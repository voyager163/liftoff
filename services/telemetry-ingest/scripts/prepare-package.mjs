import { cp, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(serviceRoot, 'build', 'package');
const npmCliPath = process.env.npm_execpath;

if (!npmCliPath) {
  throw new Error('npm_execpath is required. Run this script through npm.');
}

await rm(path.join(serviceRoot, 'build'), { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });

for (const name of ['package.json', 'package-lock.json']) {
  await cp(path.join(serviceRoot, name), path.join(packageRoot, name));
}
await cp(path.join(serviceRoot, 'dist'), path.join(packageRoot, 'dist'), { recursive: true });

const install = spawnSync(
  process.execPath,
  [npmCliPath, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
  {
    cwd: packageRoot,
    env: process.env,
    encoding: 'utf8',
    shell: false,
    timeout: 300_000,
    maxBuffer: 10 * 1024 * 1024
  }
);

if (install.status !== 0) {
  const output = [install.error?.message, install.stdout, install.stderr].filter(Boolean).join('\n');
  throw new Error(`Unable to prepare the telemetry gateway runtime package.\n${output}`);
}
