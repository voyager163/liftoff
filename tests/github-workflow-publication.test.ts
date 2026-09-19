import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { activationProducerFixture } from './helpers/activation-producer-fixture.js';
import { WorkflowGitHubFixture, workflowFixtureNow, workflowFixturePath, workflowFixtureSource } from './helpers/workflow-publication-fixture.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { assertPhaseOutputsBound, evidenceHeaderDigest, validateEvidenceFreshness } from '../src/domain/governance/activation/evidence.js';
import { canonicalPhaseGraph } from '../src/domain/governance/activation/graph.js';
import { executeRepositoryWorkflowSource, planRepositoryWorkflowSource } from '../src/application/repository-governance/producer-workflow-source.js';
import { executeGitHubPhase } from '../src/governance-activation/phase-github.js';
import { readWorkflowEffect } from '../src/application/repository-governance/workflow-checkpoints.js';
import { GitHubActivationClient } from '../src/adapters/github/activation-rest.js';
import { planWorkflowSourcePublication, type WorkflowPublicationPlan } from '../src/adapters/github/production-workflows.js';
import { gitObjectSha, treeWithFiles, workflowCommitSha } from '../src/adapters/github/workflow-git-objects.js';
import { blockedState, evidenceHeaderFor, writeOutcomeTransaction } from '../src/governance-activation/transition-records.js';
import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome } from '../src/governance-activation/transition-ports.js';
import type { PhaseEvidenceRecord } from '../src/domain/governance/activation/types.js';

const fixtures: Awaited<ReturnType<typeof activationProducerFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

async function publicationFixture(phaseId: 'repository-workflow-source-ready' | 'bootstrap-workflow-source-ready' | 'workflow-source-ready' = 'repository-workflow-source-ready') {
  const ruleset = { path: '.github/rulesets/develop.json', content: '{"name":"Reviewed source control","target":"branch","enforcement":"active","rules":[{"type":"deletion"}]}\n' };
  const additional = phaseId === 'workflow-source-ready' ? [ruleset] : [];
  const protocol = new WorkflowGitHubFixture(`${workflowFixtureSource}\n# Existing published workflow\n`, additional);
  const f = await activationProducerFixture(phaseId, {
    sourceSha: protocol.baseSha, paths: [workflowFixturePath, ...additional.map((file) => file.path)],
    publication: { featureBranch: 'automation/liftoff-reviewed-workflow', repositoryId: 42, actorId: 7,
      commitTime: workflowFixtureNow, commitMessage: 'Publish reviewed source workflow' }
  }, protocol.runner);
  fixtures.push(f);
  f.inspection.scope = phaseId === 'repository-workflow-source-ready' ? 'repository' : 'activation';
  const workflowFile = path.join(f.projectRoot, workflowFixturePath);
  await mkdir(path.dirname(workflowFile), { recursive: true });
  await writeFile(workflowFile, workflowFixtureSource);
  for (const file of additional) {
    await mkdir(path.dirname(path.join(f.projectRoot, file.path)), { recursive: true });
    await writeFile(path.join(f.projectRoot, file.path), file.content);
  }
  await f.refreshInputs();
  const approve = async () => {
    const input = await f.approve();
    input.adapters.githubActivation = { storage: f.storage };
    return input;
  };
  const execute = (input: PhaseAdapterExecutionInput) => withProjectMutationLock(f.projectRoot,
    async (lease) => {
      const result = await executeGitHubPhase({ ...input, lease });
      if (!result) throw new Error('The registered workflow phase has no GitHub executor.');
      return result;
    });
  return { ...f, protocol, workflowFile, approve, execute };
}

