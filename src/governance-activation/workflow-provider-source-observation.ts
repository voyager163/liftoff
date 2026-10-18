import { types } from 'node:util';
import { githubRef, githubRepository, positiveId } from '../adapters/github/activation-rest.js';
import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { captureWorkflowBinding, workflowFailure } from './workflow-control-values.js';
import { protectedWorkflowFamilyForRef } from './workflow-context-proof.js';
import { workflowRequirementObservationClient } from './workflow-requirement-source-observation.js';
import { assertSource5WorkflowContext } from './workflow-source5-context.js';
import type { Source5WorkflowContext } from './workflow-source5-context.js';
import { assertWorkflowObservationRuntime } from './workflow-runtime.js';
import type { WorkflowRuntime } from './workflow-runtime.js';

export interface Source5WorkflowProviderSource {
  readonly repository: string;
  readonly repositoryId: number;
  readonly ref: string;
  readonly sourceSha: string;
  readonly treeSha: string;
}

export function captureWorkflowProviderSourceObservation(input: {
  readonly context: Source5WorkflowContext;
  readonly runtime: WorkflowRuntime;
  readonly source: Source5WorkflowProviderSource;
}, kind: 'code-scanning' | 'secret-protection-history') {
  const code = `workflow-${kind}`, name = kind === 'code-scanning' ? 'Code-scanning' : 'Secret Protection history';
  if (typeof input !== 'object' || input === null || types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 3 ||
    Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['context', 'runtime', 'source'].includes(key)) ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(field =>
      !field.enumerable || !Object.hasOwn(field, 'value'))) {
    return workflowFailure(`${code}-request`,
      `${name} observation accepts only the constructed current5 context, original read-only runtime and exact repository/ref/commit/tree references.`);
  }
  const { context, runtime } = input;
  assertSource5WorkflowContext(context);
  assertWorkflowObservationRuntime(runtime);
  const source = captureWorkflowBinding(input.source);
  if (!isRecord(source) || canonicalSha256(Object.keys(source).sort()) !==
    canonicalSha256(['ref', 'repository', 'repositoryId', 'sourceSha', 'treeSha']) ||
    [source.sourceSha, source.treeSha].some(value => typeof value !== 'string' || !/^[a-f0-9]{40}$/u.test(value)) ||
    typeof source.ref !== 'string' || !protectedWorkflowFamilyForRef(source.ref)) {
    return workflowFailure(`${code}-reference`,
      `${name} observation requires one literal protected-family branch, full immutable commit/tree and exact repository ID/name; reports, tool selectors and result overrides are not inputs.`);
  }
  githubRepository(source.repository); positiveId(source.repositoryId); githubRef(source.ref);
  const client = workflowRequirementObservationClient(runtime), prefix = `/repos/${source.repository}`;
  const ref = `refs/heads/${source.ref}`;
  async function repository() {
    const actual = await client.get(prefix);
    if (actual.id !== source.repositoryId || actual.full_name !== source.repository) {
      return workflowFailure(`${code}-repository`,
        `The actual ${kind === 'code-scanning' ? 'analysis' : 'scan-history'} repository differs from the exact selected ID/name.`);
    }
  }
  async function commit() {
    const actual = await client.get(`${prefix}/git/commits/${source.sourceSha}`);
    if (actual.sha !== source.sourceSha || !isRecord(actual.tree) || actual.tree.sha !== source.treeSha) {
      return workflowFailure(`${code}-commit`,
        `The actual ${kind === 'code-scanning' ? 'analysis' : 'scan-history'} source commit/tree differs from the exact immutable subject.`);
    }
  }
  async function branch() {
    const actual = await client.get(`${prefix}/git/ref/heads/${source.ref}`);
    if (actual.ref !== ref || !isRecord(actual.object) || actual.object.type !== 'commit' || actual.object.sha !== source.sourceSha) {
      return workflowFailure(`${code}-ref`, 'The actual protected-family ref does not name the selected exact source commit.');
    }
  }
  return {
    context, runtime, source, client, prefix, ref,
    async before() { await repository(); await commit(); await branch(); },
    async after() { await branch(); await commit(); await repository(); }
  };
}
