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
import * as modernPlugins from '../src/application/project/modern-plugins.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { phaseCapabilities } from '../src/domain/governance/activation/capabilities.js';
import { SUPPORTED_MANIFEST_VERSIONS } from '../src/domain/project/manifest/reader.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { buildCurrentArtifacts } from '../src/templates.js';
import { currentUpdateReportSchemaVersion } from '../src/application/update/current-request.js';
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

  it('derives the exact current generation inventory without advertising unsupported transitions', () => {
    const report = installedCapabilities(), registry = modernPlugins.modernSourceRegistry();
    expect(report.plugins.registryDigest).toBe(registry.registryDigest);
    expect(report.plugins.pluginSetDigest).toBe(registry.pluginSetDigest);
    expect(report.plugins.inventory.map(({ id }) => id)).toEqual(registry.inventory.map(({ id }) => id));
    expect(report.workflows.map(({ id }) => id)).toEqual(projectCatalog.developmentWorkflows.map(({ id }) => id));
    expect(report.workflows.map(({ id }) => id)).toEqual(['openspec', 'spec-kit', 'manual']);
    expect(report.profiles.map(({ id }) => id)).toEqual(['single-maintainer-gitflow', 'none']);
    expect(report.agents.map(({ id }) => id)).toEqual(projectCatalog.codingAgents.map(({ id }) => id));
    expect(report.schemas.manifestRead).toEqual([...SUPPORTED_MANIFEST_VERSIONS, 8]);
    expect(report.schemas.currentGeneration).toMatchObject({
      manifestWrite: 8, commands: ['plan', 'init', 'migrate'],
      workflows: ['openspec', 'spec-kit', 'manual'], defaultWorkflow: 'openspec', manualAgentsOptional: true
    });
    expect(report.schemas.modernReadOnly).toMatchObject({
      manifestRead: [8], governanceReport: 3, execution: false,
      commands: ['validate', 'doctor', 'dev', 'infra', 'governance status', 'governance resume', 'governance verify']
    });
    expect(report.schemas.modernLocalVerification).toMatchObject({
      manifestRead: [8], report: 7, selector: 'governance <plan|approve|apply-next> --scope local --local-operation verify',
      requests: ['verify-local', 'verify-manual-native', 'verify-openspec-local', 'verify-openspec-initialized', 'verify-openspec-archived'],
      explicitRequest: true, separateConsent: true, explicitExecution: true,
      workflowFinalization: false, publication: false, successorRevalidation: false,
      nativeManual: {
        consent: 'approve-manual-native', previewSchema: 6, consentSchema: 5, resultSchema: 5,
        requiredScopes: ['infrastructurePreparation', 'infrastructureNetwork'],
        platform: 'darwin', architecture: 'arm64', tofuVersion: '1.12.6',
        providerSource: 'registry.opentofu.org/hashicorp/azurerm', providerVersion: '5.3.0'
      }
    });
    expect(report.schemas.modernLocalCompletion).toMatchObject({
      manifestRead: [8], report: 5,
      selectors: {
        finalize: 'governance <plan|approve|apply-next> --scope local --local-operation finalize',
        publish: 'governance <plan|approve|apply-next|recover> --scope local --local-operation publish'
      },
      workflows: ['manual', 'spec-kit'], profiles: ['none', 'single-maintainer-gitflow', 'team-gitflow'],
      requests: ['finalize-local', 'review-local-publication'], separateFinalizationConsent: true,
      artifactSchemas: [1, 2, 3], protectedIndexArtifact: {
        schemaVersion: 3, encoding: 'deflate-raw', maximumRecordBytes: 65536, maximumDecodedBytes: 65536
      },
      separatePublicationConsent: true, explicitExecution: true, attributedRecovery: true,
      openSpecFinalization: false, successorRevalidation: false, providerOperations: false
    });
    expect(report.schemas.modernSuccessorRevalidation).toMatchObject({
      manifestRead: [8], report: 6,
      selector: 'governance <plan|approve|apply-next|recover> --scope local --local-operation revalidate-successor',
      requests: ['revalidate-successor', 'review-successor-revalidation'],
      separatePublicationConsent: true, explicitExecution: true, attributedRecovery: true,
      committedIncompleteExit: 2, successorCreation: false, workflowFinalization: false, providerOperations: false
    });
    const plan = buildCurrentProjectPlan({
      projectName: 'Capability schema specimen', projectType: 'standard', apiStack: 'node',
      agents: ['copilot'], environments: ['dev']
    }, { requireProjectName: true });
    const manifest = buildCurrentArtifacts(plan).find(({ logicalName }) => logicalName === 'manifest');
    if (!manifest) throw new Error('Expected actual generated manifest.');
    expect(report.schemas.manifestWrite).toBe(JSON.parse(manifest.content).artifactVersion);
    expect(report.schemas.reports.update).toBe(currentUpdateReportSchemaVersion);
    expect(report.schemas.currentUpdate).toMatchObject({
      manifestRead: [...SUPPORTED_MANIFEST_VERSIONS, 8], manifestWrite: 8, report: 4,
      separateConsent: true, explicitRecovery: true, configurationBound: true,
      applicationWrites: false, workflowChanges: false, profileChanges: false, providerOperations: false
    });
    expect(report.schemas.projectAdoption).toMatchObject({
      command: 'adopt', report: 1, previewAvailable: true, executablePlanAvailable: true,
      separateVerificationPermission: true, separateFileApproval: true,
      activeBindingPublication: false, providerOperations: false
    });
    expect(report.schemas.reports.projectAdoption).toBe(1);
    expect(report.schemas.repair).toEqual(repairCapabilities.schemas);
    expect(report.runtime).toMatchObject({ minimumNodeVersion, distribution: 'node/npm', nativeDistribution: false });
    expect(report.boundaries).toMatchObject({
      thirdPartyPluginLoading: false, publicStatefulMigration: false,
      projectTelemetryEnrollment: false, capabilityIsApproval: false
    });
    expect(report.boundaries.privateApis).toContain('Historical successor creation is limited to the separately advertised currentUpdate scope');
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
    expect(installedCapabilities().schemas.manifestRead).toEqual([...SUPPORTED_MANIFEST_VERSIONS, 8]);
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
    const modern = vi.spyOn(modernPlugins, 'modernSourceRegistry').mockImplementation(() => {
      throw new Error('Unexpected current registry read');
    });
    for (const argv of [['capabilities', '--help'], ['help', 'capabilities']]) {
      const result = await invoke(argv);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('liftoff capabilities');
      expect(result.stderr).toBe('');
    }
    expect(registry).not.toHaveBeenCalled();
    expect(modern).not.toHaveBeenCalled();
  });

  it('surfaces an invalid installed bundle instead of returning success-shaped metadata', async () => {
    vi.spyOn(modernPlugins, 'modernSourceRegistry').mockImplementation(() => {
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
    expect(result.stdout).toContain('Modern v8 read-only');
    expect(result.stdout).toContain('Modern v8 verification');
    expect(result.stdout).toContain('--local-operation verify');
    expect(result.stdout).toContain('--local-operation finalize');
    expect(result.stdout).toContain('--local-operation publish');
    expect(result.stdout).toContain('--local-operation revalidate-successor');
    expect(result.stdout).toContain('governance verify');
    expect(result.stdout).toContain('not approval');
    for (const file of ['README.md', path.join('docs', 'cli-reference.md'), path.join('docs', 'telemetry.md')]) {
      expect(readFileSync(file, 'utf8')).toContain('liftoff capabilities');
    }
    const reference = readFileSync(path.join('docs', 'cli-reference.md'), 'utf8');
    expect(reference).toContain('schema-1');
    expect(reference).toContain('injected-only');
    expect(reference).toContain('liftoff help capabilities');
    expect(reference).toContain('schemas.modernReadOnly');
    expect(reference).toContain('schemas.modernLocalCompletion');
    expect(reference).toContain('schemas.modernSuccessorRevalidation');
    expect(reference).toContain('does not enable Manual/team generation');
  });
});
