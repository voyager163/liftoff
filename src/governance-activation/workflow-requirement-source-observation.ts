import { types } from 'node:util';
import { GitHubActivationClient } from '../adapters/github/activation-rest.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { freezeModernValue } from '../domain/governance/activation/modern-graph.js';
import { workflowFailure } from './workflow-control-values.js';
import { assertSource5WorkflowContext } from './workflow-source5-context.js';
import type { Source5WorkflowContext } from './workflow-source5-context.js';
import { assertWorkflowObservationRuntime } from './workflow-runtime.js';
import type { WorkflowRuntime } from './workflow-runtime.js';
import {
  captureWorkflowRequirementSourceReference, readRequiredWorkflowSource
} from './workflow-requirements.js';
import type { WorkflowRequirementSource, WorkflowRequirementSourceReference } from './workflow-requirements.js';

export interface Source5WorkflowRequirementSourceObservation {
  readonly status: 'observed';
  readonly source: WorkflowRequirementSourceReference;
  readonly graphHash: string;
  readonly requirements: WorkflowRequirementSource;
  readonly originalPlan: 'not-validated';
  readonly sourceRefCurrentness: 'not-observed';
  readonly requiredContextSemantics: 'not-validated';
  readonly prerequisiteSession: null;
  readonly execution: 'not-authorized';
}

export function workflowRequirementObservationClient(runtime: WorkflowRuntime): GitHubActivationClient {
  assertWorkflowObservationRuntime(runtime);
  return new GitHubActivationClient({ async request(request) {
    assertWorkflowObservationRuntime(runtime);
    if (request.method !== 'GET') {
      return workflowFailure('workflow-required-source-read-only', 'Immutable required-context observation cannot submit provider effects.');
    }
    const response = await runtime.client.transport.request(request);
    assertWorkflowObservationRuntime(runtime);
    return response;
  } });
}

/** Uses the original read-only invocation; a serializable inventory never becomes a recipe or session. */
export async function observeSource5WorkflowRequirementSource(input: {
  readonly context: Source5WorkflowContext;
  readonly runtime: WorkflowRuntime;
  readonly source: WorkflowRequirementSourceReference;
}): Promise<Source5WorkflowRequirementSourceObservation> {
  if (typeof input !== 'object' || input === null || types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 3 ||
    Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['context', 'runtime', 'source'].includes(key)) ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(descriptor =>
      !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) {
    return workflowFailure('workflow-required-source-request',
      'Immutable required-context observation accepts only the constructed current5 context, original read-only runtime and exact source references.');
  }
  const { context, runtime } = input;
  assertSource5WorkflowContext(context);
  assertWorkflowObservationRuntime(runtime);
  const source = captureWorkflowRequirementSourceReference(input.source);
  const client = workflowRequirementObservationClient(runtime);
  const repository = await client.get(`/repos/${source.repository}`);
  if (repository.id !== source.repositoryId || repository.full_name !== source.repository) {
    return workflowFailure('workflow-required-source-repository', 'The actual immutable source repository differs from its exact selected ID/name.');
  }
  const requirements = await readRequiredWorkflowSource({
    client, assertWithinDeadline: () => assertWorkflowObservationRuntime(runtime)
  }, source, context.records.identity.profile);
  assertWorkflowObservationRuntime(runtime);
  // Literal context-name dictionaries are not activation-record field namespaces.
  return freezeModernValue({
    status: 'observed', source, graphHash: canonicalSha256(context.records.graph), requirements,
    originalPlan: 'not-validated', sourceRefCurrentness: 'not-observed',
    requiredContextSemantics: 'not-validated', prerequisiteSession: null, execution: 'not-authorized'
  });
}
