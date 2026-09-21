import { chmod, lstat, open, readFile, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSecurityWorkspace, type RegisteredWorkspace } from './workspace.ts';
import { dependencyInventory } from './inventory.ts';
import {
  classifyPublishedAdvisory, isPublishedCvssVector, nativeOwnCvssClassification, projectPublishedAdvisories, publishedOsvSnapshotMetadata,
  type OwnAdvisoryClassification, type PublishedAdvisoryMetadata
} from './osv-advisory.ts';
import { evaluateSecurityReport, portableParts, SecurityEvidenceError, type EvidenceIdentity, type SecurityReport } from './evidence.ts';
import {
  createGoToolGraphContract, goToolContractGraph, parseGoToolGraphContract, requireGoToolContractObservation,
  type GoToolGraphContract
} from './osv-go-contract.ts';
import {
  fetchOsvSnapshot, linuxOsvNetworkProbe, osvNoNetworkProfile, requireOsvAdvisoryCoverage, sandboxOsvCommand, type OsvSnapshot
} from './osv-transport.ts';
import {
  extractedOsvComponents, normalizeOsvReport, osvArguments, osvDigest, osvRelease,
  osvSbom, readUvLock, reconcileUvLock, workerRequirementsCoverage, requireOsvExtraction, runOsvBoundary,
  verifyOsvDownload, verifyOsvVersion, frozenGoEnvironment, parseGoJsonStream, reconcileGoResolution, goChecksumGaps,
  parseGoSumdbRecord, combineGoGraphs,
  OsvUnclassifiedSeverityError, osvUnscoredPolicyRules, type OsvSeverityIssue,
  type GoVerifiedChecksum, type OsvGraph, type OsvInputFormat
} from './osv.ts';

// Run with Node 24 and --python=/absolute/path/to/python3.11-or-newer.
// --extract-locks never queries advisories; --public-fixtures queries only the
// fixed public coordinates below. --resolve-go --go=/absolute/path/to/go starts
// offline; --restore-go permits only missing canonical proxy/sumdb metadata.
// Resolution receipts remain blocked, not finding or adopted-policy verdicts.
export const publicOsvFixtures = {
  clean: [{ name: 'six', version: '1.17.0', dependencies: [] }],
  transitive: [
    { name: 'requests', version: '2.32.5', dependencies: ['certifi', 'charset-normalizer', 'idna', 'urllib3'] },
    { name: 'certifi', version: '2025.8.3', dependencies: [] },
    { name: 'charset-normalizer', version: '3.4.3', dependencies: [] },
    { name: 'idna', version: '3.10', dependencies: [] },
    { name: 'urllib3', version: '1.26.5', dependencies: [] }
  ]
} as const;

// A nonfunctional query fixture using x/net's published exact direct dependency
// relationship to vulnerable x/text. It is not the repository or a claim about
// the entire historical x/net build list.
export const publicGoFixture: OsvGraph = {
  id: 'go-backend', pathParts: ['fixture', 'go', 'full-graph.cdx.json'],
  inputDigest: osvDigest('nonfunctional-go-transitive-query-fixture-v1'),
  components: [
    { name: 'golang.org/x/net', version: 'v0.0.0-20220722155237-a158d28d115b',
      ecosystem: 'Go', chains: [['fixture', 'golang.org/x/net']] },
    ...[
      ['golang.org/x/sys', 'v0.0.0-20220520151302-bc2c85ada10a'],
      ['golang.org/x/term', 'v0.0.0-20210927222741-03fcf44c2211'],
      ['golang.org/x/text', 'v0.3.7']
    ].map(([name, version]) => ({ name: name!, version: version!, ecosystem: 'Go' as const,
      chains: [['fixture', 'golang.org/x/net', name!]] }))
  ]
};

function fixtureLock(which: keyof typeof publicOsvFixtures): string {
  const packages = publicOsvFixtures[which], root = packages[0]!;
  return `version = 1\nrevision = 3\nrequires-python = ">=3.11"\n\n[[package]]
name = "osv-nonfunctional-fixture"
version = "0.0.0"
source = { virtual = "." }
dependencies = [{ name = "${root.name}" }]
[package.optional-dependencies]
[package.metadata]
provides-extras = []
` + packages.map(item => `
[[package]]
name = "${item.name}"
version = "${item.version}"
source = { registry = "https://pypi.org/simple" }
dependencies = [${item.dependencies.map(name => `{ name = "${name}" }`).join(', ')}]
`).join('');
}

export async function createOsvWorkspace(
  repoRoot: string, outsideParent = process.env.LIFTOFF_SECURITY_WORKSPACE_PARENT
): Promise<RegisteredWorkspace> {
  if (!outsideParent) throw new SecurityEvidenceError('osv-external-workspace-parent-required');
  const root = await realpath(repoRoot);
  const parent = path.resolve(outsideParent);
  const lexical = path.relative(root, parent);
  if (lexical === '' || !lexical.startsWith(`..${path.sep}`) && lexical !== '..' && !path.isAbsolute(lexical)) {
    throw new SecurityEvidenceError('osv-workspace-inside-source');
  }
  const status = await lstat(parent);
  if (!status.isDirectory() || status.isSymbolicLink() ||
      typeof process.getuid === 'function' && status.uid !== process.getuid()) {
    throw new SecurityEvidenceError('osv-external-parent-unsafe');
  }
  const canonical = await realpath(parent), relative = path.relative(root, canonical);
  if (relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
    throw new SecurityEvidenceError('osv-workspace-inside-source');
  }
  // The child receives a fresh private owner marker and exact cleanup ledger.
  // The explicitly selected artifact parent and other workers' roots are never removed.
  return createSecurityWorkspace(path.relative(process.cwd(), canonical));
}

async function download(asset: string, max: number): Promise<Uint8Array> {
  let url = `https://github.com/${osvRelease.repository}/releases/download/v${osvRelease.version}/${asset}`;
  try {
    for (let redirects = 0; redirects < 5; redirects++) {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = new URL(response.headers.get('location') ?? '', url);
        if (next.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com'].includes(next.hostname)) {
          throw new Error();
        }
        await response.body?.cancel();
        url = next.href;
        continue;
      }
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let count = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return Buffer.concat(chunks);
        count += value.byteLength;
        if (count > max) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
    }
  } catch { /* no URL, response content or download exception crosses the boundary */ }
  throw new SecurityEvidenceError('osv-tool-download-failed');
}

