import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NodeCommandRunner } from '../src/process-runner.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { GitHubActivationClient } from '../src/adapters/github/activation-rest.js';
import {
  qualifyRepositorySourceChecks, readBoundWorkflowRun, repositoryCheckContextsFromQualification,
  type BoundRepositoryCheckFixture, type ProtectedRefFamily, type WorkflowRunBinding
} from '../src/adapters/github/production-checks.js';
import { controlledSourceCheckFixtures, deriveRequiredSourceChecks } from '../src/adapters/github/workflow-check-recipes.js';
import { verifySourceCheckAssertionLog } from '../src/adapters/github/source-check-execution.js';
import { planWorkflowSourcePublication, readbackWorkflowContent, type WorkflowPublicationPlan } from '../src/adapters/github/production-workflows.js';
import { treeWithFiles } from '../src/adapters/github/workflow-git-objects.js';
import { WorkflowGitHubFixture, workflowFixtureNow, workflowFixturePath, workflowFixtureSource } from './helpers/workflow-publication-fixture.js';

async function qualificationFixture(
  source = workflowFixtureSource,
  extraFiles: readonly { path: string; content: string }[] = [],
  target: { refFamily: ProtectedRefFamily; branch: string } = { refFamily: 'develop', branch: 'develop' }
) {
  const protocol = new WorkflowGitHubFixture(source, extraFiles);
  if (target.branch !== 'develop' && target.branch !== 'main') protocol.refs.set(target.branch, protocol.baseSha);
  const client = new GitHubActivationClient(protocol);
  const workflow = await readbackWorkflowContent(client, 'owner/repo', workflowFixturePath, protocol.baseSha);
  const requiredChecks = await deriveRequiredSourceChecks(client, 'owner/repo', workflow, 4);
  const fixtures: BoundRepositoryCheckFixture[] = [];
  for (const polarity of ['positive', 'negative'] as const) {
    const plan = await planWorkflowSourcePublication({
      client, repository: 'owner/repo', repositoryId: 42, actorId: 7, baseSha: protocol.baseSha, targetBranch: target.branch,
      featureBranch: `automation/check-${polarity}`, workflowFiles: controlledSourceCheckFixtures(requiredChecks, polarity),
      commitMessage: `Reviewed ${polarity} source fixture`, commitTime: workflowFixtureNow, recipe: 'gitflow-source-check-fixture.v1'
    });
    const base = protocol.trees.get(plan.baseTreeSha)!;
    const next = treeWithFiles(base, plan.files);
    protocol.trees.set(next.sha, next.entries);
    for (const file of plan.files) protocol.blobs.set(file.blobSha, Buffer.from(file.content));
    protocol.commits.set(plan.commitSha, { sha: plan.commitSha, tree: { sha: next.sha }, parents: [{ sha: plan.baseSha }] });
    protocol.refs.set(plan.featureBranch, plan.commitSha);
    const number = fixtures.length + 1;
    const pr = {
      number, state: 'open', draft: true, merged: false, user: { id: 7 },
      head: { ref: plan.featureBranch, sha: plan.commitSha, repo: { id: 42, full_name: 'owner/repo' } },
      base: { ref: plan.targetBranch, sha: plan.baseSha, repo: { id: 42, full_name: 'owner/repo' } }
    };
    protocol.pullRequests.set(number, pr);
    const run = protocol.addRun(plan.featureBranch, 'pull_request', undefined, pr);
    const binding: WorkflowRunBinding = {
      repository: 'owner/repo', repositoryId: 42, workflowPath: workflowFixturePath, workflowId: 4,
      workflowDigest: canonicalSha256(source), sourceSha: plan.commitSha, producerSourceSha: protocol.baseSha,
      ref: plan.featureBranch, actorId: 7, event: 'pull_request', expectedJobs: ['Node source validation'], runAttempt: 1
    };
    fixtures.push({ publication: plan, polarity, refFamily: target.refFamily, pullRequestNumber: number,
      runs: [{ binding, operation: {
        provider: 'github', actionId: 'github.checks.repository-qualified', operationId: String(run.id),
        resourceId: `/repos/owner/repo/actions/runs/${run.id}`, startedAt: workflowFixtureNow,
        observedAt: workflowFixtureNow, status: polarity === 'positive' ? 'completed' : 'failed'
      } }] });
  }
  const input = { client, repository: 'owner/repo', requiredChecks, fixtures, now: new Date(workflowFixtureNow) };
  return { protocol, client, input, fixtures, requiredChecks };
}

