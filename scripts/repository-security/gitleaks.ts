import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createSecretsBoundary, type SecretResult } from './secrets.ts';

/**
 * Explicitly opt-in, fixture-only qualification. Never accepts a scan target,
 * repository checkout, caller configuration, remote or existing Git history.
 * Installation alone downloads one official pinned artifact; qualification is
 * offline. Ordinary tests do not install tools or run detector qualification.
 */
export const GITLEAKS_FIXTURE_PINS = Object.freeze({
  'darwin-arm64': Object.freeze({
    version: '8.30.1',
    url: 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_darwin_arm64.tar.gz',
    sha256: 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5'
  }),
  'linux-x64': Object.freeze({
    version: '8.30.1',
    url: 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz',
    sha256: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'
  })
});

const RULE = 'liftoff-nonfunctional-fixture';
const SENTINEL = 'LIFTOFF_NONFUNCTIONAL_FIXTURE_000000000000000000000000';
const FILE = 'fixture.txt';
const CONFIG = `title = "Nonfunctional fixture qualification only"
[[rules]]
id = "${RULE}"
description = "Nonfunctional synthetic fixture only"
regex = '''LIFTOFF_NONFUNCTIONAL_FIXTURE_[0-9]{24}'''
`;
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const MAX_REPORT = 65_536;
const MAX_ARCHIVE = 16_777_216;
const MAX_BINARY = 67_108_864;
type Failure = 'unsupported-platform' | 'invalid-input' | 'workspace-changed' | 'cleanup-failed'
  | 'download-failed' | 'checksum-mismatch' | 'process-failed' | 'timeout'
  | 'unsafe-stderr' | 'output-limit' | 'invalid-report' | 'unexpected-findings' | 'fixture-incomplete'
  | 'candidate-suppression' | 'scan-input-changed';

export class FixtureError extends Error {
  readonly code: Failure;

  constructor(code: Failure) {
    super(`Gitleaks fixture rejected: ${code}.`);
    this.code = code;
    this.name = 'GitleaksFixtureError';
  }
}
function fail(code: Failure): never { throw new FixtureError(code); }
async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error: unknown) {
    if (error instanceof FixtureError) throw error;
    return fail('process-failed');
  }
}
function safePath(value: string): string {
  if (!path.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) fail('invalid-input');
  return value;
}
function commit(value: string): string {
  if (!/^[a-f0-9]{40}$/.test(value)) fail('invalid-input');
  return value;
}

