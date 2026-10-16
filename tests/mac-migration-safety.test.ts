import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, chown, link, lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { userInfo } from 'node:os';
import { runMacMigration } from '../src/application/upgrade/mac-migration.js';
import { captureMigrationTree, migrationAbsent } from '../src/adapters/distribution/mac-migration-state.js';
import { assertMigrationMetadata, macMigrationHash } from '../src/adapters/distribution/mac-npm-owner.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { macMigrationFixture } from './fixtures/mac-migration.js';

type Fixture = Awaited<ReturnType<typeof macMigrationFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const value of fixtures.splice(0)) await value.cleanup(); });
async function fixture() { const value = await macMigrationFixture(); fixtures.push(value); return value; }

async function system(executable: string, args: string[]) {
  const result = await new NodeCommandRunner().run({ executable, args }, {
    cwd: '/', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0' },
    timeoutMs: 10_000, ensureProcessTreeSettled: true
  });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 0, processTreeSettled: true });
  return result.stdout;
}

async function assertBeforeUninstall(value: Fixture, blocker?: string) {
  const run = vi.spyOn(value.dependencies.upgrade.runner, 'run');
  const result = await runMacMigration(value.request, value.dependencies);
  expect(result).toMatchObject({ status: 'blocked', effects: 'none' });
  if (blocker) expect(result.blockers).toContain(blocker);
  expect(result.review).toBeUndefined();
  expect(run.mock.calls.some(([command]) => command.args.includes('uninstall'))).toBe(false);
  expect(await readFile(path.join(value.oldPackage, 'package.json'), 'utf8')).toContain('0.12.3');
  expect(await readlink(value.oldLauncher)).toBe('../lib/node_modules/@msn-control/liftoff/dist/cli.js');
  expect(await migrationAbsent(path.join(value.root, 'private journal'))).toBe(true);
}

describe.skipIf(process.platform === 'win32')('bounded migration recovery material safety', () => {
  it.each([0o500, 0o600])('refuses non-recreatable directory mode %s before approval or uninstall', async mode => {
    const value = await fixture();
    const directory = path.join(value.oldPackage, 'dist');
    const original = (await lstat(directory)).mode & 0o777;
    try {
      await chmod(directory, mode);
      await expect(captureMigrationTree(value.oldPackage)).rejects.toThrow('unrecoverable-old-directory');
      await assertBeforeUninstall(value, mode === 0o500 ? 'unrecoverable-old-directory' : undefined);
      expect((await lstat(directory)).mode & 0o777).toBe(mode);
    } finally { await chmod(directory, original); }
  });

  it('refuses multiply linked package bytes without deleting either entry', async () => {
    const value = await fixture();
    const source = path.join(value.oldPackage, 'dist/dependency.js');
    const alias = path.join(value.root, 'unrelated hard link');
    await link(source, alias);
    await expect(captureMigrationTree(value.oldPackage)).rejects.toThrow('single-link');
    expect(await readFile(alias)).toEqual(await readFile(source));
  });

  it('refuses a read-only launcher parent without widening its permissions', async () => {
    const value = await fixture();
    const directory = path.dirname(value.oldLauncher);
    const original = (await lstat(directory)).mode & 0o777;
    try {
      await chmod(directory, 0o500);
      await assertBeforeUninstall(value, 'unrecoverable-directory-permissions');
      expect((await lstat(directory)).mode & 0o777).toBe(0o500);
    } finally { await chmod(directory, original); }
  });

  const otherGroup = process.getgroups?.().find(group => group !== process.getgid?.());
  it.skipIf(otherGroup === undefined)('refuses a mixed-group entry without silently reassigning it during recovery', async () => {
    const value = await fixture();
    const file = path.join(value.oldPackage, 'dist/dependency.js');
    const original = await lstat(file);
    try {
      await chown(file, original.uid, otherGroup!);
      await assertBeforeUninstall(value, 'unsafe-old-material');
      expect((await lstat(file)).gid).toBe(otherGroup);
    } finally { await chown(file, original.uid, original.gid); }
  });

  it('still restores exact supported file/directory modes and observed provenance rather than widening or stripping them', async ({ task }) => {
    const value = await fixture();
    const nativeRun = NodeCommandRunner.prototype.run;
    const observations: unknown[] = [];
    vi.spyOn(NodeCommandRunner.prototype, 'run').mockImplementation(async function (this: NodeCommandRunner, command, options) {
      const result = await nativeRun.call(this, command, options);
      if (['/bin/ls', '/usr/bin/xattr'].includes(command.executable)) observations.push(result);
      return result;
    });
    for (const root of [value.oldPackage, value.recovery]) {
      await chmod(path.join(root, 'dist'), 0o700);
      await chmod(path.join(root, 'dist/dependency.js'), 0o400);
    }
    const expected = await captureMigrationTree(value.oldPackage);
    const provenanceFiles = [path.join(value.oldPackage, 'dist'), path.join(value.oldPackage, 'dist/dependency.js'), value.oldLauncher];
    const provenance = process.platform === 'darwin' ? await Promise.all(provenanceFiles.map(file =>
      system('/usr/bin/xattr', ['-s', '-p', '-x', 'com.apple.provenance', file]))) : [];
    value.dependencies.cask!.installExact = async () => ({ settled: true, installed: false });
    const preview = await runMacMigration(value.request, value.dependencies);
    expect(preview.status, JSON.stringify({ preview, observations })).toBe('ready');
    const journalRoot = path.join(value.root, 'private journal');
    const applied = await runMacMigration({ ...value.request, apply: { review: preview.review!, journalRoot } }, value.dependencies);
    expect(applied).toMatchObject({ status: 'partial', blockers: ['cask-install-failed'] });
    const bytes = await readFile(path.join(journalRoot, 'journal.json'));
    expect(await runMacMigration({ recover: { journalRoot, journalSha256: macMigrationHash(bytes) } }, value.dependencies))
      .toMatchObject({ status: 'restored', effects: 'old-restored', blockers: [] });
    expect((await captureMigrationTree(value.oldPackage)).content).toBe(expected.content);
    expect((await lstat(path.join(value.oldPackage, 'dist'))).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(value.oldPackage, 'dist/dependency.js'))).mode & 0o777).toBe(0o400);
    if (process.platform === 'darwin') {
      expect(await Promise.all(provenanceFiles.map(file =>
        system('/usr/bin/xattr', ['-s', '-p', '-x', 'com.apple.provenance', file])))).toEqual(provenance);
    }
    Object.assign(task.meta, { metadataPreservation: { observedProvenanceHex: provenance,
      originalInventory: expected.entries, restoredInventory: (await captureMigrationTree(value.oldPackage)).entries,
      qualification: 'Actual private filesystem/process metadata readback; synthetic cask failure, no public provider.' } });
  });
});

