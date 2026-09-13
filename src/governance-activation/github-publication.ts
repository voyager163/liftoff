import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput } from './transition-ports.js';
import type { TransitionOperation } from '../domain/governance/activation/types.js';
import { inspectGitRepository, reviewedPushUrl } from './phase-publication.js';
import { commandSucceeded, runGit } from './transition-process.js';
import { cloneState, readbackProof } from './transition-records.js';
import { GitHubActivationError, githubRepository, object, positiveId } from '../adapters/github/activation-rest.js';
import { assertGitHubAuthorized, clientFor, githubOperation, repositoryConfiguration, sourceSha } from './github-config.js';

export async function planGitHubPublication(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  const config = repositoryConfiguration(input.inspection);
  const client = clientFor(input);
  const git = await inspectGitRepository(input.inspection.projectRoot, input.runner);
  if (git.issues.length || !git.insideWorkTree || !git.head || git.branch !== config.defaultBranch || git.status.length) {
    throw new GitHubActivationError('publication-prerequisite', 'Publication requires a clean reviewed local commit on develop at this exact project root; no reset, rebase, or arbitrary staging is permitted.');
  }
  const pushUrl = `https://github.com/${config.name}.git`;
  if (git.remotes.length) {
    const reviewed = reviewedPushUrl(git);
    const accepted = [pushUrl, `git@github.com:${config.name}.git`, `ssh://git@github.com/${config.name}.git`];
    if (!accepted.includes(reviewed)) throw new GitHubActivationError('remote-drift', 'The existing origin differs from the explicitly approved github.com destination. It will not be replaced.');
  }
  const repository = await client.optional(`/repos/${config.name}`);
  if (!repository && !config.create) {
    throw new GitHubActivationError('repository-prerequisite', 'The approved repository is absent or unreadable. Grant access, or explicitly approve repository.create for this exact destination.');
  }
  const [owner, name] = config.name.split('/') as [string, string];
  let ownerKind: 'user' | 'organization' = 'organization';
  if (!repository) {
    const ownerInfo = await client.get(`/users/${owner}`);
    if (ownerInfo.type === 'User') {
      const actor = await client.get('/user');
      if (actor.login !== owner) throw new GitHubActivationError('owner-prerequisite', 'A personal repository can only be created for the authenticated approved owner.');
      ownerKind = 'user';
    } else if (ownerInfo.type === 'Organization') {
      const membership = await client.get(`/user/memberships/orgs/${owner}`);
      if (membership.state !== 'active') throw new GitHubActivationError('owner-prerequisite', 'An active approved organization identity with repository-create permission is required.');
    } else throw new GitHubActivationError('owner-prerequisite', 'The approved repository owner is not a supported user or organization.');
  } else {
    assertRepositoryBinding(repository, config.name, config.visibility);
    if (repository.default_branch !== config.defaultBranch) {
      throw new GitHubActivationError('default-branch-prerequisite', 'An existing repository default branch must be reconciled to develop through a separately reviewed operation; publication will not silently change it.');
    }
  }
  const remote = repository ? await client.optional(`/repos/${config.name}/git/ref/heads/${config.defaultBranch}`) : null;
  const remoteHead = remote ? sourceSha(object(remote.object).sha) : null;
  if (remoteHead && remoteHead !== git.head) {
    const ancestor = await runGit(input.runner, input.inspection.projectRoot, ['merge-base', '--is-ancestor', remoteHead, git.head]);
    if (!commandSucceeded(ancestor)) {
      throw new GitHubActivationError('non-fast-forward', 'The remote branch is not a verified ancestor of the reviewed local commit. Fetch/reconcile under owner control; force-push is forbidden.');
    }
  }
  const operations: TransitionOperation[] = [
    githubOperation(input, 'github.repository.ensure', repository ? 'github-read' : 'github-repository-create', {
      repository: config.name, name, owner, ownerKind, visibility: config.visibility, create: !repository,
      repositoryId: repository ? positiveId(repository.id) : null, defaultBranch: config.defaultBranch
    }),
    ...(!git.remotes.length ? [{
      adapter: 'git' as const, actionId: 'git.remote.bind', mutationClass: 'git-remote-bind' as const, phaseId: input.phase.id,
      inputs: { name: 'origin', pushUrl }, destination: { type: 'local' as const, identity: '.git/config' },
      remote: false, destructive: false
    }] : []),
    {
      adapter: 'git', actionId: remoteHead === git.head ? 'git.verify-existing-push' : 'git.push-approved-ref',
      mutationClass: remoteHead === git.head ? 'github-read' : 'git-push', phaseId: input.phase.id,
      inputs: {
        repository: config.name, branch: config.defaultBranch, localHead: git.head, remoteHead,
        pushUrl: git.remotes.length ? reviewedPushUrl(git) : pushUrl
      },
      destination: { type: 'repository', identity: pushUrl, repository: config.name, ref: `refs/heads/${config.defaultBranch}` },
      remote: true, destructive: false
    }
  ];
  if (!repository) operations.push(githubOperation(input, 'github.repository.default-branch', 'github-write', {
    repository: config.name, defaultBranch: config.defaultBranch
  }));
  return { operations };
}

function assertRepositoryBinding(repository: Record<string, unknown>, expected: string, visibility: 'private' | 'public'): void {
  if (githubRepository(repository.full_name).toLowerCase() !== expected.toLowerCase() ||
    repository.private !== (visibility === 'private') || repository.archived !== false ||
    repository.disabled === true || repository.fork === true) {
    throw new GitHubActivationError('repository-binding', 'Repository identity, visibility, or ownership differs from the reviewed non-archived, non-fork destination.');
  }
  positiveId(repository.id);
}

