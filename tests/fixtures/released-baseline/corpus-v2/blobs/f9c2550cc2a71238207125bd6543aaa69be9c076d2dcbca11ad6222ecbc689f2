import { loadProjectConfigOptions } from '../../adapters/filesystem/project-config.js';
import type {
  ProjectOptions,
  ProjectPlan
} from '../../domain/project/contracts.js';
import {
  buildProjectPlanWithCatalog,
  type BuildPlanOptions
} from '../../domain/project/planning.js';
import { projectCatalog } from './catalog.js';

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

export function buildProjectPlan(
  input: ProjectOptions,
  options: BuildPlanOptions
): ProjectPlan {
  return buildProjectPlanWithCatalog(input, options, projectCatalog);
}
