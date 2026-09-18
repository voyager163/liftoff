import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { githubRef, githubRepository, positiveId, GitHubActivationError, type GitHubActivationClient } from '../../adapters/github/activation-rest.js';
import { readbackWorkflowContent } from '../../adapters/github/workflow-source-readback.js';
import { sourceSha } from '../../governance-activation/github-config.js';
import { exactObject, privateDigest } from './private-resource-plans.js';
import {
  environmentRuntimeRecipe, renderEnvironmentRuntimeWorkflow, environmentRuntimeJob, type EnvironmentRuntimeRecipe
} from './environment-runtime-workflow.js';
import {
  stagingSecurityWorkflowRecipe, renderStagingSecurityWorkflow, stagingSecurityWorkflowJob,
  type StagingSecurityWorkflowRecipe
} from './staging-security-workflow.js';

interface ApplicationSourceBinding {
  schemaVersion: 1;
  repository: string;
  repositoryId: number;
  workflowId: number;
  workflowDigest: string;
  sourceSha: string;
  ref: string;
  actorId: number;
}

export type PrivateRunnerApplicationSource = ApplicationSourceBinding & (
  | { kind: 'environment-runtime'; recipe: EnvironmentRuntimeRecipe }
  | { kind: 'staging-security'; recipe: StagingSecurityWorkflowRecipe }
);

export interface PrivateRunnerApplicationSourceObservation {
  kind: PrivateRunnerApplicationSource['kind'];
  repository: string;
  repositoryId: number;
  workflowId: number;
  workflowPath: string;
  workflowDigest: string;
  sourceSha: string;
  ref: string;
  refSha: string;
  blobSha: string;
}

function require(value: unknown, message: string): asserts value {
  if (!value) throw new GitHubActivationError('private-runner-application-source', message);
}

export function privateApplicationWorkflowContent(source: PrivateRunnerApplicationSource): string {
  return source.kind === 'environment-runtime'
    ? renderEnvironmentRuntimeWorkflow(source.recipe)
    : renderStagingSecurityWorkflow(source.recipe);
}

export function privateApplicationWorkflowJob(source: PrivateRunnerApplicationSource): string {
  return source.kind === 'environment-runtime' ? environmentRuntimeJob : stagingSecurityWorkflowJob;
}

export function validatePrivateRunnerApplicationSource(value: unknown): PrivateRunnerApplicationSource {
  const data = exactObject(value, [
    'schemaVersion', 'kind', 'repository', 'repositoryId', 'workflowId', 'workflowDigest', 'sourceSha', 'ref', 'actorId', 'recipe'
  ], 'Published private application workflow');
  require(data.schemaVersion === 1 && (data.kind === 'environment-runtime' || data.kind === 'staging-security'),
    'Only the actual registered environment-runtime and staging-security recipes can extend this runner assignment.');
  const ref = githubRef(data.ref);
  require(!ref.startsWith('refs/'), 'Application workflow bindings require the exact short branch ref, not a wildcard or inferred default.');
  const binding: ApplicationSourceBinding = {
    schemaVersion: 1, repository: githubRepository(data.repository), repositoryId: positiveId(data.repositoryId),
    workflowId: positiveId(data.workflowId), workflowDigest: privateDigest(data.workflowDigest, 'Published application workflow digest'),
    sourceSha: sourceSha(data.sourceSha), ref, actorId: positiveId(data.actorId)
  };
  let source: PrivateRunnerApplicationSource;
  if (data.kind === 'environment-runtime') {
    source = { ...binding, kind: 'environment-runtime', recipe: environmentRuntimeRecipe(data.recipe) };
  } else {
    const recipe = stagingSecurityWorkflowRecipe(data.recipe);
    require(recipe.repository === binding.repository && recipe.repositoryId === binding.repositoryId &&
      recipe.actorId === binding.actorId && recipe.ref === binding.ref &&
      (recipe.workflowId === null || recipe.workflowId === binding.workflowId),
    'The staging source template and its actual published repository, workflow, actor and ref bindings disagree.');
    source = { ...binding, kind: 'staging-security', recipe };
  }
  exactObject(source.recipe.runner, ['group', 'label'], 'Stable published runner routing');
  require(binding.workflowDigest === canonicalSha256(privateApplicationWorkflowContent(source)),
    'The published application workflow digest must commit to its exact registered recipe bytes.');
  return structuredClone(source);
}

export function privateApplicationWorkflowSelector(source: PrivateRunnerApplicationSource): string {
  return `${source.repository}/${source.recipe.workflowPath}@refs/heads/${source.ref}`;
}

export function assertPrivateApplicationWorkflowRouting(
  source: PrivateRunnerApplicationSource,
  expected: { repository: string; repositoryId: number; groupName: string; runnerName: string }
): void {
  require(source.repository === expected.repository && source.repositoryId === expected.repositoryId &&
    source.recipe.runner.group === expected.groupName && source.recipe.runner.label === expected.runnerName,
  'The exact published application workflow must select this repository-dedicated runner group and label, not another group or a broad fleet.');
}

export async function readPrivateRunnerApplicationSource(
  client: GitHubActivationClient, value: PrivateRunnerApplicationSource,
  options: { refSha?: string } = {}
): Promise<PrivateRunnerApplicationSourceObservation> {
  const source = validatePrivateRunnerApplicationSource(value);
  const refSha = sourceSha(options.refSha ?? source.sourceSha);
  const workflow = await client.get(`/repos/${source.repository}/actions/workflows/${source.workflowId}`);
  const ref = await client.get(`/repos/${source.repository}/git/ref/heads/${source.ref}`);
  const content = await readbackWorkflowContent(client, source.repository, source.recipe.workflowPath, source.sourceSha);
  const selected = refSha === source.sourceSha ? content
    : await readbackWorkflowContent(client, source.repository, source.recipe.workflowPath, refSha);
  require(workflow.id === source.workflowId && workflow.path === source.recipe.workflowPath && workflow.state === 'active' &&
    ref.ref === `refs/heads/${source.ref}` && typeof ref.object === 'object' && ref.object !== null &&
    'sha' in ref.object && ref.object.sha === refSha && 'type' in ref.object && ref.object.type === 'commit' &&
    content.digest === source.workflowDigest && content.content === privateApplicationWorkflowContent(source) &&
    selected.digest === content.digest && selected.content === content.content && selected.blobSha === content.blobSha,
  'Actual workflow registration, branch ref or source bytes changed; no runner allowlist write or application routing proof is permitted.');
  return {
    kind: source.kind, repository: source.repository, repositoryId: source.repositoryId,
    workflowId: source.workflowId, workflowPath: source.recipe.workflowPath, workflowDigest: content.digest,
    sourceSha: source.sourceSha, ref: source.ref, refSha, blobSha: content.blobSha
  };
}
