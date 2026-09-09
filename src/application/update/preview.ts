import path from 'node:path';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';

export const updatePreviewSchemaVersion = 1;
export const updatePreviewDirectoryParts: readonly string[] = Object.freeze(['liftoff', 'update-previews']);

export type UpdatePreviewMode = 'normal' | 'force';
export type UpdatePreviewErrorCode =
  | 'preview-missing'
  | 'preview-invalid'
  | 'preview-unsupported'
  | 'preview-mismatch'
  | 'preview-storage'
  | 'preview-busy';

export class UpdatePreviewError extends Error {
  constructor(readonly code: UpdatePreviewErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UpdatePreviewError';
  }
}

export interface UpdatePreviewInput {
  /** The real project root returned by the filesystem adapter, not a display alias. */
  projectRoot: string;
  cliVersion: string;
  mode: UpdatePreviewMode;
  source: unknown;
  target: unknown;
  operations: unknown;
}

export interface UpdatePreviewDescriptor {
  readonly projectRoot: string;
  readonly cliVersion: string;
  readonly mode: UpdatePreviewMode;
  readonly sourceDigest: string;
  readonly targetDigest: string;
  readonly operationsDigest: string;
  readonly fingerprint: string;
}

export interface UpdatePreviewReceipt {
  readonly schemaVersion: typeof updatePreviewSchemaVersion;
  readonly kind: 'liftoff-update-preview';
  readonly projectRoot: string;
  readonly projectKey: string;
  readonly receiptId: string;
  readonly issuedAt: string;
  readonly variants: readonly UpdatePreviewDescriptor[];
}

export interface UpdatePreviewIssuance {
  receiptId: string;
  issuedAt: string;
}

const digestPattern = /^[0-9a-f]{64}$/u;
const receiptIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function invalid(message: string): never {
  throw new UpdatePreviewError('preview-invalid', message);
}

function strictKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    invalid(`${label} has missing or unrecognized fields.`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f]/u.test(value)) {
    invalid(`${label} must be a nonempty string without control characters.`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !digestPattern.test(value)) {
    invalid(`${label} must be a complete lowercase SHA-256 fingerprint.`);
  }
  return value;
}

export function normalizeUpdatePreviewProjectRoot(value: string): string {
  const root = text(value, 'Preview project root');
  const paths = /^[a-z]:[\\/]/iu.test(root) || root.startsWith('\\\\') ? path.win32 : path.posix;
  if (!paths.isAbsolute(root) || root.startsWith('\\\\?\\') || root.startsWith('\\\\.\\')) {
    invalid('Preview project root must be an absolute canonical native path.');
  }
  const normalized = paths.normalize(root);
  const boundary = paths.parse(normalized).root;
  if (paths === path.win32 && !/^[a-z]:\\$/iu.test(boundary) &&
      !/^\\\\[^\\]+\\[^\\]+\\$/u.test(boundary)) {
    invalid('Preview project root must include its Windows drive or UNC share.');
  }
  return normalized === boundary ? boundary : normalized.endsWith(paths.sep) ? normalized.slice(0, -1) : normalized;
}

export function updatePreviewProjectKey(projectRoot: string): string {
  return canonicalSha256({
    schemaVersion: updatePreviewSchemaVersion,
    kind: 'liftoff-update-project',
    projectRoot: normalizeUpdatePreviewProjectRoot(projectRoot)
  });
}

function assertSemanticJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null) invalid('Preview semantics must contain only finite JSON values.');
  if (ancestors.has(value)) invalid('Preview semantics cannot contain cycles.');
  if (Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype) {
    invalid('Preview semantics must use plain JSON arrays, not runtime objects.');
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) {
    invalid('Preview semantics must use plain JSON objects, not runtime objects.');
  }
  if (Object.getOwnPropertySymbols(value).length) invalid('Preview semantics cannot contain symbol keys.');
  const properties = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(properties);
  if (Array.isArray(value) &&
      (keys.length !== value.length + 1 || Array.from({ length: value.length }, (_, index) => index)
        .some((index) => !Object.hasOwn(properties, String(index))))) {
    invalid('Preview semantics cannot contain sparse arrays or additional array properties.');
  }
  ancestors.add(value);
  for (const key of keys) {
    if (Array.isArray(value) && key === 'length') continue;
    const property = properties[key];
    if (!Object.hasOwn(property, 'value') || !property.enumerable) {
      invalid('Preview semantics cannot contain accessors or hidden properties.');
    }
    assertSemanticJson(property.value, ancestors);
  }
  ancestors.delete(value);
}

function semanticDigest(value: unknown): string {
  assertSemanticJson(value);
  return canonicalSha256(value);
}

function descriptorFromDigests(input: Omit<UpdatePreviewDescriptor, 'fingerprint'>): UpdatePreviewDescriptor {
  const projectRoot = normalizeUpdatePreviewProjectRoot(input.projectRoot);
  const cliVersion = text(input.cliVersion, 'Preview CLI version');
  if (!/^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/iu.test(cliVersion)) {
    invalid('Preview CLI version must be a semantic version.');
  }
  if (input.mode !== 'normal' && input.mode !== 'force') invalid('Preview mode must be normal or force.');
  const fields = {
    projectRoot,
    cliVersion,
    mode: input.mode,
    sourceDigest: digest(input.sourceDigest, 'Preview source digest'),
    targetDigest: digest(input.targetDigest, 'Preview target digest'),
    operationsDigest: digest(input.operationsDigest, 'Preview operations digest')
  };
  return Object.freeze({
    ...fields,
    fingerprint: canonicalSha256({
      schemaVersion: updatePreviewSchemaVersion,
      kind: 'liftoff-update-plan',
      ...fields
    })
  });
}

