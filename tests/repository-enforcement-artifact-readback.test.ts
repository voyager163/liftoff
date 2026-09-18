import { randomUUID, createHash } from 'node:crypto';
import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it as registerTest, vi } from 'vitest';
import { canonicalJson, canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, canonicalPhaseGraphHash, currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { phaseScope, type PhaseId, type PhaseEvidenceRecord, type TransitionOperation } from '../src/domain/governance/activation/types.js';
import { transitionPlanForPhase, evaluateApprovalForTransitionPlan } from '../src/domain/governance/activation/approvals.js';
import { planDigestFor, rollbackPlanForPhase } from '../src/domain/governance/activation/operations.js';
import { validateApprovalEnvelope, validateSavedTransitionPlan } from '../src/domain/governance/activation/validators.js';
import { evidenceBodyDigest, validateEvidenceFreshness } from '../src/domain/governance/activation/evidence.js';
import { writeGovernanceApprovalAuthority } from '../src/governance-activation/authority-records.js';
import { loadActivationState } from '../src/governance-activation/activation-state.js';
import { evidenceHeaderFor, nextStateForOutcome, readbackProof, writeOutcomeTransaction, blockedState } from '../src/governance-activation/transition-records.js';
import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanningInput } from '../src/governance-activation/transition-ports.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { GitHubActivationClient, object, positiveId, type GitHubRequest, type GitHubResponse } from '../src/adapters/github/activation-rest.js';
import { buildCanonicalGitFlowRulesets } from '../src/adapters/github/production-rulesets.js';
import { observeRepositoryControls } from '../src/adapters/github/repository-control-observation.js';
import { readbackWorkflowContent, readWorkflowPublicationCheckpoints } from '../src/adapters/github/production-workflows.js';
import { controlledNodeTestFixture, sourceCheckFixtureArtifact } from '../src/adapters/github/workflow-check-recipes.js';
import {
  dispatchApprovedWorkflowRun, readBoundWorkflowRun,
  type FailedWorkflowArtifactRequest, type RepositoryChecksEvidencePayload, type WorkflowRunBinding
} from '../src/adapters/github/production-checks.js';
import { planRepositoryChecks, executeRepositoryChecks } from '../src/application/repository-governance/producer-checks.js';
import {
  planRepositoryRulesets, executeRepositoryRulesets, planRepositoryLiveReadback, executeRepositoryLiveReadback
} from '../src/application/repository-governance/producer-rulesets.js';
import {
  revalidateApprovedRepositoryChecks, planApprovedFullChecks, revalidateApprovedFullChecks
} from '../src/application/repository-governance/repository-check-revalidation.js';
import {
  planFullActivationChecks, executeFullActivationChecks, type BoundProductionPredecessors
} from '../src/application/azure-activation/full-activation-checks.js';
import * as predecessors from '../src/application/repository-governance/repository-control-predecessors.js';
import * as stagingReceipts from '../src/application/azure-activation/staging-qualification-receipt.js';
import * as rehearsalReceipts from '../src/application/azure-activation/rehearsal-qualification-receipt.js';
import { readFullControlFailedArtifacts } from '../src/application/repository-governance/repository-control-artifact-readback.js';
import { assertGitHubPhaseAuthority } from '../src/application/repository-governance/workflow-authority.js';
import { assertRepositoryControlAuthority } from '../src/application/repository-governance/repository-control-authority.js';
import { workflowOperationFixture } from './helpers/workflow-operation-fixture.js';
import { WorkflowGitHubFixture, dispatchFixtureSource, workflowFixtureNow, workflowFixturePath, workflowFixtureSource } from './helpers/workflow-publication-fixture.js';
import { singleReportBytesZip } from './helpers/private-report-zip-fixture.js';

let activeBodies = 0;
const cleanup: Array<() => Promise<void>> = [];
function it(name: string, body: () => Promise<void>, timeout?: number) {
  registerTest(name, async () => {
    activeBodies++;
    try { await body(); } finally { activeBodies--; }
  }, timeout);
}
afterEach(async () => {
  if (activeBodies) throw new Error('Preserving artifact fixtures while owning test work remains unsettled.');
  while (cleanup.length) {
    await cleanup[0]!();
    cleanup.shift();
  }
});

async function retainFixture(root: string) {
  const identity = await lstat(root), resolved = await realpath(root);
  if (!identity.isDirectory() || identity.isSymbolicLink() || path.dirname(resolved) !== await realpath(path.resolve('tests'))) {
    throw new Error('The artifact fixture was not created in its exact owned test scope.');
  }
  cleanup.push(async () => {
    const current = await lstat(root);
    if (await realpath(root) !== resolved || current.dev !== identity.dev || current.ino !== identity.ino ||
      current.birthtimeMs !== identity.birthtimeMs || current.uid !== identity.uid || !current.isDirectory() || current.isSymbolicLink()) {
      throw new Error('Preserving artifact fixture with changed creation identity.');
    }
    await rm(resolved, { recursive: true });
  });
}

class EnforcementArtifactProtocol extends WorkflowGitHubFixture {
  pendingArtifact: number | undefined;
  readonly artifactDeclaration = sourceCheckFixtureArtifact('node-tests', 'node-test.v1', '.');
  readonly repository: Record<string, unknown> = {
    id: 42, node_id: 'R_fixture42', name: 'repo', full_name: 'owner/repo',
    owner: { id: 9, login: 'owner', type: 'Organization' }, archived: false, disabled: false,
    default_branch: 'develop', allow_merge_commit: false, allow_squash_merge: true,
    allow_rebase_merge: true, allow_auto_merge: false, delete_branch_on_merge: false,
    permissions: { admin: true, push: true, pull: true }, foreign_setting: 'preserved'
  };
  private controlId = 1000;
  private observationId = 0;

  override addRun(...args: Parameters<WorkflowGitHubFixture['addRun']>) {
    const run = super.addRun(...args);
    const runId = positiveId(run.id);
    run.updated_at = workflowFixtureNow;
    const job = this.jobs.get(runId)?.[0];
    if (!job || !Array.isArray(job.steps)) throw new Error('Actual fixture run job is missing.');
    Object.assign(job, { run_attempt: 1, started_at: workflowFixtureNow, completed_at: workflowFixtureNow });
    job.steps.splice(3, 0, { number: 4, name: 'Upload controlled fixture', status: 'completed', conclusion: 'success' });
    job.steps[4].number = 5;
    const commit = this.commits.get(String(run.head_sha));
    const tree = commit && this.trees.get(String(object(commit.tree).sha));
    const file = tree?.find((entry) => entry.path === this.artifactDeclaration.path);
    const source = file && this.blobs.get(file.sha);
    if (!source) throw new Error('The actual published controlled fixture bytes are missing.');
    const bytes = singleReportBytesZip(source, this.artifactDeclaration.path.split('/').at(-1)!);
    const id = 5000 + runId;
    this.artifacts.set(id, {
      metadata: {
        id, name: `liftoff-source-check-node-tests-${runId}`, expired: false,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, size_in_bytes: bytes.length,
        created_at: workflowFixtureNow,
        workflow_run: { id: runId, repository_id: 42, head_repository_id: 42, head_sha: run.head_sha, head_branch: run.head_branch }
      }, bytes
    });
    return run;
  }

