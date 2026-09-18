import { beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import {
  validatePublicCapability,
  validatePublicCapabilitiesEnvelope,
  type PublicCapabilitiesEnvelopeV1,
  type PublicCapabilityV1
} from '../src/protocol/capabilities.js';
import { CaptureStream } from './helpers.js';

let installed: PublicCapabilitiesEnvelopeV1;
let reviewed: PublicCapabilityV1;

beforeAll(async () => {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  expect(await runCli({ argv: ['capabilities', '--json'], stdout, stderr, env: {} })).toBe(0);
  installed = validatePublicCapabilitiesEnvelope(JSON.parse(stdout.text()));
  const update = installed.capabilities.find((capability) => capability.id === 'project-update');
  if (!update) throw new Error('The public registry must declare managed update.');
  reviewed = update;
});

const malformedCapabilities: Array<[string, (capability: PublicCapabilityV1) => unknown]> = [
  ['non-string profile', (value) => ({ ...value, supportedProfiles: [17] })],
  ['duplicate profile', (value) => ({ ...value, supportedProfiles: ['node-fastify', 'node-fastify'] })],
  ['non-string input', (value) => ({ ...value, requiredInputs: [{}] })],
  ['non-array compatibility identities', (value) => ({ ...value, compatibilityIdentities: 'current' })],
  ['duplicate platform', (value) => ({ ...value, supportedPlatforms: ['darwin', 'darwin'] })],
  ['missing platform', (value) => ({ ...value, supportedPlatforms: [] })],
  ['unknown schema field', (value) => ({ ...value, commandSchema: { ...value.commandSchema, trustAnySchema: true } })],
  ['negative result schema', (value) => ({ ...value, commandSchema: { ...value.commandSchema, resultSchemaVersion: -1 } })],
  ['invalid contract version', (value) => ({ ...value, commandSchema: { ...value.commandSchema, contractVersion: 0 } })],
  ['unknown authorization field', (value) => ({ ...value, authorization: { ...value.authorization, bypass: true } })],
  ['malformed automation flags', (value) => ({ ...value, authorization: { ...value.authorization, automationFlags: [false] } })],
  ['qualified injected-only executor', (value) => ({ ...value, qualificationState: 'qualified', executor: 'injected-only' })],
  ['qualified unavailable executor', (value) => ({ ...value, qualificationState: 'qualified', executor: 'unavailable' })]
];

describe('strict admission of advertised public capabilities', () => {
  it.each(malformedCapabilities)('rejects %s rather than asserting an unchecked public type', (_name, corrupt) => {
    expect(() => validatePublicCapability(corrupt(reviewed))).toThrow();
  });

  it('rejects duplicate capability identities', () => {
    expect(() => validatePublicCapabilitiesEnvelope({
      ...installed, capabilities: [...installed.capabilities, installed.capabilities[0]]
    })).toThrow();
  });

  it('rejects duplicate engines even when the descriptor count is six', () => {
    expect(() => validatePublicCapabilitiesEnvelope({
      ...installed, engines: [...installed.engines.slice(1), installed.engines[1]]
    })).toThrow();
  });

  it('rejects an edited engine module and extra engine fields', () => {
    for (const changed of [
      { ...installed.engines[0], applicationModule: 'application/unregistered-effects' },
      { ...installed.engines[0], grantsAllAuthority: true }
    ]) {
      expect(() => validatePublicCapabilitiesEnvelope({
        ...installed, engines: [changed, ...installed.engines.slice(1)]
      })).toThrow();
    }
  });

  it('rejects a malformed CLI version in the capability envelope', () => {
    expect(() => validatePublicCapabilitiesEnvelope({ ...installed, cliVersion: 'not-a-release' })).toThrow();
  });

  it.each(['project-generation', 'project-migration'])(
    'does not advertise a fictional JSON report schema for human-only %s',
    (id) => {
      const capability = installed.capabilities.find((entry) => entry.id === id);
      expect(capability).toBeDefined();
      expect(capability?.commandSchema.resultSchemaVersion ?? null).toBeNull();
    }
  );

  it('does not advertise standalone Vue generation', () => {
    const capability = installed.capabilities.find((entry) => entry.id === 'project-generation');
    expect(capability).toBeDefined();
    expect(capability?.supportedProfiles).not.toContain('vue-component');
  });
});