export function createUpdatePreviewDescriptor(input: UpdatePreviewInput): UpdatePreviewDescriptor {
  // Array order is retained: execution order and command argument order can be semantic.
  return descriptorFromDigests({
    projectRoot: input.projectRoot,
    cliVersion: input.cliVersion,
    mode: input.mode,
    sourceDigest: semanticDigest(input.source),
    targetDigest: semanticDigest(input.target),
    operationsDigest: semanticDigest(input.operations)
  });
}

export function validateUpdatePreviewDescriptor(value: unknown): UpdatePreviewDescriptor {
  if (!isRecord(value)) invalid('Preview descriptor must be an object.');
  strictKeys(value, [
    'projectRoot', 'cliVersion', 'mode', 'sourceDigest', 'targetDigest', 'operationsDigest', 'fingerprint'
  ], 'Preview descriptor');
  if (value.mode !== 'normal' && value.mode !== 'force') invalid('Preview mode must be normal or force.');
  const descriptor = descriptorFromDigests({
    projectRoot: text(value.projectRoot, 'Preview project root'),
    cliVersion: text(value.cliVersion, 'Preview CLI version'),
    mode: value.mode,
    sourceDigest: digest(value.sourceDigest, 'Preview source digest'),
    targetDigest: digest(value.targetDigest, 'Preview target digest'),
    operationsDigest: digest(value.operationsDigest, 'Preview operations digest')
  });
  if (descriptor.projectRoot !== value.projectRoot || descriptor.fingerprint !== value.fingerprint) {
    invalid('Preview descriptor fingerprint or canonical project root is inconsistent.');
  }
  return descriptor;
}

export function createUpdatePreviewReceipt(
  descriptors: readonly UpdatePreviewDescriptor[],
  issuance: UpdatePreviewIssuance
): UpdatePreviewReceipt {
  if (descriptors.length < 1 || descriptors.length > 2) invalid('A preview receipt needs one or two eligible variants.');
  const variants = descriptors.map(validateUpdatePreviewDescriptor)
    .sort((left, right) => left.mode === right.mode ? 0 : left.mode === 'normal' ? -1 : 1);
  const first = variants[0];
  if (new Set(variants.map((variant) => variant.mode)).size !== variants.length) {
    invalid('A preview receipt cannot repeat an effective mode.');
  }
  if (variants.some((variant) => variant.projectRoot !== first.projectRoot || variant.cliVersion !== first.cliVersion)) {
    invalid('Preview variants must bind the same canonical project and installed CLI.');
  }
  if (!receiptIdPattern.test(issuance.receiptId)) invalid('Preview receiptId must be a lowercase UUID.');
  const issuedAt = Date.parse(issuance.issuedAt);
  if (!Number.isFinite(issuedAt) || new Date(issuedAt).toISOString() !== issuance.issuedAt) {
    invalid('Preview issuedAt must be an ISO UTC timestamp.');
  }
  return Object.freeze({
    schemaVersion: updatePreviewSchemaVersion,
    kind: 'liftoff-update-preview',
    projectRoot: first.projectRoot,
    projectKey: updatePreviewProjectKey(first.projectRoot),
    receiptId: issuance.receiptId,
    issuedAt: issuance.issuedAt,
    variants: Object.freeze(variants)
  });
}

export function validateUpdatePreviewReceipt(
  value: unknown,
  options: { projectRoot?: string; now?: Date } = {}
): UpdatePreviewReceipt {
  if (!isRecord(value)) invalid('Preview receipt must be an object.');
  if (value.schemaVersion !== updatePreviewSchemaVersion) {
    throw new UpdatePreviewError('preview-unsupported', 'Unsupported or missing preview receipt schema; expected schema 1.');
  }
  strictKeys(value, [
    'schemaVersion', 'kind', 'projectRoot', 'projectKey', 'receiptId', 'issuedAt', 'variants'
  ], 'Preview receipt');
  if (value.kind !== 'liftoff-update-preview' || !Array.isArray(value.variants)) invalid('Invalid preview receipt kind or variants.');
  const receipt = createUpdatePreviewReceipt(value.variants.map(validateUpdatePreviewDescriptor), {
    receiptId: text(value.receiptId, 'Preview receiptId'),
    issuedAt: text(value.issuedAt, 'Preview issuedAt')
  });
  if (value.projectRoot !== receipt.projectRoot || value.projectKey !== receipt.projectKey) {
    invalid('Preview receipt project identity is inconsistent.');
  }
  if (options.projectRoot !== undefined &&
      receipt.projectRoot !== normalizeUpdatePreviewProjectRoot(options.projectRoot)) {
    throw new UpdatePreviewError('preview-mismatch', 'Preview belongs to a different project or worktree. Run liftoff update --check.');
  }
  if (options.now !== undefined &&
      (!Number.isFinite(options.now.getTime()) || Date.parse(receipt.issuedAt) > options.now.getTime())) {
    invalid('Preview receipt is dated in the future or the current clock is invalid.');
  }
  return receipt;
}

export function matchUpdatePreviewReceipt(
  receipt: unknown,
  currentDescriptor: UpdatePreviewDescriptor
): UpdatePreviewDescriptor {
  const current = validateUpdatePreviewDescriptor(currentDescriptor);
  const validated = validateUpdatePreviewReceipt(receipt, { projectRoot: current.projectRoot });
  const matched = validated.variants.find((variant) => variant.mode === current.mode);
  if (!matched || matched.fingerprint !== current.fingerprint) {
    throw new UpdatePreviewError(
      'preview-mismatch',
      `The ${current.mode} preview is missing or stale for the current inputs, target, or operations. Run liftoff update --check.`
    );
  }
  return current;
}
