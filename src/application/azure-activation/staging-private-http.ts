import https from 'node:https';
import dns from 'node:dns';
import { createHash } from 'node:crypto';

/**
 * Request specification for private staging HTTP transport.
 */
export interface StagingPrivateHttpTestSeam {
  /**
   * Controlled DNS resolution seam for test fixtures.
   * In production, defaults to standard node:dns.lookup.
   */
  dnsLookup?: (
    hostname: string,
    options: { all: boolean } | Record<string, unknown>,
    callback: (err: NodeJS.ErrnoException | null, addresses?: Array<{ address: string; family: number | string }>) => void
  ) => void;
  /**
   * Trusted Certificate Authority (PEM format) for test fixtures with synthetic root CAs.
   * Standard TLS verification (rejectUnauthorized: true) is strictly preserved.
   */
  ca?: string | Buffer | Array<string | Buffer>;
  /**
   * Optional connection target pin override solely for testing socket peer mismatch.
   */
  pinAddress?: string;
}

export interface StagingPrivateHttpRequest {
  /**
   * Approved HTTPS FQDN (RFC 1123 format).
   */
  fqdn: string;
  /**
   * Canonical path starting with '/' and containing no traversal segments.
   */
  path: string;
  /**
   * Expected private IPv4 address (RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16).
   */
  expectedPrivateIp: string;
  /**
   * Absolute deadline timestamp in epoch milliseconds.
   */
  deadlineMs?: number;
  /**
   * Maximum duration in milliseconds for the HTTP request.
   */
  timeoutMs?: number;
  /**
   * Maximum allowed response body size in bytes (default 524,288 = 512 KiB; max 2,097,152 = 2 MiB).
   */
  maxBodyBytes?: number;
  /**
   * Port number (default: 443).
   */
  port?: number;
  /**
   * Controlled test seam solely for isolated test fixtures.
   * Never permits insecure TLS flags or non-RFC1918 public recipe bypass.
   */
  _testSeam?: StagingPrivateHttpTestSeam;
}

export interface StagingPrivateHttpCertificateDetails {
  subject: Record<string, string>;
  issuer: Record<string, string>;
  validFrom: string;
  validTo: string;
  fingerprint256: string;
  subjectAlternativeNames: string[];
}

/**
 * Witness proving actual private network access, DNS resolution, socket peer facts,
 * TLS authorization, and response integrity without leaking private response bodies.
 */
export interface StagingPrivateHttpWitness {
  protocol: 'https:';
  fqdn: string;
  path: string;
  observedDnsAddresses: string[];
  peerAddress: string;
  peerPort: number;
  tlsAuthorized: boolean;
  tlsPeerCertificate: StagingPrivateHttpCertificateDetails;
  statusCode: number;
  mediaType: string;
  bodyDigest: string;
  bodyBytesLength: number;
  observedAt: string;
}

export interface StagingPrivateHttpResponse {
  witness: StagingPrivateHttpWitness;
  body: unknown;
  bytes: Buffer;
}

export interface ValidatedHealthBody {
  status: string;
  [key: string]: unknown;
}

export interface ValidatedOpenApiSchemaBody {
  openapi: string;
  title: string;
  version: string;
  paths: string[];
  [key: string]: unknown;
}

/**
 * Strictly verifies whether an IPv4 address belongs to RFC 1918 private ranges:
 * - 10.0.0.0/8 (10.0.0.0 - 10.255.255.255)
 * - 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
 * - 192.168.0.0/16 (192.168.0.0 - 192.168.255.255)
 * Rejects loopback (127.x), link-local (169.254.x), public IPs, octal/hex notation, and IPv6.
 */
export function isRfc1918Ipv4(ip: string): boolean {
  if (typeof ip !== 'string') return false;
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return false;
    const n = Number(part);
    if (n < 0 || n > 255) return false;
    octets.push(n);
  }
  const [o0, o1] = octets as [number, number, number, number];
  if (o0 === 10) return true;
  if (o0 === 172 && o1 >= 16 && o1 <= 31) return true;
  if (o0 === 192 && o1 === 168) return true;
  return false;
}

