import { digest, identifier, record, SecurityEvidenceError } from './evidence.ts';
import { osvDigest, osvSbom, parseGoSumdbRecord, type OsvGraph } from './osv.ts';

const moduleName = 'github.com/pressly/goose/v3';
const baselineLookup = ['goModules', 'go-backend', 'tools', moduleName];
type ChecksumSource = 'authenticated-upstream-go.sum' | 'go-verified-sumdb-cache';
export interface GoToolModule {
  name: string;
  version: string;
  sum: string;
  goModSum: string;
  chains: string[][];
  provenance: { sum: ChecksumSource; goModSum: ChecksumSource; sumdbRecordDigest: string | null };
}
export interface GoToolGraphContract {
  schemaVersion: 1;
  graph: 'go-backend';
  baseline: { pathParts: ['assets', 'supported-stack.json']; lookup: string[] };
  root: { name: string; version: string; sum: string; goModSum: string; archiveDigest: string;
    goModDigest: string; upstreamGoSumDigest: string };
  derivation: {
    method: 'frozen-go-list-m-all';
    goVersion: string;
    goExecutableDigest: string;
    rootGoVersion: string;
    moduleGraphDigest: string;
    selectedGraphDigest: string;
    observedAt: string;
    proxy: 'https://proxy.golang.org';
    sumdb: 'sum.golang.org';
    toolchain: 'local';
    metadata: 'readonly';
  };
  modules: GoToolModule[];
  sumdbRecords: { name: string; version: string; recordDigest: string; record: string }[];
}

function fail(): never { throw new SecurityEvidenceError('osv-invalid-tool-graph-contract'); }
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^h1:[A-Za-z0-9+/]{43}=$/.test(value)) fail();
  return value;
}
function version(value: unknown): string {
  const result = identifier(value, 'osv-invalid-go-version');
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?$/.test(result)) fail();
  return result;
}
function array(value: unknown, min = 1): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > 10_000) fail();
  return value;
}
function source(value: unknown): ChecksumSource {
  if (value !== 'authenticated-upstream-go.sum' && value !== 'go-verified-sumdb-cache') fail();
  return value;
}

