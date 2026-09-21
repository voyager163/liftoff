import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, readlink, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCodeqlSarif } from './codeql.ts';
import { evaluateSecurityReport, SecurityEvidenceError, type EvidenceIdentity } from './evidence.ts';

// This opt-in demonstration never selects repository source or uploads results.
export const codeqlFixturePin = Object.freeze({
  version: '2.27.0',
  platform: 'osx64',
  url: 'https://github.com/github/codeql-action/releases/download/codeql-bundle-v2.27.0/codeql-bundle-osx64.tar.gz',
  bytes: 1_366_461_365,
  digest: 'sha256:33144291ddcf14ca969a658dfdda679f5dc8c8fee630c9c8251dc7a8dab5719c',
  queryPack: 'codeql/javascript-queries@2.4.5',
  libraryPack: 'codeql/javascript-all@2.10.1',
  query: 'js/incomplete-sanitization',
  queryDigest: 'sha256:38e248b447238648366ddd2c543e4842fbd7b7ae2efcdc0a95a0875534a5a693',
  sourceHead: '70d10881b46d873118d825735696f39b6d35ebe0'
});

export interface CodeqlFixtureArea {
  readonly root: string;
  readonly slots: Readonly<Record<'tool' | 'home' | 'scratch' | 'clean' | 'insecure' | 'coverage', string>>;
  readonly registration: CodeqlFixtureRegistration;
  verify(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface CodeqlFixtureRegistration {
  root: string;
  owner: string;
  inode: number;
  device: number;
  slots: Record<'tool' | 'home' | 'scratch' | 'clean' | 'insecure' | 'coverage', number>;
}

export async function createCodeqlFixtureArea(parent: string): Promise<CodeqlFixtureArea> {
  const parentRoot = await realpath(parent);
  if (!(await lstat(parentRoot)).isDirectory()) throw new SecurityEvidenceError('codeql-fixture-parent');
  const root = path.join(parentRoot, `.codeql-fixture-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  const owner = randomUUID();
  const marker = path.join(root, '.owner');
  await writeFile(marker, owner, { flag: 'wx', mode: 0o600 });
  const identity = await lstat(root);
  const slots = Object.fromEntries(
    ['tool', 'home', 'scratch', 'clean', 'insecure', 'coverage'].map(name => [name, path.join(root, name)])
  ) as Record<'tool' | 'home' | 'scratch' | 'clean' | 'insecure' | 'coverage', string>;
  const identities: Record<string, number> = {};
  for (const slot of Object.values(slots)) {
    await mkdir(slot, { mode: 0o700 });
    identities[path.basename(slot)] = (await lstat(slot)).ino;
  }
  return resumeCodeqlFixtureArea({
    root, owner, inode: identity.ino, device: identity.dev,
    slots: identities as CodeqlFixtureRegistration['slots']
  });
}

export async function resumeCodeqlFixtureArea(registration: CodeqlFixtureRegistration): Promise<CodeqlFixtureArea> {
  const { root, owner, inode, device } = registration;
  if (!path.isAbsolute(root) || !/^\.codeql-fixture-[0-9a-f-]{36}$/.test(path.basename(root)) ||
      !/^[0-9a-f-]{36}$/.test(owner) ||
      JSON.stringify(Object.keys(registration.slots).sort()) !==
        JSON.stringify(['clean', 'coverage', 'home', 'insecure', 'scratch', 'tool'])) {
    throw new SecurityEvidenceError('codeql-fixture-registration');
  }
  const marker = path.join(root, '.owner');
  const slots = Object.fromEntries(
    Object.keys(registration.slots).map(name => [name, path.join(root, name)])
  ) as Record<keyof CodeqlFixtureRegistration['slots'], string>;
  let closed = false;

  async function verify() {
    try {
      const current = await lstat(root), markerStatus = await lstat(marker);
      if (closed || current.isSymbolicLink() || current.ino !== inode || current.dev !== device ||
          !markerStatus.isFile() || markerStatus.isSymbolicLink() || await readFile(marker, 'utf8') !== owner ||
          (await readdir(root)).some(name => !['.owner', ...Object.keys(slots)].includes(name))) {
        throw new Error();
      }
      for (const name of Object.keys(slots) as (keyof typeof slots)[]) {
        const current = await lstat(slots[name]);
        if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== registration.slots[name]) throw new Error();
      }
    } catch {
      throw new SecurityEvidenceError('codeql-fixture-registration');
    }
  }

  // Only the six explicitly registered output trees are traversed; links are
  // unlinked as entries, never followed to their targets.
  async function removeTree(directory: string) {
    const directoryStatus = await lstat(directory);
    if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
      throw new SecurityEvidenceError('codeql-fixture-cleanup-directory');
    }
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory)) {
      const target = path.join(directory, entry);
      const status = await lstat(target);
      if (status.isDirectory() && !status.isSymbolicLink()) {
        await removeTree(target);
        await rmdir(target);
      } else {
        await unlink(target);
      }
    }
  }

  await verify();
  return {
    root, slots, registration, verify,
    async cleanup() {
      await verify();
      try {
        for (const slot of Object.values(slots)) {
          await removeTree(slot);
          await rmdir(slot);
        }
        await unlink(marker);
        await rmdir(root);
        closed = true;
      } catch {
        throw new SecurityEvidenceError('codeql-fixture-cleanup');
      }
    }
  };
}

export function codeqlFixtureEnvironment(area: CodeqlFixtureArea): NodeJS.ProcessEnv {
  return {
    PATH: `${path.join(area.slots.home, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: area.slots.home, TMPDIR: area.slots.scratch, TMP: area.slots.scratch, TEMP: area.slots.scratch,
    XDG_CACHE_HOME: area.slots.home, XDG_CONFIG_HOME: area.slots.home, XDG_DATA_HOME: area.slots.home,
    CODEQL_USER_HOME: area.slots.home,
    PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
    JAVA_TOOL_OPTIONS: `-Djava.io.tmpdir="${area.slots.scratch}" -Duser.home="${area.slots.home}" -XX:ActiveProcessorCount=1 -Xmx1024m -XX:MaxDirectMemorySize=256m`,
    OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', GOMAXPROCS: '1'
  };
}

export interface CodeqlFixtureExecution {
  startedAt: string;
  completedAt: string;
  exitCode: number;
  stdoutBytes: number;
  stderrBytes: number;
}

const diagnosticPatterns = {
  'memory-exhausted': /OutOfMemoryError|Java heap space|insufficient memory|out of memory/i,
  'empty-extraction': /No source code was seen|no source files|did not extract any code/i,
  'missing-runtime': /(?:node|python|java).{0,80}(?:not found|not installed|not available)|cannot find.{0,40}(?:node|python|java)|Could not start Node\.js|Please install Node\.js/i,
  'unsupported-option': /Unknown option|Unmatched argument|Unrecognized option|not supported.{0,30}build.mode/i,
  'filesystem-denied': /Permission denied|Operation not permitted|AccessDeniedException/i,
  'disk-exhausted': /No space left on device|Too many open files/i,
  'extractor-failed': /extractor.{0,80}(?:failed|error)|extraction.{0,80}failed/i,
  'typescript-error': /TypeScript.{0,80}(?:error|failed)/i
} as const;

export class CodeqlFixtureProcessError extends SecurityEvidenceError {
  readonly execution: CodeqlFixtureExecution;
  readonly diagnostics: readonly (keyof typeof diagnosticPatterns)[];
  constructor(execution: CodeqlFixtureExecution, stderr: Uint8Array) {
    super('codeql-fixture-process-failed');
    this.execution = Object.freeze(execution);
    const text = Buffer.from(stderr).toString('utf8');
    this.diagnostics = Object.freeze((Object.keys(diagnosticPatterns) as (keyof typeof diagnosticPatterns)[])
      .filter(key => diagnosticPatterns[key].test(text)));
  }
}

export interface CodeqlRuntimeEnvironment {
  CODEQL_PYTHON?: string;
  GOPATH?: string;
  GOCACHE?: string;
  GOMODCACHE?: string;
  GOROOT?: string;
  GOTOOLCHAIN?: 'local';
  GOPROXY?: 'off' | 'https://proxy.golang.org';
  GOSUMDB?: 'off' | 'sum.golang.org';
  GOWORK?: 'off';
  GOENV?: 'off';
  GOAUTH?: 'off';
  GOFLAGS?: '-mod=readonly';
  GOVCS?: '*:off';
  CGO_ENABLED?: '0';
}

export async function captureCodeqlFixtureOutput<T>(
  area: CodeqlFixtureArea, executable: string, args: string[],
  consume: (stdout: string) => T,
  timeoutMs: number, maximumBytes: number, runtime: CodeqlRuntimeEnvironment = {},
  allowedExitCodes: readonly number[] = [0]
): Promise<{ execution: CodeqlFixtureExecution; value: T }> {
  await area.verify();
  if (!path.isAbsolute(executable) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000 ||
      !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 16 * 1024 * 1024 ||
      !allowedExitCodes.includes(0) || allowedExitCodes.length > 2 ||
      new Set(allowedExitCodes).size !== allowedExitCodes.length || allowedExitCodes.some(code => code !== 0 && code !== 1)) {
    throw new SecurityEvidenceError('codeql-fixture-process-options');
  }
  if (Object.keys(runtime).some(key => ![
    'CODEQL_PYTHON', 'GOPATH', 'GOCACHE', 'GOMODCACHE', 'GOROOT', 'GOTOOLCHAIN', 'GOPROXY', 'GOSUMDB', 'CGO_ENABLED',
    'GOWORK', 'GOENV', 'GOAUTH', 'GOFLAGS', 'GOVCS'
  ].includes(key)) || runtime.GOTOOLCHAIN !== undefined && runtime.GOTOOLCHAIN !== 'local' ||
      runtime.GOPROXY !== undefined && !['off', 'https://proxy.golang.org'].includes(runtime.GOPROXY) ||
      runtime.GOSUMDB !== undefined && !['off', 'sum.golang.org'].includes(runtime.GOSUMDB) ||
      ['GOWORK', 'GOENV', 'GOAUTH'].some(key => runtime[key as keyof CodeqlRuntimeEnvironment] !== undefined &&
        runtime[key as keyof CodeqlRuntimeEnvironment] !== 'off') ||
      runtime.GOFLAGS !== undefined && runtime.GOFLAGS !== '-mod=readonly' ||
      runtime.GOVCS !== undefined && runtime.GOVCS !== '*:off' ||
      runtime.CGO_ENABLED !== undefined && runtime.CGO_ENABLED !== '0') {
    throw new SecurityEvidenceError('codeql-fixture-runtime-environment');
  }
  for (const key of ['GOPATH', 'GOCACHE', 'GOMODCACHE'] as const) {
    const value = runtime[key];
    if (value !== undefined && (!path.isAbsolute(value) || path.resolve(value) !== value ||
        !value.startsWith(`${area.slots.home}${path.sep}`))) {
      throw new SecurityEvidenceError('codeql-fixture-runtime-cache');
    }
  }
  const startedAt = new Date().toISOString();
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0;
    let failure: string | undefined;
    const child = spawn(executable, args, {
      cwd: area.slots.scratch, env: { ...codeqlFixtureEnvironment(area), ...runtime }, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', shell: false
    });
    function stop(code: string) {
      failure ??= code;
      if (child.pid) {
        try {
          // The fresh process group contains only this registered invocation.
          process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
        } catch { /* A process that already exited still fails closed below. */ }
      }
    }
    const timer = setTimeout(() => stop('codeql-fixture-timeout'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes + stderrBytes > maximumBytes) stop('codeql-fixture-output-limit');
      else if (!failure) stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > maximumBytes) stop('codeql-fixture-output-limit');
      else if (!failure) stderr.push(Buffer.from(chunk));
      chunk.fill(0);
    });
    child.on('error', () => { failure ??= 'codeql-fixture-spawn'; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const completedAt = new Date().toISOString();
      try {
        if (failure) throw new SecurityEvidenceError(failure);
        if (code === null || !allowedExitCodes.includes(code) || signal) {
          const bytes = Buffer.concat(stderr);
          try {
            throw new CodeqlFixtureProcessError({ startedAt, completedAt, exitCode: code ?? -1, stdoutBytes, stderrBytes }, bytes);
          } finally { bytes.fill(0); }
        }
        let value: T;
        try { value = consume(Buffer.concat(stdout).toString('utf8')); }
        catch { throw new SecurityEvidenceError('codeql-fixture-output-invalid'); }
        resolve({ execution: { startedAt, completedAt, exitCode: code, stdoutBytes, stderrBytes }, value });
      } catch (error) {
        reject(error);
      } finally {
        for (const chunk of stdout) chunk.fill(0);
        for (const chunk of stderr) chunk.fill(0);
        stdout.length = 0;
        stderr.length = 0;
      }
    });
  });
}