/**
 * Validates canonical FQDN per RFC 1123:
 * - 1-253 characters total
 * - At least two domain labels
 * - Lowercase alphanumeric and hyphens
 * - No IP address literals or port numbers
 */
export function validateFqdn(fqdn: string): string {
  if (typeof fqdn !== 'string') throw new Error('FQDN must be a string');
  const normalized = fqdn.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 253) {
    throw new Error(`Invalid FQDN length: ${normalized.length}`);
  }
  if (isRfc1918Ipv4(normalized) || /^\d+\.\d+\.\d+\.\d+$/.test(normalized)) {
    throw new Error(`FQDN cannot be an IP address literal: ${normalized}`);
  }
  const labels = normalized.split('.');
  if (labels.length < 2) {
    throw new Error(`FQDN must have at least two domain labels: ${normalized}`);
  }
  for (const label of labels) {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      throw new Error(`Invalid FQDN label "${label}" in ${normalized}`);
    }
  }
  return normalized;
}

/**
 * Validates canonical HTTP path:
 * - Must start with '/'
 * - No whitespace
 * - No path traversal segments ('.' or '..')
 */
export function validateCanonicalPath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error(`Path must be a non-empty string starting with '/': ${path}`);
  }
  if (/\s/.test(path)) {
    throw new Error(`Path cannot contain whitespace: ${path}`);
  }
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new Error(`Path contains traversal segment "${seg}": ${path}`);
    }
  }
  return path;
}

/**
 * Pure validation helper for health response payloads.
 * Requires a valid JSON object with status === 'ok'.
 */
export function validateHealthResponseBody(body: unknown): ValidatedHealthBody {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Health response body must be a non-null object');
  }
  const record = body as Record<string, unknown>;
  if (typeof record.status !== 'string' || record.status.trim() === '') {
    throw new Error('Health response missing status string');
  }
  if (record.status !== 'ok') {
    throw new Error(`Health status was "${record.status}", expected "ok"`);
  }
  return record as ValidatedHealthBody;
}

/**
 * Pure validation helper for OpenAPI 3.0 / 3.1 schema payloads.
 * Requires valid openapi version, info block with title and version,
 * and 1-128 valid operation paths.
 */
export function validateOpenApiSchemaBody(body: unknown): ValidatedOpenApiSchemaBody {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('OpenAPI schema root must be a non-null object');
  }
  const schema = body as Record<string, unknown>;
  if (typeof schema.openapi !== 'string' || !/^3\.(?:0|1)\.\d+$/.test(schema.openapi)) {
    throw new Error(`OpenAPI version must be 3.0 or 3.1, received: ${String(schema.openapi)}`);
  }
  if (!schema.info || typeof schema.info !== 'object' || Array.isArray(schema.info)) {
    throw new Error('OpenAPI schema missing valid info object');
  }
  const info = schema.info as Record<string, unknown>;
  if (typeof info.title !== 'string' || info.title.trim() === '') {
    throw new Error('OpenAPI info.title must be a non-empty string');
  }
  if (typeof info.version !== 'string' || info.version.trim() === '') {
    throw new Error('OpenAPI info.version must be a non-empty string');
  }
  if (!schema.paths || typeof schema.paths !== 'object' || Array.isArray(schema.paths)) {
    throw new Error('OpenAPI schema missing valid paths object');
  }
  const paths = schema.paths as Record<string, unknown>;
  const pathKeys = Object.keys(paths);
  if (pathKeys.length === 0) {
    throw new Error('OpenAPI paths object must not be empty');
  }
  if (pathKeys.length > 128) {
    throw new Error(`OpenAPI paths count exceeded limit of 128 (found ${pathKeys.length})`);
  }
  const allowedMethods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
  for (const p of pathKeys) {
    if (!p.startsWith('/')) {
      throw new Error(`OpenAPI path "${p}" does not start with '/'`);
    }
    const item = paths[p];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`OpenAPI path item for "${p}" must be an object`);
    }
    const itemObj = item as Record<string, unknown>;
    const hasMethod = Object.entries(itemObj).some(([method, val]) =>
      allowedMethods.includes(method.toLowerCase()) &&
      val && typeof val === 'object' && !Array.isArray(val) &&
      (val as Record<string, unknown>).responses &&
      typeof (val as Record<string, unknown>).responses === 'object' &&
      Object.keys((val as Record<string, unknown>).responses as object).length > 0
    );
    if (!hasMethod) {
      throw new Error(`OpenAPI path "${p}" has no valid operations with responses`);
    }
  }
  return {
    ...schema,
    openapi: schema.openapi,
    title: info.title,
    version: info.version,
    paths: pathKeys.sort()
  };
}

