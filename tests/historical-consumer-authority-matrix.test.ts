import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViteDevServer } from 'vite';
import type { UpdatePreviewOptions } from '../src/adapters/filesystem/update-previews.js';
import type { AssessmentSnapshot } from '../src/adapters/filesystem/standards-assessment/snapshot.js';
import type { GovernanceInspection } from '../src/application/repository-governance/inspection-contracts.js';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import type { ExternalCommand } from '../src/domain/project/contracts.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import { fixturePlan } from './governance-activation-fixtures.js';
import { CaptureStream } from './helpers.js';
import { createActivationSuccessorRuntime } from './fixtures/activation-successor-runtime.js';
import {
  capturedTree, materializeReleasedFiles, releasedBytes, releasedCase, type CapturedActivation
} from './fixtures/released-baseline/corpus.js';

const cases = [
  { id: 'activation-v1', family: 1, ancestors: [] },
  { id: 'activation-v2-retained', family: 2, ancestors: [] },
  { id: 'activation-v2-disposed-spec-kit', family: 2, ancestors: [] },
  { id: 'activation-v3-local', family: 3, ancestors: [] },
  { id: 'activation-v2-with-v1-history', family: 2, ancestors: [1] },
  { id: 'activation-v3-with-v2-v1-history', family: 3, ancestors: [2, 1] }
] as const;
type Case = typeof cases[number];
type HistoricalState = ReturnType<typeof import('../src/governance-activation/historical-state.js')['validateReadableHistoricalActivationState']>;
type CurrentHistory = Extract<Awaited<ReturnType<typeof import('../src/governance-activation/migration-history.js')['inspectActivationMigrationHistory']>>, { status: 'committed' }>;

let loader: ViteDevServer;
let cacheRoot: string;
let cacheIdentity: Awaited<ReturnType<typeof lstat>>;
let commands: typeof import('../src/commands.js');
let argumentsApi: typeof import('../src/args.js');
let manifests: typeof import('../src/application/project/manifest.js');
let histories: typeof import('../src/governance-activation/migration-history.js');
let historicalStates: typeof import('../src/governance-activation/historical-state.js');
let stateFiles: typeof import('../src/governance-activation/activation-state.js');
let proofs: typeof import('../src/governance-activation/read-only.js');
let doctor: typeof import('../src/governance-activation/doctor.js');
let inspections: typeof import('../src/application/repository-governance/inspection.js');
let reporting: typeof import('../src/application/repository-governance/reporting.js');
let progress: typeof import('../src/application/repository-governance/progress.js');
let approvals: typeof import('../src/domain/governance/activation/approvals.js');
let validators: typeof import('../src/domain/governance/activation/validators.js');
let authority: typeof import('../src/governance-activation/authority-records.js');
let graph: typeof import('../src/domain/governance/activation/graph.js');
let snapshots: typeof import('../src/adapters/filesystem/standards-assessment/snapshot.js');
let processes: typeof import('../src/process-runner.js');
let locks: typeof import('../src/adapters/filesystem/project-lock.js');
let current: Fixture | undefined;
let applying = false;
const fixtures: Fixture[] = [];
const forbiddenReads: string[] = [];
const network = vi.fn(async () => { throw new Error('Historical consumer matrix forbids network effects.'); });

interface Fixture {
  parent: string;
  identity: Awaited<ReturnType<typeof lstat>>;
  project: string;
  home: string;
  otherHome: string;
  cwd: string;
  entry: CapturedActivation;
  originalState: HistoricalState;
  storage: UpdatePreviewOptions;
  readRunner: MatrixRunner;
  migrationRunner: MatrixRunner;
  protectedPaths: string[];
  passed: boolean;
}

