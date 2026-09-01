import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import {
  createFixtureProject,
  doctorExitCode,
  runCommand,
  type CommandContext
} from '../src/commands.js';
import { liftoffVersion } from '../src/version.js';
import { governanceArtifactPaths } from '../src/repository-governance.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';
import type {
  CommandResult,
  RunCommandOptions
} from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';

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
    response.end(JSON.stringify({
      name: '@msn-control/liftoff',
      version
    }));
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

async function powerAppsFixtureProject(
  codeAppsPlugin = false,
  agents: Array<'copilot' | 'claude'> = ['copilot']
): Promise<string> {
  const projectRoot = await createFixtureProject({
    projectName: 'Power Apps Doctor App',
    projectType: 'power-apps-code-app',
    specWorkflow: 'openspec',
    agents,
    codeAppsPlugin
  });
  cleanups.push(path.dirname(projectRoot));
  return projectRoot;
}

class PluginDoctorRunner extends ReadyInitRunner {
  override async run(
    command: ExternalCommand,
    options?: RunCommandOptions
  ): Promise<CommandResult> {
    const result = await super.run(command, options);
    if (command.executable === 'copilot' && command.args.join(' ') === 'plugin list') {
      return { ...result, stdout: 'code-apps-preview 1.0.0 enabled\n' };
    }
    if (command.executable === 'claude' && command.args.join(' ') === 'plugin list --json') {
      return { ...result, status: 2, stdout: '', stderr: 'plugin listing unavailable\n' };
    }
    return result;
  }
}

