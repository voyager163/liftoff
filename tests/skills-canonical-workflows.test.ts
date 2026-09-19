import { describe, expect, it } from 'vitest';
import {
  loadCanonicalSkillCatalog,
  getCanonicalSkill,
  assertValidSkillEntrypoint,
  validateAndEnrichSkill
} from '../src/adapters/packaged-assets/skill-assets.js';
import {
  CANONICAL_SKILL_IDS,
  CAPABILITY_ENGINE_OWNERS,
  SUPPORTED_SKILL_HOSTS
} from '../src/domain/skills/contracts.js';

describe('Task 14.1: Canonical workflows and schema 1 catalog', () => {
  it('loads schema 1 catalog with exactly eleven canonical workflows', () => {
    const catalog = loadCanonicalSkillCatalog();
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.catalogVersion).toBe('1.0.0');
    expect(catalog.skills).toHaveLength(11);

    const ids = catalog.skills.map((skill) => skill.id);
    expect(ids).toEqual([...CANONICAL_SKILL_IDS]);
  });

  it('maps every canonical skill to one of the six explicit engine owners', () => {
    const catalog = loadCanonicalSkillCatalog();
    for (const skill of catalog.skills) {
      expect(CAPABILITY_ENGINE_OWNERS).toContain(skill.owningEngine);
    }

    const byEngine: Record<string, string[]> = {};
    for (const skill of catalog.skills) {
      byEngine[skill.owningEngine] = byEngine[skill.owningEngine] ?? [];
      byEngine[skill.owningEngine].push(skill.id);
    }

    expect(byEngine['Standards and Assessment']?.sort()).toEqual(['assess']);
    expect(byEngine['Project Generation']?.sort()).toEqual(['init'].sort());
    expect(byEngine['Project Evolution']?.sort()).toEqual(['adopt', 'migrate', 'repair', 'update'].sort());
    expect(byEngine['Repository Governance']?.sort()).toEqual(['governance', 'governance-assess', 'setup'].sort());
    expect(byEngine['Azure Activation']?.sort()).toEqual(['azure'].sort());
    expect(byEngine['Distribution and CLI Upgrade']?.sort()).toEqual(['cli-upgrade'].sort());
  });

  it('declares explicit command result/report schemas matching platform contracts', () => {
    const catalog = loadCanonicalSkillCatalog();
    const schemaMap = Object.fromEntries(catalog.skills.map((s) => [s.id, s.commandResultSchema]));

    // Repair retains unchanged contract 1 and report schema 2
    expect(schemaMap.repair).toBe(2);
    const repairSkill = getCanonicalSkill('repair');
    expect(repairSkill.contractVersion).toBe(1);

    // Update, Governance, Azure, and Setup use schema 3
    expect(schemaMap.update).toBe(3);
    expect(schemaMap.governance).toBe(3);
    expect(schemaMap.azure).toBe(3);
    expect(schemaMap.setup).toBe(3);

    // JSON commands retain their own schemas; human commands have no JSON body.
    expect(schemaMap['governance-assess']).toBe(1);
    expect(schemaMap.assess).toBe(1);
    expect(schemaMap.adopt).toBe(1);
    expect(schemaMap.init).toBeNull();
    expect(schemaMap.migrate).toBeNull();
    expect(getCanonicalSkill('init').commandOutput).toBe('human');
    expect(getCanonicalSkill('migrate').commandOutput).toBe('human');
    expect(schemaMap['cli-upgrade']).toBe(1);
  });

  it('supports all three declared agent hosts without independent per-skill SemVer', () => {
    const catalog = loadCanonicalSkillCatalog();
    for (const skill of catalog.skills) {
      expect(skill.supportedHosts).toEqual([...SUPPORTED_SKILL_HOSTS]);

      // Verify no independent per-skill SemVer field exists
      expect(skill).not.toHaveProperty('version');
      expect(skill).not.toHaveProperty('semver');

      // Content hash must be 64 lowercase hex characters
      expect(skill.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(skill.content).toBeTruthy();
      expect(skill.content?.length).toBeGreaterThan(100);
    }
  });

  it('preserves invocation identity across hosts for all skills', () => {
    const catalog = loadCanonicalSkillCatalog();
    for (const skill of catalog.skills) {
      expect(skill.defaultInvocations['github-copilot']).toBe(`/liftoff-${skill.id}`);
      expect(skill.defaultInvocations.claude).toBe(`/liftoff-${skill.id}`);
      expect(skill.defaultInvocations.codex).toBe(`$liftoff-${skill.id}`);
    }
  });

  it('verifies canonical skills contain no model SDK or LLM client dependencies', () => {
    const catalog = loadCanonicalSkillCatalog();
    const forbiddenPatterns = [
      /@anthropic-ai\/sdk/i,
      /@openai\/api/i,
      /@azure\/openai/i,
      /import\s+.*from\s+['"]openai['"]/i,
      /import\s+.*from\s+['"]langchain['"]/i,
      /new\s+OpenAI\(/i,
      /new\s+Anthropic\(/i
    ];

    for (const skill of catalog.skills) {
      for (const pattern of forbiddenPatterns) {
        expect(skill.content).not.toMatch(pattern);
      }
    }
  });

  it('verifies that canonical skills explicitly reject generic Yes and autopilot approval', () => {
    const catalog = loadCanonicalSkillCatalog();
    const mutatingSkills = catalog.skills.filter((s) => s.authorizationRequired);

    expect(mutatingSkills.length).toBeGreaterThanOrEqual(6);

    for (const skill of mutatingSkills) {
      expect(skill.content).toMatch(
        /Autopilot[\s\S]{0,200}(?:not consent|not user approval|grant no|authorize no)/i
      );
      if (skill.id !== 'init' && skill.id !== 'migrate') {
        expect(skill.content).not.toContain('--yes');
      } else {
        expect(skill.content).toContain('--yes');
        expect(skill.authorizationMechanism).toBe('flag-consent');
        expect(skill.commandResultSchema).toBeNull();
        expect(skill.content).toMatch(/confirmation only|confirms choices\/plan only/);
      }
    }
  });

  it('supports reload option in loadCanonicalSkillCatalog and clearSkillCatalogCache', () => {
    const catalog1 = loadCanonicalSkillCatalog();
    const catalog2 = loadCanonicalSkillCatalog({ reload: true });

    expect(catalog1.schemaVersion).toBe(1);
    expect(catalog2.schemaVersion).toBe(1);
    expect(catalog1.skills.length).toBe(catalog2.skills.length);

    const reloadedSkill = getCanonicalSkill('setup', { reload: true });
    expect(reloadedSkill.id).toBe('setup');
    expect(reloadedSkill.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('strictly validates entrypoint safety and catalog fields', () => {
    expect(() => assertValidSkillEntrypoint('', 'setup')).toThrow();
    expect(() => assertValidSkillEntrypoint('/abs/path', 'setup')).toThrow();
    expect(() => assertValidSkillEntrypoint('../escape', 'setup')).toThrow();
    expect(() => assertValidSkillEntrypoint('sub//file', 'setup')).toThrow();
    expect(() => assertValidSkillEntrypoint('sub/./file', 'setup')).toThrow();
    expect(assertValidSkillEntrypoint('setup/SKILL.md', 'setup')).toEqual(['setup', 'SKILL.md']);

    expect(() => validateAndEnrichSkill(null)).toThrow();
    expect(() => validateAndEnrichSkill({ id: 'unknown', extra: 1 })).toThrow();
    expect(() => validateAndEnrichSkill({ id: 'invalid-id' })).toThrow();
    const { content: _content, contentHash: _hash, ...validBase } = getCanonicalSkill('setup');
    for (const patch of [
      { name: '' }, { description: '' }, { owningEngine: 'Fake Engine' }, { requiredCapability: '' },
      { commandResultSchema: 0 }, { contractVersion: -1 }, { supportedHosts: [] },
      { defaultInvocations: 'not-record' }, { defaultInvocations: {} }, { effectClass: 'invalid' },
      { authorizationRequired: 'not-bool' }
    ]) expect(() => validateAndEnrichSkill({ ...validBase, ...patch }), JSON.stringify(patch)).toThrow();
  });
});
