import { describe, expect, it, vi } from 'vitest';
import {
  fetchOsvSnapshot, planOsvApiRequest, requireOsvAdvisoryCoverage, sandboxOsvCommand
} from '../scripts/repository-security/osv-transport.ts';
import { osvDigest, type OsvGraph } from '../scripts/repository-security/osv.ts';

const sentinel = 'NONFUNCTIONAL_TRANSPORT_SENTINEL';
const coordinates = [{ name: 'urllib3', version: '1.26.5', ecosystem: 'PyPI' as const }];
const id = 'PYSEC-2023-192';
const query = () => ({ host: 'api.osv.dev', method: 'POST', path: '/v1/querybatch',
  body: { queries: [{ package: { name: 'urllib3', ecosystem: 'PyPI' }, version: '1.26.5' }] } });
const vulnerability = { id, modified: '2026-09-20T00:00:00Z', affected: [{ package: { name: 'urllib3', ecosystem: 'PyPI' } }] };

describe('OSV enforced coordinate transport', () => {
  it('constructs only the exact coordinate payload and approved advisory GETs', () => {
    const plan = planOsvApiRequest(query(), coordinates);
    expect(plan.host).toBe('api.osv.dev');
    expect(plan.body).toBe('{"queries":[{"package":{"name":"urllib3","ecosystem":"PyPI"},"version":"1.26.5"}]}');
    expect(Object.isFrozen(plan)).toBe(true);
    expect(planOsvApiRequest({ host: 'api.osv.dev', method: 'GET', path: `/v1/vulns/${id}`, body: null }, coordinates, [id]))
      .toEqual({ host: 'api.osv.dev', method: 'GET', path: `/v1/vulns/${id}`, body: null });
  });

  it('rejects hosts, redirects disguised as paths, source/SBOM payloads, credentials and private coordinates', () => {
    const candidates = [
      { ...query(), host: 'other.invalid' }, { ...query(), host: 'api.osv.dev.evil.invalid' },
      { ...query(), path: 'https://other.invalid/v1/querybatch' }, { ...query(), path: '/v1/querybatch?source=anything' },
      { ...query(), method: 'PUT' }, { ...query(), authorization: sentinel }, { ...query(), body: { sbom: sentinel } },
      { ...query(), body: { queries: query().body.queries, source: sentinel } },
      { ...query(), body: { queries: [{ ...query().body.queries[0], lockfile: sentinel }] } },
      { ...query(), body: { queries: [{ package: { name: sentinel, ecosystem: 'PyPI' }, version: '1.26.5' }] } },
      { host: 'api.osv.dev', method: 'GET', path: `/v1/vulns/${id}`, body: sentinel },
      { host: 'api.osv.dev', method: 'GET', path: '/v1/vulns/../../source', body: null }
    ];
    for (const candidate of candidates) {
      let error: unknown;
      try { planOsvApiRequest(candidate, coordinates); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(sentinel);
    }
  });

  it('rejects raw input fields before transport execution', async () => {
    const wire = vi.fn();
    await expect(fetchOsvSnapshot([{ ...coordinates[0]!, source: sentinel } as typeof coordinates[0]], wire)).rejects.toThrow();
    expect(wire).not.toHaveBeenCalled();
  });

  it('collects complete bounded matches without following advisory reference URLs', async () => {
    const wire = vi.fn(async plan => ({ statusCode: 200, tlsAuthorized: true,
      body: JSON.stringify(plan.method === 'POST' ? { results: [{ vulns: [{ id }] }] }
        : { ...vulnerability, references: [{ url: 'https://other.invalid/do-not-fetch' }], details: sentinel }) }));
    const result = await fetchOsvSnapshot(coordinates, wire);
    expect(wire).toHaveBeenCalledTimes(2);
    expect(result.matches[0]!.ids).toEqual([id]);
    expect(result.requests.map(request => request.host)).toEqual(['api.osv.dev', 'api.osv.dev']);
    expect(JSON.stringify(result.requests)).not.toContain(sentinel);
    expect(result.requests[0]!.bodyDigest).toBe(osvDigest(planOsvApiRequest(query(), coordinates).body!));
  });

  it.each([
    { statusCode: 302, tlsAuthorized: true, body: '{"location":"https://other.invalid"}' },
    { statusCode: 200, tlsAuthorized: false, body: '{"results":[{}]}' },
    { statusCode: 200, tlsAuthorized: true, body: sentinel },
    { statusCode: 200, tlsAuthorized: true, body: '{"results":[]}' },
    { statusCode: 200, tlsAuthorized: true, body: '{"results":[{"next_page_token":"not-qualified"}]}' }
  ])('fails closed on transport or incomplete response %#', async response => {
    const wire = vi.fn(async () => response);
    await expect(fetchOsvSnapshot(coordinates, wire)).rejects.toThrow('Security evidence rejected');
    expect(wire).toHaveBeenCalledTimes(1);
  });

  it('does not surface transport exceptions or server payloads', async () => {
    await expect(fetchOsvSnapshot(coordinates, async () => { throw new Error(sentinel); }))
      .rejects.toThrow('osv-api-unavailable');
  });

  it('rejects silent offline matcher drops even when package extraction is complete', async () => {
    const snapshot = await fetchOsvSnapshot(coordinates, async plan => ({ statusCode: 200, tlsAuthorized: true,
      body: JSON.stringify(plan.method === 'POST' ? { results: [{ vulns: [{ id }] }] } : vulnerability) }));
    const graph: OsvGraph = { id: 'standard-backend', pathParts: ['uv.lock'], inputDigest: osvDigest('fixture'),
      components: coordinates.map(item => ({ ...item, chains: [['fixture', item.name]] })) };
    const raw = { experimental_config: { licenses: { summary: false, allowlist: null } },
      results: [{ source: { path: '/owned/input.cdx.json', type: 'sbom' },
        packages: [{ package: coordinates[0], vulnerabilities: [] as { id: string }[] }] }] };
    expect(() => requireOsvAdvisoryCoverage(JSON.stringify(raw), '/owned/input.cdx.json', graph, snapshot))
      .toThrow('osv-api-advisory-coverage');
    raw.results[0]!.packages[0]!.vulnerabilities.push({ id });
    expect(() => requireOsvAdvisoryCoverage(JSON.stringify(raw), '/owned/input.cdx.json', graph, snapshot)).not.toThrow();
  });

  it('requires a qualified platform and offline scanner mode for the process sandbox', () => {
    expect(sandboxOsvCommand('/owned/osv', ['scan', 'source', '--offline'], 'darwin').executable).toBe('/usr/bin/sandbox-exec');
    expect(() => sandboxOsvCommand('/owned/osv', ['scan', 'source'], 'darwin')).toThrow('osv-network-sandbox-requires-offline');
    expect(() => sandboxOsvCommand('/owned/osv', ['--offline'], 'linux')).toThrow('osv-network-sandbox-unqualified');
    const linux = sandboxOsvCommand('/owned/osv', ['scan', 'source', '--offline'], 'linux', '/owned/python');
    expect(linux.executable).toBe('/owned/python');
    expect(linux.args.slice(0, 2)).toEqual(['-I', '-S']);
    expect(linux.args[2]).toMatch(/osv-linux-sandbox\.py$/);
    expect(linux.args.slice(3)).toEqual(['/owned/osv', 'scan', 'source', '--offline']);
    expect(() => sandboxOsvCommand('/owned/osv', ['scan', 'source'], 'linux', '/owned/python')).toThrow('requires-offline');
    expect(() => sandboxOsvCommand('/owned/osv', ['--offline'], 'linux', 'python')).toThrow('unqualified');
  });
});
