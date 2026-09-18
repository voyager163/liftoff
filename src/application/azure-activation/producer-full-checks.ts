import { GitHubActivationClient, GitHubActivationError } from '../../adapters/github/activation-rest.js';
import type { PhasePlanningInput, PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import { clientFor } from '../../governance-activation/github-config.js';
import { assertGitHubPhaseAuthority } from '../repository-governance/workflow-authority.js';
import {
  planFullActivationChecks, executeFullActivationChecks, type PredecessorVerifierCallback
} from './full-activation-checks.js';
import { readVerifiedStagingQualification } from './staging-qualification-receipt.js';
import { readVerifiedRehearsalQualification } from './rehearsal-qualification-receipt.js';

export function fullProductionPredecessorVerifier(
  input: PhasePlanningInput | PhaseAdapterExecutionInput, readOnlyClient?: GitHubActivationClient
): PredecessorVerifierCallback {
  const base = readOnlyClient ?? clientFor(input);
  const client = new GitHubActivationClient({ async request(request) {
    if (request.method !== 'GET') throw new GitHubActivationError('qualification-read-only', 'Retained production qualification grants no hidden provider mutations.');
    if ('plan' in input) {
      const operation = input.plan.operations.find((entry) => entry.actionId === 'github.checks.green-red-proof');
      if (!operation) throw new GitHubActivationError('qualification-read-authority', 'The exact full check qualification operation is absent.');
      await assertGitHubPhaseAuthority(input, operation);
    }
    return base.transport.request(request);
  } });
  return async (requested) => {
    const staging = await readVerifiedStagingQualification(input, client, requested.staging);
    const rehearsal = await readVerifiedRehearsalQualification(input, client, requested.rehearsal);
    if (typeof requested.artifactDigest !== 'string' || staging.sourceSha !== requested.sourceSha ||
      rehearsal.sourceSha !== requested.sourceSha || staging.artifactDigest !== requested.artifactDigest ||
      rehearsal.artifactDigest !== requested.artifactDigest) {
      throw new GitHubActivationError('full-qualification-binding', 'Full checks require concrete staging and separately approved rollout/rollback for the exact same source and immutable artifact.');
    }
    return {
      sourceSha: requested.sourceSha, artifactDigest: requested.artifactDigest,
      staging: { phaseId: 'staging-qualified', ...requested.staging, sourceSha: requested.sourceSha,
        artifactDigest: requested.artifactDigest, verifiedAt: staging.producedAt },
      rehearsal: { phaseId: 'production-rehearsed', ...requested.rehearsal, sourceSha: requested.sourceSha,
        artifactDigest: requested.artifactDigest, verifiedAt: rehearsal.producedAt }
    };
  };
}

export const fullProductionChecksProducer = {
  plan: (input: PhasePlanningInput) => planFullActivationChecks(input, { predecessorVerifier: fullProductionPredecessorVerifier(input) }),
  execute: (input: PhaseAdapterExecutionInput) => executeFullActivationChecks(input, { predecessorVerifier: fullProductionPredecessorVerifier(input) })
};
