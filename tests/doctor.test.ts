import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { createFixtureProject, doctorExitCode, runCommand } from '../src/commands.js';
import { liftoffVersion } from '../src/version.js';
import { CaptureStream } from './helpers.js';

const cleanups: string[] = [];
const previousRegistry = process.env.LIFTOFF_REGISTRY;
const unreachableRegistry = 'http://127.0.0.1:1';

beforeAll(() => {
  // unreachable registry: freshness lookup must soft-fail silently
  process.env.LIFTOFF_REGISTRY = unreachableRegistry;
});

afterAll(() => {
  if (previousRegistry === undefined) {
    delete process.env.LIFTOFF_REGISTRY;
  } else {
    process.env.LIFTOFF_REGISTRY = previousRegistry;
  }
});

afterEach(async () => {
  process.env.LIFTOFF_REGISTRY = unreachableRegistry;
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

async function withRegistryVersion(version: string, callback: () => Promise<void>): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ version }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  process.env.LIFTOFF_REGISTRY = `http://127.0.0.1:${address.port}`;
  try {
    await callback();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function fixtureProject(pattern = 'prompt'): Promise<string> {
  const projectRoot = await createFixtureProject({
    projectName: 'Doctor App',
    pattern,
    cloud: 'azure',
    region: 'eastus',
    environments: ['dev'],
    specWorkflow: 'openspec',
    includeFrontend: false
  });
  cleanups.push(path.dirname(projectRoot));
  return projectRoot;
}

async function standardFixtureProject(apiStack: string): Promise<string> {
  const projectRoot = await createFixtureProject({
    projectName: 'Standard Doctor App',
    projectType: 'standard',
    apiStack,
    cloud: 'azure',
    region: 'eastus',
    environments: ['dev'],
    specWorkflow: 'openspec',
    includeFrontend: false
  });
  cleanups.push(path.dirname(projectRoot));
  return projectRoot;
}

async function run(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(args), { cwd, stdout, stderr });
  return { code, out: stdout.text(), err: stderr.text() };
}

describe('doctor exit-code model', () => {
  it('exits 0 with warnings only and 1 on any failure', () => {
    const warnOnly = [{ title: 'X', checks: [{ label: 'a', severity: 'warn' as const, detail: '' }, { label: 'b', severity: 'ok' as const, detail: '' }] }];
    const withFail = [{ title: 'X', checks: [{ label: 'a', severity: 'fail' as const, detail: '' }] }];
    expect(doctorExitCode(warnOnly)).toBe(0);
    expect(doctorExitCode(withFail)).toBe(1);
  }, 30_000);
});

describe('doctor command', () => {
  it('runs CLI and environment checks outside a project while offline', async () => {
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'liftoff-doctor-'));
    cleanups.push(elsewhere);

    const result = await run(['doctor'], elsewhere);
    expect(result.out).toContain('CLI');
    expect(result.out).toContain(`version: Liftoff ${liftoffVersion}`);
    expect(result.out).not.toContain('cli freshness');
    expect(result.out).toContain('Environment');
    expect(result.out).toContain('node:');
    expect(result.out).not.toContain('Project');
    expect(result.out).not.toContain('Runtime');
    expect(result.out).not.toContain('Cloud -');
  }, 30_000);

  it('runs all layers inside a project, configured by the manifest', async () => {
    const root = await fixtureProject();

    const result = await run(['doctor'], root);
    expect(result.out).toContain('CLI');
    expect(result.out).toContain('Environment');
    expect(result.out).toContain('Project');
    expect(result.out).toContain('Runtime');
    expect(result.out).toContain('Cloud - azure');
    expect(result.out).toMatch(/manifest: valid, \d+ artifacts present/);
    expect(result.out).toContain('scaffold drift: project matches the current templates');
    expect(result.out).not.toContain('cli freshness');
  }, 30_000);

  it('reports current and newer authoritative registry versions outside a project', async () => {
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'liftoff-doctor-freshness-'));
    cleanups.push(elsewhere);

    await withRegistryVersion(liftoffVersion, async () => {
      const current = await run(['doctor'], elsewhere);
      expect(current.out).toContain(`cli freshness: running ${liftoffVersion}, latest stable ${liftoffVersion}`);
    });

    await withRegistryVersion('99.0.0', async () => {
      const newer = await run(['doctor', '--json'], elsewhere);
      const report = JSON.parse(newer.out);
      const cli = report.layers.find((layer: { title: string }) => layer.title === 'CLI');
      const freshness = cli.checks.find((check: { label: string }) => check.label === 'cli freshness');
      expect(freshness).toMatchObject({
        severity: 'warn',
        detail: `Liftoff 99.0.0 is published, this CLI is ${liftoffVersion}`
      });
      expect(freshness.remedy).toContain('@msn-control/liftoff@99.0.0');
      expect(freshness.remedy).toContain('--registry=https://registry.npmjs.org');
      expect(report.summary.warnings).toBeGreaterThanOrEqual(1);
    });
  }, 30_000);

  it('ignores and preserves stale managed-registry configuration', async () => {
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'liftoff-doctor-mirror-'));
    cleanups.push(elsewhere);
    const npmrcPath = path.join(elsewhere, '.npmrc');
    const npmrc = 'registry=https://stale.example.invalid/npm/\n';
    await writeFile(npmrcPath, npmrc, 'utf8');

    await withRegistryVersion('99.0.0', async () => {
      const result = await run(['doctor'], elsewhere);
      expect(result.out).toContain(`Liftoff 99.0.0 is published, this CLI is ${liftoffVersion}`);
      expect(await readFile(npmrcPath, 'utf8')).toBe(npmrc);
    });
  }, 30_000);

  it('fails with a remedy when .env is missing and passes once created', async () => {
    const root = await fixtureProject();

    const missing = await run(['doctor'], root);
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(/\[fail\]\s+\.env: missing - copy \.env\.example to \.env/);

    await writeFile(path.join(root, '.env'), (await readFile(path.join(root, '.env.example'), 'utf8')), 'utf8');
    const present = await run(['doctor'], root);
    expect(present.out).toMatch(/\[ok\]\s+\.env: present/);
  }, 30_000);

  it('surfaces scaffold drift as a single warning with the update remedy', async () => {
    const root = await fixtureProject();
    const configPath = path.join(root, 'liftoff.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.environments = ['dev', 'test'];
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await run(['doctor'], root);
    expect(result.out).toMatch(/\[warn\]\s+scaffold drift: \d+ update\(s\) available - run liftoff update/);
  }, 30_000);

  it('discovers the project from a subdirectory', async () => {
    const root = await fixtureProject();
    const result = await run(['doctor'], path.join(root, 'backend', 'apis'));
    expect(result.out).toContain('Project');
    expect(result.out).toMatch(/manifest: valid/);
  }, 30_000);

  it('reports unsupported manifests as a project failure without crashing', async () => {
    const root = await fixtureProject();
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.artifactVersion = 1;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const result = await run(['doctor'], root);
    expect(result.code).toBe(1);
    expect(result.out).toContain('Unsupported manifest artifactVersion 1');
    expect(result.out).not.toContain('Runtime');
  }, 30_000);

  it('adds the worker tooling check for worker-enabled azure patterns', async () => {
    const root = await fixtureProject('rag');
    const result = await run(['doctor', '--json'], root);
    const report = JSON.parse(result.out);
    const cloud = report.layers.find((layer: { title: string }) => layer.title === 'Cloud - azure');
    expect(cloud.checks.some((check: { label: string }) => check.label === 'functions tooling')).toBe(true);
  }, 30_000);

  it('emits versioned JSON with layers and summary', async () => {
    const root = await fixtureProject();
    const result = await run(['doctor', '--json'], root);
    const report = JSON.parse(result.out);
    expect(report.schemaVersion).toBe(1);
    expect(report.layers.map((layer: { title: string }) => layer.title)).toContain('CLI');
    expect(report.layers.map((layer: { title: string }) => layer.title)).toContain('Project');
    expect(typeof report.summary.failures).toBe('number');
    expect(typeof report.summary.warnings).toBe('number');
    expect(result.out).not.toContain('cli freshness');
  }, 30_000);
});

