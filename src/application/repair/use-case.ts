import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionContext } from '../context.js';
import { loadManifest, parseManifest } from '../project/manifest.js';
import { buildRepairedManifestV8 } from '../project/repair-manifest.js';
import { findProjectRoot } from '../../adapters/filesystem/project-discovery.js';
import { ProjectFileTransactionError, type ProjectFileMutation, type ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import {
  assertInputBindingUnchanged, captureInputBinding, captureReviewedSnapshot as captureProjectFileSnapshot
} from '../execution/plan-binding.js';
import {
  applyReviewedExecution, assertReviewedFileApprovalCurrent, requestReviewedFileApproval
} from '../execution/kernel.js';
import { withCooperatingExecutionLock } from '../execution/cross-writers.js';
import { reviewedPlanMatches } from '../../domain/execution/immutable-plan.js';
import { operationFailureOutcome } from '../../domain/execution/operation-outcome.js';
import {
  inspectExecutionJournal,
  recoverExecutionJournal
} from '../execution/journal-adapter.js';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { isRecord } from '../../domain/governance/activation/canonical-json.js';
import {
  assessInfrastructureLayout, retiredFlatRootInfrastructureIdentities
} from '../../domain/project/infrastructure-layout.js';
import type { EnvironmentId, LiftoffManifest } from '../../domain/project/contracts.js';
import { NodeCommandRunner } from '../../process-runner.js';
import { repairExecutionIdentity, repairSchemaVersions, type RepairExecutionIdentity } from '../../domain/repair/identity.js';
import { liftoffVersion } from '../../version.js';
import type { UpdateApprovalResult } from '../update/approval.js';
import { inspectInfrastructureRepair, type InfrastructureRepairCandidate } from './infrastructure.js';
import { repairAzureBaseline } from './baseline-flow.js';
import { baselineValidationPolicy, type BaselineValidationPolicy } from './baseline-validation.js';
import { discoverRepairEligibility, repairCommandLimits, repairDiscoveryLimits, type RepairDiscovery } from './discovery.js';
import {
  buildRepairPreview, loadRepairPreview, mutationDescriptors, repairApprovalStore,
  repairHistoryFiles, repairHistoryRoot, type RepairPreview
} from './preview.js';
import { repairValidationPolicy, validateRepairCandidate } from './validation.js';
import { repairCapabilities } from './capabilities.js';
import { emitRepairReport, type RepairReport } from './report.js';
import { repairRequestIssue, type RepairRequest } from './request.js';
import { requestRepairApproval } from './approval.js';
import { repairAgentActions, repairCheckAction, repairCommandAction, repairResumeActions } from './guidance.js';
import { repairHistoryMutations, repairManifestLinkDeclarations } from './history.js';
import { assertRepairReadback } from './readback.js';
import { inspectRepairVerificationWorkspaces, recoverRepairVerificationWorkspaces } from './workspaces.js';
export type { RepairRequest } from './request.js';

interface RepairInspection {
  manifest: LiftoffManifest;
  candidate: InfrastructureRepairCandidate;
  snapshots: ProjectFileSnapshot[];
  mutations: ProjectFileMutation[];
  discovery: RepairDiscovery;
  blockers: string[];
  sourceManifest: Buffer;
  validationTool?: BaselineValidationPolicy['tool'];
}

function repairedManifest(manifest: LiftoffManifest, original: Buffer, candidate: InfrastructureRepairCandidate): string {
  return buildRepairedManifestV8(manifest, original, candidate.artifacts);
}

async function inspect(root: string, request: Pick<RepairRequest, 'live' | 'subscription'>, context: ExecutionContext): Promise<RepairInspection> {
  const manifestSnapshot = await captureProjectFileSnapshot(root, ['liftoff.manifest.json'], 4 * 1024 * 1024);
  if (!manifestSnapshot.content || manifestSnapshot.content.length > 4 * 1024 * 1024) {
    throw new Error('Repair requires a bounded existing Liftoff manifest.');
  }
  const manifest = await loadManifest(root);
  const candidate = await inspectInfrastructureRepair(root, manifest);
  const configSnapshot = await captureProjectFileSnapshot(root, ['liftoff.config.json']);
  const snapshots = [...new Map([...candidate.snapshots, manifestSnapshot, configSnapshot]
    .map((entry) => [entry.pathParts.join('/'), entry])).values()];
  const discovery = await discoverRepairEligibility(root, candidate, {
    live: request.live, subscription: request.subscription, runner: context.runner ?? new NodeCommandRunner(), env: context.env
  });
  const blockers = [...candidate.blockers, ...discovery.blockers];
  let validationTool: BaselineValidationPolicy['tool'] | undefined;
  if (candidate.layout !== 'independent' && !blockers.length) {
    try { validationTool = (await baselineValidationPolicy(root, context.env)).tool; }
    catch (error) { blockers.push(error instanceof Error ? error.message : 'The installed validation tool could not be identified.'); }
  }
  const mutations = candidate.layout === 'independent' || candidate.blockers.length ? [] : [
    ...candidate.mutations,
    {
      type: 'write' as const, pathParts: ['liftoff.manifest.json'],
      content: repairedManifest(manifest, manifestSnapshot.content, candidate)
    }
  ];
  return { manifest, candidate, snapshots, mutations, discovery, blockers, sourceManifest: manifestSnapshot.content, validationTool };
}

function manifestEnvironments(manifest: LiftoffManifest): readonly EnvironmentId[] {
  return manifest.project.workload.kind === 'components' ? [] : manifest.project.workload.environments;
}

function previewFor(root: string, inspection: RepairInspection, scope: Pick<RepairRequest, 'live' | 'subscription'>, now: Date) {
  return buildRepairPreview({
    projectRoot: root, snapshots: inspection.snapshots, mutations: inspection.mutations,
    scope: {
      layout: inspection.candidate.layout,
      environments: manifestEnvironments(inspection.manifest),
      resourceGroups: inspection.candidate.resourceGroups, statePaths: inspection.candidate.statePaths,
      directoryInventory: inspection.candidate.directoryInventory,
      discoveryPolicy: { ...repairCommandLimits, ...repairDiscoveryLimits },
      observations: inspection.discovery.observations, historyRoot: repairHistoryRoot, historyFiles: repairHistoryFiles,
      manifestProvenanceLinks: repairManifestLinkDeclarations(inspection.mutations),
      validationTool: inspection.validationTool ?? null
    },
    live: scope.live, subscription: scope.subscription, now
  });
}

function assertSamePreview(current: RepairPreview, saved: RepairPreview): void {
  if (!reviewedPlanMatches(saved, current)) {
    throw new Error('Repair inputs, destinations or exact effects changed after preview. No new repair was committed; run a fresh check.');
  }
}

export async function repairProject(request: RepairRequest, context: ExecutionContext): Promise<number> {
  let root = request.project ? path.resolve(context.cwd, request.project) : context.cwd;
  let committed = false;
  let selectedManifest: LiftoffManifest | undefined;
  let approval: UpdateApprovalResult | undefined;
  let validationAttempted = false;
  let validationCompleted = false;
  let executionIdentity: RepairExecutionIdentity | undefined;
  let fingerprint: string | undefined;
  let historyPath: string | undefined;
  const now = () => context.updateNow?.() ?? new Date();
  const storage = { ...context.updatePreview, env: context.updatePreview?.env ?? context.env };
  const base = (): RepairReport => ({
    schemaVersion: repairSchemaVersions.report,
    operationKind: request.recover ? 'recover' : request.verifyPlan ? 'verify' : request.inspectLayout ? 'inspect-layout' : request.approvePlan ? 'apply' : 'check',
    requestedScope: request.recover ? 'repair-recovery' :
      request.inspectLayout || request.applicationPatch || request.verifyPlan ? 'application-layout' : 'local-infrastructure',
    projectRoot: root, status: 'blocked', committed, capabilities: repairCapabilities,
    repairScopeComplete: false, verification: 'not-run', message: '', blockers: [], nextActions: [],
    ...(approval ? { approval } : {}),
    ...(executionIdentity ? { identity: executionIdentity } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(historyPath ? { historyPath } : {}),
    ...(validationAttempted ? {
      verificationEffects: {
        attempted: true, networkAuthorized: true, dependencyPreparationAuthorized: true,
        outcome: validationCompleted ? 'passed' as const : 'incomplete' as const,
        boundary: 'Previously approved isolated OpenTofu validation and provider preparation are not undone by a later file-transaction or finalization failure. No project-script, state or deployment authority was granted.'
      }
    } : {})
  });
  const emit = (report: RepairReport) => emitRepairReport(context, request.json, report);
  const recoverAction = () => repairCommandAction(root, ['--recover'], {
    id: 'repair-recover', label: 'Recover the recorded transaction', scope: 'repair-recovery', approvalRequired: true,
    description: 'This handles only the previously approved interrupted repair; it does not start a new transformation.'
  });
  context.presentation.commandIdentity('repair', 'Reviewed project repair with separate action-specific approval');
  try {
    const issue = repairRequestIssue(request);
    if (issue) throw new Error(issue);
    if (request.capabilities) {
      if (request.json) context.presentation.rawStdout(`${JSON.stringify(repairCapabilities, null, 2)}\n`);
      else {
        context.presentation.definitions('Packaged repair capabilities', [
          { label: 'CLI', value: repairCapabilities.cliVersion },
          { label: 'Repair contract', value: String(repairCapabilities.repairContractVersion) },
          { label: 'Recipes', value: repairCapabilities.recipes.map((entry) => `${entry.id} v${entry.version}`).join(', ') }
        ]);
        context.presentation.bullets('Approval boundaries', Object.values(repairCapabilities.approval)
          .flatMap((entry) => typeof entry === 'string' ? [entry] : [...entry]));
        context.presentation.bullets('Limitations', [
          repairCapabilities.boundaries.applicationPatch, repairCapabilities.boundaries.verificationIsolation,
          repairCapabilities.boundaries.statefulMigration, repairCapabilities.boundaries.agentInstallation
        ]);
      }
      return 0;
    }
    const discovered = request.project ? root : await findProjectRoot(context.cwd);
    if (!discovered) throw new Error('No Liftoff project was found. Select an existing project with liftoff repair <project-path>; repair never initializes a directory.');
    const details = await lstat(discovered);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Repair project root must be a regular directory, not a link.');
    root = await realpath(discovered);
    const approvalStore = repairApprovalStore(root, storage);
    const pendingUpdate = await inspectExecutionJournal(root, 'update');
    if (pendingUpdate.status !== 'absent') {
      const command = { executable: 'liftoff', args: ['update', '--project', root] };
      const { commandShellForPlatform, formatShellCommand } = await import('../../adapters/process/shell-command.js');
      emit({ ...base(), message: 'An unfinished update must be recovered before repair.',
        blockers: pendingUpdate.reason ? [pendingUpdate.reason] : [],
        nextActions: [
          { kind: 'command', id: 'update-recovery', label: 'Recover the unfinished update', description: 'Update owns its recorded transaction, not repair.',
            command, displayCommand: formatShellCommand(command, commandShellForPlatform(process.platform)),
            cwd: root, scope: 'managed-update', approvalRequired: true },
          repairCheckAction(root)
        ] });
      return 2;
    }
    const pending = await inspectExecutionJournal(root, 'repair', { approvalStore });
    const pendingWorkspaces = await inspectRepairVerificationWorkspaces(root, storage);
    if (request.recover) {
      const result = await recoverExecutionJournal(root, 'repair', { approvalStore });
      const workspaceRecovery = await recoverRepairVerificationWorkspaces(root, storage);
      committed = result.committed;
      const allAbsent = result.status === 'absent' && workspaceRecovery.status === 'absent';
      const isBlocked = result.status === 'blocked' || workspaceRecovery.status === 'blocked' || workspaceRecovery.status === 'partial';
      const blockers = [
        ...result.rollbackFailures,
        ...result.cleanupFailures,
        ...workspaceRecovery.issues.map((entry) => entry.message),
        ...workspaceRecovery.results.flatMap((entry) => entry.issues.map((i) => i.message))
      ];
      emit({
        ...base(), status: isBlocked ? 'blocked' : 'recovered',
        repairScopeComplete: allAbsent,
        recovery: { schemaVersion: pending.schemaVersion, identity: pending.repairIdentity },
        privateWorkspaceRecovery: workspaceRecovery,
        message: allAbsent ? 'No interrupted local repair transaction exists.' :
          isBlocked ? 'Repair recovery is blocked; concurrent project changes or uncertain private workspaces were preserved.' :
            'Recovered recorded repair material. No new transformation was started.',
        blockers,
        nextActions: [repairCheckAction(root)]
      });
      return allAbsent ? 0 : 2;
    }
    if (pending.status !== 'absent' || pendingWorkspaces.status !== 'absent') {
      committed = pending.committed;
      const blockers = [
        ...(pending.reason ? [pending.reason] : []),
        ...pendingWorkspaces.issues.map((entry) => entry.message),
        ...pendingWorkspaces.workspaces.flatMap((w) => w.issues.map((i) => i.message))
      ];
      emit({
        ...base(),
        message: pending.status !== 'absent'
          ? 'An interrupted local repair requires explicit recovery.'
          : 'Retained private verification workspaces require explicit recovery.',
        recovery: { schemaVersion: pending.schemaVersion, identity: pending.repairIdentity },
        privateWorkspaces: pendingWorkspaces,
        blockers,
        nextActions: [recoverAction()]
      });
      return 2;
    }
    selectedManifest = await loadManifest(root);
    if (!selectedManifest) throw new Error('Repair requires a valid loaded Liftoff manifest.');
    const requestedFingerprint = request.approvePlan ?? request.verifyPlan;
    let saved = requestedFingerprint ? await loadRepairPreview(root, requestedFingerprint, now(), storage) : undefined;
    const requestedRecipe = saved?.recipe.id ?? request.recipe;
    if (request.inspectLayout || request.applicationPatch ||
        request.verifyPlan && requestedRecipe !== 'azure-baseline-settings' || requestedRecipe === 'application-layout-patch') {
      const { repairApplicationProject } = await import('./patch-flow.js');
      return await repairApplicationProject({ root, manifest: selectedManifest, request, context, storage, saved });
    }
    if (selectedManifest.project.workload.kind === 'components') {
      emit({
        ...base(), status: 'blocked',
        message: 'Infrastructure repair is not applicable to component-only adoption without recorded Azure infrastructure.',
        blockers: ['No backend, cloud environment or generated infrastructure is implied by the selected component profile.'],
        nextActions: [repairCommandAction(root, ['--inspect-layout'], {
          id: 'application-inventory', label: 'Inspect broader application layout', scope: 'application-layout',
          description: 'Read-only actual-file inventory and target identities; no automatic folder moves or starter replacement.'
        })]
      });
      return 2;
    }
    const scope = saved
      ? { live: saved.live, subscription: saved.subscription ?? undefined }
      : { live: request.live, subscription: request.subscription?.toLowerCase() };

    const broader = [
      repairCommandAction(root, ['--inspect-layout'], {
        id: 'application-inventory', label: 'Inspect broader application layout', scope: 'application-layout',
        description: 'Read-only actual-file inventory and target identities; no automatic folder moves or starter replacement.'
      }),
      ...repairAgentActions(root, selectedManifest),
      ...repairResumeActions(root, selectedManifest)
    ];

    if (requestedRecipe === 'azure-baseline-settings') {
      return repairAzureBaseline({ root, request, context, storage, saved, broader });
    }

    let inspection = await inspect(root, scope, context);
    const identity = repairExecutionIdentity(liftoffVersion, 'azure-local-layout');
    executionIdentity = identity;
    const report = { ...base(), identity, layout: inspection.candidate.layout, eligibility: inspection.discovery };
    if (inspection.blockers.length) {
      const nextActions = [repairCheckAction(root), ...broader];
      if (!scope.live && !inspection.candidate.blockers.length && inspection.discovery.status === 'unknown') {
        nextActions.unshift(repairCommandAction(root, ['--check', '--live', '--subscription', '<subscription-id>'], {
          id: 'repair-live-check', label: 'Confirm subscription and check absence', scope: 'live-metadata',
          description: 'Only bounded metadata reads with existing authentication; confirm and substitute the actual subscription UUID first.',
          approvalRequired: true, requiresInput: ['subscription-id']
        }));
      } else if (inspection.discovery.status === 'stateful' || inspection.discovery.observations.some((entry) => entry.status === 'present')) {
        nextActions.unshift({
          kind: 'guidance', id: 'preserve-state', label: 'Keep original infrastructure and state unchanged',
          description: 'This public local lane does not execute deployed-state cutover. A separately qualified protected migration is required.',
          cwd: root, scope: 'stateful-migration', approvalRequired: false
        });
      }
      emit({ ...report, message: 'Infrastructure repair is plan-only; no project or state files were changed.',
        blockers: inspection.blockers, operations: mutationDescriptors(inspection.mutations), nextActions });
      return 2;
    }
    if (inspection.candidate.layout === 'independent') {
      emit({ ...report, status: 'current', repairScopeComplete: true, verification: 'not-required',
        message: 'No layout reorganization is required. Local baseline verification and cloud activation remain separate.',
        nextActions: broader });
      return 0;
    }
    const preview = previewFor(root, inspection, scope, saved ? new Date(saved.createdAt) : now());
    fingerprint = preview.fingerprint;
    if (!saved) {
      const receipt = await createScopedUserLocalRecordStore(root, 'repair-preview', storage).write(preview.fingerprint, preview);
      emit({
        ...report, status: 'available', message: 'Review the exact local reorganization below. No project files have been changed.',
        fingerprint: preview.fingerprint, expiresAt: preview.expiresAt, receiptPath: receipt.path,
        operations: mutationDescriptors(inspection.mutations), validationPolicy: repairValidationPolicy,
        validationSummary: [
          repairValidationPolicy.effects,
          ...(inspection.validationTool ? [
            `Installed OpenTofu: ${inspection.validationTool.file.path}; SHA-256 ${inspection.validationTool.file.digest}.`
          ] : []),
          `tofu ${repairValidationPolicy.formatCommand.join(' ')} in the isolated infrastructure root`,
          ...repairValidationPolicy.commands.map((args) => `tofu ${args.join(' ')} in each isolated environment root`),
          ...repairManifestLinkDeclarations(inspection.mutations).map((link) => `Preserve the exact manifest repair provenance link at ${link.pathParts.join('/')}.`),
          'Approval includes only this isolated OpenTofu validation, the listed infrastructure/manifest files and immutable history; not application scripts, state migration or deployment.'
        ],
        historyPath: path.join(root, ...repairHistoryRoot, preview.fingerprint),
        nextActions: [
          repairCommandAction(root, (scope.live && scope.subscription) ? ['--live', '--subscription', scope.subscription] : [], {
            id: 'repair-interactive', label: 'Review and approve interactively', approvalRequired: true,
            description: 'A genuine terminal asks Yes/No with default No. No fingerprint entry is needed.'
          }),
          repairCommandAction(root, ['--approve-plan', preview.fingerprint], {
            id: 'repair-automation-apply', label: 'Optional exact-plan automation', approvalRequired: true,
            description: 'Use only after explicit approval of the displayed scope; the same eligibility and stale-plan checks apply.'
          }),
          ...repairAgentActions(root, selectedManifest)
        ]
      });
      approval = await requestRepairApproval(request, preview.fingerprint,
        'Run the displayed isolated OpenTofu validation and apply these exact infrastructure, manifest and history changes?', context, root);
      if (approval.status !== 'approved') {
        if (approval.status !== 'required') emit({
          ...report, approval, message: 'Repair approval was declined or cancelled; no validation or project file transaction ran.',
          nextActions: [repairCheckAction(root), ...broader]
        });
        return 2;
      }
      const loaded = await loadRepairPreview(root, preview.fingerprint, now(), storage);
      inspection = await inspect(root, scope, context);
      if (inspection.blockers.length) throw new Error(`Repair eligibility changed while approval was open: ${inspection.blockers.join(' ')}`);
      assertSamePreview(previewFor(root, inspection, scope, new Date(loaded.createdAt)), loaded);
      saved = loaded;
    }
    const activeSaved = saved;
    assertSamePreview(preview, activeSaved);
    approval ??= await requestReviewedFileApproval({
      kind: 'repair', projectRoot: root, fingerprint: activeSaved.fingerprint, approvePlan: request.approvePlan
    }, { stderr: context.stderr });
    const activeApproval = approval;
    const history = [...repairHistoryRoot, activeSaved.fingerprint];
    historyPath = path.join(root, ...history);
    const historyMutations = repairHistoryMutations({
      preview: activeSaved, sourceManifest: inspection.sourceManifest, snapshots: inspection.snapshots,
      mutations: inspection.mutations, verificationPolicy: repairValidationPolicy
    });
    const validatePlan = async () => {
      await loadRepairPreview(root, activeSaved.fingerprint, now(), storage);
      const current = await inspect(root, scope, context);
      if (current.blockers.length) throw new Error(`Repair eligibility changed before commit: ${current.blockers.join(' ')}`);
      assertSamePreview(previewFor(root, current, scope, new Date(activeSaved.createdAt)), activeSaved);
    };
    const bindingOptions = {
      projectRoot: root,
      sourceFiles: inspection.snapshots.map((snapshot) => snapshot.pathParts),
      directoryPaths: inspection.candidate.directoryInventory.map((directory) => directory.pathParts),
      expiresAt: activeSaved.expiresAt, maximumFileBytes: 4 * 1024 * 1024
    };
    const validationBinding = await captureInputBinding(bindingOptions);
    const assertValidationInputs = async () => {
      await loadRepairPreview(root, activeSaved.fingerprint, now(), storage);
      await assertReviewedFileApprovalCurrent(root, 'repair', activeSaved.fingerprint, activeApproval);
      await assertInputBindingUnchanged(validationBinding, bindingOptions, { nowIso: now().toISOString() });
    };
    const outcome = await withCooperatingExecutionLock(root, async () => {
      await assertReviewedFileApprovalCurrent(root, 'repair', activeSaved.fingerprint, activeApproval);
      await validatePlan();
      validationAttempted = true;
      await validateRepairCandidate(inspection.candidate,
        manifestEnvironments(inspection.manifest),
        context.runner ?? new NodeCommandRunner(), context.env, {
          projectRoot: root, preview: activeSaved, tool: inspection.validationTool!,
          storage: { ...storage, clock: now }, assertCurrent: assertValidationInputs
        });
      validationCompleted = true;
      const historySnapshots = await Promise.all(historyMutations.map((entry) => captureProjectFileSnapshot(root, entry.pathParts)));
      if (historySnapshots.some((entry) => entry.content !== undefined)) throw new Error('Repair history already exists. It is immutable; request a fresh check rather than overwriting it.');
      const mutations = [...historyMutations, ...inspection.mutations];
      const originals = [...inspection.snapshots, ...historySnapshots];
      const result = await applyReviewedExecution(root, mutations, {
        transactionKind: 'repair', repairIdentity: identity, planFingerprint: activeSaved.fingerprint, approvalStore,
        approval: activeApproval, preconditions: originals, storage, validatePlan,
        verifyCommitted: async () => {
          const post = await loadManifest(root);
          if (assessInfrastructureLayout(post).kind !== 'independent') throw new Error('Repair committed, but current independent layout could not be verified.');
          await assertRepairReadback(root, mutations, originals);
        }
      });
      committed ||= result.committed;
      return result;
    }, { currentCommand: 'repair', storage });
    committed = outcome.committed;
    if (!committed) {
      emit({ ...report, approval, committed, status: 'failed',
        message: 'The approved local repair did not commit.', blockers: [...outcome.rollbackFailures, ...outcome.cleanupFailures],
        nextActions: [recoverAction()] });
      return 1;
    }
    emit({
      ...report, ...base(), approval, operationKind: 'apply', status: outcome.operation.status === 'completed' ? 'applied' : 'partial', committed,
      repairScopeComplete: outcome.operation.status === 'completed',
      verification: outcome.operation.verification === 'passed' ? 'passed' : 'incomplete',
      fingerprint: activeSaved.fingerprint, historyPath: path.join(root, ...history),
      message: outcome.operation.status === 'completed'
        ? 'Infrastructure files and actual provenance were repaired; original manifest history was preserved. Governance activation is not claimed.'
        : 'The approved infrastructure transaction committed, but current readback or cleanup is incomplete. Original history and later edits were preserved.',
      blockers: outcome.cleanupFailures,
      nextActions: outcome.cleanupFailures.length ? [recoverAction()] : broader
    });
    return outcome.cleanupFailures.length ? 2 : 0;
  } catch (error) {
    const failure = operationFailureOutcome({
      committed, attemptedEffects: validationAttempted,
      rollbackFailures: error instanceof ProjectFileTransactionError ? error.rollbackFailures : undefined
    });
    emit({
      ...base(), ...failure,
      message: committed ? 'Infrastructure repair committed, but follow-up verification or cleanup is incomplete.' : 'Local repair stopped; no successful commit was reported.',
      blockers: [error instanceof Error ? error.message : 'Unexpected repair failure.'],
      ...(validationAttempted ? { validationSummary: ['Previously approved isolated OpenTofu validation was attempted; no application-script, state or deployment authority was granted.'] } : {}),
      nextActions: [...(validationAttempted || committed ? [recoverAction()] : []),
        repairCheckAction(root), ...(selectedManifest ? repairAgentActions(root, selectedManifest) : [])]
    });
    return committed ? 2 : 1;
  }
}