const gitMetadata = new Set([
  'rev-parse --show-toplevel', 'rev-parse --verify HEAD', 'symbolic-ref --quiet --short HEAD',
  'remote', 'remote get-url --push --all origin'
]);
class MatrixRunner implements CommandRunner {
  readonly calls: ExternalCommand[] = [];
  readonly forbidden: ExternalCommand[] = [];
  private readonly reviewedChecks = new Set<string>();
  constructor(private readonly root: string, private readonly allowUnavailableChecks = false) {}
  allowReviewedChecks(checks: readonly { command: ExternalCommand; cwd: string }[]) {
    for (const check of checks) {
      if (check.command.executable === 'openspec' && check.command.args[0] === 'validate') {
        this.reviewedChecks.add(canonicalSha256(check));
      }
    }
  }
  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push(command);
    if (command.executable === 'git' && gitMetadata.has(command.args.join(' '))) {
      const top = command.args.join(' ') === 'rev-parse --show-toplevel';
      return { command, displayCommand: 'bounded fixture Git metadata', status: top ? 0 : 128,
        stdout: top ? this.root : '', stderr: '', signal: null, timedOut: false };
    }
    if (this.allowUnavailableChecks && this.reviewedChecks.has(canonicalSha256({
      command, cwd: options?.cwd ?? this.root
    }))) {
      return { command, displayCommand: 'unavailable local proof', status: 127, stdout: '',
        stderr: 'No installed local validation tool is qualified by this historical consumer fixture.', signal: null, timedOut: false };
    }
    this.forbidden.push(command);
    throw new Error(`Forbidden consumer command: ${command.executable} ${command.args.join(' ')}`);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected a structured production result.');
  return value;
}
function array(value: Record<string, unknown>, key: string): unknown[] {
  if (!Array.isArray(value[key])) throw new Error(`Expected production array ${key}.`);
  return value[key];
}
function protects(filename: string): boolean {
  return current?.protectedPaths.some((root) => filename === root || filename.startsWith(`${root}${path.sep}`)) ?? false;
}
function assertPublicRead(filename: string): void {
  if (protects(filename)) {
    forbiddenReads.push(filename);
    throw new Error('A consumer attempted to read or traverse retained private material.');
  }
}
async function privateFingerprint(root: string) {
  return (await capturedTree(root)).map(({ path: name, mode, bytes }) => ({
    path: name, mode, digest: createHash('sha256').update(Buffer.from(bytes, 'base64')).digest('hex')
  }));
}

beforeAll(async () => {
  cacheRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-historical-consumer-loader-')));
  cacheIdentity = await lstat(cacheRoot);
  loader = await createActivationSuccessorRuntime(path.join(cacheRoot, 'ssr'));
  [
    commands, argumentsApi, manifests, histories, historicalStates, stateFiles, proofs, doctor, inspections,
    reporting, progress, approvals, validators, authority, graph, snapshots, processes, locks
  ] = await Promise.all([
    '/src/commands.ts', '/src/args.ts', '/src/application/project/manifest.ts',
    '/src/governance-activation/migration-history.ts', '/src/governance-activation/historical-state.ts',
    '/src/governance-activation/activation-state.ts', '/src/governance-activation/read-only.ts',
    '/src/governance-activation/doctor.ts', '/src/application/repository-governance/inspection.ts',
    '/src/application/repository-governance/reporting.ts', '/src/application/repository-governance/progress.ts',
    '/src/domain/governance/activation/approvals.ts', '/src/domain/governance/activation/validators.ts',
    '/src/governance-activation/authority-records.ts', '/src/domain/governance/activation/graph.ts',
    '/src/adapters/filesystem/standards-assessment/snapshot.ts', '/src/process-runner.ts',
    '/src/adapters/filesystem/project-lock.ts'
  ].map((file) => loader.ssrLoadModule(file)));
}, 60_000);

beforeEach(() => {
  current = undefined;
  applying = false;
  forbiddenReads.length = 0;
  network.mockClear();
  vi.stubGlobal('fetch', network);
  vi.spyOn(processes.NodeCommandRunner.prototype, 'run').mockImplementation(async (command, options) => {
    if (!current) throw new Error('Unexpected process outside an owned consumer fixture.');
    return (applying ? current.migrationRunner : current.readRunner).run(command, options);
  });
  const read = snapshots.AssessmentSnapshot.prototype.read;
  const list = snapshots.AssessmentSnapshot.prototype.list;
  vi.spyOn(snapshots.AssessmentSnapshot.prototype, 'read').mockImplementation(async function (this: AssessmentSnapshot, parts, maximum) {
    assertPublicRead(path.join(this.root, ...parts));
    return read.call(this, parts, maximum);
  });
  vi.spyOn(snapshots.AssessmentSnapshot.prototype, 'list').mockImplementation(async function (this: AssessmentSnapshot, parts, maximum, withinBudget) {
    assertPublicRead(path.join(this.root, ...parts));
    return list.call(this, parts, maximum, withinBudget);
  });
});

