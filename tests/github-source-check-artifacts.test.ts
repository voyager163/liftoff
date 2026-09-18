import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalPhaseGraph } from '../src/domain/governance/activation/graph.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { GitHubActivationClient, type GitHubRequest } from '../src/adapters/github/activation-rest.js';
import {
  revalidateRepositoryChecksQualification, type RepositoryChecksEvidencePayload
} from '../src/adapters/github/production-checks.js';
import {
  sourceCheckFixtureArtifact, type SourceCheckRecipe
} from '../src/adapters/github/workflow-check-recipes.js';
import { readWorkflowPublicationCheckpoints } from '../src/adapters/github/production-workflows.js';
import { planRepositoryChecks, executeRepositoryChecks } from '../src/application/repository-governance/producer-checks.js';
import { workflowOperationFixture } from './helpers/workflow-operation-fixture.js';
import { singleReportBytesZip } from './helpers/private-report-zip-fixture.js';
import {
  WorkflowGitHubFixture, workflowFixtureNow, workflowFixturePath, workflowFixtureSource
} from './helpers/workflow-publication-fixture.js';

const fixtures: Awaited<ReturnType<typeof workflowOperationFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });
const commands = [
  ['node-test.v1', 'node --test'], ['vitest.v1', 'npm test'],
  ['pytest.v1', 'uv run --frozen pytest'], ['go-test.v1', 'go test ./...']
] as const;

class SourceArtifactProtocol extends WorkflowGitHubFixture {
  deferArtifacts = false;
  deferArchive = false;
  fixturePath = '';

  override addRun(...args: Parameters<WorkflowGitHubFixture['addRun']>) {
    const run = super.addRun(...args);
    run.updated_at = workflowFixtureNow;
    const job = this.jobs.get(run.id)![0]!;
    Object.assign(job, { run_attempt: 1, started_at: workflowFixtureNow, completed_at: workflowFixtureNow });
    job.steps.splice(3, 0, { number: 4, name: 'Upload controlled fixture', status: 'completed', conclusion: 'success' });
    job.steps[4].number = 5;
    const tree = this.trees.get((this.commits.get(run.head_sha)!.tree as { sha: string }).sha)!;
    const file = tree.find((entry) => entry.path === this.fixturePath)!;
    const bytes = singleReportBytesZip(this.blobs.get(file.sha)!, this.fixturePath.split('/').at(-1)!);
    const id = 5000 + run.id;
    this.artifacts.set(id, {
      metadata: { id, name: `liftoff-source-check-node-tests-${run.id}`, expired: false,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, size_in_bytes: bytes.length, created_at: workflowFixtureNow,
        workflow_run: { id: run.id, repository_id: 42, head_repository_id: 42, head_sha: run.head_sha, head_branch: run.head_branch } },
      bytes
    });
    return run;
  }

  override async request(request: GitHubRequest) {
    const pathname = request.path.split('?')[0]!;
    if (request.method === 'GET' && request.binary && this.deferArchive) {
      this.requests.push(structuredClone(request));
      return { status: 404, headers: {}, data: { message: 'Exact fixture archive is not visible yet' } };
    }
    const run = /^\/repos\/owner\/repo\/actions\/runs\/(\d+)\/artifacts$/u.exec(pathname);
    const job = /^\/repos\/owner\/repo\/actions\/jobs\/(\d+)$/u.exec(pathname);
    if (request.method === 'GET' && (run || job)) {
      this.requests.push(structuredClone(request));
      await this.beforeRequest?.(request);
      if (run) {
        const artifacts = this.deferArtifacts ? [] : [...this.artifacts.values()].map((entry) => entry.metadata)
          .filter((entry) => (entry.workflow_run as { id: number }).id === Number(run[1]));
        return { status: 200, headers: {}, data: { total_count: artifacts.length, artifacts } };
      }
      const value = [...this.jobs.values()].flat().find((entry) => entry.id === Number(job![1]));
      return { status: value ? 200 : 404, headers: {}, data: value ?? { message: 'Missing exact source-check job' } };
    }
    return super.request(request);
  }
}

