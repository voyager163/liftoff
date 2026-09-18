import {
  GitHubActivationError, githubName, githubRepository, positiveId
} from '../../adapters/github/activation-rest.js';
import { exactObject } from './private-resource-plans.js';

export interface PrivateRunnerAssignmentBinding {
  schemaVersion: 1;
  repository: string;
  repositoryId: number;
  organization: string;
  organizationId: number;
  groupId: number;
  runnerGroupName: string;
  definitionId: number;
  runnerName: string;
  imageId: string;
  machineSize: string;
  maxRunners: number;
  networkConfigurationId: string;
  networkConfigurationName: string;
  networkSettingsId: string;
  subnetId: string;
  region: string;
  allowedWorkflows: readonly string[];
}

function require(value: unknown, message: string): asserts value {
  if (!value) throw new GitHubActivationError('private-runner-assignment', message);
}

export function privateRunnerNetworkId(value: unknown): string {
  require(typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(value),
    'Runner assignment requires an actual provider-issued network ID.');
  return value;
}

export function validatePrivateRunnerAssignment(value: unknown): PrivateRunnerAssignmentBinding {
  const data = exactObject(value, [
    'schemaVersion', 'repository', 'repositoryId', 'organization', 'organizationId', 'groupId', 'runnerGroupName',
    'definitionId', 'runnerName', 'imageId', 'machineSize', 'maxRunners', 'networkConfigurationId',
    'networkConfigurationName', 'networkSettingsId', 'subnetId', 'region', 'allowedWorkflows'
  ], 'Exact private runner assignment');
  const repository = githubRepository(data.repository), organization = githubName(data.organization);
  require(data.schemaVersion === 1 && repository.split('/')[0] === organization &&
    Number.isSafeInteger(data.maxRunners) && Number(data.maxRunners) >= 1 && Number(data.maxRunners) <= 8 &&
    typeof data.subnetId === 'string' &&
    /^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/virtualNetworks\/[^/]+\/subnets\/[^/]+$/u.test(data.subnetId) &&
    typeof data.region === 'string' && /^[a-z][a-z0-9]{1,39}$/u.test(data.region) &&
    Array.isArray(data.allowedWorkflows) && data.allowedWorkflows.length > 0 && data.allowedWorkflows.length <= 8,
  'Assignment requires exact provider IDs, subnet, region and a bounded workflow allowlist.');
  const allowedWorkflows = data.allowedWorkflows.map((entry) => {
    require(typeof entry === 'string' && entry.startsWith(`${repository}/.github/workflows/`) &&
      /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@refs\/heads\/[A-Za-z0-9_./-]+$/u.test(entry.slice(repository.length + 1)) &&
      !entry.includes('..') && !entry.includes('//'), 'Workflow access must name one exact same-repository path and branch.');
    return entry;
  });
  require(new Set(allowedWorkflows).size === allowedWorkflows.length, 'Duplicate workflow selectors cannot expand or disguise assignment.');
  return {
    schemaVersion: 1, repository, repositoryId: positiveId(data.repositoryId), organization,
    organizationId: positiveId(data.organizationId), groupId: positiveId(data.groupId),
    runnerGroupName: githubName(data.runnerGroupName), definitionId: positiveId(data.definitionId),
    runnerName: githubName(data.runnerName), imageId: githubName(data.imageId), machineSize: githubName(data.machineSize),
    maxRunners: Number(data.maxRunners), networkConfigurationId: privateRunnerNetworkId(data.networkConfigurationId),
    networkConfigurationName: githubName(data.networkConfigurationName), networkSettingsId: privateRunnerNetworkId(data.networkSettingsId),
    subnetId: data.subnetId, region: data.region, allowedWorkflows
  };
}
