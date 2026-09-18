import { isUtf8 } from 'node:buffer';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import {
  GitHubActivationError,
  expectStatus,
  githubName,
  githubRef,
  githubRepository,
  object,
  positiveId,
  type GitHubActivationClient
} from './activation-rest.js';
import { clientFor, sourceSha } from '../../governance-activation/github-config.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import type { ExternalOperationState, TransitionOperation } from '../../domain/governance/activation/types.js';
import { assertGitHubPhaseAuthority } from '../../application/repository-governance/workflow-authority.js';
import {
  prepareWorkflowEffect, readWorkflowEffect, recordWorkflowProviderResult,
  type WorkflowEffectIdentity, type WorkflowEffectStep
} from '../../application/repository-governance/workflow-checkpoints.js';
import { gitObjectSha, readGitTree, treeWithFiles, workflowCommitSha } from './workflow-git-objects.js';
import { decodeWorkflow, matchesProtectedRefFamily } from './workflow-check-recipes.js';
import {
  controlledNodeTestPath, controlledSourceFixturePaths, readbackWorkflowContent,
  workflowSourcePathPattern as workflowPath, type WorkflowFileDefinition
} from './workflow-source-readback.js';
export {
  controlledNodeTestPath, controlledSourceFixturePaths,
  readbackWorkflowContent, readbackControlledNodeFixture, readbackValidationSource,
  type WorkflowFileDefinition, type ObservedWorkflowContent
} from './workflow-source-readback.js';

export interface PublishedWorkflowSourceFile {
  path: string;
  digest: string;
  readbackDigest: string;
  blobSha: string;
}

export interface WorkflowPublicationResult {
  status: 'pending' | 'completed';
  pendingReason?: 'pull-request' | 'workflow-registration';
  repository: string;
  repositoryId: number;
  actorId: number;
  actorLogin: string;
  ref: string;
  commitSha: string;
  featureBranch: string;
  pullRequestNumber: number;
  files: readonly PublishedWorkflowSourceFile[];
  publishedAt: string;
  operation: ExternalOperationState;
  workflows: readonly { path: string; workflowId: number; digest: string; blobSha: string; sourceSha: string }[];
}

export interface WorkflowPublicationPlan {
  schemaVersion: 1;
  recipe: 'gitflow-workflow-source.v1' | 'gitflow-node-test-fixture.v1' | 'gitflow-source-check-fixture.v1';
  repository: string;
  repositoryId: number;
  actorId: number;
  actorLogin: string;
  targetBranch: string;
  featureBranch: string;
  baseSha: string;
  mainSha: string;
  baseTreeSha: string;
  treeSha: string;
  commitSha: string;
  commitTime: string;
  commitMessage: string;
  controlsDigest: string;
  requiredChecks: readonly { context: string; appId: number | null }[];
  files: readonly (WorkflowFileDefinition & { blobSha: string; beforeBlobSha: string | null })[];
}

export interface GeneratedWorkflowPublicationReview extends Omit<WorkflowPublicationPlan, 'files'> {
  representation: 'registered-generated-source.v1';
  files: readonly (WorkflowPublicationPlan['files'][number] |
    (Omit<WorkflowPublicationPlan['files'][number], 'content'> & { contentSource: 'registered-generator' }))[];
}

/** Fits registered programs within the 64 KiB private-review bound; both digests bind bytes and local sources remain inline. */
export function reviewGeneratedWorkflowPublication(
  plan: WorkflowPublicationPlan, generatedPaths: readonly string[]
): GeneratedWorkflowPublicationReview {
  validateWorkflowPublicationPlan(plan);
  if (plan.recipe !== 'gitflow-workflow-source.v1' || !generatedPaths.length || generatedPaths.length > 64 ||
    new Set(generatedPaths).size !== generatedPaths.length ||
    generatedPaths.some((path) => !path.startsWith('.github/workflows/') || !plan.files.some((file) => file.path === path))) {
    throw new GitHubActivationError('publication-review', 'A generated-source review requires its exact registered workflow paths, never ruleset or fixture ownership.');
  }
  return {
    ...plan, representation: 'registered-generated-source.v1',
    files: plan.files.map((file) => {
      if (!generatedPaths.includes(file.path)) return file;
      const { content: _content, ...identity } = file;
      return { ...identity, contentSource: 'registered-generator' as const };
    })
  };
}

function generatedReviewPaths(value: Record<string, unknown>): string[] {
  if (value.representation !== 'registered-generated-source.v1' || !Array.isArray(value.files) ||
    !value.files.length || value.files.length > 64) {
    throw new GitHubActivationError('publication-review', 'The generated-source review representation or exact file inventory is invalid.');
  }
  return value.files.flatMap((entry) => {
    const file = object(entry);
    if (Object.hasOwn(file, 'contentSource') && file.contentSource !== 'registered-generator' ||
      file.contentSource === 'registered-generator' && Object.hasOwn(file, 'content')) {
      throw new GitHubActivationError('publication-review', 'Generated-source references cannot use unknown encodings or mix inline bytes with generator references.');
    }
    return file.contentSource === 'registered-generator' ? [String(file.path)] : [];
  });
}

function publicationPayloadMatches(plan: WorkflowPublicationPlan, value: unknown): boolean {
  const reviewed = object(value, 'Reviewed workflow publication');
  return reviewed.representation === undefined ? canonicalSha256(reviewed) === canonicalSha256(plan) :
    canonicalSha256(reviewed) === canonicalSha256(reviewGeneratedWorkflowPublication(plan, generatedReviewPaths(reviewed)));
}

