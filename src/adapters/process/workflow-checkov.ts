import { access, lstat, opendir, readlink, realpath, writeFile } from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { freezeModernValue } from '../../domain/governance/activation/modern-graph.js';
import { applicationSearchEnvironment } from '../../application/repair/application-environment.js';
import { toolFile } from '../../application/repair/application-toolchain.js';
import { applicationWithin } from '../../application/repair/application-files.js';
import { readBoundProjectFileDigest, readBoundProjectFileSnapshot } from '../filesystem/bound-project-files.js';
import { assertWorkspaceDirectorySnapshot, captureWorkspaceDirectoryChain } from '../filesystem/repair-workspaces.js';
import { NodeCommandRunner, type CommandResult } from '../../process-runner.js';

const version = '3.3.20';
const pythonProbe = 'import json,sys;print(json.dumps({"version":list(sys.version_info[:3]),"path":sys.path,"prefix":sys.prefix,"basePrefix":sys.base_prefix}))';
const bootstrap = 'import json,runpy,sys;sys.path[:]=json.loads(sys.argv[1]);sys.argv=sys.argv[2:];runpy.run_path(sys.argv[0],run_name="__main__")';
const limits = Object.freeze({ roots: 32, files: 32768, directories: 8192, links: 128,
  depth: 32, bytes: 512 * 1024 * 1024, fileBytes: 64 * 1024 * 1024 });
const frameworks = ['terraform', 'dockerfile', 'github_actions'] as const;
export type WorkflowCheckovFramework = typeof frameworks[number];

export class WorkflowCheckovRefusal extends Error {}
function refuse(message: string): never { throw new WorkflowCheckovRefusal(message); }
const diagnostics = { pathLabel: 'installed Checkov program', invalid: refuse };

async function text(root: string, parts: readonly string[], maximumBytes: number): Promise<string> {
  const file = await readBoundProjectFileSnapshot(root, parts, { maximumBytes, linkPolicy: 'single-link', diagnostics });
  if (!file.content) refuse('A required scanner program declaration is missing.');
  const value = file.content.toString('utf8');
  if (!Buffer.from(value).equals(file.content)) refuse('A scanner declaration is not complete UTF-8 text.');
  return value;
}

function json(text: string): unknown {
  try { return JSON.parse(text); } catch { return refuse('The actual Checkov process did not return one complete JSON report.'); }
}
function complete(result: CommandResult): boolean {
  return result.processSpawned === true && result.processTreeSettled === true && result.signal === null &&
    !result.timedOut && !result.outputLimitExceeded && !result.aborted && !result.errorCode;
}
function absent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
function physical(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
function safeAbsolute(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value);
}
/** Read the generated launcher as data; no shell trampoline is ever executed. */
export function readWorkflowCheckovPythonLauncher(source: string): string {
  const direct = /^#!(\/[^\s\r\n]+)\r?\n/u.exec(source);
  const trampoline = /^#!\/bin\/sh\n'''exec' '([^'\r\n]+)' "\$0" "\$@"\n' '''\n/u.exec(source);
  const interpreter = trampoline?.[1] ?? direct?.[1];
  if (!safeAbsolute(interpreter) || !/^python(?:3(?:\.14)?)?$/u.test(path.basename(interpreter))) {
    refuse('The scanner requires a literal installed Python launcher; env, arbitrary shells and wrapper commands are unsupported.');
  }
  return interpreter;
}
/** Conservative scope refusal, not a Terraform parser or module/evaluation qualification. */
export function assertWorkflowCheckovLiteralScope(sources: readonly string[]): void {
  if (!sources.length || sources.some(source => /\bmodule\b|[A-Za-z_][A-Za-z0-9_-]*\s*\(/u.test(source))) {
    refuse('Module references and function expressions require separately observed input/evaluation closure; the private literal-file scanner cannot follow or omit them.');
  }
}
async function namesIn(directory: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of await opendir(directory, { bufferSize: 32 })) {
    if (names.length >= limits.files + limits.directories + limits.links) refuse('The scanner directory member inventory exceeds its fixed bound.');
    names.push(entry.name);
  }
  return names.sort();
}

