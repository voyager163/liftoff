import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { evidenceBodyDigest } from '../../domain/governance/activation/evidence.js';
import type { PhaseEvidenceRecord } from '../../domain/governance/activation/types.js';
import { GitHubActivationClient, GitHubActivationError } from '../../adapters/github/activation-rest.js';
import type { RepositoryControlBinding } from '../../adapters/github/repository-control-observation.js';
import type { PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { AzureActivationAdmissionError } from '../azure-activation/authority.js';
import { readEnvironmentRuntimeReceipt } from '../azure-activation/environment-runtime-receipt.js';
import { requireQualificationEvidence, type QualificationEvidenceReference } from '../azure-activation/qualification-evidence.js';
import {
  declaredEnforcementArtifactRequests, readFullControlFailedArtifacts, type RepositoryControlArtifactReadback
} from './repository-control-artifact-readback.js';
import { enforcementPredecessorReferences, readEnforcementProductionPredecessors } from './repository-control-predecessors.js';

export async function assertFullControlQualification(
  input: PhasePlanningInput, client: GitHubActivationClient, binding: RepositoryControlBinding,
  record: PhaseEvidenceRecord, sourceSha: string, artifactDigest: string,
  reference: QualificationEvidenceReference, artifactReadback?: RepositoryControlArtifactReadback,
  planning = false
): Promise<void> {
  const phaseId = record.header.phaseId;
  const payload = record.payload;
  const semantic = isRecord(payload) &&
    (phaseId === 'staging-qualified' && isRecord(payload.securityObservation) ||
      phaseId === 'production-rehearsed' && isRecord(payload.applicationRehearsal));
  if ((input.inspection.scope ?? 'activation') !== 'activation' ||
    (phaseId !== 'staging-qualified' && phaseId !== 'production-rehearsed') ||
    record.header.scope !== 'activation' || record.header.result !== 'verified' ||
    reference.evidenceId !== record.evidenceId || reference.headerDigest !== canonicalSha256(record.header) ||
    reference.bodyDigest !== record.header.bodyDigest ||
    record.header.bodyDigest !== evidenceBodyDigest(record.payload, record.liveReadback) ||
    !isRecord(payload) || payload.sourceSha !== sourceSha || payload.artifactDigest !== artifactDigest ||
    !semantic && (!isRecord(payload.runtimeObservation) || payload.runtimeObservation.kind !== 'environment-runtime-observation.v1' ||
      !isRecord(payload.runtimeObservation.workflow))) {
    throw new GitHubActivationError('full-control-qualification',
      'Full enforcement needs the genuine source/artifact/environment-bound workflow operation and exact original receipt reference. Flat nativeQualification assertions and repository proof cannot release main.');
  }
  const readOnly = new GitHubActivationClient({
    async request(request) {
      if (request.method !== 'GET') {
        throw new GitHubActivationError('full-control-read-scope', 'Full control evidence inspection cannot dispatch or mutate providers.');
      }
      return client.transport.request(request);
    }
  });
  try {
    const { plan } = requireQualificationEvidence(input.inspection, phaseId, reference, input.now);
    if (semantic) {
      // Preview only freezes original references. Execution independently opens
      // native witnesses and provider bytes under the new read operation.
      if (planning) return;
      if (!artifactReadback) {
        throw new GitHubActivationError('control-predecessor-authority',
          'Concrete semantic predecessor inspection requires its actual currently approved full enforcement read operation.');
      }
      const references = enforcementPredecessorReferences(artifactReadback);
      if (canonicalSha256(phaseId === 'staging-qualified' ? references.staging : references.rehearsal) !== canonicalSha256(reference)) {
        throw new GitHubActivationError('control-predecessor-authority', 'The semantic receipt is not the exact original reference approved for this current read.');
      }
      await readFullControlFailedArtifacts(input, artifactReadback, declaredEnforcementArtifactRequests(artifactReadback.operation));
      await readEnforcementProductionPredecessors(input, artifactReadback, binding, {
        ...references, sourceSha, artifactDigest
      });
      return;
    }
    const runtimeObservation = payload.runtimeObservation;
    if (!isRecord(runtimeObservation) || !isRecord(runtimeObservation.workflow)) {
      throw new GitHubActivationError('full-control-qualification', 'The original runtime observation is missing.');
    }
    const actionId = phaseId === 'staging-qualified' ? 'github.checks.staging' : 'github.checks.production-rehearsal';
    const dispatches = plan.operations.filter((operation) => operation.actionId === actionId);
    const originalWorkflow = dispatches[0]?.inputs.workflow;
    if (dispatches.length !== 1 || !isRecord(originalWorkflow) ||
      originalWorkflow.repository !== binding.repository || originalWorkflow.repositoryId !== binding.repositoryId ||
      typeof originalWorkflow.producerSourceSha !== 'string' || !/^[a-f0-9]{40}$/u.test(originalWorkflow.producerSourceSha) ||
      typeof originalWorkflow.sourceSha !== 'string' || !/^[a-f0-9]{40}$/u.test(originalWorkflow.sourceSha) ||
      runtimeObservation.executionSourceSha !== originalWorkflow.sourceSha ||
      canonicalSha256(runtimeObservation.workflow) !== canonicalSha256(originalWorkflow)) {
      throw new GitHubActivationError('full-control-qualification',
        'Runtime verifier identities must match the exact original approved workflow operation, independently of any application-source claim.');
    }
    if (artifactReadback) {
      await readFullControlFailedArtifacts(input, artifactReadback, declaredEnforcementArtifactRequests(artifactReadback.operation));
    }
    await readEnvironmentRuntimeReceipt(input, readOnly, {
      phaseId, reference,
      verifierSource: {
        producerSourceSha: originalWorkflow.producerSourceSha, executionSourceSha: originalWorkflow.sourceSha
      },
      artifactDigest
    });
  } catch (error) {
    if (error instanceof AzureActivationAdmissionError) {
      throw new GitHubActivationError('full-control-qualification', error.message);
    }
    throw error;
  }
  throw new GitHubActivationError('full-native-verifier-unavailable',
    'The original runtime artifact bytes and private readback witness are not complete staging DAST, application build/deployment source or rollout/rollback proof. Those full verifiers remain unavailable; runtime-only observations cannot release the main hold.');
}
