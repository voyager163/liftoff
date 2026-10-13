import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { latestRecordWithPayload } from '../domain/governance/activation/evidence.js';
import { outputBindingsMatch, outputResourcesMatch } from '../domain/governance/activation/source-values.js';
import type { ExternalOperationState, LiveReadbackProof, PhaseOutputBindings } from '../domain/governance/activation/types.js';
import type {
  GovernanceTransitionInspection, PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanningInput
} from './transition-ports.js';
import { positiveId } from '../adapters/github/activation-rest.js';
import {
  clientFor, digest, ownedPath, repositoryConfiguration, sourceSha, verifiedOutput
} from './github-config.js';
import {
  activationInputPathIsObserved, isSensitiveActivationPath
} from './inputs.js';
import {
  applicationBudget, applicationConfiguration, applicationDeadlineInput, applicationDispatchPlan, applicationError,
  applicationText, assertApplicationAuthority, assertApplicationProgressPorts, isApplicationProviderError, observeApplicationProtection
} from './application-readiness.js';
import {
  applicationPrerequisiteBinding, observeApplicationPrerequisites
} from './application-prerequisites.js';
import { runnerBinding } from './runner-readiness.js';
import { azureObject, runAzureJson } from './azure-discovery.js';
import { applicationReadbackProof as readbackProof } from './application-readiness.js';
import { inspectAzureDeploymentOwnership } from './azure-deployment-ownership.js';

export interface VerifiedApplicationArtifact {
  sourceSha: string;
  workflowDigest: string;
  workflowRunId: number;
  workflowJobId: number;
  acrRunId: string;
  environment: string;
  registryResourceId: string;
  imageRepository: string;
  digest: string;
  immutableImage: string;
  artifactBindingDigest: string;
  attestationVerificationDigest: string;
}

export function readVerifiedApplicationArtifact(inspection: GovernanceTransitionInspection): VerifiedApplicationArtifact {
  const evidence = latestRecordWithPayload(inspection, 'application-artifact-ready');
  const output = inspection.state.phaseOutputs?.['application-artifact-ready'];
  if (inspection.state.phases['application-artifact-ready'].state !== 'verified' || !evidence || !output ||
    !outputBindingsMatch(evidence, 'application-artifact-ready', inspection.state.phases['application-artifact-ready'].evidence, output) ||
    !outputResourcesMatch(output, evidence) || !isRecord(evidence.payload) ||
    evidence.payload.kind !== 'application-artifact-ready.v1' || evidence.payload.deploymentPerformed !== false) {
    return applicationError('application-artifact-unverified', 'Deployment preparation requires current authoritative immutable publication evidence, not a tag, bootstrap image or injected success placeholder.');
  }
  const payload = evidence.payload;
  const sha = sourceSha(payload.sourceSha);
  const workflowDigest = applicationText(payload.workflowDigest, /^[a-f0-9]{64}$/u, 'Published workflow byte digest');
  const imageDigest = digest(payload.artifactDigest);
  const registryResourceId = applicationText(payload.registryResourceId,
    /^\/subscriptions\/[a-f0-9-]+\/resourceGroups\/[A-Za-z0-9_.()-]+\/providers\/Microsoft\.ContainerRegistry\/registries\/[a-z0-9]+$/u,
    'Published canonical registry resource ID');
  const environment = applicationText(output.values.environment, /^(?:dev|staging|prod)$/u, 'Published declared environment');
  const imageRepository = applicationText(output.values.imageRepository, /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u, 'Published image repository');
  const loginServer = verifiedOutput(inspection, 'application-prerequisites-ready', 'loginServer');
  const immutableImage = `${loginServer}/${imageRepository}@${imageDigest}`;
  const expected = inspection.activationInputs?.phases['application-artifact-ready'] ??
    inspection.state.activationInputs?.phases['application-artifact-ready'];
  const prerequisiteConfiguration = (inspection.activationInputs ?? inspection.state.activationInputs)?.phases['application-prerequisites-ready'];
  if (payload.immutableImage !== immutableImage || output.values.immutableImage !== immutableImage ||
    output.values.artifactDigest !== imageDigest || output.values.registryResourceId !== registryResourceId ||
    expected?.sourceSha !== sha || expected.workflowDigest !== workflowDigest ||
    expected.imageRepository !== imageRepository ||
    environment !== prerequisiteConfiguration?.environment ||
    registryResourceId !== verifiedOutput(inspection, 'application-prerequisites-ready', 'registryResourceId') ||
    !output.resources.some((resource) => resource.provider === 'azure' &&
      resource.resourceId === `${registryResourceId}/repositories/${imageRepository}@${imageDigest}`)) {
    return applicationError('application-artifact-mismatch', 'The authoritative published source, recipe, registry, environment or immutable digest differs; deployment cannot consume it.');
  }
  return {
    sourceSha: sha, workflowDigest, workflowRunId: positiveId(payload.workflowRunId), workflowJobId: positiveId(payload.workflowJobId),
    acrRunId: applicationText(payload.acrRunId, /^[a-z0-9]{1,32}$/u, 'Actual ACR publication run ID'),
    environment, registryResourceId, imageRepository, digest: imageDigest, immutableImage,
    artifactBindingDigest: applicationText(payload.artifactBindingDigest, /^[a-f0-9]{64}$/u, 'Published artifact binding'),
    attestationVerificationDigest: applicationText(payload.attestationVerificationDigest, /^[a-f0-9]{64}$/u, 'Actual attestation verification digest')
  };
}