/** A declared root beneath a traversal skip needs its own inventory. */
export function workflowCheckovInventoryRoots(roots: readonly string[]): readonly string[] {
  return roots.filter((root, index) => !roots.some((parent, parentIndex) =>
    parentIndex !== index && parent !== root && applicationWithin(parent, root) &&
    path.relative(parent, root).split(path.sep)[0] !== 'site-packages'));
}

/** Protocol checking only: a caller-supplied JSON report is never execution or proof authority. */
export function checkWorkflowCheckovResult(
  result: CommandResult, selectedFiles: readonly string[], framework: WorkflowCheckovFramework = 'terraform'
): 'passed' | 'failed' {
  if (!frameworks.includes(framework)) refuse('The private scanner framework is unsupported.');
  if (!complete(result) || ![0, 1].includes(result.status ?? -1)) {
    refuse('The actual scanner did not finish with bounded output and its original process tree settled.');
  }
  const report = json(result.stdout);
  if (!isRecord(report) || report.check_type !== framework || !isRecord(report.results) ||
      !isRecord(report.summary) || report.summary.checkov_version !== version) {
    refuse(`A single ${framework === 'terraform' ? 'Terraform' : framework === 'dockerfile' ? 'Dockerfile' : 'GitHub Actions'} report from the supported observed Checkov development version is required.`);
  }
  const results = report.results, summary = report.summary;
  const passed = results.passed_checks, failed = results.failed_checks;
  const skipped = results.skipped_checks, errors = results.parsing_errors;
  if (!Array.isArray(passed) || !Array.isArray(failed) || !Array.isArray(skipped) || !Array.isArray(errors)) {
    refuse('The scanner result inventory is incomplete.');
  }
  if (skipped.length || errors.length || summary.skipped !== 0 || summary.parsing_errors !== 0 ||
      summary.passed !== passed.length || summary.failed !== failed.length ||
      typeof summary.resource_count !== 'number' || !Number.isSafeInteger(summary.resource_count) ||
      summary.resource_count < 0 || framework !== 'github_actions' && summary.resource_count === 0 ||
      passed.length + failed.length === 0) {
    refuse('Skipped, suppressed, unparsed, empty or inconsistent scanner coverage cannot pass or establish a controlled red.');
  }
  if (result.status !== (failed.length ? 1 : 0)) {
    refuse('The scanner exit status disagrees with its findings; soft-fail output is not success.');
  }
  if (!selectedFiles.length || new Set(selectedFiles).size !== selectedFiles.length ||
      selectedFiles.some(file => !safeAbsolute(file))) refuse('An exact nonempty scanner input inventory is required.');
  const files = new Set(selectedFiles), identities = new Set<string>(), resources = new Set<string>(), coveredFiles = new Set<string>();
  for (const [checks, expected] of [[passed, 'PASSED'], [failed, 'FAILED']] as const) {
    for (const check of checks) {
      if (!isRecord(check) || typeof check.check_id !== 'string' || !/^CKV(?:2)?_[A-Z0-9_]+$/u.test(check.check_id) ||
          !isRecord(check.check_result) || check.check_result.result !== expected ||
          !safeAbsolute(check.file_abs_path) || !files.has(check.file_abs_path) ||
          typeof check.resource !== 'string' || !check.resource || check.resource.length > 1024 ||
          !Array.isArray(check.file_line_range) || check.file_line_range.length !== 2 ||
          !check.file_line_range.every(line => Number.isSafeInteger(line) && line >= 0) ||
          check.file_line_range[0] === 0 && !(framework === 'github_actions' &&
            check.check_id === 'CKV_GHA_7' && /^on(?:\([^\u0000-\u001f\u007f]*\))?$/u.test(check.resource) &&
            check.file_line_range[1] === 1) ||
          check.file_line_range[0] > check.file_line_range[1]) {
        refuse('A scanner finding has missing, contradictory or out-of-scope source identity.');
      }
      if (framework === 'dockerfile' && (!/^CKV(?:2)?_DOCKER_[0-9]+$/u.test(check.check_id) ||
          !check.resource.startsWith(`${check.file_abs_path}.`) ||
          !/^(?:FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)?$/u
            .test(check.resource.slice(check.file_abs_path.length + 1)))) {
        refuse('A Dockerfile finding must identify its actual file and one supported instruction, not another framework or resource.');
      }
      if (framework === 'github_actions' && (!/^CKV(?:2)?_GHA_[0-9]+$/u.test(check.check_id) ||
          !/^(?:jobs(?:\([A-Za-z_][A-Za-z0-9_-]*\)(?:\.steps\[[1-9][0-9]*\](?:\([^\u0000-\u001f\u007f]*\))?)?)?|permissions|on(?:\([^\u0000-\u001f\u007f]*\))?)$/u.test(check.resource))) {
        refuse('A GitHub Actions finding must identify an actual workflow policy resource, not another framework or input kind.');
      }
      const resource = framework === 'dockerfile' ? check.file_abs_path : `${check.file_abs_path}\0${check.resource}`;
      const identity = framework !== 'terraform'
        ? `${resource}\0${check.resource}\0${check.check_id}\0${check.file_line_range.join(':')}`
        : `${resource}\0${check.check_id}`;
      if (identities.has(identity)) refuse('Duplicate scanner findings cannot inflate coverage.');
      identities.add(identity); resources.add(resource); coveredFiles.add(check.file_abs_path);
    }
  }
  // This version's Actions runner never populates Report.resources; findings, not that zero counter, cover files.
  if (framework === 'github_actions') {
    if (summary.resource_count !== 0 || coveredFiles.size !== files.size) {
      refuse('Every selected workflow must have actual nonempty findings and the supported Actions counter shape.');
    }
  } else if (resources.size !== summary.resource_count) refuse('The actual checked resource inventory is incomplete.');
  if (framework === 'dockerfile' && resources.size !== files.size) refuse('Every selected Dockerfile must have actual nonempty checked coverage.');
  return failed.length ? 'failed' : 'passed';
}