/** A new root is registered by inode + owner marker, never by a filename glob. */
async function workspace(worktree: string, owner: 'gitleaks' | 'checkov' | 'gitleaks-source' | 'npm-runtime', scratchParent = tmpdir()) {
  if (!['gitleaks', 'checkov', 'gitleaks-source', 'npm-runtime'].includes(owner)) fail('invalid-input');
  const project = await realpath(safePath(worktree));
  if (project !== await realpath(process.cwd())) fail('invalid-input');
  const parent = await realpath(safePath(scratchParent));
  const relative = path.relative(project, parent);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) ||
      !(await lstat(parent)).isDirectory()) fail('invalid-input');
  const root = await mkdtemp(path.join(parent, `${owner}-fixture-`));
  await chmod(root, 0o700);
  const rootStat = await lstat(root);
  const marker = randomUUID();
  await writeFile(path.join(root, '.fixture-owner'), marker, { flag: 'wx', mode: 0o600 });
  let registered = new Map<string, { ino: number; directory: boolean }>();
  let closed = false;
  const sourceAssessment = owner === 'gitleaks-source' || owner === 'npm-runtime';
  async function snapshot() {
    const status = await lstat(root);
    if (closed || status.isSymbolicLink() || !status.isDirectory() || status.ino !== rootStat.ino
      || status.dev !== rootStat.dev) fail('workspace-changed');
    const markerStatus = await lstat(path.join(root, '.fixture-owner'));
    if (markerStatus.isSymbolicLink() || !markerStatus.isFile()
      || await readFile(path.join(root, '.fixture-owner'), 'utf8') !== marker) fail('workspace-changed');
    const result = new Map<string, { ino: number; directory: boolean }>();
    let bytes = 0;
    async function walk(relative: string, depth: number) {
      if (depth > (sourceAssessment ? 40 : 12)) fail('workspace-changed');
      for (const entry of await readdir(path.join(root, relative))) {
        const logical = path.join(relative, entry);
        const stat = await lstat(path.join(root, logical));
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) ||
            result.size >= (sourceAssessment ? 20_000 : 1_024)) fail('workspace-changed');
        bytes += stat.isFile() ? stat.size : 0;
        if (bytes > (sourceAssessment ? 256 * 1024 * 1024 : MAX_BINARY + MAX_ARCHIVE + 1_048_576)) fail('workspace-changed');
        result.set(logical, { ino: stat.ino, directory: stat.isDirectory() });
        if (stat.isDirectory()) await walk(logical, depth + 1);
      }
    }
    await walk('', 0);
    return result;
  }
  async function register() { registered = await snapshot(); }
  await register();
  return {
    root,
    async directory(name: string) {
      if (!/^[a-z][a-z-]*$/.test(name)) fail('invalid-input');
      const target = path.join(root, name);
      await mkdir(target, { mode: 0o700 });
      await register();
      return target;
    },
    async write(name: string, content: string | Uint8Array, executable = false) {
      if (!/^[a-z][a-z0-9.-]*$/.test(name)) fail('invalid-input');
      const target = path.join(root, name);
      await writeFile(target, content, { flag: 'wx', mode: executable ? 0o700 : 0o600 });
      await register();
      return target;
    },
    register,
    async check() {
      const live = await snapshot();
      if (live.size !== registered.size || [...live].some(([key, value]) => {
        const known = registered.get(key);
        return !known || known.ino !== value.ino || known.directory !== value.directory;
      })) fail('workspace-changed');
    },
    async cleanup() {
      try {
        const live = await snapshot();
        if (live.size !== registered.size || [...live].some(([key, value]) => {
          const known = registered.get(key);
          return !known || known.ino !== value.ino || known.directory !== value.directory;
        })) fail('workspace-changed');
        const files = [...registered].filter(([, value]) => !value.directory).map(([key]) => key);
        const dirs = [...registered].filter(([, value]) => value.directory).map(([key]) => key);
        for (const name of files.filter(name => name !== '.fixture-owner')) await unlink(path.join(root, name));
        for (const name of dirs.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)) await rmdir(path.join(root, name));
        await unlink(path.join(root, '.fixture-owner'));
        await rmdir(root);
        closed = true;
      } catch { fail('cleanup-failed'); }
    }
  };
}
export type PrivateFixtureWorkspace = Awaited<ReturnType<typeof workspace>>;
type Workspace = PrivateFixtureWorkspace;

