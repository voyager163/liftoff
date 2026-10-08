import path from 'node:path';
import {
  createScopedUserLocalRecordStore,
  type UpdatePreviewOptions
} from '../../adapters/filesystem/update-previews.js';
import type {
  WorkflowTransitionTransactionAuthorityStore
} from '../../adapters/filesystem/reviewed-update-transaction.js';
import {
  canonicalSha256
} from '../../domain/governance/activation/canonical-json.js';

function digest(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(
      `${label} requires a complete lowercase SHA-256 digest.`
    );
  }
  return value;
}

export function createWorkflowTransitionTransactionAuthorityStore(
  projectRoot: string,
  options: UpdatePreviewOptions = {}
): WorkflowTransitionTransactionAuthorityStore {
  const root = path.resolve(projectRoot);
  if (!path.isAbsolute(projectRoot) || projectRoot !== root) {
    throw new Error(
      'Workflow transition authority requires a canonical absolute project root.'
    );
  }
  const store = createScopedUserLocalRecordStore(
    root, 'workflow-transition-transaction-authority', options
  );
  const key = (
    planFingerprint: string,
    transactionDigest: string,
    revoked = false
  ) => canonicalSha256({
    schemaVersion: 1,
    kind: 'liftoff-workflow-transition-transaction-authority-key',
    projectRoot: root,
    planFingerprint: digest(planFingerprint, 'Workflow transition plan'),
    transactionDigest: digest(
      transactionDigest, 'Workflow transition transaction'
    ),
    revoked
  });
  const body = (planFingerprint: string, transactionDigest: string) => ({
    schemaVersion: 1,
    kind: 'liftoff-workflow-transition-transaction-authority' as const,
    projectRoot: root,
    planFingerprint: digest(planFingerprint, 'Workflow transition plan'),
    transactionDigest: digest(
      transactionDigest, 'Workflow transition transaction'
    )
  });
  const authority = {
    transactionKind: 'workflow-transition' as const,
    projectRoot: root,
    write: async (planFingerprint: string, transactionDigest: string) => {
      await store.write(
        key(planFingerprint, transactionDigest),
        body(planFingerprint, transactionDigest)
      );
    },
    verify: async (planFingerprint: string, transactionDigest: string) => {
      const record = await store.read(
        key(planFingerprint, transactionDigest)
      );
      const revoked = await store.read(
        key(planFingerprint, transactionDigest, true)
      );
      return revoked === null && record !== null &&
        record.projectRoot === root &&
        canonicalSha256(record.value) ===
          canonicalSha256(body(planFingerprint, transactionDigest));
    },
    remove: async (planFingerprint: string, transactionDigest: string) => {
      await store.write(key(planFingerprint, transactionDigest, true), {
        ...body(planFingerprint, transactionDigest),
        revoked: true
      });
    }
  };
  Object.defineProperties(authority, {
    transactionKind: { writable: false, configurable: false },
    projectRoot: { writable: false, configurable: false }
  });
  return Object.freeze(authority);
}
