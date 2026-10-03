import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { normalizeUpdatePreviewProjectRoot, updatePreviewProjectKey } from './preview.js';

export const updateTransactionApprovalSchemaVersion = 1;
export const localVerificationTransactionAuthoritySchemaVersion = 1 as const;

export interface UpdateTransactionApprovalStore {
  /** Only the explicit-approval coordinator may write transaction or checkpoint seals. */
  write(planFingerprint: string, transactionDigest: string): Promise<void>;
  verify(planFingerprint: string, transactionDigest: string): Promise<boolean>;
  remove(planFingerprint: string, transactionDigest: string): Promise<void>;
}

export interface LocalVerificationTransactionAuthorityStore extends UpdateTransactionApprovalStore {
  readonly transactionKind: 'local-verification';
  /** The caller supplies a canonical root; filesystem use independently verifies it. */
  readonly projectRoot: string;
}

export interface UpdateTransactionApprovalBinding {
  readonly projectRoot: string;
  readonly planFingerprint: string;
  readonly transactionDigest: string;
}

export interface UpdateTransactionApprovalSeal extends UpdateTransactionApprovalBinding {
  readonly schemaVersion: typeof updateTransactionApprovalSchemaVersion;
  readonly kind: 'liftoff-update-transaction-approval';
  readonly projectKey: string;
  readonly approvalId: string;
  readonly approvedAt: string;
}

export interface LocalVerificationTransactionAuthority extends Omit<UpdateTransactionApprovalSeal, 'kind' | 'schemaVersion'> {
  readonly schemaVersion: typeof localVerificationTransactionAuthoritySchemaVersion;
  readonly kind: 'liftoff-local-verification-transaction-authority';
}

export class UpdateTransactionApprovalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UpdateTransactionApprovalError';
  }
}

function invalid(message: string): never {
  throw new UpdateTransactionApprovalError(message);
}

export function validateUpdateTransactionApprovalDigests(planFingerprint: unknown, transactionDigest: unknown): void {
  if (typeof planFingerprint !== 'string' || !/^[0-9a-f]{64}$/u.test(planFingerprint) ||
      typeof transactionDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(transactionDigest)) {
    invalid('Transaction approval requires complete lowercase SHA-256 plan and transaction digests.');
  }
}

function bindingFields(binding: UpdateTransactionApprovalBinding): Omit<UpdateTransactionApprovalSeal, 'approvalId' | 'approvedAt'> {
  validateUpdateTransactionApprovalDigests(binding.planFingerprint, binding.transactionDigest);
  const projectRoot = normalizeUpdatePreviewProjectRoot(binding.projectRoot);
  return {
    schemaVersion: updateTransactionApprovalSchemaVersion,
    kind: 'liftoff-update-transaction-approval',
    projectRoot,
    projectKey: updatePreviewProjectKey(projectRoot),
    planFingerprint: binding.planFingerprint,
    transactionDigest: binding.transactionDigest
  };
}

export function updateTransactionApprovalKey(binding: UpdateTransactionApprovalBinding): string {
  return canonicalSha256(bindingFields(binding));
}

function validateIssuance(issuance: { approvalId: string; approvedAt: string }): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(issuance.approvalId)) {
    invalid('Transaction approvalId must be a lowercase UUID.');
  }
  const time = Date.parse(issuance.approvedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== issuance.approvedAt) {
    invalid('Transaction approvedAt must be an ISO UTC timestamp.');
  }
}

export function createUpdateTransactionApprovalSeal(
  binding: UpdateTransactionApprovalBinding,
  issuance: { approvalId: string; approvedAt: string }
): UpdateTransactionApprovalSeal {
  validateIssuance(issuance);
  return Object.freeze({
    ...bindingFields(binding),
    approvalId: issuance.approvalId,
    approvedAt: issuance.approvedAt
  });
}