/** No inherited environment is spread in: in particular no Git object overrides. */
export function fixtureGitEnvironment(root: string, wrapperDirectory: string): NodeJS.ProcessEnv {
  safePath(root);
  safePath(wrapperDirectory);
  return {
    PATH: `${wrapperDirectory}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'home'),
    TMPDIR: path.join(root, 'scratch'), TMP: path.join(root, 'scratch'), TEMP: path.join(root, 'scratch'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty'),
    GIT_CONFIG_SYSTEM: path.join(root, 'empty'), GIT_TERMINAL_PROMPT: '0',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0', GIT_CEILING_DIRECTORIES: root,
    GIT_AUTHOR_NAME: 'Liftoff Fixture', GIT_COMMITTER_NAME: 'Liftoff Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@invalid.example', GIT_COMMITTER_EMAIL: 'fixture@invalid.example',
    GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    LC_ALL: 'C', LANG: 'C', TZ: 'UTC'
  };
}

export function fixtureGitOptions(root: string): string[] {
  safePath(root);
  return [
    '-c', `core.hooksPath=${path.join(root, 'empty-directory')}`,
    '-c', `init.templateDir=${path.join(root, 'empty-directory')}`,
    '-c', `core.attributesFile=${path.join(root, 'empty')}`,
    '-c', `core.excludesFile=${path.join(root, 'empty')}`,
    '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false',
    '-c', 'credential.helper=', '-c', 'credential.interactive=false', '-c', 'core.askPass=',
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'protocol.allow=never',
    '-c', 'protocol.file.allow=never', '-c', 'diff.external=', '-c', 'core.pager=cat'
  ];
}

async function initialize(worktree: string, owner: 'gitleaks' | 'checkov' | 'gitleaks-source' | 'npm-runtime' = 'gitleaks', scratchParent = tmpdir()) {
  const owned = await workspace(worktree, owner, scratchParent);
  try {
    for (const name of ['home', 'scratch', 'empty-directory', 'bin']) await owned.directory(name);
    await owned.write('empty', '');
    return owned;
  } catch {
    await owned.register();
    await owned.cleanup();
    return fail('workspace-changed');
  }
}

/** Shared only by the two fixture adapters; it never opens an existing checkout. */
export function createPrivateFixtureWorkspace(worktree: string, owner: 'gitleaks' | 'checkov' = 'gitleaks', scratchParent = tmpdir()) {
  return initialize(worktree, owner, scratchParent);
}

/** A separate non-fixture owner for explicitly inventoried source assessment. */
export function createPrivateSourceWorkspace(worktree: string, scratchParent: string) {
  return initialize(worktree, 'gitleaks-source', scratchParent);
}

export function createPrivatePackageWorkspace(worktree: string, scratchParent: string) {
  return initialize(worktree, 'npm-runtime', scratchParent);
}

export function parseGitObjectStoreMetadata(stdout: Uint8Array, stderr: Uint8Array) {
  if (stdout.byteLength > 65_536 || stderr.byteLength > 65_536) fail('unsafe-stderr');
  const keys = ['count', 'size', 'in-pack', 'packs', 'size-pack', 'prune-packable', 'garbage', 'size-garbage'];
  const counts = new Map<string, number>();
  let output: string, errors: string;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    output = decoder.decode(stdout); errors = decoder.decode(stderr);
  } catch { return fail('unsafe-stderr'); }
  for (const line of output.trim().split(/\r?\n/)) {
    const match = /^([a-z-]+): ([0-9]+)$/.exec(line), count = Number(match?.[2]);
    if (!match || !keys.includes(match[1]!) || counts.has(match[1]!) || !Number.isSafeInteger(count)) fail('unsafe-stderr');
    counts.set(match[1]!, count);
  }
  const warnings = errors.trim().split(/\r?\n/).filter(Boolean);
  if (counts.size !== keys.length || warnings.length !== counts.get('garbage') ||
      warnings.some(line => !/^warning: garbage found: [^\r\n\0]+$/.test(line))) fail('unsafe-stderr');
  return { garbageEntries: counts.get('garbage')!, garbageWarnings: warnings.length, alternateObjectStores: false };
}

interface QuietOutput {
  exitCode: number; stdout: Buffer;
  objectStoreMetadata?: ReturnType<typeof parseGitObjectStoreMetadata>;
}
async function quiet(
  executable: string, args: readonly string[], owned: Workspace,
  options: {
    timeoutMs?: number; maxBytes?: number; cwd?: string; environment?: NodeJS.ProcessEnv; input?: Uint8Array;
    objectStoreMetadata?: true;
  } = {}
): Promise<QuietOutput> {
  if (options.objectStoreMetadata && (executable !== '/usr/bin/git' ||
      JSON.stringify(args.slice(-2)) !== JSON.stringify(['count-objects', '-v']))) fail('invalid-input');
  await owned.check();
  return new Promise((resolve, reject) => {
    let failure: Failure | undefined;
    let size = 0;
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    let errorSize = 0;
    const child = spawn(executable, [...args], {
      cwd: options.cwd ?? owned.root,
      env: options.environment ?? fixtureGitEnvironment(owned.root, path.join(owned.root, 'bin')),
      stdio: ['pipe', 'pipe', 'pipe'], shell: false
    });
    const stop = (code: Failure) => {
      failure ??= code;
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
      for (const chunk of errorChunks) chunk.fill(0);
      errorChunks.length = 0;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > (options.maxBytes ?? MAX_REPORT)) { chunk.fill(0); stop('output-limit'); return; }
      if (!failure) chunks.push(Buffer.from(chunk));
      chunk.fill(0);
    });
    // Scanner stderr is always fatal. Only the exact read-only Git metadata
    // command may project matched garbage warnings to path-free counts.
    child.stderr.on('data', (chunk: Buffer) => {
      errorSize += chunk.length;
      if (options.objectStoreMetadata && errorSize <= 65_536 && !failure) {
        errorChunks.push(Buffer.from(chunk)); chunk.fill(0);
      } else { chunk.fill(0); stop('unsafe-stderr'); }
    });
    child.on('error', () => { failure ??= 'process-failed'; });
    child.stdin.on('error', () => { failure ??= 'process-failed'; });
    child.stdin.end(options.input);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal || code === null) failure ??= 'process-failed';
      if (failure || code === null) {
        for (const chunk of chunks) chunk.fill(0);
        for (const chunk of errorChunks) chunk.fill(0);
        reject(new FixtureError(failure ?? 'process-failed'));
      } else {
        const stdout = Buffer.concat(chunks);
        for (const chunk of chunks) chunk.fill(0);
        const errors = Buffer.concat(errorChunks);
        for (const chunk of errorChunks) chunk.fill(0);
        try {
          if (options.objectStoreMetadata && code !== 0) fail('process-failed');
          const metadata = options.objectStoreMetadata ? parseGitObjectStoreMetadata(stdout, errors) : undefined;
          resolve({ exitCode: code, stdout, ...(metadata ? { objectStoreMetadata: metadata } : {}) });
        } catch (error) {
          stdout.fill(0);
          reject(error instanceof FixtureError ? error : new FixtureError('process-failed'));
        } finally { errors.fill(0); }
      }
    });
  });
}

/** Caller supplies a trusted allowlisted environment; outputs are never logged. */
export const capturePrivateFixtureProcess = quiet;

export interface FixtureFinding {
  readonly commitIndex: number; readonly line: number; readonly column: number;
  readonly endLine: number; readonly endColumn: number;
}

/**
 * Report template emits ONLY integers. No scanner-controlled string (including
 * path, rule, commit, author, match, excerpt or message) is ever interpolated.
 */
export function fixtureMetadataTemplate(commits: readonly string[], exactFile: string): string {
  if (commits.length < 1 || commits.length > 3 || new Set(commits).size !== commits.length) fail('invalid-input');
  commits.forEach(commit);
  safePath(exactFile);
  const commitCases = commits.map((sha, index) => `{{if eq .Commit "${sha}"}}${index}{{else}}`).join('');
  const commitEnds = '{{end}}'.repeat(commits.length);
  return `[{{range $index, $finding := .}}{{if $index}},{{end}}[` +
    `{{if eq .RuleID "${RULE}"}}0{{else}}-1{{end}},` +
    `{{if or (eq .File "${FILE}") (eq .File ${JSON.stringify(exactFile)})}}0{{else}}-1{{end}},` +
    `${commitCases}-1${commitEnds},` +
    `{{.StartLine}},{{.StartColumn}},{{.EndLine}},{{.EndColumn}},` +
    `{{if eq .Secret "REDACTED"}}1{{else}}0{{end}}]{{end}}]\n`;
}

export function parseGitleaksFixtureOutput(stdout: Uint8Array, exitCode: number, commitCount: number): readonly FixtureFinding[] {
  if (!(stdout instanceof Uint8Array) || stdout.byteLength === 0 || stdout.byteLength > MAX_REPORT
    || !Number.isSafeInteger(commitCount) || commitCount < 1 || commitCount > 3) fail('invalid-report');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout)); } catch { return fail('invalid-report'); }
  if (!Array.isArray(parsed) || parsed.length > 8 || (exitCode !== 0 && exitCode !== 42)
    || (exitCode === 0) !== (parsed.length === 0)) fail('invalid-report');
  const seen = new Set<string>();
  const result = parsed.map((entry: unknown) => {
    if (!Array.isArray(entry) || entry.length !== 8 || !entry.every((n: unknown) => typeof n === 'number'
      && Number.isSafeInteger(n) && n >= 0 && n <= 10_000_000)) fail('invalid-report');
    const [rule, file, revision, line, column, endLine, endColumn, redacted]: unknown[] = entry;
    if (rule !== 0 || file !== 0 || redacted !== 1 || typeof revision !== 'number' || revision >= commitCount
      || typeof line !== 'number' || line < 1 || typeof column !== 'number' || column < 1
      || typeof endLine !== 'number' || endLine < line || typeof endColumn !== 'number' || endColumn < 1
      || (endLine === line && endColumn < column)) fail('invalid-report');
    const key = JSON.stringify(entry);
    if (seen.has(key)) fail('invalid-report');
    seen.add(key);
    return Object.freeze({ commitIndex: revision, line, column, endLine, endColumn });
  });
  return Object.freeze(result);
}

/** Real child-process leak tests, without a detector, Git repository or network. */
export async function qualifyFixtureOutputProbe(worktree: string, kind: 'stdout' | 'stderr' | 'oversize' | 'timeout' | 'failure'): Promise<void> {
  return guarded(async () => {
    const owned = await initialize(worktree);
    const scripts = {
      stdout: `process.stdout.write("${SENTINEL}")`,
      stderr: `process.stderr.write("${SENTINEL}")`,
      oversize: 'process.stdout.write("x".repeat(70000))',
      timeout: 'setInterval(()=>{},1000)',
      failure: 'process.exit(2)'
    };
    try {
      const output = await quiet(process.execPath, ['-e', scripts[kind]], owned, { timeoutMs: kind === 'timeout' ? 100 : 5_000 });
      try { parseGitleaksFixtureOutput(output.stdout, output.exitCode, 1); } finally { output.stdout.fill(0); }
    } finally { await owned.register(); await owned.cleanup(); }
  });
}

export interface PinnedFixtureTool {
  readonly version: '8.30.1';
  readonly platform: 'darwin-arm64' | 'linux-x64';
  readonly archiveDigest: string;
  readonly binaryDigest: string;
  cleanup(): Promise<void>;
}
const installed = new WeakMap<PinnedFixtureTool, { owned: Workspace; binary: string }>();

/** Shared fixture adapters still require an installer-issued, digest-bound tool. */
export async function capturePinnedFixtureGitleaks(
  tool: PinnedFixtureTool, args: readonly string[], owned: PrivateFixtureWorkspace,
  options: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<QuietOutput> {
  return guarded(async () => {
    const installation = installed.get(tool);
    if (!installation) fail('invalid-input');
    await installation.owned.check();
    if (sha256(await readFile(installation.binary)) !== tool.binaryDigest) fail('checksum-mismatch');
    return quiet(installation.binary, args, owned, options);
  });
}

interface FixtureScanControls {
  source: string;
  configuration: { path: string; contents: string };
  template: { path: string; contents: string };
  history?: { base: string; head: string };
}

/** Reject controls at the actual invocation, including files added after registration. */
export async function captureSuppressionFreeFixtureGitleaks(
  tool: PinnedFixtureTool, owned: PrivateFixtureWorkspace, controls: FixtureScanControls
): Promise<QuietOutput> {
  return guarded(async () => {
    const within = (target: string) => {
      safePath(target);
      const relative = path.relative(owned.root, target);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('invalid-input');
      return target;
    };
    const source = within(controls.source);
    within(controls.configuration.path);
    within(controls.template.path);
    if (controls.history && path.basename(source) !== '.git') fail('invalid-input');
    if (controls.history) { commit(controls.history.base); commit(controls.history.head); }
    const snapshot = async () => {
      await owned.check();
      if ((await readdir(owned.root)).some(name => name.toLowerCase() === '.gitleaksignore')) fail('candidate-suppression');
      if ((await lstat(source)).isFile() &&
          (await readdir(path.dirname(source))).some(name => name.toLowerCase() === '.gitleaksignore')) fail('candidate-suppression');
      if (await readFile(controls.configuration.path, 'utf8') !== controls.configuration.contents ||
          await readFile(controls.template.path, 'utf8') !== controls.template.contents) fail('checksum-mismatch');
      const entries: string[] = [];
      let size = 0;
      async function visit(file: string, depth: number) {
        if (depth > 12 || entries.length > 1024) fail('fixture-incomplete');
        const status = await lstat(file);
        if (status.isSymbolicLink() || await realpath(file) !== file) fail('invalid-input');
        if (path.basename(file).toLowerCase() === '.gitleaksignore') fail('candidate-suppression');
        if (status.isDirectory()) {
          for (const name of (await readdir(file)).sort()) await visit(path.join(file, name), depth + 1);
        } else if (status.isFile()) {
          size += status.size;
          if (size > MAX_BINARY) fail('fixture-incomplete');
          entries.push(JSON.stringify([path.relative(owned.root, file), status.ino, status.mode, sha256(await readFile(file))]));
        } else fail('invalid-input');
      }
      await visit(source, 0);
      if (!entries.length) fail('fixture-incomplete');
      return sha256(entries.join('\n'));
    };
    const before = await snapshot();
    const selection = controls.history
      ? ['git', '--platform=none', `--log-opts=${controls.history.base}..${controls.history.head} --no-ext-diff --no-textconv --no-renames`, source]
      : ['dir', source];
    const output = await capturePinnedFixtureGitleaks(tool, [...selection,
      '--config', controls.configuration.path, '--report-template', controls.template.path,
      '--report-format', 'template', '--report-path', '-', '--redact=100', '--no-banner', '--no-color',
      '--log-level=error', '--exit-code=42', '--ignore-gitleaks-allow', '--max-decode-depth=0',
      '--max-archive-depth=0', '--timeout=15', '--gitleaks-ignore-path', path.join(owned.root, 'empty-directory')
    ], owned);
    try {
      if (await snapshot() !== before) fail('scan-input-changed');
      return output;
    } catch (error) {
      output.stdout.fill(0);
      throw error;
    }
  });
}

/** Creates only a new synthetic repository with isolated per-command controls. */
export async function createPrivateFixtureGit(owned: PrivateFixtureWorkspace, executable: string) {
  const gitBinary = await realpath(safePath(executable));
  if (!(await lstat(gitBinary)).isFile()) fail('invalid-input');
  const repo = await owned.directory('repository');
  const quote = (s: string) => `'${s.replaceAll("'", "'\"'\"'")}'`;
  const wrapper = `#!/bin/sh\nexec ${[gitBinary, ...fixtureGitOptions(owned.root)].map(quote).join(' ')} "$@"\n`;
  await writeFile(path.join(owned.root, 'bin', 'git'), wrapper, { flag: 'wx', mode: 0o700 });
  await owned.register();
  const git = async (args: readonly string[]) => {
    try {
      const result = await quiet(path.join(owned.root, 'bin', 'git'), ['-C', repo, ...args], owned, { cwd: repo });
      if (result.exitCode !== 0) { result.stdout.fill(0); fail('process-failed'); }
      const output = result.stdout.toString('utf8');
      result.stdout.fill(0);
      return output;
    } finally { await owned.register(); }
  };
  await git(['init', '--quiet', '--object-format=sha1', '--initial-branch=fixture-only', `--template=${path.join(owned.root, 'empty-directory')}`]);
  return { root: repo, git };
}