function assertReusableOutputs(input: PhaseAdapterExecutionInput, outcome: PhaseAdapterOutcome) {
  if (outcome.status !== 'completed' || !outcome.outputs || !isRecord(outcome.evidencePayload)) {
    throw new Error('A completed actual producer outcome is required.');
  }
  const payload = { ...outcome.evidencePayload, outputBindings: outcome.outputs,
    planDigest: input.plan.planDigest, savedPlanDigest: canonicalSha256(input.plan) };
  const header = evidenceHeaderFor({
    inspection: input.inspection, phase: input.phase, plan: input.plan, result: 'verified',
    now: input.now, payload, liveReadback: outcome.liveReadback
  });
  const record: PhaseEvidenceRecord = { evidenceId: 'workflow-source-output-fixture', header, payload, liveReadback: outcome.liveReadback };
  const state = structuredClone(input.inspection.state);
  state.phaseOutputs = { [input.phase.id]: outcome.outputs };
  state.phases[input.phase.id] = {
    ...state.phases[input.phase.id], state: 'verified',
    evidence: [{ evidenceId: record.evidenceId, phaseId: input.phase.id, headerDigest: evidenceHeaderDigest(header), result: 'verified' }]
  };
  expect(() => assertPhaseOutputsBound(state, [record])).not.toThrow();
  const validation = validateEvidenceFreshness(record, {
    ...input.inspection.contexts[input.phase.id], reviewedPlans: [input.plan], inputDigest: input.plan.inputDigest,
    evidenceReferences: [{
      evidenceId: record.evidenceId, phaseId: input.phase.id,
      pathParts: ['governance', 'evidence', `${record.evidenceId}.json`],
      headerDigest: evidenceHeaderDigest(header), producedAt: header.producedAt, result: header.result
    }], now: input.now
  });
  expect(validation.valid, JSON.stringify(validation.issues)).toBe(true);
}

