import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, lstat, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  applicationBuildWorkflowRecipe, applicationBuildWorkflowRecipeId, applicationBuildWorkflowSource,
  applicationBuildWorkflowDispatchInputs, applicationBuildWorkflowIntegration, assertApplicationBuildWorkflowSource,
  renderApplicationBuildWorkflow, type ApplicationBuildWorkflowRecipe
} from '../src/application/azure-activation/application-build-workflow.js';
import { applicationBuildWorkflowProgram } from '../src/application/azure-activation/application-build-workflow-program.js';
import { readApplicationBuildArchive, validateApplicationBuildReport } from '../src/application/azure-activation/application-build-report.js';
import type { ApplicationArtifactInputs } from '../src/application/azure-activation/application-artifact-inputs.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  applicationRegistryId, applicationTenant, applicationPrincipal, applicationSubscription, applicationReportZip, artifactSha
} from './helpers/application-artifact-fixture.js';

const sourceSha = '1234567890abcdef1234567890abcdef12345678';
// Deliberately synthetic operator pins, never published or used to download an action or image.
const recipe = (): ApplicationBuildWorkflowRecipe => ({
  schemaVersion: 1, recipe: applicationBuildWorkflowRecipeId, workflowPath: '.github/workflows/liftoff-application-build.yml',
  repository: 'owner/repo', repositoryId: 42, actorId: 7, ref: 'develop',
  azure: { tenantId: applicationTenant, principalId: applicationPrincipal, clientId: '11111111-2222-4333-8444-555555555559' },
  registry: { resourceId: applicationRegistryId, loginServer: 'crliftoff.azurecr.io', location: 'eastus', repository: 'team/app' },
  platform: 'linux/amd64', artifactName: 'application-build-report', context: '.', dockerfile: 'Dockerfile',
  tools: { dockerVersion: '28.0.0', buildxVersion: 'v0.22.0', buildkitImage: `moby/buildkit@sha256:${'b'.repeat(64)}` },
  uploadArtifactActionSha: 'a'.repeat(40),
  budget: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 100 },
  limits: { maxRunMinutes: 5, httpTimeoutSeconds: 1, commandTimeoutSeconds: 2, buildTimeoutSeconds: 2 }
});

const jwt = (value: Record<string, unknown>) => [
  Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url'),
  Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...value })).toString('base64url'),
  Buffer.from('isolated-provider-signature').toString('base64url')
].join('.');

const commands = String.raw`#!/usr/bin/env node
import { appendFile, readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(await readFile(join(root, 'case.json'), 'utf8'));
const executable = process.argv[1].endsWith('/git') ? 'git' : 'docker';
const args = process.argv.slice(2);
const event = { executable, args, environmentKeys: Object.keys(process.env), cwd: process.cwd(),
  configDirectory: process.env.DOCKER_CONFIG,
  hasSecretArgument: Object.values(data.tokens).some(token => args.join(' ').includes(token)),
  hasGitHeader: process.env.GIT_CONFIG_VALUE_0 === 'Authorization: Basic ' + Buffer.from('x-access-token:' + data.tokens.github).toString('base64') };
const action = executable === 'git' ? args.includes('rev-parse') ? 'git-head' : args.includes('fetch') ? 'git-fetch' :
  args.includes('checkout') ? 'git-checkout' : 'git-other' : args.includes('build') ? 'docker-build' : args.includes('rm') ? 'docker-remove' : 'docker-other';
if (executable === 'docker' && args.includes('build')) {
  const configPath = join(process.env.DOCKER_CONFIG, 'config.json');
  const configuration = JSON.parse(await readFile(configPath, 'utf8'));
  event.credentialMode = (await lstat(configPath)).mode & 0o777;
  event.directoryMode = (await lstat(process.env.DOCKER_CONFIG)).mode & 0o777;
  event.scopedTokenOnly = JSON.stringify(configuration) === JSON.stringify({
    auths: { [data.recipe.registry.loginServer]: { registrytoken: data.tokens.push } }
  });
}
await appendFile(join(root, 'commands.jsonl'), JSON.stringify(event) + '\n');
if (data.failCommand === action) {
  process.stdout.write(data.tokens.github);
  process.stderr.write(data.tokens.push);
  process.exit(9);
}
if (data.largeCommand === action) process.stdout.write(data.tokens.github.repeat(20000));
if (data.timeoutCommand === action) {
  setTimeout(() => process.exit(0), 240000);
} else if (executable === 'git') {
  if (args[0] === 'init') {
    const target = args.at(-1);
    await mkdir(join(target, '.github', 'workflows'), { recursive: true });
    await writeFile(join(target, data.recipe.workflowPath), data.workflowSource);
    await writeFile(join(target, 'Dockerfile'), 'FROM scratch\n');
  } else if (args.includes('rev-parse')) process.stdout.write((data.checkoutSha ?? data.sourceSha) + '\n');
  else if (args.includes('status')) { if (data.dirtySource) process.stdout.write(' M Dockerfile\n'); }
  else if (!(args.includes('remote') && args.includes('add') || args.includes('fetch') || args.includes('checkout'))) process.exit(8);
} else {
  if (args[0] !== '--host' || args[1] !== 'unix:///var/run/docker.sock') process.exit(7);
  const command = args.slice(2);
  if (command[0] === 'version') process.stdout.write(JSON.stringify({
    Client: { Version: data.recipe.tools.dockerVersion }, Server: { Version: data.dockerServerVersion ?? data.recipe.tools.dockerVersion }
  }));
  else if (command[1] === 'version') process.stdout.write('github.com/docker/buildx ' + data.recipe.tools.buildxVersion + ' fixture\n');
  else if (command[1] === 'build') {
    if (!['--provenance=false', '--sbom=false', '--metadata-file', '--quiet'].every(flag => args.includes(flag)) ||
      args[args.indexOf('--platform') + 1] !== data.recipe.platform ||
      args[args.indexOf('--output') + 1] !== 'type=image,name=' + data.recipe.registry.loginServer + '/' +
        data.recipe.registry.repository + ',push-by-digest=true,name-canonical=true,push=true,oci-mediatypes=true' ||
      !event.scopedTokenOnly || event.hasSecretArgument) process.exit(6);
    const path = args[args.indexOf('--metadata-file') + 1];
    if (data.metadataSymlink) {
      const { symlink } = await import('node:fs/promises');
      await symlink(join(root, 'case.json'), path);
    } else await writeFile(path, JSON.stringify(data.metadata), { mode: 0o600 });
  } else if (!(command[0] === 'buildx' && ['create', 'inspect', 'rm'].includes(command[1]))) process.exit(8);
}
`;

