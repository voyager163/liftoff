import {
  createScopedUserLocalRecordStore
} from '../../adapters/filesystem/update-previews.js';
import {
  canonicalSha256, isRecord
} from '../../domain/governance/activation/canonical-json.js';
import type {
  ApplicationInspectionOptions
} from '../repair/application-preparation-types.js';
import {
  openCompletedAdoptionVerificationResult,
  sealCompletedAdoptionVerificationResult,
  type RepairWorkspaceStorageOptions
} from '../repair/workspaces.js';
import {
  readAdoptionVerificationConsent,
  type AdoptionVerificationConsent
} from './verification-consent.js';
import {
  loadAdoptionVerificationPlan,
  type AdoptionVerificationPlan
} from './verification-plan.js';

export const adoptionVerificationResultSchemaVersion = 1 as const;

export interface AdoptionVerificationCommandResult {
  readonly index: number;
  readonly status: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
  readonly passed: boolean;
}

export interface AdoptionVerificationPreparationResult {
  readonly schemaVersion: 1;
  readonly provider: string;
  readonly version: 1;
  readonly cwdPathParts: readonly string[];
  readonly policyDigest: string;
  readonly status: 'passed' | 'failed';
  readonly commands: readonly AdoptionVerificationCommandResult[];
}

export interface AdoptionVerificationExecutionResult {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-adoption-verification-result';
  readonly projectRoot: string;
  readonly reviewFingerprint: string;
  readonly destinationPlanFingerprint: string;
  readonly compatibilityPlanFingerprint: string;
  readonly verificationPlanFingerprint: string;
  readonly consentFingerprint: string;
  readonly snapshotDigest: string;
  readonly verificationPolicyDigest: string;
  readonly providerDigest: string;
  readonly toolchainDigest: string;
  readonly workspaceId: string;
  readonly status: 'passed' | 'failed' | 'uncertain';
  readonly startedAt: string;
  readonly completedAt: string;
  readonly commands: readonly AdoptionVerificationCommandResult[];
  readonly preparation: readonly AdoptionVerificationPreparationResult[];
  readonly blockers: readonly string[];
  readonly inputsUnchanged: boolean;
  readonly cleanupComplete: boolean;
  readonly retainedWorkspace?: string;
  readonly compatibility: 'verified-by-declared-checks' | 'not-verified';
  readonly approval: 'not-requested';
  readonly transaction: 'not-authorized';
  readonly publication: 'not-authorized';
  readonly limitations: readonly string[];
  readonly receiptFingerprint: string | null;
}

export type AdoptionVerificationReceipt = AdoptionVerificationExecutionResult & {
  readonly status: 'passed';
  readonly inputsUnchanged: true;
  readonly cleanupComplete: true;
  readonly compatibility: 'verified-by-declared-checks';
  readonly receiptFingerprint: string;
};

export interface AdoptionVerificationIdentity {
  readonly projectRoot: string;
  readonly reviewFingerprint: string;
  readonly destinationPlanFingerprint: string;
  readonly compatibilityPlanFingerprint: string;
  readonly verificationPlanFingerprint: string;
}

export interface AdoptionVerificationReadOptions {
  readonly storage?: RepairWorkspaceStorageOptions;
  readonly inspection?: ApplicationInspectionOptions;
}

export function adoptionVerificationTime(
  storage?: RepairWorkspaceStorageOptions
): Date {
  const value = storage?.clock?.() ?? new Date();
  if (!Number.isFinite(value.getTime())) {
    throw new Error('Adoption verification clock is invalid.');
  }
  return value;
}

function resultStore(
  projectRoot: string, storage?: RepairWorkspaceStorageOptions
) {
  return createScopedUserLocalRecordStore(
    projectRoot, 'adoption-verification-result', storage
  );
}

export async function loadAdoptionVerificationAuthority(
  identity: AdoptionVerificationIdentity,
  source: unknown,
  storage?: RepairWorkspaceStorageOptions,
  inspection: ApplicationInspectionOptions = {}
): Promise<{
  plan: AdoptionVerificationPlan;
  consent: AdoptionVerificationConsent;
}> {
  const now = adoptionVerificationTime(storage);
  const plan = await loadAdoptionVerificationPlan(
    identity.projectRoot, identity.reviewFingerprint,
    identity.destinationPlanFingerprint, identity.compatibilityPlanFingerprint,
    identity.verificationPlanFingerprint, source, now, storage, inspection
  );
  const consent = await readAdoptionVerificationConsent(
    identity.projectRoot, identity.reviewFingerprint,
    identity.destinationPlanFingerprint, identity.compatibilityPlanFingerprint,
    identity.verificationPlanFingerprint, source, now, storage, inspection
  );
  if (!consent) {
    throw new Error(
      'No exact current adoption verification consent exists; no project code or preparation was executed.'
    );
  }
  return { plan, consent };
}

function receiptBody(
  result: AdoptionVerificationExecutionResult
): Omit<AdoptionVerificationReceipt, 'receiptFingerprint'> {
  const { receiptFingerprint: _fingerprint, ...body } = result;
  return body as Omit<AdoptionVerificationReceipt, 'receiptFingerprint'>;
}