const capture = captureCodeqlFixtureOutput;

export async function captureCodeqlFixtureProcess(
  area: CodeqlFixtureArea, executable: string, args: string[], timeoutMs = 30_000, maximumBytes = 1024 * 1024
): Promise<CodeqlFixtureExecution> {
  return (await capture(area, executable, args, () => undefined, timeoutMs, maximumBytes)).execution;
}

async function fileDigest(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

export interface CodeqlToolSeal {
  bundleDigest: string;
  treeDigest: string;
  files: number;
}

async function toolTreeDigest(area: CodeqlFixtureArea): Promise<CodeqlToolSeal> {
  await area.verify();
  const root = path.join(area.slots.tool, 'codeql');
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) {
    throw new SecurityEvidenceError('codeql-fixture-tool-root');
  }
  const tree = createHash('sha256');
  let files = 0, bytes = 0;
  async function visit(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name), status = await lstat(file);
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (++files > 100_000 || (bytes += status.size) > 16 * 1024 ** 3) {
        throw new SecurityEvidenceError('codeql-fixture-tool-size');
      }
      if (status.isSymbolicLink()) {
        const link = await readlink(file), target = path.resolve(path.dirname(file), link);
        if (path.isAbsolute(link) || !target.startsWith(`${root}${path.sep}`)) {
          throw new SecurityEvidenceError('codeql-fixture-tool-link');
        }
        tree.update(JSON.stringify([relative, 'link', link]));
      } else if (status.isDirectory()) {
        tree.update(JSON.stringify([relative, 'directory', status.mode & 0o777]));
        await visit(file);
      } else if (status.isFile()) {
        tree.update(JSON.stringify([relative, 'file', status.mode & 0o777, await fileDigest(file)]));
      } else {
        throw new SecurityEvidenceError('codeql-fixture-tool-entry');
      }
    }
  }
  await visit(root);
  return { bundleDigest: codeqlFixturePin.digest, treeDigest: `sha256:${tree.digest('hex')}`, files };
}

