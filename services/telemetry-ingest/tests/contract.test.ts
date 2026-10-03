import { describe, expect, it } from 'vitest';
import {
  canonicalTelemetryCommand,
  createTelemetryEvent,
  createTelemetryStorageRecord,
  isTelemetryCliVersion,
  isTelemetryCommand,
  isTelemetryExcludedCommand,
  telemetryClientFields,
  telemetryCommands,
  telemetryEventName,
  telemetryExcludedCommands,
  telemetrySchemaVersion,
  telemetryStorageFields
} from '../../../src/telemetry/contract.js';
import { handleTelemetryRequest, parseTelemetryEvent } from '../src/handler.js';
import { fixedNow, recordingDependencies, streamedRequest } from './support/fixtures.js';

// The gateway compiles this shared module, so its suite pins the whole client/gateway contract.
describe('shared client and gateway telemetry contract', () => {
  it('accepts every schema-1 aggregate event the CLI contract can create', async () => {
    const exitOutcomes = [[0, 'success'], [1, 'failure'], [2, 'failure']] as const;
    for (const command of telemetryCommands) {
      for (const [exitCode, outcome] of exitOutcomes) {
        const event = createTelemetryEvent(command, '0.12.3', exitCode);
        expect(event).toEqual({
          schemaVersion: telemetrySchemaVersion,
          event: telemetryEventName,
          command,
          cliVersion: '0.12.3',
          outcome
        });
        expect(Object.keys(event)).toEqual([...telemetryClientFields]);

        const deps = recordingDependencies();
        expect(await handleTelemetryRequest(streamedRequest([JSON.stringify(event)]), deps))
          .toEqual({ status: 204 });
        expect(deps.upload).toHaveBeenCalledWith(createTelemetryStorageRecord(event, fixedNow));
      }
    }
  });

  it('stores exactly the approved six columns in order', () => {
    const record = createTelemetryStorageRecord(createTelemetryEvent('upgrade', '1.0.0-rc.1', 0), fixedNow);
    expect(Object.keys(record)).toEqual([...telemetryStorageFields]);
    expect(record).toEqual({
      TimeGenerated: '2026-07-26T00:00:00.000Z',
      EventName: 'command_executed',
      SchemaVersion: 1,
      Command: 'upgrade',
      CliVersion: '1.0.0-rc.1',
      Outcome: 'success'
    });
  });

  it('maps every help request form to the help command', () => {
    expect(canonicalTelemetryCommand({ flags: {} })).toBe('help');
    expect(canonicalTelemetryCommand({ command: 'help', flags: {} })).toBe('help');
    expect(canonicalTelemetryCommand({ command: '--help', flags: {} })).toBe('help');
    expect(canonicalTelemetryCommand({ command: 'infra', subcommand: 'plan', flags: { help: true } }))
      .toBe('help');
  });

  it('names nested commands with an explicit command:subcommand identity', () => {
    expect(canonicalTelemetryCommand({ command: 'infra', subcommand: 'plan', flags: {} })).toBe('infra:plan');
    expect(canonicalTelemetryCommand({ command: 'governance', subcommand: 'verify', flags: {} }))
      .toBe('governance:verify');
    expect(canonicalTelemetryCommand({ command: 'upgrade', flags: { check: true } })).toBe('upgrade');
  });

  it('never names unknown or project-derived commands', () => {
    for (const input of [
      { command: '/private/project', flags: {} },
      { command: 'infra', subcommand: '/private/project', flags: {} },
      { command: 'init', subcommand: 'my-app', flags: {} },
      { command: 'governance', subcommand: 'unknown', flags: {} }
    ]) {
      expect(canonicalTelemetryCommand(input)).toBeUndefined();
    }
  });

  it('excludes assessment and repair discovery even when help is requested', () => {
    expect(isTelemetryExcludedCommand({ command: 'governance', subcommand: 'assess', flags: {} })).toBe(true);
    expect(canonicalTelemetryCommand({ command: 'governance', subcommand: 'assess', flags: { help: true } }))
      .toBeUndefined();
    for (const flag of ['capabilities', 'inspect-layout']) {
      expect(isTelemetryExcludedCommand({ command: 'repair', flags: { [flag]: true } })).toBe(true);
      expect(canonicalTelemetryCommand({ command: 'repair', flags: { [flag]: true } })).toBeUndefined();
    }
    expect(isTelemetryExcludedCommand({ command: 'repair', flags: { capabilities: 'true' } })).toBe(false);
    expect(canonicalTelemetryCommand({ command: 'repair', flags: {} })).toBe('repair');
    expect(isTelemetryExcludedCommand({ command: 'governance', flags: {} })).toBe(false);
    expect(isTelemetryExcludedCommand({ flags: {} })).toBe(false);
  });

  it('rejects excluded command identities at the gateway', async () => {
    const deps = recordingDependencies();
    for (const command of telemetryExcludedCommands) {
      const event = { ...createTelemetryEvent('help', '0.12.3', 0), command };
      expect(parseTelemetryEvent(event)).toBeUndefined();
      expect(await handleTelemetryRequest(streamedRequest([JSON.stringify(event)]), deps))
        .toEqual({ status: 400 });
    }
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it('keeps value predicates strict about type and release shape', () => {
    expect(isTelemetryCommand('infra:plan')).toBe(true);
    for (const value of [undefined, null, 1, ['help'], 'governance:assess', 'INFRA:PLAN']) {
      expect(isTelemetryCommand(value)).toBe(false);
    }
    for (const version of ['0.12.3', '1.0.0-alpha', '1.0.0-beta.2', '10.20.30-rc.0']) {
      expect(isTelemetryCliVersion(version)).toBe(true);
    }
    for (const version of [undefined, 12, '01.2.3', '1.2', '1.2.3-preview', '1.2.3-rc.01', '1.2.3+build', 'v1.2.3']) {
      expect(isTelemetryCliVersion(version)).toBe(false);
    }
  });
});
