import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRepairVerificationWorkspace, inspectRepairVerificationWorkspaces, recoverRepairVerificationWorkspaces,
  type CreateRepairVerificationWorkspaceOptions, type RepairWorkspaceRecord, type RepairWorkspaceStorageOptions
} from '../src/application/repair/workspaces.js';
import {
  openWorkspaceSeal, repairWorkspaceAuthorityKey, repairWorkspaceIndexKey, workspaceRecordKey, workspaceSeal
} from '../src/application/repair/workspaces-records.js';
import {
  createRepairWorkspaceRegistryStore, createScopedUserLocalRecordStore, getUpdatePreviewDirectory
} from '../src/adapters/filesystem/update-previews.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { repairExecutionIdentity } from '../src/domain/repair/identity.js';
import { liftoffVersion } from '../src/version.js';
import {
  TemporaryDirectories, ScriptedRunner, commandResult, createCommandFlowFixture, repairHuman, repairJson, snapshotTree
} from './fixtures/repair-branches.js';

const execute = promisify(execFile);
const directories = new TemporaryDirectories();
afterEach(async () => { await directories.cleanup(); });
const posix = process.platform !== 'win32';
const isCheck = (args: readonly string[]) => args.includes('--test');

describe('retained private verification workspaces gate the CLI until safely recovered', () => {
  it('blocks every new repair operation behind an unsettled workspace and never cleans it without proof', async () => {
    const f = await createCommandFlowFixture(await directories.make('lf ws cli '));
    const runner = new ScriptedRunner((call) => isCheck(call.command.args)
      ? commandResult(call.command, { processTreeSettled: false }) : undefined);
    const check = await repairJson(f.root, ['--check', '--application-patch', f.patch], { home: f.home, runner });
    const fingerprint = check.report.fingerprint!;
    const verified = await repairJson(f.root, ['--verify-plan', fingerprint], { home: f.home, runner });
    expect(verified.code).toBe(2);
    expect(verified.report).toMatchObject({ status: 'partial', committed: false });
    const retained = verified.report.verificationResult!.retainedWorkspace!;
    expect(verified.report.verificationResult).toMatchObject({ status: 'failed', cleanupComplete: false });
    expect(verified.report.blockers.join(' ')).toContain('[workspace-cleanup]');
    const copy = await snapshotTree(path.join(retained, 'project'));
    expect(copy[f.target.join('/')]).toBeDefined();
    const project = await snapshotTree(f.root);

    for (const args of [['--approve-plan', fingerprint], ['--verify-plan', fingerprint], ['--check', '--application-patch', f.patch]]) {
      const blocked = await repairJson(f.root, args, { home: f.home, runner });
      expect(blocked.code).toBe(2);
      expect(blocked.report).toMatchObject({ status: 'blocked', committed: false });
      expect(blocked.report.message).toBe('Retained private verification workspaces require explicit recovery.');
      expect(blocked.report.privateWorkspaces?.workspaces).toEqual([expect.objectContaining({
        directory: retained, owner: 'uncertain', uncertainCommands: 1,
        issues: expect.arrayContaining([expect.objectContaining({ code: 'owner-uncertain' })])
      })]);
      expect(blocked.report.nextActions.map((action) => action.id)).toEqual(['repair-recover']);
    }

    const recovery = await repairJson(f.root, ['--recover'], { home: f.home, runner });
    expect(recovery.code).toBe(2);
    expect(recovery.report).toMatchObject({ status: 'blocked', repairScopeComplete: false });
    expect(recovery.report.message).toContain('uncertain private workspaces were preserved');
    expect(recovery.report.privateWorkspaceRecovery).toMatchObject({ status: 'blocked', cleanupComplete: false });
    expect(recovery.report.privateWorkspaceRecovery!.results).toEqual([expect.objectContaining({ status: 'blocked', removedEntries: 0 })]);
    const human = await repairHuman(f.root, ['--recover'], { home: f.home, runner });
    expect(human.code).toBe(2);
    expect(human.stdout).toContain('Registered private verification workspaces');
    expect(human.stdout).toContain('owner uncertain');
    expect(human.stdout).toContain('Private cleanup outcomes');
    expect(await snapshotTree(path.join(retained, 'project'))).toEqual(copy);
    expect(await snapshotTree(f.root)).toEqual(project);
    expect(runner.effects().filter((call) => isCheck(call.command.args))).toHaveLength(1);
  });

  it('recovers a released workspace after a denied cleanup, then requires fresh verification before applying', async () => {
    const f = await createCommandFlowFixture(await directories.make('lf ws cli '));
    const runner = new ScriptedRunner();
    let deny = true;
    const storage: Pick<RepairWorkspaceStorageOptions, 'beforeWorkspaceOperation'> = {
      beforeWorkspaceOperation: async (operation) => {
        if (operation === 'unlink' && deny) {
          deny = false;
          throw Object.assign(new Error('simulated denied unlink'), { code: 'EACCES' });
        }
      }
    };
    const check = await repairJson(f.root, ['--check', '--application-patch', f.patch], { home: f.home, runner });
    const fingerprint = check.report.fingerprint!;
    const verified = await repairJson(f.root, ['--verify-plan', fingerprint], { home: f.home, runner, storage });
    expect(verified.code).toBe(2);
    expect(verified.report).toMatchObject({ status: 'partial', committed: false });
    expect(verified.report.blockers.join(' ')).toContain('[workspace-permission-denied]');
    const retained = verified.report.verificationResult!.retainedWorkspace!;
    expect((await lstat(retained)).isDirectory()).toBe(true);
    const project = await snapshotTree(f.root), staging = await snapshotTree(f.stage);

    const gated = await repairJson(f.root, ['--approve-plan', fingerprint], { home: f.home, runner });
    expect(gated.report.privateWorkspaces?.workspaces).toEqual([expect.objectContaining({ phase: 'cleanup-failed', owner: 'released' })]);
    expect(gated.code).toBe(2);

    const recovered = await repairJson(f.root, ['--recover'], { home: f.home, runner });
    expect(recovered.code).toBe(2);
    expect(recovered.report).toMatchObject({ status: 'recovered', repairScopeComplete: false });
    expect(recovered.report.message).toBe('Recovered recorded repair material. No new transformation was started.');
    expect(recovered.report.privateWorkspaceRecovery).toMatchObject({ status: 'complete', cleanupComplete: true, retained: [] });
    await expect(lstat(retained)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await snapshotTree(f.root)).toEqual(project);
    expect(await snapshotTree(f.stage)).toEqual(staging);
    const idle = await repairJson(f.root, ['--recover'], { home: f.home, runner });
    expect(idle).toMatchObject({ code: 0, report: { message: 'No interrupted local repair transaction exists.' } });

    const unverified = await repairJson(f.root, ['--approve-plan', fingerprint], { home: f.home, runner });
    expect(unverified.code).toBe(2);
    expect(unverified.report.message).toContain('File approval does not authorize project checks');
    expect((await repairJson(f.root, ['--verify-plan', fingerprint], { home: f.home, runner })).code).toBe(0);
    const applied = await repairJson(f.root, ['--approve-plan', fingerprint], { home: f.home, runner });
    expect(applied.code, applied.report.blockers.join('; ')).toBe(0);
    expect(await readFile(path.join(f.root, ...f.target), 'utf8')).toBe(f.sourceBytes);
    expect(runner.effects().filter((call) => isCheck(call.command.args))).toHaveLength(2);
  });
});

