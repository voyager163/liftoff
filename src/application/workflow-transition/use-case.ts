import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { findProjectRoot } from '../../adapters/filesystem/project-discovery.js';
import type { UpdatePreviewOptions } from '../../adapters/filesystem/update-previews.js';
import type { ExecutionContext } from '../context.js';
import {
  assertWorkflowTransitionPlanCurrent,
  isCurrentWorkflowSelection,
  prepareWorkflowTransitionPlan,
  readWorkflowTransitionPlan,
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
    | 'execution-unavailable'
    | 'recovery-unavailable'
    | 'blocked';
  readonly exitCode: 0 | 1 | 2;
  readonly readOnly: boolean;
  readonly projectWrites: false;
  readonly transaction: 'not-started';
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
  const operation = request.recover
    ? 'recover' as const
    : request.approvePlan ? 'apply' as const : 'check' as const;
  let projectRoot = path.resolve(context.cwd, request.project ?? '.');
  const limitations = Object.freeze([
    'Schema 1 registers exact workflow transition planning and authority selection only; transition executors are not yet available.',
    'Application files, Git history, framework specifications/history, deployment/state, global tools and shared profiles are not changed.',
    'An agent, JSON output, force, generic yes, saved plan or successful check cannot authorize project writes.'
  ]);
  const report = (
    status: WorkflowTransitionCommandReport['status'],
    exitCode: 0 | 1 | 2,
    plan: WorkflowTransitionPlanReport | null,
    planStoragePath: string | null,
    diagnostics: readonly string[]
  ): WorkflowTransitionCommandReport => Object.freeze({
    schemaVersion: workflowTransitionReportSchemaVersion,
    kind: 'liftoff-workflow-transition',
    command: 'workflow set',
    operation,
    projectRoot,
    status,
    exitCode,
    readOnly: true,
    projectWrites: false,
    transaction: 'not-started',
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
      return render(report(
        'review-required', 2, prepared.plan, prepared.path,
        ['Review the exact source, target, agent selection, current inputs, checks and expiry. No transition effects are authorized.']
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
    if (request.recover) {
      return render(report('recovery-unavailable', 1, plan, null, [
        'No authenticated workflow transition transaction exists for this planning-only implementation.'
      ]), context, request.json);
    }
    return render(report('execution-unavailable', 2, plan, null, [
      'The exact plan is current, but no workflow transition executor is registered yet; no project write was attempted.'
    ]), context, request.json);
  } catch (error) {
    return render(report('blocked', 1, null, null, [
      workflowTransitionPlanError(error)
    ]), context, request.json);
  }
}
