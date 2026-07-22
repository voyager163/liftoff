import { describe, expect, it } from 'vitest';
import { buildProjectPlan, mergeOptions, PlanValidationError } from '../src/planner.js';

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
});