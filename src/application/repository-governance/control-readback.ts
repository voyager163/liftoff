import { GitHubActivationError } from '../../adapters/github/activation-rest.js';
import type { GitHubRulesetWriteResult, PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import { isRecord } from '../../domain/governance/activation/canonical-json.js';
import type { LiveReadbackProof } from '../../domain/governance/activation/types.js';
import { readbackProof } from '../../governance-activation/transition-records.js';

export function assertMatchingControlReadback(
  expectedSourceDigest: string,
  readback: unknown,
  repository: string
): asserts readback is Pick<GitHubRulesetWriteResult, 'resourceId' | 'sourceDigest' | 'readbackDigest'> {
  const collection = `/repos/${repository}/rulesets`;
  if (!isRecord(readback) || typeof readback.resourceId !== 'string' || readback.resourceId.length === 0 ||
    (readback.resourceId !== collection &&
      (!readback.resourceId.startsWith(`${collection}/`) || !/^[1-9]\d*$/u.test(readback.resourceId.slice(collection.length + 1)))) ||
    !/^[a-f0-9]{64}$/u.test(expectedSourceDigest) ||
    readback.sourceDigest !== expectedSourceDigest || readback.readbackDigest !== expectedSourceDigest) {
    throw new GitHubActivationError(
      'control-readback-mismatch',
      'Independent control readback does not match the exact reviewed repository and source digest; semantic helper equality alone is not proof.'
    );
  }
}

export function controlReadbackProof(
  input: PhaseAdapterExecutionInput,
  expectedSourceDigest: string,
  readback: GitHubRulesetWriteResult,
  repository: string
): LiveReadbackProof {
  assertMatchingControlReadback(expectedSourceDigest, readback, repository);
  return {
    ...readbackProof(input, 'github', 'ruleset', readback.resourceId, {
      repository, sourceDigest: readback.sourceDigest, readbackDigest: readback.readbackDigest
    }),
    sourceDigest: readback.sourceDigest,
    readbackDigest: readback.readbackDigest
  };
}
