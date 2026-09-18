import path from 'node:path';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { githubRepositoryFromPushUrl } from '../../domain/governance/activation/inputs.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import { readProjectFile } from '../../adapters/filesystem/project-files.js';
import type { UpdatePreviewOptions } from '../../adapters/filesystem/update-previews.js';
import { validateArtifactPathParts } from '../../domain/project/paths.js';
import type { CommandRunner } from '../../process-runner.js';
import type {
  GovernanceTransitionInspection, PhaseAdapterExecutionInput, PhaseAdapterOutcome
} from '../../governance-activation/transition-ports.js';
import { inspectActivationMigrationHistory } from '../../governance-activation/migration-history.js';
import { readHistoricalSnapshotInventory } from '../../governance-activation/historical-state.js';
import { validateHistoricalV3EvidenceRecord } from '../../governance-activation/historical-v3.js';
import { validateHistoricalV4Policy7EvidenceRecord } from '../../governance-activation/historical-v4-policy7.js';
import { isHistoricalV4Policy7ActivationIdentity } from '../../domain/governance/policy/identity.js';
import { parseHistoryJson, rawHistoryDigest } from '../../governance-activation/history-contracts.js';
import { readActivationEvidence, readReviewedTransitionPlans } from '../../governance-activation/proof-records.js';
import { evidencePathParts, readbackProof, transitionPlanPathParts, cloneState } from '../../governance-activation/transition-records.js';
import { clientFor } from '../../governance-activation/github-config.js';
import { object, positiveId } from '../../adapters/github/activation-rest.js';

interface PublicationBinding {
  schemaVersion: 1;
  sourceSnapshotId: string;
  sourceEvidenceId: string;
  sourceHeaderDigest: string;
  recordedHead: string;
  branch: string;
  repository: string;
  repositoryId: string | null;
  pushUrl: string;
  inputAlgorithm: 'phase-consumed-v4';
  pendingLocalMetadata: readonly { path: string; digest: string | null }[];
  newLocalMetadataPublished: boolean;
}

