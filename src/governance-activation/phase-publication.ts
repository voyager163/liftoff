import { type GitIgnoreRule, parseGitIgnore, ignoredByRules } from './git-ignore.js';
import { readProjectFile } from '../adapters/filesystem/project-files.js';
import { readdir, lstat } from 'node:fs/promises';
import { isProjectMutationReservationName, remoteRepository, githubRepositoryFromPushUrl } from '../domain/governance/activation/inputs.js';
import path from 'node:path';
import { validateArtifactPathParts } from '../domain/project/paths.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import type {
  GitStatusEntry, GitRepositoryInspection, GitRemote, GovernanceTransitionInspection, PhaseAdapterExecutionInput, PhaseAdapterOutcome
} from './transition-ports.js';
import type { CommandRunner } from '../process-runner.js';
import { runGit, commandSucceeded, commandFailure } from './transition-process.js';
import type { UserActivationState, PhaseGraphNode, TransitionOperation } from '../domain/governance/activation/types.js';
import { operation, transitionDestination } from '../domain/governance/activation/operations.js';
import { canonicalApprovalEnvelopeHash } from '../domain/governance/activation/approvals.js';
import { readbackProof } from './transition-records.js';

async function allProjectFiles(projectRoot: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string, relative: string, inherited: readonly GitIgnoreRule[] = []): Promise<void> {
    const ignoreBytes = await readProjectFile(projectRoot, [...relative.split('/').filter(Boolean), '.gitignore']);
    const rules = [...inherited, ...parseGitIgnore(ignoreBytes?.toString('utf8') ?? '', relative)];
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      if (
        entry.name === '.git' ||
        isProjectMutationReservationName(entry.name) ||
        entry.name === 'node_modules' ||
        entry.name === '.venv' ||
        entry.name === '.terraform' ||
        entry.name.startsWith('.env') && !entry.name.endsWith('.example') ||
        entry.name === '.cache' ||
        (relative === '' && entry.name === 'governance')
      ) continue;
      const child = path.join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (ignoredByRules(childRelative, entry.isDirectory(), rules)) continue;
      if (entry.isDirectory()) await visit(child, childRelative, rules);
      else if (entry.isFile()) files.push(childRelative);
    }
  }
  await visit(projectRoot, '');
  return files;
}

async function stagedPayloadDigest(projectRoot: string, files: readonly string[]): Promise<string> {
  const entries = [];
  for (const file of [...files].sort()) {
    const bytes = await readProjectFile(projectRoot, validateArtifactPathParts(file.split('/'), 'Reviewed Git path'));
    if (!bytes) throw new Error(`Reviewed Git payload ${file} disappeared.`);
    entries.push({ path: file, digest: canonicalSha256(bytes.toString('base64')) });
  }
  return canonicalSha256(entries);
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

export async function inspectGitRepository(projectRoot: string, runner: CommandRunner): Promise<GitRepositoryInspection> {
  const rootResult = await runGit(runner, projectRoot, ['rev-parse', '--show-toplevel']);
  if (!commandSucceeded(rootResult)) {
    let markerPresent = true;
    try { await lstat(path.join(projectRoot, '.git')); }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') markerPresent = false;
      else throw error;
    }
    return {
      insideWorkTree: false, root: null, branch: null, head: null, upstream: null, status: [], remotes: [],
      issues: markerPresent || rootResult.status !== 128 || rootResult.errorCode || rootResult.timedOut
        ? ['Git discovery failed; refusing to reinterpret an unsafe, inaccessible, or invalid repository as a new repository.']
        : []
    };
  }
  const root = path.resolve(rootResult.stdout.trim());
  if (root !== path.resolve(projectRoot)) {
    return {
      insideWorkTree: true, root, branch: null, head: null, upstream: null, status: [], remotes: [],
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
  for (const remote of remotes) {
    const pushUrls = await runGit(runner, projectRoot, ['remote', 'get-url', '--push', '--all', remote.name]);
    remote.pushUrls = commandSucceeded(pushUrls) ? pushUrls.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
  }
  const issues: string[] = [];
  if (!branch) issues.push('Detached HEAD or unborn branch cannot be reviewed for deterministic governance commit/push.');
  if (!commandSucceeded(statusResult)) issues.push(commandFailure(statusResult));
  if (status.some((entry) => entry.index === 'D' || entry.worktree === 'D')) {
    issues.push('Unknown file deletion is outside the reviewed initial commit plan.');
  }
  return { insideWorkTree: true, root, branch, head, upstream, status, remotes, issues };
}

function parseRemotes(output: string): GitRemote[] {
  const remotes = new Map<string, GitRemote>();
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/u);
    if (match) {
      const entry = remotes.get(match[1]!) ?? { name: match[1]!, url: '', pushUrls: [] };
      if (match[3] === 'fetch') entry.url = match[2]!;
      else entry.pushUrls = [...entry.pushUrls, match[2]!];
      remotes.set(entry.name, entry);
    }
  }
  return [...remotes.values()].sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

function gitStatusDigest(inspection: GitRepositoryInspection): string {
  return canonicalSha256({ branch: inspection.branch, head: inspection.head, status: inspection.status, remotes: inspection.remotes });
}

async function remoteHead(runner: CommandRunner, projectRoot: string, remote: string, branch: string): Promise<string | null> {
  const result = await runGit(runner, projectRoot, ['ls-remote', '--heads', remote, branch]);
  if (!commandSucceeded(result)) throw new Error(commandFailure(result));
  const first = result.stdout.trim().split(/\s+/u)[0];
  return first && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(first) ? first : null;
}

async function isAncestor(runner: CommandRunner, projectRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await runGit(runner, projectRoot, ['merge-base', '--is-ancestor', ancestor, descendant])).status === 0;
}

