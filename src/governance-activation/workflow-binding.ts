import { createHash } from 'node:crypto';
import { GitHubActivationError } from '../adapters/github/activation-rest.js';
import { freezeModernValue } from '../domain/governance/activation/modern-graph.js';
import { assertModernRecordData, assertSafeControlRecord } from '../domain/governance/activation/source-values.js';

export function workflowFailure(code: string, message: string): never {
  throw new GitHubActivationError(code, message);
}
export function captureWorkflowBinding<T>(value: T): T {
  assertModernRecordData(value, 'workflow binding');
  assertSafeControlRecord(value, () => workflowFailure('workflow-sensitive',
    'Workflow control bindings must be plain payload-free public data; sensitive or executable content is prohibited.'));
  return freezeModernValue(structuredClone(value));
}
export async function recordWorkflowCheckpoint<T>(writer: (checkpoint: T) => Promise<void>, checkpoint: T): Promise<void> {
  try { await writer(captureWorkflowBinding(checkpoint)); } catch {
    return workflowFailure('workflow-durability', 'The exact workflow checkpoint was not durably confirmed. Diagnostics were withheld; retain partial effects and never repeat uncertain work.');
  }
}
export function workflowByteDigest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function workflowDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    return workflowFailure('workflow-digest', 'Workflow source requires an exact raw SHA-256 byte digest.');
  }
  return value;
}