/** Rehydrates only from current registered renderers, then verifies the exact reviewed file/blob/commit identities. */
export function materializeWorkflowPublicationReview(
  value: unknown, generatedFiles: readonly WorkflowFileDefinition[]
): WorkflowPublicationPlan {
  const reviewed = object(value, 'Reviewed workflow publication');
  if (reviewed.representation === undefined) {
    const plan = reviewed as unknown as WorkflowPublicationPlan;
    validateWorkflowPublicationPlan(plan);
    return plan;
  }
  const paths = generatedReviewPaths(reviewed);
  const { representation: _representation, files: _files, ...identity } = reviewed;
  const plan = {
    ...identity,
    files: (reviewed.files as unknown[]).map((entry) => {
      const file = object(entry);
      if (!paths.includes(String(file.path))) return file;
      if (Object.hasOwn(file, 'content')) {
        throw new GitHubActivationError('publication-review', 'A generated source file cannot mix inline bytes with registered content references.');
      }
      const current = generatedFiles.filter((source) => source.path === file.path);
      if (current.length !== 1) {
        throw new GitHubActivationError('publication-review', 'The exact reviewed generated workflow is missing or ambiguous in the current trusted renderer inventory.');
      }
      const { contentSource: _source, ...binding } = file;
      return { ...binding, content: current[0]!.content };
    })
  } as unknown as WorkflowPublicationPlan;
  validateWorkflowPublicationPlan(plan);
  if (!publicationPayloadMatches(plan, reviewed)) {
    throw new GitHubActivationError('publication-review', 'The generated-source review differs from its exact rehydrated source/actor/ref/blob inventory.');
  }
  return plan;
}

function isPublicationTarget(ref: string): boolean {
  return ref === 'develop' || ref === 'main' ||
    matchesProtectedRefFamily(ref, 'release/**') || matchesProtectedRefFamily(ref, 'hotfix/**');
}

export function validateWorkflowPublicationPlan(plan: WorkflowPublicationPlan): void {
  githubRepository(plan.repository); positiveId(plan.repositoryId); positiveId(plan.actorId); githubName(plan.actorLogin);
  for (const sha of [plan.baseSha, plan.mainSha, plan.baseTreeSha, plan.treeSha, plan.commitSha]) sourceSha(sha);
  if (plan.schemaVersion !== 1 || !['gitflow-workflow-source.v1', 'gitflow-node-test-fixture.v1', 'gitflow-source-check-fixture.v1'].includes(plan.recipe) ||
    !/^(?:feature|automation)\/[A-Za-z0-9][A-Za-z0-9_./-]*$/u.test(githubRef(plan.featureBranch)) ||
    !isPublicationTarget(githubRef(plan.targetBranch)) ||
    plan.recipe === 'gitflow-workflow-source.v1' && plan.targetBranch !== 'develop' ||
    !/^[a-f0-9]{64}$/u.test(plan.controlsDigest) ||
    !Number.isFinite(Date.parse(plan.commitTime)) || new Date(plan.commitTime).toISOString() !== plan.commitTime ||
    Date.parse(plan.commitTime) % 1000 !== 0 || !plan.commitMessage || plan.commitMessage.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(plan.commitMessage) ||
    !Array.isArray(plan.requiredChecks) || plan.requiredChecks.length > 64 ||
    plan.requiredChecks.some((check) => typeof check.context !== 'string' || !check.context ||
      check.context.length > 200 || /[\u0000-\u001f\u007f]/u.test(check.context) ||
      check.appId !== null && (!Number.isSafeInteger(check.appId) || check.appId < 1)) ||
    !Array.isArray(plan.files) || !plan.files.length || plan.files.length > 64 ||
    new Set(plan.files.map((file) => file.path.toLowerCase())).size !== plan.files.length) {
    throw new GitHubActivationError('publication-plan', 'The reviewed GitFlow publication plan has invalid source, destination, actor or bounded payload identities.');
  }
  for (const file of plan.files) {
    if ((plan.recipe === 'gitflow-workflow-source.v1' ? !workflowPath.test(file.path) :
      !(controlledSourceFixturePaths as readonly string[]).includes(file.path)) ||
      typeof file.content !== 'string' || !file.content.length || Buffer.byteLength(file.content) > 256 * 1024 ||
      Buffer.from(file.content).toString('utf8') !== file.content ||
      canonicalSha256(file.content) !== file.digest || gitObjectSha('blob', file.content) !== file.blobSha ||
      file.beforeBlobSha !== null && !/^[a-f0-9]{40}$/u.test(file.beforeBlobSha)) {
      throw new GitHubActivationError('publication-plan', 'The reviewed file bytes, modes, blob identity or registered source path changed.');
    }
  }
  if (plan.files.reduce((size, file) => size + Buffer.byteLength(file.content), 0) > 512 * 1024 ||
    plan.recipe !== 'gitflow-workflow-source.v1' && plan.files.some((file) => file.beforeBlobSha !== null) ||
    plan.recipe === 'gitflow-node-test-fixture.v1' && (plan.files.length !== 1 || plan.files[0]!.path !== controlledNodeTestPath) ||
    plan.recipe === 'gitflow-workflow-source.v1' && !plan.files.some((file) => file.path.startsWith('.github/workflows/')) ||
    workflowCommitSha({ treeSha: plan.treeSha, parentSha: plan.baseSha, message: plan.commitMessage,
      actorLogin: plan.actorLogin, actorId: plan.actorId, commitTime: plan.commitTime }).sha !== plan.commitSha) {
    throw new GitHubActivationError('publication-plan', 'The exact bounded source inventory or deterministic commit identity no longer matches the approved publication.');
  }
}