  override async request(request: GitHubRequest): Promise<GitHubResponse> {
    const endpoint = new URL(`https://api.github.com${request.path}`).pathname;
    const root = '/repos/owner/repo';
    const artifact = /^\/repos\/owner\/repo\/actions\/artifacts\/(\d+)(?:\/zip)?$/u.exec(endpoint);
    const artifactList = /^\/repos\/owner\/repo\/actions\/runs\/(\d+)\/artifacts$/u.exec(endpoint);
    const job = /^\/repos\/owner\/repo\/actions\/jobs\/(\d+)$/u.exec(endpoint);
    const overridden = endpoint === root || endpoint === '/user' || endpoint === '/apps/github-actions' ||
      endpoint === `${root}/rulesets` || endpoint.startsWith(`${root}/rulesets/`) || artifactList || job ||
      artifact && Number(artifact[1]) === this.pendingArtifact;
    if (!overridden) return super.request(request);
    this.requests.push(structuredClone(request));
    await this.beforeRequest?.(request);
    const respond = (data: unknown, status = 200): GitHubResponse => ({
      status, headers: { 'x-github-request-id': `CONTROL-${++this.observationId}`, etag: `"${canonicalSha256(data)}"` }, data
    });
    if (artifact && Number(artifact[1]) === this.pendingArtifact) return respond({ message: 'Retained artifact not visible' }, 404);
    if (request.method === 'GET') {
      if (endpoint === root) return respond(this.repository);
      if (endpoint === '/user') return respond({ id: this.actorId, login: this.actorLogin, type: 'User' });
      if (endpoint === '/apps/github-actions') return respond({ id: 15368, slug: 'github-actions', owner: { id: 9919 } });
      if (endpoint === `${root}/rulesets`) return respond(this.controls);
      if (endpoint.startsWith(`${root}/rulesets/`)) {
        const control = this.controls.find((entry) => entry.id === Number(endpoint.split('/').at(-1)));
        return control ? respond(control) : respond({ message: 'Missing owned rule' }, 404);
      }
      if (artifactList) {
        const artifacts = [...this.artifacts.values()].map((entry) => entry.metadata)
          .filter((entry) => object(entry.workflow_run).id === Number(artifactList[1]));
        return respond({ total_count: artifacts.length, artifacts });
      }
      if (job) {
        const observed = [...this.jobs.values()].flat().find((entry) => entry.id === Number(job[1]));
        return observed ? respond(observed) : respond({ message: 'Missing actual job' }, 404);
      }
    }
    if (request.method === 'POST' && endpoint === `${root}/rulesets`) {
      const id = this.controlId++;
      const control = { ...structuredClone(object(request.body)), id, node_id: `RS_${id}`, source: 'owner/repo', source_type: 'Repository' };
      this.controls.push(control);
      return respond(control, 201);
    }
    if (request.method === 'PUT' && endpoint.startsWith(`${root}/rulesets/`)) {
      const control = this.controls.find((entry) => entry.id === Number(endpoint.split('/').at(-1)));
      if (!control) throw new Error('The bounded provider cannot replace an unknown control.');
      Object.assign(control, structuredClone(object(request.body)));
      return respond(control);
    }
    if (request.method === 'PATCH' && endpoint === root) {
      Object.assign(this.repository, object(request.body));
      return respond(this.repository);
    }
    throw new Error(`Unapproved fixture effect: ${request.method} ${endpoint}`);
  }
}

