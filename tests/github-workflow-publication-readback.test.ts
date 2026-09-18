import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { GitHubActivationClient } from '../src/adapters/github/activation-rest.js';
import { planWorkflowSourcePublication, readbackWorkflowPublication } from '../src/adapters/github/production-workflows.js';
import { treeWithFiles } from '../src/adapters/github/workflow-git-objects.js';
import { WorkflowGitHubFixture, workflowFixtureNow, workflowFixturePath, workflowFixtureSource } from './helpers/workflow-publication-fixture.js';

async function publicationReadbackFixture(requiredCheck = false) {
  const protocol = new WorkflowGitHubFixture(`${workflowFixtureSource}\n# Original source\n`);
  if (requiredCheck) protocol.branchRules = [{ type: 'required_status_checks',
    parameters: { required_status_checks: [{ context: 'Node source validation', integration_id: 15368 }] } }];
  const client = new GitHubActivationClient(protocol);
  const publication = await planWorkflowSourcePublication({
    client, repository: 'owner/repo', repositoryId: 42, actorId: 7, baseSha: protocol.baseSha,
    featureBranch: 'automation/readback', commitTime: workflowFixtureNow, commitMessage: 'Reviewed source',
    workflowFiles: [{ path: workflowFixturePath, content: workflowFixtureSource, digest: canonicalSha256(workflowFixtureSource) }]
  });
  const next = treeWithFiles(protocol.trees.get(publication.baseTreeSha)!, publication.files);
  protocol.trees.set(next.sha, next.entries);
  for (const file of publication.files) protocol.blobs.set(file.blobSha, Buffer.from(file.content));
  protocol.commits.set(publication.commitSha, { sha: publication.commitSha, tree: { sha: next.sha }, parents: [{ sha: publication.baseSha }] });
  protocol.refs.set(publication.featureBranch, publication.commitSha);
  protocol.pullRequests.set(1, {
    number: 1, state: 'open', merged: false, draft: false, user: { id: 7 },
    head: { ref: publication.featureBranch, sha: publication.commitSha, repo: { id: 42, full_name: 'owner/repo' } },
    base: { ref: 'develop', sha: protocol.baseSha, repo: { id: 42, full_name: 'owner/repo' } },
    body: `Reviewed Liftoff ${publication.recipe}\n\nSource: ${publication.baseSha}\nPayload: ${canonicalSha256(publication)}\n\nNo bypass, protected-ref push, release or tag is authorized.`
  });
  const operation = { provider: 'github' as const, actionId: 'github.workflow-source.publish', operationId: '1',
    resourceId: '/repos/owner/repo/pulls/1', startedAt: workflowFixtureNow, observedAt: workflowFixtureNow, status: 'running' as const };
  const input = { client, publication, operation, now: new Date(workflowFixtureNow) };
  protocol.requests.length = 0;
  return { protocol, input, publication };
}

describe('immutable recorded publication readback', () => {
  it('reads only the recorded pending PR and independently validates merged source without writing', async () => {
    const f = await publicationReadbackFixture();
    expect(await readbackWorkflowPublication(f.input)).toMatchObject({ status: 'pending', pullRequestNumber: 1, commitSha: f.publication.commitSha });
    const merged = f.protocol.merge(1);
    expect(await readbackWorkflowPublication(f.input)).toMatchObject({
      status: 'completed', repository: 'owner/repo', repositoryId: 42, actorId: 7, actorLogin: 'owner',
      commitSha: merged, ref: 'develop', pullRequestNumber: 1,
      files: [{ path: workflowFixturePath, digest: canonicalSha256(workflowFixtureSource),
        readbackDigest: canonicalSha256(workflowFixtureSource), blobSha: f.publication.files[0]!.blobSha }]
    });
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(f.protocol.refs.get('main')).toBe(f.protocol.mainSha);
  });

  it.each(['head', 'repository', 'actor', 'body', 'closed', 'merge-actor', 'source-tree', 'base-parent', 'main-tip'] as const)(
    'does not accept changed publication %s bindings', async (field) => {
      const f = await publicationReadbackFixture();
      const pr = f.protocol.pullRequests.get(1)!;
      if (field === 'head') pr.head.sha = 'c'.repeat(40);
      if (field === 'repository') pr.head.repo.id = 43;
      if (field === 'actor') pr.user.id = 8;
      if (field === 'body') pr.body = 'An unrelated source publication';
      if (field === 'closed') pr.state = 'closed';
      if (field === 'merge-actor') { f.protocol.merge(1); pr.merged_by.id = 8; }
      if (field === 'source-tree') {
        const sha = f.protocol.merge(1);
        f.protocol.commits.get(sha)!.tree = { sha: 'c'.repeat(40) };
      }
      if (field === 'base-parent') {
        const sha = f.protocol.merge(1);
        f.protocol.commits.get(sha)!.parents = [{ sha: 'c'.repeat(40) }, { sha: f.publication.commitSha }];
      }
      if (field === 'main-tip') f.protocol.refs.set('main', 'c'.repeat(40));
      await expect(readbackWorkflowPublication(f.input)).rejects.toThrow();
      expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
    });

  it.each(['failure', 'skipped', 'cancelled', 'neutral'])('never blesses a merge with a required %s check', async (conclusion) => {
    const f = await publicationReadbackFixture(true);
    f.protocol.addRun(f.publication.featureBranch, 'pull_request', undefined, f.protocol.pullRequests.get(1)!);
    f.protocol.checks.get(10000)!.conclusion = conclusion;
    f.protocol.merge(1);
    await expect(readbackWorkflowPublication(f.input)).rejects.toThrow(/actual successful exact protected-branch checks/);
  });

  it('reads the actual required check/app binding before successful source publication settlement', async () => {
    const f = await publicationReadbackFixture(true);
    f.protocol.addRun(f.publication.featureBranch, 'pull_request', undefined, f.protocol.pullRequests.get(1)!);
    f.protocol.merge(1);
    expect((await readbackWorkflowPublication(f.input)).status).toBe('completed');
    f.protocol.checks.get(10000)!.app.id = 9;
    await expect(readbackWorkflowPublication(f.input)).rejects.toThrow(/actual successful exact protected-branch checks/);
  });

  it('keeps merged source pending until real active workflow registration is independently observed', async () => {
    const f = await publicationReadbackFixture();
    const sourceSha = f.protocol.merge(1);
    f.protocol.workflowVisible = false;
    expect(await readbackWorkflowPublication(f.input)).toMatchObject({ status: 'pending', pendingReason: 'workflow-registration', workflows: [] });
    f.protocol.workflowVisible = true;
    expect(await readbackWorkflowPublication(f.input)).toMatchObject({ status: 'completed', workflows: [
      { path: workflowFixturePath, workflowId: 4, sourceSha }
    ] });
    f.protocol.workflowState = 'disabled_manually';
    await expect(readbackWorkflowPublication(f.input)).rejects.toThrow(/registration is disabled/);
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('rejects guessed resource IDs and refuses to treat controlled check fixtures as workflow publication', async () => {
    const f = await publicationReadbackFixture();
    await expect(readbackWorkflowPublication({ ...f.input, operation: { ...f.input.operation, operationId: '99' } })).rejects.toThrow(/actual recorded/);
    await expect(readbackWorkflowPublication({ ...f.input, operation: { ...f.input.operation, actionId: 'github.checks.repository-qualified' } })).rejects.toThrow(/actual recorded/);
  });
});
