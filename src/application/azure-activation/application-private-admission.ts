import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { evidenceBodyDigest, evidenceHeaderDigest, latestRecordWithPayload } from '../../domain/governance/activation/evidence.js';
import { parseApplicationImageReference } from '../../adapters/azure/application-provisioning.js';
import type { PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import {
  applicationPrivateAssert as must, type ApplicationPrivateArtifact
} from './application-private-contracts.js';

export function applicationPrivateObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  must(isRecord(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(','), 'input-fields');
  return value;
}

export function applicationPrivateDigest(value: unknown): string {
  must(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'digest-binding');
  return value;
}

export function applicationPrivateReference(value: unknown, workspaceId: string): string {
  must(typeof value === 'string' && value.startsWith(`state-workspace:${workspaceId}/`) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.slice(53)),
  'private-reference');
  return value;
}

export function assertApplicationPrivateArtifact(input: Pick<PhasePlanningInput, 'inspection'>, expected: ApplicationPrivateArtifact | null): void {
  if (!expected) return;
  const record = latestRecordWithPayload(input.inspection, 'application-artifact-ready');
  const phase = input.inspection.state.phases['application-artifact-ready'];
  const outputs = input.inspection.state.phaseOutputs?.['application-artifact-ready'];
  must(record && record.header.result === 'verified' && phase.state === 'verified' &&
    record.evidenceId === expected.evidenceId && evidenceHeaderDigest(record.header) === expected.headerDigest &&
    phase.evidence.some((ref) => ref.evidenceId === record.evidenceId && ref.headerDigest === expected.headerDigest) &&
    record.header.bodyDigest === evidenceBodyDigest(record.payload, record.liveReadback) && isRecord(record.payload) &&
    record.payload.kind === 'application-artifact-ready.v1' && outputs &&
    canonicalSha256(record.payload.outputBindings) === canonicalSha256(outputs), 'current-artifact-evidence');
  const image = parseApplicationImageReference(expected.imageRef);
  const original = parseApplicationImageReference(record.payload.imageRef);
  const sourceRegistry = expected.sourceRegistryResourceId ?? expected.registryResourceId;
  must((expected.sourceRegistryResourceId !== undefined || record.payload.imageRef === expected.imageRef) &&
    original.digest === image.digest && record.payload.sourceCommitSha === expected.sourceSha &&
    record.payload.digest === image.digest && outputs.values['azure.artifact.imageRef'] === record.payload.imageRef &&
    outputs.values['azure.artifact.digest'] === image.digest && outputs.values['azure.artifact.sourceSha'] === expected.sourceSha &&
    outputs.resources.some((resource) => resource.provider === 'azure' && resource.resourceId === sourceRegistry) &&
    record.liveReadback?.some((proof) => proof.provider === 'azure' && proof.matches && proof.resourceId === sourceRegistry),
  'artifact-binding');
}
