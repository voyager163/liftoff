import { packagedSupportedStack } from '../../adapters/packaged-assets/supported-stack.js';
import { createProjectCatalog } from '../../domain/project/catalog.js';
import { governancePolicyVersion } from '../../repository-governance.js';

export type { RegionResolution } from '../../domain/project/contracts.js';
export type {
  ProjectCatalog,
  ProjectCatalogContext
} from '../../domain/project/catalog.js';

export const projectCatalog = createProjectCatalog({
  frameworkVersions: {
    openspec: packagedSupportedStack.frameworks.openspec.version,
    'spec-kit': packagedSupportedStack.frameworks['spec-kit'].version
  },
  governancePolicyVersion
});

export const {
  approvedStack,
  projectTypes,
  apiStacks,
  patterns,
  providers,
  azureRegions,
  canonicalDefaultEnvironmentIds,
  environments,
  canonicalDefaultEnvironments,
  specWorkflows,
  governanceProfiles,
  codingAgents,
  frameworkDefinitions,
  getPattern,
  getProjectType,
  getApiStack,
  getProvider,
  getSpecWorkflow,
  getGovernanceProfile,
  getCodingAgent,
  getFrameworkDefinition,
  canonicalizeCodingAgents,
  getEnvironment,
  getDefaultRegion,
  listRegions,
  searchRegions,
  resolveRegion,
  isPatternId,
  isProjectTypeId,
  isApiStackId,
  isProviderId,
  isEnvironmentId,
  isSpecWorkflowId,
  isCodingAgentId,
  projectInputCatalog
} = projectCatalog;