async function workspaceFixture() {
  const directory = await directories.make('lf ws id ');
  const repository = path.join(directory, 'repository');
  const project = path.join(repository, 'Project with spaces');
  const staging = path.join(directory, 'patch staging');
  const home = path.join(directory, 'home');
  await Promise.all([mkdir(path.join(repository, '.git'), { recursive: true }), mkdir(project, { recursive: true }),
    mkdir(staging), mkdir(home)]);
  await writeFile(path.join(project, 'application.ts'), 'export const preserved = true;\n');
  await writeFile(path.join(staging, 'replacement.ts'), 'export const preserved = false;\n');
  const storage: RepairWorkspaceStorageOptions = { homedir: home, env: { XDG_STATE_HOME: undefined, LOCALAPPDATA: undefined } };
  const request: CreateRepairVerificationWorkspaceOptions = {
    planFingerprint: canonicalSha256('exact reviewed repair'),
    repairIdentity: repairExecutionIdentity(liftoffVersion, 'application-layout-patch'),
    patchStagingRoot: staging,
    bindings: {
      inputDigest: canonicalSha256('inputs'), verificationPolicyDigest: canonicalSha256('checks'),
      providerDigest: canonicalSha256(null), toolchainDigest: canonicalSha256('tools')
    },
    approvedScopes: { projectCode: true, dependencyPreparation: false, network: false, lifecycle: false }
  };
  return { directory, project, staging, home, storage, request };
}
type WorkspaceFixture = Awaited<ReturnType<typeof workspaceFixture>>;