export function applicationArtifactBinding(input: PhasePlanningInput | PhaseAdapterExecutionInput) {
  const config = applicationConfiguration(input, 'application-artifact-ready', [
    'sourceSha', 'workflowPath', 'workflowDigest', 'contextPath', 'dockerfilePath', 'imageRepository',
    'sourceTransmissionApproved', 'dependencyNetworkApproved', 'buildExecutionApproved'
  ]);
  if (config.sourceTransmissionApproved !== true || config.dependencyNetworkApproved !== true ||
    config.buildExecutionApproved !== true) {
    return applicationError('application-build-consent',
      'Source transmission, dependency/network access and build execution each require explicit consent in the separately reviewed artifact plan; resource approval is not build consent.');
  }
  const prerequisites = applicationPrerequisiteBinding(input);
  if (verifiedOutput(input.inspection, 'application-prerequisites-ready', 'prerequisiteBindingDigest') !== prerequisites.bindingDigest) {
    return applicationError('application-prerequisites-stale', 'Application artifact planning requires current exact verified registry/identity prerequisites.');
  }
  const workflowPath = ownedPath(config.workflowPath, 'Artifact workflow path');
  const contextPath = ownedPath(config.contextPath, 'Artifact context path');
  const dockerfilePath = ownedPath(config.dockerfilePath, 'Artifact Dockerfile path');
  if (!/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/u.test(workflowPath) ||
    !activationInputPathIsObserved([...contextPath.split('/'), 'Dockerfile']) ||
    !dockerfilePath.startsWith(`${contextPath}/`) ||
    !activationInputPathIsObserved(dockerfilePath.split('/')) ||
    [contextPath, dockerfilePath, workflowPath].some((value) =>
      isSensitiveActivationPath(value.split('/'), input.inspection.sensitivePathExclusions ?? []))) {
    return applicationError('application-source-scope', 'Artifact recipes must select one observed non-sensitive source context, its Dockerfile and one explicit committed workflow.');
  }
  const repository = repositoryConfiguration(input.inspection);
  const runner = runnerBinding(input);
  const binding = {
    repository: repository.name,
    repositoryId: positiveId(verifiedOutput(input.inspection, 'phase-0-complete', 'repositoryId')),
    ref: repository.defaultBranch, sourceSha: sourceSha(config.sourceSha),
    workflowPath, workflowDigest: applicationText(config.workflowDigest, /^[a-f0-9]{64}$/u, 'Reviewed raw workflow byte digest'),
    contextPath, dockerfilePath,
    imageRepository: applicationText(config.imageRepository, /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u, 'Application image repository'),
    environment: prerequisites.environment, registryId: prerequisites.registryId, registryName: prerequisites.registryName,
    loginServer: applicationText(verifiedOutput(input.inspection, 'application-prerequisites-ready', 'loginServer'),
      /^[a-z0-9]+(?:-[a-z0-9]+)?\.azurecr\.io$/u, 'Verified registry login server'),
    subscriptionId: prerequisites.subscriptionId, tenantId: prerequisites.tenantId,
    principalId: prerequisites.principalId, clientId: prerequisites.principalAppId,
    prerequisiteBindingDigest: prerequisites.bindingDigest,
    backendBindingDigest: prerequisites.backendBindingDigest, runnerBindingDigest: runner.bindingDigest,
    runnerGroupName: runner.runnerGroupName, runnerLabel: runner.label,
    runnerId: positiveId(verifiedOutput(input.inspection, 'runner-ready', 'runnerId')),
    runnerGroupId: positiveId(verifiedOutput(input.inspection, 'runner-ready', 'groupId')),
    networkConfigurationId: verifiedOutput(input.inspection, 'runner-ready', 'networkConfigurationId'),
    budget: applicationBudget(input),
    sourceTransmissionApproved: true, dependencyNetworkApproved: true, buildExecutionApproved: true
  };
  const bindingDigest = canonicalSha256(binding);
  return { ...binding, bindingDigest, tag: `liftoff-${binding.environment}-${bindingDigest}`,
    runTitle: `Liftoff application artifact ${bindingDigest}` };
}

