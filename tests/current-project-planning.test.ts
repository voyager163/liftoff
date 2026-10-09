import { describe, expect, it } from 'vitest';
import { buildCurrentProjectPlan, buildProjectPlan, PlanValidationError } from '../src/application/project/planning.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { modernActivationSourceContracts } from '../src/domain/governance/policy/identity.js';
import type { CodingAgentId, ProjectOptions } from '../src/domain/project/contracts.js';
import { buildProjectPlanWithCatalog, type ProjectPlanningCatalog } from '../src/domain/project/planning.js';

const input: ProjectOptions = {
  projectName: 'Manual Application',
  projectType: 'standard',
  apiStack: 'go-huma',
  cloud: 'azure'
};
const options = { requireProjectName: true };
const agents: CodingAgentId[] = ['github-copilot', 'claude', 'codex'];
const subsets = Array.from({ length: 8 }, (_, mask) =>
  agents.filter((_, index) => (mask & (1 << index)) !== 0)
);

describe('current development planning', () => {
  it('accepts historical custom catalogs without requiring current-only members', () => {
    const { getDevelopmentWorkflow: _workflow, currentProjectInputCatalog: _inputs, ...historical } = projectCatalog;
    const catalog: ProjectPlanningCatalog = historical;
    expect(buildProjectPlanWithCatalog(input, options, catalog)).toEqual(buildProjectPlan(input, options));
    expect(() => buildProjectPlanWithCatalog({ ...input, specWorkflow: 'manual' }, options, catalog))
      .toThrow(/Unknown spec-driven workflow/);
  });

  it('adds Manual without changing historical workflow or framework catalogs', () => {
    expect(projectCatalog.developmentWorkflows.map(workflow => workflow.id))
      .toEqual(['openspec', 'spec-kit', 'manual']);
    expect(projectCatalog.developmentWorkflows.filter(workflow => workflow.default).map(workflow => workflow.id))
      .toEqual(['openspec']);
    expect(projectCatalog.specWorkflows.map(workflow => workflow.id)).toEqual(['openspec', 'spec-kit']);
    expect(Object.keys(projectCatalog.frameworkDefinitions)).toEqual(['openspec', 'spec-kit']);
    expect(projectCatalog.getSpecWorkflow('manual')).toBeUndefined();
    expect(projectCatalog.isSpecWorkflowId('manual')).toBe(false);
    expect(projectCatalog.getDevelopmentWorkflow('Manual')).toMatchObject({ id: 'manual', default: false });
    expect(() => buildProjectPlan({ ...input, specWorkflow: 'manual' }, options))
      .toThrow(/Unknown spec-driven workflow/);
  });

  it('retains OpenSpec and Copilot omission defaults while selecting the actual current policy', () => {
    const historical = buildProjectPlan(input, options);
    const current = buildCurrentProjectPlan(input, options);
    expect(current.specWorkflow.id).toBe('openspec');
    expect(current.agents.map(agent => agent.id)).toEqual(['github-copilot']);
    expect(current.framework).toEqual(historical.framework);
    expect(current.governanceProfile.policyVersion).toBe('7');
    expect(historical.governanceProfile.policyVersion).toBe('6');
    expect({ ...current, governanceProfile: historical.governanceProfile }).toEqual(historical);
  });

  it.each([undefined, [], ['none'], ['NONE']].map(selection => [selection] as const))('records intentional CLI-only Manual agents %j', selection => {
    const plan = buildCurrentProjectPlan({ ...input, specWorkflow: 'Manual', agents: selection }, options);
    expect(plan.specWorkflow.id).toBe('manual');
    expect(plan.framework).toBeUndefined();
    expect(plan.agents).toEqual([]);
    expect(plan.defaultAgent).toBeUndefined();
    expect(plan.copilotCloud).toBe(false);
    expect(plan.governanceProfile.id).toBe('single-maintainer-gitflow');
    expect(JSON.parse(JSON.stringify(plan))).not.toHaveProperty('framework');
    expect(plan.apiStack.framework).toBe('Huma v2 with Chi');
    expect(JSON.stringify(plan)).not.toContain('"executable":');
  });

  it.each(subsets.map(selection => [selection] as const))('preserves Manual subset %j in canonical order', selection => {
    const plan = buildCurrentProjectPlan({
      ...input, specWorkflow: 'manual', agents: [...selection].reverse()
    }, options);
    expect(plan.agents.map(agent => agent.id)).toEqual(selection);
    expect(plan.framework).toBeUndefined();
    expect(plan.defaultAgent).toBeUndefined();
    expect(plan.governanceProfile.policyVersion).toBe(
      modernActivationSourceContracts().find(source =>
        source.identity.profile === 'single-maintainer-gitflow' && source.identity.workflow === 'manual'
      )?.identity.policyVersion
    );
  });

  for (const workflow of ['openspec', 'spec-kit'] as const) {
    it.each(subsets.slice(1).map(selection => [selection] as const))(
      `preserves ${workflow} subset %j and its real framework`,
      selection => {
        const selected: ProjectOptions = {
          ...input, specWorkflow: workflow, agents: [...selection].reverse(),
          ...(workflow === 'spec-kit' && selection.length > 1 ? { defaultAgent: selection.at(-1) } : {})
        };
        const current = buildCurrentProjectPlan(selected, options);
        const historical = buildProjectPlan(selected, options);
        expect({ ...current, governanceProfile: historical.governanceProfile }).toEqual(historical);
        expect(current.agents.map(agent => agent.id)).toEqual(selection);
        expect(current.framework).toEqual(projectCatalog.getFrameworkDefinition(workflow));
        expect(current.defaultAgent?.id).toBe(workflow === 'spec-kit' ? selection.at(-1) : undefined);
      }
    );

    it.each([[], ['none']].map(selection => [selection] as const))(`refuses empty or none agents for ${workflow}: %j`, selection => {
      expect(() => buildCurrentProjectPlan({ ...input, specWorkflow: workflow, agents: selection }, options))
        .toThrow(PlanValidationError);
    });
  }

  it.each([
    ['none', 'claude'],
    ['claude', 'none'],
    ['none', 'none'],
    ['none', 'unknown'],
    ['unknown'],
    [''],
    [' ']
  ].map(selection => [selection] as const))('does not discard invalid Manual agent entries %j', selection => {
    expect(() => buildCurrentProjectPlan({ ...input, specWorkflow: 'manual', agents: selection }, options))
      .toThrow(PlanValidationError);
  });

  it.each([
    { defaultAgent: 'claude' },
    { copilotCloud: true },
    { copilotCloud: false },
    { configureOpenSpecProfile: true },
    { configureOpenSpecProfile: false }
  ])('rejects framework-only Manual options before any generation %j', extra => {
    expect(() => buildCurrentProjectPlan({
      ...input, specWorkflow: 'manual', agents: ['claude'], ...extra
    }, options)).toThrow(PlanValidationError);
  });

  it('retains the Spec Kit selected-default requirement', () => {
    for (const extra of [{}, { defaultAgent: 'codex' }]) {
      expect(() => buildCurrentProjectPlan({
        ...input, specWorkflow: 'spec-kit', agents: ['github-copilot', 'claude'], ...extra
      }, options)).toThrow(PlanValidationError);
    }
  });

  it.each([
    { projectType: 'standard', apiStack: 'python-fastapi' },
    { projectType: 'standard', apiStack: 'node-fastify' },
    { projectType: 'standard', apiStack: 'go-huma' },
    { projectType: 'genai', apiStack: 'python-fastapi', pattern: 'generic' }
  ])('retains real workload and environment decisions for Manual %j', workload => {
    const selected = { ...input, ...workload, includeFrontend: true, environments: ['prod', 'dev'] };
    const current = buildCurrentProjectPlan({ ...selected, specWorkflow: 'manual' }, options);
    const historical = buildProjectPlan(selected, options);
    expect(current.workload).toBe(historical.workload);
    expect(current.apiStack).toEqual(historical.apiStack);
    expect(current.approvedStack).toEqual(historical.approvedStack);
    expect(current.environments).toEqual(historical.environments);
    expect(current.includeFrontend).toBe(true);
    expect(current.framework).toBeUndefined();
  });

  it('keeps governance none disabled without selecting a current governance source', () => {
    const plan = buildCurrentProjectPlan({ ...input, specWorkflow: 'manual', governanceProfile: 'none' }, options);
    expect(plan.governanceProfile.id).toBe('none');
    expect(plan.governanceProfile.policyVersion).toBeUndefined();
    expect(plan.agents).toEqual([]);
    expect(plan.framework).toBeUndefined();
  });

  it('selects the packaged team policy only for current generation', () => {
    const plan = buildCurrentProjectPlan({
      ...input,
      specWorkflow: 'manual',
      governanceProfile: 'team-gitflow'
    }, options);
    expect(plan.governanceProfile).toMatchObject({
      id: 'team-gitflow',
      policyVersion: '1'
    });
    expect(() => buildProjectPlan({
      ...input,
      governanceProfile: 'team-gitflow'
    }, options)).toThrow(/current manifest-v8/u);
  });

  it.each([
    { specWorkflow: 'unknown' },
    { projectType: 'power-apps-code-app' }
  ])('does not expose deferred or retired selections %j', extra => {
    expect(() => buildCurrentProjectPlan({ ...input, specWorkflow: 'manual', ...extra }, options))
      .toThrow(PlanValidationError);
  });
});
