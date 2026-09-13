import { createHash } from 'node:crypto';
import {
  createScopedUserLocalRecordStore, type UpdatePreviewOptions
} from '../../adapters/filesystem/update-previews.js';
import type { ReviewedUpdateApprovalStore } from '../../adapters/filesystem/reviewed-update-transaction.js';
import type { ProjectFileMutation, ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { liftoffVersion } from '../../version.js';
import { repairValidationPolicy } from './validation.js';

export const repairRecipeVersion = 'azure-local-layout-v1';
export const repairPreviewTtlMs = 15 * 60_000;
export const repairHistoryRoot = ['.liftoff', 'repair-history'] as const;
export const repairHistoryFiles = ['manifest.json', 'receipt.json'] as const;
export const byteDigest = (content: string | Buffer): string =>
  createHash('sha256').update(content).digest('hex');

export function snapshotDescriptors(snapshots: readonly ProjectFileSnapshot[]) {
  return snapshots.map((snapshot) => ({
    pathParts: snapshot.pathParts, digest: snapshot.content === undefined ? null : byteDigest(snapshot.content),
    mode: snapshot.mode ?? null
  })).sort((a, b) => a.pathParts.join('/').localeCompare(b.pathParts.join('/'), 'en'));
}

export function mutationDescriptors(mutations: readonly ProjectFileMutation[]) {
  return mutations.map((mutation) => ({
    type: mutation.type, pathParts: mutation.pathParts,
    digest: mutation.type === 'write' ? byteDigest(mutation.content) : null,
    mode: mutation.type === 'write' ? mutation.mode ?? null : null
  }));
}

export interface RepairPreview {
  schemaVersion: 1;
  kind: 'liftoff-repair-preview';
  projectRoot: string;
  cliVersion: string;
  recipe: string;
  createdAt: string;
  expiresAt: string;
  live: boolean;
  subscription: string | null;
  inputDigest: string;
  effectsDigest: string;
  verificationDigest: string;
  fingerprint: string;
}

export function buildRepairPreview(input: {
  projectRoot: string;
  snapshots: readonly ProjectFileSnapshot[];
  mutations: readonly ProjectFileMutation[];
  scope: unknown;
  live: boolean;
  subscription?: string;
  now: Date;
}): RepairPreview {
  const body = {
    schemaVersion: 1 as const, kind: 'liftoff-repair-preview' as const, projectRoot: input.projectRoot,
    cliVersion: liftoffVersion, recipe: repairRecipeVersion,
    createdAt: input.now.toISOString(), expiresAt: new Date(input.now.getTime() + repairPreviewTtlMs).toISOString(),
    live: input.live, subscription: input.subscription?.toLowerCase() ?? null,
    inputDigest: canonicalSha256({ snapshots: snapshotDescriptors(input.snapshots), scope: input.scope }),
    effectsDigest: canonicalSha256(mutationDescriptors(input.mutations)),
    verificationDigest: canonicalSha256(repairValidationPolicy)
  };
  return { ...body, fingerprint: canonicalSha256(body) };
}

export async function loadRepairPreview(
  projectRoot: string, fingerprint: string, now: Date, storage?: UpdatePreviewOptions
): Promise<RepairPreview> {
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error('Repair approval requires the complete lowercase 64-character fingerprint.');
  const stored = await createScopedUserLocalRecordStore(projectRoot, 'repair-preview', storage).read(fingerprint);
  if (!stored || !isRecord(stored.value)) throw new Error('No matching repair preview exists for this project. Run liftoff repair --check first.');
  const { fingerprint: actual, ...value } = stored.value;
  const keys = ['schemaVersion', 'kind', 'projectRoot', 'cliVersion', 'recipe', 'createdAt', 'expiresAt', 'live', 'subscription', 'inputDigest', 'effectsDigest', 'verificationDigest'];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
      value.schemaVersion !== 1 || value.kind !== 'liftoff-repair-preview' || value.projectRoot !== projectRoot ||
      actual !== fingerprint || canonicalSha256(value) !== fingerprint ||
      value.cliVersion !== liftoffVersion || value.recipe !== repairRecipeVersion ||
      typeof value.createdAt !== 'string' || typeof value.expiresAt !== 'string' ||
      typeof value.live !== 'boolean' ||
      !(value.subscription === null || typeof value.subscription === 'string' &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value.subscription)) ||
      value.live !== (value.subscription !== null) ||
      typeof value.inputDigest !== 'string' || typeof value.effectsDigest !== 'string' ||
      typeof value.verificationDigest !== 'string' ||
      ![value.inputDigest, value.effectsDigest, value.verificationDigest].every((digest) => /^[a-f0-9]{64}$/u.test(digest))) {
    throw new Error('Repair preview is invalid or belongs to another project, recipe or CLI. Request a new check.');
  }
  const created = Date.parse(value.createdAt), expires = Date.parse(value.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || created > now.getTime() ||
      expires <= now.getTime() || expires - created !== repairPreviewTtlMs) {
    throw new Error('Repair preview expired or has invalid dates; request a new check.');
  }
  return {
    schemaVersion: 1, kind: 'liftoff-repair-preview', projectRoot, cliVersion: value.cliVersion,
    recipe: value.recipe, createdAt: value.createdAt, expiresAt: value.expiresAt,
    live: value.live, subscription: value.subscription, inputDigest: value.inputDigest,
    effectsDigest: value.effectsDigest, verificationDigest: value.verificationDigest, fingerprint
  };
}

export function repairApprovalStore(projectRoot: string, options?: UpdatePreviewOptions): ReviewedUpdateApprovalStore {
  const store = createScopedUserLocalRecordStore(projectRoot, 'repair-approval', options);
  const key = (fingerprint: string, digest: string, revoked = false) =>
    canonicalSha256({ kind: 'liftoff-repair-transaction-authority', projectRoot, fingerprint, digest, revoked });
  const body = (fingerprint: string, digest: string) => ({
    schemaVersion: 1, kind: 'liftoff-repair-transaction-authority', projectRoot, fingerprint, digest
  });
  return {
    write: async (fingerprint, digest) => { await store.write(key(fingerprint, digest), body(fingerprint, digest)); },
    verify: async (fingerprint, digest) => {
      const record = await store.read(key(fingerprint, digest));
      const revoked = await store.read(key(fingerprint, digest, true));
      return !revoked && record !== null && canonicalSha256(record.value) === canonicalSha256(body(fingerprint, digest));
    },
    remove: async (fingerprint, digest) => {
      await store.write(key(fingerprint, digest, true), { ...body(fingerprint, digest), revoked: true });
    }
  };
}
