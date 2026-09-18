import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViteDevServer } from 'vite';
import type { GitHubActivationTransport, GitHubRequest } from '../src/adapters/github/activation-rest.js';
import type { UpdatePreviewOptions } from '../src/adapters/filesystem/update-previews.js';
import type { ActivationConfiguration } from '../src/domain/governance/activation/types.js';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import type { ExternalCommand } from '../src/domain/project/contracts.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import { CaptureStream } from './helpers.js';
import { createActivationSuccessorRuntime } from './fixtures/activation-successor-runtime.js';
import { capturedTree, materializeReleasedFiles, readReleasedBaselineIndex } from './fixtures/released-baseline/corpus.js';

type Identity = Awaited<ReturnType<typeof lstat>>;
type History = Extract<Awaited<ReturnType<typeof import('../src/governance-activation/migration-history.js')['inspectActivationMigrationHistory']>>, { status: 'committed' }>;
interface Producer {
  head: string;
  repository: string;
  pushUrl: string;
  azureInputs: ActivationConfiguration;
}
interface Fixture extends Producer {
  parent: string;
  identity: Identity;
  project: string;
  home: string;
  otherHome: string;
  legacyHome: string;
  legacyAuthority: Awaited<ReturnType<typeof capturedTree>>;
  cwd: string;
  gitEnvironment: NodeJS.ProcessEnv;
  storage: UpdatePreviewOptions;
  runner: PublicationRunner;
  transport: FixtureGitHubReads;
  original: Map<string, { bytes: Buffer; mode: number }>;
  passed: boolean;
}

