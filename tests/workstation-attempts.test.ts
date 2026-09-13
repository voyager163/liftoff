import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWorkstationNoProgressStore,
  workstationNoProgressKey,
  WorkstationAttemptStoreError,
  type WorkstationNoProgressReceipt
} from '../src/adapters/filesystem/workstation-attempts.js';
import {
  createScopedUserLocalRecordStore,
  nodeUpdatePreviewFileSystem,
  type UpdatePreviewFileSystem,
  type UpdatePreviewOptions
} from '../src/adapters/filesystem/update-previews.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';
import {
  installRequirement,
  probeRequirement,
  type ExecutableIdentity,
  type ExecutableObserver,
  type InstallContext,
  type NoProgressRemediationAttempt,
  type SelectedRequirement,
  type WorkstationNoProgressStore
} from '../src/workstation.js';
import { workstationRequirementCatalog } from '../src/workstation-catalog.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const recipeId = 'node:darwin:brew:upgrade';
const inputFingerprint = 'a'.repeat(64);
const unchanged: NoProgressRemediationAttempt = {
  recipeId, inputFingerprint, outputFingerprint: inputFingerprint, outcome: 'unchanged'
};
const receipt: WorkstationNoProgressReceipt = {
  schemaVersion: 1, kind: 'liftoff-workstation-no-progress', ...unchanged
};

async function fixture() {
  const relativeRoot = path.join('tests', `.workstation-attempts-${randomUUID()}`);
  await mkdir(relativeRoot, { mode: 0o700 });
  const root = path.resolve(relativeRoot);
  roots.push(root);
  const invocationRoot = path.join(root, 'existing-invocation');
  const home = path.join(root, 'private-home');
  await mkdir(invocationRoot, { mode: 0o700 });
  await mkdir(path.join(invocationRoot, '.git'), { mode: 0o700 });
  await writeFile(path.join(invocationRoot, 'preserve.txt'), 'original project bytes\n');
  await mkdir(home, { mode: 0o700 });
  const options: UpdatePreviewOptions = { homedir: home, env: {} };
  return {
    root, invocationRoot, home, options,
    store: createWorkstationNoProgressStore(invocationRoot, options),
    records: createScopedUserLocalRecordStore(invocationRoot, 'workstation-remediation', options)
  };
}

