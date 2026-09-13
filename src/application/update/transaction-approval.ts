import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { normalizeUpdatePreviewProjectRoot, updatePreviewProjectKey } from './preview.js';

export const updateTransactionApprovalSchemaVersion = 1;

export interface UpdateTransactionApprovalStore {
  /** Only the explicit-approval coordinator may write transaction or checkpoint seals. */
  write(planFingerprint: string, transactionDigest: string): Promise<void>;
  verify(planFingerprint: string, transactionDigest: string): Promise<boolean>;
  remove(planFingerprint: string, transactionDigest: string): Promise<void>;
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

export function createUpdateTransactionApprovalSeal(
  binding: UpdateTransactionApprovalBinding,
  issuance: { approvalId: string; approvedAt: string }
): UpdateTransactionApprovalSeal {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(issuance.approvalId)) {
    invalid('Transaction approvalId must be a lowercase UUID.');
  }
  const time = Date.parse(issuance.approvedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== issuance.approvedAt) {
    invalid('Transaction approvedAt must be an ISO UTC timestamp.');
  }
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
