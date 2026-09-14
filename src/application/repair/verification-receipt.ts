import {
  createScopedUserLocalRecordStore, type UpdatePreviewOptions
} from '../../adapters/filesystem/update-previews.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { repairSchemaVersions } from '../../domain/repair/identity.js';
import type { RepairPreview } from './preview.js';

export interface RepairVerificationReceipt {
  schemaVersion: 1;
  kind: 'liftoff-application-repair-verification';
  fingerprint: string;
  inputDigest: string;
  effectsDigest: string;
  verificationDigest: string;
  identityDigest: string;
  verifiedAt: string;
  expiresAt: string;
  networkAuthorized: boolean;
  dependencyPreparationAuthorized: boolean;
  result: 'declared-checks-passed';
}

function binding(preview: RepairPreview) {
  return {
    schemaVersion: repairSchemaVersions.applicationVerification,
    kind: 'liftoff-application-repair-verification' as const,
    fingerprint: preview.fingerprint, inputDigest: preview.inputDigest,
    effectsDigest: preview.effectsDigest, verificationDigest: preview.verificationDigest,
    identityDigest: canonicalSha256({
      cliVersion: preview.cliVersion, repairContractVersion: preview.repairContractVersion, recipe: preview.recipe
    })
  };
}

export async function readRepairVerification(
  preview: RepairPreview, now: Date, storage?: UpdatePreviewOptions
): Promise<RepairVerificationReceipt | null> {
  const stored = await createScopedUserLocalRecordStore(preview.projectRoot, 'repair-verification', storage).read(preview.fingerprint);
  if (!stored) return null;
  const value = stored.value;
  if (!isRecord(value)) throw new Error('Invalid repair verification receipt; request a fresh preview and separately authorize its checks.');
  const { verifiedAt, expiresAt, networkAuthorized, dependencyPreparationAuthorized, result, ...actualBinding } = value;
  if (canonicalSha256(actualBinding) !== canonicalSha256(binding(preview)) ||
      typeof verifiedAt !== 'string' || expiresAt !== preview.expiresAt ||
      typeof networkAuthorized !== 'boolean' || typeof dependencyPreparationAuthorized !== 'boolean' ||
      result !== 'declared-checks-passed' ||
      !Number.isFinite(Date.parse(verifiedAt)) || Date.parse(verifiedAt) < Date.parse(preview.createdAt) ||
      Date.parse(verifiedAt) > now.getTime() || Date.parse(preview.expiresAt) <= now.getTime()) {
    throw new Error('Repair verification is invalid, stale or bound to different inputs, staged bytes or checks. Request a new preview and verification; old success is not authority.');
  }
  return { ...binding(preview), verifiedAt, expiresAt: preview.expiresAt, networkAuthorized, dependencyPreparationAuthorized, result };
}

export async function saveRepairVerification(
  preview: RepairPreview, now: Date, networkAuthorized: boolean, storage?: UpdatePreviewOptions,
  dependencyPreparationAuthorized = false
): Promise<RepairVerificationReceipt> {
  if (preview.recipe.id !== 'application-layout-patch' ||
      now.getTime() < Date.parse(preview.createdAt) || now.getTime() >= Date.parse(preview.expiresAt)) {
    throw new Error('The application plan expired during verification; request a new preview before file approval.');
  }
  const receipt: RepairVerificationReceipt = {
    ...binding(preview), verifiedAt: now.toISOString(), expiresAt: preview.expiresAt,
    networkAuthorized, dependencyPreparationAuthorized, result: 'declared-checks-passed'
  };
  await createScopedUserLocalRecordStore(preview.projectRoot, 'repair-verification', storage).write(preview.fingerprint, receipt);
  return receipt;
}