export function applicationArtifactPlanInputs(input: PhasePlanningInput | PhaseAdapterExecutionInput) {
  return { ...applicationArtifactBinding(input), deploymentPerformed: false, acceptsTagOnly: false };
}

export type ApplicationArtifactBinding = ReturnType<typeof applicationArtifactBinding>;

function dispatchInputs(binding: ReturnType<typeof applicationArtifactBinding>): Record<string, string> {
  return {
    binding_digest: binding.bindingDigest, source_sha: binding.sourceSha,
    context_path: binding.contextPath, dockerfile_path: binding.dockerfilePath,
    image_repository: binding.imageRepository, image_tag: binding.tag,
    registry_id: binding.registryId, client_id: binding.clientId,
    subscription_id: binding.subscriptionId, tenant_id: binding.tenantId,
    environment: binding.environment
  };
}

async function gitText(input: PhaseAdapterExecutionInput, args: readonly string[]): Promise<string> {
  const result = await input.runner.run({ executable: 'git', args: [...args] }, {
    cwd: input.inspection.projectRoot, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024, stream: false,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' }
  });
  if (result.status !== 0 || result.timedOut || result.outputLimitExceeded || result.aborted || result.errorCode) {
    return applicationError('application-source-unobservable', 'Artifact source could not be observed within its Git deadline/byte bound; diagnostics were withheld.');
  }
  return result.stdout;
}

