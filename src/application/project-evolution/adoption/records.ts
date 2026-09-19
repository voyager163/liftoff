import type { AdoptionPlan, AdoptionRecord } from '../../../domain/project-evolution/adoption/contracts.js';
import { adoptionExecutionIdentity, validateAdoptionExecutionIdentity } from '../../../domain/project-evolution/adoption/identity.js';
import { canonicalSha256, isRecord } from '../../../domain/governance/activation/canonical-json.js';
import type { ReviewedUpdateApprovalStore } from '../../../adapters/filesystem/reviewed-update-transaction.js';
import { createScopedUserLocalRecordStore, type UpdatePreviewOptions } from '../../../adapters/filesystem/update-previews.js';
import { liftoffVersion } from '../../../version.js';
import type { ApplicationVerificationResult } from '../../repair/application-types.js';
import { ApplicationInspectionError } from '../../repair/application-files.js';
import { adoptionPreviewTtlMs } from './planning.js';
import { lstat } from 'node:fs/promises';

export interface AdoptionPreview {
  schemaVersion: 1;
  kind: 'liftoff-adoption-preview';
  identity: ReturnType<typeof adoptionExecutionIdentity>;
  projectRoot: string;
  profile: string;
  component: string[];
  proposal: string | null;
  createdAt: string;
  expiresAt: string;
  fingerprint: string;
  planDigest: string;
  recordId: string;
}

export function adoptionPreview(plan: AdoptionPlan): AdoptionPreview {
  return {
    schemaVersion: 1, kind: 'liftoff-adoption-preview',
    identity: adoptionExecutionIdentity(plan.cliVersion), projectRoot: plan.projectRoot,
    profile: plan.component.profile.id, component: [...plan.component.rootPathParts], proposal: plan.proposal?.path ?? null,
    createdAt: plan.createdAt, expiresAt: plan.expiresAt, fingerprint: plan.fingerprint,
    planDigest: canonicalSha256(plan), recordId: plan.recordId
  };
}

export async function loadAdoptionPreview(
  projectRoot: string, fingerprint: string, now: Date, storage?: UpdatePreviewOptions
): Promise<AdoptionPreview> {
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new ApplicationInspectionError('Adoption permission requires a complete lowercase 64-character plan fingerprint.');
  const stored = await createScopedUserLocalRecordStore(projectRoot, 'adoption-preview', storage).read(fingerprint);
  const value = stored?.value;
  const keys = ['schemaVersion', 'kind', 'identity', 'projectRoot', 'profile', 'component', 'proposal', 'createdAt', 'expiresAt', 'fingerprint', 'planDigest', 'recordId'];
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
    value.schemaVersion !== 1 || value.kind !== 'liftoff-adoption-preview' || value.projectRoot !== projectRoot ||
    value.fingerprint !== fingerprint || typeof value.planDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.planDigest) ||
    typeof value.recordId !== 'string' || !/^[a-f0-9]{64}$/u.test(value.recordId) ||
    typeof value.profile !== 'string' || !Array.isArray(value.component) || value.component.some((part) => typeof part !== 'string') ||
    !(value.proposal === null || typeof value.proposal === 'string') ||
    typeof value.createdAt !== 'string' || typeof value.expiresAt !== 'string') {
    throw new ApplicationInspectionError('No valid matching external adoption preview exists. Request a fresh same-project check; project-local claims are not approval.');
  }
  const identity = validateAdoptionExecutionIdentity(value.identity);
  const created = Date.parse(value.createdAt), expires = Date.parse(value.expiresAt);
  if (identity.cliVersion !== liftoffVersion || !Number.isFinite(created) || !Number.isFinite(expires) ||
    created > now.getTime() || expires <= now.getTime() || expires - created !== adoptionPreviewTtlMs) {
    throw new ApplicationInspectionError('Adoption preview expired or has an incompatible writer/time identity. Request a fresh check.');
  }
  return {
    schemaVersion: 1, kind: 'liftoff-adoption-preview', identity, projectRoot,
    profile: value.profile, component: value.component, proposal: value.proposal,
    createdAt: value.createdAt, expiresAt: value.expiresAt, fingerprint, planDigest: value.planDigest, recordId: value.recordId
  };
}

export function assertAdoptionPreviewMatches(plan: AdoptionPlan, preview: AdoptionPreview): void {
  if (plan.fingerprint !== preview.fingerprint || canonicalSha256(plan) !== preview.planDigest) {
    throw new ApplicationInspectionError('Adoption bytes, modes, directory inventory, profile, target, proposal or tools changed after review. No transaction is authorized; request a fresh check.');
  }
}