export async function observePublicationTarget(client: GitHubActivationClient, repository: string, targetBranch: string) {
  const repo = githubRepository(repository);
  const branch = githubRef(targetBranch);
  const [metadata, actor, target, main, protections, rules, effective] = await Promise.all([
    client.get(`/repos/${repo}`), client.get('/user'),
    client.get(`/repos/${repo}/git/ref/heads/${branch}`), client.get(`/repos/${repo}/git/ref/heads/main`),
    client.optional(`/repos/${repo}/branches/${encodeURIComponent(branch)}/protection`),
    client.list(`/repos/${repo}/rulesets?includes_parents=true`),
    branch.includes('/') ? Promise.resolve([]) : client.list(`/repos/${repo}/rules/branches/${branch}`)
  ]);
  if (metadata.full_name !== repo || metadata.default_branch !== 'develop' ||
    metadata.archived !== false || metadata.disabled !== false ||
    target.ref !== `refs/heads/${branch}` || main.ref !== 'refs/heads/main' ||
    object(target.object).type !== 'commit' || object(main.object).type !== 'commit') {
    throw new GitHubActivationError('publication-target', 'Actual repository identity, active GitFlow default or permanent refs differ from the reviewed publication target.');
  }
  const controls = [];
  for (const rule of rules) controls.push(await client.get(`/repos/${repo}/rulesets/${positiveId(rule.id)}`));
  controls.sort((a, b) => positiveId(a.id) - positiveId(b.id));
  const required = new Map<string, { context: string; appId: number | null }>();
  const checks = [
    ...(protections?.required_status_checks ? (() => {
      const settings = object(protections.required_status_checks);
      if (!Array.isArray(settings.checks)) throw new GitHubActivationError('publication-protection', 'Classic branch protections must return the exact required check/app bindings.');
      return settings.checks.map((entry) => {
        const check = object(entry);
        return { context: check.context, appId: check.app_id === null || check.app_id === -1 ? null : positiveId(check.app_id) };
      });
    })() : []),
    ...effective.filter((rule) => rule.type === 'required_status_checks').flatMap((rule) => {
      const checks = object(rule.parameters).required_status_checks;
      if (!Array.isArray(checks)) throw new GitHubActivationError('publication-protection', 'Effective rules must return their exact required status-check bindings.');
      return checks.map((entry) => {
        const check = object(entry);
        return { context: check.context, appId: check.integration_id === null || check.integration_id === undefined ? null : positiveId(check.integration_id) };
      });
    })
  ];
  for (const check of checks) {
    if (typeof check.context !== 'string' || !check.context || check.context.length > 200 ||
      /[\u0000-\u001f\u007f]/u.test(check.context)) throw new GitHubActivationError('publication-protection', 'A required check has an invalid exact context name.');
    const existing = required.get(check.context);
    if (existing?.appId && check.appId && existing.appId !== check.appId) throw new GitHubActivationError('publication-protection', 'Conflicting required check app identities cannot authorize publication settlement.');
    required.set(check.context, { context: check.context, appId: existing?.appId ?? check.appId });
  }
  return {
    repositoryId: positiveId(metadata.id), actorId: positiveId(actor.id), actorLogin: githubName(actor.login, 'Authenticated actor login'),
    baseSha: sourceSha(object(target.object).sha), mainSha: sourceSha(object(main.object).sha),
    controlsDigest: canonicalSha256({ protections, controls, effective }),
    requiredChecks: [...required.values()].sort((a, b) => a.context.localeCompare(b.context, 'en'))
  };
}

