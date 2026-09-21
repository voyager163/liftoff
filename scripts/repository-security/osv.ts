import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { OwnAdvisoryClassification } from './osv-advisory.ts';
import {
  digest, identifier, parseSecurityReport, portableParts, record, SecurityEvidenceError,
  type EvidenceIdentity, type SecurityFinding, type SecurityReport, type Severity
} from './evidence.ts';
import type { Graph } from './inventory.ts';

// Release assets and SHA256SUMS are independently checked before execution.
export const osvRelease = {
  version: '2.6.0',
  repository: 'google/osv-scanner',
  checksums: '29f6fbc8bdd02d977df4b0987705d046233c36b70469a7021c623e8c155c9ddc',
  assets: {
    'darwin-arm64': ['osv-scanner_darwin_arm64', '98c460dcd37de25819babd757d04542045b6243113e209edcd4d89fedb0256b4'],
    'darwin-x64': ['osv-scanner_darwin_amd64', '60c5296637e977b28eeda5c7f13573e447659a632922737f94d11fa7e30ad6ca'],
    'linux-arm64': ['osv-scanner_linux_arm64', '2c71403eb443d05891c4f268c3ad771cf4f16e5443463fd7851ef8f454d3c7e4'],
    'linux-x64': ['osv-scanner_linux_amd64', 'ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108'],
    'win32-arm64': ['osv-scanner_windows_arm64.exe', 'ca1379da0e408279ef2c85cde0846a903495738a91c7b065a208048437c1686c'],
    'win32-x64': ['osv-scanner_windows_amd64.exe', 'e0ed7644118b717b028c249ee9d3515024e55e8510747ca08906eb96765354d6']
  }
} as const;

export const osvBounds = { stdout: 4 * 1024 * 1024, stderr: 64 * 1024, input: 16 * 1024 * 1024, timeoutMs: 120_000 };
export const osvDigest = (source: string | Uint8Array): string =>
  `sha256:${createHash('sha256').update(source).digest('hex')}`;

function reject(code: string): never { throw new SecurityEvidenceError(code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('osv-invalid-object');
  return value as Record<string, unknown>;
}
function array(value: unknown, min = 0, max = 10_000): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) reject('osv-invalid-array');
  return value;
}
function exactSet(actual: readonly string[], expected: readonly string[], code = 'osv-incomplete-extraction'): void {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length ||
      new Set(expected).size !== expected.length || actual.some(value => !expected.includes(value))) reject(code);
}
function json(source: string): unknown {
  if (!source || Buffer.byteLength(source) > osvBounds.stdout) reject('osv-report-size');
  try { return JSON.parse(source); } catch { return reject('osv-invalid-json'); }
}

export interface OsvComponent {
  name: string;
  version: string;
  ecosystem: 'PyPI' | 'Go';
  chains: string[][];
}
export interface OsvGraph {
  id: string;
  pathParts: string[];
  inputDigest: string;
  components: OsvComponent[];
}
const key = (item: Pick<OsvComponent, 'ecosystem' | 'name' | 'version'>) =>
  `${item.ecosystem}:${item.name}@${item.version}`;

function component(name: unknown, version: unknown, ecosystem: 'PyPI' | 'Go'): OsvComponent {
  const n = identifier(name, 'osv-invalid-component'), v = identifier(version, 'osv-invalid-version');
  if (ecosystem === 'PyPI' && (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(n) ||
      !/^[0-9][a-zA-Z0-9.!+-]*$/.test(v))) reject('osv-invalid-pypi-coordinate');
  if (ecosystem === 'Go' && (!/^[a-zA-Z0-9][a-zA-Z0-9._~/-]+$/.test(n) ||
      !/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.+-]+)?$/.test(v))) reject('osv-invalid-go-coordinate');
  return { name: n, version: v, ecosystem, chains: [] };
}

/**
 * Raw child streams are never logged, returned or attached to errors. Only the
 * caller's allowlisted projection may cross this boundary. No inherited env.
 */