describe('checkpointed approved GitFlow workflow publication', () => {
  it.each(['repository-workflow-source-ready', 'bootstrap-workflow-source-ready', 'workflow-source-ready'] as const)(
    'emits engine-consumable resource readback for published and reverified %s workflows', async (phaseId) => {
      const f = await publicationFixture(phaseId);
      const input = await f.approve();
      expect((await f.execute(input)).status).toBe('pending');
      const sourceSha = f.protocol.merge(1);
      const published = await f.execute(input);
      assertReusableOutputs(input, published);
      const config = f.inspection.activationInputs!.phases[phaseId]!;
      delete config.publication;
      config.sourceSha = sourceSha;
      await f.refreshInputs();
      const read = await f.approve();
      const before = f.protocol.requests.filter((request) => request.method !== 'GET').length;
      const verified = await f.execute(read);
      assertReusableOutputs(read, verified);
      expect(f.protocol.requests.filter((request) => request.method !== 'GET')).toHaveLength(before);
    }
  );

  it.each(['repository-workflow-source-ready', 'bootstrap-workflow-source-ready', 'workflow-source-ready'] as const)(
    'uses real scoped default GitHub transport and pre-effect private records for %s', async (phaseId) => {
      const f = await publicationFixture(phaseId);
      const input = await f.approve();
      const operation = input.plan.operations.find((op) => op.actionId === 'github.workflow-source.publish')!;
      const publication = operation.inputs.publication as WorkflowPublicationPlan;
      const stages: string[] = [];
      f.protocol.beforeRequest = async (request) => {
        if (request.method === 'GET') return;
        const step = request.path.endsWith('/trees') ? 'tree' : request.path.endsWith('/commits') ? 'commit' :
          request.path.endsWith('/refs') ? 'ref' : 'pull-request';
        const records = await readWorkflowEffect(input, operation, {
          repositoryId: 42, ref: publication.featureBranch, purpose: 'workflow-publication', step
        }, request);
        expect(records?.prepared).toMatchObject({ planDigest: input.plan.planDigest, operationDigest: canonicalSha256(operation) });
        expect(records?.response).toBeNull();
        stages.push(step);
      };
      const first = await f.execute(input);
      expect(first).toMatchObject({ status: 'pending', operation: { provider: 'github', operationId: '1', resourceId: '/repos/owner/repo/pulls/1' } });
      expect(stages).toEqual(['tree', 'commit', 'ref', 'pull-request']);
      expect(f.protocol.refs.get('main')).toBe(f.protocol.mainSha);
      expect(f.protocol.refs.get('develop')).toBe(f.protocol.baseSha);
      expect(await readFile(f.workflowFile, 'utf8')).toBe(workflowFixtureSource);
      const commit = f.protocol.commits.get(publication.commitSha)!;
      const tree = f.protocol.trees.get((commit.tree as { sha: string }).sha)!;
      expect(tree.find((entry) => entry.path === 'README.md')?.sha).toBe(gitObjectSha('blob', 'Unrelated project-owned bytes.\n'));
      expect(f.protocol.requests.filter((request) => request.method !== 'GET').map((request) => request.path)).toEqual([
        '/repos/owner/repo/git/trees', '/repos/owner/repo/git/commits', '/repos/owner/repo/git/refs', '/repos/owner/repo/pulls'
      ]);
    });

  it('reads the same pending PR without writes, then independently verifies the exact permitted merge source', async () => {
    const f = await publicationFixture();
    const input = await f.approve();
    expect((await f.execute(input)).status).toBe('pending');
    expect((await f.execute(input)).status).toBe('pending');
    const source = f.protocol.merge(1);
    const result = await f.execute(input);
    expect(result).toMatchObject({ status: 'completed', evidencePayload: {
      sourceSha: source, pullRequestNumber: 1, repositoryId: 42, actorId: 7,
      files: [{ path: workflowFixturePath, digest: canonicalSha256(workflowFixtureSource), readbackDigest: canonicalSha256(workflowFixtureSource) }]
    } });
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(4);
    expect(f.protocol.refs.get('main')).toBe(f.protocol.mainSha);
  });

  it.each(['trees', 'commits', 'refs', 'pulls'])('recovers a lost %s response from immutable recorded identities without duplicate requests', async (resource) => {
    const f = await publicationFixture();
    const input = await f.approve();
    const endpoint = resource === 'pulls' ? '/repos/owner/repo/pulls' : `/repos/owner/repo/git/${resource}`;
    f.protocol.loseResponseFor = `POST ${endpoint}`;
    expect((await f.execute(input)).status).toBe('blocked');
    expect((await f.execute(input)).status).toBe('pending');
    expect(f.protocol.requests.filter((request) => request.method === 'POST' && request.path === endpoint)).toHaveLength(1);
  });

  it('does not retry an uncertain branch creation when a subsequent read reports absence', async () => {
    const f = await publicationFixture();
    const input = await f.approve();
    f.protocol.loseResponseFor = 'POST /repos/owner/repo/git/refs';
    expect((await f.execute(input)).status).toBe('blocked');
    f.protocol.refs.delete('automation/liftoff-reviewed-workflow');
    expect(await f.execute(input)).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('never authorizes redispatch') });
    expect(f.protocol.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/refs'))).toHaveLength(1);
  });

  it('only retries a known rejected effect under newly issued exact recovery authority', async () => {
    const f = await publicationFixture();
    const original = await f.approve();
    f.protocol.rejectRequestFor = 'POST /repos/owner/repo/git/refs';
    const failure = await f.execute(original);
    expect(failure.status).toBe('blocked');
    f.protocol.rejectRequestFor = null;
    expect((await f.execute(original)).status).toBe('blocked');
    const next = blockedState({
      inspection: f.inspection, phase: original.phase, plan: original.plan, now: f.now,
      blocker: failure.blocker!, executionStarted: true
    });
    await writeOutcomeTransaction({ projectRoot: f.projectRoot, plan: original.plan, nextState: next,
      expectedStateHash: f.inspection.loadedState!.contentHash });
    f.inspection.state = next;
    await f.refreshInputs();
    f.inspection.recoverPhase = original.phase.id;
    f.inspection.contexts[original.phase.id].reviewedPlans = [original.plan];
    f.inspection.readiness.phases[original.phase.id] = { state: 'blocked', plannable: true, blockers: ['Exact recovery requested.'] };
    const recovery = await f.approve();
    recovery.recovery = true;
    expect(recovery.plan.approval.envelopeHash).not.toBe(original.plan.approval.envelopeHash);
    expect((await f.execute(recovery)).status).toBe('pending');
    expect(f.protocol.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/refs'))).toHaveLength(2);
    expect(f.protocol.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/trees'))).toHaveLength(1);
  });

  it.each(['actor', 'repository', 'base', 'main', 'controls', 'source'] as const)('rejects current %s drift before any remote effect', async (field) => {
    const f = await publicationFixture();
    const input = await f.approve();
    if (field === 'actor') f.protocol.actorId = 8;
    if (field === 'repository') f.protocol.repositoryId = 43;
    if (field === 'base') f.protocol.refs.set('develop', 'c'.repeat(40));
    if (field === 'main') f.protocol.refs.set('main', 'c'.repeat(40));
    if (field === 'controls') f.protocol.controls.push({ id: 9, name: 'foreign', enforcement: 'active' });
    if (field === 'source') await writeFile(f.workflowFile, `${workflowFixtureSource}\n# Unreviewed\n`);
    expect((await f.execute(input)).status).toBe('blocked');
    expect(f.protocol.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  it('requires the actual lease and refuses another phase authority', async () => {
    const f = await publicationFixture();
    const input = await f.approve();
    expect(await executeRepositoryWorkflowSource(input)).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('lease') });
    const wrongPhase = { ...input, phase: canonicalPhaseGraph.phases.find((phase) => phase.id === 'bootstrap-workflow-source-ready')! };
    expect((await f.execute(wrongPhase)).status).toBe('blocked');
    expect(f.protocol.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  it('retains known effects when identity changes between requests', async () => {
    const f = await publicationFixture();
    const input = await f.approve();
    f.protocol.beforeRequest = async (request) => {
      if (request.method === 'POST' && request.path.endsWith('/trees')) f.protocol.actorId = 8;
    };
    expect((await f.execute(input)).status).toBe('blocked');
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(f.protocol.refs.get('develop')).toBe(f.protocol.baseSha);
  });

  it('does not replace changed, closed or wrong-actor merged PRs', async () => {
    for (const change of ['head', 'closed', 'merge-actor']) {
      const f = await publicationFixture();
      const input = await f.approve();
      expect((await f.execute(input)).status).toBe('pending');
      const pr = f.protocol.pullRequests.get(1)!;
      if (change === 'head') pr.head.sha = 'c'.repeat(40);
      if (change === 'closed') pr.state = 'closed';
      if (change === 'merge-actor') { f.protocol.merge(1); pr.merged_by.id = 8; }
      expect((await f.execute(input)).status).toBe('blocked');
      expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(4);
    }
  });

  it('requires exact publication approval for the full application source phase before any provider write', async () => {
    const f = await publicationFixture('workflow-source-ready');
    const input = await f.approve();
    expect(input.plan.scope).toBe('activation');
    expect(input.phase.approvalGate).toMatchObject({ kind: 'repository-publish', required: true });
    expect(input.phase.evidence.liveReadbackProviders).toEqual(['github']);
    input.inspection.approvals = [];
    expect(await f.execute(input)).toMatchObject({ status: 'blocked' });
    expect(f.protocol.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  it('rejects unsafe publication targets and source aliases before creating a branch', async () => {
    const protocol = new WorkflowGitHubFixture();
    const input = { client: new GitHubActivationClient(protocol), repository: 'owner/repo', repositoryId: 42, actorId: 7,
      baseSha: protocol.baseSha, featureBranch: 'automation/source', workflowFiles: [
        { path: workflowFixturePath, content: `${workflowFixtureSource}\n# New\n`, digest: canonicalSha256(`${workflowFixtureSource}\n# New\n`) }
      ], commitMessage: 'Reviewed source', commitTime: workflowFixtureNow };
    await expect(planWorkflowSourcePublication({ ...input, targetBranch: 'main' })).rejects.toThrow(/Main is never/);
    await expect(planWorkflowSourcePublication({ ...input, featureBranch: 'develop' })).rejects.toThrow(/temporary GitFlow/);
    await expect(planWorkflowSourcePublication({ ...input, workflowFiles: [{ ...input.workflowFiles[0]!, path: '.github/workflows/../outside.yml' }] })).rejects.toThrow(/exact bounded/);
    expect(protocol.requests).toEqual([]);
    expect(() => treeWithFiles([{ path: 'Test.js', type: 'blob', mode: '100644', sha: 'a'.repeat(40) }],
      [{ path: 'test.js', blobSha: 'b'.repeat(40) }])).toThrow(/aliases/);
  });

  it('computes immutable Git object identities identical to Git without writing objects or refs', () => {
    const content = 'Reviewed source bytes\n';
    const expected = execFileSync('git', ['hash-object', '--stdin'], { input: content, encoding: 'utf8' }).trim();
    expect(gitObjectSha('blob', content)).toBe(expected);
    const input = { treeSha: 'a'.repeat(40), parentSha: 'b'.repeat(40), message: 'Reviewed', actorLogin: 'owner', actorId: 7, commitTime: workflowFixtureNow };
    const stamp = Date.parse(input.commitTime) / 1000;
    const raw = `tree ${input.treeSha}\nparent ${input.parentSha}\nauthor owner <7+owner@users.noreply.github.com> ${stamp} +0000\ncommitter owner <7+owner@users.noreply.github.com> ${stamp} +0000\n\nReviewed\n`;
    expect(workflowCommitSha(input).sha).toBe(execFileSync('git', ['hash-object', '-t', 'commit', '--stdin'], { input: raw, encoding: 'utf8' }).trim());
  });
});