/** Structural validation is not policy adoption or independent signature verification. */
export function parseGoToolGraphContract(text: string, expectedVersion: string): GoToolGraphContract {
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) fail();
  let input: unknown;
  try { input = JSON.parse(text); } catch { return fail(); }
  const top = record(input, ['schemaVersion', 'graph', 'baseline', 'root', 'derivation', 'modules', 'sumdbRecords'],
    'osv-invalid-tool-graph-contract');
  if (top.schemaVersion !== 1 || top.graph !== 'go-backend') fail();
  const baseline = record(top.baseline, ['pathParts', 'lookup'], 'osv-invalid-tool-graph-contract');
  if (JSON.stringify(baseline.pathParts) !== '["assets","supported-stack.json"]' ||
      JSON.stringify(baseline.lookup) !== JSON.stringify(baselineLookup)) fail();
  const root = record(top.root, ['name', 'version', 'sum', 'goModSum', 'archiveDigest', 'goModDigest', 'upstreamGoSumDigest'],
    'osv-invalid-tool-graph-contract');
  if (root.name !== moduleName || root.version !== expectedVersion) fail();
  const derivation = record(top.derivation, ['method', 'goVersion', 'goExecutableDigest', 'rootGoVersion',
    'moduleGraphDigest', 'selectedGraphDigest', 'observedAt', 'proxy', 'sumdb', 'toolchain', 'metadata'],
  'osv-invalid-tool-graph-contract');
  if (derivation.method !== 'frozen-go-list-m-all' || derivation.proxy !== 'https://proxy.golang.org' ||
      derivation.sumdb !== 'sum.golang.org' || derivation.toolchain !== 'local' || derivation.metadata !== 'readonly') fail();
  for (const name of ['goVersion', 'rootGoVersion']) {
    if (typeof derivation[name] !== 'string' || !/^1\.[0-9]+\.[0-9]+$/.test(derivation[name])) fail();
  }
  if (typeof derivation.observedAt !== 'string' || !Number.isFinite(Date.parse(derivation.observedAt)) ||
      new Date(derivation.observedAt).toISOString() !== derivation.observedAt) fail();
  const modules = array(top.modules).map(value => {
    const item = record(value, ['name', 'version', 'sum', 'goModSum', 'chains', 'provenance'], 'osv-invalid-tool-graph-contract');
    const provenance = record(item.provenance, ['sum', 'goModSum', 'sumdbRecordDigest'], 'osv-invalid-tool-graph-contract');
    return { name: identifier(item.name, 'osv-invalid-module'), version: version(item.version),
      sum: hash(item.sum), goModSum: hash(item.goModSum), chains: array(item.chains).map(chain =>
        array(chain).map(value => identifier(value, 'osv-invalid-chain'))), provenance: {
        sum: source(provenance.sum), goModSum: source(provenance.goModSum),
        sumdbRecordDigest: provenance.sumdbRecordDigest === null ? null : digest(provenance.sumdbRecordDigest)
      } };
  });
  if (new Set(modules.map(item => item.name)).size !== modules.length) fail();
  if (modules.some(item => item.chains.length > 100 || item.chains.some(chain => chain.length > 50) ||
      new Set(item.chains.map(chain => JSON.stringify(chain))).size !== item.chains.length)) fail();
  const roots = modules.filter(item => item.name === root.name);
  if (roots.length !== 1 || roots[0]!.version !== root.version || roots[0]!.sum !== root.sum || roots[0]!.goModSum !== root.goModSum) fail();
  const sumdbRecords = array(top.sumdbRecords).map(value => {
    const item = record(value, ['name', 'version', 'recordDigest', 'record'], 'osv-invalid-tool-graph-contract');
    const name = identifier(item.name, 'osv-invalid-module'), v = version(item.version);
    if (typeof item.record !== 'string') fail();
    const parsed = parseGoSumdbRecord(item.record, name, v);
    if (parsed.recordDigest !== digest(item.recordDigest)) fail();
    const module = modules.find(module => module.name === name && module.version === v);
    if (!module || module.sum !== parsed.sum || module.goModSum !== parsed.goModSum ||
        module.provenance.sumdbRecordDigest !== parsed.recordDigest) fail();
    return { name, version: v, recordDigest: parsed.recordDigest, record: item.record };
  });
  if (new Set(sumdbRecords.map(item => item.name)).size !== sumdbRecords.length) fail();
  for (const module of modules) {
    const needsRecord = module.provenance.sum === 'go-verified-sumdb-cache' ||
      module.provenance.goModSum === 'go-verified-sumdb-cache';
    if (needsRecord !== (module.provenance.sumdbRecordDigest !== null) ||
        needsRecord && !sumdbRecords.some(item => item.name === module.name && item.version === module.version)) fail();
  }
  const result: GoToolGraphContract = {
    schemaVersion: 1, graph: 'go-backend', baseline: { pathParts: ['assets', 'supported-stack.json'], lookup: baselineLookup },
    root: { name: moduleName, version: version(root.version), sum: hash(root.sum), goModSum: hash(root.goModSum),
      archiveDigest: digest(root.archiveDigest), goModDigest: digest(root.goModDigest),
      upstreamGoSumDigest: digest(root.upstreamGoSumDigest) },
    derivation: { method: 'frozen-go-list-m-all', goVersion: derivation.goVersion as string,
      goExecutableDigest: digest(derivation.goExecutableDigest), rootGoVersion: derivation.rootGoVersion as string,
      moduleGraphDigest: digest(derivation.moduleGraphDigest), selectedGraphDigest: digest(derivation.selectedGraphDigest),
      observedAt: derivation.observedAt, proxy: 'https://proxy.golang.org', sumdb: 'sum.golang.org',
      toolchain: 'local', metadata: 'readonly' },
    modules, sumdbRecords
  };
  osvSbom(goToolContractGraph(result));
  return result;
}

