import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { hasMissingInitInputs } from '../src/cli/project-options.js';
import { projectInputCatalog } from '../src/catalogs.js';
import { normalizeProjectOptions, resolveProjectTypeInput } from '../src/domain/project/inputs.js';
import { promptForInitOptions, resolveCatalogInput } from '../src/interactive.js';
import { buildProjectPlan, mergeOptions, PlanValidationError } from '../src/planner.js';
import type { ProjectOptions } from '../src/types.js';
import { CaptureStream } from './helpers.js';

const complete: ProjectOptions = {
  projectName: 'consistent-input',
  projectType: 'standard',
  apiStack: 'node-fastify',
  cloud: 'azure',
  region: 'eastus',
  includeFrontend: false,
  environments: ['dev'],
  specWorkflow: 'openspec',
  agents: ['github-copilot'],
  governanceProfile: 'none',
  copilotCloud: false
};

async function prompt(input: ProjectOptions, answers = '') {
  const output = new CaptureStream();
  const options = await promptForInitOptions(input, {
    input: Readable.from(answers ? [answers] : []),
    output
  });
  return { options, output: output.text() };
}

describe('consistent supplied project input', () => {
  it('honors no-genai without asking for a conflicting workload', async () => {
    const result = await prompt({
      ...complete,
      projectType: undefined,
      apiStack: undefined,
      genai: false
    }, '\n');
    expect(result.options.projectType).toBe('standard');
    expect(result.options.apiStack).toBe('python-fastapi');
    expect(result.output).not.toContain('Select workload');
    expect(result.output).not.toContain('Select GenAI pattern');
    expect(buildProjectPlan(result.options, { requireProjectName: true }).workload).toBe('standard');
  });

  it('honors genai while asking only for its missing pattern', async () => {
    const result = await prompt({
      ...complete,
      projectType: undefined,
      apiStack: undefined,
      genai: true
    }, '\n');
    expect(result.options.projectType).toBe('genai');
    expect(result.options.pattern).toBe('generic');
    expect(result.output).not.toContain('Select workload');
    expect(buildProjectPlan(result.options, { requireProjectName: true }).workload).toBe('genai');
  });

  it('normalizes aliases before deciding whether a Spec Kit default is missing', async () => {
    const input: ProjectOptions = {
      ...complete,
      projectType: 'Standard application',
      apiStack: 'NODE',
      specWorkflow: 'Spec Kit',
      agents: ['Claude', 'Copilot'],
      copilotCloud: undefined
    };
    expect(hasMissingInitInputs(input)).toBe(true);
    const result = await prompt(input, '2\n');
    expect(result.options.agents).toEqual(['github-copilot', 'claude']);
    expect(result.options.defaultAgent).toBe('claude');
    expect(buildProjectPlan(result.options, { requireProjectName: true }).defaultAgent?.id).toBe('claude');
    expect(input.agents).toEqual(['Claude', 'Copilot']);
  });

  it.each([{ agents: [] }, { agents: ['copilot', 'typo-agent'] }])('rejects invalid supplied agents before prompting: $agents', async ({ agents }) => {
    const output = new CaptureStream();
    await expect(promptForInitOptions({
      ...complete,
      agents,
      includeFrontend: undefined
    }, { input: Readable.from(['n\n']), output })).rejects.toBeInstanceOf(PlanValidationError);
    expect(output.text()).toBe('');
  });

  it('does not replace an invalid single-agent default with the selected agent', async () => {
    const result = await prompt({
      ...complete,
      specWorkflow: 'spec-kit',
      defaultAgent: 'claude',
      copilotCloud: undefined
    });
    expect(result.options.defaultAgent).toBe('claude');
    expect(() => buildProjectPlan(result.options, { requireProjectName: true }))
      .toThrow(/must also be present/);
  });

  it('keeps unknown catalog tokens available for validation rather than erasing them', () => {
    const input = {
      projectType: 'unknown-kind',
      apiStack: 'unknown-api',
      pattern: 'unknown-pattern',
      cloud: 'unknown-cloud',
      specWorkflow: 'unknown-workflow',
      agents: ['unknown-agent'],
      defaultAgent: 'unknown-default'
    };
    expect(resolveCatalogInput(input)).toMatchObject(input);
    expect(normalizeProjectOptions(input, projectInputCatalog)).toMatchObject(input);
    expect(resolveProjectTypeInput(input, projectInputCatalog.getProjectType).issues)
      .toContain('Unknown project type: unknown-kind.');
  });

  it('rejects an unknown supplied workflow instead of probing an undefined framework', async () => {
    await expect(prompt({
      ...complete,
      specWorkflow: 'unknown-workflow',
      agents: undefined
    })).rejects.toThrow('Unknown spec-driven workflow');
  });

  it('retains compatible explicit overrides of valid configuration', () => {
    const merged = mergeOptions(complete, {
      apiStack: 'GO',
      region: 'West US 2',
      includeFrontend: true
    });
    const plan = buildProjectPlan(merged, { requireProjectName: true });
    expect(plan.apiStack.id).toBe('go-huma');
    expect(plan.region.slug).toBe('westus2');
    expect(plan.includeFrontend).toBe(true);
    expect(complete.apiStack).toBe('node-fastify');
  });

  it.each(['power-apps-code-app', 'Power Apps code app', 'POWER_APPS_CODE_APP'])(
    'keeps formerly normalized retired type inputs explicitly rejected: %s',
    (projectType) => {
      expect(() => buildProjectPlan({ ...complete, projectType }, { requireProjectName: true }))
        .toThrow(/Power Apps.*retired/);
    }
  );
});
