import {
  createScopedUserLocalRecordStore, resolveUpdatePreviewLocation, type UpdatePreviewOptions
} from '../../adapters/filesystem/update-previews.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { assertModernRecordData } from '../../domain/governance/activation/source-values.js';
import { exactRecord } from '../../domain/project/manifest/fields.js';
import { liftoffVersion } from '../../version.js';
import { normalizeUpdatePreviewProjectRoot } from '../update/preview.js';
import { inspectAdoptionCandidate, type AdoptionCandidateInspection } from './candidate.js';

export const adoptionPreviewSchemaVersion = 1 as const;
export const adoptionReviewContractVersion = 1 as const;
export const adoptionPreviewTtlMs = 15 * 60_000;

export interface AdoptionPreview {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-adoption-preview';
  readonly adoptionReviewContractVersion: 1;
  readonly cliVersion: string;
  readonly projectRoot: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly sourceDigest: string;
  readonly inventoryDigest: string;
  readonly candidateDigest: string | null;
  readonly managedSourceDigest: string;
  readonly candidateStatus: 'blocked' | 'candidate-observed-unverified';
  readonly verification: 'not-performed';
  readonly publication: 'not-authorized';
  readonly fingerprint: string;
}

export interface AdoptionReviewInspection extends AdoptionCandidateInspection {
  readonly preview: AdoptionPreview;
}

export class AdoptionPreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdoptionPreviewError';
  }
}

function invalid(message: string): never {
  throw new AdoptionPreviewError(message);
}

function assertDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    invalid('Adoption review requires complete lowercase SHA-256 digests.');
  }
}

function reviewBody(inspection: AdoptionCandidateInspection, createdAt: string, expiresAt: string) {
  const { report } = inspection;
  return {
    schemaVersion: adoptionPreviewSchemaVersion, kind: 'liftoff-adoption-preview' as const,
    adoptionReviewContractVersion, cliVersion: liftoffVersion,
    projectRoot: report.inventory.projectRoot, createdAt, expiresAt,
    sourceDigest: report.sourceDigest, inventoryDigest: report.inventory.inspectionDigest,
    candidateDigest: report.candidateDigest, managedSourceDigest: canonicalSha256(report.managedSource),
    candidateStatus: report.status, verification: report.verification, publication: report.publication
  };
}

export async function createAdoptionReview(
  projectRoot: string, source: unknown, now: Date = new Date()
): Promise<AdoptionReviewInspection> {
  const current = now.getTime(), deadline = new Date(current + adoptionPreviewTtlMs);
  if (!Number.isFinite(current) || !Number.isFinite(deadline.getTime())) {
    invalid('Adoption review requires a finite current clock.');
  }
  const createdAt = new Date(current).toISOString(), expiresAt = deadline.toISOString();
  const inspection = await inspectAdoptionCandidate(projectRoot, source);
  const body = reviewBody(inspection, createdAt, expiresAt);
  const preview = Object.freeze({ ...body, fingerprint: canonicalSha256(body) });
  return Object.assign(inspection, { preview });
}