async function requireRuntimeNetworkDenial(workspace: RegisteredWorkspace, python?: string): Promise<void> {
  if (process.platform === 'linux' && python) {
    await runOsvBoundary({
      ...linuxOsvNetworkProbe(python), cwd: workspace.root,
      env: { HOME: workspace.root, TMPDIR: workspace.root }, timeoutMs: 5000,
      project: output => {
        if (output.trim() !== '{"ipv4":true,"ipv6":true,"unix":true,"ioUring":true,"seccomp":true,"noNewPrivileges":true}') {
          throw new SecurityEvidenceError('osv-network-denial-unproven');
        }
      }
    });
    return;
  }
  if (process.platform !== 'darwin') throw new SecurityEvidenceError('osv-network-sandbox-unqualified');
  const source = `const net=require('node:net');const s=net.connect({host:'127.0.0.1',port:9});
s.on('error',e=>{console.log(JSON.stringify({blocked:e.code==='EPERM'||e.code==='EACCES'}));});
s.on('connect',()=>{s.destroy();process.exitCode=2;});`;
  await runOsvBoundary({
    executable: '/usr/bin/sandbox-exec', args: ['-p', osvNoNetworkProfile, process.execPath, '-e', source],
    cwd: workspace.root, env: { HOME: workspace.root, TMPDIR: workspace.root }, timeoutMs: 5000,
    project: output => {
      if (output.trim() !== '{"blocked":true}') throw new SecurityEvidenceError('osv-network-denial-unproven');
    }
  });
}

interface OsvScanOptions {
  workspace: RegisteredWorkspace; executable: string; python: string; input: string; config: string;
  graph: OsvGraph; identity: EvidenceIdentity; name: string; owner?: string;
}

async function scanWithOsvTransport(options: OsvScanOptions): Promise<{ report: SecurityReport; transport: object }> {
  const { workspace, graph } = options;
  await requireRuntimeNetworkDenial(workspace, options.python);
  const snapshot = await fetchOsvSnapshot(graph.components.map(({ name, version, ecosystem }) => ({ name, version, ecosystem })));
  const classifications: OwnAdvisoryClassification[] = [];
  const nativeScores: object[] = [];
  for (const [index, metadata] of publishedOsvSnapshotMetadata(graph, snapshot).entries()) {
    try { classifications.push(classifyPublishedAdvisory(metadata)); }
    catch (error) {
      if (!(error instanceof SecurityEvidenceError) || error.code !== 'osv-unsupported-published-severity' ||
          metadata.unsupportedSeverityEntries || metadata.labels.length || !metadata.vectors.length ||
          metadata.vectors.some(vector => !isPublishedCvssVector(vector.type, vector.vector))) throw error;
      const component = graph.components.find(item => item.name === metadata.package && item.version === metadata.version)!;
      const advisory = snapshot.advisories.find(item => item.id === metadata.advisory)!;
      const coordinate = { name: component.name, version: component.version, ecosystem: component.ecosystem };
      const scoreSnapshot: OsvSnapshot = {
        coordinates: [coordinate], matches: [{ coordinate, ids: [metadata.advisory] }],
        advisories: [advisory], requests: [], digest: osvDigest(JSON.stringify({ coordinate, advisory }))
      };
      const selected: OsvGraph = { ...graph, components: [component], inputDigest: scoreSnapshot.digest };
      const parts = ['own-scores', options.name, `${index}.cdx.json`], sbom = osvSbom(selected);
      await workspace.write(parts, sbom);
      const scored = await scanOfflineOsvSnapshot({
        ...options, graph: selected, input: path.join(workspace.root, ...parts), name: `${options.name}-score-${index}`
      }, scoreSnapshot);
      const own = nativeOwnCvssClassification(metadata, scored.report);
      const severity = own.severity;
      classifications.push(own);
      nativeScores.push({ package: metadata.package, version: metadata.version, advisory: metadata.advisory,
        severity, source: 'pinned-offline-single-advisory-single-component', snapshotDigest: scoreSnapshot.digest,
        reportDigest: osvDigest(JSON.stringify(scored.report)), transport: scored.transport });
      await workspace.verify(parts, sbom);
    }
  }
  const result = await scanOfflineOsvSnapshot(options, snapshot, classifications);
  return { report: result.report, transport: { assessment: result.transport, nativeOwnScoreEvidence: nativeScores } };
}

async function scanOfflineOsvSnapshot(
  options: OsvScanOptions, snapshot: OsvSnapshot, classifications?: readonly OwnAdvisoryClassification[]
): Promise<{ report: SecurityReport; transport: object }> {
  const { workspace, graph } = options;
  const env = { HOME: workspace.root, USERPROFILE: workspace.root, TMPDIR: workspace.root, TMP: workspace.root, TEMP: workspace.root, PATH: '' };
  const dbParts = ['transport', options.name], dbRoot = path.join(workspace.root, ...dbParts);
  const binaries: { file: string; digest: string }[] = [];
  try {
    for (const ecosystem of [...new Set(graph.components.map(item => item.ecosystem))]) {
      const parts = [...dbParts, 'osv-scalibr', ecosystem];
      await workspace.write([...parts, '.registered'], '');
      const data = await runOsvBoundary({
        executable: options.python, args: ['-I', '-S', '-c', `import base64,io,json,sys,zipfile
b=io.BytesIO()
with zipfile.ZipFile(b,"w",compression=zipfile.ZIP_DEFLATED) as z:
 for v in json.load(sys.stdin): z.writestr(v["id"]+".json",json.dumps(v))
print(base64.b64encode(b.getvalue()).decode("ascii"))`],
        cwd: workspace.root, env, stdin: JSON.stringify(snapshot.advisories),
        project: source => {
          if (!/^[A-Za-z0-9+/]+={0,2}\n?$/.test(source)) throw new SecurityEvidenceError('osv-database-encoding');
          return Buffer.from(source.trim(), 'base64');
        }
      });
      const filePath = path.join(workspace.root, ...parts, 'all.zip'), file = await open(filePath, 'wx', 0o600);
      binaries.push({ file: filePath, digest: osvDigest(data) });
      try { await file.writeFile(data); } finally { await file.close(); }
    }
    const args = osvArguments('extract', 'cdx', options.input, options.config)
      .filter(arg => arg !== '--experimental-disable-plugins=vulnmatch/osvdev,vulnmatch/osvlocal');
    args.push('--experimental-disable-plugins=vulnmatch/osvdev', '--local-db-path', dbRoot);
    const generatedAt = new Date().toISOString();
    const projected = await runOsvBoundary({
      ...sandboxOsvCommand(options.executable, args, process.platform, options.python), cwd: workspace.root, env, acceptedExits: [0, 1],
      project: (source, exitCode) => {
        requireOsvAdvisoryCoverage(source, options.input, graph, snapshot);
        try {
          return { report: normalizeOsvReport({ source, exitCode, expectedPath: options.input, graph, identity: options.identity,
            owner: options.owner ?? 'fixture-only', generatedAt, completedAt: new Date().toISOString(), classifications }), issues: [] };
        } catch (error) {
          if (!(error instanceof OsvUnclassifiedSeverityError)) throw error;
          return { report: null, issues: error.issues };
        }
      }
    });
    if (projected.report === null) {
      throw new OsvPublishedClassificationError(projected.issues, projectPublishedAdvisories(graph, projected.issues, snapshot));
    }
    const report = projected.report;
    return { report, transport: { kind: 'fixed-origin-coordinate-client-and-network-denied-offline-osv',
      runtimeSocketDenial: 'EPERM-or-EACCES', requests: snapshot.requests, snapshotDigest: snapshot.digest,
      databaseDigests: binaries.map(file => file.digest), scopedDatabase: true } };
  } finally {
    for (const binary of binaries) {
      const status = await lstat(binary.file);
      if (!status.isFile() || status.isSymbolicLink() || osvDigest(await readFile(binary.file)) !== binary.digest) {
        throw new SecurityEvidenceError('osv-database-cleanup-identity');
      }
      await unlink(binary.file);
    }
  }
}

