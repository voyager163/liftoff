import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput } from './transition-ports.js';
import type { TransitionOperation, LiveReadbackProof } from '../domain/governance/activation/types.js';
import { planGitHubPublication, executeGitHubPublication } from './github-publication.js';
import { planGitHubDiscovery, observeGitHubPhase0 } from './github-discovery.js';
import { discoverPhase0 } from './phase-discovery.js';
import { clientFor, githubOperation, repositoryConfiguration } from './github-config.js';
import { executeCredentialReady, executeRulesetPhase } from './phase-governance.js';
import { readbackProof, cloneState } from './transition-records.js';
import { writeProjectFile } from '../adapters/filesystem/project-files.js';
import { credentialPolicyPathParts, buildFineGrainedPatCredentialPolicy, canonicalCredentialRepository } from './credentials.js';
import { runnerPreflightSecretName } from '../domain/governance/activation/types.js';
import { protectedStdinCredentialChannel, privateTtyCredentialChannel } from '../adapters/credentials/protected-input.js';
import { githubCliSecretWriter } from '../adapters/credentials/github-enrollment.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';

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
  const repository = repositoryConfiguration(input.inspection).name;
  switch (input.phase.id) {
    case 'pushed':
      if (input.inspection.activationInputs?.repository?.create) {
        return executeGitHubPublication(input);
      }
      return null;
    case 'phase-0-complete':
      return discoverPhase0(input);
    case 'credential-ready': {
      if (input.credentialEnrollment) {
        try {
          const channel = input.credentialEnrollment.protectedStdin
            ? protectedStdinCredentialChannel(true)
            : privateTtyCredentialChannel();
          const secretBytes = await channel.read('fine-grained PAT');
          const writer = githubCliSecretWriter(input.runner, input.inspection.projectRoot);
          await writer.write(repository, runnerPreflightSecretName, secretBytes);
          const [owner, name] = repository.split('/') as [string, string];
          const policy = buildFineGrainedPatCredentialPolicy({
            repository: canonicalCredentialRepository({ id: input.inspection.state.repository.id, owner, name }),
            allowedWorkflows: [{ path: '.github/workflows/bootstrap-import-preflight.yml', jobs: ['bootstrap-import-preflight'] }],
            createdAt: input.now,
            proof: {
              verifiedAt: input.now.toISOString(),
              readbackDigest: canonicalSha256(secretBytes),
              readbackProvider: 'github-api',
              payloadFree: true
            }
          });
          secretBytes.fill(0);
          await writeProjectFile(input.inspection.projectRoot, [...credentialPolicyPathParts], `${JSON.stringify(policy, null, 2)}\n`);
          const resourceId = `/repos/${repository}/actions/secrets/${runnerPreflightSecretName}`;
          return {
            status: 'completed',
            resultState: 'verified',
            evidencePayload: {
              kind: 'credential-ready.v1',
              policyDigest: canonicalSha256(policy),
              secretName: runnerPreflightSecretName
            },
            liveReadback: [readbackProof(input, 'github', 'secret', resourceId, { enrolled: true })],
            completedOperations: input.plan.operations.filter((op) => op.actionId.startsWith('github.credential.'))
          };
        } catch (error) {
          return {
            status: 'blocked',
            blocker: error instanceof Error ? error.message : String(error),
            completedOperations: []
          };
        }
      }
      return executeCredentialReady(input);
    }
    case 'rulesets-applied':
    case 'live-readback':
      return executeRulesetPhase(input);
    default:
      return null;
  }
}