async function fixture(full = false, semantic = false) {
  const checksPhase = full ? 'green-red-proof' : 'repository-checks-qualified';
  const controlPhase = full ? 'rulesets-applied' : 'repository-rulesets-applied';
  const families = ['develop', 'main', 'release/**', 'hotfix/**'] as const;
  const declaration = sourceCheckFixtureArtifact('node-tests', 'node-test.v1', '.');
  const workflow = workflowFixtureSource.replace('[develop]', `[${families.join(', ')}]`) +
    `      - name: Upload controlled fixture\n        if: always()\n        uses: actions/upload-artifact@${'b'.repeat(40)}\n        with:\n          name: ${declaration.name}\n          path: ${declaration.path}\n          if-no-files-found: error\n`;
  const rulesets = buildCanonicalGitFlowRulesets({ requiredChecks: ['Node source validation'], actionsAppId: 15368 });
  const files = rulesets.map((definition) => ({ path: `.github/rulesets/${definition.name}.json`, content: JSON.stringify(definition) }));
  const protocol = new EnforcementArtifactProtocol(workflow, files);
  protocol.autoChecks = true;
  for (const family of families) protocol.refs.set(family.replace('/**', '/maintenance/1.2.3'), family === 'main' ? protocol.mainSha : protocol.baseSha);
  // This bounded predecessor port exercises source-check custody, not Azure qualification.
  const predecessor: BoundProductionPredecessors = {
    sourceSha: protocol.baseSha, artifactDigest: `sha256:${'c'.repeat(64)}`,
    staging: { phaseId: 'staging-qualified', evidenceId: 'test-double-staging', headerDigest: '1'.repeat(64),
      bodyDigest: '2'.repeat(64), sourceSha: protocol.baseSha, artifactDigest: `sha256:${'c'.repeat(64)}`, verifiedAt: workflowFixtureNow },
    rehearsal: { phaseId: 'production-rehearsed', evidenceId: 'test-double-rehearsal', headerDigest: '3'.repeat(64),
      bodyDigest: '4'.repeat(64), sourceSha: protocol.baseSha, artifactDigest: `sha256:${'c'.repeat(64)}`, verifiedAt: workflowFixtureNow }
  };
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === checksPhase)!;
  const f = await workflowOperationFixture(phase.id, async (inspection) => {
    const input = { inspection, phase, runner: protocol.runner, now: new Date(workflowFixtureNow) };
    const planned = full ? await planFullActivationChecks(input, { predecessorVerifier: () => predecessor }) : await planRepositoryChecks(input);
    if (planned.blockers?.length) throw new Error(planned.blockers.join(' '));
    return planned.operations;
  }, protocol.runner, {
    predecessorSourceSha: protocol.baseSha, files: [{ path: workflowFixturePath, content: workflow }, ...files],
    configuration: { schemaVersion: 1, repository: { name: 'owner/repo' }, phases: {
      [controlPhase]: { settings: { default_branch: 'develop', allow_merge_commit: true }, mainHold: full ? 'qualified' : 'hold' },
      [checksPhase]: {
        sourceSha: protocol.baseSha, workflowPaths: [workflowFixturePath], repositoryId: 42, actorId: 7,
        ...(full ? {
          artifactDigest: predecessor.artifactDigest,
          staging: { evidenceId: predecessor.staging.evidenceId, headerDigest: predecessor.staging.headerDigest, bodyDigest: predecessor.staging.bodyDigest },
          rehearsal: { evidenceId: predecessor.rehearsal.evidenceId, headerDigest: predecessor.rehearsal.headerDigest, bodyDigest: predecessor.rehearsal.bodyDigest }
        } : {}),
        fixtures: families.map((family, index) => ({
          refFamily: family, targetBranch: family.replace('/**', '/maintenance/1.2.3'),
          baseSha: family === 'main' ? protocol.mainSha : protocol.baseSha,
          positiveBranch: `automation/artifact-positive-${index}`, negativeBranch: `automation/artifact-negative-${index}`,
          commitTime: workflowFixtureNow
        }))
      }
    } }
  });
  await retainFixture(f.root);
  f.input.adapters.githubActivation!.transport = protocol;
  const inspection = f.input.inspection;
  const planning = (id: PhaseId = controlPhase): PhasePlanningInput => ({
    inspection, phase: canonicalPhaseGraph.phases.find((entry) => entry.id === id)!,
    adapters: f.input.adapters, runner: protocol.runner, now: f.input.now
  });
  async function issue(operations: readonly TransitionOperation[], id: PhaseId = controlPhase, issued = true) {
    const input = planning(id);
    inspection.scope = phaseScope(id);
    const context = inspection.contexts[id];
    const requested = transitionPlanForPhase(input.phase, inspection.state, context.transition, f.projectRoot, undefined, {
      operations, configuration: inspection.activationInputs, selectionScope: inspection.scope
    });
    const expiresAt = new Date(f.input.now.getTime() + 900_000).toISOString();
    const envelope = input.phase.approvalGate.required ? validateApprovalEnvelope({
      ...requested, schemaVersion: 4, id: randomUUID(), approvedAt: f.input.now.toISOString(), expiresAt,
      approver: 'isolated-current-enforcement-reader'
    }) : null;
    const evaluation = evaluateApprovalForTransitionPlan(requested, envelope ? [envelope] : [], { now: f.input.now });
    const plan = validateSavedTransitionPlan({
      schemaVersion: 2, scope: phaseScope(id), selectionScope: inspection.scope, phaseId: id,
      identity: currentActivationIdentity, graphHash: canonicalPhaseGraphHash,
      createdAt: f.input.now.toISOString(), expiresAt, stateHash: canonicalSha256(inspection.state),
      baselineDigest: context.baselineSha, inputDigest: context.inputDigest, transitionDigest: context.transition.transitionDigest,
      planDigest: planDigestFor({ phase: input.phase, transitionDigest: context.transition.transitionDigest, operations, approvalPlanDigest: requested.planDigest }),
      mutationClasses: input.phase.allowedMutations, operations, configuration: inspection.activationInputs,
      approval: { gateKind: input.phase.approvalGate.kind, required: input.phase.approvalGate.required,
        evaluation, envelopeId: evaluation.envelopeId, envelopeHash: evaluation.envelopeHash },
      rollbackPlan: rollbackPlanForPhase(input.phase), noSecrets: true
    });
    if (envelope) {
      inspection.approvals = [...inspection.approvals, envelope];
      if (issued) await writeGovernanceApprovalAuthority(f.projectRoot, canonicalSha256(plan), envelope, f.storage);
    }
    return { ...input, plan, adapters: f.input.adapters } satisfies PhaseAdapterExecutionInput;
  }
  async function persist(input: PhaseAdapterExecutionInput, outcome: PhaseAdapterOutcome) {
    if (outcome.status !== 'completed' || !isRecord(outcome.evidencePayload)) throw new Error(outcome.blocker ?? 'Fixture producer did not complete.');
    const payload = { ...outcome.evidencePayload, planDigest: input.plan.planDigest, savedPlanDigest: canonicalSha256(input.plan) };
    const header = evidenceHeaderFor({ inspection, phase: input.phase, plan: input.plan, result: 'verified',
      now: f.input.now, payload, liveReadback: outcome.liveReadback });
    const record: PhaseEvidenceRecord = { evidenceId: `artifact-consumer-${randomUUID()}`, header, payload, liveReadback: outcome.liveReadback };
    const reference = { phaseId: input.phase.id, evidenceId: record.evidenceId, headerDigest: canonicalSha256(header), result: 'verified' as const };
    const next = nextStateForOutcome({ inspection, phase: input.phase, plan: input.plan, resultState: 'verified',
      now: f.input.now, evidenceReference: reference, outputs: outcome.outputs });
    await writeOutcomeTransaction({ projectRoot: f.projectRoot, plan: input.plan, nextState: next, evidenceRecord: record,
      evidencePathParts: ['governance', 'evidence', `${record.evidenceId}.json`], expectedStateHash: inspection.loadedState!.contentHash });
    inspection.state = next;
    inspection.loadedState = await loadActivationState(f.projectRoot);
    inspection.evidence = [...inspection.evidence, record];
    inspection.contexts[input.phase.id].reviewedPlans = [input.plan];
    inspection.contexts[input.phase.id].evidenceReferences = next.phases[input.phase.id].evidence;
    const fresh = validateEvidenceFreshness(record, inspection.contexts[input.phase.id]);
    if (!fresh.valid) throw new Error(JSON.stringify(fresh.issues));
    return record;
  }
  const verifySource: TransitionOperation = {
    phaseId: 'repository-workflow-source-ready', adapter: 'github', actionId: 'github.workflow-source.verify',
    mutationClass: 'github-read', remote: true, destructive: false,
    destination: { type: 'repository', identity: 'owner/repo', repository: 'owner/repo' },
    inputs: { repository: 'owner/repo', sourceSha: protocol.baseSha }
  };
  const sourceApproval = await issue([verifySource], verifySource.phaseId);
  const client = new GitHubActivationClient(protocol);
  const observedFiles = await Promise.all([workflowFixturePath, ...files.map((file) => file.path)].sort()
    .map((file) => readbackWorkflowContent(client, 'owner/repo', file, protocol.baseSha)));
  const inventory = observedFiles.map((file) => ({ path: file.path, digest: file.digest, readbackDigest: file.digest, blobSha: file.blobSha }));
  const sourcePayload = {
    kind: 'repository-workflow-source-ready.v1', repository: 'owner/repo', repositoryId: 42, actorId: 7,
    actorLogin: 'owner', ref: 'develop', sourceSha: protocol.baseSha, files: inventory,
    workflows: observedFiles.filter((file) => file.path === workflowFixturePath).map((file) => ({
      path: file.path, workflowId: 4, digest: file.digest, blobSha: file.blobSha, sourceSha: protocol.baseSha
    })),
    rulesetSourceDigest: canonicalSha256(inventory.filter((file) => file.path.startsWith('.github/rulesets/')).map(({ path, digest }) => ({ path, digest })))
  };
  await persist(sourceApproval, { status: 'completed', resultState: 'verified', evidencePayload: sourcePayload,
    completedOperations: [verifySource], liveReadback: [
      readbackProof(sourceApproval, 'github', 'workflow-source', `/repos/owner/repo/git/commits/${protocol.baseSha}`, sourcePayload)
    ] });
  if (semantic) {
    const sourcePhase = 'workflow-source-ready';
    const fullSource = { ...verifySource, phaseId: sourcePhase } satisfies TransitionOperation;
    const sourceInput = await issue([fullSource], sourcePhase);
    await persist(sourceInput, {
      status: 'completed', resultState: 'verified', completedOperations: [fullSource],
      evidencePayload: { ...sourcePayload, kind: 'workflow-source-ready.v1' },
      liveReadback: [readbackProof(sourceInput, 'github', 'workflow-source', `/repos/owner/repo/git/commits/${protocol.baseSha}`, sourcePayload)]
    });
    for (const id of ['staging-qualified', 'production-rehearsed'] as const) {
      // Scope-specific serialized test inputs; closed semantic readers below are
      // explicitly doubled. These records are NOT native/provider qualification.
      const operation: TransitionOperation = {
        phaseId: id, adapter: 'github',
        actionId: id === 'staging-qualified' ? 'github.checks.staging' : 'github.checks.production-rehearsal',
        mutationClass: 'github-workflow-dispatch', remote: true, destructive: false,
        destination: { type: 'repository', identity: 'owner/repo', repository: 'owner/repo' },
        inputs: { boundedSemanticFixture: true }
      };
      const subscriptionId = '11111111-2222-4333-8444-555555555555';
      const resourceId = `/subscriptions/${subscriptionId}/resourceGroups/bounded-fixture/providers/Microsoft.App/containerApps/bounded-fixture`;
      const readback: TransitionOperation = {
        phaseId: id, adapter: 'azure-opentofu',
        actionId: id === 'staging-qualified' ? 'azure.staging.readback' : 'azure.production-readback',
        mutationClass: 'azure-read', remote: true, destructive: false,
        destination: { type: 'subscription', identity: resourceId, subscriptionId },
        inputs: { boundedSemanticFixture: true }
      };
      const input = await issue([operation, readback], id);
      const record = await persist(input, {
        status: 'completed', resultState: 'verified', completedOperations: [operation, readback],
        evidencePayload: { kind: `${id}.v1`, sourceSha: protocol.baseSha, artifactDigest: predecessor.artifactDigest,
          ...(id === 'staging-qualified' ? { securityObservation: { boundedSemanticFixture: true } } :
            { applicationRehearsal: { boundedSemanticFixture: true } }) },
        liveReadback: inspection.contexts[id].liveReadbackProviders!.map((provider) =>
          readbackProof(input, provider, 'bounded-semantic-port',
            provider === 'github' ? '/repos/owner/repo/actions/runs/901' : resourceId, { boundedSemanticFixture: true }))
      });
      const reference = { evidenceId: record.evidenceId, headerDigest: canonicalSha256(record.header), bodyDigest: record.header.bodyDigest };
      const key = id === 'staging-qualified' ? 'staging' : 'rehearsal';
      Object.assign(predecessor[key], reference);
      inspection.activationInputs!.phases[checksPhase]![key] = reference;
    }
    inspection.scope = 'activation';
    const plan = await planFullActivationChecks(planning(checksPhase), { predecessorVerifier: () => predecessor });
    if (plan.blockers?.length) throw new Error(plan.blockers.join(' '));
    f.input = await issue(plan.operations, checksPhase);
  }
  inspection.scope = phaseScope(checksPhase);
  const original = await withProjectMutationLock(f.projectRoot, (lease) => full
    ? executeFullActivationChecks({ ...f.input, lease }, { predecessorVerifier: () => predecessor })
    : executeRepositoryChecks({ ...f.input, lease }));
  const record = await persist(f.input, original);
  const evidence = record.payload as RepositoryChecksEvidencePayload;
  const retained = canonicalJson(record);
  if (!semantic) f.input.now.setTime(f.input.now.getTime() + 3_600_000);
  const binding = (await observeRepositoryControls(client, 'owner/repo', 42)).binding;
  protocol.requests.length = 0;
  async function currentRead(change?: (operation: TransitionOperation) => void, issued = true) {
    const fullPlan = full ? await planApprovedFullChecks(planning(), client, record, binding, protocol.baseSha) : undefined;
    const planned = fullPlan ? { operations: [{
      phaseId: controlPhase, adapter: 'github', actionId: 'github.ruleset.readback',
      mutationClass: 'github-read', remote: true, destructive: false,
      destination: { type: 'repository', identity: 'owner/repo', repository: 'owner/repo' },
      inputs: { repository: 'owner/repo', failedWorkflowArtifacts: fullPlan.failedWorkflowArtifacts,
        originalFixturePlans: fullPlan.originalFixturePlans,
        qualificationReferences: [
          { phaseId: 'staging-qualified', reference: inspection.activationInputs!.phases[checksPhase]!.staging },
          { phaseId: 'production-rehearsed', reference: inspection.activationInputs!.phases[checksPhase]!.rehearsal }
        ] }
    } satisfies TransitionOperation], blockers: [] } : await planRepositoryRulesets(planning());
    if (planned.blockers?.length) throw new Error(planned.blockers.join(' '));
    const read = structuredClone(planned.operations.find((entry) => entry.actionId === 'github.ruleset.readback')!);
    change?.(read);
    const execution = await issue([read], controlPhase, issued);
    return { execution, operation: read };
  }
  const revalidate = (read: Awaited<ReturnType<typeof currentRead>>) => withProjectMutationLock(f.projectRoot, (lease) =>
    (full ? revalidateApprovedFullChecks : revalidateApprovedRepositoryChecks)(read.execution, client, record, binding, protocol.baseSha,
      { execution: { ...read.execution, lease }, operation: read.operation }));
  return { ...f, inspection, protocol, planning, issue, persist, record, evidence, retained, currentRead, revalidate, client, binding, predecessor };
}

