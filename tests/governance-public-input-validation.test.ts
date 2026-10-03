import { describe, expect, it } from 'vitest';
import {
  validateActivationConfiguration, validatePublicActivationInputs, validateUserActivationState
} from '../src/domain/governance/activation/validators.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import type { UserActivationState } from '../src/domain/governance/activation/types.js';
import { coverageState, coverageSubscription, coverageTenant } from './fixtures/governance-coverage/transition-project.js';

type Json = Record<string, unknown>;

const token = ['ghp', 'V'.repeat(36)].join('_');
const sentinels = [token, 'SENTINEL-\u001b[2J\u0007-control', `SENTINEL-${'L'.repeat(300)}`];
const nestedCredential = (phase: string) =>
  `activationInputs.phases.${phase} contains credential material in a nested value; use protected credential enrollment instead.`;
const fieldNameCredential = (phase: string) =>
  `activationInputs.phases.${phase} contains credential material in a field name; use protected credential enrollment instead.`;
const credentialAt = (location: string) => `${location} contains credential material; use protected credential enrollment instead.`;
const unsupportedField = (location: string, fields: string) => `${location} contains an unsupported field; allowed fields: ${fields}.`;
const unsupportedPhase = 'activationInputs.phases contains an unsupported phase identifier; use only phase ids from the managed phase graph.';
const visibilityValues = 'activationInputs.repository.visibility must be "private" or "public".';
const azure = { subscriptionId: coverageSubscription, tenantId: coverageTenant, region: 'eastus' };
const budget = { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 };

function refusal(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the activation inputs to be refused.');
}

function expectTrustedRefusal(validate: (value: unknown) => unknown, input: unknown, expected: string, supplied: readonly string[] = []): void {
  const message = refusal(() => validate(input));
  expect(message).toBe(expected);
  for (const text of [...supplied, 'SENTINEL']) expect(message).not.toContain(text);
  expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
}

function deep(levels: number): Json {
  const root: Json = {};
  let cursor = root;
  for (let level = 0; level < levels; level += 1) {
    const next: Json = {};
    cursor.next = next;
    cursor = next;
  }
  return root;
}

function expectNormalized(actual: unknown, expected: unknown): void {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  expect(canonicalSha256(actual)).toBe(canonicalSha256(expected));
}

describe('public activation input diagnostics', () => {
  it('names only trusted locations for unsupported supplied keys, phase ids and visibility values', () => {
    for (const supplied of sentinels) {
      const cases: Array<[unknown, string]> = [
        [{ schemaVersion: 1, phases: {}, [supplied]: 1 },
          unsupportedField('activationInputs', 'schemaVersion, phases, repository, azure, budget')],
        [{ schemaVersion: 1, phases: {}, repository: { name: 'acme/widget', [supplied]: 1 } },
          unsupportedField('activationInputs.repository', 'name, defaultBranch, visibility, create')],
        [{ schemaVersion: 1, phases: {}, azure: { ...azure, [supplied]: 1 } },
          unsupportedField('activationInputs.azure', 'subscriptionId, tenantId, region')],
        [{ schemaVersion: 1, phases: {}, budget: { ...budget, [supplied]: 1 } },
          unsupportedField('activationInputs.budget', 'currency, fixedMonthlyCents, usageMonthlyCents')],
        [{ schemaVersion: 1, phases: { [supplied]: {} } }, unsupportedPhase],
        [{ schemaVersion: 1, phases: {}, repository: { name: 'acme/widget', visibility: supplied } }, visibilityValues],
        [{ schemaVersion: 1, phases: {}, repository: { name: 'acme/widget', visibility: { token, note: supplied } } }, visibilityValues]
      ];
      for (const [input, expected] of cases) {
        expectTrustedRefusal(validatePublicActivationInputs, input, expected, [supplied, token]);
        expectTrustedRefusal(validateActivationConfiguration, input, expected, [supplied, token]);
      }
    }
  });

  it('names only the validated phase for nested phase-input failures', () => {
    for (const supplied of sentinels) {
      const cases: Array<[unknown, string]> = [
        [{ schemaVersion: 1, phases: { 'runner-ready': { [supplied]: deep(22) } } },
          'activationInputs.phases.runner-ready exceeds the supported JSON nesting depth.'],
        [{ schemaVersion: 1, phases: { 'runner-ready': { [supplied]: token } } }, nestedCredential('runner-ready')],
        [{ schemaVersion: 1, phases: { 'runner-ready': { list: [[{ [supplied]: token }]] } } }, nestedCredential('runner-ready')],
        [{ schemaVersion: 1, phases: { 'runner-ready': { [supplied]: Number.NaN } } },
          'activationInputs.phases.runner-ready contains a nested value that must be an object.']
      ];
      for (const [input, expected] of cases) {
        expectTrustedRefusal(validatePublicActivationInputs, input, expected, [supplied, token]);
        expectTrustedRefusal(validateActivationConfiguration, input, expected, [supplied, token]);
      }
    }
  });

  it('reports forbidden field names with fixed canonical labels instead of the caller spelling', () => {
    const labels: Array<[string, string]> = [
      ['CLIENTSECRET', 'clientSecret'], ['Password', 'password'], ['sastoken', 'sasToken'],
      ['ACCESSTOKEN', 'accessToken'], ['token', 'token'], ['ConnectionString', 'connectionString']
    ];
    for (const [key, label] of labels) {
      const input = { schemaVersion: 1, phases: { 'phase-0-complete': { outer: { [key]: 'value' } } } };
      const expected = `activationInputs.phases.phase-0-complete: field ${label} is not permitted in public activation inputs.`;
      for (const validate of [validatePublicActivationInputs, validateActivationConfiguration]) {
        const message = refusal(() => validate(input));
        expect(message).toBe(expected);
        if (key !== label) expect(message).not.toContain(key);
      }
    }
    const reserved = JSON.parse('{"schemaVersion":1,"phases":{"phase-0-complete":{"__proto__":{"polluted":true}}}}') as unknown;
    expect(refusal(() => validatePublicActivationInputs(reserved)))
      .toBe('activationInputs.phases.phase-0-complete: field __proto__ is not permitted in public activation inputs.');
  });
});

