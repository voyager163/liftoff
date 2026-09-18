import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { GitHubActivationClient, GitHubActivationError } from '../../adapters/github/activation-rest.js';
import type { RepositoryControlBinding } from '../../adapters/github/repository-control-observation.js';
import { clientFor } from '../../governance-activation/github-config.js';
import type { PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { readVerifiedStagingQualification } from '../azure-activation/staging-qualification-receipt.js';
import { readVerifiedRehearsalQualification } from '../azure-activation/rehearsal-qualification-receipt.js';
import { qualificationEvidenceReference, type QualificationEvidenceReference } from '../azure-activation/qualification-evidence.js';
import type {
  BoundProductionPredecessors, PredecessorVerifierCallback, PredecessorVerifierInput
} from '../azure-activation/full-activation-checks.js';
import { assertEnforcementReadAuthority, type RepositoryControlArtifactReadback } from './repository-control-artifact-readback.js';

function fail(message: string): never {
  throw new GitHubActivationError('control-predecessor-authority', message);
}

function approvedReference(
  readback: RepositoryControlArtifactReadback, phaseId: 'staging-qualified' | 'production-rehearsed',
  reference: QualificationEvidenceReference
): void {
  const declarations = readback.operation.inputs.qualificationReferences;
  if (!Array.isArray(declarations) || !declarations.length || declarations.length > 3 ||
    declarations.filter((entry) => isRecord(entry) && entry.phaseId === phaseId &&
      canonicalSha256(entry.reference) === canonicalSha256(reference)).length !== 1 ||
    declarations.filter((entry) => isRecord(entry) && entry.phaseId === phaseId).length !== 1) {
    fail('Each semantic predecessor needs its exact original reference once in the current approved read operation.');
  }
}

export function enforcementPredecessorReferences(readback: RepositoryControlArtifactReadback): {
  staging: QualificationEvidenceReference;
  rehearsal: QualificationEvidenceReference;
} {
  const declarations = readback.operation.inputs.qualificationReferences;
  if (!Array.isArray(declarations) || declarations.length > 3) fail('The exact approved predecessor reference inventory is missing.');
  const referenceFor = (phaseId: 'staging-qualified' | 'production-rehearsed') => {
    const entries = declarations.filter((entry) => isRecord(entry) && entry.phaseId === phaseId);
    if (entries.length !== 1 || !isRecord(entries[0])) fail('Each production predecessor requires one exact approved original reference.');
    return qualificationEvidenceReference(entries[0].reference);
  };
  return { staging: referenceFor('staging-qualified'), rehearsal: referenceFor('production-rehearsed') };
}

type StagingReadback = Awaited<ReturnType<typeof readVerifiedStagingQualification>> & { sourceSha: string; artifactDigest: string };
type RehearsalReadback = Awaited<ReturnType<typeof readVerifiedRehearsalQualification>> & { sourceSha: string; artifactDigest: string };

/** Reopens real semantic receipts using current read authority; never executes their original native plans. */
export async function readEnforcementProductionPredecessors(
  input: PhasePlanningInput, readback: RepositoryControlArtifactReadback | undefined,
  binding: RepositoryControlBinding, requested: PredecessorVerifierInput
): Promise<{
  staging: StagingReadback;
  rehearsal: RehearsalReadback;
}> {
  if (input.inspection.scope !== 'activation' || !['rulesets-applied', 'live-readback'].includes(input.phase.id)) {
    fail('Semantic production predecessors require the actual full enforcement reader scope.');
  }
  const request = structuredClone(requested);
  const stagingReference = qualificationEvidenceReference(request.staging);
  const rehearsalReference = qualificationEvidenceReference(request.rehearsal);
  if (!/^[a-f0-9]{40}$/u.test(request.sourceSha) || typeof request.artifactDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(request.artifactDigest)) {
    fail('Full predecessor inspection requires distinct exact source and immutable application artifact commitments.');
  }
  await assertEnforcementReadAuthority(input, readback);
  if (!readback) fail('Semantic predecessor inspection cannot borrow a producer approval or planning context.');
  approvedReference(readback, 'staging-qualified', stagingReference);
  approvedReference(readback, 'production-rehearsed', rehearsalReference);
  const current: PhasePlanningInput = {
    inspection: input.inspection, phase: input.phase, runner: input.runner, adapters: input.adapters,
    now: readback.execution.clock?.() ?? input.now
  };
  const transport = clientFor(readback.execution).transport;
  const client = new GitHubActivationClient({ async request(operation) {
    if (operation.method !== 'GET' || operation.path !== '/user' &&
      operation.path !== `/repos/${binding.repository}` && !operation.path.startsWith(`/repos/${binding.repository}/`)) {
      fail('Semantic predecessor inspection is same-repository GitHub GET only, never native access or producer replay.');
    }
    await assertEnforcementReadAuthority(input, readback);
    approvedReference(readback, 'staging-qualified', stagingReference);
    approvedReference(readback, 'production-rehearsed', rehearsalReference);
    return transport.request(operation);
  } });
  const staging = await readVerifiedStagingQualification(current, client, stagingReference);
  if (typeof staging.sourceSha !== 'string' || typeof staging.artifactDigest !== 'string' ||
    staging.sourceSha !== request.sourceSha || staging.artifactDigest !== request.artifactDigest ||
    staging.security.report.source.repository !== binding.repository ||
    staging.security.report.source.repositoryId !== binding.repositoryId ||
    staging.security.job.appId !== binding.actionsApp.id || staging.security.job.appSlug !== binding.actionsApp.slug) {
    fail('The actual staging source/artifact/repository/application identity differs from the approved enforcement target.');
  }
  const rehearsal = await readVerifiedRehearsalQualification(current, client, rehearsalReference);
  if (typeof rehearsal.sourceSha !== 'string' || typeof rehearsal.artifactDigest !== 'string' ||
    rehearsal.sourceSha !== request.sourceSha || rehearsal.artifactDigest !== request.artifactDigest ||
    canonicalSha256(rehearsal.staging.reference) !== canonicalSha256(staging.reference) ||
    rehearsal.staging.nativeWitnessDigest !== staging.nativeWitnessDigest) {
    fail('Rehearsal does not retain the same exact qualified staging witness and immutable source/artifact.');
  }
  await assertEnforcementReadAuthority(input, readback);
  approvedReference(readback, 'staging-qualified', stagingReference);
  approvedReference(readback, 'production-rehearsed', rehearsalReference);
  return {
    staging: { ...staging, sourceSha: staging.sourceSha, artifactDigest: staging.artifactDigest },
    rehearsal: { ...rehearsal, sourceSha: rehearsal.sourceSha, artifactDigest: rehearsal.artifactDigest }
  };
}

export function enforcementProductionPredecessorVerifier(
  input: PhasePlanningInput, readback: RepositoryControlArtifactReadback,
  binding: RepositoryControlBinding
): PredecessorVerifierCallback {
  return async (request): Promise<BoundProductionPredecessors> => {
    const { staging, rehearsal } = await readEnforcementProductionPredecessors(input, readback, binding, request);
    return {
      sourceSha: staging.sourceSha, artifactDigest: staging.artifactDigest,
      staging: { phaseId: 'staging-qualified', ...staging.reference, sourceSha: staging.sourceSha,
        artifactDigest: staging.artifactDigest, verifiedAt: staging.producedAt },
      rehearsal: { phaseId: 'production-rehearsed', ...rehearsal.reference, sourceSha: rehearsal.sourceSha,
        artifactDigest: rehearsal.artifactDigest, verifiedAt: rehearsal.producedAt }
    };
  };
}
