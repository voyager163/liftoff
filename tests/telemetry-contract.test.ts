import { describe, expect, it } from 'vitest';
import { commandDefinitions } from '../src/args.js';
import {
  canonicalTelemetryCommand,
  createTelemetryEvent,
  createTelemetryStorageRecord,
  isSemanticVersion,
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
  });

  it('accepts semantic versions and rejects identifying free-form values', () => {
    expect(isSemanticVersion('0.6.1')).toBe(true);
    expect(isSemanticVersion('1.2.3-beta.1+build.5')).toBe(true);
    expect(isSemanticVersion('1.2.3-0')).toBe(true);
    expect(isSemanticVersion('1.2.3+build.01')).toBe(true);
    expect(isSemanticVersion('1.2.3-01')).toBe(false);
    expect(isSemanticVersion('01.2.3')).toBe(false);
    expect(isSemanticVersion('v1.2.3')).toBe(false);
    expect(isSemanticVersion('/private/project')).toBe(false);
  });
});
