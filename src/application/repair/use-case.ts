import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionContext } from '../context.js';
import { loadManifest, parseManifest } from '../project/manifest.js';
import { findProjectRoot } from '../../adapters/filesystem/project-discovery.js';
import { captureProjectFileSnapshot, type ProjectFileMutation, type ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import {
  applyReviewedUpdateTransaction, inspectReviewedUpdateTransaction, recoverReviewedUpdateTransaction
} from '../../adapters/filesystem/reviewed-update-transaction.js';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { isRecord } from '../../domain/governance/activation/canonical-json.js';
import {
  assessInfrastructureLayout, retiredFlatRootInfrastructureIdentities
} from '../../domain/project/infrastructure-layout.js';
import type { LiftoffManifest } from '../../domain/project/contracts.js';
import { commandShellForPlatform, formatShellCommand } from '../../adapters/process/shell-command.js';
import { NodeCommandRunner } from '../../process-runner.js';
import { inspectInfrastructureRepair, type InfrastructureRepairCandidate } from './infrastructure.js';
import { discoverRepairEligibility, repairCommandLimits, repairDiscoveryLimits, type RepairDiscovery } from './discovery.js';
import {
  buildRepairPreview, byteDigest, loadRepairPreview, mutationDescriptors, repairApprovalStore,
  repairHistoryFiles, repairHistoryRoot, repairRecipeVersion, snapshotDescriptors, type RepairPreview
} from './preview.js';
import { repairValidationPolicy, validateRepairCandidate } from './validation.js';

export interface RepairRequest {
  project?: string;
  check: boolean;
  live: boolean;
  subscription?: string;
  approvePlan?: string;
  recover: boolean;
  json: boolean;
}

interface RepairInspection {
  manifest: LiftoffManifest;
  candidate: InfrastructureRepairCandidate;
  snapshots: ProjectFileSnapshot[];
  mutations: ProjectFileMutation[];
  discovery: RepairDiscovery;
  blockers: string[];
  sourceManifest: Buffer;
}

interface RepairReport {
  schemaVersion: 1;
  operationKind: 'check' | 'apply' | 'recover';
  requestedScope: 'local-infrastructure';
  projectRoot: string;
  status: 'current' | 'available' | 'blocked' | 'applied' | 'failed' | 'recovered' | 'partial';
  committed: boolean;
  repairScopeComplete: boolean;
  verification: 'not-run' | 'not-required' | 'passed' | 'incomplete';
  message: string;
  blockers: string[];
  nextActions: string[];
  layout?: string;
  eligibility?: RepairDiscovery;
  fingerprint?: string;
  expiresAt?: string;
  receiptPath?: string;
  historyPath?: string;
  operations?: ReturnType<typeof mutationDescriptors>;
  validationPolicy?: typeof repairValidationPolicy;
}

const projectCommand = (root: string, command: string, args: string[] = []) =>
  formatShellCommand({ executable: 'liftoff', args: [command, '--project', root, ...args] }, commandShellForPlatform(process.platform));

function emit(context: ExecutionContext, request: RepairRequest, report: RepairReport): void {
  if (request.json) {
    context.presentation.rawStdout(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  context.presentation.status(
    report.status === 'failed' ? 'error' :
      ['blocked', 'partial', 'available'].includes(report.status) ? 'warning' : 'success',
    'Project infrastructure repair', report.message
  );
  context.presentation.definitions('Selected repair scope', [
    { label: 'Project', value: report.projectRoot },
    { label: 'Layout', value: report.layout ?? 'not inspected' },
    { label: 'Eligibility', value: report.eligibility?.status ?? 'not inspected' },
    ...(report.fingerprint ? [{ label: 'Plan fingerprint', value: report.fingerprint }] : []),
    ...(report.expiresAt ? [{ label: 'Expires', value: report.expiresAt }] : []),
    ...(report.receiptPath ? [{ label: 'External receipt', value: report.receiptPath }] : [])
  ]);
  if (report.operations?.length) context.presentation.bullets('Exact project file changes',
    report.operations.map((entry) => `${entry.type} ${entry.pathParts.join('/')}${entry.digest ? ` (SHA-256 ${entry.digest})` : ''}`));
  if (report.validationPolicy) context.presentation.bullets('Approved validation scope', [
    report.validationPolicy.effects,
    `tofu ${report.validationPolicy.formatCommand.join(' ')} in the isolated infrastructure root`,
    ...report.validationPolicy.commands.map((args) => `tofu ${args.join(' ')} in each isolated environment root`),
    `Each command is bounded to ${report.validationPolicy.timeoutMs / 1000} seconds.`
  ]);
  if (report.blockers.length) context.presentation.bullets('Blockers', report.blockers);
  context.presentation.bullets('Next steps', report.nextActions);
}

function repairedManifest(manifest: LiftoffManifest, original: Buffer, candidate: InfrastructureRepairCandidate): string {
  const raw: unknown = JSON.parse(original.toString('utf8'));
  if (!isRecord(raw) || ![6, 7].includes(manifest.artifactVersion)) {
    throw new Error('Run liftoff update --check and approve the manifest upgrade before local infrastructure repair.');
  }
  const newNames = new Set(candidate.artifacts.map((artifact) => artifact.logicalName));
  const retired = new Set(retiredFlatRootInfrastructureIdentities.map((identity) => `${identity.logicalName}\0${identity.pathParts.join('/')}`));
  const next = {
    ...raw,
    projectArtifacts: [
      ...manifest.projectArtifacts.filter((artifact) => !newNames.has(artifact.logicalName) &&
        !retired.has(`${artifact.logicalName}\0${artifact.pathParts.join('/')}`)),
      ...candidate.artifacts
    ]
  };
  const parsed = parseManifest(next);
  if (assessInfrastructureLayout(parsed).kind !== 'independent') {
    throw new Error('Repair candidate did not establish the complete independent infrastructure inventory.');
  }
  return `${JSON.stringify(next, null, 2)}\n`;
}

async function inspect(root: string, request: Pick<RepairRequest, 'live' | 'subscription'>, context: ExecutionContext): Promise<RepairInspection> {
  const manifestSnapshot = await captureProjectFileSnapshot(root, ['liftoff.manifest.json']);
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
  const mutations = candidate.layout === 'independent' || candidate.blockers.length ? [] : [
    ...candidate.mutations,
    {
      type: 'write' as const, pathParts: ['liftoff.manifest.json'],
      content: repairedManifest(manifest, manifestSnapshot.content, candidate)
    }
  ];
  return { manifest, candidate, snapshots, mutations, discovery, blockers, sourceManifest: manifestSnapshot.content };
}

function previewFor(root: string, inspection: RepairInspection, scope: Pick<RepairRequest, 'live' | 'subscription'>, now: Date) {
  return buildRepairPreview({
    projectRoot: root, snapshots: inspection.snapshots, mutations: inspection.mutations,
    scope: {
      environments: inspection.manifest.project.workload.environments,
      resourceGroups: inspection.candidate.resourceGroups, statePaths: inspection.candidate.statePaths,
      directoryInventory: inspection.candidate.directoryInventory,
      discoveryPolicy: { ...repairCommandLimits, ...repairDiscoveryLimits },
      observations: inspection.discovery.observations, historyRoot: repairHistoryRoot, historyFiles: repairHistoryFiles
    },
    live: scope.live, subscription: scope.subscription, now
  });
}

function assertSamePreview(current: RepairPreview, saved: RepairPreview): void {
  if (current.fingerprint !== saved.fingerprint) {
    throw new Error('Repair inputs, destinations or exact effects changed after preview. No new repair was committed; run a fresh check.');
  }
}

export async function repairProject(request: RepairRequest, context: ExecutionContext): Promise<number> {
  let root = request.project ? path.resolve(context.cwd, request.project) : context.cwd;
  let committed = false;
  const now = () => context.updateNow?.() ?? new Date();
  const storage = { ...context.updatePreview, env: context.updatePreview?.env ?? context.env };
  const base = (): RepairReport => ({
    schemaVersion: 1, operationKind: request.recover ? 'recover' : request.approvePlan ? 'apply' : 'check',
    requestedScope: 'local-infrastructure', projectRoot: root, status: 'blocked', committed,
    repairScopeComplete: false, verification: 'not-run', message: '', blockers: [], nextActions: []
  });
  context.presentation.commandIdentity('repair', 'Reviewed local infrastructure reorganization');
  try {
    if ((request.check && (request.approvePlan || request.recover)) || (request.recover && request.approvePlan) ||
        ((request.approvePlan || request.recover) && (request.live || request.subscription)) ||
        request.live !== Boolean(request.subscription) ||
        request.subscription !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(request.subscription)) {
      throw new Error('Invalid repair authority: check/live/subscription, exact-plan application and recovery are separate scopes.');
    }
    const discovered = request.project ? root : await findProjectRoot(context.cwd);
    if (!discovered) throw new Error('No Liftoff project was found. Select an existing project with --project; repair never initializes a directory.');
    const details = await lstat(discovered);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Repair project root must be a regular directory, not a link.');
    root = await realpath(discovered);
    await loadManifest(root);
    const approvalStore = repairApprovalStore(root, storage);
    const pendingUpdate = await inspectReviewedUpdateTransaction(root);
    if (pendingUpdate.status !== 'absent') {
      emit(context, request, { ...base(), message: 'An unfinished update must be recovered before repair.',
        nextActions: [projectCommand(root, 'update'), projectCommand(root, 'repair', ['--check'])] });
      return 2;
    }
    const pending = await inspectReviewedUpdateTransaction(root, { transactionKind: 'repair', approvalStore });
    if (request.recover) {
      const result = await recoverReviewedUpdateTransaction(root, { transactionKind: 'repair', approvalStore });
      committed = result.committed;
      emit(context, request, {
        ...base(), status: result.status === 'blocked' ? 'blocked' : 'recovered',
        message: result.status === 'absent' ? 'No interrupted local repair transaction exists.' :
          result.status === 'blocked' ? 'Repair recovery is blocked; concurrent project changes were preserved.' :
            'Recovered the previously approved local repair. No new transformation was started.',
        blockers: [...result.rollbackFailures, ...result.cleanupFailures],
        nextActions: [projectCommand(root, 'repair', ['--check'])]
      });
      return result.status === 'absent' ? 0 : 2;
    }
    if (pending.status !== 'absent') {
      committed = pending.committed;
      emit(context, request, { ...base(), message: 'An interrupted local repair requires explicit recovery.',
        blockers: pending.reason ? [pending.reason] : [],
        nextActions: [projectCommand(root, 'repair', ['--recover'])] });
      return 2;
    }
    const saved = request.approvePlan ? await loadRepairPreview(root, request.approvePlan, now(), storage) : undefined;
    const scope = saved
      ? { live: saved.live, subscription: saved.subscription ?? undefined }
      : { live: request.live, subscription: request.subscription?.toLowerCase() };
    const inspection = await inspect(root, scope, context);
    const report = { ...base(), layout: inspection.candidate.layout, eligibility: inspection.discovery };
    const resume = [projectCommand(root, 'update', ['--check']), formatShellCommand({
      executable: 'liftoff', args: ['governance', 'status', '--project', root, '--scope', 'local']
    }, commandShellForPlatform(process.platform))];
    if (inspection.blockers.length) {
      const nextActions = [projectCommand(root, 'repair', ['--check'])];
      if (!scope.live && !inspection.candidate.blockers.length && inspection.discovery.status === 'unknown') {
        nextActions.unshift(`Confirm the deployment subscription, then run ${projectCommand(root, 'repair',
          ['--check', '--live', '--subscription', '<subscription-id>'])}. This only reads metadata with your existing authentication.`);
      } else if (inspection.discovery.status === 'stateful' || inspection.discovery.observations.some((entry) => entry.status === 'present')) {
        nextActions.unshift('Keep the original roots and state unchanged. This CLI local lane does not execute deployed-state cutover; a separately qualified protected migration is required.');
      }
      emit(context, request, { ...report, message: 'Infrastructure repair is plan-only; no project or state files were changed.',
        blockers: inspection.blockers, operations: mutationDescriptors(inspection.mutations), nextActions });
      return 2;
    }
    if (inspection.candidate.layout === 'independent') {
      emit(context, request, { ...report, status: 'current', repairScopeComplete: true, verification: 'not-required',
        message: 'No layout reorganization is required. Local baseline verification and cloud activation remain separate.',
        nextActions: resume });
      return 0;
    }
    const preview = previewFor(root, inspection, scope, saved ? new Date(saved.createdAt) : now());
    if (!saved) {
      const receipt = await createScopedUserLocalRecordStore(root, 'repair-preview', storage).write(preview.fingerprint, preview);
      emit(context, request, {
        ...report, status: 'available', message: 'Supported local reorganization is ready for exact-plan approval. No project files were changed.',
        fingerprint: preview.fingerprint, expiresAt: preview.expiresAt, receiptPath: receipt.path,
        operations: mutationDescriptors(inspection.mutations), validationPolicy: repairValidationPolicy,
        historyPath: path.join(root, ...repairHistoryRoot, preview.fingerprint),
        nextActions: [projectCommand(root, 'repair', ['--approve-plan', preview.fingerprint]),
          'Approval covers only the listed infrastructure and manifest changes, immutable provenance history, and isolated validation; not deployment or state migration.']
      });
      return 2;
    }
    assertSamePreview(preview, saved);
    await validateRepairCandidate(inspection.candidate, inspection.manifest.project.workload.environments,
      context.runner ?? new NodeCommandRunner(), context.env);
    const history = [...repairHistoryRoot, saved.fingerprint];
    const historyMutations: ProjectFileMutation[] = [
      { type: 'write', pathParts: [...history, 'manifest.json'], content: inspection.sourceManifest, mode: 0o600 },
      { type: 'write', pathParts: [...history, 'receipt.json'], content: `${JSON.stringify({
        schemaVersion: 1, kind: 'liftoff-local-infrastructure-repair', recipe: repairRecipeVersion,
        fingerprint: saved.fingerprint, projectRoot: root, reviewedAt: saved.createdAt,
        source: snapshotDescriptors(inspection.snapshots), target: mutationDescriptors(inspection.mutations),
        verification: repairValidationPolicy, activationEvidence: 'not-issued'
      }, null, 2)}\n`, mode: 0o600 }
    ];
    const historySnapshots = await Promise.all(historyMutations.map((entry) => captureProjectFileSnapshot(root, entry.pathParts)));
    if (historySnapshots.some((entry) => entry.content !== undefined)) throw new Error('Repair history already exists. It is immutable; request a fresh check rather than overwriting it.');
    const outcome = await applyReviewedUpdateTransaction(root, [...historyMutations, ...inspection.mutations], {
      transactionKind: 'repair', planFingerprint: saved.fingerprint, approvalStore,
      preconditions: [...inspection.snapshots, ...historySnapshots],
      validatePlan: async () => {
        await loadRepairPreview(root, saved.fingerprint, now(), storage);
        const current = await inspect(root, scope, context);
        if (current.blockers.length) throw new Error(`Repair eligibility changed before commit: ${current.blockers.join(' ')}`);
        assertSamePreview(previewFor(root, current, scope, new Date(saved.createdAt)), saved);
      }
    });
    committed = outcome.committed;
    if (!committed) {
      emit(context, request, { ...report, committed, status: 'failed',
        message: 'The approved local repair did not commit.', blockers: [...outcome.rollbackFailures, ...outcome.cleanupFailures],
        nextActions: [projectCommand(root, 'repair', ['--recover'])] });
      return 1;
    }
    const post = await loadManifest(root);
    if (assessInfrastructureLayout(post).kind !== 'independent') throw new Error('Repair committed, but current independent layout could not be verified.');
    for (const mutation of inspection.mutations) {
      const actual = await captureProjectFileSnapshot(root, mutation.pathParts);
      if (mutation.type === 'write'
        ? actual.content === undefined || byteDigest(actual.content) !== byteDigest(mutation.content)
        : actual.content !== undefined) {
        throw new Error(`Repair committed, but ${mutation.pathParts.join('/')} changed before final readback.`);
      }
    }
    emit(context, request, {
      ...report, status: outcome.cleanupFailures.length ? 'partial' : 'applied', committed,
      repairScopeComplete: outcome.cleanupFailures.length === 0, verification: 'passed',
      fingerprint: saved.fingerprint, historyPath: path.join(root, ...history),
      message: 'Infrastructure files and actual provenance were repaired; original manifest history was preserved. Governance activation is not claimed.',
      blockers: outcome.cleanupFailures,
      nextActions: outcome.cleanupFailures.length ? [projectCommand(root, 'repair', ['--recover'])] : resume
    });
    return outcome.cleanupFailures.length ? 2 : 0;
  } catch (error) {
    emit(context, request, {
      ...base(), status: committed ? 'partial' : 'failed', verification: committed ? 'incomplete' : 'not-run',
      message: committed ? 'Infrastructure repair committed, but follow-up verification or cleanup is incomplete.' : 'Local repair stopped; no successful commit was reported.',
      blockers: [error instanceof Error ? error.message : 'Unexpected repair failure.'],
      nextActions: [projectCommand(root, 'repair', ['--check'])]
    });
    return committed ? 2 : 1;
  }
}
