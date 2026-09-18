import {
  AzureApplicationProvisioningClient, SHA256_DIGEST_PATTERN
} from '../../adapters/azure/application-provisioning.js';
import { AzureArmError } from '../../adapters/azure/activation-rest.js';
import { sanitizeAzureOutput } from '../../adapters/azure/production-adapter.js';
import { readApplicationRegistryManifest } from '../../adapters/azure/application-registry.js';
import {
  dispatchApprovedWorkflowRun, readBoundWorkflowRun, readBoundWorkflowArtifact, WorkflowDispatchReadbackPendingError
} from '../../adapters/github/production-checks.js';
import { readbackWorkflowContent } from '../../adapters/github/production-workflows.js';
import { decodeWorkflow } from '../../adapters/github/workflow-check-recipes.js';
import { GitHubActivationClient, GitHubActivationError, object, positiveId } from '../../adapters/github/activation-rest.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { ExternalOperationState, LiveReadbackProof, PhaseOutputBindings, TransitionOperation } from '../../domain/governance/activation/types.js';
import { clientFor } from '../../governance-activation/github-config.js';
import { githubPorts } from '../../governance-activation/github-ports.js';
import { readbackProof } from '../../governance-activation/transition-records.js';
import type {
  PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput
} from '../../governance-activation/transition-ports.js';
import { assertGitHubPhaseAuthority } from '../repository-governance/workflow-authority.js';
import { readWorkflowEffect, type WorkflowEffectCheckpoints } from '../repository-governance/workflow-checkpoints.js';
import { assertAzurePhaseAuthority, AzureActivationAdmissionError } from './authority.js';
import {
  applicationArtifactInputs, applicationArtifactOperations, defaultAzureArmTransport,
  type ApplicationArtifactInputs, type ApplicationArtifactRole
} from './application-artifact-inputs.js';
import { readApplicationBuildArchive, validateApplicationBuildReport } from './application-build-report.js';
import {
  applicationArtifactSetDigest, applicationArtifactSetInputs, applicationArtifactSetRole,
  assertApplicationArtifactSetOperations, artifactSetAssert,
  type ApplicationArtifactRoleEvidence, type ApplicationArtifactRoleInputs, type ApplicationArtifactSetInputs
} from './application-artifact-set.js';
import { assertApplicationBuildWorkflowSource } from './application-build-workflow.js';

export { SHA256_DIGEST_PATTERN };

export function planApplicationArtifactReady(input: PhasePlanningInput): PhasePlanBuild {
  try { return { operations: applicationArtifactOperations(applicationArtifactInputs(input)) }; }
  catch (error) {
    if (!(error instanceof AzureActivationAdmissionError) && !(error instanceof AzureArmError) && !(error instanceof GitHubActivationError)) throw error;
    return { operations: [], blockers: [error.message] };
  }
}

function assertApplicationOperations(input: PhaseAdapterExecutionInput, config: ApplicationArtifactInputs) {
  const operations = applicationArtifactOperations(config);
  const external = input.plan.operations.filter((operation) => operation.remote);
  if (external.length !== operations.length || operations.some((expected) =>
    external.filter((operation) => canonicalSha256(operation) === canonicalSha256(expected)).length !== 1)) {
    throw new AzureActivationAdmissionError('application-plan',
      'Application build requires exactly its source/actor/target-bound GitHub dispatch and Azure image readback operations; generic flags are not effect authority.');
  }
  return operations;
}

