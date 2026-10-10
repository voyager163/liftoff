import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput } from './transition-ports.js';
import type { TransitionOperation, LiveReadbackProof } from '../domain/governance/activation/types.js';
import { planGitHubPublication, executeGitHubPublication } from './github-publication.js';
import { executeGitHubDiscovery, planGitHubDiscovery, observeGitHubPhase0 } from './github-discovery.js';
import {
  assertGitHubAuthorized, clientFor, githubOperation, phaseConfiguration, repositoryConfiguration, verifiedOutput
} from './github-config.js';
import { executeRulesetPhase } from './phase-governance.js';
import {
  enrollGitHubCredential, githubCliSecretWriter, parseGitHubCredentialConfiguration
} from '../adapters/credentials/github-enrollment.js';
import { githubPorts } from './github-ports.js';
import { privateTtyCredentialChannel, protectedStdinCredentialChannel } from '../adapters/credentials/protected-input.js';
import {
  credentialPolicyPathParts, detectCredentialLeaks, runnerPreflightWorkflowAllowlist
} from './credentials.js';
import { positiveId, safeGitHubFailure } from '../adapters/github/activation-rest.js';
import { canonicalJson, canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { captureProjectFileSnapshot } from '../adapters/filesystem/project-transaction.js';
import { readbackProof } from './transition-records.js';
import { runnerPreflightSecretName } from '../domain/governance/activation/types.js';
import {
  runnerGitHubPlanInputs
} from './runner-readiness.js';

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
      {
        const configuration = parseGitHubCredentialConfiguration(phaseConfiguration(
          input.inspection,
          input.phase.id,
          ['kind', 'appId', 'installationId', 'tokenId', 'owner', 'appUnavailableReason']
        ));
        const repositoryId = positiveId(verifiedOutput(input.inspection, 'phase-0-complete', 'repositoryId'), 'Verified repository ID');
        const policyPath = credentialPolicyPathParts.join('/');
        return {
          operations: [
            githubOperation(input, 'github.credential.enroll-masked', 'github-secret-write', {
              repository, repositoryId, secretName: runnerPreflightSecretName, configuration,
              allowedWorkflows: runnerPreflightWorkflowAllowlist,
              protectedInput: 'private-tty-or-explicit-protected-stdin'
            }),
            githubOperation(input, 'github.credential.verify-policy', 'github-read', {
              repository, repositoryId, secretName: runnerPreflightSecretName, policyPathParts: credentialPolicyPathParts
            }),
            {
              phaseId: input.phase.id, adapter: 'local-state', actionId: 'local.credential-policy.write',
              mutationClass: 'write-credential-policy', inputs: { pathParts: credentialPolicyPathParts },
              destination: { type: 'local', identity: policyPath, pathParts: credentialPolicyPathParts },
              remote: false, destructive: false
            }
          ]
        };
      }
    case 'runner-ready':
      {
        const plan = runnerGitHubPlanInputs(input);
      return {
        operations: [
          githubOperation(
            input,
            'github.runner.ensure-ready',
            'github-write',
            plan,
            { type: 'external', identity: `/orgs/${plan.organization}` }
          )
        ]
      };
      }
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
      return executeCredentialEnrollment(input);
    case 'rulesets-applied':
    case 'live-readback':
      return executeRulesetPhase(input);
    default:
      return null;
  }
}

async function executeCredentialEnrollment(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  if (!input.credentialEnrollment) {
    return {
      status: 'blocked',
      blocker: 'Credential enrollment must be explicitly invoked with governance credential-enroll after reviewing and approving the credential-ready plan. No protected input was read.',
      completedOperations: []
    };
  }
  const enrollment = input.plan.operations.find((operation) => operation.actionId === 'github.credential.enroll-masked');
  const verification = input.plan.operations.find((operation) => operation.actionId === 'github.credential.verify-policy');
  const policyWrite = input.plan.operations.find((operation) => operation.actionId === 'local.credential-policy.write');
  if (!enrollment || !verification || !policyWrite) {
    return {
      status: 'blocked',
      blocker: 'Credential enrollment requires the exact reviewed enrollment, independent readback, and local payload-free policy operations.',
      completedOperations: []
    };
  }
  try {
    const configuration = parseGitHubCredentialConfiguration(phaseConfiguration(
      input.inspection,
      input.phase.id,
      ['kind', 'appId', 'installationId', 'tokenId', 'owner', 'appUnavailableReason']
    ));
    const repository = repositoryConfiguration(input.inspection).name;
    const repositoryId = positiveId(verifiedOutput(input.inspection, 'phase-0-complete', 'repositoryId'), 'Verified repository ID');
    const ports = githubPorts(input);
    const channel = ports.protectedCredentialChannel ?? (input.credentialEnrollment.protectedStdin
      ? protectedStdinCredentialChannel(true)
      : privateTtyCredentialChannel());
    await assertGitHubAuthorized(input, enrollment);
    await assertGitHubAuthorized(input, verification);
    const result = await enrollGitHubCredential({
      repository,
      repositoryId,
      configuration,
      identity: input.inspection.state.identity,
      client: clientFor(input),
      channel,
      secretWriter: ports.secretWriter ?? githubCliSecretWriter(input.runner, input.inspection.projectRoot),
      ...(ports.credentialTransport ? { credentialTransport: ports.credentialTransport } : {}),
      now: input.clock?.() ?? input.now,
      assertAuthorized: async () => assertGitHubAuthorized(input, enrollment)
    });
    const policyText = `${canonicalJson(result.policy)}\n`;
    const scan = detectCredentialLeaks([{
      source: 'generated-artifact',
      label: credentialPolicyPathParts.join('/'),
      text: policyText
    }]);
    if (scan.status === 'compromised') {
      throw new Error('The generated credential policy contained credential-shaped material; it was not persisted.');
    }
    const usageDigest = canonicalSha256(result.usage);
    if (result.policy.proof.readbackDigest !== usageDigest) {
      throw new Error('Credential policy proof does not match the independently observed sanitized usage result.');
    }
    const policyDigest = canonicalSha256(result.policy);
    const liveReadback = readbackProof(
      input,
      'github',
      'actions-secret-metadata',
      `/repos/${repository}/actions/secrets/${runnerPreflightSecretName}`,
      result.usage
    );
    const before = await captureProjectFileSnapshot(input.inspection.projectRoot, [...credentialPolicyPathParts]);
    return {
      status: 'completed',
      resultState: 'verified',
      evidencePayload: {
        kind: 'credential-ready.v1',
        policyDigest,
        usageDigest,
        configurationDigest: canonicalSha256(configuration),
        usage: result.usage
      },
      liveReadback: [liveReadback],
      fileMutations: [{
        type: 'write',
        pathParts: [...credentialPolicyPathParts],
        content: policyText,
        mode: 0o600
      }],
      filePreconditions: [before],
      completedOperations: [enrollment, verification, policyWrite],
      cleanupWarnings: result.cleanupWarnings
    };
  } catch (error) {
    return {
      status: 'blocked',
      blocker: safeGitHubFailure(error),
      completedOperations: []
    };
  }
}