describe('public activation input boundary screen', () => {
  it('keeps refusing the existing short-token, query and userinfo shapes wherever inputs are supplied', () => {
    for (const shape of ['ghp_x', 'GHS_a', 'github_pat_1', 'https://user@example.test', 'callback?token=abc', 'hook&sig=abc']) {
      expectTrustedRefusal(validatePublicActivationInputs,
        { schemaVersion: 1, phases: { 'runner-ready': { note: shape } } }, nestedCredential('runner-ready'), [shape]);
      expectTrustedRefusal(validatePublicActivationInputs,
        { schemaVersion: 1, phases: { 'runner-ready': { [shape]: 'restricted' } } }, fieldNameCredential('runner-ready'), [shape]);
    }
    expectTrustedRefusal(validatePublicActivationInputs, { schemaVersion: 1, phases: {}, repository: { name: 'acme/ghs_tools' } },
      credentialAt('activationInputs.repository.name'), ['ghs_tools']);
    expectTrustedRefusal(validatePublicActivationInputs, { schemaVersion: 1, phases: {}, repository: { name: 'acme/github_pat_1' } },
      credentialAt('activationInputs.repository.name'), ['github_pat_1']);
    expectTrustedRefusal(validatePublicActivationInputs,
      { schemaVersion: 1, phases: {}, repository: { name: 'acme/widget', defaultBranch: 'feature/GHP_x' } },
      credentialAt('activationInputs.repository.defaultBranch'), ['GHP_x']);
  });

  it('refuses credential-shaped phase values recognized only by the shared sensitive-text screen, at any depth', () => {
    const values = [
      'Bearer abc123def456', 'basic setup', `npm_${'a'.repeat(36)}`, 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      'DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=c2VjcmV0', 'https://hooks.slack.com/services/T000/B000/XXXX',
      'password=hunter2', 'postgres://user:pass@db.example.test/app'
    ];
    for (const value of values) {
      for (const inputs of [{ note: value }, { list: [{ inner: [value] }] }]) {
        const input = { schemaVersion: 1, phases: { 'runner-ready': inputs } };
        expectTrustedRefusal(validatePublicActivationInputs, input, nestedCredential('runner-ready'), [value]);
        expect(validateActivationConfiguration(input)).toEqual(input);
      }
    }
  });

  it('refuses credential-shaped phase field names at any depth and credential-shaped repository values', () => {
    for (const inputs of [{ [token]: 1 }, { outer: [{ [`npm_${'b'.repeat(24)}`]: 1 }] }, { 'Bearer abc123def456': 1 }]) {
      expectTrustedRefusal(validatePublicActivationInputs,
        { schemaVersion: 1, phases: { 'runner-ready': inputs } }, fieldNameCredential('runner-ready'), [token, 'npm_', 'abc123def456']);
    }
    expectTrustedRefusal(validatePublicActivationInputs, { schemaVersion: 1, phases: {}, repository: { name: `acme/${token}` } },
      credentialAt('activationInputs.repository.name'), [token]);
    expectTrustedRefusal(validatePublicActivationInputs,
      { schemaVersion: 1, phases: {}, repository: { name: 'acme/widget', defaultBranch: `feature/${token}` } },
      credentialAt('activationInputs.repository.defaultBranch'), [token]);
  });

  it('keeps benign inputs and exact GitHub App installation-token metadata accepted', () => {
    const benign = {
      schemaVersion: 1,
      phases: { 'runner-ready': { group: 'restricted', labels: ['linux-x64'], tokenStrategy: 'rotate secrets monthly', docs: 'https://github.com/acme/widget' } },
      repository: { name: 'acme/ghost-town', defaultBranch: 'feature/token-refresh' }
    };
    expectNormalized(validatePublicActivationInputs(benign), benign);
    const metadata = { schemaVersion: 1, phases: { 'credential-ready': { token: { generatedBy: 'github-app', strategy: 'installation-token', ttlSeconds: 3600 } } } };
    expectNormalized(validatePublicActivationInputs(metadata), metadata);
    for (const metadataToken of [
      { generatedBy: 'github-app', strategy: 'installation-token', ttlSeconds: 3601 },
      { generatedBy: 'github-app', strategy: 'pat', ttlSeconds: 60 },
      { generatedBy: 'github-app', strategy: 'installation-token', ttlSeconds: 60, scope: 'all' }
    ]) {
      const input = { schemaVersion: 1, phases: { 'credential-ready': { token: metadataToken } } };
      for (const validate of [validatePublicActivationInputs, validateActivationConfiguration]) {
        expect(refusal(() => validate(input)))
          .toBe('activationInputs.phases.credential-ready: field token is not permitted in public activation inputs.');
      }
    }
  });

  it('normalizes accepted inputs at the public boundary exactly like the persisted-configuration validator', () => {
    for (const input of acceptedCorpus) expectNormalized(validatePublicActivationInputs(input.value), input.expected);
  });
});