describe('immutable workstation no-progress receipts', () => {
  it('uses a canonical hashed key and does not create anything on a missing lookup', async () => {
    const { home, invocationRoot, store } = await fixture();
    expect(workstationNoProgressKey(recipeId, inputFingerprint)).toBe(canonicalSha256({ inputFingerprint, recipeId }));
    expect(await store.find(recipeId, inputFingerprint)).toBeNull();
    expect(await readdir(home)).toEqual([]);
    expect((await readdir(invocationRoot)).sort()).toEqual(['.git', 'preserve.txt']);
  });

  it('round-trips exact private schema-1 metadata across new store instances without rewriting it', async () => {
    const { invocationRoot, options, store, records } = await fixture();
    await store.record(unchanged);
    const saved = (await records.read(workstationNoProgressKey(recipeId, inputFingerprint)))!;
    const bytes = await readFile(saved.path, 'utf8');
    const before = await lstat(saved.path);
    expect(saved.value).toEqual(receipt);
    expect(path.relative(invocationRoot, saved.path).startsWith('..')).toBe(true);
    expect(bytes.length).toBeLessThan(1024);
    expect(bytes).not.toContain(invocationRoot);
    expect(bytes).not.toMatch(/PATH|stdout|stderr|token|executable|home|createdAt/);
    const fresh = createWorkstationNoProgressStore(invocationRoot, options);
    expect(await fresh.find(recipeId, inputFingerprint)).toEqual(unchanged);
    await fresh.record(unchanged);
    const after = await lstat(saved.path);
    expect(await readFile(saved.path, 'utf8')).toBe(bytes);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    if (process.platform !== 'win32') {
      expect(after.mode & 0o077).toBe(0);
      expect((await lstat(path.dirname(saved.path))).mode & 0o077).toBe(0);
    }
    expect(await readFile(path.join(invocationRoot, 'preserve.txt'), 'utf8')).toBe('original project bytes\n');
  });

  it('isolates bindings by recipe, observed inputs, namespace, and existing invocation root', async () => {
    const { root, invocationRoot, options, store } = await fixture();
    await store.record(unchanged);
    expect(await store.find('node:darwin:brew:install', inputFingerprint)).toBeNull();
    expect(await store.find(recipeId, 'b'.repeat(64))).toBeNull();
    expect(await createScopedUserLocalRecordStore(invocationRoot, 'governance-preview', options)
      .read(workstationNoProgressKey(recipeId, inputFingerprint))).toBeNull();
    const other = path.join(root, 'other-invocation');
    await mkdir(other, { mode: 0o700 });
    await mkdir(path.join(other, '.git'), { mode: 0o700 });
    expect(await createWorkstationNoProgressStore(other, options).find(recipeId, inputFingerprint)).toBeNull();
    expect(await store.find(recipeId, inputFingerprint)).toEqual(unchanged);
  });

  it.each([
    ['../not-a-recipe', inputFingerprint],
    ['node:darwin:brew:upgrade', 'short'],
    ['node:darwin:brew:upgrade', 'A'.repeat(64)],
    ['node:darwin:brew:upgrade', '../' + 'a'.repeat(64)]
  ])('rejects unsafe or noncanonical lookup bindings before storage access', async (recipe, fingerprint) => {
    const { store, home } = await fixture();
    await expect(store.find(recipe, fingerprint)).rejects.toBeInstanceOf(WorkstationAttemptStoreError);
    expect(await readdir(home)).toEqual([]);
  });

  it('rejects extra payload fields and changed before/after hashes before writing a receipt', async () => {
    const { store, home } = await fixture();
    const payload = { ...unchanged, stdout: 'fixture-secret-output', PATH: '/private/path' };
    await expect(store.record(payload)).rejects.toBeInstanceOf(WorkstationAttemptStoreError);
    await expect(store.record({ ...unchanged, outputFingerprint: 'b'.repeat(64) }))
      .rejects.toBeInstanceOf(WorkstationAttemptStoreError);
    expect(await readdir(home)).toEqual([]);
  });

  it.each([
    { ...receipt, schemaVersion: 2 },
    { ...receipt, kind: 'another-kind' },
    { ...receipt, recipeId: 'node:darwin:brew:install' },
    { ...receipt, inputFingerprint: 'b'.repeat(64) },
    { ...receipt, outputFingerprint: 'b'.repeat(64) },
    { ...receipt, outcome: 'ready' },
    { ...receipt, token: 'fixture-secret-value' },
    { schemaVersion: 1, kind: receipt.kind, recipeId, inputFingerprint, outcome: 'unchanged' },
    null,
    []
  ])('rejects corrupt or expanded receipt data and preserves its bytes: %j', async (value) => {
    const { store, records } = await fixture();
    const saved = await records.write(workstationNoProgressKey(recipeId, inputFingerprint), value);
    const bytes = await readFile(saved.path);
    await expect(store.find(recipeId, inputFingerprint)).rejects.toBeInstanceOf(WorkstationAttemptStoreError);
    await expect(store.record(unchanged)).rejects.toBeInstanceOf(WorkstationAttemptStoreError);
    expect(await readFile(saved.path)).toEqual(bytes);
  });

  it.each(['{"token":"fixture-secret-value",', ' '.repeat(65 * 1024)])(
    'treats malformed or oversized stored JSON as an error, not missing history', async (content) => {
      const { store, records } = await fixture();
      await store.record(unchanged);
      const saved = (await records.read(workstationNoProgressKey(recipeId, inputFingerprint)))!;
      await writeFile(saved.path, content);
      await expect(store.find(recipeId, inputFingerprint)).rejects.toMatchObject({
        code: 'workstation-attempt-storage',
        message: 'Unable to read private workstation no-progress history; malformed or inaccessible history was not ignored.'
      });
      expect(await readFile(saved.path, 'utf8')).toBe(content);
    }
  );

  it('does not hide unreadable history or alter the protected record', async () => {
    const { invocationRoot, options, store, records } = await fixture();
    await store.record(unchanged);
    const saved = (await records.read(workstationNoProgressKey(recipeId, inputFingerprint)))!;
    const bytes = await readFile(saved.path);
    const fileSystem: UpdatePreviewFileSystem = {
      ...nodeUpdatePreviewFileSystem,
      async openFile(filePath, access, mode) {
        if (filePath === saved.path && access === 'read') {
          throw Object.assign(new Error('injected permission failure'), { code: 'EACCES' });
        }
        return nodeUpdatePreviewFileSystem.openFile(filePath, access, mode);
      }
    };
    const unavailable = createWorkstationNoProgressStore(invocationRoot, { ...options, fileSystem });
    await expect(unavailable.find(recipeId, inputFingerprint)).rejects.toBeInstanceOf(WorkstationAttemptStoreError);
    expect(await readFile(saved.path)).toEqual(bytes);
  });

  it.skipIf(process.platform === 'win32')('retains the hardened symlink and private-permission boundary', async () => {
    const { root, store, records } = await fixture();
    await store.record(unchanged);
    const saved = (await records.read(workstationNoProgressKey(recipeId, inputFingerprint)))!;
    await chmod(saved.path, 0o644);
    await expect(store.find(recipeId, inputFingerprint)).rejects.toBeInstanceOf(WorkstationAttemptStoreError);
    await chmod(saved.path, 0o600);
    const target = path.join(root, 'unrelated.txt');
    await writeFile(target, 'unrelated bytes\n', { mode: 0o600 });
    await unlink(saved.path);
    await symlink(target, saved.path);
    await expect(store.find(recipeId, inputFingerprint)).rejects.toBeInstanceOf(WorkstationAttemptStoreError);
    await expect(store.record(unchanged)).rejects.toBeInstanceOf(WorkstationAttemptStoreError);
    expect(await readFile(target, 'utf8')).toBe('unrelated bytes\n');
  });

  it('requires an existing invocation root and keeps storage outside that project', async () => {
    const { root, invocationRoot, options } = await fixture();
    const destination = path.join(root, 'not-created-project');
    const missingRoot = createWorkstationNoProgressStore(destination, options);
    await expect(missingRoot.find(recipeId, inputFingerprint)).rejects.toBeInstanceOf(WorkstationAttemptStoreError);
    await expect(missingRoot.record(unchanged)).rejects.toBeInstanceOf(WorkstationAttemptStoreError);
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    const contained = createWorkstationNoProgressStore(invocationRoot, {
      homedir: path.join(invocationRoot, 'not-a-private-home'), env: {}
    });
    await expect(contained.record(unchanged)).rejects.toBeInstanceOf(WorkstationAttemptStoreError);
    expect((await readdir(invocationRoot)).sort()).toEqual(['.git', 'preserve.txt']);
  });
});

