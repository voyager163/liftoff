import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { executeSkillsUseCase } from '../src/application/skills/use-case.js';
import { loadOwnershipStore } from '../src/application/skills/ownership.js';
import { getCanonicalSkill } from '../src/adapters/packaged-assets/skill-assets.js';
import { projectSkillForHost } from '../src/adapters/skills/host-projections.js';
import { skillsFixture, terminalStreams } from './helpers/skills-fixture.js';

describe('Reviewed personal delivery, independent from project initialization', () => {
  let fixture: Awaited<ReturnType<typeof skillsFixture>>;
  beforeEach(async () => { fixture = await skillsFixture(); });
  afterEach(async () => { await fixture.cleanup(); });

  it('defaults to user scope in unrelated working directories without any project manifest', async () => {
    for (const cwd of [fixture.cwd, fixture.project]) {
      const result = await executeSkillsUseCase({
        subcommand: 'plan', hosts: ['claude'], skillId: 'assess'
      }, { cwd }, fixture.dependencies);
      expect(result.outcome).toBe('planned');
      if (result.outcome !== 'planned') continue;
      expect(result.result.scope).toBe('user');
      expect(result.result.targetRoot).toBe(fixture.home);
    }
    expect((await fixture.apply({ skillId: undefined })).ok).toBe(true);
    expect(Object.keys((await loadOwnershipStore('user', fixture.home)).projections)).toHaveLength(11);
    expect(await readdir(fixture.cwd)).toEqual([]);
    expect(await readdir(fixture.project)).toEqual([]);
  });

  it('maintains one byte-identical Copilot/Codex physical projection with both selected consumers', async () => {
    const result = await fixture.apply({ hosts: ['github-copilot', 'codex'], skillId: undefined });
    expect(result.ok).toBe(true);
    const store = await loadOwnershipStore('user', fixture.home);
    expect(Object.keys(store.projections)).toHaveLength(11);
    for (const record of Object.values(store.projections)) {
      expect(record.consumers).toEqual(['github-copilot', 'codex']);
      const copilot = projectSkillForHost(getCanonicalSkill(record.skillId), 'github-copilot', 'user');
      const codex = projectSkillForHost(getCanonicalSkill(record.skillId), 'codex', 'user');
      expect(copilot.renderedContent).toBe(codex.renderedContent);
      expect(await readFile(path.join(fixture.home, ...record.pathParts), 'utf8')).toBe(copilot.renderedContent);
    }
  });

  it('discloses shared visibility without adding the unselected host as a consumer', async () => {
    const plan = await fixture.preview({ hosts: ['codex'] });
    expect(plan.overlappingDiscoveryDisclosures.join('\n')).toContain('shared with Copilot');
    expect(plan.actions[0].consumers).toEqual(['codex']);
    expect((await fixture.apply({ hosts: ['codex'] })).ok).toBe(true);
    expect(Object.values((await loadOwnershipStore('user', fixture.home)).projections)[0].consumers).toEqual(['codex']);
  });

  it('uses Claude personal commands without creating another host projection or changing settings', async () => {
    const settings = path.join(fixture.home, '.vscode', 'settings.json');
    await mkdir(path.dirname(settings));
    await writeFile(settings, '{"custom.setting":true}\n');
    expect((await fixture.apply({ skillId: undefined })).ok).toBe(true);
    const store = await loadOwnershipStore('user', fixture.home);
    expect(Object.keys(store.projections).every((key) => key.startsWith('.claude/commands/'))).toBe(true);
    await expect(readdir(path.join(fixture.home, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(settings, 'utf8')).toBe('{"custom.setting":true}\n');
  });

  it('keeps JSON and nonterminal invocation as a zero-write preview even when a prompt returns Yes', async () => {
    const terminal = terminalStreams();
    let prompts = 0;
    for (const json of [true, false]) {
      const result = await executeSkillsUseCase({
        subcommand: 'install', hosts: ['claude'], skillId: 'assess', json
      }, {
        cwd: fixture.cwd, ...terminal,
        stdin: json ? terminal.stdin : undefined,
        approveUpdatePlan: async () => { prompts++; return true; }
      }, fixture.dependencies);
      expect(result.outcome).toBe('planned');
      expect(result.exitCode).toBe(2);
    }
    expect(prompts).toBe(0);
    expect(await readdir(fixture.home)).toEqual([]);
    expect(await readdir(fixture.cwd)).toEqual([]);
  });

  it('uses project scope only when explicitly selected and does not invent initialization metadata', async () => {
    const result = await fixture.apply({ scope: 'project', project: fixture.project });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(Object.keys((await loadOwnershipStore('project', fixture.project)).projections)).toEqual(['.claude/commands/liftoff-assess.md']);
    await expect(readFile(path.join(fixture.project, 'liftoff.manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(path.join(fixture.home, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
