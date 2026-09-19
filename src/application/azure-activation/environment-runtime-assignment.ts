import { GitHubActivationClient } from '../../adapters/github/activation-rest.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import { clientFor } from '../../governance-activation/github-config.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import { assertGitHubPhaseAuthority } from '../repository-governance/workflow-authority.js';
import { environmentRuntimeInputs, type EnvironmentRuntimeInputs } from './environment-runtime-inputs.js';
import { requireQualificationEvidence } from './qualification-evidence.js';
import {
  qualificationFailure, qualificationObject, qualificationText, qualificationTimestamp
} from './qualification-authority.js';
import {
  verifyPrivateRunnerAssignment, type PrivateRunnerAssignmentObservation
} from './private-runner-assignment.js';

export function environmentRuntimeRunnerReadEffects(
  config: Pick<EnvironmentRuntimeInputs, 'runnerAssignment'>
): NonNullable<TransitionOperation['effects']> {
  const binding = config.runnerAssignment.binding;
  const root = `/orgs/${binding.organization}`;
  const group = `${root}/actions/runner-groups/${binding.groupId}`;
  return [
    `/repos/${binding.repository}`, root, group, `${group}/repositories`,
    `${root}/settings/network-configurations/${binding.networkConfigurationId}`,
    `${root}/settings/network-settings/${binding.networkSettingsId}`,
    `${group}/hosted-runners`, `${group}/runners`,
    `${root}/actions/hosted-runners/${binding.definitionId}`
  ].map((resource) => ({
    mutationClass: 'github-read', remote: true, destructive: false,
    destination: { type: 'external', identity: `https://api.github.com${resource}`, repository: binding.repository }
  }));
}

function assertReferencedAssignment(input: PhaseAdapterExecutionInput, config: EnvironmentRuntimeInputs): void {
  const { record, plan } = requireQualificationEvidence(
    input.inspection, 'runner-ready', config.runnerAssignment.reference, input.clock?.() ?? input.now
  );
  const payload = record.payload;
  const declarations = plan.operations.filter((operation) =>
    ['github.runner.ensure-ready', 'github.runner.reachability-dispatch'].includes(operation.actionId))
    .map((operation) => operation.inputs.plan);
  const declared = declarations[0];
  const expectedSource = {
    schemaVersion: 1, kind: 'environment-runtime', repository: config.workflow.repository,
    repositoryId: config.workflow.repositoryId, workflowId: config.workflow.workflowId,
    workflowDigest: config.workflow.workflowDigest, sourceSha: config.workflow.producerSourceSha,
    ref: config.workflow.ref, actorId: config.workflow.actorId, recipe: config.runtime.recipe
  };
  if (!isRecord(payload) || payload.kind !== 'runner-ready.v1' ||
    !['network-reachability-only', 'workflow-assignment-only'].includes(String(payload.scope)) ||
    !isRecord(payload.assignment) || payload.assignment.kind !== 'private-runner-assignment-readback/1' ||
    canonicalSha256(payload.assignment.binding) !== canonicalSha256(config.runnerAssignment.binding) ||
    !isRecord(declared) || declarations.some((value) => canonicalSha256(value) !== canonicalSha256(declared)) ||
    !Array.isArray(declared.applicationSources) ||
    declared.applicationSources.filter((source) => canonicalSha256(source) === canonicalSha256(expectedSource)).length !== 1) {
    qualificationFailure('environment-runner-reference', 'The exact authoritative original runner receipt and reviewed source declaration must bind this same assignment. Current group names, source-list presence or a substituted public reference are not creation custody.');
  }
}

/** Control/fleet readback only; the artifact reader independently admits both verifier sources and the actual job. */
export async function readEnvironmentRuntimeRunnerAssignment(
  input: PhaseAdapterExecutionInput, dispatch: TransitionOperation
): Promise<PrivateRunnerAssignmentObservation> {
  const config = environmentRuntimeInputs(dispatch.inputs);
  const digest = canonicalSha256(config);
  const effects = environmentRuntimeRunnerReadEffects(config);
  const authorize = async () => {
    if (canonicalSha256(environmentRuntimeInputs(dispatch.inputs)) !== digest ||
      effects.some((required) => dispatch.effects?.filter((effect) =>
        canonicalSha256(effect) === canonicalSha256(required)).length !== 1)) {
      qualificationFailure('environment-runner-read-authority', 'Each exact runner assignment GET resource requires its own current reviewed GitHub-read effect. Repository-only or original creation authority cannot authorize these reads.');
    }
    await assertGitHubPhaseAuthority(input, dispatch);
  };
  await authorize();
  assertReferencedAssignment(input, config);
  const allowed = new Set(effects.map((effect) => effect.destination.identity));
  const base = clientFor(input);
  const client = new GitHubActivationClient({ async request(request) {
    const url = new URL(request.path, 'https://api.github.com');
    const parameters = [...url.searchParams];
    if (request.method !== 'GET' || request.body !== undefined || request.binary ||
      url.origin !== 'https://api.github.com' || url.username || url.password || url.hash ||
      !allowed.has(`${url.origin}${url.pathname}`) ||
      new Set(parameters.map(([name]) => name)).size !== parameters.length ||
      parameters.some(([name, value]) =>
        !['page', 'per_page'].includes(name) || !/^[1-9][0-9]{0,2}$/u.test(value) || Number(value) > 100)) {
      qualificationFailure('environment-runner-read-scope', 'Assignment observation permits only its exact bounded approved GitHub GET resources; no mutation, alternate host or broader fleet lookup is allowed.');
    }
    await authorize();
    return base.transport.request(request);
  } });
  return verifyPrivateRunnerAssignment(client, config.runnerAssignment.binding, {
    authorize: async () => { await authorize(); assertReferencedAssignment(input, config); },
    now: () => input.clock?.() ?? input.now
  });
}

/** Decoding alone is not private custody or authority; the immutable producer witness must commit these observations. */
export function environmentRuntimeAssignmentObservation(
  value: unknown, config: Pick<EnvironmentRuntimeInputs, 'runnerAssignment'>
): PrivateRunnerAssignmentObservation {
  const data = qualificationObject(value, ['kind', 'binding', 'requestIds', 'sources', 'job', 'observedAt'], 'Original runner control observation');
  if (data.kind !== 'private-runner-assignment-readback/1' ||
    canonicalSha256(data.binding) !== canonicalSha256(config.runnerAssignment.binding) ||
    !Array.isArray(data.requestIds) || data.requestIds.length < 9 || data.requestIds.length > 64 ||
    canonicalSha256(data.sources) !== canonicalSha256([]) || data.job !== null) {
    qualificationFailure('environment-runner-observation', 'The original control-only observation must bind the exact reviewed repository, group, network and hosted definition. It cannot replace independent source/job evidence.');
  }
  const requestIds = data.requestIds.map((value) => qualificationText(value, 'Actual GitHub assignment readback request'));
  if (requestIds.some((value) => !/^[A-Fa-f0-9]{4}:[A-Fa-f0-9:]{4,100}$/u.test(value)) ||
    new Set(requestIds).size !== requestIds.length) {
    qualificationFailure('environment-runner-observation', 'Actual distinct provider-issued request identities are required for assignment control readback.');
  }
  return {
    kind: 'private-runner-assignment-readback/1', binding: structuredClone(config.runnerAssignment.binding),
    requestIds, sources: [], job: null, observedAt: qualificationTimestamp(data.observedAt, 'Original runner assignment readback time')
  };
}