async function download(url: string, target: string) {
  let current = new URL(url);
  const timeout = AbortSignal.timeout(60_000);
  try {
    for (let redirect = 0; redirect < 5; redirect++) {
      if (current.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com'].includes(current.hostname)
        || current.username || current.password) fail('download-failed');
      const response = await fetch(current, { redirect: 'manual', signal: timeout, credentials: 'omit' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) fail('download-failed');
        current = new URL(location, current);
        continue;
      }
      if (!response.ok || !response.body) fail('download-failed');
      const file = await open(target, 'wx', 0o600);
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > MAX_ARCHIVE) fail('download-failed');
          await file.writeFile(chunk);
        }
      } finally { await file.close(); }
      return;
    }
  } catch { return fail('download-failed'); }
  fail('download-failed');
}

/** Explicit authorized install, never invoked by import or ordinary unit tests. */
export async function installPinnedFixtureGitleaks(worktree: string, scratchParent?: string): Promise<PinnedFixtureTool> {
  return guarded(async () => {
    const platform = `${process.platform}-${process.arch}`;
    if (platform !== 'darwin-arm64' && platform !== 'linux-x64') fail('unsupported-platform');
    const pin = GITLEAKS_FIXTURE_PINS[platform];
    const owned = await initialize(worktree, 'gitleaks', scratchParent);
    try {
      const archive = path.join(owned.root, 'gitleaks.tar.gz');
      await download(pin.url, archive);
      await owned.register();
      if (sha256(await readFile(archive)) !== pin.sha256) fail('checksum-mismatch');
      const extracted = await quiet('/usr/bin/tar', ['-xOf', archive, 'gitleaks'], owned, { maxBytes: MAX_BINARY });
      if (extracted.exitCode !== 0 || extracted.stdout.byteLength === 0) fail('process-failed');
      const binaryDigest = sha256(extracted.stdout);
      const binary = await owned.write('gitleaks', extracted.stdout, true);
      extracted.stdout.fill(0);
      const version = await quiet(binary, ['version'], owned);
      const expectedVersion = Buffer.from('8.30.1\n');
      if (version.exitCode !== 0 || !version.stdout.equals(expectedVersion)) fail('process-failed');
      version.stdout.fill(0);
      const tool: PinnedFixtureTool = Object.freeze({
        version: '8.30.1', platform, archiveDigest: pin.sha256, binaryDigest,
        async cleanup() { await owned.cleanup(); installed.delete(tool); }
      });
      installed.set(tool, { owned, binary });
      return tool;
    } catch (error: unknown) {
      await owned.register();
      await owned.cleanup();
      throw error;
    }
  });
}