describe.skipIf(process.platform !== 'darwin')('actual private Darwin metadata refusal', () => {
  const cases = (['file', 'directory'] as const).flatMap(kind =>
    (['acl', 'xattr', 'flags'] as const).map(metadata => ({ kind, metadata })));

  it.for(cases)('refuses $metadata on the old $kind without stripping it or uninstalling', async ({ kind, metadata }) => {
    const value = await fixture();
    const selected = kind === 'directory' ? path.join(value.oldPackage, 'dist') : path.join(value.oldPackage, 'dist/dependency.js');
    const attribute = 'org.liftoff.migration-fixture';
    try {
      if (metadata === 'acl') await system('/bin/chmod', ['+a', `user:${userInfo().username} allow read`, selected]);
      if (metadata === 'xattr') await system('/usr/bin/xattr', ['-w', attribute, 'preserve exact fixture', selected]);
      if (metadata === 'flags') await system('/usr/bin/chflags', ['hidden', selected]);
      const before = await system('/bin/ls', ['-dlenO@', selected]);
      await assertBeforeUninstall(value, 'unrecoverable-mac-metadata');
      expect(await system('/bin/ls', ['-dlenO@', selected])).toBe(before);
      if (metadata === 'xattr') expect(await system('/usr/bin/xattr', ['-p', attribute, selected])).toBe('preserve exact fixture\n');
    } finally {
      if (metadata === 'acl') await system('/bin/chmod', ['-N', selected]);
      if (metadata === 'xattr') await system('/usr/bin/xattr', ['-d', attribute, selected]);
      if (metadata === 'flags') await system('/usr/bin/chflags', ['nohidden', selected]);
    }
  });

  it('refuses extended launcher metadata before residual-link deletion', async () => {
    const value = await fixture();
    const attribute = 'org.liftoff.migration-fixture';
    try {
      await system('/usr/bin/xattr', ['-s', '-w', attribute, 'preserve launcher', value.oldLauncher]);
      await assertBeforeUninstall(value, 'unrecoverable-mac-metadata');
      expect(await system('/usr/bin/xattr', ['-s', '-p', attribute, value.oldLauncher])).toBe('preserve launcher\n');
    } finally { await system('/usr/bin/xattr', ['-s', '-d', attribute, value.oldLauncher]); }
  });

  it('rechecks native metadata at exact apply rather than trusting a stale preview', async () => {
    const value = await fixture();
    const preview = await runMacMigration(value.request, value.dependencies);
    expect(preview.status).toBe('ready');
    const selected = path.join(value.oldPackage, 'dist/dependency.js');
    const attribute = 'org.liftoff.migration-fixture';
    const run = vi.spyOn(value.dependencies.upgrade.runner, 'run');
    try {
      await system('/usr/bin/xattr', ['-w', attribute, 'concurrent metadata', selected]);
      expect(await runMacMigration({ ...value.request, apply: { review: preview.review!,
        journalRoot: path.join(value.root, 'private journal') } }, value.dependencies))
        .toMatchObject({ status: 'blocked', effects: 'none', blockers: ['unrecoverable-mac-metadata'] });
      expect(run.mock.calls.some(([command]) => command.args.includes('uninstall'))).toBe(false);
      expect(await migrationAbsent(value.oldPackage)).toBe(false);
      expect(await migrationAbsent(path.join(value.root, 'private journal'))).toBe(true);
    } finally { await system('/usr/bin/xattr', ['-d', attribute, selected]); }
  });

  it('blocks unavailable metadata observations rather than qualifying mode-only recovery', async () => {
    const run = vi.spyOn(NodeCommandRunner.prototype, 'run').mockResolvedValue({
      command: { executable: '/bin/ls', args: [] }, displayCommand: '/bin/ls',
      status: 0, stdout: '', stderr: '', signal: null, timedOut: false, processTreeSettled: false
    });
    await expect(assertMigrationMetadata(['/private/selected fixture'])).rejects.toMatchObject({ code: 'mac-metadata-unavailable' });
    expect(run.mock.calls[0][0]).toEqual({ executable: '/bin/ls', args: ['-dlenTO@', '--', '/private/selected fixture'] });
    expect(run.mock.calls[0][1]).toMatchObject({ cwd: '/', ensureProcessTreeSettled: true,
      env: { DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0', LC_ALL: 'C' } });
  });
});
