import type { ActivationIdentity } from '../../domain/governance/activation/types.js';
import { manifestDisplayPath } from '../../domain/project/paths.js';
import type { PresentationSession } from '../../terminal.js';
import { liftoffVersion } from '../../version.js';
import type { UpdateApprovalResult } from './approval.js';
import type { UpdateInspection } from './inspection.js';
import { isUnownedUpdateConflict, provisioningJson } from './planning.js';
import { entryDisplay, entryMarker, manifestChanges } from './reporting.js';
import type { UpdateWritePlan } from './write-plan.js';
import type { LocalRevalidationPhaseResult, LocalRevalidationPreview } from './revalidation.js';
import { formatUpdateCommand } from './command-guidance.js';
import { commandShellForPlatform, formatShellCommand } from '../../adapters/process/shell-command.js';

export const updateReportSchemaVersion = 3 as const;

export interface UpdatePlanSummary {
  mode: 'normal' | 'force';
  fingerprint: string;
  eligible: boolean;
  writeCount: number;
  blockers: readonly string[];
}

export interface UpdateMigrationSummary {
  status: 'not-required' | 'available' | 'blocked' | 'committed';
  sourceIdentity: ActivationIdentity | null;
  targetIdentity: ActivationIdentity | null;
  snapshotId?: string;
  reasonCode?: string;
  historyPaths: readonly string[];
  operations?: readonly { type: 'write' | 'delete'; path: string }[];
  issues: readonly string[];
}

export interface UpdateRevalidationSummary {
  status: 'not-required' | 'pending' | 'running' | 'blocked' | 'complete';
  nextPhase: string | null;
  issues: readonly string[];
  preview?: LocalRevalidationPreview;
  phaseResults?: readonly LocalRevalidationPhaseResult[];
}

export interface UpdateReportInput {
  mode: 'check' | 'apply';
  status: 'current' | 'update-available' | 'applied' | 'partial' | 'blocked' | 'failed';
  reasonCode: string;
  projectRoot: string;
  plans?: readonly UpdatePlanSummary[];
  selectedPlanFingerprint?: string;
  receipt?: { status: 'not-required' | 'issued' | 'matched' | 'missing' | 'stale' | 'consumed'; path?: string };
  approval?: UpdateApprovalResult;
  migration?: UpdateMigrationSummary;
  revalidation?: UpdateRevalidationSummary;
  committed?: boolean;
  message?: string;
  remedy?: string;
  warnings?: readonly string[];
}

export function buildUpdateReport(
  input: UpdateReportInput,
  inspection?: UpdateInspection,
  writePlan?: UpdateWritePlan
) {
  const entries = (inspection?.entries ?? [])
    .filter((entry) => entry.status !== 'unchanged' || entry.refreshHash)
    .map((entry) => ({
      logicalName: entry.logicalName,
      status: entry.status,
      path: manifestDisplayPath(entry.pathParts),
      ...(entry.previousPathParts ? { previousPath: manifestDisplayPath(entry.previousPathParts) } : {}),
      ...(entry.status === 'retired' || entry.status === 'retired-conflict'
        ? { fileDeleted: entry.destinationOccupied !== false } : {}),
      reason: entry.reason
    }));
  const written = input.committed
    ? (writePlan?.written ?? []).map((entry) => manifestDisplayPath(entry.pathParts))
    : [];
  const removed = input.committed ? (writePlan?.retired ?? []).map((entry) => ({
    logicalName: entry.logicalName,
    status: entry.status === 'retired-conflict' ? 'force-retired' :
      entry.destinationOccupied === false ? 'retired-absent' : 'retired',
    path: manifestDisplayPath(entry.pathParts),
    fileDeleted: entry.destinationOccupied !== false,
    reason: entry.reason
  })) : [];
  const skipped = (writePlan?.skipped ?? []).map((entry) => ({
    logicalName: entry.logicalName, status: entry.status,
    path: manifestDisplayPath(entry.pathParts), reason: entry.reason
  }));
  const manifest = input.committed ? writePlan?.nextManifest : inspection?.manifest;
  const activationIdentity = manifest && manifest.governance.profile !== 'none' &&
    manifest.governance.profile !== 'unspecified' ? manifest.governance.activationIdentity ?? null : null;
  const migration = input.migration ?? {
    status: 'not-required' as const, sourceIdentity: null, targetIdentity: null, historyPaths: [], issues: []
  };
  const { migration: _migration, ...reportInput } = input;
  return {
    schemaVersion: updateReportSchemaVersion,
    scope: 'project-update',
    ...reportInput,
    cliVersion: liftoffVersion,
    projectVersion: inspection?.manifest.liftoffVersion ?? null,
    plans: input.plans ?? [],
    receipt: input.receipt ?? { status: 'not-required' },
    committed: input.committed ?? false,
    entries,
    written,
    removed,
    skipped,
    summary: inspection?.summary ?? null,
    managedCore: { entries, written, removed, skipped, summary: inspection?.summary ?? null },
    provisioning: inspection ? provisioningJson(inspection.provisioningPlans) : [],
    ownershipMigrationPending: inspection?.ownershipMigrationPending ?? false,
    manifestChanges: inspection && writePlan
      ? manifestChanges(inspection.manifest, writePlan.nextManifest)
      : inspection?.plannedManifestChanges ?? [],
    activationIdentity,
    activationMigration: migration,
    activationStateMigration: migration,
    revalidation: input.revalidation ?? { status: 'not-required', nextPhase: null, issues: [] },
    reconciliation: inspection?.reconciliation ?? null,
    ...(input.mode === 'check' ? { projectBytesWritten: 0 } : {})
  };
}

