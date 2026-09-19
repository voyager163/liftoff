import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { executeSkillsUseCase } from '../src/application/skills/use-case.js';
import { loadOwnershipStore, skillOwnershipPathParts } from '../src/application/skills/ownership.js';
import { canonicalJson, sha256Hex } from '../src/domain/governance/activation/canonical-json.js';
import { projectSkillForHost } from '../src/adapters/skills/host-projections.js';
import { getCanonicalSkill, loadCanonicalSkillCatalog } from '../src/adapters/packaged-assets/skill-assets.js';
import type { SkillCatalog } from '../src/domain/skills/contracts.js';
import { skillsFixture, stageSkillCatalog } from './helpers/skills-fixture.js';

describe('Exact skill ownership and shared-consumer lifecycle', () => {
  let fixture: Awaited<ReturnType<typeof skillsFixture>>;
  beforeEach(async () => { fixture = await skillsFixture(); });
  afterEach(async () => { await fixture.cleanup(); });
  const request = { subcommand: 'install' as const, hosts: ['claude' as const], skillId: 'assess' as const };
  const relative = '.claude/commands/liftoff-assess.md';

  it('preserves different unowned bytes and rejects any approval of the collision', async () => {
    const destination = path.join(fixture.home, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, 'custom user skill');
    const preview = await executeSkillsUseCase({ ...request, check: true }, { cwd: fixture.cwd }, fixture.dependencies);
    expect(preview.outcome).toBe('blocked-plan');
    if (preview.outcome !== 'blocked-plan') return;
    expect(preview.result.actions[0].action).toBe('collision-unowned');
    const apply = await executeSkillsUseCase({ ...request, approvePlan: preview.result.fingerprint }, { cwd: fixture.cwd }, fixture.dependencies);
    expect(apply.outcome).toBe('blocked-plan');
    expect(await readFile(destination, 'utf8')).toBe('custom user skill');
    expect((await loadOwnershipStore('user', fixture.home)).projections).toEqual({});
  });

  it('adopts only reviewed exact registered matching bytes, without rewriting the file', async () => {
    const destination = path.join(fixture.home, relative);
    const projection = projectSkillForHost(getCanonicalSkill('assess'), 'claude', 'user');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, projection.renderedContent, { mode: 0o640 });
    const before = await lstat(destination);
    const plan = await fixture.preview();
    expect(plan.actions[0].action).toBe('adopt');
    expect((await loadOwnershipStore('user', fixture.home)).projections).toEqual({});
    const result = await fixture.apply();
    expect(result.outcome).toBe('executed');
    if (result.outcome !== 'executed') return;
    expect(result.result.fileChangeCount).toBe(0);
    expect(result.result.ownershipChangeCount).toBe(1);
    const after = await lstat(destination);
    expect([after.ino, after.mtimeMs, after.mode]).toEqual([before.ino, before.mtimeMs, before.mode]);
    expect((await loadOwnershipStore('user', fixture.home)).projections[relative].logicalId).toBe('canonical-skill:assess');
  });

  it('updates only unchanged owned bytes from a newly reviewed canonical catalog', async () => {
    expect((await fixture.apply()).ok).toBe(true);
    const original = await readFile(path.join(fixture.home, relative), 'utf8');
    const revised: SkillCatalog = structuredClone(loadCanonicalSkillCatalog());
    const skill = revised.skills.find((entry) => entry.id === 'assess')!;
    skill.content += '\nA reviewed canonical instruction revision.\n';
    skill.contentHash = sha256Hex(skill.content!);
    fixture.dependencies.catalogRoot = await stageSkillCatalog(fixture.root, revised);
    fixture.dependencies.loadCatalog = () => revised;
    const result = await fixture.apply({ subcommand: 'update' });
    expect(result.ok).toBe(true);
    const current = await readFile(path.join(fixture.home, relative), 'utf8');
    expect(current).not.toBe(original);
    expect(current).toContain('A reviewed canonical instruction revision.');
    expect((await fixture.apply({ subcommand: 'update' })).result).toMatchObject({ outcome: 'unchanged' });
  });

  it.each(['bytes', 'mode', 'absence'] as const)('preserves a managed %s conflict and its original ownership record', async (change) => {
    expect((await fixture.apply()).ok).toBe(true);
    const destination = path.join(fixture.home, relative);
    const ownership = path.join(fixture.home, ...skillOwnershipPathParts);
    const before = await readFile(ownership);
    if (change === 'bytes') await writeFile(destination, 'customized managed instruction');
    if (change === 'mode') await chmod(destination, 0o444);
    if (change === 'absence') await unlink(destination);
    for (const subcommand of ['update', 'remove'] as const) {
      const result = await executeSkillsUseCase({ ...request, subcommand, check: true }, { cwd: fixture.cwd }, fixture.dependencies);
      expect(result.outcome).toBe('blocked-plan');
      if (result.outcome === 'blocked-plan') expect(result.result.actions[0].action).toBe('conflict-modified');
    }
    expect(await readFile(ownership)).toEqual(before);
    if (change === 'bytes') expect(await readFile(destination, 'utf8')).toBe('customized managed instruction');
    if (change === 'absence') await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not turn update into installation or remove an unowned file', async () => {
    expect((await fixture.apply({ subcommand: 'update' })).result).toMatchObject({ outcome: 'unchanged' });
    expect(await readdir(fixture.home)).toEqual([]);
    const destination = path.join(fixture.home, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, 'unowned');
    expect((await fixture.apply({ subcommand: 'remove' })).result).toMatchObject({ outcome: 'unchanged' });
    expect(await readFile(destination, 'utf8')).toBe('unowned');
    await expect(readFile(path.join(fixture.home, ...skillOwnershipPathParts))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('subtracts all selected shared consumers once and persists only real metadata changes', async () => {
    expect((await fixture.apply({ hosts: ['github-copilot', 'codex'] })).ok).toBe(true);
    const destination = path.join(fixture.home, '.agents', 'skills', 'liftoff-assess', 'SKILL.md');
    const before = await lstat(destination);
    expect((await fixture.apply({ subcommand: 'remove', hosts: ['github-copilot'] })).ok).toBe(true);
    const record = Object.values((await loadOwnershipStore('user', fixture.home)).projections)[0];
    expect(record.host).toBe('codex');
    expect(record.consumers).toEqual(['codex']);
    expect((await lstat(destination)).ino).toBe(before.ino);
    expect((await fixture.apply({ subcommand: 'remove', hosts: ['github-copilot'] })).result).toMatchObject({ outcome: 'unchanged' });
    expect((await fixture.apply({ hosts: ['github-copilot'] })).ok).toBe(true);
    const removed = await fixture.apply({ subcommand: 'remove', hosts: ['github-copilot', 'codex'] });
    expect(removed.result).toMatchObject({ fileChangeCount: 1, ownershipChangeCount: 1 });
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await loadOwnershipStore('user', fixture.home)).projections).toEqual({});
    expect((await fixture.apply({ subcommand: 'remove', hosts: ['github-copilot', 'codex'] })).result).toMatchObject({ outcome: 'unchanged' });
  });

  it('retains an unselected shared owner and removes one physical owned file once regardless of future projection bytes', async () => {
    expect((await fixture.apply({ hosts: ['github-copilot'] })).ok).toBe(true);
    const destination = path.join(fixture.home, '.agents', 'skills', 'liftoff-assess', 'SKILL.md');
    const before = await lstat(destination);
    const unchanged = await fixture.apply({ subcommand: 'remove', hosts: ['codex'] });
    expect(unchanged.result).toMatchObject({ outcome: 'unchanged' });
    expect((await lstat(destination)).ino).toBe(before.ino);
    const removed = await fixture.apply({ subcommand: 'remove', hosts: ['github-copilot', 'codex'] });
    expect(removed.result).toMatchObject({ outcome: 'applied', fileChangeCount: 1, ownershipChangeCount: 1 });
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves neighboring framework files and all directories lacking exact cleanup authority', async () => {
    const commands = path.join(fixture.home, '.claude', 'commands');
    await mkdir(commands, { recursive: true });
    const framework = path.join(commands, 'openspec-apply-change.md');
    const neighbor = path.join(commands, 'README.md');
    await writeFile(framework, 'Framework-owned skill');
    await writeFile(neighbor, 'Custom notes');
    const directory = await lstat(commands);
    expect((await fixture.apply()).ok).toBe(true);
    expect((await fixture.apply({ subcommand: 'remove' })).ok).toBe(true);
    expect(await readFile(framework, 'utf8')).toBe('Framework-owned skill');
    expect(await readFile(neighbor, 'utf8')).toBe('Custom notes');
    expect((await lstat(commands)).ino).toBe(directory.ino);
  });

  it('rejects a redirected ownership target without writing the supplied root', async () => {
    expect((await fixture.apply()).ok).toBe(true);
    const store = await loadOwnershipStore('user', fixture.home);
    const file = path.join(fixture.home, ...skillOwnershipPathParts);
    await writeFile(file, canonicalJson({ ...store, targetRoot: fixture.project }));
    await expect(loadOwnershipStore('user', fixture.home)).rejects.toThrow(/canonical target/);
    expect(await readdir(fixture.project)).toEqual([]);
    expect(await readFile(path.join(fixture.home, relative), 'utf8')).toContain('Liftoff');
  });

  it('fully rejects malformed ownership schema, identity, hashes, paths, hosts, consumers, and modes', async () => {
    expect((await fixture.apply()).ok).toBe(true);
    const original = await loadOwnershipStore('user', fixture.home);
    const file = path.join(fixture.home, ...skillOwnershipPathParts);
    const record = original.projections[relative];
    const invalidRecords = [
      { logicalId: 'canonical-skill:repair' }, { skillId: 'custom' }, { host: 'codex' },
      { pathParts: ['..', 'outside'] }, { relativeDestination: '.claude/commands/custom.md' },
      { canonicalContentHash: 'bad' }, { projectedContentHash: 'A'.repeat(64) }, { catalogDigest: 'bad' },
      { catalogVersion: 'unknown' }, { installedByPlan: '' }, { updatedByPlan: true },
      { consumers: [] }, { consumers: ['claude', 'claude'] }, { consumers: ['codex'] },
      { consumers: ['claude', 'github-copilot'] }, { projectedMode: 0o777 }, { unknown: true }
    ];
    for (const patch of invalidRecords) {
      await writeFile(file, canonicalJson({ ...original, projections: { [relative]: { ...record, ...patch } } }));
      await expect(loadOwnershipStore('user', fixture.home), JSON.stringify(patch)).rejects.toThrow();
    }
    for (const patch of [{ schemaVersion: 2 }, { kind: 'unknown' }, { scope: 'project' }, { catalogId: 'other' }, { unknown: true }]) {
      await writeFile(file, canonicalJson({ ...original, ...patch }));
      await expect(loadOwnershipStore('user', fixture.home), JSON.stringify(patch)).rejects.toThrow();
    }
    await writeFile(file, '{"schemaVersion":1');
    await expect(loadOwnershipStore('user', fixture.home)).rejects.toThrow(/malformed JSON/);
  });
});