async function run(
  args: string[],
  cwd: string,
  runner = new ReadyInitRunner(),
  context: Partial<Pick<
    CommandContext,
    'configuredRegistryTargetLookup' | 'stableReleaseLookup'
  >> = {}
): Promise<{ code: number; out: string; err: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(args), {
    cwd,
    stdout,
    stderr,
    runner,
    ...context
  });
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
    expect(result.out).toMatch(/manifest: valid, \d+ managed core and \d+ project provenance entries/);
    expect(result.out).toContain('framework contract: OpenSpec 1.11.0');
    expect(result.out).toContain('framework markers: 1 selected integration verified');
    expect(result.out).toContain(
      'managed core: Liftoff core is current; project templates are not compared'
    );
    expect(result.out).toContain('repository governance');
    expect(result.out).toContain('live enforcement is not inferred');
    expect(result.out).not.toContain('cli freshness');
  }, 30_000);

  it('reports local governance integrity without claiming live enforcement', async () => {
    const root = await fixtureProject();
    const ready = JSON.parse((await run(['doctor', '--json'], root)).out);
    const project = ready.layers.find((layer: { title: string }) =>
      layer.title === 'Project'
    );
    expect(project.checks.find((check: { id?: string }) =>
      check.id === 'repository-governance'
    )).toMatchObject({
      severity: 'ok',
      state: 'handoff-generated',
      detail: expect.stringContaining('live enforcement is not inferred')
    });

    await writeFile(
      path.join(root, ...governanceArtifactPaths.policy),
      'locally changed policy\n'
    );
    const validation = await run(['validate'], root);
    expect(validation.code).toBe(1);
    expect(validation.err).toContain(
      'Artifact hash mismatch for repository-governance-policy'
    );
    const unhealthy = JSON.parse((await run(['doctor', '--json'], root)).out);
    const unhealthyProject = unhealthy.layers.find((layer: { title: string }) =>
      layer.title === 'Project'
    );
    expect(unhealthyProject.checks.find((check: { id?: string }) =>
      check.id === 'repository-governance'
    )).toMatchObject({
      severity: 'fail',
      state: 'unhealthy'
    });
  }, 30_000);

  it('warns when governance adoption preserves an unowned conflict', async () => {
    const root = await fixtureProject();
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.governance.state = 'handoff-partial';
    manifest.managedArtifacts = manifest.managedArtifacts.filter(
      (artifact: { logicalName: string }) =>
        artifact.logicalName !== 'repository-governance-copilot-launcher'
    );
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(
      path.join(root, ...governanceArtifactPaths['github-copilot']),
      'developer launcher\n'
    );

    expect((await run(['validate'], root)).code).toBe(0);
    const result = await run(['doctor', '--json'], root);
    const project = JSON.parse(result.out).layers.find(
      (layer: { title: string }) => layer.title === 'Project'
    );
    expect(project.checks.find((check: { id?: string }) =>
      check.id === 'repository-governance'
    )).toMatchObject({
      severity: 'warn',
      state: 'handoff-partial',
      detail: expect.stringContaining('outside Liftoff ownership'),
      remedy: expect.stringMatching(/update --check.*update --force/)
    });
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

  it('reports shared requirement identifiers, states, severities, and authentication health', async () => {
    const root = await fixtureProject();
    const result = await run(['doctor', '--json'], root);
    const report = JSON.parse(result.out);
    const environment = report.layers.find((layer: { title: string }) => layer.title === 'Environment');
    const byId = new Map(environment.checks.map((check: { id: string }) => [check.id, check]));

    expect(byId.get('node')).toMatchObject({
      id: 'node',
      severity: 'ok',
      state: 'ready',
      requirementSeverity: 'blocking'
    });
    expect(byId.get('openspec')).toMatchObject({
      state: 'ready',
      requirementSeverity: 'blocking'
    });
    expect(byId.get('github-copilot:github-copilot-authentication')).toMatchObject({
      severity: 'warn',
      state: 'not-observable',
      requirementSeverity: 'advisory'
    });
    expect(report.schemaVersion).toBe(1);
  }, 30_000);

  it('fails blocking readiness and warns for advisory readiness from the shared probes', async () => {
    const root = await fixtureProject();
    const result = await run(
      ['doctor', '--json'],
      root,
      new ReadyInitRunner({ missing: ['openspec', 'docker'] })
    );
    const report = JSON.parse(result.out);
    const environment = report.layers.find((layer: { title: string }) => layer.title === 'Environment');
    const byId = new Map(environment.checks.map((check: { id: string }) => [check.id, check]));

    expect(result.code).toBe(1);
    expect(byId.get('openspec')).toMatchObject({
      severity: 'fail',
      state: 'missing',
      requirementSeverity: 'blocking'
    });
    expect(byId.get('docker')).toMatchObject({
      severity: 'warn',
      state: 'missing',
      requirementSeverity: 'advisory'
    });
  }, 30_000);

  it('checks the v3 framework contract and selected integration markers explicitly', async () => {
    const root = await fixtureProject();
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.framework.contractVersion = '1.5.0';
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    await rm(path.join(root, '.github', 'skills', 'openspec-apply-change', 'SKILL.md'));

    const report = JSON.parse((await run(['doctor', '--json'], root)).out);
    const project = report.layers.find((layer: { title: string }) => layer.title === 'Project');
    const contract = project.checks.find((check: { id: string }) => check.id === 'framework-contract');
    const markers = project.checks.find((check: { id: string }) => check.id === 'framework-markers');
    expect(contract).toMatchObject({ severity: 'fail', state: 'outdated' });
    expect(markers).toMatchObject({ severity: 'fail', state: 'unhealthy' });
    expect(markers.detail).toContain('Missing framework marker');
  }, 30_000);

  it('checks Spec Kit with both selected agents and its explicit default integration', async () => {
    const root = await createFixtureProject({
      projectName: 'Spec Kit Doctor App',
      projectType: 'standard',
      apiStack: 'node',
      cloud: 'azure',
      region: 'eastus',
      environments: ['dev'],
      specWorkflow: 'spec-kit',
      agents: ['copilot', 'claude'],
      defaultAgent: 'claude',
      includeFrontend: false
    });
    cleanups.push(path.dirname(root));

    const report = JSON.parse((await run(['doctor', '--json'], root)).out);
    const project = report.layers.find((layer: { title: string }) => layer.title === 'Project');
    const environment = report.layers.find((layer: { title: string }) => layer.title === 'Environment');
    expect(project.checks.find((check: { id: string }) => check.id === 'framework-contract')).toMatchObject({
      severity: 'ok',
      detail: 'Spec Kit 1.0.1'
    });
    expect(project.checks.find((check: { id: string }) => check.id === 'selected-agents')).toMatchObject({
      detail: 'github-copilot, claude'
    });
    expect(environment.checks.map((check: { id: string }) => check.id)).toEqual(expect.arrayContaining([
      'spec-kit',
      'github-copilot',
      'claude'
    ]));
  }, 30_000);

  it('derives Power Apps doctor checks without API, cloud, or global CLI requirements', async () => {
    const root = await powerAppsFixtureProject();
    const runner = new ReadyInitRunner();
    const result = await run(['doctor', '--json'], root, runner);
    const report = JSON.parse(result.out);
    const environment = report.layers.find((layer: { title: string }) => layer.title === 'Environment');
    const project = report.layers.find((layer: { title: string }) => layer.title === 'Project');
    const runtime = report.layers.find((layer: { title: string }) => layer.title === 'Runtime');

    expect(environment.checks.map((check: { id: string }) => check.id)).toEqual(
      expect.arrayContaining(['node', 'openspec', 'github-copilot'])
    );
    expect(environment.checks.map((check: { id: string }) => check.id)).not.toEqual(
      expect.arrayContaining(['python', 'go', 'docker', 'opentofu', 'azure-cli'])
    );
    expect(project.checks.find((check: { id: string }) => check.id === 'power-apps-project'))
      .toMatchObject({ severity: 'ok', state: 'ready' });
    expect(project.checks.find((check: { id: string }) => check.id === 'power-apps-starter'))
      .toMatchObject({
        severity: 'ok',
        state: 'ready',
        detail: expect.stringContaining('3438c352483e40982f6c5c0fc36fd71f8e7adbbb')
      });
    expect(runtime.checks.find((check: { id: string }) => check.id === 'power-apps-cli'))
      .toMatchObject({
        severity: 'skipped',
        state: 'not-observable',
        remedy: 'run npm ci, then rerun liftoff doctor'
      });
    expect(report.layers.some((layer: { title: string }) => layer.title.startsWith('Cloud -'))).toBe(false);
    expect(report.layers.some((layer: { title: string }) => layer.title === 'Optional Code Apps plugin')).toBe(false);
    expect(runner.calls.some((command) =>
      command.executable === 'pac' || command.executable === 'power-apps'
    )).toBe(false);
  }, 30_000);

  it('reports requested Code Apps plugin state per host as advisory JSON', async () => {
    const root = await powerAppsFixtureProject(true, ['copilot', 'claude']);
    const result = await run(['doctor', '--json'], root, new PluginDoctorRunner());
    const report = JSON.parse(result.out);
    const plugin = report.layers.find(
      (layer: { title: string }) => layer.title === 'Optional Code Apps plugin'
    );
    const byId = new Map(plugin.checks.map((check: { id: string }) => [check.id, check]));

    expect(result.code).toBe(0);
    expect(byId.get('code-apps-plugin:github-copilot')).toMatchObject({
      severity: 'ok',
      state: 'ready',
      requirementSeverity: 'advisory'
    });
    expect(byId.get('code-apps-plugin:claude')).toMatchObject({
      severity: 'warn',
      state: 'not-observable',
      requirementSeverity: 'advisory',
      remedy: expect.stringContaining('code-apps-preview@power-platform-skills')
    });
  }, 30_000);

  it('probes only the installed project-local Power Apps CLI without downloads', async () => {
    const root = await powerAppsFixtureProject();
    await mkdir(path.join(root, 'node_modules'));
    const runner = new ReadyInitRunner();
    const report = JSON.parse((await run(['doctor', '--json'], root, runner)).out);
    const runtime = report.layers.find((layer: { title: string }) => layer.title === 'Runtime');

    expect(runtime.checks.find((check: { id: string }) => check.id === 'power-apps-cli'))
      .toMatchObject({ severity: 'ok', state: 'ready' });
    expect(runner.calls).toContainEqual({
      executable: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: ['--no-install', 'power-apps', '--version']
    });
  }, 30_000);

  it('reports corrupted Power Apps package identity as a project failure', async () => {
    const root = await powerAppsFixtureProject();
    const lockPath = path.join(root, 'package-lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    lock.name = 'different-project';
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const result = await run(['doctor', '--json'], root);
    const report = JSON.parse(result.out);
    const project = report.layers.find((layer: { title: string }) => layer.title === 'Project');
    expect(result.code).toBe(1);
    expect(project.checks.find((check: { id: string }) => check.id === 'power-apps-project'))
      .toMatchObject({
        severity: 'fail',
        state: 'unhealthy',
        detail: 'package.json and package-lock.json must record the same project name.'
      });
  }, 30_000);

  it('warns about legacy framework uncertainty without inferring agents or framework ownership', async () => {
    const root = await fixtureProject();
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const workload = manifest.project.workload;
    manifest.artifacts = [
      ...manifest.managedArtifacts,
      ...manifest.projectArtifacts.map((artifact: Record<string, unknown>) => ({
        logicalName: artifact.logicalName,
        category: artifact.category,
        pathParts: artifact.pathParts,
        contentHash: artifact.generationHash
      }))
    ];
    delete manifest.managedArtifacts;
    delete manifest.projectArtifacts;
    manifest.artifactVersion = 2;
    manifest.project = {
      name: manifest.project.name,
      projectType: workload.kind,
      apiStack: workload.apiStack,
      pattern: workload.pattern,
      cloud: workload.cloud,
      region: workload.region,
      frontend: workload.frontend,
      environments: workload.environments,
      specWorkflow: manifest.project.specWorkflow
    };
    delete manifest.framework;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    const before = await readFile(manifestPath, 'utf8');

    const result = await run(['doctor', '--json'], root);
    const report = JSON.parse(result.out);
    const project = report.layers.find((layer: { title: string }) => layer.title === 'Project');
    const environment = report.layers.find((layer: { title: string }) => layer.title === 'Environment');
    const legacy = project.checks.find((check: { id: string }) => check.id === 'framework-legacy-state');

    expect(legacy).toMatchObject({ severity: 'warn', state: 'not-observable' });
    expect(legacy.detail).toContain('does not prove');
    expect(project.checks.some((check: { id: string }) => check.id === 'selected-agents')).toBe(false);
    expect(environment.checks.some((check: { id: string }) => check.id === 'github-copilot')).toBe(false);
    expect(environment.checks.some((check: { id: string }) => check.id === 'openspec')).toBe(false);
    expect(await readFile(manifestPath, 'utf8')).toBe(before);
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

  it('distinguishes a stale configured mirror from canonical freshness', async () => {
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'liftoff-doctor-stale-mirror-'));
    cleanups.push(elsewhere);
    const result = await run(
      ['doctor'],
      elsewhere,
      new ReadyInitRunner(),
      {
        stableReleaseLookup: async () => ({
          name: '@msn-control/liftoff',
          version: '99.0.0'
        }),
        configuredRegistryTargetLookup: async () => ({ status: 'stale' })
      }
    );
    expect(result.out).toContain(
      'configured npm registry does not expose it'
    );
    expect(result.out).toContain('managed registry owner');
    expect(result.out).toContain('liftoff upgrade --check');
    expect(result.out).not.toContain('npm install --global');
  });

  it('fails with a remedy when .env is missing and passes once created', async () => {
    const root = await fixtureProject();

    const missing = await run(['doctor'], root);
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(/\[error\]\s+\.env: missing - copy \.env\.example to \.env/);

    await writeFile(path.join(root, '.env'), (await readFile(path.join(root, '.env.example'), 'utf8')), 'utf8');
    const present = await run(['doctor'], root);
    expect(present.out).toMatch(/\[ok\]\s+\.env: present/);
  }, 30_000);

  it('surfaces managed-core maintenance as a single warning with the update remedy', async () => {
    const root = await fixtureProject();
    const configPath = path.join(root, 'liftoff.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.environments = ['dev', 'test'];
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await run(['doctor'], root);
    expect(result.out).toMatch(
      /\[warn\]\s+managed core: \d+ core maintenance action\(s\) available - run liftoff update/
    );
  }, 30_000);

  it('does not report project template edits as managed-core drift', async () => {
    const root = await fixtureProject();
    await writeFile(
      path.join(root, 'backend', 'apis', 'main.py'),
      '# production application\n'
    );
    await rm(path.join(root, 'infrastructure', 'opentofu', 'azure', 'main.tf'));

    const result = await run(['doctor', '--json'], root);
    const report = JSON.parse(result.out);
    const project = report.layers.find(
      (layer: { title: string }) => layer.title === 'Project'
    );
    expect(project.checks.find((check: { label: string }) =>
      check.label === 'managed core'
    )).toMatchObject({
      severity: 'ok',
      detail: 'Liftoff core is current; project templates are not compared'
    });
  }, 30_000);

  it('keeps CLI upgrade and project update remedies distinct', async () => {
    const root = await fixtureProject();
    const configPath = path.join(root, 'liftoff.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.environments = ['dev', 'test'];
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await run(
      ['doctor'],
      root,
      new ReadyInitRunner(),
      {
        stableReleaseLookup: async () => ({
          name: '@msn-control/liftoff',
          version: '99.0.0'
        }),
        configuredRegistryTargetLookup: async () => ({
          status: 'available',
          registryKind: 'canonical'
        })
      }
    );
    expect(result.out).toMatch(
      /cli freshness:.*liftoff upgrade --check.*liftoff upgrade/
    );
    expect(result.out).toMatch(
      /managed core: \d+ core maintenance action\(s\) available - run liftoff update/
    );
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
