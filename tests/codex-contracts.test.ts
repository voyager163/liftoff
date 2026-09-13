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
      for (const fragment of [
        'liftoff governance status --scope local --json',
        'liftoff governance plan --scope local --json',
        'liftoff governance apply-next --scope local --json --execute',
        'liftoff governance verify --scope local --json',
        'Unscoped governance defaults to activation',
        'Plan saves a disclosed external preview, not approval',
        'Apply-next without `--execute` is strictly read-only',
        '--inputs <public-json-file>',
        '--protected-stdin',
        'operator-controlled protected channel',
        'nextActions', 'command.executable', 'command.args', 'cwd', 'scope', 'approvalRequired',
        'Never automatically approve a plan',
        'approval does not execute',
        'liftoff governance plan --scope activation --json',
        'liftoff governance recover --plan <fingerprint> --execute',
        'local-only request', 'declined later authority',
        'Do not repeat an unchanged failure',
        'deferred retention is not failed activation'
      ]) expect(content).toContain(fragment);
      expect(content).not.toContain('Status, plan, and resume are read-only');
      expect(content).not.toContain('supported secure reference');
    }
  });

  it.each(selections)('tracks exact native identities for $specWorkflow agents=$agents default=$defaultAgent', (selection) => {
    const artifacts = buildArtifacts(project(selection));
    const manifest = parseManifest(JSON.parse(artifacts.find((artifact) => artifact.logicalName === 'manifest')!.content));
    const wrappers = artifacts.filter((artifact) => artifact.logicalName.startsWith('liftoff-'));
    const expected = selection.agents.flatMap((agent) => [
      governanceAgentIntegrations[agent].setup, governanceAgentIntegrations[agent].assessment
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
      .toBe('liftoff governance status --scope local --json');
    for (const fragment of [
      'command.executable', 'command.args', 'cwd', 'approvalRequired',
      'nextPlannablePhase', 'nextReadyPhase', 'post-operation readiness',
      'localSetup', 'activation', 'migration', 'lifecycle',
      'liftoff governance plan --scope local --json',
      'liftoff governance apply-next --scope local --json --execute',
      'liftoff governance plan --scope activation --json',
      'Never automatically approve a plan',
      'private operator channel', 'local-only request', 'declined later authority',
      'disclosed external preview', '--inputs <public-json-file>', '--protected-stdin',
      'exit 2 means consistent but', 'indeterminate readiness',
      'Do not repeat an unchanged failure', 'actual deployment',
      'matching live enforcement', 'future'
    ]) expect(setup.content).toContain(fragment);
    expect([...assessment.content.matchAll(/`(liftoff [^`]+)`/g)].map((match) => match[1])).toEqual([
      'liftoff governance assess --json', 'liftoff governance assess --live --json'
    ]);
    expect(assessment.content).toContain('Only when the developer explicitly requests live reads');
    expect(assessment.content).toContain('Stop after explaining the report');
    expect(assessment.content).toContain('repair, migration, activation');
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

  it('never generates governance wrappers for an opted-out Codex project', () => {
    expect(buildRepositoryGovernanceArtifacts(project({ governanceProfile: 'none' }))).toEqual([]);
  });
});
