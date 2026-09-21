#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';
import { buildProjectPlan } from '../dist/planner.js';
import { buildArtifacts } from '../dist/templates.js';
import { writeArtifacts } from '../dist/file-system.js';
import { localImageSessionFromEnvironment, TrivyReportError } from './repository-security/trivy.ts';
import { SecurityEvidenceError } from './repository-security/evidence.ts';
import { summarizeImageGate } from './repository-security/artifact-gates.ts';
import { canonicalDigest } from './repository-security/admission.ts';
import { generatedSecurityCases } from './repository-security/inventory.ts';
import { assessCheckovScope } from './repository-security/checkov.ts';
import { qualifyGeneratedDockerHealthDiagnostic } from './repository-security/generated-role-policy.ts';
import { requireGeneratedArtifactBaseline } from './repository-security/generated-artifact-binding.ts';

const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) throw new Error('Run generated-container verification through npm.');
const arguments_ = process.argv.slice(2);
if (arguments_.length !== 0 && (arguments_.length !== 2 || !['--case', '--health-case'].includes(arguments_[0]))) {
  throw new Error('Usage: npm run verify:generated-containers -- [--case <name[,name...]> | --health-case <generated-case>]');
}
const healthCase = arguments_[0] === '--health-case' ? arguments_[1] : undefined;
const selectedCase = healthCase ? undefined : arguments_[1];
if (healthCase && (process.env.LIFTOFF_TRIVY_LOCAL !== '1' || !process.env.LIFTOFF_CHECKOV_EXECUTABLE ||
    !generatedSecurityCases.some(entry => entry.id === healthCase))) {
  throw new Error('Health qualification requires a declared generated case and registered private image/Checkov configuration.');
}
const security = await localImageSessionFromEnvironment(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  ['node', 'go', 'frontend', 'python', 'genai-worker', 'genai-non-worker', 'genai-generic']);
const tempRoot = security ? path.join(security.root, 'contexts', 'generated')
  : await mkdtemp(path.join(os.tmpdir(), 'liftoff-container-verify-'));
if (security) await mkdir(tempRoot, { mode: 0o700 });
const runId = randomUUID();
const imageTags = [];
const tagFor = (name) => security?.tagFor(name) ?? `liftoff-template-${name}:verify-${runId}`;
const sentinel = 'liftoff-host-context-sentinel';
let securityStage = 'tool-restore';
let securityCase;
let securityImage;
const blockedImageCases = [];
const incompleteImageCases = [];
const imageAssessments = [];
const builtImageExpectations = [];
let expectedImageCases = ['node', 'go', 'frontend', 'python', 'genai-worker', 'genai-non-worker', 'genai-generic'];
const healthEvidence = [];

function dockerOptions(options = {}) {
  return { ...options, ...(security ? { env: security.environment } : {}) };
}
const dockerCommand = args => security?.dockerArgs(args) ?? args;
const dockerExecutable = security?.dockerExecutable ?? 'docker';

async function runTool(executable, args, cwd) {
  const isDocker = executable === 'docker';
  if (security && isDocker) {
    const output = await security.docker(args, {
      cwd, timeoutMs: 20 * 60_000, maxBytes: 20 * 1024 * 1024, discardStderr: true
    });
    try { return output.toString('utf8'); } finally { output.fill(0); }
  }
  const result = spawn.sync(isDocker ? dockerExecutable : executable, isDocker ? dockerCommand(args) : args, dockerOptions({
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 20 * 60_000,
    maxBuffer: 20 * 1024 * 1024
  }));
  if (result.error || result.status !== 0) {
    if (security) throw new Error('Isolated generated-container subprocess failed; raw output withheld.');
    throw new Error(
      `${executable} ${args.join(' ')} failed in ${cwd}\n` +
      `${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`
    );
  }
  return result.stdout;
}

const run = (args, cwd) => runTool('docker', args, cwd);
const runNpm = (args, cwd) => runTool(process.execPath, [npmCliPath, ...args], cwd);

function safeRegistryEnvironment(name) {
  const configuredRegistry = (security?.environment ?? process.env)[name];
  if (configuredRegistry) {
    const parsed = new URL(configuredRegistry);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(
        `${name} must not contain credentials, query parameters, or fragments.`
      );
    }
    return parsed.toString();
  }
  return undefined;
}

