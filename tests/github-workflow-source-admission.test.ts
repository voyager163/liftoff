import { afterEach, describe, expect, it } from 'vitest';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { canonicalPhaseGraph } from '../src/domain/governance/activation/graph.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { gitObjectSha } from '../src/adapters/github/workflow-git-objects.js';
import { executeRepositoryWorkflowSource, planRepositoryWorkflowSource, type WorkflowSourceEvidencePayload } from '../src/application/repository-governance/producer-workflow-source.js';
import { workflowOperationFixture } from './helpers/workflow-operation-fixture.js';
import { WorkflowGitHubFixture, workflowFixtureNow, workflowFixturePath, workflowFixtureSource } from './helpers/workflow-publication-fixture.js';

const fixtures: Awaited<ReturnType<typeof workflowOperationFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });

async function sourceFixture(rulesetContent?: string) {
  const files = [{ path: workflowFixturePath, content: workflowFixtureSource },
    ...(rulesetContent ? [{ path: '.github/rulesets/develop.json', content: rulesetContent }] : [])];
  const protocol = new WorkflowGitHubFixture(workflowFixtureSource, files.filter((file) => file.path !== workflowFixturePath));
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'repository-workflow-source-ready')!;
  const f = await workflowOperationFixture(phase.id, async (inspection) => {
    const build = await planRepositoryWorkflowSource({ inspection, phase, runner: protocol.runner, now: new Date(workflowFixtureNow) });
    if (build.blockers?.length) throw new Error(build.blockers.join(' '));
    return build.operations;
  }, protocol.runner, {
    files,
    configuration: { schemaVersion: 1, repository: { name: 'owner/repo' }, phases: {
      'repository-workflow-source-ready': { sourceSha: protocol.baseSha, paths: files.map((file) => file.path) }
    } }
  });
  fixtures.push(f);
  return { ...f, protocol, execute: () => withProjectMutationLock(f.projectRoot, (lease) =>
    executeRepositoryWorkflowSource({ ...f.input, lease })) };
}

describe('already-published workflow-source admission', () => {
  it('uses exact current phase authority, repository/ref/actor and recorded workflow ID without publishing again', async () => {
    const f = await sourceFixture();
    expect(f.input.plan.operations[0]!.inputs).toMatchObject({
      repositoryId: 42, actorId: 7, actorLogin: 'owner', ref: 'develop',
      files: [{ path: workflowFixturePath, workflowId: 4 }]
    });
    const result = await f.execute();
    expect(result).toMatchObject({ status: 'completed', evidencePayload: {
      repository: 'owner/repo', repositoryId: 42, actorId: 7, actorLogin: 'owner', ref: 'develop', sourceSha: f.protocol.baseSha,
      files: [{ path: workflowFixturePath, blobSha: gitObjectSha('blob', workflowFixtureSource) }],
      workflows: [{ path: workflowFixturePath, workflowId: 4, sourceSha: f.protocol.baseSha }]
    } });
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(f.protocol.requests.some((request) => request.path === '/repos/owner/repo/actions/workflows/4')).toBe(true);
  });

  it('retains the published ruleset file-inventory digest independently of semantic definition hashes and observed blob IDs', async () => {
    const content = '{\n  "name": "reviewed-develop",\n  "target": "branch",\n  "enforcement": "active"\n}\n';
    const f = await sourceFixture(content);
    const result = await f.execute();
    expect(result.status).toBe('completed');
    const payload = result.evidencePayload as WorkflowSourceEvidencePayload;
    const expected = canonicalSha256([{ path: '.github/rulesets/develop.json', digest: canonicalSha256(content) }]);
    expect(payload.rulesetSourceDigest).toBe(expected);
    expect(payload.rulesetSourceDigest).not.toBe(canonicalSha256(JSON.parse(content)));
    expect(payload.files.find((file) => file.path === '.github/rulesets/develop.json')).toEqual({
      path: '.github/rulesets/develop.json', digest: canonicalSha256(content), readbackDigest: canonicalSha256(content),
      blobSha: gitObjectSha('blob', content)
    });
  });

  it('does not accept a lease-only or different-phase readback as successful workflow-source evidence', async () => {
    const f = await sourceFixture();
    expect(await executeRepositoryWorkflowSource(f.input)).toMatchObject({ status: 'blocked' });
    f.input.inspection.approvals = [];
    expect((await f.execute()).status).toBe('blocked');
    expect(f.protocol.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  it.each(['actor', 'repository', 'ref', 'workflow'] as const)('rejects current %s drift instead of rebinding a saved source plan', async (field) => {
    const f = await sourceFixture();
    if (field === 'actor') f.protocol.actorId = 8;
    if (field === 'repository') f.protocol.repositoryId = 43;
    if (field === 'ref') f.protocol.refs.set('develop', 'c'.repeat(40));
    if (field === 'workflow') f.protocol.workflowState = 'disabled_manually';
    expect((await f.execute()).status).toBe('blocked');
    expect(f.protocol.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });
});
