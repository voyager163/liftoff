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
