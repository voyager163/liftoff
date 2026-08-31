import { describe, expect, it } from 'vitest';
import { commandDefinitions } from '../src/args.js';
import {
  canonicalTelemetryCommand,
  createTelemetryEvent,
  createTelemetryStorageRecord,
  isTelemetryCliVersion,
  telemetryClientFields,
  telemetryCommands,
  telemetryStorageFields
} from '../src/telemetry/contract.js';

describe('telemetry contract', () => {
  it('stays in parity with every explicit CLI command and subcommand', () => {
    const expected = new Set<string>(['version']);
    for (const [command, definition] of Object.entries(commandDefinitions)) {
      expected.add(command);
      for (const subcommand of definition.subcommands ?? []) {
        expected.add(`${command}:${subcommand}`);
      }
    }
    expect([...telemetryCommands].sort()).toEqual([...expected].sort());
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

  it('normalizes help and nested command paths without arguments', () => {
    expect(canonicalTelemetryCommand({ flags: {} })).toBe('help');
    expect(canonicalTelemetryCommand({ command: 'init', flags: { help: true } })).toBe('help');
    expect(canonicalTelemetryCommand({ command: 'infra', subcommand: 'plan', flags: {} })).toBe('infra:plan');
    expect(canonicalTelemetryCommand({ command: 'upgrade', flags: {} })).toBe('upgrade');
    expect(canonicalTelemetryCommand({ command: 'upgrade', flags: { check: true } })).toBe('upgrade');
    expect(canonicalTelemetryCommand({ command: 'unknown', flags: {} })).toBeUndefined();
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