async function sourceArtifactFixture(
  recipe: SourceCheckRecipe = 'node-test.v1', directory: '.' | 'backend' = '.',
  families: readonly ('develop' | 'main')[] = ['develop']
) {
  const command = commands.find((entry) => entry[0] === recipe)![1];
  const artifact = sourceCheckFixtureArtifact('node-tests', recipe, directory);
  const source = workflowFixtureSource.replace('[develop]', `[${families.join(', ')}]`).replace('run: node --test',
    `${directory === '.' ? '' : `working-directory: ${directory}\n        `}run: ${command}`) +
    `      - name: Upload controlled fixture\n        if: always()\n        uses: actions/upload-artifact@${'b'.repeat(40)}\n        with:\n          name: ${artifact.name}\n          path: ${artifact.path}\n          if-no-files-found: error\n          retention-days: 1\n`;
  const protocol = new SourceArtifactProtocol(source, recipe === 'vitest.v1' ? [{
    path: directory === '.' ? 'package.json' : `${directory}/package.json`,
    content: JSON.stringify({ scripts: { test: 'vitest run' } })
  }] : []);
  protocol.fixturePath = artifact.path;
  protocol.autoChecks = true;
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'repository-checks-qualified')!;
  const f = await workflowOperationFixture('repository-checks-qualified', async (inspection) => {
    const plan = await planRepositoryChecks({ inspection, phase, runner: protocol.runner, now: new Date(workflowFixtureNow) });
    if (plan.blockers?.length) throw new Error(plan.blockers.join(' '));
    return plan.operations;
  }, protocol.runner, {
    predecessorSourceSha: protocol.baseSha,
    configuration: { schemaVersion: 1, repository: { name: 'owner/repo' }, phases: {
      'repository-checks-qualified': {
        sourceSha: protocol.baseSha, workflowPaths: [workflowFixturePath], repositoryId: 42, actorId: 7,
        fixtures: families.map((family) => ({ refFamily: family, targetBranch: family, baseSha: protocol.refs.get(family)!,
          positiveBranch: `automation/fixture-positive${families.length > 1 ? `-${family}` : ''}`,
          negativeBranch: `automation/fixture-negative${families.length > 1 ? `-${family}` : ''}`, commitTime: workflowFixtureNow }))
      }
    } }
  });
  fixtures.push(f);
  f.input.adapters.githubActivation!.transport = protocol;
  const operation = f.input.plan.operations[0]!;
  const execute = () => withProjectMutationLock(f.projectRoot, (lease) => executeRepositoryChecks({ ...f.input, lease }));
  const revalidate = (evidence: RepositoryChecksEvidencePayload) => withProjectMutationLock(f.projectRoot, (lease) =>
    revalidateRepositoryChecksQualification({
      client: new GitHubActivationClient(protocol), evidence, now: f.input.now,
      artifactReadback: { execution: { ...f.input, lease }, operation }
    }));
  return { ...f, protocol, operation, artifact, execute, revalidate };
}

