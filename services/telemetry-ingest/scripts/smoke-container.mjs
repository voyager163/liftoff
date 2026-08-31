import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(serviceRoot, '..', '..');
const suffix = randomUUID().replaceAll('-', '');
const image = `liftoff-telemetry-ingest-smoke:${suffix}`;
let containerId;

function registryBuildArgs() {
  const value = process.env.npm_config_registry;
  if (!value) return [];
  const registry = new URL(value);
  if (registry.username || registry.password || registry.search || registry.hash) {
    throw new Error('npm_config_registry must not contain credentials, query parameters, or fragments.');
  }
  return ['--build-arg', `NPM_CONFIG_REGISTRY=${registry.toString()}`];
}

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeout ?? 300_000
  });
  if (result.status !== 0 && !options.allowFailure) {
    const output = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`docker ${args.join(' ')} failed.\n${output}`);
  }
  return result;
}

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/events`, { method: 'GET' });
      if (response.status === 405) {
        return;
      }
    } catch {
      // The container may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Telemetry container did not become ready.');
}

try {
  docker([
    'build',
    '--file',
    path.join('services', 'telemetry-ingest', 'Dockerfile'),
    ...registryBuildArgs(),
    '--tag',
    image,
    '.'
  ]);
  const run = docker([
    'run',
    '--detach',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16m',
    '--publish',
    '127.0.0.1::8080',
    image,
    'node',
    '--input-type=module',
    '--eval',
    `
      const gateway = await import('./dist/services/telemetry-ingest/src/server.js');
      const server = gateway.createTelemetryServer(() => ({
        now: () => new Date(),
        upload: async () => undefined
      }));
      await gateway.listenTelemetryServer(server);
      let shuttingDown = false;
      const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        void gateway.closeTelemetryServer(server);
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    `
  ]);
  containerId = run.stdout.trim();

  const configuredUser = docker(['inspect', '--format', '{{.Config.User}}', containerId]).stdout.trim();
  if (configuredUser !== 'node') {
    throw new Error(`Expected container user "node", received "${configuredUser}".`);
  }

  const portOutput = docker(['port', containerId, '8080/tcp']).stdout.trim();
  const hostPort = portOutput.match(/127\.0\.0\.1:(\d+)$/)?.[1];
  if (!hostPort) {
    throw new Error(`Unable to resolve telemetry container port from "${portOutput}".`);
  }
  const baseUrl = `http://127.0.0.1:${hostPort}`;
  await waitForServer(baseUrl);

  const missingRoute = await fetch(`${baseUrl}/health`);
  if (missingRoute.status !== 404) {
    throw new Error(`Expected no public health route, received ${missingRoute.status}.`);
  }
  const oversized = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(1_025)
  });
  if (oversized.status !== 413) {
    throw new Error(`Expected oversized request status 413, received ${oversized.status}.`);
  }

  docker(['stop', '--time', '5', containerId], { timeout: 15_000 });
  const exitCode = docker(['inspect', '--format', '{{.State.ExitCode}}', containerId]).stdout.trim();
  if (exitCode !== '0') {
    throw new Error(`Expected graceful container exit code 0, received ${exitCode}.`);
  }
} finally {
  if (containerId) {
    docker(['rm', '--force', containerId], { allowFailure: true, timeout: 30_000 });
  }
  docker(['image', 'rm', '--force', image], { allowFailure: true, timeout: 60_000 });
}