/** Explicit local runner effect. Not release/native qualification, a sandbox, or a prerequisite issuer. */
export class WorkflowCheckovInvocation {
  #runner = new NodeCommandRunner();
  #settled = true;
  #spawned = false;
  #used = false;
  #validationResult: CommandResult | null = null;
  #searchPath = process.env.PATH;
  private readonly files: readonly string[];
  constructor(
    private readonly projectRoot: string, private readonly home: string,
    files: readonly string[], private readonly deadline: number,
    private readonly framework: WorkflowCheckovFramework = 'terraform'
  ) {
    if (!frameworks.includes(framework)) refuse('The private scanner framework is unsupported.');
    this.files = Object.freeze([...files]);
    if (!Number.isFinite(deadline) || deadline > performance.now() + 180_000) refuse('A scanner invocation cannot extend its original bounded preparation/execution cutoff.');
    Object.freeze(this);
  }
  get processTreeSettled(): boolean { return this.#settled; }
  get processSpawned(): boolean { return this.#spawned; }
  get validationResult(): CommandResult | null { return this.#validationResult; }
  #remaining(): number {
    const remaining = Math.floor(this.deadline - performance.now());
    if (!Number.isFinite(remaining) || remaining <= 0) refuse('The original absolute scanner preparation/execution deadline expired.');
    return remaining;
  }
  async #run(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, metadata = false): Promise<CommandResult> {
    const timeoutMs = Math.min(metadata ? 15_000 : 180_000, this.#remaining());
    this.#settled = false;
    const result = await this.#runner.run({ executable, args: [...args] }, {
      cwd: this.home, env, timeoutMs, maxOutputBytes: metadata ? 65536 : 1024 * 1024,
      ensureProcessTreeSettled: true, stream: false
    });
    this.#spawned ||= result.processSpawned === true;
    this.#settled = result.processTreeSettled === true;
    if (!metadata) this.#validationResult = freezeModernValue(result);
    this.#remaining();
    return result;
  }
  async #external(supplied: string): Promise<string> {
    if (!safeAbsolute(supplied)) refuse('A bounded absolute installed program path is required.');
    const resolved = await realpath(supplied);
    if ([this.projectRoot, this.home].some(root => applicationWithin(root, resolved))) {
      refuse('Scanner programs and import roots cannot resolve into project or execution-HOME paths.');
    }
    return resolved;
  }
  async #launcher(): Promise<string> {
    const search = await applicationSearchEnvironment({ PATH: this.#searchPath }, this.projectRoot, this.home, this.home);
    const raw = search.PATH ?? '';
    if (Buffer.byteLength(raw) > 32768 || raw.split(path.delimiter).length > 256) refuse('The scanner search path exceeds its bound.');
    for (const directory of raw.split(path.delimiter)) {
      if (!directory || !path.isAbsolute(directory)) continue;
      const candidate = path.join(directory, 'checkov');
      try { await lstat(candidate); } catch (error) { if (absent(error)) continue; throw error; }
      await access(candidate, constants.X_OK);
      return this.#external(candidate);
    }
    return refuse('The actual installed Checkov scanner is unavailable; it was not installed or substituted.');
  }
  async #pathDeclarations(root: string): Promise<string[]> {
    const result = [root], pending = [root], seen = new Set<string>();
    while (pending.length) {
      const current = pending.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      if (seen.size > limits.roots) refuse('The explicit scanner import-root inventory exceeds its bound.');
      const names = await namesIn(current);
      for (const name of names.filter(name => name.endsWith('.pth'))) {
        for (const raw of (await text(current, [name], 65536)).split(/\r?\n/u)) {
          if (!raw || raw.startsWith('#')) continue;
          // Recognize the finite Homebrew path declaration; never execute a .pth hook.
          const match = /^import site; site\.addsitedir\('([^']+)'\)$/u.exec(raw);
          const declared = match ? match[1]! : raw.startsWith('import ') || raw.startsWith('import\t') ? null : raw;
          if (!declared || !safeAbsolute(declared)) refuse('Executable or relative Python path hooks are unsupported by the private scanner bootstrap.');
          const resolved = await this.#external(declared);
          if (path.basename(resolved) !== 'site-packages') refuse('Only declared installed site-packages roots can extend the isolated scanner import path.');
          if (!(await lstat(resolved)).isDirectory()) refuse('A declared scanner import root is not a directory.');
          if (!result.includes(resolved)) { result.push(resolved); pending.push(resolved); }
        }
      }
    }
    return result;
  }
  async #capture(roots: readonly string[], programPrefixes: readonly string[]): Promise<string> {
    let files = 0, directories = 0, links = 0, bytes = 0;
    const records: unknown[] = [], targets = new Set<string>();
    const fileGroup = async (members: readonly { root: string; parts: string[] }[]) => {
      this.#remaining();
      if (files + members.length > limits.files) refuse('The observed scanner program exceeds its fixed file bound.');
      const captured = await Promise.allSettled(members.map(({ root, parts }) =>
        readBoundProjectFileDigest(root, parts, { maximumBytes: limits.fileBytes, linkPolicy: 'single-link', diagnostics })));
      for (const [index, result] of captured.entries()) {
        if (result.status === 'rejected') throw result.reason;
        if (++files > limits.files || (bytes += result.value.bytes) > limits.bytes) refuse('The observed scanner program exceeds its fixed inventory bound.');
        records.push({ root: members[index]!.root, ...result.value });
      }
      this.#remaining();
    };
    const visit = async (root: string, parts: string[]) => {
      this.#remaining();
      if (++directories > limits.directories || parts.length > limits.depth) refuse('The observed scanner directory inventory exceeds its fixed bound.');
      const directory = path.join(root, ...parts), before = await lstat(directory, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) refuse('The observed scanner directory was replaced.');
      const names = await namesIn(directory);
      records.push({ root, parts, directory: physical(before), names });
      const pending: { root: string; parts: string[] }[] = [];
      const flush = async () => { if (pending.length) await fileGroup(pending.splice(0)); };
      for (const name of names) {
        // -S and the explicit bootstrap do not add a nested global site-packages root.
        if (!parts.length && name === 'site-packages') continue;
        const member = [...parts, name], target = path.join(root, ...member), stat = await lstat(target, { bigint: true });
        if (stat.isFile() && !stat.isSymbolicLink()) {
          pending.push({ root, parts: member });
          if (pending.length === 4) await flush();
          continue;
        }
        await flush();
        if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(root, member);
        else if (stat.isSymbolicLink()) {
          if (++links > limits.links) refuse('The observed scanner link inventory exceeds its bound.');
          const link = await readlink(target), resolved = await this.#external(target), actual = await lstat(resolved);
          if (!actual.isFile() || actual.isSymbolicLink()) refuse('Directory or non-file scanner links are unsupported.');
          if (!programPrefixes.some(prefix => applicationWithin(prefix, resolved))) {
            refuse('A scanner program link resolves outside the observed installed program prefixes.');
          }
          records.push({ root, member, link, resolved, physical: physical(stat) });
          if (!targets.has(resolved)) {
            targets.add(resolved); await fileGroup([{ root: path.dirname(resolved), parts: [path.basename(resolved)] }]);
          }
          if (await readlink(target) !== link || await realpath(target) !== resolved ||
              physical(await lstat(target, { bigint: true })) !== physical(stat)) refuse('A scanner program link changed.');
        } else refuse('A scanner program member is not an ordinary directory, file or bound file link.');
      }
      await flush();
      if (physical(await lstat(directory, { bigint: true })) !== physical(before) ||
          canonicalSha256(await namesIn(directory)) !== canonicalSha256(names)) refuse('The scanner directory membership changed.');
    };
    for (const root of workflowCheckovInventoryRoots(roots)) {
      const stat = await lstat(root);
      const boundary = await captureWorkspaceDirectoryChain(stat.isDirectory() ? root : path.dirname(root));
      await assertWorkspaceDirectorySnapshot(boundary);
      if (stat.isDirectory()) await visit(root, []); else await fileGroup([{ root: path.dirname(root), parts: [path.basename(root)] }]);
      await assertWorkspaceDirectorySnapshot(boundary);
    }
    this.#remaining();
    return canonicalSha256(records);
  }
  async execute(env: NodeJS.ProcessEnv): Promise<{ readonly result: CommandResult; readonly programDigest: string }> {
    if (this.#used) refuse('A private scanner invocation is single-use; observations or failures do not authorize replay.');
    this.#used = true;
    env = Object.freeze({ ...env });
    this.#remaining();
    if (await realpath(this.projectRoot) !== this.projectRoot || await realpath(this.home) !== this.home) {
      refuse('The actual project and execution HOME must be canonical paths.');
    }
    if (!this.files.length || this.files.some(file => !safeAbsolute(file) ||
        !applicationWithin(this.projectRoot, file) ||
        (this.framework === 'terraform' ? !file.endsWith('.tf') : this.framework === 'dockerfile'
          ? path.basename(file) !== 'Dockerfile'
          : !/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path.relative(this.projectRoot, file).split(path.sep).join('/'))))) {
      refuse('Only actual captured project files matching the selected finite scanner framework can enter the private scanner.');
    }
    const launcher = await this.#launcher();
    const launcherIdentity = await toolFile(launcher, this.projectRoot, this.home, false);
    const pythonAlias = readWorkflowCheckovPythonLauncher(await text(path.dirname(launcher), [path.basename(launcher)], 65536));
    const python = await this.#external(pythonAlias);
    const interpreterIdentity = await toolFile(python, this.projectRoot, this.home, true);
    const metadata = await this.#run(pythonAlias, ['-I', '-S', '-B', '-c', pythonProbe], env, true);
    if (!complete(metadata) || metadata.status !== 0) refuse('The installed isolated Python interpreter could not be observed.');
    const observed = json(metadata.stdout);
    if (!isRecord(observed) || !Array.isArray(observed.version) || observed.version.length !== 3 ||
        observed.version[0] !== 3 || observed.version[1] !== 14 || !Number.isSafeInteger(observed.version[2]) ||
        !safeAbsolute(observed.prefix) || !safeAbsolute(observed.basePrefix) || !Array.isArray(observed.path) || !observed.path.length ||
        observed.path.length > limits.roots || !observed.path.every(safeAbsolute)) {
      refuse('The private scanner requires an observed Python 3.14 isolated runtime, not an inferred release/native qualification.');
    }
    const prefix = await this.#external(observed.prefix);
    const basePrefix = await this.#external(observed.basePrefix);
    const configPath = path.join(prefix, 'pyvenv.cfg');
    const configuration = await toolFile(configPath, this.projectRoot, this.home, false);
    const siteAlias = path.join(prefix, 'lib', 'python3.14', 'site-packages');
    const site = await this.#external(siteAlias);
    const imported = await this.#pathDeclarations(site);
    const packageMetadata = await text(site, [`checkov-${version}.dist-info`, 'METADATA'], 256 * 1024);
    if (JSON.stringify([...packageMetadata.matchAll(/^Name: ([^\r\n]+)\r?$/gmu)].map(match => match[1])) !== '["checkov"]' ||
        JSON.stringify([...packageMetadata.matchAll(/^Version: ([^\r\n]+)\r?$/gmu)].map(match => match[1])) !== JSON.stringify([version])) {
      refuse('The observed development Checkov package identity is unsupported.');
    }
    const standard: string[] = [], missing: string[] = [];
    for (const name of observed.path) {
      const parent = await this.#external(path.dirname(name));
      if (!applicationWithin(basePrefix, path.join(parent, path.basename(name))) ||
          !['python3.14', 'lib-dynload', 'python314.zip'].includes(path.basename(name))) {
        refuse('An isolated interpreter import path is outside its observed standard-library prefix.');
      }
      try { standard.push(await this.#external(name)); } catch (error) { if (!absent(error)) throw error; missing.push(name); }
    }
    const paths = [...new Set([...imported, ...standard])];
    if (paths.length > limits.roots) refuse('The observed isolated import-root inventory exceeds its bound.');
    const interpreterDirectory = await this.#external(path.dirname(pythonAlias));
    if (!applicationWithin(prefix, interpreterDirectory)) refuse('The literal interpreter launcher must belong to its observed virtual-environment prefix.');
    const roots = [...new Set([...paths, launcher, python, configPath, interpreterDirectory])];
    const programPrefixes = [prefix, basePrefix, ...imported];
    const before = await this.#capture(roots, programPrefixes);
    const config = path.join(this.home, 'checkov.yml'), modules = path.join(this.home, 'no-external-modules');
    await writeFile(config, '{}\n', { flag: 'wx', mode: 0o600 });
    const result = await this.#run(pythonAlias, ['-I', '-S', '-B', '-c', bootstrap, JSON.stringify(paths), launcher,
      '--framework', this.framework, '--file', ...this.files, '--output', 'json', '--skip-download',
      '--download-external-modules', 'false', '--external-modules-download-path', modules,
      '--skip-results-upload', '--config-file', config], env);
    if (!this.#settled) refuse('The original scanner process tree did not settle; its execution HOME must be retained.');
    for (const name of missing) {
      try { await lstat(name); } catch (error) { if (absent(error)) continue; throw error; }
      refuse('An originally absent interpreter import path appeared.');
    }
    if (await realpath(pythonAlias) !== python || await realpath(siteAlias) !== site ||
        canonicalSha256(await this.#pathDeclarations(site)) !== canonicalSha256(imported) ||
        canonicalSha256(await toolFile(launcher, this.projectRoot, this.home, false)) !== canonicalSha256(launcherIdentity) ||
        canonicalSha256(await toolFile(python, this.projectRoot, this.home, true)) !== canonicalSha256(interpreterIdentity) ||
        canonicalSha256(await toolFile(configPath, this.projectRoot, this.home, false)) !== canonicalSha256(configuration) ||
        await this.#capture(roots, programPrefixes) !== before) refuse('The observed scanner program, interpreter, import paths or complete bounded program inventory changed.');
    this.#remaining();
    return freezeModernValue({ result, programDigest: canonicalSha256({ version, python: observed.version, paths, before,
      launcherIdentity, interpreterIdentity, configuration, bootstrap,
      argvPolicy: `all-${this.framework}-checks-no-download-no-upload-no-user-config` }) });
  }
}
