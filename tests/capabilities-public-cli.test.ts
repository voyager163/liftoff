import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliTelemetryHooks } from '../src/cli.js';
import { parseArgs } from '../src/args.js';
import { validatePublicCapabilitiesEnvelope } from '../src/protocol/capabilities.js';
import { commandDefinitions } from '../src/domain/execution/command-definitions.js';
import { CaptureStream } from './helpers.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('public capability discovery', () => {
  it('does not promote implementation presence into uncompleted native-host qualification', async () => {
    const { buildPublicCapabilitiesEnvelope } = await import('../src/application/engine-composition.js');
    const capabilities = buildPublicCapabilitiesEnvelope().capabilities;
    for (const capability of capabilities) {
      expect(capability.supportedPlatforms).toEqual(['darwin', 'win32', 'linux']);
      expect(capability.qualificationState).not.toBe('qualified');
      if (capability.executor === 'built-in') expect(capability.qualificationState).toBe('unqualified');
    }
  });

  it('declares real separate authorization flags and current generation identity', async () => {
    const { resolveCapability } = await import('../src/application/engine-composition.js');
    const commands = [
      ['project-generation', 'init'], ['project-migration', 'migrate'],
      ['project-update', 'update'], ['project-repair', 'repair'], ['project-adoption', 'adopt']
    ];
    for (const [id, command] of commands) {
      const capability = resolveCapability(id!);
      expect(capability?.authorization.consentRequirements?.length).toBeGreaterThan(0);
      for (const flag of capability!.authorization.automationFlags ?? []) {
        expect(commandDefinitions[command!]?.flags[flag.slice(2)]).toBeDefined();
      }
    }
    expect(resolveCapability('project-generation')?.compatibilityIdentities).toEqual(['manifest-v8']);
    expect(resolveCapability('project-repair')?.authorization.automationFlags).toEqual(expect.arrayContaining([
      '--verify-plan', '--approve-plan', '--allow-dependency-preparation', '--allow-network', '--live'
    ]));
  });

  it('uses one evolution registry for both the public composition and ownership module', async () => {
    const [barrel, declared, composition] = await Promise.all([
      import('../src/application/project-evolution/index.js'),
      import('../src/application/project-evolution/capabilities.js'),
      import('../src/application/engine-composition.js')
    ]);
    expect(barrel.projectEvolutionCapabilities).toBe(declared.projectEvolutionCapabilities);
    const adoption = composition.resolveCapability('project-adoption');
    expect(adoption).toBe(declared.projectEvolutionCapabilities.find((entry) => entry.id === 'project-adoption'));
    expect(adoption?.commandSchema).toMatchObject({ resultSchemaVersion: 1, reportContract: 'adoption-report-v1' });
    expect(adoption?.authorization.automationFlags).toEqual(expect.arrayContaining([
      '--check', '--verify-plan', '--approve-plan', '--allow-dependency-preparation', '--allow-network', '--recover'
    ]));
    expect(composition.resolveCapability('project-migration')?.supportedProfiles).not.toContain('vue-component');
  });

  it('emits the installed six-engine contract without a project, notice, or writes', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'liftoff capabilities '));
    roots.push(cwd);
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    const hooks: CliTelemetryHooks = {
      beforeCommand: vi.fn<CliTelemetryHooks['beforeCommand']>().mockResolvedValue(true),
      afterCommand: vi.fn<CliTelemetryHooks['afterCommand']>().mockResolvedValue(undefined)
    };
    const code = await runCli({ argv: ['capabilities', '--json'], cwd, stdout, stderr, telemetry: hooks });
    expect(code, stderr.text() || stdout.text()).toBe(0);
    const result = validatePublicCapabilitiesEnvelope(JSON.parse(stdout.text()));
    expect(result.schemaVersion).toBe(1);
    expect(result.engines).toHaveLength(6);
    expect(new Set(result.engines.map((engine) => engine.id)).size).toBe(6);
    expect(result.engines.map((engine) => engine.id)).not.toContain('execution');
    expect(new Set(result.capabilities.map((capability) => capability.id)).size).toBe(result.capabilities.length);
    expect(result.capabilities.find((capability) => capability.id === 'project-repair')?.commandSchema)
      .toMatchObject({ resultSchemaVersion: 2, contractVersion: 1 });
    expect(result.capabilities.find((capability) => capability.id === 'project-update')?.commandSchema.resultSchemaVersion)
      .toBe(3);
    expect(await readdir(cwd)).toEqual([]);
    expect(hooks.beforeCommand).not.toHaveBeenCalled();
    expect(hooks.afterCommand).not.toHaveBeenCalled();
  });

  it.each(['--project', '--inputs', '--scope', '--execute', '--yes', '--approve-plan', '--schema'])(
    'rejects unrelated negotiation option %s before discovery',
    (flag) => {
      expect(() => parseArgs(['capabilities', flag])).toThrow(/Unknown flag/);
    }
  );
});
