import { GitHubActivationClient, GitHubActivationError } from '../adapters/github/activation-rest.js';
import type { GitHubActivationTransport } from '../adapters/github/activation-rest.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { assertGitHubAuthorized, clientFor } from './github-config.js';
import { assertGovernanceApprovalIssued } from './authority-records.js';
import { freezeModernValue } from '../domain/governance/activation/modern-graph.js';
import {
  approvalRequestForSavedPlan, evaluateApprovalForTransitionPlan
} from '../domain/governance/activation/approvals.js';
import type { TransitionOperation } from '../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput } from './transition-ports.js';
import type { CommandRunner } from '../process-runner.js';
import type { Source5WorkflowEffectInput } from './workflow-source5-ports.js';
import {
  isSource5WorkflowEffectInput, assertSource5WorkflowEffectContext,
  requestSource5WorkflowEffect, runSource5WorkflowGitEffect
} from './workflow-source5-ports.js';
import { assertSource5WorkflowAuthority } from './workflow-source5-authority.js';
import { source5WorkflowActions, source5WorkflowOperation } from './workflow-source5-operations.js';

import { workflowByteDigest, workflowFailure, workflowGitCommand, workflowGitOptions } from './workflow-binding.js';
import { workflowPlannedOperation } from './workflow-operations.js';
export { workflowPlannedOperation } from './workflow-operations.js';
export { workflowFailure, captureWorkflowBinding, recordWorkflowCheckpoint, workflowByteDigest, workflowDigest } from './workflow-binding.js';
export type WorkflowEffectInput = PhaseAdapterExecutionInput | Source5WorkflowEffectInput;
export function workflowProjectRoot(input: WorkflowEffectInput): string {
  return isSource5WorkflowEffectInput(input) ? input.projectRoot : input.inspection.projectRoot;
}
export function workflowReviewedPlans(input: WorkflowEffectInput) {
  return isSource5WorkflowEffectInput(input) ? [input.plan, ...input.reviewedPlans] :
    [input.plan, ...Object.values(input.inspection.contexts).flatMap(context => context.reviewedPlans ?? [])];
}