function validateReceipt(
  value: unknown, identity: AdoptionVerificationIdentity,
  plan: AdoptionVerificationPlan, consent: AdoptionVerificationConsent
): AdoptionVerificationReceipt {
  if (!isRecord(value)) {
    throw new Error('Saved adoption verification result is invalid.');
  }
  const receipt = value as unknown as AdoptionVerificationReceipt;
  if (receipt.schemaVersion !== adoptionVerificationResultSchemaVersion ||
      receipt.kind !== 'liftoff-adoption-verification-result' ||
      receipt.projectRoot !== plan.report.projectRoot ||
      receipt.reviewFingerprint !== identity.reviewFingerprint ||
      receipt.destinationPlanFingerprint !== identity.destinationPlanFingerprint ||
      receipt.compatibilityPlanFingerprint !== identity.compatibilityPlanFingerprint ||
      receipt.verificationPlanFingerprint !== identity.verificationPlanFingerprint ||
      receipt.consentFingerprint !== consent.fingerprint ||
      receipt.snapshotDigest !== plan.report.snapshotDigest ||
      receipt.verificationPolicyDigest !== plan.report.verificationPolicyDigest ||
      receipt.providerDigest !== plan.report.providerDigest ||
      receipt.toolchainDigest !== plan.report.toolchainDigest ||
      !/^[a-f0-9]{64}$/u.test(receipt.workspaceId) ||
      receipt.status !== 'passed' ||
      receipt.inputsUnchanged !== true ||
      receipt.cleanupComplete !== true ||
      receipt.retainedWorkspace !== undefined ||
      receipt.compatibility !== 'verified-by-declared-checks' ||
      receipt.approval !== 'not-requested' ||
      receipt.transaction !== 'not-authorized' ||
      receipt.publication !== 'not-authorized' ||
      !Array.isArray(receipt.commands) ||
      receipt.commands.length !== plan.verificationPolicy.commands.length ||
      !receipt.commands.every((command, index) =>
        isRecord(command) && command.index === index && command.passed === true) ||
      !Array.isArray(receipt.preparation) ||
      receipt.preparation.length !== plan.verificationPolicy.preparation.length ||
      !receipt.preparation.every(entry =>
        isRecord(entry) && entry.status === 'passed') ||
      !Array.isArray(receipt.blockers) || receipt.blockers.length !== 0 ||
      !Array.isArray(receipt.limitations) ||
      typeof receipt.startedAt !== 'string' ||
      typeof receipt.completedAt !== 'string' ||
      !Number.isFinite(Date.parse(receipt.startedAt)) ||
      !Number.isFinite(Date.parse(receipt.completedAt)) ||
      Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt) ||
      Date.parse(receipt.completedAt) > Date.parse(consent.expiresAt) ||
      typeof receipt.receiptFingerprint !== 'string' ||
      receipt.receiptFingerprint !== canonicalSha256(receiptBody(receipt))) {
    throw new Error(
      'Saved adoption verification result is invalid, incomplete or bound to different authority.'
    );
  }
  return Object.freeze(structuredClone(receipt));
}

export async function readBoundAdoptionVerificationResult(
  identity: AdoptionVerificationIdentity,
  plan: AdoptionVerificationPlan,
  consent: AdoptionVerificationConsent,
  storage?: RepairWorkspaceStorageOptions
): Promise<AdoptionVerificationReceipt | null> {
  const stored = await resultStore(plan.report.projectRoot, storage)
    .read(identity.verificationPlanFingerprint);
  if (!stored) return null;
  if (!isRecord(stored.value) ||
      typeof stored.value.workspaceId !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(stored.value.workspaceId)) {
    throw new Error('Saved adoption verification result seal is invalid.');
  }
  const payload = await openCompletedAdoptionVerificationResult(
    plan.report.projectRoot, stored.value.workspaceId,
    identity.verificationPlanFingerprint, stored.value, storage
  );
  return validateReceipt(payload, identity, plan, consent);
}

export async function persistAdoptionVerificationReceipt(
  result: AdoptionVerificationExecutionResult,
  storage?: RepairWorkspaceStorageOptions
): Promise<AdoptionVerificationReceipt> {
  if (result.status !== 'passed' || result.inputsUnchanged !== true ||
      result.cleanupComplete !== true ||
      result.compatibility !== 'verified-by-declared-checks' ||
      result.receiptFingerprint !== null) {
    throw new Error(
      'Only a complete successful adoption verification can become a receipt.'
    );
  }
  const body = receiptBody(result) as Omit<
    AdoptionVerificationReceipt, 'receiptFingerprint'
  >;
  const receipt = {
    ...body,
    receiptFingerprint: canonicalSha256(body)
  } as AdoptionVerificationReceipt;
  const sealed = await sealCompletedAdoptionVerificationResult(
    result.projectRoot, result.workspaceId,
    result.verificationPlanFingerprint, receipt, storage
  );
  await resultStore(result.projectRoot, storage).write(
    result.verificationPlanFingerprint, sealed
  );
  return Object.freeze(structuredClone(receipt));
}

export async function readAdoptionVerificationResult(
  projectRoot: string,
  reviewFingerprint: string,
  destinationPlanFingerprint: string,
  compatibilityPlanFingerprint: string,
  verificationPlanFingerprint: string,
  source: unknown,
  options: AdoptionVerificationReadOptions = {}
): Promise<AdoptionVerificationReceipt | null> {
  const identity = {
    projectRoot, reviewFingerprint, destinationPlanFingerprint,
    compatibilityPlanFingerprint, verificationPlanFingerprint
  };
  const { plan, consent } = await loadAdoptionVerificationAuthority(
    identity, source, options.storage, options.inspection
  );
  return readBoundAdoptionVerificationResult(
    identity, plan, consent, options.storage
  );
}