function defaultBranch(state: UserActivationState): string {
  return remoteRepository(state).defaultBranch || 'develop';
}

export function reviewedPushUrl(git: GitRepositoryInspection): string {
  const origin = git.remotes[0];
  if (git.remotes.length !== 1 || origin?.name !== 'origin' ||
    origin.pushUrls.length !== 1 || origin.pushUrls[0] !== origin.url) {
    throw new Error('Publication requires one resolved origin push URL matching its reviewed fetch destination; differing or multiple push destinations are unreviewed.');
  }
  const url = origin.pushUrls[0]!;
  if (/https?:\/\/[^/]*@/i.test(url)) throw new Error('Credential-bearing Git destinations cannot be reviewed or persisted.');
  return url;
}

export async function gitCommitOperations(
  inspection: GovernanceTransitionInspection,
  phase: PhaseGraphNode,
  runner: CommandRunner
): Promise<TransitionOperation[]> {
  const git = await inspectGitRepository(inspection.projectRoot, runner);
  if (git.issues.length > 0) throw new Error(git.issues.join(' '));
  const branch = defaultBranch(inspection.state);
  if (!git.insideWorkTree) {
    const files = await allProjectFiles(inspection.projectRoot);
    return [
      operation({
        adapter: 'git', actionId: 'git.init', mutationClass: 'git-commit', phaseId: phase.id,
        inputs: { branch }, destination: transitionDestination('local', '.git'), remote: false, destructive: false
      }),
      operation({
        adapter: 'git', actionId: 'git.add-reviewed', mutationClass: 'git-commit', phaseId: phase.id,
        inputs: { paths: files, statusDigest: canonicalSha256(files), payloadDigest: await stagedPayloadDigest(inspection.projectRoot, files) },
        destination: transitionDestination('local', 'git-index'), remote: false, destructive: false
      }),
      operation({
        adapter: 'git', actionId: 'git.commit-reviewed', mutationClass: 'git-commit', phaseId: phase.id,
        inputs: { message: 'Initial Liftoff baseline', branch, paths: files },
        destination: transitionDestination('local', branch, { ref: branch }), remote: false, destructive: false
      })
    ];
  }
  if (git.branch !== branch) throw new Error(`Expected branch ${branch}, found ${git.branch ?? 'detached'}.`);
  if (git.upstream) {
    const divergence = await runGit(runner, inspection.projectRoot, ['rev-list', '--left-right', '--count', `${git.upstream}...HEAD`]);
    if (!commandSucceeded(divergence)) throw new Error(commandFailure(divergence));
    const [behind, ahead] = divergence.stdout.trim().split(/\s+/u).map((value) => Number.parseInt(value, 10));
    if ((behind ?? 0) > 0 || (ahead ?? 0) > 0) {
      throw new Error(`Branch ${branch} diverges from ${git.upstream}; refusing commit before explicit reconciliation.`);
    }
  }
  if (git.status.length === 0 && git.head) {
    return [operation({
      adapter: 'git', actionId: 'git.verify-existing-commit', mutationClass: 'read-worktree', phaseId: phase.id,
      inputs: { head: git.head, branch, statusDigest: gitStatusDigest(git) },
      destination: transitionDestination('local', branch, { ref: branch }), remote: false, destructive: false
    })];
  }
  const paths = git.status.map((entry) => entry.path).sort((left, right) => left.localeCompare(right, 'en'));
  return [
    operation({
      adapter: 'git', actionId: 'git.add-reviewed', mutationClass: 'git-commit', phaseId: phase.id,
      inputs: { paths, statusDigest: gitStatusDigest(git), payloadDigest: await stagedPayloadDigest(inspection.projectRoot, paths) },
      destination: transitionDestination('local', 'git-index'), remote: false, destructive: false
    }),
    operation({
      adapter: 'git', actionId: 'git.commit-reviewed', mutationClass: 'git-commit', phaseId: phase.id,
      inputs: { message: 'Initial Liftoff baseline', branch, paths },
      destination: transitionDestination('local', branch, { ref: branch }), remote: false, destructive: false
    })
  ];
}