class RuntimeRunner implements CommandRunner {
  calls: ExternalCommand[] = [];
  version = '24.19.0';
  postVersion = '24.19.0';
  failInstaller = false;
  onInstall?: () => void;
  constructor(private events: string[] = []) {}
  async run(command: ExternalCommand, _options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push(command);
    this.events.push(`${command.executable}:${command.args[0]}`);
    if (command.executable === 'brew' && command.args[0] === 'upgrade') {
      this.onInstall?.();
      if (!this.failInstaller) this.version = this.postVersion;
    }
    return {
      command, displayCommand: [command.executable, ...command.args].join(' '),
      status: this.failInstaller && command.args[0] === 'upgrade' ? 17 : 0,
      signal: null, timedOut: false,
      stdout: command.executable === 'node' ? `v${this.version}` : 'Homebrew 5.0.0',
      stderr: this.failInstaller && command.args[0] === 'upgrade' ? 'installer failed' : ''
    };
  }
}

function nodeRequirement(): SelectedRequirement {
  const definition = workstationRequirementCatalog.node;
  return {
    id: 'node', definition, severity: 'blocking', reasons: ['test'],
    minimumVersion: definition.minimumVersion, releaseLine: definition.releaseLine,
    allowPrerelease: false
  };
}

async function runtimeFixture() {
  const value = await fixture();
  const firstCwd = path.join(value.root, 'neutral-one');
  const secondCwd = path.join(value.root, 'neutral-two');
  await mkdir(firstCwd, { mode: 0o700 });
  await mkdir(secondCwd, { mode: 0o700 });
  const identity: ExecutableIdentity = {
    executable: 'node', resolution: 'resolved', origin: 'brew', kind: 'executable', evidence: 'path-search',
    resolvedPath: path.join(value.root, 'tool installation', 'node'),
    realPath: path.join(value.root, 'Cellar', 'node@24', 'node')
  };
  const observer: ExecutableObserver = {
    async resolve(executable) { return { ...identity, executable }; },
    async inspect(executable) { return { executable, resolution: 'missing', origin: 'unknown', evidence: 'unavailable' }; }
  };
  const context = (runner: CommandRunner, cwd = firstCwd): InstallContext => ({
    authorized: true, host: { platform: 'darwin', linuxFamily: 'unknown' },
    runner, cwd, executableObserver: observer, includeHealthNotices: false,
    env: { PATH: '/fixture/tool-bin', HOME: value.home, PWD: cwd, TMPDIR: cwd },
    noProgressStore: createWorkstationNoProgressStore(value.invocationRoot, value.options)
  });
  return { ...value, firstCwd, secondCwd, identity, observer, context };
}

