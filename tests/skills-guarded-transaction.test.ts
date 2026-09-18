import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstat, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSkillDeliveryPlan } from '../src/application/skills/planning.js';
import { executeSkillDeliveryPlan } from '../src/application/skills/execution.js';
import { loadOwnershipStore, skillOwnershipPathParts } from '../src/application/skills/ownership.js';
import { skillsFixture, fixtureApprovalStore } from './helpers/skills-fixture.js';
import { createSkillsTransactionApprovalStore } from '../src/adapters/filesystem/update-previews.js';
import { clearSkillCatalogCache, loadCanonicalSkillCatalog } from '../src/adapters/packaged-assets/skill-assets.js';

describe('Skills uses the released guarded transaction and real private approvals', () => {
  let fixture: Awaited<ReturnType<typeof skillsFixture>>;
  beforeEach(async () => { fixture = await skillsFixture(); });
  afterEach(async () => { await fixture.cleanup(); });

  it('installs into isolated user home without a project or home-parent lock write', async () => {
    const beforeParent = await readdir(fixture.root);
    const result = await fixture.apply();
    expect(result.outcome).toBe('executed');
    expect(result.ok).toBe(true);
    if (result.outcome !== 'executed') return;
    expect(result.result.outcome).toBe('applied');
    expect(result.result.committed).toBe(true);
    expect(result.result.verified).toBe(true);
    const store = await loadOwnershipStore('user', fixture.home);
    expect(Object.keys(store.projections)).toEqual(['.claude/commands/liftoff-assess.md']);
    expect(await readdir(fixture.root)).toEqual(beforeParent);
    expect(await readdir(fixture.cwd)).toEqual([]);
    expect(await readdir(fixture.project)).toEqual([]);
    expect(await readdir(path.join(fixture.home, '.liftoff'))).toEqual(['skills-ownership.json']);
  });

  it('repeated matching install is a true zero-write no-op, including ownership mode/inode/mtime', async () => {
    expect((await fixture.apply()).ok).toBe(true);
    const storePath = path.join(fixture.home, ...skillOwnershipPathParts);
    const filePath = path.join(fixture.home, '.claude', 'commands', 'liftoff-assess.md');
    const before = await Promise.all([storePath, filePath].map(async (file) => ({
      bytes: await readFile(file), stat: await lstat(file)
    })));
    const result = await fixture.apply();
    expect(result.outcome).toBe('executed');
    if (result.outcome !== 'executed') return;
    expect(result.result.outcome).toBe('unchanged');
    expect(result.result.appliedCount).toBe(0);
    for (const [index, file] of [storePath, filePath].entries()) {
      expect(await readFile(file)).toEqual(before[index].bytes);
      const stat = await lstat(file);
      expect([stat.ino, stat.mode, stat.mtimeMs, stat.ctimeMs])
        .toEqual([before[index].stat.ino, before[index].stat.mode, before[index].stat.mtimeMs, before[index].stat.ctimeMs]);
    }
  });

  it('preserves a file created after review instead of treating a read error or stale absence as permission', async () => {
    const plan = await createSkillDeliveryPlan({
      scope: 'user', targetRoot: fixture.home, hosts: ['claude'], skillIds: ['assess']
    }, { now: fixture.dependencies.now });
    await writeFile(path.join(fixture.home, '.claude'), 'a user file replaced the absent parent');
    await expect(executeSkillDeliveryPlan(plan, { approvePlan: plan.fingerprint }, {
      approvalStore: fixtureApprovalStore(fixture.home)
    })).rejects.toThrow(/not a directory|changed after review/);
    expect(await readFile(path.join(fixture.home, '.claude'), 'utf8')).toBe('a user file replaced the absent parent');
  });

  it('does not redirect private approval writes into a current repository through a home-state symlink', async () => {
    const ancestor = process.platform === 'darwin' ? 'Library' : process.platform === 'win32' ? 'AppData' : '.local';
    await symlink(fixture.cwd, path.join(fixture.home, ancestor), 'dir');
    const result = await fixture.apply();
    expect(result.outcome).toBe('executed');
    expect(result.result).toMatchObject({ outcome: 'failed', committed: false });
    expect(await readdir(fixture.cwd)).toEqual([]);
    await expect(readFile(path.join(fixture.home, '.claude', 'commands', 'liftoff-assess.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires the independent canonical home identity for user private approvals', async () => {
    const redirected = createSkillsTransactionApprovalStore(fixture.home, 'user', { env: {}, homedir: fixture.project });
    await expect(redirected.write('a'.repeat(64), 'b'.repeat(64))).rejects.toThrow(/independently selected canonical user home/);
    expect(await readdir(fixture.home)).toEqual([]);
    expect(await readdir(fixture.project)).toEqual([]);
  });

  it('rebuilds approved effects from fresh packaged sources rather than mutable cached catalog data', async () => {
    const plan = await createSkillDeliveryPlan({
      scope: 'user', targetRoot: fixture.home, hosts: ['claude'], skillIds: ['assess']
    }, { now: fixture.dependencies.now });
    const cached = loadCanonicalSkillCatalog();
    cached.skills.find((skill) => skill.id === 'assess')!.description = 'Injected stale cache metadata.';
    try {
      const result = await executeSkillDeliveryPlan(plan, { approvePlan: plan.fingerprint }, {
        approvalStore: fixtureApprovalStore(fixture.home)
      });
      expect(result, result.message).toMatchObject({ outcome: 'applied', committed: true, verified: true });
      expect(await readFile(path.join(fixture.home, '.claude', 'commands', 'liftoff-assess.md'), 'utf8'))
        .not.toContain('Injected stale cache metadata.');
    } finally {
      clearSkillCatalogCache();
    }
  });
});