export async function sealCodeqlFixtureTool(area: CodeqlFixtureArea): Promise<CodeqlToolSeal> {
  await inspectCodeqlFixtureTool(area);
  return toolTreeDigest(area);
}

export async function verifyCodeqlFixtureTool(area: CodeqlFixtureArea, seal: CodeqlToolSeal): Promise<void> {
  const observed = await toolTreeDigest(area);
  if (observed.bundleDigest !== seal.bundleDigest || observed.treeDigest !== seal.treeDigest || observed.files !== seal.files) {
    throw new SecurityEvidenceError('codeql-fixture-tool-cache-changed');
  }
}

export async function restoreCodeqlFixtureTool(area: CodeqlFixtureArea): Promise<string> {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
    throw new SecurityEvidenceError('codeql-fixture-platform-unqualified');
  }
  await captureCodeqlFixtureProcess(area, '/usr/bin/arch', ['-x86_64', '/usr/bin/true']);
  await captureCodeqlFixtureProcess(area, '/usr/bin/xcode-select', ['-p']);
  const archive = path.join(area.slots.tool, 'bundle.tar.gz');
  await captureCodeqlFixtureProcess(area, '/usr/bin/curl', [
    '--disable', '--fail', '--silent', '--show-error', '--location', '--proto', '=https',
    '--proto-redir', '=https', '--tlsv1.2', '--connect-timeout', '20', '--max-time', '480',
    '--max-filesize', String(codeqlFixturePin.bytes), '--output', archive, codeqlFixturePin.url
  ], 500_000);
  const status = await lstat(archive);
  if (!status.isFile() || status.isSymbolicLink() || status.size !== codeqlFixturePin.bytes ||
      await fileDigest(archive) !== codeqlFixturePin.digest) throw new SecurityEvidenceError('codeql-fixture-bundle-digest');
  await capture(area, '/usr/bin/tar', ['-tzf', archive], output => {
    const entries = output.trim().split('\n');
    if (entries.length === 0 || entries.some(name => !name.startsWith('codeql/') ||
        name.includes('\\') || name.split('/').some(part => part === '..'))) throw new Error();
    return undefined;
  }, 300_000, 16 * 1024 * 1024);
  await captureCodeqlFixtureProcess(area, '/usr/bin/tar', ['-xzf', archive, '-C', area.slots.tool], 300_000);
  await unlink(archive);
  await chmod(area.slots.tool, 0o700);
  return path.join(area.slots.tool, 'codeql', 'codeql');
}

