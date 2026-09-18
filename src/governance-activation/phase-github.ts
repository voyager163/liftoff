import type {
  PhaseAdapterExecutionInput,
  PhaseAdapterOutcome,
  PhasePlanBuild,
  PhasePlanningInput
} from './transition-ports.js';
import { planGitHubPublication, executeGitHubPublication } from './github-publication.js';
import { planGitHubDiscovery } from './github-discovery.js';
import { discoverPhase0 } from './phase-discovery.js';
import { githubOperation, repositoryConfiguration } from './github-config.js';
import {
  executeActivationApproval,
  executeRulesetPhase
} from './phase-governance.js';

// Application and adapter imports
import {
  planRepositoryDiscovery,
  executeRepositoryDiscovery
} from '../application/repository-governance/producer-discovery.js';
import {
  planRepositoryWorkflowSource,
  executeRepositoryWorkflowSource
} from '../application/repository-governance/producer-workflow-source.js';
import {
  planRepositoryChecks,
  executeRepositoryChecks
} from '../application/repository-governance/producer-checks.js';
import {
  planRepositoryRulesets,
  planRepositoryLiveReadback,
  executeRepositoryRulesets,
  executeRepositoryLiveReadback
} from '../application/repository-governance/producer-rulesets.js';
import {
  executeProductionCredentialEnrollment,
  executeProductionCredentialChallenge,
  planProductionCredentialReadiness,
  verifyProductionCredentialReadiness
} from '../adapters/credentials/production-credentials.js';
import { executeCompositePhase, planCompositePhase } from './phase-composite.js';
import { executePrivateRunner, planPrivateRunner } from '../application/azure-activation/producer-runner.js';
import { stateWriteOperation } from './transition-records.js';
import { planGreenRedProofPhase } from '../application/azure-activation/producer-qualification.js';

export async function planGitHubPhase(input: PhasePlanningInput): Promise<PhasePlanBuild | null> {
  if (input.phase.id === 'pushed' && !input.inspection.activationInputs?.repository?.create) return null;
  const repository = repositoryConfiguration(input.inspection).name;
  const phaseId = input.phase.id as string;

  switch (phaseId) {
    case 'pushed':
      if (input.inspection.activationInputs?.repository?.create) {
        return planGitHubPublication(input);
      }
      return null;
    case 'phase-0-complete':
      return await planGitHubDiscovery(input);
    case 'repository-discovered':
      return await planRepositoryDiscovery(input);
    case 'bootstrap-workflow-source-ready':
    case 'workflow-source-ready':
    case 'repository-workflow-source-ready':
      return await planRepositoryWorkflowSource(input);
    case 'credential-ready':
      return planProductionCredentialReadiness(input);
    case 'runner-ready':
      return planPrivateRunner(input);
    case 'repository-checks-qualified':
      return await planRepositoryChecks(input);
    case 'private-backend-proof':
      return planCompositePhase(input);
    case 'application-artifact-ready':
    case 'dev-proof':
    case 'production-rehearsed':
    case 'staging-qualified':
      return planCompositePhase(input);
    case 'green-red-proof':
      return planGreenRedProofPhase(input);
    case 'repository-enforcement-approved':
      return { operations: [stateWriteOperation(input.phase)] };
    case 'rulesets-applied':
    case 'repository-rulesets-applied':
      return await planRepositoryRulesets(input);
    case 'live-readback':
    case 'repository-live-readback':
      return planRepositoryLiveReadback(input);
    default:
      return null;
  }
}

export async function executeGitHubPhase(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null> {
  if (input.phase.id === 'pushed' && !input.inspection.activationInputs?.repository?.create) return null;
  const phaseId = input.phase.id as string;

  switch (phaseId) {
    case 'pushed':
      if (input.inspection.activationInputs?.repository?.create) {
        return executeGitHubPublication(input);
      }
      return null;
    case 'phase-0-complete':
      return discoverPhase0(input);
    case 'repository-discovered':
      return executeRepositoryDiscovery(input);
    case 'bootstrap-workflow-source-ready':
    case 'workflow-source-ready':
    case 'repository-workflow-source-ready':
      return executeRepositoryWorkflowSource(input);
    case 'credential-ready': {
      if (input.credentialEnrollment) {
        return executeProductionCredentialEnrollment({ executionInput: input });
      }
      if (input.plan.operations.some((operation) => operation.actionId === 'github.credential.enroll-masked')) {
        return { status: 'blocked', completedOperations: [],
          blocker: 'Credential enrollment requires its owning credential-enroll command and protected input; apply-next cannot acquire secret custody.' };
      }
      if (input.plan.operations.some((operation) => operation.actionId === 'github.credential.usage-challenge')) {
        return executeProductionCredentialChallenge(input);
      }
      return verifyProductionCredentialReadiness(input);
    }
    case 'runner-ready':
      return executePrivateRunner(input);
    case 'private-backend-proof':
      return executeCompositePhase(input);
    case 'repository-checks-qualified':
      return executeRepositoryChecks(input);
    case 'application-artifact-ready':
    case 'dev-proof':
    case 'production-rehearsed':
    case 'staging-qualified':
    case 'green-red-proof':
      return executeCompositePhase(input);
    case 'repository-enforcement-approved':
      return executeActivationApproval(input);
    case 'rulesets-applied':
      return executeRulesetPhase(input);
    case 'repository-rulesets-applied':
      return executeRepositoryRulesets(input);
    case 'live-readback':
      return executeRulesetPhase(input);
    case 'repository-live-readback':
      return executeRepositoryLiveReadback(input);
    default:
      return null;
  }
}