function boundedSemanticReaderPorts(f: Awaited<ReturnType<typeof fixture>>) {
  const referenceFor = (id: 'staging-qualified' | 'production-rehearsed') => {
    const bound = id === 'staging-qualified' ? f.predecessor.staging : f.predecessor.rehearsal;
    return { evidenceId: bound.evidenceId, headerDigest: bound.headerDigest, bodyDigest: bound.bodyDigest };
  };
  const stagingValue = {
    kind: 'verified-staging-qualification.v1', reference: referenceFor('staging-qualified'),
    sourceSha: f.predecessor.sourceSha, artifactDigest: f.predecessor.artifactDigest,
    nativeWitnessDigest: 'e'.repeat(64), resource: {}, producedAt: workflowFixtureNow,
    security: { report: { source: { repository: 'owner/repo', repositoryId: 42 } }, job: { appId: 15368, appSlug: 'github-actions' } }
  } as Awaited<ReturnType<typeof stagingReceipts.readVerifiedStagingQualification>>;
  const rehearsalValue = {
    reference: referenceFor('production-rehearsed'), sourceSha: f.predecessor.sourceSha,
    artifactDigest: f.predecessor.artifactDigest, staging: stagingValue, producedAt: workflowFixtureNow
  } as Awaited<ReturnType<typeof rehearsalReceipts.readVerifiedRehearsalQualification>>;
  const stage = vi.spyOn(stagingReceipts, 'readVerifiedStagingQualification').mockResolvedValue(stagingValue);
  const rehearse = vi.spyOn(rehearsalReceipts, 'readVerifiedRehearsalQualification').mockResolvedValue(rehearsalValue);
  return { restore() { stage.mockRestore(); rehearse.mockRestore(); } };
}