export async function runOsvBoundary<T>(options: {
  executable: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv;
  stdin?: string; timeoutMs?: number; acceptedExits?: readonly number[];
  stderrMode?: 'go-metadata';
  project: (stdout: string, exitCode: number) => T;
}): Promise<T> {
  if (options.stdin && Buffer.byteLength(options.stdin) > osvBounds.input) reject('osv-input-size');
  const timeout = options.timeoutMs ?? osvBounds.timeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > osvBounds.timeoutMs) reject('osv-invalid-timeout');
  return new Promise((resolve, fail) => {
    let output: Buffer[] = [], errors: Buffer[] = [], outputSize = 0, errorSize = 0, failed: string | undefined;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.executable, [...options.args], {
        cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      fail(new SecurityEvidenceError('osv-launch-failed'));
      return;
    }
    function stop(code: string) {
      failed ??= code;
      output = [];
      errors = [];
      child.kill('SIGKILL');
    }
    const timer = setTimeout(() => stop('osv-timeout'), timeout);
    child.stdout.on('data', (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > osvBounds.stdout) stop('osv-stdout-limit');
      else if (!failed) output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errorSize += chunk.length;
      if (errorSize > osvBounds.stderr) stop('osv-stderr-limit');
      else if (!failed && options.stderrMode === 'go-metadata') errors.push(chunk);
    });
    child.on('error', () => { failed ??= 'osv-launch-failed'; });
    child.stdin.on('error', () => { /* close/exit handling below remains authoritative */ });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      try {
        if (failed) reject(failed);
        const goStderr = options.stderrMode === 'go-metadata'
          ? classifyGoStderr(Buffer.concat(errors).toString('utf8')) : undefined;
        const goStdout = options.stderrMode === 'go-metadata' && code !== 0
          ? classifyGoJsonError(Buffer.concat(output).toString('utf8')) : undefined;
        errors = [];
        if (goStderr === 'missing' || goStdout === 'missing') reject('osv-go-metadata-missing');
        if (goStderr === 'toolchain' || goStdout === 'toolchain') reject('osv-go-toolchain-incompatible');
        if (signal || code === null || !(options.acceptedExits ?? [0]).includes(code)) reject('osv-process-failed');
        // With --verbosity=error, stderr is evidence of a failed plugin even
        // when the CLI returns an apparently clean, fully enumerated report.
        if (errorSize !== 0 && goStderr !== 'download-status') reject('osv-stderr-rejected');
        const source = Buffer.concat(output).toString('utf8');
        output = [];
        errors = [];
        try { resolve(options.project(source, code)); } catch (error) {
          // Do not trust even a parser exception to omit raw input.
          if (error instanceof SecurityEvidenceError && [
            'osv-unknown-severity', 'osv-incomplete-extraction', 'osv-invalid-advisory',
            'osv-vulnerability-group-mismatch', 'osv-exit-report-mismatch', 'osv-api-advisory-coverage'
          ].includes(error.code)) reject(error.code);
          reject('osv-output-rejected');
        }
      } catch (error) {
        output = [];
        fail(error instanceof SecurityEvidenceError ? error : new SecurityEvidenceError('osv-process-failed'));
      }
    });
    child.stdin.end(options.stdin);
  });
}

export function classifyGoStderr(source: string): 'empty' | 'missing' | 'toolchain' | 'download-status' | 'error' {
  if (!source) return 'empty';
  if (/requires go >= [0-9.]+.*GOTOOLCHAIN=local/.test(source)) return 'toolchain';
  if (/module lookup disabled by GOPROXY=off|cannot find module providing package.*GOPROXY=off/.test(source)) return 'missing';
  if (source.trim().split(/\r?\n/).every(line =>
    /^go: downloading [A-Za-z0-9][A-Za-z0-9._~!/+@-]* v[0-9][A-Za-z0-9.+-]*$/.test(line))) return 'download-status';
  return 'error';
}

function classifyGoJsonError(source: string): ReturnType<typeof classifyGoStderr> | undefined {
  try {
    for (const item of parseGoJsonStream(source)) {
      const error = typeof item.Error === 'string' ? item.Error : item.Error && object(item.Error).Err;
      if (typeof error === 'string') {
        const result = classifyGoStderr(error);
        if (result === 'missing' || result === 'toolchain') return result;
      }
    }
  } catch { /* Error classification never substitutes for successful metadata parsing. */ }
  return undefined;
}

export function verifyOsvDownload(binary: Uint8Array, sums: Uint8Array, platform: string, arch: string): string {
  const asset = osvRelease.assets[`${platform}-${arch}` as keyof typeof osvRelease.assets];
  if (!asset || osvDigest(sums) !== `sha256:${osvRelease.checksums}` ||
      osvDigest(binary) !== `sha256:${asset[1]}`) reject('osv-tool-digest');
  const lines = Buffer.from(sums).toString('utf8').trim().split(/\r?\n/);
  if (lines.filter(line => line === `${asset[1]}  ${asset[0]}`).length !== 1) reject('osv-checksum-identity');
  return asset[0];
}

export function verifyOsvVersion(output: string): string {
  if (!/^osv-scanner version: 2\.6\.0\r?\n/.test(output) || output.length > 4096) reject('osv-tool-version');
  return osvRelease.version;
}

export type OsvInputFormat = 'uv' | 'go-mod' | 'cdx';
export function osvArguments(mode: 'extract' | 'scan', format: OsvInputFormat, input: string, config: string): string[] {
  const extractor = { uv: 'python/uvlock', 'go-mod': 'go/gomod', cdx: 'sbom/cdx' }[format];
  if (!extractor || !['extract', 'scan'].includes(mode)) reject('osv-invalid-mode');
  return ['scan', 'source', '--format=json', '--all-packages', '--all-vulns',
    '--no-call-analysis=go,rust', '--no-resolve', '--no-ignore', '--verbosity=error',
    '--experimental-no-default-plugins', `--experimental-plugins=${extractor}`,
    ...(mode === 'extract' ? ['--offline', '--experimental-disable-plugins=vulnmatch/osvdev,vulnmatch/osvlocal']
      : ['--experimental-plugins=vulnmatch/osvdev']),
    '--config', config, '--lockfile', input];
}

// TOML parsing is delegated to Python's standard library in isolated mode, not
// to an ad-hoc lockfile regex or code supplied by the lockfile.
export async function readUvLock(source: string, python: string, cwd: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  const program = `import json,sys,tomllib
d=tomllib.loads(sys.stdin.read())
print(json.dumps({"version":d.get("version"),"revision":d.get("revision"),"requires-python":d.get("requires-python"),"package":[{k:v for k,v in p.items() if k in ("name","version","source","dependencies","optional-dependencies","metadata")} for p in d.get("package",[])]}))
`;
  return runOsvBoundary({ executable: python, args: ['-I', '-S', '-c', program], cwd, env, stdin: source, project: json });
}

