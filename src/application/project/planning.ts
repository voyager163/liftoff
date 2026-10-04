import { loadProjectConfigOptions } from '../../adapters/filesystem/project-config.js';
import type {
  CurrentProjectPlan,
  ProjectOptions,
  ProjectPlan
} from '../../domain/project/contracts.js';
import {
  buildCurrentProjectPlanWithCatalog,
  buildProjectPlanWithCatalog,
  type BuildPlanOptions
} from '../../domain/project/planning.js';
import { projectCatalog } from './catalog.js';
import { modernActivationSourceContracts } from '../../domain/governance/policy/identity.js';

export {
  PlanValidationError,
  formatProjectPlan,
  mergeOptions,
  projectPlanEntries,
  toSafeProjectName,
  type ProjectPlanEntry
} from '../../domain/project/planning.js';
export {
  normalizeProjectOptions,
  resolveProjectTypeInput,
  type ProjectInputCatalog
} from '../../domain/project/inputs.js';

export function loadConfigOptions(
  configPath: string,
  cwd: string
): Promise<ProjectOptions> {
  return loadProjectConfigOptions(configPath, cwd, projectCatalog);
}

export function loadCurrentConfigOptions(configPath: string, cwd: string): Promise<ProjectOptions> {
  return loadProjectConfigOptions(configPath, cwd, {
    ...projectCatalog,
    getSpecWorkflow: projectCatalog.getDevelopmentWorkflow
  }, { allowEmptyAgents: true });
}

export function buildProjectPlan(
  input: ProjectOptions,
  options: BuildPlanOptions
): ProjectPlan {
  return buildProjectPlanWithCatalog(input, options, projectCatalog);
}

export function buildCurrentProjectPlan(
  input: ProjectOptions,
  options: BuildPlanOptions
): CurrentProjectPlan {
  const plan = buildCurrentProjectPlanWithCatalog(input, options, projectCatalog);
  if (plan.governanceProfile.id === 'none') return plan;
  const source = modernActivationSourceContracts().find(({ identity }) =>
    identity.profile === plan.governanceProfile.id && identity.workflow === plan.specWorkflow.id
  );
  if (!source) throw new Error('No current governance source matches the selected development workflow.');
  return {
    ...plan,
    governanceProfile: { ...plan.governanceProfile, policyVersion: source.identity.policyVersion }
  };
}