export async function observeApplicationSource(input: PhaseAdapterExecutionInput) {
  input = applicationDeadlineInput(input);
  const binding = applicationArtifactBinding(input);
  const head = (await gitText(input, ['rev-parse', '--verify', 'HEAD'])).trim();
  const diff = await gitText(input, ['diff', binding.sourceSha, '--', binding.contextPath, binding.workflowPath]);
  const untracked = await gitText(input, ['ls-files', '--others', '--exclude-standard', '--', binding.contextPath]);
  const tree = await gitText(input, ['ls-tree', '-r', '-z', binding.sourceSha, '--', binding.contextPath, binding.workflowPath]);
  const entries = tree.split('\0').filter(Boolean);
  if (head !== binding.sourceSha || diff || untracked || !entries.length || entries.length > 10_000 ||
    !entries.some((entry) => entry.endsWith(`\t${binding.dockerfilePath}`)) ||
    entries.some((entry) => {
      const match = entry.match(/^100(?:644|755) blob [a-f0-9]{40}\t(.+)$/u);
      return !match || !activationInputPathIsObserved(match[1]!.split('/')) ||
        isSensitiveActivationPath(match[1]!.split('/'), input.inspection.sensitivePathExclusions ?? []);
    })) {
    return applicationError('application-source-changed',
      'Artifact source differs from the approved complete commit, contains uncommitted/custom/sensitive files or unsupported symlinks/submodules; no checkout/reset or source upload was performed.');
  }
  const workflow = Buffer.from(await gitText(input, ['show', `${binding.sourceSha}:${binding.workflowPath}`]), 'utf8');
  if (!workflow.length || workflow.length > 128 * 1024 ||
    createHash('sha256').update(workflow).digest('hex') !== binding.workflowDigest) {
    return applicationError('application-recipe-changed', 'The actual local artifact workflow bytes differ from the separately reviewed immutable recipe.');
  }
  let parsed: unknown;
  try { parsed = parse(workflow.toString('utf8')); }
  catch { return applicationError('application-workflow-invalid', 'The approved artifact workflow is not valid bounded YAML.'); }
  const job = isRecord(parsed) && isRecord(parsed.jobs) ? parsed.jobs.publish : null;
  const trigger = isRecord(parsed) && isRecord(parsed.on) && isRecord(parsed.on.workflow_dispatch)
    ? parsed.on.workflow_dispatch : null;
  const inputs = trigger && isRecord(trigger.inputs) ? trigger.inputs : null;
  if (!isRecord(parsed) || !isRecord(parsed.jobs) || Object.keys(parsed.jobs).join(',') !== 'publish' ||
    parsed['run-name'] !== 'Liftoff application artifact ${{ inputs.binding_digest }}' ||
    !isRecord(parsed.concurrency) ||
    parsed.concurrency.group !== 'liftoff-application-artifact-${{ inputs.binding_digest }}' ||
    parsed.concurrency['cancel-in-progress'] !== false ||
    !isRecord(job) || job.name !== 'Liftoff application artifact' ||
    job.if !== '${{ github.sha == inputs.source_sha && github.run_attempt == 1 }}' ||
    !isRecord(job['runs-on']) || job['runs-on'].group !== binding.runnerGroupName ||
    canonicalSha256(job['runs-on'].labels) !== canonicalSha256([binding.runnerLabel]) ||
    typeof job['timeout-minutes'] !== 'number' || job['timeout-minutes'] <= 0 || job['timeout-minutes'] > 20 ||
    !inputs || canonicalSha256(Object.keys(inputs).sort()) !== canonicalSha256(Object.keys(dispatchInputs(binding)).sort()) ||
    Object.values(inputs).some((entry) => !isRecord(entry) || entry.type !== 'string' || entry.required !== true) ||
    !Array.isArray(job.steps) || job.steps.length > 30 ||
    job.steps.some((step) => !isRecord(step) || step.uses !== undefined &&
      (typeof step.uses !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[a-f0-9]{40}$/u.test(step.uses)))) {
    return applicationError('application-workflow-scope',
      'Artifact workflow must have one exact protected publish job, immutable actions, bounded timeout, exact declared inputs, and a pre-effect source/rerun guard. Workflow publication/runner admission remain separate prerequisites.');
  }
  const client = clientFor(input);
  const remote = await client.get(`/repos/${binding.repository}/contents/${binding.workflowPath}?ref=${binding.sourceSha}`);
  if (remote.type !== 'file' || remote.encoding !== 'base64' || remote.path !== binding.workflowPath ||
    typeof remote.content !== 'string' || remote.content.length > 180_000 ||
    !Buffer.from(remote.content.replace(/\s/gu, ''), 'base64').equals(workflow)) {
    return applicationError('application-remote-source', 'Independent committed workflow readback differs from the approved raw recipe; local annotations are not publication proof.');
  }
  const branch = await client.get(`/repos/${binding.repository}/git/ref/heads/${binding.ref}`);
  if (!isRecord(branch.object) || branch.object.sha !== binding.sourceSha) {
    return applicationError('application-remote-source', 'The approved remote source ref has moved; no build dispatch was permitted.');
  }
  const group = await client.get(`/orgs/${binding.repository.split('/')[0]}/actions/runner-groups/${binding.runnerGroupId}`);
  if (group.id !== binding.runnerGroupId || group.name !== binding.runnerGroupName ||
    group.network_configuration_id !== binding.networkConfigurationId || group.restricted_to_workflows !== true ||
    !Array.isArray(group.selected_workflows) ||
    !group.selected_workflows.includes(`${binding.repository}/${binding.workflowPath}@refs/heads/${binding.ref}`)) {
    return applicationError('application-runner-unready',
      'The exact private-network runner group has not admitted this artifact workflow; task13 runner admission is not inferred, broadened or rewritten by task14.');
  }
  return { binding, sourceTreeDigest: canonicalSha256(entries), workflowDigest: binding.workflowDigest };
}

function boundRun(run: Record<string, unknown>, binding: ReturnType<typeof applicationArtifactBinding>, planCreatedAt: string) {
  if (run.head_sha !== binding.sourceSha || run.head_branch !== binding.ref ||
    run.path !== binding.workflowPath || run.display_title !== binding.runTitle ||
    run.event !== 'workflow_dispatch' || run.run_attempt !== 1 ||
    !isRecord(run.repository) || run.repository.id !== binding.repositoryId ||
    typeof run.created_at !== 'string' || !Number.isFinite(Date.parse(run.created_at)) ||
    Date.parse(run.created_at) < Date.parse(planCreatedAt)) {
    return applicationError('application-run-mismatch', 'Actual artifact workflow run changed source, recipe, repository, attempt or approved invocation scope.');
  }
  return positiveId(run.id, 'Artifact workflow run ID');
}

function operationForRun(input: PhaseAdapterExecutionInput, run: Record<string, unknown>, binding: ReturnType<typeof applicationArtifactBinding>): ExternalOperationState {
  const id = boundRun(run, binding, applicationDispatchPlan(input).createdAt);
  return { provider: 'github', actionId: 'github.artifact.build-dispatch', operationId: `github-actions:${id}`,
    resourceId: `/repos/${binding.repository}/actions/runs/${id}`, pollUrl: `https://api.github.com/repos/${binding.repository}/actions/runs/${id}`,
    startedAt: String(run.created_at), observedAt: (input.clock?.() ?? input.now).toISOString(), status: 'running' };
}

