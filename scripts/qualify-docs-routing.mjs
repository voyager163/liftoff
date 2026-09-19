#!/usr/bin/env node
import { createServer } from 'node:net';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeHttpServer, fetchText, listenOnLoopback, qualifyAppRoutes, startPrefixStrippingProxy
} from '../tests/helpers/api-routing.mjs';

export {
  compareSchemas, extractScalarSchemaReference, validateOpenApiShape, validateSchemaResponse,
  closeHttpServer, fetchText, listenOnLoopback, qualifyAppRoutes, startPrefixStrippingProxy
} from '../tests/helpers/api-routing.mjs';

export const genAiPatterns = [
  { pattern: 'generic', customRoute: '/api/ai/run' },
  { pattern: 'rag', customRoute: '/api/rag/query' },
  { pattern: 'chatbot', customRoute: '/api/chat/run' },
  { pattern: 'agent', customRoute: '/api/agent/run' },
  { pattern: 'prompt', customRoute: '/api/invoke/run' },
  { pattern: 'multi-agent', customRoute: '/api/multi-agent/run' },
  { pattern: 'fine-tuned', customRoute: '/api/fine-tuned/run' },
  { pattern: 'streaming', customRoute: '/api/stream' },
  { pattern: 'workflow', customRoute: '/api/workflows/run' }
];

const commandTimeoutMs = 120_000;
const readinessTimeoutMs = 30_000;
const serverTimeoutMs = 45_000;
const maxOutputBytes = 65_536;

function failed(result) {
  return result.status !== 0 || result.timedOut || result.outputLimitExceeded ||
    result.errorCode || result.processTreeSettled !== true;
}

export async function checkPrerequisite(runner, executable, args = ['--version'], options = {}) {
  const result = await runner.run({ executable, args }, {
    ...options, timeoutMs: 15_000, maxOutputBytes: 8192, ensureProcessTreeSettled: true
  });
  if (failed(result)) {
    throw new Error(`Missing prerequisite: ${executable} ${args.join(' ')} must run successfully within its budget: ${result.errorMessage ?? result.stderr}`);
  }
  return result;
}

export async function findFreePort() {
  const server = createServer();
  const url = await listenOnLoopback(server);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return Number(new URL(url).port);
}

