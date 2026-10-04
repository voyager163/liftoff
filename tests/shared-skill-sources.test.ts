import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as reads from '../src/adapters/packaged-assets/plugin-assets.js';
import * as sources from '../src/adapters/packaged-assets/skill-sources.js';
import {
  nativeIntegrationHeader, renderAssessmentIntegration, renderRepairInstructions,
  renderRepairIntegration, renderSetupIntegration
} from '../src/generators/governance/integrations.js';
import { repairContractVersion, repairRecipes, repairSchemaVersions } from '../src/domain/repair/identity.js';
import { installedCapabilities } from '../src/application/capabilities.js';
import { commandDefinitions } from '../src/cli/args/definitions.js';
import { expectBoundedCapabilitySkill } from './fixtures/reviewed-rendering.js';

const ids = ['setup', 'governance-assessment', 'repair'] as const;
const agents = ['github-copilot', 'claude', 'codex'] as const;
const originals = Object.fromEntries(ids.map(id => [
  id, readFileSync(path.join('assets', 'skills', `${id}.md`), 'utf8')
]));
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function fixture(id: sources.PackagedSkillId, content?: string | Buffer): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'liftoff-skills-'));
  roots.push(root);
  mkdirSync(path.join(root, 'assets', 'skills'), { recursive: true });
  if (content !== undefined) writeFileSync(path.join(root, 'assets', 'skills', `${id}.md`), content);
  return root;
}

