import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { isUtf8 } from 'node:buffer';
import type {
  PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput
} from '../../governance-activation/transition-ports.js';
import { clientFor, githubOperation, phaseConfiguration, repositoryConfiguration, sourceSha } from '../../governance-activation/github-config.js';
import { readbackProof } from '../../governance-activation/transition-records.js';
import {
  planWorkflowSourcePublication, publishWorkflowSourceViaGitFlow, readbackWorkflowContent, readWorkflowPublicationOperation,
  materializeWorkflowPublicationReview, reviewGeneratedWorkflowPublication,
  type PublishedWorkflowSourceFile, type WorkflowFileDefinition, type WorkflowPublicationPlan, type WorkflowPublicationResult
} from '../../adapters/github/production-workflows.js';
import { readProjectFile } from '../../adapters/filesystem/project-files.js';
import { GitHubActivationError, githubName, object, positiveId, safeGitHubFailure, text } from '../../adapters/github/activation-rest.js';
import type { PhaseId, TransitionOperation } from '../../domain/governance/activation/types.js';
import { assertGitHubPhaseAuthority } from './workflow-authority.js';
import {
  applicationBuildWorkflowRecipe, applicationBuildWorkflowSource, type ApplicationBuildWorkflowRecipe
} from '../azure-activation/application-build-workflow.js';
import {
  environmentRuntimeRecipe, renderEnvironmentRuntimeWorkflow, type EnvironmentRuntimeRecipe
} from '../azure-activation/environment-runtime-workflow.js';
import {
  stagingSecurityWorkflowRecipe, stagingSecurityWorkflowRecipeId, stagingSecurityWorkflowSource, type StagingSecurityWorkflowRecipe
} from '../azure-activation/staging-security-workflow.js';

export const workflowSourcePublicationAction = 'github.workflow-source.publish' as const;

export interface GeneratedWorkflowSource {
  recipe: ApplicationBuildWorkflowRecipe['recipe'] | StagingSecurityWorkflowRecipe['recipe'] | 'environmentRuntime';
  recipeDigest: string;
  remoteOnlyPaths: readonly string[];
}

interface GeneratedWorkflowSourceSelection {
  generatedSource?: GeneratedWorkflowSource;
  generatedSources?: readonly GeneratedWorkflowSource[];
}

interface RegisteredGeneratedWorkflow {
  recipe: GeneratedWorkflowSource['recipe'];
  recipeDigest: string;
  files: readonly WorkflowFileDefinition[];
  actorId?: number;
  remoteOnlyPaths: string[];
}

export interface WorkflowSourceEvidencePayload {
  kind: 'repository-workflow-source-ready.v1' | 'bootstrap-workflow-source-ready.v1' | 'workflow-source-ready.v1';
  repository: string;
  repositoryId: number;
  actorId: number;
  actorLogin: string;
  ref: string;
  sourceSha: string;
  files: readonly PublishedWorkflowSourceFile[];
  workflows: WorkflowPublicationResult['workflows'];
  /** Ordered published {path,digest} inventory, never a semantic ruleset-definition digest. */
  rulesetSourceDigest?: string;
  baseSha?: string;
  pullRequestNumber?: number;
  generatedSource?: GeneratedWorkflowSource;
  generatedSources?: readonly GeneratedWorkflowSource[];
}

function sourceEvidenceKind(phaseId: PhaseId): WorkflowSourceEvidencePayload['kind'] {
  if (phaseId === 'repository-workflow-source-ready' || phaseId === 'bootstrap-workflow-source-ready' || phaseId === 'workflow-source-ready') {
    return `${phaseId}.v1`;
  }
  throw new GitHubActivationError('workflow-source-phase', 'Workflow source evidence belongs only to its exact registered source phase.');
}

export interface WorkflowSourcePublicationConfiguration {
  featureBranch: string;
  repositoryId: number;
  actorId: number;
  commitTime: string;
  commitMessage: string;
}

