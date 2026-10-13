import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdir, readFile, readlink, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runMacMigration, defaultMacMigrationDependencies } from '../src/application/upgrade/mac-migration.js';
import { parseMacMigration, macMigrationHelp, macMigrationMain } from '../src/cli/mac-migration.js';
import { captureMigrationTree, MacMigrationJournalStore, migrationAbsent, migrationLauncher,
  restoreMigrationTree, migrationJournalByteLimit, assertMigrationRecoveryJournalBudget,
  type MigrationJournal } from '../src/adapters/distribution/mac-migration-state.js';
import * as migrationState from '../src/adapters/distribution/mac-migration-state.js';
import { discoverMacNpmSelections, inspectMacNpmOwner, macMigrationHash as hash,
  migrationDirectory, migrationEnvironment, migrationNames } from '../src/adapters/distribution/mac-npm-owner.js';
import { macMigrationFixture } from './fixtures/mac-migration.js';
import { MacMigrationFailure, type MacNpmManager } from '../src/domain/distribution/mac-migration.js';
import { macMigrationBridge } from '../src/domain/distribution/mac-migration-bridge.js';
import { NodeCommandRunner } from '../src/process-runner.js';

type Fixture = Awaited<ReturnType<typeof macMigrationFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });
async function fixture(manager: MacNpmManager = 'custom', shared = false) {
  const value = await macMigrationFixture(manager, shared); fixtures.push(value); return value;
}
async function apply(value: Fixture) {
  const preview = await runMacMigration(value.request, value.dependencies);
  expect(preview.blockers).toEqual([]);
  expect(preview.status).toBe('ready');
  return runMacMigration({ ...value.request, apply: { review: preview.review!,
    journalRoot: path.join(value.root, 'private journal') } }, value.dependencies);
}
async function journal(value: Fixture) {
  const root = path.join(value.root, 'private journal');
  const bytes = await readFile(path.join(root, 'journal.json'));
  return { root, digest: hash(bytes), data: JSON.parse(bytes.toString()).journal as MigrationJournal };
}
async function recover(value: Fixture) {
  const selected = await journal(value);
  return runMacMigration({ recover: { journalRoot: selected.root, journalSha256: selected.digest } }, value.dependencies);
}

