import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { findProjectRoot } from '../../adapters/filesystem/project-discovery.js';
import type { UpdatePreviewOptions } from '../../adapters/filesystem/update-previews.js';
import type { ExecutionContext } from '../context.js';
import {
  requestUpdateApproval
} from '../update/approval.js';
import {
  applyWorkflowTransitionPlan,
  recoverWorkflowTransitionPlan,
  type WorkflowTransitionExecutionOutcome
} from './execution.js';
import {
  assertWorkflowTransitionPlanCurrent,
  isCurrentWorkflowSelection,
  prepareWorkflowTransitionPlan,
  readWorkflowTransitionPlan,
  readWorkflowTransitionPlanForRecovery,
  workflowSelectionMatches,
  workflowTransitionPlanError,
  type WorkflowTransitionPlanReport,
  type WorkflowTransitionTarget
} from './plan.js';
import {
  workflowTransitionRequestIssue,
  type WorkflowTransitionRequest
} from './request.js';

export const workflowTransitionReportSchemaVersion = 1 as const;

export interface WorkflowTransitionCommandReport {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-workflow-transition';
  readonly command: 'workflow set';
  readonly operation: 'check' | 'apply' | 'recover';
  readonly projectRoot: string;
  readonly status:
    | 'current'
    | 'review-required'
    | 'declined'
    | 'applied'
    | 'recovered'
    | 'execution-unavailable'
    | 'recovery-unavailable'
    | 'blocked';
  readonly exitCode: 0 | 1 | 2;
  readonly readOnly: boolean;
  readonly projectWrites: boolean;
  readonly transaction:
    | 'not-started'
    | WorkflowTransitionExecutionOutcome;
  readonly plan: WorkflowTransitionPlanReport | null;
  readonly planStoragePath: string | null;
  readonly diagnostics: readonly string[];
  readonly limitations: readonly string[];
}

function render(
  report: WorkflowTransitionCommandReport,
  context: ExecutionContext,
  json: boolean
): number {
  if (json) {
    context.presentation.rawStdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    context.presentation.commandIdentity(
      'workflow set',
      'Reviewed development-workflow transition'
    );
    context.presentation.definitions('Selected scope', [
      { label: 'Project', value: report.projectRoot },
      { label: 'Operation', value: report.operation },
      { label: 'Status', value: report.status },
      {
        label: 'Plan',
        value: report.plan?.fingerprint ?? 'unavailable'
      }
    ]);
    context.presentation.status(
      report.exitCode === 0
        ? 'success'
        : report.exitCode === 1 ? 'error' : 'warning',
      report.status,
      [...report.diagnostics, ...report.limitations].join(' ')
    );
  }
  context.outcome?.record(
    report.exitCode === 0
      ? 'success'
      : report.exitCode === 2 ? 'attention-required' : 'failure'
  );
  return report.exitCode;
}

