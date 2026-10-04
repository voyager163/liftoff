import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { captureProjectFileSnapshot, type ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { readProjectFile } from '../../adapters/filesystem/project-files.js';
import { errorCode } from '../../adapters/filesystem/errors.js';
import { FileSystemError } from '../../domain/project/errors.js';
import { manifestHadFilteredLegacyNonDurableOwnership } from '../../domain/project/manifest/reader.js';
import type { CodingAgentId, GeneratedArtifact, LiftoffManifest, ProjectPlan } from '../../domain/project/contracts.js';
import { isRetiredManagedCoreArtifactIdentity } from '../../domain/project/artifact-lifecycle.js';
import { activationStateFilePathParts } from '../../governance-activation/activation-state.js';
import { planHistoricalActivationStateMigration } from '../../governance-activation/migration.js';
import {
  planActivationHistoryMigration, planModernActivationSuccessor, readModernActivationSuccessorSource,
  type ModernSuccessorTarget
} from '../../governance-activation/migration-history.js';
import { validateCapturedReleasedSource } from '../../governance-activation/historical-state.js';
import { copySourceHistoryData, createSourceHistoryCapture, sourceObservationIdentities } from '../../governance-activation/source-history-capture.js';
import { buildModernManagedCore, type ModernManagedCoreInput } from '../project/modern-managed-core.js';
import type { ManagedManifestDecision } from '../project/manifest-writer.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { rawHistoryDigest, parseHistoryJson, historyRecord, migrationStateFilePathParts } from '../../governance-activation/history-contracts.js';
import { manifestHistoryPaths } from '../../domain/project/manifest/history.js';
import { activationTargetHistoryPathParts } from '../../domain/project/manifest/activation-target-history.js';
import { createManifestV8Reader } from '../../domain/project/manifest/v8.js';
import { prepareManifestSchemaSuccessor, prepareStandaloneManifestHistory } from './manifest-history.js';
import { collectStandaloneManifestHistoryInput } from './manifest-history-capture.js';
import {
  manifestOnlyAbsentControlPaths, prepareCurrentManifestMaintenance, prepareManifestMaintenanceCandidate, readCurrentManifestMaintenanceSource
} from './manifest-maintenance.js';
import { inspectModernMaintenanceSource } from '../governance/modern-installed-preflight.js';
import {
  activeMaintenanceFilePreconditions, assertActiveMaintenanceCollections, prepareActiveManifestMaintenance,
  requiredActivationTargetPreservation
} from './active-manifest-maintenance.js';
import { projectCatalog } from '../project/catalog.js';
import {
  activationSensitivePathExclusions, isSensitiveActivationPath, normalizeSensitivePathExclusions, readActivationInputSnapshot
} from '../../governance-activation/inputs.js';
import { phaseIds } from '../../domain/governance/activation/types.js';
import { assertNoPendingReviewedUpdate, inspectReviewedUpdateTransaction } from '../../adapters/filesystem/reviewed-update-transaction.js';
import type { CommandRunner } from '../../process-runner.js';
import { captureMigrationRetainedProjectInputs, migrationSensitivePathExclusions } from '../../governance-activation/historical-inputs.js';
import { formatUpdateGuidanceText, type UpdateGuidanceContext, type UpdateGuidanceText } from './command-guidance.js';
import { hasDrift, reconcileProject, type ManagedArtifactInventory } from '../../reconcile.js';
import { compareSemver } from '../../semver.js';
import { buildManifest } from '../../templates.js';
import { liftoffVersion } from '../../version.js';
import { loadManifest, parseManifest, resolveModernManifestV8SourceContract } from '../project/manifest.js';
import { buildProjectPlan, loadConfigOptions } from '../project/planning.js';
import {
  isRecordedModernUpdateSelection, readRecordedModernUpdateSelection, type ModernUpdateSelection
} from './modern-update-selection.js';
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

export async function inspectModernSuccessorUpdate(projectRoot: string, selected: ModernUpdateSelection) {
  const input = copySourceHistoryData(selected, 'modern successor update selection');
  await assertNoPendingReviewedUpdate(projectRoot);
  let recorded: Awaited<ReturnType<typeof readRecordedModernUpdateSelection>> | undefined;
  let targetInput: ModernManagedCoreInput;
  if (isRecordedModernUpdateSelection(input)) {
    recorded = await readRecordedModernUpdateSelection(projectRoot);
    targetInput = recorded.selection;
  } else targetInput = input;
  const inspection = await inspectSelectedModernSuccessorUpdate(projectRoot, targetInput);
  return {
    ...inspection,
    snapshots: uniqueUpdateSnapshots([...inspection.snapshots, ...(recorded?.snapshots ?? [])], inspection.projectRoot),
    configurationReview: recorded ? {
      present: recorded.snapshots.some(file => file.pathParts.join('/') === 'liftoff.config.json' && file.content !== undefined),
      deferredFields: recorded.deferredConfiguration
    } : null
  };
}

async function inspectSelectedModernSuccessorUpdate(projectRoot: string, targetInput: ModernManagedCoreInput) {
  const boundary = await createSourceHistoryCapture(projectRoot);
  const state = await boundary.capture(activationStateFilePathParts, true);
  if (state.content === undefined) {
    const original = await boundary.capture(['liftoff.manifest.json']);
    if (historyRecord(parseHistoryJson(original.content, 'source manifest'), 'source manifest').artifactVersion === 8) {
      return inspectCurrentManifestMaintenance(boundary.root, targetInput);
    }
    return inspectManifestSuccessorUpdate(boundary.root, targetInput);
  }
  if (historyRecord(parseHistoryJson(state.content, 'active source state'), 'active source state').schemaVersion === 4) {
    return inspectActiveManifestMaintenance(boundary.root, targetInput);
  }
  const source = await readModernActivationSuccessorSource(projectRoot);
  const inventory = await validateCapturedReleasedSource(source.captures);
  const manifest = inventory.manifest;
  const core = await inspectModernManagedCore(source.projectRoot, manifest, targetInput, source.captures);
  const target: ModernSuccessorTarget = { ...targetInput, managed: core.managed };
  const successorPlan = await planModernActivationSuccessor(source, target);
  return {
    kind: 'activation-successor' as const,
    projectRoot: source.projectRoot, source, manifest, target, successorPlan, ...core,
    historyPathParts: ['governance', 'history', successorPlan.semanticInput.history.snapshotId],
    sourceRepositoryId: inventory.state.repository.id
  };
}

async function inspectModernManagedCore(
  projectRoot: string, manifest: ManagedArtifactInventory, selected: ModernManagedCoreInput,
  captures: readonly ProjectFileSnapshot[]
) {
  const render: GeneratedArtifact[] = buildModernManagedCore(selected).map(artifact => ({
    ...artifact, pathParts: [...artifact.pathParts]
  }));
  const reader = await createSourceHistoryCapture(projectRoot);
  const names = new Set(render.map(artifact => artifact.logicalName));
  for (const artifact of render) await reader.capture(artifact.pathParts, true);
  for (const previous of manifest.managedArtifacts) {
    if (names.has(previous.logicalName) ||
        isRetiredManagedCoreArtifactIdentity(previous.logicalName, previous.category, previous.pathParts)) {
      await reader.capture(previous.pathParts, true);
    }
  }
  const snapshots = uniqueUpdateSnapshots([...captures, ...reader.observations()], projectRoot);
  const byPath = new Map(snapshots.map(snapshot => [snapshot.pathParts.join('\0'), snapshot]));
  const entries = await reconcileProject(manifest, render, projectRoot, {
    readFile: async (_root, parts) => {
      const snapshot = byPath.get(parts.join('\0'));
      if (!snapshot) throw new FileSystemError('Modern successor reconciliation requires an actual captured file or absence.');
      return snapshot.content;
    }
  });
  const managed: ManagedManifestDecision[] = render.map(artifact => ({
    kind: 'bytes', logicalName: artifact.logicalName, category: artifact.category,
    pathParts: [...artifact.pathParts], content: artifact.content
  }));
  for (const previous of manifest.managedArtifacts) {
    if (names.has(previous.logicalName)) continue;
    managed.push({
      kind: isRetiredManagedCoreArtifactIdentity(previous.logicalName, previous.category, previous.pathParts) ? 'retire-alias' : 'retain',
      logicalName: previous.logicalName
    });
  }
  await reader.assertRoot();
  return {
    managed, render, entries, snapshots,
    oldByName: new Map(manifest.managedArtifacts.map(artifact => [artifact.logicalName, {
      ...artifact, pathParts: [...artifact.pathParts]
    }]))
  };
}

export async function assertManifestOnlyActivationCollectionsEmpty(projectRoot: string): Promise<void> {
  const reader = await createSourceHistoryCapture(projectRoot);
  const collections = ['plans', 'evidence', 'approvals', 'supersessions', 'reconciliation'] as const;
  for (const directory of collections) {
    if ((await reader.recordPaths(directory)).length) {
      throw new FileSystemError(`Manifest-only update cannot interpret orphaned governance/${directory} records as an unstarted activation.`);
    }
  }
}

async function inspectManifestSuccessorUpdate(projectRoot: string, selected: ModernManagedCoreInput) {
  const reader = await createSourceHistoryCapture(projectRoot);
  for (const parts of manifestOnlyAbsentControlPaths) await reader.captureAbsent(parts);
  await assertManifestOnlyActivationCollectionsEmpty(reader.root);
  const historyInput = await collectStandaloneManifestHistoryInput(reader.root);
  const history = prepareStandaloneManifestHistory(historyInput);
  const original = parseHistoryJson(historyInput.sourceManifest.content, 'original source manifest');
  const manifest = parseManifest(original);
  if (canonicalSha256(manifest.project) !== canonicalSha256(selected.selection.project) ||
    canonicalSha256(manifest.framework) !== canonicalSha256(selected.selection.framework) ||
    selected.selection.profile === 'team-gitflow' ||
    manifest.governance.profile !== 'unspecified' && manifest.governance.profile !== selected.selection.profile) {
    throw new FileSystemError('Manifest-only update cannot change the recorded project, framework, workflow, agents or profile.');
  }
  const captures = uniqueUpdateSnapshots([...reader.observations(), ...history.filePreconditions], reader.root);
  const core = await inspectModernManagedCore(reader.root, manifest, selected, captures);
  const prepared = prepareManifestSchemaSuccessor(historyInput, selected, core.managed);
  const sourceBinding = canonicalSha256({
    kind: 'liftoff-manifest-only-source', projectRoot: reader.root,
    directory: history.directoryObservation,
    files: captures.map(file => ({
      pathParts: file.pathParts, digest: file.content === undefined ? null : rawHistoryDigest(file.content),
      mode: file.mode ?? null
    }))
  });
  await assertManifestOnlyActivationCollectionsEmpty(reader.root);
  await reader.assertRoot();
  return {
    kind: 'manifest-successor' as const,
    projectRoot: reader.root, source: { projectRoot: reader.root, captures, sourceBinding },
    manifest, target: { ...selected, managed: core.managed }, ...core, historyInput,
    successorPlan: { manifest: prepared.manifest, semanticTransitionDigest: prepared.semanticTransitionDigest },
    historyPathParts: [...history.directoryObservation.pathParts],
    sourceRepositoryId: null
  };
}

async function inspectCurrentManifestMaintenance(projectRoot: string, selected: ModernManagedCoreInput) {
  const reader = await createSourceHistoryCapture(projectRoot);
  for (const parts of manifestOnlyAbsentControlPaths) await reader.captureAbsent(parts);
  await assertManifestOnlyActivationCollectionsEmpty(reader.root);
  const original = await reader.capture(['liftoff.manifest.json']);
  const manifest = createManifestV8Reader({ catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract })
    .parseManifestV8(parseHistoryJson(original.content, 'current source manifest'));
  if (manifest.sourceManifestHistory?.kind === 'activation-history') {
    throw new FileSystemError('Current manifest maintenance cannot reinterpret missing activation state or its history.');
  }
  if (manifest.sourceManifestHistory) {
    const paths = manifestHistoryPaths(manifest.sourceManifestHistory);
    await reader.capture(paths.indexPathParts);
    await reader.capture(paths.manifestPathParts);
  }
  const source = readCurrentManifestMaintenanceSource(reader.observations());
  const core = await inspectModernManagedCore(reader.root, source.manifest, selected, source.snapshots);
  const successorPlan = prepareCurrentManifestMaintenance(core.snapshots, selected, core.managed);
  await assertManifestOnlyActivationCollectionsEmpty(reader.root);
  await reader.assertRoot();
  return {
    kind: 'manifest-maintenance' as const, projectRoot: reader.root, manifest: source.manifest,
    source: {
      projectRoot: reader.root, captures: core.snapshots,
      sourceBinding: canonicalSha256({
        kind: 'liftoff-current-manifest-source', projectRoot: reader.root, files: sourceObservationIdentities(core.snapshots)
      })
    },
    target: { ...selected, managed: core.managed }, ...core, successorPlan,
    historyPathParts: null, sourceRepositoryId: null
  };
}

async function inspectActiveManifestMaintenance(projectRoot: string, selected: ModernManagedCoreInput) {
  const source = await inspectModernMaintenanceSource(projectRoot);
  if (!('kind' in source)) throw new FileSystemError(source.blockers.join(' '));
  await assertActiveMaintenanceCollections(source.snapshot);
  const captures = activeMaintenanceFilePreconditions(source);
  const core = await inspectModernManagedCore(source.snapshot.root, source.manifest, selected, captures);
  const candidate = prepareManifestMaintenanceCandidate(source.original, selected, core.managed);
  const reference = requiredActivationTargetPreservation(source, candidate.manifestChanged);
  const reader = await createSourceHistoryCapture(source.snapshot.root);
  const preservationObservation = reference ? await reader.capture(activationTargetHistoryPathParts(reference), true) : undefined;
  const successorPlan = await prepareActiveManifestMaintenance(source.snapshot, selected, core.managed, preservationObservation);
  await assertActiveMaintenanceCollections(source.snapshot);
  await reader.assertRoot();
  const snapshots = uniqueUpdateSnapshots([...core.snapshots, ...successorPlan.preconditions], reader.root);
  return {
    kind: 'active-manifest-maintenance' as const, projectRoot: reader.root, manifest: source.manifest,
    source: {
      projectRoot: reader.root, captures: snapshots,
      sourceBinding: canonicalSha256({
        kind: 'liftoff-active-manifest-source', installedBinding: source.binding,
        preservation: preservationObservation ? sourceObservationIdentities([preservationObservation]) : []
      })
    },
    target: { ...selected, managed: core.managed }, ...core, snapshots, successorPlan,
    activeSnapshot: source.snapshot, preservationObservation,
    historyPathParts: reference ? activationTargetHistoryPathParts(reference).slice(0, -1) : null,
    sourceRepositoryId: source.current.state.repository.id
  };
}

export type ModernSuccessorUpdateInspection = Awaited<ReturnType<typeof inspectModernSuccessorUpdate>>;

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
  plan: ProjectPlan
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

function recordedAgentRenderPlan(plan: ProjectPlan, manifest: LiftoffManifest): ProjectPlan {
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
  const separateAgentRepair = deferredAgentRepair(manifest, plan);
  const desiredRenderPlan = recordedAgentRenderPlan(plan, manifest);
  const stateMigration = await planHistoricalActivationStateMigration(projectRoot);
  let historyMigration = await planActivationHistoryMigration(projectRoot);
  if (historyMigration.status === 'blocked' &&
    historyMigration.reasonCode === 'unreviewed-historical-records' && historyMigration.unreviewedPathParts) {
    historyMigration = await planActivationHistoryMigration(projectRoot, {
      reviewedUnreferencedPathParts: historyMigration.unreviewedPathParts
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
      issues: ['Original v1/v2 history will be preserved; current v3 proof must be established by approved local revalidation.'],
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