export async function gitPushOperations(
  inspection: GovernanceTransitionInspection,
  phase: PhaseGraphNode,
  runner: CommandRunner
): Promise<TransitionOperation[]> {
  const git = await inspectGitRepository(inspection.projectRoot, runner);
  if (git.issues.length > 0) throw new Error(git.issues.join(' '));
  if (!git.insideWorkTree || !git.head) throw new Error('A reviewed local commit is required before push.');
  const branch = defaultBranch(inspection.state);
  if (git.branch !== branch) throw new Error(`Expected branch ${branch}, found ${git.branch ?? 'detached'}.`);
  if (git.status.length > 0) {
    throw new Error(`Worktree has unreviewed changes outside governance/plans: ${git.status.map((entry) => entry.path).join(', ')}.`);
  }
  const remoteNames = new Set(git.remotes.map((remote) => remote.name));
  if (!remoteNames.has('origin') || git.remotes.length !== 1) {
    throw new Error(`Expected exactly one approved origin remote; found ${git.remotes.map((remote) => remote.name).join(', ') || 'none'}.`);
  }
  const pushUrl = reviewedPushUrl(git);
  const remoteSha = await remoteHead(runner, inspection.projectRoot, pushUrl, branch);
  if (remoteSha && remoteSha !== git.head && !(await isAncestor(runner, inspection.projectRoot, remoteSha, git.head))) {
    throw new Error('Remote branch is not a fast-forward target; force, reset, rebase, and non-fast-forward push are forbidden.');
  }
  return [operation({
    adapter: 'git',
    actionId: remoteSha === git.head ? 'git.verify-existing-push' : 'git.push-approved-ref',
    mutationClass: remoteSha === git.head ? 'github-read' : 'git-push',
    phaseId: phase.id,
    inputs: { remote: 'origin', branch, localHead: git.head, remoteHead: remoteSha, statusDigest: gitStatusDigest(git), pushUrl },
    destination: transitionDestination('repository', pushUrl, {
      repository: githubRepositoryFromPushUrl(pushUrl), ref: `refs/heads/${branch}`
    }),
    remote: true, destructive: false
  })];
}