export interface WorkflowSourceConfiguration {
  sourceSha: string;
  paths: readonly string[];
  publication?: WorkflowSourcePublicationConfiguration;
  applicationBuild?: ApplicationBuildWorkflowRecipe;
  applicationBuilds?: readonly ApplicationBuildWorkflowRecipe[];
  /** Repository/actor/ref authority comes from the exact publication/readback, not invented renderer fields. */
  environmentRuntime?: { recipe: EnvironmentRuntimeRecipe };
  /** Unsupplied execution identities remain null; this selects source, not a later dispatch. */
  stagingSecurity?: StagingSecurityWorkflowRecipe;
}

function generatedSourceValues(selection: GeneratedWorkflowSourceSelection): Record<string, string | number> {
  if (selection.generatedSource) return {
    generatedSourceRecipeDigest: selection.generatedSource.recipeDigest,
    generatedRemoteOnlyCount: selection.generatedSource.remoteOnlyPaths.length
  };
  if (selection.generatedSources) return {
    generatedSourcesDigest: canonicalSha256(selection.generatedSources),
    generatedSourceCount: selection.generatedSources.length,
    generatedRemoteOnlyCount: selection.generatedSources.reduce((count, source) => count + source.remoteOnlyPaths.length, 0)
  };
  return {};
}

async function observeSourceBinding(input: PhasePlanningInput, repository: string, source: string) {
  const client = clientFor(input);
  const ref = repositoryConfiguration(input.inspection).defaultBranch;
  const [metadata, actor, target] = await Promise.all([
    client.get(`/repos/${repository}`), client.get('/user'), client.get(`/repos/${repository}/git/ref/heads/${ref}`)
  ]);
  const repositoryId = positiveId(metadata.id);
  if (String(repositoryId) !== input.inspection.state.remoteBinding?.id || metadata.full_name !== repository ||
    metadata.default_branch !== ref || metadata.archived !== false || metadata.disabled !== false ||
    target.ref !== `refs/heads/${ref}` || object(target.object).type !== 'commit' || object(target.object).sha !== source) {
    throw new GitHubActivationError('workflow-source-binding', 'Already-published source must match the actual bound repository ID and current exact default ref; an arbitrary or unmerged SHA is not source readiness.');
  }
  return { repositoryId, actorId: positiveId(actor.id), actorLogin: githubName(actor.login, 'Actual source-readback actor'), ref };
}