async function released(f: WorkspaceFixture) {
  const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
  await handle.releaseOwner();
  return handle;
}

async function authenticated(f: WorkspaceFixture, key: string, change: (value: Record<string, any>) => unknown) {
  const authority = await createScopedUserLocalRecordStore(f.project, 'repair-workspace-authority', f.storage).read(repairWorkspaceAuthorityKey);
  const secret = (authority!.value as { key: string }).key;
  const registry = createRepairWorkspaceRegistryStore(f.project, f.storage);
  const saved = await registry.read(key);
  const value = openWorkspaceSeal(saved!.value, secret) as Record<string, any>;
  const replacement = change(value) ?? workspaceSeal(value, secret);
  await registry.compareExchange(key, saved!.digest, replacement);
}

async function expectRetainedAfterRecovery(f: WorkspaceFixture, directory: string, code?: string) {
  const before = await snapshotTree(directory);
  const recovery = await recoverRepairVerificationWorkspaces(f.project, f.storage);
  expect(recovery.status).toBe('blocked');
  expect(recovery.cleanupComplete).toBe(false);
  const issues = [...recovery.issues, ...recovery.results.flatMap((entry) => entry.issues), ...recovery.retained.flatMap((entry) => entry.issues)];
  if (code) expect(issues.map((issue) => issue.code)).toContain(code);
  expect(await snapshotTree(directory)).toEqual(before);
  return recovery;
}

