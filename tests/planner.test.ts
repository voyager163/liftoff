import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildProjectPlan,
  loadConfigOptions,
  mergeOptions,
  PlanValidationError,
  projectPlanEntries
} from '../src/planner.js';

describe('planner', () => {
  it('builds a default Azure OpenSpec plan', () => {
    const plan = buildProjectPlan({ projectName: 'Claims Assistant', pattern: 'rag', cloud: 'azure' }, { requireProjectName: true });

    expect(plan.safeProjectName).toBe('claims-assistant');
    expect(plan.workload).toBe('genai');
    expect(plan.region.slug).toBe('eastus');
    expect(plan.specWorkflow.id).toBe('openspec');
    expect(plan.environments.map((environment) => environment.id)).toEqual(['dev', 'staging', 'prod']);
    expect(plan.projectType.id).toBe('genai');
    expect(plan.apiStack.id).toBe('python-fastapi');
    expect(plan.approvedStack).toContain('PydanticAI');
    expect(plan.agents.map((agent) => agent.id)).toEqual(['github-copilot']);
    expect(plan.defaultAgent).toBeUndefined();
    expect(plan.copilotCloud).toBe(false);
    expect(plan.framework.version).toBe('1.11.0');
    expect(plan.governanceProfile).toMatchObject({
      id: 'single-maintainer-gitflow',
      policyVersion: '6',
      default: true
    });

  });

  it.each(['generic', 'undecided', 'unsure', 'not-sure'])(
    'builds a generic GenAI plan from %s',
    (pattern) => {
      const plan = buildProjectPlan({
        projectName: 'Unspecified Assistant',
        projectType: 'genai',
        pattern,
        cloud: 'azure'
      }, { requireProjectName: true });

      expect(plan.workload).toBe('genai');
      expect(plan.pattern).toMatchObject({
        id: 'generic',
        label: 'Generic GenAI Starter',
        routePrefix: '/api/ai',
        worker: false
      });
      expect(plan.apiStack.id).toBe('python-fastapi');
      expect(plan.frontendStarter).toBe('Generic AI playground');
      expect(plan.approvedStack).toContain('PydanticAI');
    }
  );

  it.each([
    ['python', 'python-fastapi'],
    ['node', 'node-fastify'],
    ['golang', 'go-huma']
  ])('builds a standard %s API plan', (input, expected) => {
    const plan = buildProjectPlan({
      projectName: 'Standard API',
      projectType: 'standard',
      apiStack: input,
      cloud: 'azure'
    }, { requireProjectName: true });

    expect(plan.projectType.id).toBe('standard');
    expect(plan.apiStack.id).toBe(expected);
    expect(plan.pattern).toBeUndefined();
    expect(plan.approvedStack).not.toContain('PydanticAI');
  });

  it('infers project type from compatible legacy and standard inputs', () => {
    expect(buildProjectPlan({ projectName: 'Legacy', pattern: 'rag', cloud: 'azure' }, { requireProjectName: true }).projectType.id).toBe('genai');
    expect(buildProjectPlan({ projectName: 'Standard', apiStack: 'node', cloud: 'azure' }, { requireProjectName: true }).projectType.id).toBe('standard');
  });

  it.each([
    {},
    { apiStack: 'node' },
    { pattern: 'rag' },
    { cloud: 'azure' },
    { region: 'eastus' },
    { includeFrontend: false },
    { environments: ['dev'] },
    { codeAppsPlugin: false }
  ])('rejects retired Power Apps planning before interpreting deeper options %j', (extra) => {
    expect(() => buildProjectPlan({
      projectName: 'Retired Power App',
      projectType: 'power-apps-code-app',
      ...extra
    }, { requireProjectName: true })).toThrow(/Power Apps.*retired|retired.*Power Apps/i);
  });

  it('rejects a retired workload before conflicting legacy selectors', () => {
    expect(() => buildProjectPlan({
      projectName: 'Conflict',
      projectType: 'power-apps-code-app',
      genai: false
    }, { requireProjectName: true })).toThrow(/Power Apps.*retired|retired.*Power Apps/i);
  });

  it('rejects contradictory project identity inputs', () => {
    expect(() => buildProjectPlan({
      projectName: 'Invalid',
      projectType: 'standard',
      apiStack: 'node',
      pattern: 'rag',
      cloud: 'azure'
    }, { requireProjectName: true })).toThrow(/cannot select a GenAI pattern/);
    expect(() => buildProjectPlan({
      projectName: 'Invalid',
      projectType: 'genai',
      apiStack: 'go',
      pattern: 'rag',
      cloud: 'azure'
    }, { requireProjectName: true })).toThrow(/python-fastapi/);
  });

  it('rejects planned providers', () => {
    expect(() => buildProjectPlan({ projectName: 'App', pattern: 'rag', cloud: 'aws' }, { requireProjectName: true })).toThrow(PlanValidationError);
  });

  it('rejects ambiguous non-interactive regions', () => {
    expect(() => buildProjectPlan({ projectName: 'App', pattern: 'rag', cloud: 'azure', region: 'korea' }, { requireProjectName: true })).toThrow(/ambiguous/);
  });

  it('rejects the retired test deployment environment from CLI options', () => {
    expect(() => buildProjectPlan({
      projectName: 'App',
      pattern: 'rag',
      cloud: 'azure',
      environments: ['test']
    }, { requireProjectName: true })).toThrow(/Unknown environment: test\./);
  });

  it('keeps config-file values when flags are undefined', () => {
    const merged = mergeOptions(
      { projectName: 'From Config', pattern: 'chatbot', cloud: 'azure', includeFrontend: true },
      { cloud: 'azure', yes: true }
    );

    expect(merged.projectName).toBe('From Config');
    expect(merged.pattern).toBe('chatbot');
    expect(merged.includeFrontend).toBe(true);
  });

  it('supports explicit governance opt-out and rejects unknown profiles', () => {
    const disabled = buildProjectPlan({
      projectName: 'Ungoverned',
      pattern: 'rag',
      cloud: 'azure',
      governanceProfile: 'none'
    }, { requireProjectName: true });
    expect(disabled.governanceProfile.id).toBe('none');
    expect(projectPlanEntries(disabled)).toContainEqual({
      label: 'Repository governance',
      value: 'Disabled; no local handoff or remote action'
    });
    expect(() => buildProjectPlan({
      projectName: 'Unknown Governance',
      pattern: 'rag',
      cloud: 'azure',
      governanceProfile: 'enterprise-theatre'
    }, { requireProjectName: true })).toThrow(
      /Unknown repository governance profile.*single-maintainer-gitflow, none/
    );
  });

  it('merges governance configuration only when an override is defined', () => {
    expect(mergeOptions(
      { governanceProfile: 'none' },
      { yes: true }
    ).governanceProfile).toBe('none');
    expect(mergeOptions(
      { governanceProfile: 'none' },
      { governanceProfile: 'single-maintainer-gitflow' }
    ).governanceProfile).toBe('single-maintainer-gitflow');
  });

  it('canonicalizes multiple selected agents and records a Spec Kit default', () => {
    const plan = buildProjectPlan({
      projectName: 'Multi Agent',
      pattern: 'rag',
      cloud: 'azure',
      specWorkflow: 'spec-kit',
      agents: ['claude-code', 'copilot'],
      defaultAgent: 'claude'
    }, { requireProjectName: true });

    expect(plan.agents.map((agent) => agent.id)).toEqual(['github-copilot', 'claude']);
    expect(plan.defaultAgent?.id).toBe('claude');
    expect(plan.framework.version).toBe('1.0.1');
  });

  it('requires a Spec Kit default for multiple agents', () => {
    expect(() => buildProjectPlan({
      projectName: 'Missing Default',
      pattern: 'rag',
      cloud: 'azure',
      specWorkflow: 'spec-kit',
      agents: ['copilot', 'claude']
    }, { requireProjectName: true })).toThrow(/requires --default-agent/);
  });

  it('resolves Copilot cloud setup only for OpenSpec with GitHub Copilot', () => {
    expect(buildProjectPlan({
      projectName: 'Cloud Copilot',
      pattern: 'rag',
      cloud: 'azure',
      agents: ['copilot'],
      copilotCloud: true
    }, { requireProjectName: true }).copilotCloud).toBe(true);

    for (const invalid of [
      { specWorkflow: 'spec-kit', agents: ['copilot'], defaultAgent: 'copilot' },
      { specWorkflow: 'openspec', agents: ['claude'] }
    ]) {
      expect(() => buildProjectPlan({
        projectName: 'Invalid Cloud Copilot',
        pattern: 'rag',
        cloud: 'azure',
        copilotCloud: false,
        ...invalid
      }, { requireProjectName: true })).toThrow(/requires OpenSpec with GitHub Copilot/);
    }
  });

  it('rejects unsupported or inconsistent agent selections', () => {
    expect(() => buildProjectPlan({
      projectName: 'Unknown Agent',
      pattern: 'rag',
      cloud: 'azure',
      agents: ['not-an-agent']
    }, { requireProjectName: true })).toThrow(/Unknown AI coding agent/);
    expect(() => buildProjectPlan({
      projectName: 'Wrong Default',
      pattern: 'rag',
      cloud: 'azure',
      specWorkflow: 'spec-kit',
      agents: ['copilot'],
      defaultAgent: 'claude'
    }, { requireProjectName: true })).toThrow(/must also be present/);
    expect(() => buildProjectPlan({
      projectName: 'OpenSpec Default',
      pattern: 'rag',
      cloud: 'azure',
      defaultAgent: 'copilot'
    }, { requireProjectName: true })).toThrow(/only valid with Spec Kit/);
  });

  it('loads canonical agent settings while excluding one-run consent flags from config', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-config-agents-'));
    try {
      await writeFile(path.join(root, 'valid.json'), JSON.stringify({
        agents: ['claude-code', 'copilot'],
        specWorkflow: 'spec-kit',
        defaultAgent: 'claude',
        governanceProfile: 'none'
      }));
      expect(await loadConfigOptions('valid.json', root)).toMatchObject({
        agents: ['github-copilot', 'claude'],
        defaultAgent: 'claude',
        governanceProfile: 'none'
      });

      await writeFile(path.join(root, 'invalid.json'), JSON.stringify({ force: true }));
      await expect(loadConfigOptions('invalid.json', root)).rejects.toThrow(/Unknown configuration field: force/);
      await writeFile(path.join(root, 'cloud-consent.json'), JSON.stringify({
        copilotCloud: true,
        configureOpenSpecProfile: true
      }));
      await expect(loadConfigOptions('cloud-consent.json', root)).rejects
        .toThrow(/Unknown configuration fields: copilotCloud, configureOpenSpecProfile/);
      await writeFile(path.join(root, 'bad-governance.json'), JSON.stringify({
        governanceProfile: 'unknown'
      }));
      await expect(loadConfigOptions('bad-governance.json', root)).rejects
        .toThrow(/governanceProfile has unsupported value/);
      await writeFile(path.join(root, 'bad-environment.json'), JSON.stringify({
        environments: ['test']
      }));
      await expect(loadConfigOptions('bad-environment.json', root)).rejects
        .toThrow(/Configuration field environments contains unsupported value "test"/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects retired Power Apps configuration before deeper fields', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-config-power-apps-'));
    try {
      await writeFile(path.join(root, 'retired.json'), JSON.stringify({
        projectName: 'Power App',
        projectType: 'power-apps-code-app',
        codeAppsPlugin: { malformed: true },
        cloud: { unsafe: true },
        environments: '../outside'
      }));
      await expect(loadConfigOptions('retired.json', root))
        .rejects.toThrow(/Power Apps.*retired|retired.*Power Apps/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});