export async function planWorkflowSourcePublication(input: {
  client: GitHubActivationClient;
  repository: string;
  repositoryId: number;
  actorId: number;
  baseSha: string;
  targetBranch?: string;
  featureBranch: string;
  workflowFiles: readonly WorkflowFileDefinition[];
  commitMessage: string;
  commitTime: string;
  recipe?: WorkflowPublicationPlan['recipe'];
}): Promise<WorkflowPublicationPlan> {
  const repo = githubRepository(input.repository);
  const branch = githubRef(input.featureBranch);
  const target = githubRef(input.targetBranch ?? 'develop');
  const recipe = input.recipe ?? 'gitflow-workflow-source.v1';
  if (!/^(?:feature|automation)\/[A-Za-z0-9][A-Za-z0-9_./-]*$/u.test(branch) ||
    !isPublicationTarget(target) ||
    recipe === 'gitflow-workflow-source.v1' && target !== 'develop' ||
    !Number.isFinite(Date.parse(input.commitTime)) || new Date(input.commitTime).toISOString() !== input.commitTime ||
    Date.parse(input.commitTime) % 1000 !== 0 ||
    !input.commitMessage || input.commitMessage.length > 200 || /[\u0000-\u001f\u007f]/u.test(input.commitMessage) ||
    !input.workflowFiles.length || input.workflowFiles.length > 64) {
    throw new GitHubActivationError('publication-plan', 'Publication requires an exact temporary GitFlow branch, reviewed whole-second UTC commit time, bounded message and source files. Main is never a workflow publication target.');
  }
  const files = input.workflowFiles.map((file) => {
    const bytes = Buffer.from(file.content);
    if ((recipe === 'gitflow-workflow-source.v1' ? !workflowPath.test(file.path) :
      !(controlledSourceFixturePaths as readonly string[]).includes(file.path)) ||
      bytes.length === 0 || bytes.length > 256 * 1024 || !isUtf8(bytes) || bytes.toString('utf8') !== file.content ||
      canonicalSha256(file.content) !== file.digest) {
      throw new GitHubActivationError('publication-file', 'Only exact bounded reviewed workflow/ruleset files or the registered test fixture may be published.');
    }
    return { ...file, blobSha: gitObjectSha('blob', bytes), beforeBlobSha: null as string | null };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (new Set(files.map((file) => file.path.toLowerCase())).size !== files.length ||
    files.reduce((size, file) => size + Buffer.byteLength(file.content), 0) > 512 * 1024 ||
    recipe === 'gitflow-workflow-source.v1' && !files.some((file) => file.path.startsWith('.github/workflows/')) ||
    recipe === 'gitflow-node-test-fixture.v1' && (files.length !== 1 || files[0]!.path !== controlledNodeTestPath)) {
    throw new GitHubActivationError('publication-file', 'Publication needs a unique bounded exact file inventory including an actual workflow; a fixture changes only its registered test.');
  }
  const observed = await observePublicationTarget(input.client, repo, target);
  if (observed.repositoryId !== positiveId(input.repositoryId) || observed.actorId !== positiveId(input.actorId) ||
    observed.baseSha !== sourceSha(input.baseSha)) {
    throw new GitHubActivationError('publication-binding', 'The actual repository ID, authenticated actor or target tip differs from the explicit publication inputs.');
  }
  if (await input.client.optional(`/repos/${repo}/git/ref/heads/${branch}`) ||
    (await input.client.list(`/repos/${repo}/pulls?state=all&head=${repo.split('/')[0]}:${branch}`)).length) {
    throw new GitHubActivationError('publication-collision', 'The reviewed temporary branch or a prior pull request already exists without this operation custody. Use recorded recovery, not a replacement branch.');
  }
  const commit = await input.client.get(`/repos/${repo}/git/commits/${observed.baseSha}`);
  if (commit.sha !== observed.baseSha) throw new GitHubActivationError('source-commit', 'The base commit readback differs from the exact reviewed source.');
  const baseTreeSha = sourceSha(object(commit.tree).sha);
  const entries = readGitTree(await input.client.get(`/repos/${repo}/git/trees/${baseTreeSha}?recursive=1`), baseTreeSha);
  for (const file of files) {
    const prior = entries.find((entry) => entry.path === file.path);
    if (recipe !== 'gitflow-workflow-source.v1' && prior) {
      throw new GitHubActivationError('fixture-collision', 'The controlled test fixture cannot replace an existing project-owned test.');
    }
    file.beforeBlobSha = prior?.sha ?? null;
  }
  const treeSha = treeWithFiles(entries, files).sha;
  if (treeSha === baseTreeSha) throw new GitHubActivationError('publication-no-change', 'The exact workflow bytes are already at the selected immutable source; use source readback instead of creating an empty PR.');
  const computed = workflowCommitSha({
    treeSha, parentSha: observed.baseSha, message: input.commitMessage, actorLogin: observed.actorLogin,
    actorId: observed.actorId, commitTime: input.commitTime
  });
  return {
    schemaVersion: 1, recipe, repository: repo, ...observed, targetBranch: target, featureBranch: branch,
    baseTreeSha, treeSha, commitSha: computed.sha, commitTime: input.commitTime, commitMessage: input.commitMessage, files
  };
}

function publicationIdentity(plan: WorkflowPublicationPlan, step: WorkflowEffectStep): WorkflowEffectIdentity {
  return { repositoryId: plan.repositoryId, ref: plan.featureBranch,
    purpose: plan.recipe === 'gitflow-workflow-source.v1' ? 'workflow-publication' : 'check-fixture', step };
}

function publicationRequest(plan: WorkflowPublicationPlan, step: Exclude<WorkflowEffectStep, 'dispatch'>) {
  const root = `/repos/${plan.repository}`;
  switch (step) {
    case 'tree': return { method: 'POST' as const, path: `${root}/git/trees`, body: {
      base_tree: plan.baseTreeSha,
      tree: plan.files.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: file.content }))
    } };
    case 'commit': {
      const { author } = workflowCommitSha({ treeSha: plan.treeSha, parentSha: plan.baseSha,
        message: plan.commitMessage, actorLogin: plan.actorLogin, actorId: plan.actorId, commitTime: plan.commitTime });
      return { method: 'POST' as const, path: `${root}/git/commits`,
        body: { tree: plan.treeSha, parents: [plan.baseSha], message: `${plan.commitMessage}\n`, author, committer: author } };
    }
    case 'ref': return { method: 'POST' as const, path: `${root}/git/refs`,
      body: { ref: `refs/heads/${plan.featureBranch}`, sha: plan.commitSha } };
    case 'pull-request': return { method: 'POST' as const, path: `${root}/pulls`, body: {
      head: plan.featureBranch, base: plan.targetBranch, title: plan.commitMessage,
      body: `Reviewed Liftoff ${plan.recipe}\n\nSource: ${plan.baseSha}\nPayload: ${canonicalSha256(plan)}\n\nNo bypass, protected-ref push, release or tag is authorized.`,
      maintainer_can_modify: false, draft: plan.recipe !== 'gitflow-workflow-source.v1'
    } };
  }
}

