import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CommandResult, CommandRunner } from '../process-runner.js';
import { formatCommand, NodeCommandRunner } from '../process-runner.js';
import type { ExternalCommand, LiftoffManifest } from '../types.js';
import {
  applyProjectFileTransaction,
  readProjectFile,
  resolveProjectPath,
  validateArtifactPathParts,
  type ProjectFileMutation
} from '../file-system.js';
import {
  archiveGeneratedSeedForPhase,
  generatedSeedChangeName,
  validateGeneratedSeedForPhase,
  verifyGeneratedSeedBaselineForPhase
} from './seed-lifecycle.js';
import {
  canonicalApprovalEnvelopeHash,
  evaluateApprovalForTransitionPlan,
  transitionPlanForPhase
} from './approvals.js';
import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import {
  credentialPolicyPathParts,
  detectCredentialLeaks
} from './credentials.js';
import {
  evidenceHeaderDigest,
  selectLatestPhaseEvidence,
  type EvidenceFreshnessContext
} from './evidence.js';
import {
  phaseContractDigests
} from './graph.js';
import {
  buildApprovedPhase0FactsFromState,
  renderGovernanceChangeWritePlan,
  stateWithSelectedActiveChange,
  type GovernanceSourceOfTruthInspection
} from './source-of-truth.js';
import type {
  ApprovalEnvelope,
  BootstrapStateRetention,
  EvidenceHeader,
  LiveReadbackProof,
  ManagedPhaseGraph,
  MutationClass,
  PhaseEvidenceRecord,
  PhaseGraphNode,
  PhaseId,
  RollbackOperation,
  SavedTransitionPlan,
  TransitionOperation,
  TransitionOperationDestination,
  TransitionRollbackPlan,
  UserActivationState
} from './types.js';
import { phaseIds } from './types.js';
import {
  validateEvidenceHeader,
  validateSavedTransitionPlan,
  validateUserActivationState
} from './validators.js';
import {
  activationStateContentHash,
  type LoadedActivationState
} from './activation-state.js';

export const governancePlanDirectoryPathParts = ['governance', 'plans'] as const;

const planLifetimeMs = 15 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;
const remoteImportPayloadKind = 'remote-import-verified.v1';
const workflowSourcePayloadKind = 'workflow-source-ready.v1';
const greenRedPayloadKind = 'green-red-proof.v1';
const bootstrapStateDisposedPayloadKind = 'bootstrap-state-disposed.v1';
const engineProducer = 'liftoff-governance-transition-engine';

export interface GovernanceTransitionInspection {
  projectRoot: string;
  manifest: LiftoffManifest;
  graph: ManagedPhaseGraph;
  graphHash: string;
  loadedState?: LoadedActivationState;
  state: UserActivationState;
  approvals: readonly ApprovalEnvelope[];
  evidence: readonly PhaseEvidenceRecord[];
  contexts: Record<PhaseId, EvidenceFreshnessContext>;
  readiness: {
    nextReadyPhase: PhaseId | null;
    phases: Record<PhaseId, { state: string; blockers: readonly string[] }>;
  };
  sourceOfTruth: GovernanceSourceOfTruthInspection;
}

export interface GitRepositoryInspection {
  insideWorkTree: boolean;
  root: string | null;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  status: readonly GitStatusEntry[];
  remotes: readonly GitRemote[];
  issues: readonly string[];
}

export interface GitStatusEntry {
  index: string;
  worktree: string;
  path: string;
}

export interface GitRemote {
  name: string;
  url: string;
}

export interface Phase0DiscoveryFacts {
  repositoryId: string;
  repositoryName: string;
  defaultBranch: string;
  baselineDigest: string;
  privateStagingDast: boolean;
  credentialRequired: boolean;
  statePath: UserActivationState['applicability']['statePath'];
  approvedFacts: readonly { id: string; value: string | number | boolean | null }[];
}

export interface GitHubRulesetWriteResult {
  resourceId: string;
  sourceDigest: string;
  readbackDigest: string;
}

export interface GitHubRulesetAdapter {
  applyRuleset(input: {
    repository: string;
    sourceDigest: string;
    approvalEnvelopeId: string;
  }): Promise<GitHubRulesetWriteResult>;
  readRuleset(input: {
    repository: string;
    sourceDigest: string;
  }): Promise<GitHubRulesetWriteResult>;
}

export interface PhaseAdapterOutcome {
  status: 'completed' | 'blocked';
  resultState?: EvidenceHeader['result'] | 'approved';
  blocker?: string;
  evidencePayload?: unknown;
  liveReadback?: readonly LiveReadbackProof[];
  stateOverride?: UserActivationState;
  fileMutations?: readonly ProjectFileMutation[];
  completedOperations?: readonly TransitionOperation[];
  cleanupWarnings?: readonly string[];
  retryableWithoutStateMutation?: boolean;
}

export interface GovernancePhaseAdapter {
  phaseId: PhaseId;
  execute(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome>;
}

export interface PhaseAdapterExecutionInput {
  inspection: GovernanceTransitionInspection;
  plan: SavedTransitionPlan;
  phase: PhaseGraphNode;
  runner: CommandRunner;
  adapters: GovernanceTransitionAdapters;
  now: Date;
}

export interface GovernanceTransitionAdapters {
  phases?: Partial<Record<PhaseId, GovernancePhaseAdapter>>;
  githubRulesets?: GitHubRulesetAdapter;
}

export interface ApplyNextPreview {
  schemaVersion: 1;
  command: 'governance apply-next';
  projectRoot: string;
  execute: boolean;
  applied: false;
  authorized: boolean;
  reason: string;
  message: string;
  selectedPhase: PhaseId | null;
  nextReadyPhase: PhaseId | null;
  approval: SavedTransitionPlan['approval'] | null;
  proposedMutations: {
    local: readonly MutationClass[];
    remote: readonly MutationClass[];
    operations: readonly TransitionOperation[];
  };
  savedPlan: null | {
    pathParts: readonly string[];
    digest: string;
  };
  noWrites: boolean;
  blockers: readonly string[];
}

export interface ApplyNextExecutionResult extends Omit<ApplyNextPreview, 'applied' | 'savedPlan' | 'noWrites'> {
  applied: boolean;
  executedPhase: PhaseId | null;
  savedPlan: {
    pathParts: readonly string[];
    digest: string;
  } | null;
  noWrites: false;
  executedOperations: readonly TransitionOperation[];
  evidence: {
    evidenceId: string;
    pathParts: readonly string[];
    headerDigest: string;
    result: EvidenceHeader['result'];
  } | null;
  stateHash: string | null;
  rollbackPlan: TransitionRollbackPlan;
  cleanupWarnings: readonly string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandSucceeded(result: CommandResult): boolean {
  return result.status === 0 && !result.timedOut && !result.errorCode;
}

function commandFailure(result: CommandResult): string {
  if (result.timedOut) {
    return `${result.displayCommand} timed out`;
  }
  if (result.errorCode || result.errorMessage) {
    return `${result.displayCommand}: ${[result.errorCode, result.errorMessage].filter(Boolean).join(': ')}`;
  }
  return `${result.displayCommand} exited ${result.status ?? 'unknown'}${result.stderr ? `: ${result.stderr.trim()}` : ''}`;
}

function phaseById(graph: ManagedPhaseGraph, phaseId: PhaseId): PhaseGraphNode {
  const phase = graph.phases.find((entry) => entry.id === phaseId);
  if (!phase) {
    throw new Error(`Unknown phase ${phaseId}.`);
  }
  return phase;
}

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9A-Za-z]/g, '');
}

export function transitionPlanPathParts(plan: SavedTransitionPlan): string[] {
  return validateArtifactPathParts([
    ...governancePlanDirectoryPathParts,
    `${plan.phaseId}-${safeTimestamp(plan.createdAt)}-${plan.planDigest.slice(0, 12)}.json`
  ], 'Governance transition plan path');
}

function evidencePathParts(evidenceId: string): string[] {
  return validateArtifactPathParts(['governance', 'evidence', `${evidenceId}.json`], 'Governance evidence path');
}

function activationStatePathParts(): string[] {
  return validateArtifactPathParts(['governance', 'activation-state.json'], 'Activation state path');
}