interface PythonProject { dependencies: Record<string, string>; optionalDependencies: Record<string, Record<string, string>> }
export function reconcileUvLock(
  source: string, parsed: unknown, graph: Graph, project: PythonProject
): OsvGraph {
  if (graph.ecosystem !== 'pypi' || !['standard-backend', 'genai-backend', 'function-worker'].includes(graph.id)) {
    reject('osv-wrong-graph');
  }
  const lock = object(parsed);
  if (lock.version !== 1 || lock.revision !== 3) reject('osv-unsupported-uv-format');
  const packages = array(lock.package, 2).map(object);
  const local = packages.filter(pkg => object(pkg.source).editable === '.' || object(pkg.source).virtual === '.');
  if (local.length !== 1) reject('osv-uv-root');
  const root = local[0]!, rootName = identifier(root.name, 'osv-uv-root');
  if (Object.keys(object(root.source)).length !== 1) reject('osv-uv-root');
  const remote = packages.filter(pkg => pkg !== root);
  const components = remote.map(pkg => {
    const source = record(pkg.source, ['registry'], 'osv-private-or-unresolved-source');
    if (source.registry !== 'https://pypi.org/simple') reject('osv-private-or-unresolved-source');
    return component(pkg.name, pkg.version, 'PyPI');
  });
  exactSet(components.map(item => item.name), components.map(item => item.name), 'osv-ambiguous-uv-versions');
  const byName = new Map(components.map(item => [item.name, item]));
  const optional = object(root['optional-dependencies'] ?? {});
  const metadata = object(root.metadata);
  exactSet(array(metadata['provides-extras']).map(String), Object.keys(optional), 'osv-extra-mismatch');
  exactSet(graph.extras, Object.keys(project.optionalDependencies), 'osv-extra-mismatch');
  if (graph.extras.some(extra => !(extra in optional))) reject('osv-extra-mismatch');
  const refs = (value: unknown) => array(value).map(value => {
    const ref = object(value), name = identifier(ref.name, 'osv-invalid-dependency');
    if (!byName.has(name) || ref.version !== undefined && ref.version !== byName.get(name)!.version) {
      reject('osv-unresolved-dependency');
    }
    return name;
  });
  const rootDirect = refs(root.dependencies ?? []);
  if (graph.id !== 'function-worker') {
    exactSet(rootDirect, Object.keys(project.dependencies), 'osv-baseline-drift');
    exactSet(Object.keys(optional), graph.extras, 'osv-extra-mismatch');
  }
  for (const [name, version] of Object.entries(project.dependencies)) {
    if (byName.get(name)?.version !== version ||
        ![...rootDirect, ...Object.values(optional).flatMap(refs)].includes(name)) reject('osv-baseline-drift');
  }
  for (const [extra, dependencies] of Object.entries(project.optionalDependencies)) {
    for (const [name, version] of Object.entries(dependencies)) {
      if (!refs(optional[extra]).includes(name) || byName.get(name)?.version !== version) reject('osv-extra-mismatch');
    }
  }
  // Cover the entire universal lock (all platform markers and extras), not just
  // the host's active subset. Enumerate bounded simple dependency paths.
  const edges = new Map<string, string[]>();
  for (const pkg of [root, ...remote]) {
    edges.set(String(pkg.name), [...new Set([
      ...refs(pkg.dependencies ?? []),
      ...Object.values(object(pkg['optional-dependencies'] ?? {})).flatMap(refs)
    ])].sort());
  }
  const visit = (name: string, chain: string[]) => {
    if (chain.includes(name)) return;
    const next = [...chain, name];
    if (next.length > 50) reject('osv-chain-limit');
    const target = byName.get(name);
    if (target) {
      if (target.chains.length >= 100) reject('osv-chain-limit');
      target.chains.push(next);
    }
    for (const child of edges.get(name) ?? []) visit(child, next);
  };
  visit(rootName, []);
  if (components.some(item => item.chains.length === 0)) reject('osv-unreachable-lock-component');
  return { id: graph.id, pathParts: portableParts(graph.pathParts), inputDigest: osvDigest(source),
    components: components.sort((a, b) => key(a) < key(b) ? -1 : 1) };
}

export function osvSbom(graph: OsvGraph): string {
  if (!graph.components.length) reject('osv-empty-graph');
  for (const item of graph.components) {
    if (!['PyPI', 'Go'].includes(item.ecosystem)) reject('osv-wrong-ecosystem');
    component(item.name, item.version, item.ecosystem);
  }
  exactSet(graph.components.map(key), graph.components.map(key), 'osv-duplicate-component');
  return JSON.stringify({
    bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    components: graph.components.map(item => ({
      type: 'library', name: item.name, version: item.version,
      purl: `pkg:${item.ecosystem === 'PyPI' ? 'pypi' : 'golang'}/${item.name}@${item.version}`
    }))
  });
}