export interface GitleaksFixtureEvidence {
  readonly scope: 'new-disposable-synthetic-repository-only';
  readonly operationalRepositoryScanned: false;
  readonly nativePushOrForkProof: false;
  readonly defaultProviderRulesQualified: false;
  readonly scannerVersion: '8.30.1';
  readonly platform: 'darwin-arm64' | 'linux-x64';
  readonly archiveDigest: string;
  readonly binaryDigest: string;
  readonly configDigest: string;
  readonly templateDigest: string;
  readonly observedAt: string;
  readonly completedAt: string;
  readonly currentTreeFindingCount: 0;
  readonly introducedHistoryFindingCount: 1;
  readonly fixtureCommits: readonly string[];
  readonly result: SecretResult;
  readonly cleanup: 'completed';
}

/**
 * Only the handle issued by the pinned installer is accepted. Every input file,
 * Git object and commit is constructed here, never copied from the worktree.
 */
export async function qualifyGitleaksFixture(tool: PinnedFixtureTool, worktree: string, gitExecutable: string): Promise<GitleaksFixtureEvidence> {
  return guarded(async () => {
    const installation = installed.get(tool);
    if (!installation) fail('invalid-input');
    await installation.owned.check();
    if (sha256(await readFile(installation.binary)) !== tool.binaryDigest) fail('checksum-mismatch');
    const owned = await initialize(worktree);
    try {
      const { root: repo, git } = await createPrivateFixtureGit(owned, gitExecutable);
      const tree = await owned.directory('tree');
      const makeCommit = async (content: string, message: string) => {
        await writeFile(path.join(repo, FILE), content, { mode: 0o600 });
        await owned.register();
        await git(['add', '--', FILE]);
        await git(['commit', '--quiet', '--no-gpg-sign', '-m', message]);
        return commit((await git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim());
      };
      const base = await makeCommit('nonfunctional fixture base\n', 'fixture-base');
      const introduced = await makeCommit(`${SENTINEL}\n`, 'fixture-introduced');
      const head = await makeCommit('nonfunctional fixture removed\n', 'fixture-removed');
      if (await git(['rev-parse', '--show-toplevel']) !== `${repo}\n`
        || await git(['rev-parse', '--is-shallow-repository']) !== 'false\n'
        || await git(['remote']) !== ''
        || await git(['ls-files', '-z']) !== `${FILE}\0`
        || await git(['rev-list', '--reverse', `${base}..${head}`]) !== `${introduced}\n${head}\n`) fail('fixture-incomplete');
      await git(['fsck', '--strict', '--no-progress']);
      const current = await git(['show', `${head}:${FILE}`]);
      if (current !== 'nonfunctional fixture removed\n') fail('fixture-incomplete');
      const exactFile = path.join(tree, FILE);
      await writeFile(exactFile, current, { flag: 'wx', mode: 0o600 });
      await owned.register();
      const commits = [introduced, head];
      const template = fixtureMetadataTemplate(commits, exactFile);
      const templateFile = await owned.write('metadata.tmpl', template);
      const configFile = await owned.write('detector.toml', CONFIG);
      const options = ['--config', configFile, '--report-template', templateFile, '--report-format', 'template',
        '--report-path', '-', '--redact=100', '--no-banner', '--no-color', '--log-level=error',
        '--exit-code=42', '--ignore-gitleaks-allow', '--max-decode-depth=0', '--max-archive-depth=0', '--timeout=15'];
      const observedAt = new Date().toISOString();
      const scan = async (args: readonly string[]) => {
        if (await readFile(configFile, 'utf8') !== CONFIG || await readFile(templateFile, 'utf8') !== template
          || sha256(await readFile(installation.binary)) !== tool.binaryDigest) fail('checksum-mismatch');
        const output = await quiet(installation.binary, [...args, ...options], owned);
        try {
          if (await readFile(configFile, 'utf8') !== CONFIG || await readFile(templateFile, 'utf8') !== template) fail('checksum-mismatch');
          return parseGitleaksFixtureOutput(output.stdout, output.exitCode, commits.length);
        } finally { output.stdout.fill(0); }
      };
      const clean = await scan(['dir', exactFile]);
      const detected = await scan(['git', '--platform=none', `--log-opts=${base}..${head} --no-ext-diff --no-textconv --no-renames`, repo]);
      if (clean.length !== 0 || detected.length !== 1 || detected[0]?.commitIndex !== 0) fail('unexpected-findings');
      const finishedAt = new Date().toISOString();
      const basePolicyDigest = sha256('fixture-only governing policy; no operational approval');
      const policy = {
        schemaVersion: 1, repository: 'fixture/isolated', basePolicyCommit: base, basePolicyDigest,
        detector: { name: 'gitleaks', version: tool.version, binaryDigest: tool.binaryDigest, configDigest: sha256(CONFIG) },
        rules: [RULE], exclusions: [], dispositions: []
      };
      const policyJson = JSON.stringify(policy);
      const identity = {
        repository: 'fixture/isolated', event: 'pull_request', ref: 'refs/heads/fixture-only',
        sourceCommit: head, baseCommit: base, workflowCommit: base, runId: 1, attempt: 1,
        basePolicyCommit: base, basePolicyDigest, inventoryDigest: sha256(JSON.stringify({ commits, file: FILE }))
      };
      const scopes = [
        { id: 'current-tree', kind: 'current-tree', ref: identity.ref, revision: head, baseRevision: null, commits: [head] },
        { id: 'introduced-history', kind: 'introduced-history', ref: identity.ref, revision: head, baseRevision: base, commits }
      ];
      const context = {
        schemaVersion: 1, identity, mode: 'intake', observedAt, now: finishedAt, maxAgeSeconds: 3_600,
        policyDigest: sha256(policyJson), scopes, locations: [[FILE]]
      };
      const report = {
        schemaVersion: 1, identity, policyDigest: context.policyDigest, detector: policy.detector,
        observedAt, startedAt: observedAt, completedAt: finishedAt,
        coverage: scopes.map(scope => ({
          id: scope.id, kind: scope.kind, ref: scope.ref, revision: scope.revision, baseRevision: scope.baseRevision,
          commitCount: scope.commits.length, commitsDigest: sha256(JSON.stringify([...scope.commits].sort())),
          status: 'complete', shallow: false, missingObjects: 0, skippedInputs: 0
        })),
        findingCount: detected.length,
        findings: detected.map(item => ({
          finding: { ruleId: RULE, pathParts: [FILE], line: item.line, column: item.column,
            endLine: item.endLine, endColumn: item.endColumn, commit: commits[item.commitIndex] },
          scopeIds: ['introduced-history'], currentSource: 'absent'
        }))
      };
      const boundary = createSecretsBoundary(JSON.stringify(context), policyJson);
      const result = boundary.assess({
        exitCode: 1, timedOut: false, signal: null, stdout: new Uint8Array(), stderr: new Uint8Array(),
        report: Buffer.from(JSON.stringify(report))
      });
      if (result.assessment !== 'qualified' || result.gate !== 'blocked' || result.counts.unresolved !== 1) fail('unexpected-findings');
      const evidence: GitleaksFixtureEvidence = Object.freeze({
        scope: 'new-disposable-synthetic-repository-only', operationalRepositoryScanned: false,
        nativePushOrForkProof: false, defaultProviderRulesQualified: false,
        scannerVersion: tool.version, platform: tool.platform, archiveDigest: tool.archiveDigest, binaryDigest: tool.binaryDigest,
        configDigest: sha256(CONFIG), templateDigest: sha256(template),
        observedAt, completedAt: finishedAt,
        currentTreeFindingCount: 0, introducedHistoryFindingCount: 1,
        fixtureCommits: Object.freeze([base, introduced, head]), result, cleanup: 'completed'
      });
      return evidence;
    } finally {
      await owned.register();
      await owned.cleanup();
    }
  });
}