export function validateAdoptionPreview(
  value: unknown, now: Date, expected: { projectRoot?: string; fingerprint?: string } = {}
): AdoptionPreview {
  assertModernRecordData(value, 'Adoption preview');
  const fields = exactRecord(value, [
    'schemaVersion', 'kind', 'adoptionReviewContractVersion', 'cliVersion', 'projectRoot', 'createdAt',
    'expiresAt', 'sourceDigest', 'inventoryDigest', 'candidateDigest', 'managedSourceDigest',
    'candidateStatus', 'verification', 'publication', 'fingerprint'
  ], 'Adoption preview');
  if (fields.schemaVersion !== adoptionPreviewSchemaVersion || fields.kind !== 'liftoff-adoption-preview' ||
      fields.adoptionReviewContractVersion !== adoptionReviewContractVersion || fields.cliVersion !== liftoffVersion) {
    invalid('Unsupported adoption review identity; update/repair previews or other CLI contracts are not adoption reviews.');
  }
  if (typeof fields.projectRoot !== 'string' ||
      normalizeUpdatePreviewProjectRoot(fields.projectRoot) !== fields.projectRoot ||
      expected.projectRoot !== undefined && fields.projectRoot !== normalizeUpdatePreviewProjectRoot(expected.projectRoot)) {
    invalid('Adoption review belongs to a different or noncanonical project root.');
  }
  const { sourceDigest, inventoryDigest, managedSourceDigest, fingerprint, candidateDigest } = fields;
  assertDigest(sourceDigest);
  assertDigest(inventoryDigest);
  assertDigest(managedSourceDigest);
  assertDigest(fingerprint);
  if (fields.candidateStatus !== 'blocked' && fields.candidateStatus !== 'candidate-observed-unverified' ||
      fields.candidateStatus === 'blocked' && candidateDigest !== null ||
      fields.candidateStatus === 'candidate-observed-unverified' && candidateDigest === null) {
    invalid('Adoption review must preserve its actual blocked or unverified candidate state.');
  }
  if (candidateDigest !== null) assertDigest(candidateDigest);
  if (fields.verification !== 'not-performed' || fields.publication !== 'not-authorized') {
    invalid('An adoption comparison review cannot claim verification or publication authority.');
  }
  if (typeof fields.createdAt !== 'string' || typeof fields.expiresAt !== 'string' || !Number.isFinite(now.getTime())) {
    invalid('Adoption review requires canonical dates and a finite current clock.');
  }
  const created = Date.parse(fields.createdAt), expires = Date.parse(fields.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) ||
      new Date(created).toISOString() !== fields.createdAt || new Date(expires).toISOString() !== fields.expiresAt ||
      created > now.getTime() || expires <= now.getTime() || expires - created !== adoptionPreviewTtlMs) {
    invalid('Adoption review is expired, future-dated or has an invalid review interval; request a new review.');
  }
  const { fingerprint: _fingerprint, ...body } = fields;
  if (fingerprint !== canonicalSha256(body) || expected.fingerprint !== undefined && fingerprint !== expected.fingerprint) {
    invalid('Adoption review fingerprint does not match its exact identity and observations.');
  }
  return Object.freeze({
    schemaVersion: adoptionPreviewSchemaVersion, kind: 'liftoff-adoption-preview', adoptionReviewContractVersion,
    cliVersion: liftoffVersion, projectRoot: fields.projectRoot, createdAt: fields.createdAt, expiresAt: fields.expiresAt,
    sourceDigest, inventoryDigest, candidateDigest, managedSourceDigest,
    candidateStatus: fields.candidateStatus, verification: 'not-performed', publication: 'not-authorized',
    fingerprint
  });
}

/** Saved observations are deliberately separate from consent, verification and transaction authority. */
export async function saveAdoptionPreview(
  value: unknown, now: Date, storage?: UpdatePreviewOptions
): Promise<{ path: string; preview: AdoptionPreview }> {
  const preview = validateAdoptionPreview(value, now);
  const location = await resolveUpdatePreviewLocation(preview.projectRoot, storage);
  if (location.projectRoot !== preview.projectRoot) invalid('Adoption preview storage resolved a different canonical root.');
  const stored = await createScopedUserLocalRecordStore(preview.projectRoot, 'adoption-preview', storage)
    .write(preview.fingerprint, preview);
  if (stored.projectRoot !== preview.projectRoot) invalid('Adoption preview storage resolved a different canonical root.');
  return { path: stored.path, preview };
}

export async function loadAdoptionPreview(
  projectRoot: string, fingerprint: string, now: Date, storage?: UpdatePreviewOptions
): Promise<AdoptionPreview> {
  assertDigest(fingerprint);
  const root = normalizeUpdatePreviewProjectRoot(projectRoot);
  const stored = await createScopedUserLocalRecordStore(root, 'adoption-preview', storage).read(fingerprint);
  if (!stored) invalid('No matching same-project adoption review exists; request a new review.');
  if (stored.projectRoot !== root) invalid('Adoption preview storage resolved a different canonical root.');
  return validateAdoptionPreview(stored.value, now, { projectRoot: root, fingerprint });
}

export async function revalidateAdoptionPreview(
  value: unknown, source: unknown, now: Date
): Promise<AdoptionCandidateInspection> {
  const preview = validateAdoptionPreview(value, now);
  const inspection = await inspectAdoptionCandidate(preview.projectRoot, source);
  const body = reviewBody(inspection, preview.createdAt, preview.expiresAt);
  if (canonicalSha256(body) !== preview.fingerprint) {
    invalid('Adoption review is stale: current source, application inventory or comparison candidate changed; request a new review.');
  }
  return inspection;
}