export function goToolContractGraph(contract: GoToolGraphContract): OsvGraph {
  return { id: 'go-backend', pathParts: ['security', 'go-tool-graphs.json'], inputDigest: osvDigest(JSON.stringify(contract)),
    components: contract.modules.map(item => ({ name: item.name, version: item.version, ecosystem: 'Go',
      chains: item.chains.map(chain => [...chain]) })) };
}

export function requireGoToolContractObservation(
  contract: GoToolGraphContract, selected: OsvGraph, exactSums: readonly { name: string; version: string; sum: string; goModSum: string }[],
  upstreamGoSum?: string
): void {
  if (contract.derivation.selectedGraphDigest !== selected.inputDigest ||
      contract.modules.length !== selected.components.length || exactSums.length !== contract.modules.length) fail();
  for (const module of contract.modules) {
    if (!selected.components.some(item => item.name === module.name && item.version === module.version &&
      JSON.stringify(item.chains) === JSON.stringify(module.chains)) ||
        !exactSums.some(item => item.name === module.name && item.version === module.version &&
          item.sum === module.sum && item.goModSum === module.goModSum)) fail();
    if (upstreamGoSum !== undefined) {
      for (const [suffix, value, provenance] of [
        ['', module.sum, module.provenance.sum], ['/go.mod', module.goModSum, module.provenance.goModSum]
      ]) {
        const present = upstreamGoSum.split(/\r?\n/).includes(`${module.name} ${module.version}${suffix} ${value}`);
        if (present !== (provenance === 'authenticated-upstream-go.sum')) fail();
      }
    }
  }
}

export function createGoToolGraphContract(options: {
  expectedVersion: string; root: GoToolGraphContract['root']; derivation: GoToolGraphContract['derivation'];
  selected: OsvGraph; upstreamGoSum: string;
  exactSums: readonly { name: string; version: string; sum: string; goModSum: string }[];
  records: GoToolGraphContract['sumdbRecords'];
}): GoToolGraphContract {
  const upstream = new Map(options.upstreamGoSum.trim().split(/\r?\n/).map(line => {
    const [name, version, hash] = line.split(' ');
    return [`${name}@${version}`, hash];
  }));
  const modules = options.exactSums.map(item => {
    const sum: ChecksumSource = upstream.get(`${item.name}@${item.version}`) === item.sum
      ? 'authenticated-upstream-go.sum' : 'go-verified-sumdb-cache';
    const goModSum: ChecksumSource = upstream.get(`${item.name}@${item.version}/go.mod`) === item.goModSum
      ? 'authenticated-upstream-go.sum' : 'go-verified-sumdb-cache';
    const proof = options.records.find(record => record.name === item.name && record.version === item.version);
    const selected = options.selected.components.find(component => component.name === item.name && component.version === item.version);
    return { ...item, chains: selected?.chains, provenance: { sum, goModSum,
      sumdbRecordDigest: sum === 'go-verified-sumdb-cache' || goModSum === 'go-verified-sumdb-cache'
        ? proof?.recordDigest : null } };
  }).sort((a, b) => a.name < b.name ? -1 : 1);
  const contract = parseGoToolGraphContract(JSON.stringify({
    schemaVersion: 1, graph: 'go-backend',
    baseline: { pathParts: ['assets', 'supported-stack.json'], lookup: baselineLookup },
    root: options.root, derivation: options.derivation, modules,
    sumdbRecords: [...options.records].sort((a, b) => a.name < b.name ? -1 : 1)
  }), options.expectedVersion);
  requireGoToolContractObservation(contract, options.selected, options.exactSums, options.upstreamGoSum);
  return contract;
}