async function qualifyOwnCvssControls(
  workspace: RegisteredWorkspace, executable: string, python: string, config: string
) {
  await requireRuntimeNetworkDenial(workspace);
  const controls = [
    { name: 'high', vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N', severity: 'critical' },
    { name: 'zero', vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N', severity: 'info' }
  ];
  const records = [];
  for (const [index, control] of controls.entries()) {
    const coordinate = { name: 'example.invalid/nonfunctional-cvss-fixture', version: 'v1.0.0', ecosystem: 'Go' as const };
    const id = `GO-2099-${9000000 + index}`;
    const advisory = {
      schema_version: '1.6.0', id, modified: '2026-09-20T00:00:00Z', published: '2026-09-20T00:00:00Z',
      severity: [{ type: 'CVSS_V4', score: control.vector }],
      affected: [{ package: { name: coordinate.name, ecosystem: coordinate.ecosystem },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.0.0' }] }] }]
    };
    const snapshot: OsvSnapshot = {
      coordinates: [coordinate], matches: [{ coordinate, ids: [id] }], advisories: [advisory], requests: [],
      digest: osvDigest(JSON.stringify(advisory))
    };
    const graph: OsvGraph = {
      id: 'go-backend', pathParts: ['nonfunctional-cvss-fixture.cdx.json'], inputDigest: snapshot.digest,
      components: [{ ...coordinate, chains: [['nonfunctional-cvss-fixture', coordinate.name]] }]
    };
    const parts = ['cvss-controls', control.name, 'input.cdx.json'], sbom = osvSbom(graph);
    await workspace.write(parts, sbom);
    const identity: EvidenceIdentity = {
      repository: 'fixture/isolated', event: 'workflow_dispatch', sourceSha: '0'.repeat(40), baseSha: '0'.repeat(40),
      workflowSha: '0'.repeat(40), runId: String(index + 1), attempt: 1,
      policyDigest: snapshot.digest, inventoryDigest: snapshot.digest, configurationDigest: snapshot.digest
    };
    const result = await scanOfflineOsvSnapshot({
      workspace, executable, python, config, graph, identity, input: path.join(workspace.root, ...parts),
      name: `cvss-control-${control.name}`
    }, snapshot);
    const metadata = projectPublishedAdvisories(graph, [{
      componentIndex: 0, package: coordinate.name, version: coordinate.version, advisories: [id], classification: 'missing'
    }], snapshot)[0]!;
    const classification = nativeOwnCvssClassification(metadata, result.report);
    if (classification.severity !== control.severity || classification.kind !== 'vulnerability') {
      throw new SecurityEvidenceError('osv-native-cvss-control-failed');
    }
    await workspace.verify(parts, sbom);
    records.push({ case: control.name, expectedSeverity: control.severity, actualSeverity: classification.severity,
      upstreamVector: control.vector, advisoryCount: 1, componentCount: 1, networkQueries: 0,
      snapshotDigest: snapshot.digest, reportDigest: osvDigest(JSON.stringify(result.report)) });
  }
  return records;
}

export type RepositoryOsvAssessment =
  | { graph: string; components: number; inputDigest: string; status: 'complete';
      report: SecurityReport; transport: object; passed: boolean; blocking: number; tracked: number }
  | { graph: string; components: number; inputDigest: string; status: 'error'; code: string; passed: false;
      unclassified?: readonly OsvSeverityIssue[]; advisoryMetadata?: readonly PublishedAdvisoryMetadata[] };

class OsvPublishedClassificationError extends OsvUnclassifiedSeverityError {
  readonly advisoryMetadata: readonly PublishedAdvisoryMetadata[];
  constructor(issues: readonly OsvSeverityIssue[], metadata: readonly PublishedAdvisoryMetadata[]) {
    super(issues);
    this.advisoryMetadata = metadata;
  }
}

async function assessRepositoryGraph(options: Parameters<typeof scanWithOsvTransport>[0]): Promise<RepositoryOsvAssessment> {
  const scoped = { graph: options.graph.id, components: options.graph.components.length, inputDigest: options.graph.inputDigest };
  try {
    const { report, transport } = await scanWithOsvTransport({ ...options, owner: 'voyager163' });
    // Local qualification is strict, not permission to adopt candidate exceptions.
    const verdict = evaluateSecurityReport(report, report, { exceptions: [], blockingRules: osvUnscoredPolicyRules }, new Date());
    return { ...scoped, status: 'complete', report, transport, passed: verdict.passed,
      blocking: verdict.blocking.length, tracked: verdict.tracked.length };
  } catch (error) {
    if (!(error instanceof SecurityEvidenceError)) throw error;
    const permitted = [
      'osv-unknown-severity', 'osv-api-unavailable', 'osv-api-timeout', 'osv-api-response-rejected',
      'osv-api-response-size', 'osv-api-response-json', 'osv-api-pagination-unqualified',
      'osv-api-advisory-limit', 'osv-api-advisory-mismatch', 'osv-api-advisory-coverage'
    ];
    if (!permitted.includes(error.code)) throw error;
    return { ...scoped, status: 'error', code: error.code, passed: false,
      ...(error instanceof OsvUnclassifiedSeverityError ? { unclassified: error.issues } : {}),
      ...(error instanceof OsvPublishedClassificationError ? { advisoryMetadata: error.advisoryMetadata } : {}) };
  }
}

// Go owns only the explicitly created private cache roots. Register each
// generated entry, then delete by exact path/inode, never recursive rm/globs.
async function cleanRegisteredGoCache(root: string): Promise<void> {
  const files: { target: string; ino: number; dev: number }[] = [], dirs: typeof files = [];
  async function register(directory: string, depth: number) {
    if (depth > 40 || files.length + dirs.length > 30_000) throw new SecurityEvidenceError('osv-go-cache-bound');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (depth === 0 && entry.name === '.registered') continue;
      portableParts([entry.name]);
      const target = path.join(directory, entry.name), stat = await lstat(target);
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw new SecurityEvidenceError('osv-go-cache-unsafe');
      const registered = { target, ino: stat.ino, dev: stat.dev };
      if (stat.isDirectory()) { dirs.push(registered); await register(target, depth + 1); }
      else if (stat.isFile()) files.push(registered);
      else throw new SecurityEvidenceError('osv-go-cache-unsafe');
    }
  }
  const status = await lstat(root);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new SecurityEvidenceError('osv-go-cache-unsafe');
  await register(root, 0);
  for (const directory of dirs) {
    const current = await lstat(directory.target);
    if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== directory.ino || current.dev !== directory.dev) {
      throw new SecurityEvidenceError('osv-go-cache-changed');
    }
    await chmod(directory.target, 0o700);
  }
  for (const file of files) {
    const current = await lstat(file.target);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
        current.ino !== file.ino || current.dev !== file.dev) throw new SecurityEvidenceError('osv-go-cache-changed');
    await unlink(file.target);
  }
  for (const directory of dirs.reverse()) await rmdir(directory.target);
}

export async function qualifyFrozenGo(repoRoot: string, options: {
  go: string; restore: boolean; workspaceParent?: string; captureToolGraph?: boolean; verifyToolGraph?: boolean; python?: string;
  assessment?: { python: string; identity: EvidenceIdentity };
}) {
  if (!path.isAbsolute(options.go)) throw new SecurityEvidenceError('osv-go-path-required');
  const baselinePath = path.join(repoRoot, 'assets', 'supported-stack.json'), baselineSource = await readFile(baselinePath, 'utf8');
  const baseline = JSON.parse(baselineSource);
  const release = baseline.goModules['go-backend'];
  const modPath = path.join(repoRoot, ...release.moduleTemplatePathParts);
  const sumPath = path.join(path.dirname(modPath), 'go.sum');
  const goMod = await readFile(modPath, 'utf8'), goSum = await readFile(sumPath, 'utf8');
  const workspace = await createOsvWorkspace(repoRoot, options.workspaceParent);
  const cacheIds = ['home', 'modcache', 'verificationcache', 'buildcache', 'scratch', 'gopath'] as const;
  const frozen = new Map<string, string>();
  async function copyFrozen(parts: string[], source: string) {
    await workspace.write(parts, source);
    frozen.set(parts.join('/'), source);
    await chmod(path.join(workspace.root, ...parts), 0o400);
  }
  async function verify() {
    for (const [name, source] of frozen) await workspace.verify(name.split('/'), source);
    if (await readFile(modPath, 'utf8') !== goMod || await readFile(sumPath, 'utf8') !== goSum ||
        await readFile(baselinePath, 'utf8') !== baselineSource) throw new SecurityEvidenceError('osv-lock-mutated');
  }
  try {
    await copyFrozen(['app', 'go.mod'], goMod);
    await copyFrozen(['app', 'go.sum'], goSum);
    for (const id of cacheIds) await workspace.write(['go-state', id, '.registered'], '');
    const state = (name: typeof cacheIds[number]) => path.join(workspace.root, 'go-state', name);
    const env = {
      ...frozenGoEnvironment(state('home')), GOMODCACHE: state('modcache'), GOCACHE: state('buildcache'),
      GOPATH: state('gopath'), TMPDIR: state('scratch'), TMP: state('scratch'), TEMP: state('scratch')
    };
    const online = { ...env, GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org' };
    const cwd = path.join(workspace.root, 'app');
    const version = await runOsvBoundary({
      executable: options.go, args: ['version'], cwd, env, stderrMode: 'go-metadata',
      project: source => {
        const match = /^go version go(1\.[0-9]+\.[0-9]+) [a-z0-9]+\/[a-z0-9]+\s*$/.exec(source);
        if (!match || match[1]!.split('.').slice(0, 2).join('.') !== release.goVersion.split('.').slice(0, 2).join('.')) {
          throw new SecurityEvidenceError('osv-go-toolchain-incompatible');
        }
        return match[1]!;
      }
    });
    async function list(environment: NodeJS.ProcessEnv, directory = cwd) {
      try {
        return await runOsvBoundary({
          executable: options.go, args: ['list', '-m', '-mod=readonly', '-json', 'all'], cwd: directory, env: environment,
          stderrMode: 'go-metadata', project: parseGoJsonStream
        });
      } finally { await verify(); }
    }
    let offline: string, selected: Record<string, unknown>[] | undefined;
    try { selected = await list(env); offline = 'available'; } catch (error) {
      if (!(error instanceof SecurityEvidenceError) || error.code !== 'osv-go-metadata-missing') throw error;
      offline = error.code;
    }
    if (!selected && options.restore) {
      selected = await list(online);
    }
    if (!selected) throw new SecurityEvidenceError('osv-go-metadata-missing');
    const moduleGraph = await runOsvBoundary({
      executable: options.go, args: ['mod', 'graph'], cwd, env, stderrMode: 'go-metadata', project: source => source
    });
    await verify();
    const app = reconcileGoResolution({
      graph: { id: 'go-backend', ecosystem: 'go', pathParts: release.moduleTemplatePathParts, extras: [] },
      goMod, goSum, resolved: selected, moduleGraph, expected: { ...release, tools: {} }
    });
    await workspace.write(['goose-fetch', '.registered'], '');
    const fetchCwd = path.join(workspace.root, 'goose-fetch');
    const tools = Object.entries(release.tools);
    if (tools.length !== 1 || tools[0]![0] !== 'github.com/pressly/goose/v3') throw new SecurityEvidenceError('osv-go-tool-inventory');
    const [toolName, toolVersion] = tools[0] as [string, string];
    async function downloadGoose(environment: NodeJS.ProcessEnv) {
      return runOsvBoundary({
        executable: options.go, args: ['mod', 'download', '-json', `${toolName}@${toolVersion}`],
        cwd: fetchCwd, env: environment, stderrMode: 'go-metadata',
        project: source => {
          const values = parseGoJsonStream(source);
          if (values.length !== 1 || values[0]!.Path !== toolName || values[0]!.Version !== toolVersion || values[0]!.Error) {
            throw new SecurityEvidenceError('osv-go-tool-download');
          }
          return values[0]!;
        }
      });
    }
    let gooseDownload: Record<string, unknown>, gooseOffline: string;
    try { gooseDownload = await downloadGoose(env); gooseOffline = 'available'; } catch (error) {
      if (!(error instanceof SecurityEvidenceError) || error.code !== 'osv-go-metadata-missing' || !options.restore) throw error;
      gooseOffline = error.code;
      gooseDownload = await downloadGoose(online);
    }
    const cached = async (value: unknown, cache: typeof cacheIds[number] = 'modcache') => {
      if (typeof value !== 'string') throw new SecurityEvidenceError('osv-go-cache-path');
      const canonical = await realpath(value), relative = path.relative(state(cache), canonical);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new SecurityEvidenceError('osv-go-cache-path');
      return canonical;
    };
    const toolMod = await readFile(await cached(gooseDownload.GoMod), 'utf8');
    const toolRoot = await cached(gooseDownload.Dir);
    const toolSum = await readFile(path.join(toolRoot, 'go.sum'), 'utf8');
    if (await readFile(path.join(toolRoot, 'go.mod'), 'utf8') !== toolMod) throw new SecurityEvidenceError('osv-go-tool-metadata-mismatch');
    await copyFrozen(['goose', 'go.mod'], toolMod);
    await copyFrozen(['goose', 'go.sum'], toolSum);
    const toolCwd = path.join(workspace.root, 'goose');
    let toolSelected: Record<string, unknown>[];
    try { toolSelected = await list(env, toolCwd); } catch (error) {
      if (!(error instanceof SecurityEvidenceError) || error.code !== 'osv-go-metadata-missing' || !options.restore) throw error;
      toolSelected = await list(online, toolCwd);
    }
    const toolGraph = await runOsvBoundary({
      executable: options.go, args: ['mod', 'graph'], cwd: toolCwd, env, stderrMode: 'go-metadata', project: source => source
    });
    const toolManifest = await runOsvBoundary({
      executable: options.go, args: ['mod', 'edit', '-json'], cwd: toolCwd, env, stderrMode: 'go-metadata',
      project: source => parseGoJsonStream(source)[0]!
    });
    await workspace.verify(['goose', 'go.mod'], toolMod);
    await workspace.verify(['goose', 'go.sum'], toolSum);
    const direct = (toolManifest.Require as { Path: string; Version: string; Indirect: boolean }[])
      .filter(item => !item.Indirect);
    const gaps = goChecksumGaps(toolSelected, toolSum);
    if (gaps.some(item => item.archive === 'mismatch' || item.module === 'mismatch')) {
      throw new SecurityEvidenceError('osv-go-checksum-mismatch');
    }
    const supplemental: GoVerifiedChecksum[] = [];
    const retainedRecords: GoToolGraphContract['sumdbRecords'] = [];
    const escape = (value: string) => value.replace(/[A-Z]/g, letter => `!${letter.toLowerCase()}`);
    if (gaps.length) {
      const metadataArgs = ['list', '-m', '-mod=readonly', '-json', ...gaps.map(item => `${item.name}@${item.version}`)];
      const metadata = (environment: NodeJS.ProcessEnv) => runOsvBoundary({
        executable: options.go, args: metadataArgs, cwd: fetchCwd,
        env: { ...environment, GOMODCACHE: state('verificationcache') },
        stderrMode: 'go-metadata', project: parseGoJsonStream
      });
      try { await metadata(env); } catch (error) {
        if (!(error instanceof SecurityEvidenceError) || error.code !== 'osv-go-metadata-missing' || !options.restore) throw error;
        await metadata(online);
      }
      for (const gap of gaps) {
        const recordPath = path.join(state('verificationcache'), 'cache', 'download', 'sumdb', 'sum.golang.org', 'lookup',
          ...`${escape(gap.name)}@${escape(gap.version)}`.split('/'));
        const record = await readFile(await cached(recordPath, 'verificationcache'), 'utf8');
        const parsed = parseGoSumdbRecord(record, gap.name, gap.version);
        supplemental.push(parsed);
        retainedRecords.push({ name: gap.name, version: gap.version, recordDigest: parsed.recordDigest, record });
      }
    }
    const tool = reconcileGoResolution({
      graph: { id: 'go-backend', ecosystem: 'go', pathParts: ['assets', 'supported-stack.json'], extras: [] },
      goMod: toolMod, goSum: toolSum, resolved: toolSelected, moduleGraph: toolGraph,
      expected: { dependencies: Object.fromEntries(direct.map(item => [item.Path, item.Version])),
        tools: { [toolName]: toolVersion }, goVersion: String(toolManifest.Go) },
      tool: { name: toolName, version: toolVersion, sum: String(gooseDownload.Sum), goModSum: String(gooseDownload.GoModSum) },
      additionalChecksums: supplemental
    });
    await verify();
    await workspace.verify(['goose', 'go.mod'], toolMod);
    await workspace.verify(['goose', 'go.sum'], toolSum);
    const combined = combineGoGraphs(app, [tool], release.tools);
    const extractionGraphs: Record<string, OsvGraph> = { app, goose: tool, combined };
    const rootArchiveDigest = osvDigest(await readFile(await cached(gooseDownload.Zip)));
    const sumdbTree = await readFile(path.join(state('gopath'), 'pkg', 'sumdb', 'sum.golang.org', 'latest'), 'utf8');
    const goExecutableDigest = osvDigest(await readFile(await realpath(options.go)));
    let contractReceipt: object | undefined;
    if (options.captureToolGraph || options.verifyToolGraph || options.assessment) {
      const rootRecordPath = path.join(state('modcache'), 'cache', 'download', 'sumdb', 'sum.golang.org', 'lookup',
        ...`${escape(toolName)}@${escape(toolVersion)}`.split('/'));
      const rootRecord = await readFile(await cached(rootRecordPath), 'utf8');
      const rootProof = parseGoSumdbRecord(rootRecord, toolName, toolVersion);
      retainedRecords.push({ name: toolName, version: toolVersion, recordDigest: rootProof.recordDigest, record: rootRecord });
      const exactSums = [
        { name: toolName, version: toolVersion, sum: String(gooseDownload.Sum), goModSum: String(gooseDownload.GoModSum) },
        ...toolSelected.filter(item => item.Main !== true).map(item => {
          const proof = supplemental.find(proof => proof.name === item.Path && proof.version === item.Version);
          return { name: String(item.Path), version: String(item.Version), sum: String(item.Sum ?? proof?.sum),
            goModSum: String(item.GoModSum ?? proof?.goModSum) };
        })
      ];
      const fresh = createGoToolGraphContract({
        expectedVersion: toolVersion, selected: tool, upstreamGoSum: toolSum, exactSums, records: retainedRecords,
        root: { name: toolName, version: toolVersion, sum: rootProof.sum, goModSum: rootProof.goModSum, archiveDigest: rootArchiveDigest,
          goModDigest: osvDigest(toolMod), upstreamGoSumDigest: osvDigest(toolSum) },
        derivation: { method: 'frozen-go-list-m-all', goVersion: version, goExecutableDigest, rootGoVersion: String(toolManifest.Go),
          moduleGraphDigest: osvDigest(toolGraph.trim().split(/\r?\n/).sort().join('\n')),
          selectedGraphDigest: tool.inputDigest, observedAt: new Date().toISOString(),
          proxy: 'https://proxy.golang.org', sumdb: 'sum.golang.org', toolchain: 'local', metadata: 'readonly' }
      });
      const contractPath = path.join(repoRoot, 'security', 'go-tool-graphs.json');
      const serialized = `${JSON.stringify(fresh, null, 2)}\n`;
      if (options.captureToolGraph) {
        try {
          const destination = await open(contractPath, 'wx', 0o644);
          try { await destination.writeFile(serialized); } finally { await destination.close(); }
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
        }
      }
      const status = await lstat(contractPath);
      if (!status.isFile() || status.isSymbolicLink()) throw new SecurityEvidenceError('osv-contract-file-unsafe');
      const bytes = await readFile(contractPath, 'utf8'), retained = parseGoToolGraphContract(bytes, toolVersion);
      requireGoToolContractObservation(retained, tool, exactSums, toolSum);
      if (JSON.stringify(retained.root) !== JSON.stringify(fresh.root)) throw new SecurityEvidenceError('osv-tool-contract-drift');
      extractionGraphs.contract = goToolContractGraph(retained);
      contractReceipt = { pathParts: ['security', 'go-tool-graphs.json'], digest: osvDigest(bytes),
        modules: retained.modules.length, sumdbRecords: retained.sumdbRecords.length,
        policyRegistration: 'requested-not-assumed', advisoryAssessment: 'not-run' };
    }
    const extraction = await extractOsvGoGraphs(workspace, extractionGraphs, 'osv-go', options.assessment, options.python);
    return {
      status: 'blocked', graph: 'go-backend', goVersion: version,
      goExecutableDigest,
      offline, app: { selectedModuleCount: app.components.length, inputDigest: app.inputDigest },
      goose: { offline: gooseOffline, selectedModuleCount: tool.components.length, inputDigest: tool.inputDigest,
        name: toolName, version: toolVersion, rootSum: gooseDownload.Sum, rootGoModSum: gooseDownload.GoModSum,
        rootArchiveDigest, goModDigest: osvDigest(toolMod), goSumDigest: osvDigest(toolSum),
        upstreamChecksumGaps: gaps.length, supplementalVerifiedRecords: supplemental.length,
        sumdbRecordsDigest: osvDigest(JSON.stringify(supplemental)), sumdbTreeDigest: osvDigest(sumdbTree),
        checksumAuthority: 'Go-verified-sum.golang.org-and-authenticated-upstream-module',
        sourceChecksumContract: contractReceipt ? 'captured-proposed-local-contract' : 'not-evaluated-by-this-observation' },
      inputDigest: osvDigest(JSON.stringify([osvDigest(goMod), osvDigest(goSum)])),
      componentInventories: Object.entries(extractionGraphs).map(([scope, graph]) => ({
        scope, inputDigest: graph.inputDigest,
        components: graph.components.map(component => ({ ...component, chains: component.chains.map(chain => [...chain]) })),
        sbom: JSON.parse(osvSbom(graph))
      })),
      extraction, contract: contractReceipt, advisoryQueries: options.assessment !== undefined,
      findingVerdict: options.assessment ? 'see-scoped-assessment' : 'not-produced',
      gaps: [...(options.assessment ? [] : ['actual-repository-advisory-assessment-not-run']),
        contractReceipt ? 'tool-contract-control-registration-and-base-adoption-pending' : 'tool-contract-not-evaluated']
    };
  } finally {
    let verificationFailed = false;
    try { await verify(); } catch { verificationFailed = true; }
    for (const id of cacheIds) {
      const target = path.join(workspace.root, 'go-state', id);
      try { await cleanRegisteredGoCache(target); } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    for (const [name, source] of frozen) {
      await workspace.verify(name.split('/'), source);
      await chmod(path.join(workspace.root, ...name.split('/')), 0o600);
    }
    await workspace.cleanup();
    if (verificationFailed) throw new SecurityEvidenceError('osv-lock-mutated');
  }
}

export async function extractOsvGoGraphs(
  workspace: RegisteredWorkspace, graphs: Record<string, OsvGraph>, directory = 'osv-go',
  assessment?: { python: string; identity: EvidenceIdentity; scopes?: readonly string[] }, sandboxPython?: string
) {
  const assessmentScopes = assessment?.scopes ?? ['combined'];
  if (assessment && (assessmentScopes.length === 0 || assessmentScopes.length > 16 ||
      new Set(assessmentScopes).size !== assessmentScopes.length ||
      assessmentScopes.some(scope => !Object.hasOwn(graphs, scope)))) throw new SecurityEvidenceError('osv-assessment-scope');
  const asset = osvRelease.assets[`${process.platform}-${process.arch}` as keyof typeof osvRelease.assets];
  if (!asset) throw new SecurityEvidenceError('osv-platform-unqualified');
  const executable = path.join(workspace.root, asset[0]);
  const [binary, sums] = await Promise.all([download(asset[0], 256 * 1024 * 1024),
    download('osv-scanner_SHA256SUMS', 64 * 1024)]);
  verifyOsvDownload(binary, sums, process.platform, process.arch);
  const file = await open(executable, 'wx', 0o600);
  try {
    try { await file.writeFile(binary); } finally { await file.close(); }
    await chmod(executable, 0o700);
    const env = frozenGoEnvironment(workspace.root);
    const python = assessment?.python ?? sandboxPython;
    await runOsvBoundary({ ...sandboxOsvCommand(executable, ['--version'], process.platform, python), cwd: workspace.root, env, project: verifyOsvVersion });
    await workspace.write([directory, 'empty.toml'], '');
    const counts: { scope: string; selected: number; extracted: number; inputDigest: string; sbomDigest: string }[] = [];
    const assessments: RepositoryOsvAssessment[] = [];
    for (const [name, graph] of Object.entries(graphs)) {
      const parts = [directory, `${name}.cdx.json`], source = osvSbom(graph), input = path.join(workspace.root, ...parts);
      await workspace.write(parts, source);
      const count = await runOsvBoundary({
        ...sandboxOsvCommand(executable, osvArguments('extract', 'cdx', input, path.join(workspace.root, directory, 'empty.toml')), process.platform, python),
        cwd: workspace.root, env,
        project: source => { requireOsvExtraction(source, input, graph); return extractedOsvComponents(source, input).length; }
      });
      await workspace.verify(parts, source);
      counts.push({ scope: name, selected: graph.components.length, extracted: count, inputDigest: graph.inputDigest,
        sbomDigest: osvDigest(source) });
      if (assessment && assessmentScopes.includes(name)) {
        assessments.push(await assessRepositoryGraph({
          workspace, executable, python: assessment.python, input, config: path.join(workspace.root, directory, 'empty.toml'),
          graph, identity: assessment.identity, name: name === 'combined' ? 'repository-go' : `packed-${name}`
        }));
        await workspace.verify(parts, source);
      }
    }
    await workspace.verify([directory, 'empty.toml'], '');
    return { tool: 'osv-scanner', version: osvRelease.version, binaryDigest: `sha256:${asset[1]}`,
      mode: assessment ? 'full-graph-assessment-with-fixed-coordinate-transport' : 'offline-extraction-only',
      scopes: counts, assessments };
  } finally {
    const status = await lstat(executable);
    if (!status.isFile() || status.isSymbolicLink() || osvDigest(await readFile(executable)) !== `sha256:${asset[1]}`) {
      throw new SecurityEvidenceError('osv-tool-cleanup-identity');
    }
    await unlink(executable);
  }
}

export async function qualifyOsvFixtures(repoRoot: string, options: {
  python: string; extractRepositoryLocks: boolean; queryPublicFixtures: boolean; workspaceParent?: string;
  assessment?: { identity: EvidenceIdentity };
}) {
  if (!path.isAbsolute(options.python)) throw new SecurityEvidenceError('osv-python-path-required');
  if (options.assessment && (!options.extractRepositoryLocks || options.queryPublicFixtures)) {
    throw new SecurityEvidenceError('osv-assessment-scope');
  }
  const workspace = await createOsvWorkspace(repoRoot, options.workspaceParent);
  const asset = osvRelease.assets[`${process.platform}-${process.arch}` as keyof typeof osvRelease.assets];
  if (!asset) { await workspace.cleanup(); throw new SecurityEvidenceError('osv-platform-unqualified'); }
  const executable = path.join(workspace.root, asset[0]);
  let binaryRegistered = false;
  const env: NodeJS.ProcessEnv = {
    HOME: workspace.root, USERPROFILE: workspace.root, XDG_CONFIG_HOME: workspace.root,
    XDG_CACHE_HOME: workspace.root, TMPDIR: workspace.root, TMP: workspace.root, TEMP: workspace.root,
    PATH: '', NO_COLOR: '1', GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off'
  };
  const receipt: { tool: object; extraction: object[]; publicFixtures: object[]; assessments: RepositoryOsvAssessment[];
    nativeOwnScoreControls: object[] } = {
    tool: { name: 'osv-scanner', version: osvRelease.version, platform: `${process.platform}-${process.arch}`,
      binaryDigest: `sha256:${asset[1]}`, checksumFileDigest: `sha256:${osvRelease.checksums}` },
    extraction: [], publicFixtures: [], assessments: [], nativeOwnScoreControls: []
  };
  try {
    const [binary, sums] = await Promise.all([download(asset[0], 256 * 1024 * 1024),
      download('osv-scanner_SHA256SUMS', 64 * 1024)]);
    verifyOsvDownload(binary, sums, process.platform, process.arch);
    const file = await open(executable, 'wx', 0o600);
    binaryRegistered = true;
    try { await file.writeFile(binary); } finally { await file.close(); }
    await chmod(executable, 0o700);
    await runOsvBoundary({ ...sandboxOsvCommand(executable, ['--version'], process.platform, options.python), cwd: workspace.root, env, project: verifyOsvVersion });
    await workspace.write(['empty.toml'], '');
    const config = path.join(workspace.root, 'empty.toml');
    if (options.queryPublicFixtures) {
      receipt.nativeOwnScoreControls = await qualifyOwnCvssControls(workspace, executable, options.python, config);
    }
    const extract = async (format: OsvInputFormat, parts: string[], content: string, graph?: OsvGraph) => {
      await workspace.write(parts, content);
      const input = path.join(workspace.root, ...parts);
      const result = await runOsvBoundary({
        ...sandboxOsvCommand(executable, osvArguments('extract', format, input, config), process.platform, options.python), cwd: workspace.root, env,
        project: source => {
          if (graph) requireOsvExtraction(source, input, graph);
          return extractedOsvComponents(source, input);
        }
      });
      await workspace.verify(parts, content);
      return result;
    };
    if (options.extractRepositoryLocks) {
      const baseline = JSON.parse(await readFile(path.join(repoRoot, 'assets', 'supported-stack.json'), 'utf8'));
      const npm = [
        { id: 'liftoff-cli', pathParts: baseline.npmProjects.liftoff.lockPathParts },
        { id: 'telemetry-ingest', pathParts: baseline.npmProjects['telemetry-ingest'].lockPathParts },
        { id: 'node-backend', pathParts: baseline.npmProjects['node-backend'].lockPathParts },
        { id: 'standard-frontend', pathParts: baseline.npmProjects.frontend.lockPathParts }
      ];
      const inventory = dependencyInventory(baseline, npm);
      for (const graph of inventory.filter(graph => graph.ecosystem === 'pypi')) {
        const input = path.join(repoRoot, ...graph.pathParts), source = await readFile(input, 'utf8');
        const parsed = await readUvLock(source, options.python, workspace.root, env);
        let expected = reconcileUvLock(source, parsed, graph, baseline.pythonProjects[graph.id]);
        let workerExportCount: number | undefined;
        let workerScopes: ReturnType<typeof workerRequirementsCoverage>['evidence'] | undefined;
        if (graph.id === 'function-worker') {
          const workerPath = path.join(repoRoot, 'assets', 'locks', 'python-genai', 'function-requirements.txt');
          const worker = await readFile(workerPath, 'utf8');
          const reconciled = workerRequirementsCoverage(worker, parsed, expected);
          expected = reconciled.graph;
          workerScopes = reconciled.evidence;
          workerExportCount = reconciled.evidence.exportedComponents.length;
          if (await readFile(workerPath, 'utf8') !== worker) throw new SecurityEvidenceError('osv-lock-mutated');
        }
        const direct = await extract('uv', [graph.id, 'uv.lock'], source);
        const sbom = await extract('cdx', [graph.id, 'full-graph.cdx.json'], osvSbom(expected), expected);
        if (await readFile(input, 'utf8') !== source) throw new SecurityEvidenceError('osv-lock-mutated');
        receipt.extraction.push({
          graph: graph.id, inputDigest: expected.inputDigest, expected: expected.components.length,
          directExtractorCount: direct.length, exactSbomCount: sbom.length,
          directMatches: direct.length === expected.components.length && direct.every(item =>
            expected.components.some(p => p.name === item.name && p.version === item.version && p.ecosystem === item.ecosystem)),
          directMissingCount: expected.components.filter(item => !direct.some(p =>
            p.name === item.name && p.version === item.version && p.ecosystem === item.ecosystem)).length,
          directAdditionalCount: direct.filter(item => !expected.components.some(p =>
            p.name === item.name && p.version === item.version && p.ecosystem === item.ecosystem)).length,
          workerExportCount, workerScopes, extras: graph.extras, advisoryQueries: false
        });
        if (options.assessment) {
          receipt.assessments.push(await assessRepositoryGraph({
            workspace, executable, python: options.python,
            input: path.join(workspace.root, graph.id, 'full-graph.cdx.json'), config,
            graph: expected, identity: options.assessment.identity, name: `repository-${graph.id}`
          }));
          await workspace.verify([graph.id, 'full-graph.cdx.json'], osvSbom(expected));
          if (await readFile(input, 'utf8') !== source) throw new SecurityEvidenceError('osv-lock-mutated');
        }
      }
      const go = inventory.find(graph => graph.ecosystem === 'go')!;
      const source = await readFile(path.join(repoRoot, ...go.pathParts), 'utf8');
      const sumPath = path.join(repoRoot, ...go.pathParts.slice(0, -1), 'go.sum'), sum = await readFile(sumPath, 'utf8');
      const direct = await extract('go-mod', [go.id, 'go.mod'], source);
      if (await readFile(path.join(repoRoot, ...go.pathParts), 'utf8') !== source ||
          await readFile(sumPath, 'utf8') !== sum) throw new SecurityEvidenceError('osv-lock-mutated');
      receipt.extraction.push({ graph: go.id, directExtractorCount: direct.length, inputDigest: osvDigest(source),
        checksumDigest: osvDigest(sum), checksumSupersetVersions: sum.trim().split(/\r?\n/).filter(line =>
          !line.split(' ')[1]?.endsWith('/go.mod')).length,
        supportedToolsCovered: Object.entries(baseline.goModules[go.id].tools).every(([name, version]) =>
          direct.some(item => item.name === name && item.version === version) && sum.includes(`${name} ${String(version)} h1:`)),
        complete: false, gap: 'frozen-resolved-module-and-tool-inventory-required', advisoryQueries: false });
    }
    for (const which of ['clean', 'transitive'] as const) {
      const source = fixtureLock(which), parsed = await readUvLock(source, options.python, workspace.root, env);
      const root = publicOsvFixtures[which][0]!;
      const graph = reconcileUvLock(source, parsed, {
        id: 'standard-backend', ecosystem: 'pypi', pathParts: ['fixture', which, 'uv.lock'], extras: []
      }, { dependencies: { [root.name]: root.version }, optionalDependencies: {} });
      await extract('uv', ['fixture', which, 'uv.lock'], source, graph);
      const input = path.join(workspace.root, 'fixture', which, 'uv.lock');
      if (options.queryPublicFixtures) {
        const generatedAt = new Date().toISOString(), digest = osvDigest('nonfunctional-public-fixture-only');
        // Synthetic run identities are never represented as hosted qualification.
        const identity: EvidenceIdentity = {
          repository: 'voyager163/liftoff', event: 'workflow_dispatch', sourceSha: '0'.repeat(40),
          baseSha: '0'.repeat(40), workflowSha: '0'.repeat(40), runId: '1', attempt: 1,
          inventoryDigest: digest, policyDigest: digest, configurationDigest: digest
        };
          const sbomParts = ['fixture', which, 'input.cdx.json'], sbom = osvSbom(graph);
          await extract('cdx', sbomParts, sbom, graph);
          const { report, transport } = await scanWithOsvTransport({
            workspace, executable, python: options.python, input: path.join(workspace.root, ...sbomParts),
            config, graph, identity, name: which
          });
        const verdict = evaluateSecurityReport(report, report, { exceptions: [], blockingRules: osvUnscoredPolicyRules }, new Date());
        if (which === 'clean' && report.findings.length !== 0 ||
            which === 'transitive' && !report.findings.some(f =>
              f.component === 'urllib3' && f.chains.some(chain => chain.includes('requests')) &&
              ['high', 'critical'].includes(f.severity))) throw new SecurityEvidenceError('osv-fixture-inconclusive');
        receipt.publicFixtures.push({
          fixture: which, hostedEvidence: false, complete: true, packages: graph.components.length,
          responseDigest: report.tool.database, generatedAt, completedAt: report.completedAt,
          findings: report.findings.map(f => ({ advisory: f.rule, package: f.component, severity: f.severity, chains: f.chains })),
          verdict, transport
        });
        await workspace.verify(['fixture', which, 'uv.lock'], source);
        await workspace.verify(sbomParts, sbom);
      }
    }
    const goFixture = publicGoFixture;
    await extract('cdx', ['fixture', 'go', 'full-graph.cdx.json'], osvSbom(goFixture), goFixture);
    receipt.extraction.push({ graph: 'go-backend', fixture: true, exactSbomCount: 4, advisoryQueries: false });
    if (options.queryPublicFixtures) {
      const generatedAt = new Date().toISOString(), digest = osvDigest('nonfunctional-public-fixture-only');
      const input = path.join(workspace.root, 'fixture', 'go', 'full-graph.cdx.json');
      let report: SecurityReport | undefined;
      let transport: object | undefined;
      try {
        ({ report, transport } = await scanWithOsvTransport({
          workspace, executable, python: options.python, input, config, graph: goFixture, name: 'go',
          identity: {
              repository: 'voyager163/liftoff', event: 'workflow_dispatch', sourceSha: '0'.repeat(40),
              baseSha: '0'.repeat(40), workflowSha: '0'.repeat(40), runId: '1', attempt: 1,
              inventoryDigest: digest, policyDigest: digest, configurationDigest: digest
          }
        }));
      } catch (error) {
        if (!(error instanceof SecurityEvidenceError) || error.code !== 'osv-unknown-severity') throw error;
        receipt.publicFixtures.push({ fixture: 'go-transitive-query-slice', hostedEvidence: false,
          packages: goFixture.components.length, blocked: true, diagnostic: error.code, findingVerdict: 'not-produced' });
      }
      if (report) {
        const findings = report.findings.filter(f => f.component === 'golang.org/x/text' &&
        f.chains.some(chain => chain.includes('golang.org/x/net')) && ['high', 'critical'].includes(f.severity));
        if (!findings.length) throw new SecurityEvidenceError('osv-fixture-inconclusive');
        const verdict = evaluateSecurityReport(report, report, { exceptions: [], blockingRules: osvUnscoredPolicyRules }, new Date());
        receipt.publicFixtures.push({ fixture: 'go-transitive-query-slice', hostedEvidence: false,
          packages: goFixture.components.length, responseDigest: report.tool.database, generatedAt,
          completedAt: report.completedAt, findings: findings.map(f => ({ advisory: f.rule, package: f.component,
          severity: f.severity, chains: f.chains })), findingCount: report.findings.length, verdict, transport });
      }
      await workspace.verify(['fixture', 'go', 'full-graph.cdx.json'], osvSbom(goFixture));
    }
    await workspace.verify(['empty.toml'], '');
    return receipt;
  } finally {
    if (binaryRegistered) {
      const status = await lstat(executable);
      if (!status.isFile() || status.isSymbolicLink() || osvDigest(await readFile(executable)) !== `sha256:${asset[1]}`) {
        throw new SecurityEvidenceError('osv-tool-cleanup-identity');
      }
      await unlink(executable);
    }
    await workspace.cleanup();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--extract-locks', '--public-fixtures', '--resolve-go', '--restore-go', '--capture-go-tool-graph'].includes(arg) &&
      !arg.startsWith('--python=') && !arg.startsWith('--go=') && !arg.startsWith('--workspace-parent=')) ||
      args.includes('--restore-go') && !args.includes('--resolve-go') ||
      args.includes('--capture-go-tool-graph') && !args.includes('--resolve-go') ||
      args.includes('--resolve-go') && args.some(arg => ['--extract-locks', '--public-fixtures'].includes(arg))) {
    throw new SecurityEvidenceError('osv-fixture-arguments');
  }
  try {
    const result = args.includes('--resolve-go') ? await qualifyFrozenGo(process.cwd(), {
      go: args.find(arg => arg.startsWith('--go='))?.slice('--go='.length) ?? '', restore: args.includes('--restore-go'),
      workspaceParent: args.find(arg => arg.startsWith('--workspace-parent='))?.slice('--workspace-parent='.length),
      captureToolGraph: args.includes('--capture-go-tool-graph')
    }) : await qualifyOsvFixtures(process.cwd(), {
      python: args.find(arg => arg.startsWith('--python='))?.slice('--python='.length) ?? '',
      extractRepositoryLocks: args.includes('--extract-locks'), queryPublicFixtures: args.includes('--public-fixtures'),
      workspaceParent: args.find(arg => arg.startsWith('--workspace-parent='))?.slice('--workspace-parent='.length)
    });
    console.log(JSON.stringify(result, null, 2));
    if ('status' in result && result.status === 'blocked') process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof SecurityEvidenceError ? error.message : 'Security evidence rejected: osv-fixture-failed.');
    process.exitCode = 1;
  }
}