/**
 * Performs private staging HTTPS request with DNS observation, socket connection pinning,
 * strict TLS validation, and witness generation.
 */
export async function stagingPrivateHttpFetch(
  request: StagingPrivateHttpRequest
): Promise<StagingPrivateHttpResponse> {
  if (!request || typeof request !== 'object') {
    throw new Error('Request must be an object');
  }
  const fqdn = validateFqdn(request.fqdn);
  const path = validateCanonicalPath(request.path);
  const expectedPrivateIp = request.expectedPrivateIp;
  if (!isRfc1918Ipv4(expectedPrivateIp)) {
    throw new Error(
      `Expected private IPv4 address must be an RFC1918 address (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16): ${String(expectedPrivateIp)}`
    );
  }

  const port = request.port !== undefined ? request.port : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Port must be an integer between 1 and 65535: ${String(port)}`);
  }

  const maxBodyBytes = request.maxBodyBytes !== undefined ? request.maxBodyBytes : 524288;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 2097152) {
    throw new Error(`maxBodyBytes must be an integer between 1024 and 2097152: ${String(maxBodyBytes)}`);
  }

  const now = Date.now();
  let timeoutMs = 15000;
  if (request.timeoutMs !== undefined) {
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new Error('timeoutMs must be a positive number');
    }
    timeoutMs = request.timeoutMs;
  }
  if (request.deadlineMs !== undefined) {
    if (!Number.isFinite(request.deadlineMs)) {
      throw new Error('deadlineMs must be a finite number');
    }
    const remaining = request.deadlineMs - now;
    if (remaining <= 0) {
      throw new Error('Execution deadline expired before request could be started');
    }
    timeoutMs = Math.min(timeoutMs, remaining);
  }
  if (timeoutMs <= 0) {
    throw new Error(`Calculated request timeout was non-positive: ${timeoutMs}`);
  }

  // Controlled DNS seam solely for isolated test fixtures; production uses standard dns.lookup
  const lookupSeam =
    request._testSeam && typeof request._testSeam.dnsLookup === 'function'
      ? request._testSeam.dnsLookup
      : dns.lookup;

  // Step 1: DNS Observation
  const dnsResult = await new Promise<Array<{ address: string; family: number | string }>>(
    (resolvePromise, rejectPromise) => {
      lookupSeam(fqdn, { all: true }, (err, addresses) => {
        if (err) {
          return rejectPromise(
            new Error(`DNS lookup failed for ${fqdn}: ${err.message || String(err)}`)
          );
        }
        if (!Array.isArray(addresses) || addresses.length === 0) {
          return rejectPromise(new Error(`DNS lookup returned no addresses for ${fqdn}`));
        }
        resolvePromise(addresses);
      });
    }
  );

  const observedDnsAddresses = dnsResult.map((entry) => entry.address);
  for (const entry of dnsResult) {
    if (entry.address !== expectedPrivateIp) {
      throw new Error(
        `DNS resolution mismatch: expected private address ${expectedPrivateIp}, observed [${observedDnsAddresses.join(', ')}]`
      );
    }
    if (entry.family !== 4 && entry.family !== 'IPv4') {
      throw new Error(`DNS resolution family mismatch: expected IPv4, observed family ${entry.family}`);
    }
  }

  const pinnedTargetAddress =
    request._testSeam && request._testSeam.pinAddress
      ? request._testSeam.pinAddress
      : dnsResult[0]!.address;

  // Step 2: Connection Pinning and HTTPS Request
  return new Promise<StagingPrivateHttpResponse>((resolvePromise, rejectPromise) => {
    let completed = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const fail = (err: Error) => {
      if (completed) return;
      completed = true;
      cleanup();
      rejectPromise(err);
    };

    const reqOptions: https.RequestOptions = {
      host: fqdn,
      port: port,
      path: path,
      method: 'GET',
      servername: fqdn,
      rejectUnauthorized: true,
      agent: false,
      lookup: (
        _hostname: string,
        lookupOpts: unknown,
        cb: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void
      ) => {
        let callback = cb;
        let opts = lookupOpts as { all?: boolean } | undefined;
        if (typeof lookupOpts === 'function') {
          callback = lookupOpts as any;
          opts = undefined;
        }
        if (opts && opts.all) {
          callback(null, [{ address: pinnedTargetAddress, family: 4 }]);
        } else {
          callback(null, pinnedTargetAddress, 4);
        }
      },
      headers: {
        Host: fqdn,
        Accept: 'application/json',
        'User-Agent': 'liftoff-staging-private-http/1.0',
        Connection: 'close'
      }
    };

    if (request._testSeam && request._testSeam.ca) {
      reqOptions.ca = request._testSeam.ca;
    }

    const req = https.request(reqOptions, (res) => {
      try {
        const socket = res.socket as import('node:tls').TLSSocket;
        if (!socket) throw new Error('Response socket was not available');

        // Check TLS authorization
        if (!socket.authorized) {
          throw new Error(
            `TLS authorization failed: ${socket.authorizationError?.message || 'Certificate unauthorized'}`
          );
        }

        // Check remote peer address
        const rawPeer = socket.remoteAddress;
        const normalizedPeer = rawPeer ? rawPeer.replace(/^::ffff:/, '') : '';
        if (normalizedPeer !== expectedPrivateIp) {
          throw new Error(
            `Remote peer address mismatch: observed ${normalizedPeer}, expected ${expectedPrivateIp}`
          );
        }

        // Status 200 requirement (no redirects followed)
        if (res.statusCode !== 200) {
          throw new Error(`Expected HTTP 200 OK, received status ${res.statusCode}`);
        }

        // Content-Type requirement
        const rawContentType = String(res.headers['content-type'] || '');
        const mediaType = rawContentType.split(';')[0]!.trim().toLowerCase();
        if (mediaType !== 'application/json') {
          throw new Error(`Content-Type must be application/json, received: ${rawContentType}`);
        }

        // Capture actual TLS peer certificate facts
        const peerCert = typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate(true) : null;
        const certDetails: StagingPrivateHttpCertificateDetails = {
          subject: (peerCert?.subject ? { ...peerCert.subject } : {}) as Record<string, string>,
          issuer: (peerCert?.issuer ? { ...peerCert.issuer } : {}) as Record<string, string>,
          validFrom: peerCert?.valid_from || '',
          validTo: peerCert?.valid_to || '',
          fingerprint256: peerCert?.fingerprint256 || '',
          subjectAlternativeNames: peerCert?.subjectaltname ? peerCert.subjectaltname.split(', ') : []
        };

        const observedPeerPort = socket.remotePort || port;
        const observedAt = new Date().toISOString();

        let receivedBytes = 0;
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (receivedBytes > maxBodyBytes) {
            req.destroy(new Error(`Response body exceeded maximum allowed size of ${maxBodyBytes} bytes`));
          } else {
            chunks.push(chunk);
          }
        });

        res.on('end', () => {
          if (completed) return;
          try {
            const rawBuffer = Buffer.concat(chunks);
            const bodyDigest = createHash('sha256').update(rawBuffer).digest('hex');
            const text = new TextDecoder('utf-8', { fatal: true }).decode(rawBuffer);
            let parsedBody: unknown;
            try {
              parsedBody = JSON.parse(text);
            } catch (parseErr: any) {
              throw new Error(`Response body was not valid JSON: ${parseErr.message}`);
            }
            if (parsedBody === null || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
              throw new Error('Response JSON root must be an object');
            }

            const witness: StagingPrivateHttpWitness = {
              protocol: 'https:',
              fqdn: fqdn,
              path: path,
              observedDnsAddresses: [...observedDnsAddresses],
              peerAddress: normalizedPeer,
              peerPort: observedPeerPort,
              tlsAuthorized: socket.authorized === true,
              tlsPeerCertificate: certDetails,
              statusCode: res.statusCode!,
              mediaType: mediaType,
              bodyDigest: bodyDigest,
              bodyBytesLength: rawBuffer.length,
              observedAt: observedAt
            };

            completed = true;
            cleanup();
            resolvePromise({
              witness: witness,
              body: parsedBody,
              bytes: rawBuffer
            });
          } catch (err: any) {
            fail(err);
          }
        });

        res.on('error', (err) => fail(err));
      } catch (err: any) {
        req.destroy();
        fail(err);
      }
    });

    req.on('error', (err) => fail(err));

    timer = setTimeout(() => {
      req.destroy(new Error(`Staging private HTTP request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    req.end();
  });
}