const acceptedCorpus: ReadonlyArray<{ label: string; value: unknown; expected: unknown }> = [
  {
    label: 'complete input in caller order',
    value: {
      budget: { usageMonthlyCents: 500, fixedMonthlyCents: 1200, currency: 'EUR' },
      azure: { region: 'eastus', tenantId: coverageTenant, subscriptionId: coverageSubscription },
      repository: { create: false, visibility: 'public', defaultBranch: 'release/1.0', name: 'acme/widget' },
      phases: {
        'runner-ready': { labels: ['linux-x64', 'arm64'], limits: { count: 2, enabled: true, note: null, ratio: 0.5 }, group: 'restricted' },
        'credential-ready': { token: { ttlSeconds: 1800, strategy: 'installation-token', generatedBy: 'github-app' }, owners: ['acme'] }
      },
      schemaVersion: 1
    },
    expected: {
      schemaVersion: 1,
      phases: {
        'runner-ready': { labels: ['linux-x64', 'arm64'], limits: { count: 2, enabled: true, note: null, ratio: 0.5 }, group: 'restricted' },
        'credential-ready': { token: { ttlSeconds: 1800, strategy: 'installation-token', generatedBy: 'github-app' }, owners: ['acme'] }
      },
      repository: { name: 'acme/widget', defaultBranch: 'release/1.0', visibility: 'public', create: false },
      azure: { subscriptionId: coverageSubscription, tenantId: coverageTenant, region: 'eastus' },
      budget: { currency: 'EUR', fixedMonthlyCents: 1200, usageMonthlyCents: 500 }
    }
  },
  { label: 'minimal input', value: { phases: {}, schemaVersion: 1 }, expected: { schemaVersion: 1, phases: {} } },
  {
    label: 'repository without optional fields',
    value: { repository: { name: 'acme/widget' }, schemaVersion: 1, phases: {} },
    expected: { schemaVersion: 1, phases: {}, repository: { name: 'acme/widget' } }
  }
];

// Shapes the public boundary now refuses remain readable from persisted state and saved plans.
const persistedOnly = {
  schemaVersion: 1,
  phases: {
    'runner-ready': {
      notes: ['Bearer abc123def456', 'basic setup', `npm_${'a'.repeat(36)}`], [token]: 'restricted',
      connection: 'DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=c2VjcmV0',
      webhook: 'https://hooks.slack.com/services/T000/B000/XXXX', jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      login: 'password=hunter2', database: 'postgres://user:pass@db.example.test/app'
    }
  },
  repository: { defaultBranch: 'feature/GHP_x', name: 'acme/ghs_tools' }
};
const persistedOnlyExpected = {
  schemaVersion: 1,
  phases: persistedOnly.phases,
  repository: { name: 'acme/ghs_tools', defaultBranch: 'feature/GHP_x' }
};

describe('activation configuration normalization parity', () => {
  it('normalizes accepted public inputs exactly as before the boundary changes', () => {
    for (const input of acceptedCorpus) expectNormalized(validateActivationConfiguration(input.value), input.expected);
  });

  it('keeps accepting and normalizing persisted configuration shapes that the public boundary refuses', () => {
    expectNormalized(validateActivationConfiguration(persistedOnly), persistedOnlyExpected);
    const state = validateUserActivationState(coverageState({ activationInputs: persistedOnly as unknown as UserActivationState['activationInputs'] }));
    expectNormalized(state.activationInputs, persistedOnlyExpected);
  });

  it('keeps diagnostics of other public JSON readers byte-identical', () => {
    const outputs = { 'phase-0-complete': { values: { value: token }, resources: [] } } as unknown as UserActivationState['phaseOutputs'];
    expect(refusal(() => validateUserActivationState(coverageState({ phaseOutputs: outputs }))))
      .toBe('activationState.phaseOutputs.phase-0-complete.values.value contains credential material; use protected credential enrollment instead.');
  });
});