export async function assertWorkflowAuthority(
  input: WorkflowEffectInput, operation: TransitionOperation
): Promise<void> {
  if (isSource5WorkflowEffectInput(input)) {
    assertSource5WorkflowEffectContext(input);
    if (input.observationOnly) return workflowFailure('workflow-observation-only', 'Recorded workflow observation cannot acquire write authority or repeat an effect.');
    return assertSource5WorkflowAuthority({ authority: input.authority, projectRoot: input.projectRoot,
      plan: input.plan, operation: { ...operation, phaseId: input.phase.id },
      now: input.clock?.() ?? input.now, clock: input.clock, write: true });
  }
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
export async function assertWorkflowObservationAuthority(input: WorkflowEffectInput, operation: TransitionOperation): Promise<void> {
  if (!isSource5WorkflowEffectInput(input)) return assertWorkflowAuthority(input, operation);
  assertSource5WorkflowEffectContext(input);
  await assertSource5WorkflowAuthority({ authority: input.authority, projectRoot: input.projectRoot,
    plan: input.plan, operation: { ...operation, phaseId: input.phase.id }, now: input.clock?.() ?? input.now, write: false });
}

export function workflowOperation(
  input: WorkflowEffectInput, actionId: string, binding: unknown
): TransitionOperation {
  if (isSource5WorkflowEffectInput(input)) {
    const base = (source5WorkflowActions[input.phase.id] as readonly string[]).find(base => base === actionId);
    if (!base) return workflowFailure('workflow-source5-action', 'Unknown indexed workflow action.');
    const allowed = source5WorkflowActions[input.phase.id].find(base => base === actionId)!;
    const expected = source5WorkflowOperation(input.phase.id, allowed, binding);
    const matches = input.plan.operations.filter(entry => canonicalSha256(entry) === canonicalSha256(expected));
    if (matches.length !== 1 || canonicalSha256(expected) !== canonicalSha256(input.operation)) {
      return workflowFailure('workflow-source5-plan', 'The selected exact indexed workflow binding must occur once in the reviewed current5 plan.');
    }
    return expected;
  }
  const matches = input.plan.operations.filter((entry) => entry.actionId === actionId);
  if (matches.length !== 1 || canonicalSha256(matches[0]) !==
    canonicalSha256(workflowPlannedOperation(input.phase.id, actionId, binding))) {
    return workflowFailure('workflow-plan', 'The exact source, ref, recipe and proof binding must be present once in the reviewed operation; directory-wide or repository-only placeholders are not authority.');
  }
  return freezeModernValue(structuredClone(matches[0]!));
}

export interface WorkflowRuntime {
  client: GitHubActivationClient;
  git(args: readonly string[]): Promise<string>;
  assertWithinDeadline(): void;
}

export interface WorkflowObservationServices {
  readonly projectRoot: string;
  readonly runner: CommandRunner;
  readonly transport: GitHubActivationTransport;
}
export function workflowObservationRuntime(services: WorkflowObservationServices): WorkflowRuntime {
  return boundedWorkflowRuntime(services, true);
}
export function workflowRuntime(input: WorkflowEffectInput): WorkflowRuntime {
  if (isSource5WorkflowEffectInput(input)) assertSource5WorkflowEffectContext(input);
  const projectRoot = workflowProjectRoot(input);
  const underlying = isSource5WorkflowEffectInput(input) ? input.transport : clientFor(input).transport;
  const transport: GitHubActivationTransport = {
    async request(request) {
      if (isSource5WorkflowEffectInput(input) && request.method !== 'GET') {
        return requestSource5WorkflowEffect(input, request);
      }
      if (isSource5WorkflowEffectInput(input)) {
        await assertSource5WorkflowAuthority({ ...input, now: input.clock?.() ?? input.now, write: false });
      }
      return underlying.request(request);
    }
  };
  const runner: CommandRunner = isSource5WorkflowEffectInput(input) ? {
    async run(command, options) {
      await assertSource5WorkflowAuthority({ ...input, now: input.clock?.() ?? input.now, write: false });
      return input.runner.run(command, options);
    }
  } : input.runner;
  return boundedWorkflowRuntime({ projectRoot, transport, runner }, false,
    isSource5WorkflowEffectInput(input) ? (args, timeoutMs) => runSource5WorkflowGitEffect(input, args, timeoutMs) : undefined);
}
function readableGit(args: readonly string[]): boolean {
  const same = (expected: readonly string[]) => canonicalSha256(args) === canonicalSha256(expected);
  const sha = (value: string | undefined) => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
  return same(['symbolic-ref', '--short', 'HEAD']) || same(['remote', 'get-url', '--all', 'origin']) ||
    same(['remote', 'get-url', '--push', '--all', 'origin']) || same(['config', '--list', '--name-only']) ||
    same(['status', '--porcelain=v1', '--untracked-files=all']) || same(['diff', '--cached', '--name-only']) ||
    args.length === 3 && args[0] === 'rev-parse' && args[1] === '--verify' &&
      (args[2] === 'HEAD' || /^[a-f0-9]{40}\^\{tree\}$/u.test(args[2]!)) ||
    args.length === 2 && args[0] === 'show' && /^[a-f0-9]{40}:(?:\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml|governance\/rulesets\/[A-Za-z0-9_-]+\.json)$/u.test(args[1]!) ||
    args.length === 5 && sha(args[4]) && same(['rev-list', '--parents', '-n', '1', args[4]!]) ||
    args.length === 6 && sha(args[5]) && same(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', args[5]!]);
}
function boundedWorkflowRuntime(services: WorkflowObservationServices, readOnly: boolean,
  effectGit?: (args: readonly string[], timeoutMs: number) => ReturnType<CommandRunner['run']>): WorkflowRuntime {
  const deadline = Date.now() + 180_000;
  const projectRoot = services.projectRoot;
  function assertWithinDeadline() {
    if (Date.now() >= deadline) {
      return workflowFailure('workflow-deadline', 'Workflow observation reached its three-minute deadline. Retain dispatched work and observe it; never repeat an uncertain effect.');
    }
  }
  const underlying = services.transport;
  return {
    assertWithinDeadline,
    client: new GitHubActivationClient({
      async request(request) {
        assertWithinDeadline();
        if (readOnly && request.method !== 'GET') return workflowFailure('workflow-observation-only', 'Observation services cannot write provider state.');
        const responseDeadline = Math.min(deadline, Date.now() + 30_000);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadlineError = new GitHubActivationError('workflow-deadline',
          'Workflow provider response exceeded its bounded deadline; diagnostics were withheld and acceptance may be uncertain.');
        try {
          const response = await Promise.race([
            underlying.request(request),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(deadlineError),
              Math.max(0, responseDeadline - Date.now()));
            })
          ]);
          if (Date.now() >= responseDeadline) throw deadlineError;
          return response;
        } catch (error) {
          if (error === deadlineError) throw error;
          throw new GitHubActivationError('workflow-provider',
            'Workflow provider observation failed; diagnostics were withheld. Retain recorded intent because write acceptance may be uncertain.');
        } finally { if (timer) clearTimeout(timer); }
      }
    }),
    async git(args) {
      assertWithinDeadline();
      if (readOnly && !readableGit(args)) {
        return workflowFailure('workflow-observation-only', 'Observation services accept only bounded literal Git reads.');
      }
      const commandDeadline = Math.min(deadline, Date.now() + 30_000);
      let result;
      try { result = effectGit && !readableGit(args)
        ? await effectGit(args, Math.min(30_000, deadline - Date.now()))
        : await services.runner.run(workflowGitCommand(args), workflowGitOptions(projectRoot,
          Math.min(30_000, deadline - Date.now()))); } catch {
        return workflowFailure('workflow-git', 'The literal Git transport failed; diagnostics were withheld and recorded partial effects must be reconciled without repeating uncertain work.');
      }
      if (Date.now() >= commandDeadline || result.status !== 0 || result.timedOut ||
        result.outputLimitExceeded || result.errorCode || result.aborted) {
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
