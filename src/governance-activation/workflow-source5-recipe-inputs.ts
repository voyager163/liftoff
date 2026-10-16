import { types } from 'node:util';
import { parse } from 'yaml';
import { githubRef } from '../adapters/github/activation-rest.js';
import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { freezeModernValue } from '../domain/governance/activation/modern-graph.js';
import { recognizeWorkflowValidatorProgramStep } from '../domain/governance/activation/workflow-validator-program.js';
import type { WorkflowContextValidator } from '../domain/governance/activation/workflow-validator-program.js';
import { captureWorkflowBinding, workflowFailure } from './workflow-control-values.js';
import { protectedWorkflowFamilyForRef, validateContextWorkflow } from './workflow-context-proof.js';
import type { RequiredWorkflowContext } from './workflow-context-proof.js';
import {
  observeSource5WorkflowRequirementSource, workflowRequirementObservationClient
} from './workflow-requirement-source-observation.js';
import type { Source5WorkflowRequirementSourceObservation } from './workflow-requirement-source-observation.js';
import { protectedWorkflowFamilies } from './workflow-requirements.js';
import type { ProtectedWorkflowFamily, WorkflowRequirementSourceReference } from './workflow-requirements.js';
import { assertWorkflowObservationRuntime, readWorkflowBytes } from './workflow-runtime.js';
import type { WorkflowRuntime } from './workflow-runtime.js';
import { assertSource5WorkflowContext } from './workflow-source5-context.js';
import type { Source5WorkflowContext } from './workflow-source5-context.js';

export interface Source5WorkflowRecipeReference {
  readonly family: ProtectedWorkflowFamily;
  readonly ref: string;
  readonly path: string;
  readonly digest: string;
}

export interface Source5WorkflowRecipeInputs {
  readonly status: 'blocked';
  readonly source: Source5WorkflowRequirementSourceObservation;
  readonly workflow: Source5WorkflowRecipeReference & {
    readonly contexts: readonly (RequiredWorkflowContext & {
      readonly integrationId: number | null;
      readonly validatorSyntax: WorkflowContextValidator | null;
    })[];
  };
  readonly blockers: readonly {
    readonly context: string;
    readonly code: 'workflow-recipe-semantic-catalog-unavailable' | 'workflow-recipe-validator-body-unavailable';
    readonly message: string;
  }[];
  readonly qualifiedExecutableRecipe: null;
  readonly prerequisiteSession: null;
  readonly execution: 'not-authorized';
}