export async function inspectCodeqlFixtureTool(area: CodeqlFixtureArea) {
  const executable = path.join(area.slots.tool, 'codeql', 'codeql');
  const version = await capture(area, executable, ['version', '--format=json'], source => {
    const value: unknown = JSON.parse(source);
    if (value === null || typeof value !== 'object' ||
        (value as { version?: unknown }).version !== codeqlFixturePin.version) throw new Error();
    return codeqlFixturePin.version;
  }, 30_000, 1024 * 1024);
  const languages = await capture(area, executable, ['resolve', 'languages', '--format=json'], source => {
    const value: unknown = JSON.parse(source);
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, 'javascript')) throw new Error();
    return ['javascript'];
  }, 30_000, 1024 * 1024);
  const packsRoot = path.join(area.slots.tool, 'codeql', 'qlpacks', 'codeql');
  const queryVersions = await readdir(path.join(packsRoot, 'javascript-queries'));
  const libraryVersions = await readdir(path.join(packsRoot, 'javascript-all'));
  if (queryVersions.length !== 1 || libraryVersions.length !== 1 ||
      !/^\d+\.\d+\.\d+$/.test(queryVersions[0]!) || !/^\d+\.\d+\.\d+$/.test(libraryVersions[0]!)) {
    throw new SecurityEvidenceError('codeql-fixture-pack-identity');
  }
  const queryPath = path.join(packsRoot, 'javascript-queries', queryVersions[0]!,
    'Security', 'CWE-116', 'IncompleteSanitization.ql');
  const query = await readFile(queryPath, 'utf8');
  if (!query.includes('@id js/incomplete-sanitization') || !query.includes('@security-severity 7.8') ||
      `codeql/javascript-queries@${queryVersions[0]}` !== codeqlFixturePin.queryPack ||
      `codeql/javascript-all@${libraryVersions[0]}` !== codeqlFixturePin.libraryPack ||
      await fileDigest(queryPath) !== codeqlFixturePin.queryDigest) {
    throw new SecurityEvidenceError('codeql-fixture-query-identity');
  }
  return {
    version: version.value, languages: languages.value,
    queryPack: `codeql/javascript-queries@${queryVersions[0]}`,
    libraryPack: `codeql/javascript-all@${libraryVersions[0]}`,
    query: 'js/incomplete-sanitization', queryDigest: await fileDigest(queryPath)
  };
}