export function adoptionApprovalStore(projectRoot: string, storage?: UpdatePreviewOptions): ReviewedUpdateApprovalStore {
  const store = createScopedUserLocalRecordStore(projectRoot, 'adoption-approval', storage);
  const key = (fingerprint: string, digest: string, revoked = false) =>
    canonicalSha256({ kind: 'liftoff-adoption-transaction-authority', projectRoot, fingerprint, digest, revoked });
  const body = (fingerprint: string, digest: string) => ({
    schemaVersion: 1, kind: 'liftoff-adoption-transaction-authority', projectRoot, fingerprint, digest
  });
  return {
    write: async (fingerprint, digest) => { await store.write(key(fingerprint, digest), body(fingerprint, digest)); },
    verify: async (fingerprint, digest) => {
      const [record, revoked] = await Promise.all([store.read(key(fingerprint, digest)), store.read(key(fingerprint, digest, true))]);
      return !revoked && record !== null && canonicalSha256(record.value) === canonicalSha256(body(fingerprint, digest));
    },
    remove: async (fingerprint, digest) => { await store.write(key(fingerprint, digest, true), { ...body(fingerprint, digest), revoked: true }); }
  };
}

export interface AdoptionVerificationReceipt {
  schemaVersion: 1;
  kind: 'liftoff-adoption-verification';
  fingerprint: string;
  planDigest: string;
  targetDigest: string;
  candidateDigest: string;
  verificationDigest: string;
  toolchainDigest: string;
  resultDigest: string;
  verifiedAt: string;
  expiresAt: string;
  commandsPassed: number;
  preparationPassed: number;
  projectCodeAuthorized: true;
  preparationAuthorized: boolean;
  networkAuthorized: boolean;
  settled: true;
}

export async function saveAdoptionVerification(
  plan: AdoptionPlan, verification: ApplicationVerificationResult, now: Date, storage?: UpdatePreviewOptions
): Promise<AdoptionVerificationReceipt> {
  if (verification.status !== 'passed' || !verification.inspectedProjectUnchanged || !verification.cleanupComplete ||
    verification.verificationPolicyDigest !== plan.verificationDigest || verification.toolchainDigest !== plan.toolchainDigest) {
    throw new ApplicationInspectionError('Failed, changed or unsettled adoption verification cannot issue a successful receipt.');
  }
  if (now.getTime() < Date.parse(plan.createdAt) || now.getTime() >= Date.parse(plan.expiresAt) ||
    verification.commands.length === 0 || verification.commands.some((command) => !command.passed) ||
    verification.preparation.some((preparation) => preparation.status !== 'passed')) {
    throw new ApplicationInspectionError('Expired, empty or failed adoption checks cannot be recorded as verification.');
  }
  const value: AdoptionVerificationReceipt = {
    schemaVersion: 1, kind: 'liftoff-adoption-verification', fingerprint: plan.fingerprint,
    planDigest: canonicalSha256(plan), targetDigest: plan.targetDigest, candidateDigest: verification.candidateDigest,
    verificationDigest: plan.verificationDigest, toolchainDigest: plan.toolchainDigest,
    resultDigest: canonicalSha256(verification), verifiedAt: now.toISOString(), expiresAt: plan.expiresAt,
    commandsPassed: verification.commands.length, preparationPassed: verification.preparation.length,
    projectCodeAuthorized: true, preparationAuthorized: plan.permissions.dependencyPreparation,
    networkAuthorized: plan.permissions.network, settled: true
  };
  await createScopedUserLocalRecordStore(plan.projectRoot, 'adoption-verification', storage).write(plan.fingerprint, value);
  return value;
}

