import type { UpdatePreviewOptions } from '../../adapters/filesystem/update-previews.js';
import {
  formatRequirementVersion
} from '../../domain/workstation/constraints.js';
import {
  InteractivePrompter,
  isInteractiveTerminal
} from '../../interactive.js';
import { NodeCommandRunner } from '../../process-runner.js';
import {
  applyWorkflowTransitionPlan,
  recoverWorkflowTransitionPlan
} from '../workflow-transition/execution.js';
import {
  agentRepairSelectionMatches,
  prepareWorkflowTransitionPlan,
  type WorkflowTransitionPlanReport
} from '../workflow-transition/plan.js';
import type { ExecutionContext } from '../context.js';
import { loadProjectManifest } from '../project/manifest.js';
import { requestRepairApproval } from './approval.js';
import { repairCapabilities } from './capabilities.js';
import { repairCommandAction, repairCheckAction } from './guidance.js';
import { emitRepairReport, type RepairReport } from './report.js';
import type { RepairRequest } from './request.js';

export async function repairAgentIntegrations(input: {
  readonly root: string;
  readonly request: RepairRequest;
  readonly context: ExecutionContext;
  readonly storage: UpdatePreviewOptions;
  readonly now: Date;
  readonly savedPlan?: WorkflowTransitionPlanReport;
}): Promise<number> {
  const { root, request, context, storage, now } = input;
  const machineChanges: string[] = [];
  const base = (
    operationKind: RepairReport['operationKind']
  ): RepairReport => ({
    schemaVersion: 2,
    operationKind,
    requestedScope: 'agent-integration',
    projectRoot: root,
    status: 'blocked',
    committed: false,
    capabilities: repairCapabilities,
    repairScopeComplete: false,
    verification: 'not-run',
    message: '',
    blockers: [],
    nextActions: [],
    machineChanges: Object.freeze([...machineChanges])
  });
  const emit = (report: RepairReport): void =>
    emitRepairReport(context, request.json, report);
  let activePlan: WorkflowTransitionPlanReport | undefined =
    input.savedPlan;
  try {
    const manifest = await loadProjectManifest(root);
    if (manifest.artifactVersion !== 8) {
      throw new Error(
        'Additive agent repair requires a current manifest-v8 project; run the reviewed update path first.'
      );
    }
    const workflow = manifest.project.specWorkflow;
    if (request.defaultAgent !== undefined && workflow !== 'spec-kit') {
      throw new Error(
        'Repair --default-agent is supported only for a current Spec Kit project.'
      );
    }
    if (request.installTools && workflow === 'manual') {
      throw new Error(
        'Manual agent repair requires no external framework tool installation.'
      );
    }
    if (request.configureOpenSpecProfile && workflow !== 'openspec') {
      throw new Error(
        'Repair --configure-openspec-profile is supported only for a current OpenSpec project.'
      );
    }
    if (input.savedPlan) {
      const plan = input.savedPlan;
      if (!agentRepairSelectionMatches(plan, {
        agents: request.agents,
        defaultAgent: request.defaultAgent
      })) {
        throw new Error(
          'The requested agents or default do not match the saved additive repair plan.'
        );
      }
      if (request.recover) {
        const recovered = await recoverWorkflowTransitionPlan(
          root,
          plan.fingerprint,
          { now, storage }
        );
        const transaction = recovered.outcome;
        const blocked = transaction.status === 'blocked';
        const absent = transaction.status === 'absent';
        const partial =
          transaction.status === 'committed-readback-failed' ||
          transaction.status === 'committed-cleanup-pending';
        emit({
          ...base('recover'),
          status: blocked || absent
            ? 'blocked'
            : partial ? 'partial' : 'recovered',
          committed: transaction.committed,
          repairScopeComplete:
            transaction.status === 'committed' ||
            transaction.status === 'rolled-back',
          verification: transaction.committed
            ? partial ? 'incomplete' : 'passed'
            : 'not-run',
          message: absent
            ? 'No authenticated additive agent repair transaction exists for this exact plan.'
            : blocked
              ? 'Additive agent repair recovery is blocked; concurrent project changes were preserved.'
              : partial
                ? 'The additive agent repair committed, but readback or transaction cleanup remains incomplete.'
                : 'Recovered the authenticated additive agent repair transaction without starting new work.',
          blockers: [
            ...transaction.rollbackFailures,
            ...transaction.cleanupFailures,
            ...transaction.readbackFailures
          ],
          fingerprint: plan.fingerprint,
          agentPlan: plan,
          agentTransaction: transaction,
          nextActions: [repairCheckAction(root)]
        });
        context.outcome?.record(
          blocked || absent || partial
            ? 'failure'
            : 'success'
        );
        return blocked || absent ? 1 : partial ? 2 : 0;
      }
      return await applyAgentPlan(plan, {
        status: 'approved',
        fingerprint: plan.fingerprint,
        method: 'fingerprint'
      });
    }

    const runner = context.runner ?? new NodeCommandRunner();
    const interactive = !request.check &&
      !request.json &&
      isInteractiveTerminal(context.stdin, context.stderr);
    const prompter = interactive
      ? new InteractivePrompter({
          input: context.stdin,
          output: context.stderr,
          presentation: context.presentation,
          cwd: root,
          configuredRoot: root,
          runner
        })
      : undefined;
    let prepared: Awaited<ReturnType<typeof prepareWorkflowTransitionPlan>>;
    try {
      prepared = await prepareWorkflowTransitionPlan(root, workflow, {
        agents: request.agents,
        defaultAgent: request.defaultAgent,
        agentRepair: true,
        now,
        storage,
        runner,
        env: context.env,
        workstationProbe: context.workstationProbe,
        workstationNoProgressStore: context.workstationNoProgressStore,
        installTools: request.installTools,
        configureOpenSpecProfile: request.configureOpenSpecProfile,
        streamOptions: context.presentation.childStreams(),
        authorizeTool: prompter
          ? async (probe, command, requiresExplicitReview) =>
              await prompter.confirmToolInstallation({
                label: probe.requirement.definition.label,
                severity: probe.requirement.severity,
                purpose: requiresExplicitReview
                  ? 'Separate review of a version or channel replacement; agent-file approval does not authorize it.'
                  : probe.requirement.reasons.join('; '),
                requirement:
                  `required ${formatRequirementVersion(probe.requirement)}`,
                observed: `${probe.reasonCode} - ${probe.detail}`,
                ...(command ? { command } : {}),
                ...(command ? {} : { remedy: probe.remedy })
              })
          : undefined,
        authorizeOpenSpecProfile: prompter
          ? async profile =>
              await prompter.confirmOpenSpecProfileConfiguration({
                observed: [
                  { label: 'Profile', value: profile.observed.profile },
                  { label: 'Delivery', value: profile.observed.delivery },
                  {
                    label: 'Workflows',
                    value: profile.observed.workflows.length > 0
                      ? profile.observed.workflows.join(', ')
                      : '(none)'
                  }
                ],
                required: [
                  { label: 'Profile', value: 'custom' },
                  { label: 'Delivery', value: 'both' },
                  {
                    label: 'Workflows',
                    value: 'complete packaged workflow inventory'
                  }
                ],
                differences: [...profile.differences],
                commands: [...profile.commands]
              })
          : undefined,
        onCommand: command => context.presentation.command(command),
        onMachineCommand: command => machineChanges.push(command)
      });
    } finally {
      prompter?.close();
    }
    const plan = prepared.plan;
    activePlan = plan;
    if (plan.operation !== 'agent-repair') {
      throw new Error('Repair produced the wrong reviewed operation.');
    }
    if (plan.execution.status === 'not-required') {
      emit({
        ...base('check'),
        status: 'current',
        repairScopeComplete: true,
        verification: 'not-required',
        message:
          'Every explicitly requested agent integration and applicable Spec Kit default is already current. Unrelated application and infrastructure readiness were not evaluated.',
        fingerprint: plan.fingerprint,
        receiptPath: prepared.path,
        agentPlan: plan,
        machineChanges: prepared.machineChanges,
        nextActions: []
      });
      context.outcome?.record('success');
      return 0;
    }
    if (request.check || request.json ||
        plan.execution.status !== 'ready-for-file-approval') {
      const executable =
        plan.execution.status === 'ready-for-file-approval';
      emit({
        ...base('check'),
        status: executable ? 'available' : 'blocked',
        message: executable
          ? 'Review the exact additive agent integrations and selection fields. No project bytes were changed; unrelated application and infrastructure work remains outside this repair scope.'
          : 'Pinned framework tools or the OpenSpec global profile still require separate preparation; no project bytes were changed.',
        blockers: executable ? [] : [
          'Agent integration execution is unavailable until the separately authorized preparation report is ready.'
        ],
        fingerprint: plan.fingerprint,
        expiresAt: plan.expiresAt,
        receiptPath: prepared.path,
        agentPlan: plan,
        machineChanges: prepared.machineChanges,
        nextActions: executable
          ? [repairCommandAction(
              root,
              ['--approve-plan', plan.fingerprint],
              {
                id: 'agent-repair-apply',
                label: 'Apply the exact additive agent repair',
                scope: 'agent-integration',
                approvalRequired: true,
                description:
                  'Applies only the saved official/native integration effects and exact additive selection fields.'
              }
            )]
          : [repairCheckAction(root)]
      });
      context.outcome?.record('attention-required');
      return 2;
    }
    const approval = await requestRepairApproval(
      request,
      plan.fingerprint,
      `Apply this exact additive agent repair (${plan.fingerprint})?`,
      context
    );
    if (approval.status !== 'approved') {
      emit({
        ...base('check'),
        status: 'available',
        approval,
        message:
          'Exact additive agent repair approval was not granted; no project transaction ran.',
        fingerprint: plan.fingerprint,
        expiresAt: plan.expiresAt,
        receiptPath: prepared.path,
        agentPlan: plan,
        machineChanges: prepared.machineChanges,
        nextActions: [repairCheckAction(root)]
      });
      context.outcome?.record(
        approval.status === 'declined'
          ? 'cancelled'
          : 'attention-required'
      );
      return 2;
    }
    return await applyAgentPlan(plan, approval);

    async function applyAgentPlan(
      plan: WorkflowTransitionPlanReport,
      approval: RepairReport['approval']
    ): Promise<number> {
      if (plan.execution.status !== 'ready-for-file-approval') {
        throw new Error(
          'The saved additive agent repair has no executable file plan.'
        );
      }
      const transaction = await applyWorkflowTransitionPlan(plan, {
        now,
        storage,
        runner: context.runner ?? new NodeCommandRunner(),
        env: context.env,
        workstationProbe: context.workstationProbe,
        streamOptions: context.presentation.childStreams(),
        onCommand: command => context.presentation.command(command)
      });
      const partial =
        transaction.status === 'committed-readback-failed' ||
        transaction.status === 'committed-cleanup-pending';
      const applied = transaction.committed;
      emit({
        ...base('apply'),
        status: applied ? partial ? 'partial' : 'applied' : 'failed',
        committed: applied,
        repairScopeComplete: applied && !partial,
        verification: applied
          ? partial ? 'incomplete' : 'passed'
          : 'not-run',
        message: applied
          ? partial
            ? 'The exact additive agent repair committed, but readback or cleanup remains incomplete.'
            : 'The exact additive agent integrations and selection fields committed. Existing agents, unrelated files, application readiness and infrastructure state were preserved.'
          : 'The exact additive agent repair did not commit.',
        blockers: [
          ...transaction.rollbackFailures,
          ...transaction.cleanupFailures,
          ...transaction.readbackFailures
        ],
        fingerprint: plan.fingerprint,
        agentPlan: plan,
        agentTransaction: transaction,
        ...(approval ? { approval } : {}),
        nextActions: partial
          ? [repairCommandAction(
              root,
              ['--recover', '--approve-plan', plan.fingerprint],
              {
                id: 'agent-repair-recover',
                label: 'Recover the exact additive agent transaction',
                scope: 'agent-integration',
                approvalRequired: true,
                description:
                  'Recovery is bound to the saved plan and authenticated transaction; it starts no new repair.'
              }
            )]
          : []
      });
      context.outcome?.record(
        applied
          ? partial ? 'attention-required' : 'success'
          : 'failure'
      );
      return applied ? partial ? 2 : 0 : 1;
    }
  } catch (error) {
    emit({
      ...base(
        request.recover
          ? 'recover'
          : request.approvePlan ? 'apply' : 'check'
      ),
      status: 'failed',
      message:
        'Additive agent repair stopped before a successful project commit could be reported.',
      blockers: [
        error instanceof Error
          ? error.message
          : 'Unexpected additive agent repair failure.'
      ],
      ...(activePlan
        ? {
            fingerprint: activePlan.fingerprint,
            agentPlan: activePlan
          }
        : {}),
      machineChanges: Object.freeze([...machineChanges]),
      nextActions: activePlan?.execution.status ===
          'ready-for-file-approval'
        ? [repairCommandAction(
            root,
            ['--recover', '--approve-plan', activePlan.fingerprint],
            {
              id: 'agent-repair-recover',
              label: 'Inspect exact additive agent recovery',
              scope: 'agent-integration',
              approvalRequired: true,
              description:
                'Recovery is authenticated to this saved plan and reports absence rather than manufacturing a transaction.'
            }
          )]
        : [repairCheckAction(root)]
    });
    context.outcome?.record('failure');
    return 1;
  }
}
