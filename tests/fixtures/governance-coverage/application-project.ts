import type { ActivationConfiguration, PhaseId, UserActivationState } from '../../../src/governance-activation/index.js';
import type { CommandRunner } from '../../../src/process-runner.js';
import { canonicalPhaseGraph } from '../../../src/domain/governance/activation/graph.js';
import { applicationPrerequisiteBinding } from '../../../src/governance-activation/application-prerequisites.js';
import { bootstrapBinding } from '../../../src/governance-activation/azure-backend-bootstrap.js';
import { runnerBinding } from '../../../src/governance-activation/runner-readiness.js';
import {
  coverageActivationInputs, coverageInspection, coverageNow, coveragePrincipal, coverageState, coverageSubscription
} from './transition-project.js';

export const applicationFixtureClient = '00000000-0000-4000-8000-000000000004';
export const applicationFixtureWorkloadPrincipal = '00000000-0000-4000-8000-000000000005';
export const applicationFixtureWorkloadClient = '00000000-0000-4000-8000-000000000006';

export function configureApplicationFixture(inputs: ActivationConfiguration, state: UserActivationState) {
  inputs.repository = { name: 'owner/repo', defaultBranch: 'develop', visibility: 'private', create: false };
  inputs.budget = { currency: 'USD', fixedMonthlyCents: 5000, usageMonthlyCents: 2500 };
  inputs.phases['state-path-selected'] = {
    ...coverageActivationInputs().phases['state-path-selected'], statePath: 'bootstrap-local'
  };
  inputs.phases['application-prerequisites-ready'] = {
    environment: 'dev', registrySku: 'Basic', assignRegistryRoles: true
  };
  inputs.phases['bootstrap-local'] = {
    environment: 'dev', egressMode: 'nat-gateway', virtualNetworkCidr: '10.42.0.0/24',
    runnerSubnetCidr: '10.42.0.0/27', privateEndpointSubnetCidr: '10.42.0.32/27',
    privateDnsZone: 'privatelink.blob.core.windows.net'
  };
  inputs.phases['runner-ready'] = {
    environment: 'dev', organizationId: 7654321, egressMode: 'nat-gateway',
    image: 'ubuntu-latest', size: '4-core', maximumRunners: 1
  };
  state.activationInputs = inputs;
  state.applicability.statePath = 'bootstrap-local';
  for (const id of ['phase-0-complete', 'provider-ready', 'bootstrap-local', 'runner-ready'] as const) {
    state.phases[id].state = 'verified';
  }
  state.phaseOutputs = {
    ...state.phaseOutputs,
    'phase-0-complete': {
      values: { repositoryId: 123, repository: 'owner/repo', principalType: 'service-principal',
        principalObjectId: coveragePrincipal, principalAppId: applicationFixtureClient },
      resources: [{ provider: 'github', resourceType: 'repository', resourceId: 'owner/repo' }]
    },
    'provider-ready': {
      values: { subscriptionId: coverageSubscription },
      resources: [{ provider: 'azure', resourceType: 'provider-registration',
        resourceId: `/subscriptions/${coverageSubscription}/providers/GitHub.Network` }]
    }
  };
}

export async function applicationPlanningFixture(
  root: string, phaseId: PhaseId, runner: CommandRunner,
  inputs = coverageActivationInputs(), state = coverageState()
) {
  configureApplicationFixture(inputs, state);
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === phaseId)!;
  let inspection = await coverageInspection({ root, phaseId, state, activationInputs: inputs });
  const initial = { inspection, phase, runner, now: coverageNow };
  const bootstrap = bootstrapBinding(initial);
  state.phaseOutputs = {
    ...state.phaseOutputs,
    'bootstrap-local': {
      values: { bootstrapBindingDigest: bootstrap.bindingDigest, backendBindingDigest: bootstrap.backend.bindingDigest,
        environment: bootstrap.environment, egressMode: bootstrap.egressMode },
      resources: [{ provider: 'azure', resourceType: 'Microsoft.Resources/deployments', resourceId: bootstrap.deploymentResourceId },
        ...bootstrap.resourceIds.map((resource) => ({ provider: 'azure' as const, ...resource }))]
    }
  };
  inspection = await coverageInspection({ root, phaseId, state, activationInputs: inputs });
  const runnerPlan = runnerBinding({ ...initial, inspection });
  state.phaseOutputs['runner-ready'] = {
    values: { runnerBindingDigest: runnerPlan.bindingDigest, label: runnerPlan.label, runnerId: 444, groupId: 333,
      networkConfigurationId: 'NC_fixture', networkSettingsId: runnerPlan.networkSettingsResourceId },
    resources: [{ provider: 'github', resourceType: 'hosted-runner', resourceId: '/orgs/owner/actions/hosted-runners/444' }]
  };
  inspection = await coverageInspection({ root, phaseId, state, activationInputs: inputs });
  const prerequisite = applicationPrerequisiteBinding({ ...initial, inspection });
  if (phaseId === 'application-artifact-ready') {
    inputs.phases['application-artifact-ready'] = {
      sourceSha: 'a'.repeat(40), sourceTreeSha: 'b'.repeat(40),
      workflowPath: '.github/workflows/application-artifact.yml',
      workflowDigest: 'b'.repeat(64), contextPath: 'backend', dockerfilePath: 'backend/Dockerfile',
      imageRepository: 'application/backend', sourceTransmissionApproved: true,
      dependencyNetworkApproved: true, buildExecutionApproved: true,
      ...inputs.phases['application-artifact-ready']
    };
    state.phases['application-prerequisites-ready'].state = 'verified';
    state.phaseOutputs['application-prerequisites-ready'] = {
      values: { prerequisiteBindingDigest: prerequisite.bindingDigest,
        environment: prerequisite.environment, registryResourceId: prerequisite.registryId,
        loginServer: `${prerequisite.registryName}.azurecr.io` }, resources: []
    };
  }
  inspection = await coverageInspection({ root, phaseId, state, activationInputs: inputs });
  return { root, inputs, state, inspection, phase, runner, now: coverageNow, bootstrap, runnerPlan, prerequisite };
}