function migrationReviewDetails(migration: UpdateMigrationSummary): string[] {
  if (migration.status === 'not-required') return [];
  return [
    `Status: ${migration.status}; original history is not executable proof.`,
    ...(migration.sourceIdentity ? [`Source activation identity: ${JSON.stringify(migration.sourceIdentity)}`] : []),
    ...(migration.targetIdentity ? [`Target activation identity: ${JSON.stringify(migration.targetIdentity)}`] : []),
    ...(migration.snapshotId ? [`History snapshot: ${migration.snapshotId}`] : []),
    ...migration.historyPaths.map((entry) => `Preserve ${entry}`),
    ...(migration.operations ?? []).map((entry) => `${entry.type} ${JSON.stringify(entry.path)}`),
    ...migration.issues
  ];
}

function revalidationReviewDetails(revalidation: UpdateRevalidationSummary): string[] {
  if (revalidation.status === 'not-required') return [];
  const preview = revalidation.preview;
  const shell = commandShellForPlatform(process.platform);
  const commandDetails = (entry: LocalRevalidationPreview['inspectionCommands'][number]) =>
    `${formatShellCommand(entry.command, shell)} (directory: ${JSON.stringify(entry.cwdPathParts.join('/') || '.')}); environment overrides: ${JSON.stringify(entry.env)}`;
  return [
    `Status: ${revalidation.status}`,
    ...revalidation.issues.map((issue) => `Known revalidation gap: ${issue}`),
    ...(revalidation.issues.length ? ['Approval may commit v2 while these known revalidation gaps remain blocked.'] : []),
    ...(preview ? [
      `Commands are relative to project: ${JSON.stringify(preview.projectRoot)}`,
      `Target activation identity: ${JSON.stringify(preview.targetIdentity)}`,
      ...preview.effects,
      ...preview.inspectionCommands.map((entry) => `Read-only inspection: ${commandDetails(entry)}`),
      ...preview.phases.flatMap((phase) =>
        phase.commands.map((entry) => `${phase.phaseId}: ${commandDetails(entry)}`)
      ),
      ...preview.reusedPhases.map((phase) =>
        `Reuse fresh ${phase.phaseId} evidence ${phase.evidenceId} (header: ${phase.headerDigest}).`
      ),
      `Record writes: ${preview.recordWrites.plans}; ${preview.recordWrites.evidence}; ${preview.recordWrites.state}`,
      preview.recordWrites.limit,
      `Command limits: ${preview.commandLimits.timeoutMs} ms; ${preview.commandLimits.maxOutputBytes} output bytes.`,
      ...preview.outputPolicy.map((policy) =>
        `Generated-output policy for ${policy.executable} from ${JSON.stringify(policy.cwd.join('/') || '.')}: ${policy.outputs.map((parts) => JSON.stringify(parts.join('/'))).join(', ')}; only after a listed matching command executes.`
      ),
      preview.boundary
    ] : []),
    ...(revalidation.nextPhase ? [`Next incomplete phase: ${revalidation.nextPhase}`] : [])
  ];
}

