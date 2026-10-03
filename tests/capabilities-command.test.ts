import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliTelemetryHooks } from '../src/cli.js';
import { parseArgs } from '../src/cli/args/parser.js';
import { commandDefinitions } from '../src/cli/args/definitions.js';
import { getGeneralHelp } from '../src/cli/args/help.js';
import { installedCapabilities } from '../src/application/capabilities.js';
import { repairCapabilities } from '../src/application/repair/capabilities.js';
import * as pluginApplication from '../src/application/project/plugins.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { phaseCapabilities } from '../src/domain/governance/activation/capabilities.js';
import { SUPPORTED_MANIFEST_VERSIONS } from '../src/domain/project/manifest/reader.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { buildArtifacts } from '../src/templates.js';
import { updateReportSchemaVersion } from '../src/application/update/output.js';
import { minimumNodeVersion } from '../src/runtime.js';
import { liftoffVersion } from '../src/version.js';
import * as telemetryConfig from '../src/telemetry/config.js';
import { canonicalTelemetryCommand, isTelemetryExcludedCommand } from '../src/telemetry/contract.js';
import { CaptureStream } from './helpers.js';

afterEach(() => { vi.restoreAllMocks(); });

async function invoke(argv: string[], options: { env?: NodeJS.ProcessEnv; telemetry?: CliTelemetryHooks } = {}) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const code = await runCli({
    argv, stdout, stderr, env: options.env ?? {}, telemetry: options.telemetry,
    cwd: path.join(process.cwd(), 'package.json', 'not-a-directory')
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe('project-independent capability discovery', () => {
  it('runs the actual public JSON route without a usable project directory', async () => {
    const result = await invoke(['capabilities', '--json']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ schemaVersion: 1, kind: 'liftoff-capabilities', cliVersion: liftoffVersion, projectIndependent: true });
    expect(Object.keys(report).sort()).toEqual([
      'agents', 'boundaries', 'cliVersion', 'commands', 'globalOptions', 'governance', 'kind', 'plugins', 'profiles',
      'projectIndependent', 'repair', 'runtime', 'schemaVersion', 'schemas', 'workflows'
    ]);
    expect(report.commands).toEqual(Object.entries(commandDefinitions).map(([name, definition]) => ({
      name, subcommands: [...definition.subcommands ?? []],
      defaultMaxPositionals: definition.defaultMaxPositionals,
      subcommandMaxPositionals: { ...definition.subcommandMaxPositionals },
      flags: Object.entries(definition.flags).map(([name, flag]) => ({
        name, kind: flag.kind, negatable: flag.negatable === true
      }))
    })));
    expect(report.globalOptions).toEqual(getGeneralHelp(liftoffVersion).globalOptions);
    expect(report.globalOptions.map(({ syntax }: { syntax: string }) => syntax)).toContain('--version');
    expect(result.stdout).not.toContain(process.cwd());
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(128 * 1024);
  });

  it('derives the current release inventory rather than advertising private modern contracts', () => {
    const report = installedCapabilities(), registry = pluginApplication.builtinPluginRegistry();
    expect(report.plugins.registryDigest).toBe(registry.registryDigest);
    expect(report.plugins.pluginSetDigest).toBe(registry.pluginSetDigest);
    expect(report.plugins.inventory.map(({ id }) => id)).toEqual(registry.inventory.map(({ id }) => id));
    expect(report.workflows.map(({ id }) => id)).toEqual(projectCatalog.specWorkflows.map(({ id }) => id));
    expect(report.workflows.map(({ id }) => id)).toEqual(['openspec', 'spec-kit']);
    expect(report.profiles.map(({ id }) => id)).toEqual(['single-maintainer-gitflow', 'none']);
    expect(report.agents.map(({ id }) => id)).toEqual(projectCatalog.codingAgents.map(({ id }) => id));
    expect(report.schemas.manifestRead).toEqual(SUPPORTED_MANIFEST_VERSIONS);
    const plan = buildProjectPlan({
      projectName: 'Capability schema specimen', projectType: 'standard', apiStack: 'node',
      agents: ['copilot'], environments: ['dev']
    }, { requireProjectName: true });
    const manifest = buildArtifacts(plan).find(({ logicalName }) => logicalName === 'manifest');
    if (!manifest) throw new Error('Expected actual generated manifest.');
    expect(report.schemas.manifestWrite).toBe(JSON.parse(manifest.content).artifactVersion);
    expect(report.schemas.reports.update).toBe(updateReportSchemaVersion);
    expect(report.schemas.repair).toEqual(repairCapabilities.schemas);
    expect(report.runtime).toMatchObject({ minimumNodeVersion, distribution: 'node/npm', nativeDistribution: false });
    expect(report.boundaries).toMatchObject({
      thirdPartyPluginLoading: false, publicStatefulMigration: false,
      projectTelemetryEnrollment: false, capabilityIsApproval: false
    });
  });

  it('retains unavailable/injected-only/blocker distinctions instead of treating registration as execution support', () => {
    const report = installedCapabilities();
    for (const [phase, capability] of Object.entries(phaseCapabilities)) {
      expect(report.governance.phases.find((row) => row.phase === phase)).toEqual({
        phase, ...capability,
        productionExecutorAvailable: capability.executor === 'built-in' && capability.blocker === undefined
      });
    }
    for (const phase of ['credential-ready', 'provider-ready', 'rulesets-applied', 'live-readback']) {
      expect(report.governance.phases.find((row) => row.phase === phase)?.productionExecutorAvailable).toBe(false);
    }
    expect(report.runtime.hostSupport).toContain('not installed tools or native-package qualification');
    expect(report.boundaries.registration).toContain('executor is available');
  });

  it('preserves the existing repair capability route and independent returned records', async () => {
    const result = await invoke(['repair', '--capabilities', '--json']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(repairCapabilities);
    const report = installedCapabilities();
    expect(report.repair).toEqual(repairCapabilities);
    Reflect.set(report.repair.modes, 0, 'not-a-real-mode');
    report.schemas.manifestRead.length = 0;
    expect(installedCapabilities().repair).toEqual(repairCapabilities);
    expect(installedCapabilities().schemas.manifestRead).toEqual(SUPPORTED_MANIFEST_VERSIONS);
  });

  it.each([
    ['capabilities'], ['capabilities', '--json'], ['capabilities', '--json=false'],
    ['capabilities', '--help'], ['capabilities', '--help', '--json'], ['help', 'capabilities']
  ])('skips all custom telemetry hooks for %j', async (...argv) => {
    const hooks: CliTelemetryHooks = {
      beforeCommand: vi.fn().mockResolvedValue(true),
      afterCommand: vi.fn().mockResolvedValue(undefined),
      afterSemanticCommand: vi.fn().mockResolvedValue(undefined)
    };
    const result = await invoke(argv, { telemetry: hooks });
    expect(result.code).toBe(0);
    expect(hooks.beforeCommand).not.toHaveBeenCalled();
    expect(hooks.afterCommand).not.toHaveBeenCalled();
    expect(hooks.afterSemanticCommand).not.toHaveBeenCalled();
    expect(isTelemetryExcludedCommand(parseArgs(argv))).toBe(true);
    expect(canonicalTelemetryCommand(parseArgs(argv))).toBeUndefined();
  });

  it.each([
    {}, { LIFTOFF_TELEMETRY: '0' }, { DO_NOT_TRACK: '1' }, { CI: 'true' }
  ])('never reads or writes disclosure or uses transport with environment %j', async (env) => {
    const read = vi.spyOn(telemetryConfig, 'readTelemetryNoticeVersion').mockRejectedValue(new Error('Unexpected disclosure read'));
    const write = vi.spyOn(telemetryConfig, 'recordTelemetryNotice').mockRejectedValue(new Error('Unexpected disclosure write'));
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
    for (const argv of [['capabilities', '--json'], ['capabilities', '--help'], ['help', 'capabilities']]) {
      expect((await invoke(argv, { env })).code).toBe(0);
    }
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not resolve even installed plugin assets for help', async () => {
    const registry = vi.spyOn(pluginApplication, 'builtinPluginRegistry').mockImplementation(() => {
      throw new Error('Unexpected registry read');
    });
    for (const argv of [['capabilities', '--help'], ['help', 'capabilities']]) {
      const result = await invoke(argv);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('liftoff capabilities');
      expect(result.stderr).toBe('');
    }
    expect(registry).not.toHaveBeenCalled();
  });

  it('surfaces an invalid installed bundle instead of returning success-shaped metadata', async () => {
    vi.spyOn(pluginApplication, 'builtinPluginRegistry').mockImplementation(() => {
      throw new Error('Installed bundle failed verification');
    });
    const result = await invoke(['capabilities', '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('"kind": "liftoff-capabilities"');
    expect(result.stderr).toContain('Installed bundle failed verification');
  });

  it.each([
    ['capabilities', 'some-project'], ['capabilities', '--project', '.'],
    ['capabilities', '--live'], ['capabilities', '--yes'], ['capabilities', '--json=maybe'],
    ['capabilities', '--json', '--json']
  ])('rejects unsupported authority and output syntax %j before telemetry', async (...argv) => {
    const hooks: CliTelemetryHooks = {
      beforeCommand: vi.fn().mockResolvedValue(true), afterCommand: vi.fn().mockResolvedValue(undefined)
    };
    const result = await invoke(argv, { telemetry: hooks });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
    expect(hooks.beforeCommand).not.toHaveBeenCalled();
    expect(hooks.afterCommand).not.toHaveBeenCalled();
  });

  it('prints actual limits in the human-readable route and documents the public syntax', async () => {
    const result = await invoke(['capabilities']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Manifest readers');
    expect(result.stdout).toContain('2, 3, 4, 5, 6, 7');
    expect(result.stdout).toContain('not approval');
    for (const file of ['README.md', path.join('docs', 'cli-reference.md'), path.join('docs', 'telemetry.md')]) {
      expect(readFileSync(file, 'utf8')).toContain('liftoff capabilities');
    }
    const reference = readFileSync(path.join('docs', 'cli-reference.md'), 'utf8');
    expect(reference).toContain('schema-1');
    expect(reference).toContain('injected-only');
    expect(reference).toContain('liftoff help capabilities');
    expect(reference).toContain('internal Manual/team/v8 APIs are deliberately not promoted');
  });
});
