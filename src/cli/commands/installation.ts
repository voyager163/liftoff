import type { ParsedArgs } from '../../domain/project/contracts.js';
import type { ExecutionContext } from '../../application/context.js';
import { readBooleanFlag, readStringFlag } from '../args/readers.js';
import { createInstallationContinuation } from '../../application/distribution/continuations.js';
import type { inspectMigrationRecovery } from '../../application/distribution/recover-migration.js';
import { getApplicationEngines } from '../../application/engine-composition.js';
import {
  hasUsableApprovalTerminal, isPlanFingerprint, type PlanApprovalPrompt
} from '../../application/execution/approval.js';
import { isNonExecutingInstallationCommand, canPersistInstallationTelemetryNotice } from '../../domain/distribution/contracts.js';
import type { InstallationInspectionResult, InstallationMigrationPlan, InstallationMigrationRecord } from '../../domain/distribution/contracts.js';
import { DistributionError, MigrationExecutionError, type DistributionReason } from '../../domain/distribution/errors.js';
import { InstallationDetector } from '../../adapters/distribution/installation-detector.js';
import { ReceiptStore } from '../../adapters/distribution/receipt-store.js';
import type { NativeAdmission } from '../../adapters/distribution/native-admission.js';
import type { DirectInstallerAdapter } from '../../adapters/distribution/direct-installer-adapter.js';
import type { StructuredContinuationV1 } from '../../protocol/continuation.js';

export { isNonExecutingInstallationCommand, canPersistInstallationTelemetryNotice };

export interface InstallationCommandContext extends ExecutionContext {
  installationDetector?: InstallationDetector;
  receiptStore?: ReceiptStore;
  nativeAdmission?: NativeAdmission;
  directInstaller?: DirectInstallerAdapter;
  approveMigrationPlan?: PlanApprovalPrompt;
  installationNow?: () => Date;
}

export type InstallationCommandResult =
  | { schemaVersion: 1; command: 'installation'; mode: 'inspect'; status: InstallationInspectionResult['status']; inspection: InstallationInspectionResult }
  | { schemaVersion: 1; command: 'installation'; mode: 'migration-preview'; status: 'preview'; plan: InstallationMigrationPlan; nextActions: readonly StructuredContinuationV1[] }
  | { schemaVersion: 1; command: 'installation'; mode: 'migration-apply'; status: 'completed' | 'failed'; record: InstallationMigrationRecord; nextActions: readonly StructuredContinuationV1[]; recordPersistence?: 'unconfirmed' }
  | { schemaVersion: 1; command: 'installation'; mode: 'recovery-inspection'; status: 'inspected'; recovery: Awaited<ReturnType<typeof inspectMigrationRecovery>>; nextActions: readonly StructuredContinuationV1[] }
  | { schemaVersion: 1; command: 'installation'; mode: 'inspect' | 'migration-preview' | 'migration-apply' | 'recovery-inspection'; status: 'blocked'; reasonCode: DistributionReason; error: string };

function validateRequest(parsed: ParsedArgs): void {
  if (parsed.command !== 'installation') throw new DistributionError('Installation maintenance requires the explicitly selected installation command.');
  const subcommand = parsed.subcommand;
  if (subcommand !== 'inspect' && subcommand !== 'migrate') throw new DistributionError('Use installation inspect or installation migrate --to <owner>.');
  const allowed = subcommand === 'inspect' ? ['json', 'help'] : ['to', 'candidate', 'destination', 'launcher', 'check', 'approve-plan', 'recover', 'json', 'help'];
  if (Object.keys(parsed.flags).some((key) => !allowed.includes(key))) throw new DistributionError('Flag is not valid for this exact installation subcommand.');
  const approval = parsed.flags['approve-plan'];
  if (approval !== undefined && !isPlanFingerprint(approval)) throw new DistributionError('--approve-plan requires exactly 64 lowercase hexadecimal characters.');
  if (parsed.flags.check === true && approval !== undefined ||
      parsed.flags.recover === true && Object.keys(parsed.flags).some((key) => !['recover', 'json', 'help'].includes(key))) {
    throw new DistributionError('Installation check and recovery inspection cannot add approval or new migration scope.');
  }
}

