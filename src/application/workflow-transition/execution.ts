import { createHash } from 'node:crypto';
import {
  readBoundProjectFileSnapshot
} from '../../adapters/filesystem/bound-project-files.js';
import {
  applyWorkflowTransitionTransaction,
  inspectWorkflowTransitionTransaction,
  recoverWorkflowTransitionTransaction,
  ReviewedUpdateTransactionError,
  type ReviewedUpdateTransactionOutcome
} from '../../adapters/filesystem/reviewed-update-transaction.js';
import type {
  UpdatePreviewOptions
} from '../../adapters/filesystem/update-previews.js';
import {
  canonicalSha256
} from '../../domain/governance/activation/canonical-json.js';
import {
  validateFrameworkInstallation
} from '../../framework-validation.js';
import type {
  CommandRunner,
  RunCommandOptions
} from '../../process-runner.js';
import type { WorkstationProbeOptions } from '../../workstation.js';
import {
  inspectModernLocalVerification,
  planModernLocalVerification
} from '../governance/modern-local-inputs.js';
import {
  assertWorkflowTransitionFrameworkPreserved,
  assertWorkflowTransitionPlanCurrent,
  assertWorkflowTransitionTargetFrameworkCommitted,
  readWorkflowTransitionPlan,
  readWorkflowTransitionPlanForRecovery,
  rebuildWorkflowTransitionExecution,
  type WorkflowTransitionExecutionCandidate,
  type WorkflowTransitionPlanReport
} from './plan.js';
import {
  createWorkflowTransitionTransactionAuthorityStore
} from './transaction-authority.js';

export interface WorkflowTransitionExecutionOptions {
  readonly storage?: UpdatePreviewOptions;
  readonly now: Date;
  readonly runner?: CommandRunner;
  readonly env?: NodeJS.ProcessEnv;
  readonly workstationProbe?: WorkstationProbeOptions;
  readonly streamOptions?: Pick<RunCommandOptions, 'stdout' | 'stderr'>;
  readonly onCommand?: (command: string) => void;
}