describe.skipIf(process.platform === 'win32')('private SOURCE-only Mac migration', () => {
  it.each<MacNpmManager>(['custom', 'nvm', 'volta', 'homebrew-node'])('previews and transfers one verified %s owner in paths with spaces', async manager => {
    const value = await fixture(manager, true);
    await mkdir(path.join(value.prefix, 'lib/node_modules/unrelated'));
    const preserved = ['.npmrc', 'telemetry.json', '.liftoff/preferences', 'project/package.json'];
    for (const file of preserved) {
      await mkdir(path.dirname(path.join(value.root, file)), { recursive: true });
      await writeFile(path.join(value.root, file), `preserve ${file}`);
    }
    const before = await captureMigrationTree(value.oldPackage);
    const run = vi.spyOn(value.dependencies.upgrade.runner, 'run');
    const preview = await runMacMigration(value.request, value.dependencies);
    expect(preview).toMatchObject({ status: 'ready', effects: 'none', mode: 'preview',
      selected: { manager, version: '0.12.3', packageRoot: value.oldPackage } });
    expect((await captureMigrationTree(value.oldPackage)).physical).toBe(before.physical);
    expect(run.mock.calls.every(([command]) => !command.args.includes('uninstall'))).toBe(true);
    const result = await apply(value);
    expect(result.blockers).toEqual([]);
    expect(result).toMatchObject({ status: 'installed', effects: 'cask-installed',
      verification: { owner: 'homebrew-cask', version: '0.13.0', assets: 'verified', path: 'selected', parentShell: 'not-observable' } });
    const uninstall = run.mock.calls.filter(([command]) => command.args.includes('uninstall'));
    expect(uninstall).toHaveLength(1);
    expect(uninstall[0][0]).toEqual({ executable: value.node,
      args: [value.npm, 'uninstall', '--global', '--prefix', value.prefix, '--ignore-scripts', '--no-audit', '--no-fund', '@msn-control/liftoff'] });
    expect(uninstall[0][1]).toMatchObject({ ensureProcessTreeSettled: true,
      env: { npm_config_offline: 'true', npm_config_ignore_scripts: 'true', HOMEBREW_NO_AUTO_UPDATE: '1' } });
    expect(await migrationAbsent(value.oldPackage)).toBe(true);
    expect(await lstat(path.join(value.prefix, 'lib/node_modules/unrelated'))).toBeDefined();
    for (const file of preserved) expect(await readFile(path.join(value.root, file), 'utf8')).toBe(`preserve ${file}`);
    expect(await readlink(value.oldLauncher)).toBe(path.join(value.source, 'bin/liftoff'));
    expect((await journal(value)).data.phase).toBe('verified');
    expect(await migrationAbsent(path.join(value.root, 'private journal/lock'))).toBe(true);
  }, 30_000);

  it('rejects the selected old source checkout before manager probing', async () => {
    const value = await fixture();
    await writeFile(path.join(value.oldPackage, '.git'), 'gitdir: source fixture');
    const run = vi.spyOn(value.dependencies.upgrade.runner, 'run');
    const result = await runMacMigration(value.request, value.dependencies);
    expect(result.blockers).toContain('source-checkout'); expect(run).not.toHaveBeenCalled();
  });

  it('requires exact existing Homebrew and the separately qualified real provider even for source admission', async () => {
    const value = await fixture();
    expect((await runMacMigration({ selection: value.request.selection }, value.dependencies)).blockers)
      .toContain('approved-existing-homebrew-required');
    delete value.dependencies.cask;
    expect((await runMacMigration(value.request, value.dependencies)).blockers).toContain('native-cask-provider-unqualified');
    expect(defaultMacMigrationDependencies().cask).toBeUndefined();
    expect(await migrationAbsent(value.oldPackage)).toBe(false);
  });

  it('the real standalone entrypoint refuses unqualified apply on an isolated old npm fixture', async () => {
    const value = await fixture();
    const result = await new NodeCommandRunner().run({ executable: process.execPath,
      args: [path.resolve('dist/cli/mac-migration.js'), '--npm', value.npm, '--node', value.node,
        '--prefix', value.prefix, '--manager', 'custom', '--brew', value.request.brew!,
        '--recovery', value.recovery, '--apply', 'a'.repeat(64), '--journal', path.join(value.root, 'never-created')] },
    { cwd: value.root, env: { PATH: '', HOME: value.root }, timeoutMs: 30_000, ensureProcessTreeSettled: true });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'blocked', effects: 'none' });
    expect(await migrationAbsent(value.oldPackage)).toBe(false);
    expect(await migrationAbsent(path.join(value.root, 'never-created'))).toBe(true);
  });

  it('standalone main emits help, input errors and honest unqualified preview JSON', async () => {
    const value = await fixture();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await macMigrationMain(['--help'])).toBe(0);
      expect(await macMigrationMain(['--brew', 'relative'])).toBe(1);
      expect(await macMigrationMain(['--npm', value.npm, '--node', value.node, '--prefix', value.prefix,
        '--manager', 'custom', '--brew', value.request.brew!])).toBe(1);
      expect(stdout.mock.calls[0][0]).toContain('SOURCE ONLY');
      expect(JSON.parse(String(stdout.mock.calls.at(-1)![0]))).toMatchObject({ status: 'blocked', effects: 'none' });
      expect(stderr.mock.calls[0][0]).toContain('No migration was performed');
    } finally { stdout.mockRestore(); stderr.mockRestore(); }
  });

  it.each(['policy', 'signature', 'asset', 'channel', 'destination', 'cask-scope', 'recovery', 'recovery-version', 'permission', 'collision'])(
    'blocks unsafe %s before uninstall', async failure => {
      const value = await fixture();
      const cask = value.dependencies.cask!;
      if (failure === 'policy') cask.policy.homebrew.cask = null;
      if (failure === 'signature') value.material.signature[0] ^= 1;
      if (failure === 'asset') value.material.assets.get('NOTICE')![0] ^= 1;
      if (failure === 'channel') cask.channel = async () => ({ ...value.channel, artifactSha256: '0'.repeat(64) });
      if (failure === 'destination') cask.destination = async () => path.join(value.root, 'unrelated');
      if (failure === 'cask-scope') cask.preflight = async () => ({ identity: '', permissions: 'verified', collisions: 'clear' });
      if (failure === 'recovery') await writeFile(path.join(value.recovery, 'dist/dependency.js'), 'not the old installed dependency\n');
      if (failure === 'recovery-version') {
        await writeFile(path.join(value.recovery, 'dist/cli.js'), 'console.log("Liftoff 0.11.0")');
        await writeFile(path.join(value.oldPackage, 'dist/cli.js'), 'console.log("Liftoff 0.11.0")');
      }
      if (failure === 'permission') await chmod(value.oldPackage, 0o777);
      if (failure === 'collision') await writeFile(path.join(value.brewPrefix, 'bin/liftoff'), 'unrelated user launcher');
      const run = vi.spyOn(value.dependencies.upgrade.runner, 'run');
      const result = await runMacMigration(value.request, value.dependencies);
      expect(result.status).toBe('blocked'); expect(result.effects).toBe('none'); expect(result.blockers.length).toBeGreaterThan(0);
      expect(run.mock.calls.some(([command]) => command.args.includes('uninstall'))).toBe(false);
      expect(await migrationAbsent(value.oldPackage)).toBe(false);
    });

  it('rejects stale explicit review and preexisting journals without uninstall', async () => {
    const value = await fixture();
    const run = vi.spyOn(value.dependencies.upgrade.runner, 'run');
    expect((await runMacMigration({ ...value.request, apply: { review: '0'.repeat(64),
      journalRoot: path.join(value.root, 'journal') } }, value.dependencies)).blockers).toContain('stale-exact-review');
    const preview = await runMacMigration(value.request, value.dependencies);
    await mkdir(path.join(value.root, 'journal'));
    expect((await runMacMigration({ ...value.request, apply: { review: preview.review!,
      journalRoot: path.join(value.root, 'journal') } }, value.dependencies)).effects).toBe('none');
    expect(run.mock.calls.some(([command]) => command.args.includes('uninstall'))).toBe(false);
  });

  it('discovers only bounded PATH copies and requires explicit selection for ambiguous owners', async () => {
    const first = await fixture(); const second = await fixture();
    for (const value of [first, second]) await symlink(value.npm, path.join(value.prefix, 'bin/npm'));
    first.dependencies.upgrade.environment.PATH = `${path.join(first.prefix, 'bin')}:${path.join(second.prefix, 'bin')}`;
    const selections = await discoverMacNpmSelections(first.dependencies.upgrade.environment);
    expect(selections).toHaveLength(2);
    expect((await runMacMigration({ brew: first.request.brew, recovery: first.recovery }, first.dependencies)).blockers)
      .toContain('explicit-unambiguous-owner-selection-required');
    expect((await runMacMigration(first.request, first.dependencies)).status).toBe('ready');
    await expect(discoverMacNpmSelections({ PATH: 'relative:/usr/bin' })).rejects.toMatchObject({ code: 'ambiguous-path' });
    await expect(discoverMacNpmSelections({ PATH: Array(65).fill('/usr/bin').join(':') })).rejects.toMatchObject({ code: 'ambiguous-path' });
  });

  it.each(['unknown', 'failed', 'changed-link', 'changed-parent'])('preserves partial npm %s without cask dispatch', async failure => {
    const value = await fixture();
    const original = value.dependencies.upgrade.runner.run.bind(value.dependencies.upgrade.runner);
    value.dependencies.upgrade.runner = { run: async (command, options) => {
      const result = await original(command, options);
      if (command.args.includes('uninstall')) {
        if (failure === 'unknown') return { ...result, processTreeSettled: false };
        if (failure === 'failed') return { ...result, status: 1 };
        if (failure === 'changed-link') { await unlink(value.oldLauncher); await writeFile(value.oldLauncher, 'new user launcher'); }
        if (failure === 'changed-parent') await chmod(path.join(value.prefix, 'bin'), 0o700);
      }
      return result;
    } };
    const install = vi.spyOn(value.dependencies.cask!, 'installExact');
    const result = await apply(value);
    expect(result.status).toBe('partial'); expect(result.journal).toBeDefined(); expect(install).not.toHaveBeenCalled();
    if (failure === 'unknown') {
      expect((await journal(value)).data.phase).toBe('uncertain');
      expect(await migrationAbsent(path.join(value.root, 'private journal/lock'))).toBe(false);
      expect(await readlink(value.oldLauncher)).toContain('@msn-control/liftoff');
    }
    if (failure === 'failed') expect((await recover(value)).status).toBe('restored');
  }, 30_000);

  it.each(['unknown', 'throws', 'verification', 'failed'])('preserves partial cask %s and cannot overwrite installations', async failure => {
    const value = await fixture();
    const cask = value.dependencies.cask!;
    if (failure === 'unknown') cask.installExact = async () => ({ settled: false, installed: false });
    if (failure === 'throws') cask.installExact = async () => { throw new Error('unknown dispatch settlement'); };
    if (failure === 'failed') cask.installExact = async () => ({ settled: true, installed: false });
    if (failure === 'verification') {
      const original = cask.installed;
      cask.installed = async (...args) => { const result = await original(...args); result.ownership.installedVersion = '9.9.9'; return result; };
    }
    const result = await apply(value);
    expect(result.status).toBe('partial'); expect(result.journal).toBeDefined();
    if (failure === 'failed') {
      expect((await recover(value)).status).toBe('restored');
      expect((await captureMigrationTree(value.oldPackage)).content).toBe((await captureMigrationTree(value.recovery)).content);
      expect(await readlink(value.oldLauncher)).toBe('../lib/node_modules/@msn-control/liftoff/dist/cli.js');
      expect((await recover(value)).status).toBe('restored');
    } else {
      const recovered = await recover(value);
      expect(recovered.status).toBe('partial');
      expect(await migrationAbsent(value.oldPackage)).toBe(true);
    }
  }, 30_000);

  it('keeps a verified cask distinct from stale PATH selection and reports parent-shell limits', async () => {
    const value = await fixture();
    const foreign = path.join(value.root, 'foreign bin'); await mkdir(foreign);
    await writeFile(path.join(foreign, 'liftoff'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    value.dependencies.upgrade.environment.PATH = `${foreign}:${value.brewPrefix}/bin`;
    expect(await apply(value)).toMatchObject({ status: 'installed', verification: { assets: 'verified', path: 'unresolved',
      parentShell: 'not-observable' } });
  }, 30_000);

  it.each(['cask', 'user', 'backup', 'journal', 'key-permission', 'tool'])('refuses unsafe selected recovery %s', async changed => {
    const value = await fixture();
    value.dependencies.cask!.installExact = async () => ({ settled: true, installed: false });
    await apply(value);
    if (changed === 'cask') value.dependencies.cask!.absent = async () => false;
    if (changed === 'user') { await mkdir(value.oldPackage); await writeFile(path.join(value.oldPackage, 'new-install'), 'preserve'); }
    if (changed === 'backup') await writeFile(path.join(value.root, 'private journal/old-package/dist/dependency.js'), 'changed');
    if (changed === 'journal') await writeFile(path.join(value.root, 'private journal/journal.json'), '{}');
    if (changed === 'key-permission') await chmod(path.join(value.root, 'private journal/authority.key'), 0o644);
    if (changed === 'tool') await writeFile(value.node, '#!/bin/sh\nexit 1\n');
    const result = await recover(value);
    expect(result.status).not.toBe('restored'); expect(result.blockers.length).toBeGreaterThan(0);
    if (changed === 'user') expect(await readFile(path.join(value.oldPackage, 'new-install'), 'utf8')).toBe('preserve');
  }, 30_000);

  it('requires positive dead-lock selection without mistaking process death for npm/cask settlement', async () => {
    const value = await fixture();
    const store = new MacMigrationJournalStore(path.join(value.root, 'locks'));
    await store.initialize();
    const ownerPath = path.join(store.root, 'lock/owner.json');
    const active = hash(await readFile(ownerPath));
    await expect(store.selectDeadLock(active)).rejects.toMatchObject({ code: 'migration-owner-active' });
    await expect(store.selectDeadLock('0'.repeat(64))).rejects.toMatchObject({ code: 'lock-changed' });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    await store.selectDeadLock(active);
    expect(kill).toHaveBeenCalledWith(process.pid, 0);
    expect(await migrationAbsent(path.dirname(ownerPath))).toBe(true);
    expect(await readFile(path.join(store.root, 'authority.key'))).toHaveLength(32);
  });

  it('journals each exclusive restore entry and refuses unknown entry settlement rather than adopting bytes', async () => {
    const value = await fixture();
    value.dependencies.cask!.installExact = async () => ({ settled: true, installed: false });
    await apply(value);
    const selected = await journal(value);
    const store = new MacMigrationJournalStore(selected.root);
    const data = await store.read(selected.digest); await store.lock();
    data.phase = 'restore-intent';
    const save = store.save.bind(store);
    let calls = 0;
    store.save = async journal => { await save(journal); if (++calls === 2) throw new Error('fixture interruption after durable intent'); };
    await expect(restoreMigrationTree(path.join(store.root, 'old-package'), data, store)).rejects.toThrow('fixture interruption');
    await store.release();
    const result = await recover(value);
    expect(result.blockers).toContain('restore-settlement-unproven');
    expect(await migrationAbsent(value.oldPackage)).toBe(true);
  }, 30_000);

  it.each(['unchanged', 'user-child', 'edited-entry'])('resumes only unchanged completed recovery entries: %s', async change => {
    const value = await fixture();
    value.dependencies.cask!.installExact = async () => ({ settled: true, installed: false });
    await apply(value);
    const selected = await journal(value); const store = new MacMigrationJournalStore(selected.root);
    const data = await store.read(selected.digest); await store.lock(); data.phase = 'restore-intent';
    const save = store.save.bind(store); let calls = 0;
    store.save = async journal => {
      await save(journal);
      if (++calls === (change === 'edited-entry' ? 7 : 3)) throw new Error('fixture interruption after durable completion');
    };
    await expect(restoreMigrationTree(path.join(store.root, 'old-package'), data, store)).rejects.toThrow('fixture interruption');
    await store.release();
    if (change === 'user-child') await writeFile(path.join(value.oldPackage, 'new-user-data'), 'preserve');
    if (change === 'edited-entry') await writeFile(path.join(value.oldPackage, 'dist/cli.js'), 'new user version');
    const result = await recover(value);
    if (change === 'unchanged') expect(result.status).toBe('restored');
    else {
      expect(result.status).toBe('partial');
      expect(result.blockers).toContain(change === 'user-child' ? 'restored-directory-changed' : 'restored-entry-changed');
      expect(await readFile(path.join(value.oldPackage, change === 'user-child' ? 'new-user-data' : 'dist/cli.js'), 'utf8'))
        .toBe(change === 'user-child' ? 'preserve' : 'new user version');
    }
  }, 30_000);

  it('rejects authenticated but structurally foreign journals and changed lock authority', async () => {
    const value = await fixture();
    value.dependencies.cask!.installExact = async () => ({ settled: true, installed: false }); await apply(value);
    const selected = await journal(value); const store = new MacMigrationJournalStore(selected.root);
    const data = await store.read(selected.digest); await store.lock();
    Object.assign(data, { unregisteredAuthority: 'not admitted' }); await store.save(data);
    const descriptor = await store.descriptor();
    await expect(new MacMigrationJournalStore(store.root).read(descriptor.sha256))
      .rejects.toMatchObject({ code: 'invalid-journal-shape' });
    await writeFile(path.join(store.root, 'lock/owner.json'), JSON.stringify({ pid: process.pid, token: 'a'.repeat(64) }));
    await expect(store.save(data)).rejects.toMatchObject({ code: 'journal-authority-changed' });
    await expect(store.release()).rejects.toMatchObject({ code: 'migration-lock-changed' });
  }, 30_000);

  it.each([-1, 0, 1])('bounds the complete authenticated journal envelope at limit %i bytes', async difference => {
    const value = await fixture();
    value.dependencies.cask!.installExact = async () => ({ settled: true, installed: false });
    await apply(value);
    const selected = await journal(value);
    const store = new MacMigrationJournalStore(selected.root);
    const data = await store.read(selected.digest); await store.lock();
    data.phase = 'cask-intent'; await store.save(data);
    const before = await store.descriptor();
    const file = path.join(store.root, 'journal.json');
    const previous = await readFile(file);
    const members = await readdir(store.root);
    data.phase = 'cask-settled';
    data.tree.entries[0].physical = '';
    const base = Buffer.byteLength(JSON.stringify({ journal: data, mac: '0'.repeat(64) }));
    data.tree.entries[0].physical = 'x'.repeat(migrationJournalByteLimit + difference - base);
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThan(migrationJournalByteLimit);
    if (difference > 0) {
      await expect(store.save(data)).rejects.toMatchObject({ code: 'journal-limit' });
      expect(await store.descriptor()).toEqual(before);
      expect(await readFile(file)).toEqual(previous);
      expect(await readdir(store.root)).toEqual(members);
      expect(store.hasUnsettledOperation).toBe(true);
      const reader = new MacMigrationJournalStore(store.root);
      expect((await reader.read(before.sha256)).phase).toBe('cask-intent');
      expect(reader.hasUnsettledOperation).toBe(true);
    } else {
      await store.save(data);
      expect((await readFile(file)).length).toBe(migrationJournalByteLimit + difference);
      const descriptor = await store.descriptor();
      expect((await new MacMigrationJournalStore(store.root).read(descriptor.sha256)).phase).toBe('cask-settled');
      expect(store.hasUnsettledOperation).toBe(false);
    }
    await store.release();
  }, 30_000);

  it('reserves full recovery-ledger growth separately from a writable current envelope', async () => {
    const value = await fixture();
    value.dependencies.cask!.installExact = async () => ({ settled: true, installed: false });
    await apply(value);
    const selected = await journal(value);
    const data = structuredClone(selected.data);
    data.tree.entries[0].physical = '';
    const base = Buffer.byteLength(JSON.stringify({ journal: data, mac: '0'.repeat(64) }));
    data.tree.entries[0].physical = 'x'.repeat(migrationJournalByteLimit - 256 - base);
    expect(Buffer.byteLength(JSON.stringify({ journal: data, mac: '0'.repeat(64) }))).toBeLessThan(migrationJournalByteLimit);
    expect(() => assertMigrationRecoveryJournalBudget(data)).toThrow('recovery-journal-limit');
    const next = await fixture();
    const nextRun = vi.spyOn(next.dependencies.upgrade.runner, 'run');
    vi.spyOn(migrationState, 'assertMigrationRecoveryJournalBudget').mockImplementation(() => {
      throw new MacMigrationFailure('recovery-journal-limit');
    });
    const result = await apply(next);
    expect(result).toMatchObject({ status: 'blocked', effects: 'none', blockers: ['recovery-journal-limit'] });
    expect(nextRun.mock.calls.some(([command]) => command.args.includes('uninstall'))).toBe(false);
    expect((await journal(next)).data.phase).toBe('prepared');
    expect(await migrationAbsent(next.oldPackage)).toBe(false);
  }, 30_000);

  it('reserves and restores confined internal dependency links without adopting external material', async () => {
    const value = await fixture();
    for (const root of [value.oldPackage, value.recovery]) {
      await symlink('dependency.js', path.join(root, 'dist/dependency-link.js'));
    }
    value.dependencies.cask!.installExact = async () => ({ settled: true, installed: false });
    expect((await apply(value)).status).toBe('partial');
    expect((await recover(value)).status).toBe('restored');
    expect(await readlink(path.join(value.oldPackage, 'dist/dependency-link.js'))).toBe('dependency.js');
    expect((await captureMigrationTree(value.oldPackage)).content).toBe((await captureMigrationTree(value.recovery)).content);
  }, 30_000);

  it('retains the durable recovery intent, lock and scratch when completion exceeds the journal envelope', async () => {
    const value = await fixture();
    value.dependencies.cask!.installExact = async () => ({ settled: true, installed: false });
    await apply(value);
    const save = MacMigrationJournalStore.prototype.save;
    vi.spyOn(MacMigrationJournalStore.prototype, 'save').mockImplementation(async function (
      this: MacMigrationJournalStore, data: MigrationJournal
    ) {
      if (data.restoration?.completed.length === 1 && data.restoration.pending === undefined) {
        data.tree.entries[0].physical += 'x'.repeat(migrationJournalByteLimit);
      }
      await save.call(this, data);
    });
    const result = await recover(value);
    expect(result).toMatchObject({ status: 'partial' });
    expect(result.blockers).toContain('journal-limit');
    expect(result.blockers).toContain('migration-lock-retained');
    expect(result.retainedScratch).toBeDefined();
    expect(await migrationAbsent(path.join(value.root, 'private journal/lock'))).toBe(false);
    expect((await journal(value)).data).toMatchObject({ phase: 'restore-intent', restoration: { completed: [], pending: '' } });
    expect(await readdir(value.oldPackage)).toEqual([]);
  }, 30_000);

  it.each(['first-save', 'replacement', 'removed'])('never replaces concurrently changed journal bytes: %s', async change => {
    const value = await fixture();
    value.dependencies.cask!.installExact = async () => ({ settled: true, installed: false });
    await apply(value);
    const selected = await journal(value);
    const store = new MacMigrationJournalStore(change === 'first-save' ? path.join(value.root, 'new journal') : selected.root);
    const data = change === 'first-save' ? { ...selected.data } : await store.read(selected.digest);
    if (change === 'first-save') {
      await store.initialize();
      data.root = store.root;
      data.rootIdentity = await migrationDirectory(store.root);
    } else await store.lock();
    const file = path.join(store.root, 'journal.json');
    if (change === 'removed') await unlink(file);
    else await writeFile(file, 'concurrent journal bytes\n', { mode: 0o600 });
    await expect(store.save(data)).rejects.toThrow();
    if (change === 'removed') expect(await migrationAbsent(file)).toBe(true);
    else expect(await readFile(file, 'utf8')).toBe('concurrent journal bytes\n');
    await store.release();
  }, 30_000);

  it('stops before residual cleanup or cask dispatch when journal bytes change during uninstall', async () => {
    const value = await fixture();
    const original = value.dependencies.upgrade.runner.run.bind(value.dependencies.upgrade.runner);
    value.dependencies.upgrade.runner = { run: async (command, options) => {
      const result = await original(command, options);
      if (command.args.includes('uninstall')) {
        await writeFile(path.join(value.root, 'private journal/journal.json'), 'concurrent journal bytes\n');
      }
      return result;
    } };
    const install = vi.spyOn(value.dependencies.cask!, 'installExact');
    const result = await apply(value);
    expect(result.status).toBe('partial');
    expect(result.blockers).toContain('journal-changed');
    expect(install).not.toHaveBeenCalled();
    expect(await readlink(value.oldLauncher)).toBe('../lib/node_modules/@msn-control/liftoff/dist/cli.js');
    expect(await readFile(path.join(value.root, 'private journal/journal.json'), 'utf8')).toBe('concurrent journal bytes\n');
  }, 30_000);

  it('captures confined internal links, rejects escapes, alias paths and unsafe permissions', async () => {
    const value = await fixture();
    await symlink('dependency.js', path.join(value.oldPackage, 'dist/link.js'));
    expect((await captureMigrationTree(value.oldPackage)).entries.some(entry => entry.kind === 'link')).toBe(true);
    await unlink(path.join(value.oldPackage, 'dist/link.js'));
    await symlink(value.node, path.join(value.oldPackage, 'dist/link.js'));
    await expect(captureMigrationTree(value.oldPackage)).rejects.toMatchObject({ code: 'old-link-escape' });
    await writeFile(path.join(value.oldPackage, 'Case'), 'a'); await writeFile(path.join(value.oldPackage, 'case'), 'b');
    if ((await readdir(value.oldPackage)).includes('Case') && (await readdir(value.oldPackage)).includes('case')) {
      await expect(migrationNames(value.oldPackage, 20)).rejects.toMatchObject({ code: 'path-alias' });
    }
    await expect(migrationNames(value.oldPackage, 1)).rejects.toMatchObject({ code: 'inventory-limit' });
    expect(await migrationAbsent(path.join(value.root, 'missing'))).toBe(true);
    await expect(migrationLauncher(value.node)).rejects.toMatchObject({ code: 'launcher-not-attributable' });
  });

  it('rejects mismatched npm executable, version manager and launcher before any removal', async () => {
    const value = await fixture();
    const scratch = await value.dependencies.upgrade.makeNeutralDirectory();
    try {
      await expect(inspectMacNpmOwner({ ...value.request.selection!, manager: 'nvm' }, value.dependencies.upgrade, scratch))
        .rejects.toMatchObject({ code: 'missing-nvm-root' });
      await expect(inspectMacNpmOwner({ ...value.request.selection!, npm: value.node }, value.dependencies.upgrade, scratch)).rejects.toThrow();
      await unlink(value.oldLauncher); await symlink(value.node, value.oldLauncher);
      await expect(inspectMacNpmOwner(value.request.selection!, value.dependencies.upgrade, scratch))
        .rejects.toMatchObject({ code: 'unproven-old-launcher' });
    } finally { await value.dependencies.upgrade.removeNeutralDirectory(scratch); }
  });
});

