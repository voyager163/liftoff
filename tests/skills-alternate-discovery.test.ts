import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeSkillsUseCase } from '../src/application/skills/use-case.js';
import { loadOwnershipStore } from '../src/application/skills/ownership.js';
import { projectSkillForHost } from '../src/adapters/skills/host-projections.js';
import { getCanonicalSkill } from '../src/adapters/packaged-assets/skill-assets.js';
import type { SkillHostId, SkillScope } from '../src/domain/skills/contracts.js';
import { skillsFixture } from './helpers/skills-fixture.js';

describe('Documented alternate host roots (offline discovery admission, not agent-host qualification)', () => {
  let fixture: Awaited<ReturnType<typeof skillsFixture>>;
  beforeEach(async () => { fixture = await skillsFixture(); });
  afterEach(async () => { await fixture.cleanup(); });

  async function stage(root: string, relative: string, content = 'Unowned competing workflow') {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    return file;
  }

  it.each<[SkillHostId, SkillScope, string]>([
    ['github-copilot', 'user', '.copilot/skills/liftoff-assess/SKILL.md'],
    ['github-copilot', 'project', '.agents/skills/liftoff-assess/SKILL.md'],
    ['github-copilot', 'project', '.claude/skills/liftoff-assess/SKILL.md'],
    ['codex', 'user', '.copilot/skills/liftoff-assess/SKILL.md'],
    ['codex', 'project', '.github/skills/liftoff-assess/SKILL.md'],
    ['claude', 'user', '.claude/skills/liftoff-assess/SKILL.md'],
    ['claude', 'project', '.claude/skills/liftoff-assess/SKILL.md']
  ])('preserves and blocks a competing %s %s invocation at %s', async (host, scope, alternate) => {
    const root = scope === 'user' ? fixture.home : fixture.project;
    const file = await stage(root, alternate);
    const result = await executeSkillsUseCase({
      subcommand: 'install', scope, hosts: [host], skillId: 'assess',
      ...(scope === 'project' ? { project: fixture.project } : {})
    }, { cwd: fixture.cwd }, fixture.dependencies);
    expect(result).toMatchObject({
      outcome: 'blocked-plan', nextActions: [],
      result: { summary: { blocked: 1 }, hasConflicts: true }
    });
    if (result.outcome !== 'blocked-plan') throw new Error('Expected a blocked discovery plan.');
    expect(result.result.actions[0].reason).toContain(file);
    expect(result.result.files).toContainEqual(expect.objectContaining({
      pathParts: alternate.split('/'), state: 'file'
    }));
    expect(await readFile(file, 'utf8')).toBe('Unowned competing workflow');
    await expect(readFile(path.join(root, '.liftoff', 'skills-ownership.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects two planned conflicting project copies before either is created', async () => {
    const result = await executeSkillsUseCase({
      subcommand: 'install', scope: 'project', project: fixture.project,
      hosts: ['github-copilot', 'codex'], skillId: 'assess'
    }, { cwd: fixture.cwd }, fixture.dependencies);
    expect(result).toMatchObject({
      outcome: 'blocked-plan', result: { hasConflicts: true, summary: { blocked: 2 } }
    });
    expect(await readdir(fixture.project)).toEqual([]);
  });

  it('binds absence in alternate roots so a new competing file invalidates approved delivery', async () => {
    const options = { scope: 'project' as const, project: fixture.project, hosts: ['github-copilot' as const] };
    const plan = await fixture.preview(options);
    const alternate = '.claude/skills/liftoff-assess/SKILL.md';
    expect(plan.files).toContainEqual({ pathParts: alternate.split('/'), state: 'absent' });
    await stage(fixture.project, alternate);
    const result = await executeSkillsUseCase({
      ...options, subcommand: 'install', skillId: 'assess', approvePlan: plan.fingerprint
    }, { cwd: fixture.cwd }, fixture.dependencies);
    expect(result.ok).toBe(false);
    await expect(readFile(path.join(fixture.project, '.github', 'skills', 'liftoff-assess', 'SKILL.md')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('checks an opposite-scope alternate root rather than only the registered write destination', async () => {
    const file = await stage(fixture.home, '.copilot/skills/liftoff-assess/SKILL.md');
    const result = await executeSkillsUseCase({
      subcommand: 'plan', scope: 'project', project: fixture.project,
      hosts: ['github-copilot'], skillId: 'assess'
    }, { cwd: fixture.cwd }, fixture.dependencies);
    expect(result).toMatchObject({ outcome: 'blocked-plan', result: { hasConflicts: true } });
    if (result.outcome !== 'blocked-plan') throw new Error('Expected conflicting personal discovery.');
    expect(result.result.actions[0].reason).toContain(file);
    expect(result.result.discovery[0].files).toContainEqual(expect.objectContaining({
      pathParts: ['.copilot', 'skills', 'liftoff-assess', 'SKILL.md'], state: 'file'
    }));
    expect(await readdir(fixture.project)).toEqual([]);
  });

  it('discloses identical alternate bytes without claiming ownership or changing that file', async () => {
    const projection = projectSkillForHost(getCanonicalSkill('assess'), 'github-copilot', 'user');
    const file = await stage(fixture.home, '.copilot/skills/liftoff-assess/SKILL.md', projection.renderedContent);
    const plan = await fixture.preview({ hosts: ['github-copilot'] });
    expect(plan.overlappingDiscoveryDisclosures.join('\n')).toContain(file);
    expect(plan.summary.blocked).toBe(0);
    expect((await fixture.apply({ hosts: ['github-copilot'] })).ok).toBe(true);
    expect(Object.keys((await loadOwnershipStore('user', fixture.home)).projections))
      .toEqual(['.agents/skills/liftoff-assess/SKILL.md']);
    expect(await readFile(file, 'utf8')).toBe(projection.renderedContent);
  });

  it('allows exact owned removal without taking over a competing workflow', async () => {
    expect((await fixture.apply()).ok).toBe(true);
    const file = await stage(fixture.home, '.claude/skills/liftoff-assess/SKILL.md');
    expect((await fixture.apply({ subcommand: 'remove' })).ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('Unowned competing workflow');
    expect(Object.keys((await loadOwnershipStore('user', fixture.home)).projections)).toEqual([]);
  });

  it('does not confuse separate Claude commands and Copilot skills with overlapping transports', async () => {
    const options = { scope: 'project' as const, project: fixture.project, hosts: ['github-copilot' as const, 'claude' as const] };
    expect((await fixture.apply(options)).ok).toBe(true);
    expect(Object.keys((await loadOwnershipStore('project', fixture.project)).projections)).toHaveLength(2);
  });
});