describe('registered source recipe failed-artifact consumption', () => {
  it.each(commands)('publishes, reads and revalidates actual %s negative fixture archive bytes with private custody', async (recipe) => {
    const f = await sourceArtifactFixture(recipe, recipe === 'node-test.v1' ? '.' : 'backend');
    const outcome = await f.execute();
    expect(outcome).toMatchObject({ status: 'completed', resultState: 'verified' });
    const evidence = outcome.evidencePayload as RepositoryChecksEvidencePayload;
    const negative = evidence.controlledNegativeChecks[0]!;
    expect(negative.fixtureArtifact).toMatchObject({
      request: {
        origin: { kind: 'check-fixture', phaseId: 'repository-checks-qualified',
          planDigest: f.input.plan.planDigest, savedPlanDigest: canonicalSha256(f.input.plan), pullRequestNumber: 2 },
        artifact: { artifactId: 5101, name: 'liftoff-source-check-node-tests-101' },
        operation: { operationId: '101', status: 'failed' }, job: { jobId: 1010, checkRunId: 10100 }
      },
      checkpointDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sourceFileDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    });
    expect(negative.fixtureArtifact!.archiveDigest).toBe(f.protocol.artifacts.get(5101)!.metadata.digest);
    expect(outcome.outputs!.resources).toContainEqual({
      provider: 'github', resourceType: 'workflow-artifact', resourceId: '/repos/owner/repo/actions/artifacts/5101'
    });
    expect(outcome.liveReadback).toEqual(expect.arrayContaining([expect.objectContaining({
      provider: 'github', resourceType: 'workflow-artifact', resourceId: '/repos/owner/repo/actions/artifacts/5101'
    })]));
    expect(evidence.requiredChecks[0]!.fixtureArtifact).toMatchObject(f.artifact);
    const before = canonicalSha256(evidence);
    f.protocol.requests.length = 0;
    expect((await f.revalidate(evidence)).controlledNegativeChecks).toEqual(evidence.controlledNegativeChecks);
    expect(canonicalSha256(evidence)).toBe(before);
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(f.protocol.requests.some((request) => request.path.includes('/runs/101/artifacts'))).toBe(false);
    expect(f.protocol.refs.get('main')).toBe(f.protocol.mainSha);
    expect(f.protocol.pullRequests.size).toBe(2);
  });

  it('keeps a missing artifact resumably blocked on the actual failed run without inventing a running operation', async () => {
    const f = await sourceArtifactFixture();
    f.protocol.deferArtifacts = true;
    expect(await f.execute()).toMatchObject({
      status: 'blocked', operation: { operationId: '101', status: 'failed' }, blocker: expect.stringContaining('has not appeared')
    });
    expect(await f.execute()).toMatchObject({ status: 'blocked', operation: { operationId: '101', status: 'failed' } });
    f.protocol.deferArtifacts = false;
    expect((await f.execute()).status).toBe('completed');
    expect(f.protocol.runs.size).toBe(2);
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(8);
  });

  it('reports the specific pending artifact run, not the last run in a multi-family fixture batch', async () => {
    const f = await sourceArtifactFixture('node-test.v1', '.', ['develop', 'main']);
    f.protocol.deferArtifacts = true;
    expect(await f.execute()).toMatchObject({ status: 'blocked', operation: {
      operationId: '101', resourceId: '/repos/owner/repo/actions/runs/101', status: 'failed'
    } });
    expect([...f.protocol.runs.keys()]).toEqual([100, 101, 102, 103]);
    expect(f.protocol.pullRequests.size).toBe(4);
  });

  it('persists the actual returned artifact ID before a pending download and resumes only that same ID', async () => {
    const f = await sourceArtifactFixture();
    f.protocol.deferArchive = true;
    expect(await f.execute()).toMatchObject({ status: 'blocked', operation: { operationId: '101', status: 'failed' } });
    const original = f.protocol.artifacts.get(5101)!;
    f.protocol.artifacts.delete(5101);
    f.protocol.artifacts.set(6101, { metadata: { ...original.metadata, id: 6101 }, bytes: Buffer.from(original.bytes) });
    f.protocol.deferArchive = false;
    f.protocol.requests.length = 0;
    expect(await f.execute()).toMatchObject({ status: 'blocked', operation: { operationId: '101', status: 'failed' } });
    expect(f.protocol.requests.some((request) => request.path.includes('/artifacts/6101'))).toBe(false);
    expect(f.protocol.requests.some((request) => /\/runs\/\d+\/artifacts/u.test(request.path))).toBe(false);
    f.protocol.artifacts.set(5101, original);
    expect((await f.execute()).status).toBe('completed');
    expect(f.protocol.runs.size).toBe(2);
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('requires the private artifact provider observation as well as the original run/publication checkpoints', async () => {
    const f = await sourceArtifactFixture();
    const outcome = await f.execute();
    const evidence = outcome.evidencePayload as RepositoryChecksEvidencePayload;
    const reference = evidence.controlledNegativeChecks[0]!.fixtureArtifact!;
    const stored = await createScopedUserLocalRecordStore(f.projectRoot, 'governance-operation', f.storage).read(reference.recordKey);
    expect(stored!.value).toMatchObject({ kind: 'github-source-check-artifact-observed',
      request: { artifact: { artifactId: 5101 }, operation: { operationId: '101' } } });
    await rm(stored!.path);
    f.protocol.requests.length = 0;
    await expect(f.revalidate(evidence)).rejects.toThrow(/original project-bound private provider observation/);
    expect(f.protocol.requests.some((request) => request.binary)).toBe(false);
  });

  it('rejects missing current private readback authority rather than dropping a declared artifact requirement', async () => {
    const f = await sourceArtifactFixture();
    const outcome = await f.execute();
    await expect(revalidateRepositoryChecksQualification({
      client: new GitHubActivationClient(f.protocol), evidence: outcome.evidencePayload as RepositoryChecksEvidencePayload
    })).rejects.toThrow(/original private custody/);
  });

  it.each(['tree', 'commit', 'ref', 'pull-request'] as const)('requires the original %s checkpoint, not only a public run/PR descriptor', async (step) => {
    const f = await sourceArtifactFixture();
    const result = await f.execute();
    const evidence = result.evidencePayload as RepositoryChecksEvidencePayload;
    const fixture = evidence.boundFixtures.find((entry) => entry.polarity === 'negative')!;
    const stages = await readWorkflowPublicationCheckpoints(f.input, f.operation, fixture.publication);
    const prepared = stages.find((entry) => entry.step === step)!.records!.prepared;
    const key = canonicalSha256({ intentDigest: prepared.intentDigest, attempt: prepared.attempt, stage: 'prepared' });
    const record = await createScopedUserLocalRecordStore(f.projectRoot, 'governance-operation', f.storage).read(key);
    await rm(record!.path);
    f.protocol.requests.length = 0;
    await expect(f.revalidate(evidence)).rejects.toThrow(/private workflow checkpoint/);
    expect(f.protocol.requests.some((request) => request.binary)).toBe(false);
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('does not accept a provider-digest-valid archive containing a different fixture', async () => {
    const f = await sourceArtifactFixture('pytest.v1');
    f.protocol.beforeRequest = async (request) => {
      if (!request.path.includes('/runs/101/artifacts')) return;
      const artifact = f.protocol.artifacts.get(5101)!;
      artifact.bytes = singleReportBytesZip(Buffer.from('def unrelated_test():\n    assert True\n'), f.artifact.path.split('/').at(-1)!);
      artifact.metadata.digest = `sha256:${createHash('sha256').update(artifact.bytes).digest('hex')}`;
      artifact.metadata.size_in_bytes = artifact.bytes.length;
      f.protocol.beforeRequest = undefined;
    };
    expect(await f.execute()).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('exact immutable controlled fixture bytes') });
  });

  it('rejects a second identically named artifact instead of selecting latest', async () => {
    const f = await sourceArtifactFixture();
    f.protocol.beforeRequest = async (request) => {
      if (!request.path.includes('/runs/101/artifacts')) return;
      const artifact = f.protocol.artifacts.get(5101)!;
      f.protocol.artifacts.set(6101, { metadata: { ...artifact.metadata, id: 6101 }, bytes: Buffer.from(artifact.bytes) });
      f.protocol.beforeRequest = undefined;
    };
    expect(await f.execute()).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('Multiple artifacts') });
    expect(f.protocol.requests.some((request) => request.binary)).toBe(false);
  });

  it('does not use archived fixture bytes to excuse an infrastructure or skipped validator failure', async () => {
    const f = await sourceArtifactFixture('go-test.v1');
    expect((await f.execute()).status).toBe('completed');
    const job = f.protocol.jobs.get(101)![0]!;
    job.steps[0].conclusion = 'failure';
    job.steps[2].conclusion = 'skipped';
    f.protocol.requests.length = 0;
    expect(await f.execute()).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('exact real validation step') });
    expect(f.protocol.requests.some((request) => request.binary)).toBe(false);
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
  });
});
