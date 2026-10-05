#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import spawn from 'cross-spawn';
import { buildProjectPlan } from '../dist/planner.js';
import { buildArtifacts } from '../dist/templates.js';
import { writeArtifacts } from '../dist/file-system.js';
import { nodeRuntimeError } from '../dist/runtime.js';
import { resolveTemplateRuntime, templateRuntimeEnvironment } from './standard-node-template-runtime.mjs';

const { nodePath, npmCliPath } = resolveTemplateRuntime();
const reportPath = process.env.LIFTOFF_TEMPLATE_QUALIFICATION_REPORT;
const generatorError = nodeRuntimeError(process.versions.node);
if (generatorError) throw new Error(generatorError);
if (reportPath !== undefined && !path.isAbsolute(reportPath)) {
  throw new Error('LIFTOFF_TEMPLATE_QUALIFICATION_REPORT must be an absolute report path.');
}
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-standard-node-'));
const projectRoot = path.join(await realpath(tempRoot), 'verified-standard-app');
const commands = [];
let qualification;
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function runNode(cwd, args, extraEnv = {}, npm = false) {
  const argv = npm ? [npmCliPath, ...args] : args;
  const result = spawn.sync(nodePath, argv, {
    cwd,
    env: { ...templateRuntimeEnvironment({ nodePath, npmCliPath }), ...extraEnv },
    encoding: 'utf8',
    shell: false,
    timeout: 15 * 60_000,
    maxBuffer: 10 * 1024 * 1024
  });
  commands.push({
    component: path.relative(projectRoot, cwd) || 'project', args,
    executable: nodePath, argv,
    status: result.status, signal: result.signal,
    error: result.error ? { code: result.error.code, message: result.error.message } : null,
    stdout: result.stdout, stderr: result.stderr
  });
  if (result.error) {
    throw new Error(
      `${npm ? 'npm' : 'node'} ${args.join(' ')} could not start in ${cwd}: ${result.error.message}`
    );
  }
  if (result.status !== 0 || result.signal !== null) {
    throw new Error(
      `${npm ? 'npm' : 'node'} ${args.join(' ')} failed in ${cwd}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`
    );
  }
  return result.stdout;
}

const runNpm = (cwd, args, extraEnv = {}) => runNode(cwd, args, extraEnv, true);

function requireVersion(lock, packagePath, expected) {
  const version = lock.packages?.[packagePath]?.version;
  if (version !== expected) {
    throw new Error(`${packagePath} resolved unexpected version ${String(version)}.`);
  }
}

try {
  const plan = buildProjectPlan({
    projectName: 'Verified Standard App',
    projectType: 'standard',
    apiStack: 'node',
    cloud: 'azure',
    region: 'eastus',
    includeFrontend: true,
    environments: ['dev']
  }, { requireProjectName: true });
  await writeArtifacts(projectRoot, buildArtifacts(plan));
  const projectNodeVersion = runNode(projectRoot, ['--version']).trim().replace(/^v/u, '');
  const npmVersion = runNpm(projectRoot, ['--version']).trim();
  if (!/^\d+\.\d+\.\d+$/u.test(projectNodeVersion) ||
      (process.env.LIFTOFF_TEMPLATE_EXPECTED_PROJECT_NODE !== undefined &&
       projectNodeVersion !== process.env.LIFTOFF_TEMPLATE_EXPECTED_PROJECT_NODE) ||
      (process.env.LIFTOFF_TEMPLATE_EXPECTED_NPM !== undefined &&
       npmVersion !== process.env.LIFTOFF_TEMPLATE_EXPECTED_NPM)) {
    throw new Error('The actual generated-project Node/npm runtime does not match its selected qualification lane.');
  }

  const backendRoot = path.join(projectRoot, 'backend');
  const frontendRoot = path.join(projectRoot, 'frontend');
  const metadataPaths = [
    path.join(backendRoot, 'package.json'),
    path.join(backendRoot, 'package-lock.json'),
    path.join(frontendRoot, 'package.json'),
    path.join(frontendRoot, 'package-lock.json')
  ];
  const before = await Promise.all(metadataPaths.map((filePath) => readFile(filePath)));
  const backendLock = JSON.parse(before[1].toString('utf8'));
  const backendManifest = JSON.parse(before[0].toString('utf8'));
  const frontendLock = JSON.parse(before[3].toString('utf8'));
  const baseline = JSON.parse(
    await readFile(path.resolve('assets', 'supported-stack.json'), 'utf8')
  );

  requireVersion(
    backendLock,
    'node_modules/drizzle-orm',
    baseline.npmProjects['node-backend'].resolved.dependencies['drizzle-orm']
  );
  if (JSON.stringify(backendManifest.overrides) !== JSON.stringify({
    '@esbuild-kit/core-utils': { esbuild: '0.25.12' }
  })) {
    throw new Error('Generated backend must contain only the reviewed loader-scoped esbuild override.');
  }
  requireVersion(
    backendLock,
    'node_modules/@esbuild-kit/core-utils/node_modules/esbuild',
    '0.25.12'
  );
  for (const dependency of ['vite', '@vitejs/plugin-vue', 'tailwindcss']) {
    requireVersion(
      frontendLock,
      `node_modules/${dependency}`,
      baseline.npmProjects.frontend.resolved.dependencies[dependency]
    );
  }

  runNpm(backendRoot, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  runNpm(backendRoot, ['run', 'build']);
  runNpm(backendRoot, ['test']);
  const metadataEnvironment = {
    DATABASE_URL: 'postgresql://127.0.0.1:1/liftoff_qualification',
    REDIS_URL: 'redis://127.0.0.1:1/0'
  };
  runNpm(backendRoot, ['run', 'db:generate'], metadataEnvironment);
  runNpm(backendRoot, ['exec', '--offline', '--', 'drizzle-kit', 'check'], metadataEnvironment);
  runNpm(frontendRoot, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  runNpm(frontendRoot, ['run', 'build']);

  const after = await Promise.all(metadataPaths.map((filePath) => readFile(filePath)));
  if (before.some((contents, index) => !contents.equals(after[index]))) {
    throw new Error('Standard Node.js template verification modified generated package metadata.');
  }
  const templatePaths = [
    'assets/plugins/node-fastify/node-backend/package.json',
    'assets/plugins/node-fastify/node-backend/package-lock.json'
  ];
  const templateBytes = await Promise.all(templatePaths.map(file => readFile(path.resolve(file))));
  qualification = {
    schemaVersion: 2, kind: 'liftoff-standard-node-template-qualification',
    sourceRevision: process.env.GITHUB_SHA ?? null,
    platform: process.platform, architecture: process.arch,
    nodeVersion: process.versions.node, projectNodeVersion, npmVersion,
    templateInputs: templatePaths.map((file, index) => ({
      pathParts: file.split('/'), bytes: templateBytes[index].length, sha256: sha256(templateBytes[index])
    })),
    generatedMetadata: metadataPaths.map((file, index) => ({
      pathParts: path.relative(projectRoot, file).split(path.sep), bytes: before[index].length, sha256: sha256(before[index])
    })),
    metadataUnchanged: true, databaseExecution: false, commands
  };
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
if (reportPath !== undefined) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(qualification, null, 2)}\n`, { flag: 'wx' });
}
console.log('Standard Node.js backend and frontend install, build, test, and Drizzle metadata verification passed.');