/** Derives real source inputs; recognizing a CLI command never qualifies its context or executable. */
export async function observeSource5WorkflowRecipeInputs(input: {
  readonly context: Source5WorkflowContext;
  readonly runtime: WorkflowRuntime;
  readonly source: WorkflowRequirementSourceReference;
  readonly workflow: Source5WorkflowRecipeReference;
}): Promise<Source5WorkflowRecipeInputs> {
  if (typeof input !== 'object' || input === null || types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 4 ||
    Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['context', 'runtime', 'source', 'workflow'].includes(key)) ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(field =>
      !field.enumerable || !Object.hasOwn(field, 'value'))) {
    return workflowFailure('workflow-recipe-input-request',
      'Recipe input observation accepts only the constructed current5 context, original read-only runtime and exact source/workflow selectors.');
  }
  const { context, runtime } = input;
  assertSource5WorkflowContext(context);
  assertWorkflowObservationRuntime(runtime);
  const { source, workflow } = captureWorkflowBinding({ source: input.source, workflow: input.workflow });
  if (!isRecord(workflow) ||
    canonicalSha256(Object.keys(workflow).sort()) !== canonicalSha256(['digest', 'family', 'path', 'ref']) ||
    !protectedWorkflowFamilies.includes(workflow.family) ||
    typeof workflow.ref !== 'string' || protectedWorkflowFamilyForRef(workflow.ref) !== workflow.family ||
    typeof workflow.path !== 'string' || !/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/u.test(workflow.path) ||
    typeof workflow.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(workflow.digest)) {
    return workflowFailure('workflow-recipe-input-reference',
      'Recipe observation requires one literal protected family/ref and immutable supported workflow path/digest; context maps, commands and recipe bytes are not inputs.');
  }
  githubRef(workflow.ref);
  const observed = await observeSource5WorkflowRequirementSource({ context, runtime, source });
  const client = workflowRequirementObservationClient(runtime);
  async function observeRef() {
    const ref = await client.get(`/repos/${source.repository}/git/ref/heads/${workflow.ref}`);
    assertWorkflowObservationRuntime(runtime);
    if (ref.ref !== `refs/heads/${workflow.ref}` || !isRecord(ref.object) || ref.object.sha !== source.sourceSha) {
      return workflowFailure('workflow-recipe-input-ref', 'The actual selected protected ref does not name the exact immutable recipe source.');
    }
  }
  await observeRef();
  const tree = await client.get(`/repos/${source.repository}/git/trees/${source.treeSha}?recursive=1`);
  assertWorkflowObservationRuntime(runtime);
  const members = Array.isArray(tree.tree) ? tree.tree.filter(entry => isRecord(entry) && entry.path === workflow.path) : [];
  if (tree.sha !== source.treeSha || tree.truncated !== false || members.length !== 1 ||
    !isRecord(members[0]) || members[0].type !== 'blob' || members[0].mode !== '100644') {
    return workflowFailure('workflow-recipe-input-workflow', 'The actual complete source tree must contain exactly one ordinary non-executable workflow file at the selected path.');
  }
  const bytes = await readWorkflowBytes(client, source.repository, source.sourceSha, workflow.path, workflow.digest);
  assertWorkflowObservationRuntime(runtime);
  let value: unknown;
  try { value = parse(bytes.toString('utf8'), { uniqueKeys: true, maxAliasCount: 0 }); }
  catch {
    return workflowFailure('workflow-recipe-input-workflow', 'Recipe inputs require actual unambiguous bounded workflow YAML.');
  }
  if (!isRecord(value) || !isRecord(value.jobs)) {
    return workflowFailure('workflow-recipe-input-workflow', 'The actual workflow has no complete job inventory.');
  }
  const jobs = value.jobs;
  const contexts = Object.entries(jobs).map(([jobId, job]): RequiredWorkflowContext => {
    const last: unknown = isRecord(job) && Array.isArray(job.steps) ? job.steps.at(-1) : undefined;
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(jobId) || !isRecord(job) || typeof job.name !== 'string' ||
      !job.name || job.name.length > 100 || /[\u0000-\u001f\u007f]/u.test(job.name) ||
      !isRecord(last) || typeof last.name !== 'string' || !last.name || last.name.length > 100 ||
      /[\u0000-\u001f\u007f]/u.test(last.name)) {
      return workflowFailure('workflow-recipe-input-contexts', 'Actual job/validation identities are missing, unsupported or ambiguous.');
    }
    return { jobId, name: job.name, validationStep: last.name };
  });
  if (contexts.length > 32 || new Set(contexts.map(item => item.name)).size !== contexts.length ||
    canonicalSha256(contexts.map(item => item.name).sort()) !==
      canonicalSha256(observed.requirements.families[workflow.family])) {
    return workflowFailure('workflow-recipe-input-contexts',
      'The complete actual workflow job names must equal every literal required source context for this family; no omitted, extra or renamed contexts qualify.');
  }
  validateContextWorkflow(bytes, { contexts });
  const actual = contexts.map(item => {
    const job = jobs[item.jobId];
    const integrationId = observed.requirements.integrations[workflow.family][item.name];
    if (integrationId === undefined) {
      return workflowFailure('workflow-recipe-input-contexts', 'The actual required source context has no complete integration selector.');
    }
    return { ...item, integrationId,
      validatorSyntax: recognizeWorkflowValidatorProgramStep(isRecord(job) && Array.isArray(job.steps) ? job.steps.at(-1) : null) };
  });
  const blockers: Source5WorkflowRecipeInputs['blockers'][number][] = actual.flatMap(item => [{
    context: item.name, code: 'workflow-recipe-semantic-catalog-unavailable' as const,
    message: 'No accepted release-owned mapping and immutable executable/tool/action/preparation subjects qualify this literal context. A recognized local CLI command or source publication is not that authority.'
  }, ...(item.validatorSyntax === null ? [{
    context: item.name, code: 'workflow-recipe-validator-body-unavailable' as const,
    message: 'The actual final step has no supported closed local validator syntax. Echo, forced exits, arbitrary commands, external actions and private unregistered bodies are not executable substitutes.'
  }] : [])]);
  await observeRef();
  const result: Source5WorkflowRecipeInputs = freezeModernValue({
    status: 'blocked', source: observed, workflow: { ...workflow, contexts: actual }, blockers,
    qualifiedExecutableRecipe: null, prerequisiteSession: null, execution: 'not-authorized'
  });
  assertWorkflowObservationRuntime(runtime);
  return result;
}