function buildArgs(tag, registryKind) {
  const registry = registryKind === 'npm'
    ? safeRegistryEnvironment('npm_config_registry')
    : registryKind === 'python'
      ? safeRegistryEnvironment('UV_DEFAULT_INDEX')
      : undefined;
  const buildArgument = registryKind === 'npm'
    ? `NPM_CONFIG_REGISTRY=${registry}`
    : `UV_DEFAULT_INDEX=${registry}`;
  return [
    'build',
    ...(registry ? ['--build-arg', buildArgument] : []),
    '--tag',
    tag,
    '.'
  ];
}

async function prepareNativeSource(projectRoot, entry) {
  const context = entry.name === 'frontend' ? path.join(projectRoot, 'frontend') : projectRoot;
  if (entry.name === 'frontend') {
    await runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], context);
    await runNpm(['run', 'build'], context);
  } else if (entry.plan.apiStack.id === 'python-fastapi') {
    if (security) {
      const identity = await security.preparePython(projectRoot, entry.plan.workload === 'genai' && entry.plan.pattern.worker);
      console.log(JSON.stringify({ caseId: entry.name, preparationRuntime: identity }));
    } else await runTool('uv', [
        'sync', '--frozen', '--project', 'backend', '--extra', 'test',
        ...(entry.plan.workload === 'genai' && entry.plan.pattern.worker ? ['--extra', 'functions'] : [])
      ], projectRoot);
  } else if (entry.plan.apiStack.id === 'node-fastify') {
    await runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], path.join(projectRoot, 'backend'));
    await runNpm(['run', 'build'], path.join(projectRoot, 'backend'));
  } else {
    await runTool('go', ['mod', 'download'], path.join(projectRoot, 'backend'));
    await runTool('go', ['build', './...'], path.join(projectRoot, 'backend'));
  }
  const directories = [
    ['.git'], ['node_modules'], ['.venv'], ['dist'],
    ...(entry.name === 'frontend' ? [] : [
      ['backend', '.venv'], ['backend', 'node_modules'], ['backend', 'dist']
    ])
  ];
  const probes = directories.map(parts => [...parts, sentinel]);
  probes.push(['.env.liftoff-private'], ['terraform.tfstate']);
  for (const parts of probes) {
    const file = path.join(context, ...parts);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${sentinel}\n`, { mode: 0o600 });
  }
  return probes;
}

async function verifyStartup(build, projectRoot, probes) {
  const name = security ? await security.reserveContainer(build.caseId)
    : `liftoff-verify-${runId}-${build.frontend ? 'frontend' : path.basename(projectRoot)}`;
  const port = build.frontend ? 80 : 8000;
  const command = [
    'run', ...(security ? security.containerIdentityArgs(build.caseId) : ['--rm']),
    '--name', name, '--publish', `127.0.0.1::${port}`,
    '--env', 'DATABASE_URL=postgresql://liftoff:test-only@127.0.0.1:5432/liftoff',
    '--env', 'REDIS_URL=redis://127.0.0.1:6379/0',
    '--env', 'PYDANTIC_AI_MODEL=test',
    '--env', 'LANGFUSE_PUBLIC_KEY=', '--env', 'LANGFUSE_SECRET_KEY=',
    build.imageId ?? build.tag
  ];
  if (security) await security.verifyBuilder();
  const child = spawn(dockerExecutable, dockerCommand(command), dockerOptions({
    cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'], shell: false
  }));
  let startupError;
  let logs = '';
  child.on('error', error => { startupError = error; });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { logs = `${logs}${chunk}`.slice(-64_000); });
  }
  const closed = new Promise(resolve => child.once('close', resolve));
  let failure;
  let healthProof;
  let registeredContainer = false;
  try {
    const deadline = Date.now() + 60_000;
    let origin;
    while (Date.now() < deadline) {
      if (startupError || child.exitCode !== null || child.signalCode !== null) {
        if (security) throw new SecurityEvidenceError('generated-image-startup-process-exit');
        throw new Error(`Generated image ${build.tag} exited before becoming ready: ${startupError?.message ?? logs}`);
      }
      if (security) await security.verifyBuilder();
      const binding = spawn.sync(dockerExecutable, dockerCommand(['port', name, `${port}/tcp`]), dockerOptions({
        encoding: 'utf8', shell: false, timeout: 10_000
      }));
      if (binding.error) {
        if (security) throw new SecurityEvidenceError('generated-image-port-inspection-error');
        throw binding.error;
      }
      if (binding.status !== 0 && !/no such (object|container)/i.test(binding.stderr ?? '')) {
        if (security) throw new SecurityEvidenceError('generated-image-port-inspection-failed');
        throw new Error(`Unable to inspect generated container ${name}: ${binding.stderr}`);
      }
      const matched = /^127\.0\.0\.1:(\d+)$/m.exec(binding.stdout ?? '');
      if (matched) {
        if (security && !registeredContainer) {
          await security.registerContainer(build.caseId, name);
          registeredContainer = true;
        }
        const candidate = `http://127.0.0.1:${matched[1]}`;
        try {
          const response = await fetch(`${candidate}${build.frontend ? '/' : '/health'}`, {
            signal: AbortSignal.timeout(2_000), redirect: 'error'
          });
          await response.arrayBuffer();
          if (response.ok) {
            origin = candidate;
            break;
          }
        } catch (error) {
          if (!(error instanceof TypeError) && error.name !== 'TimeoutError') throw error;
        }
      }
      await delay(200);
    }
    if (!origin) {
      if (security) throw new SecurityEvidenceError('generated-image-startup-deadline');
      throw new Error(`Generated image ${build.tag} never became healthy.\n${logs}`);
    }
    for (const endpoint of build.frontend ? ['/'] : ['/health', '/ready', '/openapi.json']) {
      const response = await fetch(`${origin}${endpoint}`, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
      if (!response.ok) {
        if (security) throw new SecurityEvidenceError('generated-image-endpoint-status');
        throw new Error(`${build.tag} ${endpoint} returned ${response.status}.\n${logs}`);
      }
      const content = await response.text();
      const document = build.frontend ? undefined : JSON.parse(content);
      const expected = build.frontend
        ? response.headers.get('content-type')?.includes('text/html') &&
          /\bid=["']app["']/.test(content) && /<script\b[^>]*\bsrc=["']/.test(content)
        : document !== null && typeof document === 'object' &&
          (endpoint === '/openapi.json' ? typeof document.openapi === 'string'
            : document.status === (endpoint === '/health' ? 'ok' : 'ready'));
      if (!expected) {
        if (security) throw new SecurityEvidenceError('generated-image-endpoint-contract');
        throw new Error(`${build.tag} ${endpoint} returned an unexpected response.`);
      }
      if (build.frontend) {
        const script = /<script\b[^>]*\bsrc=["']([^"']+)["']/.exec(content)?.[1];
        if (!script) throw new Error('Generated frontend entry is missing its module path.');
        const scriptUrl = new URL(script, origin);
        if (scriptUrl.origin !== origin) throw new Error('Frontend entry must load its generated local module.');
        const asset = await fetch(scriptUrl, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
        if (
          !asset.ok ||
          !/(?:java|ecma)script/i.test(asset.headers.get('content-type') ?? '') ||
          !(await asset.text()).trim()
        ) {
          throw new Error(`Generated frontend module was not served: ${scriptUrl.pathname}`);
        }
      }
      if (security && healthCase) healthProof = await security.proveGeneratedHealth(build.caseId, name);
    }
    const workdir = JSON.parse(await run(['inspect', '--format', '{{json .Config.WorkingDir}}', name], projectRoot)) || '/';
    const imagePaths = new Set(probes.flatMap(parts => [
      path.posix.join(workdir, ...parts),
      ...(parts[0] === 'backend' ? [path.posix.join(workdir, ...parts.slice(1))] : [])
    ]));
    for (const imagePath of imagePaths) {
      if (security) await security.verifyBuilder();
      const copied = spawn.sync(dockerExecutable, dockerCommand([
        'cp', `${name}:${imagePath}`, path.join(tempRoot, 'unexpected-context-file')
      ]), dockerOptions({ encoding: 'utf8', shell: false, timeout: 10_000 }));
      if (copied.error) throw copied.error;
      if (copied.status === 0) {
        if (security) throw new SecurityEvidenceError('generated-image-context-leak');
        throw new Error(`Host-only build input leaked into ${build.tag}: ${imagePath}`);
      }
      if (!/could not find the file|no such file or directory/i.test(copied.stderr ?? '')) {
        if (security) throw new SecurityEvidenceError('generated-image-context-inspection-error');
        throw new Error(`Unable to inspect build-context exclusion ${imagePath}: ${copied.stderr}`);
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    const cleanup = security ? undefined : spawn.sync('docker', ['rm', '--force', name], {
      encoding: 'utf8', shell: false, timeout: 15_000
    });
    if (security) {
      try {
        await security.removeContainer(name);
      } catch {
        failure = new Error('Owned generated container cleanup could not be verified; no unverified object was removed.');
      }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([closed, delay(5_000, undefined, { ref: false })]);
    if (cleanup && (cleanup.error || cleanup.status !== 0 && !/no such container/i.test(cleanup.stderr ?? ''))) {
      const detail = `Container cleanup failed for ${name}: ${cleanup.error?.message ?? cleanup.stderr}`;
      failure = new Error(`${failure?.message ?? ''}\n${detail}`, { cause: failure });
    }
  }
  if (failure) throw failure;
  return healthProof;
}

try {
  if (security && !healthCase) {
    await security.restoreTool();
    securityStage = 'database-refresh';
    await security.refreshDatabase();
  }
  const plans = [
    {
      name: 'node',
      plan: buildProjectPlan({
        projectName: 'Container Node',
        projectType: 'standard',
        apiStack: 'node',
        cloud: 'azure'
      }, { requireProjectName: true }),
      builds: [{
        pathParts: [],
        tag: tagFor('node'),
        registryKind: 'npm'
      }]
    },
    {
      name: 'go',
      plan: buildProjectPlan({
        projectName: 'Container Go',
        projectType: 'standard',
        apiStack: 'go',
        cloud: 'azure'
      }, { requireProjectName: true }),
      builds: [{
        pathParts: [],
        tag: tagFor('go')
      }]
    },
    {
      name: 'frontend',
      plan: buildProjectPlan({
        projectName: 'Container Frontend',
        projectType: 'standard',
        apiStack: 'node',
        cloud: 'azure',
        includeFrontend: true
      }, { requireProjectName: true }),
      builds: [{
        pathParts: ['frontend'],
        tag: tagFor('frontend'),
        frontend: true,
        registryKind: 'npm'
      }]
    },
    {
      name: 'python',
      plan: buildProjectPlan({
        projectName: 'Container Python',
        projectType: 'standard',
        apiStack: 'python',
        cloud: 'azure'
      }, { requireProjectName: true }),
      builds: [{
        pathParts: [],
        tag: tagFor('python'),
        registryKind: 'python'
      }]
    },
    {
      name: 'genai-worker',
      plan: buildProjectPlan({
        projectName: 'Container GenAI Worker',
        pattern: 'rag',
        cloud: 'azure'
      }, { requireProjectName: true }),
      builds: [{
        pathParts: [],
        tag: tagFor('genai-worker'),
        registryKind: 'python'
      }]
    },
    {
      name: 'genai-non-worker',
      plan: buildProjectPlan({
        projectName: 'Container GenAI Non Worker',
        pattern: 'chatbot',
        cloud: 'azure'
      }, { requireProjectName: true }),
      builds: [{
        pathParts: [],
        tag: tagFor('genai-non-worker'),
        registryKind: 'python'
      }]
    },
    {
      name: 'genai-generic',
      plan: buildProjectPlan({
        projectName: 'Container GenAI Generic',
        pattern: 'generic',
        cloud: 'azure'
      }, { requireProjectName: true }),
      builds: [{
        pathParts: [],
        tag: tagFor('genai-generic'),
        registryKind: 'python'
      }]
    }
  ];

  const requestedCases = selectedCase?.split(',');
  const unknownCases = requestedCases?.filter(name => !plans.some(entry => entry.name === name)) ?? [];
  if (unknownCases.length) {
    throw new Error(`Unknown container case ${unknownCases.join(', ')}. Select ${plans.map(entry => entry.name).join(', ')}.`);
  }
  let selectedPlans = requestedCases ? plans.filter(entry => requestedCases.includes(entry.name)) : plans;
  if (healthCase) {
    const known = generatedSecurityCases.find(entry => entry.id === healthCase);
    if (!known) throw new Error('Unknown generated health case.');
    const plan = buildProjectPlan(known.options, { requireProjectName: true });
    const family = plan.workload === 'genai' ? plan.pattern.worker ? 'genai-worker' : plan.pattern.id === 'generic' ? 'genai-generic' : 'genai-non-worker'
      : known.options.apiStack ?? 'node';
    const backend = plans.find(entry => entry.name === family);
    if (!backend) throw new Error('Generated health runtime family is unqualified.');
    selectedPlans = [{ ...backend, plan }];
    if (known.options.includeFrontend) selectedPlans.push({ ...plans.find(entry => entry.name === 'frontend'), plan });
  }
  expectedImageCases = selectedPlans.map(entry => entry.name);
  for (const entry of selectedPlans) {
    securityCase = entry.name;
    securityImage = undefined;
    securityStage = 'native-preparation';
    const projectRoot = path.join(tempRoot, entry.name);
    const artifacts = buildArtifacts(entry.plan);
    const artifactBindings = artifacts.map(item => ({
      logicalName: item.logicalName, pathParts: item.pathParts,
      digest: `sha256:${createHash('sha256').update(item.content).digest('hex')}`
    }));
    const artifactInventoryDigest = canonicalDigest(artifactBindings);
    if (healthCase) requireGeneratedArtifactBaseline(healthCase, artifactInventoryDigest);
    await writeArtifacts(projectRoot, artifacts);
    const metadataPaths = artifacts
      .filter(artifact => /^(package(?:-lock)?\.json|pyproject\.toml|uv\.lock|go\.(mod|sum))$/.test(artifact.pathParts.at(-1)))
      .map(artifact => path.join(projectRoot, ...artifact.pathParts));
    const before = await Promise.all(metadataPaths.map(file => readFile(file)));
    const probes = await prepareNativeSource(projectRoot, entry);
    const after = await Promise.all(metadataPaths.map(file => readFile(file)));
    securityStage = 'dependency-metadata-verification';
    if (before.some((bytes, index) => !bytes.equals(after[index]))) {
      throw new Error(`Native preparation changed generated dependency metadata for ${entry.name}.`);
    }
    securityStage = 'compose-configuration';
    await run(['compose', 'config', '-q'], projectRoot);
    if (entry.plan.workload === 'genai') {
      await run(['compose', '--profile', 'observability', 'config', '-q'], projectRoot);
    }
    for (const build of entry.builds) {
      securityStage = 'image-build';
      const context = path.join(projectRoot, ...build.pathParts);
      if (security) await security.build(entry.name, { context, registryKind: build.registryKind,
        ...(healthCase ? { generatedInput: {
          caseId: healthCase, target: build.frontend ? 'frontend' : 'backend', artifactInventoryDigest, files: artifactBindings
        } } : {}) });
      else await run(buildArgs(build.tag, build.registryKind), context);
      imageTags.push(build.tag);
      securityStage = 'image-registration';
      const image = security ? await security.registerBuilt(entry.name) : undefined;
      securityImage = image;
      if (image) builtImageExpectations.push({ caseId: entry.name, imageDigest: image.id, platform: image.platform });
      securityStage = 'startup-and-context-checks';
      const healthProof = await verifyStartup({ ...build, caseId: entry.name, imageId: image?.id }, projectRoot, probes);
      if (security && healthCase) {
        securityStage = 'health-contract-qualification';
        const parts = [...build.pathParts, 'Dockerfile'];
        const dockerfile = artifacts.find(item => item.pathParts.join('/') === parts.join('/'));
        if (!dockerfile) throw new Error('Generated Dockerfile is missing from its exact artifact inventory.');
        for (const item of artifacts) {
          if (await readFile(path.join(projectRoot, ...item.pathParts), 'utf8') !== item.content) throw new Error('Generated health source inputs changed.');
        }
        const native = await assessCheckovScope(process.cwd(), process.env.LIFTOFF_CHECKOV_EXECUTABLE, {
          framework: 'dockerfile', files: [{ pathParts: parts, content: dockerfile.content }]
        }, process.env.LIFTOFF_SECURITY_WORKSPACE_PARENT);
        const qualified = qualifyGeneratedDockerHealthDiagnostic(native, healthProof, { caseId: healthCase, artifactInventoryDigest });
        healthEvidence.push(qualified);
        console.log(JSON.stringify({ ...qualified, nativeChecks: native.results, vulnerabilitiesAssessed: false }));
      }
      if (security && !healthCase) {
        securityStage = 'image-assessment';
        try {
          const assessment = await security.assess(entry.name);
          imageAssessments.push(assessment);
          console.log(JSON.stringify(assessment));
          if (assessment.findings.some(finding => ['high', 'critical'].includes(finding.severity))) {
            blockedImageCases.push(entry.name);
            console.log(JSON.stringify({
              caseId: entry.name, runId: security.runId, imageDigest: image.id, platform: image.platform,
              status: 'blocked', stage: 'finding-policy', code: 'blocking-image-findings'
            }));
          }
        } catch (error) {
          if (!(error instanceof TrivyReportError)) throw error;
          incompleteImageCases.push(entry.name);
          console.log(JSON.stringify({
            caseId: entry.name, runId: security.runId, imageDigest: image.id, platform: image.platform,
            status: 'incomplete', stage: 'image-assessment', code: error.code, diagnostic: error.diagnostic
          }));
        }
      }
      console.log(`Verified prepared-source ${entry.name} image and startup.`);
    }
  }
  if (blockedImageCases.length || incompleteImageCases.length) {
    securityStage = incompleteImageCases.length ? 'image-assessment' : 'finding-policy';
    securityCase = undefined;
    securityImage = undefined;
    throw new Error('Generated image findings remain blocking after complete selected-case assessment.');
  }
  console.log(
    'Generated containers built from locally prepared source, excluded host-only inputs, and served their operational endpoints.'
  );
} catch (error) {
  if (security) {
    console.log(JSON.stringify({ caseId: securityCase ?? 'generated', runId: security.runId,
      imageDigest: securityImage?.id, platform: securityImage?.platform,
      status: securityStage === 'finding-policy' ? 'blocked' : 'incomplete', stage: securityStage,
      ...(blockedImageCases.length ? { blockedCases: blockedImageCases } : {}),
      ...(incompleteImageCases.length ? { incompleteCases: incompleteImageCases } : {}),
      ...(error instanceof TrivyReportError ? { diagnostic: error.diagnostic } : {}),
      code: securityStage === 'finding-policy' ? 'blocking-image-findings'
        : error instanceof SecurityEvidenceError ? error.code : 'bounded-process-or-check-failure' }));
    throw new Error('Local generated-image qualification failed; raw tool and image output withheld.');
  }
  throw error;
} finally {
  for (const imageTag of security ? [] : imageTags) {
    const cleanup = spawn.sync('docker', ['image', 'rm', imageTag], {
      encoding: 'utf8',
      shell: false,
      timeout: 15_000
    });
    if (cleanup.error || cleanup.status !== 0) {
      process.stderr.write(`Unable to remove verification image ${imageTag}: ${cleanup.error?.message ?? cleanup.stderr}\n`);
      process.exitCode = 1;
    }
  }
  if (security) {
    let cleanup = 'failed';
    try {
      await security.cleanup();
      cleanup = 'completed';
      console.log(JSON.stringify({ caseId: 'generated', runId: security.runId, status: 'cleaned' }));
    } finally {
      console.log(JSON.stringify(healthCase ? {
        kind: 'generated-health-only-qualification', generatedCase: healthCase, cleanup,
        assessmentComplete: cleanup === 'completed' &&
          healthEvidence.length === (generatedSecurityCases.find(entry => entry.id === healthCase)?.options.includeFrontend ? 2 : 1),
        qualifiedTargets: healthEvidence.map(item => item.target),
        expectedTargets: generatedSecurityCases.find(entry => entry.id === healthCase)?.options.includeFrontend ? ['backend', 'frontend'] : ['backend'],
        nativeFailuresPreserved: true, vulnerabilitiesAssessed: false, publicationQualified: false
      } : summarizeImageGate(expectedImageCases, builtImageExpectations, imageAssessments, cleanup)));
    }
  }
  else await rm(tempRoot, { recursive: true, force: true });
}