const fixtureSources = Object.freeze({
  clean: 'export function quoteText(value) {\n  return value.replace(/\'/g, "\'\'");\n}\n',
  insecure: 'export function quoteText(value) {\n  return value.replace("\'", "\'\'");\n}\n'
});

const coverageQuery = `import javascript
from File file
where exists(TopLevel top | top.getFile() = file and not top.isExterns())
select file.getRelativePath(),
  count(TopLevel top | top.getFile() = file and not top.isExterns()),
  count(JSParseError error | error.getFile() = file)
`;

export function parseCodeqlFixtureCoverage(source: string): string[][] {
  try {
    if (Buffer.byteLength(source) > 64 * 1024) throw new Error();
    const value = JSON.parse(source) as { '#select'?: { columns?: { kind?: string }[]; tuples?: unknown[][] } };
    const result = value['#select'];
    if (JSON.stringify(result?.columns?.map(column => column.kind)) !== JSON.stringify(['String', 'Integer', 'Integer']) ||
        !Array.isArray(result?.tuples) || result.tuples.length !== 1) throw new Error();
    const tuple = result.tuples[0];
    if (!tuple || tuple.length !== 3 || tuple[0] !== 'fixture.js' || tuple[1] !== 1 || tuple[2] !== 0) throw new Error();
    return [['fixture.js']];
  } catch {
    throw new SecurityEvidenceError('codeql-fixture-extraction-coverage');
  }
}

async function readFixtureOutput(filename: string, maximumBytes = 4 * 1024 * 1024): Promise<string> {
  try {
    const status = await lstat(filename);
    if (!status.isFile() || status.isSymbolicLink() || status.size === 0 || status.size > maximumBytes) throw new Error();
    const result = await readFile(filename, 'utf8');
    if (Buffer.byteLength(result) > maximumBytes) throw new Error();
    return result;
  } catch {
    throw new SecurityEvidenceError('codeql-fixture-report-unreadable');
  }
}