const provider = String.raw`
import { appendFile as fixtureAppend, readFile as fixtureRead } from 'node:fs/promises';
import { dirname as fixtureDirname, join as fixtureJoin } from 'node:path';
import { fileURLToPath as fixtureFileUrl } from 'node:url';
const fixtureRoot = fixtureDirname(fixtureFileUrl(import.meta.url));
const fixture = JSON.parse(await fixtureRead(fixtureJoin(fixtureRoot, 'case.json'), 'utf8'));
let fixtureRunReads = 0;
Object.defineProperty(process, 'platform', { value: 'linux' });
Object.defineProperty(process, 'arch', { value: fixture.recipe.platform === 'linux/amd64' ? 'x64' : 'arm64' });
globalThis.fetch = async (resource, init) => {
  const url = new URL(resource), body = new URLSearchParams(init.body ?? '');
  const headers = new Headers(init.headers);
  const request = { url: url.href, method: init.method, redirect: init.redirect, formKeys: [...body.keys()],
    scope: body.get('scope'), hasSignal: init.signal instanceof AbortSignal };
  await fixtureAppend(fixtureJoin(fixtureRoot, 'http.jsonl'), JSON.stringify(request) + '\n');
  if (fixture.httpTimeoutPath === url.pathname) return new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error(fixture.tokens.github)), { once: true });
  });
  if (fixture.httpStatusPath === url.pathname) return new Response(fixture.tokens.github, { status: 403 });
  if (fixture.httpRedirectPath === url.pathname) return new Response(fixture.tokens.github, {
    status: 307, headers: { location: 'https://unreviewed.example/credential-bearing-redirect' }
  });
  const response = (data, extra = {}) => new Response(typeof data === 'string' || data instanceof Uint8Array ? data : JSON.stringify(data), {
    status: 200, headers: { 'content-type': 'application/json', ...extra }
  });
  const requireFixture = condition => { if (!condition) throw new Error(fixture.tokens.github); };
  requireFixture(init.redirect === 'error' && init.signal instanceof AbortSignal);
  if (url.origin === 'https://api.github.com') {
    requireFixture(init.method === 'GET' && headers.get('authorization') === 'Bearer ' + fixture.tokens.github &&
      headers.get('x-github-api-version') === '2022-11-28');
    if (url.pathname === '/repos/owner/repo') return response(fixture.repository);
    if (url.pathname === '/repos/owner/repo/actions/runs/100/attempts/1') {
      fixtureRunReads++;
      return response(fixture.finalRun && fixtureRunReads > 1 ? fixture.finalRun : fixture.run);
    }
    if (url.pathname === '/repos/owner/repo/actions/runs/100') return response(fixture.currentRun);
    if (url.pathname === '/repos/owner/repo/actions/workflows/4') return response(fixture.workflow);
    if (url.pathname === '/repos/owner/repo/actions/runs/100/attempts/1/jobs' && url.search === '?per_page=100&page=1')
      return response(fixture.jobs);
    if (url.pathname === '/repos/owner/repo/actions/jobs/1000') return response(fixture.job);
    if (url.pathname === '/repos/owner/repo/contents/' + fixture.recipe.workflowPath && url.search === '?ref=' + fixture.sourceSha)
      return response(fixture.workflowFile);
  }
  if (url.origin === 'https://pipelines.actions.githubusercontent.com') {
    requireFixture(init.method === 'GET' && headers.get('authorization') === 'Bearer ' + fixture.tokens.request &&
      url.pathname === '/fixture/_apis/distributedtask/jobs/job/idtoken' && url.searchParams.get('audience') === 'api://AzureADTokenExchange');
    return response({ value: fixture.tokens.oidc });
  }
  if (url.origin === 'https://login.microsoftonline.com') {
    requireFixture(url.pathname === '/' + fixture.recipe.azure.tenantId + '/oauth2/v2.0/token' && init.method === 'POST' &&
      body.get('scope') === 'https://management.azure.com/.default' &&
      body.get('client_assertion') === fixture.tokens.oidc && body.get('client_id') === fixture.recipe.azure.clientId &&
      body.get('client_assertion_type') === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' && body.get('grant_type') === 'client_credentials');
    return response({ token_type: 'Bearer', access_token: fixture.tokens.aad });
  }
  if (url.origin === 'https://management.azure.com') {
    requireFixture(init.method === 'GET' && url.pathname === fixture.recipe.registry.resourceId && url.search === '?api-version=2023-07-01' &&
      headers.get('authorization') === 'Bearer ' + fixture.tokens.aad);
    return response(fixture.registry, { 'x-ms-request-id': 'fixture-registry-observation' });
  }
  if (url.origin === 'https://' + fixture.recipe.registry.loginServer) {
    if (url.pathname === '/oauth2/exchange') {
      requireFixture(init.method === 'POST' && body.get('access_token') === fixture.tokens.aad &&
        body.get('tenant') === fixture.recipe.azure.tenantId && body.get('service') === fixture.recipe.registry.loginServer &&
        body.get('grant_type') === 'access_token');
      return response({ refresh_token: fixture.tokens.refresh });
    }
    if (url.pathname === '/oauth2/token') {
      requireFixture(init.method === 'POST' && body.get('refresh_token') === fixture.tokens.refresh &&
        body.get('service') === fixture.recipe.registry.loginServer && body.get('grant_type') === 'refresh_token' &&
        ['repository:team/app:pull,push', 'repository:team/app:pull'].includes(body.get('scope')));
      return response({ access_token: body.get('scope').endsWith(':pull,push') ? fixture.tokens.push : fixture.tokens.pull });
    }
    requireFixture(init.method === 'GET' && headers.get('authorization') === 'Bearer ' + fixture.tokens.pull);
    if (url.pathname === '/v2/team/app/manifests/' + fixture.imageDigest) return response(Buffer.from(fixture.manifestBase64, 'base64'), {
      'content-type': 'application/vnd.oci.image.manifest.v1+json',
      'docker-content-digest': fixture.manifestHeader ?? fixture.imageDigest
    });
    if (url.pathname === '/v2/team/app/blobs/' + fixture.configDigest) return response(Buffer.from(fixture.configBase64, 'base64'), {
      'content-type': 'application/octet-stream', 'docker-content-digest': fixture.configHeader ?? fixture.configDigest
    });
  }
  throw new Error('Fixture forbids every unregistered endpoint.');
};
`;