describe('private workspace boundaries are exact native identities', () => {
  it('refuses simulated platform storage and non-normalized boundaries before any private write', async () => {
    const f = await workspaceFixture();
    const before = await snapshotTree(f.directory);
    await expect(createRepairVerificationWorkspace(f.project, f.request, {
      ...f.storage, platform: process.platform === 'win32' ? 'linux' : 'win32'
    })).rejects.toMatchObject({ code: 'unsupported-record' });
    await expect(createRepairVerificationWorkspace(`${f.project}${path.sep}..${path.sep}${path.basename(f.project)}`, f.request, f.storage))
      .rejects.toMatchObject({ code: 'unsafe-path' });
    expect(await snapshotTree(f.directory)).toEqual(before);
  });

  it.each(['project', 'staging'] as const)('blocks recovery after the bound %s directory is replaced', async (which) => {
    const f = await workspaceFixture();
    const handle = await released(f);
    const original = which === 'project' ? f.project : f.staging;
    await rename(original, `${original} moved`);
    await mkdir(original);
    await writeFile(path.join(original, 'replacement.txt'), 'not the reviewed directory\n');
    await expectRetainedAfterRecovery(f, handle.directory, 'scope-mismatch');
    expect(await readFile(path.join(original, 'replacement.txt'), 'utf8')).toBe('not the reviewed directory\n');
    expect((await readdir(`${original} moved`)).length).toBeGreaterThan(0);
  });

  it('does not treat a vanished ready workspace as cleaned', async () => {
    const f = await workspaceFixture();
    const handle = await released(f);
    await rm(handle.directory, { recursive: true });
    const recovery = await recoverRepairVerificationWorkspaces(f.project, f.storage);
    expect(recovery).toMatchObject({ status: 'blocked', cleanupComplete: false });
    expect(recovery.results).toEqual([expect.objectContaining({ status: 'blocked', issues: [expect.objectContaining({ code: 'workspace-missing' })] })]);
    expect(recovery.retained).toEqual([expect.objectContaining({ workspaceId: handle.workspaceId })]);
  });

  it('records a workspace removed after a failed cleanup as cleaned without deleting anything else', async () => {
    const f = await workspaceFixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, {
      ...f.storage, beforeWorkspaceOperation: async (operation) => {
        if (operation === 'unlink' || operation === 'rmdir') throw Object.assign(new Error('simulated busy'), { code: 'EBUSY' });
      }
    });
    await writeFile(path.join(handle.roles.scratch, 'output.txt'), 'private output\n');
    await handle.releaseOwner();
    expect(await handle.cleanup()).toMatchObject({ status: 'incomplete', cleanupComplete: false, retained: true });
    await rm(handle.directory, { recursive: true });
    const recovery = await recoverRepairVerificationWorkspaces(f.project, f.storage);
    expect(recovery).toMatchObject({ status: 'complete', cleanupComplete: true, retained: [] });
    expect(await readFile(path.join(f.project, 'application.ts'), 'utf8')).toBe('export const preserved = true;\n');
    expect(await readFile(path.join(f.staging, 'replacement.ts'), 'utf8')).toBe('export const preserved = false;\n');
  });

  it('blocks recovery when a registered role disappears from a ready workspace', async () => {
    const f = await workspaceFixture();
    const handle = await released(f);
    await rm(handle.roles.cache, { recursive: true });
    await expectRetainedAfterRecovery(f, handle.directory, 'workspace-missing');
  });

  it('preserves unregistered entries beside the fixed roles instead of deleting them', async () => {
    const f = await workspaceFixture();
    const handle = await released(f);
    await writeFile(path.join(handle.directory, 'unregistered.txt'), 'not owned by the workspace record\n');
    await expectRetainedAfterRecovery(f, handle.directory, 'unsafe-path');
    expect(await readFile(path.join(handle.directory, 'unregistered.txt'), 'utf8')).toBe('not owned by the workspace record\n');
  });

  it('refuses cleanup through a private output link to the workspace or its ancestors', async () => {
    const f = await workspaceFixture();
    const handle = await released(f);
    await symlink(path.dirname(handle.directory), path.join(handle.roles.scratch, 'ancestor-link'), 'junction');
    await expectRetainedAfterRecovery(f, handle.directory, 'unsafe-path');
    expect((await lstat(path.join(handle.roles.scratch, 'ancestor-link'))).isSymbolicLink()).toBe(true);
  });

  it.skipIf(!posix)('refuses special files instead of opening or deleting them (Windows unrun)', async () => {
    const f = await workspaceFixture();
    const handle = await released(f);
    await execute('mkfifo', [path.join(handle.roles.scratch, 'pipe')]);
    await expectRetainedAfterRecovery(f, handle.directory, 'unsafe-path');
    expect((await lstat(path.join(handle.roles.scratch, 'pipe'))).isFIFO()).toBe(true);
  });

  it.skipIf(!posix)('stops at the cleanup depth budget without partial deletion (Windows unrun)', async () => {
    const f = await workspaceFixture();
    const handle = await released(f);
    await mkdir(path.join(handle.roles.scratch, ...Array<string>(65).fill('d')), { recursive: true });
    await expectRetainedAfterRecovery(f, handle.directory, 'limits-exceeded');
  });

  it('keeps one consistent registry when workspaces are allocated concurrently', async () => {
    const f = await workspaceFixture();
    const outcomes = await Promise.allSettled([1, 2, 3].map(() => createRepairVerificationWorkspace(f.project, f.request, f.storage)));
    const created = outcomes.flatMap((outcome) => outcome.status === 'fulfilled' ? [outcome.value] : []);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') expect(['registry-busy', 'registry-unavailable']).toContain((outcome.reason as { code: string }).code);
    }
    expect(created.length).toBeGreaterThan(0);
    const inspection = await inspectRepairVerificationWorkspaces(f.project, f.storage);
    expect(inspection.workspaces.map((entry) => entry.workspaceId).sort()).toEqual(created.map((entry) => entry.workspaceId).sort());
    for (const handle of created) {
      await handle.releaseOwner();
      expect((await handle.cleanup()).cleanupComplete).toBe(true);
    }
    expect((await inspectRepairVerificationWorkspaces(f.project, f.storage)).status).toBe('absent');
  });
});