async function gitRead(runner: CommandRunner, root: string, args: string[]): Promise<string> {
  const result = await runner.run({ executable: 'git', args }, { cwd: root, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
  if (result.status !== 0 || result.timedOut || result.errorCode || result.outputLimitExceeded) {
    throw new Error('Publication revalidation could not establish the exact bounded Git observation. No publication was attempted.');
  }
  return result.stdout;
}

async function pendingMetadata(
  inspection: GovernanceTransitionInspection, runner: CommandRunner, preservedPaths: readonly (readonly string[])[]
): Promise<PublicationBinding['pendingLocalMetadata']> {
  const records = await readActivationEvidence(inspection.projectRoot);
  const plans = await readReviewedTransitionPlans(inspection.projectRoot);
  const controlPaths = new Set([
    'governance/activation-state.json', 'governance/migration-state.json',
    ...preservedPaths.map((parts) => parts.join('/')),
    ...records.map((record) => evidencePathParts(record.evidenceId).join('/')),
    ...plans.map((plan) => transitionPlanPathParts(plan).join('/')),
    ...inspection.approvals.map((approval) => `governance/approvals/${approval.id}.json`)
  ]);
  if (inspection.manifest.artifactVersion === 8 && inspection.manifest.provenance.kind === 'generated' &&
    inspection.manifest.provenance.origin.kind === 'historical-manifest') {
    controlPaths.add(inspection.manifest.provenance.origin.historyPathParts.join('/'));
  }
  const managed = new Map(inspection.manifest.managedArtifacts.map((artifact) => [artifact.pathParts.join('/'), artifact.contentHash]));
  const inputReference = inspection.configurationBinding?.reference;
  const inputPath = inputReference ? path.relative(inspection.projectRoot, inputReference).split(path.sep).join('/') : null;
  const changed = (await gitRead(runner, inspection.projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0').filter(Boolean);
  const pending: Array<{ path: string; digest: string | null }> = [];
  for (const entry of changed) {
    if (entry.length < 4 || /[RCU]/u.test(entry.slice(0, 2))) {
      throw new Error('Renamed, conflicted or ambiguous publication paths require a separate reviewed publication operation.');
    }
    const name = entry.slice(3);
    const parts = validateArtifactPathParts(name.split('/'), 'Publication revalidation path');
    if (controlPaths.has(name)) continue;
    const registeredHash = managed.get(name);
    if (!registeredHash && name !== 'liftoff.manifest.json' && name !== inputPath) {
      throw new Error(`Publication source ${name} has changed or is newly unpublished. Review its separate publication; compatibility readback cannot certify it.`);
    }
    const bytes = await readProjectFile(inspection.projectRoot, parts);
    const digest = bytes === undefined ? null : rawHistoryDigest(bytes);
    if (registeredHash && `sha256:${digest}` !== registeredHash) {
      throw new Error(`Managed metadata ${name} differs from the reviewed successor. Fresh review is required before publication revalidation.`);
    }
    pending.push({ path: name, digest });
  }
  return pending.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

export async function planHistoricalPublicationReadback(
  inspection: GovernanceTransitionInspection, phaseId: 'committed' | 'pushed', runner: CommandRunner,
  storage?: UpdatePreviewOptions
): Promise<TransitionOperation[] | null> {
  if (!inspection.state.successorHistory) return null;
  const history = await inspectActivationMigrationHistory(inspection.projectRoot, storage);
  if (history.status !== 'committed' || history.index.sourceIdentity.activationContractVersion !== 3 &&
      !isHistoricalV4Policy7ActivationIdentity(history.index.sourceIdentity)) return null;
  const source = await readHistoricalSnapshotInventory(inspection.projectRoot, history.index);
  if ((source.state.schemaVersion !== 3 && source.state.schemaVersion !== 4) || source.state.phases.committed.state !== 'verified' ||
    source.state.phases.pushed.state !== 'verified') return null;
  const candidates = source.files.filter((file) => file.kind === 'evidence').map((file) =>
    (source.state.schemaVersion === 4 ? validateHistoricalV4Policy7EvidenceRecord : validateHistoricalV3EvidenceRecord)(
      parseHistoryJson(file.content, file.pathParts.join('/'))));
  const original = candidates.filter((record) => record.header.phaseId === phaseId && record.header.result === 'verified' &&
    source.state.phases[phaseId].evidence.some((reference) => reference.evidenceId === record.evidenceId &&
      reference.headerDigest === canonicalSha256(record.header)))
    .sort((left, right) => Date.parse(right.header.producedAt) - Date.parse(left.header.producedAt));
  const selected = original[0];
  if (!selected || !isRecord(selected.payload) || typeof selected.payload.head !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(selected.payload.head)) {
    throw new Error('The retained publication has no independently interpretable recorded Git commit.');
  }
  if (original.some((record) => record.header.producedAt === selected.header.producedAt &&
    canonicalSha256(record.payload) !== canonicalSha256(selected.payload))) {
    throw new Error('The retained publication has contradictory equally authoritative receipts.');
  }
  const published = candidates.find((record) => record.header.phaseId === 'pushed' && record.header.result === 'verified' &&
    source.state.phases.pushed.evidence.some((reference) => reference.evidenceId === record.evidenceId));
  const pushUrl = source.state.remoteBinding?.pushUrl ??
    (isRecord(published?.payload) && typeof published.payload.pushUrl === 'string' ? published.payload.pushUrl : null);
  if (!pushUrl || !isRecord(published?.payload) || published.payload.head !== selected.payload.head) {
    throw new Error('Retained commit and push receipts do not identify one exact original publication.');
  }
  const repository = githubRepositoryFromPushUrl(pushUrl);
  if (inspection.activationInputs?.repository?.name &&
    inspection.activationInputs.repository.name.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('The selected repository differs from retained publication; compatibility revalidation cannot change its target.');
  }
  const head = (await gitRead(runner, inspection.projectRoot, ['rev-parse', '--verify', 'HEAD'])).trim();
  const branch = (await gitRead(runner, inspection.projectRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
  const urls = (await gitRead(runner, inspection.projectRoot, ['remote', 'get-url', '--push', '--all', 'origin'])).trim().split(/\r?\n/u);
  if (head !== selected.payload.head || branch !== (source.state.remoteBinding?.defaultBranch ?? source.state.repository.defaultBranch) ||
    urls.length !== 1 || urls[0] !== pushUrl) {
    throw new Error('The actual local commit, branch or push destination changed. No recommit, force push or old-receipt edit is permitted.');
  }
  const pendingLocalMetadata = await pendingMetadata(inspection, runner, history.preconditions.map((snapshot) => snapshot.pathParts));
  const binding: PublicationBinding = {
    schemaVersion: 1, sourceSnapshotId: history.index.snapshotId,
    sourceEvidenceId: selected.evidenceId, sourceHeaderDigest: canonicalSha256(selected.header),
    recordedHead: head, branch, repository, repositoryId: source.state.remoteBinding?.id ?? null, pushUrl,
    inputAlgorithm: 'phase-consumed-v4', pendingLocalMetadata, newLocalMetadataPublished: pendingLocalMetadata.length === 0
  };
  return [{
    phaseId, adapter: 'git', actionId: phaseId === 'committed' ? 'git.verify-existing-commit' : 'git.verify-existing-push',
    mutationClass: phaseId === 'committed' ? 'read-worktree' : 'github-read',
    destination: phaseId === 'committed'
      ? { type: 'local', identity: head, ref: `refs/heads/${branch}` }
      : { type: 'repository', identity: pushUrl, repository, ref: `refs/heads/${branch}` },
    remote: phaseId === 'pushed', destructive: false,
    inputs: { publicationRevalidation: binding }
  }];
}

export async function executeHistoricalPublicationReadback(
  input: PhaseAdapterExecutionInput
): Promise<PhaseAdapterOutcome | null> {
  if (input.phase.id !== 'committed' && input.phase.id !== 'pushed') return null;
  const reviewed = input.plan.operations.find((operation) => isRecord(operation.inputs.publicationRevalidation));
  if (!reviewed) return null;
  const current = await planHistoricalPublicationReadback(
    input.inspection, input.phase.id, input.runner, input.adapters.githubActivation?.storage
  );
  if (!current || current.length !== 1 || canonicalSha256(current[0]) !== canonicalSha256(reviewed)) {
    return { status: 'blocked', blocker: 'Publication revalidation inputs changed after the exact reviewed plan.', completedOperations: [] };
  }
  const binding = reviewed.inputs.publicationRevalidation as unknown as PublicationBinding;
  const state = cloneState(input.inspection.state);
  const payload = { kind: `${input.phase.id}.v1`, head: binding.recordedHead, pushUrl: binding.pushUrl, publicationRevalidation: binding };
  if (input.phase.id === 'committed') {
    return { status: 'completed', resultState: 'verified', evidencePayload: payload, completedOperations: [reviewed] };
  }
  const client = clientFor(input);
  const repository = await client.get(`/repos/${binding.repository}`);
  const ref = await client.get(`/repos/${binding.repository}/git/ref/heads/${encodeURIComponent(binding.branch)}`);
  const id = String(positiveId(repository.id));
  if (repository.full_name !== binding.repository || repository.default_branch !== binding.branch ||
    binding.repositoryId !== null && binding.repositoryId !== id || object(ref.object).sha !== binding.recordedHead ||
    ref.ref !== `refs/heads/${binding.branch}`) {
    return { status: 'blocked', blocker: 'Independent GitHub repository/ref readback differs from the retained publication. No push or receipt rewriting occurred.', completedOperations: [] };
  }
  state.remoteBinding = {
    id, name: binding.repository, defaultBranch: binding.branch, pushUrl: binding.pushUrl,
    verifiedAt: (input.clock?.() ?? input.now).toISOString()
  };
  return {
    status: 'completed', resultState: 'verified', stateOverride: state, evidencePayload: payload,
    completedOperations: [reviewed],
    liveReadback: [readbackProof(input, 'github', 'git-ref', `/repos/${binding.repository}/git/ref/heads/${binding.branch}`, {
      repositoryId: id, repository: binding.repository, head: binding.recordedHead, ref: `refs/heads/${binding.branch}`
    })]
  };
}
