import path from 'node:path';
import {
  applyProjectFileTransaction,
  captureProjectFileSnapshot,
  type ProjectFileMutation
} from '../../adapters/filesystem/project-transaction.js';
import {
  findProjectRoot
} from '../../adapters/filesystem/project-discovery.js';
import {
  loadManifest,
  parseManifest
} from '../project/manifest.js';
import {
  manifestHadFilteredLegacyNonDurableOwnership
} from '../../domain/project/manifest/reader.js';
import {
  manifestDisplayPath
} from '../../domain/project/paths.js';
import {
  readProjectFile
} from '../../adapters/filesystem/project-files.js';
import {
  buildProjectPlan,
  loadConfigOptions
} from '../project/planning.js';
import {
  hasDrift,
  reconcileProject
} from '../../reconcile.js';
import type {
  ReconcileEntry
} from '../../reconcile.js';
import {
  compareSemver
} from '../../semver.js';
import {
  buildManifest
} from '../../templates.js';
import type {
  ExecutionContext
} from '../context.js';
import {
  activationStateFilePathParts
} from '../../governance-activation/activation-state.js';
import {
  planHistoricalActivationStateMigration
} from '../../governance-activation/migration.js';
import type {
  LiftoffManifest,
  ProjectPlan
} from '../../domain/project/contracts.js';
import {
  liftoffVersion
} from '../../version.js';
import {
  appendProvisionedProjectArtifacts,
  assertAuthorizedUpdateMutations,
  buildUpdateArtifacts,
  captureUpdateSnapshots,
  inspectProvisioningGroups,
  isUnownedUpdateConflict,
  planWithBlockedProvisioning,
  preflightUpdate,
  type ProvisioningEntry,
  provisioningJson,
  requestedProvisioningGroups,
  sameWorkloadIntent,
  selectUpdatePreconditions
} from './planning.js';
import {
  activeChangeReconciliationReport,
  combineReconciliationReports,
  entryDisplay,
  entryMarker,
  isDirtyGitWorktree,
  manifestChanges,
  maybeInjectUpdateFailure,
  stateMigrationReconciliation,
  summarizeEntries
} from './reporting.js';

export interface UpdateRequest {
  check: boolean;
  force: boolean;
  jsonMode: boolean;
  project?: string;
}

function preserveDiagnosticGovernanceIdentity(
  target: LiftoffManifest,
  source: LiftoffManifest
): void {
  if (
    target.governance.profile === 'none' ||
    target.governance.profile === 'unspecified' ||
    source.governance.profile === 'none' ||
    source.governance.profile === 'unspecified'
  ) {
    return;
  }
  target.governance.policyVersion = source.governance.policyVersion;
  if (source.governance.activationIdentity) {
    target.governance.activationIdentity = source.governance.activationIdentity;
  } else {
    delete target.governance.activationIdentity;
  }
}