export async function createRouteQualification({ generators, runner, env = process.env, tools = {} }) {
  const directory = path.resolve('tests', `.route qualification ${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  const scratch = path.join(directory, 'scratch');
  const cache = path.join(directory, 'cache');
  await Promise.all([scratch, cache].map((item) => mkdir(item)));
  const environment = {
    ...env, TMPDIR: scratch, TEMP: scratch, TMP: scratch,
    npm_config_cache: path.join(cache, 'npm'), UV_CACHE_DIR: path.join(cache, 'uv'),
    UV_PYTHON_DOWNLOADS: 'never', GOTOOLCHAIN: 'local'
  };
  const executables = {
    go: env.GO_PATH ?? 'go', npm: env.NPM_PATH ?? 'npm', uv: env.UV_PATH ?? 'uv',
    python: env.PYTHON_PATH ?? (process.platform === 'win32' ? 'python' : 'python3'),
    node: process.execPath, ...tools
  };
  const probed = new Set();
  const active = new Set();
  let safeToRemove = true;
  let closed = false;

  const execute = (command, options = {}) => {
    if (closed) throw new Error('Qualification fixture is already closed');
    const token = {};
    active.add(token);
    return runner.run(command, {
      env: environment, timeoutMs: commandTimeoutMs, maxOutputBytes,
      ensureProcessTreeSettled: true, ...options
    }).then((result) => {
      if (result.processTreeSettled !== true) safeToRemove = false;
      return result;
    }, (error) => { safeToRemove = false; throw error; }).finally(() => active.delete(token));
  };
  const boundedRunner = { run: execute };
  const prerequisite = async (id) => {
    if (probed.has(id)) return;
    await checkPrerequisite(boundedRunner, executables[id], id === 'go' ? ['version'] : ['--version'], { cwd: directory });
    probed.add(id);
  };
  const run = async (executable, args, cwd) => {
    const result = await execute({ executable, args }, { cwd });
    if (failed(result)) throw new Error(`Qualification command failed: ${result.displayCommand}\n${result.errorMessage ?? ''}\n${result.stdout}\n${result.stderr}`);
  };

  return {
    directory,
    async qualify({ apiStack, pattern, customRoute }) {
      const python = apiStack === 'python' || pattern !== undefined;
      await prerequisite(python ? 'uv' : apiStack === 'go' ? 'go' : 'npm');
      if (python) await prerequisite('python');
      else if (apiStack === 'node') await prerequisite('node');
      const project = path.join(directory, pattern ? `genai-${pattern}` : `${apiStack}-standard`);
      const plan = generators.buildProjectPlan({
        projectName: pattern ? `GenAI ${pattern} Route Test` : `${apiStack} Route Test`,
        ...(pattern ? { pattern } : { projectType: 'standard', apiStack }),
        cloud: 'azure', governanceProfile: 'none'
      }, { requireProjectName: true });
      await generators.writeArtifacts(project, generators.buildArtifacts(plan));
      const backend = path.join(project, 'backend');
      let command;
      const port = await findFreePort();
      if (apiStack === 'go') {
        const binary = path.join(project, process.platform === 'win32' ? 'api.exe' : 'api');
        await run(executables.go, ['build', '-o', binary, './cmd/api'], backend);
        command = { executable: binary, args: [] };
      } else if (python) {
        await run(executables.uv, [
          'sync', '--frozen', '--no-build', '--no-install-project', '--python', executables.python,
          '--project', backend
        ], project);
        const interpreter = path.join(backend, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin',
          process.platform === 'win32' ? 'python.exe' : 'python');
        command = { executable: interpreter, args: ['-m', 'uvicorn', 'backend.apis.main:app', '--port', String(port), '--host', '127.0.0.1'] };
      } else {
        await run(executables.npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], backend);
        await run(executables.npm, ['run', 'build', '--ignore-scripts'], backend);
        command = { executable: executables.node, args: ['dist/server.js'] };
      }

      const controller = new AbortController();
      let outcome;
      let executionError;
      const running = execute(command, {
        cwd: python ? project : backend, signal: controller.signal, timeoutMs: serverTimeoutMs,
        env: {
          ...environment, PORT: String(port), PYTHONPATH: project,
          DATABASE_URL: 'postgresql://localhost:5432/route_test', REDIS_URL: 'redis://localhost:6379/0'
        }
      }).then((result) => { outcome = result; }, (error) => { executionError = error; });
      const baseUrl = `http://127.0.0.1:${port}`;
      const proxyPrefix = '/tenant/pricing';
      const proxy = startPrefixStrippingProxy(port, proxyPrefix);
      try {
        const deadline = Date.now() + readinessTimeoutMs;
        let ready = false;
        while (Date.now() < deadline) {
          if (executionError || outcome) throw new Error(`Server exited before readiness: ${executionError ?? `${outcome.stdout}\n${outcome.stderr}`}`);
          try {
            const { response, text } = await fetchText(`${baseUrl}/ready`);
            ready = response.status === 200 && JSON.parse(text).status === 'ready';
          } catch {}
          if (ready) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!ready) throw new Error(`${pattern ?? apiStack} server did not respond within its readiness budget`);
        const proxyUrl = await listenOnLoopback(proxy);
        const probe = await fetchText(`${proxyUrl}${proxyPrefix}/ready`);
        if (probe.response.status !== 200) throw new Error('Prefix-stripping proxy is not responsive');
        const results = await qualifyAppRoutes({
          name: pattern ? `GenAI / FastAPI (${pattern})` : `${apiStack} standard`,
          baseUrl, proxyUrl, proxyPrefix,
          expectedSchemaRoutes: ['/health', '/ready', ...(pattern ? [customRoute] : python ? ['/api'] : [])],
          expectedHttpRoutes: [
            { path: '/health', status: 200, jsonFields: { status: 'ok' } },
            { path: '/ready', status: 200, jsonFields: { status: 'ready' } },
            ...(pattern ? [{
              path: customRoute, method: pattern === 'streaming' ? 'GET' : 'POST',
              ...(pattern === 'streaming' ? {} : { body: {} }), status: 422
            }] : ['/api'])
          ]
        });
        if (outcome || executionError) throw new Error('Server terminated during route qualification');
        return results;
      } finally {
        try { await closeHttpServer(proxy); }
        catch (error) { safeToRemove = false; throw error; }
        finally {
          controller.abort();
          await running;
          if (executionError || outcome?.processTreeSettled !== true) {
            safeToRemove = false;
            throw new Error(`Owned server settlement is unconfirmed; retaining ${directory}`);
          }
        }
      }
    },
    async close() {
      if (active.size || !safeToRemove) throw new Error(`Fixture may still be active; retaining ${directory}`);
      closed = true;
      await rm(directory, { recursive: true, force: true });
    }
  };
}

async function main() {
  const [{ buildProjectPlan }, { buildArtifacts }, { writeArtifacts }, { NodeCommandRunner }] = await Promise.all([
    import('../dist/planner.js'), import('../dist/templates.js'),
    import('../dist/file-system.js'), import('../dist/process-runner.js')
  ]);
  const qualification = await createRouteQualification({
    generators: { buildProjectPlan, buildArtifacts, writeArtifacts }, runner: new NodeCommandRunner()
  });
  try {
    for (const input of [{ apiStack: 'go' }, { apiStack: 'node' }, { apiStack: 'python' }, ...genAiPatterns]) {
      const result = await qualification.qualify(input);
      console.log(`${result.name}: ${result.checks.length} real HTTP checks passed`);
    }
    console.log('All three standard backends and nine GenAI patterns passed. Native Windows/cloud qualification is not claimed.');
  } finally { await qualification.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Route qualification failed:', error);
    process.exitCode = 1;
  });
}
