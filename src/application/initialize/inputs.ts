import { getCodingAgent, getProjectType, projectInputCatalog } from '../project/catalog.js';
import type { ProjectOptions } from '../../domain/project/contracts.js';
import { normalizeProjectOptions, resolveProjectTypeInput } from '../../domain/project/inputs.js';
import { PlanValidationError } from '../../domain/project/planning.js';
import { isRetiredPowerAppsWorkload, retiredPowerAppsMessage } from '../../domain/project/retired-workload.js';

export function assertSupportedProjectOptions(options: ProjectOptions): void {
  if (isRetiredPowerAppsWorkload(options.projectType)) {
    throw new PlanValidationError([retiredPowerAppsMessage(String(options.projectType))]);
  }
}

export function hasMissingInitInputs(rawOptions: ProjectOptions): boolean {
  const options = normalizeProjectOptions(rawOptions, projectInputCatalog);
  const projectType = resolveProjectTypeInput(options, getProjectType).projectType?.id;
  const missingTypeSpecific = projectType === 'genai'
    ? !options.pattern
    : projectType === 'standard'
      ? !options.apiStack
      : true;
  const missingDefaultAgent = options.specWorkflow === 'spec-kit' &&
    (options.agents?.length ?? 0) > 1 &&
    !options.defaultAgent;
  const missingCopilotCloud = options.specWorkflow === 'openspec' &&
    options.agents?.some((agent) => getCodingAgent(agent)?.id === 'github-copilot') === true &&
    options.copilotCloud === undefined;
  return !options.projectName ||
    missingTypeSpecific ||
    !options.cloud ||
    options.includeFrontend === undefined ||
    !options.specWorkflow ||
    !options.agents ||
    !options.governanceProfile ||
    missingDefaultAgent ||
    missingCopilotCloud ||
    !options.environments;
}
