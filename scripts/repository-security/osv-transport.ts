import { request } from 'node:https';
import type { ClientRequest } from 'node:http';
import { TLSSocket } from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecurityEvidenceError, identifier, record } from './evidence.ts';
import {
  extractedOsvComponents, osvAdvisoryId, osvBounds, osvDigest, requireOsvExtraction, type OsvGraph
} from './osv.ts';

export interface OsvCoordinate { name: string; version: string; ecosystem: 'PyPI' | 'Go' }
export interface OsvApiPlan {
  readonly host: 'api.osv.dev';
  readonly method: 'POST' | 'GET';
  readonly path: string;
  readonly body: string | null;
}
export interface OsvSnapshot {
  coordinates: OsvCoordinate[];
  matches: { coordinate: OsvCoordinate; ids: string[] }[];
  advisories: Record<string, unknown>[];
  requests: { host: 'api.osv.dev'; method: 'POST' | 'GET'; route: 'querybatch' | 'advisory';
    bodyDigest: string | null; queryCount: number; tlsAuthorized: true }[];
  digest: string;
}
type WireResult = { statusCode: number; body: string; tlsAuthorized: boolean };
type Wire = (plan: OsvApiPlan) => Promise<WireResult>;
const coordinateKey = (coordinate: OsvCoordinate) => `${coordinate.ecosystem}:${coordinate.name}@${coordinate.version}`;
function reject(code = 'osv-api-boundary'): never { throw new SecurityEvidenceError(code); }
function array(value: unknown, max = 1000): unknown[] {
  if (!Array.isArray(value) || value.length > max) reject();
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
  return value as Record<string, unknown>;
}
function json(source: string): unknown {
  if (!source || Buffer.byteLength(source) > osvBounds.stdout) reject('osv-api-response-size');
  try { return JSON.parse(source); } catch { return reject('osv-api-response-json'); }
}
function coordinate(value: unknown): OsvCoordinate {
  const item = record(value, ['name', 'version', 'ecosystem'], 'osv-api-coordinate');
  if (item.ecosystem !== 'PyPI' && item.ecosystem !== 'Go') reject('osv-api-coordinate');
  return { name: identifier(item.name, 'osv-api-coordinate'), version: identifier(item.version, 'osv-api-coordinate'),
    ecosystem: item.ecosystem };
}

/** Only this validated, newly constructed plan reaches the HTTPS implementation. */
export function planOsvApiRequest(
  value: unknown, allowedCoordinates: readonly OsvCoordinate[], returnedAdvisories: readonly string[] = []
): OsvApiPlan {
  const input = record(value, ['host', 'method', 'path', 'body'], 'osv-api-boundary');
  if (input.host !== 'api.osv.dev') reject();
  const allowed = allowedCoordinates.map(coordinate), keys = new Set(allowed.map(coordinateKey));
  if (!allowed.length || keys.size !== allowed.length || allowed.length > 1000) reject();
  if (input.method === 'POST' && input.path === '/v1/querybatch') {
    const body = record(input.body, ['queries'], 'osv-api-boundary');
    const queries = array(body.queries).map(value => {
      const query = record(value, ['package', 'version'], 'osv-api-boundary');
      const pkg = record(query.package, ['name', 'ecosystem'], 'osv-api-boundary');
      const selected = coordinate({ name: pkg.name, ecosystem: pkg.ecosystem, version: query.version });
      if (!keys.has(coordinateKey(selected))) reject('osv-api-unapproved-coordinate');
      return { package: { name: selected.name, ecosystem: selected.ecosystem }, version: selected.version };
    });
    if (queries.length !== allowed.length || new Set(queries.map(query =>
      `${query.package.ecosystem}:${query.package.name}@${query.version}`)).size !== keys.size) reject('osv-api-query-coverage');
    return Object.freeze({ host: 'api.osv.dev', method: 'POST', path: '/v1/querybatch', body: JSON.stringify({ queries }) });
  }
  if (input.method === 'GET' && typeof input.path === 'string' && input.body === null &&
      input.path.startsWith('/v1/vulns/')) {
    const id = osvAdvisoryId(input.path.slice('/v1/vulns/'.length));
    if (!returnedAdvisories.includes(id)) reject('osv-api-unapproved-advisory');
    return Object.freeze({ host: 'api.osv.dev', method: 'GET', path: `/v1/vulns/${id}`, body: null });
  }
  return reject();
}

async function httpsWire(plan: OsvApiPlan): Promise<WireResult> {
  return new Promise((resolve, fail) => {
    let completed = false;
    let req: ClientRequest | undefined, timer: NodeJS.Timeout | undefined;
    const stop = (code: string) => {
      if (!completed) {
        completed = true;
        clearTimeout(timer);
        req?.destroy();
        fail(new SecurityEvidenceError(code));
      }
    };
    try { req = request({
      protocol: 'https:', hostname: 'api.osv.dev', servername: 'api.osv.dev', port: 443,
      method: plan.method, path: plan.path, rejectUnauthorized: true, agent: false,
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'liftoff-osv-coordinate-boundary/1',
        ...(plan.body === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(plan.body) }) }
    }, response => {
      const chunks: Buffer[] = [];
      const tlsAuthorized = response.socket instanceof TLSSocket && response.socket.authorized;
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > osvBounds.stdout) stop('osv-api-response-size');
        else chunks.push(chunk);
      });
      response.on('error', () => stop('osv-api-unavailable'));
      response.on('aborted', () => stop('osv-api-unavailable'));
      response.on('end', () => {
        clearTimeout(timer);
        if (completed) return;
        completed = true;
        resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'),
          tlsAuthorized });
      });
    }); } catch { stop('osv-api-unavailable'); return; }
    timer = setTimeout(() => stop('osv-api-timeout'), 15_000);
    req.on('error', () => stop('osv-api-unavailable'));
    req.end(plan.body);
  });
}

