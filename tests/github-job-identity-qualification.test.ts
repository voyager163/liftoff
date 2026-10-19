import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import {
  prepareGitHubJobIdentityProgram, selectGitHubJobIdentityBinding, jobIdentityQualificationName
} from '../scripts/qualify-github-job-identity.mjs';
import { checkWorkflow, githubJobIdentityQualificationWorkflow } from '../scripts/check-repository-policy.mjs';

const root = process.cwd();
const directories: string[] = [];
const env = {
  GITHUB_REPOSITORY: 'voyager163/liftoff', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'observe-job-identity', GITHUB_RUN_ID: '100',
  GITHUB_REPOSITORY_ID: '200', GITHUB_REPOSITORY_OWNER_ID: '300', GITHUB_ACTOR_ID: '400',
  GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
  GITHUB_WORKFLOW_REF: 'voyager163/liftoff/.github/workflows/github-job-identity.yml@refs/heads/develop'
};
function jobs() {
  return { total_count: 2, jobs: [
    { name: 'Prepare dependency-free job identity program' },
    { id: 999, name: jobIdentityQualificationName, run_id: 100, run_attempt: 1,
      head_sha: env.GITHUB_SHA, status: 'in_progress', conclusion: null,
      check_run_url: 'https://api.github.com/repos/voyager163/liftoff/check-runs/500' }
  ] };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('closed manual job identity qualification without dependency execution', () => {
  it('selects the check-run ID, not Actions job ID, and creates a fresh purpose-bound challenge', () => {
    const selected = selectGitHubJobIdentityBinding(env, jobs());
    expect(selected).toMatchObject({
      repository: env.GITHUB_REPOSITORY, repositoryId: 200, ownerId: 300, actorId: 400,
      runId: 100, checkRunId: 500, runAttempt: 1, sourceSha: env.GITHUB_SHA,
      workflowRef: env.GITHUB_WORKFLOW_REF
    });
    expect(selected.audience).toMatch(/^urn:liftoff:github-job-identity:[a-f0-9]{64}$/);
    expect(selectGitHubJobIdentityBinding(env, jobs()).audience).not.toBe(selected.audience);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(selected).not.toHaveProperty('authenticated');
    expect(selected).not.toHaveProperty('workflowAuthority');
  });
  it.each([
    { GITHUB_REPOSITORY: 'other/repository' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_JOB: 'prepare-job-identity' }, { GITHUB_RUN_ID: '00100' },
    { GITHUB_REPOSITORY_ID: 'NaN' }, { GITHUB_ACTOR_ID: '9007199254740992' },
    { GITHUB_SHA: 'unbound' }, { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) },
    { GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace('github-job-identity', 'another') }
  ])('refuses unsupported qualification selectors: %j', change => {
    expect(() => selectGitHubJobIdentityBinding({ ...env, ...change }, jobs())).toThrow();
  });
  it.each(['missing', 'duplicate', 'paginated', 'different-run', 'rerun', 'different-sha', 'not-running',
    'completed', 'foreign-check-origin', 'foreign-check-repository', 'noncanonical-check-id'])(
    'refuses an incomplete or foreign original jobs response: %s', fault => {
      const data = jobs(), job = data.jobs[1]!;
      if (fault === 'missing') { data.jobs.pop(); data.total_count--; }
      if (fault === 'duplicate') { data.jobs.push({ ...job }); data.total_count++; }
      if (fault === 'paginated') data.total_count++;
      if (fault === 'different-run') job.run_id = 101;
      if (fault === 'rerun') job.run_attempt = 2;
      if (fault === 'different-sha') job.head_sha = 'b'.repeat(40);
      if (fault === 'not-running') job.status = 'queued';
      if (fault === 'completed') Object.assign(job, { status: 'completed', conclusion: 'success' });
      if (fault === 'foreign-check-origin') job.check_run_url = 'https://outside.example/check-runs/500';
      if (fault === 'foreign-check-repository') job.check_run_url = 'https://api.github.com/repos/other/repository/check-runs/500';
      if (fault === 'noncanonical-check-id') job.check_run_url = 'https://api.github.com/repos/voyager163/liftoff/check-runs/00500';
      expect(() => selectGitHubJobIdentityBinding(env, data)).toThrow();
    }
  );
  it('matches the entire reviewed workflow and preserves the contribution OIDC prohibition', async () => {
    const workflow = parse(await readFile(path.join(root, '.github/workflows/github-job-identity.yml'), 'utf8'));
    expect(workflow).toEqual(githubJobIdentityQualificationWorkflow());
    expect(() => checkWorkflow('github-job-identity.yml', workflow)).not.toThrow();
    expect(() => checkWorkflow('another.yml', workflow)).toThrow(/cannot escalate/);
  });
  it.each(['push', 'pull-request', 'caller-input', 'extra-job', 'prepare-oidc', 'prepare-dependency-install',
    'observer-checkout', 'observer-dependency-install', 'observer-extra-step', 'observer-environment',
    'observer-reusable-workflow', 'observer-unpinned-action', 'observer-wrong-runtime', 'observer-custom-audience',
    'observer-cloud-permission', 'observer-secret', 'rerun', 'foreign-repository', 'self-hosted',
    'suppressed-failure', 'missing-needs', 'missing-report', 'ignore-missing-report', 'new-checkout-source'])(
    'rejects any extension of the privileged closed qualification: %s', async fault => {
      const workflow = parse(await readFile(path.join(root, '.github/workflows/github-job-identity.yml'), 'utf8'));
      const prepare = workflow.jobs['prepare-job-identity'], observe = workflow.jobs['observe-job-identity'];
      if (fault === 'push') workflow.on.push = null;
      if (fault === 'pull-request') workflow.on.pull_request = null;
      if (fault === 'caller-input') workflow.on.workflow_dispatch = { inputs: { audience: { type: 'string' } } };
      if (fault === 'extra-job') workflow.jobs.extra = structuredClone(observe);
      if (fault === 'prepare-oidc') prepare.permissions['id-token'] = 'write';
      if (fault === 'prepare-dependency-install') prepare.steps.splice(2, 0, { run: 'npm ci' });
      if (fault === 'observer-checkout') observe.steps.unshift(structuredClone(prepare.steps[0]));
      if (fault === 'observer-dependency-install') observe.steps.splice(2, 0, { run: 'npm ci' });
      if (fault === 'observer-extra-step') observe.steps.push({ run: 'gh attestation sign' });
      if (fault === 'observer-environment') observe.environment = 'npm-release';
      if (fault === 'observer-reusable-workflow') observe.uses = 'other/repository/.github/workflows/job.yml@main';
      if (fault === 'observer-unpinned-action') observe.steps[0].uses = 'actions/setup-node@main';
      if (fault === 'observer-wrong-runtime') observe.steps[0].with['node-version'] = '24';
      if (fault === 'observer-custom-audience') observe.steps[2].env.AUDIENCE = 'api://AzureADTokenExchange';
      if (fault === 'observer-cloud-permission') observe.permissions.contents = 'write';
      if (fault === 'observer-secret') observe.steps[2].env.GH_TOKEN = '${{ secrets.PUBLISH_TOKEN }}';
      if (fault === 'rerun') observe.if = '${{ success() }}';
      if (fault === 'foreign-repository') observe.if = observe.if.replace('voyager163/liftoff', 'other/repository');
      if (fault === 'self-hosted') observe['runs-on'] = 'self-hosted';
      if (fault === 'suppressed-failure') observe['continue-on-error'] = true;
      if (fault === 'missing-needs') delete observe.needs;
      if (fault === 'missing-report') observe.steps.pop();
      if (fault === 'ignore-missing-report') observe.steps[3].with['if-no-files-found'] = 'ignore';
      if (fault === 'new-checkout-source') prepare.steps[0].with.ref = 'main';
      expect(() => checkWorkflow('github-job-identity.yml', workflow)).toThrow(/exact closed/);
    }
  );
  it('prepares actual executable modules without npm and refuses to replace an existing output', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'liftoff job identity # program '));
    directories.push(directory);
    if (process.version !== 'v24.21.0') {
      await expect(prepareGitHubJobIdentityProgram(directory)).rejects.toThrow('exact reviewed Node');
      expect(await readdir(directory)).toEqual([]);
      return;
    }
    await mkdir(path.join(directory, 'src/adapters/github'), { recursive: true });
    for (const file of ['job-identity.ts', 'activation-rest.ts']) {
      await writeFile(path.join(directory, 'src/adapters/github', file),
        await readFile(path.join(root, 'src/adapters/github', file)));
    }
    const output = await prepareGitHubJobIdentityProgram(directory);
    expect((await readdir(output)).sort()).toEqual(['activation-rest.js', 'inventory.json', 'job-identity.js', 'package.json', 'qualify.mjs']);
    const inventory = JSON.parse(await readFile(path.join(output, 'inventory.json'), 'utf8'));
    for (const file of inventory.files) {
      expect(createHash('sha256').update(await readFile(path.join(output, file.name))).digest('hex')).toBe(file.sha256);
    }
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const identity = await import(${JSON.stringify(pathToFileURL(path.join(output, 'job-identity.js')).href)}); console.log(typeof identity.observeGitHubJobIdentity);`
    ], { encoding: 'utf8', cwd: os.tmpdir() });
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout.trim()).toBe('function');
    const refused = spawnSync(process.execPath, [path.join(output, 'qualify.mjs'), 'observe'], {
      encoding: 'utf8', cwd: os.tmpdir(), env: { ...process.env, GITHUB_EVENT_NAME: '', GH_TOKEN: 'private-unlogged-credential' }
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('qualification failed');
    expect(refused.stderr).not.toContain('private-unlogged-credential');
    expect(await readdir(output)).not.toContain('job-identity-report.json');
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const preloader = path.join(directory, 'mock-issuer.mjs'), marker = path.join(directory, 'network.txt');
    await writeFile(preloader, `
      import assert from 'node:assert/strict';
      import { sign } from 'node:crypto';
      import { appendFileSync } from 'node:fs';
      const privateKey = ${JSON.stringify(keys.privateKey.export({ format: 'pem', type: 'pkcs8' }))};
      const key = ${JSON.stringify({ ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-only-key', alg: 'RS256', use: 'sig' })};
      globalThis.fetch = async (input, options) => {
        const url = new URL(String(input));
        assert.equal(options.redirect, 'error');
        if (url.origin === 'https://api.github.com') {
          assert.equal(options.headers.Authorization, 'Bearer private-unlogged-credential');
          appendFileSync(${JSON.stringify(marker)}, 'api\\n');
          return new Response(JSON.stringify(${JSON.stringify(jobs())}));
        }
        if (url.origin === 'https://pipelines.actions.githubusercontent.com') {
          assert.equal(options.headers.Authorization, 'Bearer test-only-request-token');
          appendFileSync(${JSON.stringify(marker)}, 'request\\n');
          const now = Math.floor(Date.now() / 1000);
          const claims = {
            iss: 'https://token.actions.githubusercontent.com', aud: url.searchParams.get('audience'),
            sub: 'repo:voyager163/liftoff:ref:refs/heads/develop',
            repository: 'voyager163/liftoff', repository_id: '200', repository_owner_id: '300',
            actor_id: '400', run_id: '100', check_run_id: '500', run_attempt: '1',
            sha: '${env.GITHUB_SHA}', workflow_sha: '${env.GITHUB_SHA}',
            workflow_ref: '${env.GITHUB_WORKFLOW_REF}', ref: 'refs/heads/develop', ref_type: 'branch',
            event_name: 'workflow_dispatch', runner_environment: 'github-hosted',
            iat: now, nbf: now - 5, exp: now + 300
          };
          const prefix = Buffer.from(JSON.stringify({alg: 'RS256', typ: 'JWT', kid: 'test-only-key'})).toString('base64url')
            + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url');
          const value = prefix + '.' + sign('RSA-SHA256', Buffer.from(prefix), privateKey).toString('base64url');
          return new Response(JSON.stringify({value}));
        }
        assert.equal(String(input), 'https://token.actions.githubusercontent.com/.well-known/jwks');
        assert.equal(options.headers.Authorization, undefined);
        appendFileSync(${JSON.stringify(marker)}, 'jwks\\n');
        return new Response(JSON.stringify({keys: [key]}));
      };
    `);
    const childEnv = {
      ...process.env, ...env, GH_TOKEN: 'private-unlogged-credential',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/jobs/job/idtoken?api-version=2.0',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-only-request-token'
    };
    const execute = () => spawnSync(process.execPath, ['--import', pathToFileURL(preloader).href,
      path.join(output, 'qualify.mjs'), 'observe'], { encoding: 'utf8', cwd: os.tmpdir(), env: childEnv });
    const mocked = execute();
    expect(mocked.status, mocked.stderr).toBe(0);
    expect(mocked.stdout).toContain('job facts only');
    expect(await readFile(marker, 'utf8')).toBe('api\nrequest\njwks\n');
    const reportBytes = await readFile(path.join(output, 'job-identity-report.json'));
    const report = JSON.parse(reportBytes.toString('utf8'));
    expect(report).toMatchObject({
      scope: 'signed-github-job-facts-only',
      observation: { checkRunId: 500, runId: 100, hostCustody: 'not-established', workflowAuthority: 'not-issued' }
    });
    expect(reportBytes.toString('utf8')).not.toMatch(/private-unlogged-credential|test-only-request-token|PRIVATE KEY/);
    await rm(marker);
    await writeFile(path.join(output, 'job-identity.js'), '\n// actual changed program bytes\n', { flag: 'a' });
    const tampered = execute();
    expect(tampered.status).toBe(1);
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(output, 'job-identity-report.json'))).toEqual(reportBytes);
    await expect(prepareGitHubJobIdentityProgram(directory)).rejects.toThrow(/EEXIST/);
  });
});
