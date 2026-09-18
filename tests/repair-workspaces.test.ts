import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRepairVerificationWorkspace, inspectRepairVerificationWorkspaces, recoverRepairVerificationWorkspaces,
  getRepairWorkspaceRoot, type CreateRepairVerificationWorkspaceOptions, type RepairWorkspaceRecord,
  type RepairWorkspaceStorageOptions, type RepairVerificationWorkspace
} from '../src/application/repair/workspaces.js';
import {
  openWorkspaceSeal, repairWorkspaceAuthorityKey, repairWorkspaceIndexKey, workspaceRecordKey, workspaceSeal
} from '../src/application/repair/workspaces-records.js';
import {
  createRepairWorkspaceRegistryStore, createScopedUserLocalRecordStore,
  nodeUpdatePreviewFileSystem
} from '../src/adapters/filesystem/update-previews.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { repairExecutionIdentity } from '../src/domain/repair/identity.js';
import { liftoffVersion } from '../src/version.js';
import { NodeCommandRunner, type CommandResult } from '../src/process-runner.js';

const roots: string[] = [];
const retained = new Set<string>();
const activity = {
  kind: 'verification' as const, commandDigest: canonicalSha256('reviewed command'),
  network: false, lifecycle: false
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (!retained.has(root)) await rm(root, { recursive: true, force: true });
  }
});

async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const target = path.join(entry.parentPath, entry.name);
    result[path.relative(root, target)] = (await readFile(target)).toString('base64');
  }
  return result;
}

async function fixture() {
  const directory = await mkdtemp(path.resolve('.repair-workspaces-'));
  roots.push(directory);
  const repository = path.join(directory, 'repository');
  const project = path.join(repository, 'Project with spaces');
  const staging = path.join(directory, 'patch staging');
  const home = path.join(directory, 'home');
  await Promise.all([mkdir(path.join(repository, '.git'), { recursive: true }),
    mkdir(project, { recursive: true }), mkdir(staging), mkdir(home)]);
  await writeFile(path.join(project, 'liftoff.manifest.json'), '{invalid manifest: this service must not read it}\n');
  await writeFile(path.join(project, 'application.ts'), 'export const preserved = true;\n');
  await writeFile(path.join(staging, 'patch.json'), '{"untrusted":"not workspace authority"}\n');
  await writeFile(path.join(staging, 'replacement.ts'), 'export const preserved = false;\n');
  await mkdir(path.join(home, 'global-cache'));
  await writeFile(path.join(home, 'global-cache', 'never-delete.txt'), 'global cache remains\n');
  const storage: RepairWorkspaceStorageOptions = {
    homedir: home, env: { XDG_STATE_HOME: undefined, LOCALAPPDATA: undefined }
  };
  const request: CreateRepairVerificationWorkspaceOptions = {
    planFingerprint: canonicalSha256('exact reviewed repair'),
    repairIdentity: repairExecutionIdentity(liftoffVersion, 'application-layout-patch'),
    patchStagingRoot: staging,
    bindings: {
      inputDigest: canonicalSha256('exact source and stage inventory'),
      verificationPolicyDigest: canonicalSha256('exact checks'),
      providerDigest: canonicalSha256(null),
      toolchainDigest: canonicalSha256('exact installed tools')
    },
    approvedScopes: { projectCode: true, dependencyPreparation: false, network: false, lifecycle: false }
  };
  return { directory, repository, project, staging, home, storage, request };
}

type WorkspaceFixture = Awaited<ReturnType<typeof fixture>>;

async function recordFor(
  fixture: WorkspaceFixture, workspace: Pick<RepairVerificationWorkspace, 'workspaceId'>
) {
  const authority = await createScopedUserLocalRecordStore(fixture.project, 'repair-workspace-authority', fixture.storage)
    .read(repairWorkspaceAuthorityKey);
  const key = (authority!.value as { key: string }).key;
  const registry = createRepairWorkspaceRegistryStore(fixture.project, fixture.storage);
  const saved = await registry.read(workspaceRecordKey(workspace.workspaceId));
  return {
    registry, saved: saved!, key,
    record: openWorkspaceSeal(saved!.value, key) as RepairWorkspaceRecord
  };
}

async function mutateAuthenticated(
  fixture: WorkspaceFixture, workspace: Pick<RepairVerificationWorkspace, 'workspaceId'>,
  change: (record: RepairWorkspaceRecord) => void
) {
  const { registry, saved, key, record } = await recordFor(fixture, workspace);
  change(record);
  await registry.compareExchange(workspaceRecordKey(workspace.workspaceId), saved.digest, workspaceSeal(record, key));
}

