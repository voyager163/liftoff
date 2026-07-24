import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProjectPlan, loadConfigOptions, mergeOptions, PlanValidationError } from '../src/planner.js';

describe('planner', () => {
  it('builds a default Azure OpenSpec plan', () => {
    const plan = buildProjectPlan({ projectName: 'Claims Assistant', pattern: 'rag', cloud: 'azure' }, { requireProjectName: true });

    expect(plan.safeProjectName).toBe('claims-assistant');
    expect(plan.region.slug).toBe('eastus');
    expect(plan.specWorkflow.id).toBe('openspec');
    expect(plan.environments.map((environment) => environment.id)).toEqual(['dev', 'test', 'prod']);
    expect(plan.projectType.id).toBe('genai');
    expect(plan.apiStack.id).toBe('python-fastapi');
    expect(plan.approvedStack).toContain('PydanticAI');
    expect(plan.agents.map((agent) => agent.id)).toEqual(['github-copilot']);
    expect(plan.defaultAgent).toBeUndefined();
    expect(plan.framework.version).toBe('1.6.0');
  });

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
    expect(plan.framework.version).toBe('0.14.1');
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
        defaultAgent: 'claude'
      }));
      expect(await loadConfigOptions('valid.json', root)).toMatchObject({
        agents: ['github-copilot', 'claude'],
        defaultAgent: 'claude'
      });

      await writeFile(path.join(root, 'invalid.json'), JSON.stringify({ force: true }));
      await expect(loadConfigOptions('invalid.json', root)).rejects.toThrow(/Unknown configuration field: force/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});