let loader: ViteDevServer;
let supportRoot: string;
let supportIdentity: Identity;
let sourceRoot: string;
let commands: typeof import('../src/commands.js');
let argumentsApi: typeof import('../src/args.js');
let histories: typeof import('../src/governance-activation/migration-history.js');
let manifests: typeof import('../src/application/project/manifest.js');
let inspections: typeof import('../src/application/repository-governance/inspection.js');
let proofs: typeof import('../src/governance-activation/read-only.js');
let stateFiles: typeof import('../src/governance-activation/activation-state.js');
let validators: typeof import('../src/domain/governance/activation/validators.js');
let historical: typeof import('../src/governance-activation/historical-v3.js');
let authority: typeof import('../src/governance-activation/authority-records.js');
let approvals: typeof import('../src/domain/governance/activation/approvals.js');
let graph: typeof import('../src/domain/governance/activation/graph.js');
let processes: typeof import('../src/process-runner.js');
let locks: typeof import('../src/adapters/filesystem/project-lock.js');
interface RuntimeModules {
  '/src/commands.ts': typeof commands;
  '/src/args.ts': typeof argumentsApi;
  '/src/governance-activation/migration-history.ts': typeof histories;
  '/src/application/project/manifest.ts': typeof manifests;
  '/src/application/repository-governance/inspection.ts': typeof inspections;
  '/src/governance-activation/read-only.ts': typeof proofs;
  '/src/governance-activation/activation-state.ts': typeof stateFiles;
  '/src/domain/governance/activation/validators.ts': typeof validators;
  '/src/governance-activation/historical-v3.ts': typeof historical;
  '/src/governance-activation/authority-records.ts': typeof authority;
  '/src/domain/governance/activation/approvals.ts': typeof approvals;
  '/src/domain/governance/activation/graph.ts': typeof graph;
  '/src/process-runner.ts': typeof processes;
  '/src/adapters/filesystem/project-lock.ts': typeof locks;
}
async function runtimeModule<K extends keyof RuntimeModules>(filename: K): Promise<RuntimeModules[K]> {
  // Vite's untyped runtime boundary is restricted to these exact source-module contracts.
  return await loader.ssrLoadModule(filename) as RuntimeModules[K];
}
let current: Fixture | undefined;
const fixtures: Fixture[] = [];
const fixtureRoots: string[] = [];
const network = vi.fn(async () => { throw new Error('Publication source regression forbids real network access.'); });
const localGitReads = new Set([
  'rev-parse --show-toplevel', 'rev-parse --verify HEAD', 'symbolic-ref --quiet --short HEAD',
  'remote', 'remote get-url --push --all origin', 'status --porcelain=v1 -z --untracked-files=all'
]);

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected a structured production report.');
  return value;
}
function array(value: Record<string, unknown>, key: string): unknown[] {
  if (!Array.isArray(value[key])) throw new Error(`Expected production array ${key}.`);
  return value[key];
}
function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Expected a nonempty production string.');
  return value;
}
function resultFor(command: ExternalCommand, status: number, stdout: string, stderr = ''): CommandResult {
  return { command, displayCommand: `${command.executable} ${command.args.join(' ')}`,
    status, stdout, stderr, signal: null, timedOut: false };
}
function git(f: Pick<Fixture, 'project' | 'gitEnvironment'>, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd: f.project, env: f.gitEnvironment, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024
  });
  if (result.error || result.status !== 0) throw new Error(`Owned local Git failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

class PublicationRunner implements CommandRunner {
  readonly calls: ExternalCommand[] = [];
  readonly forbidden: ExternalCommand[] = [];
  readonly simulatedChecks: ExternalCommand[] = [];
  private readonly reviewedChecks = new Set<string>();
  fixtureChecksEnabled = false;
  constructor(private readonly fixture: () => Fixture) {}
  review(preview: unknown) {
    for (const phase of array(object(preview), 'phases').map(object)) {
      for (const check of array(phase, 'commands').map(object)) {
        const command = object(check.command);
        const executable = requiredString(command.executable);
        const args = array(command, 'args').map(requiredString);
        const parts = array(check, 'cwdPathParts').map(requiredString);
        const env = object(check.env);
        for (const value of Object.values(env)) if (typeof value !== 'string') throw new Error('Invalid reviewed check environment.');
        this.reviewedChecks.add(canonicalSha256({
          command: { executable, args }, cwd: path.join(this.fixture().project, ...parts), env
        }));
      }
    }
  }
  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push(command);
    const f = this.fixture();
    if (command.executable === 'git' && localGitReads.has(command.args.join(' ')) && options?.cwd === f.project) {
      return resultFor(command, 0, git(f, command.args));
    }
    const key = canonicalSha256({ command, cwd: options?.cwd, env: options?.env ?? {} });
    if (this.reviewedChecks.has(key)) {
      if (!this.fixtureChecksEnabled) return resultFor(command, 127, '', 'Local tools are deliberately unavailable in this source-harness stage.');
      if (command.executable === 'liftoff') {
        const stdout = new CaptureStream(), stderr = new CaptureStream();
        const code = await commands.runCommand(argumentsApi.parseArgs([...command.args]), {
          cwd: f.project, stdout, stderr, runner: this, storage: f.storage, updatePreview: f.storage, env: {}
        });
        return resultFor(command, code, stdout.text(), stderr.text());
      }
      // Portable tool observations only; real current state/evidence is written exclusively by the reviewed engine.
      this.simulatedChecks.push(command);
      return resultFor(command, 0, 'Bounded source-harness tool observation; not an installed-tool or provider qualification.\n');
    }
    this.forbidden.push(command);
    throw new Error(`Unreviewed process in publication regression: ${command.executable} ${command.args.join(' ')}`);
  }
}

class FixtureGitHubReads implements GitHubActivationTransport {
  readonly requests: GitHubRequest[] = [];
  head: string;
  id = 42;
  constructor(private readonly repository: string, head: string) { this.head = head; }
  async request(request: GitHubRequest) {
    expect(request.method).toBe('GET');
    expect([`/repos/${this.repository}`, `/repos/${this.repository}/git/ref/heads/develop`]).toContain(request.path);
    expect(request.body).toBeUndefined();
    this.requests.push(request);
    return { status: 200, headers: {}, data: request.path.endsWith('/git/ref/heads/develop')
      ? { ref: 'refs/heads/develop', object: { sha: this.head, type: 'commit' } }
      : { id: this.id, full_name: this.repository, default_branch: 'develop' } };
  }
}

beforeAll(async () => {
  supportRoot = await realpath(await mkdtemp(path.resolve('tests', '.public-v3-runtime-')));
  supportIdentity = await lstat(supportRoot);
  sourceRoot = path.join(supportRoot, 'released source');
  await mkdir(sourceRoot, { mode: 0o700 });
  const release = readReleasedBaselineIndex().sources.find((source) => source.release === 'v0.12.3');
  if (!release || release.commit !== '70d10881b46d873118d825735696f39b6d35ebe0') throw new Error('Missing exact released source closure.');
  await materializeReleasedFiles(sourceRoot, release.files);
  loader = await createActivationSuccessorRuntime(path.join(supportRoot, 'ssr'));
  [
    commands, argumentsApi, histories, manifests, inspections, proofs, stateFiles, validators,
    historical, authority, approvals, graph, processes, locks
  ] = await Promise.all([
    runtimeModule('/src/commands.ts'), runtimeModule('/src/args.ts'),
    runtimeModule('/src/governance-activation/migration-history.ts'),
    runtimeModule('/src/application/project/manifest.ts'), runtimeModule('/src/application/repository-governance/inspection.ts'),
    runtimeModule('/src/governance-activation/read-only.ts'), runtimeModule('/src/governance-activation/activation-state.ts'),
    runtimeModule('/src/domain/governance/activation/validators.ts'), runtimeModule('/src/governance-activation/historical-v3.ts'),
    runtimeModule('/src/governance-activation/authority-records.ts'), runtimeModule('/src/domain/governance/activation/approvals.ts'),
    runtimeModule('/src/domain/governance/activation/graph.ts'), runtimeModule('/src/process-runner.ts'),
    runtimeModule('/src/adapters/filesystem/project-lock.ts')
  ]);
}, 60_000);
beforeEach(() => {
  current = undefined;
  network.mockClear();
  vi.stubGlobal('fetch', network);
  vi.spyOn(processes.NodeCommandRunner.prototype, 'run').mockImplementation(async (command, options) => {
    if (!current) throw new Error('No owned publication fixture is active.');
    return current.runner.run(command, options);
  });
});
async function removeOwnedDirectory(root: string, expected: Identity) {
  const observed = await lstat(root);
  if (!observed.isDirectory() || observed.isSymbolicLink() || await realpath(root) !== root ||
    observed.dev !== expected.dev || observed.ino !== expected.ino || observed.birthtimeMs !== expected.birthtimeMs) {
    throw new Error(`Owned fixture identity changed; preserve ${root}.`);
  }
  await rm(root, { recursive: true });
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (current?.passed) {
    current.passed = false;
    for (const filename of [await locks.projectMutationLockPath(current.project),
      await locks.userScopeMutationLockPath(current.project), path.join(current.project, '.git', 'index.lock')]) {
      await expect(lstat(filename), `Unsettled owned operation; preserve ${current.parent}`).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await removeOwnedDirectory(current.parent, current.identity);
    current.passed = true;
  } else if (current || fixtureRoots.length) {
    console.error(`Public v3 fixture retained for diagnosis: ${current?.parent ?? fixtureRoots.at(-1)}`);
  }
  current = undefined;
});
afterAll(async () => {
  await loader?.close();
  if (supportRoot && fixtureRoots.length === fixtures.length && fixtures.every((fixture) => fixture.passed)) {
    await removeOwnedDirectory(supportRoot, supportIdentity);
  }
  else if (supportRoot) console.error(`Closed public v3 source/cache retained for diagnosis: ${supportRoot}`);
});

async function fixture(): Promise<Fixture> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-public-v3-')));
  const identity = await lstat(parent);
  fixtureRoots.push(parent);
  const project = path.join(parent, 'project with spaces'), home = path.join(parent, 'selected private home');
  const otherHome = path.join(parent, 'wrong private home'), cwd = path.join(parent, 'different invocation cwd');
  const legacyHome = path.join(parent, 'released private home'), emptyHooks = path.join(parent, 'empty hooks');
  for (const directory of [project, home, otherHome, cwd, legacyHome, emptyHooks]) await mkdir(directory, { mode: 0o700 });
  const emptyGitConfig = path.join(parent, 'empty git config');
  await writeFile(emptyGitConfig, '', { flag: 'wx', mode: 0o600 });
  const producer = spawnSync(process.execPath, [
    path.resolve('tests/fixtures/released-baseline/publication-producer.mjs'),
    JSON.stringify({ sourceRoot, projectRoot: project, legacyHome, emptyGitConfig, emptyHooks })
  ], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    env: {
      PATH: process.env.PATH, HOME: legacyHome, USERPROFILE: legacyHome,
      XDG_CONFIG_HOME: path.join(legacyHome, 'config'), XDG_STATE_HOME: path.join(legacyHome, 'state'),
      LOCALAPPDATA: path.join(legacyHome, 'local'), TMPDIR: parent
    }
  });
  expect(producer.error, `${parent}\n${producer.stderr}`).toBeUndefined();
  expect(producer.status, `${parent}\n${producer.stderr}`).toBe(0);
  const produced = object(JSON.parse(producer.stdout));
  expect(produced).toMatchObject({
    release: 'v0.12.3', baselineCommit: '70d10881b46d873118d825735696f39b6d35ebe0',
    kind: 'released-production-serializers-real-local-git-controlled-remote-observation',
    identity: { activationContractVersion: 3, manifestArtifactVersion: 7 }
  });
  const release = readReleasedBaselineIndex().sources.find((source) => source.release === 'v0.12.3')!;
  const sourcePaths = new Set(release.files.map((file) => file.path));
  for (const filename of array(produced, 'loaded')) expect(sourcePaths.has(requiredString(filename))).toBe(true);
  for (const phase of ['committed', 'pushed']) {
    const digests = object(object(produced.publicationDigests)[phase]);
    expect(digests.original).not.toBe(digests.withLaterAzure);
  }
  const head = requiredString(produced.head), repository = requiredString(produced.repository), pushUrl = requiredString(produced.pushUrl);
  const azureInputs = validators.validateActivationConfiguration(produced.azureInputs);
  const storage: UpdatePreviewOptions = { homedir: home, env: {}, repositoryRoot: project, clock: () => new Date() };
  const runner = new PublicationRunner(() => value);
  const value: Fixture = {
    parent, identity, project, home, otherHome, legacyHome, legacyAuthority: await capturedTree(legacyHome),
    cwd, head, repository, pushUrl, azureInputs, storage, runner,
    gitEnvironment: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: emptyGitConfig,
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0'
    },
    transport: new FixtureGitHubReads(repository, head),
    original: new Map((await capturedTree(project)).filter((file) => !file.path.startsWith('.git/'))
      .map((file) => [file.path, { bytes: Buffer.from(file.bytes, 'base64'), mode: file.mode }])),
    passed: false
  };
  fixtures.push(value);
  current = value;
  vi.stubEnv('HOME', otherHome);
  vi.stubEnv('USERPROFILE', otherHome);
  vi.stubEnv('XDG_STATE_HOME', path.join(otherHome, 'state'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(otherHome, 'config'));
  vi.stubEnv('LOCALAPPDATA', path.join(otherHome, 'local'));
  const sourceState = historical.validateHistoricalV3ActivationState(JSON.parse(value.original.get('governance/activation-state.json')!.bytes.toString()));
  for (const phase of ['committed', 'pushed'] as const) {
    expect(sourceState.phases[phase].state).toBe('verified');
    const record = historical.validateHistoricalV3EvidenceRecord(JSON.parse(
      value.original.get(`governance/evidence/released-serializer-${phase}.json`)!.bytes.toString()));
    expect(record.payload).toMatchObject({ head, pushUrl });
    expect(sourceState.phases[phase].evidence).toContainEqual({
      phaseId: phase, evidenceId: record.evidenceId, headerDigest: canonicalSha256(record.header), result: 'verified'
    });
  }
  expect(git(value, ['rev-parse', '--verify', 'HEAD']).trim()).toBe(head);
  expect(git(value, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
  return value;
}

async function invoke(f: Fixture, args: string[], storage = f.storage) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const code = await commands.runCommand(argumentsApi.parseArgs(args), {
    cwd: f.cwd, stdout, stderr, runner: f.runner, storage, updatePreview: storage,
    updateNow: () => new Date(), env: {},
    adapters: { githubActivation: { transport: f.transport, storage } }
  });
  const text = stdout.text(), err = stderr.text();
  return { code, text, err, body: text.trim().startsWith('{') ? object(JSON.parse(text)) : undefined };
}
function governance(f: Fixture, command: string, extra: string[] = []) {
  return ['governance', command, '--project', f.project, '--scope', 'activation', '--json', ...extra];
}
async function historyBytes(f: Fixture, history: History) {
  for (const file of history.index.files) {
    const original = f.original.get(file.originalPathParts.join('/'));
    if (!original) throw new Error(`Unknown released source ${file.originalPathParts.join('/')}.`);
    expect(file.digest).toBe(createHash('sha256').update(original.bytes).digest('hex'));
    expect(file.mode).toBe(original.mode);
    expect(await readFile(path.join(f.project, ...file.copyPathParts))).toEqual(original.bytes);
  }
  const manifest = await manifests.loadManifest(f.project);
  if (manifest.artifactVersion !== 8 || manifest.provenance.kind !== 'generated' ||
    manifest.provenance.origin.kind !== 'historical-manifest') throw new Error('Missing exact original manifest provenance.');
  expect(await readFile(path.join(f.project, ...manifest.provenance.origin.historyPathParts)))
    .toEqual(f.original.get('liftoff.manifest.json')!.bytes);
  expect(await capturedTree(f.legacyHome)).toEqual(f.legacyAuthority);
  expect(await capturedTree(f.otherHome)).toEqual([]);
}
async function update(f: Fixture) {
  const checked = await invoke(f, ['update', '--project', f.project, '--check', '--json']);
  expect(checked.code, `${f.parent}\n${checked.text}${checked.err}`).toBe(2);
  const report = object(checked.body);
  const selected = array(report, 'plans').map(object).find((plan) => plan.mode === 'normal' && plan.eligible === true);
  if (!selected) throw new Error('Missing actual reviewed update preview.');
  const preview = object(object(report.revalidation).preview);
  f.runner.review(preview);
  const applied = await invoke(f, ['update', '--project', f.project, '--approve-plan', requiredString(selected.fingerprint), '--json']);
  return applied;
}
async function migrateAndRevalidate(f: Fixture, demonstrateIncomplete = false): Promise<History> {
  f.runner.fixtureChecksEnabled = !demonstrateIncomplete;
  const committed = await update(f);
  f.runner.fixtureChecksEnabled = false;
  expect(committed.code, `${f.parent}\n${committed.text}${committed.err}`).toBe(demonstrateIncomplete ? 2 : 0);
  expect(committed.body).toMatchObject({
    committed: true, activationMigration: { status: 'committed' },
    revalidation: { status: demonstrateIncomplete ? 'blocked' : 'complete' }
  });
  const history = await histories.inspectActivationMigrationHistory(f.project, f.storage);
  if (history.status !== 'committed') throw new Error('The actual reviewed successor transaction did not commit.');
  expect(history.index.sourceIdentity.activationContractVersion).toBe(3);
  expect(history.state.identity).toEqual(graph.currentActivationIdentity);
  expect(history.state.remoteBinding).toBeUndefined();
  expect(Object.values(history.state.phases).every((phase) => phase.approvals.length === 0)).toBe(true);
  await historyBytes(f, history);
  expect(f.transport.requests).toEqual([]);
  if (demonstrateIncomplete) {
    expect((await proofs.readActivationEvidence(f.project)).some((record) => record.header.result === 'verified')).toBe(false);
    f.runner.fixtureChecksEnabled = true;
    const revalidated = await update(f);
    f.runner.fixtureChecksEnabled = false;
    expect(revalidated.code, `${f.parent}\n${revalidated.text}${revalidated.err}`).toBe(0);
    expect(revalidated.body, revalidated.text + revalidated.err).toMatchObject({ committed: true, revalidation: { status: 'complete' } });
  }
  const inspection = await inspections.inspectGovernanceTransition(f.project, { runner: f.runner, storage: f.storage, scope: 'activation' });
  expect(inspection.readiness.nextPlannablePhase).toBe('committed');
  for (const phase of ['seed-valid', 'seed-verified', 'seed-archived'] as const) expect(inspection.readiness.phases[phase].state).toBe('verified');
  for (const record of await proofs.readActivationEvidence(f.project)) {
    expect(record.header.identity).toEqual(graph.currentActivationIdentity);
    expect(record.evidenceId).not.toMatch(/^released-serializer-/);
  }
  expect(f.runner.simulatedChecks.length).toBeGreaterThan(0);
  await historyBytes(f, history);
  return history;
}
async function configureAzure(f: Fixture) {
  const reference = path.join(f.project, 'later-azure.inputs.json');
  await writeFile(reference, `${JSON.stringify(f.azureInputs, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return reference;
}
async function previewAndApprove(f: Fixture, phase: 'committed' | 'pushed', inputs: string) {
  const planned = await invoke(f, governance(f, 'plan', ['--inputs', inputs]));
  expect(planned.code, `${f.parent}\n${planned.text}${planned.err}`).toBe(0);
  const body = object(planned.body);
  const plan = validators.validateSavedTransitionPlan(body.plan);
  expect(plan.phaseId).toBe(phase);
  expect(plan.approval.required).toBe(true);
  expect(plan.approval.evaluation.approvalRequired).toBe(true);
  expect(plan.operations.filter((operation) => operation.adapter === 'git')).toMatchObject([{
    actionId: phase === 'committed' ? 'git.verify-existing-commit' : 'git.verify-existing-push',
    mutationClass: phase === 'committed' ? 'read-worktree' : 'github-read',
    inputs: { publicationRevalidation: { recordedHead: f.head, inputAlgorithm: 'phase-consumed-v4', newLocalMetadataPublished: false } }
  }]);
  expect(plan.operations.some((operation) => ['git-commit', 'git-push', 'github-write'].includes(operation.mutationClass))).toBe(false);
  const fingerprint = requiredString(object(body.preview).fingerprint);
  const approved = await invoke(f, governance(f, 'approve', ['--plan', fingerprint, '--inputs', inputs]));
  expect(approved.code, `${f.parent}\n${approved.text}${approved.err}`).toBe(0);
  expect(approved.body).toMatchObject({ approved: true, executed: false });
  const envelopeId = requiredString(object(approved.body).envelopeId);
  const envelope = validators.validateApprovalEnvelope(JSON.parse(
    await readFile(path.join(f.project, 'governance', 'approvals', `${envelopeId}.json`), 'utf8')));
  expect(envelope.identity).toEqual(graph.currentActivationIdentity);
  expect(envelope.phaseId).toBe(phase);
  expect(envelope.id).not.toMatch(/^(?:committed|pushed)-review$/);
  expect(envelope.permissions.some((permission) => ['git-commit', 'git-push', 'github-write'].includes(permission))).toBe(false);
  expect(envelope.permissions).toContain(phase === 'committed' ? 'read-worktree' : 'github-read');
  expect(approvals.canonicalApprovalEnvelopeHash(envelope)).toBe(object(approved.body).envelopeHash);
  await authority.assertGovernanceApprovalIssued(f.project, envelope, f.storage);
  await expect(authority.assertGovernanceApprovalIssued(f.project, envelope, {
    ...f.storage, homedir: f.otherHome
  })).rejects.toThrow(/no project-bound authority/);
  return { fingerprint, plan, envelope };
}
function exactApply(f: Fixture, fingerprint: string, inputs: string) {
  return governance(f, 'apply-next', ['--execute', '--plan', fingerprint, '--inputs', inputs]);
}
function noPublicationEffects(f: Fixture) {
  expect(f.runner.forbidden).toEqual([]);
  expect(f.runner.calls.filter((command) => command.executable === 'git').every((command) => localGitReads.has(command.args.join(' ')))).toBe(true);
  expect(f.runner.calls.some((command) => ['gh', 'az'].includes(command.executable))).toBe(false);
  expect(network).not.toHaveBeenCalled();
}

describe('public affected-v3 publication with real local Git and bounded fixture observations', () => {
  it('migrates actual released-writer records, separately approves current readback in a selected private store and never republishes', async () => {
    const f = await fixture();
    const history = await migrateAndRevalidate(f, true);
    const beforeAzure = await inspections.inspectGovernanceTransition(f.project, { runner: f.runner, storage: f.storage, scope: 'activation' });
    const inputs = await configureAzure(f);
    const withAzure = await inspections.inspectGovernanceTransition(f.project, {
      runner: f.runner, storage: f.storage, scope: 'activation', activationInputs: f.azureInputs
    });
    for (const phase of ['committed', 'pushed'] as const) {
      expect(withAzure.contexts[phase].inputDigest).toBe(beforeAzure.contexts[phase].inputDigest);
    }
    const beforeUnapproved = await capturedTree(f.project);
    const unapproved = await invoke(f, governance(f, 'apply-next', ['--execute', '--inputs', inputs]));
    expect(unapproved.code).toBe(1);
    expect(unapproved.body).toMatchObject({ applied: false, authorized: false, reason: 'approval-required', executedOperations: [] });
    expect(await capturedTree(f.project)).toEqual(beforeUnapproved);
    const committed = await previewAndApprove(f, 'committed', inputs);
    const wrongStore = await invoke(f, exactApply(f, committed.fingerprint, inputs), { ...f.storage, homedir: f.otherHome });
    expect(wrongStore.code).toBe(1);
    expect(wrongStore.text + wrongStore.err).toMatch(/matching external governance preview|project-bound authority/);
    expect(f.transport.requests).toEqual([]);
    const commitResult = await invoke(f, exactApply(f, committed.fingerprint, inputs));
    expect(commitResult.code, `${f.parent}\n${commitResult.text}${commitResult.err}`).toBe(0);
    expect(commitResult.body).toMatchObject({ applied: true, executedPhase: 'committed', authorized: true });
    expect(f.transport.requests).toEqual([]);
    const pushed = await previewAndApprove(f, 'pushed', inputs);
    const pushResult = await invoke(f, exactApply(f, pushed.fingerprint, inputs));
    expect(pushResult.code, `${f.parent}\n${pushResult.text}${pushResult.err}`).toBe(0);
    expect(pushResult.body).toMatchObject({ applied: true, executedPhase: 'pushed', authorized: true });
    expect(f.transport.requests.map((request) => request.path)).toEqual([
      `/repos/${f.repository}`, `/repos/${f.repository}/git/ref/heads/develop`
    ]);
    const state = await stateFiles.loadActivationState(f.project, f.storage);
    expect(state?.state.remoteBinding).toMatchObject({ id: '42', name: f.repository, pushUrl: f.pushUrl });
    expect(state?.state.activationInputs).toEqual(f.azureInputs);
    expect(state?.state.repository.id).toBe(history.state.repository.id);
    expect(state?.state.successorHistory).toEqual(history.state.successorHistory);
    const evidence = await proofs.readActivationEvidence(f.project);
    for (const phase of ['committed', 'pushed'] as const) {
      const record = evidence.find((record) => record.header.phaseId === phase);
      expect(record?.header).toMatchObject({ identity: graph.currentActivationIdentity, result: 'verified' });
      expect(record?.payload).toMatchObject({
        head: f.head, publicationRevalidation: {
          sourceSnapshotId: history.index.snapshotId, sourceEvidenceId: `released-serializer-${phase}`,
          newLocalMetadataPublished: false, inputAlgorithm: 'phase-consumed-v4'
        }
      });
      const binding = object(object(record?.payload).publicationRevalidation);
      expect(array(binding, 'pendingLocalMetadata').map(object)).toContainEqual(expect.objectContaining({ path: 'liftoff.manifest.json' }));
    }
    const beforeRepeat = await capturedTree(f.project);
    const repeat = await invoke(f, exactApply(f, pushed.fingerprint, inputs));
    expect(repeat.code).toBe(1);
    expect(repeat.body?.applied).not.toBe(true);
    expect(await capturedTree(f.project)).toEqual(beforeRepeat);
    expect(f.transport.requests).toHaveLength(2);
    const laterInputs = path.join(f.project, 'subsequent-azure.inputs.json');
    await writeFile(laterInputs, `${JSON.stringify({
      ...f.azureInputs, azure: { ...f.azureInputs.azure, region: 'westus' }
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const beforeConsumers = await capturedTree(f.project);
    for (const command of ['status', 'resume', 'verify']) {
      const observed = await invoke(f, governance(f, command, ['--inputs', laterInputs]));
      expect(observed.code, observed.text + observed.err).toBe(command === 'verify' ? 2 : 0);
      expect(observed.body).toMatchObject({ progress: { local: true, activation: false } });
      if (command !== 'verify') {
        const phases = array(object(observed.body), 'phases').map(object);
        for (const phase of ['committed', 'pushed']) {
          expect(phases.find((entry) => entry.id === phase)).toMatchObject({
            state: 'verified', evidence: { freshness: { status: 'fresh' } }
          });
        }
      } else expect(observed.body).toMatchObject({ consistent: true, complete: false, ok: false });
    }
    expect(await capturedTree(f.project)).toEqual(beforeConsumers);
    expect(f.transport.requests).toHaveLength(2);
    expect(git(f, ['rev-parse', '--verify', 'HEAD']).trim()).toBe(f.head);
    expect(git(f, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
    expect(JSON.parse(git(f, ['show', 'HEAD:liftoff.manifest.json'])).artifactVersion).toBe(7);
    await historyBytes(f, history);
    noPublicationEffects(f);
    f.passed = true;
  }, 180_000);

  it.each(['local-head', 'branch', 'push-destination', 'application-source', 'pending-current-workflow', 'edited-input-reference'] as const)(
    'refuses %s drift after public exact approval without executing or changing retained records',
    async (change) => {
      const f = await fixture();
      const history = await migrateAndRevalidate(f);
      const inputs = await configureAzure(f);
      let approved = await previewAndApprove(f, 'committed', inputs);
      if (change === 'pending-current-workflow') {
        const committed = await invoke(f, exactApply(f, approved.fingerprint, inputs));
        expect(committed.code, committed.text + committed.err).toBe(0);
        expect(committed.body).toMatchObject({ applied: true, executedPhase: 'committed' });
        approved = await previewAndApprove(f, 'pushed', inputs);
      }
      if (change === 'local-head') {
        git(f, ['-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${path.join(f.parent, 'empty hooks')}`,
          '-c', 'user.name=Offline drift fixture', '-c', 'user.email=fixture@example.invalid',
          'commit', '--quiet', '--allow-empty', '-m', 'Deliberate unpublished fixture commit']);
        expect(git(f, ['rev-parse', '--verify', 'HEAD']).trim()).not.toBe(f.head);
      } else if (change === 'branch') {
        git(f, ['branch', '-m', 'unreviewed-branch']);
      } else if (change === 'push-destination') {
        git(f, ['remote', 'set-url', '--push', 'origin', 'https://github.com/owner/other-fixture.git']);
      } else if (change === 'application-source') {
        const source = [...f.original.keys()].find((name) => name.startsWith('backend/src/') && name.endsWith('.ts'));
        if (!source) throw new Error('The actual released fixture has no backend source.');
        await writeFile(path.join(f.project, source), Buffer.concat([
          f.original.get(source)!.bytes, Buffer.from('\n// Deliberate unpublished application change.\n')
        ]));
      } else if (change === 'pending-current-workflow') {
        const filename = path.join(f.project, '.github', 'workflows', 'unpublished-current-workflow.yml');
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, 'name: Unpublished current fixture\non: workflow_dispatch\npermissions:\n  contents: read\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --version\n',
          { flag: 'wx', mode: 0o644 });
      } else {
        await writeFile(inputs, `${JSON.stringify({ ...f.azureInputs, azure: { ...f.azureInputs.azure, region: 'westus' } })}\n`);
      }
      const before = await capturedTree(f.project);
      const checkCount = f.runner.simulatedChecks.length;
      const refused = await invoke(f, exactApply(f, approved.fingerprint, inputs));
      expect(refused.code, refused.text + refused.err).toBe(1);
      expect(refused.body?.applied).not.toBe(true);
      expect(refused.text + refused.err).toMatch(/changed|unpublished|differ|binding/i);
      if (change === 'pending-current-workflow') {
        expect(refused.text + refused.err).toContain('.github/workflows/unpublished-current-workflow.yml');
        expect(refused.text + refused.err).toContain('separate publication');
      }
      expect(await capturedTree(f.project)).toEqual(before);
      expect(f.runner.simulatedChecks).toHaveLength(checkCount);
      expect(f.transport.requests).toEqual([]);
      await historyBytes(f, history);
      noPublicationEffects(f);
      f.passed = true;
    }, 180_000
  );

  it.each(['remote-head', 'remote-repository-id'] as const)(
    'persists refusal of mismatched %s through public apply without certifying or republishing',
    async (change) => {
      const f = await fixture();
      const history = await migrateAndRevalidate(f);
      const inputs = await configureAzure(f);
      const committed = await previewAndApprove(f, 'committed', inputs);
      const commitResult = await invoke(f, exactApply(f, committed.fingerprint, inputs));
      expect(commitResult.code, commitResult.text + commitResult.err).toBe(0);
      expect(commitResult.body).toMatchObject({ applied: true, executedPhase: 'committed' });
      const approved = await previewAndApprove(f, 'pushed', inputs);
      const beforeEvidence = await proofs.readActivationEvidence(f.project);
      if (change === 'remote-head') {
        f.transport.head = createHash('sha1').update('Independent bounded fake remote drift').digest('hex');
        expect(f.transport.head).not.toBe(f.head);
      } else f.transport.id = 43;
      const refused = await invoke(f, exactApply(f, approved.fingerprint, inputs));
      expect(refused.code, refused.text + refused.err).toBe(1);
      expect(refused.body).toMatchObject({
        applied: false, reason: 'blocked', selectedPhase: 'pushed',
        message: expect.stringContaining('Independent GitHub repository/ref readback differs')
      });
      expect(array(object(refused.body), 'executedOperations')).toEqual([
        approved.plan.operations.find((operation) => operation.actionId === 'governance.activation-state.write')
      ]);
      expect(f.transport.requests.map((request) => request.path)).toEqual([
        `/repos/${f.repository}`, `/repos/${f.repository}/git/ref/heads/develop`
      ]);
      const after = await stateFiles.loadActivationState(f.project, f.storage);
      expect(after?.state.phases.committed.state).toBe('verified');
      expect(after?.state.phases.pushed).toMatchObject({ state: 'blocked', evidence: [] });
      expect(after?.state.remoteBinding).toBeUndefined();
      expect(after?.state.successorHistory).toEqual(history.state.successorHistory);
      expect(await proofs.readActivationEvidence(f.project)).toEqual(beforeEvidence);
      await authority.assertGovernanceApprovalIssued(f.project, approved.envelope, f.storage);
      const beforeRepeat = await capturedTree(f.project);
      const repeat = await invoke(f, exactApply(f, approved.fingerprint, inputs));
      expect(repeat.code).toBe(1);
      expect(await capturedTree(f.project)).toEqual(beforeRepeat);
      expect(f.transport.requests).toHaveLength(2);
      expect(git(f, ['rev-parse', '--verify', 'HEAD']).trim()).toBe(f.head);
      expect(git(f, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
      await historyBytes(f, history);
      noPublicationEffects(f);
      f.passed = true;
    }, 180_000
  );
});
