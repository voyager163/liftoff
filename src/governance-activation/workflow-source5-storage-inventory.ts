import { workflowSource5ControlLimits } from '../adapters/filesystem/update-previews.js';
import type { createWorkflowSource5ControlStore, WorkflowSource5ControlNamespace } from '../adapters/filesystem/update-previews.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { captureWorkflowBinding, workflowFailure } from './workflow-binding.js';
import { source5MaximumEffectEntries } from './workflow-source5-operations.js';
import { source5OwnershipMaximumGeneration } from './workflow-source5-ownership.js';

export interface Source5WorkflowStorageBound {
  readonly namespace: WorkflowSource5ControlNamespace;
  readonly key: string;
  readonly maximumEncodedBytes: number;
  readonly maximumRevisions: number;
}
// Each four-field descriptor consumes nine safe-record nodes; reserve scope/envelope nodes without widening that validator.
export const source5MaximumStorageKeys = Math.min(
  source5MaximumEffectEntries * (2 * source5OwnershipMaximumGeneration + 19) + 8,
  Math.floor((200_000 - 2048) / 9)
);

/** This is an exact metadata description, never an operation or directory capability. */
export async function measureSource5WorkflowStorageInventory(
  store: ReturnType<typeof createWorkflowSource5ControlStore>, key: string,
  scope: Readonly<Record<string, unknown>>, requested: readonly Source5WorkflowStorageBound[]
) {
  const objects = requested.map(object => captureWorkflowBinding(object));
  if (objects.length + 1 > source5MaximumStorageKeys) {
    return workflowFailure('workflow-source5-storage-inventory', 'The finite concrete workflow storage-key inventory exceeds its supported bound.');
  }
  const keys = new Set<string>();
  for (const object of objects) {
    const identity = `${object.namespace}:${object.key}`;
    if (!Object.hasOwn(workflowSource5ControlLimits, object.namespace) ||
      !/^[a-f0-9]{64}$/u.test(object.key) || keys.has(identity) ||
      object.namespace === 'proof' && object.key === key ||
      canonicalSha256(Object.keys(object).sort()) !== canonicalSha256(['key', 'maximumEncodedBytes', 'maximumRevisions', 'namespace']) ||
      !Number.isSafeInteger(object.maximumEncodedBytes) || object.maximumEncodedBytes < 1 ||
      object.maximumEncodedBytes > workflowSource5ControlLimits[object.namespace] ||
      !Number.isSafeInteger(object.maximumRevisions) || object.maximumRevisions < 1 ||
      object.maximumRevisions > source5OwnershipMaximumGeneration + 1) {
      return workflowFailure('workflow-source5-storage-inventory', 'Concrete workflow keys must be unique, closed, finite and fit their complete sealed-object namespace caps.');
    }
    keys.add(identity);
  }
  const self = { namespace: 'proof' as const, key, maximumEncodedBytes: 0, maximumRevisions: 1 };
  const value = { ...captureWorkflowBinding(scope), kind: 'workflow-source5-storage-inventory',
    objects: [...objects, self], maximumEncodedFootprint: 0 };
  for (let attempt = 0; ; attempt++) {
    value.maximumEncodedFootprint = value.objects.reduce((total, object) =>
      total + object.maximumEncodedBytes * object.maximumRevisions, 0);
    if (!Number.isSafeInteger(value.maximumEncodedFootprint)) {
      return workflowFailure('workflow-source5-storage-inventory', 'Complete encoded workflow storage footprint cannot be represented exactly.');
    }
    const bytes = await store.measure('proof', key, value);
    if (bytes === self.maximumEncodedBytes) break;
    if (attempt === 8) return workflowFailure('workflow-source5-storage-inventory', 'The complete sealed key manifest cannot be represented within its finite bound.');
    self.maximumEncodedBytes = bytes;
  }
  return captureWorkflowBinding({ value, digest: canonicalSha256(value) });
}
