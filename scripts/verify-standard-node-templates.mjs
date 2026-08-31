#!/usr/bin/env node
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import spawn from 'cross-spawn';
import { buildProjectPlan } from '../dist/planner.js';
import { buildArtifacts } from '../dist/templates.js';
import { writeArtifacts } from '../dist/file-system.js';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-standard-node-'));
const projectRoot = path.join(await realpath(tempRoot), 'verified-standard-app');
const npmCliPath = process.env.npm_execpath;

if (!npmCliPath) {
  throw new Error('npm_execpath is required. Run this verification through npm.');
}

function runNpm(cwd, args) {
  const result = spawn.sync(process.execPath, [npmCliPath, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 15 * 60_000,
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.error) {
    throw new Error(
      `npm ${args.join(' ')} could not start in ${cwd}: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `npm ${args.join(' ')} failed in ${cwd}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`
    );
  }
}

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
  const frontendLock = JSON.parse(before[3].toString('utf8'));
  const baseline = JSON.parse(
    await readFile(path.resolve('assets', 'supported-stack.json'), 'utf8')
  );

  requireVersion(
    backendLock,
    'node_modules/drizzle-orm',
    baseline.npmProjects['node-backend'].resolved.dependencies['drizzle-orm']
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
  runNpm(frontendRoot, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  runNpm(frontendRoot, ['run', 'build']);

  const after = await Promise.all(metadataPaths.map((filePath) => readFile(filePath)));
  if (before.some((contents, index) => !contents.equals(after[index]))) {
    throw new Error('Standard Node.js template verification modified generated package metadata.');
  }
  console.log('Standard Node.js backend and frontend install, build, and test verification passed.');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