async function assertBuildWorkflow(
  client: GitHubActivationClient, config: ApplicationArtifactInputs, selection?: ApplicationArtifactRoleInputs
): Promise<void> {
  const source = await readbackWorkflowContent(client, config.workflow.repository, config.workflow.workflowPath, config.workflow.sourceSha);
  if (source.digest !== config.workflow.workflowDigest) throw new GitHubActivationError('application-workflow-source', 'Application workflow source changed after review.');
  if (selection) assertApplicationBuildWorkflowSource(source.content, selection.build);
  const document = decodeWorkflow(source.content);
  const restrictedPermissions = (value: unknown) => {
    const permissions = object(value, 'Explicit application workflow permissions');
    return permissions.contents === 'read' && Object.entries(permissions).every(([name, permission]) =>
      name === 'contents' && permission === 'read' || name === 'actions' && permission === 'read' ||
      name === 'id-token' && permission === 'write' || permission === 'none');
  };
  const cancelsExisting = (value: unknown) => value !== undefined && (
    typeof value !== 'object' || value === null ||
    object(value)['cancel-in-progress'] !== false
  );
  const jobs = Object.entries(object(document.jobs, 'Actual application workflow jobs'));
  const names = jobs.map(([id, value]) => object(value).name ?? id);
  if (!restrictedPermissions(document.permissions) || cancelsExisting(document.concurrency) ||
    jobs.length !== config.workflow.expectedJobs.length ||
    config.workflow.expectedJobs.some((name) => names.filter((entry) => entry === name).length !== 1) ||
    jobs.some(([, value]) => {
      const job = object(value);
      return Object.hasOwn(job, 'uses') || Object.hasOwn(job, 'strategy') || Object.hasOwn(job, 'environment') ||
        job.permissions !== undefined && !restrictedPermissions(job.permissions) || cancelsExisting(job.concurrency) ||
        !Number.isSafeInteger(job['timeout-minutes']) ||
        Number(job['timeout-minutes']) < 1 || Number(job['timeout-minutes']) > config.maxRunMinutes;
    })) {
    throw new GitHubActivationError('application-workflow-time',
      'Every actual build job must match the reviewed inventory, restricted token permissions and explicit time ceiling; matrices, reusable/environment-bound jobs and cancellation of other operations are not admitted.');
  }
}

function checkpointIdentity(config: ApplicationArtifactInputs) {
  return {
    repositoryId: config.workflow.repositoryId, ref: `${config.workflow.ref}:${config.workflow.workflowId}`,
    purpose: 'workflow-dispatch' as const, step: 'dispatch' as const
  };
}

function checkpointOutputs(
  records: WorkflowEffectCheckpoints | null, operation?: ExternalOperationState, unreadable = false, unresolved = false
): PhaseOutputBindings {
  const rejected = records?.response && [401, 403, 404, 422].includes(records.response.status) && !records.observed;
  return {
    values: {
      'application.artifact.status': unreadable ? 'unresolved-private-checkpoint' :
        rejected ? 'rejected-awaiting-reviewed-recovery' :
          records ? operation ? 'provider-operation-recorded' : 'submission-uncertain' :
          operation || unresolved ? 'recorded-execution-unresolved' : 'not-dispatched',
      'application.artifact.checkpointDigest': records ? canonicalSha256(records.prepared) : null,
      'application.artifact.providerRequestId': records?.response?.requestId ?? null,
      'application.artifact.responseRunId': records?.response?.providerId ?? null,
      'application.artifact.runId': operation?.operationId ?? null
    },
    resources: operation ? [{ provider: 'github', resourceType: 'workflow-run', resourceId: operation.resourceId }] : []
  };
}

function observedCheckpointOperation(
  config: ApplicationArtifactInputs, dispatch: TransitionOperation, records: WorkflowEffectCheckpoints | null,
  observedAt: string
): ExternalOperationState | undefined {
  if (!records?.observed) return undefined;
  const id = positiveId(Number(records.observed.providerId), 'Observed application build run ID');
  const resourceId = `/repos/${config.workflow.repository}/actions/runs/${id}`;
  if (records.observed.resourceId !== resourceId) throw new GitHubActivationError('application-checkpoint', 'Observed application build checkpoint names a different provider resource.');
  return {
    provider: 'github', actionId: dispatch.actionId, operationId: String(id), resourceId,
    startedAt: records.prepared.preparedAt, observedAt, status: 'running', planDigest: records.prepared.planDigest
  };
}