export async function readAdoptionVerification(
  plan: AdoptionPlan, now: Date, storage?: UpdatePreviewOptions
): Promise<AdoptionVerificationReceipt | null> {
  const saved = await createScopedUserLocalRecordStore(plan.projectRoot, 'adoption-verification', storage).read(plan.fingerprint);
  if (!saved) return null;
  const record = saved.value;
  const keys = [
    'schemaVersion', 'kind', 'fingerprint', 'planDigest', 'targetDigest', 'candidateDigest',
    'verificationDigest', 'toolchainDigest', 'resultDigest', 'verifiedAt', 'expiresAt', 'commandsPassed',
    'preparationPassed', 'projectCodeAuthorized', 'preparationAuthorized', 'networkAuthorized', 'settled'
  ];
  if (!isRecord(record) || Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)) ||
    record.schemaVersion !== 1 || record.kind !== 'liftoff-adoption-verification' ||
    record.fingerprint !== plan.fingerprint || record.planDigest !== canonicalSha256(plan) ||
    record.targetDigest !== plan.targetDigest || record.verificationDigest !== plan.verificationDigest || record.toolchainDigest !== plan.toolchainDigest ||
    typeof record.candidateDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(record.candidateDigest) ||
    typeof record.resultDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(record.resultDigest) ||
    typeof record.verifiedAt !== 'string' || !Number.isFinite(Date.parse(record.verifiedAt)) ||
    Date.parse(record.verifiedAt) < Date.parse(plan.createdAt) || Date.parse(record.verifiedAt) > now.getTime() ||
    record.expiresAt !== plan.expiresAt || Date.parse(plan.expiresAt) <= now.getTime() ||
    typeof record.commandsPassed !== 'number' || !Number.isInteger(record.commandsPassed) || record.commandsPassed < 1 || record.commandsPassed > 8 ||
    typeof record.preparationPassed !== 'number' || !Number.isInteger(record.preparationPassed) || record.preparationPassed < 0 || record.preparationPassed > 4 ||
    record.projectCodeAuthorized !== true || record.preparationAuthorized !== plan.permissions.dependencyPreparation ||
    record.networkAuthorized !== plan.permissions.network || record.settled !== true) {
    throw new ApplicationInspectionError('External adoption verification metadata is invalid or belongs to another immutable plan.');
  }
  return {
    schemaVersion: 1, kind: 'liftoff-adoption-verification', fingerprint: plan.fingerprint,
    planDigest: record.planDigest, targetDigest: record.targetDigest, candidateDigest: record.candidateDigest,
    verificationDigest: record.verificationDigest, toolchainDigest: record.toolchainDigest, resultDigest: record.resultDigest,
    verifiedAt: record.verifiedAt, expiresAt: plan.expiresAt, commandsPassed: record.commandsPassed,
    preparationPassed: record.preparationPassed, projectCodeAuthorized: true,
    preparationAuthorized: record.preparationAuthorized, networkAuthorized: record.networkAuthorized, settled: true
  };
}

export async function saveCommittedAdoption(record: AdoptionRecord, storage?: UpdatePreviewOptions): Promise<void> {
  await createScopedUserLocalRecordStore(record.projectRoot, 'adoption-checkpoint', storage).write(
    canonicalSha256({ kind: 'adoption-committed', recordId: record.recordId }),
    { schemaVersion: 1, kind: 'liftoff-adoption-committed', recordId: record.recordId, fingerprint: record.fingerprint,
      recordDigest: canonicalSha256(record), manifestHash: record.manifestHash }
  );
}

export async function saveAdoptionPreEffect(
  plan: AdoptionPlan, rootMode: number, storage?: UpdatePreviewOptions
): Promise<void> {
  await createScopedUserLocalRecordStore(plan.projectRoot, 'adoption-checkpoint', storage).write(
    canonicalSha256({ kind: 'adoption-pre-effect', fingerprint: plan.fingerprint }),
    {
      schemaVersion: 1, kind: 'liftoff-adoption-pre-effect', identity: adoptionExecutionIdentity(plan.cliVersion),
      projectRoot: plan.projectRoot, projectIdentity: plan.projectIdentity, rootMode,
      fingerprint: plan.fingerprint, planDigest: canonicalSha256(plan), recordId: plan.recordId
    }
  );
}

export async function assertAdoptionRecoveryTarget(
  projectRoot: string, fingerprint: string, storage?: UpdatePreviewOptions
): Promise<void> {
  const stored = await createScopedUserLocalRecordStore(projectRoot, 'adoption-checkpoint', storage).read(
    canonicalSha256({ kind: 'adoption-pre-effect', fingerprint })
  );
  const value = stored?.value;
  const fields = ['schemaVersion', 'kind', 'identity', 'projectRoot', 'projectIdentity', 'rootMode', 'fingerprint', 'planDigest', 'recordId'];
  if (!isRecord(value) || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field)) ||
    value.schemaVersion !== 1 || value.kind !== 'liftoff-adoption-pre-effect' || value.projectRoot !== projectRoot ||
    value.fingerprint !== fingerprint || !isRecord(value.projectIdentity) || Object.keys(value.projectIdentity).length !== 3 ||
    typeof value.rootMode !== 'number' || !Number.isInteger(value.rootMode) || value.rootMode < 0 || value.rootMode > 0o777 ||
    typeof value.planDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.planDigest) ||
    typeof value.recordId !== 'string' || !/^[a-f0-9]{64}$/u.test(value.recordId)) {
    throw new ApplicationInspectionError('Adoption recovery has no matching external pre-effect target checkpoint. Preserve the original journal; project-local claims cannot authorize recovery.');
  }
  validateAdoptionExecutionIdentity(value.identity);
  const current = await lstat(projectRoot);
  if (!current.isDirectory() || current.isSymbolicLink() || value.projectIdentity.device !== String(current.dev) ||
    value.projectIdentity.inode !== String(current.ino) || value.projectIdentity.birthtime !== String(current.birthtimeMs) ||
    value.rootMode !== (current.mode & 0o777)) {
    throw new ApplicationInspectionError('Adoption recovery target creation identity or mode changed; the replacement project was preserved.');
  }
}