/**
 * Dependency-free stable JS source snippet export for verbatim embedding into parent
 * reviewed workflow (staging-security-workflow-program.ts).
 * Defines stagingPrivateHttpFetch, isRfc1918Ipv4, validateHealthResponseBody, and
 * validateOpenApiSchemaBody using Node.js built-ins exclusively.
 */
export const stagingPrivateHttpProgram = String.raw`import https from 'node:https';
import dns from 'node:dns';
import { createHash } from 'node:crypto';

export function isRfc1918Ipv4(ip) {
  if (typeof ip !== 'string') return false;
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const octets = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return false;
    const n = Number(part);
    if (n < 0 || n > 255) return false;
    octets.push(n);
  }
  const [o0, o1] = octets;
  if (o0 === 10) return true;
  if (o0 === 172 && o1 >= 16 && o1 <= 31) return true;
  if (o0 === 192 && o1 === 168) return true;
  return false;
}

export function validateFqdn(fqdn) {
  if (typeof fqdn !== 'string') throw new Error('FQDN must be a string');
  const normalized = fqdn.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 253) throw new Error('Invalid FQDN length');
  if (isRfc1918Ipv4(normalized) || /^\d+\.\d+\.\d+\.\d+$/.test(normalized)) {
    throw new Error('FQDN cannot be an IP address: ' + normalized);
  }
  const labels = normalized.split('.');
  if (labels.length < 2) throw new Error('FQDN must contain at least two domain labels: ' + normalized);
  for (const label of labels) {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      throw new Error('Invalid FQDN label "' + label + '" in ' + normalized);
    }
  }
  return normalized;
}

export function validateCanonicalPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error('Path must be a string starting with "/": ' + path);
  }
  if (/\s/.test(path)) throw new Error('Path cannot contain whitespace: ' + path);
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new Error('Path contains path traversal segment: ' + path);
    }
  }
  return path;
}

export function validateHealthResponseBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Health response body must be a non-null object');
  }
  if (typeof body.status !== 'string' || body.status.trim() === '') {
    throw new Error('Health response missing status string');
  }
  if (body.status !== 'ok') {
    throw new Error('Health status was "' + body.status + '", expected "ok"');
  }
  return body;
}

export function validateOpenApiSchemaBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('OpenAPI schema root must be a non-null object');
  }
  if (typeof body.openapi !== 'string' || !/^3\.(?:0|1)\.\d+$/.test(body.openapi)) {
    throw new Error('OpenAPI version must be 3.0 or 3.1, received: ' + String(body.openapi));
  }
  if (!body.info || typeof body.info !== 'object' || Array.isArray(body.info)) {
    throw new Error('OpenAPI schema missing valid info object');
  }
  if (typeof body.info.title !== 'string' || body.info.title.trim() === '') {
    throw new Error('OpenAPI info.title must be a non-empty string');
  }
  if (typeof body.info.version !== 'string' || body.info.version.trim() === '') {
    throw new Error('OpenAPI info.version must be a non-empty string');
  }
  if (!body.paths || typeof body.paths !== 'object' || Array.isArray(body.paths)) {
    throw new Error('OpenAPI schema missing valid paths object');
  }
  const pathKeys = Object.keys(body.paths);
  if (pathKeys.length === 0) throw new Error('OpenAPI paths object must not be empty');
  if (pathKeys.length > 128) throw new Error('OpenAPI paths count exceeded limit of 128');
  const allowedMethods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
  for (const p of pathKeys) {
    if (!p.startsWith('/')) throw new Error('OpenAPI path "' + p + '" does not start with "/"');
    const item = body.paths[p];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('OpenAPI path item for "' + p + '" must be an object');
    }
    const hasMethod = Object.entries(item).some(([method, val]) =>
      allowedMethods.includes(method.toLowerCase()) &&
      val && typeof val === 'object' && !Array.isArray(val) &&
      val.responses && typeof val.responses === 'object' &&
      Object.keys(val.responses).length > 0
    );
    if (!hasMethod) throw new Error('OpenAPI path "' + p + '" has no valid operations with responses');
  }
  return {
    ...body,
    openapi: body.openapi,
    title: body.info.title,
    version: body.info.version,
    paths: pathKeys.sort()
  };
}

export async function stagingPrivateHttpFetch(request) {
  if (!request || typeof request !== 'object') throw new Error('Request must be an object');
  const fqdn = validateFqdn(request.fqdn);
  const path = validateCanonicalPath(request.path);
  const expectedPrivateIp = request.expectedPrivateIp;
  if (!isRfc1918Ipv4(expectedPrivateIp)) {
    throw new Error('Expected private IPv4 address must be an RFC1918 address (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16): ' + String(expectedPrivateIp));
  }

  const port = request.port !== undefined ? request.port : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be an integer between 1 and 65535: ' + String(port));
  }

  const maxBodyBytes = request.maxBodyBytes !== undefined ? request.maxBodyBytes : 524288;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 2097152) {
    throw new Error('maxBodyBytes must be an integer between 1024 and 2097152: ' + String(maxBodyBytes));
  }

  const now = Date.now();
  let timeoutMs = 15000;
  if (request.timeoutMs !== undefined) {
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new Error('timeoutMs must be a positive number');
    }
    timeoutMs = request.timeoutMs;
  }
  if (request.deadlineMs !== undefined) {
    if (!Number.isFinite(request.deadlineMs)) {
      throw new Error('deadlineMs must be a finite number');
    }
    const remaining = request.deadlineMs - now;
    if (remaining <= 0) {
      throw new Error('Execution deadline expired before request could be started');
    }
    timeoutMs = Math.min(timeoutMs, remaining);
  }
  if (timeoutMs <= 0) {
    throw new Error('Calculated request timeout was non-positive: ' + timeoutMs);
  }

  // Controlled DNS seam solely for test fixtures; production uses standard dns.lookup
  const lookupSeam = request._testSeam && typeof request._testSeam.dnsLookup === 'function'
    ? request._testSeam.dnsLookup
    : dns.lookup;

  // Step 1: DNS Observation
  const dnsResult = await new Promise((resolvePromise, rejectPromise) => {
    lookupSeam(fqdn, { all: true }, (err, addresses) => {
      if (err) return rejectPromise(new Error('DNS lookup failed for ' + fqdn + ': ' + (err.message || String(err))));
      if (!Array.isArray(addresses) || addresses.length === 0) {
        return rejectPromise(new Error('DNS lookup returned no addresses for ' + fqdn));
      }
      resolvePromise(addresses);
    });
  });

  const observedDnsAddresses = dnsResult.map(entry => entry.address);
  for (const entry of dnsResult) {
    if (entry.address !== expectedPrivateIp) {
      throw new Error('DNS resolution mismatch: expected private address ' + expectedPrivateIp + ', observed [' + observedDnsAddresses.join(', ') + ']');
    }
    if (entry.family !== 4 && entry.family !== 'IPv4') {
      throw new Error('DNS resolution family mismatch: expected IPv4, observed family ' + entry.family);
    }
  }

  const pinnedTargetAddress = request._testSeam && request._testSeam.pinAddress
    ? request._testSeam.pinAddress
    : dnsResult[0].address;

  // Step 2: Connection Pinning and HTTPS Request
  return new Promise((resolvePromise, rejectPromise) => {
    let completed = false;
    let timer = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const fail = (err) => {
      if (completed) return;
      completed = true;
      cleanup();
      rejectPromise(err);
    };

    const reqOptions = {
      host: fqdn,
      port: port,
      path: path,
      method: 'GET',
      servername: fqdn,
      rejectUnauthorized: true,
      agent: false,
      lookup: (hostname, lookupOpts, cb) => {
        if (typeof lookupOpts === 'function') {
          cb = lookupOpts;
          lookupOpts = {};
        }
        if (lookupOpts && lookupOpts.all) {
          cb(null, [{ address: pinnedTargetAddress, family: 4 }]);
        } else {
          cb(null, pinnedTargetAddress, 4);
        }
      },
      headers: {
        'Host': fqdn,
        'Accept': 'application/json',
        'User-Agent': 'liftoff-staging-private-http/1.0',
        'Connection': 'close'
      }
    };

    if (request._testSeam && request._testSeam.ca) {
      reqOptions.ca = request._testSeam.ca;
    }

    const req = https.request(reqOptions, (res) => {
      try {
        const socket = res.socket;
        if (!socket) throw new Error('Response socket was not available');

        // Check TLS authorization
        if (!socket.authorized) {
          throw new Error('TLS authorization failed: ' + (socket.authorizationError?.message || 'Certificate unauthorized'));
        }

        // Check remote peer address
        const rawPeer = socket.remoteAddress;
        const normalizedPeer = rawPeer ? rawPeer.replace(/^::ffff:/, '') : '';
        if (normalizedPeer !== expectedPrivateIp) {
          throw new Error('Remote peer address mismatch: observed ' + normalizedPeer + ', expected ' + expectedPrivateIp);
        }

        // Status 200 requirement (no redirects followed)
        if (res.statusCode !== 200) {
          throw new Error('Expected HTTP 200 OK, received status ' + res.statusCode);
        }

        // Content-Type requirement
        const rawContentType = String(res.headers['content-type'] || '');
        const mediaType = rawContentType.split(';')[0].trim().toLowerCase();
        if (mediaType !== 'application/json') {
          throw new Error('Content-Type must be application/json, received: ' + rawContentType);
        }

        // Capture actual TLS peer certificate facts
        const peerCert = typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate(true) : null;
        const certDetails = {
          subject: peerCert?.subject ? { ...peerCert.subject } : {},
          issuer: peerCert?.issuer ? { ...peerCert.issuer } : {},
          validFrom: peerCert?.valid_from || '',
          validTo: peerCert?.valid_to || '',
          fingerprint256: peerCert?.fingerprint256 || '',
          subjectAlternativeNames: peerCert?.subjectaltname ? peerCert.subjectaltname.split(', ') : []
        };

        const observedPeerPort = socket.remotePort || port;
        const observedAt = new Date().toISOString();

        let receivedBytes = 0;
        const chunks = [];

        res.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (receivedBytes > maxBodyBytes) {
            req.destroy(new Error('Response body exceeded maximum allowed size of ' + maxBodyBytes + ' bytes'));
          } else {
            chunks.push(chunk);
          }
        });

        res.on('end', () => {
          if (completed) return;
          try {
            const rawBuffer = Buffer.concat(chunks);
            const bodyDigest = createHash('sha256').update(rawBuffer).digest('hex');
            const text = new TextDecoder('utf-8', { fatal: true }).decode(rawBuffer);
            let parsedBody;
            try {
              parsedBody = JSON.parse(text);
            } catch (parseErr) {
              throw new Error('Response body was not valid JSON: ' + parseErr.message);
            }
            if (parsedBody === null || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
              throw new Error('Response JSON root must be an object');
            }

            const witness = {
              protocol: 'https:',
              fqdn: fqdn,
              path: path,
              observedDnsAddresses: [...observedDnsAddresses],
              peerAddress: normalizedPeer,
              peerPort: observedPeerPort,
              tlsAuthorized: socket.authorized === true,
              tlsPeerCertificate: certDetails,
              statusCode: res.statusCode,
              mediaType: mediaType,
              bodyDigest: bodyDigest,
              bodyBytesLength: rawBuffer.length,
              observedAt: observedAt
            };

            completed = true;
            cleanup();
            resolvePromise({
              witness: witness,
              body: parsedBody,
              bytes: rawBuffer
            });
          } catch (err) {
            fail(err);
          }
        });

        res.on('error', (err) => fail(err));
      } catch (err) {
        req.destroy();
        fail(err);
      }
    });

    req.on('error', (err) => fail(err));

    timer = setTimeout(() => {
      req.destroy(new Error('Staging private HTTP request timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);

    req.end();
  });
}
`;

