import { createHash } from 'node:crypto';
import { devNull } from 'node:os';
import { GitHubActivationClient, GitHubActivationError } from '../adapters/github/activation-rest.js';
import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { assertGitHubAuthorized, clientFor } from './github-config.js';
import { assertGovernanceApprovalIssued } from './authority-records.js';
import { freezeModernValue } from '../domain/governance/activation/modern-graph.js';
import { assertModernRecordData, assertSafeControlRecord } from '../domain/governance/activation/source-values.js';
import {
  approvalRequestForSavedPlan, evaluateApprovalForTransitionPlan
} from '../domain/governance/activation/approvals.js';
import type { PhaseId, TransitionOperation } from '../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput } from './transition-ports.js';

export function workflowFailure(code: string, message: string): never {
  throw new GitHubActivationError(code, message);
}

export function captureWorkflowBinding<T>(value: T): T {
  assertModernRecordData(value, 'workflow binding');
  assertSafeControlRecord(value, () => workflowFailure('workflow-sensitive',
    'Workflow control bindings must be plain payload-free public data; sensitive or executable content is prohibited.'));
  return freezeModernValue(structuredClone(value));
}

export async function recordWorkflowCheckpoint<T>(
  writer: (checkpoint: T) => Promise<void>, checkpoint: T
): Promise<void> {
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

export async function assertWorkflowAuthority(
  input: PhaseAdapterExecutionInput, operation: TransitionOperation
): Promise<void> {
  await assertGitHubAuthorized(input, operation);
  if (!input.lease || !input.phase.approvalGate.required ||
    [operation, ...operation.effects ?? []].some((effect) =>
      !input.phase.allowedMutations[effect.remote ? 'remote' : 'local'].includes(effect.mutationClass))) {
    return workflowFailure('workflow-authority', 'Workflow effects require a held project lease and an explicitly gated phase permitting the exact effect; legacy local source authority is not publication approval.');
  }
  const envelope = input.inspection.approvals.find((entry) => entry.id === input.plan.approval.envelopeId);
  if (!envelope) return workflowFailure('workflow-authority', 'Workflow effects require independently issued current approval.');
  const approval = evaluateApprovalForTransitionPlan(
    approvalRequestForSavedPlan(input.plan, input.phase, input.inspection.state),
    input.inspection.approvals, { now: input.clock?.() ?? input.now }
  );
  if (approval.approvalRequired || approval.envelopeHash !== input.plan.approval.envelopeHash) {
    return workflowFailure('workflow-authority', 'The issued workflow approval does not cover the unchanged exact source, destination and effect scope.');
  }
  await assertGovernanceApprovalIssued(input.inspection.projectRoot, envelope);
}

export function workflowOperation(
  input: PhaseAdapterExecutionInput, actionId: string, binding: unknown
): TransitionOperation {
  const matches = input.plan.operations.filter((entry) => entry.actionId === actionId);
  if (matches.length !== 1 || canonicalSha256(matches[0]) !==
    canonicalSha256(workflowPlannedOperation(input.phase.id, actionId, binding))) {
    return workflowFailure('workflow-plan', 'The exact source, ref, recipe and proof binding must be present once in the reviewed operation; directory-wide or repository-only placeholders are not authority.');
  }
  return freezeModernValue(structuredClone(matches[0]!));
}

export function workflowPlannedOperation(
  phaseId: PhaseId, actionId: string, binding: unknown
): TransitionOperation {
  if (!isRecord(binding) || typeof binding.repository !== 'string') {
    return workflowFailure('workflow-plan', 'Workflow planning requires its exact repository binding.');
  }
  const repository = binding.repository;
  const destination: TransitionOperation['destination'] = {
    type: 'repository', identity: repository, repository
  };
  const read: NonNullable<TransitionOperation['effects']>[number] = {
    mutationClass: 'github-read', destination, remote: true, destructive: false
  };
  if (actionId === 'git.workflow-source.publish-reviewed') {
    if (!Array.isArray(binding.files)) return workflowFailure('workflow-plan', 'Source planning requires its per-file inventory.');
    const writes: NonNullable<TransitionOperation['effects']>[number][] = binding.files.map((file) => {
      if (!isRecord(file) || typeof file.path !== 'string') return workflowFailure('workflow-plan', 'A reviewed source path is missing.');
      return {
        mutationClass: file.path.startsWith('.github/workflows/') ? 'write-workflows' : 'write-ruleset-source',
        destination: { type: 'local', identity: file.path, pathParts: file.path.split('/') },
        remote: false, destructive: false
      };
    });
    return {
      phaseId, actionId, adapter: 'git', mutationClass: 'git-push', destination,
      inputs: binding, remote: true, destructive: false,
      effects: [...writes, { mutationClass: 'git-commit',
        destination: { type: 'local', identity: '.git' }, remote: false, destructive: false }, read]
    };
  }
  if (actionId === 'github.workflow-source.admit-reviewed') {
    return {
      phaseId, actionId, adapter: 'github', mutationClass: 'github-write',
      destination: { type: 'external', identity: `/orgs/${repository.split('/')[0]}/actions/runner-groups/${binding.groupId}` },
      inputs: binding, remote: true, destructive: false, effects: [read]
    };
  }
  const actions = [
    'github.workflow-source.bind-execution-ref', 'github.checks.dev-proof', 'github.checks.staging',
    'github.checks.production-rehearsal', 'github.checks.green-red-proof'
  ];
  if (!actions.includes(actionId)) return workflowFailure('workflow-plan', 'The workflow source producer does not expose generic actions.');
  return {
    phaseId, actionId, adapter: 'github',
    mutationClass: actionId === 'github.workflow-source.bind-execution-ref' ? 'github-write' : 'github-workflow-dispatch',
    inputs: binding, destination: { ...destination, ref: `refs/tags/${binding.executionRef}` },
    remote: true, destructive: false, effects: [read]
  };
}

export interface WorkflowRuntime {
  client: GitHubActivationClient;
  git(args: readonly string[]): Promise<string>;
  assertWithinDeadline(): void;
}

export function workflowRuntime(input: PhaseAdapterExecutionInput): WorkflowRuntime {
  const deadline = Date.now() + 180_000;
  const projectRoot = input.inspection.projectRoot;
  function assertWithinDeadline() {
    if (Date.now() >= deadline) {
      return workflowFailure('workflow-deadline', 'Workflow observation reached its three-minute deadline. Retain dispatched work and observe it; never repeat an uncertain effect.');
    }
  }
  const underlying = clientFor(input);
  return {
    assertWithinDeadline,
    client: new GitHubActivationClient({
      async request(request) {
        assertWithinDeadline();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadlineError = new GitHubActivationError('workflow-deadline',
          'Workflow provider response exceeded its bounded deadline; diagnostics were withheld and acceptance may be uncertain.');
        try {
          return await Promise.race([
            underlying.transport.request(request),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(deadlineError),
              Math.min(30_000, deadline - Date.now()));
            })
          ]);
        } catch (error) {
          if (error === deadlineError) throw error;
          throw new GitHubActivationError('workflow-provider',
            'Workflow provider observation failed; diagnostics were withheld. Retain recorded intent because write acceptance may be uncertain.');
        } finally { if (timer) clearTimeout(timer); }
      }
    }),
    async git(args) {
      assertWithinDeadline();
      const command = { executable: 'git', args: [
        '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${devNull}`,
        '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
        '-c', 'push.followTags=false', '-c', 'push.recurseSubmodules=no',
        '-c', 'remote.origin.mirror=false', ...args
      ] };
      let result;
      try { result = await input.runner.run(command, {
        cwd: projectRoot, timeoutMs: Math.min(30_000, deadline - Date.now()),
        maxOutputBytes: 1024 * 1024, stream: false,
        env: {
          GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0',
          GIT_TRACE: '', GIT_TRACE_PACKET: '', GIT_TRACE_CURL: '', GIT_CURL_VERBOSE: '',
          GIT_TRACE_SETUP: '', GIT_TRACE2: '', GIT_TRACE2_EVENT: '', GIT_TRACE2_PERF: ''
        }
      }); } catch {
        return workflowFailure('workflow-git', 'The literal Git transport failed; diagnostics were withheld and recorded partial effects must be reconciled without repeating uncertain work.');
      }
      if (result.status !== 0 || result.timedOut || result.outputLimitExceeded || result.errorCode || result.aborted) {
        return workflowFailure('workflow-git', 'The literal reviewed Git operation was not confirmed within its time and output bounds; diagnostics were withheld.');
      }
      return result.stdout;
    }
  };
}

export async function readWorkflowBytes(
  client: GitHubActivationClient, repository: string, sha: string, path: string, digest: string
): Promise<Buffer> {
  const file = await client.get(`/repos/${repository}/contents/${path}?ref=${sha}`);
  if (file.type !== 'file' || file.path !== path || file.encoding !== 'base64' ||
    typeof file.content !== 'string' || file.content.length > 180_000 ||
    !/^[A-Za-z0-9+/=\s]+$/u.test(file.content)) {
    return workflowFailure('workflow-readback', 'The exact immutable source file was absent, oversized or not observable as a regular file.');
  }
  const bytes = Buffer.from(file.content.replace(/\s/gu, ''), 'base64');
  if (!bytes.length || bytes.length > 128 * 1024 || workflowByteDigest(bytes) !== digest) {
    return workflowFailure('workflow-readback', 'Immutable provider source bytes differ from the exact reviewed recipe.');
  }
  return bytes;
}