export function validateUpdateTransactionApprovalSeal(
  value: unknown,
  expected: UpdateTransactionApprovalBinding,
  now: Date
): UpdateTransactionApprovalSeal {
  if (!isRecord(value)) invalid('Transaction approval seal must be an object.');
  if (value.schemaVersion !== updateTransactionApprovalSchemaVersion) {
    invalid('Unsupported or missing transaction approval schema; expected schema 1.');
  }
  const keys = [
    'schemaVersion', 'kind', 'projectRoot', 'projectKey', 'planFingerprint', 'transactionDigest', 'approvalId', 'approvedAt'
  ];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    invalid('Transaction approval seal has missing or unrecognized fields.');
  }
  if (value.kind !== 'liftoff-update-transaction-approval' || typeof value.projectRoot !== 'string' ||
      typeof value.planFingerprint !== 'string' || typeof value.transactionDigest !== 'string' ||
      typeof value.approvalId !== 'string' || typeof value.approvedAt !== 'string') {
    invalid('Invalid transaction approval seal; a preview receipt is not approval.');
  }
  const seal = createUpdateTransactionApprovalSeal({
    projectRoot: value.projectRoot,
    planFingerprint: value.planFingerprint,
    transactionDigest: value.transactionDigest
  }, { approvalId: value.approvalId, approvedAt: value.approvedAt });
  if (seal.projectRoot !== value.projectRoot || seal.projectKey !== value.projectKey) {
    invalid('Transaction approval seal has an inconsistent canonical project identity.');
  }
  if (seal.projectRoot !== normalizeUpdatePreviewProjectRoot(expected.projectRoot) ||
      seal.planFingerprint !== expected.planFingerprint || seal.transactionDigest !== expected.transactionDigest) {
    invalid('Transaction approval seal does not match this project, plan, and exact transaction digest.');
  }
  if (!Number.isFinite(now.getTime()) || Date.parse(seal.approvedAt) > now.getTime()) {
    invalid('Transaction approval is dated in the future or the current clock is invalid.');
  }
  return seal;
}

function localVerificationBinding(binding: UpdateTransactionApprovalBinding) {
  const { kind: _kind, schemaVersion: _schema, ...fields } = bindingFields(binding);
  return { ...fields, schemaVersion: localVerificationTransactionAuthoritySchemaVersion,
    kind: 'liftoff-local-verification-transaction-authority' as const };
}

export function localVerificationTransactionAuthorityKey(binding: UpdateTransactionApprovalBinding): string {
  return canonicalSha256(localVerificationBinding(binding));
}

export function createLocalVerificationTransactionAuthority(
  binding: UpdateTransactionApprovalBinding,
  issuance: { approvalId: string; approvedAt: string }
): LocalVerificationTransactionAuthority {
  validateIssuance(issuance);
  return Object.freeze({ ...localVerificationBinding(binding), approvalId: issuance.approvalId, approvedAt: issuance.approvedAt });
}

export function validateLocalVerificationTransactionAuthority(
  value: unknown, expected: UpdateTransactionApprovalBinding, now: Date
): LocalVerificationTransactionAuthority {
  const keys = ['schemaVersion', 'kind', 'projectRoot', 'projectKey', 'planFingerprint', 'transactionDigest', 'approvalId', 'approvedAt'];
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
        const field = Object.getOwnPropertyDescriptor(value, key);
        return !field?.enumerable || !Object.hasOwn(field, 'value');
      })) invalid('Local-verification authority requires exact own-data fields.');
  if (value.schemaVersion !== localVerificationTransactionAuthoritySchemaVersion ||
      value.kind !== 'liftoff-local-verification-transaction-authority' ||
      typeof value.projectRoot !== 'string' || typeof value.planFingerprint !== 'string' ||
      typeof value.transactionDigest !== 'string' || typeof value.approvalId !== 'string' || typeof value.approvedAt !== 'string') {
    invalid('Unsupported or malformed local-verification authority; another operation cannot authorize publication.');
  }
  const seal = createLocalVerificationTransactionAuthority({
    projectRoot: value.projectRoot, planFingerprint: value.planFingerprint, transactionDigest: value.transactionDigest
  }, { approvalId: value.approvalId, approvedAt: value.approvedAt });
  if (seal.projectRoot !== value.projectRoot || seal.projectKey !== value.projectKey ||
      canonicalSha256(localVerificationBinding(seal)) !== canonicalSha256(localVerificationBinding(expected))) {
    invalid('Local-verification authority differs from this project, publication, or exact transaction digest.');
  }
  if (!Number.isFinite(now.getTime()) || Date.parse(seal.approvedAt) > now.getTime()) {
    invalid('Local-verification authority is dated in the future or the current clock is invalid.');
  }
  return seal;
}
