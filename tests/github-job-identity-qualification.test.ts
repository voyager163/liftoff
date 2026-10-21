import { afterEach, describe, expect, it } from 'vitest';
import { link, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import {
  prepareGitHubJobIdentityProgram, selectGitHubJobIdentityBinding, jobIdentityQualificationName, jobIdentityProgramBootstrap
} from '../scripts/qualify-github-job-identity.mjs';
import { checkWorkflow, githubJobIdentityQualificationWorkflow } from '../scripts/check-repository-policy.mjs';

const root = process.cwd();
const directories: string[] = [];
const bootstrapSource = jobIdentityProgramBootstrap.slice("node --input-type=module <<'NODE'\n".length, -'\nNODE'.length);
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
async function handoffFixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff original helper # ')));
  directories.push(directory);
  const program = path.join(directory, 'qualification/job-identity-program');
  await mkdir(program, { recursive: true });
  const content = new Map([
    ['job-identity.js', 'export {};\n'], ['activation-rest.js', 'export {};\n'],
    ['qualify.mjs', `import { writeFile } from 'node:fs/promises';
await writeFile(new URL('entry-imported.txt', import.meta.url), 'imported');
export async function runGitHubJobIdentityObservation() {
  await writeFile(new URL('observation.txt', import.meta.url), 'synthetic helper only');
}
`],
    ['package.json', '{"type":"module"}\n']
  ]);
  for (const [name, bytes] of content) await writeFile(path.join(program, name), bytes);
  const inventory = { schemaVersion: 1, files: [...content].map(([name, bytes]) => ({ name, sha256: hash(bytes) })) };
  const saveInventory = async () => {
    const bytes = `${JSON.stringify(inventory, null, 2)}\n`;
    await writeFile(path.join(program, 'inventory.json'), bytes);
    return hash(bytes);
  };
  const expected = await saveInventory();
  return { directory, program, inventory, expected, saveInventory };
}
function bootstrap(directory: string, expected: string, preloader?: string) {
  return spawnSync(process.execPath, [...(preloader ? ['--import', pathToFileURL(preloader).href] : []),
    '--input-type=module', '-e', bootstrapSource], {
    cwd: directory, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, LIFTOFF_JOB_IDENTITY_PROGRAM_SHA256: expected, GH_TOKEN: 'private-handoff-canary' }
  });
}
async function expectNoImport(program: string) {
  expect(await readdir(program)).not.toContain('entry-imported.txt');
  expect(await readdir(program)).not.toContain('observation.txt');
}
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
    'suppressed-failure', 'missing-needs', 'missing-report', 'ignore-missing-report', 'new-checkout-source',
    'missing-producer-output', 'artifact-provided-digest', 'missing-bootstrap', 'changed-bootstrap'])(
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
      if (fault === 'missing-producer-output') delete prepare.outputs;
      if (fault === 'artifact-provided-digest') observe.steps[2].env.LIFTOFF_JOB_IDENTITY_PROGRAM_SHA256 = '${{ env.ARTIFACT_DIGEST }}';
      if (fault === 'missing-bootstrap') observe.steps[2].run = 'node qualification/job-identity-program/qualify.mjs observe';
      if (fault === 'changed-bootstrap') observe.steps[2].run = observe.steps[2].run.replace('before.nlink === 1n', 'true');
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
    expect(inventory.files.map((file: { name: string }) => file.name)).toEqual([
      'job-identity.js', 'activation-rest.js', 'qualify.mjs', 'package.json'
    ]);
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
            sub: 'repo:voyager163@300/liftoff@200:ref:refs/heads/develop',
            repository: 'voyager163/liftoff', repository_id: '200', repository_owner_id: '300',
            actor_id: '400', run_id: '100', check_run_id: process.env.MOCK_JOB_CLAIM_TEST ?? '500', run_attempt: '1',
            sha: '${env.GITHUB_SHA}', workflow_sha: '${env.GITHUB_SHA}',
            workflow_ref: '${env.GITHUB_WORKFLOW_REF}', ref: 'refs/heads/develop', ref_type: 'branch',
            job_workflow_ref: '${env.GITHUB_WORKFLOW_REF}', job_workflow_sha: '${env.GITHUB_SHA}',
            event_name: 'workflow_dispatch', runner_environment: 'github-hosted',
            iat: now, nbf: now - 600, exp: now + 300
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
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env, ...env, GH_TOKEN: 'private-unlogged-credential',
      LIFTOFF_JOB_IDENTITY_PROGRAM_SHA256: hash(await readFile(path.join(output, 'inventory.json'))),
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/jobs/job/idtoken?api-version=2.0',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-only-request-token'
    };
    const execute = () => spawnSync(process.execPath, ['--import', pathToFileURL(preloader).href,
      path.join(output, 'qualify.mjs'), 'observe'], { encoding: 'utf8', cwd: os.tmpdir(), env: childEnv });
    const mocked = spawnSync(process.execPath, ['--import', pathToFileURL(preloader).href,
      '--input-type=module', '-e', bootstrapSource], { encoding: 'utf8', cwd: directory, env: childEnv });
    expect(mocked.status, mocked.stderr).toBe(0);
    expect(mocked.stdout).toContain('job facts only');
    expect(await readFile(marker, 'utf8')).toBe('api\nrequest\njwks\n');
    const reportBytes = await readFile(path.join(output, 'job-identity-report.json'));
    const report = JSON.parse(reportBytes.toString('utf8'));
    expect(report).toMatchObject({
      scope: 'signed-github-job-facts-only',
      programInventorySha256: childEnv.LIFTOFF_JOB_IDENTITY_PROGRAM_SHA256,
      observation: { checkRunId: 500, runId: 100, hostCustody: 'not-established', workflowAuthority: 'not-issued' }
    });
    expect(reportBytes.toString('utf8')).not.toMatch(/private-unlogged-credential|test-only-request-token|PRIVATE KEY/);
    childEnv.MOCK_JOB_CLAIM_TEST = 'private-invalid-job-claim';
    const badClaim = execute();
    expect(badClaim.status).toBe(1);
    expect(badClaim.stderr).toContain('github-job-identity-claims; claim-stage=job');
    expect(badClaim.stderr).not.toMatch(/private-invalid-job-claim|private-unlogged-credential|test-only-request-token/);
    expect(await readFile(path.join(output, 'job-identity-report.json'))).toEqual(reportBytes);
    delete childEnv.MOCK_JOB_CLAIM_TEST;
    await rm(marker);
    await writeFile(path.join(output, 'job-identity.js'), '\n// actual changed program bytes\n', { flag: 'a' });
    const tampered = execute();
    expect(tampered.status).toBe(1);
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(output, 'job-identity-report.json'))).toEqual(reportBytes);
    await expect(prepareGitHubJobIdentityProgram(directory)).rejects.toThrow(/EEXIST/);
  });
});

