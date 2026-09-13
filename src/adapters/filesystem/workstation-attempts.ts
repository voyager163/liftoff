import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import type {
  NoProgressRemediationAttempt,
  WorkstationNoProgressStore
} from '../../domain/workstation/contracts.js';
import { workstationRequirementCatalog } from '../../workstation-catalog.js';
import { createScopedUserLocalRecordStore, type UpdatePreviewOptions } from './update-previews.js';

export interface WorkstationNoProgressReceipt extends NoProgressRemediationAttempt {
  schemaVersion: 1;
  kind: 'liftoff-workstation-no-progress';
}

export class WorkstationAttemptStoreError extends Error {
  readonly code = 'workstation-attempt-storage';

  constructor(message: string) {
    super(message);
    this.name = 'WorkstationAttemptStoreError';
  }
}

const fingerprintPattern = /^[a-f0-9]{64}$/u;
const attemptFields = ['recipeId', 'inputFingerprint', 'outputFingerprint', 'outcome'];
const receiptFields = ['schemaVersion', 'kind', ...attemptFields];

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function validateLookup(recipeId: string, inputFingerprint: string): void {
  const registered = typeof recipeId === 'string' && Object.values(workstationRequirementCatalog)
    .some((definition) => definition.remedies?.some((recipe) => recipe.id === recipeId));
  if (!registered || typeof inputFingerprint !== 'string' || !fingerprintPattern.test(inputFingerprint)) {
    throw new WorkstationAttemptStoreError('Workstation no-progress history requires a registered recipe and complete lowercase SHA-256 fingerprint.');
  }
}

export function workstationNoProgressKey(recipeId: string, inputFingerprint: string): string {
  validateLookup(recipeId, inputFingerprint);
  return canonicalSha256({ recipeId, inputFingerprint });
}

function validatedAttempt(value: Record<string, unknown>, recipeId: string, inputFingerprint: string): NoProgressRemediationAttempt {
  if (value.recipeId !== recipeId || value.inputFingerprint !== inputFingerprint ||
      value.outputFingerprint !== inputFingerprint || value.outcome !== 'unchanged') {
    throw new WorkstationAttemptStoreError('Invalid workstation no-progress receipt: the recipe and unchanged before/after fingerprints must match the requested binding.');
  }
  return { recipeId, inputFingerprint, outputFingerprint: inputFingerprint, outcome: 'unchanged' };
}

/** Bind to an existing invocation root, never an ephemeral command directory or an uncreated project destination. */
export function createWorkstationNoProgressStore(
  invocationRoot: string,
  options: UpdatePreviewOptions = {}
): WorkstationNoProgressStore {
  const records = createScopedUserLocalRecordStore(invocationRoot, 'workstation-remediation', {
    ...options,
    env: { ...(options.env ?? process.env) }
  });
  return {
    async find(recipeId, inputFingerprint) {
      const key = workstationNoProgressKey(recipeId, inputFingerprint);
      try {
        const record = await records.read(key);
        if (!record) return null;
        if (!isRecord(record.value) || !exactFields(record.value, receiptFields) ||
            record.value.schemaVersion !== 1 || record.value.kind !== 'liftoff-workstation-no-progress') {
          throw new WorkstationAttemptStoreError('Invalid workstation no-progress receipt: exact schema 1 metadata is required.');
        }
        return validatedAttempt(record.value, recipeId, inputFingerprint);
      } catch (error) {
        if (error instanceof WorkstationAttemptStoreError) throw error;
        throw new WorkstationAttemptStoreError('Unable to read private workstation no-progress history; malformed or inaccessible history was not ignored.');
      }
    },
    async record(attempt) {
      if (!isRecord(attempt) || !exactFields(attempt, attemptFields)) {
        throw new WorkstationAttemptStoreError('Workstation no-progress receipts may contain only the registered recipe, fingerprints, and unchanged outcome.');
      }
      const key = workstationNoProgressKey(attempt.recipeId, attempt.inputFingerprint);
      const verified = validatedAttempt(attempt, attempt.recipeId, attempt.inputFingerprint);
      const receipt: WorkstationNoProgressReceipt = {
        schemaVersion: 1, kind: 'liftoff-workstation-no-progress', ...verified
      };
      try {
        await records.write(key, receipt);
      } catch {
        throw new WorkstationAttemptStoreError('Unable to preserve immutable workstation no-progress history; existing records were not replaced.');
      }
    }
  };
}
