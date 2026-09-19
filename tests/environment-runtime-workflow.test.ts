import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeCommandRunner } from '../src/process-runner.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { object } from '../src/adapters/github/activation-rest.js';
import { decodeWorkflow } from '../src/adapters/github/workflow-check-recipes.js';
import {
  environmentRuntimeJob, environmentRuntimeRecipe, environmentRuntimeReportFile, environmentRuntimeStep,
  renderEnvironmentRuntimeWorkflow, validateEnvironmentRuntimeReport
} from '../src/application/azure-activation/environment-runtime-workflow.js';
import { environmentQualificationFixture } from './helpers/environment-qualification-fixture.js';

const fixtures: Array<{ fixture: Awaited<ReturnType<typeof environmentQualificationFixture>>; cleanupAllowed: boolean }> = [];
afterEach(async () => {
  const retained: string[] = [];
  for (const entry of fixtures.splice(0)) {
    if (entry.cleanupAllowed) await entry.fixture.cleanup();
    else retained.push(entry.fixture.root);
  }
  if (retained.length) throw new Error(`Fixture retained because its owned process tree was not confirmed settled: ${retained.join(', ')}`);
});

type ResponseCase = 'valid' | 'html200' | 'redirect' | 'wrong-health' | 'wrong-schema' | 'blank-paths' | 'invalid-path-item' |
  'oversized-json' | 'wrong-runner-group' | 'missing-runner-name' | 'wrong-runner-label';

async function runRegisteredProbe(responseCase: ResponseCase) {
  const f = await environmentQualificationFixture();
  const registration = { fixture: f, cleanupAllowed: true };
  fixtures.push(registration);
  const correlation = randomUUID();
  const startedAt = new Date().toISOString();
  const observedPaths: string[] = [];
  const schema = {
    openapi: '3.1.0', info: { title: 'Isolated runtime protocol', version: '1.0.0' },
    paths: { '/api/v1/quote': { get: { responses: { '200': { description: 'Actual quote route' } } } } }
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    observedPaths.push(url.pathname);
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/__ready') { response.end('{"ready":true}'); return; }
    if (request.headers['x-liftoff-test-host'] === 'api.github.com') {
      if (url.pathname.endsWith('/jobs')) {
        const job = f.protocol.job();
        response.end(JSON.stringify({ total_count: 1, jobs: [{
          ...job,
          ...(responseCase === 'wrong-runner-group' ? { runner_group_name: 'unreviewed-group' } : {}),
          ...(responseCase === 'missing-runner-name' ? { runner_name: null } : {}),
          ...(responseCase === 'wrong-runner-label' ? { labels: ['unreviewed-label'] } : {})
        }] }));
      } else response.end(JSON.stringify(f.protocol.run()));
      return;
    }
    if (request.headers['x-liftoff-test-host'] !== f.recipe.fqdn) {
      response.statusCode = 404; response.end('{}'); return;
    }
    if (url.pathname === f.recipe.healthPath) {
      if (responseCase === 'html200') { response.setHeader('Content-Type', 'text/html'); response.end('<html>SPA shell</html>'); return; }
      if (responseCase === 'redirect') { response.statusCode = 302; response.setHeader('Location', 'https://unapproved.invalid/'); response.end('{}'); return; }
      if (responseCase === 'oversized-json') { response.end(JSON.stringify({ status: 'ok', padding: 'x'.repeat(131072) })); return; }
      response.end(JSON.stringify({ status: responseCase === 'wrong-health' ? 'not-healthy' : 'ok' }));
      return;
    }
    if (url.pathname === f.recipe.schemaPath) {
      response.end(JSON.stringify(
        responseCase === 'wrong-schema' ? { title: 'not an OpenAPI document' } :
        responseCase === 'blank-paths' ? { ...schema, paths: {} } :
        responseCase === 'invalid-path-item' ? { ...schema, paths: { '/api/v1/quote': null } } : schema
      ));
      return;
    }
    response.statusCode = 404; response.end('{}');
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 100;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('The owned HTTP fixture did not receive a port.');
    const base = `http://127.0.0.1:${address.port}`;
    const ready = await fetch(`${base}/__ready`, { signal: AbortSignal.timeout(1000) });
    expect(await ready.json()).toEqual({ ready: true });
    const source = decodeWorkflow(renderEnvironmentRuntimeWorkflow(f.recipe));
    const job = object(object(source.jobs).runtime);
    if (!Array.isArray(job.steps)) throw new Error('Registered workflow has no steps.');
    const step = job.steps.map((value) => object(value)).find((value) => value.name === environmentRuntimeStep);
    const shell = step?.run;
    if (typeof shell !== 'string') throw new Error('Registered workflow has no actual observation program.');
    const match = /^node --input-type=module <<'LIFTOFF_RUNTIME_OBSERVATION'\n([\s\S]+)LIFTOFF_RUNTIME_OBSERVATION\n$/u.exec(shell);
    if (!match) throw new Error('Unsupported registered observation command.');
    // Only this child maps approved HTTPS names to this owned HTTP protocol fixture.
    const preload = `
      const original = globalThis.fetch;
      const allowed = ${JSON.stringify(['api.github.com', f.recipe.fqdn])};
      globalThis.fetch = (value, options) => {
        const url = new URL(value);
        if (url.protocol !== 'https:' || !allowed.includes(url.hostname) || url.username || url.password || url.port) {
          throw new Error('Unapproved test network target.');
        }
        const destination = new URL(${JSON.stringify(base)});
        destination.pathname = url.pathname; destination.search = url.search;
        return original(destination, {...options, headers: {...options?.headers, 'x-liftoff-test-host': url.hostname}});
      };
    `;
    registration.cleanupAllowed = false;
    const result = await new NodeCommandRunner().run({
      executable: process.execPath,
      args: ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, '--input-type=module']
    }, {
      cwd: f.projectRoot, stdin: match[1], timeoutMs: 10_000, maxOutputBytes: 64 * 1024,
      ensureProcessTreeSettled: true, stream: false,
      env: {
        GH_TOKEN: 'isolated-protocol-test-value', GITHUB_REPOSITORY: f.workflow.repository,
        GITHUB_REPOSITORY_ID: String(f.workflow.repositoryId), GITHUB_RUN_ID: String(f.protocol.runId),
        GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: f.workflow.sourceSha,
        LIFTOFF_RUNTIME_RECIPE: JSON.stringify(f.recipe), LIFTOFF_CORRELATION_ID: correlation,
        LIFTOFF_CONFIGURATION_DIGEST: f.dispatchInputs.qualification_digest, LIFTOFF_RECIPE_DIGEST: canonicalSha256(f.recipe)
      }
    });
    registration.cleanupAllowed = result.processTreeSettled === true;
    expect(result.timedOut).toBe(false);
    expect(result.processTreeSettled).toBe(true);
    return { f, result, startedAt, completedAt: new Date().toISOString(), correlation, observedPaths, schema };
  } finally {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  }
}