// The optional wire is for deterministic fixtures, never a host/proxy override.
// Real qualification calls this without injection; Node core HTTPS does not
// consult proxy/credential environment variables or follow redirects.
export async function fetchOsvSnapshot(input: readonly OsvCoordinate[], wire: Wire = httpsWire): Promise<OsvSnapshot> {
  const coordinates = input.map(coordinate);
  const requests: OsvSnapshot['requests'] = [];
  let totalBytes = 0;
  const deadline = Date.now() + osvBounds.timeoutMs;
  async function send(plan: OsvApiPlan) {
    if (Date.now() > deadline) reject('osv-api-timeout');
    let result: WireResult;
    try { result = await wire(plan); } catch (error) {
      if (error instanceof SecurityEvidenceError && [
        'osv-api-timeout', 'osv-api-response-size', 'osv-api-unavailable'
      ].includes(error.code)) throw error;
      return reject('osv-api-unavailable');
    }
    if (result.statusCode !== 200 || !result.tlsAuthorized) reject('osv-api-response-rejected');
    totalBytes += Buffer.byteLength(result.body);
    if (totalBytes > 32 * 1024 * 1024) reject('osv-api-response-size');
    requests.push({ host: 'api.osv.dev', method: plan.method, route: plan.method === 'POST' ? 'querybatch' : 'advisory',
      bodyDigest: plan.body === null ? null : osvDigest(plan.body), queryCount: plan.method === 'POST' ? coordinates.length : 0,
      tlsAuthorized: true });
    return json(result.body);
  }
  const plan = planOsvApiRequest({
    host: 'api.osv.dev', method: 'POST', path: '/v1/querybatch',
    body: { queries: coordinates.map(item => ({ package: { name: item.name, ecosystem: item.ecosystem }, version: item.version })) }
  }, coordinates);
  const batch = record(await send(plan), ['results'], 'osv-api-response');
  const results = array(batch.results);
  if (results.length !== coordinates.length) reject('osv-api-query-coverage');
  const matches = results.map((value, index) => {
    const result = object(value);
    if (Object.keys(result).some(key => !['vulns', 'next_page_token'].includes(key))) reject('osv-api-response');
    if (result.next_page_token) reject('osv-api-pagination-unqualified');
    const ids = array(result.vulns ?? []).map(vuln => osvAdvisoryId(object(vuln).id)).sort();
    if (new Set(ids).size !== ids.length) reject('osv-api-response');
    return { coordinate: coordinates[index]!, ids };
  });
  const ids = [...new Set(matches.flatMap(item => item.ids))].sort();
  if (ids.length > 200) reject('osv-api-advisory-limit');
  const advisories: Record<string, unknown>[] = [];
  for (const id of ids) {
    const value = object(await send(planOsvApiRequest({
      host: 'api.osv.dev', method: 'GET', path: `/v1/vulns/${id}`, body: null
    }, coordinates, ids)));
    if (value.id !== id || !Array.isArray(value.affected) || !value.affected.length ||
        typeof value.modified !== 'string' || !Number.isFinite(Date.parse(value.modified))) reject('osv-api-advisory-mismatch');
    advisories.push(value);
  }
  return { coordinates, matches, advisories, requests, digest: osvDigest(JSON.stringify({ coordinates, matches, advisories })) };
}

export function requireOsvAdvisoryCoverage(source: string, inputPath: string, graph: OsvGraph, snapshot: OsvSnapshot): void {
  requireOsvExtraction(source, inputPath, graph);
  const coordinates = extractedOsvComponents(source, inputPath);
  const report = object(json(source));
  const rows = array(object(array(report.results)[0]).packages);
  if (snapshot.matches.length !== rows.length) reject('osv-api-query-coverage');
  rows.forEach((value, index) => {
    const row = object(value), current = coordinates[index]!;
    const expected = snapshot.matches.find(item => coordinateKey(item.coordinate) === coordinateKey(current));
    const ids = array(row.vulnerabilities ?? []).map(vuln => osvAdvisoryId(object(vuln).id)).sort();
    if (!expected || JSON.stringify(ids) !== JSON.stringify(expected.ids)) reject('osv-api-advisory-coverage');
  });
}

export const osvNoNetworkProfile = '(version 1) (allow default) (deny network*)';
export function linuxOsvNetworkProbe(python: string) {
  if (!path.isAbsolute(python) || /[\0\r\n]/.test(python)) reject('osv-network-sandbox-unqualified');
  return { executable: python, args: ['-I', '-S', fileURLToPath(new URL('./osv-linux-sandbox.py', import.meta.url)), '--probe'] };
}
export function sandboxOsvCommand(executable: string, args: readonly string[], platform = process.platform, python?: string) {
  if (!['darwin', 'linux'].includes(platform) || platform === 'linux' && !python) reject('osv-network-sandbox-unqualified');
  if (!args.includes('--offline') && args[0] !== '--version') reject('osv-network-sandbox-requires-offline');
  if (platform === 'linux') {
    if (!path.isAbsolute(executable) || /[\0\r\n]/.test(executable)) reject('osv-network-sandbox-unqualified');
    const command = linuxOsvNetworkProbe(python!);
    return { executable: command.executable, args: [...command.args.slice(0, -1), executable, ...args] };
  }
  return { executable: '/usr/bin/sandbox-exec', args: ['-p', osvNoNetworkProfile, executable, ...args] };
}
