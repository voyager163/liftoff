#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import spawn from 'cross-spawn';
import { buildProjectPlan } from '../dist/planner.js';
import { buildArtifacts } from '../dist/templates.js';
import { writeArtifacts } from '../dist/file-system.js';

const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) throw new Error('Run generated-container verification through npm.');
const arguments_ = process.argv.slice(2);
if (arguments_.length !== 0 && (arguments_.length !== 2 || arguments_[0] !== '--case')) {
  throw new Error('Usage: npm run verify:generated-containers -- [--case <name[,name...]>]');
}
const selectedCase = arguments_[1];
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-container-verify-'));
const runId = randomUUID();
const imageTags = [];
const tagFor = (name) => `liftoff-template-${name}:verify-${runId}`;
const sentinel = 'liftoff-host-context-sentinel';

function runTool(executable, args, cwd) {
  const result = spawn.sync(executable, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 20 * 60_000,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
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
  const configuredRegistry = process.env[name];
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
    runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], context);
    runNpm(['run', 'build'], context);
  } else if (entry.plan.apiStack.id === 'python-fastapi') {
    runTool('uv', [
      'sync', '--frozen', '--project', 'backend', '--extra', 'test',
      ...(entry.plan.workload === 'genai' && entry.plan.pattern.worker ? ['--extra', 'functions'] : [])
    ], projectRoot);
  } else if (entry.plan.apiStack.id === 'node-fastify') {
    runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], path.join(projectRoot, 'backend'));
    runNpm(['run', 'build'], path.join(projectRoot, 'backend'));
  } else {
    runTool('go', ['mod', 'download'], path.join(projectRoot, 'backend'));
    runTool('go', ['build', './...'], path.join(projectRoot, 'backend'));
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
  const name = `liftoff-verify-${runId}-${build.frontend ? 'frontend' : path.basename(projectRoot)}`;
  const port = build.frontend ? 80 : 8000;
  const command = [
    'run', '--rm', '--name', name, '--publish', `127.0.0.1::${port}`,
    '--env', 'DATABASE_URL=postgresql://liftoff:test-only@127.0.0.1:5432/liftoff',
    '--env', 'REDIS_URL=redis://127.0.0.1:6379/0',
    '--env', 'PYDANTIC_AI_MODEL=test',
    '--env', 'LANGFUSE_PUBLIC_KEY=', '--env', 'LANGFUSE_SECRET_KEY=',
    build.tag
  ];
  const child = spawn('docker', command, {
    cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'], shell: false
  });
  let startupError;
  let logs = '';
  child.on('error', error => { startupError = error; });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { logs = `${logs}${chunk}`.slice(-64_000); });
  }
  const closed = new Promise(resolve => child.once('close', resolve));
  let failure;
  try {
    const deadline = Date.now() + 60_000;
    let origin;
    while (Date.now() < deadline) {
      if (startupError || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Generated image ${build.tag} exited before becoming ready: ${startupError?.message ?? logs}`);
      }
      const binding = spawn.sync('docker', ['port', name, `${port}/tcp`], {
        encoding: 'utf8', shell: false, timeout: 10_000
      });
      if (binding.error) throw binding.error;
      if (binding.status !== 0 && !/no such (object|container)/i.test(binding.stderr ?? '')) {
        throw new Error(`Unable to inspect generated container ${name}: ${binding.stderr}`);
      }
      const matched = /^127\.0\.0\.1:(\d+)$/m.exec(binding.stdout ?? '');
      if (matched) {
        const candidate = `http://127.0.0.1:${matched[1]}`;
        try {
          const response = await fetch(`${candidate}${build.frontend ? '/' : '/health'}`, {
            signal: AbortSignal.timeout(2_000)
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
    if (!origin) throw new Error(`Generated image ${build.tag} never became healthy.\n${logs}`);
    for (const endpoint of build.frontend ? ['/'] : ['/health', '/ready', '/openapi.json']) {
      const response = await fetch(`${origin}${endpoint}`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) {
        throw new Error(`${build.tag} ${endpoint} returned ${response.status}.\n${logs}`);
      }
      const content = await response.text();
      const document = build.frontend ? undefined : JSON.parse(content);
      const expected = build.frontend
        ? response.headers.get('content-type')?.includes('text/html') &&
          /\bid=["']app["']/.test(content) && /<script\b[^>]*\bsrc=["']/.test(content)
        : document !== null && typeof document === 'object' &&
          (endpoint === '/openapi.json' ? typeof document.openapi === 'string' : typeof document.status === 'string');
      if (!expected) {
        throw new Error(`${build.tag} ${endpoint} returned an unexpected response.`);
      }
      if (build.frontend) {
        const script = /<script\b[^>]*\bsrc=["']([^"']+)["']/.exec(content)?.[1];
        if (!script) throw new Error('Generated frontend entry is missing its module path.');
        const scriptUrl = new URL(script, origin);
        if (scriptUrl.origin !== origin) throw new Error('Frontend entry must load its generated local module.');
        const asset = await fetch(scriptUrl, { signal: AbortSignal.timeout(5_000) });
        if (
          !asset.ok ||
          !/(?:java|ecma)script/i.test(asset.headers.get('content-type') ?? '') ||
          !(await asset.text()).trim()
        ) {
          throw new Error(`Generated frontend module was not served: ${scriptUrl.pathname}`);
        }
      }
    }
    const workdir = JSON.parse(run(['inspect', '--format', '{{json .Config.WorkingDir}}', name], projectRoot)) || '/';
    const imagePaths = new Set(probes.flatMap(parts => [
      path.posix.join(workdir, ...parts),
      ...(parts[0] === 'backend' ? [path.posix.join(workdir, ...parts.slice(1))] : [])
    ]));
    for (const imagePath of imagePaths) {
      const copied = spawn.sync('docker', [
        'cp', `${name}:${imagePath}`, path.join(tempRoot, 'unexpected-context-file')
      ], { encoding: 'utf8', shell: false, timeout: 10_000 });
      if (copied.error) throw copied.error;
      if (copied.status === 0) throw new Error(`Host-only build input leaked into ${build.tag}: ${imagePath}`);
      if (!/could not find the file|no such file or directory/i.test(copied.stderr ?? '')) {
        throw new Error(`Unable to inspect build-context exclusion ${imagePath}: ${copied.stderr}`);
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    const cleanup = spawn.sync('docker', ['rm', '--force', name], {
      encoding: 'utf8', shell: false, timeout: 15_000
    });
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([closed, delay(5_000, undefined, { ref: false })]);
    if (cleanup.error || cleanup.status !== 0 && !/no such container/i.test(cleanup.stderr ?? '')) {
      const detail = `Container cleanup failed for ${name}: ${cleanup.error?.message ?? cleanup.stderr}`;
      failure = new Error(`${failure?.message ?? ''}\n${detail}`, { cause: failure });
    }
  }
  if (failure) throw failure;
}

try {
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
  const selectedPlans = requestedCases ? plans.filter(entry => requestedCases.includes(entry.name)) : plans;
  for (const entry of selectedPlans) {
    const projectRoot = path.join(tempRoot, entry.name);
    const artifacts = buildArtifacts(entry.plan);
    await writeArtifacts(projectRoot, artifacts);
    const metadataPaths = artifacts
      .filter(artifact => /^(package(?:-lock)?\.json|pyproject\.toml|uv\.lock|go\.(mod|sum))$/.test(artifact.pathParts.at(-1)))
      .map(artifact => path.join(projectRoot, ...artifact.pathParts));
    const before = await Promise.all(metadataPaths.map(file => readFile(file)));
    const probes = await prepareNativeSource(projectRoot, entry);
    const after = await Promise.all(metadataPaths.map(file => readFile(file)));
    if (before.some((bytes, index) => !bytes.equals(after[index]))) {
      throw new Error(`Native preparation changed generated dependency metadata for ${entry.name}.`);
    }
    run(['compose', 'config', '-q'], projectRoot);
    if (entry.plan.workload === 'genai') {
      run(['compose', '--profile', 'observability', 'config', '-q'], projectRoot);
    }
    for (const build of entry.builds) {
      run(
        buildArgs(build.tag, build.registryKind),
        path.join(projectRoot, ...build.pathParts)
      );
      imageTags.push(build.tag);
      await verifyStartup(build, projectRoot, probes);
      console.log(`Verified prepared-source ${entry.name} image and startup.`);
    }
  }
  console.log(
    'Generated containers built from locally prepared source, excluded host-only inputs, and served their operational endpoints.'
  );
} finally {
  for (const imageTag of imageTags) {
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
  await rm(tempRoot, { recursive: true, force: true });
}