describe('private repair workspace registration', () => {
  it('creates fixed private roles only after authenticated registration and preserves project/staging/backup bytes', async () => {
    const f = await fixture();
    const projectBefore = await tree(f.project);
    const stageBefore = await tree(f.staging);
    const backup = createScopedUserLocalRecordStore(f.project, 'repair-backup', f.storage);
    const backupKey = canonicalSha256('original byte backup');
    const beforeBackup = await backup.write(backupKey, { kind: 'original-backup', bytes: 'private original bytes' });
    const backupBytes = await readFile(beforeBackup.path);
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    expect(path.relative(getRepairWorkspaceRoot(f.storage), handle.directory).startsWith('..')).toBe(false);
    expect(Object.keys(handle.roles)).toEqual(['project', 'home', 'cache', 'scratch']);
    for (const role of ['project', 'home', 'cache', 'scratch'] as const) {
      expect(handle.roles[role]).toBe(path.join(handle.directory, role));
      const details = await lstat(handle.roles[role]);
      expect(details.isDirectory()).toBe(true);
      expect(details.isSymbolicLink()).toBe(false);
      if (process.platform !== 'win32') expect(details.mode & 0o777).toBe(0o700);
    }
    const initial = await recordFor(f, handle);
    expect(initial.record).toMatchObject({
      schemaVersion: 1, kind: 'liftoff-repair-workspace', projectRoot: f.project,
      directory: handle.directory, phase: 'ready', bindings: f.request.bindings,
      approvedScopes: f.request.approvedScopes, owner: { state: 'active', release: null }
    });
    expect(initial.record.creationIdentity).toEqual(expect.objectContaining({
      device: expect.any(String), inode: expect.any(String), birthtime: expect.any(String)
    }));
    await handle.checkpoint('copying');
    let commandResult: CommandResult | undefined;
    let value: number;
    try {
      value = await handle.runOwned(activity, async () => {
        const registered = await recordFor(f, handle);
        expect(registered.record.activities).toMatchObject({ started: 1, settled: 0 });
        expect(registered.record.activities.inFlight).toHaveLength(1);
        commandResult = await new NodeCommandRunner().run({
          executable: process.execPath,
          args: ['-e', "require('node:fs').writeFileSync('effect.txt', 'approved private effect\\n')"]
        }, {
          cwd: handle.roles.project, timeoutMs: 5_000, maxOutputBytes: 1024,
          env: { SystemRoot: process.env.SystemRoot },
          ensureProcessTreeSettled: true
        });
        if (commandResult.processTreeSettled !== true) retained.add(f.directory);
        return { value: 42, allKnownCommandsSettled: commandResult.processTreeSettled === true };
      });
    } catch (error) {
      if (commandResult?.processTreeSettled !== true) retained.add(f.directory);
      throw new Error(`Native workspace execution failed; cwd length=${handle.roles.project.length}, code=${commandResult?.errorCode ?? 'no-result'}, retained=${retained.has(f.directory)}; ${commandResult?.errorMessage ?? 'No runner diagnostic.'}`, { cause: error });
    }
    expect(commandResult?.status, `${commandResult?.errorCode ?? ''}: ${commandResult?.errorMessage ?? ''}; cwd length=${handle.roles.project.length}`).toBe(0);
    expect(await readFile(path.join(handle.roles.project, 'effect.txt'), 'utf8')).toBe('approved private effect\n');
    expect(value).toBe(42);
    await handle.checkpoint('verified');
    await handle.releaseOwner();
    expect((await inspectRepairVerificationWorkspaces(f.project, f.storage)).workspaces[0]).toMatchObject({
      phase: 'verified', owner: 'released', commandsStarted: 1, commandsSettled: 1
    });
    const cleaned = await handle.cleanup();
    expect(cleaned).toMatchObject({ status: 'cleaned', cleanupComplete: true, retained: false, issues: [] });
    await expect(lstat(handle.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await inspectRepairVerificationWorkspaces(f.project, f.storage)).status).toBe('absent');
    expect(await tree(f.project)).toEqual(projectBefore);
    expect(await tree(f.staging)).toEqual(stageBefore);
    expect(await readFile(beforeBackup.path)).toEqual(backupBytes);
    expect(await readFile(path.join(f.home, 'global-cache', 'never-delete.txt'), 'utf8')).toBe('global cache remains\n');
    const historical = await recordFor(f, handle);
    expect(historical.record).toMatchObject({
      phase: 'cleaned', cleanup: { complete: true }, owner: { state: 'released', release: { allKnownCommandsSettled: true } }
    });
  });

  it('reads absence without creating private state and ignores project JSON claiming arbitrary workspace ownership', async () => {
    const f = await fixture();
    const before = await tree(f.directory);
    expect(await inspectRepairVerificationWorkspaces(f.project, f.storage)).toMatchObject({
      status: 'absent', workspaces: [], issues: []
    });
    expect(await recoverRepairVerificationWorkspaces(f.project, f.storage)).toMatchObject({
      status: 'absent', cleanupComplete: true, results: [], issues: []
    });
    expect(await tree(f.directory)).toEqual(before);
  });

  it.runIf(process.platform === 'win32')('preserves over-limit workspace records and recovers only through their original storage', async () => {
    const f = await fixture();
    const originalStorage = {
      ...f.storage, env: { LOCALAPPDATA: path.join(f.home, 'long-state-location-'.repeat(3)) }
    };
    const handle = await createRepairVerificationWorkspace(f.project, f.request, originalStorage);
    expect(handle.roles.project.length).toBeGreaterThan(258);
    const originalBytes = await tree(f.home);
    const result = await new NodeCommandRunner().run({
      executable: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync('must-not-exist.txt', 'unapproved')"]
    }, { cwd: handle.roles.project, ensureProcessTreeSettled: true, timeoutMs: 5_000 });
    expect(result).toMatchObject({
      status: null, errorCode: 'WINDOWS_CWD_TOO_LONG', processSpawned: false, processTreeSettled: true
    });
    expect(await tree(f.home)).toEqual(originalBytes);
    const shorterStorage = { ...f.storage, env: { LOCALAPPDATA: path.join(f.home, 'state') } };
    expect((await inspectRepairVerificationWorkspaces(f.project, shorterStorage)).status).toBe('absent');
    expect((await recoverRepairVerificationWorkspaces(f.project, shorterStorage)).status).toBe('absent');
    expect(await tree(f.home)).toEqual(originalBytes);
    expect((await inspectRepairVerificationWorkspaces(f.project, originalStorage)).workspaces[0])
      .toMatchObject({ workspaceId: handle.workspaceId, owner: 'active', commandsStarted: 0 });
    await handle.releaseOwner();
    expect((await recoverRepairVerificationWorkspaces(f.project, originalStorage)).cleanupComplete).toBe(true);
    await expect(lstat(handle.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['project', 'staging'])('rejects storage overlapping %s before private metadata writes', async (which) => {
    const f = await fixture();
    const before = await tree(f.directory);
    const storage = { ...f.storage, homedir: which === 'project' ? f.project : f.staging };
    await expect(createRepairVerificationWorkspace(f.project, f.request, storage)).rejects.toThrow();
    expect(await tree(f.directory)).toEqual(before);
  });

  it.each([
    { projectCode: false, dependencyPreparation: false, network: false, lifecycle: false },
    { projectCode: true, dependencyPreparation: 'yes', network: false, lifecycle: false }
  ])('rejects absent or malformed effect permissions before registration', async (scopes) => {
    const f = await fixture();
    const before = await tree(f.directory);
    await expect(createRepairVerificationWorkspace(f.project, {
      ...f.request, approvedScopes: scopes as CreateRepairVerificationWorkspaceOptions['approvedScopes']
    }, f.storage)).rejects.toThrow(/scope|permission/i);
    expect(await tree(f.directory)).toEqual(before);
  });

  it('rejects arbitrary caller directory fields and accepts no runtime manifest authority', async () => {
    const f = await fixture();
    await expect(createRepairVerificationWorkspace(f.project, {
      ...f.request, directory: f.staging
    } as CreateRepairVerificationWorkspaceOptions, f.storage)).rejects.toThrow(/unsupported fields/);
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    await rm(path.join(f.project, 'liftoff.manifest.json'));
    await handle.releaseOwner();
    expect((await recoverRepairVerificationWorkspaces(f.project, f.storage)).status).toBe('complete');
    await expect(lstat(handle.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('authenticated owner release', () => {
  it('blocks cleanup while an owned command is pending and never probes or kills a PID', async () => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    const kill = vi.spyOn(process, 'kill');
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const command = handle.runOwned(activity, async () => {
      enter();
      await waiting;
      return { value: true, allKnownCommandsSettled: true };
    });
    await entered;
    await expect(handle.releaseOwner()).rejects.toThrow(/active or uncertain/);
    expect(await handle.cleanup()).toMatchObject({
      status: 'blocked', cleanupComplete: false, issues: [{ code: 'owner-active', message: expect.any(String) }]
    });
    expect((await recoverRepairVerificationWorkspaces(f.project, f.storage)).cleanupComplete).toBe(false);
    finish();
    await command;
    await handle.releaseOwner();
    expect((await handle.cleanup()).cleanupComplete).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

  it.each(['unproven-result', 'thrown-operation'])('retains unknown ownership after %s', async (mode) => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    await expect(handle.runOwned(activity, async () => {
      await writeFile(path.join(handle.roles.scratch, 'prior-effect'), 'an effect already happened\n');
      if (mode === 'thrown-operation') throw new Error('unknown child settlement');
      return { value: false, allKnownCommandsSettled: false };
    })).rejects.toMatchObject({ code: 'owner-uncertain' });
    await expect(handle.releaseOwner()).rejects.toMatchObject({ code: 'owner-uncertain' });
    const report = await recoverRepairVerificationWorkspaces(f.project, f.storage);
    expect(report).toMatchObject({ status: 'blocked', cleanupComplete: false });
    expect(report.retained[0]).toMatchObject({ owner: 'uncertain', commandsStarted: 1, uncertainCommands: 1 });
    expect(await readFile(path.join(handle.roles.scratch, 'prior-effect'), 'utf8')).toContain('already happened');
  });

  it.each([
    { kind: 'preparation' as const, network: false, lifecycle: false },
    { kind: 'verification' as const, network: true, lifecycle: false },
    { kind: 'verification' as const, network: false, lifecycle: true }
  ])('does not invoke operations outside $kind/$network/$lifecycle authority', async (effects) => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    const operation = vi.fn(async () => ({ value: true, allKnownCommandsSettled: true }));
    await expect(handle.runOwned({ ...activity, ...effects }, operation)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(operation).not.toHaveBeenCalled();
    expect((await recordFor(f, handle)).record.activities.started).toBe(0);
    await handle.releaseOwner();
    expect((await handle.cleanup()).cleanupComplete).toBe(true);
  });

  it('allows separately scoped preparation without conferring file-transaction authority', async () => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, {
      ...f.request, approvedScopes: { projectCode: true, dependencyPreparation: true, network: true, lifecycle: false }
    }, f.storage);
    await handle.runOwned({ ...activity, kind: 'preparation', network: true }, async () => {
      await writeFile(path.join(handle.roles.cache, 'private-package'), 'private dependency bytes\n');
      return { value: undefined, allKnownCommandsSettled: true };
    });
    await handle.releaseOwner();
    expect((await handle.cleanup()).cleanupComplete).toBe(true);
    expect(await readFile(path.join(f.project, 'application.ts'), 'utf8')).toBe('export const preserved = true;\n');
  });

  it('retains failed-check progress after known commands settle and cleanup succeeds', async () => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    const outcome = await handle.runOwned(activity, async () => ({
      value: { passed: false }, allKnownCommandsSettled: true
    }));
    expect(outcome.passed).toBe(false);
    await handle.checkpoint('failed');
    await handle.releaseOwner();
    expect((await handle.cleanup()).cleanupComplete).toBe(true);
    expect((await recordFor(f, handle)).record).toMatchObject({
      phase: 'cleaned', lastCheckpoint: 'failed', activities: { started: 1, settled: 1 }
    });
  });

  it('cannot launch or checkpoint new effects after owner release', async () => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    await handle.releaseOwner();
    const operation = vi.fn(async () => ({ value: true, allKnownCommandsSettled: true }));
    await expect(handle.runOwned(activity, operation)).rejects.toMatchObject({ code: 'owner-uncertain' });
    await expect(handle.checkpoint('verifying')).rejects.toMatchObject({ code: 'owner-uncertain' });
    expect(operation).not.toHaveBeenCalled();
    expect((await handle.cleanup()).cleanupComplete).toBe(true);
  });

  it('does not infer stopped ownership from PID reuse, dead-parent claims or old timestamps', async () => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    await handle.releaseOwner();
    await mutateAuthenticated(f, handle, (record) => {
      record.owner = { ...record.owner, state: 'active', processId: 2_000_000_000, release: null };
      record.createdAt = '2000-01-01T00:00:00.000Z';
      record.updatedAt = '2000-01-01T00:00:00.000Z';
    });
    const kill = vi.spyOn(process, 'kill');
    const report = await recoverRepairVerificationWorkspaces(f.project, f.storage);
    expect(report).toMatchObject({ status: 'blocked', cleanupComplete: false });
    expect(report.retained[0]?.issues).toContainEqual(expect.objectContaining({ code: 'owner-uncertain' }));
    expect((await lstat(handle.directory)).isDirectory()).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('record and creation-identity confinement', () => {
  it.each(['schema', 'contract', 'recipe', 'cli', 'role-path', 'project-root', 'birthtime'])(
    'refuses a correctly authenticated but unsupported or changed %s record', async (change) => {
      const f = await fixture();
      const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
      await handle.releaseOwner();
      const before = await tree(handle.directory);
      await mutateAuthenticated(f, handle, (record) => {
        if (change === 'schema') (record as { schemaVersion: number }).schemaVersion = 2;
        if (change === 'contract') (record.repairIdentity as { repairContractVersion: number }).repairContractVersion = 2;
        if (change === 'recipe') (record.repairIdentity.recipe as { version: number }).version = 2;
        if (change === 'cli') record.repairIdentity.cliVersion = '999.0.0';
        if (change === 'role-path') record.roles.cache.path = f.staging;
        if (change === 'project-root') record.projectRoot = f.staging;
        if (change === 'birthtime') record.creationIdentity!.birthtime = (BigInt(record.creationIdentity!.birthtime) + 1n).toString();
      });
      expect((await recoverRepairVerificationWorkspaces(f.project, f.storage)).cleanupComplete).toBe(false);
      expect(await tree(handle.directory)).toEqual(before);
    }
  );

  it('rejects forged release JSON without the external authentication key', async () => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    const { registry, saved, record } = await recordFor(f, handle);
    record.owner = {
      ...record.owner, state: 'released', release: { releasedAt: record.createdAt, allKnownCommandsSettled: true }
    };
    await registry.compareExchange(workspaceRecordKey(handle.workspaceId), saved.digest, {
      schemaVersion: 1, kind: 'liftoff-repair-workspace-seal', payload: record, mac: '0'.repeat(64)
    });
    const report = await recoverRepairVerificationWorkspaces(f.project, f.storage);
    expect(report.cleanupComplete).toBe(false);
    expect(report.results[0]?.issues[0]?.code).toBe('unauthenticated-record');
    expect((await lstat(handle.directory)).isDirectory()).toBe(true);
  });

  it('refuses copying a valid sibling record to another workspace key', async () => {
    const f = await fixture();
    const first = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    const second = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    await first.releaseOwner();
    await second.releaseOwner();
    const a = await recordFor(f, first), b = await recordFor(f, second);
    await b.registry.compareExchange(workspaceRecordKey(second.workspaceId), b.saved.digest, a.saved.value);
    expect(await second.cleanup()).toMatchObject({ cleanupComplete: false, issues: [{ code: 'scope-mismatch', message: expect.any(String) }] });
    expect((await lstat(first.directory)).isDirectory()).toBe(true);
    expect((await lstat(second.directory)).isDirectory()).toBe(true);
  });

  it('rejects cross-project authenticated records instead of reading project JSON for authority', async () => {
    const a = await fixture(), b = await fixture();
    const source = await createRepairVerificationWorkspace(a.project, a.request, a.storage);
    const destination = await createRepairVerificationWorkspace(b.project, b.request, b.storage);
    await source.releaseOwner();
    await destination.releaseOwner();
    const from = await recordFor(a, source), to = await recordFor(b, destination);
    await to.registry.compareExchange(workspaceRecordKey(destination.workspaceId), to.saved.digest, from.saved.value);
    expect((await recoverRepairVerificationWorkspaces(b.project, b.storage)).cleanupComplete).toBe(false);
    expect((await lstat(source.directory)).isDirectory()).toBe(true);
    expect((await lstat(destination.directory)).isDirectory()).toBe(true);
  });

  it.each(['workspace', 'role'])('refuses changed %s directory identities before deletion', async (where) => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    await handle.releaseOwner();
    const target = where === 'workspace' ? handle.directory : handle.roles.cache;
    const original = path.join(f.directory, `original-${where}`);
    await rename(target, original);
    await mkdir(target);
    await writeFile(path.join(target, 'replacement'), 'unowned replacement\n');
    expect((await handle.cleanup()).cleanupComplete).toBe(false);
    expect(await readFile(path.join(target, 'replacement'), 'utf8')).toBe('unowned replacement\n');
    expect((await lstat(original)).isDirectory()).toBe(true);
  });

  it.each(['workspace', 'role'])('refuses a %s link/junction and leaves its target intact', async (where) => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    await handle.releaseOwner();
    const target = where === 'workspace' ? handle.directory : handle.roles.cache;
    await rename(target, path.join(f.directory, `registered-${where}`));
    await symlink(f.staging, target, process.platform === 'win32' ? 'junction' : 'dir');
    const before = await tree(f.staging);
    expect((await handle.cleanup()).cleanupComplete).toBe(false);
    expect(await tree(f.staging)).toEqual(before);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
  });

  it('rejects unsafe workspace ancestors and preserves source/staging targets', async () => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    await handle.releaseOwner();
    const parent = path.dirname(handle.directory);
    await rename(parent, path.join(f.directory, 'original-workspace-parent'));
    await symlink(f.staging, parent, process.platform === 'win32' ? 'junction' : 'dir');
    const before = await tree(f.staging);
    expect((await handle.cleanup()).cleanupComplete).toBe(false);
    expect(await tree(f.staging)).toEqual(before);
    expect((await lstat(parent)).isSymbolicLink()).toBe(true);
  });

  it('rejects a role case alias on both case-sensitive and case-insensitive filesystems', async () => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    await handle.releaseOwner();
    const renamed = path.join(handle.directory, 'CACHE');
    await rename(handle.roles.cache, renamed);
    await writeFile(path.join(renamed, 'preserve'), 'case alias is not ownership\n');
    expect((await handle.cleanup()).cleanupComplete).toBe(false);
    expect(await readFile(path.join(renamed, 'preserve'), 'utf8')).toBe('case alias is not ownership\n');
  });

  it.skipIf(process.platform === 'win32')('refuses a private storage ancestor whose access was broadened', async () => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    await handle.releaseOwner();
    await chmod(path.dirname(handle.directory), 0o777);
    expect(await handle.cleanup()).toMatchObject({
      cleanupComplete: false, retained: true, issues: [{ code: 'permission-denied', message: expect.any(String) }]
    });
    expect((await lstat(handle.directory)).isDirectory()).toBe(true);
  });

  it('refuses external descendant links and multiply linked files without changing their targets', async () => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    await handle.releaseOwner();
    const external = path.join(handle.roles.cache, 'external');
    await symlink(f.staging, external, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await handle.cleanup()).cleanupComplete).toBe(false);
    await rm(external);
    await link(path.join(f.project, 'application.ts'), path.join(handle.roles.project, 'hard-link'));
    expect((await handle.cleanup()).cleanupComplete).toBe(false);
    expect(await readFile(path.join(f.project, 'application.ts'), 'utf8')).toBe('export const preserved = true;\n');
  });

  it.skipIf(process.platform === 'win32')('unlinks safe internal npm-style executable links without following or editing targets', async () => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    const module = path.join(handle.roles.project, 'node_modules', 'example');
    const bins = path.join(handle.roles.project, 'node_modules', '.bin');
    await mkdir(module, { recursive: true });
    await mkdir(bins);
    await writeFile(path.join(module, 'cli.js'), '#!/usr/bin/env node\n');
    await symlink(path.join('..', 'example', 'cli.js'), path.join(bins, 'example'));
    await chmod(module, 0o500);
    await handle.releaseOwner();
    expect((await handle.cleanup()).cleanupComplete).toBe(true);
    await expect(lstat(handle.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('safely unlinks external interpreter leaf links and internal workspace hardlinks without touching external files', async () => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    const externalTool = path.join(f.directory, 'external-python');
    await writeFile(externalTool, '#!/usr/bin/env python3\n');
    const venvBin = path.join(handle.roles.project, '.venv', 'bin');
    await mkdir(venvBin, { recursive: true });
    await symlink(externalTool, path.join(venvBin, 'python'));
    const cacheFile = path.join(handle.roles.cache, 'cached-dep');
    await writeFile(cacheFile, 'internal cached content\n');
    await link(cacheFile, path.join(handle.roles.project, 'hardlinked-dep'));
    await handle.releaseOwner();
    expect((await handle.cleanup()).cleanupComplete).toBe(true);
    await expect(lstat(handle.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(externalTool, 'utf8')).toBe('#!/usr/bin/env python3\n');
  });
});

describe('cleanup progress and safe recovery', () => {
  it('cleans a nontrivial private dependency/output inventory without persisting its bytes in records', async () => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    for (let group = 0; group < 5; group++) {
      const target = path.join(handle.roles.cache, `group-${group}`);
      await mkdir(target);
      await Promise.all(Array.from({ length: 50 }, (_, index) =>
        writeFile(path.join(target, `entry-${index}`), 'private package/output fixture bytes\n')
      ));
    }
    await handle.releaseOwner();
    const result = await handle.cleanup();
    expect(result).toMatchObject({ cleanupComplete: true, retained: false });
    expect(result.removedEntries).toBeGreaterThan(250);
    const saved = await recordFor(f, handle);
    expect(JSON.stringify(saved.record)).not.toContain('private package/output fixture bytes');
    expect((await readFile(saved.saved.path)).byteLength).toBeLessThan(64 * 1024);
  }, 30_000);

  it('retains authenticated progress after an I/O failure and recovers without rerunning code', async () => {
    const f = await fixture();
    let fail = true;
    const handle = await createRepairVerificationWorkspace(f.project, f.request, {
      ...f.storage,
      beforeWorkspaceOperation: async (operation, target) => {
        if (fail && operation === 'rmdir' && path.basename(target) === 'project') {
          throw Object.assign(new Error('injected I/O failure'), { code: 'EIO' });
        }
      }
    });
    await writeFile(path.join(handle.roles.project, 'effect.txt'), 'already verified\n');
    await handle.releaseOwner();
    const failed = await handle.cleanup();
    expect(failed).toMatchObject({ status: 'incomplete', cleanupComplete: false, retained: true });
    expect(failed.removedEntries).toBeGreaterThan(0);
    const kept = await recordFor(f, handle);
    expect(kept.record).toMatchObject({ phase: 'cleanup-failed', owner: { state: 'released' }, cleanup: { complete: false } });
    fail = false;
    const recovered = await recoverRepairVerificationWorkspaces(f.project, f.storage);
    expect(recovered).toMatchObject({ status: 'complete', cleanupComplete: true, retained: [] });
    expect((await recordFor(f, handle)).record.activities.started).toBe(0);
    await expect(lstat(handle.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports denied cleanup without deleting private output or claiming success', async () => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, {
      ...f.storage,
      beforeWorkspaceOperation: async (operation) => {
        if (operation === 'scan') throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
    });
    await writeFile(path.join(handle.roles.cache, 'retained'), 'private output\n');
    await handle.releaseOwner();
    expect(await handle.cleanup()).toMatchObject({
      cleanupComplete: false, retained: true, removedEntries: 0,
      issues: [{ code: 'permission-denied', message: expect.any(String) }]
    });
    expect(await readFile(path.join(handle.roles.cache, 'retained'), 'utf8')).toBe('private output\n');
    expect((await recordFor(f, handle)).record.phase).toBe('cleanup-failed');
  });

  it('blocks concurrent recovery while the exact cleanup lease is held', async () => {
    const f = await fixture();
    let checked = false;
    const handle = await createRepairVerificationWorkspace(f.project, f.request, {
      ...f.storage,
      beforeWorkspaceOperation: async (operation) => {
        if (operation !== 'unlink' || checked) return;
        checked = true;
        const concurrent = await recoverRepairVerificationWorkspaces(f.project, f.storage);
        expect(concurrent.cleanupComplete).toBe(false);
        expect(concurrent.results[0]?.issues).toContainEqual(expect.objectContaining({ code: 'owner-uncertain' }));
      }
    });
    await writeFile(path.join(handle.roles.project, 'output'), 'private output\n');
    await handle.releaseOwner();
    expect((await handle.cleanup()).cleanupComplete).toBe(true);
    expect(checked).toBe(true);
  });

  it('rechecks authenticated owner release after a metadata race before deletion', async () => {
    const f = await fixture();
    let changed = false;
    let workspace: RepairVerificationWorkspace;
    const handle = await createRepairVerificationWorkspace(f.project, f.request, {
      ...f.storage,
      beforeWorkspaceOperation: async (operation) => {
        if (operation !== 'unlink' || changed) return;
        changed = true;
        await mutateAuthenticated(f, workspace, (record) => {
          record.owner = { ...record.owner, state: 'active', release: null };
        });
      }
    });
    workspace = handle;
    const output = path.join(handle.roles.project, 'output');
    await writeFile(output, 'must remain\n');
    await handle.releaseOwner();
    expect((await handle.cleanup()).cleanupComplete).toBe(false);
    expect(await readFile(output, 'utf8')).toBe('must remain\n');
    expect((await inspectRepairVerificationWorkspaces(f.project, f.storage)).status).toBe('blocked');
  });

  it('rechecks creation identity after a cleanup boundary race before deleting anything', async () => {
    const f = await fixture();
    let changed = false;
    let registered = '';
    const handle = await createRepairVerificationWorkspace(f.project, f.request, {
      ...f.storage,
      beforeWorkspaceOperation: async (operation, target) => {
        if (operation !== 'scan' || target !== registered || changed) return;
        changed = true;
        await rename(target, path.join(f.directory, 'moved-private-workspace'));
        await mkdir(target);
        await writeFile(path.join(target, 'unowned'), 'replacement bytes\n');
      }
    });
    registered = handle.directory;
    await handle.releaseOwner();
    const result = await handle.cleanup();
    expect(result.cleanupComplete).toBe(false);
    expect(await readFile(path.join(handle.directory, 'unowned'), 'utf8')).toBe('replacement bytes\n');
  });

  it.each(['root', 'role'] as const)('refuses %s replacement at scan boundary, preserving replacement marker and retaining recovery record', async (targetKind) => {
    const f = await fixture();
    let replaced = false;
    let targetPath = '';
    const replacementDir = path.join(f.directory, `replacement-${targetKind}`);
    await mkdir(replacementDir, { mode: 0o700 });
    const markerFile = path.join(replacementDir, 'marker.txt');
    await writeFile(markerFile, 'replacement marker content\n', { mode: 0o600 });
    const backupPath = path.join(f.directory, `backup-${targetKind}`);

    const handle = await createRepairVerificationWorkspace(f.project, f.request, {
      ...f.storage,
      beforeWorkspaceOperation: async (operation, target) => {
        if (!replaced && operation === 'scan' && target === handle.directory) {
          replaced = true;
          await rename(targetPath, backupPath);
          await rename(replacementDir, targetPath);
        }
      }
    });
    targetPath = targetKind === 'root' ? handle.directory : handle.roles.cache;
    await handle.releaseOwner();
    const result = await handle.cleanup();
    expect(result.cleanupComplete).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'identity-changed' }));
    expect(await readFile(path.join(targetPath, 'marker.txt'), 'utf8')).toBe('replacement marker content\n');
    const inspection = await inspectRepairVerificationWorkspaces(f.project, f.storage);
    expect(['blocked', 'retained']).toContain(inspection.status);
    expect(inspection.workspaces).toContainEqual(expect.objectContaining({
      workspaceId: handle.workspaceId, cleanupComplete: false
    }));
  });

  it('refuses external hardlink introduced between peer unlinks before permission changes, preserving external marker/mode', async () => {
    const f = await fixture();
    const externalFile = path.join(f.directory, 'external-peer-link');
    let peerBPath = '';
    let linked = false;
    let modeAtLinkTime: number | undefined;

    const handle = await createRepairVerificationWorkspace(f.project, f.request, {
      ...f.storage,
      beforeWorkspaceOperation: async (operation, target) => {
        if (!linked && operation === 'unlink' && target === peerBPath) {
          linked = true;
          await link(peerBPath, externalFile);
          const statBefore = await lstat(externalFile);
          modeAtLinkTime = Number(statBefore.mode & 0o777);
        }
      }
    });
    const peerA = path.join(handle.roles.cache, 'peer-a');
    const peerB = path.join(handle.roles.project, 'peer-b');
    peerBPath = peerB;
    await writeFile(peerA, 'shared private bytes\n');
    await link(peerA, peerB);
    await chmod(peerB, 0o444);
    await handle.releaseOwner();

    const result = await handle.cleanup();
    expect(result.cleanupComplete).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'identity-changed' }));
    expect(linked).toBe(true);
    expect(await readFile(externalFile, 'utf8')).toBe('shared private bytes\n');
    const statAfter = await lstat(externalFile);
    expect(Number(statAfter.mode & 0o777)).toBe(modeAtLinkTime);
    const inspection = await inspectRepairVerificationWorkspaces(f.project, f.storage);
    expect(inspection.status).toBe('retained');
    expect(inspection.workspaces).toContainEqual(expect.objectContaining({
      workspaceId: handle.workspaceId, cleanupComplete: false
    }));
  });

  it('refuses cleanup when a peer parent is moved outside and replaced with a junction before first unlink, requiring 0 unlinks and preserving mode', async () => {
    const f = await fixture();
    const outsideDir = path.join(f.directory, 'outside-moved-parent');
    let peerAPath = '';
    let nestedBPath = '';
    let hijacked = false;

    const handle = await createRepairVerificationWorkspace(f.project, f.request, {
      ...f.storage,
      beforeWorkspaceOperation: async (operation, target) => {
        if (!hijacked && operation === 'unlink' && target === peerAPath) {
          hijacked = true;
          await rename(nestedBPath, outsideDir);
          await symlink(outsideDir, nestedBPath, process.platform === 'win32' ? 'junction' : 'dir');
        }
      }
    });
    const dirA = path.join(handle.roles.cache, 'dir-a');
    const nestedB = path.join(handle.roles.project, 'nested-b');
    const dirB = path.join(nestedB, 'dir-b');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const peerA = path.join(dirA, 'peer-a');
    const peerB = path.join(dirB, 'peer-b');
    peerAPath = peerA;
    nestedBPath = nestedB;
    await writeFile(peerA, 'shared readonly hardlink bytes\n');
    await link(peerA, peerB);
    await chmod(peerB, 0o444);
    await handle.releaseOwner();

    const result = await handle.cleanup();
    expect(result.cleanupComplete).toBe(false);
    expect(result.removedEntries).toBe(0);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: expect.stringMatching(/identity-changed|unsafe-path/) }));
    expect(hijacked).toBe(true);

    const movedPeerB = path.join(outsideDir, 'dir-b', 'peer-b');
    expect(await readFile(movedPeerB, 'utf8')).toBe('shared readonly hardlink bytes\n');
    const statMoved = await lstat(movedPeerB);
    expect(Number(statMoved.mode & 0o777)).toBe(0o444);
    expect(await readFile(peerA, 'utf8')).toBe('shared readonly hardlink bytes\n');

    const inspection = await inspectRepairVerificationWorkspaces(f.project, f.storage);
    expect(['blocked', 'retained']).toContain(inspection.status);
    expect(inspection.workspaces).toContainEqual(expect.objectContaining({
      workspaceId: handle.workspaceId, cleanupComplete: false
    }));
  });

  it('retains a stale cleanup lease rather than deleting it using PID or age', async () => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    await handle.releaseOwner();
    const { saved } = await recordFor(f, handle);
    const projectKey = path.basename(path.dirname(handle.directory));
    const lease = path.join(path.dirname(saved.path), `repair-workspace-cleanup-${projectKey}-${handle.workspaceId}.lock`);
    await writeFile(lease, JSON.stringify({ pid: 2_000_000_000, createdAt: '2000-01-01' }), { mode: 0o600 });
    const bytes = await readFile(lease);
    expect((await recoverRepairVerificationWorkspaces(f.project, f.storage)).cleanupComplete).toBe(false);
    expect(await readFile(lease)).toEqual(bytes);
    expect((await lstat(handle.directory)).isDirectory()).toBe(true);
  });

  it('keeps an allocating record if registry writes fail after directory creation', async () => {
    const f = await fixture();
    let fail = false;
    const storage: RepairWorkspaceStorageOptions = {
      ...f.storage,
      fileSystem: {
        ...nodeUpdatePreviewFileSystem,
        replaceFile: async (from, to) => {
          if (fail) throw Object.assign(new Error('registry unavailable'), { code: 'EIO' });
          await nodeUpdatePreviewFileSystem.replaceFile(from, to);
        }
      },
      beforeWorkspaceOperation: async (operation) => { if (operation === 'mkdir') fail = true; }
    };
    await expect(createRepairVerificationWorkspace(f.project, f.request, storage)).rejects.toThrow(/uncertain/);
    const report = await inspectRepairVerificationWorkspaces(f.project, f.storage);
    expect(report).toMatchObject({ status: 'blocked' });
    expect(report.workspaces).toHaveLength(1);
    expect(report.workspaces[0]).toMatchObject({ phase: 'allocating', owner: 'uncertain' });
    expect((await recoverRepairVerificationWorkspaces(f.project, f.storage)).cleanupComplete).toBe(false);
  });

  it('does not recreate an index deleted after authenticated registration', async () => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    await handle.releaseOwner();
    const registry = createRepairWorkspaceRegistryStore(f.project, f.storage);
    const index = await registry.read(repairWorkspaceIndexKey);
    await rm(index!.path);
    expect((await inspectRepairVerificationWorkspaces(f.project, f.storage)).status).toBe('blocked');
    await expect(createRepairVerificationWorkspace(f.project, f.request, f.storage)).rejects.toThrow(/without its index/);
    expect((await lstat(handle.directory)).isDirectory()).toBe(true);
  });

  it('rejects an authenticated future index without discovering cleanup paths by filenames', async () => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    await handle.releaseOwner();
    const { registry, key } = await recordFor(f, handle);
    const saved = await registry.read(repairWorkspaceIndexKey);
    const index = openWorkspaceSeal(saved!.value, key) as { schemaVersion: number };
    index.schemaVersion = 2;
    await registry.compareExchange(repairWorkspaceIndexKey, saved!.digest, workspaceSeal(index, key));
    const result = await recoverRepairVerificationWorkspaces(f.project, f.storage);
    expect(result).toMatchObject({
      cleanupComplete: false, results: [], issues: [{ code: 'unsupported-record', message: expect.any(String) }]
    });
    expect((await lstat(handle.directory)).isDirectory()).toBe(true);
  });
});