it('runs only the selected standard API runtime checks', async () => {
  const nodeRoot = await standardFixtureProject('node');
  const nodeReport = JSON.parse((await run(['doctor', '--json'], nodeRoot)).out);
  const nodeEnvironment = nodeReport.layers.find((layer: { title: string }) => layer.title === 'Environment');
  expect(nodeEnvironment.checks.map((check: { label: string }) => check.label)).toContain('node');
  expect(nodeEnvironment.checks.map((check: { label: string }) => check.label)).not.toContain('python3');
  expect(nodeEnvironment.checks.map((check: { label: string }) => check.label)).not.toContain('go');
  const nodeProject = nodeReport.layers.find((layer: { title: string }) => layer.title === 'Project');
  expect(nodeProject.checks.some((check: { label: string }) => check.label === 'node-fastify project')).toBe(true);

  const goRoot = await standardFixtureProject('go');
  const goReport = JSON.parse((await run(['doctor', '--json'], goRoot)).out);
  const goEnvironment = goReport.layers.find((layer: { title: string }) => layer.title === 'Environment');
  expect(goEnvironment.checks.map((check: { label: string }) => check.label)).toContain('go');
  expect(goEnvironment.checks.map((check: { label: string }) => check.label)).not.toContain('python3');
}, 30_000);
