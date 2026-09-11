import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { captureProjectFileSnapshot, type ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { readProjectFile } from '../../adapters/filesystem/project-files.js';
import { errorCode } from '../../adapters/filesystem/errors.js';
import { FileSystemError } from '../../domain/project/errors.js';
import { manifestHadFilteredLegacyNonDurableOwnership } from '../../domain/project/manifest/reader.js';
import type { LiftoffManifest, ProjectPlan } from '../../domain/project/contracts.js';
import { activationStateFilePathParts } from '../../governance-activation/activation-state.js';
import { planHistoricalActivationStateMigration } from '../../governance-activation/migration.js';
import { planActivationHistoryMigration } from '../../governance-activation/migration-history.js';
import { migrationStateFilePathParts } from '../../governance-activation/history-contracts.js';
import { readActivationInputSnapshot } from '../../governance-activation/inputs.js';
import { phaseIds } from '../../domain/governance/activation/types.js';
import { inspectReviewedUpdateTransaction } from '../../adapters/filesystem/reviewed-update-transaction.js';
import type { CommandRunner } from '../../process-runner.js';
import { captureRetainedProjectInputs } from './protected-source.js';
import { formatUpdateGuidanceText, type UpdateGuidanceContext, type UpdateGuidanceText } from './command-guidance.js';
import { hasDrift, reconcileProject } from '../../reconcile.js';
import { compareSemver } from '../../semver.js';
import { buildManifest } from '../../templates.js';
import { liftoffVersion } from '../../version.js';
import { loadManifest } from '../project/manifest.js';
import { buildProjectPlan, loadConfigOptions } from '../project/planning.js';
import {
  buildUpdateArtifacts,
  captureUpdateSnapshots,
  inspectProvisioningGroups,
  planWithBlockedProvisioning,
  requestedProvisioningGroups,
  sameWorkloadIntent
} from './planning.js';
import {
  activeChangeReconciliationReport,
  combineReconciliationReports,
  manifestChanges,
  stateMigrationReconciliation,
  summarizeEntries,
  type ManagedUpdateReconciliationReport
} from './reporting.js';

export class UpdatePlanError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
    private readonly remedyText: UpdateGuidanceText
  ) {
    super(message);
    this.name = 'UpdatePlanError';
  }

  get remedy(): string {
    return this.formatRemedy();
  }

  formatRemedy(context?: UpdateGuidanceContext): string {
    return formatUpdateGuidanceText(this.remedyText, context);
  }
}

export function preserveDiagnosticGovernanceIdentity(
  target: LiftoffManifest,
  source: LiftoffManifest
): void {
  if (
    target.governance.profile === 'none' || target.governance.profile === 'unspecified' ||
    source.governance.profile === 'none' || source.governance.profile === 'unspecified'
  ) return;
  target.governance.policyVersion = source.governance.policyVersion;
  if (source.governance.activationIdentity) {
    target.governance.activationIdentity = source.governance.activationIdentity;
  } else {
    delete target.governance.activationIdentity;
  }
}