export function workerRequirementsCoverage(source: string, parsedLock: unknown, graph: OsvGraph) {
  if (graph.id !== 'function-worker') reject('osv-wrong-graph');
  const packages = array(object(parsedLock).package, 2).map(object);
  const root = packages.find(pkg => object(pkg.source).editable === '.' || object(pkg.source).virtual === '.');
  if (!root) reject('osv-uv-root');
  const byName = new Map(packages.map(pkg => [String(pkg.name), pkg]));
  const selected = new Set<string>();
  const walk = (value: unknown, into = selected) => {
    for (const dep of array(value)) {
      const name = identifier(object(dep).name, 'osv-invalid-dependency');
      if (into.has(name)) continue;
      const pkg = byName.get(name);
      if (!pkg) reject('osv-unresolved-dependency');
      into.add(name);
      walk(pkg.dependencies ?? [], into);
      Object.values(object(pkg['optional-dependencies'] ?? {})).forEach(value => walk(value, into));
    }
  };
  walk(root.dependencies ?? []);
  walk(object(root['optional-dependencies']).functions);
  const entries = source.replace(/\\\r?\n[ \t]*/g, ' ').split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
  const observed = entries.map(line => {
    const match = /^([a-z0-9.-]+)==([^ ;]+)(?:\s*;\s*(.+?))?\s+((?:--hash=sha256:[0-9a-f]{64}\s*)+)$/.exec(line.trim());
    if (!match) reject('osv-unresolved-worker-requirement');
    // Markers are a union for auditing, never evaluated on the scanner host.
    if (match[3]) {
      const predicates = match[3].split(/\s+(?:and|or)\s+/);
      if (predicates.some(predicate =>
        !/^(?:sys_platform|implementation_name|platform_python_implementation)\s*(?:==|!=)\s*(?:'[a-zA-Z0-9_.-]+'|"[a-zA-Z0-9_.-]+")$/.test(predicate))) {
        reject('osv-unsupported-worker-marker');
      }
    }
    const pkg = component(match[1], match[2], 'PyPI');
    if (!graph.components.some(item => key(item) === key(pkg))) reject('osv-worker-lock-drift');
    return { name: pkg.name, version: pkg.version, ecosystem: pkg.ecosystem };
  });
  exactSet(observed.map(item => item.name), [...selected], 'osv-worker-coverage');
  const tests = new Set<string>();
  walk(object(root['optional-dependencies']).test ?? [], tests);
  const lockOnly = graph.components.filter(item => !selected.has(item.name)).map(item => ({
    name: item.name, version: item.version, ecosystem: item.ecosystem, testDependency: tests.has(item.name)
  }));
  const exported = observed.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    graph: { ...graph, inputDigest: osvDigest(`${graph.inputDigest}\n${osvDigest(source)}\n`) },
    evidence: {
      auditScope: 'universal-lock-all-extras-and-platform-markers' as const,
      exportScope: 'root-plus-functions-requirements-marker-union' as const,
      installedRuntimeAssessed: false,
      fullLockComponents: graph.components.length, exportedComponents: exported,
      exportedCoordinateDigest: osvDigest(JSON.stringify(exported)), lockOnlyComponents: lockOnly,
      exactPackageVersionInclusionVerified: true
    }
  };
}

export function reconcileWorkerRequirements(source: string, parsedLock: unknown, graph: OsvGraph): OsvGraph {
  return workerRequirementsCoverage(source, parsedLock, graph).graph;
}

export function frozenGoEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root,
    TMPDIR: root, TMP: root, TEMP: root, PATH: '',
    GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off', GOFLAGS: '-mod=readonly',
    GOPROXY: 'off', GOSUMDB: 'off', GOPRIVATE: '', GONOPROXY: '', GONOSUMDB: '',
    GOMODCACHE: root, GOPATH: root, GOCACHE: 'off', GOTELEMETRY: 'off', CGO_ENABLED: '0', GOAUTH: 'off'
  };
}

export function parseGoJsonStream(source: string): Record<string, unknown>[] {
  if (!source || Buffer.byteLength(source) > osvBounds.stdout) reject('osv-report-size');
  const values: Record<string, unknown>[] = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (start === -1) {
      if (/\s/.test(char)) continue;
      if (char !== '{') reject('osv-invalid-go-json');
      start = index;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      values.push(object(json(source.slice(start, index + 1))));
      if (values.length > 10_000) reject('osv-go-module-limit');
      start = -1;
    }
  }
  if (start !== -1 || !values.length) reject('osv-invalid-go-json');
  return values;
}

