import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localImageSessionFromEnvironment, TrivyReportError } from '../../../scripts/repository-security/trivy.ts';
import { SecurityEvidenceError } from '../../../scripts/repository-security/evidence.ts';
import { summarizeImageGate } from '../../../scripts/repository-security/artifact-gates.ts';

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(serviceRoot, '..', '..');
const security = await localImageSessionFromEnvironment(repositoryRoot, ['telemetry-ingest']);
const suffix = randomUUID().replaceAll('-', '');
const image = security?.tagFor('telemetry-ingest') ?? `liftoff-telemetry-ingest-smoke:${suffix}`;
let containerId;
let securityContainerName;
let imageIdentity;
let securityStage = 'tool-restore';
let imageAssessment;

function registryBuildArgs() {
  const value = (security?.environment ?? process.env).npm_config_registry;
  if (!value) return [];
  const registry = new URL(value);
  if (registry.username || registry.password || registry.search || registry.hash) {
    throw new Error('npm_config_registry must not contain credentials, query parameters, or fragments.');
  }
  return ['--build-arg', `NPM_CONFIG_REGISTRY=${registry.toString()}`];
}

async function docker(args, options = {}) {
  if (security) {
    const output = await security.docker(args, {
      cwd: options.cwd ?? repositoryRoot, timeoutMs: options.timeout ?? 300_000,
      maxBytes: 10 * 1024 * 1024, discardStderr: true
    });
    try { return { status: 0, stdout: output.toString('utf8') }; } finally { output.fill(0); }
  }
  const result = spawnSync(security?.dockerExecutable ?? 'docker', security?.dockerArgs(args) ?? args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: 'utf8',
    ...(security ? { env: security.environment } : {}),
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeout ?? 300_000
  });
  if (result.status !== 0 && !options.allowFailure) {
    if (security) throw new Error('Isolated telemetry-container subprocess failed; raw output withheld.');
    const output = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`docker ${args.join(' ')} failed.\n${output}`);
  }
  return result;
}

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/events`, {
        method: 'GET', signal: AbortSignal.timeout(2_000), redirect: 'error'
      });
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
  if (security) {
    await security.restoreTool();
    securityStage = 'database-refresh';
    await security.refreshDatabase();
  }
  securityStage = 'context-materialization';
  const context = security ? await security.prepareContext('telemetry-ingest', [
    ['package.json'], ['.dockerignore'], ['src', 'telemetry', 'contract.ts'],
    ...['Dockerfile', 'package.json', 'package-lock.json', 'tsconfig.json', 'scripts', 'src']
      .map(name => ['services', 'telemetry-ingest', name])
  ]) : undefined;
  securityStage = 'image-build';
  if (security) {
    await security.build('telemetry-ingest', {
      context: context.root, registryKind: 'npm', dockerfile: ['services', 'telemetry-ingest', 'Dockerfile']
    });
  } else await docker([
    'build',
    '--file',
    path.join('services', 'telemetry-ingest', 'Dockerfile'),
    ...registryBuildArgs(),
    '--tag',
    image,
    '.'
  ], { cwd: context?.root });
  securityStage = 'image-registration';
  if (security) imageIdentity = await security.registerBuilt('telemetry-ingest');
  if (context) await context.verify();
  securityStage = 'startup-checks';
  if (security) securityContainerName = await security.reserveContainer('telemetry-ingest');
  const run = await docker([
    'run',
    ...(security ? security.containerIdentityArgs('telemetry-ingest') : []),
    ...(security ? ['--name', securityContainerName] : []),
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
    imageIdentity?.id ?? image,
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
  if (security) await security.registerContainer('telemetry-ingest', securityContainerName);

  const configuredUser = (await docker(['inspect', '--format', '{{.Config.User}}', containerId])).stdout.trim();
  if (configuredUser !== 'node') {
    throw new Error(`Expected container user "node", received "${configuredUser}".`);
  }

  const portOutput = (await docker(['port', containerId, '8080/tcp'])).stdout.trim();
  const hostPort = portOutput.match(/127\.0\.0\.1:(\d+)$/)?.[1];
  if (!hostPort) {
    throw new Error(`Unable to resolve telemetry container port from "${portOutput}".`);
  }
  const baseUrl = `http://127.0.0.1:${hostPort}`;
  await waitForServer(baseUrl);

  const missingRoute = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
  if (missingRoute.status !== 404) {
    throw new Error(`Expected no public health route, received ${missingRoute.status}.`);
  }
  const oversized = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(1_025),
    signal: AbortSignal.timeout(5_000), redirect: 'error'
  });
  if (oversized.status !== 413) {
    throw new Error(`Expected oversized request status 413, received ${oversized.status}.`);
  }

  await docker(['stop', '--time', '5', containerId], { timeout: 15_000 });
  const exitCode = (await docker(['inspect', '--format', '{{.State.ExitCode}}', containerId])).stdout.trim();
  if (exitCode !== '0') {
    throw new Error(`Expected graceful container exit code 0, received ${exitCode}.`);
  }
  if (security) {
    securityStage = 'image-assessment';
    const assessment = await security.assess('telemetry-ingest');
    imageAssessment = assessment;
    console.log(JSON.stringify(assessment));
    if (assessment.findings.some(finding => ['high', 'critical'].includes(finding.severity))) {
      securityStage = 'finding-policy';
      throw new Error('Telemetry image contains unexcepted blocking vulnerability or policy findings.');
    }
  }
} catch (error) {
  if (security) {
    console.log(JSON.stringify({ caseId: 'telemetry-ingest', runId: security.runId,
      imageDigest: imageIdentity?.id, platform: imageIdentity?.platform,
      status: securityStage === 'finding-policy' ? 'blocked' : 'incomplete', stage: securityStage,
      ...(error instanceof TrivyReportError ? { diagnostic: error.diagnostic } : {}),
      code: securityStage === 'finding-policy' ? 'blocking-image-findings'
        : error instanceof SecurityEvidenceError ? error.code : 'bounded-process-or-check-failure' }));
    throw new Error('Local telemetry-image qualification failed; raw tool and image output withheld.');
  }
  throw error;
} finally {
  if (containerId) {
    if (security) await security.removeContainer(securityContainerName);
    else await docker(['rm', '--force', containerId], { allowFailure: true, timeout: 30_000 });
  }
  if (security) {
    let cleanup = 'failed';
    try {
      await security.cleanup();
      cleanup = 'completed';
      console.log(JSON.stringify({ caseId: 'telemetry-ingest', runId: security.runId, status: 'cleaned' }));
    } finally {
      console.log(JSON.stringify(summarizeImageGate(['telemetry-ingest'],
        imageIdentity ? [{ caseId: 'telemetry-ingest', imageDigest: imageIdentity.id, platform: imageIdentity.platform }] : [],
        imageAssessment ? [imageAssessment] : [], cleanup)));
    }
  }
  else await docker(['image', 'rm', '--force', image], { allowFailure: true, timeout: 60_000 });
}
