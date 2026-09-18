import type {
  PhaseAdapterExecutionInput,
  PhaseAdapterOutcome,
  PhasePlanBuild,
  PhasePlanningInput
} from '../../governance-activation/transition-ports.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import {
  assertGitHubAuthorized,
  clientFor,
  githubOperation,
  phaseConfiguration,
  repositoryConfiguration
} from '../../governance-activation/github-config.js';
import { cloneState, readbackProof } from '../../governance-activation/transition-records.js';
import {
  discoverRepositoryGovernance,
  type RepositoryGovernanceDiscoveryReport
} from '../../adapters/github/production-repository.js';
import {
  safeGitHubFailure,
  GitHubActivationError
} from '../../adapters/github/activation-rest.js';

export async function planRepositoryDiscovery(
  input: PhasePlanningInput
): Promise<PhasePlanBuild> {
  const config = repositoryConfiguration(input.inspection);
  phaseConfiguration(input.inspection, input.phase.id, []);
  const binding = input.inspection.state.remoteBinding;
  if (input.phase.id !== 'repository-discovered' || input.inspection.scope !== 'repository' ||
    !binding || !/^[1-9]\d*$/u.test(binding.id) || !Number.isSafeInteger(Number(binding.id)) ||
    binding.name.toLowerCase() !== config.name.toLowerCase()) {
    throw new GitHubActivationError('repository-binding', 'Repository discovery requires explicit repository scope and the independently verified numeric publication identity.');
  }
  const operation = githubOperation(
    input,
    'github.repository.discover',
    'github-read',
    {
      repository: config.name,
      repositoryId: binding.id,
      scope: 'repository',
      coverage: ['identity', 'branches', 'branch-protection', 'rulesets', 'workflow-source', 'checks', 'actions-capabilities'],
      stability: 'two-matching-observations'
    },
    { type: 'repository', identity: config.name, repository: config.name }
  );
  return { operations: [operation] };
}

export async function executeRepositoryDiscovery(
  input: PhaseAdapterExecutionInput
): Promise<PhaseAdapterOutcome> {
  const completed: TransitionOperation[] = [];

  try {
    const planned = await planRepositoryDiscovery(input);
    const operation = planned.operations[0]!;
    await assertGitHubAuthorized(input, operation);
    const config = repositoryConfiguration(input.inspection);
    const client = clientFor(input);
    const report: RepositoryGovernanceDiscoveryReport = await discoverRepositoryGovernance(
      client,
      config.name,
      input.now,
      Number(operation.inputs.repositoryId)
    );

    const branchNames = report.branches.map((b) => b.name);
    const missingBranches = ['develop', 'main'].filter((b) => !branchNames.includes(b));
    if (missingBranches.length > 0) {
      return {
        status: 'blocked',
        blocker: `Repository ${config.name} is missing required GitFlow permanent branches: ${missingBranches.join(', ')}. Create and publish develop and main before repository governance.`,
        completedOperations: [operation]
      };
    }

    const facts = [
      { id: 'repository.id', value: String(report.repository.id) },
      { id: 'repository.nameWithOwner', value: report.repository.name },
      { id: 'repository.defaultBranch', value: report.repository.defaultBranch },
      { id: 'repository.isPrivate', value: report.repository.isPrivate }
    ];

    const state = cloneState(input.inspection.state);
    if (!state.remoteBinding || state.remoteBinding.id !== String(report.repository.id) ||
      state.remoteBinding.name.toLowerCase() !== report.repository.name.toLowerCase()) {
      return { status: 'blocked', blocker: 'Repository discovery differs from the independently verified publication binding.', completedOperations: [operation] };
    }

    completed.push(operation);

    const resourceId = `/repos/${config.name}`;
    const liveReadbackProofItem = readbackProof(
      input,
      'github',
      'repository',
      resourceId,
      report
    );

    return {
      status: 'completed',
      resultState: 'verified',
      stateOverride: state,
      evidencePayload: {
        kind: 'repository-discovered.v1',
        facts,
        repository: report.repository,
        branches: report.branches,
        branchProtections: report.branchProtections,
        rulesets: report.rulesets,
        rulesetMetadata: report.rulesetMetadata,
        workflows: report.workflows,
        checksByRef: report.checksByRef,
        capabilities: report.capabilities,
        unobserved: report.unobserved,
        observationDigest: report.observationDigest,
        observedAt: report.observedAt
      },
      liveReadback: [liveReadbackProofItem],
      completedOperations: completed,
      outputs: {
        values: {
          repositoryId: report.repository.id,
          repository: report.repository.name,
          defaultBranch: report.repository.defaultBranch
        },
        resources: [{ provider: 'github', resourceType: 'repository', resourceId }]
      }
    };
  } catch (error) {
    return {
      status: 'blocked',
      blocker: safeGitHubFailure(error),
      completedOperations: completed
    };
  }
}