describe('unsupported migration host refusal on every test platform', () => {
  it.each([
    { platform: 'linux' }, { platform: 'win32' }, { architecture: 'x64' }, { nativeArchitecture: 'x86_64' },
    { appleSilicon: '0' }, { translated: '1' }, { translated: 'unknown' }, { osVersion: '13.4' },
    { osVersion: '12.9' }, { osVersion: 'unknown' }
  ])('rejects %j before manager or scratch effects', async change => {
    const dependencies = defaultMacMigrationDependencies();
    dependencies.host = async () => ({ platform: 'darwin', architecture: 'arm64', nativeArchitecture: 'arm64',
      appleSilicon: '1', translated: '0', osVersion: '15.7', runtimeVersion: '24.21.0', ...change });
    const run = vi.spyOn(dependencies.upgrade.runner, 'run');
    const scratch = vi.spyOn(dependencies.upgrade, 'makeNeutralDirectory');
    expect(await runMacMigration({}, dependencies)).toMatchObject({ status: 'blocked', effects: 'none' });
    expect(run).not.toHaveBeenCalled(); expect(scratch).not.toHaveBeenCalled();
  });
});

describe('standalone interface and no-public-authority contract', () => {
  it('defaults to preview with no old executable invocation and documents explicit source-only limits', () => {
    expect(parseMacMigration([])).toEqual({});
    expect(macMigrationHelp).toContain('SOURCE ONLY');
    expect(macMigrationHelp).toContain('Public apply remains blocked');
    expect(macMigrationHelp).not.toMatch(/brew install .*--version/);
    expect(macMigrationBridge).toMatchObject({ published: false, executableMigrationAuthority: false,
      legacyPackage: '@msn-control/liftoff', standaloneCommand: 'liftoff-migrate-npm' });
    const prefix = path.resolve('custom'); const privateRoot = path.resolve('private journal');
    expect(parseMacMigration(['--npm', path.join(prefix, 'npm'), '--node', path.join(prefix, 'node'), '--prefix', prefix, '--manager', 'custom',
      '--apply', 'a'.repeat(64), '--journal', privateRoot])).toMatchObject({
      selection: { prefix, manager: 'custom' }, apply: { review: 'a'.repeat(64), journalRoot: privateRoot }
    });
    expect(parseMacMigration(['--recover', 'b'.repeat(64), '--journal', privateRoot, '--dead-lock', 'c'.repeat(64)]))
      .toMatchObject({ recover: { journalSha256: 'b'.repeat(64), deadLockSha256: 'c'.repeat(64) } });
  });
  it.each([
    ['--help', '--apply'], ['--apply'], ['--apply', 'latest'], ['--apply', 'A'.repeat(64)], ['--journal', '/private'],
    ['--recover', 'a'.repeat(64)], ['--recover', 'a'.repeat(64), '--journal', '/private', '--brew', '/brew'],
    ['--dead-lock', 'a'.repeat(64)], ['--npm', '/npm'], ['--brew', 'relative'], ['--brew', '/a/../b'],
    ['--brew', '/a', '--brew', '/b'], ['--manager-root', '/root'],
    ['--npm', '/npm', '--node', '/node', '--prefix', '/prefix', '--manager', 'unknown']
  ])('rejects ambiguous option set %j', args => expect(() => parseMacMigration(args)).toThrow());
  it('clears inherited loaders, manager settings and shared cache/config/auto-update authority', () => {
    const dependencies = { ...defaultMacMigrationDependencies().upgrade,
      environment: { HOME: '/home', PATH: '/foreign', NODE_OPTIONS: '--require=foreign', npm_config_registry: 'https://foreign' } };
    const scratch = path.resolve('private scratch'); const node = path.resolve('selected/node');
    expect(migrationEnvironment(dependencies, scratch, node)).toMatchObject({
      HOME: scratch, TMPDIR: scratch, NODE_OPTIONS: '', NODE_PATH: '',
      npm_config_cache: path.join(scratch, 'npm-cache'), HOMEBREW_CACHE: path.join(scratch, 'homebrew-cache'),
      npm_config_userconfig: path.join(scratch, 'absent.npmrc'), HOMEBREW_NO_AUTO_UPDATE: '1', npm_config_offline: 'true'
    });
    expect(migrationEnvironment(dependencies, scratch, node)).not.toHaveProperty('npm_config_registry');
  });
});
