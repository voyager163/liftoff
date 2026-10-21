import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import {
  assertDigestApplicationPublicationOperation, readDigestApplicationPublicationReceipt
} from '../domain/governance/activation/application-publication-values.js';
import {
  createApplicationPublicationRecordContract, type ModernRelatedRecords
} from '../domain/governance/activation/modern-records.js';
import type { ModernActivationSourceInput } from '../domain/governance/activation/modern-record-contracts.js';
import { outputBindingsMatch, outputResourcesMatch } from '../domain/governance/activation/source-values.js';
import type { ManifestContractContext } from '../domain/project/manifest/context.js';

/** Read-only v2 consumption. It cannot dispatch, publish, deploy or qualify the committed producer digests. */
export function readVerifiedDigestApplicationArtifact(
  catalog: ManifestContractContext['catalog'], context: ModernActivationSourceInput,
  stateValue: unknown, related: ModernRelatedRecords
) {
  const records = createApplicationPublicationRecordContract(catalog, context);
  const state = records.readState(stateValue, related), phase = state.phases['application-artifact-ready'];
  const output = state.phaseOutputs?.['application-artifact-ready'];
  if (phase.state !== 'verified' || !output) {
    throw new Error('Publication source6 consumption requires the original verified artifact state and bound outputs.');
  }
  const evidence = (related.evidence ?? []).map(value => records.readEvidence(value, related)).find(record =>
    outputBindingsMatch(record, 'application-artifact-ready', phase.evidence, output));
  if (!evidence || !outputResourcesMatch(output, evidence) || !isRecord(evidence.payload) ||
    evidence.payload.kind !== 'application-artifact-ready.v2' || evidence.payload.deploymentPerformed !== false) {
    throw new Error('Publication source6 consumption requires its exact v2 original artifact evidence and matching resource readback.');
  }
  const receipt = readDigestApplicationPublicationReceipt(evidence.payload.publication);
  assertDigestApplicationPublicationOperation(receipt, phase.operation);
  const expected = {
    sourceSha: receipt.sourceSha, sourceTreeSha: receipt.sourceTreeSha, workflowDigest: receipt.workflowDigest,
    environment: receipt.environment, registryResourceId: receipt.registryResourceId,
    imageRepository: receipt.imageRepository, artifactDigest: receipt.artifactDigest, immutableImage: receipt.immutableImage,
    publicationReceiptDigest: canonicalSha256(receipt)
  };
  const run = `/repos/${receipt.repository}/actions/runs/${receipt.workflowRunId}`;
  const image = `${receipt.registryResourceId}/repositories/${receipt.imageRepository}@${receipt.artifactDigest}`;
  if (Object.entries(expected).some(([key, value]) => output.values[key] !== value) ||
    !output.resources.some(resource => resource.provider === 'github' &&
      resource.resourceType === 'workflow-run' && resource.resourceId === run) ||
    !output.resources.some(resource => resource.provider === 'azure' &&
      resource.resourceType === 'container-image' && resource.resourceId === image)) {
    throw new Error('Publication source6 outputs contradict the original receipt, workflow run or digest-only image.');
  }
  return receipt;
}
