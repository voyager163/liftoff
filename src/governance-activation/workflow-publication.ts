import { devNull } from 'node:os';
import { parse } from 'yaml';
import { isRecord, canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { captureProjectFileSnapshot, applyProjectFileTransaction } from '../adapters/filesystem/project-transaction.js';
import { githubRef, githubRepository } from '../adapters/github/activation-rest.js';
import { detectCredentialLeaks } from './credentials.js';
import { ownedPath, sourceSha } from './github-config.js';
import type { PhasePlanningInput, PhasePlanBuild } from './transition-ports.js';
import { repositoryConfiguration } from './github-config.js';
import {
  assertWorkflowAuthority, captureWorkflowBinding, readWorkflowBytes, workflowByteDigest, workflowDigest,
  workflowFailure, workflowOperation, workflowPlannedOperation, workflowRuntime, recordWorkflowCheckpoint,
  workflowProjectRoot, type WorkflowEffectInput
} from './workflow-runtime.js';
import { assertSource5WorkflowIntent, isSource5WorkflowEffectInput, recordSource5WorkflowStage } from './workflow-source5-ports.js';

export interface ReviewedWorkflowFile {
  path: string;
  beforeDigest: string | null;
  digest: string;
  content: string;
}

export interface WorkflowPublicationBinding {
  repository: string;
  repositoryId: number;
  ref: string;
  parentSha: string;
  files: readonly ReviewedWorkflowFile[];
  sourceTransmissionApproved: true;
}

export type WorkflowPublicationCheckpoint =
  | { bindingDigest: string; planDigest: string; stage: 'writing' }
  | { bindingDigest: string; planDigest: string; stage: 'committed' | 'push-intent' | 'published'; commitSha: string };

export type WorkflowPublicationInput = WorkflowEffectInput & {
  publicationCheckpoint?: WorkflowPublicationCheckpoint;
  recordWorkflowPublication?: (checkpoint: WorkflowPublicationCheckpoint) => Promise<void>;
};

export interface PublishedWorkflowSource {
  kind: 'workflow-source-publication.v1';
  bindingDigest: string;
  repository: string;
  repositoryId: number;
  ref: string;
  parentSha: string;
  commitSha: string;
  treeSha: string;
  files: readonly { path: string; digest: string }[];
  observedAt: string;
  observationDigest: string;
}

export function validateWorkflowPublication(value: WorkflowPublicationBinding): WorkflowPublicationBinding {
  value = captureWorkflowBinding(value);
  githubRepository(value.repository);
  githubRef(value.ref);
  sourceSha(value.parentSha);
  if (!Number.isSafeInteger(value.repositoryId) || value.repositoryId <= 0 ||
    value.sourceTransmissionApproved !== true || !/^ci\/liftoff-workflows-[a-z0-9-]+$/u.test(value.ref) ||
    !value.files.length || value.files.length > 32 ||
    new Set(value.files.map((file) => file.path)).size !== value.files.length) {
    return workflowFailure('workflow-publication-scope', 'Publication requires one exact non-protected source-review branch, repository ID, explicit transmission consent and a bounded unique per-file inventory. Protected refs are never directly pushed.');
  }
  for (const file of value.files) {
    if (file.path.startsWith('.github/')) ownedPath(file.path, 'Reviewed workflow source file');
    if (!/^(?:\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml|governance\/rulesets\/[A-Za-z0-9_-]+\.json)$/u.test(file.path) ||
      typeof file.content !== 'string' || Buffer.byteLength(file.content) > 128 * 1024 ||
      workflowByteDigest(file.content) !== workflowDigest(file.digest) ||
      file.beforeDigest === file.digest ||
      file.beforeDigest !== null && workflowDigest(file.beforeDigest) !== file.beforeDigest ||
      detectCredentialLeaks([{ source: 'generated-artifact', label: file.path, text: file.content }]).status === 'compromised') {
      return workflowFailure('workflow-publication-files', 'Every source file must have exact reviewed safe bytes and before/after digests; broad directories and credential-shaped content are prohibited.');
    }
    let parsed: unknown;
    try { parsed = file.path.endsWith('.json') ? JSON.parse(file.content) : parse(file.content); }
    catch { return workflowFailure('workflow-publication-files', 'Reviewed workflow/ruleset source must be valid bounded YAML or JSON.'); }
    if (!isRecord(parsed) || file.path.endsWith('.json') && parsed.target !== 'branch' && parsed.target !== 'tag' ||
      !file.path.endsWith('.json') && !isRecord(parsed.jobs)) {
      return workflowFailure('workflow-publication-files', 'Publication requires actual workflow jobs or repository ruleset payloads, not annotations.');
    }
  }
  return value;
}

export async function planWorkflowSourcePublication(
  input: PhasePlanningInput, request: WorkflowPublicationBinding
): Promise<PhasePlanBuild> {
  const binding = validateWorkflowPublication(request);
  const projectRoot = input.inspection.projectRoot;
  if (binding.repository !== repositoryConfiguration(input.inspection).name) {
    return workflowFailure('workflow-publication-repository', 'Publication planning cannot replace the verified repository binding.');
  }
  const snapshots = await Promise.all(binding.files.map((file) =>
    captureProjectFileSnapshot(projectRoot, file.path.split('/'))));
  if (snapshots.some((snapshot, index) =>
    (snapshot.content === undefined ? null : workflowByteDigest(snapshot.content)) !== binding.files[index]!.beforeDigest)) {
    return workflowFailure('workflow-publication-before', 'Publication planning requires exact independently read per-file before bytes.');
  }
  return {
    operations: [workflowPlannedOperation(input.phase.id, 'git.workflow-source.publish-reviewed', binding)],
    fileMutations: binding.files.map((file) => ({ type: 'write', pathParts: file.path.split('/'), content: file.content })),
    filePreconditions: snapshots
  };
}

async function observePublished(
  input: WorkflowPublicationInput, binding: WorkflowPublicationBinding, commitSha: string,
  runtime: ReturnType<typeof workflowRuntime>
): Promise<PublishedWorkflowSource> {
  const repository = await runtime.client.get(`/repos/${binding.repository}`);
  const ref = await runtime.client.get(`/repos/${binding.repository}/git/ref/heads/${binding.ref}`);
  const commit = await runtime.client.get(`/repos/${binding.repository}/git/commits/${commitSha}`);
  const treeSha = sourceSha((await runtime.git(['rev-parse', '--verify', `${commitSha}^{tree}`])).trim());
  if (repository.id !== binding.repositoryId || repository.full_name !== binding.repository ||
    ref.ref !== `refs/heads/${binding.ref}` || !isRecord(ref.object) || ref.object.sha !== commitSha ||
    commit.sha !== commitSha || !isRecord(commit.tree) || commit.tree.sha !== treeSha ||
    !Array.isArray(commit.parents) || commit.parents.length !== 1 ||
    !isRecord(commit.parents[0]) || commit.parents[0].sha !== binding.parentSha) {
    return workflowFailure('workflow-publication-readback', 'Independent publication readback does not preserve the exact repository, reviewed ref and single source parent.');
  }
  for (const file of binding.files) {
    await readWorkflowBytes(runtime.client, binding.repository, commitSha, file.path, file.digest);
  }
  const files = binding.files.map(({ path, digest }) => ({ path, digest }));
  const observed = { repository: binding.repository, repositoryId: binding.repositoryId,
    ref: binding.ref, parentSha: binding.parentSha, commitSha, treeSha, files };
  return { kind: 'workflow-source-publication.v1', bindingDigest: canonicalSha256(binding), ...observed,
    observedAt: (input.clock?.() ?? input.now).toISOString(), observationDigest: canonicalSha256(observed) };
}

export async function executeWorkflowSourcePublication(
  input: WorkflowPublicationInput, request: WorkflowPublicationBinding
): Promise<PublishedWorkflowSource> {
  const binding = validateWorkflowPublication(request);
  const projectRoot = workflowProjectRoot(input);
  const bindingDigest = canonicalSha256(binding);
  const planDigest = input.plan.planDigest;
  const operation = workflowOperation(input, 'git.workflow-source.publish-reviewed', binding);
  await assertWorkflowAuthority(input, operation);
  const recordPublication = input.recordWorkflowPublication;
  if (!recordPublication || !input.phase.allowedMutations.local.includes('git-commit') ||
    !input.phase.allowedMutations.remote.includes('git-push') ||
    !input.phase.allowedMutations.remote.includes('github-read')) {
    return workflowFailure('workflow-publication-unavailable', 'Source publication requires explicit successor commit/push/readback authority and durable engine checkpoints. The legacy ungated local source phase cannot publish.');
  }
  const checkpoint = input.publicationCheckpoint && captureWorkflowBinding(input.publicationCheckpoint);
  if (checkpoint && (checkpoint.bindingDigest !== bindingDigest || checkpoint.planDigest !== planDigest ||
    !['writing', 'committed', 'push-intent', 'published'].includes(checkpoint.stage))) {
    return workflowFailure('workflow-publication-checkpoint', 'Publication recovery cannot retag a checkpoint for different source or authority.');
  }
  const runtime = workflowRuntime(input);
  const repository = await runtime.client.get(`/repos/${binding.repository}`);
  if (repository.id !== binding.repositoryId || repository.full_name !== binding.repository) {
    return workflowFailure('workflow-publication-repository', 'The actual repository ID/name differs from the separately approved publication destination.');
  }
  const gitKeys = (await runtime.git(['config', '--list', '--name-only'])).split('\n');
  if (gitKeys.some((key) => /^filter\..*\.(?:clean|smudge|process)$/iu.test(key))) {
    return workflowFailure('workflow-publication-filters', 'Repository or inherited Git filters could execute unreviewed code or transform approved source. Publication refuses them instead of executing or changing the configuration.');
  }
  const urls = (await runtime.git(['remote', 'get-url', '--all', 'origin'])).trim().split('\n');
  const pushUrls = (await runtime.git(['remote', 'get-url', '--push', '--all', 'origin'])).trim().split('\n');
  const approvedUrls = [`https://github.com/${binding.repository}.git`, `git@github.com:${binding.repository}.git`];
  if (urls.length !== 1 || pushUrls.length !== 1 || !approvedUrls.includes(urls[0]!) || urls[0] !== pushUrls[0]) {
    return workflowFailure('workflow-publication-remote', 'Source publication requires one exact matching fetch/push origin; credential-bearing or alternate remotes are not used.');
  }
  if ((await runtime.git(['symbolic-ref', '--short', 'HEAD'])).trim() !== binding.ref) {
    return workflowFailure('workflow-publication-ref', 'The selected local source-review branch differs. Publication never checks out or creates a branch implicitly.');
  }
  let commitSha = checkpoint && 'commitSha' in checkpoint ? sourceSha(checkpoint.commitSha) : undefined;
  const head = (await runtime.git(['rev-parse', '--verify', 'HEAD'])).trim();
  if (commitSha) {
    if (head !== commitSha) return workflowFailure('workflow-publication-head', 'The recorded source commit is not the unchanged local HEAD.');
  } else {
    if (head !== binding.parentSha || checkpoint) {
      return workflowFailure('workflow-publication-uncertain', 'Source writing or commit acceptance is uncertain; reconcile the recorded intent explicitly instead of repeating or adopting an unrecorded commit.');
    }
    if (await runtime.git(['status', '--porcelain=v1', '--untracked-files=all']) ||
      await runtime.git(['diff', '--cached', '--name-only'])) {
      return workflowFailure('workflow-publication-dirty', 'Publication does not consume unrelated staged, tracked or untracked developer changes.');
    }
    const snapshots = await Promise.all(binding.files.map((file) =>
      captureProjectFileSnapshot(projectRoot, file.path.split('/'))));
    if (snapshots.some((snapshot, index) =>
      (snapshot.content === undefined ? null : workflowByteDigest(snapshot.content)) !== binding.files[index]!.beforeDigest)) {
      return workflowFailure('workflow-publication-before', 'A source file changed after review; no write was performed.');
    }
    await assertWorkflowAuthority(input, operation);
    await recordWorkflowCheckpoint(recordPublication, { bindingDigest, planDigest, stage: 'writing' });
    if (isSource5WorkflowEffectInput(input)) await assertSource5WorkflowIntent(input, 'source-write');
    await applyProjectFileTransaction(projectRoot, binding.files.map((file) =>
      ({ type: 'write' as const, pathParts: file.path.split('/'), content: file.content })), { preconditions: snapshots,
      ...(isSource5WorkflowEffectInput(input) ? { onBeforeMutation: async () => {
        await assertWorkflowAuthority(input, operation);
      } } : {}) });
    await assertWorkflowAuthority(input, operation);
    await runtime.git(['--literal-pathspecs', 'add', '--', ...binding.files.map((file) => file.path)]);
    if (isSource5WorkflowEffectInput(input)) {
      await recordSource5WorkflowStage(input, 'publication-commit-intent', { bindingDigest, planDigest });
    }
    await runtime.git(['-c', `core.hooksPath=${devNull}`, '--literal-pathspecs', 'commit', '--only', '--no-gpg-sign',
      '-m', 'Publish reviewed governance workflow source',
      '-m', 'Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>',
      '--', ...binding.files.map((file) => file.path)]);
    commitSha = sourceSha((await runtime.git(['rev-parse', '--verify', 'HEAD'])).trim());
    if (isSource5WorkflowEffectInput(input)) {
      await recordSource5WorkflowStage(input, 'publication-commit-observed', { bindingDigest, planDigest, commitSha });
    } else {
      const parents = (await runtime.git(['rev-list', '--parents', '-n', '1', commitSha])).trim();
      if (parents !== `${commitSha} ${binding.parentSha}`) {
        return workflowFailure('workflow-publication-parent', 'The actual source commit failed its immutable parent check; partial effects remain recorded.');
      }
      await recordWorkflowCheckpoint(recordPublication, { bindingDigest, planDigest, stage: 'committed', commitSha });
    }
  }
  if (isSource5WorkflowEffectInput(input)) {
    const parents = (await runtime.git(['rev-list', '--parents', '-n', '1', commitSha])).trim();
    if (parents !== `${commitSha} ${binding.parentSha}`) {
      return workflowFailure('workflow-publication-parent', 'The actual source commit failed its immutable parent check; original acceptance remains retained.');
    }
    if (!input.publicationCheckpoint || input.publicationCheckpoint.stage === 'writing' ||
      input.publicationCheckpoint.stage === 'committed') {
      await recordWorkflowCheckpoint(recordPublication, { bindingDigest, planDigest, stage: 'committed', commitSha });
    }
  }
  const changed = (await runtime.git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commitSha]))
    .split('\0').filter(Boolean).sort();
  if (canonicalSha256(changed) !== canonicalSha256(binding.files.map((file) => file.path).sort())) {
    return workflowFailure('workflow-publication-inventory', 'The actual source commit changed files outside, or omitted files from, its exact reviewed inventory.');
  }
  for (const file of binding.files) {
    if (workflowByteDigest(await runtime.git(['show', `${commitSha}:${file.path}`])) !== file.digest) {
      return workflowFailure('workflow-publication-bytes', 'The actual committed bytes differ from the approved per-file recipe.');
    }
  }
  const remote = await runtime.client.get(`/repos/${binding.repository}/git/ref/heads/${binding.ref}`);
  if (!isRecord(remote.object) || remote.ref !== `refs/heads/${binding.ref}`) {
    return workflowFailure('workflow-publication-remote', 'The explicitly approved existing review ref cannot be independently observed.');
  }
  if (remote.object.sha !== commitSha) {
    if (checkpoint?.stage === 'push-intent' || checkpoint?.stage === 'published') {
      return workflowFailure('workflow-publication-uncertain', 'An earlier push intent is not visible at the exact reviewed ref; automatic repeat push is prohibited.');
    }
    if (remote.object.sha !== binding.parentSha) {
      return workflowFailure('workflow-publication-remote', 'The source-review remote ref moved; no push, force or reset is permitted.');
    }
    await assertWorkflowAuthority(input, operation);
    await recordWorkflowCheckpoint(recordPublication, { bindingDigest, planDigest, stage: 'push-intent', commitSha });
    await runtime.git(['push', '--porcelain', 'origin', `${commitSha}:refs/heads/${binding.ref}`]);
  }
  const proof = await observePublished(input, binding, commitSha, runtime);
  await recordWorkflowCheckpoint(recordPublication, { bindingDigest, planDigest, stage: 'published', commitSha });
  return proof;
}