export async function installationCommand(parsed: ParsedArgs, context: InstallationCommandContext): Promise<number> {
  const json = readBooleanFlag(parsed.flags, 'json') === true;
  const recover = readBooleanFlag(parsed.flags, 'recover') === true;
  const approval = readStringFlag(parsed.flags, 'approve-plan');
  const check = readBooleanFlag(parsed.flags, 'check') === true;
  let mode: InstallationCommandResult['mode'] = parsed.subcommand === 'inspect' ? 'inspect' : recover ? 'recovery-inspection'
    : approval ? 'migration-apply' : 'migration-preview';
  const emit = (result: InstallationCommandResult): void => {
    if (json) context.presentation.rawStdout(`${JSON.stringify(result)}\n`);
  };
  try {
    validateRequest(parsed);
    const distribution = (await getApplicationEngines(context)).distribution;
    const detector = context.installationDetector ?? new InstallationDetector({
      admission: context.nativeAdmission, receiptStore: context.receiptStore, cwd: context.cwd, env: context.env, runner: context.runner
    });
    const store = context.receiptStore ?? detector.receiptStore;
    if (parsed.subcommand === 'inspect') {
      const candidate = readStringFlag(parsed.flags, 'candidate');
      const inspection = await distribution.inspectInstallation({ candidatePath: candidate, detector });
      emit({ schemaVersion: 1, command: 'installation', mode: 'inspect', status: inspection.status, inspection });
      if (!json) {
        context.presentation.commandIdentity('installation inspect', 'Read-only native executable, owner, and ordinary command resolution');
        context.presentation.definitions('Installation', [
          { label: 'Executable', value: inspection.executable.resolvedPath },
          { label: 'Observed version', value: inspection.executable.version ?? 'unverified' },
          { label: 'Owner', value: inspection.installation.owner },
          { label: 'Effective launcher', value: inspection.pathResolution.effectiveLauncher ?? 'none' }
        ]);
        context.presentation.status(inspection.status === 'healthy' || inspection.status === 'unlinked-candidate' ? 'info' : 'warning', inspection.status, inspection.summary);
        if (inspection.remedy) context.presentation.remedy(inspection.remedy);
      }
      return inspection.status === 'migration-required' ? 2 : inspection.status === 'healthy' || inspection.status === 'unlinked-candidate' ? 0 : 1;
    }
    if (recover) {
      const recovery = await distribution.inspectMigrationRecovery({ detector, receiptStore: store, now: context.installationNow, json });
      const nextActions = recovery.proposedPlan ? [createInstallationContinuation(recovery.proposedPlan, 'migrate', json)]
        : recovery.upgradeContinuation ? [recovery.upgradeContinuation] : [];
      emit({ schemaVersion: 1, command: 'installation', mode: 'recovery-inspection', status: 'inspected', recovery, nextActions });
      if (!json) {
        context.presentation.definitions('Read-only installation recovery', [
          { label: 'Record', value: recovery.recordId }, { label: 'Status', value: recovery.record.status },
          { label: 'Legacy package', value: recovery.legacyPackage }, { label: 'Launcher', value: recovery.launcher },
          { label: 'Remaining effects', value: recovery.remainingEffects.join(', ') || 'none' }
        ]);
        context.presentation.remedy(recovery.remedy);
        if (recovery.proposedPlan) renderPlanPreview(recovery.proposedPlan, context);
        if (recovery.upgradeContinuation) {
          context.presentation.definitions('Receipt-owned close/handover retry', [
            { label: 'Working directory', value: recovery.upgradeContinuation.cwd },
            { label: 'Authority', value: 'Dedicated owner-preserving upgrade; no migration or new fingerprint approval' }
          ]);
          context.presentation.command(recovery.upgradeContinuation.displayCommand);
        }
      }
      return recovery.transaction === 'blocked' || recovery.launcher === 'changed' || recovery.issues.length ? 1 : 0;
    }
    const owner = readStringFlag(parsed.flags, 'to');
    if (owner !== 'direct' && owner !== 'homebrew-cask' && owner !== 'winget') throw new DistributionError('Migration requires --to homebrew-cask, winget, or direct.');
    const plan = await distribution.planInstallationMigration({
      toOwner: owner, candidatePath: readStringFlag(parsed.flags, 'candidate'),
      destinationDirectory: readStringFlag(parsed.flags, 'destination'), launcherPath: readStringFlag(parsed.flags, 'launcher'),
      detector, receiptStore: store, directInstaller: context.directInstaller, runner: context.runner, now: context.installationNow
    });
    const preview = check || !approval && (json || !hasUsableApprovalTerminal(context));
    if (preview) {
      const nextActions = [createInstallationContinuation(plan, 'migrate', json)];
      emit({ schemaVersion: 1, command: 'installation', mode: 'migration-preview', status: 'preview', plan, nextActions });
      if (!json) renderPlanPreview(plan, context);
      return 0;
    }
    mode = 'migration-apply';
    if (!json) renderPlanPreview(plan, context);
    // Validate guidance before effects; emit this planned readback only after the commit verifies.
    const inspectionContinuation = createInstallationContinuation(plan, 'inspect', json);
    const record = await distribution.executeInstallationMigration({
      plan, approvePlan: approval, json,
      approvalContext: { stdin: context.stdin, stderr: context.stderr, approveMigrationPlan: context.approveMigrationPlan ?? context.approveUpdatePlan },
      ...(!json ? { onProgress: (step: number, total: number, description: string) => context.presentation.stage(`[${step}/${total}] ${description}`) } : {})
    });
    if (record.status !== 'completed' && record.status !== 'failed') throw new DistributionError('Installation has no completed or recorded failure outcome.', 'recovery_required');
    const nextActions = record.status === 'completed' ? [inspectionContinuation] : [];
    emit({ schemaVersion: 1, command: 'installation', mode: 'migration-apply', status: record.status, record, nextActions });
    if (!json) {
      if (record.status === 'completed') context.presentation.completion(
        'Installation handover verified', `Liftoff ${plan.targetInstallation.targetVersion} is owned by ${owner} and resolves normally.`,
        [
          { label: 'Retained payloads', value: String(record.retainedPaths?.length ?? 0) },
          { label: 'Inspection working directory', value: inspectionContinuation.cwd }
        ], inspectionContinuation.displayCommand
      );
      else {
        context.presentation.status('error', 'Installation handover incomplete', record.failure?.message ?? 'Inspect the retained installation record.');
        context.presentation.remedy('Use installation migrate --recover in the original user/home context for read-only inspection. No executable retry is emitted until that inspection admits a fresh exact plan; legacy restoration cannot overwrite another owner.');
      }
    }
    return record.status === 'completed' ? 0 : 1;
  } catch (error) {
    if (error instanceof MigrationExecutionError && error.record) {
      emit({ schemaVersion: 1, command: 'installation', mode: 'migration-apply', status: 'failed', record: error.record, nextActions: [], recordPersistence: 'unconfirmed' });
      if (!json) context.presentation.error(error.message);
      return 1;
    }
    const reasonCode = error instanceof DistributionError ? error.reasonCode : 'verification_failed';
    const message = error instanceof Error ? error.message : 'Installation observation or execution failed.';
    emit({ schemaVersion: 1, command: 'installation', mode, status: 'blocked', reasonCode, error: message });
    if (!json) context.presentation.error(message);
    return 1;
  }
}

