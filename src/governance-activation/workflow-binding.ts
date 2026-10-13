import { createHash } from 'node:crypto';
import { devNull } from 'node:os';
import { GitHubActivationError } from '../adapters/github/activation-rest.js';
import { freezeModernValue } from '../domain/governance/activation/modern-graph.js';
import { assertModernRecordData, assertSafeControlRecord } from '../domain/governance/activation/source-values.js';
import type { GitHubResponse } from '../adapters/github/activation-rest.js';
import { isRecord } from '../domain/governance/activation/canonical-json.js';
import type { WorkflowProofCheckpoint } from './workflow-context-proof.js';

export const workflowTerminalConclusions = [
  'success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale', 'startup_failure'
] as const;

export function readWorkflowDispatchHandle(
  response: GitHubResponse, repository: string
): Pick<WorkflowProofCheckpoint, 'runId' | 'runUrl' | 'htmlUrl'> | undefined {
  if (response.status === 204 && response.data === null) return undefined;
  const data = response.data;
  if (response.status !== 200 || !isRecord(data) ||
    !Number.isSafeInteger(data.workflow_run_id) || Number(data.workflow_run_id) <= 0 ||
    data.run_url !== `https://api.github.com/repos/${repository}/actions/runs/${data.workflow_run_id}` ||
    data.html_url !== `https://github.com/${repository}/actions/runs/${data.workflow_run_id}`) {
    return workflowFailure('workflow-dispatch-handle', 'The accepted dispatch response did not expose a valid exact-repository run ID and URLs. Retain intent; do not redispatch or expose provider diagnostics.');
  }
  return { runId: Number(data.workflow_run_id), runUrl: data.run_url, htmlUrl: data.html_url };
}

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
export function workflowGitCommand(args: readonly string[]) {
  return { executable: 'git', args: [
    '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${devNull}`,
    '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
    '-c', 'push.followTags=false', '-c', 'push.recurseSubmodules=no',
    '-c', 'remote.origin.mirror=false', ...args
  ] };
}
export function workflowGitOptions(projectRoot: string, timeoutMs: number) {
  return { cwd: projectRoot, timeoutMs, maxOutputBytes: 1024 * 1024, stream: false, env: {
    GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0',
    GIT_TRACE: '', GIT_TRACE_PACKET: '', GIT_TRACE_CURL: '', GIT_CURL_VERBOSE: '',
    GIT_TRACE_SETUP: '', GIT_TRACE2: '', GIT_TRACE2_EVENT: '', GIT_TRACE2_PERF: ''
  } };
}