export async function updateProject(request: UpdateRequest, context: ExecutionContext): Promise<number> {
  const { presentation } = context;
  const { check, force, jsonMode, project: explicit } = request;
  presentation.commandIdentity('update', 'Reconcile Liftoff-managed core files');
  if (force && check) {
    presentation.error(
      '--force cannot be combined with --check.',
      'Run `liftoff update --check` to inspect drift or `liftoff update --force` to overwrite conflicts.'
    );
    return 1;
  }

  const projectRoot = explicit ? path.resolve(context.cwd, explicit) : await findProjectRoot(context.cwd);
  if (!projectRoot) {
    presentation.error(
      `No liftoff.manifest.json found in ${context.cwd} or any parent directory.`,
      'Run this command inside a Liftoff project or provide its path explicitly.'
    );
    return 1;
  }

  const initialUpdateSnapshots = check
    ? []
    : await Promise.all([
        captureProjectFileSnapshot(projectRoot, ['liftoff.manifest.json']),
        captureProjectFileSnapshot(projectRoot, ['liftoff.config.json'])
      ]);
  const manifest = await loadManifest(projectRoot);
  const oldByName = new Map(
    manifest.managedArtifacts.map((artifact) => [artifact.logicalName, artifact])
  );
  if (compareSemver(manifest.liftoffVersion, liftoffVersion) > 0) {
    presentation.error(
      `This project was written by Liftoff ${manifest.liftoffVersion}, which is newer than this CLI (${liftoffVersion}).`,
      'Upgrade the CLI first.'
    );
    return 1;
  }

  const config = await loadConfigOptions('liftoff.config.json', projectRoot);
  const recordedWorkload = manifest.project.workload;
  if (config.cloud !== undefined && config.cloud !== recordedWorkload.cloud) {
    presentation.error(
      `Cloud changes (${recordedWorkload.cloud} -> ${config.cloud}) are a migration, not an update.`,
      'Restore liftoff.config.json or perform the cloud change through a separately reviewed project migration.'
    );
    return 1;
  }
  const plan = buildProjectPlan(config, { requireProjectName: true });
  if (plan.projectName !== manifest.project.name) {
    presentation.error(
      `Project name changes (${manifest.project.name} -> ${plan.projectName}) are a migration, not an update.`,
      'Restore liftoff.config.json or perform the rename through a separately reviewed project migration.'
    );
    return 1;
  }
  if (plan.workload !== recordedWorkload.kind) {
    presentation.error(
      `Project type changes (${recordedWorkload.kind} -> ${plan.workload}) are not supported by update.`,
      'Initialize a fresh project and move production behavior through a reviewed project change.'
    );
    return 1;
  }
  {
    if (plan.provider.id !== recordedWorkload.cloud) {
      presentation.error(
        `Cloud changes (${recordedWorkload.cloud} -> ${plan.provider.id}) are a migration, not an update.`,
        'Restore liftoff.config.json or perform the cloud change through a separately reviewed project migration.'
      );
      return 1;
    }
    if (plan.region.slug !== recordedWorkload.region) {
      presentation.error(
        `Region changes (${recordedWorkload.region} -> ${plan.region.slug}) are a migration, not an update.`,
        'Restore liftoff.config.json or perform the region change through a separately reviewed project migration.'
      );
      return 1;
    }
    if (plan.apiStack.id !== recordedWorkload.apiStack) {
      presentation.error(
        `API stack changes (${recordedWorkload.apiStack} -> ${plan.apiStack.id}) are a migration, not an update.`,
        'Initialize a fresh project and move production behavior through a reviewed project change.'
      );
      return 1;
    }
    const recordedPattern = recordedWorkload.kind === 'genai' ? recordedWorkload.pattern : undefined;
    const desiredPattern = plan.workload === 'genai' ? plan.pattern.id : undefined;
    if (desiredPattern !== recordedPattern) {
      presentation.error(
        `Pattern changes (${recordedPattern ?? 'none'} -> ${desiredPattern ?? 'none'}) are a migration, not an update.`,
        'Use a separately reviewed project migration; the existing migrate command only adopts non-Liftoff sources into a fresh target.'
      );
      return 1;
    }
  }
  if (
    manifest.governance.profile !== 'none' &&
    manifest.governance.profile !== 'unspecified' &&
    plan.governanceProfile.id === 'none' &&
    await readProjectFile(projectRoot, [...activationStateFilePathParts]) !== undefined
  ) {
    presentation.error(
      'Repository governance cannot be disabled by update while governance/activation-state.json exists.',
      'Restore liftoff.config.json or complete a separately supported deactivation and reconciliation workflow before disabling governance. This Liftoff release does not infer deactivation or the absence of live enforcement.'
    );
    return 1;
  }
  if (plan.specWorkflow.id !== manifest.project.specWorkflow) {
    presentation.error(
      `Spec workflow changes (${manifest.project.specWorkflow} -> ${plan.specWorkflow.id}) require official framework initialization and are not supported by liftoff update.`,
      'Restore the workflow recorded in liftoff.manifest.json or migrate into a fresh project.'
    );
    return 1;
  }
  const configuredAgents = plan.agents.map((agent) => agent.id);
  if (
    manifest.framework.state === 'initialized' && (
      configuredAgents.length !== manifest.project.agents.length ||
      configuredAgents.some((agent, index) => agent !== manifest.project.agents[index]) ||
      plan.defaultAgent?.id !== manifest.project.defaultAgent
    )
  ) {
    presentation.error(
      'AI agent or default-agent changes require official framework initialization and are not supported by liftoff update.',
      'Restore liftoff.config.json to the integrations recorded in liftoff.manifest.json.'
    );
    return 1;
  }

  let desiredRenderPlan: ProjectPlan = manifest.framework.state === 'legacy'
    ? { ...plan, agents: [], defaultAgent: undefined }
    : plan;
  const stateMigration = await planHistoricalActivationStateMigration(projectRoot);
  const desiredRender = buildUpdateArtifacts(desiredRenderPlan, manifest);
  let provisioningPlans = await inspectProvisioningGroups(
    projectRoot,
    desiredRender,
    requestedProvisioningGroups(manifest, desiredRenderPlan)
  );
  if (stateMigration.report.diagnosticOnly === true) {
    provisioningPlans = provisioningPlans.map((group) => ({
      ...group,
      entries: [],
      blocked: true,
      reason: 'Historical activation v1 is diagnostic-only. This update may maintain managed core but cannot provision project-owned components.'
    }));
  }
  const renderPlan = planWithBlockedProvisioning(
    desiredRenderPlan,
    recordedWorkload,
    provisioningPlans
  );
  const render = buildUpdateArtifacts(renderPlan, manifest);
  const scopedRender = [
    ...render.filter((artifact) => artifact.lifecycle === 'managed-core'),
    ...desiredRender.filter((artifact) =>
    artifact.lifecycle === 'project' &&
      provisioningPlans.some((group) =>
        !group.blocked && group.group === artifact.provisioningGroup
      )
    )
  ];
  const updateSnapshots = check
    ? []
    : await captureUpdateSnapshots(
        projectRoot,
        manifest,
        scopedRender,
        initialUpdateSnapshots
      );
  const entries = await reconcileProject(manifest, render, projectRoot);
  const summary = summarizeEntries(entries);
  const ownershipMigrationPending =
    manifest.artifactVersion !== 7 ||
    manifestHadFilteredLegacyNonDurableOwnership(manifest);
  const plannedManifest = buildManifest(renderPlan, render, {
    frameworkState: manifest.framework.state,
    projectArtifacts: manifest.projectArtifacts
  });
  if (stateMigration.report.diagnosticOnly === true) {
    preserveDiagnosticGovernanceIdentity(plannedManifest, manifest);
  }
  const plannedManifestChanges = manifestChanges(manifest, plannedManifest);
  const reconciliation = combineReconciliationReports([
    stateMigrationReconciliation(stateMigration),
    await activeChangeReconciliationReport(projectRoot)
  ]);
  if (reconciliation.status === 'blocked') {
    const blockedReport = {
      schemaVersion: 2,
      mode: check ? 'check' : 'apply',
      scope: 'managed-core',
      status: 'blocked',
      cliVersion: liftoffVersion,
      projectVersion: manifest.liftoffVersion,
      entries: [],
      removed: [],
      provisioning: [],
      ownershipMigrationPending: false,
      manifestChanges: plannedManifestChanges,
      activationStateMigration: stateMigration.report,
      reconciliation,
      summary
    };
    if (jsonMode) {
      presentation.rawStdout(`${JSON.stringify(blockedReport, null, 2)}\n`);
    } else {
      presentation.status('error', 'Managed update blocked', reconciliation.issues.join('; '));
      if (reconciliation.remedy) {
        presentation.remedy(reconciliation.remedy);
      }
    }
    return 1;
  }
  const workloadIntentChanged = !sameWorkloadIntent(
    plannedManifest.project.workload,
    manifest.project.workload
  );
  const manifestRewritePending =
    ownershipMigrationPending ||
    workloadIntentChanged;
  const drift =
    hasDrift(entries) ||
    manifestRewritePending ||
    provisioningPlans.length > 0 ||
    stateMigration.status === 'migrate';
  const visible = entries.filter((entry) => entry.status !== 'unchanged' || entry.refreshHash);

  if (!drift) {
    if (jsonMode) {
      presentation.rawStdout(`${JSON.stringify(check ? {
        schemaVersion: 2,
        mode: 'check',
        scope: 'managed-core',
        status: reconciliation.status === 'reconciliation-required' ? 'reconciliation-required' : 'current',
        cliVersion: liftoffVersion,
        projectVersion: manifest.liftoffVersion,
        entries: [],
        provisioning: [],
        ownershipMigrationPending,
        manifestChanges: plannedManifestChanges,
        activationIdentity: manifest.governance.profile !== 'none' && manifest.governance.profile !== 'unspecified'
          ? manifest.governance.activationIdentity ?? null
          : null,
        activationStateMigration: stateMigration.report,
        reconciliation,
        summary
      } : {
        schemaVersion: 2,
        mode: 'apply',
        scope: 'managed-core',
        status: reconciliation.status === 'reconciliation-required' ? 'reconciliation-required' : 'current',
        cliVersion: liftoffVersion,
        projectVersion: manifest.liftoffVersion,
        written: [],
        removed: [],
        skipped: [],
        provisioning: [],
        ownershipMigrationPending,
        manifestChanges: plannedManifestChanges,
        activationIdentity: manifest.governance.profile !== 'none' && manifest.governance.profile !== 'unspecified'
          ? manifest.governance.activationIdentity ?? null
          : null,
        activationStateMigration: stateMigration.report,
        reconciliation,
        summary
      }, null, 2)}\n`);
      return 0;
    }
    presentation.definitions('Project versions', [
      { label: 'Liftoff CLI', value: liftoffVersion },
      { label: 'Project generated by', value: manifest.liftoffVersion }
    ]);
    presentation.status(
      'success',
      'Liftoff core is current',
      `${summary.unchanged} managed-core artifacts match; project files are not compared`
    );
    if (stateMigration.report.diagnosticOnly === true) {
      presentation.status(
        'warning',
        'Historical activation remains diagnostic-only',
        'Managed-core is current; activation v1 state and evidence were preserved without migration, retagging, or execution authority.'
      );
    }
    return 0;
  }

  if (check) {
    if (jsonMode) {
      presentation.rawStdout(`${JSON.stringify({
        schemaVersion: 2,
        mode: 'check',
        scope: 'managed-core',
        cliVersion: liftoffVersion,
        projectVersion: manifest.liftoffVersion,
        entries: visible.map((entry) => ({
          logicalName: entry.logicalName,
          status: entry.status,
          path: manifestDisplayPath(entry.pathParts),
          previousPath: entry.previousPathParts ? manifestDisplayPath(entry.previousPathParts) : undefined,
          fileDeleted: entry.status === 'retired' || entry.status === 'retired-conflict'
            ? entry.destinationOccupied !== false
            : undefined,
          reason: entry.reason
        })),
        provisioning: provisioningJson(provisioningPlans),
        ownershipMigrationPending,
        manifestChanges: plannedManifestChanges,
        activationIdentity: plannedManifest.governance.profile !== 'none' && plannedManifest.governance.profile !== 'unspecified'
          ? plannedManifest.governance.activationIdentity ?? null
          : null,
        activationStateMigration: stateMigration.report,
        reconciliation,
        summary
      }, null, 2)}\n`);
      return 2;
    }

    presentation.definitions('Project versions', [
      { label: 'Liftoff CLI', value: liftoffVersion },
      { label: 'Project generated by', value: manifest.liftoffVersion }
    ]);
    if (visible.length > 0) {
      if (presentation.stdout.layout === 'plain') {
        presentation.section(
          'Liftoff core drift',
          visible.map((entry) => `${entryMarker(entry)} ${entryDisplay(entry)}  ${entry.reason}`)
        );
      } else {
        presentation.table(
          'Liftoff core drift',
          ['Change', 'Artifact', 'Reason'],
          visible.map((entry) => [entryMarker(entry), entryDisplay(entry), entry.reason])
        );
      }
    }
    for (const group of provisioningPlans) {
      presentation.bullets(
        `Project component provisioning: ${group.group}`,
        [
          ...(group.reason ? [group.reason] : []),
          ...group.entries.map((entry) =>
            `${entry.status} ${manifestDisplayPath(entry.rendered.pathParts)}  ${entry.reason}`
          )
        ]
      );
    }
    const manifestMaintenance = [
      ownershipMigrationPending
        ? 'release legacy project artifacts from Liftoff update authority in manifest schema v7; no production file will be written'
        : undefined,
      workloadIntentChanged
        ? 'record the requested project configuration intent after safe provisioning'
        : undefined
    ].filter((item): item is string => item !== undefined);
    if (manifestMaintenance.length > 0) {
      presentation.bullets('Manifest maintenance', manifestMaintenance);
    }
    if (stateMigration.status === 'migrate') {
      presentation.bullets('Activation-state migration', [
        `${stateMigration.report.path}: explicit compatibility mapping preserves evidence bytes and stages ${stateMigration.report.reconciliationPath}`
      ]);
    }
    if (reconciliation.status === 'reconciliation-required') {
      presentation.bullets('Reconciliation required after update', [
        ...reconciliation.changedIdentityFields.map((field) =>
          `${field.field}: ${JSON.stringify(field.from)} -> ${JSON.stringify(field.to)}`
        ),
        `invalid phases: ${reconciliation.phaseImpact.invalidPhaseIds.join(', ') || 'none'}`,
        reconciliation.remedy ?? 'Run governance status/verify before executing affected phases.'
      ]);
    }
    const toWrite =
      summary.new +
      summary.missing +
      summary.upgrade +
      summary.moved +
      summary.refresh +
      provisioningPlans.reduce(
        (count, group) =>
          count + (
            group.blocked
              ? 0
              : group.entries.filter((entry) => entry.status === 'create').length
          ),
        0
      ) +
      (manifestRewritePending ? 1 : 0) +
      stateMigration.mutations.length;
    const toRetire = summary.retired;
    presentation.status(
      'warning',
      'Liftoff core maintenance available',
      `${toWrite} to write, ${toRetire} retired alias ownership record(s) to remove (${summary.retiredRemoved} file deletion(s)), ${summary.conflict + summary.retiredConflict} core conflict(s), ${summary.orphan} core orphan(s), ${summary.unchanged} core unchanged`
    );
    if (toWrite > 0 || toRetire > 0) {
      presentation.command('liftoff update');
    }
    const unownedConflicts = entries.filter((entry) => isUnownedUpdateConflict(entry, oldByName));
    if (unownedConflicts.length > 0) {
      presentation.bullets(
        'Unowned destinations remain protected',
        unownedConflicts.map((entry) =>
          `${entryDisplay(entry)}: review and resolve this unowned destination manually; --force cannot overwrite it`
        )
      );
    }
    if (entries.some((entry) =>
      !isUnownedUpdateConflict(entry, oldByName) &&
      (entry.status === 'conflict' || entry.status === 'retired-conflict' ||
        entry.status === 'moved' && !entry.cleanMove)
    )) {
      presentation.command('liftoff update --force');
    }
    return 2;
  }

  const blockedProvisioning = provisioningPlans.filter((group) => group.blocked);

  if (isDirtyGitWorktree(projectRoot)) {
    const warning =
      'The project worktree has uncommitted changes; consider committing before applying.';
    if (jsonMode) {
      presentation.rawStderr(`Warning: ${warning}\n`);
    } else {
      presentation.warning(warning);
    }
  }
  presentation.stage('Apply safe Liftoff core changes', projectRoot);
  await preflightUpdate(projectRoot, entries, force, oldByName);
  maybeInjectUpdateFailure(context.env, 'after-preflight');

  const written: ReconcileEntry[] = [];
  const retired: ReconcileEntry[] = [];
  const skipped: ReconcileEntry[] = [];
  const mutations: ProjectFileMutation[] = [];
  for (const entry of entries) {
    switch (entry.status) {
      case 'new':
      case 'missing':
      case 'upgrade':
        mutations.push({
          type: 'write',
          pathParts: entry.pathParts,
          content: entry.rendered!.content
        });
        written.push(entry);
        break;
      case 'moved':
        if (!isUnownedUpdateConflict(entry, oldByName) && (entry.cleanMove || force)) {
          if (!entry.destinationMatches) {
            mutations.push({
              type: 'write',
              pathParts: entry.pathParts,
              content: entry.rendered!.content
            });
          }
          mutations.push({ type: 'delete', pathParts: entry.previousPathParts! });
          written.push(entry);
        } else {
          skipped.push(entry);
        }
        break;
      case 'retired':
        mutations.push({ type: 'delete', pathParts: entry.pathParts });
        retired.push(entry);
        break;
      case 'retired-conflict':
        if (force) {
          mutations.push({ type: 'delete', pathParts: entry.pathParts });
          retired.push(entry);
        } else {
          skipped.push(entry);
        }
        break;
      case 'conflict':
        if (force && !isUnownedUpdateConflict(entry, oldByName)) {
          mutations.push({
            type: 'write',
            pathParts: entry.pathParts,
            content: entry.rendered!.content
          });
          if (entry.previousPathParts) {
            mutations.push({ type: 'delete', pathParts: entry.previousPathParts });
          }
          written.push(entry);
        } else {
          skipped.push(entry);
        }
        break;
      default:
        break;
    }
  }

  const provisioned: ProvisioningEntry[] = [];
  for (const group of provisioningPlans) {
    if (group.blocked) {
      continue;
    }
    for (const entry of group.entries) {
      if (entry.status === 'create') {
        mutations.push({
          type: 'write',
          pathParts: entry.rendered.pathParts,
          content: entry.rendered.content
        });
      }
      provisioned.push(entry);
    }
  }
  for (const mutation of stateMigration.mutations) {
    mutations.push(mutation);
  }

  const skippedByName = new Map(skipped.map((entry) => [entry.logicalName, entry]));
  const hasUnrecordedGovernanceConflict = skipped.some((entry) =>
    entry.status === 'conflict' &&
    entry.rendered?.category === 'governance' &&
    !oldByName.has(entry.logicalName)
  );
  const hasProtectedRetiredAlias = skipped.some((entry) =>
    entry.status === 'retired-conflict'
  );
  const nextProjectArtifacts = appendProvisionedProjectArtifacts(
    manifest.projectArtifacts,
    provisioningPlans
  );
  const nextManifest = buildManifest(
    renderPlan,
    render.filter((artifact) => artifact.logicalName !== 'manifest'),
    {
      frameworkState: manifest.framework.state,
      projectArtifacts: nextProjectArtifacts
    }
  );
  nextManifest.framework = manifest.framework;
  nextManifest.project.specWorkflow = manifest.project.specWorkflow;
  nextManifest.project.agents = manifest.project.agents;
  if (manifest.project.defaultAgent) {
    nextManifest.project.defaultAgent = manifest.project.defaultAgent;
  } else {
    delete nextManifest.project.defaultAgent;
  }
  if (
    (hasUnrecordedGovernanceConflict || hasProtectedRetiredAlias) &&
    nextManifest.governance.profile !== 'none'
  ) {
    nextManifest.governance.state = 'handoff-partial';
  }
  if (stateMigration.report.diagnosticOnly === true) {
    preserveDiagnosticGovernanceIdentity(nextManifest, manifest);
  }
  nextManifest.managedArtifacts = nextManifest.managedArtifacts.flatMap((artifact) => {
    if (!skippedByName.has(artifact.logicalName)) {
      return [artifact];
    }
    const previous = oldByName.get(artifact.logicalName);
    if (!previous) {
      return [];
    }
    return [{ ...artifact, pathParts: previous.pathParts, contentHash: previous.contentHash }];
  });
  for (const entry of entries) {
    if (entry.status === 'orphan') {
      const previous = oldByName.get(entry.logicalName)!;
      if (
        plan.governanceProfile.id === 'none' &&
        previous.category === 'governance'
      ) {
        continue;
      }
      nextManifest.managedArtifacts.push(previous);
    }
    if (entry.status === 'retired-conflict' && !force) {
      const previous = oldByName.get(entry.logicalName)!;
      if (
        plan.governanceProfile.id === 'none' &&
        previous.category === 'governance'
      ) {
        continue;
      }
      nextManifest.managedArtifacts.push(previous);
    }
  }
  parseManifest(JSON.parse(JSON.stringify(nextManifest)) as unknown);
  mutations.push({
    type: 'write',
    pathParts: ['liftoff.manifest.json'],
    content: `${JSON.stringify(nextManifest, null, 2)}\n`
  });
  assertAuthorizedUpdateMutations(
    mutations,
    entries,
    provisioningPlans,
    stateMigration.mutations.map((mutation) => mutation.pathParts)
  );
  await applyProjectFileTransaction(projectRoot, mutations, {
    onBeforeMutation: async (mutation, index) => {
      maybeInjectUpdateFailure(context.env, `before-mutation:${index}`);
      maybeInjectUpdateFailure(context.env, `before-path:${mutation.pathParts.join('/')}`);
    },
    preconditions: [
      ...selectUpdatePreconditions(
        updateSnapshots,
        entries,
        mutations,
        provisioned.map((entry) => entry.rendered.pathParts)
      ),
      ...stateMigration.preconditions
    ]
  });

  if (jsonMode) {
    presentation.rawStdout(`${JSON.stringify({
      schemaVersion: 2,
      mode: 'apply',
      scope: 'managed-core',
      status: blockedProvisioning.length > 0 || skipped.length > 0
        ? 'partial'
        : reconciliation.status === 'reconciliation-required'
          ? 'reconciliation-required'
          : 'applied',
      cliVersion: liftoffVersion,
      projectVersion: manifest.liftoffVersion,
      written: written.map((entry) => manifestDisplayPath(entry.pathParts)),
      removed: retired.map((entry) => ({
        logicalName: entry.logicalName,
        status: entry.status === 'retired-conflict'
          ? 'force-retired'
          : entry.destinationOccupied === false
            ? 'retired-absent'
            : 'retired',
        path: manifestDisplayPath(entry.pathParts),
        fileDeleted: entry.destinationOccupied !== false,
        reason: entry.reason
      })),
      stateWritten: stateMigration.mutations.map((mutation) => manifestDisplayPath(mutation.pathParts)),
      skipped: skipped.map((entry) => ({
        logicalName: entry.logicalName,
        status: entry.status,
        path: manifestDisplayPath(entry.pathParts),
        reason: entry.reason
      })),
      provisioning: provisioningJson(provisioningPlans),
      ownershipMigrationPending,
      manifestChanges: manifestChanges(manifest, nextManifest),
      activationIdentity: nextManifest.governance.profile !== 'none' && nextManifest.governance.profile !== 'unspecified'
        ? nextManifest.governance.activationIdentity ?? null
        : null,
      activationStateMigration: stateMigration.report,
      reconciliation,
      summary
    }, null, 2)}\n`);
    return 0;
  }

  if (written.length > 0) {
    presentation.bullets(
      'Applied Liftoff core changes',
      written.map((entry) => `wrote ${entryDisplay(entry)}`)
    );
  }
  const retiredDeleted = retired.filter((entry) => entry.destinationOccupied !== false);
  const retiredAbsent = retired.filter((entry) => entry.destinationOccupied === false);
  if (retiredDeleted.length > 0) {
    presentation.bullets(
      'Removed retired Liftoff aliases',
      retiredDeleted.map((entry) => `removed ${entryDisplay(entry)}  ${entry.reason}`)
    );
  }
  if (retiredAbsent.length > 0) {
    presentation.bullets(
      'Retired absent Liftoff alias ownership',
      retiredAbsent.map((entry) => `removed manifest ownership for ${entryDisplay(entry)}  ${entry.reason}`)
    );
  }
  if (stateMigration.status === 'migrate') {
    presentation.bullets(
      'Migrated activation state',
      stateMigration.mutations.map((mutation) => `wrote ${manifestDisplayPath(mutation.pathParts)}; evidence bytes preserved`)
    );
  }
  if (provisioned.length > 0) {
    presentation.bullets(
      'Provisioned project components',
      provisioned.map((entry) =>
        `${entry.status === 'create' ? 'wrote' : 'adopted'} ${manifestDisplayPath(entry.rendered.pathParts)}`
      )
    );
  }
  if (blockedProvisioning.length > 0) {
    presentation.bullets(
      'Blocked project component provisioning',
      blockedProvisioning.flatMap((group) =>
        [
          ...(group.reason ? [`${group.group}: ${group.reason}`] : []),
          ...group.entries
            .filter((entry) => entry.status === 'conflict')
            .map((entry) =>
              `${group.group}: preserved ${manifestDisplayPath(entry.rendered.pathParts)}; --force cannot overwrite project-owned bytes`
            )
        ]
      )
    );
  }
  if (skipped.length > 0) {
    presentation.bullets(
      'Skipped Liftoff core conflicts',
      skipped.map((entry) =>
        isUnownedUpdateConflict(entry, oldByName)
          ? `protected unowned destination ${entryDisplay(entry)}  ${entry.reason} (resolve manually; --force cannot overwrite it)`
          : entry.status === 'retired-conflict'
            ? `protected retired alias ${entryDisplay(entry)}  ${entry.reason}${force ? '' : ' (delete it manually or use --force to remove)'}`
            : `skipped ${entryDisplay(entry)}  ${entry.reason}${force ? '' : ' (use --force to overwrite)'}`
      )
    );
  }
  const orphans = entries.filter((entry) => entry.status === 'orphan');
  if (orphans.length > 0) {
    presentation.bullets(
      'Orphaned Liftoff core artifacts',
      orphans.map((entry) => `orphan ${entryDisplay(entry)}  ${entry.reason}`)
    );
  }
  if (reconciliation.status === 'reconciliation-required') {
    presentation.bullets(
      'Reconciliation required',
      [
        ...reconciliation.changedIdentityFields.map((field) =>
          `${field.field}: ${JSON.stringify(field.from)} -> ${JSON.stringify(field.to)}`
        ),
        `invalid phases: ${reconciliation.phaseImpact.invalidPhaseIds.join(', ') || 'none'}`,
        reconciliation.remedy ?? 'Run governance status/verify before executing affected phases.'
      ]
    );
  }
  presentation.completion(
    'Updated project',
    [
      `${written.length} core written`,
      `${retired.length} retired ownership removed`,
      `${retiredDeleted.length} retired file deleted`,
      `${provisioned.length} project provisioned`,
      ...(blockedProvisioning.length > 0
        ? [`${blockedProvisioning.length} provisioning group(s) blocked`]
        : []),
      `${skipped.length} core skipped`
    ].join(', '),
    [{ label: 'Manifest version', value: liftoffVersion }],
    'liftoff validate && liftoff doctor'
  );
  return 0;
}