export async function findUpdateRepositoryBoundary(projectRoot: string): Promise<string | undefined> {
  let current = projectRoot;
  while (true) {
    try {
      const marker = await lstat(path.join(current, '.git'));
      if (!marker.isDirectory() && !marker.isFile()) {
        throw new FileSystemError('The Git boundary must be a regular file or directory, not a symlink.');
      }
      return await realpath(current);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function assertUpdateIntent(
  projectRoot: string,
  manifest: LiftoffManifest,
  plan: ProjectPlan
): Promise<void> {
  const recorded = manifest.project.workload;
  const separateMigration = 'Restore liftoff.config.json or perform a separately reviewed project migration.';
  if (plan.projectName !== manifest.project.name) {
    throw new UpdatePlanError(
      `Project name changes (${manifest.project.name} -> ${plan.projectName}) are a migration, not an update.`,
      'project-identity-change', separateMigration
    );
  }
  if (plan.workload !== recorded.kind) {
    throw new UpdatePlanError(
      `Project type changes (${recorded.kind} -> ${plan.workload}) are not supported by update.`,
      'workload-change', separateMigration
    );
  }
  for (const [label, from, to] of [
    ['Cloud', recorded.cloud, plan.provider.id],
    ['Region', recorded.region, plan.region.slug],
    ['API stack', recorded.apiStack, plan.apiStack.id]
  ] as const) {
    if (from !== to) {
      throw new UpdatePlanError(
        `${label} changes (${from} -> ${to}) are a migration, not an update.`,
        'workload-identity-change', separateMigration
      );
    }
  }
  const recordedPattern = recorded.kind === 'genai' ? recorded.pattern : undefined;
  const desiredPattern = plan.workload === 'genai' ? plan.pattern.id : undefined;
  if (recordedPattern !== desiredPattern) {
    throw new UpdatePlanError(
      `Pattern changes (${recordedPattern ?? 'none'} -> ${desiredPattern ?? 'none'}) are a migration, not an update.`,
      'pattern-change', separateMigration
    );
  }
  if (
    manifest.governance.profile !== 'none' && manifest.governance.profile !== 'unspecified' &&
    plan.governanceProfile.id === 'none' &&
    await readProjectFile(projectRoot, [...activationStateFilePathParts]) !== undefined
  ) {
    throw new UpdatePlanError(
      'Repository governance cannot be disabled by update while governance/activation-state.json exists.',
      'deactivation-required',
      'Restore liftoff.config.json or use a separately supported deactivation workflow; update does not infer the absence of live enforcement.'
    );
  }
  if (plan.specWorkflow.id !== manifest.project.specWorkflow) {
    throw new UpdatePlanError(
      `Spec workflow changes (${manifest.project.specWorkflow} -> ${plan.specWorkflow.id}) require official framework initialization and are not supported by liftoff update.`,
      'framework-change', separateMigration
    );
  }
  if (
    manifest.framework.state === 'initialized' && (
      plan.agents.length !== manifest.project.agents.length ||
      plan.agents.some((agent, index) => agent.id !== manifest.project.agents[index]) ||
      plan.defaultAgent?.id !== manifest.project.defaultAgent
    )
  ) {
    throw new UpdatePlanError(
      'AI agent or default-agent changes require official framework initialization and are not supported by liftoff update.',
      'agent-change', 'Restore the integrations recorded in liftoff.manifest.json.'
    );
  }
}

export async function inspectProjectUpdate(
  projectDirectory: string,
  options: { runner?: CommandRunner } = {}
) {
  const projectRoot = await realpath(projectDirectory);
  const initialSnapshots = [
    await captureProjectFileSnapshot(projectRoot, ['liftoff.manifest.json'])
  ];
  const manifest = await loadManifest(projectRoot);
  const interrupted = await inspectReviewedUpdateTransaction(projectRoot);
  if (interrupted.status !== 'absent') {
    throw new UpdatePlanError(
      'An existing update transaction requires recovery before a new preview.',
      'transaction-recovery-required',
      ['Review the reported transaction and run ', { projectRoot }, ' for bounded recovery.']
    );
  }
  if (compareSemver(manifest.liftoffVersion, liftoffVersion) > 0) {
    throw new UpdatePlanError(
      `This project was written by Liftoff ${manifest.liftoffVersion}, which is newer than this CLI (${liftoffVersion}).`,
      'newer-project', 'Upgrade the CLI first.'
    );
  }
  initialSnapshots.push(await captureProjectFileSnapshot(projectRoot, ['liftoff.config.json']));
  const config = await loadConfigOptions('liftoff.config.json', projectRoot);
  if (config.cloud !== undefined && config.cloud !== manifest.project.workload.cloud) {
    throw new UpdatePlanError(
      `Cloud changes (${manifest.project.workload.cloud} -> ${config.cloud}) are a migration, not an update.`,
      'workload-identity-change', 'Restore liftoff.config.json or perform a separately reviewed project migration.'
    );
  }
  const plan = buildProjectPlan(config, { requireProjectName: true });
  await assertUpdateIntent(projectRoot, manifest, plan);
  initialSnapshots.push(await captureProjectFileSnapshot(projectRoot, [...activationStateFilePathParts]));
  initialSnapshots.push(await captureProjectFileSnapshot(projectRoot, [...migrationStateFilePathParts]));
  const desiredRenderPlan: ProjectPlan = manifest.framework.state === 'legacy'
    ? { ...plan, agents: [], defaultAgent: undefined }
    : plan;
  const stateMigration = await planHistoricalActivationStateMigration(projectRoot);
  let historyMigration = await planActivationHistoryMigration(projectRoot);
  if (historyMigration.status === 'blocked' &&
    historyMigration.reasonCode === 'unreviewed-historical-records' && historyMigration.unreviewedPathParts) {
    historyMigration = await planActivationHistoryMigration(projectRoot, {
      reviewedUnreferencedPathParts: historyMigration.unreviewedPathParts
    });
  }
  const desiredRender = buildUpdateArtifacts(desiredRenderPlan, manifest);
  let provisioningPlans = await inspectProvisioningGroups(
    projectRoot, desiredRender, requestedProvisioningGroups(manifest, desiredRenderPlan)
  );
  if (historyMigration.status === 'eligible' || stateMigration.report.diagnosticOnly === true) {
    provisioningPlans = provisioningPlans.map((group) => ({
      ...group, entries: [], blocked: true,
      reason: 'Activation migration defers new component provisioning until a fresh post-migration preview.'
    }));
  }
  const renderPlan = planWithBlockedProvisioning(desiredRenderPlan, manifest.project.workload, provisioningPlans);
  const render = buildUpdateArtifacts(renderPlan, manifest);
  const scopedRender = [
    ...render.filter((artifact) => artifact.lifecycle === 'managed-core'),
    ...desiredRender.filter((artifact) =>
      artifact.lifecycle === 'project' &&
      provisioningPlans.some((group) => !group.blocked && group.group === artifact.provisioningGroup)
    )
  ];
  const snapshots = await captureUpdateSnapshots(projectRoot, manifest, scopedRender, initialSnapshots);
  if (historyMigration.status === 'eligible') {
    snapshots.push(...historyMigration.preconditions);
  } else if (historyMigration.status === 'current' && historyMigration.history.status === 'committed') {
    snapshots.push(
      await captureProjectFileSnapshot(projectRoot, historyMigration.history.journal.historyIndexPathParts),
      ...await Promise.all(historyMigration.history.index.files.map((file) =>
        captureProjectFileSnapshot(projectRoot, file.copyPathParts)
      ))
    );
  }
  const entries = await reconcileProject(manifest, render, projectRoot);
  const ownershipMigrationPending = manifest.artifactVersion !== 7 ||
    manifestHadFilteredLegacyNonDurableOwnership(manifest);
  const plannedManifest = buildManifest(renderPlan, render, {
    frameworkState: manifest.framework.state, projectArtifacts: manifest.projectArtifacts
  });
  if (stateMigration.report.diagnosticOnly === true && historyMigration.status !== 'eligible') {
    preserveDiagnosticGovernanceIdentity(plannedManifest, manifest);
  }
  const workloadIntentChanged = !sameWorkloadIntent(plannedManifest.project.workload, manifest.project.workload);
  const historicalReconciliation: ManagedUpdateReconciliationReport =
    historyMigration.status === 'blocked' ? {
      status: 'blocked', changedIdentityFields: [],
      phaseImpact: { preservedPhaseIds: [], invalidPhaseIds: [] },
      issues: historyMigration.issues,
      remedy: 'Repair the exact historical compatibility or record issue; force cannot authorize an unsupported migration.'
    } : historyMigration.status === 'eligible' ? {
      status: 'reconciliation-required',
      changedIdentityFields: [{
        field: 'governance.activationIdentity',
        from: historyMigration.semanticPlan.sourceIdentity,
        to: historyMigration.semanticPlan.targetIdentity
      }],
      phaseImpact: { preservedPhaseIds: [], invalidPhaseIds: [...phaseIds] },
      issues: ['Original v1 history will be preserved; current v2 proof must be established by approved local revalidation.'],
      remedy: 'Review the history-preserving successor plan and explicitly approve the matching preview.'
    } : stateMigrationReconciliation(stateMigration);
  const activeChangeReport = await activeChangeReconciliationReport(projectRoot,
    historyMigration.status === 'eligible' ? historyMigration.inventory.state.activeChange : undefined);
  if (historyMigration.status === 'eligible' && activeChangeReport.status !== 'not-required') {
    activeChangeReport.status = 'blocked';
  }
  const reconciliation = combineReconciliationReports([historicalReconciliation, activeChangeReport]);
  const hasMigrationHistory = historyMigration.status === 'eligible' ||
    historyMigration.status === 'current' && historyMigration.history.status === 'committed';
  const revalidationSource = hasMigrationHistory
    ? await readActivationInputSnapshot(projectRoot, manifest, options.runner)
    : undefined;
  const retainedSource = hasMigrationHistory ? await captureRetainedProjectInputs(projectRoot) : undefined;
  return {
    projectRoot,
    repositoryRoot: await findUpdateRepositoryBoundary(projectRoot),
    manifest,
    plan,
    renderPlan,
    render,
    entries,
    oldByName: new Map(manifest.managedArtifacts.map((artifact) => [artifact.logicalName, artifact])),
    provisioningPlans,
    snapshots: uniqueUpdateSnapshots(snapshots, projectRoot),
    stateMigration,
    historyMigration,
    revalidationSource,
    retainedSource,
    reconciliation,
    ownershipMigrationPending,
    workloadIntentChanged,
    plannedManifestChanges: manifestChanges(manifest, plannedManifest),
    summary: summarizeEntries(entries),
    hasDrift: hasDrift(entries) || ownershipMigrationPending || workloadIntentChanged ||
      provisioningPlans.length > 0 || stateMigration.status === 'migrate' ||
      historyMigration.status === 'eligible'
  };
}

export type UpdateInspection = Awaited<ReturnType<typeof inspectProjectUpdate>>;

export function uniqueUpdateSnapshots(
  snapshots: readonly ProjectFileSnapshot[],
  projectRoot: string
): ProjectFileSnapshot[] {
  const unique = new Map<string, ProjectFileSnapshot>();
  for (const snapshot of snapshots) {
    const key = snapshot.pathParts.join('\0');
    const previous = unique.get(key);
    if (previous && (
      (previous.content === undefined) !== (snapshot.content === undefined) ||
      previous.mode !== snapshot.mode ||
      previous.content?.equals(snapshot.content!) === false
    )) {
      throw new UpdatePlanError(
        `Project input changed during preview: ${snapshot.pathParts.join('/')}`,
        'inputs-changed', ['Run ', { projectRoot, mode: 'check' }, ' again.']
      );
    }
    unique.set(key, snapshot);
  }
  return [...unique.values()];
}