export async function analyzeCodeqlFixture(area: CodeqlFixtureArea, name: keyof typeof fixtureSources) {
  await area.verify();
  if (!Object.hasOwn(fixtureSources, name)) throw new SecurityEvidenceError('codeql-fixture-case');
  const tool = await inspectCodeqlFixtureTool(area);
  const executable = path.join(area.slots.tool, 'codeql', 'codeql');
  const directory = area.slots[name], sourceRoot = path.join(directory, 'source');
  await mkdir(sourceRoot, { mode: 0o700 });
  const sourcePath = path.join(sourceRoot, 'fixture.js');
  await writeFile(sourcePath, fixtureSources[name], { mode: 0o600, flag: 'wx' });
  const database = path.join(directory, 'database');
  const extraction = await captureCodeqlFixtureProcess(area, executable, [
    'database', 'create', database, '--language=javascript', `--source-root=${sourceRoot}`,
    '--build-mode=none', '--threads=1', '--ram=1024'
  ], 300_000);
  const queryDirectory = path.join(area.slots.coverage, name);
  await mkdir(queryDirectory, { mode: 0o700 });
  const queryPath = path.join(queryDirectory, 'coverage.ql');
  await writeFile(queryPath, coverageQuery, { mode: 0o600, flag: 'wx' });
  await writeFile(path.join(queryDirectory, 'qlpack.yml'),
    `name: local/codeql-fixture-coverage\nversion: 0.0.0\ndependencies:\n  codeql/javascript-all: ${tool.libraryPack.split('@')[1]}\n`,
    { mode: 0o600, flag: 'wx' });
  const coveragePath = path.join(directory, 'coverage.bqrs');
  await captureCodeqlFixtureProcess(area, executable, [
    'query', 'run', queryPath, `--database=${database}`, `--output=${coveragePath}`,
    `--additional-packs=${path.join(area.slots.tool, 'codeql', 'qlpacks')}`, '--threads=1', '--ram=1024'
  ], 300_000);
  const coverage = await capture(area, executable, ['bqrs', 'decode', coveragePath, '--format=json'],
    parseCodeqlFixtureCoverage, 30_000, 64 * 1024);
  const sarifPath = path.join(directory, 'result.sarif');
  const query = path.join(area.slots.tool, 'codeql', 'qlpacks', 'codeql', 'javascript-queries',
    tool.queryPack.split('@')[1]!, 'Security', 'CWE-116', 'IncompleteSanitization.ql');
  const analysis = await captureCodeqlFixtureProcess(area, executable, [
    'database', 'analyze', database, query, '--format=sarif-latest', '--sarif-category=fixture/javascript',
    `--output=${sarifPath}`, '--threads=1', '--ram=1024'
  ], 300_000);
  if (await readFile(sourcePath, 'utf8') !== fixtureSources[name]) throw new SecurityEvidenceError('codeql-fixture-source-changed');
  const inputDigest = await fileDigest(sourcePath);
  if (JSON.stringify(await readdir(sourceRoot)) !== JSON.stringify(['fixture.js'])) {
    throw new SecurityEvidenceError('codeql-fixture-source-inventory');
  }
  const record = {
    name, tool, extraction, analysis, extractedPaths: coverage.value, inputDigest,
    sourcePaths: [['fixture.js']], platform: `${process.platform}-${process.arch}`,
    reportDigest: await fileDigest(sarifPath), coverageQueryDigest: hash(coverageQuery)
  };
  await writeFile(path.join(directory, 'execution.json'), JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  return record;
}

export async function inspectCodeqlFixtureSarif(area: CodeqlFixtureArea, name: keyof typeof fixtureSources) {
  await area.verify();
  const sarif = parseFixtureJson(await readFixtureOutput(path.join(area.slots[name], 'result.sarif')));
  const runs = sarif.runs;
  if (!Array.isArray(runs) || runs.length !== 1) throw new SecurityEvidenceError('codeql-fixture-sarif-runs');
  const run = object(runs[0]), driver = object(object(run.tool).driver);
  return {
    runCount: runs.length, categoryMatches: object(run.automationDetails).id === 'fixture/javascript/',
    hasSemanticVersion: driver.semanticVersion === codeqlFixturePin.version,
    hasVersion: driver.version === codeqlFixturePin.version,
    invocationCount: Array.isArray(run.invocations) ? run.invocations.length : 0,
    invocations: Array.isArray(run.invocations) ? run.invocations.map(value => {
      const invocation = object(value);
      return {
        executionSuccessful: invocation.executionSuccessful === true,
        hasStart: typeof invocation.startTimeUtc === 'string',
        hasEnd: typeof invocation.endTimeUtc === 'string',
        hasExitCode: typeof invocation.exitCode === 'number'
      };
    }) : [],
    rules: Array.isArray(driver.rules) ? driver.rules.length : 0,
    results: Array.isArray(run.results) ? run.results.length : null,
    nativePrimaryFingerprints: Array.isArray(run.results) ? run.results.filter(value => {
      const result = object(value);
      const primary = result.partialFingerprints === undefined ? undefined : object(result.partialFingerprints).primaryLocationLineHash;
      return typeof primary === 'string' && /^[a-f0-9]{16,64}:[1-9][0-9]*$/.test(primary) && !/[\r\n]/.test(primary);
    }).length : null
  };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SecurityEvidenceError('codeql-fixture-report-object');
  }
  return value as Record<string, unknown>;
}