describe('source-derived real repository check qualification', () => {
  it('recognizes the actual native Node assertion output, not a fabricated failed-step summary', async () => {
    const f = await qualificationFixture();
    const file = controlledSourceCheckFixtures(f.requiredChecks, 'negative')[0]!;
    const root = await realpath(await mkdtemp(path.join(process.cwd(), 'tests', '.source check native-')));
    let started = false;
    let settled = false;
    try {
      const filename = path.join(root, file.path);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, file.content, { flag: 'wx' });
      started = true;
      const result = await new NodeCommandRunner().run({ executable: process.execPath, args: ['--test', filename] }, {
        cwd: root, timeoutMs: 10_000, maxOutputBytes: 256 * 1024, ensureProcessTreeSettled: true,
        env: { NODE_OPTIONS: undefined, NODE_PATH: undefined, LIFTOFF_TELEMETRY: '0', DO_NOT_TRACK: '1' }
      });
      settled = result.processTreeSettled === true;
      expect(settled, 'Uncertain native assertion workspace must be retained').toBe(true);
      expect(result.status).toBe(1);
      expect(() => verifySourceCheckAssertionLog(f.requiredChecks[0]!, Buffer.from(`${result.stdout}\n${result.stderr}`))).not.toThrow();
    } finally {
      if (!started || settled) await rm(root, { recursive: true });
    }
  });

  it.each(['release', 'hotfix'] as const)('qualifies exact nested %s/** fixtures without relabeling single-level proof', async (prefix) => {
    const family = `${prefix}/**` as const;
    const source = workflowFixtureSource.replace('[develop]', `["${family}"]`);
    const f = await qualificationFixture(source, [], { refFamily: family, branch: `${prefix}/maintenance/1.2.3` });
    const result = await qualifyRepositorySourceChecks(f.input);
    expect(result.requiredChecks[0]!.refFamilies).toEqual([family]);
    expect(result.positiveChecks[0]!.refFamily).toBe(family);
    expect(result.controlledNegativeChecks[0]!.refFamily).toBe(family);
    expect(repositoryCheckContextsFromQualification(result)[0]!.refFamily).toBe(family);
    expect(f.fixtures.every((fixture) => fixture.publication.targetBranch === `${prefix}/maintenance/1.2.3`)).toBe(true);

    const narrow = await qualificationFixture(workflowFixtureSource.replace('[develop]', `["${prefix}/*"]`), [], {
      refFamily: `${prefix}/*`, branch: `${prefix}/1.2.3`
    });
    expect((await qualifyRepositorySourceChecks(narrow.input)).requiredContexts[0]!.refFamily).toBe(`${prefix}/*`);
    narrow.requiredChecks[0]!.refFamilies = [family];
    await expect(qualifyRepositorySourceChecks(narrow.input)).rejects.toThrow(/derived from the actual approved immutable workflow/);
  });

  it('derives the actual job context and independently binds positive/controlled-red source, PR, run, attempt, job and check', async () => {
    const f = await qualificationFixture();
    f.protocol.requests.length = 0;
    const result = await qualifyRepositorySourceChecks(f.input);
    expect(result).toMatchObject({ repository: 'owner/repo', repositoryId: 42, actorId: 7, sourceSha: f.protocol.baseSha });
    expect(result.requiredChecks).toMatchObject([{ context: 'Node source validation', jobId: 'node-tests',
      workflowId: 4, workflowPath: workflowFixturePath, producerSourceSha: f.protocol.baseSha, refFamilies: ['develop'] }]);
    expect(result.positiveChecks).toMatchObject([{ context: 'Node source validation', runId: 100, runAttempt: 1, checkRunId: 10000,
      jobId: 1000, actorId: 7, repositoryId: 42, conclusion: 'success', refFamily: 'develop', pullRequestNumber: 1 }]);
    expect(result.controlledNegativeChecks).toMatchObject([{ context: 'Node source validation', runId: 101, runAttempt: 1,
      jobId: 1010, checkRunId: 10100, conclusion: 'failure', deliberateFailure: true,
      validationStep: { name: 'Validate source', number: 3, conclusion: 'failure' } }]);
    expect(result.requiredContexts).toMatchObject([{
      context: 'Node source validation', appId: 15368, appSlug: 'github-actions',
      workflowId: 4, workflowPath: workflowFixturePath, workflowDigest: canonicalSha256(workflowFixtureSource),
      producerSourceSha: f.protocol.baseSha, jobKey: 'node-tests', refFamily: 'develop',
      positive: { runId: 100, runAttempt: 1, checkRunId: 10000, jobId: 1000, pullRequestNumber: 1 },
      controlledNegative: { runId: 101, runAttempt: 1, checkRunId: 10100, jobId: 1010, pullRequestNumber: 2 }
    }]);
    expect(repositoryCheckContextsFromQualification({ kind: 'repository-checks-qualified.v1', ...result })).toEqual(result.requiredContexts);
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('does not project required contexts from mixed app/principal/source or full-activation proof', async () => {
    const f = await qualificationFixture();
    const result = await qualifyRepositorySourceChecks(f.input);
    for (const field of ['appId', 'actorId', 'repositoryId', 'producerSourceSha', 'runId'] as const) {
      const changed = structuredClone(result);
      if (field === 'producerSourceSha') changed.controlledNegativeChecks[0]![field] = 'c'.repeat(40);
      else changed.controlledNegativeChecks[0]![field] = field === 'runId' ? result.positiveChecks[0]!.runId : 99;
      expect(() => repositoryCheckContextsFromQualification(changed)).toThrow(/conflicting/);
    }
    expect(() => repositoryCheckContextsFromQualification({ ...result, kind: 'green-red-proof.v1', scope: 'activation' })).toThrow(/cannot supply required contexts/);
    const alteredTable = structuredClone(result);
    alteredTable.requiredContexts[0]!.appId = 99;
    expect(() => repositoryCheckContextsFromQualification(alteredTable)).toThrow(/cannot supply required contexts/);
    const escapedRef = structuredClone(result);
    escapedRef.controlledNegativeChecks[0]!.fixtureRef = 'automation/../main';
    expect(() => repositoryCheckContextsFromQualification(escapedRef)).toThrow(/safe branch/);
  });

  it('rejects positive/negative provider observations that disagree on the actual GitHub Actions app ID', async () => {
    const f = await qualificationFixture();
    f.protocol.checks.get(10100)!.app.id = 99;
    await expect(qualifyRepositorySourceChecks(f.input)).rejects.toThrow(/conflicting/);
  });

  it('does not qualify caller-selected context names or bare check conclusions', async () => {
    const f = await qualificationFixture();
    await expect(qualifyRepositorySourceChecks({
      client: f.client, repository: 'owner/repo', headSha: f.protocol.baseSha, contexts: ['verify', 'build', 'test']
    })).rejects.toThrow(/exact workflow source, actor, ref, run\/job\/check binding/);
    f.requiredChecks[0]!.context = 'guessed-success';
    await expect(qualifyRepositorySourceChecks(f.input)).rejects.toThrow(/derived from the actual approved immutable workflow/);
  });

  it.each([
    ['node-test.v1', 'node --test'],
    ['vitest.v1', 'npm test'],
    ['pytest.v1', 'uv run --frozen pytest'],
    ['go-test.v1', 'go test ./...']
  ])('qualifies real positive/negative %s recipes from their immutable validation commands', async (recipe, command) => {
    const source = workflowFixtureSource.replace('run: node --test', `run: ${command}`);
    const f = await qualificationFixture(source, recipe === 'vitest.v1' ?
      [{ path: 'package.json', content: JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '5.0.0' } }) }] : []);
    const result = await qualifyRepositorySourceChecks(f.input);
    expect(result.requiredChecks[0]!.recipe).toBe(recipe);
    expect(result.positiveChecks[0]!.conclusion).toBe('success');
    expect(result.controlledNegativeChecks[0]!.conclusion).toBe('failure');
    if (recipe === 'vitest.v1') expect(result.requiredChecks[0]!.validationManifest).toMatchObject({ path: 'package.json', digest: expect.any(String) });
  });

  it('never assumes npm test is Vitest when the actual immutable script differs', async () => {
    const source = workflowFixtureSource.replace('run: node --test', 'run: npm test');
    await expect(qualificationFixture(source, [
      { path: 'package.json', content: JSON.stringify({ scripts: { test: 'echo synthetic-success' } }) }
    ])).rejects.toThrow(/exact source-bound vitest run/);
  });

  it.each([
    ['node-test.v1', 'node --test', 'backend'],
    ['vitest.v1', 'npm test', 'backend'],
    ['pytest.v1', 'uv run --frozen pytest', 'backend'],
    ['go-test.v1', 'go test ./...', 'backend'],
    ['vitest.v1', 'npm test', 'frontend']
  ])('binds %s fixtures to the actual %s %s working directory', async (recipe, command, directory) => {
    const source = workflowFixtureSource.replace('run: node --test', `working-directory: ${directory}\n        run: ${command}`);
    const f = await qualificationFixture(source, recipe === 'vitest.v1' ? [{
      path: `${directory}/package.json`, content: JSON.stringify({ scripts: { test: 'vitest run' } })
    }] : []);
    expect(f.fixtures.flatMap((fixture) => fixture.publication.files).every((file) => file.path.startsWith(`${directory}/`))).toBe(true);
    const result = await qualifyRepositorySourceChecks(f.input);
    expect(result.requiredChecks[0]!).toMatchObject({ recipe, workingDirectory: directory });
  });

  it('resolves literal workflow/job defaults and rejects dynamic or escaping validation roots', async () => {
    const source = workflowFixtureSource.replace('jobs:', 'defaults:\n  run:\n    working-directory: backend\njobs:');
    const f = await qualificationFixture(source);
    expect((await qualifyRepositorySourceChecks(f.input)).requiredChecks[0]!.workingDirectory).toBe('backend');
    await expect(qualificationFixture(source.replace('working-directory: backend', 'working-directory: ../outside'))).rejects.toThrow(/dynamic and escaping/);
  });

  it.each(['workflow', 'actor', 'ref', 'source', 'attempt', 'repository', 'event', 'pr'] as const)(
    'rejects a real-looking run with mismatched %s identity', async (field) => {
      const f = await qualificationFixture();
      const run = f.protocol.runs.get(101)!;
      if (field === 'workflow') run.workflow_id = 5;
      if (field === 'actor') run.actor.id = 8;
      if (field === 'ref') run.head_branch = 'automation/unrelated';
      if (field === 'source') run.head_sha = f.protocol.baseSha;
      if (field === 'attempt') run.run_attempt = 2;
      if (field === 'repository') run.repository.id = 43;
      if (field === 'event') run.event = 'workflow_dispatch';
      if (field === 'pr') run.pull_requests = [{ number: 99, head: { sha: run.head_sha }, base: { sha: f.protocol.baseSha } }];
      await expect(qualifyRepositorySourceChecks(f.input)).rejects.toThrow(/Actual run|actual Actions run/);
    });

  it.each(['app', 'suite', 'head', 'context', 'check-url'] as const)('rejects synthetic or unrelated %s check bindings', async (field) => {
    const f = await qualificationFixture();
    const check = f.protocol.checks.get(10100)!;
    if (field === 'app') check.app.slug = 'posted-status-app';
    if (field === 'suite') check.check_suite.id = 99;
    if (field === 'head') check.head_sha = f.protocol.baseSha;
    if (field === 'context') check.name = 'some other check';
    if (field === 'check-url') f.protocol.jobs.get(101)![0]!.check_run_url = 'https://api.github.com/repos/other/repo/check-runs/10100';
    await expect(qualifyRepositorySourceChecks(f.input)).rejects.toThrow(/actual check|provider check-run/);
  });

  it.each(['skipped', 'neutral', 'cancelled', 'timed_out', 'action_required'])('rejects %s required checks', async (conclusion) => {
    const f = await qualificationFixture();
    f.protocol.jobs.get(101)![0]!.conclusion = conclusion;
    f.protocol.checks.get(10100)!.conclusion = conclusion;
    await expect(qualifyRepositorySourceChecks(f.input)).rejects.toThrow(/terminal non-skipped/);
  });

  it('does not treat an infrastructure/setup failure as a controlled red validation result', async () => {
    const f = await qualificationFixture();
    const job = f.protocol.jobs.get(101)![0]!;
    job.steps[0].conclusion = 'failure';
    job.steps[2].conclusion = 'skipped';
    await expect(qualifyRepositorySourceChecks(f.input)).rejects.toThrow(/exact real validation step/);
    job.steps[0].conclusion = 'success';
    job.steps[2].conclusion = 'failure';
    f.protocol.checks.get(10100)!.output.summary = 'Runner lost communication; infrastructure error';
    await expect(qualifyRepositorySourceChecks(f.input)).rejects.toThrow(/infrastructure failure/);
  });

  it.each(['', 'Process completed with exit code 1'])('does not infer deliberate assertion execution from a generic validator failure (%j)', async (summary) => {
    const f = await qualificationFixture();
    const job = f.protocol.jobs.get(101)![0]!;
    expect(job.steps[0].conclusion).toBe('success');
    expect(job.steps[2]).toMatchObject({ name: 'Validate source', conclusion: 'failure' });
    f.protocol.checks.get(10100)!.output = {
      summary, text: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'missing-test-dependency'; test collection did not reach the controlled assertion."
    };
    await expect(qualifyRepositorySourceChecks(f.input)).rejects.toThrow(/source-bound.*(?:execution|assertion)|reviewed.*source.*report/iu);
  });

  it.each(['missing', 'empty', 'summary-only', 'wrong-file', 'wrong-assertion', 'duplicate', 'collection-failure'])(
    'requires the exact native controlled-assertion log rather than %s evidence', async (fault) => {
      const f = await qualificationFixture();
      const original = f.protocol.jobLogs.get(1010)!;
      if (fault === 'missing') f.protocol.jobLogs.delete(1010);
      if (fault === 'empty') f.protocol.jobLogs.set(1010, '');
      if (fault === 'summary-only') f.protocol.jobLogs.set(1010, f.protocol.checks.get(10100)!.output.summary);
      if (fault === 'wrong-file') f.protocol.jobLogs.set(1010, original.replace('liftoff-repository-check', 'unrelated'));
      if (fault === 'wrong-assertion') f.protocol.jobLogs.set(1010, original.replace("actual: 'controlled-invalid'", "actual: 'unrelated'"));
      if (fault === 'duplicate') f.protocol.jobLogs.set(1010, `${original}\n${original}`);
      if (fault === 'collection-failure') f.protocol.jobLogs.set(1010, `${original}\nERR_MODULE_NOT_FOUND: no test collection\n`);
      await expect(qualifyRepositorySourceChecks(f.input)).rejects.toThrow(/assertion.*(?:execution|report)|source.*(?:execution|report)/iu);
    }
  );

  it.each(['missing-trace', 'wrong-trace-path', 'wrong-summary', 'mixed-failures'])(
    'requires the actual pytest assertion trace and matching summary, not %s', async (fault) => {
      const source = workflowFixtureSource.replace('run: node --test', 'run: uv run --frozen pytest');
      const f = await qualificationFixture(source);
      const original = f.protocol.jobLogs.get(1010)!;
      const changed = fault === 'missing-trace' ? original.slice(original.indexOf('FAILED ')) :
        fault === 'wrong-trace-path' ? original.replace('tests/test_liftoff_repository_check.py:2', 'tests/unrelated.py:2') :
          fault === 'wrong-summary' ? original.replace('FAILED tests/test_liftoff_repository_check.py::', 'FAILED tests/unrelated.py::') :
            original.replace('1 failed in', '2 failed in');
      f.protocol.jobLogs.set(1010, changed);
      await expect(qualifyRepositorySourceChecks(f.input)).rejects.toThrow(/assertion.*(?:execution|report)|source.*(?:execution|report)/iu);
    }
  );

  it('does not project a missing or substituted assertion witness into enforcement context', async () => {
    const f = await qualificationFixture();
    const result = await qualifyRepositorySourceChecks(f.input);
    expect(result.controlledNegativeChecks[0]!.assertionExecution).toMatchObject({
      kind: 'source-check-assertion-execution/1', recipe: 'node-test.v1', jobId: 1010
    });
    const changed = structuredClone(result);
    changed.controlledNegativeChecks[0]!.assertionExecution.jobId = 1000;
    expect(() => repositoryCheckContextsFromQualification(changed)).toThrow();
  });

  it('requires an actual failed validation step rather than only a failed job conclusion', async () => {
    const f = await qualificationFixture();
    f.protocol.jobs.get(101)![0]!.steps[2].conclusion = 'success';
    await expect(qualifyRepositorySourceChecks(f.input)).rejects.toThrow(/exact real validation step/);
  });

  it('rejects merged fixtures, changed negative bytes and missing protected ref-family coverage', async () => {
    const merged = await qualificationFixture();
    merged.protocol.pullRequests.get(2)!.merged = true;
    await expect(qualifyRepositorySourceChecks(merged.input)).rejects.toThrow(/unmerged PR/);
    const bytes = await qualificationFixture();
    const file = bytes.fixtures[1]!.publication.files[0]!;
    bytes.protocol.blobs.set(file.blobSha, Buffer.from('unrelated arbitrary failure\n'));
    await expect(qualifyRepositorySourceChecks(bytes.input)).rejects.toThrow(/blob identity|byte length/);
    const family = await qualificationFixture(workflowFixtureSource.replace('[develop]', '[develop, main]'));
    await expect(qualifyRepositorySourceChecks(family.input)).rejects.toThrow(/Every required actual workflow\/job\/ref family/);
  });

  it('refuses duplicate evidence in place of a missing controlled-negative fixture', async () => {
    const f = await qualificationFixture();
    f.input.fixtures = [f.fixtures[0]!, f.fixtures[0]!];
    await expect(qualifyRepositorySourceChecks(f.input)).rejects.toThrow(/Repeated fixtures/);
  });

  it('binds the workflow producer separately from the fixture execution source', async () => {
    const f = await qualificationFixture();
    f.fixtures[1]!.runs[0]!.binding.producerSourceSha = f.fixtures[1]!.publication.commitSha;
    await expect(qualifyRepositorySourceChecks(f.input)).rejects.toThrow(/independently bound/);
  });

  it('does not adopt an unrelated external operation ID even if source and job names agree', async () => {
    const f = await qualificationFixture();
    const selected = f.fixtures[0]!.runs[0]!;
    await expect(readBoundWorkflowRun(f.client, selected.binding, {
      ...selected.operation, operationId: '101'
    })).rejects.toThrow(/another exact workflow repository/);
  });

  it.each([
    ['dynamic context', '    name: Node source validation', '    name: ${{ matrix.name }}'],
    ['matrix job', '    runs-on: ubuntu-24.04', '    strategy:\n      matrix:\n        node: [24]\n    runs-on: ubuntu-24.04'],
    ['conditional step', '      - name: Validate source', '      - name: Validate source\n        if: always()'],
    ['infra command', '        run: node --test', '        run: exit 1'],
    ['mutable action', `actions/checkout@${'a'.repeat(40)}`, 'actions/checkout@main'],
    ['write permission', '  contents: read', '  contents: write'],
    ['other checkout', `        uses: actions/checkout@${'a'.repeat(40)}`, `        uses: actions/checkout@${'a'.repeat(40)}\n        with:\n          ref: main`],
    ['custom shell', '        run: node --test', '        shell: ./fake-validation-shell {0}\n        run: node --test'],
    ['container override', '    runs-on: ubuntu-24.04', '    container: unrelated/validator:latest\n    runs-on: ubuntu-24.04'],
    ['path filter', '    branches: [develop]', '    branches: [develop]\n    paths: ["test/**"]']
  ])('blocks unsupported %s instead of inventing exact check bindings', async (_name, from, to) => {
    await expect(qualificationFixture(workflowFixtureSource.replace(from!, to!))).rejects.toThrow();
  });
});
