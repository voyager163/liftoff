import { types } from 'node:util';
import {
  createScopedUserLocalRecordStore, type UpdatePreviewOptions
} from '../../adapters/filesystem/update-previews.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type {
  ApplicationInspectionOptions
} from '../repair/application-preparation-types.js';
import { loadAdoptionPreview } from './preview.js';
import {
  loadAdoptionVerificationPlan, type AdoptionVerificationPlan
} from './verification-plan.js';

export const adoptionVerificationConsentSchemaVersion = 1 as const;

export interface AdoptionVerificationPermissionRequest {
  readonly projectCode: boolean;
  readonly dependencyPreparation: boolean;
  readonly declaredNetwork: boolean;
}

export interface AdoptionVerificationConsent {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-adoption-verification-consent';
  readonly projectRoot: string;
  readonly reviewFingerprint: string;
  readonly destinationPlanFingerprint: string;
  readonly compatibilityPlanFingerprint: string;
  readonly verificationPlanFingerprint: string;
  readonly verificationPolicyDigest: string;
  readonly permissions: {
    readonly projectCode: true;
    readonly dependencyPreparation: boolean;
    readonly declaredNetwork: boolean;
  };
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly result: 'granted-for-isolated-verification-only';
  readonly compatibility: 'not-verified';
  readonly transaction: 'not-authorized';
  readonly publication: 'not-authorized';
  readonly fingerprint: string;
}

export interface SavedAdoptionVerificationConsent {
  readonly path: string;
  readonly consent: AdoptionVerificationConsent;
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || types.isProxy(value)) {
    throw new Error(`${label} must contain exactly the documented plain fields.`);
  }
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (prototype !== Object.prototype && prototype !== null ||
      ownKeys.length !== keys.length ||
      ownKeys.some(key => typeof key !== 'string' || !keys.includes(key)) ||
      keys.some(key => {
        const descriptor = descriptors[key];
        return !descriptor || !descriptor.enumerable || descriptor.get !== undefined ||
          descriptor.set !== undefined || !Object.hasOwn(descriptor, 'value');
      })) {
    throw new Error(`${label} must contain exactly the documented plain fields.`);
  }
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}

function permissions(value: unknown): AdoptionVerificationPermissionRequest {
  const request = exact(value, [
    'projectCode', 'dependencyPreparation', 'declaredNetwork'
  ], 'Adoption verification permission request');
  if (Object.values(request).some(item => typeof item !== 'boolean')) {
    throw new Error('Adoption verification permissions must be explicit booleans.');
  }
  return request as unknown as AdoptionVerificationPermissionRequest;
}

function expectedPermissions(
  plan: AdoptionVerificationPlan
): AdoptionVerificationConsent['permissions'] {
  return {
    projectCode: true,
    dependencyPreparation: plan.report.requiredPermissions.includes('dependency-preparation'),
    declaredNetwork: plan.report.requiredPermissions.includes('declared-network')
  };
}

async function currentPlan(
  projectRoot: string,
  reviewFingerprint: string,
  destinationPlanFingerprint: string,
  compatibilityPlanFingerprint: string,
  verificationPlanFingerprint: string,
  source: unknown,
  now: Date,
  storage?: UpdatePreviewOptions,
  inspection: ApplicationInspectionOptions = {}
) {
  const plan = await loadAdoptionVerificationPlan(
    projectRoot, reviewFingerprint, destinationPlanFingerprint,
    compatibilityPlanFingerprint, verificationPlanFingerprint,
    source, now, storage, inspection
  );
  const preview = await loadAdoptionPreview(
    plan.report.projectRoot, reviewFingerprint, now, storage
  );
  return { plan, preview };
}