describe('cross-process no-progress protection in the workstation runtime', () => {
  it('blocks a fresh runner/store despite an incidental neutral cwd, credential, or property-order change', async () => {
    const value = await runtimeFixture();
    const requirement = nodeRequirement();
    const firstRunner = new RuntimeRunner();
    const firstContext = value.context(firstRunner);
    firstContext.env = { ...firstContext.env, AUTH_TOKEN: 'fixture-first-secret' };
    const before = await probeRequirement(requirement, firstRunner, firstContext);
    const first = await installRequirement(requirement, before, firstContext);
    expect(first).toMatchObject({ state: 'unchanged', reasonCode: 'no-progress', progress: 'unchanged' });
    expect(first.attempt?.inputFingerprint).toBe(first.attempt?.outputFingerprint);
    const saved = (await value.records.read(workstationNoProgressKey(recipeId, first.attempt!.inputFingerprint)))!;
    const bytes = await readFile(saved.path, 'utf8');
    expect(bytes).not.toMatch(/fixture-first-secret|neutral-one|tool installation|PATH|PWD|TMPDIR|HOME|stdout|stderr/);

    const secondRunner = new RuntimeRunner();
    const secondContext = value.context(secondRunner, value.secondCwd);
    secondContext.env = { AUTH_TOKEN: 'fixture-new-secret', ...secondContext.env };
    secondContext.executableObserver = {
      ...value.observer,
      async resolve(executable) {
        return { evidence: value.identity.evidence, realPath: value.identity.realPath, resolvedPath: value.identity.resolvedPath,
          kind: value.identity.kind, origin: value.identity.origin, resolution: value.identity.resolution, executable };
      }
    };
    const current = await probeRequirement(requirement, secondRunner, secondContext);
    expect(current.remediationAttempts).toBeUndefined();
    const second = await installRequirement(requirement, current, secondContext);
    expect(second).toMatchObject({ state: 'unchanged', reasonCode: 'no-progress', attempt: first.attempt });
    expect(second.command).toBeUndefined();
    expect(secondRunner.calls).toEqual([{ executable: 'node', args: ['--version'] }]);
    expect(await readFile(saved.path, 'utf8')).toBe(bytes);
  });

  it.each(['version', 'resolvedPath', 'realPath', 'minimumVersion', 'PATH', 'PATHEXT', 'HOMEBREW_PREFIX'] as const)(
    'permits a new reviewed retry when the relevant %s observation changes', async (field) => {
      const value = await runtimeFixture();
      const requirement = nodeRequirement();
      const initialRunner = new RuntimeRunner();
      const initialContext = value.context(initialRunner);
      const first = await installRequirement(requirement, await probeRequirement(requirement, initialRunner, initialContext), initialContext);
      expect(first.state).toBe('unchanged');
      const nextRunner = new RuntimeRunner();
      nextRunner.postVersion = '24.21.0';
      const nextContext = value.context(nextRunner, value.secondCwd);
      const nextRequirement = { ...requirement };
      if (field === 'version') nextRunner.version = '24.19.1';
      else if (field === 'minimumVersion') nextRequirement.minimumVersion = '24.21.0';
      else if (field === 'resolvedPath' || field === 'realPath') {
        nextContext.executableObserver = {
          ...value.observer,
          async resolve(executable) { return { ...value.identity, executable, [field]: `${value.identity[field]}-changed` }; }
        };
      } else {
        nextContext.env = { ...nextContext.env, [field]: field === 'PATHEXT' ? '.CMD;.EXE' : '/fixture/changed-tool-location' };
      }
      const current = await probeRequirement(nextRequirement, nextRunner, nextContext);
      const retried = await installRequirement(nextRequirement, current, nextContext);
      expect(retried).toMatchObject({ state: 'installed', reasonCode: 'verified' });
      expect(nextRunner.calls.filter((command) => command.executable === 'brew' && command.args[0] === 'upgrade')).toHaveLength(1);
      expect(retried.attempt?.inputFingerprint).not.toBe(first.attempt?.inputFingerprint);
      expect(await value.store.find(recipeId, first.attempt!.inputFingerprint)).toEqual(first.attempt);
      expect(await value.store.find(recipeId, retried.attempt!.inputFingerprint)).toBeNull();
    }
  );

  it('does not erase an actual cwd-dependent launcher-path change with the neutral cwd exclusion', async () => {
    const value = await runtimeFixture();
    const requirement = nodeRequirement();
    const cwdObserver: ExecutableObserver = {
      ...value.observer,
      async resolve(executable, context) {
        return { ...value.identity, executable, resolvedPath: path.join(context.cwd, executable) };
      }
    };
    const firstRunner = new RuntimeRunner();
    const firstContext = { ...value.context(firstRunner), executableObserver: cwdObserver };
    const first = await installRequirement(requirement, await probeRequirement(requirement, firstRunner, firstContext), firstContext);
    const secondRunner = new RuntimeRunner();
    secondRunner.postVersion = '24.20.0';
    const secondContext = { ...value.context(secondRunner, value.secondCwd), executableObserver: cwdObserver };
    const second = await installRequirement(requirement, await probeRequirement(requirement, secondRunner, secondContext), secondContext);
    expect(second.state).toBe('installed');
    expect(second.attempt?.inputFingerprint).not.toBe(first.attempt?.inputFingerprint);
  });

  it('reads after the actual observation and records only after the authorized command and unchanged reprobe', async () => {
    const value = await runtimeFixture();
    const events: string[] = [];
    const commandRunner = new RuntimeRunner(events);
    const context = value.context(commandRunner);
    context.noProgressStore = {
      async find(recipe, fingerprint) {
        events.push('history:find');
        return value.store.find(recipe, fingerprint);
      },
      async record(attempt) {
        events.push('history:record');
        await value.store.record(attempt);
      }
    };
    const requirement = nodeRequirement();
    await installRequirement(requirement, await probeRequirement(requirement, commandRunner, context), context);
    expect(events).toEqual([
      'node:--version', 'history:find', 'brew:--version', 'brew:upgrade', 'node:--version', 'history:record'
    ]);
  });

  it.each(['declined', 'ready', 'failed', 'improved', 'changed-environment'] as const)(
    'never creates a no-progress receipt for a %s outcome', async (scenario) => {
      const value = await runtimeFixture();
      const commandRunner = new RuntimeRunner();
      const context = value.context(commandRunner);
      let lookups = 0;
      let records = 0;
      context.noProgressStore = {
        async find(recipe, fingerprint) { lookups += 1; return value.store.find(recipe, fingerprint); },
        async record(attempt) { records += 1; await value.store.record(attempt); }
      };
      if (scenario === 'declined') context.authorized = false;
      if (scenario === 'ready') commandRunner.version = '24.20.0';
      if (scenario === 'failed') commandRunner.failInstaller = true;
      if (scenario === 'improved') commandRunner.postVersion = '24.19.1';
      if (scenario === 'changed-environment') commandRunner.onInstall = () => {
        context.env = { ...context.env, PATH: '/fixture/changed-during-command' };
      };
      const requirement = nodeRequirement();
      const result = await installRequirement(requirement, await probeRequirement(requirement, commandRunner, context), context);
      expect(records).toBe(0);
      expect(await readdir(value.home)).toEqual([]);
      if (scenario === 'declined' || scenario === 'ready') expect(lookups).toBe(0);
      if (scenario === 'changed-environment') expect(result).toMatchObject({ state: 'unresolved', progress: 'changed' });
    }
  );

  it('reports corrupt history before installer execution, even if an in-process receipt also exists', async () => {
    const value = await runtimeFixture();
    const commandRunner = new RuntimeRunner();
    const context = value.context(commandRunner);
    const requirement = nodeRequirement();
    const first = await installRequirement(requirement, await probeRequirement(requirement, commandRunner, context), context);
    const saved = (await value.records.read(workstationNoProgressKey(recipeId, first.attempt!.inputFingerprint)))!;
    await writeFile(saved.path, '{ "token": "fixture-secret-value",');
    const count = commandRunner.calls.length;
    const failed = await installRequirement(requirement, first.probe, context);
    expect(failed).toMatchObject({
      state: 'failed', reasonCode: 'history-storage-failed', historyError: 'lookup',
      probe: { state: 'outdated', reasonCode: 'below-minimum' }
    });
    expect(failed.detail).toContain('No remedy command was run');
    expect(failed.detail).not.toContain('fixture-secret-value');
    expect(commandRunner.calls).toHaveLength(count);
  });

  it('rejects a misbound injected history result instead of trusting or ignoring it', async () => {
    const value = await runtimeFixture();
    const commandRunner = new RuntimeRunner();
    const context = value.context(commandRunner);
    context.noProgressStore = {
      async find(recipe, fingerprint) {
        return { recipeId: recipe, inputFingerprint: fingerprint, outputFingerprint: 'bad', outcome: 'unchanged' };
      },
      async record() { throw new Error('No write is allowed.'); }
    };
    const requirement = nodeRequirement();
    const result = await installRequirement(requirement, await probeRequirement(requirement, commandRunner, context), context);
    expect(result).toMatchObject({ state: 'failed', reasonCode: 'history-storage-failed', historyError: 'lookup' });
    expect(commandRunner.calls).toEqual([{ executable: 'node', args: ['--version'] }]);
  });

  it('preserves the actual unchanged machine outcome while reporting a receipt write failure', async () => {
    const value = await runtimeFixture();
    const commandRunner = new RuntimeRunner();
    const context = value.context(commandRunner);
    let attemptedRecord: NoProgressRemediationAttempt | undefined;
    const broken: WorkstationNoProgressStore = {
      find: (recipe, fingerprint) => value.store.find(recipe, fingerprint),
      async record(attempt) { attemptedRecord = attempt; throw new Error('Injected private-store write failure.'); }
    };
    context.noProgressStore = broken;
    const requirement = nodeRequirement();
    const result = await installRequirement(requirement, await probeRequirement(requirement, commandRunner, context), context);
    expect(result).toMatchObject({
      state: 'failed', reasonCode: 'history-storage-failed', historyError: 'record', progress: 'unchanged',
      command: 'brew upgrade node@24',
      probe: { state: 'outdated', reasonCode: 'below-minimum', detectedVersion: '24.19.0' },
      attempt: { outcome: 'unchanged' }
    });
    expect(result.detail).toContain('receipt could not be preserved');
    expect(attemptedRecord).toEqual(result.attempt);
    expect(await readdir(value.home)).toEqual([]);
  });
});