async function removeOwnedDirectory(root: string, identity: Awaited<ReturnType<typeof lstat>>) {
  const actual = await lstat(root);
  if (!actual.isDirectory() || actual.isSymbolicLink() || await realpath(root) !== root ||
    actual.dev !== identity.dev || actual.ino !== identity.ino || actual.birthtimeMs !== identity.birthtimeMs) {
    throw new Error(`Owned fixture identity changed; preserve ${root}.`);
  }
  await rm(root, { recursive: true });
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (current?.passed) {
    for (const lock of [await locks.projectMutationLockPath(current.project), await locks.userScopeMutationLockPath(current.project)]) {
      try {
        await lstat(lock);
        current.passed = false;
        throw new Error(`An owned operation has not released its lock; preserve ${current.parent}.`);
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    await removeOwnedDirectory(current.parent, current.identity);
  } else if (current) {
    console.error(`Historical consumer fixture retained for diagnosis: ${current.parent}`);
  }
  current = undefined;
});
afterAll(async () => {
  await loader?.close();
  if (cacheRoot && fixtures.every((fixture) => fixture.passed)) await removeOwnedDirectory(cacheRoot, cacheIdentity);
  else if (cacheRoot) console.error(`Closed historical consumer loader cache retained for diagnosis: ${cacheRoot}`);
});

async function fixture(test: Case): Promise<Fixture> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-historical-consumer-')));
  const identity = await lstat(parent);
  const project = path.join(parent, 'project with spaces');
  const home = path.join(parent, 'selected private home'), otherHome = path.join(parent, 'unrelated private home');
  const cwd = path.join(parent, 'different invocation cwd');
  for (const directory of [project, home, otherHome, cwd]) await mkdir(directory, { mode: 0o700 });
  const entry = releasedCase(test.id);
  if (entry.family !== 'activation') throw new Error('Expected an immutable activation fixture.');
  await materializeReleasedFiles(project, entry.files);
  const stateEntry = entry.files.find((file) => file.path === 'governance/activation-state.json');
  if (!stateEntry) throw new Error('Captured source state is missing.');
  const originalState = historicalStates.validateReadableHistoricalActivationState(JSON.parse(releasedBytes(stateEntry).toString('utf8')));
  expect(originalState.schemaVersion).toBe(test.family);
  const protectedPaths = originalState.bootstrapState
    ? [...originalState.bootstrapState.encryptedStatePathParts, ...originalState.bootstrapState.encryptionKeyPathParts]
      .map((parts) => path.join(project, ...parts)) : [];
  if (originalState.bootstrapState?.status === 'retained') {
    for (const filename of protectedPaths) {
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await writeFile(filename, 'PRIVATE-MATRIX-SENTINEL: preserve but do not consume\n', { flag: 'wx', mode: 0o600 });
    }
  }
  const value: Fixture = {
    parent, identity, project, home, otherHome, cwd, entry, originalState,
    storage: { homedir: home, env: {}, repositoryRoot: project, clock: () => new Date() },
    readRunner: new MatrixRunner(project), migrationRunner: new MatrixRunner(project, true), protectedPaths, passed: false
  };
  current = value;
  fixtures.push(value);
  return value;
}