function publicationProviderIdentity(plan: WorkflowPublicationPlan, step: Exclude<WorkflowEffectStep, 'dispatch'>, value: Record<string, unknown>) {
  const root = `/repos/${plan.repository}`;
  if (step === 'tree') {
    if (value.sha !== plan.treeSha) throw new GitHubActivationError('publication-tree', 'The returned tree differs from the exact reviewed Git object.');
    return { providerId: sourceSha(value.sha), resourceId: `${root}/git/trees/${value.sha}` };
  }
  if (step === 'commit') {
    if (value.sha !== plan.commitSha || object(value.tree).sha !== plan.treeSha ||
      !Array.isArray(value.parents) || value.parents.length !== 1 || object(value.parents[0]).sha !== plan.baseSha) {
      throw new GitHubActivationError('publication-commit', 'The returned commit does not bind the exact reviewed tree and parent.');
    }
    return { providerId: sourceSha(value.sha), resourceId: `${root}/git/commits/${value.sha}` };
  }
  if (step === 'ref') {
    if (value.ref !== `refs/heads/${plan.featureBranch}` || object(value.object).sha !== plan.commitSha ||
      object(value.object).type !== 'commit' || typeof value.node_id !== 'string') {
      throw new GitHubActivationError('publication-ref', 'The created temporary ref does not point to the exact reviewed commit.');
    }
    return { providerId: value.node_id, resourceId: `${root}/git/ref/heads/${plan.featureBranch}` };
  }
  const head = object(value.head), base = object(value.base);
  if (head.ref !== plan.featureBranch || head.sha !== plan.commitSha || object(head.repo).id !== plan.repositoryId ||
    object(head.repo).full_name !== plan.repository || base.ref !== plan.targetBranch || object(base.repo).id !== plan.repositoryId ||
    object(base.repo).full_name !== plan.repository || object(value.user).id !== plan.actorId ||
    value.body !== publicationRequest(plan, 'pull-request').body.body ||
    plan.recipe !== 'gitflow-workflow-source.v1' && (value.merged === true || value.draft !== true)) {
    throw new GitHubActivationError('publication-pr', 'The pull request belongs to a different actor, source, repository or reviewed unmerged fixture.');
  }
  return { providerId: String(positiveId(value.number, 'Pull request number')), resourceId: `${root}/pulls/${value.number}` };
}

async function observePublicationStep(
  client: GitHubActivationClient, plan: WorkflowPublicationPlan, step: Exclude<WorkflowEffectStep, 'dispatch'>,
  providerId?: string | null
): Promise<Record<string, unknown> | null> {
  const root = `/repos/${plan.repository}`;
  if (step === 'tree') return client.optional(`${root}/git/trees/${plan.treeSha}`);
  if (step === 'commit') return client.optional(`${root}/git/commits/${plan.commitSha}`);
  if (step === 'ref') return client.optional(`${root}/git/ref/heads/${plan.featureBranch}`);
  if (providerId) return client.optional(`${root}/pulls/${positiveId(Number(providerId))}`);
  const matches = await client.list(`${root}/pulls?state=all&head=${plan.repository.split('/')[0]}:${plan.featureBranch}&base=${plan.targetBranch}`);
  if (!matches.length) return null;
  if (matches.length !== 1) throw new GitHubActivationError('publication-ambiguous', 'Recovery found multiple pull requests; no latest or guessed request can replace recorded custody.');
  return client.get(`${root}/pulls/${positiveId(matches[0]!.number)}`);
}

export async function readWorkflowPublicationOperation(
  execution: PhaseAdapterExecutionInput, operation: TransitionOperation, plan: WorkflowPublicationPlan
): Promise<ExternalOperationState | null> {
  for (const step of ['pull-request', 'ref', 'commit', 'tree'] as const) {
    const records = await readWorkflowEffect(execution, operation, publicationIdentity(plan, step), publicationRequest(plan, step));
    const provider = records?.observed ?? records?.response;
    if (records && provider?.providerId && provider.resourceId) return {
      provider: 'github', actionId: operation.actionId, operationId: provider.providerId, resourceId: provider.resourceId,
      startedAt: records.prepared.preparedAt, observedAt: provider.recordedAt, status: 'running', planDigest: records.prepared.planDigest
    };
  }
  return null;
}

/** Reads every original stage, including recovery-plan provenance; it never creates missing custody. */
export async function readWorkflowPublicationCheckpoints(
  execution: PhaseAdapterExecutionInput, operation: TransitionOperation, plan: WorkflowPublicationPlan
) {
  validateWorkflowPublicationPlan(plan);
  return Promise.all((['tree', 'commit', 'ref', 'pull-request'] as const).map(async (step) => ({
    step, records: await readWorkflowEffect(execution, operation, publicationIdentity(plan, step), publicationRequest(plan, step))
  })));
}

export async function assertPublicationPreconditions(client: GitHubActivationClient, plan: WorkflowPublicationPlan, mergedSha?: string): Promise<void> {
  const current = await observePublicationTarget(client, plan.repository, plan.targetBranch);
  if (current.repositoryId !== plan.repositoryId || current.actorId !== plan.actorId || current.actorLogin !== plan.actorLogin ||
    current.baseSha !== (mergedSha ?? plan.baseSha) ||
    current.mainSha !== (plan.targetBranch === 'main' && mergedSha ? mergedSha : plan.mainSha) ||
    current.controlsDigest !== plan.controlsDigest || canonicalSha256(current.requiredChecks) !== canonicalSha256(plan.requiredChecks)) {
    throw new GitHubActivationError('publication-drift', 'Repository, actor, protected refs or controls changed after review. Existing effects are retained; no force push or protection change is permitted.');
  }
}

