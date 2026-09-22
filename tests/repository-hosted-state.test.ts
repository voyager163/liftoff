import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  approvedActionReferences, HOSTED_READ_ENDPOINTS, HOSTED_STATE_LIMITS, loadHostedState,
  type HostedGetResult, type HostedReadEndpoint, type ReadonlyHostedTransport
} from '../scripts/repository-security/hosted-state.ts';

const registrySource = await readFile(new URL('../security/action-dependencies.json', import.meta.url), 'utf8');
const references = JSON.parse(registrySource).actions.map((item: { reference: string }) => item.reference).sort();
const registry = async () => registrySource;
const state = {
  execution: { enabled: true, allowed_actions: 'all', sha_pinning_required: false },
  allowlist: { github_owned_allowed: true, verified_allowed: true, patterns_allowed: ['actions/*'] },
  workflow: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
  immutable: { enabled: false, enforced_by_owner: false },
  forkApproval: { approval_policy: 'first_time_contributors' }
};
type Surface = keyof typeof state;
function ok(body: unknown): HostedGetResult {
  return { kind: 'response', status: 200, body: JSON.stringify(body) };
}
function transport(overrides: Partial<Record<Surface, HostedGetResult | (() => HostedGetResult)>> = {}) {
  const calls: HostedReadEndpoint[] = [];
  const value: ReadonlyHostedTransport = {
    async get(endpoint) {
      calls.push(endpoint);
      const surface = (Object.keys(HOSTED_READ_ENDPOINTS) as Surface[])
        .find(surface => HOSTED_READ_ENDPOINTS[surface] === endpoint)!;
      const override = overrides[surface];
      return typeof override === 'function' ? override() : override ?? ok(state[surface]);
    }
  };
  return { value, calls };
}