export function renderPlanPreview(plan: InstallationMigrationPlan, context: ExecutionContext): void {
  const continuation = createInstallationContinuation(plan, 'migrate');
  context.presentation.commandIdentity('installation migrate (review)', 'Exact native handover; project files and Node/npm remain outside its authority');
  context.presentation.definitions('Installation plan', [
    { label: 'Fingerprint', value: plan.planFingerprint },
    { label: 'Legacy package', value: `${plan.legacyInstallation.packageName}@${plan.legacyInstallation.installedVersion}` },
    { label: 'Verified npm prefix', value: plan.legacyInstallation.prefix },
    { label: 'Native owner', value: `${plan.targetInstallation.owner}: ${plan.targetInstallation.targetPackage}@${plan.targetInstallation.targetVersion}` },
    { label: 'Native destination', value: plan.targetInstallation.destinationDirectory },
    { label: 'Native launcher', value: plan.targetInstallation.launcherPath },
    { label: 'Review expires', value: plan.expiresAt },
    { label: 'Continuation working directory', value: continuation.cwd },
    { label: 'Required authority', value: 'Exact installation plan approval' }
  ]);
  context.presentation.definitions('Ordered effects', plan.orderedEffects.map((effect) => ({ label: String(effect.step), value: effect.description })));
  context.presentation.remedy('Historical npm upgrade cannot discover native-only releases. Recovery preserves exact legacy identity, but a fresh owner-conflict review is required before any restoration.');
  context.presentation.command(continuation.displayCommand);
}
