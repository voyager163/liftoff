import { describe, expect, it } from 'vitest';
import { loadCanonicalSkillCatalog } from '../src/adapters/packaged-assets/skill-assets.js';
import {
  projectSkillForHost,
  projectAllSkillsForHost,
  resolveSkillPathParts,
  resolveSkillInvocation
} from '../src/adapters/skills/host-projections.js';
import {
  resolveHostDiscoveryRoot,
  detectOverlappingPersonalRoots,
  isPathConfined
} from '../src/adapters/skills/discovery.js';
import type { SkillHostId } from '../src/domain/skills/contracts.js';
import { canonicalSkillBody } from '../src/domain/skills/catalog.js';

describe('Host projection contracts (not native discovery qualification)', () => {
  const catalog = loadCanonicalSkillCatalog();
  const hosts: readonly SkillHostId[] = ['github-copilot', 'claude', 'codex'];

  it('projects all 11 canonical skills for all 3 declared hosts in project scope', () => {
    for (const host of hosts) {
      const projections = projectAllSkillsForHost(catalog.skills, host, 'project');
      expect(projections).toHaveLength(11);

      for (const p of projections) {
        expect(p.host).toBe(host);
        expect(p.scope).toBe('project');
        expect(p.renderedContent.length).toBeGreaterThan(100);
        expect(p.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(p.canonicalHash).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('maps project scope paths to the documented transport surfaces', () => {
    for (const skill of catalog.skills) {
      const copilotParts = resolveSkillPathParts(skill.id, 'github-copilot', 'project');
      expect(copilotParts).toEqual(['.github', 'skills', `liftoff-${skill.id}`, 'SKILL.md']);

      const claudeParts = resolveSkillPathParts(skill.id, 'claude', 'project');
      expect(claudeParts).toEqual(['.claude', 'commands', `liftoff-${skill.id}.md`]);

      const codexParts = resolveSkillPathParts(skill.id, 'codex', 'project');
      expect(codexParts).toEqual(['.agents', 'skills', `liftoff-${skill.id}`, 'SKILL.md']);
    }
  });

  it('maps personal (user) scope paths with Copilot and Codex sharing .agents/skills', () => {
    for (const skill of catalog.skills) {
      const copilotParts = resolveSkillPathParts(skill.id, 'github-copilot', 'user');
      const codexParts = resolveSkillPathParts(skill.id, 'codex', 'user');
      const claudeParts = resolveSkillPathParts(skill.id, 'claude', 'user');

      // Shared physical projection
      expect(copilotParts).toEqual(['.agents', 'skills', `liftoff-${skill.id}`, 'SKILL.md']);
      expect(codexParts).toEqual(['.agents', 'skills', `liftoff-${skill.id}`, 'SKILL.md']);
      expect(copilotParts).toEqual(codexParts);

      // Claude native personal commands
      expect(claudeParts).toEqual(['.claude', 'commands', `liftoff-${skill.id}.md`]);
    }
  });

  it('renders byte-identical compatible content with both invocation forms for shared personal Copilot/Codex projection', () => {
    for (const skill of catalog.skills) {
      const copilotProjection = projectSkillForHost(skill, 'github-copilot', 'user');
      const codexProjection = projectSkillForHost(skill, 'codex', 'user');

      // Exact byte-identical content and hash
      expect(copilotProjection.renderedContent).toBe(codexProjection.renderedContent);
      expect(copilotProjection.contentHash).toBe(codexProjection.contentHash);
      expect(copilotProjection.relativeDestination).toBe(codexProjection.relativeDestination);

      // Header contains both invocation forms
      expect(copilotProjection.renderedContent).toContain(`# /liftoff-${skill.id} | $liftoff-${skill.id}`);
      expect(copilotProjection.renderedContent).toContain(`name: liftoff-${skill.id}`);
      expect(copilotProjection.renderedContent).toContain(`description: ${JSON.stringify(skill.description)}`);
      expect(copilotProjection.invocation).toBe(`/liftoff-${skill.id}`);
      expect(codexProjection.invocation).toBe(`$liftoff-${skill.id}`);
    }
  });

  it('preserves exact invocation identity across hosts', () => {
    for (const skill of catalog.skills) {
      expect(resolveSkillInvocation(skill.id, 'github-copilot')).toBe(`/liftoff-${skill.id}`);
      expect(resolveSkillInvocation(skill.id, 'claude')).toBe(`/liftoff-${skill.id}`);
      expect(resolveSkillInvocation(skill.id, 'codex')).toBe(`$liftoff-${skill.id}`);
    }
  });

  it('formats host-specific frontmatter while deriving 100% of instructions from canonical content', () => {
    const repairSkill = catalog.skills.find((s) => s.id === 'repair')!;

    const copilot = projectSkillForHost(repairSkill, 'github-copilot', 'project');
    expect(copilot.renderedContent).toContain('name: liftoff-repair');
    expect(copilot.renderedContent).toContain('# /liftoff-repair');
    expect(copilot.renderedContent).toContain('repair contract 1 and report schema 2');

    const claude = projectSkillForHost(repairSkill, 'claude', 'project');
    expect(claude.renderedContent).toContain('name: liftoff-repair');
    expect(claude.renderedContent).toContain('# /liftoff-repair');
    expect(claude.renderedContent).toContain(canonicalSkillBody(repairSkill));

    const codex = projectSkillForHost(repairSkill, 'codex', 'project');
    expect(codex.renderedContent).toContain('# $liftoff-repair');
    expect(codex.renderedContent).toContain(canonicalSkillBody(repairSkill));
    expect(codex.renderedContent.match(/^---$/gm)).toHaveLength(2);
  });

  it('resolves documented discovery roots and detects overlapping personal roots', () => {
    const copilotRoot = resolveHostDiscoveryRoot('github-copilot', 'user', '/mock/home');
    expect(copilotRoot.relativeDiscoveryRoot).toBe('.agents/skills');

    const codexRoot = resolveHostDiscoveryRoot('codex', 'user', '/mock/home');
    expect(codexRoot.relativeDiscoveryRoot).toBe('.agents/skills');

    const claudeRoot = resolveHostDiscoveryRoot('claude', 'user', '/mock/home');
    expect(claudeRoot.relativeDiscoveryRoot).toBe('.claude/commands');

    const sharedDisclosures = detectOverlappingPersonalRoots(['github-copilot', 'codex']);
    expect(sharedDisclosures).toHaveLength(1);
    expect(sharedDisclosures[0]).toContain('personal discovery root (~/.agents/skills)');

    const copilotOnlyDisclosures = detectOverlappingPersonalRoots(['github-copilot']);
    expect(copilotOnlyDisclosures[0]).toContain('Codex');
  });

  it('enforces path confinement to avoid traversal outside root boundary', () => {
    expect(isPathConfined('/mock/root', '/mock/root/sub/file.md')).toBe(true);
    expect(isPathConfined('/mock/root', '/mock/root/../other/file.md')).toBe(false);
    expect(isPathConfined('/mock/root', '/other/file.md')).toBe(false);
  });

  it('verifies that host projections contain no --yes approval guidance for new skills and workflows', () => {
    for (const host of hosts) {
      const projections = projectAllSkillsForHost(catalog.skills, host, 'project');
      for (const p of projections) {
        if (p.skillId !== 'init' && p.skillId !== 'migrate') {
          expect(p.renderedContent).not.toContain('--yes');
        } else {
          expect(p.renderedContent).toContain('--yes');
          expect(p.renderedContent).toMatch(/confirmation only|confirms choices\/plan only/);
        }
      }
    }
  });

  it('normalizes only registered host aliases and rejects unframed/unverified content', () => {
    const setupSkill = catalog.skills.find((s) => s.id === 'setup')!;

    // Test with 'copilot' alias
    const normalized = projectSkillForHost(setupSkill, 'copilot', 'user');
    expect(normalized.host).toBe('github-copilot');

    // Test content without frontmatter
    const skillWithoutFrontmatter = {
      ...setupSkill,
      content: '# Pure markdown without frontmatter',
      contentHash: '0'.repeat(64)
    };
    expect(() => projectSkillForHost(skillWithoutFrontmatter, 'claude', 'project')).toThrow(/frame|body|digest/);
  });
});
