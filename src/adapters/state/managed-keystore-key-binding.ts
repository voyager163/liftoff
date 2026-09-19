import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { StateMigrationError } from '../../domain/repair/stateful.js';
import { PrivateLinuxKeySnapshot } from './linux-keystore-client-protocol.js';

const purpose = 'liftoff-managed-linux-key-binding/1';
const plaintext = Buffer.from('Liftoff managed key binding; not custody or readiness.', 'ascii');
const digestPattern = /^[a-f0-9]{64}$/u;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const contextKeys = [
  'projectId', 'hostRef', 'principalUid', 'enrollmentId', 'storeId', 'itemPath',
  'daemonDigest', 'dependencyInventoryDigest', 'helperDigest', 'persistedGenerationDigest'
] as const;

export interface ManagedKeystoreKeyContext {
  projectId: string;
  hostRef: string;
  principalUid: number;
  enrollmentId: string;
  storeId: string;
  itemPath: string;
  daemonDigest: string;
  dependencyInventoryDigest: string;
  helperDigest: string;
  persistedGenerationDigest: string;
}

export interface ManagedKeystoreKeyBinding {
  schemaVersion: 1;
  kind: typeof purpose;
  algorithm: 'aes-256-gcm';
  contextDigest: string;
  nonce: string;
  tag: string;
  ciphertext: string;
  evidence: 'key-binding-only';
  readiness: false;
}

function require(condition: unknown): asserts condition {
  if (!condition) throw new StateMigrationError('artifact-integrity');
}

function contextDigest(value: ManagedKeystoreKeyContext): string {
  require(isRecord(value) && Object.keys(value).length === contextKeys.length &&
    contextKeys.every((key) => Object.hasOwn(value, key)));
  require(typeof value.projectId === 'string' && /^[A-Za-z0-9_.:@/-]{1,256}$/u.test(value.projectId) &&
    typeof value.hostRef === 'string' && /^native-host:[a-f0-9]{64}$/u.test(value.hostRef) &&
    Number.isSafeInteger(value.principalUid) && value.principalUid >= 0 && value.principalUid <= 0xffffffff &&
    typeof value.enrollmentId === 'string' && uuidPattern.test(value.enrollmentId) &&
    typeof value.storeId === 'string' && uuidPattern.test(value.storeId) &&
    typeof value.itemPath === 'string' &&
    /^\/org\/freedesktop\/secrets\/collection\/login\/[A-Za-z0-9_]{1,128}$/u.test(value.itemPath));
  for (const key of ['daemonDigest', 'dependencyInventoryDigest', 'helperDigest', 'persistedGenerationDigest'] as const)
    require(typeof value[key] === 'string' && digestPattern.test(value[key]));
  return canonicalSha256({ purpose, context: value });
}

function decode(value: unknown, length: number): Buffer {
  require(typeof value === 'string' && value.length === Math.ceil(length / 3) * 4);
  const bytes = Buffer.from(value, 'base64');
  require(bytes.length === length && bytes.toString('base64') === value);
  return bytes;
}

function associatedData(digest: string): Buffer {
  return Buffer.from(canonicalJson({ purpose, contextDigest: digest }), 'utf8');
}

/** Consumes the original key snapshot; this record grants no native authority. */
export async function createManagedKeystoreKeyBinding(
  key: PrivateLinuxKeySnapshot, context: ManagedKeystoreKeyContext
): Promise<ManagedKeystoreKeyBinding> {
  try {
    const digest = contextDigest(context);
    return await key.consume((bytes) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', bytes, nonce);
      cipher.setAAD(associatedData(digest));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Object.freeze({
        schemaVersion: 1, kind: purpose, algorithm: 'aes-256-gcm', contextDigest: digest,
        nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'), evidence: 'key-binding-only', readiness: false
      });
    });
  } finally { key.release(); }
}

/** Fresh-process/host/persistence evidence must be independently established. */
export async function verifyManagedKeystoreKeyBinding(
  key: PrivateLinuxKeySnapshot, binding: unknown, context: ManagedKeystoreKeyContext
): Promise<{ matched: true; evidence: 'key-binding-only'; freshProcessVerified: false; readiness: false }> {
  try {
    const digest = contextDigest(context);
    require(isRecord(binding) &&
      Object.keys(binding).sort().join(',') === 'algorithm,ciphertext,contextDigest,evidence,kind,nonce,readiness,schemaVersion,tag' &&
      binding.schemaVersion === 1 && binding.kind === purpose && binding.algorithm === 'aes-256-gcm' &&
      binding.contextDigest === digest && binding.evidence === 'key-binding-only' && binding.readiness === false);
    const nonce = decode(binding.nonce, 12), tag = decode(binding.tag, 16);
    const ciphertext = decode(binding.ciphertext, plaintext.length);
    await key.consume((bytes) => {
      const cipher = createDecipheriv('aes-256-gcm', bytes, nonce);
      cipher.setAAD(associatedData(digest));
      cipher.setAuthTag(tag);
      let partial: Buffer | undefined;
      let completed: Buffer | undefined;
      try {
        partial = cipher.update(ciphertext);
        completed = cipher.final();
        const observed = Buffer.concat([partial, completed]);
        try { require(observed.length === plaintext.length && timingSafeEqual(observed, plaintext)); }
        finally { observed.fill(0); }
      } finally { partial?.fill(0); completed?.fill(0); }
    });
    return Object.freeze({ matched: true, evidence: 'key-binding-only', freshProcessVerified: false, readiness: false });
  } catch {
    throw new StateMigrationError('artifact-integrity');
  } finally { key.release(); }
}