export async function setProjectWorkflow(
  request: WorkflowTransitionRequest,
  context: ExecutionContext
): Promise<number> {
  let operation = request.recover
    ? 'recover' as const
    : request.approvePlan ? 'apply' as const : 'check' as const;
  let projectRoot = path.resolve(context.cwd, request.project ?? '.');
  const limitations = Object.freeze([
    'Only an initialized OpenSpec or Spec Kit project can currently execute an exact transition to Manual.',
    'Application files, Git history, framework specifications/history, deployment/state, global tools and shared profiles are preserved.',
    'OpenSpec/Spec Kit target staging and other workflow directions remain unavailable until separately qualified.'
  ]);
  const report = (
    status: WorkflowTransitionCommandReport['status'],
    exitCode: 0 | 1 | 2,
    plan: WorkflowTransitionPlanReport | null,
    planStoragePath: string | null,
    diagnostics: readonly string[],
    transaction:
      | 'not-started'
      | WorkflowTransitionExecutionOutcome = 'not-started'
  ): WorkflowTransitionCommandReport => Object.freeze({
    schemaVersion: workflowTransitionReportSchemaVersion,
    kind: 'liftoff-workflow-transition',
    command: 'workflow set',
    operation,
    projectRoot,
    status,
    exitCode,
    readOnly: operation === 'check',
    projectWrites: transaction !== 'not-started' && transaction.committed,
    transaction,
    plan,
    planStoragePath,
    diagnostics: Object.freeze([...diagnostics]),
    limitations
  });
  try {
    const issue = workflowTransitionRequestIssue(request);
    if (issue) return render(
      report('blocked', 1, null, null, [issue]),
      context,
      request.json
    );
    if (!request.project) {
      const found = await findProjectRoot(context.cwd);
      if (!found) {
        return render(report('blocked', 1, null, null, [
          'No Liftoff project was found; select an exact manifest-v8 project path.'
        ]), context, request.json);
      }
      projectRoot = found;
    }
    projectRoot = await realpath(projectRoot);
    const storage: UpdatePreviewOptions = {
      ...context.updatePreview,
      env: context.updatePreview?.env ?? context.env,
      clock: context.updatePreview?.clock ?? context.updateNow
    };
    const now = context.updateNow?.() ?? new Date();
    const target = request.target as WorkflowTransitionTarget;
    if (request.recover) {
      const selected = await readWorkflowTransitionPlanForRecovery(
        projectRoot,
        request.approvePlan!,
        now,
        storage
      );
      if (!workflowSelectionMatches(selected, {
        target,
        agents: request.agents,
        defaultAgent: request.defaultAgent
      })) {
        return render(report('blocked', 1, selected, null, [
          'The requested workflow or agent selection does not match the saved plan.'
        ]), context, request.json);
      }
      if (selected.execution.status !== 'ready-for-file-approval') {
        return render(report(
          'recovery-unavailable',
          1,
          selected,
          null,
          ['No authenticated workflow transition transaction can exist for this non-executable plan.']
        ), context, request.json);
      }
      const recovered = await recoverWorkflowTransitionPlan(
        projectRoot,
        selected.fingerprint,
        { now, storage }
      );
      const transaction = recovered.outcome;
      if (transaction.status === 'absent') {
        return render(report(
          'recovery-unavailable',
          1,
          recovered.plan,
          null,
          ['No authenticated workflow transition transaction exists for this plan.'],
          transaction
        ), context, request.json);
      }
      return render(report(
        transaction.status === 'blocked' ? 'blocked' : 'recovered',
        transaction.status === 'blocked'
          ? 1
          : transaction.status === 'committed-readback-failed' ||
              transaction.status === 'committed-cleanup-pending'
            ? 2
            : 0,
        recovered.plan,
        null,
        transaction.status === 'blocked'
          ? transaction.rollbackFailures
          : ['Authenticated workflow transition recovery completed.'],
        transaction
      ), context, request.json);
    }
    if (!request.approvePlan) {
      const prepared = await prepareWorkflowTransitionPlan(
        projectRoot,
        target,
        {
          agents: request.agents,
          defaultAgent: request.defaultAgent,
          now,
          storage
        }
      );
      if (isCurrentWorkflowSelection(prepared.plan)) {
        return render(report(
          'current', 0, prepared.plan, prepared.path,
          ['The recorded workflow and selected agents already match the exact target.']
        ), context, request.json);
      }
      if (request.check || request.json) {
        return render(report(
          'review-required', 2, prepared.plan, prepared.path,
          ['Review the exact source, target, agent selection, current inputs, checks, effects and expiry. No transition effects are authorized.']
        ), context, request.json);
      }
      if (prepared.plan.execution.status !==
          'ready-for-file-approval') {
        return render(report(
          'execution-unavailable', 2, prepared.plan, prepared.path,
          ['This workflow direction has no qualified transition executor; no project write was attempted.']
        ), context, request.json);
      }
      const approval = await requestUpdateApproval({
        fingerprint: prepared.plan.fingerprint,
        message:
          `Apply this exact workflow transition (${prepared.plan.fingerprint})?`
      }, {
        stdin: context.stdin,
        stderr: context.stderr,
        approveUpdatePlan: context.approveWorkflowTransitionPlan
      });
      if (approval.status !== 'approved') {
        return render(report(
          approval.status === 'declined' ? 'declined' : 'review-required',
          2,
          prepared.plan,
          prepared.path,
          [approval.status === 'declined'
            ? 'Workflow transition declined; no project write was attempted.'
            : 'Exact approval is required; non-interactive and non-TTY execution only preview.']
        ), context, request.json);
      }
      operation = 'apply';
      const transaction = await applyWorkflowTransitionPlan(
        prepared.plan,
        { now, storage }
      );
      return render(report(
        transaction.committed ? 'applied' : 'blocked',
        transaction.committed
          ? transaction.status === 'committed'
            ? 0
            : 2
          : 1,
        prepared.plan,
        prepared.path,
        transaction.committed
          ? ['The exact Manual workflow transition committed.']
          : transaction.rollbackFailures,
        transaction
      ), context, request.json);
    }
    const plan = await readWorkflowTransitionPlan(
      projectRoot,
      request.approvePlan,
      now,
      storage
    );
    if (!workflowSelectionMatches(plan, {
      target,
      agents: request.agents,
      defaultAgent: request.defaultAgent
    })) {
      return render(report('blocked', 1, plan, null, [
        'The requested workflow or agent selection does not match the saved plan.'
      ]), context, request.json);
    }
    await assertWorkflowTransitionPlanCurrent(plan);
    if (plan.execution.status !== 'ready-for-file-approval') {
      return render(report('execution-unavailable', 2, plan, null, [
        'The exact plan is current, but this workflow direction has no qualified transition executor.'
      ]), context, request.json);
    }
    const transaction = await applyWorkflowTransitionPlan(
      plan,
      { now, storage }
    );
    return render(report(
      transaction.committed ? 'applied' : 'blocked',
      transaction.committed
        ? transaction.status === 'committed'
          ? 0
          : 2
        : 1,
      plan,
      null,
      transaction.committed
        ? ['The exact Manual workflow transition committed.']
        : transaction.rollbackFailures,
      transaction
    ), context, request.json);
  } catch (error) {
    return render(report('blocked', 1, null, null, [
      workflowTransitionPlanError(error)
    ]), context, request.json);
  }
}