async function sourceInputs(input: PhasePlanningInput) {
  const config = phaseConfiguration(input.inspection, input.phase.id, [
    'sourceSha', 'paths', 'publication', 'applicationBuild', 'applicationBuilds', 'environmentRuntime', 'stagingSecurity'
  ]);
  if (!Array.isArray(config.paths) || !config.paths.length || config.paths.length > 64 || !config.sourceSha) {
    throw new GitHubActivationError('workflow-inputs', 'Supply exact sourceSha and unique workflow/ruleset paths. For approved publication also supply publication.featureBranch, repositoryId, actorId, commitTime and commitMessage.');
  }
  const source = sourceSha(config.sourceSha);
  const paths = config.paths;
  const repository = repositoryConfiguration(input.inspection);
  const publication = config.publication === undefined ? undefined : object(config.publication, 'Publication configuration');
  if (publication && (Object.keys(publication).sort().join(',') !==
    ['featureBranch', 'repositoryId', 'actorId', 'commitTime', 'commitMessage'].sort().join(','))) {
    throw new GitHubActivationError('workflow-configuration', 'Publication accepts only its exact documented public GitFlow inputs; push/bypass/approval booleans are forbidden.');
  }
  const generated: RegisteredGeneratedWorkflow[] = [];
  const generatedPaths = new Set<string>();
  const addGenerated = (
    definition: Pick<RegisteredGeneratedWorkflow, 'recipe' | 'recipeDigest' | 'files'>,
    binding?: { repository: string; repositoryId: number; actorId: number; ref: string }
  ) => {
    if (input.phase.id !== 'workflow-source-ready') {
      throw new GitHubActivationError('workflow-recipe-phase', 'Registered application, runtime and staging source recipes belong only to workflow-source-ready.');
    }
    if (repository.defaultBranch !== input.inspection.state.remoteBinding?.defaultBranch ||
      binding && (binding.repository !== repository.name ||
        String(binding.repositoryId) !== input.inspection.state.remoteBinding?.id ||
        binding.ref !== repository.defaultBranch ||
        publication && (binding.repositoryId !== publication.repositoryId || binding.actorId !== publication.actorId))) {
      throw new GitHubActivationError('workflow-recipe-binding', 'Generated recipe repository, provider ID, actor or default ref differs from the reviewed publication binding.');
    }
    for (const file of definition.files) {
      if (!paths.includes(file.path)) {
        throw new GitHubActivationError('workflow-recipe-path', 'Every generated workflow must be explicitly selected by its exact path.');
      }
      if (generatedPaths.has(file.path.toLowerCase())) {
        throw new GitHubActivationError('workflow-recipe-collision', 'Different registered source families cannot claim the same generated workflow path.');
      }
      generatedPaths.add(file.path.toLowerCase());
    }
    generated.push({ ...definition, ...(binding ? { actorId: binding.actorId } : {}), remoteOnlyPaths: [] });
  };
  if (config.applicationBuild !== undefined && config.applicationBuilds !== undefined) {
    throw new GitHubActivationError('workflow-recipe-configuration', 'Select applicationBuild or applicationBuilds, never both source contracts.');
  }
  if (config.applicationBuilds !== undefined) {
    if (!Array.isArray(config.applicationBuilds) || config.applicationBuilds.length < 1 || config.applicationBuilds.length > 2) {
      throw new GitHubActivationError('workflow-recipe-configuration', 'applicationBuilds requires one or two exact registered backend/frontend build recipes.');
    }
    for (const value of config.applicationBuilds) {
      const recipe = applicationBuildWorkflowRecipe(value);
      addGenerated(applicationBuildWorkflowSource(recipe), recipe);
    }
  } else if (config.applicationBuild !== undefined) {
    const recipe = applicationBuildWorkflowRecipe(config.applicationBuild);
    addGenerated(applicationBuildWorkflowSource(recipe), recipe);
  }
  if (config.environmentRuntime !== undefined) {
    const configured = object(config.environmentRuntime, 'Environment runtime source configuration');
    if (Object.keys(configured).length !== 1 || !Object.hasOwn(configured, 'recipe')) {
      throw new GitHubActivationError('workflow-recipe-configuration', 'environmentRuntime accepts only its registered recipe; generated bytes and authority flags are not source inputs.');
    }
    const recipe = environmentRuntimeRecipe(configured.recipe);
    const content = renderEnvironmentRuntimeWorkflow(recipe);
    addGenerated({ recipe: 'environmentRuntime', recipeDigest: canonicalSha256(recipe),
      files: [{ path: recipe.workflowPath, content, digest: canonicalSha256(content) }] });
  }
  if (config.stagingSecurity !== undefined) {
    const recipe = stagingSecurityWorkflowRecipe(config.stagingSecurity);
    addGenerated(stagingSecurityWorkflowSource(recipe), recipe);
  }
  const files: WorkflowFileDefinition[] = [];
  for (const name of paths) {
    if (typeof name !== 'string' || !/^\.github\/(?:workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml|rulesets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json)$/u.test(name) ||
      files.some((file) => file.path.toLowerCase() === name.toLowerCase())) {
      throw new GitHubActivationError('workflow-paths', 'Workflow source requires unique exact registered workflow/ruleset paths, not directory or wildcard ownership.');
    }
    const bytes = await readProjectFile(input.inspection.projectRoot, name.split('/'));
    const owner = generated.find((source) => source.files.some((file) => file.path === name));
    const definition = owner?.files.find((file) => file.path === name);
    if (owner && definition) {
      if (bytes && (!isUtf8(bytes) || !bytes.equals(Buffer.from(definition.content)))) {
        throw new GitHubActivationError('workflow-recipe-collision', `Existing local source ${name} differs from the registered generated recipe. It is preserved; no overwrite or adoption is authorized.`);
      }
      files.push({ ...definition });
      if (!bytes) owner.remoteOnlyPaths.push(name);
      continue;
    }
    if (!bytes || bytes.length > 256 * 1024 || !isUtf8(bytes)) throw new GitHubActivationError('workflow-bytes', `Reviewed source ${name} is absent, not exact UTF-8 or exceeds the bounded public source size.`);
    files.push({ path: name, content: bytes.toString('utf8'), digest: canonicalSha256(bytes.toString('utf8')) });
  }
  if (!files.some((file) => file.path.startsWith('.github/workflows/'))) {
    throw new GitHubActivationError('workflow-missing', 'A ruleset file alone does not establish workflow source readiness.');
  }
  if (input.phase.id === 'workflow-source-ready' && !files.some((file) => file.path.startsWith('.github/rulesets/'))) {
    throw new GitHubActivationError('workflow-ruleset-source-missing',
      'Full application workflow source requires exact reviewed ruleset source paths; workflow files alone cannot complete this phase.');
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const descriptions: GeneratedWorkflowSource[] = generated.map(({ recipe, recipeDigest, remoteOnlyPaths }) => ({
    recipe, recipeDigest, remoteOnlyPaths: remoteOnlyPaths.sort((a, b) => a.localeCompare(b, 'en'))
  }));
  // Keep the original single-recipe wire shape so existing app-build approvals retain their identities.
  const generatedMetadata: GeneratedWorkflowSourceSelection = descriptions.length === 1 ? { generatedSource: descriptions[0]! } :
    descriptions.length > 1 ? { generatedSources: descriptions } : {};
  return { source, files, publication, repository: repository.name, generatedMetadata,
    generatedFiles: generated.flatMap((source) => source.files),
    reviewPaths: generated.length > 1 || generated.some((source) => source.recipe === stagingSecurityWorkflowRecipeId) ?
      generated.flatMap((source) => source.files.map((file) => file.path)) : [],
    generatedActorIds: generated.flatMap((source) => source.actorId === undefined ? [] : [source.actorId]),
    remoteOnlyPaths: descriptions.flatMap((source) => source.remoteOnlyPaths).sort((a, b) => a.localeCompare(b, 'en')) };
}

function assertGeneratedSourceBinding(operation: TransitionOperation, current: Awaited<ReturnType<typeof sourceInputs>>): void {
  const reviewed = {
    ...(operation.inputs.generatedSource === undefined ? {} : { generatedSource: operation.inputs.generatedSource }),
    ...(operation.inputs.generatedSources === undefined ? {} : { generatedSources: operation.inputs.generatedSources })
  };
  if (canonicalSha256(reviewed) !== canonicalSha256(current.generatedMetadata)) {
    throw new GitHubActivationError('workflow-generated-source-drift', 'The reviewed generated recipe or local/remote-only source disclosure changed. Review the exact source again before publication.');
  }
}

function assertReviewedPublication(input: PhasePlanningInput, publication: WorkflowPublicationPlan, current: Awaited<ReturnType<typeof sourceInputs>>) {
  const settings = current.publication!;
  if (publication.schemaVersion !== 1 || publication.recipe !== 'gitflow-workflow-source.v1' ||
    publication.repository !== current.repository || publication.baseSha !== current.source ||
    publication.targetBranch !== 'develop' || publication.repositoryId !== settings.repositoryId ||
    publication.actorId !== settings.actorId || publication.featureBranch !== settings.featureBranch ||
    publication.commitTime !== settings.commitTime || publication.commitMessage !== settings.commitMessage ||
    canonicalSha256(publication.files.map(({ path, content, digest }) => ({ path, content, digest }))) !== canonicalSha256(current.files) ||
    input.inspection.state.remoteBinding?.id !== String(publication.repositoryId)) {
    throw new GitHubActivationError('workflow-plan-drift', 'The exact reviewed local workflow bytes, source, repository or actor changed; preserved remote effects require their recorded recovery.');
  }
}

function publicationOperation(
  input: PhasePlanningInput, publication: WorkflowPublicationPlan, current: Awaited<ReturnType<typeof sourceInputs>>,
  retainedReview?: unknown
) {
  const destination = { type: 'repository' as const, identity: publication.repository, repository: publication.repository };
  return githubOperation(input, workflowSourcePublicationAction, 'github-write', {
    publication: retainedReview ?? (current.reviewPaths.length ? reviewGeneratedWorkflowPublication(publication, current.reviewPaths) : publication),
    ...current.generatedMetadata
  }, destination,
    ['github-read', 'git-push'].map((mutationClass) => ({
      mutationClass: mutationClass as 'github-read' | 'git-push', destination, remote: true, destructive: false
    })));
}

/** Registered source families supply exact bytes only; absent local files remain remote-only and selected rulesets stay file-backed. */
export async function planRepositoryWorkflowSource(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  if (input.phase.id === 'workflow-source-ready' && !input.phase.allowedMutations.remote.includes('github-read')) {
    return { operations: [], blockers: ['Frozen graph contract correction required: workflow-source-ready is local-only with no approval or GitHub evidence. Real source publication requires github-read/github-write/git-push, repository-publish authority and GitHub readback under a reviewed identity change.'] };
  }
  try {
    const current = await sourceInputs(input);
    if (!current.publication) {
      const binding = await observeSourceBinding(input, current.repository, current.source);
      if (current.generatedActorIds.some((actorId) => actorId !== binding.actorId)) {
        throw new GitHubActivationError('workflow-recipe-binding', 'The actual workflow source reader is not the actor bound by the registered generated recipe.');
      }
      const client = clientFor(input);
      const files: Array<{ path: string; digest: string; workflowId?: number }> = [];
      for (const file of current.files) {
        if (!file.path.startsWith('.github/workflows/')) files.push({ path: file.path, digest: file.digest });
        else {
          const workflow = await client.get(`/repos/${current.repository}/actions/workflows/${file.path.split('/').at(-1)}`);
          if (workflow.path !== file.path || workflow.state !== 'active') {
            throw new GitHubActivationError('workflow-source-registration', 'Source readiness needs the actual active workflow registration for every reviewed workflow path.');
          }
          files.push({ path: file.path, digest: file.digest, workflowId: positiveId(workflow.id) });
        }
      }
      return { operations: [githubOperation(input, 'github.workflow-source.verify', 'github-read', {
        repository: current.repository, sourceSha: current.source, ...binding, files,
        ...current.generatedMetadata
      })] };
    }
    const priorDigest = input.inspection.state.phases[input.phase.id].executionPlanDigest;
    const prior = priorDigest ? input.inspection.contexts[input.phase.id].reviewedPlans?.find((plan) =>
      plan.planDigest === priorDigest && plan.phaseId === input.phase.id)?.operations.find((operation) =>
      operation.actionId === workflowSourcePublicationAction) : undefined;
    if (prior) {
      const publication = materializeWorkflowPublicationReview(prior.inputs.publication, current.generatedFiles);
      assertReviewedPublication(input, publication, current);
      assertGeneratedSourceBinding(prior, current);
      return { operations: [publicationOperation(input, publication, current, prior.inputs.publication)] };
    }
    const publication = await planWorkflowSourcePublication({
      client: clientFor(input), repository: current.repository,
      repositoryId: positiveId(current.publication.repositoryId), actorId: positiveId(current.publication.actorId),
      baseSha: current.source, featureBranch: text(current.publication.featureBranch, 'Reviewed feature branch'),
      workflowFiles: current.files, commitMessage: text(current.publication.commitMessage, 'Reviewed commit message'),
      commitTime: text(current.publication.commitTime, 'Reviewed commit time')
    });
    assertReviewedPublication(input, publication, current);
    return { operations: [publicationOperation(input, publication, current)] };
  } catch (error) {
    return { operations: [], blockers: [safeGitHubFailure(error)] };
  }
}

export async function executeRepositoryWorkflowSource(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  let admitted: { operation: TransitionOperation; publication: WorkflowPublicationPlan } | undefined;
  try {
    const publicationOperation = input.plan.operations.find((operation) => operation.actionId === workflowSourcePublicationAction);
    if (publicationOperation) {
      const current = await sourceInputs(input);
      if (!current.publication) throw new GitHubActivationError('workflow-plan-drift', 'Publication configuration was removed after review.');
      const publication = materializeWorkflowPublicationReview(publicationOperation.inputs.publication, current.generatedFiles);
      assertReviewedPublication(input, publication, current);
      assertGeneratedSourceBinding(publicationOperation, current);
      await assertGitHubPhaseAuthority(input, publicationOperation);
      admitted = { operation: publicationOperation, publication };
      const result = await publishWorkflowSourceViaGitFlow({ execution: input, operation: publicationOperation, publication });
      const remoteOnlyNotice = current.remoteOnlyPaths.length ?
        ` Generated source is remote-only at ${current.remoteOnlyPaths.join(', ')}; no local file or commit was created.` : '';
      if (result.status === 'pending') return {
        status: 'pending', operation: result.operation, completedOperations: [publicationOperation],
        blocker: (result.pendingReason === 'workflow-registration' ?
          'The exact PR is merged and its immutable bytes match, but actual workflow registration has not appeared. Resume bounded readback; do not publish again.' :
          'The exact reviewed PR is open. It must pass the existing protected-branch checks and be merged by the approved actor; Liftoff never bypasses or directly updates protected refs.') + remoteOnlyNotice
      };
      const rulesets = result.files.filter((file) => file.path.startsWith('.github/rulesets/'));
      const rulesetSourceDigest = rulesets.length ? canonicalSha256(rulesets.map(({ path, digest }) => ({ path, digest }))) : undefined;
      const resourceId = `/repos/${result.repository}/git/commits/${result.commitSha}`;
      const evidencePayload: WorkflowSourceEvidencePayload = {
        kind: sourceEvidenceKind(input.phase.id), repository: result.repository, repositoryId: result.repositoryId,
        actorId: result.actorId, actorLogin: result.actorLogin, ref: result.ref, sourceSha: result.commitSha,
        baseSha: publication.baseSha, pullRequestNumber: result.pullRequestNumber,
        files: result.files, workflows: result.workflows, ...(rulesetSourceDigest ? { rulesetSourceDigest } : {}),
        ...current.generatedMetadata
      };
      return {
        status: 'completed', resultState: 'verified', completedOperations: [publicationOperation], operation: result.operation,
        evidencePayload,
        liveReadback: [
          readbackProof(input, 'github', 'workflow-source', resourceId, {
            repository: result.repository, repositoryId: result.repositoryId, actorId: result.actorId, actorLogin: result.actorLogin,
            ref: result.ref, sourceSha: result.commitSha,
            pullRequestNumber: result.pullRequestNumber, files: result.files, workflows: result.workflows
          }),
          ...result.workflows.map((workflow) => readbackProof(input, 'github', 'workflow',
            `/repos/${result.repository}/actions/workflows/${workflow.workflowId}`, workflow))
        ],
        outputs: { values: { sourceSha: result.commitSha, repositoryId: result.repositoryId,
          actorId: result.actorId, actorLogin: result.actorLogin, ref: result.ref,
          workflowCount: result.workflows.length, workflowBindingsDigest: canonicalSha256(result.workflows),
          ...generatedSourceValues(current.generatedMetadata),
          ...(rulesetSourceDigest ? { rulesetSourceDigest } : {}) },
          resources: [{ provider: 'github', resourceType: 'workflow-source', resourceId },
            ...result.workflows.map((workflow) => ({ provider: 'github' as const, resourceType: 'workflow',
              resourceId: `/repos/${result.repository}/actions/workflows/${workflow.workflowId}` }))] }
      };
    }
    const reviewed = input.plan.operations.find((operation) => operation.actionId === 'github.workflow-source.verify');
    if (!reviewed) throw new GitHubActivationError('workflow-source-plan', 'The current phase has no exact reviewed source readback operation.');
    await assertGitHubPhaseAuthority(input, reviewed);
    const sources = await sourceInputs(input);
    const current = await planRepositoryWorkflowSource(input);
    const operation = current.operations[0];
    if (current.blockers?.length || !operation || !reviewed || canonicalSha256(reviewed) !== canonicalSha256(operation)) {
      return { status: 'blocked', blocker: current.blockers?.join(' ') ?? 'Exact reviewed workflow source inputs changed.', completedOperations: [] };
    }
    assertGeneratedSourceBinding(operation, sources);
    const repository = String(operation.inputs.repository);
    const source = String(operation.inputs.sourceSha);
    const client = clientFor(input);
    const files = operation.inputs.files as Array<{ path: string; digest: string; workflowId?: number }>;
    const observed: PublishedWorkflowSourceFile[] = [];
    const workflows: Array<{ path: string; workflowId: number; blobSha: string; digest: string; sourceSha: string }> = [];
    for (const file of files) {
      const readback = await readbackWorkflowContent(client, repository, file.path, source);
      if (readback.digest !== file.digest) {
        return { status: 'blocked', blocker: `Actual immutable source readback for ${file.path} differs from the reviewed local bytes. No publication was attempted.`, completedOperations: [] };
      }
      observed.push({ path: file.path, digest: file.digest, readbackDigest: readback.digest, blobSha: readback.blobSha });
      if (file.path.startsWith('.github/workflows/')) {
        const workflow = await client.get(`/repos/${repository}/actions/workflows/${positiveId(file.workflowId)}`);
        if (workflow.id !== file.workflowId || workflow.path !== file.path || workflow.state !== 'active') {
          throw new GitHubActivationError('workflow-source-registration', 'The actual workflow registration is disabled or belongs to another reviewed source path.');
        }
        workflows.push({ path: file.path, workflowId: positiveId(workflow.id), digest: readback.digest, blobSha: readback.blobSha, sourceSha: source });
      }
    }
    const rulesets = observed.filter((file) => file.path.startsWith('.github/rulesets/'));
    const rulesetSourceDigest = rulesets.length ? canonicalSha256(rulesets.map(({ path, digest }) => ({ path, digest }))) : undefined;
    const resourceId = `/repos/${repository}/git/commits/${source}`;
    const evidencePayload: WorkflowSourceEvidencePayload = {
      kind: sourceEvidenceKind(input.phase.id), sourceSha: source, repository,
      repositoryId: positiveId(operation.inputs.repositoryId), actorId: positiveId(operation.inputs.actorId),
      actorLogin: githubName(operation.inputs.actorLogin), ref: String(operation.inputs.ref), files: observed, workflows,
      ...(rulesetSourceDigest ? { rulesetSourceDigest } : {}),
      ...sources.generatedMetadata
    };
    return {
      status: 'completed', resultState: 'verified', completedOperations: [reviewed],
      evidencePayload,
      liveReadback: [
        readbackProof(input, 'github', 'workflow-source', resourceId, {
          sourceSha: source, repository, repositoryId: operation.inputs.repositoryId,
          actorId: operation.inputs.actorId, actorLogin: operation.inputs.actorLogin,
          ref: operation.inputs.ref, files: observed, workflows
        }),
        ...workflows.map((workflow) => readbackProof(input, 'github', 'workflow',
          `/repos/${repository}/actions/workflows/${workflow.workflowId}`, workflow))
      ],
      outputs: {
        values: { sourceSha: source, repositoryId: Number(operation.inputs.repositoryId),
          actorId: evidencePayload.actorId, actorLogin: evidencePayload.actorLogin, ref: evidencePayload.ref,
          workflowCount: workflows.length, workflowBindingsDigest: canonicalSha256(workflows),
          ...generatedSourceValues(sources.generatedMetadata),
          ...(rulesetSourceDigest ? { rulesetSourceDigest } : {}) },
        resources: [{ provider: 'github', resourceType: 'workflow-source', resourceId },
          ...workflows.map((workflow) => ({ provider: 'github' as const, resourceType: 'workflow',
            resourceId: `/repos/${repository}/actions/workflows/${workflow.workflowId}` }))]
      }
    };
  } catch (error) {
    let operation;
    const cleanupWarnings: string[] = [];
    if (admitted) {
      try { operation = await readWorkflowPublicationOperation(input, admitted.operation, admitted.publication); }
      catch (checkpointError) {
        cleanupWarnings.push(`Original publication custody could not be read: ${safeGitHubFailure(checkpointError)} Preserve it; no replacement or repeated publication is authorized.`);
      }
    }
    return {
      status: 'blocked', blocker: safeGitHubFailure(error), completedOperations: [],
      ...(operation ? { operation } : {}), ...(cleanupWarnings.length ? { cleanupWarnings } : {})
    };
  }
}
