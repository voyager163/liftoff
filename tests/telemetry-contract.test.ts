import { describe, expect, it } from 'vitest';
import { commandDefinitions } from '../src/args.js';
import releasedClient from '../services/telemetry-ingest/tests/fixtures/released-client-v0.12.3.json';
import {
  canonicalTelemetryCommand,
  canPersistTelemetryNotice,
  createTelemetryEvent,
  createTelemetryStorageRecord,
  isTelemetryCliVersion,
  telemetryClientFields,
  telemetryCommands,
  telemetryExcludedCommands,
  telemetryStorageFields
} from '../src/telemetry/contract.js';

describe('telemetry contract', () => {
  it('adds only the reviewed lifecycle commands to the immutable released allowlist', () => {
    expect(releasedClient.sourceCommit).toBe('70d10881b46d873118d825735696f39b6d35ebe0');
    expect(telemetryCommands.filter((command) => !releasedClient.commands.includes(command)).sort()).toEqual([
      'adopt',
      'installation:migrate',
      'skills:install',
      'skills:migrate',
      'skills:remove',
      'skills:update'
    ]);
    expect(releasedClient.commands.every((command) =>
      telemetryCommands.some((current) => current === command))).toBe(true);
  });

  it('covers explicit CLI commands except the exact read-only telemetry exclusions', () => {
    const expected = new Set<string>(['version']);
    for (const [command, definition] of Object.entries(commandDefinitions)) {
      expected.add(command);
      for (const subcommand of definition.subcommands ?? []) {
        expected.add(`${command}:${subcommand}`);
      }
    }
    expect([...telemetryCommands, ...telemetryExcludedCommands].sort()).toEqual([...expected].sort());
    expect(telemetryExcludedCommands).toEqual([
      'governance:assess', 'assess', 'capabilities', 'installation', 'installation:inspect',
      'skills', 'skills:list', 'skills:plan', 'skills:inspect'
    ]);
    expect(telemetryCommands.some((command) => telemetryExcludedCommands.some((excluded) => excluded === String(command)))).toBe(false);
  });

  it('defines the exact client and storage fields', () => {
    expect(telemetryClientFields).toEqual([
      'schemaVersion',
      'event',
      'command',
      'cliVersion',
      'outcome'
    ]);
    expect(telemetryStorageFields).toEqual([
      'TimeGenerated',
      'EventName',
      'SchemaVersion',
      'Command',
      'CliVersion',
      'Outcome'
    ]);
  });

  it.each([
    { flags: {} },
    ...['help', 'version', 'plan', 'patterns', 'providers', 'regions', 'validate', 'doctor', 'dev', 'infra']
      .map((command) => ({ command, flags: {} })),
    { command: 'upgrade', flags: { check: true } },
    { command: 'update', flags: { check: true } },
    { command: 'repair', flags: { check: true } },
    { command: 'init', flags: { help: true } },
    { command: 'governance', flags: {} },
    ...['status', 'plan', 'resume', 'verify', 'assess', 'apply-next']
      .map((subcommand) => ({ command: 'governance', subcommand, flags: {} })),
    { command: 'repair', flags: { capabilities: true } }
  ])('does not persist disclosure for read-only $command $subcommand', (input) => {
    expect(canPersistTelemetryNotice(input)).toBe(false);
  });

  it.each([
    { command: 'init', flags: {} },
    { command: 'update', flags: {} },
    { command: 'upgrade', flags: {} },
    { command: 'governance', subcommand: 'apply-next', flags: { execute: true } }
  ])('retains disclosure persistence for eligible $command $subcommand', (input) => {
    expect(canPersistTelemetryNotice(input)).toBe(true);
  });

  it('normalizes help and nested command paths without arguments', () => {
    expect(canonicalTelemetryCommand({ flags: {} })).toBe('help');
    expect(canonicalTelemetryCommand({ command: 'init', flags: { help: true } })).toBe('help');
    expect(canonicalTelemetryCommand({ command: 'infra', subcommand: 'plan', flags: {} })).toBe('infra:plan');
    expect(canonicalTelemetryCommand({ command: 'upgrade', flags: {} })).toBe('upgrade');
    expect(canonicalTelemetryCommand({ command: 'upgrade', flags: { check: true } })).toBe('upgrade');
    expect(canonicalTelemetryCommand({ command: 'unknown', flags: {} })).toBeUndefined();
    expect(canonicalTelemetryCommand({ command: 'governance', subcommand: 'assess', flags: {} })).toBeUndefined();
    expect(canonicalTelemetryCommand({ command: 'governance', subcommand: 'assess', flags: { help: true } })).toBeUndefined();
  });

  it.each([
    { command: 'installation', subcommand: 'inspect', flags: {} },
    { command: 'installation', subcommand: 'inspect', flags: { help: true } },
    { command: 'help', positional: ['installation'], flags: {} },
    { command: 'installation', subcommand: 'migrate', flags: { to: 'direct' } },
    { command: 'installation', subcommand: 'migrate', interactive: true, flags: { to: 'direct', json: true } },
    { command: 'installation', subcommand: 'migrate', interactive: true, flags: { to: 'direct', check: true } },
    { command: 'installation', subcommand: 'migrate', flags: { recover: true } }
  ])('excludes installation inspection and non-executing previews %j', (input) => {
    expect(canonicalTelemetryCommand(input)).toBeUndefined();
    expect(canPersistTelemetryNotice(input)).toBe(false);
  });

  it('records at most the outer approved migration, without making preview approval implicit', () => {
    expect(canonicalTelemetryCommand({
      command: 'installation', subcommand: 'migrate', interactive: true, flags: { to: 'direct' }
    })).toBe('installation:migrate');
    expect(canonicalTelemetryCommand({
      command: 'installation', subcommand: 'migrate',
      flags: { to: 'direct', 'approve-plan': 'a'.repeat(64), json: true }
    })).toBe('installation:migrate');
    expect(canonicalTelemetryCommand({
      command: 'installation', subcommand: 'migrate', flags: { to: 'direct', yes: true }
    })).toBeUndefined();
  });

  it('maps only exit status into the event and adds server time separately', () => {
    const event = createTelemetryEvent('validate', '1.2.3', 2);
    expect(event).toEqual({
      schemaVersion: 1,
      event: 'command_executed',
      command: 'validate',
      cliVersion: '1.2.3',
      outcome: 'failure'
    });
    expect(Object.keys(event)).toEqual(telemetryClientFields);

    const record = createTelemetryStorageRecord(event, new Date('2026-07-26T00:00:00.000Z'));
    expect(record).toEqual({
      TimeGenerated: '2026-07-26T00:00:00.000Z',
      EventName: 'command_executed',
      SchemaVersion: 1,
      Command: 'validate',
      CliVersion: '1.2.3',
      Outcome: 'failure'
    });
    expect(Object.keys(record)).toEqual(telemetryStorageFields);

    expect(createTelemetryEvent('upgrade', '0.7.0', 0)).toEqual({
      schemaVersion: 1,
      event: 'command_executed',
      command: 'upgrade',
      cliVersion: '0.7.0',
      outcome: 'success'
    });
    expect(createTelemetryEvent('upgrade', '0.7.0', 2)).toEqual({
      schemaVersion: 1,
      event: 'command_executed',
      command: 'upgrade',
      cliVersion: '0.7.0',
      outcome: 'failure'
    });
  });

  it('accepts bounded release versions and rejects identifier-bearing metadata', () => {
    expect(isTelemetryCliVersion('0.6.1')).toBe(true);
    expect(isTelemetryCliVersion('1.2.3-beta')).toBe(true);
    expect(isTelemetryCliVersion('1.2.3-beta.1')).toBe(true);
    expect(isTelemetryCliVersion('1.2.3-rc.0')).toBe(true);
    expect(isTelemetryCliVersion('1.2.3+build.01')).toBe(false);
    expect(isTelemetryCliVersion('1.2.3+install-550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(isTelemetryCliVersion('1.2.3-preview.private')).toBe(false);
    expect(isTelemetryCliVersion('1.2.3-01')).toBe(false);
    expect(isTelemetryCliVersion('01.2.3')).toBe(false);
    expect(isTelemetryCliVersion('v1.2.3')).toBe(false);
    expect(isTelemetryCliVersion('/private/project')).toBe(false);
  });
});