export interface ApplicationArtifactRoleResult {
  status: 'completed' | 'pending' | 'blocked';
  operation?: ExternalOperationState;
  completedOperations: readonly TransitionOperation[];
  blocker?: string;
  cleanupWarnings?: readonly string[];
  progress?: PhaseOutputBindings;
  readbacks?: readonly LiveReadbackProof[];
}

const roleObservations = new WeakMap<object, { digest: string; evidence: ApplicationArtifactRoleEvidence }>();

/** Only the concrete selection executor can issue this observation; supplied success objects cannot. */
export function readApplicationArtifactRoleObservation(outcome: ApplicationArtifactRoleResult): ApplicationArtifactRoleEvidence {
  const observed = roleObservations.get(outcome);
  artifactSetAssert(observed && observed.digest === canonicalSha256(outcome), 'concrete-observation',
    'A role requires the unmodified result of the actual source/run/artifact/registry executor, not a supplied success receipt.');
  return structuredClone(observed.evidence);
}

export function executeApplicationArtifactReady(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  return executeApplicationArtifactSelection(input);
}

/** Selects from the original whole set plan. No per-role phase, configuration or approval is fabricated. */
export async function executeApplicationArtifactRole(
  input: PhaseAdapterExecutionInput, role: ApplicationArtifactRole
): Promise<ApplicationArtifactRoleResult> {
  const outcome = await executeApplicationArtifactSelection(input, role);
  const result: ApplicationArtifactRoleResult = {
    status: outcome.status === 'completed' ? 'completed' : outcome.status === 'pending' ? 'pending' : 'blocked',
    completedOperations: outcome.completedOperations ?? [],
    ...(outcome.operation ? { operation: outcome.operation } : {}),
    ...(outcome.blocker ? { blocker: outcome.blocker } : {}),
    ...(outcome.cleanupWarnings ? { cleanupWarnings: outcome.cleanupWarnings } : {}),
    ...(outcome.status === 'completed' ? { readbacks: outcome.liveReadback } : { progress: outcome.outputs })
  };
  const observation = roleObservations.get(outcome);
  if (observation && observation.digest === canonicalSha256(outcome)) {
    roleObservations.set(result, { digest: canonicalSha256(result), evidence: observation.evidence });
  }
  return result;
}