function compareGoVersions(left: string, right: string): number {
  const parts = (version: string) => {
    const canonical = version.replace(/\+.*/, '').slice(1), separator = canonical.indexOf('-');
    return [separator < 0 ? canonical : canonical.slice(0, separator),
      separator < 0 ? '' : canonical.slice(separator + 1)] as const;
  };
  const [a, ap] = parts(left), [b, bp] = parts(right);
  const numsA = a.split('.').map(BigInt), numsB = b.split('.').map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (numsA[index] !== numsB[index]) return numsA[index]! < numsB[index]! ? -1 : 1;
  }
  if (ap === bp) return 0;
  if (!ap || !bp) return ap ? -1 : 1;
  const fieldsA = ap.split('.'), fieldsB = bp.split('.');
  for (let index = 0; index < Math.max(fieldsA.length, fieldsB.length); index++) {
    const x = fieldsA[index], y = fieldsB[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function parseGoSums(source: string): Map<string, string> {
  if (!source.trim() || Buffer.byteLength(source) > osvBounds.input) reject('osv-invalid-go-checksums');
  const sums = new Map<string, string>();
  for (const line of source.trim().split(/\r?\n/)) {
    const match = /^([^ ]+) (v[^ ]+) (h1:[a-zA-Z0-9+/]{43}=)$/.exec(line);
    if (!match || sums.has(`${match[1]}@${match[2]}`)) reject('osv-invalid-go-checksums');
    component(match[1], match[2]!.replace(/\/go\.mod$/, ''), 'Go');
    sums.set(`${match[1]}@${match[2]}`, match[3]!);
  }
  return sums;
}

export function goChecksumGaps(resolved: unknown, goSum: string): {
  name: string; version: string; archive: 'missing' | 'mismatch' | 'matched'; module: 'missing' | 'mismatch' | 'matched';
}[] {
  const sums = parseGoSums(goSum);
  return array(resolved, 1).map(object).filter(item => item.Main !== true).map(item => {
    const pkg = component(item.Path, item.Version, 'Go');
    const status = (suffix: string, observed: unknown): 'missing' | 'mismatch' | 'matched' => {
      const expected = sums.get(`${pkg.name}@${pkg.version}${suffix}`);
      return !expected ? 'missing' : expected === observed ? 'matched' : 'mismatch';
    };
    return { name: pkg.name, version: pkg.version, archive: status('', item.Sum), module: status('/go.mod', item.GoModSum) };
  }).filter(item => item.archive !== 'matched' || item.module !== 'matched');
}

export interface GoVerifiedChecksum {
  name: string;
  version: string;
  sum: string;
  goModSum: string;
  recordDigest: string;
}

// This parses a cache record, not a signature. Its caller must use a fresh
// private cache written by a successful Go sumdb client, which verifies the
// signed tree and inclusion proof *before* caching the complete record.
export function parseGoSumdbRecord(source: string, name: string, version: string): GoVerifiedChecksum {
  component(name, version, 'Go');
  if (Buffer.byteLength(source) > 64 * 1024) reject('osv-go-sumdb-record');
  const lines = source.split('\n');
  if (!/^\d+$/.test(lines[0] ?? '') || lines[3] !== '' || lines[4] !== 'go.sum database tree' ||
      !source.includes('\n— sum.golang.org ')) reject('osv-go-sumdb-record');
  const hash = (line: string | undefined, suffix: string) => {
    const prefix = `${name} ${version}${suffix} `;
    if (!line?.startsWith(prefix)) reject('osv-go-sumdb-coordinate');
    const value = line.slice(prefix.length);
    if (!/^h1:[A-Za-z0-9+/]{43}=$/.test(value)) reject('osv-go-sumdb-record');
    return value;
  };
  return { name, version, sum: hash(lines[1], ''), goModSum: hash(lines[2], '/go.mod'), recordDigest: osvDigest(source) };
}

/** The go.mod extractor is deliberately not accepted as a resolved graph. */
export function reconcileGoResolution(options: {
  graph: Graph; goMod: string; goSum: string; resolved: unknown; moduleGraph: string;
  expected: { dependencies: Record<string, string>; tools: Record<string, string>; goVersion: string };
  tool?: { name: string; version: string; sum: string; goModSum: string };
  additionalChecksums?: readonly GoVerifiedChecksum[];
}): OsvGraph {
  const { graph, goMod, goSum, expected } = options;
  if (graph.id !== 'go-backend' || graph.ecosystem !== 'go' || graph.extras.length) reject('osv-wrong-graph');
  const required = new Map<string, string>();
  let main: string | undefined, goVersion: string | undefined, block = false, retractBlock = false;
  for (const raw of goMod.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (line === 'retract (' && !block && !retractBlock) { retractBlock = true; continue; }
    if (line === ')' && retractBlock) { retractBlock = false; continue; }
    if (retractBlock) {
      component(main, line, 'Go');
      if (options.tool?.version === line) reject('osv-retracted-tool');
      continue;
    }
    if (line === 'require (' && !block) { block = true; continue; }
    if (line === ')' && block) { block = false; continue; }
    if (line.startsWith('module ') && !main && !block) { main = line.slice(7); continue; }
    if (line.startsWith('go ') && !goVersion && !block) { goVersion = line.slice(3); continue; }
    const declaration = /^(?:require\s+)?(\S+)\s+(v\S+)$/.exec(line);
    if (!declaration || !block && !line.startsWith('require ')) reject('osv-unsupported-go-directive');
    const pkg = component(declaration[1], declaration[2], 'Go');
    if (required.has(pkg.name)) reject('osv-duplicate-module');
    required.set(pkg.name, pkg.version);
  }
  if (block || retractBlock || !main || goVersion !== expected.goVersion) reject('osv-go-baseline-drift');
  for (const [name, version] of Object.entries(expected.dependencies)) {
    if (required.get(name) !== version) reject('osv-go-baseline-drift');
  }
  // Supported build/migration tools are a separate selected graph unless they
  // are explicitly in this frozen module. go.sum membership is not selection.
  for (const [name, version] of Object.entries(expected.tools)) {
    if (options.tool?.name !== name || options.tool.version !== version || main !== name) reject('osv-go-tool-graph-missing');
  }
  const sums = parseGoSums(goSum);
  const resolved = array(options.resolved, 2).map(object);
  const roots = resolved.filter(item => item.Main === true);
  if (roots.length !== 1 || roots[0]!.Path !== main || roots[0]!.Error || roots[0]!.Replace) reject('osv-go-resolution-root');
  const modules = resolved.filter(item => item.Main !== true);
  const supplemental = new Map<string, GoVerifiedChecksum>();
  for (const value of options.additionalChecksums ?? []) {
    record(value, ['name', 'version', 'sum', 'goModSum', 'recordDigest'], 'osv-invalid-go-provenance');
    const pkg = component(value.name, value.version, 'Go'), name = `${pkg.name}@${pkg.version}`;
    digest(value.recordDigest);
    if (supplemental.has(name) || !modules.some(item => item.Path === pkg.name && item.Version === pkg.version)) {
      reject('osv-unused-go-provenance');
    }
    for (const [suffix, hash] of [['', value.sum], ['/go.mod', value.goModSum]]) {
      if (!/^h1:[A-Za-z0-9+/]{43}=$/.test(hash!)) reject('osv-invalid-go-provenance');
      if (sums.has(`${name}${suffix}`) && sums.get(`${name}${suffix}`) !== hash) reject('osv-go-checksum-mismatch');
      sums.set(`${name}${suffix}`, hash!);
    }
    supplemental.set(name, value);
  }
  const components = modules.map(item => {
    if (item.Error || item.Replace || item.Indirect !== undefined && typeof item.Indirect !== 'boolean') {
      reject('osv-unresolved-go-module');
    }
    const pkg = component(item.Path, item.Version, 'Go'), name = `${pkg.name}@${pkg.version}`;
    const proof = supplemental.get(name);
    if (!sums.has(name) || !sums.has(`${name}/go.mod`) ||
        (item.Sum ?? proof?.sum) !== sums.get(name) ||
        (item.GoModSum ?? proof?.goModSum) !== sums.get(`${name}/go.mod`)) reject('osv-go-checksum-mismatch');
    return pkg;
  });
  exactSet(components.map(item => item.name), components.map(item => item.name), 'osv-duplicate-module');
  const byName = new Map(components.map(item => [item.name, item]));
  for (const [name, version] of required) {
    if (byName.get(name)?.version !== version) reject('osv-go-selected-version-drift');
  }
  const edges = new Map<string, Set<string>>(), versions = new Map<string, string>();
  const rootEdges = new Set<string>();
  function node(value: string): OsvComponent {
    const at = value.lastIndexOf('@');
    const pkg = component(value.slice(0, at), value.slice(at + 1), 'Go');
    const selected = byName.get(pkg.name);
    if (!selected) reject('osv-go-graph-omission');
    const old = versions.get(pkg.name);
    if (!old || compareGoVersions(pkg.version, old) > 0) versions.set(pkg.name, pkg.version);
    return pkg;
  }
  for (const line of options.moduleGraph.trim().split(/\r?\n/)) {
    const parts = line.split(' ');
    if (parts.length !== 2 || !parts.every(Boolean)) reject('osv-invalid-module-graph');
    const [from, to] = parts as [string, string];
    if (/^(?:go|toolchain)@/.test(to)) continue;
    if (from !== main) node(from);
    const target = node(to);
    if (from === main) rootEdges.add(`${target.name}@${target.version}`);
    const children = edges.get(from) ?? new Set<string>();
    children.add(to);
    edges.set(from, children);
  }
  exactSet([...rootEdges], [...required].map(([name, version]) => `${name}@${version}`), 'osv-go-root-graph-mismatch');
  exactSet([...versions.keys()], [...byName.keys()], 'osv-go-graph-omission');
  for (const item of components) {
    if (versions.get(item.name) !== item.version) reject('osv-go-mvs-mismatch');
  }
  // Retain versioned graph vertices: requirements from older loaded versions
  // still participate in MVS. Dropping their edges can miss selected modules.
  // Prefer direct-root paths, then explicit indirect requirements. The entire
  // graph is digest-bound; paths are representative, not runtime reachability.
  const paths = new Map<string, string[]>([[main, [main]]]), queue = [main];
  for (const directOnly of [true, false]) {
    if (!directOnly) queue.push(main);
    for (let index = directOnly ? 0 : queue.length - 1; index < queue.length; index++) {
      const current = queue[index]!;
      for (const child of [...edges.get(current) ?? []].sort()) {
        const pkg = node(child);
        if (directOnly && current === main && !(pkg.name in expected.dependencies) || paths.has(child)) continue;
        const next = [...paths.get(current)!, identifier(child, 'osv-invalid-chain')];
        if (next.length > 50) reject('osv-chain-limit');
        paths.set(child, next);
        const selected = byName.get(pkg.name)!;
        if (selected.version === pkg.version && selected.chains.length === 0) selected.chains.push(next);
        queue.push(child);
      }
    }
  }
  if (components.some(item => item.chains.length === 0)) reject('osv-go-unreachable-module');
  if (options.tool) {
    if (options.tool.name !== main || !/^h1:[A-Za-z0-9+/]{43}=$/.test(options.tool.sum) ||
        !/^h1:[A-Za-z0-9+/]{43}=$/.test(options.tool.goModSum)) reject('osv-invalid-tool-provenance');
    const root = component(options.tool.name, options.tool.version, 'Go');
    root.chains = [[`${graph.id}/tool`, root.name]];
    for (const item of components) item.chains = item.chains.map(chain => [`${graph.id}/tool`, ...chain]);
    components.unshift(root);
  }
  return { id: graph.id, pathParts: portableParts(graph.pathParts),
    inputDigest: osvDigest(JSON.stringify([osvDigest(goMod), osvDigest(goSum),
      options.moduleGraph.trim().split(/\r?\n/).sort(), options.tool ?? null,
      components.map(item => [item.name, item.version, sums.get(`${item.name}@${item.version}`),
        sums.get(`${item.name}@${item.version}/go.mod`)]).sort()])), components };
}

export function combineGoGraphs(app: OsvGraph, tools: readonly OsvGraph[], requiredTools: Record<string, string>): OsvGraph {
  if (app.id !== 'go-backend' || tools.some(tool => tool.id !== app.id) ||
      tools.length !== Object.keys(requiredTools).length) reject('osv-go-tool-graph-missing');
  const actualTools = tools.map(tool => {
    const roots = tool.components.filter(item => item.chains.some(chain =>
      chain.length === 2 && chain[0] === 'go-backend/tool' && chain[1] === item.name));
    if (roots.length !== 1 || requiredTools[roots[0]!.name] !== roots[0]!.version) reject('osv-go-tool-graph-missing');
    return roots[0]!.name;
  });
  exactSet(actualTools, Object.keys(requiredTools), 'osv-go-tool-graph-missing');
  const packages = new Map<string, OsvComponent>();
  for (const graph of [app, ...tools]) {
    digest(graph.inputDigest);
    for (const item of graph.components) {
      if (item.ecosystem !== 'Go') reject('osv-wrong-ecosystem');
      const old = packages.get(key(item));
      const chains = [...old?.chains ?? [], ...item.chains];
      packages.set(key(item), { ...item, chains: [...new Map(chains.map(chain => [JSON.stringify(chain), chain])).values()] });
    }
  }
  return { id: app.id, pathParts: [...app.pathParts],
    inputDigest: osvDigest(JSON.stringify([app.inputDigest, tools.map(tool => tool.inputDigest).sort(), requiredTools])),
    components: [...packages.values()].sort((a, b) => key(a) < key(b) ? -1 : 1) };
}

function packageRows(source: string, expectedPath: string): Record<string, unknown>[] {
  const report = object(json(source));
  if (Object.keys(report).some(k => !['results', 'experimental_config'].includes(k))) reject('osv-unexpected-report');
  const config = record(report.experimental_config, ['licenses'], 'osv-configuration-mismatch');
  const licenses = record(config.licenses, ['summary', 'allowlist'], 'osv-configuration-mismatch');
  if (licenses.summary !== false || licenses.allowlist !== null &&
      (!Array.isArray(licenses.allowlist) || licenses.allowlist.length !== 0)) reject('osv-configuration-mismatch');
  const results = array(report.results, 1, 1);
  const result = record(results[0], ['source', 'packages'], 'osv-unexpected-source');
  const location = record(result.source, ['path', 'type'], 'osv-unexpected-source');
  if (location.path !== expectedPath || !['lockfile', 'sbom'].includes(String(location.type))) reject('osv-unexpected-source');
  return array(result.packages, 1).map(object);
}

export function extractedOsvComponents(source: string, expectedPath: string): OsvComponent[] {
  return packageRows(source, expectedPath).map(row => {
    const pkg = record(row.package, ['name', 'version', 'ecosystem'], 'osv-unscannable-component');
    if (pkg.ecosystem !== 'PyPI' && pkg.ecosystem !== 'Go') reject('osv-wrong-ecosystem');
    return component(pkg.name, pkg.ecosystem === 'Go' && typeof pkg.version === 'string'
      ? `v${pkg.version.replace(/^v/, '')}` : pkg.version, pkg.ecosystem);
  });
}

export function requireOsvExtraction(source: string, expectedPath: string, graph: OsvGraph): void {
  exactSet(extractedOsvComponents(source, expectedPath).map(key), graph.components.map(key));
}

function advisory(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:GHSA-[23456789cfghjmpqrvwx]{4}(?:-[23456789cfghjmpqrvwx]{4}){2}|CVE-[0-9]{4}-[0-9]{4,}|GO-[0-9]{4}-[0-9]+|PYSEC-[0-9]{4}-[0-9]+)$/.test(value)) {
    reject('osv-invalid-advisory');
  }
  return value;
}
export const osvAdvisoryId = advisory;
export const osvUnscoredPolicyRules = Object.freeze([
  Object.freeze({ tool: 'osv-scanner', rule: 'osv-valid-unscored-advisory' })
]);
export interface OsvSeverityIssue {
  componentIndex: number;
  package: string;
  version: string;
  advisories: string[];
  classification: 'missing' | 'non-numeric' | 'noncanonical-numeric';
}
export class OsvUnclassifiedSeverityError extends SecurityEvidenceError {
  readonly issues: readonly OsvSeverityIssue[];
  constructor(issues: readonly OsvSeverityIssue[]) {
    super('osv-unknown-severity');
    this.issues = Object.freeze(issues.map(issue => Object.freeze({ ...issue, advisories: [...issue.advisories] })));
  }
}
function severity(value: unknown): Severity {
  if (typeof value !== 'string' || !/^(?:10(?:\.0)?|[0-9](?:\.[0-9])?)$/.test(value)) reject('osv-unknown-severity');
  const score = Number(value);
  return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'moderate' : score > 0 ? 'low' : 'info';
}