describe('actual registered runtime observation program over owned HTTP fixtures', () => {
  it('renders stable reviewed source routing before any provider runner, group or definition IDs exist', () => {
    const stable = environmentRuntimeRecipe({
      workflowPath: '.github/workflows/liftoff-environment-staging.yml', environment: 'staging',
      resourceId: '/subscriptions/11111111-2222-4333-8444-555555555555/resourceGroups/rg-environment-test/providers/Microsoft.App/containerApps/environment-test',
      fqdn: 'environment-test.fixture.eastus.azurecontainerapps.io', healthPath: '/health', schemaPath: '/openapi.json',
      runner: { group: 'environment-test-group', label: 'environment-test-linux' }, uploadArtifactActionSha: 'f'.repeat(40)
    });
    expect(stable.runner).toEqual({ group: 'environment-test-group', label: 'environment-test-linux' });
    const source = decodeWorkflow(renderEnvironmentRuntimeWorkflow(stable));
    const job = object(object(source.jobs).runtime);
    expect(job['runs-on']).toEqual({ group: stable.runner.group, labels: stable.runner.label });
    if (!Array.isArray(job.steps)) throw new Error('Registered source has no observation step.');
    const env = object(object(job.steps[0]).env);
    expect(JSON.parse(String(env.LIFTOFF_RUNTIME_RECIPE))).toEqual(stable);
    expect(env.LIFTOFF_RECIPE_DIGEST).toBe(canonicalSha256(stable));
    for (const extra of [{ runnerId: 351 }, { runnerId: null }, { runnerGroupId: 451 }, { definitionId: 551 }]) {
      expect(() => environmentRuntimeRecipe({ ...stable, runner: { ...stable.runner, ...extra } })).toThrow();
    }
  });

  it('executes the current Node program and admits its actual output bytes, not a handwritten report replacement', async () => {
    const { f, result, startedAt, completedAt, correlation, observedPaths, schema } = await runRegisteredProbe('valid');
    expect(result.status, result.stderr).toBe(0);
    const bytes = await readFile(path.join(f.projectRoot, environmentRuntimeReportFile));
    const job = {
      id: f.protocol.jobId, name: environmentRuntimeJob, conclusion: 'success' as const, checkRunId: f.protocol.checkId,
      appId: 15368, appSlug: 'github-actions', steps: f.protocol.job().steps
    };
    const validated = validateEnvironmentRuntimeReport(bytes, f.recipe, f.workflow, {
      runId: f.protocol.runId, correlationId: correlation, configurationDigest: f.dispatchInputs.qualification_digest,
      job, providerJob: { ...f.protocol.job(), started_at: startedAt, completed_at: completedAt }, now: new Date(completedAt)
    });
    expect(validated.report.health.bodyDigest).toBe(createHash('sha256').update('{"status":"ok"}').digest('hex'));
    expect(validated.report.schema.bodyDigest).toBe(createHash('sha256').update(JSON.stringify(schema)).digest('hex'));
    expect(validated.report.schema.paths).toEqual(['/api/v1/quote']);
    expect(validated.report.producer).toMatchObject({ runId: f.protocol.runId, jobId: f.protocol.jobId, actorId: f.workflow.actorId });
    expect(validated.runner).toEqual({
      runnerId: f.protocol.runner.id, runnerName: f.protocol.runner.name,
      runnerGroupId: f.protocol.runner.groupId, runnerGroupName: f.protocol.runner.groupName, labels: f.protocol.runner.labels
    });
    expect(observedPaths).toContain(f.recipe.healthPath);
    expect(observedPaths).toContain(f.recipe.schemaPath);
    expect(bytes.toString()).not.toContain('isolated-protocol-test-value');
  });

  it.each([
    'html200', 'redirect', 'wrong-health', 'wrong-schema', 'blank-paths', 'invalid-path-item', 'oversized-json',
    'wrong-runner-group', 'missing-runner-name', 'wrong-runner-label'
  ] as const)(
    'rejects real HTTP %s responses without emitting a successful runtime report', async (scenario) => {
      const { f, result } = await runRegisteredProbe(scenario);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Runtime observation failed; response bodies and credential diagnostics withheld.');
      await expect(readFile(path.join(f.projectRoot, environmentRuntimeReportFile))).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