export function renderUpdatePreview(
  presentation: PresentationSession,
  inspection: UpdateInspection,
  plans: readonly UpdatePlanSummary[],
  migration: UpdateMigrationSummary,
  revalidation: UpdateRevalidationSummary,
  receiptPath?: string
): void {
  presentation.definitions('Project versions', [
    { label: 'Liftoff CLI', value: liftoffVersion },
    { label: 'Project generated by', value: inspection.manifest.liftoffVersion }
  ]);
  const visible = inspection.entries.filter((entry) => entry.status !== 'unchanged' || entry.refreshHash);
  if (visible.length) {
    presentation.table('Liftoff core drift', ['Change', 'Artifact', 'Reason'],
      visible.map((entry) => [entryMarker(entry), entryDisplay(entry), entry.reason]));
  }
  const unowned = inspection.entries.filter((entry) => isUnownedUpdateConflict(entry, inspection.oldByName));
  if (unowned.length) {
    presentation.bullets('Unowned destinations remain protected', unowned.map((entry) =>
      `${entryDisplay(entry)}: resolve this unowned destination manually; --force cannot overwrite it`
    ));
  }
  for (const group of inspection.provisioningPlans) {
    presentation.bullets(`Project component provisioning: ${group.group}`, [
      ...(group.reason ? [group.reason] : []),
      ...group.entries.map((entry) => `${entry.status} ${manifestDisplayPath(entry.rendered.pathParts)}  ${entry.reason}`)
    ]);
  }
  if (inspection.ownershipMigrationPending) {
    presentation.bullets('Manifest maintenance', ['Release legacy project artifacts into provenance; no production file will be written.']);
  }
  if (migration.status !== 'not-required') {
    presentation.bullets('Activation migration', migrationReviewDetails(migration));
  }
  if (revalidation.status !== 'not-required') {
    presentation.bullets('Local revalidation', revalidationReviewDetails(revalidation));
  }
  for (const plan of plans) {
    presentation.definitions(plan.mode === 'force' ? 'Separately reviewed forced plan' : 'Reviewed update plan', [
      { label: 'Fingerprint', value: plan.fingerprint },
      { label: 'Static file operations', value: String(plan.writeCount) },
      { label: 'Eligible', value: plan.eligible ? 'yes; explicit approval still required' : 'no' }
    ]);
    if (plan.blockers.length) presentation.bullets('Plan blockers', plan.blockers);
  }
  if (receiptPath) {
    presentation.definitions('External preview receipt', [
      { label: 'Location', value: receiptPath },
      { label: 'Project bytes', value: 'unchanged; this receipt is not approval' }
    ]);
  }
  if (plans.some((plan) => plan.eligible && plan.writeCount > 0)) {
    presentation.command(formatUpdateCommand(inspection.projectRoot));
    const hasForceableConflict = inspection.entries.some((entry) =>
      !isUnownedUpdateConflict(entry, inspection.oldByName) &&
      (entry.status === 'conflict' || entry.status === 'retired-conflict' ||
        entry.status === 'moved' && !entry.cleanMove)
    );
    if (hasForceableConflict && plans.some((plan) => plan.mode === 'force' && plan.eligible && plan.writeCount > 0)) {
      presentation.command(formatUpdateCommand(inspection.projectRoot, 'force'));
    }
  }
}

export function renderUpdateSkipped(
  presentation: PresentationSession,
  inspection: UpdateInspection,
  writePlan: UpdateWritePlan
): void {
  if (!writePlan.skipped.length) return;
  presentation.bullets('Skipped Liftoff core conflicts', writePlan.skipped.map((entry) =>
    isUnownedUpdateConflict(entry, inspection.oldByName)
      ? `protected unowned destination ${entryDisplay(entry)}: ${entry.reason}; --force cannot overwrite it`
      : `${entryDisplay(entry)}: ${entry.reason}; review the separate forced plan before any overwrite`
  ));
}

export function renderUpdateApprovalScope(
  presentation: PresentationSession,
  jsonMode: boolean,
  plan: UpdatePlanSummary,
  writePlan: UpdateWritePlan,
  migration: UpdateMigrationSummary,
  revalidation: UpdateRevalidationSummary
): void {
  const lines = [
    `Effective ${plan.mode} plan: ${plan.fingerprint}`,
    ...writePlan.mutations.map((mutation) => `${mutation.type} ${JSON.stringify(manifestDisplayPath(mutation.pathParts))}`),
    ...migrationReviewDetails(migration),
    ...revalidationReviewDetails(revalidation),
    'Only this exact local plan is authorized; future provider actions require separate approval.'
  ];
  if (jsonMode) presentation.rawStderr(`${lines.join('\n')}\n`);
  else presentation.bullets('Review before approval', lines);
}