type FixtureCase = Record<string, any>;
const roots = new Set<string>();
afterEach(async () => {
  for (const root of roots) { await rm(root, { recursive: true, force: true }); roots.delete(root); }
});

async function fixture(change?: (data: FixtureCase) => void, selected = recipe()) {
  const root = resolve('tests', `.application-build-workflow-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 }); roots.add(root);
  const repository = { id: 42, full_name: 'owner/repo', archived: false, disabled: false };
  const workflowSource = renderApplicationBuildWorkflow(selected);
  const config = Buffer.from(JSON.stringify({
    architecture: selected.platform.split('/')[1], os: 'linux',
    config: { Labels: { 'org.opencontainers.image.source': 'https://github.com/owner/repo', 'org.opencontainers.image.revision': sourceSha } }
  }));
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: artifactSha(config), size: config.length },
    layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: `sha256:${'d'.repeat(64)}`, size: 100 }]
  }));
  const run = {
    id: 100, run_attempt: 1, workflow_id: 4, event: 'workflow_dispatch', head_sha: sourceSha, head_branch: 'develop',
    path: selected.workflowPath, display_title: 'liftoff-test-operation', status: 'in_progress', conclusion: null,
    actor: { id: 7 }, triggering_actor: { id: 7 }, repository, head_repository: repository
  };
  const job = {
    id: 1000, run_id: 100, run_attempt: 1, head_sha: sourceSha, head_branch: 'develop',
    name: 'Liftoff application image build', status: 'in_progress', conclusion: null, runner_id: 88,
    run_url: 'https://api.github.com/repos/owner/repo/actions/runs/100',
    url: 'https://api.github.com/repos/owner/repo/actions/jobs/1000',
    html_url: 'https://github.com/owner/repo/actions/runs/100/job/1000'
  };
  const workflowRef = 'owner/repo/' + selected.workflowPath + '@refs/heads/develop';
  const data: FixtureCase = {
    recipe: selected, sourceSha, repository, run, currentRun: structuredClone(run), job,
    jobs: { total_count: 1, jobs: [structuredClone(job)] },
    workflow: { id: 4, path: selected.workflowPath, state: 'active', name: 'Liftoff application image build' },
    workflowSource, workflowFile: {
      type: 'file', path: selected.workflowPath, encoding: 'base64', content: Buffer.from(workflowSource).toString('base64'),
      size: Buffer.byteLength(workflowSource),
      sha: createHash('sha1').update(`blob ${Buffer.byteLength(workflowSource)}\0${workflowSource}`).digest('hex')
    },
    registry: {
      id: applicationRegistryId, type: 'Microsoft.ContainerRegistry/registries', name: 'crliftoff', location: 'eastus',
      properties: { loginServer: 'crliftoff.azurecr.io', adminUserEnabled: false, provisioningState: 'Succeeded' }
    },
    imageDigest: artifactSha(manifest), configDigest: artifactSha(config),
    manifestBase64: manifest.toString('base64'), configBase64: config.toString('base64'),
    metadata: {
      'containerimage.digest': artifactSha(manifest), 'containerimage.config.digest': artifactSha(config),
      'containerimage.descriptor': { digest: artifactSha(manifest), size: manifest.length, mediaType: 'application/vnd.oci.image.manifest.v1+json' }
    },
    tokens: {
      github: 'fixture-github-credential-never-public', request: 'fixture-oidc-request-credential-never-public',
      oidc: jwt({
        iss: 'https://token.actions.githubusercontent.com', aud: 'api://AzureADTokenExchange',
        sub: 'repo:owner/repo:ref:refs/heads/develop', repository: 'owner/repo', repository_id: '42', actor_id: '7',
        sha: sourceSha, ref: 'refs/heads/develop', event_name: 'workflow_dispatch', workflow_ref: workflowRef,
        workflow_sha: sourceSha, run_id: '100', run_attempt: '1', runner_environment: 'github-hosted'
      }),
      aad: jwt({ oid: applicationPrincipal, tid: applicationTenant, appid: selected.azure.clientId, aud: 'https://management.azure.com/' }),
      refresh: jwt({ aud: 'crliftoff.azurecr.io', tenant: applicationTenant, grant_type: 'refresh_token' }),
      push: jwt({ aud: 'crliftoff.azurecr.io', grant_type: 'access_token', access: [{ type: 'repository', name: 'team/app', actions: ['pull', 'push'] }] }),
      pull: jwt({ aud: 'crliftoff.azurecr.io', grant_type: 'access_token', access: [{ type: 'repository', name: 'team/app', actions: ['pull'] }] })
    },
    env: {}
  };
  change?.(data);
  await mkdir(join(root, 'bin'), { mode: 0o700 });
  await writeFile(join(root, 'case.json'), JSON.stringify(data), { mode: 0o600 });
  for (const command of ['git', 'docker']) await writeFile(join(root, 'bin', command), commands, { mode: 0o700 });
  // Execute the program extracted from the generated workflow, not a separate report fixture.
  const rendered = parse(workflowSource);
  const step = rendered.jobs.build.steps[0];
  const programEnvironment = Object.fromEntries(Object.entries(step.env).filter(([key]) => /^LIFTOFF_APPLICATION_BUILD_PROGRAM_\d+$/.test(key))) as Record<string, string>;
  expect(Object.values(programEnvironment).join('')).toBe(applicationBuildWorkflowProgram);
  const loader = step.run.replace(/^node --input-type=module <<'LIFTOFF_APPLICATION_BUILD_PROGRAM'\n/, '')
    .replace(/LIFTOFF_APPLICATION_BUILD_PROGRAM\n$/, '');
  await writeFile(join(root, 'program.mjs'), provider + loader, { mode: 0o600 });
  const environment: NodeJS.ProcessEnv = {
    PATH: [join(root, 'bin'), dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    GITHUB_WORKSPACE: root, GITHUB_REPOSITORY: 'owner/repo', GITHUB_REPOSITORY_ID: '42', GITHUB_ACTOR_ID: '7',
    GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'build', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_SHA: sourceSha, GITHUB_WORKFLOW_SHA: sourceSha, GITHUB_REF: 'refs/heads/develop',
    GITHUB_WORKFLOW_REF: workflowRef, GITHUB_API_URL: 'https://api.github.com', GITHUB_SERVER_URL: 'https://github.com',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/fixture/_apis/distributedtask/jobs/job/idtoken?api-version=2.0',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: data.tokens.request, GH_TOKEN: data.tokens.github,
    LIFTOFF_APPLICATION_BUILD_RECIPE: JSON.stringify(data.recipe),
    LIFTOFF_SOURCE_SHA: sourceSha, LIFTOFF_REGISTRY_RESOURCE_ID: applicationRegistryId,
    LIFTOFF_IMAGE_REPOSITORY: 'team/app', LIFTOFF_ARTIFACT_NAME: selected.artifactName,
    LIFTOFF_PLATFORM: selected.platform, LIFTOFF_OPERATION_ID: 'test-operation',
    // The build child must not inherit these caller credentials, helper settings or alternate endpoints.
    AZURE_CLIENT_SECRET: 'ambient-not-an-input', DOCKER_HOST: 'tcp://unreviewed.example:2375',
    DOCKER_CONFIG: 'ambient-not-an-input', GIT_TRACE: '1', HTTP_PROXY: 'http://unreviewed.example',
    ...programEnvironment,
    ...data.env
  };
  const execute = () => new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
    const process = spawn(globalThis.process.execPath, [join(root, 'program.mjs')], {
      cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    process.stdout.on('data', bytes => { stdout += String(bytes); });
    process.stderr.on('data', bytes => { stderr += String(bytes); });
    process.once('error', reject);
    process.once('close', status => done({ status, stdout, stderr }));
  });
  const lines = async (filename: string) => {
    try { return (await readFile(join(root, filename), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  const assertClean = async () => {
    expect((await readdir(root)).filter(name => name.startsWith('.liftoff-application-build-'))).toEqual([]);
    const observed = await lines('commands.jsonl');
    for (const command of observed) {
      expect(command.hasSecretArgument).toBe(false);
      expect(command.environmentKeys).not.toEqual(expect.arrayContaining(['GH_TOKEN']));
      expect(command.environmentKeys).not.toEqual(expect.arrayContaining(['ACTIONS_ID_TOKEN_REQUEST_TOKEN']));
      expect(command.environmentKeys).not.toEqual(expect.arrayContaining(['AZURE_CLIENT_SECRET']));
      expect(command.environmentKeys).not.toEqual(expect.arrayContaining(['HTTP_PROXY']));
      expect(command.environmentKeys).not.toEqual(expect.arrayContaining(['GIT_TRACE']));
    }
  };
  const configInput: ApplicationArtifactInputs = {
    azure: { subscriptionId: applicationSubscription, tenantId: applicationTenant, principalId: applicationPrincipal },
    registryResourceId: applicationRegistryId, resourceGroup: 'rg-app', acrName: 'crliftoff', region: 'eastus', imageName: 'team/app',
    artifactName: selected.artifactName, platform: selected.platform, maxRunMinutes: 5, budget: selected.budget,
    dispatchInputs: applicationBuildWorkflowDispatchInputs(selected, sourceSha),
    workflow: {
      repository: 'owner/repo', repositoryId: 42, workflowId: 4, workflowPath: selected.workflowPath,
      workflowDigest: canonicalSha256(workflowSource), sourceSha, ref: 'develop', actorId: 7,
      runAttempt: 1, event: 'workflow_dispatch', expectedJobs: ['Liftoff application image build']
    }
  };
  return { root, data, execute, lines, assertClean, configInput };
}

async function failure(change: (data: FixtureCase) => void) {
  const f = await fixture(change), result = await f.execute();
  expect(result.status, result.stderr).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(/^Application build failed \([a-z-]+\); credential and command diagnostics withheld\./);
  for (const token of Object.values(f.data.tokens) as string[]) expect(result.stderr).not.toContain(token);
  await expect(lstat(join(f.root, 'liftoff-application-build.json'))).rejects.toHaveProperty('code', 'ENOENT');
  await f.assertClean();
  return f;
}

function modifyConfig(data: FixtureCase, mutate: (value: FixtureCase) => void) {
  const config = JSON.parse(Buffer.from(data.configBase64, 'base64').toString('utf8'));
  mutate(config);
  const configBytes = Buffer.from(JSON.stringify(config));
  const manifest = JSON.parse(Buffer.from(data.manifestBase64, 'base64').toString('utf8'));
  manifest.config.digest = artifactSha(configBytes); manifest.config.size = configBytes.length;
  const bytes = Buffer.from(JSON.stringify(manifest));
  data.configBase64 = configBytes.toString('base64'); data.configDigest = artifactSha(configBytes);
  data.manifestBase64 = bytes.toString('base64'); data.imageDigest = artifactSha(bytes);
  data.metadata['containerimage.digest'] = data.imageDigest;
  data.metadata['containerimage.config.digest'] = data.configDigest;
  data.metadata['containerimage.descriptor'].digest = data.imageDigest;
  data.metadata['containerimage.descriptor'].size = bytes.length;
}

describe('application build workflow source contract', () => {
  it('produces deterministic publishable source with exactly the dispatcher inputs, job and minimal permissions', () => {
    const first = applicationBuildWorkflowSource(recipe()), second = applicationBuildWorkflowSource(recipe());
    expect(first).toEqual(second);
    expect(first.files).toHaveLength(1);
    expect(first.files[0]!.digest).toBe(canonicalSha256(first.files[0]!.content));
    expect(first.recipe).not.toBe('liftoff-application-build');
    const workflow = parse(first.files[0]!.content);
    expect(workflow['run-name']).toBe('liftoff-${{ inputs.liftoff_operation_id }}');
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(Object.keys(workflow.on.workflow_dispatch.inputs).sort()).toEqual([
      ...applicationBuildWorkflowIntegration.dispatchInputs, 'liftoff_operation_id'
    ].sort());
    for (const declaration of Object.values(workflow.on.workflow_dispatch.inputs)) expect(declaration).toEqual({ type: 'string', required: true });
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(Object.keys(workflow.jobs)).toEqual(['build']);
    expect(workflow.jobs.build.permissions).toEqual({ contents: 'read', actions: 'read', 'id-token': 'write' });
    expect(workflow.jobs.build).not.toHaveProperty('strategy');
    expect(workflow.jobs.build).not.toHaveProperty('environment');
    expect(workflow.jobs.build.steps[0].run.length).toBeLessThan(21000);
    expect(Buffer.byteLength(first.files[0]!.content)).toBeLessThanOrEqual(262144);
    for (const value of Object.values(workflow.jobs.build.steps[0].env)) expect(String(value).length).toBeLessThan(20000);
    expect(workflow.jobs.build.steps.filter((step: any) => step.uses).map((step: any) => step.uses))
      .toEqual([`actions/upload-artifact@${recipe().uploadArtifactActionSha}`]);
    expect(workflow.jobs.build.steps[1].with).toEqual({
      name: '${{ inputs.artifact_name }}', path: '${{ github.workspace }}/liftoff-application-build.json',
      'if-no-files-found': 'error', 'retention-days': 1, 'include-hidden-files': false, 'compression-level': 0, overwrite: false
    });
    expect(() => assertApplicationBuildWorkflowSource(first.files[0]!.content, recipe())).not.toThrow();
    expect(() => assertApplicationBuildWorkflowSource(first.files[0]!.content + '\n', recipe())).toThrow();
  });

  it.each([
    (r: any) => { delete r.actorId; }, (r: any) => { r.actorId = '7'; },
    (r: any) => { delete r.budget; }, (r: any) => { r.budget.usageMonthlyCents = -1; },
    (r: any) => { r.uploadArtifactActionSha = 'v4'; }, (r: any) => { r.tools.buildkitImage = 'moby/buildkit:latest'; },
    (r: any) => { r.azure.clientSecret = 'not-an-input'; }, (r: any) => { r.context = '../outside'; },
    (r: any) => { r.dockerfile = 'Dockerfile;echo injection'; }, (r: any) => { r.platform = 'linux/amd64,linux/arm64'; },
    (r: any) => { r.registry.repository = 'team/../other'; }, (r: any) => { r.registry.loginServer = 'evil.example'; },
    (r: any) => { r.limits.maxRunMinutes = 31; }, (r: any) => { r.limits.buildTimeoutSeconds = 299; }
  ])('rejects missing or expanded recipe authority %#', change => {
    const value = recipe(); change(value);
    expect(() => applicationBuildWorkflowRecipe(value)).toThrow();
  });
});

describe('generated application build executable', () => {
  it.each(['linux/amd64', 'linux/arm64'] as const)('builds %s immutable bytes and satisfies the real archive/report validator', async platform => {
    const selected = recipe(); selected.platform = platform;
    const f = await fixture(undefined, selected), result = await f.execute();
    expect(result, result.stderr).toEqual({ status: 0, stdout: '', stderr: '' });
    const bytes = await readFile(join(f.root, 'liftoff-application-build.json'));
    const stat = await lstat(join(f.root, 'liftoff-application-build.json'));
    expect(stat.isFile()).toBe(true); expect(stat.mode & 0o777).toBe(0o600);
    expect(bytes.length).toBeLessThanOrEqual(65536);
    const value = JSON.parse(bytes.toString('utf8'));
    expect(bytes.toString('utf8')).toBe(JSON.stringify(value) + '\n');
    const proof = validateApplicationBuildReport(readApplicationBuildArchive(applicationReportZip(value)), f.configInput, {
      runId: 100, jobs: [{ id: 1000, name: 'Liftoff application image build', conclusion: 'success' }], loginServer: 'crliftoff.azurecr.io'
    });
    expect(proof).toMatchObject({ digest: f.data.imageDigest, configDigest: f.data.configDigest, sourceSha, workflowId: 4, jobId: 1000, runAttempt: 1, platform });
    for (const patch of [{ runId: 101 }, { runAttempt: 2 }, { actorId: 8 }, { jobId: 1001 }, { workflowId: 5 }, { workflowDigest: '0'.repeat(64) }]) {
      expect(() => validateApplicationBuildReport({ ...value, producer: { ...value.producer, ...patch } }, f.configInput, {
        runId: 100, jobs: [{ id: 1000, name: 'Liftoff application image build', conclusion: 'success' }], loginServer: 'crliftoff.azurecr.io'
      })).toThrow();
    }
    for (const token of Object.values(f.data.tokens) as string[]) expect(bytes.toString('utf8')).not.toContain(token);
    const calls = await f.lines('commands.jsonl');
    const build = calls.find(call => call.args.includes('build'));
    expect(build).toMatchObject({ scopedTokenOnly: true, credentialMode: 0o600, directoryMode: 0o700 });
    expect(calls.find(call => call.args.includes('fetch')).hasGitHeader).toBe(true);
    expect(calls.find(call => call.args.includes('fetch')).args.at(-1)).toBe(sourceSha);
    const created = calls.find(call => call.args.includes('create'));
    const removed = calls.filter(call => call.args.includes('rm'));
    expect(removed).toHaveLength(1);
    expect(removed[0].args.at(-1)).toBe(created.args[created.args.indexOf('--name') + 1]);
    const http = await f.lines('http.jsonl');
    expect(http.filter(call => call.scope?.startsWith('repository:')).map(call => call.scope))
      .toEqual(['repository:team/app:pull,push', 'repository:team/app:pull']);
    expect(http.filter(call => /\/v2\//.test(call.url)).map(call => call.url)).toEqual([
      `https://crliftoff.azurecr.io/v2/team/app/manifests/${f.data.imageDigest}`,
      `https://crliftoff.azurecr.io/v2/team/app/blobs/${f.data.configDigest}`
    ]);
    expect(http.every(call => call.redirect === 'error' && call.hasSignal)).toBe(true);
    await f.assertClean();
  });

  it.each([
    ['source', (d: FixtureCase) => { d.run.head_sha = '9'.repeat(40); }],
    ['repository', (d: FixtureCase) => { d.repository.id = 999; }],
    ['actor', (d: FixtureCase) => { d.run.actor.id = 8; }],
    ['triggering actor', (d: FixtureCase) => { d.run.triggering_actor.id = 8; }],
    ['attempt', (d: FixtureCase) => { d.currentRun.run_attempt = 2; }],
    ['workflow', (d: FixtureCase) => { d.workflow.path = '.github/workflows/other.yml'; }],
    ['job source', (d: FixtureCase) => { d.jobs.jobs[0].head_sha = '9'.repeat(40); }],
    ['job run', (d: FixtureCase) => { d.jobs.jobs[0].run_id = 101; }],
    ['job attempt', (d: FixtureCase) => { d.jobs.jobs[0].run_attempt = 2; }],
    ['job identity', (d: FixtureCase) => { d.job.id = 1001; }],
    ['ambiguous jobs', (d: FixtureCase) => { d.jobs.total_count = 2; d.jobs.jobs.push(d.jobs.jobs[0]); }],
    ['workflow byte identity', (d: FixtureCase) => { d.workflowFile.sha = '0'.repeat(40); }],
    ['checkout source', (d: FixtureCase) => { d.checkoutSha = '9'.repeat(40); }],
    ['dirty checkout', (d: FixtureCase) => { d.dirtySource = true; }],
    ['nonce', (d: FixtureCase) => { d.env.LIFTOFF_OPERATION_ID = ''; }],
    ['runner source', (d: FixtureCase) => { d.env.GITHUB_SHA = '9'.repeat(40); }],
    ['final run drift', (d: FixtureCase) => { d.finalRun = structuredClone(d.run); d.finalRun.actor.id = 8; }]
  ] as const)('fails closed on %s mismatch', async (_label, change) => { await failure(change); });

  it.each([
    ['OCI digest', (d: FixtureCase) => { d.manifestHeader = `sha256:${'9'.repeat(64)}`; }],
    ['actual manifest bytes', (d: FixtureCase) => { d.manifestBase64 = Buffer.from('{}').toString('base64'); }],
    ['malformed manifest', (d: FixtureCase) => { d.manifestBase64 = Buffer.from('{').toString('base64'); }],
    ['duplicate manifest members', (d: FixtureCase) => {
      const bytes = Buffer.from(Buffer.from(d.manifestBase64, 'base64').toString('utf8').replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2'));
      d.manifestBase64 = bytes.toString('base64'); d.imageDigest = artifactSha(bytes);
      d.metadata['containerimage.digest'] = d.imageDigest;
      d.metadata['containerimage.descriptor'].digest = d.imageDigest; d.metadata['containerimage.descriptor'].size = bytes.length;
    }],
    ['config bytes', (d: FixtureCase) => { d.configBase64 = Buffer.from('{}').toString('base64'); }],
    ['config digest header', (d: FixtureCase) => { d.configHeader = `sha256:${'9'.repeat(64)}`; }],
    ['config descriptor', (d: FixtureCase) => { d.metadata['containerimage.config.digest'] = `sha256:${'9'.repeat(64)}`; }],
    ['platform', (d: FixtureCase) => { modifyConfig(d, config => { config.architecture = 'arm64'; }); }],
    ['revision label', (d: FixtureCase) => { modifyConfig(d, config => { config.config.Labels['org.opencontainers.image.revision'] = sourceSha.slice(0, 7); }); }],
    ['source label', (d: FixtureCase) => { modifyConfig(d, config => { config.config.Labels['org.opencontainers.image.source'] = 'https://github.com/other/repo'; }); }],
    ['credential in OCI config', (d: FixtureCase) => { modifyConfig(d, config => { config.config.Env = ['TOKEN=' + d.tokens.github]; }); }],
    ['encoded credential in OCI config', (d: FixtureCase) => { modifyConfig(d, config => {
      config.config.Env = ['TOKEN=' + Buffer.from(d.tokens.github).toString('base64')];
    }); }],
    ['oversized report', (d: FixtureCase) => { modifyConfig(d, config => { config.config.Env = ['PUBLIC=' + 'x'.repeat(48000)]; }); }],
    ['multi-platform index', (d: FixtureCase) => { d.metadata['containerimage.descriptor'].mediaType = 'application/vnd.oci.image.index.v1+json'; }],
    ['index masquerading as an image descriptor', (d: FixtureCase) => {
      const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests: [{ ...d.metadata['containerimage.descriptor'], platform: { os: 'linux', architecture: 'amd64' } }] }));
      d.manifestBase64 = bytes.toString('base64'); d.imageDigest = artifactSha(bytes);
      d.metadata['containerimage.digest'] = d.imageDigest;
      d.metadata['containerimage.descriptor'].digest = d.imageDigest; d.metadata['containerimage.descriptor'].size = bytes.length;
    }],
    ['missing metadata', (d: FixtureCase) => { delete d.metadata['containerimage.digest']; }],
    ['metadata symlink', (d: FixtureCase) => { d.metadataSymlink = true; }]
  ] as const)('rejects %s instead of selecting a tag/first image', async (_label, change) => { await failure(change); });

  it.each([
    ['foreign OIDC endpoint', (d: FixtureCase) => { d.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://evil.example/idtoken?api-version=2.0'; }],
    ['missing explicit GitHub token', (d: FixtureCase) => { d.env.GH_TOKEN = ''; d.env.GITHUB_TOKEN = 'ambient-must-not-be-used'; }],
    ['missing OIDC authority', (d: FixtureCase) => { d.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = ''; }],
    ['foreign OIDC audience', (d: FixtureCase) => { d.tokens.oidc = jwt({ aud: 'foreign-audience' }); }],
    ['foreign AAD principal', (d: FixtureCase) => { d.tokens.aad = jwt({ oid: 'wrong-principal', tid: applicationTenant, aud: 'https://management.azure.com/' }); }],
    ['foreign registry', (d: FixtureCase) => { d.registry.properties.loginServer = 'other.azurecr.io'; }],
    ['admin-enabled registry', (d: FixtureCase) => { d.registry.properties.adminUserEnabled = true; }],
    ['broader push permission', (d: FixtureCase) => { d.tokens.push = jwt({ aud: 'crliftoff.azurecr.io', grant_type: 'access_token',
      access: [{ type: 'repository', name: 'team/app', actions: ['pull', 'push', 'delete'] }] }); }],
    ['different repository scope', (d: FixtureCase) => { d.tokens.push = jwt({ aud: 'crliftoff.azurecr.io', grant_type: 'access_token',
      access: [{ type: 'repository', name: 'team/other', actions: ['pull', 'push'] }] }); }],
    ['broader readback credential', (d: FixtureCase) => { d.tokens.pull = d.tokens.push; }],
    ['metadata permission denied', (d: FixtureCase) => { d.httpStatusPath = '/repos/owner/repo/actions/runs/100/attempts/1/jobs'; }],
    ['registry redirect', (d: FixtureCase) => { d.httpRedirectPath = '/v2/team/app/manifests/' + d.imageDigest; }],
    ['unreviewed Docker version', (d: FixtureCase) => { d.dockerServerVersion = '1.0.0'; }]
  ] as const)('refuses %s with no credential diagnostics', async (_label, change) => { await failure(change); });

  it.each([
    ['build failure', (d: FixtureCase) => { d.failCommand = 'docker-build'; }],
    ['fetch failure', (d: FixtureCase) => { d.failCommand = 'git-fetch'; }],
    ['build timeout', (d: FixtureCase) => { d.timeoutCommand = 'docker-build'; }],
    ['command output limit', (d: FixtureCase) => { d.largeCommand = 'docker-build'; }],
    ['HTTP timeout', (d: FixtureCase) => { d.httpTimeoutPath = '/repos/owner/repo/actions/runs/100/attempts/1'; }],
    ['builder cleanup failure', (d: FixtureCase) => { d.failCommand = 'docker-remove'; }]
  ] as const)('cleans owned credentials and produces no report on %s', async (_label, change) => {
    const f = await failure(change);
    const calls = await f.lines('commands.jsonl');
    if (calls.some(call => call.args.includes('create'))) expect(calls.filter(call => call.args.includes('rm'))).toHaveLength(1);
  });

  it('never overwrites or cleans an existing report or an unrelated directory', async () => {
    const f = await fixture();
    const unrelated = join(f.root, '.liftoff-application-build-unrelated');
    await mkdir(unrelated);
    await writeFile(join(unrelated, 'owned-by-someone-else'), 'preserve');
    await symlink(join(unrelated, 'owned-by-someone-else'), join(f.root, 'liftoff-application-build.json'));
    expect((await f.execute()).status).toBe(1);
    expect(await readFile(join(unrelated, 'owned-by-someone-else'), 'utf8')).toBe('preserve');
    expect((await lstat(join(f.root, 'liftoff-application-build.json'))).isSymbolicLink()).toBe(true);
    expect(await f.lines('commands.jsonl')).toEqual([]);
  });

  it('checks the fixed executable bytes before evaluating any source or provider input', async () => {
    const f = await fixture(data => { data.env.LIFTOFF_APPLICATION_BUILD_PROGRAM_0 = 'unreviewed bytes'; });
    const result = await f.execute();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Application build program identity or execution failed; diagnostics withheld.\n');
    expect(await f.lines('http.jsonl')).toEqual([]);
    expect(await f.lines('commands.jsonl')).toEqual([]);
    await expect(lstat(join(f.root, 'liftoff-application-build.json'))).rejects.toHaveProperty('code', 'ENOENT');
    await f.assertClean();
  });
});