describe('enforcement failed-artifact readback', () => {
  it('selects the exact newly issued read approval and never borrows an older equivalent grant', async () => {
    const f = await fixture();
    await f.currentRead();
    f.input.now.setTime(f.input.now.getTime() + 1);
    const current = await f.currentRead();
    await withProjectMutationLock(f.projectRoot, async (lease) => {
      const execution = { ...current.execution, lease };
      await assertGitHubPhaseAuthority(execution, current.operation);
      await assertRepositoryControlAuthority(execution, current.operation);
    });
    f.input.now.setTime(f.input.now.getTime() + 1);
    const unissued = await f.currentRead(undefined, false);
    await withProjectMutationLock(f.projectRoot, async (lease) => {
      const execution = { ...unissued.execution, lease };
      await expect(assertGitHubPhaseAuthority(execution, unissued.operation)).rejects.toThrow(/authority|issued/u);
      await expect(assertRepositoryControlAuthority(execution, unissued.operation)).rejects.toThrow(/issuance/u);
    });
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('keeps completed repository enforcement separate from full-activation and retained-state evidence', async () => {
    const f = await fixture();
    const planned = await planRepositoryRulesets(f.planning());
    const approved = await f.issue(planned.operations);
    const applied = await withProjectMutationLock(f.projectRoot, (lease) => executeRepositoryRulesets({ ...approved, lease }));
    expect(applied.status, applied.blocker).toBe('completed');
    await f.persist(approved, applied);
    const next = await planRepositoryLiveReadback(f.planning('repository-live-readback'));
    const read = await f.issue(next.operations, 'repository-live-readback');
    const result = await withProjectMutationLock(f.projectRoot, (lease) => executeRepositoryLiveReadback({ ...read, lease }));
    expect(result.status, result.blocker).toBe('completed');
    const record = await f.persist(read, result);
    expect(record.header.scope).toBe('repository');
    expect(read.plan.operations[0]!.inputs).toMatchObject({ rulesetSourceDigest: (result.evidencePayload as Record<string, unknown>).sourceDigest });
    expect(read.plan.operations[0]!.inputs).not.toHaveProperty('sourceDigest');
    const changed = structuredClone(record);
    const changedPayload = changed.payload as Record<string, unknown>;
    changedPayload.sourceDigest = 'f'.repeat(64);
    changedPayload.readbackDigest = 'f'.repeat(64);
    Object.assign(changed.liveReadback![0]!, { sourceDigest: 'f'.repeat(64), readbackDigest: 'f'.repeat(64) });
    changed.header.bodyDigest = evidenceBodyDigest(changed.payload, changed.liveReadback);
    const rejected = validateEvidenceFreshness(changed, {
      ...f.inspection.contexts['repository-live-readback'],
      evidenceReferences: [{ phaseId: 'repository-live-readback', evidenceId: changed.evidenceId,
        headerDigest: canonicalSha256(changed.header), result: 'verified' }]
    });
    expect(rejected.valid).toBe(false);
    expect(rejected.issues.some((issue) => issue.field === 'payload.sourceDigest')).toBe(true);
    const original = canonicalJson(record), controls = canonicalJson(f.protocol.controls);
    for (const phaseId of ['staging-qualified', 'production-rehearsed', 'green-red-proof',
      'remote-ready', 'rulesets-applied', 'bootstrap-state-disposed'] as const) {
      const proof = validateEvidenceFreshness(record, f.inspection.contexts[phaseId]);
      expect(proof.valid, phaseId).toBe(false);
    }
    f.inspection.scope = 'activation';
    f.inspection.activationInputs!.phases['rulesets-applied'] = {
      settings: { default_branch: 'develop', allow_merge_commit: true }, mainHold: 'replace'
    };
    f.protocol.requests.length = 0;
    const full = await planRepositoryRulesets(f.planning('rulesets-applied'));
    expect(full.operations).toEqual([]);
    expect(full.blockers?.join(' ')).toMatch(/workflow-source-ready/u);
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(canonicalJson(f.protocol.controls)).toBe(controls);
    expect(canonicalJson(record)).toBe(original);
  }, 60_000);

  it('wires full native-check custody into approved controls and live readback (bounded staging/rehearsal reader ports)', async () => {
    const f = await fixture(true, true);
    f.protocol.repository.allow_merge_commit = true;
    const planned = await planRepositoryRulesets(f.planning());
    expect(planned.blockers, planned.blockers?.join(' ')).toEqual([]);
    const execution = await f.issue(planned.operations);
    const refused = await withProjectMutationLock(f.projectRoot, (lease) => executeRepositoryRulesets({ ...execution, lease }));
    expect(refused.status).toBe('blocked');
    expect(refused.blocker).toMatch(/concrete native staging/u);
    expect(f.protocol.requests.some((request) => request.method !== 'GET')).toBe(false);
    const semantic = boundedSemanticReaderPorts(f);
    try {
      const retainedArtifact = f.evidence.controlledNegativeChecks[0]!.fixtureArtifact!;
      f.protocol.pendingArtifact = retainedArtifact.request.artifact.artifactId;
      const pending = await withProjectMutationLock(f.projectRoot, (lease) => executeRepositoryRulesets({ ...execution, lease }));
      expect(pending).toMatchObject({ status: 'blocked', operation: retainedArtifact.request.operation });
      expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
      f.protocol.pendingArtifact = undefined;
      const outcome = await withProjectMutationLock(f.projectRoot, (lease) => executeRepositoryRulesets({ ...execution, lease }));
      expect(outcome.status, outcome.blocker).toBe('completed');
      expect(outcome.evidencePayload).toMatchObject({ scope: 'activation', mainHold: null });
      expect(outcome.liveReadback?.filter((proof) => proof.resourceType === 'workflow-artifact')).toHaveLength(4);
      await f.persist(execution, outcome);
      const readPlan = await planRepositoryLiveReadback(f.planning('live-readback'));
      const read = await f.issue(readPlan.operations, 'live-readback');
      f.protocol.requests.length = 0;
      const result = await withProjectMutationLock(f.projectRoot, (lease) => executeRepositoryLiveReadback({ ...read, lease }));
      expect(result.status, result.blocker).toBe('completed');
      expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
      const expanded = structuredClone(read.plan.operations[0]!);
      expanded.inputs.failedWorkflowArtifacts = [];
      const altered = await f.issue([expanded], 'live-readback');
      await expect(withProjectMutationLock(f.projectRoot, (lease) =>
        assertGitHubPhaseAuthority({ ...altered, lease }, expanded))).rejects.toThrow(/cannot expand/u);
      expect(canonicalJson(f.record)).toBe(f.retained);
    } finally { semantic.restore(); }
  }, 90_000);

  it('replaces only the actual held control after separate full approval, retaining it on drift or missing proof (bounded semantic ports)', async () => {
    const f = await fixture(true, true);
    const inspection = f.inspection;
    const configuration = inspection.activationInputs!;
    const original = configuration.phases['green-red-proof']!;
    configuration.phases['repository-checks-qualified'] = {
      sourceSha: original.sourceSha, workflowPaths: original.workflowPaths, repositoryId: 42, actorId: 7,
      fixtures: (original.fixtures as Record<string, unknown>[]).map((entry, index) => ({
        ...entry, positiveBranch: `automation/held-positive-${index}`, negativeBranch: `automation/held-negative-${index}`
      }))
    };
    configuration.phases['repository-rulesets-applied'] = {
      settings: { default_branch: 'develop', allow_merge_commit: true }, mainHold: 'hold'
    };
    inspection.scope = 'repository';
    const repoChecks = await planRepositoryChecks(f.planning('repository-checks-qualified'));
    expect(repoChecks.blockers).toBeUndefined();
    const repoInput = await f.issue(repoChecks.operations, 'repository-checks-qualified');
    const repoResult = await withProjectMutationLock(f.projectRoot, (lease) => executeRepositoryChecks({ ...repoInput, lease }));
    await f.persist(repoInput, repoResult);
    const heldPlan = await planRepositoryRulesets(f.planning('repository-rulesets-applied'));
    expect(heldPlan.blockers).toEqual([]);
    const heldInput = await f.issue(heldPlan.operations, 'repository-rulesets-applied');
    const heldResult = await withProjectMutationLock(f.projectRoot, (lease) => executeRepositoryRulesets({ ...heldInput, lease }));
    await f.persist(heldInput, heldResult);
    const hold = object(object(heldResult.evidencePayload).mainHold);
    const main = f.protocol.controls.find((entry) => entry.name === 'liftoff-gitflow-main')!;
    expect(main.rules).toContainEqual({ type: 'update', parameters: { update_allows_fetch_and_merge: false } });
    f.input.now.setTime(f.input.now.getTime() + 1);
    configuration.phases['rulesets-applied']!.mainHold = 'replace';
    inspection.scope = 'activation';
    const withoutRehearsal = inspection.evidence;
    inspection.evidence = withoutRehearsal.filter((entry) => entry.header.phaseId !== 'production-rehearsed');
    expect((await planRepositoryRulesets(f.planning())).blockers?.join(' ')).toMatch(/production-rehearsed/u);
    inspection.evidence = withoutRehearsal;
    const planned = await planRepositoryRulesets(f.planning());
    expect(planned.blockers, planned.blockers?.join(' ')).toEqual([]);
    const approved = await f.issue(planned.operations);
    f.protocol.requests.length = 0;
    const semantic = boundedSemanticReaderPorts(f);
    try {
      const expired = await withProjectMutationLock(f.projectRoot, (lease) =>
        executeRepositoryRulesets({ ...approved, lease, clock: () => new Date(approved.plan.expiresAt) }));
      expect(expired.status).toBe('blocked');
      expect(expired.blocker).toMatch(/expired/u);
      expect(f.protocol.requests).toEqual([]);
      const mainSha = f.protocol.refs.get('main')!;
      f.protocol.refs.set('main', 'd'.repeat(40));
      const drift = await withProjectMutationLock(f.projectRoot, (lease) => executeRepositoryRulesets({ ...approved, lease }));
      expect(drift.status).toBe('blocked');
      expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
      f.protocol.refs.set('main', mainSha);
      const prior = structuredClone(main.rules);
      main.rules = [...(main.rules as unknown[]), { type: 'required_signatures' }];
      expect((await withProjectMutationLock(f.projectRoot, (lease) => executeRepositoryRulesets({ ...approved, lease }))).status).toBe('blocked');
      expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
      main.rules = prior;
      const result = await withProjectMutationLock(f.projectRoot, (lease) => executeRepositoryRulesets({ ...approved, lease }));
      expect(result.status, result.blocker).toBe('completed');
      expect(result.evidencePayload).toMatchObject({ scope: 'activation', mainHold: null, replacedHoldDigest: canonicalSha256(hold) });
      expect(f.protocol.requests.filter((request) => request.method !== 'GET')).toMatchObject([
        { method: 'PUT', path: `/repos/owner/repo/rulesets/${main.id}` }
      ]);
      expect(main.rules).not.toContainEqual({ type: 'update', parameters: { update_allows_fetch_and_merge: false } });
      expect(canonicalJson(f.record)).toBe(f.retained);
    } finally { semantic.restore(); }
  }, 90_000);

  it('retains full-check original artifact custody and revalidates native assertions under distinct current authority (bounded semantic port)', async () => {
    const f = await fixture(true);
    const current = await f.currentRead();
    expect(current.operation.inputs.failedWorkflowArtifacts).toMatchObject([
      { origin: { phaseId: 'green-red-proof' } }, { origin: { phaseId: 'green-red-proof' } },
      { origin: { phaseId: 'green-red-proof' } }, { origin: { phaseId: 'green-red-proof' } }
    ]);
    expect(f.protocol.requests.some((request) => request.binary)).toBe(false);
    // No genuine Azure receipt exists in this fixture: the default reader must refuse it.
    await expect(f.revalidate(current)).rejects.toThrow(/original activation receipt/u);
    const semanticPort = vi.spyOn(predecessors, 'enforcementProductionPredecessorVerifier')
      .mockReturnValue(() => structuredClone(f.predecessor));
    try {
      const result = await f.revalidate(current);
      expect(result.requirements).toHaveLength(4);
      expect(result.artifactReadbacks).toHaveLength(4);
      expect(f.protocol.requests.some((request) => request.binary)).toBe(true);
      expect(f.protocol.requests.some((request) => request.method !== 'GET')).toBe(false);
      expect(canonicalJson(f.record)).toBe(f.retained);
      const negative = f.evidence.controlledNegativeChecks[0]!;
      f.protocol.jobLogs.set(negative.jobId, 'Generic infrastructure failure is not the native assertion.');
      await expect(f.revalidate(current)).rejects.toThrow(/assertion|native/u);
    } finally { semanticPort.mockRestore(); }
  });

  it('refuses full-check artifact consumption without its exact original plan inventory or current issuance', async () => {
    const f = await fixture(true);
    await expect(f.revalidate(await f.currentRead((operation) => { delete operation.inputs.originalFixturePlans; })))
      .rejects.toThrow(/every exact original performed fixture-plan reference/u);
    await expect(f.revalidate(await f.currentRead(undefined, false))).rejects.toThrow(/authority|issuance|issued/u);
    expect(f.protocol.requests.some((request) => request.binary || request.method !== 'GET')).toBe(false);
  });

  it('rejects reapproved full-check fixture or predecessor drift before any provider effect', async () => {
    const f = await fixture(true);
    for (const change of [
      (operation: TransitionOperation) => {
        const bindings = operation.inputs.fixtureBindings as Array<{ polarity: string }>;
        bindings[0]!.polarity = 'negative';
      },
      (operation: TransitionOperation) => {
        object(object(operation.inputs.predecessors).staging).headerDigest = 'f'.repeat(64);
      }
    ]) {
      const operation = structuredClone(f.input.plan.operations[0]!);
      change(operation);
      const approved = await f.issue([operation], 'green-red-proof');
      f.protocol.requests.length = 0;
      const outcome = await withProjectMutationLock(f.projectRoot, (lease) =>
        executeFullActivationChecks({ ...approved, lease }, { predecessorVerifier: () => f.predecessor }));
      expect(outcome.status, outcome.blocker).toBe('blocked');
      expect(outcome.blocker).toMatch(/reviewed.*(?:scope|configuration)/u);
      expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
      expect(canonicalJson(f.record)).toBe(f.retained);
    }
  });

  it('reads a real failed full-origin dispatch as an opaque fragment under a separate current enforcement read grant', async () => {
    const declaration = sourceCheckFixtureArtifact('node-tests', 'node-test.v1', '.');
    const source = dispatchFixtureSource +
      `      - name: Upload controlled fixture\n        if: always()\n        uses: actions/upload-artifact@${'b'.repeat(40)}\n        with:\n          name: ${declaration.name}\n          path: ${declaration.path}\n          if-no-files-found: error\n`;
    const protocol = new EnforcementArtifactProtocol(source, [controlledNodeTestFixture('negative')]);
    const binding: WorkflowRunBinding = {
      repository: 'owner/repo', repositoryId: 42, workflowPath: workflowFixturePath, workflowId: 4,
      workflowDigest: canonicalSha256(source), sourceSha: protocol.baseSha, producerSourceSha: protocol.baseSha,
      ref: 'develop', actorId: 7, event: 'workflow_dispatch', expectedJobs: ['Node source validation'], runAttempt: 1
    };
    const dispatchInputs = { environment: 'dev' };
    const original: TransitionOperation = {
      phaseId: 'dev-proof', adapter: 'github', actionId: 'github.checks.dev-proof', mutationClass: 'github-workflow-dispatch',
      remote: true, destructive: false, destination: { type: 'repository', identity: 'owner/repo', repository: 'owner/repo' },
      inputs: { workflow: binding, dispatchInputs },
      effects: [{ mutationClass: 'github-read', remote: true, destructive: false,
        destination: { type: 'repository', identity: 'owner/repo', repository: 'owner/repo' } }]
    };
    const f = await workflowOperationFixture('dev-proof', [original], protocol.runner);
    await retainFixture(f.root);
    f.input.adapters.githubActivation!.transport = protocol;
    const request = await withProjectMutationLock(f.projectRoot, async (lease): Promise<FailedWorkflowArtifactRequest> => {
      const execution = { ...f.input, lease };
      const dispatched = await dispatchApprovedWorkflowRun(execution, original, binding, dispatchInputs);
      if (dispatched.status !== 'completed' || dispatched.operation.status !== 'failed') {
        throw new Error('The actual isolated dispatch did not return its failed provider handle.');
      }
      await assertGitHubPhaseAuthority(execution, original);
      const client = new GitHubActivationClient(protocol);
      const run = await readBoundWorkflowRun(client, binding, dispatched.operation);
      const artifacts = await client.list(`${dispatched.operation.resourceId}/artifacts`, 'artifacts');
      if (artifacts.length !== 1 || run.jobs.length !== 1) throw new Error('The failed producer did not return one exact artifact/job.');
      const artifact = artifacts[0]!, job = run.jobs[0]!;
      return {
        origin: { kind: 'workflow-dispatch', phaseId: 'dev-proof', planDigest: f.input.plan.planDigest,
          savedPlanDigest: canonicalSha256(f.input.plan), operationDigest: canonicalSha256(original) },
        binding, operation: dispatched.operation,
        job: { jobKey: 'verify', name: job.name, jobId: job.id, checkRunId: job.checkRunId, appId: job.appId,
          validationStep: 'Validate source', uploadStep: 'Upload controlled fixture' },
        artifact: { artifactId: positiveId(artifact.id), name: String(artifact.name), digest: String(artifact.digest) }
      };
    });
    const originalBytes = canonicalJson(f.input.plan);
    f.input.inspection.contexts['dev-proof'].reviewedPlans = [f.input.plan];
    f.input.now.setTime(f.input.now.getTime() + 1_200_000);
    const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'rulesets-applied')!;
    const context = f.input.inspection.contexts[phase.id];
    const operation: TransitionOperation = {
      phaseId: phase.id, adapter: 'github', actionId: 'github.ruleset.readback', mutationClass: 'github-read',
      destination: original.destination, remote: true, destructive: false,
      inputs: { repository: 'owner/repo', failedWorkflowArtifacts: [request] }
    };
    const requested = transitionPlanForPhase(phase, f.input.inspection.state, context.transition, f.projectRoot, undefined, {
      operations: [operation], selectionScope: 'activation'
    });
    const expiresAt = new Date(f.input.now.getTime() + 900_000).toISOString();
    const envelope = validateApprovalEnvelope({ ...requested, schemaVersion: 4, id: randomUUID(),
      approvedAt: f.input.now.toISOString(), expiresAt, approver: 'isolated-full-enforcement-reader' });
    await writeGovernanceApprovalAuthority(f.projectRoot, canonicalSha256(requested), envelope, f.storage);
    f.input.inspection.approvals = [...f.input.inspection.approvals, envelope];
    const evaluation = evaluateApprovalForTransitionPlan(requested, [envelope], { now: f.input.now });
    const plan = validateSavedTransitionPlan({
      schemaVersion: 2, scope: 'activation', selectionScope: 'activation', phaseId: phase.id,
      identity: currentActivationIdentity, graphHash: canonicalPhaseGraphHash,
      createdAt: f.input.now.toISOString(), expiresAt, stateHash: canonicalSha256(f.input.inspection.state),
      baselineDigest: context.baselineSha, inputDigest: context.inputDigest, transitionDigest: context.transition.transitionDigest,
      operations: [operation], mutationClasses: phase.allowedMutations,
      planDigest: planDigestFor({ phase, transitionDigest: context.transition.transitionDigest,
        operations: [operation], approvalPlanDigest: requested.planDigest }),
      approval: { gateKind: phase.approvalGate.kind, required: phase.approvalGate.required, evaluation,
        envelopeId: evaluation.envelopeId, envelopeHash: evaluation.envelopeHash },
      rollbackPlan: rollbackPlanForPhase(phase), noSecrets: true
    });
    const current = { ...f.input, phase, plan };
    protocol.requests.length = 0;
    const fragments = await withProjectMutationLock(f.projectRoot, (lease) =>
      readFullControlFailedArtifacts(current, { execution: { ...current, lease }, operation }, [request]));
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toMatchObject({ conclusion: 'failure', artifactId: request.artifact.artifactId,
      runId: Number(request.operation.operationId), digest: request.artifact.digest, origin: request.origin });
    expect(fragments[0]!.archive).toEqual(protocol.artifacts.get(request.artifact.artifactId)!.bytes);
    expect(fragments[0]).not.toHaveProperty('qualified');
    expect(fragments[0]).not.toHaveProperty('applicationSourceSha');
    expect(protocol.requests.every((entry) => entry.method === 'GET')).toBe(true);
    expect(protocol.requests.some((entry) => /\/runs\/\d+\/artifacts/u.test(entry.path))).toBe(false);
    expect(protocol.runs.size).toBe(1);
    expect(canonicalJson(f.input.plan)).toBe(originalBytes);
  });

  it('rejects repository-origin archives under a fresh full-scope read approval', async () => {
    const f = await fixture();
    const current = await f.currentRead();
    const operation = { ...current.operation, phaseId: 'rulesets-applied' as const };
    const execution = await f.issue([operation], 'rulesets-applied');
    const requests = f.evidence.controlledNegativeChecks.map((proof) => proof.fixtureArtifact!.request);
    f.protocol.requests.length = 0;
    await expect(withProjectMutationLock(f.projectRoot, (lease) =>
      readFullControlFailedArtifacts(execution, { execution: { ...execution, lease }, operation }, requests)))
      .rejects.toThrow(/Repository fixture archives cannot supply full/u);
    expect(f.protocol.requests).toEqual([]);
  });

  it('plans retained reads without archive access and consumes them with fresh authority after producer expiry', async () => {
    const f = await fixture();
    const read = await f.currentRead();
    expect(f.protocol.requests.some((request) => request.binary || /\/artifacts(?:\/|$)/u.test(request.path))).toBe(false);
    expect(read.operation.mutationClass).toBe('github-read');
    expect(read.operation.inputs.failedWorkflowArtifacts).toEqual(f.evidence.controlledNegativeChecks.map((proof) => proof.fixtureArtifact!.request));
    const origin = f.evidence.controlledNegativeChecks[0]!.fixtureArtifact!.request.origin;
    expect(read.operation.inputs.originalFixturePlans).toEqual([{
      phaseId: origin.phaseId, planDigest: origin.planDigest,
      savedPlanDigest: origin.savedPlanDigest, operationDigest: origin.operationDigest
    }]);
    expect(Date.parse(f.envelope.expiresAt)).toBeLessThan(f.input.now.getTime());
    f.protocol.requests.length = 0;
    const result = await f.revalidate(read);
    expect(result.artifactReadbacks).toHaveLength(4);
    expect(f.protocol.requests.some((request) => request.binary)).toBe(true);
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(f.protocol.requests.some((request) => /\/runs\/\d+\/artifacts/u.test(request.path))).toBe(false);
    expect(canonicalJson(f.record)).toBe(f.retained);
  });

  it('wires real artifact revalidation before owned effects and emits actual artifact readback resources', async () => {
    const f = await fixture();
    const planned = await planRepositoryRulesets(f.planning());
    expect(planned.blockers).toEqual([]);
    const execution = await f.issue(planned.operations);
    f.protocol.requests.length = 0;
    const outcome = await withProjectMutationLock(f.projectRoot, (lease) => executeRepositoryRulesets({ ...execution, lease }));
    expect(outcome.status, outcome.blocker).toBe('completed');
    const firstWrite = f.protocol.requests.findIndex((request) => request.method !== 'GET');
    expect(firstWrite).toBeGreaterThan(0);
    expect(f.protocol.requests.slice(0, firstWrite).some((request) => request.binary)).toBe(true);
    expect(outcome.liveReadback?.filter((proof) => proof.resourceType === 'workflow-artifact')).toHaveLength(4);
    expect(f.protocol.pullRequests.size).toBe(8);
    expect(f.protocol.runs.size).toBe(8);
    expect(f.protocol.refs.get('main')).toBe(f.protocol.mainSha);
    expect(f.protocol.repository.foreign_setting).toBe('preserved');
    const applied = await f.persist(execution, outcome);
    const live = await planRepositoryLiveReadback(f.planning('repository-live-readback'));
    expect(live.operations[0]!.inputs.failedWorkflowArtifacts).toEqual(
      execution.plan.operations.find((operation) => operation.actionId === 'github.ruleset.readback')!.inputs.failedWorkflowArtifacts);
    const unissued = await f.issue(live.operations, 'repository-live-readback', false);
    f.inspection.approvals = f.inspection.approvals.filter((entry) => entry.id !== execution.plan.approval.envelopeId);
    f.protocol.requests.length = 0;
    const blocked = await withProjectMutationLock(f.projectRoot, (lease) => executeRepositoryLiveReadback({ ...unissued, lease }));
    expect(blocked.status).toBe('blocked');
    expect(f.protocol.requests.some((request) => request.binary)).toBe(false);
    expect(applied.header.result).toBe('verified');
  });

  it('rejects a missing current exact artifact inventory before provider revalidation', async () => {
    const f = await fixture();
    const read = await f.currentRead((operation) => { delete operation.inputs.failedWorkflowArtifacts; });
    f.protocol.requests.length = 0;
    await expect(f.revalidate(read)).rejects.toThrow(/exact retained request inventory/u);
    expect(f.protocol.requests).toEqual([]);
  });

  it('rejects a different freshly approved artifact request instead of repinning the original', async () => {
    const f = await fixture();
    const read = await f.currentRead((operation) => {
      const requests = operation.inputs.failedWorkflowArtifacts as FailedWorkflowArtifactRequest[];
      requests[0]!.artifact.artifactId++;
    });
    f.protocol.requests.length = 0;
    await expect(f.revalidate(read)).rejects.toThrow(/exact retained request inventory/u);
    expect(f.protocol.requests).toEqual([]);
  });

  it('requires the original performed fixture-plan reference in the current read approval', async () => {
    const f = await fixture();
    const read = await f.currentRead((operation) => { delete operation.inputs.originalFixturePlans; });
    f.protocol.requests.length = 0;
    await expect(f.revalidate(read)).rejects.toThrow(/every exact original performed fixture-plan reference/u);
    expect(f.protocol.requests).toEqual([]);
  });

  it('rejects a different approved original-plan reference rather than relabeling old fixture custody', async () => {
    const f = await fixture();
    const read = await f.currentRead((operation) => {
      const references = operation.inputs.originalFixturePlans;
      if (!Array.isArray(references) || references.length !== 1) throw new Error('The producer did not retain one exact original fixture plan.');
      object(references[0]).planDigest = 'f'.repeat(64);
    });
    f.protocol.requests.length = 0;
    await expect(f.revalidate(read)).rejects.toThrow(/every exact original performed fixture-plan reference/u);
    expect(f.protocol.requests).toEqual([]);
  });

  it('requires current private issuance rather than the expired original producer approval', async () => {
    const f = await fixture();
    const read = await f.currentRead(undefined, false);
    f.protocol.requests.length = 0;
    await expect(f.revalidate(read)).rejects.toThrow(/issued|private/u);
    expect(f.protocol.requests).toEqual([]);
  });

  it('requires the actual held current project lease even with an issued exact read approval', async () => {
    const f = await fixture();
    const read = await f.currentRead();
    f.protocol.requests.length = 0;
    await expect(revalidateApprovedRepositoryChecks(read.execution, f.client, f.record, f.binding, f.protocol.baseSha, read))
      .rejects.toThrow(/project mutation lease/u);
    expect(f.protocol.requests).toEqual([]);
  });

  it('refuses to plan a declared artifact whose original retained descriptor is missing', async () => {
    const f = await fixture();
    delete object(f.evidence.controlledNegativeChecks[0]).fixtureArtifact;
    f.record.header.bodyDigest = evidenceBodyDigest(f.record.payload, f.record.liveReadback);
    const references = f.inspection.state.phases['repository-checks-qualified'].evidence.map((entry) =>
      entry.evidenceId === f.record.evidenceId ? { ...entry, headerDigest: canonicalSha256(f.record.header) } : entry);
    f.inspection.state.phases['repository-checks-qualified'].evidence = references;
    f.inspection.contexts['repository-checks-qualified'].evidenceReferences = references;
    f.protocol.requests.length = 0;
    const planned = await planRepositoryRulesets(f.planning());
    expect(planned.operations).toEqual([]);
    expect(planned.blockers?.join(' ')).toMatch(/complete private-custody reference/u);
    expect(f.protocol.requests.some((request) => request.binary || /\/runs\/\d+\/artifacts/u.test(request.path))).toBe(false);
  });

  it('rejects current approval expiry at the exact boundary without refreshing any original timestamp', async () => {
    const f = await fixture();
    const read = await f.currentRead();
    f.input.now.setTime(Date.parse(read.execution.plan.expiresAt));
    f.protocol.requests.length = 0;
    await expect(f.revalidate(read)).rejects.toThrow(/expired/u);
    expect(f.protocol.requests).toEqual([]);
    expect(canonicalJson(f.record)).toBe(f.retained);
  });

  it('rechecks current authority when approval expires during the actual archive download', async () => {
    const f = await fixture();
    const read = await f.currentRead();
    f.protocol.beforeRequest = async (request) => {
      if (request.binary) f.input.now.setTime(Date.parse(read.execution.plan.expiresAt));
    };
    await expect(f.revalidate(read)).rejects.toThrow(/expired/u);
    expect(canonicalJson(f.record)).toBe(f.retained);
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('rejects artifact and recipe stripping even after public receipt and state hashes are recomputed', async () => {
    const f = await fixture();
    const payload = object(f.record.payload);
    delete payload.boundFixtures;
    delete payload.requiredContexts;
    for (const check of f.evidence.requiredChecks) {
      const descriptor = object(check);
      delete descriptor.recipe;
      delete descriptor.workingDirectory;
      delete descriptor.fixtureArtifact;
    }
    for (const proof of f.evidence.controlledNegativeChecks) delete object(proof).fixtureArtifact;
    f.record.header.bodyDigest = evidenceBodyDigest(payload, f.record.liveReadback);
    const references = f.inspection.state.phases['repository-checks-qualified'].evidence.map((entry) =>
      entry.evidenceId === f.record.evidenceId ? { ...entry, headerDigest: canonicalSha256(f.record.header) } : entry);
    f.inspection.state.phases['repository-checks-qualified'].evidence = references;
    f.inspection.contexts['repository-checks-qualified'].evidenceReferences = references;
    f.protocol.requests.length = 0;
    const planned = await planRepositoryRulesets(f.planning());
    expect(planned.operations).toEqual([]);
    expect(planned.blockers?.join(' ')).toMatch(/immutable source declares a registered fixture artifact/u);
    expect(f.protocol.requests.some((request) => request.binary || request.method !== 'GET')).toBe(false);
  });

  it('requires the original private artifact observation and never rediscovers a missing one', async () => {
    const f = await fixture();
    const read = await f.currentRead();
    const proof = f.evidence.controlledNegativeChecks[0]!.fixtureArtifact!;
    const stored = await createScopedUserLocalRecordStore(f.projectRoot, 'governance-operation', f.storage).read(proof.recordKey);
    if (!stored || !stored.path.startsWith(`${f.home}${path.sep}`)) throw new Error('Missing exact owned artifact record.');
    await rm(stored.path);
    f.protocol.requests.length = 0;
    await expect(f.revalidate(read)).rejects.toThrow(/original project-bound private provider observation/u);
    expect(f.protocol.requests.some((request) => request.binary || /\/runs\/\d+\/artifacts/u.test(request.path))).toBe(false);
  });

  it('requires original fixture publication custody even with a fresh current read grant', async () => {
    const f = await fixture();
    const read = await f.currentRead();
    const negative = f.evidence.boundFixtures.find((entry) => entry.polarity === 'negative')!;
    const stages = await readWorkflowPublicationCheckpoints(f.input, f.input.plan.operations[0]!, negative.publication);
    const prepared = stages.find((entry) => entry.step === 'tree')!.records!.prepared;
    const store = createScopedUserLocalRecordStore(f.projectRoot, 'governance-operation', f.storage);
    const key = canonicalSha256({ intentDigest: prepared.intentDigest, attempt: prepared.attempt, stage: 'prepared' });
    const stored = await store.read(key);
    if (!stored || !stored.path.startsWith(`${f.home}${path.sep}`)) throw new Error('Missing exact owned original tree checkpoint.');
    await rm(stored.path);
    f.protocol.requests.length = 0;
    await expect(f.revalidate(read)).rejects.toThrow(/original tree\/commit\/ref\/PR|checkpoint/u);
    expect(f.protocol.requests.some((request) => request.binary)).toBe(false);
  });

  it('rejects changed original artifact custody even when the replacement private record is internally well formed', async () => {
    const f = await fixture();
    const read = await f.currentRead();
    const proof = f.evidence.controlledNegativeChecks[0]!.fixtureArtifact!;
    const store = createScopedUserLocalRecordStore(f.projectRoot, 'governance-operation', f.storage);
    const stored = await store.read(proof.recordKey);
    if (!stored || !stored.path.startsWith(`${f.home}${path.sep}`)) throw new Error('Missing exact owned artifact record.');
    const changed = structuredClone(object(stored.value));
    const request = object(changed.request);
    object(request.artifact).artifactId = positiveId(object(request.artifact).artifactId) + 1;
    changed.requestDigest = canonicalSha256(request);
    await rm(stored.path);
    await store.write(proof.recordKey, changed);
    f.protocol.requests.length = 0;
    await expect(f.revalidate(read)).rejects.toThrow(/retained artifact provider ID/u);
    expect(f.protocol.requests.some((entry) => entry.binary || /\/runs\/\d+\/artifacts/u.test(entry.path))).toBe(false);
    expect(canonicalJson(f.record)).toBe(f.retained);
  });

  it('retains the actual failed run on artifact visibility delay without dispatching or writing controls', async () => {
    const f = await fixture();
    const planned = await planRepositoryRulesets(f.planning());
    const execution = await f.issue(planned.operations);
    const request = f.evidence.controlledNegativeChecks[0]!.fixtureArtifact!.request;
    f.protocol.pendingArtifact = request.artifact.artifactId;
    f.protocol.requests.length = 0;
    const outcome = await withProjectMutationLock(f.projectRoot, (lease) => executeRepositoryRulesets({ ...execution, lease }));
    expect(outcome).toMatchObject({ status: 'blocked', operation: request.operation });
    expect(f.protocol.requests.every((entry) => entry.method === 'GET')).toBe(true);
    const next = blockedState({ inspection: f.inspection, phase: execution.phase, plan: execution.plan, now: f.input.now,
      blocker: outcome.blocker!, executionStarted: true, operation: outcome.operation });
    f.inspection.state = next;
    f.inspection.contexts[execution.phase.id].reviewedPlans = [execution.plan];
    f.inspection.recoverPhase = execution.phase.id;
    const recovery = await planRepositoryRulesets(f.planning());
    expect(recovery.blockers).toEqual([]);
    expect(recovery.operations).toEqual(execution.plan.operations);
    f.protocol.pendingArtifact = undefined;
    const read = execution.plan.operations.find((entry) => entry.actionId === 'github.ruleset.readback')!;
    const result = await f.revalidate({ execution, operation: read });
    expect(result.artifactReadbacks).toHaveLength(4);
    expect(f.protocol.requests.some((entry) => /\/runs\/\d+\/artifacts/u.test(entry.path))).toBe(false);
    expect(f.protocol.runs.size).toBe(8);
  });
});