describe('registry state stays exact through partial, full and interrupted recovery', () => {
  it('reports partial recovery when one workspace cleans and another must be retained', async () => {
    const f = await workspaceFixture();
    const clean = await released(f);
    const blocked = await released(f);
    await writeFile(path.join(blocked.directory, 'unregistered.txt'), 'preserve me\n');
    const recovery = await recoverRepairVerificationWorkspaces(f.project, f.storage);
    expect(recovery).toMatchObject({ status: 'partial', cleanupComplete: false });
    expect(Object.fromEntries(recovery.results.map((entry) => [entry.workspaceId, entry.status]))).toEqual({
      [clean.workspaceId]: 'cleaned', [blocked.workspaceId]: 'blocked'
    });
    await expect(lstat(clean.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(blocked.directory, 'unregistered.txt'), 'utf8')).toBe('preserve me\n');
    expect(recovery.retained.map((entry) => entry.workspaceId)).toEqual([blocked.workspaceId]);
  });

  it('refuses new allocation when the bounded registry is full and never invents records for listed identities', async () => {
    const f = await workspaceFixture();
    const existing = await released(f);
    const listed = Array.from({ length: 255 }, (_, index) => canonicalSha256(`listed-${index}`));
    await authenticated(f, repairWorkspaceIndexKey, (index) => { index.workspaces = [...index.workspaces, ...listed]; });
    const before = await snapshotTree(path.dirname(existing.directory));
    await expect(createRepairVerificationWorkspace(f.project, f.request, f.storage)).rejects.toMatchObject({ code: 'limits-exceeded' });
    expect(await snapshotTree(path.dirname(existing.directory))).toEqual(before);
    const inspection = await inspectRepairVerificationWorkspaces(f.project, f.storage);
    expect(inspection.status).toBe('blocked');
    expect(inspection.workspaces.map((entry) => entry.workspaceId)).toEqual([existing.workspaceId]);
    expect(inspection.issues).toHaveLength(255);
    expect(new Set(inspection.issues.map((issue) => issue.code))).toEqual(new Set(['registry-invalid']));
    await authenticated(f, repairWorkspaceIndexKey, (index) => { index.workspaces = [...index.workspaces, canonicalSha256('one too many')]; });
    const overflow = await inspectRepairVerificationWorkspaces(f.project, f.storage);
    expect(overflow).toMatchObject({ status: 'blocked', workspaces: [] });
    expect(overflow.issues.map((issue) => issue.code)).toEqual(['limits-exceeded']);
    expect((await lstat(existing.directory)).isDirectory()).toBe(true);
  });

  it('retires a cleaned workspace still listed after an interrupted index update, but not an occupied path', async () => {
    const f = await workspaceFixture();
    const handle = await released(f);
    expect((await handle.cleanup()).cleanupComplete).toBe(true);
    await authenticated(f, repairWorkspaceIndexKey, (index) => { index.workspaces = [handle.workspaceId]; });
    expect(await recoverRepairVerificationWorkspaces(f.project, f.storage)).toMatchObject({ status: 'complete', cleanupComplete: true });
    expect((await inspectRepairVerificationWorkspaces(f.project, f.storage)).status).toBe('absent');

    await mkdir(handle.directory, { mode: 0o700 });
    await writeFile(path.join(handle.directory, 'replacement.txt'), 'not the cleaned workspace\n');
    await authenticated(f, repairWorkspaceIndexKey, (index) => { index.workspaces = [handle.workspaceId]; });
    await expectRetainedAfterRecovery(f, handle.directory, 'identity-changed');
    expect(await readFile(path.join(handle.directory, 'replacement.txt'), 'utf8')).toBe('not the cleaned workspace\n');
  });

  it('refuses an invalid clock and unsupported checkpoints without changing recorded progress', async () => {
    const f = await workspaceFixture();
    await expect(createRepairVerificationWorkspace(f.project, f.request, { ...f.storage, clock: () => new Date(Number.NaN) }))
      .rejects.toMatchObject({ code: 'invalid-request' });
    expect((await inspectRepairVerificationWorkspaces(f.project, f.storage)).status).toBe('absent');
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    await expect(handle.checkpoint('cleaning' as never)).rejects.toMatchObject({ code: 'invalid-request' });
    expect((await inspectRepairVerificationWorkspaces(f.project, f.storage)).workspaces).toEqual([
      expect.objectContaining({ phase: 'ready', lastCheckpoint: 'ready', owner: 'active' })
    ]);
    await handle.releaseOwner();
    expect((await handle.cleanup()).cleanupComplete).toBe(true);
  });

  it.each<[string, (file: string, value: Record<string, unknown>) => Promise<void>, string]>([
    ['missing', async (file) => rm(file), 'unauthenticated-record'],
    ['bound to another project', async (file, value) => writeFile(file, JSON.stringify({ ...value, projectRoot: path.join(String(value.projectRoot), 'other') })), 'scope-mismatch'],
    ['from a future schema', async (file, value) => writeFile(file, JSON.stringify({ ...value, schemaVersion: 2 })), 'unsupported-record']
  ])('keeps workspaces retained when their authority record is %s', async (_name, tamper, code) => {
    const f = await workspaceFixture();
    const handle = await released(f);
    const storageDirectory = getUpdatePreviewDirectory({ homedir: f.home, env: {} });
    const [name] = (await readdir(storageDirectory)).filter((entry) => entry.startsWith('repair-workspace-authority-'));
    const file = path.join(storageDirectory, name!);
    await tamper(file, JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>);
    await expectRetainedAfterRecovery(f, handle.directory, code);
    expect((await inspectRepairVerificationWorkspaces(f.project, f.storage)).issues.map((issue) => issue.code)).toContain(code);
  });
});