export interface WorkflowTransitionExecutionOutcome {
  readonly operation: 'apply' | 'recover';
  readonly status:
    | 'absent'
    | 'rolled-back'
    | 'blocked'
    | 'committed-cleanup-pending'
    | 'committed-readback-failed'
    | 'committed';
  readonly committed: boolean;
  readonly transactionDigest: string | null;
  readonly readbackDigest: string | null;
  readonly rollbackFailures: readonly string[];
  readonly cleanupFailures: readonly string[];
  readonly readbackFailures: readonly string[];
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readback(
  plan: WorkflowTransitionPlanReport
): Promise<string> {
  if (plan.execution.status !== 'ready-for-file-approval') {
    throw new Error('Workflow transition readback requires an executable plan.');
  }
  const observations = [];
  for (const effect of plan.execution.effects) {
    const snapshot = await readBoundProjectFileSnapshot(
      plan.projectRoot,
      effect.pathParts,
      {
        maximumBytes: 8 * 1024 * 1024,
        linkPolicy: 'transaction-compatible',
        diagnostics: {
          pathLabel:
            `Workflow transition readback ${effect.pathParts.join('/')}`,
          invalid(detail): never {
            throw new Error(detail);
          }
        }
      }
    );
    if (effect.operation === 'delete') {
      if (snapshot.content !== undefined) {
        throw new Error(
          `Deleted workflow integration still exists: ${effect.pathParts.join('/')}.`
        );
      }
    } else if (!snapshot.content ||
        digest(snapshot.content) !== effect.contentDigest ||
        snapshot.content.length !== effect.contentBytes ||
        snapshot.mode !== effect.mode) {
      throw new Error(
        `Committed workflow transition effect differs from its approved bytes or mode: ${effect.pathParts.join('/')}.`
      );
    }
    observations.push({
      operation: effect.operation,
      pathParts: effect.pathParts,
      contentDigest: snapshot.content ? digest(snapshot.content) : null,
      contentBytes: snapshot.content?.length ?? null,
      mode: snapshot.mode ?? null
    });
  }
  await assertWorkflowTransitionFrameworkPreserved(plan);
  if (plan.target.workflow !== 'manual') {
    await assertWorkflowTransitionTargetFrameworkCommitted(plan);
    const issues = await validateFrameworkInstallation(
      plan.projectRoot,
      {
        workflow: plan.target.workflow,
        agents: [...plan.target.agents],
        ...(plan.target.defaultAgent
          ? { defaultAgent: plan.target.defaultAgent }
          : {})
      }
    );
    if (issues.length > 0) {
      throw new Error(
        `Committed workflow transition did not produce the official ${plan.target.workflow} contract:\n${issues.join('\n')}`
      );
    }
    return canonicalSha256({
      schemaVersion: 1,
      kind: 'liftoff-workflow-transition-readback',
      projectRoot: plan.projectRoot,
      planFingerprint: plan.fingerprint,
      effects: observations,
      frameworkInventory: plan.frameworkInventory,
      targetFrameworkInventory: plan.targetFrameworkInventory,
      targetLocalReadiness: {
        mode: 'official-framework-initialized',
        workflow: plan.target.workflow,
        agents: plan.target.agents,
        defaultAgent: plan.target.defaultAgent
      }
    });
  }
  const inspection = await inspectModernLocalVerification(plan.projectRoot);
  if (inspection.status !== 'modern-observed') {
    throw new Error(
      inspection.status === 'blocked'
        ? `Manual local-readiness inspection is blocked: ${inspection.blockers.join(' ')}`
        : 'Manual local-readiness inspection did not observe a current manifest-v8 project.'
    );
  }
  const readiness = await planModernLocalVerification(inspection);
  const frameworkCheck = readiness.checks.find(
    check => check.id === 'framework-source'
  );
  if (!frameworkCheck ||
      frameworkCheck.status !== 'inapplicable' ||
      frameworkCheck.command !== null ||
      frameworkCheck.reasons.length !== 1 ||
      frameworkCheck.reasons[0] !==
        'Manual selects no external framework.') {
    throw new Error(
      'Committed workflow transition did not produce native Manual local readiness.'
    );
  }
  return canonicalSha256({
    schemaVersion: 1,
    kind: 'liftoff-workflow-transition-readback',
    projectRoot: plan.projectRoot,
    planFingerprint: plan.fingerprint,
    effects: observations,
    frameworkInventory: plan.frameworkInventory,
    targetLocalReadiness: {
      mode: 'manual-native',
      planStatus: readiness.status,
      observationDigest: readiness.observationDigest,
      physicalDigest: readiness.physicalDigest,
      baselineDigest: readiness.baselineDigest,
      frameworkCheck
    }
  });
}

function sameExecution(
  expected: WorkflowTransitionExecutionCandidate,
  actual: WorkflowTransitionExecutionCandidate
): void {
  if (canonicalSha256(expected.report) !== canonicalSha256(actual.report)) {
    throw new Error(
      'Workflow transition effects changed after exact plan approval.'
    );
  }
}

function outcome(
  operation: WorkflowTransitionExecutionOutcome['operation'],
  transaction: ReviewedUpdateTransactionOutcome,
  readbackDigest: string | null = null,
  readbackFailures: readonly string[] = []
): WorkflowTransitionExecutionOutcome {
  const status = transaction.committed
    ? readbackFailures.length
      ? 'committed-readback-failed'
      : transaction.cleanupFailures.length
        ? 'committed-cleanup-pending'
        : 'committed'
    : transaction.status;
  return Object.freeze({
    operation,
    status,
    committed: transaction.committed,
    transactionDigest: transaction.transactionDigest ?? null,
    readbackDigest,
    rollbackFailures: Object.freeze([...transaction.rollbackFailures]),
    cleanupFailures: Object.freeze([...transaction.cleanupFailures]),
    readbackFailures: Object.freeze([...readbackFailures])
  });
}

export async function applyWorkflowTransitionPlan(
  plan: WorkflowTransitionPlanReport,
  options: WorkflowTransitionExecutionOptions
): Promise<WorkflowTransitionExecutionOutcome> {
  if (plan.execution.status !== 'ready-for-file-approval') {
    throw new Error('The selected workflow transition is not executable.');
  }
  await assertWorkflowTransitionPlanCurrent(plan, {
    runner: options.runner,
    env: options.env,
    workstationProbe: options.workstationProbe
  });
  const candidate = await rebuildWorkflowTransitionExecution(plan, {
    runner: options.runner,
    env: options.env,
    streamOptions: options.streamOptions,
    onCommand: options.onCommand
  });
  const authorityStore = createWorkflowTransitionTransactionAuthorityStore(
    plan.projectRoot,
    options.storage
  );
  let transactionDigest: string | null = null;
  let committedReadback: string | null = null;
  const readbackFailures: string[] = [];
  let transaction: ReviewedUpdateTransactionOutcome;
  try {
    transaction = await applyWorkflowTransitionTransaction(
      plan.projectRoot,
      candidate.mutations,
      {
        planFingerprint: plan.fingerprint,
        authorityStore,
        preconditions: candidate.preconditions,
        expectedCandidateBinding:
          plan.execution.transactionCandidateBinding,
        validateCurrentInputs: async stage => {
          if (stage !== 'before-commit') {
            await assertWorkflowTransitionPlanCurrent(plan, {
              runner: options.runner,
              env: options.env,
              workstationProbe: options.workstationProbe
            });
            sameExecution(
              candidate,
              await rebuildWorkflowTransitionExecution(plan, {
                runner: options.runner,
                env: options.env,
                streamOptions: options.streamOptions,
                onCommand: options.onCommand
              })
            );
            return;
          }
          const stored = await readWorkflowTransitionPlan(
            plan.projectRoot,
            plan.fingerprint,
            options.now,
            options.storage
          );
          if (canonicalSha256(stored) !== canonicalSha256(plan)) {
            throw new Error(
              'Workflow transition approval expired or changed before commit.'
            );
          }
          await assertWorkflowTransitionTargetFrameworkCommitted(plan);
          const observed = await inspectWorkflowTransitionTransaction(
            plan.projectRoot,
            { authorityStore }
          );
          if (observed.status !== 'interrupted' ||
              observed.planFingerprint !== plan.fingerprint ||
              !observed.transactionDigest ||
              observed.transactionDigest !== transactionDigest) {
            throw new Error(
              'Workflow transition journal differs from the approved transaction.'
            );
          }
        },
        onCheckpoint: async checkpoint => {
          if (checkpoint.phase !== 'prepared' &&
              checkpoint.phase !== 'committed') {
            return;
          }
          const observed = await inspectWorkflowTransitionTransaction(
            plan.projectRoot,
            { authorityStore }
          );
          if (observed.status !==
                (checkpoint.phase === 'committed'
                  ? 'committed'
                  : 'interrupted') ||
              observed.planFingerprint !== plan.fingerprint ||
              !observed.transactionDigest ||
              transactionDigest !== null &&
                transactionDigest !== observed.transactionDigest) {
            throw new Error(
              'Workflow transition checkpoint lacks exact transaction attribution.'
            );
          }
          transactionDigest = observed.transactionDigest;
          if (checkpoint.phase === 'committed') {
            try {
              committedReadback = await readback(plan);
            } catch (error) {
              readbackFailures.push(
                error instanceof Error
                  ? error.message
                  : 'Committed workflow transition readback failed.'
              );
            }
          }
        }
      }
    );
  } catch (error) {
    if (!(error instanceof ReviewedUpdateTransactionError) ||
        transactionDigest === null) {
      throw error;
    }
    const observed = await inspectWorkflowTransitionTransaction(
      plan.projectRoot,
      { authorityStore }
    );
    transaction = observed.status === 'absent' &&
      error.rollbackFailures.length === 0
      ? {
          status: 'rolled-back',
          committed: false,
          planFingerprint: plan.fingerprint,
          transactionDigest,
          rollbackFailures: [],
          cleanupFailures: []
        }
      : {
          status: 'blocked',
          committed: false,
          planFingerprint: plan.fingerprint,
          transactionDigest,
          rollbackFailures: error.rollbackFailures.length
            ? [...error.rollbackFailures]
            : [
                observed.reason ??
                  'Workflow transition failed and authenticated recovery remains required.'
              ],
          cleanupFailures: []
        };
  }
  if (transaction.transactionDigest !== transactionDigest) {
    throw new Error(
      'Workflow transition outcome differs from its authenticated journal.'
    );
  }
  return outcome(
    'apply',
    transaction,
    committedReadback,
    readbackFailures
  );
}

export async function recoverWorkflowTransitionPlan(
  projectRoot: string,
  planFingerprint: string,
  options: WorkflowTransitionExecutionOptions
): Promise<{
  readonly plan: WorkflowTransitionPlanReport;
  readonly outcome: WorkflowTransitionExecutionOutcome;
}> {
  const plan = await readWorkflowTransitionPlanForRecovery(
    projectRoot,
    planFingerprint,
    options.now,
    options.storage
  );
  if (plan.execution.status !== 'ready-for-file-approval') {
    throw new Error(
      'The selected workflow transition has no authenticated recovery lane.'
    );
  }
  const authorityStore = createWorkflowTransitionTransactionAuthorityStore(
    plan.projectRoot,
    options.storage
  );
  const observed = await inspectWorkflowTransitionTransaction(
    plan.projectRoot,
    { authorityStore }
  );
  if (observed.status === 'absent') {
    return {
      plan,
      outcome: outcome('recover', {
        status: 'absent',
        committed: false,
        rollbackFailures: [],
        cleanupFailures: []
      })
    };
  }
  if (observed.status === 'blocked' ||
      observed.planFingerprint !== plan.fingerprint ||
      !observed.transactionDigest) {
    return {
      plan,
      outcome: outcome('recover', {
        status: 'blocked',
        committed: false,
        rollbackFailures: [
          observed.reason ??
            'Workflow transition recovery journal is not attributable to the selected plan.'
        ],
        cleanupFailures: []
      })
    };
  }
  const transaction = await recoverWorkflowTransitionTransaction(
    plan.projectRoot,
    {
      authorityStore,
      expectedTransaction: {
        planFingerprint: plan.fingerprint,
        transactionDigest: observed.transactionDigest
      }
    }
  );
  const readbackFailures: string[] = [];
  let readbackDigest: string | null = null;
  if (transaction.committed) {
    try {
      readbackDigest = await readback(plan);
    } catch (error) {
      readbackFailures.push(
        error instanceof Error
          ? error.message
          : 'Recovered workflow transition readback failed.'
      );
    }
  }
  return {
    plan,
    outcome: outcome(
      'recover',
      transaction,
      readbackDigest,
      readbackFailures
    )
  };
}