function cloneState(state: UserActivationState): UserActivationState {
  return JSON.parse(JSON.stringify(state)) as UserActivationState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function phaseOrder(phaseId: PhaseId): number {
  return phaseIds.indexOf(phaseId);
}

function transitionDestination(
  type: TransitionOperationDestination['type'],
  identity: string,
  extras: Omit<TransitionOperationDestination, 'type' | 'identity'> = {}
): TransitionOperationDestination {
  return { type, identity, ...extras };
}

function operation(input: Omit<TransitionOperation, 'phaseId'> & { phaseId: PhaseId }): TransitionOperation {
  return input;
}

const allowedActionsByPhase: Record<PhaseId, readonly string[]> = {
  'seed-valid': [
    'openspec.seed.validate',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'seed-verified': [
    'openspec.seed.baseline-verify',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'seed-archived': [
    'openspec.seed.archive',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  committed: [
    'git.init',
    'git.add-reviewed',
    'git.commit-reviewed',
    'git.verify-existing-commit',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  pushed: [
    'git.push-approved-ref',
    'git.verify-existing-push',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'phase-0-complete': [
    'github.phase0.discover',
    'azure.phase0.discover',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'activation-approved': [
    'openspec.governance.create-change',
    'spec-kit.governance.create-change',
    'governance.activation-state.write'
  ],
  'credential-ready': [
    'github.credential.verify-policy',
    'github.credential.enroll-masked',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'provider-ready': [
    'azure.provider.ensure-ready',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'state-path-selected': [
    'azure.state-path.select',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'existing-private-path': [
    'azure.existing-private-path.verify',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'bootstrap-local': [
    'azure.bootstrap-local.apply',
    'github.bootstrap-local.configure',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'runner-ready': [
    'github.runner.ensure-ready',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'private-backend-proof': [
    'github.runner.backend-proof',
    'azure.remote-state.read',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'remote-import-verified': [
    'azure.remote-import.verify',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'remote-ready': [
    'azure.remote-ready.verify',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'application-foundation': [
    'azure.application-foundation.apply',
    'openspec.governance.update',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'workflow-source-ready': [
    'local.workflow-source.write',
    'local.ruleset-source.write',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'dev-proof': [
    'github.checks.dev-proof',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'staging-qualified': [
    'github.checks.staging',
    'azure.staging.readback',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'production-rehearsed': [
    'github.checks.production-rehearsal',
    'azure.production-readback',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'green-red-proof': [
    'github.checks.green-red-proof',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'enforcement-approved': [
    'governance.activation-state.write'
  ],
  'rulesets-applied': [
    'github.ruleset.apply',
    'github.ruleset.readback',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'live-readback': [
    'github.ruleset.readback',
    'governance.evidence.write',
    'governance.activation-state.write'
  ],
  'bootstrap-state-disposed': [
    'local.bootstrap-state.dispose',
    'governance.evidence.write',
    'governance.activation-state.write'
  ]
};

function isAllowedAction(phaseId: PhaseId, actionId: string): boolean {
  return allowedActionsByPhase[phaseId].includes(actionId);
}

function assertOperationAllowed(phase: PhaseGraphNode, op: TransitionOperation): void {
  if (op.phaseId !== phase.id) {
    throw new Error(`Operation ${op.actionId} belongs to ${op.phaseId}, not ${phase.id}.`);
  }
  if (!isAllowedAction(phase.id, op.actionId)) {
    throw new Error(`Operation ${op.actionId} is not allowlisted for phase ${phase.id}.`);
  }
  const allowed = op.remote ? phase.allowedMutations.remote : phase.allowedMutations.local;
  if (!(allowed as readonly string[]).includes(op.mutationClass)) {
    throw new Error(
      `Operation ${op.actionId} mutation ${op.mutationClass} is not declared in phase ${phase.id} ${op.remote ? 'remote' : 'local'} mutations.`
    );
  }
}

function assertPlanOperationsAllowed(plan: SavedTransitionPlan, phase: PhaseGraphNode): void {
  for (const op of plan.operations) {
    assertOperationAllowed(phase, op);
  }
}

function evidenceWriteOperation(phase: PhaseGraphNode, pathParts: readonly string[]): TransitionOperation {
  return operation({
    adapter: 'local-evidence',
    actionId: 'governance.evidence.write',
    mutationClass: 'write-evidence',
    phaseId: phase.id,
    inputs: { pathParts },
    destination: transitionDestination('local', pathParts.join('/'), { pathParts }),
    remote: false,
    destructive: false
  });
}

function stateWriteOperation(phase: PhaseGraphNode): TransitionOperation {
  return operation({
    adapter: 'local-evidence',
    actionId: 'governance.activation-state.write',
    mutationClass: 'write-activation-state',
    phaseId: phase.id,
    inputs: { pathParts: activationStatePathParts() },
    destination: transitionDestination('local', 'governance/activation-state.json', {
      pathParts: activationStatePathParts()
    }),
    remote: false,
    destructive: false
  });
}

async function allProjectFiles(projectRoot: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string, relative: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      if (
        entry.name === '.git' ||
        entry.name === 'node_modules' ||
        entry.name === '.cache' ||
        (relative === '' && entry.name === 'governance')
      ) {
        continue;
      }
      const child = path.join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(child, childRelative);
      } else if (entry.isFile()) {
        files.push(childRelative);
      }
    }
  }
  await visit(projectRoot, '');
  return files;
}

function parsePorcelainStatus(output: string): GitStatusEntry[] {
  const entries = output.split('\0').filter(Boolean);
  const parsed: GitStatusEntry[] = [];
  for (const entry of entries) {
    const index = entry.slice(0, 1);
    const worktree = entry.slice(1, 2);
    const rawPath = entry.slice(3);
    const renamed = rawPath.includes('\0') ? rawPath.split('\0').at(-1)! : rawPath;
    parsed.push({ index, worktree, path: renamed });
  }
  return parsed.filter((entry) => !entry.path.startsWith('governance/'));
}

async function runCommand(
  runner: CommandRunner,
  command: ExternalCommand,
  cwd: string
): Promise<CommandResult> {
  return await runner.run(command, { cwd });
}

async function runGit(
  runner: CommandRunner,
  projectRoot: string,
  args: string[]
): Promise<CommandResult> {
  return await runCommand(runner, { executable: 'git', args }, projectRoot);
}

async function inspectGitRepository(
  projectRoot: string,
  runner: CommandRunner
): Promise<GitRepositoryInspection> {
  const rootResult = await runGit(runner, projectRoot, ['rev-parse', '--show-toplevel']);
  if (!commandSucceeded(rootResult)) {
    return {
      insideWorkTree: false,
      root: null,
      branch: null,
      head: null,
      upstream: null,
      status: [],
      remotes: [],
      issues: []
    };
  }
  const root = path.resolve(rootResult.stdout.trim());
  if (root !== path.resolve(projectRoot)) {
    return {
      insideWorkTree: true,
      root,
      branch: null,
      head: null,
      upstream: null,
      status: [],
      remotes: [],
      issues: [`Git repository root ${root} does not match Liftoff project root ${projectRoot}.`]
    };
  }
  const branchResult = await runGit(runner, projectRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = commandSucceeded(branchResult) ? branchResult.stdout.trim() : null;
  const headResult = await runGit(runner, projectRoot, ['rev-parse', '--verify', 'HEAD']);
  const head = commandSucceeded(headResult) ? headResult.stdout.trim() : null;
  const upstreamResult = await runGit(runner, projectRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstream = commandSucceeded(upstreamResult) ? upstreamResult.stdout.trim() : null;
  const statusResult = await runGit(runner, projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const status = commandSucceeded(statusResult) ? parsePorcelainStatus(statusResult.stdout) : [];
  const remoteResult = await runGit(runner, projectRoot, ['remote', '-v']);
  const remotes = commandSucceeded(remoteResult) ? parseRemotes(remoteResult.stdout) : [];
  const issues: string[] = [];
  if (!branch) {
    issues.push('Detached HEAD or unborn branch cannot be reviewed for deterministic governance commit/push.');
  }
  if (!commandSucceeded(statusResult)) {
    issues.push(commandFailure(statusResult));
  }
  if (status.some((entry) => entry.index === 'D' || entry.worktree === 'D')) {
    issues.push('Unknown file deletion is outside the reviewed initial commit plan.');
  }
  return { insideWorkTree: true, root, branch, head, upstream, status, remotes, issues };
}

function parseRemotes(output: string): GitRemote[] {
  const remotes = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/u);
    if (match?.[3] === 'fetch') {
      remotes.set(match[1]!, match[2]!);
    }
  }
  return [...remotes.entries()]
    .map(([name, url]) => ({ name, url }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

function gitStatusDigest(inspection: GitRepositoryInspection): string {
  return canonicalSha256({
    branch: inspection.branch,
    head: inspection.head,
    status: inspection.status,
    remotes: inspection.remotes
  });
}

async function remoteHead(
  runner: CommandRunner,
  projectRoot: string,
  remote: string,
  branch: string
): Promise<string | null> {
  const result = await runGit(runner, projectRoot, ['ls-remote', '--heads', remote, branch]);
  if (!commandSucceeded(result)) {
    throw new Error(commandFailure(result));
  }
  const first = result.stdout.trim().split(/\s+/u)[0];
  return first && /^[a-f0-9]{40}$/u.test(first) ? first : null;
}

async function isAncestor(
  runner: CommandRunner,
  projectRoot: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  const result = await runGit(runner, projectRoot, ['merge-base', '--is-ancestor', ancestor, descendant]);
  return result.status === 0;
}

function defaultBranch(state: UserActivationState): string {
  return state.repository.defaultBranch || 'main';
}

async function gitCommitOperations(
  inspection: GovernanceTransitionInspection,
  phase: PhaseGraphNode,
  runner: CommandRunner
): Promise<TransitionOperation[]> {
  const git = await inspectGitRepository(inspection.projectRoot, runner);
  if (git.issues.length > 0) {
    throw new Error(git.issues.join(' '));
  }
  const branch = defaultBranch(inspection.state);
  if (!git.insideWorkTree) {
    const files = await allProjectFiles(inspection.projectRoot);
    return [
      operation({
        adapter: 'git',
        actionId: 'git.init',
        mutationClass: 'git-commit',
        phaseId: phase.id,
        inputs: { branch },
        destination: transitionDestination('local', '.git'),
        remote: false,
        destructive: false
      }),
      operation({
        adapter: 'git',
        actionId: 'git.add-reviewed',
        mutationClass: 'git-commit',
        phaseId: phase.id,
        inputs: { paths: files, statusDigest: canonicalSha256(files) },
        destination: transitionDestination('local', 'git-index'),
        remote: false,
        destructive: false
      }),
      operation({
        adapter: 'git',
        actionId: 'git.commit-reviewed',
        mutationClass: 'git-commit',
        phaseId: phase.id,
        inputs: {
          message: 'Initial Liftoff baseline',
          branch,
          paths: files
        },
        destination: transitionDestination('local', branch, { ref: branch }),
        remote: false,
        destructive: false
      })
    ];
  }
  if (git.branch !== branch) {
    throw new Error(`Expected branch ${branch}, found ${git.branch ?? 'detached'}.`);
  }
  if (git.upstream) {
    const divergence = await runGit(runner, inspection.projectRoot, ['rev-list', '--left-right', '--count', `${git.upstream}...HEAD`]);
    if (!commandSucceeded(divergence)) {
      throw new Error(commandFailure(divergence));
    }
    const [behind, ahead] = divergence.stdout.trim().split(/\s+/u).map((value) => Number.parseInt(value, 10));
    if ((behind ?? 0) > 0 || (ahead ?? 0) > 0) {
      throw new Error(`Branch ${branch} diverges from ${git.upstream}; refusing commit before explicit reconciliation.`);
    }
  }
  if (git.status.length === 0 && git.head) {
    return [
      operation({
        adapter: 'git',
        actionId: 'git.verify-existing-commit',
        mutationClass: 'read-worktree',
        phaseId: phase.id,
        inputs: { head: git.head, branch, statusDigest: gitStatusDigest(git) },
        destination: transitionDestination('local', branch, { ref: branch }),
        remote: false,
        destructive: false
      })
    ];
  }
  const paths = git.status.map((entry) => entry.path).sort((left, right) => left.localeCompare(right, 'en'));
  return [
    operation({
      adapter: 'git',
      actionId: 'git.add-reviewed',
      mutationClass: 'git-commit',
      phaseId: phase.id,
      inputs: { paths, statusDigest: gitStatusDigest(git) },
      destination: transitionDestination('local', 'git-index'),
      remote: false,
      destructive: false
    }),
    operation({
      adapter: 'git',
      actionId: 'git.commit-reviewed',
      mutationClass: 'git-commit',
      phaseId: phase.id,
      inputs: {
        message: 'Initial Liftoff baseline',
        branch,
        paths
      },
      destination: transitionDestination('local', branch, { ref: branch }),
      remote: false,
      destructive: false
    })
  ];
}

async function gitPushOperations(
  inspection: GovernanceTransitionInspection,
  phase: PhaseGraphNode,
  runner: CommandRunner
): Promise<TransitionOperation[]> {
  const git = await inspectGitRepository(inspection.projectRoot, runner);
  if (git.issues.length > 0) {
    throw new Error(git.issues.join(' '));
  }
  if (!git.insideWorkTree || !git.head) {
    throw new Error('A reviewed local commit is required before push.');
  }
  const branch = defaultBranch(inspection.state);
  if (git.branch !== branch) {
    throw new Error(`Expected branch ${branch}, found ${git.branch ?? 'detached'}.`);
  }
  if (git.status.length > 0) {
    throw new Error(`Worktree has unreviewed changes outside governance/plans: ${git.status.map((entry) => entry.path).join(', ')}.`);
  }
  const remoteNames = new Set(git.remotes.map((remote) => remote.name));
  if (!remoteNames.has('origin') || git.remotes.length !== 1) {
    throw new Error(`Expected exactly one approved origin remote; found ${git.remotes.map((remote) => remote.name).join(', ') || 'none'}.`);
  }
  const remoteSha = await remoteHead(runner, inspection.projectRoot, 'origin', branch);
  if (remoteSha && remoteSha !== git.head && !(await isAncestor(runner, inspection.projectRoot, remoteSha, git.head))) {
    throw new Error('Remote branch is not a fast-forward target; force, reset, rebase, and non-fast-forward push are forbidden.');
  }
  return [
    operation({
      adapter: 'git',
      actionId: remoteSha === git.head ? 'git.verify-existing-push' : 'git.push-approved-ref',
      mutationClass: remoteSha === git.head ? 'github-read' : 'git-push',
      phaseId: phase.id,
      inputs: {
        remote: 'origin',
        branch,
        localHead: git.head,
        remoteHead: remoteSha,
        statusDigest: gitStatusDigest(git)
      },
      destination: transitionDestination('repository', inspection.state.repository.name, {
        repository: inspection.state.repository.name,
        ref: `refs/heads/${branch}`
      }),
      remote: true,
      destructive: false
    })
  ];
}

async function phaseOperations(
  inspection: GovernanceTransitionInspection,
  phase: PhaseGraphNode,
  runner: CommandRunner,
  createdAt: string
): Promise<TransitionOperation[]> {
  const statePath = activationStatePathParts();
  const baseEvidencePath = evidencePathParts(`${phase.id}-${safeTimestamp(createdAt)}`);
  const writeOps = (includeEvidence = true) => [
    ...(includeEvidence ? [evidenceWriteOperation(phase, baseEvidencePath)] : []),
    stateWriteOperation(phase)
  ];
  switch (phase.id) {
    case 'seed-valid':
      return [
        operation({
          adapter: 'selected-spec-workflow',
          actionId: 'openspec.seed.validate',
          mutationClass: 'read-worktree',
          phaseId: phase.id,
          inputs: { changeName: generatedSeedChangeName(inspection.manifest) },
          destination: transitionDestination('local', inspection.projectRoot),
          remote: false,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'seed-verified':
      return [
        operation({
          adapter: 'selected-spec-workflow',
          actionId: 'openspec.seed.baseline-verify',
          mutationClass: 'read-worktree',
          phaseId: phase.id,
          inputs: { changeName: generatedSeedChangeName(inspection.manifest) },
          destination: transitionDestination('local', inspection.projectRoot),
          remote: false,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'seed-archived':
      return [
        operation({
          adapter: 'selected-spec-workflow',
          actionId: 'openspec.seed.archive',
          mutationClass: 'write-openspec-seed',
          phaseId: phase.id,
          inputs: { changeName: generatedSeedChangeName(inspection.manifest) },
          destination: transitionDestination('local', 'openspec/changes'),
          remote: false,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'committed':
      return [...await gitCommitOperations(inspection, phase, runner), ...writeOps()];
    case 'pushed':
      return [...await gitPushOperations(inspection, phase, runner), ...writeOps()];
    case 'phase-0-complete':
      return [
        operation({
          adapter: 'github',
          actionId: 'github.phase0.discover',
          mutationClass: 'github-read',
          phaseId: phase.id,
          inputs: { repository: inspection.state.repository.name },
          destination: transitionDestination('repository', inspection.state.repository.name, {
            repository: inspection.state.repository.name
          }),
          remote: true,
          destructive: false
        }),
        operation({
          adapter: 'azure-opentofu',
          actionId: 'azure.phase0.discover',
          mutationClass: 'azure-read',
          phaseId: phase.id,
          inputs: { cloud: 'cloud' in inspection.manifest.project.workload ? inspection.manifest.project.workload.cloud : 'power-platform' },
          destination: transitionDestination('subscription', 'phase-0-discovered-subscription', {
            subscriptionId: 'phase-0-discovered-subscription'
          }),
          remote: true,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'activation-approved': {
      const actionId = inspection.manifest.project.specWorkflow === 'openspec'
        ? 'openspec.governance.create-change'
        : 'spec-kit.governance.create-change';
      return [
        operation({
          adapter: 'selected-spec-workflow',
          actionId,
          mutationClass: 'write-openspec-governance',
          phaseId: phase.id,
          inputs: { workflowKind: inspection.manifest.project.specWorkflow },
          destination: transitionDestination('local', 'governance change'),
          remote: false,
          destructive: false
        }),
        stateWriteOperation(phase)
      ];
    }
    case 'credential-ready':
      return [
        operation({
          adapter: 'github',
          actionId: 'github.credential.verify-policy',
          mutationClass: 'github-read',
          phaseId: phase.id,
          inputs: { policyPathParts: credentialPolicyPathParts },
          destination: transitionDestination('repository', inspection.state.repository.name, {
            repository: inspection.state.repository.name
          }),
          remote: true,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'provider-ready':
      return [
        operation({
          adapter: 'azure-opentofu',
          actionId: 'azure.provider.ensure-ready',
          mutationClass: 'azure-provider-register',
          phaseId: phase.id,
          inputs: { retainedCapability: true },
          destination: transitionDestination('subscription', 'phase-0-discovered-subscription', {
            subscriptionId: 'phase-0-discovered-subscription'
          }),
          remote: true,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'state-path-selected':
      return [
        operation({
          adapter: 'azure-opentofu',
          actionId: 'azure.state-path.select',
          mutationClass: 'azure-read',
          phaseId: phase.id,
          inputs: { allowed: ['existing-private', 'bootstrap-local'] },
          destination: transitionDestination('subscription', 'phase-0-discovered-subscription', {
            subscriptionId: 'phase-0-discovered-subscription'
          }),
          remote: true,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'existing-private-path':
      return [
        operation({
          adapter: 'azure-opentofu',
          actionId: 'azure.existing-private-path.verify',
          mutationClass: 'azure-read',
          phaseId: phase.id,
          inputs: { statePath: 'existing-private' },
          destination: transitionDestination('subscription', 'phase-0-discovered-subscription', {
            subscriptionId: 'phase-0-discovered-subscription'
          }),
          remote: true,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'bootstrap-local':
      return [
        operation({
          adapter: 'azure-opentofu',
          actionId: 'azure.bootstrap-local.apply',
          mutationClass: 'azure-network-provision',
          phaseId: phase.id,
          inputs: { boundedLocalBootstrap: true },
          destination: transitionDestination('subscription', 'phase-0-discovered-subscription', {
            subscriptionId: 'phase-0-discovered-subscription'
          }),
          remote: true,
          destructive: false
        }),
        operation({
          adapter: 'github',
          actionId: 'github.bootstrap-local.configure',
          mutationClass: 'github-write',
          phaseId: phase.id,
          inputs: { repository: inspection.state.repository.name },
          destination: transitionDestination('repository', inspection.state.repository.name, {
            repository: inspection.state.repository.name
          }),
          remote: true,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'runner-ready':
      return [
        operation({
          adapter: 'github',
          actionId: 'github.runner.ensure-ready',
          mutationClass: 'github-write',
          phaseId: phase.id,
          inputs: { restrictedRunner: true },
          destination: transitionDestination('repository', inspection.state.repository.name, {
            repository: inspection.state.repository.name
          }),
          remote: true,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'private-backend-proof':
      return [
        operation({
          adapter: 'github',
          actionId: 'github.runner.backend-proof',
          mutationClass: 'github-read',
          phaseId: phase.id,
          inputs: { requiredConclusion: 'success' },
          destination: transitionDestination('repository', inspection.state.repository.name, {
            repository: inspection.state.repository.name
          }),
          remote: true,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'remote-import-verified':
      return [
        operation({
          adapter: 'azure-opentofu',
          actionId: 'azure.remote-import.verify',
          mutationClass: 'azure-state-import',
          phaseId: phase.id,
          inputs: { noChangePlanRequired: true },
          destination: transitionDestination('subscription', 'phase-0-discovered-subscription', {
            subscriptionId: 'phase-0-discovered-subscription'
          }),
          remote: true,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'remote-ready':
      return [
        operation({
          adapter: 'azure-opentofu',
          actionId: 'azure.remote-ready.verify',
          mutationClass: 'azure-read',
          phaseId: phase.id,
          inputs: { retainBootstrapStateForDays: 30 },
          destination: transitionDestination('subscription', 'phase-0-discovered-subscription', {
            subscriptionId: 'phase-0-discovered-subscription'
          }),
          remote: true,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'application-foundation':
      return [
        operation({
          adapter: 'azure-opentofu',
          actionId: 'azure.application-foundation.apply',
          mutationClass: 'azure-resource-provision',
          phaseId: phase.id,
          inputs: { noProviderUnregisterRollback: true },
          destination: transitionDestination('subscription', 'phase-0-discovered-subscription', {
            subscriptionId: 'phase-0-discovered-subscription'
          }),
          remote: true,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'workflow-source-ready':
      return [
        operation({
          adapter: 'local-state',
          actionId: 'local.workflow-source.write',
          mutationClass: 'write-workflows',
          phaseId: phase.id,
          inputs: { path: '.github/workflows' },
          destination: transitionDestination('local', '.github/workflows', {
            pathParts: ['.github', 'workflows']
          }),
          remote: false,
          destructive: false
        }),
        operation({
          adapter: 'local-state',
          actionId: 'local.ruleset-source.write',
          mutationClass: 'write-ruleset-source',
          phaseId: phase.id,
          inputs: { path: '.github/rulesets' },
          destination: transitionDestination('local', '.github/rulesets', {
            pathParts: ['.github', 'rulesets']
          }),
          remote: false,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'dev-proof':
      return [
        operation({
          adapter: 'github',
          actionId: 'github.checks.dev-proof',
          mutationClass: 'github-read',
          phaseId: phase.id,
          inputs: { acceptedConclusions: ['success'] },
          destination: transitionDestination('repository', inspection.state.repository.name, {
            repository: inspection.state.repository.name
          }),
          remote: true,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'staging-qualified':
      return [
        operation({
          adapter: 'github',
          actionId: 'github.checks.staging',
          mutationClass: 'github-read',
          phaseId: phase.id,
          inputs: { acceptedConclusions: ['success'] },
          destination: transitionDestination('repository', inspection.state.repository.name, {
            repository: inspection.state.repository.name
          }),
          remote: true,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'production-rehearsed':
      return [
        operation({
          adapter: 'github',
          actionId: 'github.checks.production-rehearsal',
          mutationClass: 'github-read',
          phaseId: phase.id,
          inputs: { acceptedConclusions: ['success'] },
          destination: transitionDestination('repository', inspection.state.repository.name, {
            repository: inspection.state.repository.name
          }),
          remote: true,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'green-red-proof':
      return [
        operation({
          adapter: 'github',
          actionId: 'github.checks.green-red-proof',
          mutationClass: 'github-read',
          phaseId: phase.id,
          inputs: { required: ['green-success', 'deliberate-red-failure'] },
          destination: transitionDestination('repository', inspection.state.repository.name, {
            repository: inspection.state.repository.name
          }),
          remote: true,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'enforcement-approved':
      return [stateWriteOperation(phase)];
    case 'rulesets-applied':
      return [
        operation({
          adapter: 'github',
          actionId: 'github.ruleset.apply',
          mutationClass: 'github-ruleset-write',
          phaseId: phase.id,
          inputs: { sourceDigest: rulesetSourceDigestFromEvidence(inspection) ?? 'missing' },
          destination: transitionDestination('repository', inspection.state.repository.name, {
            repository: inspection.state.repository.name
          }),
          remote: true,
          destructive: false
        }),
        operation({
          adapter: 'github',
          actionId: 'github.ruleset.readback',
          mutationClass: 'github-read',
          phaseId: phase.id,
          inputs: { sourceDigest: rulesetSourceDigestFromEvidence(inspection) ?? 'missing' },
          destination: transitionDestination('repository', inspection.state.repository.name, {
            repository: inspection.state.repository.name
          }),
          remote: true,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'live-readback':
      return [
        operation({
          adapter: 'github',
          actionId: 'github.ruleset.readback',
          mutationClass: 'github-read',
          phaseId: phase.id,
          inputs: { sourceDigest: rulesetSourceDigestFromEvidence(inspection) ?? 'missing' },
          destination: transitionDestination('repository', inspection.state.repository.name, {
            repository: inspection.state.repository.name
          }),
          remote: true,
          destructive: false
        }),
        ...writeOps()
      ];
    case 'bootstrap-state-disposed': {
      const paths = disposalPathInputs(inspection.state.bootstrapState);
      return [
        operation({
          adapter: 'local-state',
          actionId: 'local.bootstrap-state.dispose',
          mutationClass: 'delete-local-state',
          phaseId: phase.id,
          inputs: paths,
          destination: transitionDestination('local', 'bootstrap-state', {
            pathParts: statePath
          }),
          remote: false,
          destructive: true
        }),
        ...writeOps()
      ];
    }
  }
}

function disposalPathInputs(retention: BootstrapStateRetention | undefined): Record<string, unknown> {
  return {
    encryptedStatePathParts: retention?.encryptedStatePathParts ?? [],
    encryptionKeyPathParts: retention?.encryptionKeyPathParts ?? []
  };
}

function rulesetSourceDigestFromEvidence(inspection: GovernanceTransitionInspection): string | null {
  const record = latestRecordWithPayload(inspection, 'workflow-source-ready');
  if (!record || !isRecord(record.payload)) {
    return null;
  }
  if (record.payload.kind !== workflowSourcePayloadKind) {
    return null;
  }
  const digest = record.payload.rulesetSourceDigest;
  return typeof digest === 'string' && /^[a-f0-9]{64}$/u.test(digest) ? digest : null;
}

function latestRecordWithPayload(
  inspection: GovernanceTransitionInspection,
  phaseId: PhaseId
): PhaseEvidenceRecord | null {
  const records = inspection.evidence.filter((record) => record.header.phaseId === phaseId);
  const selection = selectLatestPhaseEvidence(records, inspection.contexts[phaseId]);
  if (!selection.selected) {
    return null;
  }
  return records.find((record) => record.evidenceId === selection.selected?.evidenceId) ?? null;
}

function rollbackPlanForPhase(phase: PhaseGraphNode, completed: readonly TransitionOperation[] = []): TransitionRollbackPlan {
  return rollbackPlanFromCompletedOperations(phase.id, phase.rollback.kind, phase.rollback.target, completed);
}

export function rollbackPlanFromCompletedOperations(
  phaseId: PhaseId,
  strategy: TransitionRollbackPlan['strategy'],
  target: PhaseId | null,
  completed: readonly TransitionOperation[]
): TransitionRollbackPlan {
  const retained: string[] = [];
  const cleanupWarnings: string[] = [];
  const operations: RollbackOperation[] = [];
  for (const op of [...completed].reverse()) {
    if (op.mutationClass === 'azure-provider-register') {
      retained.push(`${op.phaseId}:${op.actionId}:provider-registration`);
      continue;
    }
    if (op.actionId.toLowerCase().includes('unregister')) {
      cleanupWarnings.push(`Refused to generate provider unregister rollback for ${op.actionId}.`);
      continue;
    }
    if (op.mutationClass === 'github-ruleset-write') {
      operations.push({
        adapter: 'github' as const,
        actionId: 'github.ruleset.disable',
        mutationClass: 'github-ruleset-write' as const,
        phaseId,
        inputs: { fromOperation: op.actionId, cannotExpandScope: true },
        destination: op.destination,
        remote: true,
        destructive: false
      });
      continue;
    }
    if (op.mutationClass === 'azure-network-provision' || op.mutationClass === 'azure-resource-provision') {
      operations.push({
        adapter: 'azure-opentofu' as const,
        actionId: 'azure.resource.cleanup',
        mutationClass: op.mutationClass,
        phaseId,
        inputs: { fromOperation: op.actionId, noProviderUnregister: true },
        destination: op.destination,
        remote: true,
        destructive: true
      });
      continue;
    }
    if (op.mutationClass === 'write-local-state' || op.mutationClass === 'delete-local-state') {
      operations.push({
        adapter: 'local-state' as const,
        actionId: 'local.state.rollback',
        mutationClass: op.mutationClass,
        phaseId,
        inputs: { fromOperation: op.actionId },
        destination: op.destination,
        remote: false,
        destructive: op.mutationClass === 'delete-local-state'
      });
    }
  }
  return {
    phaseId,
    strategy,
    target,
    operations,
    retained,
    cleanupWarnings
  };
}

export function planDigestFor(input: {
  phase: PhaseGraphNode;
  transitionDigest: string;
  operations: readonly TransitionOperation[];
  approvalPlanDigest: string;
}): string {
  return canonicalSha256({
    phaseId: input.phase.id,
    transitionDigest: input.transitionDigest,
    approvalPlanDigest: input.approvalPlanDigest,
    operations: input.operations
  });
}

function stateHash(inspection: GovernanceTransitionInspection): string | null {
  return inspection.loadedState?.contentHash ?? null;
}

function assertNoSecrets(plan: SavedTransitionPlan): void {
  const scan = detectCredentialLeaks([{
    source: 'generated-artifact',
    label: 'governance transition plan',
    text: canonicalJson(plan)
  }]);
  if (scan.status === 'compromised') {
    throw new Error(`Governance transition plan contains credential-shaped content: ${scan.leaks.map((leak) => leak.pattern).join(', ')}.`);
  }
}

export async function buildSavedTransitionPlan(input: {
  inspection: GovernanceTransitionInspection;
  runner?: CommandRunner;
  now?: Date;
}): Promise<SavedTransitionPlan | null> {
  const phaseId = input.inspection.readiness.nextReadyPhase;
  if (!phaseId) {
    return null;
  }
  const runner = input.runner ?? new NodeCommandRunner();
  const phase = phaseById(input.inspection.graph, phaseId);
  const createdAt = (input.now ?? new Date()).toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + planLifetimeMs).toISOString();
  const context = input.inspection.contexts[phaseId];
  const approvalPlan = transitionPlanForPhase(
    phase,
    input.inspection.state,
    context.transition,
    input.inspection.projectRoot
  );
  const evaluation = evaluateApprovalForTransitionPlan(approvalPlan, input.inspection.approvals, {
    now: input.now
  });
  const operations = await phaseOperations(input.inspection, phase, runner, createdAt);
  const digest = planDigestFor({
    phase,
    transitionDigest: context.transition.transitionDigest,
    operations,
    approvalPlanDigest: approvalPlan.planDigest
  });
  const plan: SavedTransitionPlan = validateSavedTransitionPlan({
    schemaVersion: 1,
    phaseId,
    createdAt,
    expiresAt,
    identity: input.inspection.state.identity,
    graphHash: input.inspection.graphHash,
    stateHash: stateHash(input.inspection),
    baselineDigest: context.baselineSha,
    inputDigest: context.inputDigest,
    transitionDigest: context.transition.transitionDigest,
    planDigest: digest,
    mutationClasses: phase.allowedMutations,
    operations,
    approval: {
      gateKind: phase.approvalGate.kind,
      required: phase.approvalGate.required,
      evaluation,
      envelopeId: evaluation.envelopeId,
      envelopeHash: evaluation.envelopeHash
    },
    rollbackPlan: rollbackPlanForPhase(phase),
    noSecrets: true
  });
  assertPlanOperationsAllowed(plan, phase);
  assertNoSecrets(plan);
  return plan;
}

export async function previewApplyNext(input: {
  inspection: GovernanceTransitionInspection;
  runner?: CommandRunner;
  now?: Date;
  execute: boolean;
}): Promise<ApplyNextPreview> {
  let plan: SavedTransitionPlan | null = null;
  const blockers: string[] = [];
  try {
    plan = await buildSavedTransitionPlan(input);
  } catch (error) {
    blockers.push(errorMessage(error));
  }
  const nextReadyPhase = input.inspection.readiness.nextReadyPhase;
  if (!nextReadyPhase || blockers.length > 0 || !plan) {
    return {
      schemaVersion: 1,
      command: 'governance apply-next',
      projectRoot: input.inspection.projectRoot,
      execute: input.execute,
      applied: false,
      authorized: false,
      reason: 'blocked',
      message: blockers[0] ?? 'No phase is ready for execution.',
      selectedPhase: nextReadyPhase,
      nextReadyPhase,
      approval: plan?.approval ?? null,
      proposedMutations: {
        local: plan?.mutationClasses.local ?? ['none'],
        remote: plan?.mutationClasses.remote ?? ['none'],
        operations: plan?.operations ?? []
      },
      savedPlan: null,
      noWrites: true,
      blockers: blockers.length > 0 ? blockers : ['No phase is ready for execution.']
    };
  }
  if (plan.approval.evaluation.approvalRequired) {
    return {
      schemaVersion: 1,
      command: 'governance apply-next',
      projectRoot: input.inspection.projectRoot,
      execute: input.execute,
      applied: false,
      authorized: false,
      reason: 'approval-required',
      message: plan.approval.evaluation.reasons.join('; '),
      selectedPhase: nextReadyPhase,
      nextReadyPhase,
      approval: plan.approval,
      proposedMutations: {
        local: plan.mutationClasses.local,
        remote: plan.mutationClasses.remote,
        operations: plan.operations
      },
      savedPlan: null,
      noWrites: true,
      blockers: plan.approval.evaluation.reasons
    };
  }
  return {
    schemaVersion: 1,
    command: 'governance apply-next',
    projectRoot: input.inspection.projectRoot,
    execute: input.execute,
    applied: false,
    authorized: true,
    reason: input.execute ? 'execute-requested' : 'execute-required',
    message: input.execute
      ? 'Execution requested; the plan must be saved and revalidated before any mutation.'
      : 'Preview only. Rerun with --execute to save this plan and execute at most one phase.',
    selectedPhase: nextReadyPhase,
    nextReadyPhase,
    approval: plan.approval,
    proposedMutations: {
      local: plan.mutationClasses.local,
      remote: plan.mutationClasses.remote,
      operations: plan.operations
    },
    savedPlan: null,
    noWrites: true,
    blockers: []
  };
}

async function saveTransitionPlan(projectRoot: string, plan: SavedTransitionPlan): Promise<{
  pathParts: readonly string[];
  digest: string;
}> {
  const validated = validateSavedTransitionPlan(plan);
  assertNoSecrets(validated);
  const pathParts = transitionPlanPathParts(validated);
  const existing = await readProjectFile(projectRoot, pathParts);
  if (existing !== undefined) {
    throw new Error(`Refusing to overwrite existing governance transition plan ${pathParts.join('/')}.`);
  }
  const content = `${canonicalJson(validated)}\n`;
  await applyProjectFileTransaction(projectRoot, [{
    type: 'write',
    pathParts,
    content
  }]);
  return { pathParts, digest: canonicalSha256(validated) };
}

function comparePlanFreshness(saved: SavedTransitionPlan, fresh: SavedTransitionPlan | null): string[] {
  if (!fresh) {
    return ['No phase remained ready after saving the transition plan.'];
  }
  const issues: string[] = [];
  if (saved.phaseId !== fresh.phaseId) {
    issues.push(`Ready phase changed from ${saved.phaseId} to ${fresh.phaseId}.`);
  }
  for (const field of ['stateHash', 'baselineDigest', 'inputDigest', 'transitionDigest'] as const) {
    if (saved[field] !== fresh[field]) {
      issues.push(`${field} changed after plan save.`);
    }
  }
  if (canonicalSha256(saved.operations) !== canonicalSha256(fresh.operations)) {
    issues.push('Proposed operations changed after plan save.');
  }
  if (saved.approval.evaluation.approvalRequired || fresh.approval.evaluation.approvalRequired) {
    issues.push('Approval was not valid immediately before execution.');
  }
  return issues;
}

function evidenceHeaderFor(input: {
  inspection: GovernanceTransitionInspection;
  phase: PhaseGraphNode;
  plan: SavedTransitionPlan;
  result: EvidenceHeader['result'];
  now: Date;
}): EvidenceHeader {
  const context = input.inspection.contexts[input.phase.id];
  return validateEvidenceHeader({
    schemaVersion: input.inspection.state.identity.evidenceHeaderSchemaVersion,
    repositoryId: input.inspection.state.repository.id,
    identity: input.inspection.state.identity,
    phaseGraphHash: input.inspection.state.identity.phaseGraphHash,
    phaseId: input.phase.id,
    phaseContractDigest: phaseContractDigests(input.inspection.graph)[input.phase.id],
    inputDigest: input.plan.inputDigest,
    baselineSha: input.plan.baselineDigest,
    transition: context.transition,
    producedAt: input.now.toISOString(),
    producer: engineProducer,
    result: input.result
  });
}

function appendUnique(values: readonly string[], value: string | null): string[] {
  if (value === null || values.includes(value)) {
    return [...values];
  }
  return [...values, value];
}

function nextStateForOutcome(input: {
  inspection: GovernanceTransitionInspection;
  phase: PhaseGraphNode;
  plan: SavedTransitionPlan;
  resultState: EvidenceHeader['result'] | 'approved';
  evidenceReference?: UserActivationState['phases'][PhaseId]['evidence'][number];
  blocker?: string;
  override?: UserActivationState;
  now: Date;
}): UserActivationState {
  const base = cloneState(input.override ?? input.inspection.state);
  if (
    input.inspection.sourceOfTruth.status === 'selected' &&
    input.inspection.sourceOfTruth.recordActiveChangeOnNextMutation
  ) {
    const selected = stateWithSelectedActiveChange(base, input.inspection.sourceOfTruth.selected);
    base.activeChange = selected.activeChange;
  }
  const phaseState = input.resultState === 'approved' ? 'approved' : input.resultState;
  base.phases[input.phase.id] = {
    state: phaseState,
    updatedAt: input.now.toISOString(),
    evidence: input.evidenceReference
      ? [...base.phases[input.phase.id].evidence, input.evidenceReference]
      : base.phases[input.phase.id].evidence,
    approvals: appendUnique(base.phases[input.phase.id].approvals, input.plan.approval.envelopeId),
    blockers: input.blocker ? [input.blocker] : []
  };
  base.updatedAt = input.now.toISOString();
  return validateUserActivationState(base);
}

function blockedState(input: {
  inspection: GovernanceTransitionInspection;
  phase: PhaseGraphNode;
  plan: SavedTransitionPlan;
  blocker: string;
  now: Date;
}): UserActivationState {
  const base = cloneState(input.inspection.state);
  base.phases[input.phase.id] = {
    state: 'blocked',
    updatedAt: input.now.toISOString(),
    evidence: base.phases[input.phase.id].evidence,
    approvals: appendUnique(base.phases[input.phase.id].approvals, input.plan.approval.envelopeId),
    blockers: [input.blocker]
  };
  base.updatedAt = input.now.toISOString();
  return validateUserActivationState(base);
}

async function assertLoadedStateHash(projectRoot: string, expectedHash: string | null): Promise<void> {
  const bytes = await readProjectFile(projectRoot, activationStatePathParts());
  const currentHash = bytes === undefined ? null : activationStateContentHash(bytes);
  if (currentHash !== expectedHash) {
    throw new Error(`Activation state changed after inspection: expected ${expectedHash ?? 'absent'}, found ${currentHash ?? 'absent'}.`);
  }
}

async function writeOutcomeTransaction(input: {
  projectRoot: string;
  plan: SavedTransitionPlan;
  nextState: UserActivationState;
  evidenceRecord?: PhaseEvidenceRecord;
  evidencePathParts?: readonly string[];
  fileMutations?: readonly ProjectFileMutation[];
}): Promise<{
  stateHash: string;
  evidence: ApplyNextExecutionResult['evidence'];
}> {
  await assertLoadedStateHash(input.projectRoot, input.plan.stateHash);
  const stateContent = `${canonicalJson(validateUserActivationState(input.nextState))}\n`;
  const mutations: ProjectFileMutation[] = [
    ...(input.fileMutations ?? []).map((mutation) => ({
      ...mutation,
      pathParts: validateArtifactPathParts([...mutation.pathParts], 'Governance transition file mutation path')
    })),
    ...(input.evidenceRecord && input.evidencePathParts
      ? [{
          type: 'write' as const,
          pathParts: [...input.evidencePathParts],
          content: `${canonicalJson(input.evidenceRecord)}\n`
        }]
      : []),
    {
      type: 'write',
      pathParts: activationStatePathParts(),
      content: stateContent
    }
  ];
  if (input.evidencePathParts) {
    const existing = await readProjectFile(input.projectRoot, [...input.evidencePathParts]);
    if (existing !== undefined) {
      throw new Error(`Refusing to overwrite existing governance evidence ${input.evidencePathParts.join('/')}.`);
    }
  }
  await applyProjectFileTransaction(input.projectRoot, mutations);
  return {
    stateHash: activationStateContentHash(stateContent),
    evidence: input.evidenceRecord && input.evidencePathParts
      ? {
          evidenceId: input.evidenceRecord.evidenceId,
          pathParts: input.evidencePathParts,
          headerDigest: evidenceHeaderDigest(input.evidenceRecord.header),
          result: input.evidenceRecord.header.result
        }
      : null
  };
}

async function executeGitOperations(
  input: PhaseAdapterExecutionInput,
  operations: readonly TransitionOperation[]
): Promise<PhaseAdapterOutcome | null> {
  if (input.phase.id !== 'committed' && input.phase.id !== 'pushed') {
    return null;
  }
  const completed: TransitionOperation[] = [];
  for (const op of operations.filter((entry) => entry.adapter === 'git')) {
    if (op.actionId === 'git.verify-existing-commit' || op.actionId === 'git.verify-existing-push') {
      completed.push(op);
      continue;
    }
    if (op.actionId === 'git.init') {
      const result = await runGit(input.runner, input.inspection.projectRoot, ['init', '-b', String(op.inputs.branch)]);
      if (!commandSucceeded(result)) {
        return { status: 'blocked', blocker: commandFailure(result), completedOperations: completed };
      }
      completed.push(op);
    } else if (op.actionId === 'git.add-reviewed') {
      const paths = Array.isArray(op.inputs.paths) ? op.inputs.paths.map(String) : [];
      if (paths.length === 0) {
        completed.push(op);
        continue;
      }
      const result = await runGit(input.runner, input.inspection.projectRoot, ['add', '--', ...paths]);
      if (!commandSucceeded(result)) {
        return { status: 'blocked', blocker: commandFailure(result), completedOperations: completed };
      }
      completed.push(op);
    } else if (op.actionId === 'git.commit-reviewed') {
      const message = String(op.inputs.message);
      const result = await runGit(input.runner, input.inspection.projectRoot, ['commit', '-m', message]);
      if (!commandSucceeded(result)) {
        return { status: 'blocked', blocker: commandFailure(result), completedOperations: completed };
      }
      completed.push(op);
    } else if (op.actionId === 'git.push-approved-ref') {
      const branch = String(op.inputs.branch);
      const result = await runGit(input.runner, input.inspection.projectRoot, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
      if (!commandSucceeded(result)) {
        return { status: 'blocked', blocker: commandFailure(result), completedOperations: completed };
      }
      completed.push(op);
    }
  }
  return {
    status: 'completed',
    resultState: 'verified',
    completedOperations: completed
  };
}

async function executeSeedOperations(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null> {
  if (!input.phase.id.startsWith('seed-')) {
    return null;
  }
  if (input.phase.id === 'seed-valid') {
    const result = await validateGeneratedSeedForPhase(input.inspection.projectRoot, input.runner);
    if (result.status === 'blocked') {
      return { status: 'blocked', blocker: result.issues[0] ?? 'Seed validation failed.', completedOperations: [] };
    }
    return { status: 'completed', resultState: 'verified', completedOperations: input.plan.operations.filter((op) => op.actionId === 'openspec.seed.validate') };
  }
  if (input.phase.id === 'seed-verified') {
    const result = await verifyGeneratedSeedBaselineForPhase(input.inspection.projectRoot, input.runner);
    if (result.status === 'blocked') {
      return { status: 'blocked', blocker: result.issues[0] ?? 'Seed baseline verification failed.', completedOperations: [] };
    }
    return {
      status: 'completed',
      resultState: 'verified',
      evidencePayload: {
        kind: 'seed-verified.v1',
        checks: result.checks.map((check) => ({
          id: check.id,
          taskId: check.taskId,
          status: check.status
        }))
      },
      completedOperations: input.plan.operations.filter((op) => op.actionId === 'openspec.seed.baseline-verify')
    };
  }
  const result = await archiveGeneratedSeedForPhase(input.inspection.projectRoot, input.runner);
  if (result.status === 'blocked') {
    return {
      status: 'blocked',
      blocker: result.issues[0] ?? 'Seed archive failed.',
      completedOperations: result.archiveCompleted
        ? input.plan.operations.filter((op) => op.actionId === 'openspec.seed.archive')
        : [],
      retryableWithoutStateMutation: result.retryableAfterRepair
    };
  }
  return {
    status: 'completed',
    resultState: 'verified',
    evidencePayload: {
      kind: 'seed-archived.v1',
      archiveSyncBehavior: result.archiveSyncBehavior ?? null
    },
    completedOperations: input.plan.operations.filter((op) => op.actionId === 'openspec.seed.archive')
  };
}

async function discoverPhase0(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null> {
  if (input.phase.id !== 'phase-0-complete') {
    return null;
  }
  const gh = await runCommand(input.runner, {
    executable: 'gh',
    args: ['repo', 'view', '--json', 'id,nameWithOwner,defaultBranchRef,isPrivate']
  }, input.inspection.projectRoot);
  if (!commandSucceeded(gh)) {
    return {
      status: 'blocked',
      blocker: `Phase 0 GitHub read-only discovery failed: ${commandFailure(gh)}`,
      completedOperations: []
    };
  }
  let repo: { id?: string; nameWithOwner?: string; defaultBranchRef?: { name?: string }; isPrivate?: boolean };
  try {
    repo = JSON.parse(gh.stdout) as typeof repo;
  } catch (error) {
    return {
      status: 'blocked',
      blocker: `Phase 0 GitHub discovery returned invalid JSON: ${errorMessage(error)}`,
      completedOperations: []
    };
  }
  if (!repo.id || !repo.nameWithOwner || !repo.defaultBranchRef?.name) {
    return {
      status: 'blocked',
      blocker: 'Phase 0 GitHub discovery did not return repository id, nameWithOwner, and default branch.',
      completedOperations: []
    };
  }
  const az = await runCommand(input.runner, {
    executable: 'az',
    args: ['account', 'show', '--output', 'json']
  }, input.inspection.projectRoot);
  const azureAccount = commandSucceeded(az) ? safeJson(az.stdout) : null;
  const git = await inspectGitRepository(input.inspection.projectRoot, input.runner);
  const baselineDigest = canonicalSha256({
    gitHead: git.head,
    repositoryId: repo.id,
    repositoryName: repo.nameWithOwner,
    defaultBranch: repo.defaultBranchRef.name
  });
  const facts: Phase0DiscoveryFacts = {
    repositoryId: repo.id,
    repositoryName: repo.nameWithOwner,
    defaultBranch: repo.defaultBranchRef.name,
    baselineDigest,
    privateStagingDast: false,
    credentialRequired: false,
    statePath: 'none',
    approvedFacts: [
      { id: 'repository.id', value: repo.id },
      { id: 'repository.nameWithOwner', value: repo.nameWithOwner },
      { id: 'repository.defaultBranch', value: repo.defaultBranchRef.name },
      { id: 'repository.isPrivate', value: repo.isPrivate ?? null },
      { id: 'azure.accountReadable', value: azureAccount !== null }
    ]
  };
  const nextState = cloneState(input.inspection.state);
  nextState.repository = {
    id: facts.repositoryId,
    name: facts.repositoryName,
    defaultBranch: facts.defaultBranch
  };
  nextState.applicability = {
    statePath: facts.statePath,
    privateStagingDast: facts.privateStagingDast,
    credentialRequired: facts.credentialRequired
  };
  return {
    status: 'completed',
    resultState: 'verified',
    evidencePayload: {
      kind: 'phase-0-discovery.v1',
      facts: facts.approvedFacts,
      activationCreateChangePlan: {
        deterministic: true,
        graphHash: input.inspection.graphHash
      }
    },
    stateOverride: nextState,
    completedOperations: input.plan.operations.filter((op) => op.actionId === 'github.phase0.discover' || op.actionId === 'azure.phase0.discover')
  };
}

function safeJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function executeActivationApproval(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null> {
  if (input.phase.id !== 'activation-approved') {
    return null;
  }
  const state = cloneState(input.inspection.state);
  const fileMutations: ProjectFileMutation[] = [];
  if (input.inspection.sourceOfTruth.status === 'none') {
    const facts = buildApprovedPhase0FactsFromState(
      input.inspection.manifest,
      input.inspection.state,
      input.inspection.evidence
    );
    if (!facts || input.inspection.sourceOfTruth.createPlan.status !== 'ready') {
      return {
        status: 'blocked',
        blocker: input.inspection.sourceOfTruth.createPlan.reason,
        completedOperations: []
      };
    }
    const writePlan = renderGovernanceChangeWritePlan(facts);
    for (const file of writePlan.files) {
      const existing = await readProjectFile(input.inspection.projectRoot, [...file.pathParts]);
      if (existing !== undefined) {
        return {
          status: 'blocked',
          blocker: `Refusing to overwrite existing governance artifact ${file.pathParts.join('/')}.`,
          completedOperations: []
        };
      }
      fileMutations.push({
        type: 'write',
        pathParts: [...file.pathParts],
        content: file.content
      });
    }
    state.activeChange = {
      id: writePlan.changeId,
      kind: writePlan.workflowKind === 'openspec' ? 'openspec' : 'spec-kit'
    };
  } else if (input.inspection.sourceOfTruth.status === 'selected') {
    state.activeChange = {
      id: input.inspection.sourceOfTruth.selected.changeId,
      kind: input.inspection.sourceOfTruth.selected.workflowKind === 'openspec' ? 'openspec' : 'spec-kit'
    };
  } else {
    return {
      status: 'blocked',
      blocker: 'A compatible governance source of truth is required before activation approval can be recorded.',
      completedOperations: []
    };
  }
  return {
    status: 'completed',
    resultState: 'approved',
    stateOverride: state,
    fileMutations,
    completedOperations: input.plan.operations.filter((op) => op.actionId.endsWith('governance.create-change'))
  };
}

async function executeCredentialReady(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null> {
  if (input.phase.id !== 'credential-ready') {
    return null;
  }
  const policy = await readProjectFile(input.inspection.projectRoot, [...credentialPolicyPathParts]);
  if (policy === undefined) {
    return {
      status: 'blocked',
      blocker: 'Credential enrollment requires a secure masked input channel or an existing selected-repository App; automated noninteractive apply cannot collect a PAT.',
      completedOperations: []
    };
  }
  const scan = detectCredentialLeaks([{
    source: 'imported-evidence',
    label: credentialPolicyPathParts.join('/'),
    text: policy.toString('utf8')
  }]);
  if (scan.status === 'compromised') {
    return {
      status: 'blocked',
      blocker: scan.guidance.join(' '),
      completedOperations: []
    };
  }
  return {
    status: 'completed',
    resultState: 'verified',
    evidencePayload: {
      kind: 'credential-ready.v1',
      policyPathParts: credentialPolicyPathParts,
      payloadFree: true,
      policyDigest: canonicalSha256(policy.toString('utf8'))
    },
    completedOperations: input.plan.operations.filter((op) => op.actionId === 'github.credential.verify-policy')
  };
}

function remoteImportRetention(input: PhaseAdapterExecutionInput): PhaseAdapterOutcome | null {
  if (input.phase.id !== 'remote-ready') {
    return null;
  }
  if (input.inspection.state.applicability.statePath !== 'bootstrap-local') {
    return {
      status: 'completed',
      resultState: 'verified',
      evidencePayload: { kind: 'remote-ready.v1', retention: 'not-applicable' },
      completedOperations: input.plan.operations.filter((op) => op.actionId === 'azure.remote-ready.verify')
    };
  }
  const importRecord = latestRecordWithPayload(input.inspection, 'remote-import-verified');
  if (!importRecord || !isRecord(importRecord.payload) || importRecord.payload.kind !== remoteImportPayloadKind) {
    return {
      status: 'blocked',
      blocker: 'Remote import retention requires immutable remote-import evidence with state and key identifiers.',
      completedOperations: []
    };
  }
  const encryptedStatePathParts = pathPartLists(importRecord.payload.encryptedStatePathParts, 'encryptedStatePathParts');
  const encryptionKeyPathParts = pathPartLists(importRecord.payload.encryptionKeyPathParts, 'encryptionKeyPathParts');
  const retainedAt = input.now.toISOString();
  const disposeAfter = new Date(input.now.getTime() + 30 * dayMs).toISOString();
  const state = cloneState(input.inspection.state);
  state.bootstrapState = {
    status: 'retained',
    remoteImportEvidenceId: importRecord.evidenceId,
    remoteImportEvidenceDigest: evidenceHeaderDigest(importRecord.header),
    retainedAt,
    disposeAfter,
    encryptedStatePathParts,
    encryptionKeyPathParts
  };
  return {
    status: 'completed',
    resultState: 'retained',
    stateOverride: state,
    evidencePayload: {
      kind: 'remote-ready.v1',
      retention: state.bootstrapState
    },
    completedOperations: input.plan.operations.filter((op) => op.actionId === 'azure.remote-ready.verify')
  };
}

function pathPartLists(value: unknown, label: string): string[][] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of path-part arrays.`);
  }
  return value.map((entry, index) => validateArtifactPathParts(entry, `${label}[${index}]`));
}

async function executeBootstrapStateDisposal(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null> {
  if (input.phase.id !== 'bootstrap-state-disposed') {
    return null;
  }
  const retention = input.inspection.state.bootstrapState;
  if (!retention || input.inspection.state.applicability.statePath !== 'bootstrap-local') {
    return {
      status: 'completed',
      resultState: 'inapplicable',
      evidencePayload: { kind: bootstrapStateDisposedPayloadKind, reason: 'no retained bootstrap state' },
      completedOperations: []
    };
  }
  if (retention.status === 'disposed') {
    return {
      status: 'completed',
      resultState: 'disposed',
      evidencePayload: { kind: bootstrapStateDisposedPayloadKind, reason: 'already disposed', deletionEvidenceId: retention.deletionEvidenceId ?? null },
      completedOperations: []
    };
  }
  if (Date.parse(retention.disposeAfter) > input.now.getTime()) {
    return {
      status: 'blocked',
      blocker: `Retained bootstrap state is not disposable until ${retention.disposeAfter}.`,
      completedOperations: []
    };
  }
  const importRecord = input.inspection.evidence.find((record) => record.evidenceId === retention.remoteImportEvidenceId);
  if (!importRecord || evidenceHeaderDigest(importRecord.header) !== retention.remoteImportEvidenceDigest) {
    return {
      status: 'blocked',
      blocker: 'Destructive disposal requires the immutable remote-import evidence referenced by retained bootstrap state.',
      completedOperations: []
    };
  }
  if (!isRecord(importRecord.payload) || importRecord.payload.kind !== remoteImportPayloadKind) {
    return {
      status: 'blocked',
      blocker: 'Destructive disposal requires verified remote backend and no-change evidence.',
      completedOperations: []
    };
  }
  const remoteBackendDigest = importRecord.payload.remoteBackendDigest;
  const noChangePlanDigest = importRecord.payload.noChangePlanDigest;
  if (
    typeof remoteBackendDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(remoteBackendDigest) ||
    typeof noChangePlanDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(noChangePlanDigest)
  ) {
    return {
      status: 'blocked',
      blocker: 'Destructive disposal requires payload-free remote backend and no-change plan digests.',
      completedOperations: []
    };
  }
  const allPaths = [...retention.encryptedStatePathParts, ...retention.encryptionKeyPathParts]
    .map((parts) => validateArtifactPathParts([...parts], 'Bootstrap disposal path'));
  const incompleteCleanup: string[] = [];
  for (const parts of allPaths) {
    try {
      const target = await resolveProjectPath(input.inspection.projectRoot, parts);
      const details = await stat(target);
      if (!details.isFile()) {
        incompleteCleanup.push(`${parts.join('/')} is not a regular file.`);
      }
    } catch (error) {
      incompleteCleanup.push(`${parts.join('/')} was already absent before disposal: ${errorMessage(error)}`);
    }
  }
  const state = cloneState(input.inspection.state);
  state.bootstrapState = {
    ...retention,
    status: 'disposed',
    disposedAt: input.now.toISOString(),
    deletionEvidenceId: `${input.phase.id}-${safeTimestamp(input.now.toISOString())}`,
    incompleteCleanup
  };
  return {
    status: 'completed',
    resultState: 'disposed',
    stateOverride: state,
    evidencePayload: {
      kind: bootstrapStateDisposedPayloadKind,
      deletedPathParts: allPaths,
      remoteBackendDigest,
      noChangePlanDigest,
      incompleteCleanup,
      payloadFree: true
    },
    fileMutations: allPaths.map((parts) => ({ type: 'delete', pathParts: parts })),
    completedOperations: input.plan.operations.filter((op) => op.actionId === 'local.bootstrap-state.dispose'),
    cleanupWarnings: incompleteCleanup
  };
}

function assertGreenRedProof(input: PhaseAdapterExecutionInput): PhaseEvidenceRecord {
  const record = latestRecordWithPayload(input.inspection, 'green-red-proof');
  if (!record || !isRecord(record.payload) || record.payload.kind !== greenRedPayloadKind) {
    throw new Error('Ruleset enforcement requires current green-red-proof evidence with typed proof payload.');
  }
  const green = isRecord(record.payload.green) ? record.payload.green : null;
  const red = isRecord(record.payload.deliberateRed) ? record.payload.deliberateRed : null;
  const greenConclusion = green?.conclusion;
  const redConclusion = red?.conclusion;
  const badConclusions = [greenConclusion, redConclusion].filter((value) =>
    value === 'skipped' || value === 'cancelled' || value === 'neutral'
  );
  if (badConclusions.length > 0) {
    throw new Error('Skipped, cancelled, and neutral checks cannot satisfy green/red proof.');
  }
  if (!red || greenConclusion !== 'success' || redConclusion !== 'failure' || red.deliberate !== true) {
    throw new Error('Ruleset enforcement requires green success and deliberate red failure proof.');
  }
  return record;
}

async function executeRulesetPhase(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null> {
  if (input.phase.id !== 'rulesets-applied' && input.phase.id !== 'live-readback') {
    return null;
  }
  try {
    assertGreenRedProof(input);
  } catch (error) {
    return { status: 'blocked', blocker: errorMessage(error), completedOperations: [] };
  }
  const sourceDigest = rulesetSourceDigestFromEvidence(input.inspection);
  if (!sourceDigest) {
    return {
      status: 'blocked',
      blocker: 'Ruleset enforcement requires a saved ruleset source digest from workflow-source-ready evidence.',
      completedOperations: []
    };
  }
  const adapter = input.adapters.githubRulesets;
  if (!adapter) {
    return {
      status: 'blocked',
      blocker: 'No injected GitHub ruleset adapter is configured; refusing live ruleset calls in this execution context.',
      completedOperations: []
    };
  }
  const envelopeId = input.plan.approval.envelopeId;
  if (input.phase.id === 'rulesets-applied' && !envelopeId) {
    return {
      status: 'blocked',
      blocker: 'Ruleset enforcement requires a persisted enforcement approval envelope.',
      completedOperations: []
    };
  }
  const completed: TransitionOperation[] = [];
  const write = input.phase.id === 'rulesets-applied'
    ? await adapter.applyRuleset({
        repository: input.inspection.state.repository.name,
        sourceDigest,
        approvalEnvelopeId: envelopeId ?? 'ungated-readback'
      })
    : await adapter.readRuleset({
        repository: input.inspection.state.repository.name,
        sourceDigest
      });
  completed.push(...input.plan.operations.filter((op) =>
    input.phase.id === 'rulesets-applied'
      ? op.actionId === 'github.ruleset.apply' || op.actionId === 'github.ruleset.readback'
      : op.actionId === 'github.ruleset.readback'
  ));
  if (write.sourceDigest !== sourceDigest || write.readbackDigest !== sourceDigest) {
    return {
      status: 'blocked',
      blocker: 'Post-write live ruleset readback did not match the saved source digest.',
      completedOperations: completed
    };
  }
  const header = evidenceHeaderFor({
    inspection: input.inspection,
    phase: input.phase,
    plan: input.plan,
    result: 'verified',
    now: input.now
  });
  const liveReadback: LiveReadbackProof = {
    schemaVersion: input.inspection.state.identity.evidenceHeaderSchemaVersion,
    repositoryId: header.repositoryId,
    identity: header.identity,
    phaseGraphHash: header.phaseGraphHash,
    phaseId: header.phaseId,
    baselineSha: header.baselineSha,
    inputDigest: header.inputDigest,
    transition: header.transition,
    observedAt: input.now.toISOString(),
    provider: 'github',
    resourceType: 'ruleset',
    resourceId: write.resourceId,
    sourceDigest,
    readbackDigest: write.readbackDigest,
    matches: true
  };
  return {
    status: 'completed',
    resultState: 'verified',
    liveReadback: [liveReadback],
    evidencePayload: {
      kind: `${input.phase.id}.v1`,
      sourceDigest,
      resourceId: write.resourceId,
      readbackDigest: write.readbackDigest
    },
    completedOperations: completed
  };
}

async function executeBuiltInPhase(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  const custom = input.adapters.phases?.[input.phase.id];
  if (custom) {
    return await custom.execute(input);
  }
  for (const attempt of [
    executeSeedOperations,
    async (execution: PhaseAdapterExecutionInput) => executeGitOperations(execution, execution.plan.operations),
    discoverPhase0,
    executeActivationApproval,
    executeCredentialReady,
    async (execution: PhaseAdapterExecutionInput) => remoteImportRetention(execution),
    executeBootstrapStateDisposal,
    executeRulesetPhase
  ]) {
    const outcome = await attempt(input);
    if (outcome) {
      return outcome;
    }
  }
  return {
    status: 'blocked',
    blocker: `No production adapter is configured for ${input.phase.id}; refusing success-shaped fallback.`,
    completedOperations: []
  };
}

function sourceOfTruthAllowsPhase(inspection: GovernanceTransitionInspection, phaseId: PhaseId): string | null {
  if (phaseOrder(phaseId) <= phaseOrder('phase-0-complete')) {
    return null;
  }
  const source = inspection.sourceOfTruth;
  if (phaseId === 'activation-approved' && (source.status === 'none' || source.status === 'selected')) {
    return null;
  }
  if (source.status === 'selected' && source.reconciliation.status === 'not-required') {
    return null;
  }
  if (source.status === 'seed-blocked') {
    return source.blockers.join('; ');
  }
  if (source.status === 'ambiguous' || source.status === 'incompatible') {
    return source.blockers.join('; ');
  }
  if (source.status === 'none') {
    return source.createPlan.reason;
  }
  return 'Active governance source of truth is not ready.';
}

export async function executeApplyNext(input: {
  inspection: GovernanceTransitionInspection;
  reinspect: () => Promise<GovernanceTransitionInspection>;
  runner?: CommandRunner;
  adapters?: GovernanceTransitionAdapters;
  now?: Date;
}): Promise<ApplyNextExecutionResult> {
  const runner = input.runner ?? new NodeCommandRunner();
  const adapters = input.adapters ?? {};
  const now = input.now ?? new Date();
  const initialPlan = await buildSavedTransitionPlan({ inspection: input.inspection, runner, now });
  if (!initialPlan) {
    const preview = await previewApplyNext({ inspection: input.inspection, runner, now, execute: true });
    return {
      ...preview,
      applied: false,
      executedPhase: null,
      noWrites: false,
      executedOperations: [],
      evidence: null,
      stateHash: null,
      rollbackPlan: rollbackPlanFromCompletedOperations(input.inspection.readiness.nextReadyPhase ?? 'seed-valid', 'none', null, []),
      cleanupWarnings: []
    };
  }
  const phase = phaseById(input.inspection.graph, initialPlan.phaseId);
  assertPlanOperationsAllowed(initialPlan, phase);
  if (initialPlan.approval.evaluation.approvalRequired) {
    const preview = await previewApplyNext({ inspection: input.inspection, runner, now, execute: true });
    return {
      ...preview,
      applied: false,
      executedPhase: null,
      noWrites: false,
      executedOperations: [],
      evidence: null,
      stateHash: null,
      rollbackPlan: initialPlan.rollbackPlan,
      cleanupWarnings: []
    };
  }
  const saved = await saveTransitionPlan(input.inspection.projectRoot, initialPlan);
  const freshInspection = await input.reinspect();
  const freshPlan = await buildSavedTransitionPlan({ inspection: freshInspection, runner, now });
  const freshnessIssues = comparePlanFreshness(initialPlan, freshPlan);
  if (freshnessIssues.length > 0) {
    return {
      schemaVersion: 1,
      command: 'governance apply-next',
      projectRoot: input.inspection.projectRoot,
      execute: true,
      applied: false,
      authorized: false,
      reason: 'stale-after-plan-save',
      message: freshnessIssues.join(' '),
      selectedPhase: initialPlan.phaseId,
      executedPhase: null,
      nextReadyPhase: freshInspection.readiness.nextReadyPhase,
      approval: initialPlan.approval,
      proposedMutations: {
        local: initialPlan.mutationClasses.local,
        remote: initialPlan.mutationClasses.remote,
        operations: initialPlan.operations
      },
      savedPlan: saved,
      noWrites: false,
      blockers: freshnessIssues,
      executedOperations: [],
      evidence: null,
      stateHash: null,
      rollbackPlan: initialPlan.rollbackPlan,
      cleanupWarnings: []
    };
  }
  const sourceBlocker = sourceOfTruthAllowsPhase(freshInspection, initialPlan.phaseId);
  if (sourceBlocker) {
    const nextState = blockedState({ inspection: freshInspection, phase, plan: initialPlan, blocker: sourceBlocker, now });
    const write = await writeOutcomeTransaction({
      projectRoot: freshInspection.projectRoot,
      plan: initialPlan,
      nextState
    });
    return executionBlockedResult(freshInspection, initialPlan, saved, sourceBlocker, [], write.stateHash);
  }
  const outcome = await executeBuiltInPhase({
    inspection: freshInspection,
    plan: initialPlan,
    phase,
    runner,
    adapters,
    now
  });
  const completedOperations = outcome.completedOperations ?? [];
  if (outcome.status === 'blocked') {
    const blocker = outcome.blocker ?? `Phase ${phase.id} blocked.`;
    if (outcome.retryableWithoutStateMutation) {
      const stateHash = freshInspection.loadedState?.contentHash ??
        activationStateContentHash(canonicalJson(freshInspection.state));
      return executionBlockedResult(
        freshInspection,
        initialPlan,
        saved,
        blocker,
        completedOperations,
        stateHash,
        outcome.cleanupWarnings ?? [],
        false
      );
    }
    const nextState = blockedState({ inspection: freshInspection, phase, plan: initialPlan, blocker, now });
    const write = await writeOutcomeTransaction({
      projectRoot: freshInspection.projectRoot,
      plan: initialPlan,
      nextState
    });
    return executionBlockedResult(freshInspection, initialPlan, saved, blocker, completedOperations, write.stateHash, outcome.cleanupWarnings ?? []);
  }
  const resultState = outcome.resultState ?? 'verified';
  if (!(phase.terminalStates as readonly string[]).includes(resultState)) {
    const blocker = `Phase adapter returned ${resultState}, which is not an allowed terminal state for ${phase.id}.`;
    const nextState = blockedState({ inspection: freshInspection, phase, plan: initialPlan, blocker, now });
    const write = await writeOutcomeTransaction({
      projectRoot: freshInspection.projectRoot,
      plan: initialPlan,
      nextState
    });
    return executionBlockedResult(
      freshInspection,
      initialPlan,
      saved,
      blocker,
      completedOperations,
      write.stateHash,
      outcome.cleanupWarnings ?? []
    );
  }
  let evidenceRecord: PhaseEvidenceRecord | undefined;
  let evidenceParts: readonly string[] | undefined;
  let evidenceReference: UserActivationState['phases'][PhaseId]['evidence'][number] | undefined;
  if (resultState !== 'approved') {
    const evidenceId = `${phase.id}-${safeTimestamp(now.toISOString())}`;
    const header = evidenceHeaderFor({
      inspection: freshInspection,
      phase,
      plan: initialPlan,
      result: resultState,
      now
    });
    evidenceRecord = {
      evidenceId,
      header,
      ...(outcome.liveReadback ? { liveReadback: outcome.liveReadback } : {}),
      ...(outcome.evidencePayload !== undefined ? { payload: outcome.evidencePayload } : {})
    };
    evidenceParts = evidencePathParts(evidenceId);
    evidenceReference = {
      phaseId: phase.id,
      evidenceId,
      headerDigest: evidenceHeaderDigest(header),
      result: header.result
    };
  }
  const nextState = nextStateForOutcome({
    inspection: freshInspection,
    phase,
    plan: initialPlan,
    resultState,
    evidenceReference,
    override: outcome.stateOverride,
    now
  });
  const write = await writeOutcomeTransaction({
    projectRoot: freshInspection.projectRoot,
    plan: initialPlan,
    nextState,
    evidenceRecord,
    evidencePathParts: evidenceParts,
    fileMutations: outcome.fileMutations
  });
  const rollbackPlan = rollbackPlanForPhase(phase, completedOperations);
  return {
    schemaVersion: 1,
    command: 'governance apply-next',
    projectRoot: freshInspection.projectRoot,
    execute: true,
    applied: true,
    authorized: true,
    reason: 'phase-executed',
    message: `Executed one phase: ${phase.id}.`,
    selectedPhase: phase.id,
    executedPhase: phase.id,
    nextReadyPhase: phase.id,
    approval: initialPlan.approval,
    proposedMutations: {
      local: initialPlan.mutationClasses.local,
      remote: initialPlan.mutationClasses.remote,
      operations: initialPlan.operations
    },
    savedPlan: saved,
    noWrites: false,
    blockers: [],
    executedOperations: [
      ...completedOperations,
      ...(evidenceParts ? [evidenceWriteOperation(phase, evidenceParts)] : []),
      stateWriteOperation(phase)
    ],
    evidence: write.evidence,
    stateHash: write.stateHash,
    rollbackPlan,
    cleanupWarnings: [...rollbackPlan.cleanupWarnings, ...(outcome.cleanupWarnings ?? [])]
  };
}

function executionBlockedResult(
  inspection: GovernanceTransitionInspection,
  plan: SavedTransitionPlan,
  saved: { pathParts: readonly string[]; digest: string },
  blocker: string,
  completedOperations: readonly TransitionOperation[],
  stateHashValue: string,
  cleanupWarnings: readonly string[] = [],
  stateWritten = true
): ApplyNextExecutionResult {
  const phase = phaseById(inspection.graph, plan.phaseId);
  const rollbackPlan = rollbackPlanForPhase(phase, completedOperations);
  return {
    schemaVersion: 1,
    command: 'governance apply-next',
    projectRoot: inspection.projectRoot,
    execute: true,
    applied: false,
    authorized: false,
    reason: 'blocked',
    message: blocker,
    selectedPhase: plan.phaseId,
    executedPhase: null,
    nextReadyPhase: plan.phaseId,
    approval: plan.approval,
    proposedMutations: {
      local: plan.mutationClasses.local,
      remote: plan.mutationClasses.remote,
      operations: plan.operations
    },
    savedPlan: saved,
    noWrites: false,
    blockers: [blocker],
    executedOperations: [
      ...completedOperations,
      ...(stateWritten ? [stateWriteOperation(phase)] : [])
    ],
    evidence: null,
    stateHash: stateHashValue,
    rollbackPlan,
    cleanupWarnings: [...rollbackPlan.cleanupWarnings, ...cleanupWarnings]
  };
}
