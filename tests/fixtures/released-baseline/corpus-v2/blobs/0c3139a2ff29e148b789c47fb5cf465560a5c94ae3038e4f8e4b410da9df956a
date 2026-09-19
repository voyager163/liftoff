import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, Phase0DiscoveryFacts } from './transition-ports.js';
import { runCommand, commandSucceeded, commandFailure, errorMessage } from './transition-process.js';
import { inspectGitRepository, reviewedPushUrl } from './phase-publication.js';
import { githubRepositoryFromPushUrl } from '../domain/governance/activation/inputs.js';
import { cloneState, readbackProof } from './transition-records.js';

export async function discoverPhase0(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null> {
  if (input.phase.id !== 'phase-0-complete') return null;
  const gh = await runCommand(input.runner, {
    executable: 'gh',
    args: ['repo', 'view', String(input.plan.operations.find((operation) => operation.actionId === 'github.phase0.discover')?.inputs.repository),
      '--json', 'id,nameWithOwner,defaultBranchRef,isPrivate']
  }, input.inspection.projectRoot);
  if (!commandSucceeded(gh)) {
    return {
      status: 'blocked',
      blocker: `Phase 0 GitHub read-only discovery failed: ${commandFailure(gh)}`,
      completedOperations: []
    };
  }
  let repo: { id?: string; nameWithOwner?: string; defaultBranchRef?: { name?: string }; isPrivate?: boolean };
  try {
    repo = JSON.parse(gh.stdout) as typeof repo;
  } catch (error) {
    return {
      status: 'blocked',
      blocker: `Phase 0 GitHub discovery returned invalid JSON: ${errorMessage(error)}`,
      completedOperations: []
    };
  }
  if (!repo.id || !repo.nameWithOwner || !repo.defaultBranchRef?.name) {
    return {
      status: 'blocked',
      blocker: 'Phase 0 GitHub discovery did not return repository id, nameWithOwner, and default branch.',
      completedOperations: []
    };
  }
  const git = await inspectGitRepository(input.inspection.projectRoot, input.runner);
  const pushUrl = reviewedPushUrl(git);
  const remoteName = githubRepositoryFromPushUrl(pushUrl);
  if (remoteName.toLowerCase() !== repo.nameWithOwner.toLowerCase()) {
    return { status: 'blocked', blocker: 'Phase 0 repository readback differs from the actual reviewed Git push destination.', completedOperations: [] };
  }
  const facts: Phase0DiscoveryFacts = {
    repositoryId: repo.id,
    repositoryName: repo.nameWithOwner,
    defaultBranch: repo.defaultBranchRef.name,
    baselineDigest: input.plan.baselineDigest,
    privateStagingDast: 'unknown',
    credentialRequired: 'unknown',
    statePath: 'none',
    approvedFacts: [
      { id: 'repository.id', value: repo.id },
      { id: 'repository.nameWithOwner', value: repo.nameWithOwner },
      { id: 'repository.defaultBranch', value: repo.defaultBranchRef.name },
      { id: 'repository.isPrivate', value: repo.isPrivate ?? null },
      { id: 'azure.accountReadable', value: null }
    ]
  };
  const nextState = cloneState(input.inspection.state);
  nextState.remoteBinding = {
    id: facts.repositoryId,
    name: facts.repositoryName,
    defaultBranch: facts.defaultBranch,
    pushUrl,
    verifiedAt: input.now.toISOString()
  };
  nextState.applicability = {
    statePath: facts.statePath,
    privateStagingDast: facts.privateStagingDast,
    credentialRequired: facts.credentialRequired
  };
  return {
    status: 'completed',
    resultState: 'verified',
    evidencePayload: {
      kind: 'phase-0-discovery.v1',
      facts: facts.approvedFacts,
      activationCreateChangePlan: { deterministic: true, graphHash: input.inspection.graphHash }
    },
    stateOverride: nextState,
    liveReadback: [readbackProof(input, 'github', 'repository', repo.nameWithOwner, {
      id: repo.id, nameWithOwner: repo.nameWithOwner, defaultBranch: repo.defaultBranchRef.name, isPrivate: repo.isPrivate ?? null
    })],
    completedOperations: input.plan.operations.filter((op) => op.actionId === 'github.phase0.discover' || op.actionId === 'azure.phase0.discover')
  };
}