export async function saveAdoptionVerificationConsent(
  projectRoot: string,
  reviewFingerprint: string,
  destinationPlanFingerprint: string,
  compatibilityPlanFingerprint: string,
  verificationPlanFingerprint: string,
  source: unknown,
  now: Date,
  request: unknown,
  storage?: UpdatePreviewOptions,
  inspection: ApplicationInspectionOptions = {}
): Promise<SavedAdoptionVerificationConsent> {
  const granted = permissions(request);
  const { plan, preview } = await currentPlan(
    projectRoot, reviewFingerprint, destinationPlanFingerprint,
    compatibilityPlanFingerprint, verificationPlanFingerprint,
    source, now, storage, inspection
  );
  const expected = expectedPermissions(plan);
  if (canonicalSha256(granted) !== canonicalSha256(expected)) {
    throw new Error('Adoption verification consent must exactly grant every displayed required scope and no unused scope.');
  }
  const body = {
    schemaVersion: adoptionVerificationConsentSchemaVersion,
    kind: 'liftoff-adoption-verification-consent' as const,
    projectRoot: plan.report.projectRoot,
    reviewFingerprint,
    destinationPlanFingerprint,
    compatibilityPlanFingerprint,
    verificationPlanFingerprint,
    verificationPolicyDigest: plan.report.verificationPolicyDigest,
    permissions: expected,
    grantedAt: now.toISOString(),
    expiresAt: preview.expiresAt,
    result: 'granted-for-isolated-verification-only' as const,
    compatibility: 'not-verified' as const,
    transaction: 'not-authorized' as const,
    publication: 'not-authorized' as const
  };
  const consent = Object.freeze({
    ...body,
    permissions: Object.freeze(body.permissions),
    fingerprint: canonicalSha256(body)
  });
  const stored = await createScopedUserLocalRecordStore(
    plan.report.projectRoot, 'adoption-verification-consent', storage
  ).write(verificationPlanFingerprint, consent);
  if (stored.projectRoot !== plan.report.projectRoot) {
    throw new Error('Adoption verification-consent storage resolved a different canonical project root.');
  }
  return { path: stored.path, consent };
}

export async function readAdoptionVerificationConsent(
  projectRoot: string,
  reviewFingerprint: string,
  destinationPlanFingerprint: string,
  compatibilityPlanFingerprint: string,
  verificationPlanFingerprint: string,
  source: unknown,
  now: Date,
  storage?: UpdatePreviewOptions,
  inspection: ApplicationInspectionOptions = {}
): Promise<AdoptionVerificationConsent | null> {
  const { plan, preview } = await currentPlan(
    projectRoot, reviewFingerprint, destinationPlanFingerprint,
    compatibilityPlanFingerprint, verificationPlanFingerprint,
    source, now, storage, inspection
  );
  const stored = await createScopedUserLocalRecordStore(
    plan.report.projectRoot, 'adoption-verification-consent', storage
  ).read(verificationPlanFingerprint);
  if (!stored) return null;
  const value = exact(stored.value, [
    'schemaVersion', 'kind', 'projectRoot', 'reviewFingerprint',
    'destinationPlanFingerprint', 'compatibilityPlanFingerprint',
    'verificationPlanFingerprint', 'verificationPolicyDigest', 'permissions',
    'grantedAt', 'expiresAt', 'result', 'compatibility', 'transaction',
    'publication', 'fingerprint'
  ], 'Saved adoption verification consent');
  const actualPermissions = permissions(value.permissions);
  const { fingerprint, ...body } = value;
  if (value.schemaVersion !== adoptionVerificationConsentSchemaVersion ||
      value.kind !== 'liftoff-adoption-verification-consent' ||
      value.projectRoot !== plan.report.projectRoot ||
      value.reviewFingerprint !== reviewFingerprint ||
      value.destinationPlanFingerprint !== destinationPlanFingerprint ||
      value.compatibilityPlanFingerprint !== compatibilityPlanFingerprint ||
      value.verificationPlanFingerprint !== verificationPlanFingerprint ||
      value.verificationPolicyDigest !== plan.report.verificationPolicyDigest ||
      canonicalSha256(actualPermissions) !== canonicalSha256(expectedPermissions(plan)) ||
      typeof value.grantedAt !== 'string' ||
      value.expiresAt !== preview.expiresAt ||
      value.result !== 'granted-for-isolated-verification-only' ||
      value.compatibility !== 'not-verified' ||
      value.transaction !== 'not-authorized' ||
      value.publication !== 'not-authorized' ||
      typeof fingerprint !== 'string' ||
      fingerprint !== canonicalSha256(body) ||
      !Number.isFinite(Date.parse(value.grantedAt)) ||
      Date.parse(value.grantedAt) < Date.parse(preview.createdAt) ||
      Date.parse(value.grantedAt) > now.getTime() ||
      Date.parse(preview.expiresAt) <= now.getTime()) {
    throw new Error('Adoption verification consent is invalid, stale or bound to different inputs, tools or permissions.');
  }
  return Object.freeze({
    ...body,
    permissions: Object.freeze(actualPermissions) as AdoptionVerificationConsent['permissions'],
    fingerprint
  }) as AdoptionVerificationConsent;
}
