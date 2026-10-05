import { describe, expect, it } from 'vitest';
import { commandDefinitions } from '../src/args.js';
import {
  canonicalTelemetryCommand,
  createProjectTelemetryStorageRecord,
  createSemanticTelemetryEvent,
  createTelemetryEvent,
  createTelemetryStorageRecord,
  isTelemetryCliVersion,
  isProjectTelemetryDigest,
  isProjectTelemetryId,
  isTelemetrySemanticOutcome,
  parseProjectTelemetryPolicy,
  projectTelemetryClientFields,
  projectTelemetryStorageFields,
  telemetryClientFields,
  telemetryCommands,
  telemetryExcludedCommands,
  telemetryStorageFields
} from '../src/telemetry/contract.js';

describe('telemetry contract', () => {
  it.each([
    ['update', '0.12.3', 'partial'], ['update', '0.12.3', 'failure: private detail'],
    ['update', '0.12.3', 2], ['update', '0.12.3', null], ['update', '0.12.3', ['success']],
    ['update', '0.12.3', {outcome:'success',projectId:'private'}],
    [undefined, '0.12.3', 'success'], ['governance:assess', '0.12.3', 'success'],
    ['update', '0.12.3+private', 'success'], [['update'], '0.12.3', 'success'],
    ['update', ['0.12.3'], 'success']
  ])('rejects malformed schema2 constructor inputs %j %j %j', (command, version, outcome) => {
    expect(() => Reflect.apply(createSemanticTelemetryEvent, undefined, [command, version, outcome])).toThrow(TypeError);
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
    expect(telemetryExcludedCommands).toEqual(['governance:assess', 'capabilities', 'assess']);
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
    expect(isTelemetryCliVersion('0.12.3\n')).toBe(false);
    expect(isTelemetryCliVersion(`${'1'.repeat(65)}.0.0`)).toBe(false);
  });

  it('keeps explicit semantic attention, cancellation and partial failure separate from legacy exit codes', () => {
    for (const outcome of ['success', 'attention-required', 'cancelled', 'failure'] as const) {
      const event = createSemanticTelemetryEvent('update', '0.12.3', outcome);
      expect(event).toEqual({
        schemaVersion: 2, event: 'command_executed', command: 'update', cliVersion: '0.12.3', outcome
      });
      expect(isTelemetrySemanticOutcome(outcome)).toBe(true);
      expect(createTelemetryStorageRecord(event, new Date('2026-09-30T00:00:00Z')))
        .toMatchObject({ SchemaVersion: 2, Outcome: outcome });
    }
    for (const value of [2, undefined, 'partial', 'failure: private detail']) {
      expect(isTelemetrySemanticOutcome(value)).toBe(false);
    }
    expect(createTelemetryEvent('update', '0.12.3', 2)).toMatchObject({ schemaVersion: 1, outcome: 'failure' });
  });

  it('uses strict pseudonymous dimensions, not raw project or user data', () => {
    const projectId = '550e8400-e29b-41d4-a716-446655440000';
    const templateSetDigest = `sha256:${'a'.repeat(64)}`;
    expect(isProjectTelemetryId(projectId)).toBe(true);
    expect(isProjectTelemetryDigest(templateSetDigest)).toBe(true);
    for (const value of [undefined, '/private/project', `${projectId}\n`]) {
      expect(isProjectTelemetryId(value)).toBe(false);
    }
    for (const value of [null, 'private-project', `${templateSetDigest}\n`]) {
      expect(isProjectTelemetryDigest(value)).toBe(false);
    }
    for (const [profile, version] of [
      ['none', 'none'], ['single-maintainer-gitflow', 6], ['single-maintainer-gitflow', 7], ['team-gitflow', 1]
    ]) {
      expect(parseProjectTelemetryPolicy(profile, version)).toEqual({ policyProfile: profile, policyVersion: version });
    }
    for (const [profile, version] of [['none', 1], ['team-gitflow', 7], ['single-maintainer-gitflow', '7'], ['custom', 1]]) {
      expect(parseProjectTelemetryPolicy(profile, version)).toBeUndefined();
    }
    const event = {
      schemaVersion: 2, event: 'project_observed', projectId, cliVersion: '0.12.3',
      policyProfile: 'none', policyVersion: 'none', templateSetDigest, source: 'ci-heartbeat'
    } as const;
    expect(Object.keys(event)).toEqual([...projectTelemetryClientFields]);
    const record = createProjectTelemetryStorageRecord(event, new Date('2026-09-30T00:00:00Z'));
    expect(Object.keys(record)).toEqual([...projectTelemetryStorageFields]);
    expect(record).toEqual({
      TimeGenerated: '2026-09-30T00:00:00.000Z', EventName: 'project_observed', SchemaVersion: 2,
      ProjectId: projectId, CliVersion: '0.12.3', PolicyProfile: 'none', PolicyVersion: 'none',
      TemplateSetDigest: templateSetDigest, Source: 'ci-heartbeat'
    });
  });
});
