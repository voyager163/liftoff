import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { executeSkillsUseCase } from '../src/application/skills/use-case.js';
import { negotiateSkillCapability } from '../src/application/skills/capability-negotiation.js';
import { buildPublicCapabilitiesEnvelope } from '../src/application/engine-composition.js';
import { canonicalSkillBody } from '../src/domain/skills/catalog.js';
import { getCanonicalSkill } from '../src/adapters/packaged-assets/skill-assets.js';
import { projectSkillForHost } from '../src/adapters/skills/host-projections.js';
import { skillsFixture } from './helpers/skills-fixture.js';

describe('Static skill guidance and staged business preservation (not native-host qualification)', () => {
  let fixtureRoot: string;
  let fixture: Awaited<ReturnType<typeof skillsFixture>>;

  beforeEach(async () => {
    fixture = await skillsFixture();
    fixtureRoot = fixture.project;
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('demonstrates host equivalence across Copilot, Claude, and Codex for all lifecycle stages', () => {
    const lifecycleSkills = ['assess', 'adopt', 'update', 'repair'] as const;

    for (const skillId of lifecycleSkills) {
      const canonical = getCanonicalSkill(skillId);
      const copilot = projectSkillForHost(canonical, 'github-copilot', 'project');
      const claude = projectSkillForHost(canonical, 'claude', 'project');
      const codex = projectSkillForHost(canonical, 'codex', 'project');

      // Canonical instructions are identical across all three host projections
      const body = canonicalSkillBody(canonical);
      expect(copilot.renderedContent).toContain(body);
      expect(claude.renderedContent).toContain(body);
      expect(codex.renderedContent).toContain(body);

      expect(copilot.renderedContent).toContain('Capability Negotiation');
      expect(claude.renderedContent).toContain('Capability Negotiation');
      expect(codex.renderedContent).toContain('Capability Negotiation');

      if (skillId !== 'assess') {
        expect(copilot.renderedContent).toMatch(/approval/i);
        expect(claude.renderedContent).toMatch(/approval/i);
        expect(codex.renderedContent).toMatch(/approval/i);
      }

      // Invocations are distinct and valid
      expect(copilot.invocation).toBe(`/liftoff-${skillId}`);
      expect(claude.invocation).toBe(`/liftoff-${skillId}`);
      expect(codex.invocation).toBe(`$liftoff-${skillId}`);
    }
  });

  it('inspects skills without rewriting staged business files', async () => {
    // Stage an existing business project with user code
    const srcDir = path.join(fixtureRoot, 'src');
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, 'index.ts'), 'export const businessLogic = () => "active";');
    await writeFile(path.join(fixtureRoot, 'package.json'), '{"name": "my-app", "dependencies": {"fastify": "^4.0.0"}}');

    const result = await executeSkillsUseCase({
      subcommand: 'inspect',
      scope: 'project',
      project: fixtureRoot,
      hosts: ['github-copilot']
    }, { cwd: fixture.cwd }, fixture.dependencies);

    // Verification reports project state without modifying existing business code
    expect(result.ok).toBe(true);
    const businessFile = await readFile(path.join(srcDir, 'index.ts'), 'utf8');
    expect(businessFile).toBe('export const businessLogic = () => "active";');
  });

  it('keeps explicitly unqualified provider capabilities non-executable', () => {
    const actual = buildPublicCapabilitiesEnvelope();
    const offlineContract = {
      ...actual, capabilities: actual.capabilities.map((entry) =>
        entry.id === 'azure-activation' || entry.id === 'repository-governance'
          ? { ...entry, qualificationState: 'unqualified' as const } : entry)
    };

    const azureCheck = negotiateSkillCapability('azure', offlineContract);
    expect(azureCheck.status).toBe('unqualified');
    expect(azureCheck.authority).toBe('none');

    const govCheck = negotiateSkillCapability('governance', offlineContract);
    expect(govCheck.status).toBe('unqualified');
    expect(govCheck.authority).toBe('none');
  });

  it('ensures model reasoning remains advisory and cannot bypass CLI admission gates', async () => {
    const plan = await executeSkillsUseCase({
      subcommand: 'plan',
      scope: 'project',
      project: fixtureRoot,
      hosts: ['github-copilot'],
      skillId: 'repair'
    }, { cwd: fixture.cwd }, fixture.dependencies);

    expect(plan.ok).toBe(true);

    const unapproved = await executeSkillsUseCase({
        subcommand: 'install',
        scope: 'project',
        project: fixtureRoot,
        hosts: ['github-copilot'],
        skillId: 'repair'
      }, { cwd: fixture.cwd }, fixture.dependencies);
    expect(unapproved.outcome).toBe('planned');
    expect(unapproved.exitCode).toBe(2);
  });
});
