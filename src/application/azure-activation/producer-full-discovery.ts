import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome } from '../../governance-activation/transition-ports.js';
import { clientFor } from '../../governance-activation/github-config.js';
import { inspectGitRepository, reviewedPushUrl } from '../../governance-activation/phase-publication.js';
import { githubRepositoryFromPushUrl } from '../../domain/governance/activation/inputs.js';
import { cloneState, readbackProof } from '../../governance-activation/transition-records.js';
import { positiveId, safeGitHubFailure } from '../../adapters/github/activation-rest.js';
import { validateAzureBindings } from '../../adapters/azure/production-adapter.js';
import { resolveAzureInputs } from './producer-discovery.js';
import { executeGitHubDiscovery } from '../../governance-activation/github-discovery.js';

export async function discoverPhase0(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null> {
  if (input.phase.id !== 'phase-0-complete' || input.inspection.scope === 'repository') return null;
  const bindings = validateAzureBindings(resolveAzureInputs(input));
  if (!bindings.valid || !input.plan.operations.some((operation) => operation.actionId === 'azure.phase0.discover')) {
    return {
      status: 'blocked', completedOperations: [],
      blocker: 'Full activation discovery requires explicit valid Azure subscription, tenant and region and its exact reviewed account read. Select repository scope separately for GitHub-only work.'
    };
  }
  const operation = input.plan.operations.find((operation) => operation.actionId === 'github.phase0.discover');
  if (!operation || typeof operation.inputs.repository !== 'string') {
    return { status: 'blocked', blocker: 'Phase 0 has no exact reviewed repository observation.', completedOperations: [] };
  }
  try {
    const repository = operation.inputs.repository;
    const repo = await clientFor(input).get(`/repos/${repository}`);
    const id = String(positiveId(repo.id));
    if (repo.full_name !== repository || typeof repo.default_branch !== 'string' || typeof repo.private !== 'boolean') {
      throw new Error('Repository identity/default branch readback is incomplete or differs from its requested target.');
    }
    const git = await inspectGitRepository(input.inspection.projectRoot, input.runner);
    const pushUrl = reviewedPushUrl(git);
    if (githubRepositoryFromPushUrl(pushUrl).toLowerCase() !== repository.toLowerCase() ||
      input.inspection.state.remoteBinding && input.inspection.state.remoteBinding.id !== id) {
      throw new Error('The repository identity or explicit publication destination changed; existing receipts remain preserved.');
    }
    const state = cloneState(input.inspection.state);
    state.remoteBinding = { id, name: repository, defaultBranch: repo.default_branch, pushUrl, verifiedAt: input.now.toISOString() };
    return await executeGitHubDiscovery({ ...input, inspection: { ...input.inspection, state } });
  } catch (error) {
    return { status: 'blocked', blocker: safeGitHubFailure(error), completedOperations: [] };
  }
}