export async function executeGitOperations(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null> {
  if (input.phase.id !== 'committed' && input.phase.id !== 'pushed') return null;
  const completed: TransitionOperation[] = [];
  for (const op of input.plan.operations.filter((entry) => entry.adapter === 'git')) {
    if (op.actionId === 'git.verify-existing-commit' || op.actionId === 'git.verify-existing-push') {
      completed.push(op);
      continue;
    }
    await input.lease?.assertHeld();
    const currentTime = (input.clock?.() ?? input.now).getTime();
    const envelope = input.inspection.approvals.find((approval) => approval.id === input.plan.approval.envelopeId);
    if (Date.parse(input.plan.expiresAt) <= currentTime || !envelope ||
      Date.parse(envelope.approvedAt) > currentTime || Date.parse(envelope.expiresAt) <= currentTime ||
      canonicalApprovalEnvelopeHash(envelope) !== input.plan.approval.envelopeHash) {
      return { status: 'blocked', blocker: 'Publication approval or reviewed plan is no longer valid immediately before mutation.', completedOperations: completed };
    }
    if (op.actionId === 'git.init') {
      const result = await runGit(input.runner, input.inspection.projectRoot, ['init', '-b', String(op.inputs.branch)]);
      if (!commandSucceeded(result)) return { status: 'blocked', blocker: commandFailure(result), completedOperations: completed };
      completed.push(op);
    } else if (op.actionId === 'git.add-reviewed') {
      const paths = Array.isArray(op.inputs.paths) ? op.inputs.paths.map(String) : [];
      if (paths.length === 0) { completed.push(op); continue; }
      if (await stagedPayloadDigest(input.inspection.projectRoot, paths) !== op.inputs.payloadDigest) {
        return { status: 'blocked', blocker: 'Reviewed initial staging payload changed before git add.', completedOperations: completed };
      }
      const result = await runGit(input.runner, input.inspection.projectRoot, ['add', '--', ...paths]);
      if (!commandSucceeded(result)) return { status: 'blocked', blocker: commandFailure(result), completedOperations: completed };
      completed.push(op);
    } else if (op.actionId === 'git.commit-reviewed') {
      const result = await runGit(input.runner, input.inspection.projectRoot, ['commit', '-m', String(op.inputs.message)]);
      if (!commandSucceeded(result)) return { status: 'blocked', blocker: commandFailure(result), completedOperations: completed };
      completed.push(op);
    } else if (op.actionId === 'git.push-approved-ref') {
      const branch = String(op.inputs.branch);
      const git = await inspectGitRepository(input.inspection.projectRoot, input.runner);
      if (reviewedPushUrl(git) !== op.inputs.pushUrl || git.head !== op.inputs.localHead || git.status.length > 0) {
        return { status: 'blocked', blocker: 'Reviewed push destination or actual Git payload changed before publication.', completedOperations: completed };
      }
      const result = await runGit(input.runner, input.inspection.projectRoot, ['push', String(op.inputs.pushUrl), `HEAD:refs/heads/${branch}`]);
      if (!commandSucceeded(result)) return { status: 'blocked', blocker: commandFailure(result), completedOperations: completed };
      completed.push(op);
    }
  }
  const verified = await inspectGitRepository(input.inspection.projectRoot, input.runner);
  if (!verified.head) return { status: 'blocked', blocker: 'Publication did not produce a verifiable Git HEAD.', completedOperations: completed };
  if (input.phase.id === 'pushed') {
    const pushUrl = reviewedPushUrl(verified);
    if (await remoteHead(input.runner, input.inspection.projectRoot, pushUrl, defaultBranch(input.inspection.state)) !== verified.head) {
      return { status: 'blocked', blocker: 'Independent push destination readback does not match the reviewed commit.', completedOperations: completed };
    }
  }
  return {
    status: 'completed', resultState: 'verified',
    evidencePayload: { kind: `${input.phase.id}.v1`, head: verified.head, ...(input.phase.id === 'pushed' ? { pushUrl: reviewedPushUrl(verified) } : {}) },
    ...(input.phase.id === 'pushed' ? { liveReadback: [readbackProof(input, 'github', 'git-ref', reviewedPushUrl(verified), {
      head: verified.head, ref: defaultBranch(input.inspection.state), pushUrl: reviewedPushUrl(verified)
    })] } : {}),
    completedOperations: completed
  };
}
