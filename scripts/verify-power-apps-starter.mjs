#!/usr/bin/env node
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import spawn from 'cross-spawn';
import { buildProjectPlan } from '../dist/planner.js';
import { buildArtifacts } from '../dist/templates.js';
import { writeArtifacts } from '../dist/file-system.js';
import { verifyPowerAppsPackageMetadata } from '../dist/project-dependencies.js';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-power-apps-starter-'));
const projectRoot = path.join(await realpath(tempRoot), 'verified-power-app');
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function runNpm(args) {
  const result = spawn.sync(npmExecutable, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false,
    timeout: 15 * 60_000,
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.error) {
    throw new Error(
      `${npmExecutable} ${args.join(' ')} could not start: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${npmExecutable} ${args.join(' ')} failed\n${result.stdout ?? ''}\n${result.stderr ?? ''}`
    );
  }
}

try {
  const plan = buildProjectPlan({
    projectName: 'Verified Power App',
    projectType: 'power-apps-code-app'
  }, { requireProjectName: true });
  await writeArtifacts(projectRoot, buildArtifacts(plan));
  const metadataIssues = await verifyPowerAppsPackageMetadata(projectRoot);
  if (metadataIssues.length > 0) {
    throw new Error(metadataIssues.join('\n'));
  }
  const packagePath = path.join(projectRoot, 'package.json');
  const lockPath = path.join(projectRoot, 'package-lock.json');
  const packageBefore = await readFile(packagePath);
  const lockBefore = await readFile(lockPath);
  runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  runNpm(['run', 'lint']);
  runNpm(['run', 'build']);
  const [packageAfter, lockAfter] = await Promise.all([
    readFile(packagePath),
    readFile(lockPath)
  ]);
  if (!packageBefore.equals(packageAfter) || !lockBefore.equals(lockAfter)) {
    throw new Error('Power Apps verification modified generated package metadata.');
  }
  console.log('Power Apps starter install, lint, and build verification passed.');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