describe('bounded GET-only hosted setting observations', () => {
  it('reads exactly two fixed passes, projects safe fields and returns exact proposal-only differences', async () => {
    const t = transport({ execution: ok({ ...state.execution, secret: 'DO_NOT_RETAIN', selected_actions_url: 'DO_NOT_FOLLOW' }) });
    const preview = await loadHostedState(t.value, registry);
    expect(t.calls).toEqual([...Object.values(HOSTED_READ_ENDPOINTS), ...Object.values(HOSTED_READ_ENDPOINTS)]);
    expect(preview).toMatchObject({
      repository: 'voyager163/liftoff', status: 'blocked', readbackComplete: true,
      capabilityQualified: false, checkBehaviorQualified: false, applyAuthorized: false, liveEffects: false,
      orderingQualified: false, atomicConditionalWriteQualified: false, enforcementQualified: false, snapshotAtomic: false
    });
    expect(preview.actionRegistry.references).toEqual(references);
    expect(preview.settings.execution).toMatchObject({
      status: 'pending', availability: 'available', before: state.execution,
      desired: { enabled: true, allowed_actions: 'selected', sha_pinning_required: true },
      diff: [
        { field: 'allowed_actions', before: 'all', desired: 'selected' },
        { field: 'sha_pinning_required', before: false, desired: true }
      ],
      proposal: { method: 'PUT', endpoint: HOSTED_READ_ENDPOINTS.execution, applyAuthorized: false }
    });
    expect(preview.settings.allowlist).toMatchObject({
      status: 'pending', before: state.allowlist,
      desired: { github_owned_allowed: false, verified_allowed: false, patterns_allowed: references },
      diff: [
        { field: 'github_owned_allowed', before: true, desired: false },
        { field: 'verified_allowed', before: true, desired: false },
        { field: 'patterns_allowed', before: ['actions/*'], desired: references }
      ]
    });
    expect(preview.settings.workflow).toMatchObject({ status: 'configured', diff: [], before: state.workflow, desired: state.workflow });
    expect(preview.settings.immutable).toMatchObject({
      status: 'pending', before: state.immutable, desired: { enabled: true },
      diff: [{ field: 'enabled', before: false, desired: true }], preservedFields: ['enforced_by_owner'],
      proposal: { method: 'PUT', endpoint: HOSTED_READ_ENDPOINTS.immutable, payload: null, liveEffects: false }
    });
    expect(preview.settings.forkApproval).toMatchObject({
      status: 'available', intent: 'preserve-observe-only', before: state.forkApproval,
      desired: null, proposal: null, diff: [], preservedFields: ['approval_policy']
    });
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain('DO_NOT_');
    expect(serialized).not.toContain('/rulesets');
    expect(preview.blockers).toContain('tag-and-publisher-identity-qualification-pending');
    for (const setting of Object.values(preview.settings)) {
      if (setting.proposal) expect(setting.proposal).toMatchObject({
        capabilityQualified: false, checkBehaviorQualified: false, applyAuthorized: false, liveEffects: false
      });
    }
  });

  it('treats matching settings as configured, not qualified, and preserves exact allowlist readback order', async () => {
    const reversed = [...references].reverse();
    let reads = 0;
    const t = transport({
      execution: ok({ enabled: true, allowed_actions: 'selected', sha_pinning_required: true }),
      allowlist: () => ok({ github_owned_allowed: false, verified_allowed: false, patterns_allowed: ++reads === 1 ? references : reversed }),
      immutable: ok({ enabled: true, enforced_by_owner: true })
    });
    const preview = await loadHostedState(t.value, registry);
    for (const key of ['execution', 'allowlist', 'workflow', 'immutable'] as const) {
      expect(preview.settings[key].status).toBe('configured');
      expect(preview.settings[key].diff).toEqual([]);
    }
    expect(preview.settings.allowlist.before?.patterns_allowed).toEqual(reversed);
    expect(preview.settings.immutable.before?.enforced_by_owner).toBe(true);
    expect(preview.status).toBe('blocked');
    expect(preview.applyAuthorized).toBe(false);
  });

  it.each([401, 403, 404, 409, 500])('keeps HTTP %s unavailable without fabricating selected-action before-state', async status => {
    const t = transport({ allowlist: { kind: 'response', status, body: '{"message":"PRIVATE_ERROR"}' } });
    const preview = await loadHostedState(t.value, registry);
    expect(preview.settings.execution.before?.allowed_actions).toBe('all');
    expect(preview.settings.allowlist).toMatchObject({
      availability: 'unavailable', status: 'unavailable', before: null, diff: null,
      desired: { patterns_allowed: references }, observations: [
        { httpStatus: status, value: null }, { httpStatus: status, value: null }
      ]
    });
    expect(preview.readbackComplete).toBe(false);
    expect(JSON.stringify(preview)).not.toContain('PRIVATE_ERROR');
  });

  const fields = Object.entries(state).flatMap(([surface, value]) =>
    Object.keys(value).map(field => ({ surface: surface as Surface, field })));
  it.each(fields)('does not default a missing $surface.$field', async ({ surface, field }) => {
    const value: Record<string, unknown> = { ...state[surface] };
    delete value[field];
    const preview = await loadHostedState(transport({ [surface]: ok(value) }).value, registry);
    expect(preview.settings[surface]).toMatchObject({
      status: 'unknown', before: null, diff: null, availability: 'unknown'
    });
    expect(preview.settings[surface].blockers).toContain('read-1:missing-or-invalid-settings');
    expect(preview.readbackComplete).toBe(false);
  });
  it.each([
    ['execution', { ...state.execution, enabled: 'true' }],
    ['execution', { ...state.execution, allowed_actions: 'unknown' }],
    ['workflow', { ...state.workflow, default_workflow_permissions: 'admin' }],
    ['immutable', { enabled: false, enforced_by_owner: null }],
    ['allowlist', { ...state.allowlist, patterns_allowed: ['https://private.example/secret'] }],
    ['allowlist', { ...state.allowlist, patterns_allowed: ['actions/*', 'actions/*'] }],
    ['allowlist', { ...state.allowlist, patterns_allowed: Array.from({ length: 101 }, (_, i) => `owner/action${i}`) }],
    ['allowlist', { ...state.allowlist, patterns_allowed: [`owner/${'x'.repeat(201)}`] }],
    ['forkApproval', { approval_policy: 'unrecognized' }]
  ] as const)('rejects invalid %s settings without reflecting arbitrary strings', async (surface, value) => {
    const preview = await loadHostedState(transport({ [surface]: ok(value) }).value, registry);
    expect(preview.settings[surface].status).toBe('unknown');
    expect(preview.settings[surface].before).toBeNull();
    expect(JSON.stringify(preview)).not.toContain('private.example');
  });

  it.each([
    [{ kind: 'response', status: 200, body: '{invalid PRIVATE}' }, 'malformed-json'],
    [{ kind: 'response', status: 200, body: '[]' }, 'missing-or-invalid-settings'],
    [{ kind: 'response', status: 200, body: 'null' }, 'missing-or-invalid-settings'],
    [{ kind: 'response', status: 200, body: 'x'.repeat(HOSTED_STATE_LIMITS.responseBytes + 1) }, 'output-limit'],
    [{ kind: 'response', status: 200, body: 'é'.repeat(HOSTED_STATE_LIMITS.responseBytes / 2 + 1) }, 'output-limit'],
    [{ kind: 'response', status: 999, body: '{}' }, 'invalid-response'],
    [{ kind: 'error', reason: 'timeout' }, 'timeout'],
    [{ kind: 'error', reason: 'PRIVATE' }, 'transport-error']
  ])('sanitizes malformed, oversized and failed reads', async (result, reason) => {
    const preview = await loadHostedState(transport({ workflow: result as HostedGetResult }).value, registry);
    expect(preview.settings.workflow).toMatchObject({
      status: 'unknown', before: null, diff: null, observations: [{ reason }, { reason }]
    });
    expect(JSON.stringify(preview)).not.toContain('PRIVATE');
  });

  it('never reflects a thrown transport diagnostic', async () => {
    const preview = await loadHostedState({ async get() { throw new Error('PRIVATE TOKEN'); } }, registry);
    expect(preview.readbackComplete).toBe(false);
    expect(Object.values(preview.settings).every(value => value.status === 'unknown')).toBe(true);
    expect(JSON.stringify(preview)).not.toContain('PRIVATE');
  });
  it('bounds stalled injected reads', async () => {
    vi.useFakeTimers();
    try {
      const pending = loadHostedState({ get: () => new Promise(() => {}) }, registry);
      await vi.runAllTimersAsync();
      const preview = await pending;
      expect(preview.readbackComplete).toBe(false);
      expect(preview.settings.execution.blockers).toContain('read-1:timeout');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(Object.keys(state) as Surface[])('blocks observed drift on %s, including the preserved fork policy', async surface => {
    const changed = {
      execution: { ...state.execution, sha_pinning_required: true },
      allowlist: { ...state.allowlist, verified_allowed: false },
      workflow: { ...state.workflow, can_approve_pull_request_reviews: true },
      immutable: { ...state.immutable, enforced_by_owner: true },
      forkApproval: { approval_policy: 'all_external_contributors' }
    };
    let reads = 0;
    const preview = await loadHostedState(transport({
      [surface]: () => ok(++reads === 1 ? state[surface] : changed[surface])
    }).value, registry);
    expect(preview.settings[surface]).toMatchObject({
      status: 'unknown', before: null, diff: null, blockers: ['readback-drift']
    });
    expect(preview.settings[surface].observations.map(item => item.value)).toEqual([state[surface], changed[surface]]);
    expect(preview.readbackComplete).toBe(false);
  });
  it('does not turn a failed first read into success after recovery', async () => {
    let reads = 0;
    const preview = await loadHostedState(transport({
      workflow: () => ++reads === 1 ? { kind: 'error', reason: 'transport-error' } : ok(state.workflow)
    }).value, registry);
    expect(preview.settings.workflow).toMatchObject({ status: 'unknown', before: null, diff: null });
  });
});

describe('existing registered immutable action references', () => {
  it('uses the existing registry by default, without network descriptor inspection', async () => {
    const preview = await loadHostedState(transport().value);
    expect(preview.actionRegistry.references).toEqual(references);
    expect(preview.settings.allowlist.proposal?.payload).toEqual({
      github_owned_allowed: false, verified_allowed: false, patterns_allowed: references
    });
  });
  it.each([
    '{}', '{invalid', 'x'.repeat(HOSTED_STATE_LIMITS.responseBytes + 1),
    JSON.stringify({ schemaVersion: 1, actions: [] }),
    JSON.stringify({ schemaVersion: 2, actions: JSON.parse(registrySource).actions }),
    ...['actions/*', 'actions/checkout@v1', './local'].map(reference =>
      JSON.stringify({ schemaVersion: 1, actions: [{ reference, dependencies: [] }] })),
    JSON.stringify({ schemaVersion: 1, actions: [JSON.parse(registrySource).actions[0], JSON.parse(registrySource).actions[0]] }),
    JSON.stringify({ schemaVersion: 1, actions: [{ reference: references[0], dependencies: ['unregistered/action@v1'] }] })
  ])('blocks invalid registry data without manufacturing an allowlist', async source => {
    expect(() => approvedActionReferences(source)).toThrow();
    const preview = await loadHostedState(transport().value, async () => source);
    expect(preview.actionRegistry).toMatchObject({ status: 'unknown', references: null });
    expect(preview.settings.allowlist).toMatchObject({
      status: 'unknown', desired: null, diff: null, proposal: null
    });
    expect(preview.readbackComplete).toBe(false);
  });
  it('fails closed if the registry cannot be read', async () => {
    const preview = await loadHostedState(transport().value, async () => { throw new Error('PRIVATE PATH'); });
    expect(preview.actionRegistry.status).toBe('unknown');
    expect(JSON.stringify(preview)).not.toContain('PRIVATE');
  });
});
