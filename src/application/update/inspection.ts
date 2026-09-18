import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { captureReviewedSnapshot as captureProjectFileSnapshot } from '../execution/plan-binding.js';
import { readProjectFile } from '../../adapters/filesystem/project-files.js';
import { errorCode } from '../../adapters/filesystem/errors.js';
import { FileSystemError } from '../../domain/project/errors.js';
import { manifestHadFilteredLegacyNonDurableOwnership } from '../../domain/project/manifest/reader.js';
import type { CodingAgentId, LiftoffManifest, ProjectPlan } from '../../domain/project/contracts.js';
import { activationStateFilePathParts } from '../../governance-activation/activation-state.js';
import { planHistoricalActivationStateMigration } from '../../governance-activation/migration.js';
import { planActivationHistoryMigration } from '../../governance-activation/migration-history.js';
import { migrationStateFilePathParts } from '../../governance-activation/history-contracts.js';
import {
  activationSensitivePathExclusions, isSensitiveActivationPath, normalizeSensitivePathExclusions, readActivationInputSnapshot
} from '../../governance-activation/inputs.js';
import { phaseIds } from '../../domain/governance/activation/types.js';
import { inspectReviewedUpdateTransaction } from '../../adapters/filesystem/reviewed-update-transaction.js';
import type { CommandRunner } from '../../process-runner.js';
import { captureMigrationRetainedProjectInputs, migrationSensitivePathExclusions } from '../../governance-activation/historical-inputs.js';
import { formatUpdateGuidanceText, type UpdateGuidanceContext, type UpdateGuidanceText } from './command-guidance.js';
import { hasDrift, reconcileProject } from '../../reconcile.js';
import { compareSemver } from '../../semver.js';
import { buildManifest } from '../../templates.js';
import { liftoffVersion } from '../../version.js';
import { loadManifest, parseManifest } from '../project/manifest.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import {
  buildComponentMaintenanceManifest, componentMaintenancePlan, type ManagedProjectPlan
} from '../project/component-artifacts.js';
import { preserveManifestProvenance } from '../project/manifest-provenance.js';
import { inspectRepairVerificationWorkspaces } from '../repair/workspaces.js';
import type { UpdatePreviewOptions } from '../../adapters/filesystem/update-previews.js';
import { buildProjectPlan, loadConfigOptions } from '../project/planning.js';
import {
  buildUpdateArtifacts,
  captureUpdateSnapshots,
  inspectProvisioningGroups,
  planWithBlockedProvisioning,
  requestedProvisioningGroups,
  sameWorkloadIntent,
  type ProvisioningGroupPlan
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

export interface DeferredAgentRepair {
  kind: 'agent-integration';
  status: 'separate-repair-required';
  recordedAgents: readonly CodingAgentId[];
  requestedAgents: readonly CodingAgentId[];
  addAgents: readonly CodingAgentId[];
  recordedDefaultAgent: CodingAgentId | null;
  requestedDefaultAgent: CodingAgentId | null;
  changesDefault: boolean;
  executable: false;
  limitation: string;
}

function deferredAgentRepair(
  manifest: LiftoffManifest,
  plan: ManagedProjectPlan
): DeferredAgentRepair | null {
  if (manifest.framework.state !== 'initialized') return null;
  const add = plan.agents.filter((agent) => !manifest.project.agents.includes(agent.id));
  const changesDefault = plan.defaultAgent?.id !== manifest.project.defaultAgent;
  if (!add.length && !changesDefault) return null;
  return {
    kind: 'agent-integration', status: 'separate-repair-required',
    recordedAgents: [...manifest.project.agents], requestedAgents: plan.agents.map((agent) => agent.id),
    addAgents: add.map((agent) => agent.id),
    recordedDefaultAgent: manifest.project.defaultAgent ?? null,
    requestedDefaultAgent: plan.defaultAgent?.id ?? null,
    changesDefault,
    executable: false,
    limitation: 'Agent installation and framework default changes are not implemented by the public repair coordinator. Update preserves recorded integrations and the requested configuration.'
  };
}

function recordedAgentRenderPlan(plan: ManagedProjectPlan, manifest: LiftoffManifest): ManagedProjectPlan {
  if (manifest.framework.state === 'legacy') return { ...plan, agents: [], defaultAgent: undefined };
  const agents = manifest.project.agents.map((id) => {
    const agent = plan.agents.find((agent) => agent.id === id);
    if (!agent) throw new Error('Update cannot remove a recorded agent integration.');
    return agent;
  });
  const defaultAgent = agents.find((agent) => agent.id === manifest.project.defaultAgent);
  return { ...plan, agents, defaultAgent };
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
  plan: ManagedProjectPlan
): Promise<void> {
  const recorded = manifest.project.workload;
  const separateMigration = 'Restore liftoff.config.json or perform a separately reviewed project migration.';
  if (plan.projectName !== manifest.project.name) {
    throw new UpdatePlanError(
      `Project name changes (${manifest.project.name} -> ${plan.projectName}) are a migration, not an update.`,
      'project-identity-change', separateMigration
    );
  }
  const adoptedMaintenance = manifest.artifactVersion === 8 && manifest.provenance.kind === 'adopted' && plan.workload === 'components';
  if (!adoptedMaintenance && plan.workload !== recorded.kind) {
    throw new UpdatePlanError(
      `Project type changes (${recorded.kind} -> ${plan.workload}) are not supported by update.`,
      'workload-change', separateMigration
    );
  }
  if (recorded.kind !== 'components' && plan.workload !== 'components') {
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
    manifest.framework.state === 'initialized' &&
    manifest.project.agents.some((id) => !plan.agents.some((agent) => agent.id === id))
  ) {
    throw new UpdatePlanError(
      'Removing a recorded agent is not supported by update or additive integration repair.',
      'agent-removal', 'Preserve recorded integrations; use a separately reviewed supported integration workflow rather than editing manifest metadata.'
    );
  }
}

export async function inspectProjectUpdate(
  projectDirectory: string,
  options: { runner?: CommandRunner; storage?: UpdatePreviewOptions } = {}
) {
  const projectRoot = await realpath(projectDirectory);
  const initialSnapshots = [
    await captureProjectFileSnapshot(projectRoot, ['liftoff.manifest.json'], 4 * 1024 * 1024)
  ];
  const manifest = await loadManifest(projectRoot);
  const privateWorkspaces = await inspectRepairVerificationWorkspaces(projectRoot, options.storage);
  if (privateWorkspaces.status !== 'absent') {
    throw new UpdatePlanError(
      'Registered private verification workspaces are active, retained or untrusted; they block conflicting update writers.',
      'private-workspace-recovery-required',
      'Inspect the exact registered workspace and use its original repair/adoption recovery operation. Do not remove locks or workspaces by path prefix, PID or age.'
    );
  }
  const sourceManifest = initialSnapshots[0]!.content;
  if (!sourceManifest || canonicalSha256(parseManifest(JSON.parse(sourceManifest.toString('utf8')))) !== canonicalSha256(manifest)) {
    throw new UpdatePlanError('Manifest changed during inspection.', 'inputs-changed', 'Run a fresh update check.');
  }
  const preserved = preserveManifestProvenance(manifest, sourceManifest);
  const manifestHistoryMutations: import('../../adapters/filesystem/project-transaction.js').ProjectFileMutation[] = [];
  if (preserved.history) {
    const historySnapshot = await captureProjectFileSnapshot(projectRoot, preserved.history.pathParts, 4 * 1024 * 1024);
    if (historySnapshot.content !== undefined && !historySnapshot.content.equals(sourceManifest)) {
      throw new UpdatePlanError('Preserved source manifest history has different bytes.', 'manifest-history-conflict', 'Preserve history and resolve the exact conflicting identity; force cannot rewrite it.');
    }
    initialSnapshots.push(historySnapshot);
    if (historySnapshot.content === undefined) manifestHistoryMutations.push(preserved.history);
  }
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
  let plan: ManagedProjectPlan;
  if (manifest.artifactVersion === 8 && manifest.provenance.kind === 'adopted') {
    const configBytes = initialSnapshots.find((snapshot) => snapshot.pathParts.join('/') === 'liftoff.config.json')!.content;
    if (!configBytes) throw new UpdatePlanError('Adopted desired state is missing.', 'desired-state-missing', 'Restore the reviewed adopted desired state; do not initialize over the application.');
    plan = componentMaintenancePlan(manifest, JSON.parse(configBytes.toString('utf8')) as unknown);
  } else {
    if (manifest.project.workload.kind === 'components') throw new Error('Component-only identity requires explicit adopted provenance.');
    const config = await loadConfigOptions('liftoff.config.json', projectRoot);
    if (config.cloud !== undefined && config.cloud !== manifest.project.workload.cloud) {
    throw new UpdatePlanError(
      `Cloud changes (${manifest.project.workload.cloud} -> ${config.cloud}) are a migration, not an update.`,
      'workload-identity-change', 'Restore liftoff.config.json or perform a separately reviewed project migration.'
    );
    }
    plan = buildProjectPlan(config, { requireProjectName: true });
  }
  await assertUpdateIntent(projectRoot, manifest, plan);
  initialSnapshots.push(await captureProjectFileSnapshot(projectRoot, [...activationStateFilePathParts]));
  initialSnapshots.push(await captureProjectFileSnapshot(projectRoot, [...migrationStateFilePathParts]));
  const separateAgentRepair = deferredAgentRepair(manifest, plan);
  const desiredRenderPlan = recordedAgentRenderPlan(plan, manifest);
  const stateMigration = await planHistoricalActivationStateMigration(projectRoot, undefined, undefined, options.storage);
  let historyMigration = await planActivationHistoryMigration(projectRoot, { storage: options.storage });
  if (historyMigration.status === 'blocked' &&
    historyMigration.reasonCode === 'unreviewed-historical-records' && historyMigration.unreviewedPathParts) {
    historyMigration = await planActivationHistoryMigration(projectRoot, {
      reviewedUnreferencedPathParts: historyMigration.unreviewedPathParts,
      storage: options.storage
    });
  }
  const sensitivePathExclusions = normalizeSensitivePathExclusions([
    ...migrationSensitivePathExclusions(historyMigration),
    ...(historyMigration.status === 'current' ? activationSensitivePathExclusions(historyMigration.state) : [])
  ]);
  const desiredRender = buildUpdateArtifacts(desiredRenderPlan, manifest);
  const requestedGroups = requestedProvisioningGroups(manifest, desiredRenderPlan);
  const provisioningDeferred = historyMigration.status === 'eligible' || historyMigration.status === 'blocked' || stateMigration.report.diagnosticOnly === true;
  const provisioningPlans: ProvisioningGroupPlan[] = [];
  for (const requested of requestedGroups) {
    const overlapsProtectedMaterial = desiredRender.some((artifact) =>
      artifact.lifecycle === 'project' && artifact.provisioningGroup === requested.group &&
      isSensitiveActivationPath(artifact.pathParts, sensitivePathExclusions));
    if (provisioningDeferred || overlapsProtectedMaterial) {
      provisioningPlans.push({
        group: requested.group, entries: [], blocked: true,
        reason: overlapsProtectedMaterial
          ? 'Protected retained material overlaps this component inventory; ordinary update cannot inspect or replace it.'
          : 'Activation migration defers new component provisioning until a fresh post-migration preview.'
      });
    } else {
      provisioningPlans.push(...await inspectProvisioningGroups(projectRoot, desiredRender, [requested]));
    }
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
    snapshots.push(...historyMigration.history.preconditions);
  }
  const entries = await reconcileProject(manifest, render, projectRoot);
  const ownershipMigrationPending = manifest.artifactVersion !== 8 ||
    manifestHadFilteredLegacyNonDurableOwnership(manifest);
  const plannedManifest = renderPlan.workload === 'components' && manifest.artifactVersion === 8
    ? buildComponentMaintenanceManifest(manifest, renderPlan, render)
    : renderPlan.workload !== 'components' && manifest.framework.state !== 'uninitialized'
      ? buildManifest(renderPlan, render, {
        frameworkState: manifest.framework.state, projectArtifacts: manifest.projectArtifacts,
        provenance: preserved.provenance
      })
      : (() => { throw new Error('Unsupported adopted workload/framework maintenance combination.'); })();
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
      issues: [`Original v${historyMigration.semanticPlan.sourceIdentity.activationContractVersion} history will be preserved; current v${historyMigration.semanticPlan.targetIdentity.activationContractVersion} proof must be established by approved local revalidation.`],
      remedy: 'Review the history-preserving successor plan and explicitly approve the matching preview.'
    } : stateMigrationReconciliation(stateMigration);
  const activeChangeReport: ManagedUpdateReconciliationReport = historyMigration.status === 'eligible'
    ? {
      status: 'not-required', changedIdentityFields: [],
      phaseImpact: { preservedPhaseIds: [], invalidPhaseIds: [] },
      issues: ['The validated historical source remains preserved audit data; fresh Phase 0 and separate approval establish the current governance source.']
    }
    : await activeChangeReconciliationReport(projectRoot);
  const reconciliation = combineReconciliationReports([historicalReconciliation, activeChangeReport]);
  const hasMigrationHistory = historyMigration.status === 'eligible' ||
    historyMigration.status === 'current' && historyMigration.history.status === 'committed';
  const revalidationSource = hasMigrationHistory
    ? await readActivationInputSnapshot(projectRoot, manifest, options.runner, { sensitivePathExclusions })
    : undefined;
  const retainedSource = hasMigrationHistory ? await captureMigrationRetainedProjectInputs(projectRoot, sensitivePathExclusions) : undefined;
  return {
    projectRoot,
    repositoryRoot: await findUpdateRepositoryBoundary(projectRoot),
    manifest,
    manifestProvenance: preserved.provenance,
    manifestHistoryMutations,
    plan,
    deferredAgentRepair: separateAgentRepair,
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
    sensitivePathExclusions,
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