function outputFor(binding: ReturnType<typeof applicationArtifactBinding>, handle: ExternalOperationState, values: PhaseOutputBindings['values'] = {}): PhaseOutputBindings {
  return { values: { artifactBindingDigest: binding.bindingDigest, sourceSha: binding.sourceSha,
    workflowDigest: binding.workflowDigest, environment: binding.environment, registryResourceId: binding.registryId,
    imageRepository: binding.imageRepository, immutableTag: binding.tag, ...values },
    resources: [{ provider: 'github', resourceType: 'workflow-run', resourceId: handle.resourceId }] };
}

export async function executeApplicationArtifactPublication(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  input = applicationDeadlineInput(input);
  let handle: ExternalOperationState | undefined;
  let outputs: PhaseOutputBindings | undefined;
  let dispatchAttempted = false;
  let currentReadback: LiveReadbackProof[] = [];
  try {
    assertApplicationProgressPorts(input);
    const binding = applicationArtifactBinding(input);
    const dispatchedPlan = applicationDispatchPlan(input);
    const dispatch = input.plan.operations.find((entry) => entry.actionId === 'github.artifact.build-dispatch');
    if (!dispatch || canonicalSha256(dispatch.inputs) !== canonicalSha256(applicationArtifactPlanInputs(input))) {
      return applicationError('application-plan-stale', 'Artifact dispatch changed exact source, recipe, destination, permission or cost.');
    }
    await assertApplicationAuthority(input, dispatch);
    await observeApplicationProtection(input);
    await observeApplicationPrerequisites(input);
    const ownership = await inspectAzureDeploymentOwnership(input);
    if (!ownership || ownership.blocker) return applicationError('application-ownership', ownership?.blocker ?? 'Application ownership proof is missing.');
    const source = await observeApplicationSource(input);
    const client = clientFor(input);
    const previous = input.inspection.state.phases[input.phase.id].operation;
    if (previous) {
      const match = previous.resourceId.match(/\/actions\/runs\/([1-9][0-9]*)$/u);
      if (!match || previous.provider !== 'github' || previous.actionId !== dispatch.actionId ||
        previous.resourceId !== `/repos/${binding.repository}/actions/runs/${match[1]}` ||
        previous.pollUrl !== `https://api.github.com${previous.resourceId}` || previous.operationId !== `github-actions:${match[1]}`) {
        return applicationError('application-operation', 'Artifact resume changed the exact dispatched workflow handle.');
      }
      handle = previous;
    } else {
      const find = async () => (await client.list(
        `/repos/${binding.repository}/actions/workflows/${binding.workflowPath.split('/').at(-1)}/runs?event=workflow_dispatch&head_sha=${binding.sourceSha}`,
        'workflow_runs'
      )).filter((run) => run.display_title === binding.runTitle);
      const existing = await find();
      if (existing.length > 1) return applicationError('application-run-ambiguous', 'Artifact invocation is ambiguous; never choose a candidate run or repeat publication.');
      if (existing.length === 1 && input.inspection.state.phases[input.phase.id].executionPlanDigest) {
        handle = operationForRun(input, existing[0]!, binding);
        currentReadback = [readbackProof(input, 'github', 'workflow-run', handle.resourceId, {
          id: existing[0]!.id, headSha: existing[0]!.head_sha, runAttempt: existing[0]!.run_attempt
        })];
      } else {
        if (existing.length || input.inspection.state.phases[input.phase.id].executionPlanDigest) {
          return applicationError('application-dispatch-uncertain', 'Artifact destination/dispatch is occupied or acceptance is uncertain; observe the existing invocation under recovery instead of dispatching again.');
        }
        const repositories = await runAzureJson(input, [
          'acr', 'repository', 'list', '--subscription', binding.subscriptionId, '--name', binding.registryName
        ], 'Artifact publication destination inventory');
        if (!Array.isArray(repositories) || repositories.length > 1_000 ||
          repositories.some((entry) => typeof entry !== 'string')) {
          return applicationError('application-registry-unobservable', 'Complete bounded registry repository absence could not be established.');
        }
        if (repositories.includes(binding.imageRepository)) {
          const tags = await runAzureJson(input, [
            'acr', 'repository', 'show-tags', '--subscription', binding.subscriptionId,
            '--name', binding.registryName, '--repository', binding.imageRepository
          ], 'Artifact tag collision readback');
          if (!Array.isArray(tags) || tags.length > 1_000 || tags.some((entry) => typeof entry !== 'string') || tags.includes(binding.tag)) {
            return applicationError('application-tag-occupied', 'The exact immutable publication tag is occupied or its absence is unobservable; it must not be replaced/adopted.');
          }
        }
        await assertApplicationAuthority(input, dispatch);
        await observeApplicationProtection(input);
        await observeApplicationSource(input);
        await input.recordApplicationDispatchIntent?.(dispatch);
        await assertApplicationAuthority(input, dispatch);
        dispatchAttempted = true;
        await client.write('POST', `/repos/${binding.repository}/actions/workflows/${binding.workflowPath.split('/').at(-1)}/dispatches`,
          { ref: binding.ref, inputs: dispatchInputs(binding) });
        const runs = await find();
        if (runs.length !== 1) return applicationError('application-dispatch-uncertain',
          'Artifact dispatch was accepted but no unique actual run is visible yet; recovery must observe this invocation and cannot repeat dispatch.');
        handle = operationForRun(input, runs[0]!, binding);
        currentReadback = [readbackProof(input, 'github', 'workflow-run', handle.resourceId, {
          id: runs[0]!.id, headSha: runs[0]!.head_sha, runAttempt: runs[0]!.run_attempt
        })];
      }
    }
    outputs = outputFor(binding, handle, { sourceTreeDigest: source.sourceTreeDigest });
    if (!previous && currentReadback.length) {
      await input.recordApplicationProgress?.({ operation: handle, outputs, liveReadback: currentReadback });
    }
    const run = await client.get(handle.resourceId);
    boundRun(run, binding, dispatchedPlan.createdAt);
    handle = { ...handle, observedAt: (input.clock?.() ?? input.now).toISOString() };
    const liveReadback = [readbackProof(input, 'github', 'workflow-run', handle.resourceId, {
      id: run.id, headSha: run.head_sha, workflowPath: run.path, runAttempt: run.run_attempt,
      event: run.event, status: run.status, conclusion: run.conclusion
    })];
    currentReadback = liveReadback;
    if (run.status !== 'completed') {
      if (!['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(String(run.status))) {
        return applicationError('application-run-status', 'Artifact workflow returned an unsupported observation state.');
      }
      return { status: 'pending', operation: handle, outputs, liveReadback, completedOperations: [],
        blocker: 'Application build/publication is pending; retry only observes the exact dispatched workflow.' };
    }
    const jobs = await client.list(`${handle.resourceId}/jobs?filter=all`, 'jobs');
    if (jobs.length !== 1) return applicationError('application-job-scope', 'Artifact run has an unexpected job/attempt inventory.');
    const job = jobs[0]!;
    if (job.name !== 'Liftoff application artifact' || job.runner_id !== binding.runnerId ||
      job.runner_group_id !== binding.runnerGroupId || !Array.isArray(job.steps) || job.steps.length > 30) {
      return applicationError('application-job-scope', 'Artifact job was not executed on the exact qualified protected runner.');
    }
    const receipts = job.steps.filter((step) => isRecord(step) && typeof step.name === 'string' &&
      /^Liftoff artifact sha256:[a-f0-9]{64} run [a-z0-9]{1,32}$/u.test(step.name));
    if (run.conclusion !== 'success' || job.conclusion !== 'success' || receipts.length !== 1 ||
      !isRecord(receipts[0]) || receipts[0].conclusion !== 'success') {
      return { status: 'blocked', resultState: 'failed', operation: { ...handle, status: 'failed' }, outputs,
        liveReadback, completedOperations: [],
        blocker: 'Artifact publication failed or has no unique actual immutable receipt; partial registry effects require observation and separately scoped recovery, never rerun.',
        cleanupWarnings: ['A dispatched build may have published partial registry effects. No deployment, deletion or automatic rollback was attempted.'] };
    }
    handle = { ...handle, status: 'completed' };
    const receipt = String(receipts[0].name).match(/^Liftoff artifact (sha256:[a-f0-9]{64}) run ([a-z0-9]{1,32})$/u)!;
    const imageDigest = digest(receipt[1]);
    const acrRunId = receipt[2]!;
    outputs = outputFor(binding, handle, { sourceTreeDigest: source.sourceTreeDigest, artifactDigest: imageDigest, acrRunId,
      workflowJobId: positiveId(job.id) });
    const readback = input.plan.operations.find((entry) => entry.actionId === 'azure.artifact.readback');
    if (!readback || canonicalSha256(readback.inputs) !== canonicalSha256({
      artifactBindingDigest: binding.bindingDigest, sourceSha: binding.sourceSha, registryResourceId: binding.registryId,
      immutableTag: binding.tag, verifyAttestation: true
    })) return applicationError('application-plan-stale', 'The exact immutable artifact readback operation changed after review.');
    await assertApplicationAuthority(input, readback);
    const immutable = await observeImmutableApplicationArtifact(input, outputs, handle);
    await observeApplicationSource(input);
    const imageResourceId = `${binding.registryId}/repositories/${binding.imageRepository}@${imageDigest}`;
    const acrRunResourceId = `${binding.registryId}/runs/${acrRunId}`;
    const completeOutputs: PhaseOutputBindings = {
      values: { ...outputs.values, immutableImage: immutable.immutableImage,
        attestationVerificationDigest: immutable.attestationVerificationDigest },
      resources: [...outputs.resources,
        { provider: 'azure', resourceType: 'Microsoft.ContainerRegistry/registries/runs', resourceId: acrRunResourceId },
        { provider: 'azure', resourceType: 'immutable-application-image', resourceId: imageResourceId }]
    };
    return { status: 'completed', resultState: 'verified', operation: { ...handle, status: 'completed' },
      outputs: completeOutputs,
      liveReadback: [...liveReadback,
        readbackProof(input, 'azure', 'Microsoft.ContainerRegistry/registries/runs', acrRunResourceId, immutable.run),
        readbackProof(input, 'azure', 'immutable-application-image', imageResourceId, {
          registryResourceId: binding.registryId, manifest: immutable.manifest,
          immutableImage: immutable.immutableImage, sourceSha: binding.sourceSha,
          workflowDigest: binding.workflowDigest, attestationVerificationDigest: immutable.attestationVerificationDigest
        })],
      evidencePayload: { kind: 'application-artifact-ready.v1', artifactBindingDigest: binding.bindingDigest,
        sourceSha: binding.sourceSha, workflowDigest: binding.workflowDigest, workflowRunId: run.id,
        workflowJobId: job.id, registryResourceId: binding.registryId, artifactDigest: imageDigest,
        acrRunId, immutableImage: immutable.immutableImage,
        attestationVerificationDigest: immutable.attestationVerificationDigest, deploymentPerformed: false },
      completedOperations: [dispatch, readback] };
  } catch (error) {
    if (!isApplicationProviderError(error)) throw error;
    return { status: handle?.status === 'running' && currentReadback.length ? 'pending' : 'blocked', blocker: error.message,
      ...(handle && currentReadback.length ? {
        operation: { ...handle, observedAt: currentReadback[0]!.observedAt },
        outputs, liveReadback: currentReadback
      } : {}), completedOperations: [],
      cleanupWarnings: dispatchAttempted || handle
        ? ['Artifact dispatch/publication may have partial effects; preserve the exact invocation and observe it. Never repeat a dispatch with uncertain acceptance.'] : [] };
  }
}

export async function observeImmutableApplicationArtifact(
  input: PhaseAdapterExecutionInput, outputs: PhaseOutputBindings, operation: ExternalOperationState
) {
  input = applicationDeadlineInput(input);
  const binding = applicationArtifactBinding(input);
  if (outputs.values.artifactBindingDigest !== binding.bindingDigest ||
    outputs.values.sourceSha !== binding.sourceSha || outputs.values.workflowDigest !== binding.workflowDigest ||
    outputs.values.registryResourceId !== binding.registryId ||
    typeof outputs.values.acrRunId !== 'string' || !/^[a-z0-9]{1,32}$/u.test(outputs.values.acrRunId)) {
    return applicationError('application-artifact-binding', 'Artifact publication changed source, environment, approved recipe, registry or actual build run.');
  }
  const imageDigest = digest(outputs.values.artifactDigest);
  const image = `${binding.imageRepository}@${imageDigest}`;
  const tag = `${binding.imageRepository}:${binding.tag}`;
  const run = azureObject(await runAzureJson(input, [
    'acr', 'task', 'show-run', '--subscription', binding.subscriptionId, '--registry', binding.registryName,
    '--run-id', outputs.values.acrRunId,
    '--query', '{runId:runId,status:status,runType:runType,outputImages:outputImages}'
  ], 'Actual application ACR build run readback'), 'ACR build run');
  if (run.runId !== outputs.values.acrRunId || run.status !== 'Succeeded' || run.runType !== 'QuickBuild' ||
    !Array.isArray(run.outputImages) || run.outputImages.length !== 1 ||
    !isRecord(run.outputImages[0]) || run.outputImages[0].registry !== binding.loginServer ||
    run.outputImages[0].repository !== binding.imageRepository || run.outputImages[0].tag !== binding.tag ||
    run.outputImages[0].digest !== imageDigest) {
    return applicationError('application-acr-provenance', 'Actual ACR publication run does not own the exact source-bound registry image digest/tag; a caller annotation or candidate tag is not proof.');
  }
  const readManifest = async (reference: string) => {
    const metadata = azureObject(await runAzureJson(input, [
      'acr', 'repository', 'show', '--subscription', binding.subscriptionId,
      '--name', binding.registryName, '--image', reference,
      '--query', '{digest:digest,name:name,changeableAttributes:changeableAttributes}'
    ], 'Immutable application image readback'), 'Registry image');
    const attributes = azureObject(metadata.changeableAttributes, 'Registry image attributes');
    if (metadata.digest !== imageDigest || attributes.writeEnabled !== false || attributes.deleteEnabled !== false) {
      return applicationError('application-image-mutable', 'Image digest/tag changed or is writable/deletable; deployment requires actual independently readback immutable publication.');
    }
    return { digest: metadata.digest, changeableAttributes: {
      writeEnabled: attributes.writeEnabled, deleteEnabled: attributes.deleteEnabled
    } };
  };
  await readManifest(tag);
  const manifest = await readManifest(image);
  const verified = await input.runner.run({
    executable: 'gh', args: [
      'attestation', 'verify', `oci://${binding.loginServer}/${image}`, '--hostname', 'github.com',
      '--repo', binding.repository, '--signer-workflow', `${binding.repository}/${binding.workflowPath}`,
      '--signer-digest', binding.sourceSha, '--source-digest', binding.sourceSha,
      '--predicate-type', 'https://slsa.dev/provenance/v1', '--deny-self-hosted-runners', '--limit', '10', '--format', 'json'
    ]
  }, { cwd: input.inspection.projectRoot, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024, stream: false,
    env: { GH_DEBUG: '', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' } });
  if (verified.status !== 0 || verified.timedOut || verified.outputLimitExceeded || verified.errorCode || verified.aborted) {
    return applicationError('application-attestation-unavailable', 'Exact cryptographic workflow/source/image attestation or existing protected registry authentication is unavailable; no token login, credential fallback or unverified artifact acceptance was attempted.');
  }
  let attestations: unknown;
  try { attestations = JSON.parse(verified.stdout); }
  catch { return applicationError('application-attestation-invalid', 'Artifact verification returned invalid bounded JSON; proof/log bytes were withheld.'); }
  const expectedRun = `https://github.com${operation.resourceId.replace('/repos/', '/')}/attempts/1`;
  const valid = Array.isArray(attestations) && attestations.length > 0 && attestations.length <= 10 &&
    attestations.some((entry) => {
      if (!isRecord(entry) || !isRecord(entry.verificationResult)) return false;
      const result = entry.verificationResult;
      const certificate = isRecord(result.signature) && isRecord(result.signature.certificate)
        ? result.signature.certificate : null;
      const extensions = certificate && isRecord(certificate.extensions) ? certificate.extensions : null;
      return extensions?.runInvocationURI === expectedRun && extensions.buildSignerDigest === binding.sourceSha &&
        extensions.sourceRepositoryDigest === binding.sourceSha &&
        extensions.sourceRepositoryIdentifier === String(binding.repositoryId) &&
        extensions.sourceRepositoryURI === `https://github.com/${binding.repository}` &&
        extensions.runnerEnvironment === 'github-hosted' && extensions.buildTrigger === 'workflow_dispatch' &&
        Array.isArray(result.verifiedTimestamps) && result.verifiedTimestamps.length > 0 &&
        isRecord(result.statement) && result.statement.predicateType === 'https://slsa.dev/provenance/v1' &&
        Array.isArray(result.statement.subject) && result.statement.subject.length === 1 &&
        isRecord(result.statement.subject[0]) && isRecord(result.statement.subject[0].digest) &&
        result.statement.subject[0].digest.sha256 === imageDigest.slice('sha256:'.length);
    });
  if (!valid) return applicationError('application-attestation-mismatch', 'Verified certificate does not bind this exact actual hosted run, repository, source commit and immutable image subject; user-controlled predicate annotations are not authority.');
  await readManifest(tag);
  return { binding, run: { runId: run.runId, status: run.status, runType: run.runType,
    outputImages: run.outputImages.map((output) => {
      if (!isRecord(output)) return applicationError('application-acr-provenance', 'Application publication image readback is malformed.');
      return { registry: output.registry, repository: output.repository, tag: output.tag, digest: output.digest };
    }) }, manifest, imageDigest, immutableImage: `${binding.loginServer}/${image}`,
    attestationVerificationDigest: canonicalSha256(attestations) };
}