/**
 * Exact instructions for embedding into parent reviewed workflow
 * (e.g. staging-security-workflow-program.ts).
 */
export const stagingPrivateHttpEmbeddingInstructions = `
COORDINATOR EMBEDDING INSTRUCTIONS:
1. Embed the string constant 'stagingPrivateHttpProgram' at the top of the workflow program
   or import 'stagingPrivateHttpFetch' into the target execution environment.
2. Replace ambient fetchJson calls for health and OpenAPI schema with stagingPrivateHttpFetch:
   const healthRes = await stagingPrivateHttpFetch({
     fqdn: recipe.target.fqdn,
     path: recipe.target.healthPath,
     expectedPrivateIp: recipe.target.privateIp,
     deadlineMs: deadline,
     timeoutMs: recipe.authority.limits.httpTimeoutSeconds * 1000
   });
   validateHealthResponseBody(healthRes.body);

   const schemaRes = await stagingPrivateHttpFetch({
     fqdn: recipe.target.fqdn,
     path: recipe.target.schemaPath,
     expectedPrivateIp: recipe.target.privateIp,
     deadlineMs: deadline,
     timeoutMs: recipe.authority.limits.httpTimeoutSeconds * 1000
   });
   validateOpenApiSchemaBody(schemaRes.body);

3. In report generation under prerequisites, attach the actual witness:
   prerequisites: {
     health: {
       path: recipe.target.healthPath,
       status: healthRes.witness.statusCode,
       mediaType: healthRes.witness.mediaType,
       bodyDigest: healthRes.witness.bodyDigest,
       statusValue: healthRes.body.status
     },
     schema: {
       path: recipe.target.schemaPath,
       status: schemaRes.witness.statusCode,
       mediaType: schemaRes.witness.mediaType,
       bodyDigest: schemaRes.witness.bodyDigest,
       openapi: schemaRes.body.openapi,
       paths: Object.keys(schemaRes.body.paths).sort()
     },
     privateAccess: {
       healthWitness: healthRes.witness,
       schemaWitness: schemaRes.witness
     },
     reachabilityVerified: true
   }

4. Note that witness contains actual socket facts and DNS values without copying expected fields
   or exposing response body contents in public witness structures.
`.trim();