async function executeApplicationArtifactSelection(
  input: PhaseAdapterExecutionInput, role?: ApplicationArtifactRole
): Promise<PhaseAdapterOutcome> {
  let config: ApplicationArtifactInputs | undefined;
  let set: ApplicationArtifactSetInputs | undefined;
  let selection: ApplicationArtifactRoleInputs | undefined;
  let dispatch: TransitionOperation | undefined;
  let execution = input;
  const previous = input.inspection.state.phases['application-artifact-ready'];
  let operation = role === undefined && input.phase.id === 'application-artifact-ready' && previous?.operation &&
    input.plan.operations.some((entry) => entry.actionId === previous.operation!.actionId)
    ? structuredClone(previous.operation) : undefined;
  let dispatchAttempted = false;
  const completedOperations: TransitionOperation[] = [];
  try {
    if (role === undefined) config = applicationArtifactInputs(input);
    else {
      set = applicationArtifactSetInputs(input);
      selection = applicationArtifactSetRole(set, role);
      config = selection.application;
    }
    const selected = set ? assertApplicationArtifactSetOperations(input, set).filter((entry) =>
      object(entry.inputs.artifactSet).role === role) : assertApplicationOperations(input, config);
    dispatch = selected[0]!;
    const readback = selected[1]!;
    const expectedDigest = set ? applicationArtifactSetDigest(set) : canonicalSha256(config);
    const originalPlan = canonicalSha256(input.plan);
    const assertCurrent = async () => {
      if (set) artifactSetAssert(canonicalSha256(input.plan) === originalPlan, 'original-plan',
        'A selected role cannot change the original whole reviewed plan or its approval while effects are in progress.');
      if ((set ? applicationArtifactSetDigest(applicationArtifactSetInputs(input)) : canonicalSha256(applicationArtifactInputs(input))) !== expectedDigest) {
        throw new AzureActivationAdmissionError('application-input-drift', 'Application source, target or actor inputs changed after exact approval.');
      }
      if (set) {
        for (const operation of assertApplicationArtifactSetOperations(input, set)) {
          if (operation.adapter === 'github') await assertGitHubPhaseAuthority(input, operation);
          else await assertAzurePhaseAuthority(input, operation);
        }
      } else {
        assertApplicationOperations(input, config!);
        await assertGitHubPhaseAuthority(input, dispatch!);
        await assertAzurePhaseAuthority(input, readback);
      }
    };
    await assertCurrent();
    const existing = await readWorkflowEffect(input, dispatch, checkpointIdentity(config), {
      workflow: config.workflow, dispatchInputs: config.dispatchInputs
    });
    if (role !== undefined && previous.operation) {
      const recorded = existing?.observed ?? (existing?.response?.status === 200 ? existing.response : null);
      if (recorded?.providerId === previous.operation.operationId && recorded.resourceId === previous.operation.resourceId &&
        existing?.prepared.planDigest === previous.operation.planDigest) operation = structuredClone(previous.operation);
    }
    if (role === undefined && previous.operation && (!existing?.observed || existing.observed.providerId !== previous.operation.operationId ||
      existing.observed.resourceId !== previous.operation.resourceId) ||
      (input.recovery || input.plan.recovery) && !existing) {
      throw new GitHubActivationError('application-recovery-checkpoint',
        'The recorded application execution has no matching original private dispatch checkpoint. Preserve its operation and recover that exact record; no replacement dispatch is authorized.');
    }
    const baseGitHub = clientFor(input);
    const transport = {
      async request(request: Parameters<typeof baseGitHub.transport.request>[0]) {
        await assertCurrent();
        return baseGitHub.transport.request(request);
      }
    };
    execution = {
      ...input, adapters: { ...input.adapters, githubActivation: { ...githubPorts(input), transport } }
    };
    const client = new GitHubActivationClient(transport);
    const arm = defaultAzureArmTransport(input);
    const azure = new AzureApplicationProvisioningClient({
      async request(request, binding) {
        await assertCurrent();
        return arm.request(request, binding);
      }
    }, config.azure);
    const registry = await azure.getAcr(config.resourceGroup, config.acrName);
    if (registry.provisioningState !== 'Succeeded' || registry.location !== config.region || registry.adminUserEnabled ||
      selection && registry.loginServer !== selection.build.registry.loginServer) {
      throw new AzureActivationAdmissionError('application-registry', 'The exact configured registry must be provisioned in the approved region with admin credentials disabled.');
    }
    await assertBuildWorkflow(client, config, selection);
    let treeSha: string | undefined;
    if (set) {
      const commit = await client.get(`/repos/${set.source.repository}/git/commits/${set.source.sourceSha}`);
      const tree = object(commit.tree);
      artifactSetAssert(commit.sha === set.source.sourceSha && typeof tree.sha === 'string' && /^[a-f0-9]{40}$/u.test(tree.sha),
        'source-commit', 'The common application source requires its actual immutable Git commit and tree, not a caller-supplied subject.');
      treeSha = tree.sha;
    }
    dispatchAttempted = true;
    const dispatched = await dispatchApprovedWorkflowRun(execution, dispatch, config.workflow, config.dispatchInputs);
    operation = dispatched.operation;
    completedOperations.push(dispatch);
    if (dispatched.status === 'pending') {
      return {
        status: 'pending', operation, completedOperations,
        blocker: `Application build run ${operation.operationId} is pending; resume its exact recorded run without redispatch.`,
        outputs: checkpointOutputs(await readWorkflowEffect(execution, dispatch, checkpointIdentity(config), {
          workflow: config.workflow, dispatchInputs: config.dispatchInputs
        }), operation)
      };
    }
    if (dispatched.run.conclusion !== 'success') {
      throw new GitHubActivationError('application-build-failed', 'The recorded application build failed; its dispatch remains recorded and is not permission to launch a replacement.');
    }
    const run = await readBoundWorkflowRun(client, config.workflow, operation);
    const artifacts = await client.list(`${operation.resourceId}/artifacts`, 'artifacts');
    const matches = artifacts.filter((artifact) => artifact.name === config!.artifactName);
    if (matches.length !== 1) throw new GitHubActivationError('application-artifact-ambiguous', 'The exact build run must contain one uniquely named provenance artifact; no latest or first artifact is adopted.');
    const artifact = await readBoundWorkflowArtifact({
      client, binding: config.workflow, operation, artifactId: positiveId(matches[0]!.id),
      name: config.artifactName
    });
    let built;
    try {
      built = validateApplicationBuildReport(readApplicationBuildArchive(artifact.archive), config, {
        runId: run.runId, jobs: run.jobs, loginServer: registry.loginServer
      });
    } finally { artifact.archive.fill(0); }
    await assertCurrent();
    const confirmedRegistry = await azure.getAcr(config.resourceGroup, config.acrName);
    if (canonicalSha256({
      id: confirmedRegistry.id.toLowerCase(), host: confirmedRegistry.loginServer, location: confirmedRegistry.location,
      state: confirmedRegistry.provisioningState, admin: confirmedRegistry.adminUserEnabled
    }) !== canonicalSha256({
      id: registry.id.toLowerCase(), host: registry.loginServer, location: registry.location,
      state: registry.provisioningState, admin: registry.adminUserEnabled
    })) throw new AzureActivationAdmissionError('application-registry-drift', 'The registry identity or settings changed during the exact build.');
    await assertCurrent();
    const manifest = await readApplicationRegistryManifest({
      runner: input.runner, projectRoot: input.inspection.projectRoot, binding: config.azure,
      loginServer: confirmedRegistry.loginServer, repository: config.imageName, digest: built.digest,
      beforeAccess: assertCurrent, now: () => (input.clock?.() ?? input.now).getTime()
    });
    await assertCurrent();
    completedOperations.push(readback);
    const outcome: PhaseAdapterOutcome = {
      status: 'completed', resultState: 'verified', operation, completedOperations,
      evidencePayload: {
        kind: 'application-artifact-ready.v1', repository: config.imageName, digest: built.digest,
        imageRef: built.imageRef, sourceCommitSha: built.sourceSha, buildRunId: built.runId,
        workflow: config.workflow, provenance: built,
        artifact: { id: artifact.artifactId, name: artifact.name, digest: artifact.digest }
      },
      liveReadback: [
        readbackProof(input, 'github', 'workflow-run', operation.resourceId, {
          runId: built.runId, attempt: built.runAttempt, actorId: built.actorId, jobId: built.jobId, sourceSha: built.sourceSha,
          workflowDigest: config.workflow.workflowDigest, artifactId: artifact.artifactId, artifactDigest: artifact.digest
        }),
        readbackProof(input, 'azure', 'containerRegistry', confirmedRegistry.id, {
          requestId: confirmedRegistry.requestId, manifestRequestId: manifest.requestId,
          repository: config.imageName, digest: manifest.digest, imageRef: built.imageRef,
          ...(selection ? { configDigest: built.configDigest, role: selection.role } : {})
        }),
        ...(selection ? [
          readbackProof(input, 'github', 'artifact', `/repos/${config.workflow.repository}/actions/artifacts/${artifact.artifactId}`, {
            id: artifact.artifactId, name: artifact.name, digest: artifact.digest, runId: run.runId, role: selection.role
          }),
          readbackProof(input, 'github', 'git-commit', `/repos/${config.workflow.repository}/git/commits/${config.workflow.sourceSha}`, {
            sourceSha: config.workflow.sourceSha, treeSha, repositoryId: config.workflow.repositoryId
          })
        ] : [])
      ],
      outputs: {
        values: {
          'azure.artifact.digest': built.digest, 'azure.artifact.imageRef': built.imageRef,
          'azure.artifact.repository': config.imageName, 'azure.artifact.buildRunId': built.runId,
          'azure.artifact.sourceSha': built.sourceSha, 'azure.artifact.configDigest': built.configDigest,
          'github.artifact.id': artifact.artifactId, 'github.artifact.digest': artifact.digest
        },
        resources: [
          { provider: 'azure', resourceType: 'containerRegistry', resourceId: confirmedRegistry.id },
          { provider: 'github', resourceType: 'workflow-run', resourceId: operation.resourceId },
          { provider: 'github', resourceType: 'artifact', resourceId: `/repos/${config.workflow.repository}/actions/artifacts/${artifact.artifactId}` }
        ]
      }
    };
    if (set && selection && treeSha) {
      const records = await readWorkflowEffect(execution, dispatch, checkpointIdentity(config), {
        workflow: config.workflow, dispatchInputs: config.dispatchInputs
      });
      artifactSetAssert(records?.observed && records.observed.providerId === operation.operationId &&
        records.observed.resourceId === operation.resourceId && records.prepared.planDigest === input.plan.planDigest &&
        records.prepared.approvalEnvelopeHash === input.plan.approval.envelopeHash, 'original-dispatch',
      'A role must retain the original whole-phase private issuance, exact dispatch checkpoint and provider run identity.');
      await assertCurrent();
      const evidence: ApplicationArtifactRoleEvidence = {
        role: selection.role, componentId: selection.component.id, componentDigest: canonicalSha256(selection.component),
        recipeDigest: canonicalSha256(selection.build), context: selection.build.context, dockerfile: selection.build.dockerfile,
        workflow: config.workflow, source: { ...set.source, treeSha }, provenance: built,
        artifact: { id: artifact.artifactId, name: artifact.name, digest: artifact.digest },
        dispatchCheckpointDigest: canonicalSha256(records.prepared),
        originalPlanDigest: input.plan.planDigest, originalApprovalEnvelopeHash: records.prepared.approvalEnvelopeHash
      };
      roleObservations.set(outcome, { digest: canonicalSha256(outcome), evidence });
    }
    return outcome;
  } catch (error) {
    const pendingReadback = role !== undefined && error instanceof WorkflowDispatchReadbackPendingError;
    if (pendingReadback) {
      operation = structuredClone(error.operation);
      if (dispatch && !completedOperations.length) completedOperations.push(dispatch);
    }
    const message = error instanceof AzureActivationAdmissionError || error instanceof AzureArmError || error instanceof GitHubActivationError
      ? sanitizeAzureOutput(error.message) : 'Application build failed without a verified complete outcome; inspect the retained exact private dispatch record.';
    let records: WorkflowEffectCheckpoints | null = null;
    let unreadable = false;
    const cleanupWarnings: string[] = [];
    if (config && dispatch) {
      try {
        records = await readWorkflowEffect(execution, dispatch, checkpointIdentity(config), {
          workflow: config.workflow, dispatchInputs: config.dispatchInputs
        });
        const observed = observedCheckpointOperation(config, dispatch, records, (input.clock?.() ?? input.now).toISOString());
        operation ??= observed;
        if (observed && !completedOperations.length) completedOperations.push(dispatch);
      } catch (checkpointError) {
        unreadable = true;
        cleanupWarnings.push(checkpointError instanceof Error
          ? `Private build checkpoint inspection failed: ${sanitizeAzureOutput(checkpointError.message)} Preserve the existing record; no redispatch is authorized.`
          : 'Private build checkpoint inspection failed; preserve the existing record and do not redispatch.');
      }
    }
    const outputs = checkpointOutputs(records, operation, unreadable,
      dispatchAttempted || Boolean(input.recovery || input.plan.recovery || previous?.operation || previous?.executionPlanDigest));
    const retained = records ? ` Private dispatch checkpoint ${canonicalSha256(records.prepared)} is retained; recovery may only observe the exact submitted effect.` : '';
    return {
      status: 'blocked', blocker: `${message}${retained}`, completedOperations, cleanupWarnings, outputs,
      ...(operation ? { operation } : {})
    };
  }
}
