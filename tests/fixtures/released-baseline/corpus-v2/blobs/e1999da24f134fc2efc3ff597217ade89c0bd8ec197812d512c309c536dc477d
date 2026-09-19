import { createHash } from 'node:crypto';
import type { PlannedFileChange, SavedTransitionPlan } from '../domain/governance/activation/types.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import type { ActivationInputSnapshot } from '../domain/governance/activation/inputs.js';
import {
  captureProjectFileSnapshot, type ProjectFileMutation, type ProjectFileSnapshot
} from '../adapters/filesystem/project-transaction.js';
import { activationInputPathIsObserved, activationInputTextDigest } from './inputs.js';
import type { CommandRunner } from '../process-runner.js';
import type { InputTransitionBinding } from '../domain/governance/activation/types.js';

export function activationFileHash(content: string | Buffer | undefined): string | null {
  return content === undefined ? null : createHash('sha256').update(content).digest('hex');
}

export async function plannedFileChanges(
  projectRoot: string,
  mutations: readonly ProjectFileMutation[],
  preconditions: readonly ProjectFileSnapshot[] = []
): Promise<PlannedFileChange[]> {
  const paths = mutations.map((mutation) => mutation.pathParts.join('/'));
  if (new Set(paths).size !== paths.length) throw new Error('A transition cannot plan conflicting writes to the same file.');
  return Promise.all(mutations.map(async (mutation): Promise<PlannedFileChange> => {
    const before = preconditions.find((entry) => entry.pathParts.join('/') === mutation.pathParts.join('/')) ??
      await captureProjectFileSnapshot(projectRoot, mutation.pathParts);
    return {
      pathParts: mutation.pathParts,
      beforeHash: activationFileHash(before.content),
      afterHash: mutation.type === 'delete' ? null : activationFileHash(mutation.content)
    };
  }));
}

export function assertOutcomeFileChanges(
  plan: SavedTransitionPlan,
  mutations: readonly ProjectFileMutation[],
  preconditions: readonly ProjectFileSnapshot[]
): void {
  if (!plan.fileChanges || plan.fileChanges.length === 0) return;
  for (const mutation of mutations) {
    const change = plan.fileChanges.find((entry) => entry.pathParts.join('/') === mutation.pathParts.join('/'));
    const before = preconditions.find((entry) => entry.pathParts.join('/') === mutation.pathParts.join('/'));
    const afterHash = mutation.type === 'delete' ? null : activationFileHash(mutation.content);
    if (!change || !before || change.beforeHash !== activationFileHash(before.content) || change.afterHash !== afterHash) {
      throw new Error(`Outcome file ${mutation.pathParts.join('/')} differs from its exact reviewed before/after binding.`);
    }
  }
}

export function snapshotWithPlannedWrites(
  snapshot: ActivationInputSnapshot,
  mutations: readonly ProjectFileMutation[]
): ActivationInputSnapshot {
  const files = new Map(snapshot.files.map((file) => [file.path, file.digest]));
  for (const mutation of mutations) {
    if (!activationInputPathIsObserved(mutation.pathParts)) continue;
    const key = mutation.pathParts.join('/');
    if (mutation.type === 'delete') files.delete(key);
    else files.set(key, activationInputTextDigest(mutation.content.toString()));
  }
  return {
    ...snapshot,
    files: [...files].sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([path, digest]) => ({ path, digest }))
  };
}

export function assertInputFileChanges(
  before: ActivationInputSnapshot,
  after: ActivationInputSnapshot,
  plan: SavedTransitionPlan
): void {
  if (canonicalSha256(before.project) !== canonicalSha256(after.project)) {
    throw new Error('Project configuration changed during the reviewed transition.');
  }

  const oldFiles = new Map(before.files.map((entry) => [entry.path, entry.digest]));
  const newFiles = new Map(after.files.map((entry) => [entry.path, entry.digest]));
  const allowed = new Set(plan.fileChanges?.map((entry) => entry.pathParts.join('/')) ?? []);
  for (const name of new Set([...oldFiles.keys(), ...newFiles.keys()])) {
    if (oldFiles.get(name) !== newFiles.get(name) && !allowed.has(name)) {
      throw new Error(`Relevant source ${name} changed outside the reviewed transition; preserve the partial outcome and inspect recovery.`);
    }
  }
}

export async function assertPlannedFilesAfter(
  projectRoot: string,
  plan: SavedTransitionPlan,
  deferredMutations: readonly ProjectFileMutation[]
): Promise<void> {
  for (const change of plan.fileChanges ?? []) {
    const deferred = deferredMutations.find((mutation) => mutation.pathParts.join('/') === change.pathParts.join('/'));
    const hash = deferred
      ? deferred.type === 'delete' ? null : activationFileHash(deferred.content)
      : activationFileHash((await captureProjectFileSnapshot(projectRoot, [...change.pathParts])).content);
    if (hash !== change.afterHash) {
      throw new Error(`The observed output ${change.pathParts.join('/')} does not match the reviewed after-hash.`);
    }
  }
}

export async function verifiedGitInputBinding(
  before: ActivationInputSnapshot['git'],
  after: ActivationInputSnapshot['git'],
  plan: Pick<SavedTransitionPlan, 'operations'>,
  projectRoot: string,
  runner: CommandRunner
): Promise<InputTransitionBinding['git']> {
  if (canonicalSha256(before) === canonicalSha256(after)) return undefined;
  const effects = plan.operations.flatMap((operation) => [operation, ...(operation.effects ?? [])]);
  const commitAllowed = effects.some((effect) => effect.mutationClass === 'git-commit' && !effect.remote);
  if (before.head !== after.head) {
    if (!commitAllowed || !after.head) throw new Error('Git HEAD changed outside an approved history-preserving commit operation.');
    if (before.head) {
      const ancestry = await runner.run({
        executable: 'git', args: ['merge-base', '--is-ancestor', before.head, after.head]
      }, { cwd: projectRoot });
      if (ancestry.status !== 0 || ancestry.timedOut || ancestry.errorCode) {
        throw new Error('The resulting commit does not preserve the reviewed Git ancestry; no success was recorded.');
      }
    }
  }
  if (before.branch !== after.branch && !(before.branch === null && commitAllowed &&
    plan.operations.some((operation) => operation.actionId === 'git.init' &&
      (operation.inputs.branch === after.branch || operation.inputs.initialBranch === after.branch)))) {
    throw new Error('The selected Git branch changed outside the reviewed initialization boundary.');
  }
  if (canonicalSha256(before.pushUrls) !== canonicalSha256(after.pushUrls)) {
    const bind = plan.operations.filter((operation) => operation.mutationClass === 'git-remote-bind');
    const destinations = bind.flatMap((operation) => [
      operation.inputs.url, operation.inputs.pushUrl, operation.destination.identity
    ]).filter((value): value is string => typeof value === 'string' &&
      /^(?:https:\/\/github\.com\/|git@github\.com:)/u.test(value));
    if (before.pushUrls.length !== 0 || after.pushUrls.length !== 1 || !destinations.includes(after.pushUrls[0]!)) {
      throw new Error('Git remote changes must bind one previously absent origin to the exact approved destination; existing remotes are never replaced.');
    }
  }
  return { before, after };
}