export function normalizeOsvReport(options: {
  source: string; exitCode: number; expectedPath: string; graph: OsvGraph;
  identity: EvidenceIdentity; owner: string; generatedAt: string; completedAt: string;
  classifications?: readonly OwnAdvisoryClassification[];
}): SecurityReport {
  const { source, graph } = options;
  requireOsvExtraction(source, options.expectedPath, graph);
  const rows = packageRows(source, options.expectedPath);
  const components = extractedOsvComponents(source, options.expectedPath);
  const findings: SecurityFinding[] = [];
  const unclassified: OsvSeverityIssue[] = [];
  rows.forEach((row, index) => {
    if (Object.keys(row).some(k => !['package', 'dependency_groups', 'vulnerabilities', 'groups'].includes(k))) {
      reject('osv-unexpected-package-fields');
    }
    const expected = graph.components.find(item => key(item) === key(components[index]!))!;
    const vulns = array(row.vulnerabilities ?? []).map(object);
    const ids = vulns.map(vuln => advisory(vuln.id));
    const groups = array(row.groups ?? []).map(object);
    exactSet(groups.flatMap(group => array(group.ids, 1).map(advisory)), ids, 'osv-vulnerability-group-mismatch');
    const levels = new Map<Record<string, unknown>, Severity>();
    for (const group of groups) {
      if (Object.keys(group).some(k => !['ids', 'aliases', 'max_severity'].includes(k))) reject('osv-reachability-filter');
      // Alias namespaces include provider-specific identifiers. They are
      // bounded descriptive input only, never emitted or used for exceptions;
      // actual vulnerability IDs and group membership remain strictly checked.
      array(group.aliases, 1).forEach(value => identifier(value, 'osv-invalid-advisory-alias'));
      try { levels.set(group, severity(group.max_severity)); }
      catch (error) {
        if (!(error instanceof SecurityEvidenceError) || error.code !== 'osv-unknown-severity') throw error;
        if (options.classifications && group.max_severity !== undefined && group.max_severity !== null && group.max_severity !== '') {
          throw error;
        }
        if (options.classifications) continue;
        unclassified.push({
          componentIndex: graph.components.indexOf(expected), package: expected.name, version: expected.version,
          advisories: array(group.ids, 1).map(advisory),
          classification: group.max_severity === undefined || group.max_severity === null || group.max_severity === ''
            ? 'missing' : typeof group.max_severity === 'string' && /^[+-]?[0-9]+(?:\.[0-9]+)?$/.test(group.max_severity)
              ? 'noncanonical-numeric' : 'non-numeric'
        });
      }
    }
    for (const vuln of vulns) {
      if (vuln.withdrawn !== undefined) reject('osv-withdrawn-result');
      const id = advisory(vuln.id), group = groups.find(group => (group.ids as string[]).includes(id))!;
      const own = options.classifications?.filter(item =>
        item.package === expected.name && item.version === expected.version && item.advisory === id);
      if (own && own.length !== 1) reject('osv-own-classification-coverage');
      const classification = own?.[0];
      if (classification && (
        classification.basis === 'unscored-policy'
          ? classification.kind !== 'policy' || classification.severity !== 'high'
          : classification.kind !== 'vulnerability' || !['published-label', 'own-cvss-v3-base', 'native-own-cvss'].includes(classification.basis)
      )) reject('osv-own-classification-coverage');
      const level = classification?.severity ?? levels.get(group);
      if (level === undefined) continue;
      findings.push({
        id: `osv-${createHash('sha256').update(`${graph.id}\0${key(expected)}\0${id}`).digest('hex')}`,
        kind: classification?.kind ?? 'vulnerability', tool: 'osv-scanner', rule: id, scope: graph.id, component: expected.name,
        version: expected.version, chains: expected.chains, location: graph.pathParts,
        artifactDigest: graph.inputDigest, severity: level,
        owner: identifier(options.owner, 'missing-owner'),
        ...(classification?.basis === 'unscored-policy'
          ? { policyClass: 'osv-valid-unscored-advisory' as const, upstreamSeverity: 'unscored' as const } : {})
      });
    }
  });
  if (options.classifications && (options.classifications.length !== findings.length ||
      new Set(options.classifications.map(item => `${item.package}\0${item.version}\0${item.advisory}`)).size !== options.classifications.length)) {
    reject('osv-own-classification-coverage');
  }
  if (unclassified.length) throw new OsvUnclassifiedSeverityError(unclassified);
  if (options.exitCode !== (findings.length ? 1 : 0)) reject('osv-exit-report-mismatch');
  return parseSecurityReport(JSON.stringify({
    schemaVersion: 1, role: 'non-npm-dependencies', identity: options.identity,
    // The live API exposes no immutable DB revision. Bind the exact response,
    // including advisory modification data; do not claim a versioned snapshot.
    tool: { name: 'osv-scanner', version: osvRelease.version, database: osvDigest(source) },
    generatedAt: options.generatedAt, completedAt: options.completedAt, complete: true,
    units: [{ id: graph.id, inputDigest: graph.inputDigest, count: graph.components.length, platform: 'all' }],
    findings
  }));
}
