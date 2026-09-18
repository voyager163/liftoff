import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import {
  isRfc1918Ipv4,
  validateFqdn,
  validateCanonicalPath,
  validateHealthResponseBody,
  validateOpenApiSchemaBody,
  stagingPrivateHttpFetch,
  stagingPrivateHttpProgram,
  stagingPrivateHttpEmbeddingInstructions,
  type StagingPrivateHttpRequest
} from '../src/application/azure-activation/staging-private-http.js';

function findLocalRfc1918Address(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const list = interfaces[name] || [];
    for (const info of list) {
      if (info.family === 'IPv4' && isRfc1918Ipv4(info.address)) {
        return info.address;
      }
    }
  }
  return null;
}

describe('staging-private-http transport primitive', () => {
  let certDir: string;
  let caKeyPath: string;
  let caCertPath: string;
  let serverKeyPath: string;
  let serverCertPath: string;
  let wrongCertPath: string;
  let wrongKeyPath: string;
  let expiredCertPath: string;
  let expiredKeyPath: string;

  let caCertPem: string;
  let serverCertPem: string;
  let serverKeyPem: string;
  let wrongCertPem: string;
  let wrongKeyPem: string;
  let expiredCertPem: string;
  let expiredKeyPem: string;

  const approvedFqdn = 'staging-app.nicecliff-1234.eastus.azurecontainerapps.io';
  const wrongFqdn = 'unapproved.foreign-target.net';

  beforeAll(() => {
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liftoff-tls-fixture-'));
    caKeyPath = path.join(certDir, 'ca.key');
    caCertPath = path.join(certDir, 'ca.crt');
    serverKeyPath = path.join(certDir, 'server.key');
    const serverCsrPath = path.join(certDir, 'server.csr');
    serverCertPath = path.join(certDir, 'server.crt');
    const sanExtPath = path.join(certDir, 'san.cnf');

    wrongKeyPath = path.join(certDir, 'wrong.key');
    const wrongCsrPath = path.join(certDir, 'wrong.csr');
    wrongCertPath = path.join(certDir, 'wrong.crt');
    const wrongSanPath = path.join(certDir, 'wrong-san.cnf');

    expiredKeyPath = path.join(certDir, 'expired.key');
    const expiredCsrPath = path.join(certDir, 'expired.csr');
    expiredCertPath = path.join(certDir, 'expired.crt');

    // 1. Generate Synthetic Root CA
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', caKeyPath, '-out', caCertPath,
      '-days', '1', '-subj', '/CN=LiftoffTestStagingRootCA'
    ]);

    // 2. Generate Server Certificate for approved FQDN
    execFileSync('openssl', [
      'req', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', serverKeyPath, '-out', serverCsrPath,
      '-subj', `/CN=${approvedFqdn}`
    ]);
    fs.writeFileSync(sanExtPath, `subjectAltName=DNS:${approvedFqdn}\n`);
    execFileSync('openssl', [
      'x509', '-req', '-in', serverCsrPath,
      '-CA', caCertPath, '-CAkey', caKeyPath, '-CAcreateserial',
      '-out', serverCertPath, '-days', '1',
      '-extfile', sanExtPath
    ]);

    // 3. Generate Certificate for wrong FQDN
    execFileSync('openssl', [
      'req', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', wrongKeyPath, '-out', wrongCsrPath,
      '-subj', `/CN=${wrongFqdn}`
    ]);
    fs.writeFileSync(wrongSanPath, `subjectAltName=DNS:${wrongFqdn}\n`);
    execFileSync('openssl', [
      'x509', '-req', '-in', wrongCsrPath,
      '-CA', caCertPath, '-CAkey', caKeyPath, '-CAcreateserial',
      '-out', wrongCertPath, '-days', '1',
      '-extfile', wrongSanPath
    ]);

    // 4. Generate Expired Certificate
    execFileSync('openssl', [
      'req', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', expiredKeyPath, '-out', expiredCsrPath,
      '-subj', `/CN=${approvedFqdn}`
    ]);
    const caConfigPath = path.join(certDir, 'ca.cnf');
    fs.writeFileSync(path.join(certDir, 'index.txt'), '');
    fs.writeFileSync(path.join(certDir, 'serial'), '01\n');
    fs.writeFileSync(caConfigPath, [
      '[ca]', 'default_ca = fixture', '[fixture]',
      'database = index.txt', 'serial = serial', 'new_certs_dir = .',
      'default_md = sha256', 'policy = fixture_policy',
      '[fixture_policy]', 'commonName = supplied', ''
    ].join('\n'));
    execFileSync('openssl', [
      'ca', '-batch', '-notext', '-config', caConfigPath,
      '-cert', caCertPath, '-keyfile', caKeyPath,
      '-in', expiredCsrPath, '-out', expiredCertPath, '-extfile', sanExtPath,
      '-startdate', '20190101000000Z', '-enddate', '20200101000000Z'
    ], { cwd: certDir });

    caCertPem = fs.readFileSync(caCertPath, 'utf8');
    serverCertPem = fs.readFileSync(serverCertPath, 'utf8');
    serverKeyPem = fs.readFileSync(serverKeyPath, 'utf8');
    wrongCertPem = fs.readFileSync(wrongCertPath, 'utf8');
    wrongKeyPem = fs.readFileSync(wrongKeyPath, 'utf8');
    expiredCertPem = fs.readFileSync(expiredCertPath, 'utf8');
    expiredKeyPem = fs.readFileSync(expiredKeyPath, 'utf8');
    const expired = new X509Certificate(expiredCertPem);
    expect(new Date(expired.validFrom).toISOString()).toBe('2019-01-01T00:00:00.000Z');
    expect(new Date(expired.validTo).toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(expired.checkHost(approvedFqdn)).toBe(approvedFqdn);
  });

  afterAll(() => {
    if (certDir && fs.existsSync(certDir)) {
      fs.rmSync(certDir, { recursive: true, force: true });
    }
  });

  describe('RFC 1918 Private IPv4 Address Validation', () => {
    it('accepts valid 10.0.0.0/8 private addresses', () => {
      expect(isRfc1918Ipv4('10.0.0.1')).toBe(true);
      expect(isRfc1918Ipv4('10.255.255.254')).toBe(true);
      expect(isRfc1918Ipv4('10.128.45.67')).toBe(true);
    });

    it('accepts valid 172.16.0.0/12 private addresses', () => {
      expect(isRfc1918Ipv4('172.16.0.1')).toBe(true);
      expect(isRfc1918Ipv4('172.20.100.50')).toBe(true);
      expect(isRfc1918Ipv4('172.31.255.254')).toBe(true);
    });

    it('accepts valid 192.168.0.0/16 private addresses', () => {
      expect(isRfc1918Ipv4('192.168.0.1')).toBe(true);
      expect(isRfc1918Ipv4('192.168.1.237')).toBe(true);
      expect(isRfc1918Ipv4('192.168.255.254')).toBe(true);
    });

    it('rejects loopback and link-local addresses', () => {
      expect(isRfc1918Ipv4('127.0.0.1')).toBe(false);
      expect(isRfc1918Ipv4('127.0.0.2')).toBe(false);
      expect(isRfc1918Ipv4('169.254.1.1')).toBe(false);
      expect(isRfc1918Ipv4('0.0.0.0')).toBe(false);
    });

    it('rejects public IPv4 addresses', () => {
      expect(isRfc1918Ipv4('8.8.8.8')).toBe(false);
      expect(isRfc1918Ipv4('1.1.1.1')).toBe(false);
      expect(isRfc1918Ipv4('93.184.216.34')).toBe(false);
      expect(isRfc1918Ipv4('20.42.0.1')).toBe(false);
    });

    it('rejects out-of-range addresses in 172 and 192 blocks', () => {
      expect(isRfc1918Ipv4('172.15.255.255')).toBe(false);
      expect(isRfc1918Ipv4('172.32.0.1')).toBe(false);
      expect(isRfc1918Ipv4('192.167.1.1')).toBe(false);
      expect(isRfc1918Ipv4('192.169.1.1')).toBe(false);
    });

    it('rejects invalid, malformed, or octal IP strings', () => {
      expect(isRfc1918Ipv4('010.0.0.1')).toBe(false);
      expect(isRfc1918Ipv4('10.0.0')).toBe(false);
      expect(isRfc1918Ipv4('10.0.0.1.5')).toBe(false);
      expect(isRfc1918Ipv4('10.0.0.256')).toBe(false);
      expect(isRfc1918Ipv4('::1')).toBe(false);
      expect(isRfc1918Ipv4('')).toBe(false);
      expect(isRfc1918Ipv4(null as any)).toBe(false);
    });
  });

  describe('FQDN and Canonical Path Validation', () => {
    it('accepts compliant FQDNs and normalizes casing', () => {
      expect(validateFqdn('Staging-App.AzureContainerApps.io')).toBe('staging-app.azurecontainerapps.io');
      expect(validateFqdn('api.internal.corp')).toBe('api.internal.corp');
    });

    it('rejects non-FQDN values like IP addresses, single labels, and invalid characters', () => {
      expect(() => validateFqdn('10.0.0.1')).toThrow('cannot be an IP address');
      expect(() => validateFqdn('localhost')).toThrow('at least two domain labels');
      expect(() => validateFqdn('staging_app.azure.com')).toThrow('Invalid FQDN label');
      expect(() => validateFqdn('')).toThrow('Invalid FQDN length');
      expect(() => validateFqdn('a'.repeat(254) + '.com')).toThrow('Invalid FQDN length');
    });

    it('accepts compliant canonical paths', () => {
      expect(validateCanonicalPath('/health')).toBe('/health');
      expect(validateCanonicalPath('/openapi.json')).toBe('/openapi.json');
      expect(validateCanonicalPath('/api/v1/status')).toBe('/api/v1/status');
    });

    it('rejects invalid or traversing paths', () => {
      expect(() => validateCanonicalPath('health')).toThrow('starting with \'/\'');
      expect(() => validateCanonicalPath('/health/../secret')).toThrow('traversal segment');
      expect(() => validateCanonicalPath('/health/./status')).toThrow('traversal segment');
      expect(() => validateCanonicalPath('/health with space')).toThrow('whitespace');
    });
  });

  describe('Pure Health and OpenAPI Validators', () => {
    it('validates health response payload successfully', () => {
      const res = validateHealthResponseBody({ status: 'ok', uptime: 1234 });
      expect(res.status).toBe('ok');
    });

    it('rejects degraded or malformed health payloads', () => {
      expect(() => validateHealthResponseBody({ status: 'degraded' })).toThrow('Health status was "degraded"');
      expect(() => validateHealthResponseBody({ notStatus: 'ok' })).toThrow('missing status string');
      expect(() => validateHealthResponseBody(null)).toThrow('non-null object');
      expect(() => validateHealthResponseBody('ok')).toThrow('non-null object');
    });

    it('validates compliant OpenAPI 3.0 and 3.1 specifications', () => {
      const validSpec = {
        openapi: '3.1.0',
        info: { title: 'Staging API', version: '1.0.0' },
        paths: {
          '/health': {
            get: {
              summary: 'Health check',
              responses: { '200': { description: 'OK' } }
            }
          },
          '/items': {
            post: {
              summary: 'Create item',
              responses: { '201': { description: 'Created' } }
            }
          }
        }
      };
      const validated = validateOpenApiSchemaBody(validSpec);
      expect(validated.openapi).toBe('3.1.0');
      expect(validated.title).toBe('Staging API');
      expect(validated.version).toBe('1.0.0');
      expect(validated.paths).toEqual(['/health', '/items']);
    });

    it('rejects unsupported OpenAPI versions or missing operation responses', () => {
      expect(() => validateOpenApiSchemaBody({
        openapi: '2.0',
        info: { title: 'Old', version: '1.0' },
        paths: { '/health': {} }
      })).toThrow('OpenAPI version must be 3.0 or 3.1');

      expect(() => validateOpenApiSchemaBody({
        openapi: '3.0.3',
        info: { title: 'Missing Responses', version: '1.0' },
        paths: {
          '/bad': { get: { summary: 'No responses' } }
        }
      })).toThrow('has no valid operations with responses');
    });
  });

  describe('Staging Private HTTP Request Validation & Boundary Enforcement', () => {
    it('rejects public IP address as expected private address', async () => {
      await expect(stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/health',
        expectedPrivateIp: '8.8.8.8'
      })).rejects.toThrow('Expected private IPv4 address must be an RFC1918 address');
    });

    it('rejects loopback 127.0.0.1 as expected private address in public recipe', async () => {
      await expect(stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/health',
        expectedPrivateIp: '127.0.0.1'
      })).rejects.toThrow('Expected private IPv4 address must be an RFC1918 address');
    });

    it('rejects expired execution deadline', async () => {
      await expect(stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/health',
        expectedPrivateIp: '10.0.0.1',
        deadlineMs: Date.now() - 500
      })).rejects.toThrow('Execution deadline expired before request could be started');
    });

    it('rejects invalid maxBodyBytes bounds', async () => {
      await expect(stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/health',
        expectedPrivateIp: '10.0.0.1',
        maxBodyBytes: 500
      })).rejects.toThrow('maxBodyBytes must be an integer between 1024 and 2097152');
    });
  });

  describe('DNS Resolution Observation & Pinning', () => {
    it('fails closed when DNS lookup reports an error', async () => {
      const failingSeam = {
        dnsLookup: (_host: string, _opts: any, cb: any) => {
          cb(new Error('getaddrinfo ENOTFOUND ' + approvedFqdn));
        }
      };

      await expect(stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/health',
        expectedPrivateIp: '10.20.30.40',
        _testSeam: failingSeam
      })).rejects.toThrow('DNS lookup failed');
    });

    it('fails closed when DNS lookup returns empty address list', async () => {
      const emptySeam = {
        dnsLookup: (_host: string, _opts: any, cb: any) => {
          cb(null, []);
        }
      };

      await expect(stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/health',
        expectedPrivateIp: '10.20.30.40',
        _testSeam: emptySeam
      })).rejects.toThrow('DNS lookup returned no addresses');
    });

    it('fails closed when DNS resolves to a different address than approved private IP', async () => {
      const mismatchedSeam = {
        dnsLookup: (_host: string, _opts: any, cb: any) => {
          cb(null, [{ address: '10.20.30.99', family: 4 }]);
        }
      };

      await expect(stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/health',
        expectedPrivateIp: '10.20.30.40',
        _testSeam: mismatchedSeam
      })).rejects.toThrow('DNS resolution mismatch: expected private address 10.20.30.40, observed [10.20.30.99]');
    });

    it('fails closed when DNS resolves to multiple distinct addresses', async () => {
      const multiSeam = {
        dnsLookup: (_host: string, _opts: any, cb: any) => {
          cb(null, [
            { address: '10.20.30.40', family: 4 },
            { address: '10.20.30.41', family: 4 }
          ]);
        }
      };

      await expect(stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/health',
        expectedPrivateIp: '10.20.30.40',
        _testSeam: multiSeam
      })).rejects.toThrow('DNS resolution mismatch');
    });

    it('fails closed when DNS resolves to a public address', async () => {
      const publicDnsSeam = {
        dnsLookup: (_host: string, _opts: any, cb: any) => {
          cb(null, [{ address: '93.184.216.34', family: 4 }]);
        }
      };

      await expect(stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/health',
        expectedPrivateIp: '10.20.30.40',
        _testSeam: publicDnsSeam
      })).rejects.toThrow('DNS resolution mismatch');
    });

    it('fails closed when DNS resolves to IPv6 address', async () => {
      const ipv6Seam = {
        dnsLookup: (_host: string, _opts: any, cb: any) => {
          cb(null, [{ address: '::1', family: 6 }]);
        }
      };

      await expect(stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/health',
        expectedPrivateIp: '10.20.30.40',
        _testSeam: ipv6Seam
      })).rejects.toThrow('DNS resolution mismatch');
    });
  });

  describe('Live HTTPS Fixture Tests on Local Network', () => {
    let localRfc1918: string | null = null;
    let server: https.Server | null = null;
    let serverPort = 0;
    let serverReceivedHeaders: http.IncomingHttpHeaders | null = null;

    beforeAll(async () => {
      localRfc1918 = findLocalRfc1918Address();
      if (!localRfc1918) {
        // Report boundary when host environment has no RFC1918 address allocated
        console.warn('NOTICE [Local Test Boundary]: No RFC1918 address allocated on host network interfaces. Socket fact fabrication avoided.');
        return;
      }

      server = https.createServer({
        key: serverKeyPem,
        cert: serverCertPem
      }, (req, res) => {
        serverReceivedHeaders = req.headers;
        const parsedUrl = new URL(req.url || '/', `https://${req.headers.host || approvedFqdn}`);

        if (parsedUrl.pathname === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', timestamp: 1700000000 }));
        } else if (parsedUrl.pathname === '/openapi.json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            openapi: '3.1.0',
            info: { title: 'Test Private App', version: '1.0.0' },
            paths: {
              '/health': {
                get: {
                  summary: 'Health',
                  responses: { '200': { description: 'OK' } }
                }
              }
            }
          }));
        } else if (parsedUrl.pathname === '/redirect') {
          res.writeHead(302, { Location: '/health' });
          res.end();
        } else if (parsedUrl.pathname === '/wrong-type') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
        } else if (parsedUrl.pathname === '/malformed-json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{ invalid json ');
        } else if (parsedUrl.pathname === '/json-array') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('[1, 2, 3]');
        } else if (parsedUrl.pathname === '/large-body') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write('{"data":"');
          res.write('x'.repeat(2000));
          res.end('"}');
        } else if (parsedUrl.pathname === '/hang') {
          // Do not end response to trigger timeout
          res.writeHead(200, { 'Content-Type': 'application/json' });
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      });

      await new Promise<void>((resolve) => {
        server!.listen(0, localRfc1918!, () => {
          const addr = server!.address() as any;
          serverPort = addr.port;
          resolve();
        });
      });
    });

    afterAll(async () => {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
    });

    it('reports exact local test boundary if no RFC1918 interface is allocated', () => {
      if (!localRfc1918) {
        expect(findLocalRfc1918Address()).toBeNull();
      } else {
        expect(isRfc1918Ipv4(localRfc1918)).toBe(true);
      }
    });

    it('successfully observes actual private network, TLS, and response facts on live socket', async () => {
      if (!localRfc1918) return;

      const controlledDns = {
        dnsLookup: (_host: string, _opts: any, cb: any) => {
          cb(null, [{ address: localRfc1918!, family: 4 }]);
        },
        ca: caCertPem
      };

      const result = await stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/health',
        expectedPrivateIp: localRfc1918,
        port: serverPort,
        _testSeam: controlledDns
      });

      // Pure health validation
      const health = validateHealthResponseBody(result.body);
      expect(health.status).toBe('ok');

      // Validate witness reflects ACTUAL facts without copying expected values or exposing body
      const witness = result.witness;
      expect(witness.protocol).toBe('https:');
      expect(witness.fqdn).toBe(approvedFqdn);
      expect(witness.path).toBe('/health');
      expect(witness.observedDnsAddresses).toEqual([localRfc1918]);
      expect(witness.peerAddress).toBe(localRfc1918);
      expect(witness.peerPort).toBe(serverPort);
      expect(witness.tlsAuthorized).toBe(true);
      expect(witness.statusCode).toBe(200);
      expect(witness.mediaType).toBe('application/json');
      expect(witness.bodyDigest).toBe(createHash('sha256').update(result.bytes).digest('hex'));
      expect(witness.bodyBytesLength).toBe(result.bytes.length);
      expect(typeof witness.observedAt).toBe('string');

      // Verify witness does not contain private response body
      expect((witness as any).body).toBeUndefined();
      expect((witness as any).bytes).toBeUndefined();

      // Zero credential headers verification
      expect(serverReceivedHeaders).toBeDefined();
      expect(serverReceivedHeaders!['authorization']).toBeUndefined();
      expect(serverReceivedHeaders!['cookie']).toBeUndefined();
      expect(serverReceivedHeaders!['proxy-authorization']).toBeUndefined();
    });

    it('successfully performs OpenAPI schema discovery and validation', async () => {
      if (!localRfc1918) return;

      const controlledDns = {
        dnsLookup: (_host: string, _opts: any, cb: any) => {
          cb(null, [{ address: localRfc1918!, family: 4 }]);
        },
        ca: caCertPem
      };

      const result = await stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/openapi.json',
        expectedPrivateIp: localRfc1918,
        port: serverPort,
        _testSeam: controlledDns
      });

      const schema = validateOpenApiSchemaBody(result.body);
      expect(schema.openapi).toBe('3.1.0');
      expect(schema.title).toBe('Test Private App');
      expect(schema.paths).toEqual(['/health']);
    });

    it('fails closed on real TLS handshake failure when untrusted CA is presented', async () => {
      if (!localRfc1918) return;

      const noCaSeam = {
        dnsLookup: (_host: string, _opts: any, cb: any) => {
          cb(null, [{ address: localRfc1918!, family: 4 }]);
        }
        // Omit CA, so synthetic root CA is untrusted by default Node trust store
      };

      await expect(stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/health',
        expectedPrivateIp: localRfc1918,
        port: serverPort,
        _testSeam: noCaSeam
      })).rejects.toThrow();
    });

    it('fails closed on real TLS failure when certificate hostname mismatches SNI FQDN', async () => {
      if (!localRfc1918) return;

      // Start a server presenting the wrong FQDN certificate
      const wrongServer = https.createServer({
        key: wrongKeyPem,
        cert: wrongCertPem
      }, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });

      let wrongPort = 0;
      await new Promise<void>((resolve) => {
        wrongServer.listen(0, localRfc1918!, () => {
          wrongPort = (wrongServer.address() as any).port;
          resolve();
        });
      });

      try {
        const controlledDns = {
          dnsLookup: (_host: string, _opts: any, cb: any) => {
            cb(null, [{ address: localRfc1918!, family: 4 }]);
          },
          ca: caCertPem
        };

        await expect(stagingPrivateHttpFetch({
          fqdn: approvedFqdn,
          path: '/health',
          expectedPrivateIp: localRfc1918,
          port: wrongPort,
          _testSeam: controlledDns
        })).rejects.toThrow();
      } finally {
        await new Promise<void>((resolve) => wrongServer.close(() => resolve()));
      }
    });

    it('fails closed on real TLS failure when certificate is expired', async () => {
      if (!localRfc1918) return;

      const expiredServer = https.createServer({
        key: expiredKeyPem,
        cert: expiredCertPem
      }, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });

      let expiredPort = 0;
      await new Promise<void>((resolve) => {
        expiredServer.listen(0, localRfc1918!, () => {
          expiredPort = (expiredServer.address() as any).port;
          resolve();
        });
      });

      try {
        const controlledDns = {
          dnsLookup: (_host: string, _opts: any, cb: any) => {
            cb(null, [{ address: localRfc1918!, family: 4 }]);
          },
          ca: caCertPem
        };

        await expect(stagingPrivateHttpFetch({
          fqdn: approvedFqdn,
          path: '/health',
          expectedPrivateIp: localRfc1918,
          port: expiredPort,
          _testSeam: controlledDns
        })).rejects.toThrow();
      } finally {
        await new Promise<void>((resolve) => expiredServer.close(() => resolve()));
      }
    });

    it('fails closed when actual socket peer mismatches expected private IP', async () => {
      if (!localRfc1918) return;

      // Approved private address is 10.10.10.10, DNS seam returns 10.10.10.10,
      // but test seam routes socket connection to live localRfc1918 fixture
      const mismatchSeam = {
        dnsLookup: (_host: string, _opts: any, cb: any) => {
          cb(null, [{ address: '10.10.10.10', family: 4 }]);
        },
        ca: caCertPem,
        pinAddress: localRfc1918!
      };

      await expect(stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/health',
        expectedPrivateIp: '10.10.10.10',
        port: serverPort,
        _testSeam: mismatchSeam
      })).rejects.toThrow(/Remote peer address mismatch: observed .* expected 10\.10\.10\.10/);
    });

    it('fails closed and does not follow HTTP redirects', async () => {
      if (!localRfc1918) return;

      const controlledDns = {
        dnsLookup: (_host: string, _opts: any, cb: any) => {
          cb(null, [{ address: localRfc1918!, family: 4 }]);
        },
        ca: caCertPem
      };

      await expect(stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/redirect',
        expectedPrivateIp: localRfc1918,
        port: serverPort,
        _testSeam: controlledDns
      })).rejects.toThrow('Expected HTTP 200 OK, received status 302');
    });

    it('fails closed when content-type is not application/json', async () => {
      if (!localRfc1918) return;

      const controlledDns = {
        dnsLookup: (_host: string, _opts: any, cb: any) => {
          cb(null, [{ address: localRfc1918!, family: 4 }]);
        },
        ca: caCertPem
      };

      await expect(stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/wrong-type',
        expectedPrivateIp: localRfc1918,
        port: serverPort,
        _testSeam: controlledDns
      })).rejects.toThrow('Content-Type must be application/json');
    });

    it('fails closed when body is malformed JSON', async () => {
      if (!localRfc1918) return;

      const controlledDns = {
        dnsLookup: (_host: string, _opts: any, cb: any) => {
          cb(null, [{ address: localRfc1918!, family: 4 }]);
        },
        ca: caCertPem
      };

      await expect(stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/malformed-json',
        expectedPrivateIp: localRfc1918,
        port: serverPort,
        _testSeam: controlledDns
      })).rejects.toThrow('Response body was not valid JSON');
    });

    it('fails closed when JSON root is not an object', async () => {
      if (!localRfc1918) return;

      const controlledDns = {
        dnsLookup: (_host: string, _opts: any, cb: any) => {
          cb(null, [{ address: localRfc1918!, family: 4 }]);
        },
        ca: caCertPem
      };

      await expect(stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/json-array',
        expectedPrivateIp: localRfc1918,
        port: serverPort,
        _testSeam: controlledDns
      })).rejects.toThrow('Response JSON root must be an object');
    });

    it('fails closed and destroys socket when body exceeds maxBodyBytes', async () => {
      if (!localRfc1918) return;

      const controlledDns = {
        dnsLookup: (_host: string, _opts: any, cb: any) => {
          cb(null, [{ address: localRfc1918!, family: 4 }]);
        },
        ca: caCertPem
      };

      await expect(stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/large-body',
        expectedPrivateIp: localRfc1918,
        port: serverPort,
        maxBodyBytes: 1024,
        _testSeam: controlledDns
      })).rejects.toThrow('Response body exceeded maximum allowed size of 1024 bytes');
    });

    it('fails closed when request exceeds timeoutMs', async () => {
      if (!localRfc1918) return;

      const controlledDns = {
        dnsLookup: (_host: string, _opts: any, cb: any) => {
          cb(null, [{ address: localRfc1918!, family: 4 }]);
        },
        ca: caCertPem
      };

      await expect(stagingPrivateHttpFetch({
        fqdn: approvedFqdn,
        path: '/hang',
        expectedPrivateIp: localRfc1918,
        port: serverPort,
        timeoutMs: 300,
        _testSeam: controlledDns
      })).rejects.toThrow('timed out');
    });
  });

  describe('Exported JS Source Snippet & Embedding Instructions', () => {
    it('exports embedding instructions with clear coordinator guidance', () => {
      expect(stagingPrivateHttpEmbeddingInstructions).toContain('COORDINATOR EMBEDDING INSTRUCTIONS');
      expect(stagingPrivateHttpEmbeddingInstructions).toContain('stagingPrivateHttpProgram');
      expect(stagingPrivateHttpEmbeddingInstructions).toContain('stagingPrivateHttpFetch');
    });

    it('executes exported stagingPrivateHttpProgram snippet verbatim in node subprocess', async () => {
      const runnerScript = `
${stagingPrivateHttpProgram}

async function run() {
  const is10 = isRfc1918Ipv4('10.1.2.3');
  const isPublic = isRfc1918Ipv4('8.8.8.8');
  if (!is10 || isPublic) {
    console.error('RFC1918 check failed');
    process.exit(1);
  }

  const fqdn = validateFqdn('my-app.internal.corp');
  if (fqdn !== 'my-app.internal.corp') {
    console.error('validateFqdn failed');
    process.exit(2);
  }

  const health = validateHealthResponseBody({ status: 'ok' });
  if (health.status !== 'ok') {
    console.error('validateHealthResponseBody failed');
    process.exit(3);
  }

  const schema = validateOpenApiSchemaBody({
    openapi: '3.0.3',
    info: { title: 'Test', version: '1.0' },
    paths: {
      '/health': { get: { responses: { '200': { description: 'ok' } } } }
    }
  });
  if (schema.paths[0] !== '/health') {
    console.error('validateOpenApiSchemaBody failed');
    process.exit(4);
  }

  process.stdout.write(JSON.stringify({ ok: true, fqdn: fqdn }));
}

run().catch((e) => {
  console.error(e);
  process.exit(5);
});
`;

      const child = spawn(process.execPath, ['--input-type=module'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.stdin.write(runnerScript);
      child.stdin.end();

      const exitCode = await new Promise<number>((resolve) => {
        child.on('close', resolve);
      });

      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.fqdn).toBe('my-app.internal.corp');
    });

    it('executes stagingPrivateHttpFetch from stagingPrivateHttpProgram end-to-end against live fixture in node subprocess', async () => {
      const localRfc1918 = findLocalRfc1918Address();
      if (!localRfc1918) return;

      // Start temporary local https fixture
      const fixtureServer = https.createServer({
        key: serverKeyPem,
        cert: serverCertPem
      }, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', source: 'subprocess-program' }));
      });

      let fixturePort = 0;
      await new Promise<void>((resolve) => {
        fixtureServer.listen(0, localRfc1918, () => {
          fixturePort = (fixtureServer.address() as any).port;
          resolve();
        });
      });

      try {
        const payload = JSON.stringify({
          fqdn: approvedFqdn,
          path: '/health',
          expectedPrivateIp: localRfc1918,
          port: fixturePort,
          ca: caCertPem
        });

        const runnerScript = `
${stagingPrivateHttpProgram}

const config = ${payload};

async function run() {
  const seam = {
    dnsLookup: (_host, _opts, cb) => cb(null, [{ address: config.expectedPrivateIp, family: 4 }]),
    ca: config.ca
  };

  const response = await stagingPrivateHttpFetch({
    fqdn: config.fqdn,
    path: config.path,
    expectedPrivateIp: config.expectedPrivateIp,
    port: config.port,
    _testSeam: seam
  });

  validateHealthResponseBody(response.body);

  process.stdout.write(JSON.stringify({
    ok: true,
    protocol: response.witness.protocol,
    peerAddress: response.witness.peerAddress,
    tlsAuthorized: response.witness.tlsAuthorized,
    statusCode: response.witness.statusCode,
    mediaType: response.witness.mediaType,
    bodyDigest: response.witness.bodyDigest,
    hasBodyInWitness: response.witness.body !== undefined
  }));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

        const child = spawn(process.execPath, ['--input-type=module'], {
          stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.stdin.write(runnerScript);
        child.stdin.end();

        const exitCode = await new Promise<number>((resolve) => {
          child.on('close', resolve);
        });

        expect(stderr).toBe('');
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.ok).toBe(true);
        expect(parsed.protocol).toBe('https:');
        expect(parsed.peerAddress).toBe(localRfc1918);
        expect(parsed.tlsAuthorized).toBe(true);
        expect(parsed.statusCode).toBe(200);
        expect(parsed.mediaType).toBe('application/json');
        expect(typeof parsed.bodyDigest).toBe('string');
        expect(parsed.hasBodyInWitness).toBe(false);
      } finally {
        await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
      }
    });
  });
});
