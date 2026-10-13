import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput } from './transition-ports.js';
import type { TransitionOperation, LiveReadbackProof } from '../domain/governance/activation/types.js';
import { planGitHubPublication, executeGitHubPublication } from './github-publication.js';
import { executeGitHubDiscovery, planGitHubDiscovery, observeGitHubPhase0 } from './github-discovery.js';
import { clientFor, githubOperation, repositoryConfiguration } from './github-config.js';
import { executeCredentialReady, executeRulesetPhase } from './phase-governance.js';
import { phaseCapabilities } from '../domain/governance/activation/capabilities.js';

export async function planGitHubPhase(input: PhasePlanningInput): Promise<PhasePlanBuild | null> {
  const repository = repositoryConfiguration(input.inspection).name;
  switch (input.phase.id) {
    case 'pushed':
      if (input.inspection.activationInputs?.repository?.create) {
        return planGitHubPublication(input);
      }
      return null;
    case 'phase-0-complete':
      return await planGitHubDiscovery(input);
    case 'bootstrap-workflow-source-ready':
      return {
        operations: [
          {
            phaseId: input.phase.id, adapter: 'local-state', actionId: 'local.workflow-source.write',
            mutationClass: 'write-workflows', inputs: { path: '.github/workflows' },
            destination: { type: 'local', identity: '.github/workflows', pathParts: ['.github', 'workflows'] },
            remote: false, destructive: false
          },
          {
            phaseId: input.phase.id, adapter: 'git', actionId: 'git.commit-reviewed',
            mutationClass: 'git-commit', inputs: { message: 'Bootstrap verification workflows' },
            destination: { type: 'local', identity: '.git' },
            remote: false, destructive: false
          },
          {
            phaseId: input.phase.id, adapter: 'git', actionId: 'git.push-approved-ref',
            mutationClass: 'git-push', inputs: { branch: 'develop' },
            destination: { type: 'repository', identity: repository, repository },
            remote: true, destructive: false
          },
          githubOperation(input, 'github.bootstrap-local.configure', 'github-write', { repository })
        ]
      };
    case 'credential-ready':
      return {
        operations: [
          githubOperation(input, 'github.credential.verify-policy', 'github-read', { repository })
        ]
      };
    case 'runner-ready':
      return {
        operations: [
          githubOperation(input, 'github.runner.ensure-ready', 'github-write', { repository })
        ]
      };
    case 'private-backend-proof':
      return {
        operations: [
          githubOperation(input, 'github.runner.backend-proof', 'github-workflow-dispatch', { repository })
        ]
      };
    case 'application-artifact-ready':
      return {
        operations: [
          githubOperation(input, 'github.artifact.build-dispatch', 'github-workflow-dispatch', { repository })
        ]
      };
    case 'workflow-source-ready':
      return {
        operations: [
          {
            phaseId: input.phase.id, adapter: 'local-state', actionId: 'local.workflow-source.write',
            mutationClass: 'write-workflows', inputs: { path: '.github/workflows' },
            destination: { type: 'local', identity: '.github/workflows', pathParts: ['.github', 'workflows'] },
            remote: false, destructive: false
          },
          {
            phaseId: input.phase.id, adapter: 'local-state', actionId: 'local.ruleset-source.write',
            mutationClass: 'write-ruleset-source', inputs: { path: '.github/rulesets' },
            destination: { type: 'local', identity: '.github/rulesets', pathParts: ['.github', 'rulesets'] },
            remote: false, destructive: false
          }
        ]
      };
    case 'dev-proof':
      return {
        operations: [
          githubOperation(input, 'github.checks.dev-proof', 'github-workflow-dispatch', { repository })
        ]
      };
    case 'staging-qualified':
      return {
        operations: [
          githubOperation(input, 'github.checks.staging', 'github-workflow-dispatch', { repository })
        ]
      };
    case 'production-rehearsed':
      return {
        operations: [
          githubOperation(input, 'github.checks.production-rehearsal', 'github-workflow-dispatch', { repository })
        ]
      };
    case 'green-red-proof':
      return {
        operations: [
          githubOperation(input, 'github.checks.green-red-proof', 'github-workflow-dispatch', { repository })
        ]
      };
    case 'rulesets-applied':
      return {
        operations: [
          githubOperation(input, 'github.ruleset.apply', 'github-ruleset-write', { repository }),
          githubOperation(input, 'github.ruleset.readback', 'github-read', { repository })
        ]
      };
    case 'live-readback':
      return {
        operations: [
          githubOperation(input, 'github.ruleset.readback', 'github-read', { repository })
        ]
      };
    default:
      return null;
  }
}

export async function executeGitHubPhase(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null> {
  // Fails closed on repository drift before any phase producer runs.
  repositoryConfiguration(input.inspection);
  switch (input.phase.id) {
    case 'pushed':
      if (input.inspection.activationInputs?.repository?.create) {
        return executeGitHubPublication(input);
      }
      return null;
    case 'phase-0-complete':
      return executeGitHubDiscovery(input);
    case 'credential-ready':
      if (input.credentialEnrollment) {
        // Public enrollment stays unavailable until independent readback exists: refuse before any input channel or write.
        return {
          status: 'blocked',
          blocker: `${phaseCapabilities['credential-ready'].blocker ?? 'Public credential enrollment is unavailable.'} ` +
            'No credential input was read and no Actions secret or credential policy was written.',
          completedOperations: []
        };
      }
      return executeCredentialReady(input);
    case 'rulesets-applied':
    case 'live-readback':
      return executeRulesetPhase(input);
    default:
      return null;
  }
}