describe('shared packaged Liftoff skill sources', () => {
  it('retries a failed first load and caches only a successful installed read', () => {
    const read = vi.spyOn(reads, 'readDeclaredAssetBytes').mockImplementationOnce(() => {
      throw new Error('Missing installed skill');
    });
    expect(() => sources.packagedSkillSource('setup')).toThrow('Missing installed skill');
    expect(sources.packagedSkillSource('setup')).toBe(originals.setup);
    expect(sources.packagedSkillSource('setup')).toBe(originals.setup);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(ids)('reads only the exact %s source from an explicit package root', id => {
    const root = fixture(id, originals[id]);
    expect(sources.loadPackagedSkillSource(id, { packageRoot: root })).toBe(originals[id]);
    expect(sources.loadPackagedSkillSource(id)).toBe(originals[id]);
  });

  it.each(ids)('fails explicitly when the packaged %s source is missing', id => {
    const root = fixture(id);
    expect(() => sources.loadPackagedSkillSource(id, { packageRoot: root }))
      .toThrow(`Packaged asset core/liftoff-${id} at "assets/skills/${id}.md" could not be used: the file does not exist`);
  });

  it.each(['../setup', 'SETUP', 'unknown', '', null])('rejects undeclared identities before file access: %s', id => {
    const read = vi.spyOn(reads, 'readDeclaredAssetBytes');
    expect(() => Reflect.apply(sources.loadPackagedSkillSource, undefined, [id]))
      .toThrow('Unknown packaged Liftoff skill source');
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['', ' \n', 'no final newline', 'CRLF\r\n', 'nul\0\n'])('rejects malformed source text %j', content => {
    const root = fixture('setup', content);
    expect(() => sources.loadPackagedSkillSource('setup', { packageRoot: root }))
      .toThrow('must be nonempty LF-terminated text without NUL');
  });

  it('rejects invalid UTF-8, oversized files and directories instead of returning empty guidance', () => {
    const invalid = fixture('setup', Buffer.from([0xc3, 0x28, 0x0a]));
    expect(() => sources.loadPackagedSkillSource('setup', { packageRoot: invalid })).toThrow();
    const oversized = fixture('setup', `${'x'.repeat(16_384)}\n`);
    expect(() => sources.loadPackagedSkillSource('setup', { packageRoot: oversized })).toThrow('per-asset byte limit');
    const directory = fixture('setup');
    mkdirSync(path.join(directory, 'assets', 'skills', 'setup.md'));
    expect(() => sources.loadPackagedSkillSource('setup', { packageRoot: directory })).toThrow('not a regular file');
  });

  it.each(['setup', 'governance-assessment'] as const)('rejects undeclared templating in the static %s body', id => {
    const root = fixture(id, 'Not an implemented {{template}}\n');
    expect(() => sources.loadPackagedSkillSource(id, { packageRoot: root })).toThrow('does not support placeholders');
  });

  it('keeps one operation body across all hosts and preserves native headers and invocations', () => {
    for (const agent of agents) {
      expect(renderSetupIntegration(agent)).toBe(`${nativeIntegrationHeader(agent, 'setup')}\n${originals.setup}`);
      expect(renderAssessmentIntegration(agent))
        .toBe(`${nativeIntegrationHeader(agent, 'assessment')}\n${originals['governance-assessment']}`);
      expect(renderRepairIntegration(agent)).toBe(`${nativeIntegrationHeader(agent, 'repair')}${renderRepairInstructions()}`);
    }
    const repair = renderRepairInstructions();
    expect(repair).not.toMatch(/\{\{|\}\}/u);
    expect(repair).toContain(`repairContractVersion: ${repairContractVersion}`);
    expect(repair).toContain(`schemaVersion: ${repairSchemaVersions.capabilities}`);
    expect(repair).toContain(`schema-${repairSchemaVersions.applicationPatch} application patch`);
    for (const recipe of Object.values(repairRecipes)) expect(repair).toContain(`\`${recipe.id}\` v${recipe.version}`);
  });

  it.each([
    'capabilitiesSchema', 'repairContract', 'reportSchema', 'inventorySchema', 'patchSchema',
    'azureRecipe', 'azureRecipeVersion', 'applicationRecipe', 'applicationRecipeVersion'
  ])('refuses a missing %s contract placeholder', name => {
    vi.spyOn(sources, 'packagedSkillSource').mockReturnValue(originals.repair.replaceAll(`{{${name}}}`, 'omitted'));
    expect(() => renderRepairInstructions()).toThrow(`missing its ${name} placeholder`);
  });

  it.each(['{{futureSchema}}', '{{', '}}'])('refuses unrecognized or incomplete placeholder %s', token => {
    vi.spyOn(sources, 'packagedSkillSource').mockReturnValue(`${originals.repair}${token}\n`);
    expect(() => renderRepairInstructions()).toThrow('unknown or malformed placeholder');
  });

  it.each(agents)('%s setup negotiates actual commands before project reads and preserves independent approval', agent => {
    const text = renderSetupIntegration(agent).replace(/\s+/gu, ' ');
    const gate = text.indexOf('liftoff capabilities --json');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(text.indexOf('read `.liftoff/governance/README.md`'));
    expect(text).toContain(`schemaVersion: ${installedCapabilities().schemaVersion}`);
    expect(text).toContain(`governance ${installedCapabilities().schemas.reports.governance}`);
    expect(text).toContain(`update ${installedCapabilities().schemas.reports.update}`);
    for (const phrase of [
      'Missing/malformed/incompatible support: STOP',
      'name/subcommands/flags',
      'productionExecutorAvailable: true',
      'no blocker, actual readiness and independent approval',
      'Upgrade needs separate permission and fresh negotiation',
      'Use `liftoff --help` for supported upgrade guidance',
      'Before repair, negotiate its dedicated capabilities/recipes through the separate native repair protocol',
      'Verification/network/file consent stays separate',
      'No/Ctrl-C/EOF blocks unapproved writes; report prior verification effects',
      'no direct edits',
      'Never emulate commands or fabricate plans/receipts/approvals/evidence'
    ]) expect(text).toContain(phrase);
    for (const phrase of [
      'schemas.currentUpdate', 'report 4, manifestWrite 8, separateConsent and explicitRecovery',
      'do not execute the historical phase sequence',
      'schemas.modernLocalVerification', 'schemas.modernLocalCompletion', 'schemas.modernSuccessorRevalidation',
      'never substitute repair/governance recovery', 'Committed-incomplete is not rollback or local completion',
      'No admitted operation means STOP'
    ]) expect(text).toContain(phrase);
    expectBoundedCapabilitySkill(renderSetupIntegration(agent), 'setup');
    expect(Object.keys(commandDefinitions.governance.flags)).toEqual(expect.arrayContaining(['scope', 'json', 'execute']));
    expect(commandDefinitions.governance.subcommands).toEqual(expect.arrayContaining(['status', 'plan', 'apply-next', 'verify', 'resume']));
  });

  it.each(agents)('%s assessment negotiates read-only support without borrowing setup or repair authority', agent => {
    const text = renderAssessmentIntegration(agent).replace(/\s+/gu, ' ');
    expect(text.indexOf('liftoff capabilities --json')).toBeLessThan(text.indexOf('`.liftoff/governance/policy.md`'));
    expect(text).toContain(`schemas.reports.governanceAssessment: ${installedCapabilities().schemas.reports.governanceAssessment}`);
    for (const phrase of [
      '`commands` governance/assess/json',
      'require live support only for requested live reads',
      'Missing/malformed/incompatible: STOP',
      'Upgrade needs separate permission and fresh negotiation',
      'Never emulate commands or fabricate receipts',
      'Discovery grants no approval',
      'Never execute its recommendations',
      'Do not invoke it, inventory source or stage a patch here',
      'A report is not activation evidence'
    ]) expect(text).toContain(phrase);
    expectBoundedCapabilitySkill(renderAssessmentIntegration(agent), 'assessment');
    expect(commandDefinitions.governance.subcommands).toContain('assess');
    expect(commandDefinitions.governance.flags).toHaveProperty('live');
    expect(commandDefinitions.governance.flags).toHaveProperty('json');
  });

  it('preserves separately negotiated repair and the exact current guidance family', () => {
    const repair = renderRepairInstructions().replace(/\s+/gu, ' ');
    expect(repair).toContain('First run `liftoff repair --capabilities --json`, before project access');
    expect(repair).toContain('Never emulate missing features with direct edits, commands or receipts');
    expect(repair).toContain('the same immutable plan and action scopes the actual user separately approved');
    expect(repair).toContain('never direct edits followed by retrospective approval');
    expect(repair).toContain('external isolated staging OUTSIDE the project');
    expect(installedCapabilities().plugins.inventory.filter(({ category }) => category === 'agent')
      .map(({ contentVersion }) => contentVersion)).toEqual([2, 2, 2]);
    expect(installedCapabilities().workflows.map(({ id }) => id)).toContain('manual');
  });

  it('rejects dropping old safety guidance or hiding oversized additions in the new capability allowance', () => {
    const setup = renderSetupIntegration('codex');
    expect(() => expectBoundedCapabilitySkill(setup.replace('No/Ctrl-C/EOF blocks unapproved writes;', 'Approval bypassed;'), 'setup'))
      .toThrow();
    expect(() => expectBoundedCapabilitySkill(setup.replace('Require `schemaVersion:', `${'x'.repeat(700)}\nRequire \`schemaVersion:`), 'setup'))
      .toThrow();
    expect(() => expectBoundedCapabilitySkill(setup.replace('do not execute the historical phase sequence', 'execute the historical phase sequence'), 'setup'))
      .toThrow();
    expect(() => expectBoundedCapabilitySkill(setup.replace('explicitRecovery.', 'implicitRecovery.'), 'setup'))
      .toThrow();
    const assessment = renderAssessmentIntegration('codex');
    expect(() => expectBoundedCapabilitySkill(assessment.replace('Stop after explaining the report.', 'Execute its recommendations.'), 'assessment'))
      .toThrow();
    expect(() => expectBoundedCapabilitySkill(`${assessment}Unexpected tail\n`, 'assessment')).toThrow();
  });
});