function parseFixtureJson(source: string): Record<string, unknown> {
  try { return object(JSON.parse(source)); }
  catch { throw new SecurityEvidenceError('codeql-fixture-report-json'); }
}

function hash(source: string): string {
  return `sha256:${createHash('sha256').update(source).digest('hex')}`;
}

type FixtureAnalysis = Awaited<ReturnType<typeof analyzeCodeqlFixture>>;

function fixtureIdentity(
  name: keyof typeof fixtureSources, inputDigest: string, paths: string[][], configurationDigest: string
): EvidenceIdentity {
  return {
    repository: 'local/codeql-fixtures', event: 'workflow_dispatch',
    sourceSha: inputDigest.slice(7, 47), baseSha: inputDigest.slice(7, 47),
    workflowSha: configurationDigest.slice(7, 47), runId: name === 'clean' ? '1' : '2', attempt: 1,
    policyDigest: hash(JSON.stringify({ blockingRules: [], exceptions: [] })),
    inventoryDigest: hash(JSON.stringify({ paths, inputDigest })), configurationDigest
  };
}

export function evaluateCodeqlFixtureSarif(source: string, actual: FixtureAnalysis, now = new Date()) {
  if (!Object.hasOwn(fixtureSources, actual.name)) throw new SecurityEvidenceError('codeql-fixture-case');
  if (JSON.stringify(actual.tool.languages) !== JSON.stringify(['javascript'])) {
    throw new SecurityEvidenceError('codeql-fixture-language-coverage');
  }
  const configuration = (tool: FixtureAnalysis['tool'], coverageDigest: string) => hash(JSON.stringify({
    bundle: codeqlFixturePin.digest, query: tool.query, queryDigest: tool.queryDigest,
    queryPack: tool.queryPack, libraryPack: tool.libraryPack, coverageDigest,
    category: 'fixture/javascript/', threads: 1, ram: 1024
  }));
  const observedConfiguration = configuration(actual.tool, actual.coverageQueryDigest);
  const expectedConfiguration = configuration({
    ...codeqlFixturePin, languages: ['javascript']
  }, hash(coverageQuery));
  const platform = `${process.platform}-${process.arch}`;
  const identity = fixtureIdentity(actual.name, actual.inputDigest, actual.sourcePaths, observedConfiguration);
  const tool = { name: 'CodeQL', version: actual.tool.version, database: actual.tool.queryPack };
  const unit = { id: actual.name, inputDigest: actual.inputDigest, count: actual.sourcePaths.length, platform: actual.platform };
  const report = normalizeCodeqlSarif(source, {
    category: 'fixture/javascript/', identity, tool, unit, role: 'local-fixture-findings',
    sourcePaths: actual.sourcePaths, extractedPaths: actual.extractedPaths, nonSecurityRules: [],
    execution: {
      category: 'fixture/javascript/', toolVersion: actual.tool.version, reportDigest: actual.reportDigest,
      startedAt: actual.analysis.startedAt, completedAt: actual.analysis.completedAt, exitCode: actual.analysis.exitCode
    }
  });
  const nativeRuns = parseFixtureJson(source).runs as unknown[];
  const nativeRules = object(object(object(nativeRuns[0]).tool).driver).rules;
  if (!Array.isArray(nativeRules) || nativeRules.length !== 1 ||
      object(nativeRules[0]).id !== codeqlFixturePin.query ||
      object(object(nativeRules[0]).properties)['security-severity'] !== '7.8') {
    throw new SecurityEvidenceError('codeql-fixture-query-coverage');
  }
  // Expected fixture bytes and pinned policy are loaded separately from the
  // observed extraction/report identity. Neither becomes authority for itself.
  const expectedDigest = hash(fixtureSources[actual.name]);
  const evaluation = evaluateSecurityReport(report, {
    identity: fixtureIdentity(actual.name, expectedDigest, [['fixture.js']], expectedConfiguration),
    role: 'local-fixture-findings',
    tool: { name: 'CodeQL', version: codeqlFixturePin.version, database: codeqlFixturePin.queryPack },
    units: [{ id: actual.name, inputDigest: expectedDigest, count: 1, platform }]
  }, { blockingRules: [], exceptions: [] }, now);
  const expectedFindings = actual.name === 'clean' ? 0 : 1;
  if (actual.extraction.exitCode !== 0 || report.findings.length !== expectedFindings ||
      report.findings.some(finding => finding.rule !== codeqlFixturePin.query || finding.severity !== 'high') ||
      evaluation.passed !== (actual.name === 'clean') || evaluation.blocking.length !== expectedFindings) {
    throw new SecurityEvidenceError('codeql-fixture-unexpected-outcome');
  }
  return {
    case: actual.name, sourceFiles: actual.sourcePaths.length, extractedFiles: actual.extractedPaths.length,
    parseErrors: 0, extractionExitCode: actual.extraction.exitCode, analysisExitCode: actual.analysis.exitCode,
    findings: report.findings.length, blocking: evaluation.blocking.length, passed: evaluation.passed,
    inputDigest: actual.inputDigest, reportDigest: actual.reportDigest, configurationDigest: observedConfiguration,
    inventoryDigest: identity.inventoryDigest, policyDigest: identity.policyDigest,
    generatedAt: report.generatedAt, completedAt: report.completedAt
  };
}