async function run(f: Fixture, args: string[], storage = f.storage, mutate = false) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  applying = mutate;
  try {
    const code = await commands.runCommand(argumentsApi.parseArgs(args), {
      cwd: f.cwd, stdout, stderr, runner: mutate ? f.migrationRunner : f.readRunner,
      storage, updatePreview: storage, updateNow: () => new Date(), env: {}
    });
    const text = stdout.text();
    return { code, text, err: stderr.text(), body: text.trim().startsWith('{') ? object(JSON.parse(text)) : undefined };
  } finally {
    applying = false;
  }
}
function governanceArgs(f: Fixture, operation: string, live = false) {
  return ['governance', operation, '--project', f.project, '--json',
    ...(operation === 'assess' ? live ? ['--live'] : [] : ['--scope', 'activation'])];
}
function noExternalEffects(f: Fixture) {
  expect(f.readRunner.forbidden).toEqual([]);
  expect(f.migrationRunner.forbidden).toEqual([]);
  expect(forbiddenReads).toEqual([]);
  expect(network).not.toHaveBeenCalled();
}
async function assertProtection(f: Fixture) {
  for (const filename of f.protectedPaths) {
    if (f.originalState.bootstrapState?.status === 'disposed') {
      await expect(lstat(filename)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(await readFile(filename, 'utf8')).toBe('PRIVATE-MATRIX-SENTINEL: preserve but do not consume\n');
    }
  }
}
async function assertOriginalHistory(f: Fixture, history: CurrentHistory, ancestors: readonly number[]) {
  expect(history.ancestorHistory.map((reference) => reference.sourceIdentity.activationContractVersion)).toEqual(ancestors);
  const copied = new Set(history.index.files.map((file) => file.originalPathParts.join('/')));
  for (const file of history.index.files) {
    const original = f.entry.files.find((entry) => entry.path === file.originalPathParts.join('/'));
    if (!original) throw new Error(`Unexpected history source ${file.originalPathParts.join('/')}.`);
    expect(file.digest).toBe(original.sha256);
    expect(file.mode).toBe(original.mode);
    expect(await readFile(path.join(f.project, ...file.copyPathParts))).toEqual(releasedBytes(original));
  }
  for (const original of f.entry.files.filter((file) => !copied.has(file.path))) {
    const filename = path.join(f.project, ...original.path.split('/'));
    expect(await readFile(filename)).toEqual(releasedBytes(original));
    expect((await lstat(filename)).mode & 0o7777).toBe(original.mode);
  }
  for (const reference of history.ancestorHistory) {
    const original = f.entry.files.find((file) => file.path === reference.historyIndexPathParts.join('/'));
    if (!original) throw new Error('An ancestor link was not present in the immutable source capture.');
    expect(reference.historyIndexDigest).toBe(original.sha256);
    expect(await readFile(path.join(f.project, ...reference.historyIndexPathParts))).toEqual(releasedBytes(original));
  }
  if (f.originalState.bootstrapState) {
    expect(history.lifecycleObligations).toContainEqual(expect.objectContaining({
      sourceIdentity: f.originalState.identity, retention: f.originalState.bootstrapState,
      verification: 'required', authority: 'historical-protection-only'
    }));
    expect(history.state.bootstrapState).toBeUndefined();
  }
  await assertProtection(f);
}

async function migrate(f: Fixture, test: Case) {
  const sourceManifest = await manifests.loadManifest(f.project);
  const before = await capturedTree(f.project);
  const checked = await run(f, ['update', '--project', f.project, '--check', '--json']);
  expect(checked.code, `${f.parent}\n${checked.text}${checked.err}`).toBe(2);
  const report = object(checked.body);
  expect(report).toMatchObject({
    committed: false, activationMigration: {
      status: 'available', sourceIdentity: { activationContractVersion: test.family },
      targetIdentity: graph.currentActivationIdentity
    }
  });
  expect(await capturedTree(f.project)).toEqual(before);
  const selected = array(report, 'plans').map(object).find((plan) => plan.mode === 'normal' && plan.eligible === true);
  if (!selected || typeof selected.fingerprint !== 'string') throw new Error('Missing real eligible update preview.');
  const revalidation = object(object(report.revalidation).preview);
  const reviewedChecks = array(revalidation, 'phases').map(object).flatMap((phase) => array(phase, 'commands').map((value) => {
    const check = object(value), command = object(check.command);
    if (typeof command.executable !== 'string' || !Array.isArray(command.args) ||
      !command.args.every((arg) => typeof arg === 'string') || !Array.isArray(check.cwdPathParts) ||
      !check.cwdPathParts.every((part) => typeof part === 'string')) {
      throw new Error('Malformed command in the real reviewed local preview.');
    }
    return { command: { executable: command.executable, args: command.args }, cwd: path.join(f.project, ...check.cwdPathParts) };
  }));
  f.migrationRunner.allowReviewedChecks(reviewedChecks);
  const committed = await run(f, ['update', '--project', f.project, '--approve-plan', selected.fingerprint, '--json'], f.storage, true);
  expect(committed.code, `${f.parent}\n${committed.text}${committed.err}`).toBe(2);
  expect(committed.body).toMatchObject({
    committed: true, activationMigration: { status: 'committed' }, revalidation: { status: 'blocked' }
  });
  const history = await histories.inspectActivationMigrationHistory(f.project, f.storage);
  if (history.status !== 'committed') throw new Error(`Missing committed history; preserve ${f.parent}.`);
  expect(history.state.identity).toEqual(graph.currentActivationIdentity);
  expect(history.state.remoteBinding).toBeUndefined();
  expect(Object.values(history.state.phases).every((phase) => phase.approvals.length === 0)).toBe(true);
  expect(Object.values(history.state.phases).some((phase) => ['approved', 'verified', 'retained', 'disposed'].includes(phase.state))).toBe(false);
  const oldIds = new Set(f.entry.files.filter((file) => file.path.startsWith('governance/evidence/'))
    .map((file) => path.basename(file.path, '.json')));
  for (const record of await proofs.readActivationEvidence(f.project)) {
    expect(record.header.identity).toEqual(graph.currentActivationIdentity);
    expect(record.header.result).not.toBe('verified');
    expect(oldIds.has(record.evidenceId)).toBe(false);
  }
  const manifest = await manifests.loadManifest(f.project);
  expect(manifest.artifactVersion).toBe(8);
  expect(manifest.project).toEqual(sourceManifest.project);
  expect(manifest.projectArtifacts).toEqual(sourceManifest.projectArtifacts);
  expect(manifest.framework).toEqual(sourceManifest.framework);
  if (manifest.artifactVersion !== 8 || manifest.provenance.kind !== 'generated' || manifest.provenance.origin.kind !== 'historical-manifest') {
    throw new Error('Current metadata lacks original historical provenance.');
  }
  const original = f.entry.files.find((file) => file.path === 'liftoff.manifest.json');
  if (!original) throw new Error('Missing captured source manifest.');
  expect(await readFile(path.join(f.project, ...manifest.provenance.origin.historyPathParts))).toEqual(releasedBytes(original));
  await assertOriginalHistory(f, history, test.ancestors);
  return history;
}

async function issueCurrentReadAuthority(f: Fixture) {
  const inspected = await inspections.inspectGovernance(f.project, f.readRunner, new Date(), { storage: f.storage, scope: 'activation' });
  const phase = graph.canonicalPhaseGraph.phases.find((phase) => phase.id === 'committed');
  if (!phase) throw new Error('Missing current publication phase.');
  const plan = fixturePlan(inspected.contexts[phase.id], inspected.state, new Date().toISOString(), {}, f.project);
  if (!plan.approval.envelopeId) throw new Error('Current fixture plan has no explicit approval identity.');
  const envelope = validators.validateApprovalEnvelope({
    ...approvals.approvalRequestForSavedPlan(plan, phase, inspected.state),
    schemaVersion: graph.currentActivationIdentity.approvalEnvelopeSchemaVersion,
    id: plan.approval.envelopeId, approver: 'fixture-owner',
    approvedAt: plan.createdAt, expiresAt: plan.expiresAt
  });
  expect(approvals.canonicalApprovalEnvelopeHash(envelope)).toBe(plan.approval.envelopeHash);
  await authority.writeGovernanceApprovalAuthority(f.project, canonicalSha256(plan), envelope, f.storage);
  const filename = path.join(f.project, 'governance', 'approvals', `${envelope.id}.json`);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(envelope, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await authority.assertGovernanceApprovalIssued(f.project, envelope, f.storage);
  return envelope;
}

describe('immutable historical consumer authority matrix', () => {
  it.each(cases)('keeps raw $id diagnostic in status/resume/verify/assessment/doctor from a different cwd', async (test) => {
    const f = await fixture(test);
    const before = await capturedTree(f.project);
    const privateBefore = await privateFingerprint(f.home);
    for (const operation of ['status', 'resume', 'verify']) {
      const result = await run(f, governanceArgs(f, operation));
      expect(result.code, `${f.parent}\n${result.text}${result.err}`).toBe(1);
      expect(result.text + result.err).toMatch(/diagnostic-only/);
    }
    for (const live of [false, true]) {
      const result = await run(f, governanceArgs(f, 'assess', live));
      expect(result.code, `${f.parent}\n${result.text}${result.err}`).toBe(2);
      expect(result.body).toMatchObject({
        readOnly: true, projectRoot: f.project,
        projectIdentity: { availability: 'unsupported', stateSource: 'unsupported', recordedActivationIdentity: f.originalState.identity },
        snapshot: { repository: null, inputsStable: true }
      });
      expect(array(object(result.body), 'diagnostics').map(object)).toContainEqual(expect.objectContaining({ code: 'activation-history-diagnostic-only' }));
      expect(array(object(result.body), 'findings').map(object).find((entry) => entry.controlId === 'evidence.governance')?.classification).toBe('not-observed');
    }
    const manifest = await manifests.loadManifest(f.project);
    const checks = await doctor.governanceDoctorChecks(f.project, manifest, new Date(), f.storage);
    expect(checks).toContainEqual(expect.objectContaining({
      id: 'governance-identity-incompatible', state: 'migration-available',
      detail: expect.stringContaining('not current execution proof')
    }));
    expect(await capturedTree(f.project)).toEqual(before);
    expect(await privateFingerprint(f.home)).toEqual(privateBefore);
    await assertProtection(f);
    noExternalEffects(f);
    f.passed = true;
  }, 60_000);

  it.each(cases)('binds reviewed $id to current read-only consumers without inheriting historical authority', async (test) => {
    const f = await fixture(test);
    const history = await migrate(f, test);
    const envelope = await issueCurrentReadAuthority(f);
    const before = await capturedTree(f.project);
    const privateBefore = await privateFingerprint(f.home);
    for (const operation of ['status', 'resume', 'verify']) {
      const result = await run(f, governanceArgs(f, operation));
      const missingSpecKitSeed = operation === 'verify' && test.id === 'activation-v2-disposed-spec-kit';
      expect(result.code, `${f.parent}\n${result.text}${result.err}`).toBe(operation === 'verify' ? missingSpecKitSeed ? 1 : 2 : 0);
      expect(result.body).toMatchObject({
        schemaVersion: 3, projectRoot: f.project, scope: 'activation', activationIdentity: graph.currentActivationIdentity,
        progress: { local: false, repository: false, activation: false, lifecycle: false },
        migrationSummary: { currentProofRequired: true, snapshot: { id: history.index.snapshotId } }
      });
      if (operation === 'verify') {
        expect(result.body).toMatchObject({ consistent: !missingSpecKitSeed, complete: false, ok: false });
        if (missingSpecKitSeed) {
          const failed = array(object(result.body), 'checks').map(object).filter((check) => check.status === 'failed');
          expect(failed).toEqual([expect.objectContaining({
            id: 'task-projection', issues: ['Spec Kit seed-adoption-required: real bootstrap tasks are missing.']
          })]);
          await expect(lstat(path.join(f.project, 'specs', '000-liftoff-bootstrap', 'tasks.md')))
            .rejects.toMatchObject({ code: 'ENOENT' });
        }
      }
      for (const value of array(object(result.body), 'nextActions')) {
        const action = object(value);
        expect(action.project).toBe(f.project);
        expect(action.cwd).toBe(f.project);
        expect(action.scope).toBe('activation');
      }
    }
    const assessment = await run(f, governanceArgs(f, 'assess'));
    expect(assessment.code, `${f.parent}\n${assessment.text}${assessment.err}`).toBe(2);
    expect(assessment.body).toMatchObject({
      projectIdentity: { availability: 'known', stateSource: 'user' }, snapshot: { inputsStable: true }
    });
    expect(array(object(assessment.body), 'diagnostics').map(object))
      .toContainEqual(expect.objectContaining({ code: 'activation-revalidation-blocked' }));
    const manifest = await manifests.loadManifest(f.project);
    const checks = await doctor.governanceDoctorChecks(f.project, manifest, new Date(), f.storage);
    expect(checks.some((entry) => entry.id === 'governance-identity-incompatible')).toBe(false);
    expect(checks).toContainEqual(expect.objectContaining({ id: 'governance-migration-progress', state: 'revalidation-blocked' }));
    if (f.originalState.bootstrapState) {
      const lifecycle = checks.find((entry) => entry.id.startsWith('governance-historical-lifecycle-'));
      expect(lifecycle?.state).toBe('current-binding-required');
      expect(lifecycle?.detail).toContain(f.originalState.bootstrapState.status === 'disposed'
        ? 'must not recreate' : f.originalState.bootstrapState.disposeAfter);
    }
    expect(await capturedTree(f.project)).toEqual(before);
    expect(await privateFingerprint(f.home)).toEqual(privateBefore);
    const checked = await run(f, ['update', '--project', f.project, '--check', '--json']);
    expect(checked.code, `${f.parent}\n${checked.text}${checked.err}`).toBe(2);
    expect(checked.body).toMatchObject({ committed: false, activationMigration: { status: 'committed', snapshotId: history.index.snapshotId } });
    expect(await capturedTree(f.project)).toEqual(before);
    const issuedAfterCheck = await privateFingerprint(f.home);
    const wrong = { ...f.storage, homedir: f.otherHome };
    await expect(stateFiles.loadActivationState(f.project, wrong)).rejects.toThrow(/no project-bound authority/);
    await expect(proofs.inspectCurrentActivationEvidence(f.project, manifest, {
      runner: f.readRunner, now: new Date(), storage: wrong
    })).rejects.toThrow(/no project-bound authority/);
    for (const operation of ['status', 'resume', 'verify']) {
      const rejected = await run(f, governanceArgs(f, operation), wrong);
      expect(rejected.code, `${f.parent}\n${rejected.text}${rejected.err}`).toBe(1);
      expect(rejected.text + rejected.err).toMatch(/no project-bound authority/);
    }
    const wrongAssessment = await run(f, governanceArgs(f, 'assess'), wrong);
    expect(wrongAssessment.code, `${f.parent}\n${wrongAssessment.text}${wrongAssessment.err}`).toBe(2);
    expect(wrongAssessment.body).toMatchObject({
      outcome: 'partial',
      projectIdentity: {
        availability: 'unsupported', stateSource: 'unsupported', recordedActivationIdentity: graph.currentActivationIdentity
      },
      snapshot: { repository: null }
    });
    const deniedDiagnostics = array(object(wrongAssessment.body), 'diagnostics').map(object);
    expect(deniedDiagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining('no project-bound authority') }));
    expect(array(object(wrongAssessment.body), 'findings').map(object).find((entry) => entry.controlId === 'evidence.governance')?.classification)
      .toBe('not-observed');
    const wrongDoctor = await doctor.governanceDoctorChecks(f.project, manifest, new Date(), wrong);
    expect(wrongDoctor).toContainEqual(expect.objectContaining({
      id: 'governance-identity-incompatible', detail: expect.stringContaining('no project-bound authority')
    }));
    expect(await capturedTree(f.project)).toEqual(before);
    expect(await privateFingerprint(f.home)).toEqual(issuedAfterCheck);
    expect(await privateFingerprint(f.otherHome)).toEqual([]);
    await authority.assertGovernanceApprovalIssued(f.project, envelope, f.storage);
    const again = await histories.inspectActivationMigrationHistory(f.project, f.storage);
    if (again.status !== 'committed') throw new Error('Read-only consumers lost committed history.');
    expect(again.journal.revalidation.status).toBe('blocked');
    await assertOriginalHistory(f, again, test.ancestors);
    noExternalEffects(f);
    f.passed = true;
  }, 90_000);

  it('projects repositoryComplete true and activationComplete false without fabricating provider qualification', async () => {
    const test = cases[0];
    const f = await fixture(test);
    await migrate(f, test);
    const actual = await inspections.inspectGovernance(f.project, f.readRunner, new Date(), { storage: f.storage, scope: 'activation' });
    const before = await capturedTree(f.project);
    const projected: GovernanceInspection = {
      ...actual, scope: 'repository',
      readiness: { ...actual.readiness, completion: { local: true, repository: true, activation: false, lifecycle: false } }
    };
    const report = reporting.statusJson(projected, 'status');
    expect(report).toMatchObject({ repositoryComplete: true, activationComplete: false, lifecycleComplete: false });
    expect(progress.setupCompletion(projected)).toMatchObject({
      complete: true, summary: expect.stringContaining('Cloud activation, production qualification and retained-state obligations remain separate')
    });
    expect(progress.setupCompletion({ ...projected, scope: 'activation' }).complete).toBe(false);
    expect(actual.readiness.completion.repository).toBe(false);
    expect(actual.state).toBe(projected.state);
    expect(actual.evidence).toBe(projected.evidence);
    expect(await capturedTree(f.project)).toEqual(before);
    noExternalEffects(f);
    f.passed = true;
  }, 90_000);
});
