import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseArgs } from '../src/args.js';
import { parseManifest } from '../src/application/project/manifest.js';
import { canonicalizeCodingAgents } from '../src/catalogs.js';
import { optionsFromParsedArgs } from '../src/cli/project-options.js';
import { buildProjectPlan, loadConfigOptions } from '../src/planner.js';
import {
  buildRepositoryGovernanceArtifacts,
  governanceAgentIntegrations,
  governanceInvocationGuide,
  renderGovernanceAssessmentGuide
} from '../src/repository-governance.js';
import { renderRootReadme } from '../src/generators/common/base.js';
import { buildArtifacts } from '../src/templates.js';
import { getCanonicalSkill } from '../src/adapters/packaged-assets/skill-assets.js';
import { canonicalSkillBody } from '../src/domain/skills/catalog.js';
import type { CodingAgentId, ProjectOptions, SpecWorkflowId } from '../src/types.js';

const agentSubsets: CodingAgentId[][] = [
  ['github-copilot'], ['claude'], ['github-copilot', 'claude'], ['codex'],
  ['github-copilot', 'codex'], ['claude', 'codex'], ['github-copilot', 'claude', 'codex']
];
const selections = agentSubsets.flatMap((agents) => [
  { specWorkflow: 'openspec' as SpecWorkflowId, agents, defaultAgent: undefined },
  ...agents.map((defaultAgent) => ({
    specWorkflow: 'spec-kit' as SpecWorkflowId, agents, defaultAgent
  }))
]);

function project(options: ProjectOptions = {}) {
  return buildProjectPlan({
    projectName: 'Codex Contract',
    projectType: 'standard',
    apiStack: 'node',
    cloud: 'azure',
    agents: ['codex'],
    ...options
  }, { requireProjectName: true });
}