export async function qualifyCodeqlFixtureArea(area: CodeqlFixtureArea, repository = process.cwd()) {
  const sourceHead = await capture(area, '/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], source => {
    if (source.trim() !== codeqlFixturePin.sourceHead) throw new Error();
    return codeqlFixturePin.sourceHead;
  }, 30_000, 1024);
  const wrapperDigest = await fileDigest(fileURLToPath(import.meta.url));
  const cases = [];
  for (const name of ['clean', 'insecure'] as const) {
    const actual = await analyzeCodeqlFixture(area, name);
    cases.push({
      ...evaluateCodeqlFixtureSarif(await readFixtureOutput(path.join(area.slots[name], 'result.sarif')), actual),
      nativeFormat: await inspectCodeqlFixtureSarif(area, name)
    });
  }
  if (wrapperDigest !== await fileDigest(fileURLToPath(import.meta.url))) {
    throw new SecurityEvidenceError('codeql-fixture-wrapper-changed');
  }
  return {
    qualification: 'local-benign-fixture-only', identityKind: 'synthetic-local-not-a-GitHub-run',
    sourceHead: sourceHead.value, hostPlatform: `${process.platform}-${process.arch}`,
    toolPlatform: codeqlFixturePin.platform, tool: codeqlFixturePin, wrapperDigest,
    coverageQueryDigest: hash(coverageQuery), cases,
    limitations: ['no-repository-scan', 'no-generated-project-qualification', 'no-hosted-or-merge-protection-proof']
  };
}

export async function runCodeqlFixtureQualification(parent: string) {
  const area = await createCodeqlFixtureArea(path.dirname(await realpath(parent)));
  try {
    await restoreCodeqlFixtureTool(area);
    const result = await qualifyCodeqlFixtureArea(area, parent);
    return {
      ...result,
      cleanup: { registeredRoot: path.basename(area.root), registeredTrees: 6, removed: true, rawReportsRetained: 0 }
    };
  } catch (error) {
    if (error instanceof SecurityEvidenceError) throw error;
    throw new SecurityEvidenceError('codeql-fixture-failed');
  } finally {
    await area.cleanup();
  }
}
