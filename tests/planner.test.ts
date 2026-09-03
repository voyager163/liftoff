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
    expect(plan.environments.map((environment) => environment.id)).toEqual(['dev', 'test', 'prod']);
    expect(plan.projectType.id).toBe('genai');
    expect(plan.apiStack.id).toBe('python-fastapi');
    expect(plan.approvedStack).toContain('PydanticAI');
    expect(plan.agents.map((agent) => agent.id)).toEqual(['github-copilot']);
    expect(plan.defaultAgent).toBeUndefined();
    expect(plan.copilotCloud).toBe(false);
    expect(plan.framework.version).toBe('1.11.0');
    expect(plan.governanceProfile).toMatchObject({
      id: 'single-maintainer-gitflow',
      policyVersion: '5',
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

  it('builds a Power Apps code app plan without API or cloud identity', () => {
    const plan = buildProjectPlan({
      projectName: 'Field Service',
      projectType: 'power-apps-code-app',
      codeAppsPlugin: true
    }, { requireProjectName: true });

    expect(plan.workload).toBe('power-apps-code-app');
    if (plan.workload !== 'power-apps-code-app') {
      throw new Error('Expected a Power Apps code app plan.');
    }
    expect(plan.starter).toEqual({
      repository: 'https://github.com/microsoft/PowerAppsCodeApps',
      path: 'templates/starter',
      commit: '3438c352483e40982f6c5c0fc36fd71f8e7adbbb'
    });
    expect(plan.codeAppsPlugin).toBe(true);
    expect('apiStack' in plan).toBe(false);
    expect('provider' in plan).toBe(false);
    expect(plan.approvedStack).toContain('Power Apps SDK');
  });

  it.each([
    [{ apiStack: 'node' }, '--api'],
    [{ pattern: 'rag' }, '--pattern'],
    [{ cloud: 'azure' }, '--cloud'],
    [{ region: 'eastus' }, '--region'],
    [{ includeFrontend: false }, '--frontend'],
    [{ environments: ['dev'] }, '--environments']
  ])('rejects inapplicable Power Apps options %j', (extra, expected) => {
    expect(() => buildProjectPlan({
      projectName: 'Invalid Power App',
      projectType: 'power-apps-code-app',
      ...extra
    }, { requireProjectName: true })).toThrow(expected);
  });

  it('rejects conflicting explicit and legacy workload selectors', () => {
    expect(() => buildProjectPlan({
      projectName: 'Conflict',
      projectType: 'power-apps-code-app',
      genai: false
    }, { requireProjectName: true })).toThrow(/conflicts with legacy/);
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loads only applicable Power Apps configuration fields', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-config-power-apps-'));
    try {
      await writeFile(path.join(root, 'valid.json'), JSON.stringify({
        projectName: 'Power App',
        projectType: 'power-apps-code-app',
        codeAppsPlugin: false,
        specWorkflow: 'openspec',
        agents: ['copilot']
      }));
      expect(await loadConfigOptions('valid.json', root)).toMatchObject({
        projectType: 'power-apps-code-app',
        codeAppsPlugin: false
      });

      await writeFile(path.join(root, 'api-field.json'), JSON.stringify({
        projectType: 'power-apps-code-app',
        cloud: 'azure'
      }));
      await expect(loadConfigOptions('api-field.json', root)).rejects.toThrow(/cannot include: cloud/);

      await writeFile(path.join(root, 'bad-plugin.json'), JSON.stringify({
        projectType: 'power-apps-code-app',
        codeAppsPlugin: 'yes'
      }));
      await expect(loadConfigOptions('bad-plugin.json', root)).rejects.toThrow(/must be a boolean/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});