describe('Codex project selection contracts', () => {
  it.each(selections)('round trips $specWorkflow agents=$agents default=$defaultAgent', async (selection) => {
    const cliOptions = await optionsFromParsedArgs(parseArgs([
      'init', 'Codex Contract', '--type', 'standard', '--api', 'node', '--cloud', 'azure',
      '--spec', selection.specWorkflow,
      '--agents', [...selection.agents].reverse().map((agent) => agent === 'github-copilot' ? 'copilot' : agent).join(','),
      '--governance', 'none',
      ...(selection.defaultAgent ? ['--default-agent', selection.defaultAgent] : [])
    ]), process.cwd(), true);
    const plan = project(cliOptions);
    const artifacts = buildArtifacts(plan);
    const manifest = parseManifest(JSON.parse(artifacts.find((artifact) => artifact.logicalName === 'manifest')!.content));
    expect(manifest.project.agents).toEqual(selection.agents);
    expect(manifest.project.defaultAgent).toBe(selection.defaultAgent);
    expect(manifest.framework).toMatchObject({
      state: 'initialized', adapter: selection.specWorkflow, contractVersion: plan.framework.version
    });

    const directory = await mkdtemp(path.join(process.cwd(), '.codex-config-test-'));
    try {
      await writeFile(path.join(directory, 'liftoff.config.json'),
        artifacts.find((artifact) => artifact.logicalName === 'liftoff-config')!.content);
      const config = await loadConfigOptions('liftoff.config.json', directory);
      const restored = project(config);
      expect(restored.agents.map((agent) => agent.id)).toEqual(selection.agents);
      expect(restored.defaultAgent?.id).toBe(selection.defaultAgent);
      expect(restored.specWorkflow.id).toBe(selection.specWorkflow);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('normalizes aliases and duplicates without changing defaults or implicitly adding agents', () => {
    expect(canonicalizeCodingAgents([' CODEX ', 'openai codex', 'claude-code', 'copilot']).agents
      .map((agent) => agent.id)).toEqual(['github-copilot', 'claude', 'codex']);
    expect(project({ agents: ['claude', 'copilot'] }).agents.map((agent) => agent.id))
      .toEqual(['github-copilot', 'claude']);
    expect(project({ specWorkflow: 'spec-kit', agents: ['codex', 'CODEX'] }).defaultAgent?.id)
      .toBe('codex');
    expect(project({ agents: ['codex'] }).defaultAgent).toBeUndefined();
    expect(() => project({ agents: [] })).toThrow(/at least one|non.empty/i);
    expect(() => project({
      specWorkflow: 'spec-kit', agents: ['copilot', 'claude'], defaultAgent: 'codex'
    })).toThrow(/selected/i);
    expect(() => project({
      specWorkflow: 'spec-kit', agents: ['copilot', 'codex']
    })).toThrow(/default/i);
  });

  it.each([
    [], ['codex', 'codex'], ['codex', 'claude'], ['OpenAI Codex']
  ])('rejects noncanonical manifest selection %j', (...agents) => {
    const manifest = JSON.parse(buildArtifacts(project({ governanceProfile: 'none' }))
      .find((artifact) => artifact.logicalName === 'manifest')!.content);
    manifest.project.agents = agents;
    expect(() => parseManifest(manifest)).toThrow(/canonical|invalid|at least one/i);
  });
});

describe('native Codex governance integrations', () => {
  it.each(['openspec', 'spec-kit'] as const)('preserves the agentless legacy %s handoff without initializing integrations', (specWorkflow) => {
    const legacy = { ...project({ specWorkflow }), agents: [], defaultAgent: undefined };
    const artifacts = buildRepositoryGovernanceArtifacts(legacy);
    expect(artifacts.some((artifact) => artifact.logicalName.startsWith('liftoff-setup-'))).toBe(false);
    expect(artifacts.some((artifact) => artifact.logicalName.startsWith('liftoff-governance-assess-'))).toBe(false);
    expect(artifacts.every((artifact) => artifact.pathParts[0] === '.liftoff')).toBe(true);
    expect(JSON.parse(artifacts.find((artifact) => artifact.logicalName === 'repository-governance-context')!.content).agents).toEqual([]);
    const guide = artifacts.find((artifact) => artifact.logicalName === 'repository-governance-guide')!.content;
    expect(guide).toContain('Legacy project handoff');
    expect(guide).toContain('No native setup integration is recorded for this legacy project');
    expect(guide).toContain('does not initialize the framework or install coding-agent integrations');
    expect(guide).toContain('liftoff governance status --scope local --json');
    expect(guide).toContain('separately approved framework adoption');
    expect(guide).not.toContain('Use the generated setup integration from any selected agent');
    expect(guide).not.toMatch(/[/$]liftoff-(?:setup|governance-assess)/);
    expect(governanceInvocationGuide(legacy)).toBe('No native `liftoff-setup` integration is recorded.');
    expect(governanceInvocationGuide(legacy, 'assessment')).toBe('No native `liftoff-governance-assess` integration is recorded.');
    const assessment = renderGovernanceAssessmentGuide(legacy);
    expect(assessment).toContain('use the CLI directly');
    expect(assessment).toContain('liftoff governance assess --json');
    expect(assessment).not.toContain('Native setup ()');
    const readme = renderRootReadme(legacy);
    expect(readme).toContain('No native `liftoff-setup` integration is recorded');
    expect(readme).toContain('Not recorded; legacy framework adoption requires separate review');
    expect(readme).not.toContain('use native setup (');
    expect(readme).not.toContain("Run the selected agent's native setup");
    expect(readme).not.toMatch(/[/$]liftoff-(?:setup|governance-assess)/);
    expect(legacy.agents).toEqual([]);
    expect(legacy.defaultAgent).toBeUndefined();
  });

  it.each(selections)('uses the finalized setup command contract for $specWorkflow agents=$agents default=$defaultAgent', (selection) => {
    const setup = buildRepositoryGovernanceArtifacts(project(selection))
      .filter((artifact) => artifact.logicalName.startsWith('liftoff-setup-'));
    expect(setup).toHaveLength(selection.agents.length);
    for (const artifact of setup) {
      const content = artifact.content.replace(/\s+/g, ' ');
      expect(artifact.content).toContain(canonicalSkillBody(getCanonicalSkill('setup')));
      for (const fragment of [
        'liftoff capabilities --json',
        'public schema 1', 'repository-governance', 'output 3',
        'liftoff governance status --project ./my-app --scope local --json',
        'liftoff governance plan --project ./my-app --scope local --json',
        'Unscoped means activation; repository success cannot replace it',
        'Plan saves a disclosed external preview, not approval',
        'Apply-next without `--execute` is read-only',
        'Even approval-free local actions need exact execution consent',
        'Resolve `--inputs` before cwd changes; changed bytes need fresh review',
        '--protected-stdin',
        'private operator channel',
        'nextActions.continuation', '`executable`', '`args`', '`cwd`', '`scope`',
        '`project`', '`configPath`', '`configDigest`', '`compatibilityIdentity`', '`requiredAuthority`',
        'Never automatically approve a plan',
        'then separately authorized `apply-next`',
        'Honor local-only requests and declined authority',
        '0 consistent-complete, 2 consistent-incomplete, 1 inconsistent',
        'Full activation needs real deployment/live readback',
        'retention is lifecycle work',
        'Stop unchanged failures', 'recover only original plans and authority'
      ]) expect(content).toContain(fragment);
      for (const [, command] of artifact.content.matchAll(/`liftoff ([^`]+)`/g)) {
        expect(() => parseArgs(command!.split(/\s+/))).not.toThrow();
      }
      expect(content).not.toContain('Status, plan, and resume are read-only');
      expect(content).not.toContain('supported secure reference');
    }
  });

  it.each(selections)('tracks exact native identities for $specWorkflow agents=$agents default=$defaultAgent', (selection) => {
    const artifacts = buildArtifacts(project(selection));
    const manifest = parseManifest(JSON.parse(artifacts.find((artifact) => artifact.logicalName === 'manifest')!.content));
    const wrappers = artifacts.filter((artifact) => artifact.logicalName.startsWith('liftoff-'));
    const expected = selection.agents.flatMap((agent) => [
      governanceAgentIntegrations[agent].setup, governanceAgentIntegrations[agent].assessment,
      governanceAgentIntegrations[agent].repair
    ]);
    expect(wrappers.filter((artifact) => artifact.category === 'governance')).toHaveLength(expected.length);
    for (const identity of expected) {
      const artifact = artifacts.find((entry) => entry.logicalName === identity.logicalName)!;
      expect(artifact).toMatchObject({
        lifecycle: 'managed-core', category: 'governance', pathParts: [...identity.pathParts]
      });
      expect(manifest.managedArtifacts).toContainEqual({
        logicalName: identity.logicalName,
        category: 'governance',
        pathParts: [...identity.pathParts],
        contentHash: `sha256:${createHash('sha256').update(artifact.content).digest('hex')}`
      });
    }
    expect(new Set(artifacts.map((artifact) => artifact.logicalName)).size).toBe(artifacts.length);
    expect(new Set(artifacts.map((artifact) => JSON.stringify(artifact.pathParts))).size).toBe(artifacts.length);
  });

  it('does not treat a missing Codex assessment skill as a pre-assessment legacy inventory', () => {
    const artifacts = buildArtifacts(project());
    const manifest = parseManifest(JSON.parse(artifacts.find((artifact) => artifact.logicalName === 'manifest')!.content));
    manifest.managedArtifacts = manifest.managedArtifacts.filter((artifact) =>
      artifact.logicalName !== governanceAgentIntegrations.codex.assessment.logicalName);
    expect(() => parseManifest(manifest)).toThrow(/missing artifact liftoff-governance-assess-codex/);
  });

  it.each(['openspec', 'spec-kit'] as const)('renders native metadata and the full setup journey for %s', (specWorkflow) => {
    const artifacts = buildRepositoryGovernanceArtifacts(project({ specWorkflow }));
    const setup = artifacts.find((artifact) => artifact.logicalName === 'liftoff-setup-codex')!;
    const assessment = artifacts.find((artifact) => artifact.logicalName === 'liftoff-governance-assess-codex')!;
    for (const [artifact, name] of [[setup, 'liftoff-setup'], [assessment, 'liftoff-governance-assess']] as const) {
      const frontmatter = artifact.content.match(/^---\n([\s\S]*?)\n---\n/);
      expect(frontmatter).not.toBeNull();
      expect(parseYaml(frontmatter![1])).toEqual({
        name, description: expect.stringMatching(/\S/)
      });
      expect(artifact.pathParts).toEqual(['.agents', 'skills', name, 'SKILL.md']);
      expect(artifact.content).toContain(`# $${name}`);
      expect(artifact.content).not.toMatch(/skill[-_ ]?version|\bmodel\b|\.codex\/prompts/i);
      expect(artifact.logicalName).not.toContain('claude');
    }
    expect(setup.content.match(/`(liftoff [^`]+)`/)?.[1])
      .toBe('liftoff capabilities --json');
    expect(setup.content).toContain(canonicalSkillBody(getCanonicalSkill('setup')));
    const setupBody = setup.content.replace(/\s+/g, ' ');
    for (const fragment of [
      'nextActions.continuation', '`executable`', '`args`', '`cwd`', '`requiredAuthority`',
      'nextReadyPhase', 'selectedPhase', 'executedPhase', 'post-operation readiness',
      'local-only', 'activation', 'lifecycle',
      'liftoff governance plan --project ./my-app --scope local --json',
      'Never automatically approve a plan',
      'private operator channel', 'local-only requests and declined authority',
      'disclosed external preview', '--inputs', '--protected-stdin',
      '2 consistent-incomplete', '1 inconsistent',
      'Stop unchanged failures', 'real deployment/live readback'
    ]) expect(setupBody).toContain(fragment);
    expect(assessment.content).toContain(canonicalSkillBody(getCanonicalSkill('governance-assess')));
    expect([...assessment.content.matchAll(/`(liftoff [^`]+)`/g)].map((match) => match[1])).toEqual([
      'liftoff capabilities --json', 'liftoff governance assess --project ./my-app --json',
      'liftoff governance assess --project ./my-app --live --json'
    ]);
    expect(assessment.content).toContain('Only after explicit consent for bounded live reads');
    expect(assessment.content).toContain('Stop after explaining it: no follow-up execution');
    expect(assessment.content).toContain('No governance phase is completed');
    expect(assessment.content).toContain('`$liftoff-setup`');
    expect(artifacts.some((artifact) => artifact.logicalName.endsWith('-claude'))).toBe(false);
  });

  it.each(['openspec', 'spec-kit'] as const)('uses actual Codex invocation in generated %s guidance', (specWorkflow) => {
    const artifacts = buildArtifacts(project({ specWorkflow }));
    for (const name of ['root-readme', 'repository-governance-guide']) {
      const text = artifacts.find((artifact) => artifact.logicalName === name)!.content;
      expect(text.indexOf('$liftoff-setup')).toBeLessThan(text.indexOf('$liftoff-governance-assess'));
      expect(text).toContain('liftoff governance status --scope local --json');
      expect(text).not.toContain('/liftoff-setup');
      expect(text).not.toContain('/liftoff-governance-assess');
      expect(text).toContain('local-only');
      expect(text).toContain('lifecycle');
    }
  });

  it('generates only independent repair for an opted-out Codex project', () => {
    const artifacts = buildRepositoryGovernanceArtifacts(project({ governanceProfile: 'none' }));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      logicalName: 'liftoff-repair-codex', lifecycle: 'managed-core',
      pathParts: [...governanceAgentIntegrations.codex.repair.pathParts]
    });
    expect(artifacts.some((artifact) => artifact.logicalName.startsWith('repository-governance-'))).toBe(false);
  });
});
