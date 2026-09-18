import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph } from '../../domain/governance/activation/graph.js';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { GitHubActivationClient } from '../../adapters/github/activation-rest.js';
import type { PhasePlanningInput, PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import { githubPorts } from '../../governance-activation/github-ports.js';
import { applicationStagingInputs, applicationStagingProtocol } from './application-staging-inputs.js';
import { readStagingSecurityArtifact, stagingSecurityWorkflowBinding, type StagingSecurityArtifactDescriptor } from './staging-security-artifact.js';
import { stagingSecurityWorkflowDispatchInputs } from './staging-security-workflow.js';
import { readQualificationCheckpoints, qualificationOperationFromCheckpoint } from './qualification-checkpoints.js';
import { requireQualificationEvidence, type QualificationEvidenceReference } from './qualification-evidence.js';
import { qualificationFailure, qualificationObject, qualificationTimestamp, requireEnvironmentActivationScope } from './qualification-authority.js';
import { verifyApplicationRehearsalOriginalApproval } from './application-rehearsal-receipt.js';
import { sourceSha } from '../../governance-activation/github-config.js';
import { applicationImageDigest } from '../../adapters/azure/application-provisioning.js';

/** A current enforcing reader re-reads GitHub only; immutable private native observations retain their original actor/clock. */
export async function readVerifiedStagingQualification(
  input: PhasePlanningInput, client: GitHubActivationClient, reference: QualificationEvidenceReference
) {
  requireEnvironmentActivationScope(input);
  const { record, plan } = requireQualificationEvidence(input.inspection, 'staging-qualified', reference, input.now);
  const payload = record.payload;
  if (!isRecord(payload) || payload.kind !== 'staging-qualified.v1' || payload.recipe !== applicationStagingProtocol ||
    !isRecord(payload.securityObservation)) qualificationFailure('staging-original-producer', 'Only the concrete native staging/security producer can qualify staging.');
  const applicationSourceSha = sourceSha(payload.sourceSha);
  const artifactDigest = applicationImageDigest(payload.artifactDigest);
  const descriptor = qualificationObject(payload.nativeWitness, ['recordKey', 'witnessDigest'], 'Original native staging witness');
  if (typeof descriptor.recordKey !== 'string' || typeof descriptor.witnessDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(descriptor.recordKey) || !/^[a-f0-9]{64}$/u.test(descriptor.witnessDigest)) {
    qualificationFailure('staging-private-witness', 'The original exact private staging witness is required.');
  }
  const stored = await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', githubPorts(input).storage)
    .read(descriptor.recordKey);
  const witness = stored?.value;
  if (!stored || !isRecord(witness) || witness.schemaVersion !== 1 || witness.kind !== 'staging-security-native-witness.v1' ||
    witness.projectRoot !== stored.projectRoot || witness.repositoryId !== input.inspection.state.repository.id ||
    canonicalSha256(witness.identity) !== canonicalSha256(input.inspection.state.identity) ||
    witness.planDigest !== plan.planDigest || witness.savedPlanDigest !== canonicalSha256(plan) ||
    canonicalSha256(witness) !== descriptor.witnessDigest ||
    canonicalSha256({ kind: witness.kind, witnessDigest: descriptor.witnessDigest }) !== descriptor.recordKey ||
    canonicalSha256(witness.observation) !== canonicalSha256(payload.securityObservation)) {
    qualificationFailure('staging-private-witness', 'Public staging assertions do not match the original immutable private native/runner/security witness.');
  }
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'staging-qualified')!;
  const original: PhaseAdapterExecutionInput = {
    ...input, phase, plan, adapters: input.adapters ?? {},
    inspection: { ...input.inspection, activationInputs: plan.configuration }
  };
  const config = applicationStagingInputs(original), recipe = config.qualification.security!;
  const dispatches = plan.operations.filter((entry) => entry.actionId === 'github.checks.staging');
  const dispatch = dispatches[0];
  if (dispatches.length !== 1 || !dispatch || config.qualification.stage !== 'verify' ||
    typeof dispatch.inputs.producerSourceSha !== 'string' || payload.sourceSha !== recipe.sourceSha ||
    payload.artifactDigest !== recipe.image.digest) {
    qualificationFailure('staging-original-plan', 'Staging proof must retain its exact original dispatch and immutable source/artifact.');
  }
  const checkpoint = await readQualificationCheckpoints(original, dispatch, stagingSecurityWorkflowBinding(recipe),
    stagingSecurityWorkflowDispatchInputs(recipe));
  if (!checkpoint?.observed) qualificationFailure('staging-original-checkpoint', 'The original privately issued dispatch and actual provider run ID are absent.');
  await verifyApplicationRehearsalOriginalApproval(input, plan, checkpoint.prepared.preparedAt);
  const observation = payload.securityObservation;
  if (!isRecord(observation.security) || !isRecord(observation.authority) ||
    !isRecord(observation.authority.executionWindow) || !isRecord(observation.resource) ||
    observation.checkpointDigest !== canonicalSha256(checkpoint.prepared)) {
    qualificationFailure('staging-original-observation', 'The original staging witness lacks its actual operation, resource or execution interval.');
  }
  const operation = qualificationOperationFromCheckpoint(checkpoint, dispatch, stagingSecurityWorkflowBinding(recipe),
    record.header.producedAt);
  if (!operation) qualificationFailure('staging-original-operation', 'The original actual workflow operation is required.');
  const archive = qualificationObject(observation.security.descriptor,
    ['artifactId', 'name', 'archiveDigest', 'reportDigest'], 'Original security archive descriptor');
  if (typeof archive.artifactId !== 'number' || typeof archive.name !== 'string' ||
    typeof archive.archiveDigest !== 'string' || typeof archive.reportDigest !== 'string') {
    qualificationFailure('staging-original-artifact', 'The original provider and raw report byte commitments are required.');
  }
  const exact: StagingSecurityArtifactDescriptor = {
    artifactId: archive.artifactId, name: archive.name, archiveDigest: archive.archiveDigest, reportDigest: archive.reportDigest
  };
  const actual = await readStagingSecurityArtifact({
    client, recipe, producerSourceSha: dispatch.inputs.producerSourceSha, operation,
    correlationId: checkpoint.prepared.correlationId,
    configurationDigest: stagingSecurityWorkflowDispatchInputs(recipe).qualification_digest!, artifact: exact, now: input.now
  });
  const start = qualificationTimestamp(observation.authority.executionWindow.notBefore, 'Original effective staging start');
  const end = qualificationTimestamp(observation.authority.executionWindow.expiresAt, 'Original effective staging expiry');
  if (canonicalSha256(actual.descriptor) !== canonicalSha256(exact) ||
    canonicalSha256(actual.report) !== canonicalSha256(observation.security.report) ||
    canonicalSha256(actual.source) !== canonicalSha256(observation.security.source) ||
    canonicalSha256(actual.job) !== canonicalSha256(observation.security.job) ||
    Date.parse(actual.job.startedAt) < Date.parse(start) || Date.parse(actual.job.completedAt) >= Date.parse(end) ||
    Date.parse(actual.job.completedAt) > Date.parse(record.header.producedAt) ||
    observation.resource.imageRef !== `${recipe.image.loginServer}/${recipe.image.repository}@${recipe.image.digest}`) {
    qualificationFailure('staging-original-readback', 'Independent provider bytes/job/source or immutable native resource observations differ from the original qualification.');
  }
  return { kind: 'verified-staging-qualification.v1' as const, reference, sourceSha: applicationSourceSha,
    artifactDigest, security: actual, nativeWitnessDigest: descriptor.witnessDigest,
    resource: observation.resource, producedAt: record.header.producedAt };
}