async function assertPublicationSource(client: GitHubActivationClient, plan: WorkflowPublicationPlan): Promise<void> {
  const commit = await client.get(`/repos/${plan.repository}/git/commits/${plan.baseSha}`);
  if (commit.sha !== plan.baseSha || object(commit.tree).sha !== plan.baseTreeSha) {
    throw new GitHubActivationError('publication-source', 'The exact immutable publication base does not contain the reviewed source tree.');
  }
  const entries = readGitTree(await client.get(`/repos/${plan.repository}/git/trees/${plan.baseTreeSha}?recursive=1`), plan.baseTreeSha);
  if (plan.files.some((file) => (entries.find((entry) => entry.path === file.path)?.sha ?? null) !== file.beforeBlobSha) ||
    treeWithFiles(entries, plan.files).sha !== plan.treeSha) {
    throw new GitHubActivationError('publication-source', 'The reviewed Git tree changes more than the exact authorized file/blob inventory.');
  }
  const workflows = entries.filter((entry) => entry.path.startsWith('.github/workflows/') && /\.ya?ml$/u.test(entry.path));
  if (workflows.length > 64 || workflows.some((entry) => entry.mode !== '100644' || !workflowPath.test(entry.path))) {
    throw new GitHubActivationError('publication-trigger-scope', 'Automatic workflow source inventory is unbounded or includes unsupported linked/nested paths.');
  }
  for (const workflow of workflows) {
    const source = await readbackWorkflowContent(client, plan.repository, workflow.path, plan.baseSha);
    assertPublicationWorkflowEffects(source.content);
  }
  for (const file of plan.files.filter((file) => file.path.startsWith('.github/workflows/'))) {
    assertPublicationWorkflowEffects(file.content);
  }
}

