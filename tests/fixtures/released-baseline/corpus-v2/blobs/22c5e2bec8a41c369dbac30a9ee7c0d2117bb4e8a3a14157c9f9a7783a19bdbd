import { realpath } from 'node:fs/promises';
import { createScopedUserLocalRecordStore, type UpdatePreviewOptions } from '../adapters/filesystem/update-previews.js';
import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { canonicalApprovalEnvelopeHash } from '../domain/governance/activation/approvals.js';
import type { ApprovalEnvelope } from '../domain/governance/activation/types.js';

export async function assertGovernanceApprovalIssued(
  projectRoot: string,
  envelope: ApprovalEnvelope,
  storage?: UpdatePreviewOptions
): Promise<void> {
  const hash = canonicalApprovalEnvelopeHash(envelope);
  const record = await createScopedUserLocalRecordStore(projectRoot, 'governance-approval', storage).read(hash);
  if (!record || !isRecord(record.value) || record.value.kind !== 'liftoff-governance-approval' ||
    record.value.schemaVersion !== 1 || record.value.projectRoot !== record.projectRoot ||
    record.value.envelopeHash !== hash || !Object.hasOwn(record.value, 'envelope') ||
    canonicalSha256(record.value.envelope) !== canonicalSha256(envelope)) {
    throw new Error(`Approval ${envelope.id} has no project-bound authority issued by governance approve; imported files are not permission.`);
  }
}

export async function writeGovernanceApprovalAuthority(
  projectRoot: string,
  fingerprint: string,
  envelope: ApprovalEnvelope,
  storage?: UpdatePreviewOptions
): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error('Approval authority requires the exact governance preview fingerprint.');
  const envelopeHash = canonicalApprovalEnvelopeHash(envelope);
  await createScopedUserLocalRecordStore(projectRoot, 'governance-approval', storage).write(envelopeHash, {
    schemaVersion: 1, kind: 'liftoff-governance-approval', projectRoot: await realpath(projectRoot),
    fingerprint, envelopeHash, envelope
  });
}