describe('authenticated workspace records still need internally consistent authority', () => {
  const activity = (id: string) => ({ id, kind: 'verification', commandDigest: canonicalSha256('check'), network: false, lifecycle: false });
  it.each<[string, (record: RepairWorkspaceRecord) => void, string]>([
    ['an unsupported phase', (record) => { (record as { phase: string }).phase = 'exploded'; }, 'unsupported-record'],
    ['a cleanup phase used as a checkpoint', (record) => { (record as { lastCheckpoint: string }).lastCheckpoint = 'cleaning'; }, 'unsupported-record'],
    ['an invalid owner PID', (record) => { record.owner.processId = 0; }, 'registry-invalid'],
    ['an unsupported owner state', (record) => { (record.owner as { state: string }).state = 'orphaned'; }, 'unsupported-record'],
    ['an unbounded in-flight inventory', (record) => {
      record.owner = { ...record.owner, state: 'active', release: null };
      record.activities = { started: 33, settled: 0, uncertain: 0, inFlight: Array.from({ length: 33 }, (_, index) => activity(canonicalSha256(index))) } as never;
    }, 'limits-exceeded'],
    ['a duplicate in-flight activity', (record) => {
      record.owner = { ...record.owner, state: 'active', release: null };
      record.activities = { started: 2, settled: 0, uncertain: 0, inFlight: [activity('b'.repeat(64)), activity('b'.repeat(64))] } as never;
    }, 'registry-invalid'],
    ['activity counts that do not balance', (record) => { record.activities.started = 5; }, 'registry-invalid'],
    ['a release that hides an uncertain command', (record) => { record.activities = { ...record.activities, started: 1, uncertain: 1 }; }, 'owner-uncertain'],
    ['a release proof on an unreleased owner', (record) => { record.owner.state = 'active'; }, 'registry-invalid'],
    ['cleanup completion outside the cleaned phase', (record) => { record.cleanup.complete = true; }, 'registry-invalid'],
    ['progress that predates creation', (record) => { record.updatedAt = '2000-01-01T00:00:00.000Z'; }, 'registry-invalid'],
    ['an unparseable timestamp', (record) => { record.createdAt = 'yesterday'; }, 'registry-invalid'],
    ['a ready workspace without creation identity', (record) => { record.creationIdentity = null; }, 'registry-invalid'],
    ['a ready role without creation identity', (record) => { record.roles.home.identity = null; }, 'registry-invalid'],
    ['a malformed owner token', (record) => { record.owner.tokenDigest = 'not-a-digest'; }, 'invalid-request'],
    ['a non-positive revision', (record) => { record.revision = 0; }, 'registry-invalid'],
    ['a relative staging root', (record) => { record.patchStagingRoot = 'patch staging'; }, 'unsafe-path'],
    ['a non-numeric file identity', (record) => { record.projectIdentity = { ...record.projectIdentity, inode: 'inode' }; }, 'registry-invalid'],
    ['an unsupported in-flight activity', (record) => {
      record.owner = { ...record.owner, state: 'active', release: null };
      record.activities = { started: 1, settled: 0, uncertain: 0, inFlight: [{ ...activity('c'.repeat(64)), kind: 'deployment' }] } as never;
    }, 'invalid-request']
  ])('refuses %s and retains the directory', async (_name, change, code) => {
    const f = await workspaceFixture();
    const handle = await released(f);
    await authenticated(f, workspaceRecordKey(handle.workspaceId), (value) => { change(value as RepairWorkspaceRecord); });
    await expectRetainedAfterRecovery(f, handle.directory, code);
  });

  it.each<[string, (index: Record<string, any>) => void, string]>([
    ['duplicate workspace identities', (index) => { index.workspaces = [index.workspaces[0], index.workspaces[0]]; }, 'registry-invalid'],
    ['another project root', (index) => { index.projectRoot = path.join(index.projectRoot, 'other'); }, 'scope-mismatch']
  ])('refuses an authenticated index with %s', async (_name, change, code) => {
    const f = await workspaceFixture();
    const handle = await released(f);
    await authenticated(f, repairWorkspaceIndexKey, (value) => { change(value); });
    await expectRetainedAfterRecovery(f, handle.directory, code);
  });

  it('refuses an unsupported authentication envelope without trusting its payload', async () => {
    const f = await workspaceFixture();
    const handle = await released(f);
    await authenticated(f, workspaceRecordKey(handle.workspaceId), (value) => ({
      schemaVersion: 2, kind: 'liftoff-repair-workspace-seal', payload: value, mac: canonicalSha256('unverified')
    }));
    await expectRetainedAfterRecovery(f, handle.directory, 'unsupported-record');
  });
});