describe('storage compatibility and portable paths', () => {
  it('preserves existing scoped fingerprint isolation with shared private storage inside checkout-based fixtures', async () => {
    const f = await fixture();
    const other = path.join(f.repository, 'other-project');
    await mkdir(other);
    const key = canonicalSha256('same original governance fingerprint');
    const store = createScopedUserLocalRecordStore(f.project, 'governance-preview', f.storage);
    await store.write(key, { project: 'first' });
    expect(await createScopedUserLocalRecordStore(other, 'governance-preview', f.storage).read(key)).toBeNull();
    await expect(store.read('../outside.json')).rejects.toThrow(/SHA-256/);
    await expect(store.write(key, { huge: 'x'.repeat(65 * 1024) })).rejects.toThrow();
    expect((await store.read(key))?.value).toEqual({ project: 'first' });
  });

  it('provides CAS only in the new namespace and preserves existing immutable previews and backups', async () => {
    const f = await fixture();
    const key = canonicalSha256('identical metadata key');
    const preview = createScopedUserLocalRecordStore(f.project, 'repair-preview', f.storage);
    const backup = createScopedUserLocalRecordStore(f.project, 'repair-backup', f.storage);
    await preview.write(key, { preserved: 'preview' });
    await backup.write(key, { preserved: 'backup' });
    const registry = createRepairWorkspaceRegistryStore(f.project, f.storage);
    const initial = await registry.compareExchange(key, null, { mutableWorkspaceOnly: 1 });
    const next = await registry.compareExchange(key, initial.digest, { mutableWorkspaceOnly: 2 });
    await expect(registry.compareExchange(key, initial.digest, { mutableWorkspaceOnly: 3 })).rejects.toThrow(/compare-and-exchange/);
    expect((await registry.read(key))?.digest).toBe(next.digest);
    await expect(preview.write(key, { replaced: true })).rejects.toThrow(/Refusing to replace different/);
    await expect(backup.write(key, { replaced: true })).rejects.toThrow(/Refusing to replace different/);
    expect((await preview.read(key))?.value).toEqual({ preserved: 'preview' });
    expect((await backup.read(key))?.value).toEqual({ preserved: 'backup' });
    await expect(registry.compareExchange(canonicalSha256('oversized'), null, { data: 'x'.repeat(65 * 1024) }))
      .rejects.toThrow(/size limit/);
  });

  it('keeps inspect/recovery payload-free and never emits authority keys, command output or project contents', async () => {
    const f = await fixture();
    const handle = await createRepairVerificationWorkspace(f.project, f.request, f.storage);
    await writeFile(path.join(handle.roles.project, 'private-data'), 'PRIVATE-PROJECT-PAYLOAD');
    const { key } = await recordFor(f, handle);
    const report = JSON.stringify(await inspectRepairVerificationWorkspaces(f.project, f.storage));
    expect(report).not.toContain(key);
    expect(report).not.toContain('PRIVATE-PROJECT-PAYLOAD');
    expect(report).not.toContain('invalid manifest');
    expect(report).not.toContain('tokenDigest');
    expect(report).not.toContain('patch staging');
  });

  it('formats fixed native Windows and POSIX roots without claiming a Windows execution', () => {
    const windows = getRepairWorkspaceRoot({ platform: 'win32', homedir: 'C:\\Users\\Developer', env: {} });
    expect(windows).toContain(path.win32.join('C:\\Users\\Developer', 'AppData', 'Local'));
    expect(windows.endsWith(path.win32.join('repair-workspaces'))).toBe(true);
    const linux = getRepairWorkspaceRoot({ platform: 'linux', homedir: '/home/developer', env: {} });
    expect(linux).toContain(path.posix.join('/home/developer', '.local', 'state'));
    expect(linux.endsWith(path.posix.join('repair-workspaces'))).toBe(true);
  });
});
