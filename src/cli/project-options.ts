import {
  readBooleanFlag,
  readListFlag,
  readStringFlag
} from './args/readers.js';
import {
  loadConfigOptions
} from '../application/project/planning.js';
import {
  mergeOptions,
  PlanValidationError
} from '../domain/project/planning.js';
import type {
  ParsedArgs,
  ProjectOptions
} from '../domain/project/contracts.js';
import {
  isRetiredPowerAppsWorkload,
  retiredPowerAppsMessage
} from '../domain/project/retired-workload.js';
export { hasMissingInitInputs } from '../application/initialize/inputs.js';

export async function optionsFromParsedArgs(parsed: ParsedArgs, cwd: string, includeProjectName: boolean): Promise<ProjectOptions> {
  if (Object.hasOwn(parsed.flags, 'code-apps-plugin')) {
    throw new PlanValidationError([
      'Flag --code-apps-plugin was removed because Power Apps code apps are retired and unsupported.'
    ]);
  }
  const configPath = readStringFlag(parsed.flags, 'config');
  const configOptions = configPath ? await loadConfigOptions(configPath, cwd) : {};
  const flagOptions: ProjectOptions = {
    projectName: includeProjectName ? parsed.positional[0] ?? readStringFlag(parsed.flags, 'project') : readStringFlag(parsed.flags, 'project'),
    projectType: readStringFlag(parsed.flags, 'type'),
    genai: readBooleanFlag(parsed.flags, 'genai'),
    apiStack: readStringFlag(parsed.flags, 'api'),
    pattern: readStringFlag(parsed.flags, 'pattern'),
    cloud: readStringFlag(parsed.flags, 'cloud'),
    region: readStringFlag(parsed.flags, 'region'),
    includeFrontend: readBooleanFlag(parsed.flags, 'frontend'),
    environments: readListFlag(parsed.flags, 'environments'),
    specWorkflow: readStringFlag(parsed.flags, 'spec'),
    agents: readListFlag(parsed.flags, 'agents'),
    defaultAgent: readStringFlag(parsed.flags, 'default-agent'),
    copilotCloud: readBooleanFlag(parsed.flags, 'copilot-cloud'),
    configureOpenSpecProfile: readBooleanFlag(parsed.flags, 'configure-openspec-profile'),
    governanceProfile: readStringFlag(parsed.flags, 'governance'),
    configPath,
    yes: readBooleanFlag(parsed.flags, 'yes') ?? false,
    force: readBooleanFlag(parsed.flags, 'force'),
    installTools: readBooleanFlag(parsed.flags, 'install-tools'),
    installDependencies: readBooleanFlag(parsed.flags, 'install-dependencies')
  };

  if (isRetiredPowerAppsWorkload(flagOptions.projectType)) {
    throw new PlanValidationError([retiredPowerAppsMessage(flagOptions.projectType)]);
  }
  return mergeOptions(configOptions, flagOptions);
}