describe.runIf(process.version === 'v24.21.0')('original producer-bound helper handoff before import', () => {
  it('emits exactly the independently handed-off inventory digest from the actual preparation CLI', async () => {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff original preparation # ')));
    directories.push(directory);
    await mkdir(path.join(directory, 'src/adapters/github'), { recursive: true });
    for (const file of ['job-identity.ts', 'activation-rest.ts']) {
      await writeFile(path.join(directory, 'src/adapters/github', file),
        await readFile(path.join(root, 'src/adapters/github', file)));
    }
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/qualify-github-job-identity.mjs'), 'prepare'], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, GH_TOKEN: 'private-handoff-canary' }
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^[a-f0-9]{64}\n$/);
    expect(result.stdout.trim()).toBe(hash(await readFile(path.join(directory, 'qualification/job-identity-program/inventory.json'))));
    expect(result.stdout + result.stderr).not.toContain('private-handoff-canary');
  });
  it('executes the exact five-file helper only after independent digest and physical validation', async () => {
    const fixture = await handoffFixture();
    const result = bootstrap(fixture.directory, fixture.expected);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(path.join(fixture.program, 'entry-imported.txt'), 'utf8')).toBe('imported');
    expect(await readFile(path.join(fixture.program, 'observation.txt'), 'utf8')).toBe('synthetic helper only');
    expect(result.stdout + result.stderr).not.toContain('private-handoff-canary');
  });
  it.each(['missing', 'malformed', 'different', 'substituted-inventory', 'changed-entry', 'changed-module',
    'missing-file', 'empty-file', 'oversized-file', 'extra-file', 'extra-directory', 'hardlink',
    'wrong-package', 'extra-inventory-key', 'extra-file-key', 'traversal', 'duplicate', 'reordered', 'wrong-schema'])(
    'refuses %s before any downloaded entry is imported', async fault => {
      const fixture = await handoffFixture();
      let expected = fixture.expected;
      if (fault === 'missing') expected = '';
      if (fault === 'malformed') expected = 'SHA256:' + expected;
      if (fault === 'different') expected = '0'.repeat(64);
      if (fault === 'substituted-inventory') {
        const bytes = await readFile(path.join(fixture.program, 'qualify.mjs'), 'utf8') + '// substituted helper\n';
        await writeFile(path.join(fixture.program, 'qualify.mjs'), bytes);
        fixture.inventory.files[2]!.sha256 = hash(bytes);
        await fixture.saveInventory();
      }
      if (fault === 'changed-entry') await writeFile(path.join(fixture.program, 'qualify.mjs'), '// changed\n', { flag: 'a' });
      if (fault === 'changed-module') await writeFile(path.join(fixture.program, 'job-identity.js'), '// changed\n', { flag: 'a' });
      if (fault === 'missing-file') await rm(path.join(fixture.program, 'activation-rest.js'));
      if (fault === 'empty-file') await writeFile(path.join(fixture.program, 'activation-rest.js'), '');
      if (fault === 'oversized-file') await writeFile(path.join(fixture.program, 'qualify.mjs'), Buffer.alloc(256 * 1024 + 1));
      if (fault === 'extra-file') await writeFile(path.join(fixture.program, 'job-identity-report.json'), '{}');
      if (fault === 'extra-directory') await mkdir(path.join(fixture.program, 'node_modules'));
      if (fault === 'hardlink') await link(path.join(fixture.program, 'qualify.mjs'), path.join(fixture.directory, 'shared.mjs'));
      if (fault === 'wrong-package') {
        const bytes = '{"type":"commonjs"}\n';
        await writeFile(path.join(fixture.program, 'package.json'), bytes);
        fixture.inventory.files[3]!.sha256 = hash(bytes);
        expected = await fixture.saveInventory();
      }
      if (fault === 'extra-inventory-key') {
        Object.assign(fixture.inventory, { verified: true });
        expected = await fixture.saveInventory();
      }
      if (fault === 'extra-file-key') {
        Object.assign(fixture.inventory.files[0]!, { path: '../outside.js' });
        expected = await fixture.saveInventory();
      }
      if (fault === 'traversal') {
        fixture.inventory.files[0]!.name = '../outside.js';
        expected = await fixture.saveInventory();
      }
      if (fault === 'duplicate') {
        fixture.inventory.files[1] = { ...fixture.inventory.files[0]! };
        expected = await fixture.saveInventory();
      }
      if (fault === 'reordered') {
        fixture.inventory.files.reverse();
        expected = await fixture.saveInventory();
      }
      if (fault === 'wrong-schema') {
        fixture.inventory.schemaVersion = 2;
        expected = await fixture.saveInventory();
      }
      const result = bootstrap(fixture.directory, expected);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('program handoff failed');
      expect(result.stdout + result.stderr).not.toContain('private-handoff-canary');
      await expectNoImport(fixture.program);
    }
  );
  it.skipIf(process.platform === 'win32').each(['file', 'directory'])(
    'refuses a real %s symlink before import', async kind => {
      const fixture = await handoffFixture();
      if (kind === 'file') {
        const file = path.join(fixture.program, 'job-identity.js');
        await rename(file, path.join(fixture.directory, 'outside.js'));
        await symlink(path.join(fixture.directory, 'outside.js'), file);
      } else {
        const outside = path.join(fixture.directory, 'outside');
        await rename(fixture.program, outside);
        await symlink(outside, fixture.program);
      }
      const result = bootstrap(fixture.directory, fixture.expected);
      expect(result.status, result.stderr).toBe(1);
      await expectNoImport(fixture.program);
    }
  );
  it.each(['mutation', 'same-byte-replacement', 'close-rejection', 'late-extra-file'])(
    'drains capture and refuses actual %s before import', async fault => {
      const fixture = await handoffFixture(), preloader = path.join(fixture.directory, 'capture-probe.mjs');
      await mkdir(path.join(fixture.directory, 'probe'));
      const marker = path.join(fixture.directory, 'probe/capture-probe.txt');
      await writeFile(preloader, `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const originalOpen = fs.open;
fs.open = async (...args) => {
  const handle = await originalOpen(...args);
  const filename = String(args[0]);
  if (filename.endsWith(${JSON.stringify(fault === 'mutation' || fault === 'close-rejection' ? 'qualify.mjs' : 'package.json')})) {
    const originalClose = handle.close.bind(handle);
    handle.close = async () => {
      await originalClose();
      await fs.writeFile(${JSON.stringify(marker)}, 'actual close settled');
      const target = ${JSON.stringify(path.join(fixture.program, 'qualify.mjs'))};
      if (${JSON.stringify(fault)} === 'mutation') {
        const bytes = await fs.readFile(target);
        bytes[0] ^= 1;
        await fs.writeFile(target, bytes);
      }
      if (${JSON.stringify(fault)} === 'same-byte-replacement') {
        const temporary = target + '.replacement';
        await fs.writeFile(temporary, await fs.readFile(target));
        await fs.rename(temporary, target);
      }
      if (${JSON.stringify(fault)} === 'late-extra-file') {
        await fs.writeFile(${JSON.stringify(path.join(fixture.program, 'extra.txt'))}, 'late file');
      }
      if (${JSON.stringify(fault)} === 'close-rejection') throw new Error('private-close-canary');
    };
  }
  return handle;
};
syncBuiltinESMExports();
`);
      const result = bootstrap(fixture.directory, fixture.expected, preloader);
      expect(await readFile(marker, 'utf8')).toBe('actual close settled');
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout + result.stderr).not.toMatch(/private-close-canary|private-handoff-canary/);
      await expectNoImport(fixture.program);
    }
  );
  it.each([
    ['qualify.mjs', 'write'], ['qualify.mjs', 'replace'],
    ['job-identity.js', 'write'], ['job-identity.js', 'replace'],
    ['activation-rest.js', 'write'], ['activation-rest.js', 'replace'],
    ['package.json', 'write'], ['package.json', 'replace']
  ] as const)('loads captured bytes despite a final-observation %s %s', async (name, operation) => {
    const fixture = await handoffFixture();
    const sources = new Map([
      ['job-identity.js', "export const value = 'identity';\n"],
      ['activation-rest.js', "export const value = 'rest';\n"],
      ['qualify.mjs', `import { writeFile } from 'node:fs/promises';
import { value as identity } from './job-identity.js';
export async function runGitHubJobIdentityObservation() {
  const { value: rest } = await import('./activation-rest.js');
  await writeFile(new URL('observation.txt', import.meta.url), identity + ':' + rest);
}
`]
    ]);
    for (const [file, bytes] of sources) {
      await writeFile(path.join(fixture.program, file), bytes);
      fixture.inventory.files.find(member => member.name === file)!.sha256 = hash(bytes);
    }
    const expected = await fixture.saveInventory();
    await mkdir(path.join(fixture.directory, 'probe'));
    const marker = path.join(fixture.directory, 'probe/replaced.txt');
    const reopened = path.join(fixture.directory, 'probe/default-loader.txt');
    const unverified = path.join(fixture.program, 'unverified-imported.txt');
    const payload = name === 'package.json' ? '{"type":"commonjs"}\n' : `
import { writeFile } from 'node:fs/promises';
await writeFile(${JSON.stringify(unverified)}, 'unverified code executed');
export const value = 'unverified';
export async function runGitHubJobIdentityObservation() {}
`;
    const preloader = path.join(fixture.directory, 'late-load-probe.mjs');
    await writeFile(preloader, `
import fs from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
const modules = ${JSON.stringify([...sources.keys()].map(file => pathToFileURL(path.join(fixture.program, file)).href))};
registerHooks({ load(url, context, nextLoad) {
  if (modules.includes(url)) appendFileSync(${JSON.stringify(reopened)}, url + '\\n');
  return nextLoad(url, context);
} });
const original = fs.lstat;
let packageObservations = 0;
fs.lstat = async (...args) => {
  const value = await original(...args);
  if (String(args[0]) === ${JSON.stringify(path.join(fixture.program, 'package.json'))}
    && ++packageObservations === 3) {
    const target = ${JSON.stringify(path.join(fixture.program, name))};
    if (${JSON.stringify(operation)} === 'replace') {
      await fs.writeFile(target + '.replacement', ${JSON.stringify(payload)});
      await fs.rename(target + '.replacement', target);
    } else await fs.writeFile(target, ${JSON.stringify(payload)});
    await fs.writeFile(${JSON.stringify(marker)}, 'actual final-observation replacement');
  }
  return value;
};
syncBuiltinESMExports();
`);
    const result = bootstrap(fixture.directory, expected, preloader);
    expect(await readFile(marker, 'utf8')).toBe('actual final-observation replacement');
    await expect(readFile(unverified)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(reopened)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(path.join(fixture.program, 'observation.txt'), 'utf8')).toBe('identity:rest');
    expect(result.stdout + result.stderr).not.toContain('private-handoff-canary');
  });
  it.each(['relative', 'absolute', 'data', 'query', 'fragment'])(
    'refuses an unlisted %s module before executing its bytes', async kind => {
      const fixture = await handoffFixture();
      const marker = path.join(fixture.directory, 'unlisted-imported.txt');
      const payload = `import { writeFile } from 'node:fs/promises';
await writeFile(${JSON.stringify(marker)}, 'unlisted module executed');
`;
      const outside = path.join(fixture.directory, 'outside.mjs');
      await writeFile(outside, payload);
      await writeFile(path.join(fixture.program, 'activation-rest.js'), payload);
      fixture.inventory.files[1]!.sha256 = hash(payload);
      const specifier = kind === 'relative' ? '../../outside.mjs'
        : kind === 'absolute' ? pathToFileURL(outside).href
          : kind === 'data' ? `data:text/javascript;base64,${Buffer.from(payload).toString('base64')}`
            : kind === 'query' ? './activation-rest.js?unlisted' : './activation-rest.js#unlisted';
      const entry = `import ${JSON.stringify(specifier)};
export async function runGitHubJobIdentityObservation() {}
`;
      await writeFile(path.join(fixture.program, 'qualify.mjs'), entry);
      fixture.inventory.files[2]!.sha256 = hash(entry);
      const result = bootstrap(fixture.directory, await fixture.saveInventory());
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('program handoff failed');
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      await expectNoImport(fixture.program);
    }
  );
  it.each([
    ['inventory.json', 4096, true], ['inventory.json', 4097, false],
    ['qualify.mjs', 256 * 1024, true], ['qualify.mjs', 256 * 1024 + 1, false]
  ] as const)('enforces the actual %s byte boundary at %i before open (accepted=%s)', async (name, size, accepted) => {
    const fixture = await handoffFixture();
    let expected: string;
    if (name === 'inventory.json') {
      const original = await readFile(path.join(fixture.program, name));
      const bytes = Buffer.concat([original, Buffer.alloc(size - original.length, 32)]);
      await writeFile(path.join(fixture.program, name), bytes);
      expected = hash(bytes);
    } else {
      const original = await readFile(path.join(fixture.program, name), 'utf8');
      const bytes = original + '//' + ' '.repeat(size - Buffer.byteLength(original) - 2);
      await writeFile(path.join(fixture.program, name), bytes);
      fixture.inventory.files[2]!.sha256 = hash(bytes);
      expected = await fixture.saveInventory();
    }
    await mkdir(path.join(fixture.directory, 'probe'));
    const marker = path.join(fixture.directory, 'probe/opened.txt'), preloader = path.join(fixture.directory, 'open-probe.mjs');
    await writeFile(preloader, `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.open;
fs.open = async (...args) => {
  if (String(args[0]).endsWith(${JSON.stringify(name)})) await fs.writeFile(${JSON.stringify(marker)}, 'opened');
  return original(...args);
};
syncBuiltinESMExports();
`);
    const result = bootstrap(fixture.directory, expected, preloader);
    expect(result.status, result.stderr).toBe(accepted ? 0 : 1);
    if (accepted) {
      expect(await readFile(marker, 'utf8')).toBe('opened');
      expect(await readFile(path.join(fixture.program, 'observation.txt'), 'utf8')).toBe('synthetic helper only');
    } else {
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      await expectNoImport(fixture.program);
    }
  });
});