export function assertPublicationWorkflowEffects(content: string): void {
  const workflow = decodeWorkflow(content);
  const eventNames = typeof workflow.on === 'string' ? [workflow.on] :
    Array.isArray(workflow.on) ? workflow.on : Object.keys(object(workflow.on));
  if (!eventNames.length || eventNames.some((event) => !['workflow_dispatch', 'push', 'pull_request'].includes(String(event)))) {
    throw new GitHubActivationError('publication-trigger-scope', 'Publication cannot introduce or trigger unreviewed schedule, workflow-run, privileged PR-target or release automation.');
  }
  if (eventNames.every((event) => event === 'workflow_dispatch')) return;
  const permissions = workflow.permissions;
  const readOnly = permissions === 'read-all' || typeof permissions === 'object' && permissions !== null &&
    !Array.isArray(permissions) && Object.values(permissions).every((value) => value === 'read' || value === 'none');
  if (!readOnly || /\bsecrets\s*[.[]/u.test(content)) {
    throw new GitHubActivationError('publication-trigger-scope', 'Implicit PR/push checks need explicit read-only permissions without stored credentials; publication approval is not credential or cloud execution authority.');
  }
  for (const raw of Object.values(object(workflow.jobs))) {
    const job = object(raw);
    if (job.uses !== undefined || job.secrets !== undefined || job.environment !== undefined ||
      !['ubuntu-22.04', 'ubuntu-24.04', 'ubuntu-latest', 'windows-2022', 'windows-2025', 'macos-14', 'macos-15'].includes(String(job['runs-on'])) ||
      !Number.isSafeInteger(job['timeout-minutes']) || Number(job['timeout-minutes']) < 1 || Number(job['timeout-minutes']) > 30 ||
      job.permissions !== undefined && (typeof job.permissions !== 'object' || job.permissions === null ||
        Array.isArray(job.permissions) || Object.values(job.permissions).some((value) => value !== 'read' && value !== 'none'))) {
      throw new GitHubActivationError('publication-trigger-scope', 'Implicit publication checks cannot use privileged, reusable, environment-scoped, unbounded or private/self-hosted jobs. Such workflows must remain separately approved dispatch-only recipes.');
    }
  }
}

async function verifyPublicationChecks(client: GitHubActivationClient, plan: WorkflowPublicationPlan): Promise<void> {
  if (!plan.requiredChecks.length) return;
  const checks = await client.list(`/repos/${plan.repository}/commits/${plan.commitSha}/check-runs?filter=latest`, 'check_runs');
  for (const required of plan.requiredChecks) {
    const matches = checks.filter((check) => check.name === required.context &&
      (required.appId === null || object(check.app).id === required.appId));
    const check = matches[0];
    if (matches.length !== 1 || !check || check.head_sha !== plan.commitSha ||
      check.status !== 'completed' || check.conclusion !== 'success' ||
      required.appId === null && object(check.app).slug !== 'github-actions') {
      throw new GitHubActivationError('publication-required-check', 'The recorded PR cannot settle publication without actual successful exact protected-branch checks; skipped, neutral, failed or synthetic statuses do not qualify.');
    }
    positiveId(check.id); positiveId(object(check.app).id);
  }
}

/** Creates only content-addressed objects, a fresh temporary ref and a reviewed PR. Never merges or updates a protected ref. */
export async function materializeGitFlowPullRequest(input: {
  execution: PhaseAdapterExecutionInput;
  operation: TransitionOperation;
  publication: WorkflowPublicationPlan;
  client?: GitHubActivationClient;
}): Promise<{ pullRequest: Record<string, unknown>; operation: ExternalOperationState }> {
  const execution = input.execution;
  const operation = structuredClone(input.operation);
  const plan = structuredClone(input.publication);
  validateWorkflowPublicationPlan(plan);
  if (plan.recipe === 'gitflow-workflow-source.v1' ?
    operation.actionId !== 'github.workflow-source.publish' ||
      !['repository-workflow-source-ready', 'bootstrap-workflow-source-ready', 'workflow-source-ready'].includes(execution.phase.id) :
    !(execution.phase.id === 'repository-checks-qualified' && operation.actionId === 'github.checks.repository-qualified' ||
      execution.phase.id === 'green-red-proof' && operation.actionId === 'github.checks.green-red-proof')) {
    throw new GitHubActivationError('publication-phase', 'Workflow publication and controlled check fixtures require their own exact registered phase/action authority; another phase approval cannot be substituted.');
  }
  const client = input.client ?? clientFor(execution);
  await assertGitHubPhaseAuthority(execution, operation);
  const allowedPayload = operation.inputs.publication ??
    (Array.isArray(operation.inputs.fixtures) ? operation.inputs.fixtures.find((entry) =>
      canonicalSha256(entry) === canonicalSha256(plan)) : undefined);
  if (!allowedPayload || !publicationPayloadMatches(plan, allowedPayload) ||
    operation.destination.repository !== plan.repository ||
    !['github.workflow-source.publish', 'github.checks.repository-qualified', 'github.checks.green-red-proof'].includes(operation.actionId)) {
    throw new GitHubActivationError('publication-authority', 'The exact GitFlow payload is absent from its own approved publication or qualification operation.');
  }
  await assertPublicationSource(client, plan);
  let pullRequest: Record<string, unknown> | null = null;
  let startedAt = '';
  let recordedPlanDigest = execution.plan.planDigest;
  for (const step of ['tree', 'commit', 'ref', 'pull-request'] as const) {
    const identity = publicationIdentity(plan, step);
    const request = publicationRequest(plan, step);
    let records = await readWorkflowEffect(execution, operation, identity, request);
    let prepared = records?.prepared;
    const retry = records?.response && [401, 403, 404, 422].includes(records.response.status) &&
      !records.observed && execution.recovery && execution.plan.recovery &&
      records.prepared.approvalEnvelopeHash !== execution.plan.approval.envelopeHash;
    if (!records || retry) {
      await assertPublicationPreconditions(client, plan);
      if (step === 'ref' && await client.optional(`/repos/${plan.repository}/git/ref/heads/${plan.featureBranch}`)) {
        throw new GitHubActivationError('publication-collision', 'An unrecorded temporary ref appeared after review; it is not owned by this operation.');
      }
      prepared = await prepareWorkflowEffect(execution, operation, identity, request);
      await assertGitHubPhaseAuthority(execution, operation);
      await assertPublicationPreconditions(client, plan);
      await assertGitHubPhaseAuthority(execution, operation);
      const response = await client.transport.request(request);
      let provider: { providerId: string; resourceId: string } | null = null;
      if (response.status === 201) {
        try { provider = publicationProviderIdentity(plan, step, object(response.data)); } catch { /* Retain an unconfirmed response before failing readback. */ }
      }
      await recordWorkflowProviderResult(execution, operation, identity, prepared, 'response', {
        status: response.status, requestId: response.headers['x-github-request-id'] ?? null,
        providerId: provider?.providerId ?? null, resourceId: provider?.resourceId ?? null
      });
      expectStatus(response, [201], `Publish reviewed ${step}`);
      publicationProviderIdentity(plan, step, object(response.data));
      records = await readWorkflowEffect(execution, operation, identity, request);
    }
    if (!prepared || !records) throw new GitHubActivationError('publication-checkpoint', 'Publication lost its immutable pre-effect record.');
    startedAt ||= prepared.preparedAt;
    const observed = await observePublicationStep(client, plan, step, records.observed?.providerId ?? records.response?.providerId);
    if (!observed) {
      throw new GitHubActivationError('publication-uncertain', 'The recorded publication request is not currently observable. Its checkpoint is retained; absence after an uncertain request never authorizes redispatch.');
    }
    const provider = publicationProviderIdentity(plan, step, observed);
    if (records.response?.providerId && provider.providerId !== records.response.providerId ||
      records.observed?.providerId && provider.providerId !== records.observed.providerId) {
      throw new GitHubActivationError('publication-provider-id', 'Independent publication readback differs from the actual recorded provider identity.');
    }
    if (!records.observed) await recordWorkflowProviderResult(execution, operation, identity, prepared, 'observed', {
      status: 200, requestId: null, ...provider
    });
    if (step === 'pull-request') {
      pullRequest = observed;
      recordedPlanDigest = prepared.planDigest;
    }
  }
  if (!pullRequest) throw new GitHubActivationError('publication-pr', 'No actual pull request was recorded.');
  const number = positiveId(pullRequest.number);
  return {
    pullRequest,
    operation: { provider: 'github', actionId: operation.actionId, operationId: String(number),
      resourceId: `/repos/${plan.repository}/pulls/${number}`, startedAt,
      observedAt: (execution.clock?.() ?? execution.now).toISOString(), status: 'running', planDigest: recordedPlanDigest }
  };
}

export async function publishWorkflowSourceViaGitFlow(input: {
  execution: PhaseAdapterExecutionInput;
  operation: TransitionOperation;
  publication: WorkflowPublicationPlan;
  client?: GitHubActivationClient;
}): Promise<WorkflowPublicationResult> {
  if (input.publication.recipe !== 'gitflow-workflow-source.v1') {
    throw new GitHubActivationError('publication-recipe', 'Controlled test fixtures can never become published workflow-source readiness.');
  }
  const client = input.client ?? clientFor(input.execution);
  const { operation } = await materializeGitFlowPullRequest({ ...input, client });
  return readbackWorkflowPublication({
    client, publication: input.publication, operation, now: input.execution.clock?.() ?? input.execution.now
  });
}

export async function readbackWorkflowPublication(input: {
  client: GitHubActivationClient;
  publication: WorkflowPublicationPlan;
  operation: ExternalOperationState;
  now?: Date;
}): Promise<WorkflowPublicationResult> {
  const plan = input.publication;
  validateWorkflowPublicationPlan(plan);
  const number = positiveId(Number(input.operation.operationId), 'Recorded publication PR number');
  if (plan.recipe !== 'gitflow-workflow-source.v1' || input.operation.provider !== 'github' ||
    input.operation.actionId !== 'github.workflow-source.publish' ||
    input.operation.resourceId !== `/repos/${plan.repository}/pulls/${number}`) {
    throw new GitHubActivationError('publication-readback-binding', 'Publication readback requires the actual recorded workflow-source PR, not a latest PR, fixture or another phase operation.');
  }
  const client = input.client;
  await assertPublicationSource(client, plan);
  const pullRequest = await client.get(input.operation.resourceId);
  const observed = publicationProviderIdentity(plan, 'pull-request', pullRequest);
  if (observed.providerId !== String(number)) throw new GitHubActivationError('publication-readback-binding', 'The provider returned a different publication PR identity.');
  const operation = { ...input.operation, observedAt: (input.now ?? new Date()).toISOString() };
  if (pullRequest.merged !== true) {
    if (pullRequest.state !== 'open') throw new GitHubActivationError('publication-closed', 'The recorded PR was closed without merging; no replacement or protected-ref push is authorized.');
    await assertPublicationPreconditions(client, plan);
    return { status: 'pending', pendingReason: 'pull-request', repository: plan.repository, ref: plan.featureBranch, commitSha: plan.commitSha,
      repositoryId: plan.repositoryId, actorId: plan.actorId, actorLogin: plan.actorLogin,
      featureBranch: plan.featureBranch, pullRequestNumber: Number(operation.operationId), files: [],
      publishedAt: operation.observedAt, operation, workflows: [] };
  }
  if (object(pullRequest.merged_by).id !== plan.actorId || pullRequest.state !== 'closed') {
    throw new GitHubActivationError('publication-merge-actor', 'Only the exact reviewed actor may settle this PR through the permitted provider protection/check path.');
  }
  const mergedSha = sourceSha(pullRequest.merge_commit_sha, 'Actual merged source SHA');
  const merged = await client.get(`/repos/${plan.repository}/git/commits/${mergedSha}`);
  const parents = Array.isArray(merged.parents) ? merged.parents.map((entry) => sourceSha(object(entry).sha)) : [];
  if (merged.sha !== mergedSha || object(merged.tree).sha !== plan.treeSha || parents[0] !== plan.baseSha ||
    !(parents.length === 1 || parents.length === 2 && parents[1] === plan.commitSha)) {
    throw new GitHubActivationError('publication-merge-source', 'The actual merge/squash includes unreviewed source or ancestry; exact approved source readback is required.');
  }
  await assertPublicationPreconditions(client, plan, mergedSha);
  await verifyPublicationChecks(client, plan);
  const files = [];
  const workflows: WorkflowPublicationResult['workflows'][number][] = [];
  let registrationPending = false;
  for (const file of plan.files) {
    const readback = await readbackWorkflowContent(client, plan.repository, file.path, mergedSha);
    if (readback.digest !== file.digest || readback.blobSha !== file.blobSha) {
      throw new GitHubActivationError('publication-readback', 'The merged immutable workflow file differs from its exact approved bytes or blob.');
    }
    files.push({ path: file.path, digest: file.digest, readbackDigest: readback.digest, blobSha: readback.blobSha });
    if (file.path.startsWith('.github/workflows/')) {
      const workflow = await client.optional(`/repos/${plan.repository}/actions/workflows/${file.path.split('/').at(-1)}`);
      if (!workflow) registrationPending = true;
      else {
        if (workflow.path !== file.path || workflow.state !== 'active') {
          throw new GitHubActivationError('publication-workflow-registration', 'The actual workflow registration is disabled or belongs to another source path.');
        }
        workflows.push({ path: file.path, workflowId: positiveId(workflow.id), digest: file.digest,
          blobSha: file.blobSha, sourceSha: mergedSha });
      }
    }
  }
  return {
    status: registrationPending ? 'pending' : 'completed', ...(registrationPending ? { pendingReason: 'workflow-registration' as const } : {}),
    repository: plan.repository, ref: plan.targetBranch, commitSha: mergedSha,
    repositoryId: plan.repositoryId, actorId: plan.actorId, actorLogin: plan.actorLogin,
    featureBranch: plan.featureBranch, pullRequestNumber: Number(operation.operationId), files,
    publishedAt: operation.observedAt, operation: { ...operation, status: registrationPending ? 'running' : 'completed' }, workflows
  };
}