export async function executeGitHubPublication(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  const config = repositoryConfiguration(input.inspection);
  const client = clientFor(input);
  const completed: TransitionOperation[] = [];
  try {
    const ensure = input.plan.operations.find((entry) => entry.actionId === 'github.repository.ensure');
    if (!ensure) throw new GitHubActivationError('publication-inventory', 'The reviewed repository binding operation is missing.');
    await assertGitHubAuthorized(input, ensure);
    let repository = await client.optional(`/repos/${config.name}`);
    if (!repository) {
      if (ensure.inputs.create !== true) throw new GitHubActivationError('repository-missing', 'The reviewed existing repository is no longer visible; refusing to create a replacement.');
      repository = await client.write('POST', ensure.inputs.ownerKind === 'user' ? '/user/repos' : `/orgs/${config.name.split('/')[0]}/repos`, {
        name: config.name.split('/')[1], private: config.visibility === 'private', auto_init: false, has_issues: true, has_projects: false
      });
      completed.push(ensure);
    }
    if (!repository) throw new GitHubActivationError('repository-readback', 'Repository creation returned no provider identity.');
    assertRepositoryBinding(repository, config.name, config.visibility);
    if (ensure.inputs.repositoryId !== null && repository.id !== ensure.inputs.repositoryId) {
      throw new GitHubActivationError('repository-drift', 'The repository ID changed after review.');
    }
    if (!completed.includes(ensure)) completed.push(ensure);
    for (const op of input.plan.operations.filter((entry) => entry.adapter === 'git')) {
      await assertGitHubAuthorized(input, op);
      const git = await inspectGitRepository(input.inspection.projectRoot, input.runner);
      if (git.issues.length || git.status.length || git.branch !== config.defaultBranch) {
        throw new GitHubActivationError('publication-drift', 'Local Git inputs changed after publication review.');
      }
      if (op.actionId === 'git.remote.bind') {
        if (!git.remotes.length) {
          const result = await runGit(input.runner, input.inspection.projectRoot, ['remote', 'add', 'origin', String(op.inputs.pushUrl)]);
          if (!commandSucceeded(result)) throw new GitHubActivationError('remote-bind', 'Git could not bind the approved origin; no existing remote was replaced.');
        } else if (reviewedPushUrl(git) !== op.inputs.pushUrl) throw new GitHubActivationError('remote-drift', 'Origin changed before approved binding.');
        completed.push(op);
      } else if (op.actionId === 'git.push-approved-ref' || op.actionId === 'git.verify-existing-push') {
        if (git.head !== op.inputs.localHead || reviewedPushUrl(git) !== op.inputs.pushUrl) {
          throw new GitHubActivationError('publication-drift', 'Git HEAD or push URL changed after review.');
        }
        const remote = await client.optional(`/repos/${config.name}/git/ref/heads/${config.defaultBranch}`);
        const sha = remote ? sourceSha(object(remote.object).sha) : null;
        if (sha !== op.inputs.localHead) {
          if (op.actionId !== 'git.push-approved-ref' || sha !== op.inputs.remoteHead) {
            throw new GitHubActivationError('remote-drift', 'Remote branch changed concurrently; no force/update was attempted.');
          }
          const result = await runGit(input.runner, input.inspection.projectRoot, [
            'push', String(op.inputs.pushUrl), `${sourceSha(op.inputs.localHead)}:refs/heads/${config.defaultBranch}`
          ]);
          if (!commandSucceeded(result)) throw new GitHubActivationError('publication-rejected', 'GitHub rejected publication; inspect protected-branch policy and the exact ref. No bypass was attempted.');
        }
        completed.push(op);
      }
    }
    const defaultOp = input.plan.operations.find((entry) => entry.actionId === 'github.repository.default-branch');
    if (defaultOp) {
      const live = await client.get(`/repos/${config.name}`);
      if (live.default_branch !== config.defaultBranch) {
        await assertGitHubAuthorized(input, defaultOp);
        await client.write('PATCH', `/repos/${config.name}`, { default_branch: config.defaultBranch });
      }
      completed.push(defaultOp);
    }
    const current = await client.get(`/repos/${config.name}`);
    assertRepositoryBinding(current, config.name, config.visibility);
    const ref = await client.get(`/repos/${config.name}/git/ref/heads/${config.defaultBranch}`);
    const head = sourceSha(object(ref.object).sha);
    const git = await inspectGitRepository(input.inspection.projectRoot, input.runner);
    if (head !== git.head || current.id !== repository.id || current.default_branch !== config.defaultBranch) {
      throw new GitHubActivationError('publication-readback', 'Independent repository/ref readback differs from the reviewed local publication.');
    }
    const state = cloneState(input.inspection.state);
    state.remoteBinding = {
      id: String(current.id), name: config.name, defaultBranch: config.defaultBranch,
      pushUrl: reviewedPushUrl(git), verifiedAt: input.now.toISOString()
    };
    const resourceId = `/repos/${config.name}`;
    return {
      status: 'completed', resultState: 'verified', stateOverride: state, completedOperations: completed,
      evidencePayload: { kind: 'pushed.v1', head, pushUrl: reviewedPushUrl(git), repositoryId: current.id },
      outputs: { values: { sourceSha: head, repositoryId: positiveId(current.id), repository: config.name },
        resources: [{ provider: 'github', resourceType: 'repository', resourceId }] },
      liveReadback: [readbackProof(input, 'github', 'repository', resourceId, {
        id: current.id, name: config.name, head, defaultBranch: config.defaultBranch, visibility: config.visibility
      })]
    };
  } catch (error) {
    return { status: 'blocked', completedOperations: completed,
      blocker: error instanceof GitHubActivationError ? error.message : 'Publication could not be verified; raw Git/provider diagnostics were withheld.' };
  }
}
