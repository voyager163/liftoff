import { describe, expect, it, vi } from 'vitest';
import { canonicalDigest } from '../scripts/repository-security/admission.ts';
import { SecurityEvidenceError } from '../scripts/repository-security/evidence.ts';
import {
  applyHostedMigrationProduction, applyHostedMigrationSimulation, createMigrationSimulation,
  describeHostedMigration, diffHostedMigration, hostedMigrationProductionBoundary, HOSTED_MIGRATION_LIMITS,
  inspectMigrationSimulation, prepareHostedMigration, type MigrationExpectations, type MigrationProposal,
  type MigrationSimulationConsent, type MigrationSimulationFault, type InMemoryMigrationTransport
} from '../scripts/repository-security/hosted-migration.ts';

const now = new Date('2026-09-20T12:00:00.000Z');
const hash = `sha256:${'a'.repeat(64)}`;
const otherHash = `sha256:${'b'.repeat(64)}`;
const sentinel = 'DO_NOT_RETAIN_TRANSPORT_SECRET <script> [raw](https://invalid.example) \n';

// Deliberately opaque synthetic data, NOT GitHub API payloads or payload-schema qualification.
function fixture(count: 1 | 2 = 2) {
  const proposal: MigrationProposal = {
    identity: {
      repository: 'voyager163/liftoff', event: 'workflow_dispatch', sourceSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40), workflowSha: 'c'.repeat(40), runId: '123', attempt: 1,
      policyDigest: hash, inventoryDigest: hash, configurationDigest: hash
    },
    observedAt: '2026-09-20T11:00:00.000Z',
    registry: {
      schemaVersion: 1, repository: 'voyager163/liftoff', ownerType: 'User',
      endpoints: [
        { id: 'actions', readMethod: 'GET', writeMethod: 'PUT', path: '/repos/voyager163/liftoff/actions/permissions' },
        { id: 'main', readMethod: 'GET', writeMethod: 'PUT', path: '/repos/voyager163/liftoff/branches/main/protection' }
      ].slice(0, count) as MigrationProposal['registry']['endpoints']
    },
    operations: [
      { id: 'configure-actions', endpointId: 'actions',
        before: { opaqueFixtureVersion: 1, existingProtection: 'retained' },
        after: { opaqueFixtureVersion: 2, existingProtection: 'retained' },
        payload: { opaqueFixtureVersion: 2 } },
      { id: 'configure-main', endpointId: 'main',
        before: { opaqueFixtureVersion: 3, existingProtection: 'retained' },
        after: { opaqueFixtureVersion: 4, existingProtection: 'retained' },
        payload: { opaqueFixtureVersion: 4 } }
    ].slice(0, count)
  };
  const expected: MigrationExpectations = {
    identity: structuredClone(proposal.identity), proposalDigest: canonicalDigest(proposal), validatorDigest: hash
  };
  return { proposal, expected };
}

function prepare(data = fixture()) {
  return prepareHostedMigration(data.proposal, data.expected, now);
}

function authorize(plan: ReturnType<typeof prepare>): MigrationSimulationConsent {
  const metadata = describeHostedMigration(plan);
  return {
    kind: 'simulation-only-migration-consent', id: 'fixture-consent-1', owner: 'voyager163',
    identity: structuredClone(metadata.identity), planDigest: metadata.planDigest,
    registryDigest: metadata.registryDigest, beforeDigest: metadata.beforeDigest,
    afterDigest: metadata.afterDigest, payloadDigest: metadata.payloadDigest,
    approvedAt: '2026-09-20T11:45:00.000Z', expiresAt: '2026-09-20T12:30:00.000Z'
  };
}

function simulation(data = fixture(), faults: MigrationSimulationFault[] = []) {
  return createMigrationSimulation({
    registry: data.proposal.registry,
    states: data.proposal.operations.map(operation => ({ endpointId: operation.endpointId, value: operation.before })),
    faults
  });
}

function qualifyFixture(data: ReturnType<typeof fixture>) {
  data.expected.proposalDigest = canonicalDigest(data.proposal);
}

function writes(transport: InMemoryMigrationTransport) {
  return inspectMigrationSimulation(transport).trace.filter(item => item.method !== 'GET');
}

describe('local-only repository migration preparation and in-memory simulation', () => {
  it('prepares an exact digest-bound plan without mutating its inputs or selecting active defaults', () => {
    const data = fixture();
    const before = JSON.stringify(data);
    const plan = prepare(data), metadata = describeHostedMigration(plan);
    expect(JSON.stringify(data)).toBe(before);
    expect(metadata).toMatchObject({
      kind: 'local-migration-plan-description', productionEnabled: false,
      payloadValidation: 'independently-supplied-not-authenticated',
      proposalDigest: data.expected.proposalDigest, validatorDigest: hash
    });
    expect(metadata.operations.map(item => item.id)).toEqual(['configure-actions', 'configure-main']);
    expect(metadata.operations[0]).toMatchObject({
      beforeDigest: canonicalDigest(data.proposal.operations[0]!.before),
      afterDigest: canonicalDigest(data.proposal.operations[0]!.after),
      payloadDigest: canonicalDigest(data.proposal.operations[0]!.payload)
    });
    expect(Object.isFrozen(plan)).toBe(true);
    metadata.operations[0]!.payloadDigest = otherHash;
    expect(describeHostedMigration(plan).operations[0]!.payloadDigest).not.toBe(otherHash);
    expect(describeHostedMigration(prepare(fixture())).planDigest).toBe(metadata.planDigest);
  });

  it('performs a read-only diff with exact before/after comparisons and no fake writes', () => {
    const data = fixture(), plan = prepare(data), transport = simulation(data);
    const result = diffHostedMigration(plan, transport, now);
    expect(result).toMatchObject({ status: 'ready-for-simulation', mutationCount: 0, productionEnabled: false });
    expect(result.operations.map(item => item.state)).toEqual(['change-required', 'change-required']);
    expect(writes(transport)).toEqual([]);
    expect(inspectMigrationSimulation(transport).states).toEqual(data.proposal.operations.map(operation => ({
      endpointId: operation.endpointId, digest: canonicalDigest(operation.before)
    })));
  });

  it('applies only the registered order with conditional writes and immediate plus final readback', () => {
    const data = fixture(), plan = prepare(data), transport = simulation(data);
    const result = applyHostedMigrationSimulation(plan, authorize(plan), transport, now);
    expect(result).toMatchObject({
      kind: 'simulated-migration-result', status: 'completed', liveEffects: false, hostedQualification: false, recovery: null
    });
    expect(result.operations.map(operation => [operation.write, operation.verification]))
      .toEqual([['acknowledged', 'after-matched'], ['acknowledged', 'after-matched']]);
    expect(writes(transport).map(item => item.endpointId)).toEqual(['actions', 'main']);
    expect(writes(transport).map(item => item.conditionDigest)).toEqual(result.operations.map(item => item.beforeDigest));
    expect(inspectMigrationSimulation(transport).trace.map(item => item.phase)).toEqual([
      'preflight', 'preflight', 'precondition', 'precondition', 'apply', 'readback',
      'precondition', 'precondition', 'apply', 'readback', 'final-readback', 'final-readback'
    ]);
    expect(inspectMigrationSimulation(transport).states).toEqual(data.proposal.operations.map(operation => ({
      endpointId: operation.endpointId, digest: canonicalDigest(operation.after)
    })));
  });

  it('is idempotent for the same exact payload and consent, with no repeated writes', () => {
    const data = fixture(), plan = prepare(data), transport = simulation(data), consent = authorize(plan);
    expect(applyHostedMigrationSimulation(plan, consent, transport, now).status).toBe('completed');
    const second = applyHostedMigrationSimulation(plan, consent, transport, now);
    expect(second.status).toBe('completed');
    expect(second.operations.every(item => item.noop && item.write === 'not-attempted')).toBe(true);
    expect(writes(transport)).toHaveLength(2);
  });

  it('keeps an already matching control untouched while changing a different control', () => {
    const data = fixture();
    data.proposal.operations[1]!.after = structuredClone(data.proposal.operations[1]!.before);
    qualifyFixture(data);
    const plan = prepare(data), transport = simulation(data);
    const result = applyHostedMigrationSimulation(plan, authorize(plan), transport, now);
    expect(result.status).toBe('completed');
    expect(result.operations[1]).toMatchObject({ noop: true, write: 'not-attempted', verification: 'after-matched' });
    expect(writes(transport).map(item => item.endpointId)).toEqual(['actions']);
    expect(inspectMigrationSimulation(transport).states[1]!.digest).toBe(canonicalDigest(data.proposal.operations[1]!.before));
  });

  it('recognizes independently observed exact desired state as a no-op, not new mutation permission', () => {
    const data = fixture(), plan = prepare(data);
    const transport = createMigrationSimulation({
      registry: data.proposal.registry,
      states: data.proposal.operations.map(operation => ({ endpointId: operation.endpointId, value: operation.after })),
      faults: []
    });
    expect(diffHostedMigration(plan, transport, now).operations.every(item => item.state === 'already-matches')).toBe(true);
    expect(applyHostedMigrationSimulation(plan, authorize(plan), transport, now).operations.every(item => item.noop)).toBe(true);
    expect(writes(transport)).toHaveLength(0);
  });

  it.each(['planDigest', 'registryDigest', 'beforeDigest', 'afterDigest', 'payloadDigest'] as const)(
    'binds explicit consent to %s and rejects mismatches before any read or write', field => {
      const data = fixture(), plan = prepare(data), transport = simulation(data), consent = authorize(plan);
      consent[field] = otherHash;
      expect(() => applyHostedMigrationSimulation(plan, consent, transport, now)).toThrow('consent-payload-mismatch');
      expect(inspectMigrationSimulation(transport).trace).toEqual([]);
    });

  it.each([
    { sourceSha: 'd'.repeat(40) }, { baseSha: 'd'.repeat(40) }, { workflowSha: 'd'.repeat(40) },
    { runId: '124' }, { attempt: 2 }, { policyDigest: otherHash }, { inventoryDigest: otherHash },
    { configurationDigest: otherHash }, { event: 'push' }
  ])('binds source/run/policy identities in consent %#', change => {
    const data = fixture(), plan = prepare(data), transport = simulation(data), consent = authorize(plan);
    Object.assign(consent.identity, change);
    expect(() => applyHostedMigrationSimulation(plan, consent, transport, now)).toThrow('consent-identity');
    expect(writes(transport)).toEqual([]);
  });

  it('requires explicit simulation consent rather than owner strings, caller approval flags or no consent', () => {
    const data = fixture(), plan = prepare(data), transport = simulation(data);
    for (const invalid of [
      null, { owner: 'voyager163', approved: true },
      { ...authorize(plan), kind: 'production-consent' }, { ...authorize(plan), owner: 'different-owner' },
      { ...authorize(plan), approved: true }
    ]) {
      expect(() => applyHostedMigrationSimulation(plan, invalid as MigrationSimulationConsent, transport, now))
        .toThrow(SecurityEvidenceError);
    }
    expect(inspectMigrationSimulation(transport).trace).toEqual([]);
  });

  it.each([
    { approvedAt: '2026-09-20T12:01:00.000Z' }, { approvedAt: '2026-09-20T10:59:00.000Z' },
    { expiresAt: '2026-09-20T12:00:00.000Z' }, { expiresAt: '2026-09-20T12:45:00.001Z' },
    { expiresAt: '2026-02-30T12:30:00.000Z' }, { approvedAt: '2026-09-20T11:45:00Z' }
  ])('rejects stale, future, noncanonical and overlong consent %#', change => {
    const data = fixture(), plan = prepare(data), transport = simulation(data);
    expect(() => applyHostedMigrationSimulation(plan, { ...authorize(plan), ...change }, transport, now)).toThrow(SecurityEvidenceError);
    expect(writes(transport)).toEqual([]);
  });

  it('requires fresh snapshots at preparation, diff and apply', () => {
    const data = fixture(), plan = prepare(data), transport = simulation(data);
    const stale = new Date('2026-09-21T11:00:00.001Z');
    expect(() => prepareHostedMigration(data.proposal, data.expected, stale)).toThrow('stale-plan');
    expect(() => diffHostedMigration(plan, transport, stale)).toThrow('stale-plan');
    expect(() => applyHostedMigrationSimulation(plan, authorize(plan), transport, stale)).toThrow('stale-plan');
    expect(() => prepareHostedMigration(data.proposal, data.expected, new Date(NaN))).toThrow('invalid-time');
    data.proposal.observedAt = '2026-09-20T12:00:00.001Z';
    qualifyFixture(data);
    expect(() => prepare(data)).toThrow('stale-plan');
  });

  it.each(['payload', 'before', 'after'] as const)('rejects changed %s bytes against independent validation', field => {
    const data = fixture();
    data.proposal.operations[0]![field] = { maliciousWeakening: true, bypassActors: ['fixture'] };
    expect(() => prepare(data)).toThrow('unvalidated-proposal');
  });

  it('invalidates old consent when payload order, validator, registrations or separately validated bytes change', () => {
    const data = fixture(), oldPlan = prepare(data), oldConsent = authorize(oldPlan);
    const variants = [
      () => { data.proposal.operations = [...data.proposal.operations].reverse(); },
      () => { data.expected.validatorDigest = otherHash; },
      () => { data.proposal.registry.endpoints[0]!.path += '/workflow'; },
      () => { data.proposal.operations[0]!.payload = { opaqueFixtureVersion: 99 }; }
    ];
    for (const change of variants) {
      change();
      qualifyFixture(data);
      const newPlan = prepare(data), transport = simulation(data);
      expect(() => applyHostedMigrationSimulation(newPlan, oldConsent, transport, now)).toThrow('consent-payload-mismatch');
      expect(writes(transport)).toEqual([]);
    }
  });

  it('rejects mismatched expected source identity even when a supplied digest matches the proposal', () => {
    const data = fixture();
    data.expected.identity.sourceSha = 'd'.repeat(40);
    expect(() => prepare(data)).toThrow('identity-mismatch');
  });

  it('checks every endpoint before starting any mutation and invalidates consent on baseline drift', () => {
    const data = fixture(), plan = prepare(data), permit = authorize(plan);
    const transport = simulation(data, [{ call: 2, kind: 'drift', endpointId: 'main', value: { drift: sentinel } }]);
    const result = applyHostedMigrationSimulation(plan, permit, transport, now);
    expect(result.recovery).toMatchObject({
      reason: 'drift', phase: 'preflight', operationId: 'configure-main',
      acknowledged: [], uncertain: [], unattempted: ['configure-actions', 'configure-main'], consentInvalidated: true
    });
    expect(writes(transport)).toEqual([]);
    const restored = simulation(data);
    expect(() => applyHostedMigrationSimulation(plan, permit, restored, now)).toThrow('consent-invalidated');
    expect(writes(restored)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it('read-only drift reporting also prevents later use of the stale plan/consent', () => {
    const data = fixture(), plan = prepare(data), permit = authorize(plan);
    const transport = simulation(data, [{ call: 1, kind: 'drift', endpointId: 'actions', value: {} }]);
    expect(diffHostedMigration(plan, transport, now)).toMatchObject({ status: 'blocked', consentInvalidated: true, mutationCount: 0 });
    expect(() => applyHostedMigrationSimulation(plan, permit, simulation(data), now)).toThrow('consent-invalidated');
  });

  it('rechecks unchanged controls immediately before each write', () => {
    const data = fixture(), plan = prepare(data);
    const transport = simulation(data, [{ call: 4, kind: 'drift', endpointId: 'main', value: { changed: true } }]);
    const result = applyHostedMigrationSimulation(plan, authorize(plan), transport, now);
    expect(result.recovery).toMatchObject({ reason: 'drift', phase: 'precondition', operationId: 'configure-main' });
    expect(writes(transport)).toEqual([]);
  });

  it('simulates a conditional-write race without applying replacement bytes', () => {
    const data = fixture(), plan = prepare(data);
    const transport = simulation(data, [{ call: 5, kind: 'drift', endpointId: 'actions', value: { changed: true } }]);
    const result = applyHostedMigrationSimulation(plan, authorize(plan), transport, now);
    expect(result.operations[0]!.write).toBe('precondition-rejected');
    expect(result.recovery).toMatchObject({
      reason: 'write-precondition-rejected', phase: 'apply', acknowledged: [], uncertain: []
    });
    expect(writes(transport)).toHaveLength(1);
    expect(writes(transport)[0]!.result).toBe('precondition-rejected');
    expect(inspectMigrationSimulation(transport).states[0]!.digest).toBe(canonicalDigest({ changed: true }));
  });

  it('rejects a write when a different protected endpoint drifts after its final precondition read', () => {
    const data = fixture(), plan = prepare(data);
    const transport = simulation(data, [{ call: 5, kind: 'drift', endpointId: 'main', value: { changed: true } }]);
    const result = applyHostedMigrationSimulation(plan, authorize(plan), transport, now);
    expect(result.recovery).toMatchObject({ reason: 'write-precondition-rejected', acknowledged: [], uncertain: [] });
    expect(inspectMigrationSimulation(transport).states[0]!.digest).toBe(canonicalDigest(data.proposal.operations[0]!.before));
    expect(writes(transport)[0]!.result).toBe('precondition-rejected');
  });

  it.each(['write-error-before-effect', 'write-error-after-effect'] as const)(
    'records an unacknowledged write as uncertain for %s, retaining prior effects without rollback', kind => {
      const data = fixture(), plan = prepare(data), permit = authorize(plan);
      const transport = simulation(data, [{ call: 9, kind, diagnostic: sentinel }]);
      const result = applyHostedMigrationSimulation(plan, permit, transport, now);
      expect(result.recovery).toMatchObject({
        reason: 'write-error', phase: 'apply', operationId: 'configure-main',
        acknowledged: ['configure-actions'], verified: ['configure-actions'], uncertain: ['configure-main'], automaticRollback: false
      });
      expect(result.operations[1]).toMatchObject({ write: 'uncertain', verification: 'not-read', observedDigest: null });
      const state = inspectMigrationSimulation(transport);
      expect(state.trace).toHaveLength(9);
      expect(state.states[0]!.digest).toBe(canonicalDigest(data.proposal.operations[0]!.after));
      expect(state.states[1]!.digest).toBe(canonicalDigest(data.proposal.operations[1]![kind === 'write-error-after-effect' ? 'after' : 'before']));
      expect(writes(transport)).toHaveLength(2);
      expect(JSON.stringify({ result, state })).not.toContain('DO_NOT_RETAIN_TRANSPORT_SECRET');
      expect(() => applyHostedMigrationSimulation(plan, permit, transport, now)).toThrow('consent-invalidated');
      const recreatedPlan = prepare(data);
      expect(() => applyHostedMigrationSimulation(recreatedPlan, permit, transport, now)).toThrow('consent-invalidated');
    });

  it('retains an acknowledged but unreadable effect and does not attempt subsequent operations', () => {
    const data = fixture(), plan = prepare(data);
    const transport = simulation(data, [{ call: 6, kind: 'read-error', diagnostic: sentinel }]);
    const result = applyHostedMigrationSimulation(plan, authorize(plan), transport, now);
    expect(result.recovery).toMatchObject({
      reason: 'read-error', phase: 'readback', acknowledged: ['configure-actions'], verified: [],
      uncertain: ['configure-actions'], unattempted: ['configure-main']
    });
    expect(result.operations[0]).toMatchObject({ write: 'acknowledged', verification: 'read-error' });
    expect(writes(transport)).toHaveLength(1);
    expect(inspectMigrationSimulation(transport).states[1]!.digest).toBe(canonicalDigest(data.proposal.operations[1]!.before));
    expect(JSON.stringify(result)).not.toContain('DO_NOT_RETAIN_TRANSPORT_SECRET');
  });

  it('stops on a mismatched readback rather than synthesizing success or restoring older settings', () => {
    const data = fixture(), plan = prepare(data);
    const transport = simulation(data, [{ call: 10, kind: 'drift', endpointId: 'main', value: { diagnostic: sentinel } }]);
    const result = applyHostedMigrationSimulation(plan, authorize(plan), transport, now);
    expect(result).toMatchObject({
      status: 'blocked', recovery: {
        reason: 'readback-mismatch', phase: 'readback', acknowledged: ['configure-actions', 'configure-main'],
        verified: ['configure-actions'], uncertain: ['configure-main']
      }
    });
    expect(writes(transport)).toHaveLength(2);
    expect(inspectMigrationSimulation(transport).trace).toHaveLength(10);
    expect(JSON.stringify(result)).not.toContain('DO_NOT_RETAIN_TRANSPORT_SECRET');
  });

  it('detects drift to earlier acknowledged controls before later operations and during final readback', () => {
    for (const call of [7, 11]) {
      const data = fixture(), plan = prepare(data);
      const transport = simulation(data, [{ call, kind: 'drift', endpointId: 'actions', value: { unrelatedChange: true } }]);
      const result = applyHostedMigrationSimulation(plan, authorize(plan), transport, now);
      expect(result.recovery).toMatchObject({
        phase: call === 7 ? 'precondition' : 'final-readback', operationId: 'configure-actions', uncertain: ['configure-actions']
      });
      expect(writes(transport)).toHaveLength(call === 7 ? 1 : 2);
    }
  });

  it('requires a new reviewed plan and new consent after a partial failure; it does not automatically resume', () => {
    const data = fixture(), plan = prepare(data);
    const transport = simulation(data, [{ call: 9, kind: 'write-error-before-effect', diagnostic: sentinel }]);
    const permit = authorize(plan);
    expect(applyHostedMigrationSimulation(plan, permit, transport, now).status).toBe('blocked');
    data.proposal.operations[0]!.before = structuredClone(data.proposal.operations[0]!.after);
    qualifyFixture(data);
    const recoveryPlan = prepare(data), freshConsent = authorize(recoveryPlan);
    expect(() => applyHostedMigrationSimulation(recoveryPlan, permit, transport, now)).toThrow('consent-payload-mismatch');
    freshConsent.id = 'separately-reviewed-recovery';
    const recovery = applyHostedMigrationSimulation(recoveryPlan, freshConsent, transport, now);
    expect(recovery.status).toBe('completed');
    expect(recovery.operations[0]!.noop).toBe(true);
    expect(writes(transport).map(item => item.endpointId)).toEqual(['actions', 'main', 'main']);
  });

  it('cannot reuse completed consent to reapply settings after a revert to the original before-state', () => {
    const data = fixture(1), plan = prepare(data), permit = authorize(plan);
    const transport = simulation(data, [{ call: 6, kind: 'drift', endpointId: 'actions', value: data.proposal.operations[0]!.before }]);
    expect(applyHostedMigrationSimulation(plan, permit, transport, now).status).toBe('completed');
    const result = applyHostedMigrationSimulation(plan, permit, transport, now);
    expect(result.recovery).toMatchObject({ reason: 'drift', phase: 'preflight' });
    expect(writes(transport)).toHaveLength(1);
  });

  it('does not reuse a consent identity for a different consent record', () => {
    const data = fixture(1), plan = prepare(data), permit = authorize(plan), transport = simulation(data);
    applyHostedMigrationSimulation(plan, permit, transport, now);
    permit.expiresAt = '2026-09-20T12:31:00.000Z';
    expect(() => applyHostedMigrationSimulation(plan, permit, transport, now)).toThrow('consent-id-reused');
  });

  it.each([
    '/orgs/voyager163/actions/permissions', '/repos/other/repository/actions/permissions',
    '/repos/voyager163/liftoff/statuses/abc', '/repos/voyager163/liftoff/check-runs',
    '/repos/voyager163/liftoff/git/refs/heads/main', '/repos/voyager163/liftoff/rulesets',
    '/repos/voyager163/liftoff/branches/main/protection?override=true',
    '/repos/voyager163/liftoff/branches/%6dain/protection',
    '/repos/voyager163/liftoff/branches/../main/protection',
    'https://api.github.com/repos/voyager163/liftoff/actions/permissions'
  ])('rejects unknown, organization, alias or status-writing endpoints %s', path => {
    const data = fixture();
    data.proposal.registry.endpoints[0]!.path = path;
    qualifyFixture(data);
    expect(() => prepare(data)).toThrow('unsupported-endpoint');
  });

  it.each(['DELETE', 'POST', 'GET', 'HEAD', 'put'])('rejects unregistered mutation methods including %s', writeMethod => {
    const data = fixture();
    Object.assign(data.proposal.registry.endpoints[0]!, { writeMethod });
    qualifyFixture(data);
    expect(() => prepare(data)).toThrow('endpoint-method');
  });

  it('rejects organization scope, missing registration coverage, duplicate identities and object deletion', () => {
    const variants: Array<(data: ReturnType<typeof fixture>) => void> = [
      data => Object.assign(data.proposal.registry, { ownerType: 'Organization' }),
      data => Object.assign(data.proposal.registry, { repository: 'some-org/repository' }),
      data => { data.proposal.operations = data.proposal.operations.slice(0, 1); },
      data => { data.proposal.operations[0]!.endpointId = 'unregistered'; },
      data => { data.proposal.operations[1]!.id = data.proposal.operations[0]!.id; },
      data => { data.proposal.operations[1]!.endpointId = data.proposal.operations[0]!.endpointId; },
      data => { data.proposal.registry.endpoints[1]!.path = data.proposal.registry.endpoints[0]!.path; },
      data => { data.proposal.operations[0]!.after = null; },
      data => { data.proposal.identity.event = 'pull_request'; }
    ];
    for (const mutate of variants) {
      const data = fixture();
      mutate(data);
      qualifyFixture(data);
      expect(() => prepare(data)).toThrow(SecurityEvidenceError);
    }
  });

  it('supports only explicitly registered repository endpoint/method pairs, not active payload defaults', () => {
    for (const [path, writeMethod] of [
      ['/repos/voyager163/liftoff', 'PATCH'],
      ['/repos/voyager163/liftoff/rulesets/123', 'PUT'],
      ['/repos/voyager163/liftoff/environments/fixture-only', 'PUT'],
      ['/repos/voyager163/liftoff/actions/permissions/selected-actions', 'PUT'],
      ['/repos/voyager163/liftoff/actions/permissions/workflow', 'PUT'],
      ['/repos/voyager163/liftoff/branches/develop/protection', 'PUT']
    ] as const) {
      const data = fixture(1);
      Object.assign(data.proposal.registry.endpoints[0]!, { path, writeMethod });
      qualifyFixture(data);
      const plan = prepare(data), transport = simulation(data);
      expect(applyHostedMigrationSimulation(plan, authorize(plan), transport, now).status).toBe('completed');
      expect(writes(transport)[0]!.method).toBe(writeMethod);
    }
  });

  it('keeps arbitrary opaque payload/readback prose and transport diagnostics out of public metadata', () => {
    const data = fixture(1);
    data.proposal.operations[0]!.before = { privateFixture: sentinel, generation: 1 };
    data.proposal.operations[0]!.after = { privateFixture: sentinel, generation: 2 };
    data.proposal.operations[0]!.payload = { privateFixture: sentinel };
    qualifyFixture(data);
    const plan = prepare(data), transport = simulation(data);
    const diff = diffHostedMigration(plan, transport, now);
    const result = applyHostedMigrationSimulation(plan, authorize(plan), transport, now);
    expect(JSON.stringify({ metadata: describeHostedMigration(plan), diff, result, transport: inspectMigrationSimulation(transport) }))
      .not.toContain('DO_NOT_RETAIN_TRANSPORT_SECRET');
  });

  it('sanitizes read failures without treating an unreadable snapshot as empty or clean', () => {
    for (const diffOnly of [true, false]) {
      const data = fixture(1), plan = prepare(data);
      const transport = simulation(data, [{ call: 1, kind: 'read-error', diagnostic: sentinel }]);
      const result = diffOnly ? diffHostedMigration(plan, transport, now)
        : applyHostedMigrationSimulation(plan, authorize(plan), transport, now);
      expect(result.status).toBe('blocked');
      expect(JSON.stringify(result)).not.toContain('DO_NOT_RETAIN_TRANSPORT_SECRET');
      expect(writes(transport)).toEqual([]);
    }
  });

  it('rejects external callbacks, forged plan/transport handles and mutation of metadata as authority', () => {
    const data = fixture(), plan = prepare(data), permit = authorize(plan);
    const read = vi.fn(), write = vi.fn();
    const external = { kind: 'in-memory-migration-transport', read, write } as unknown as InMemoryMigrationTransport;
    expect(() => applyHostedMigrationSimulation(plan, permit, external, now)).toThrow('in-memory-transport-required');
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(() => describeHostedMigration({ kind: 'local-migration-plan' })).toThrow('unrecognized-plan');
    expect(() => createMigrationSimulation({
      registry: data.proposal.registry, states: [], faults: [], transport: external
    } as Parameters<typeof createMigrationSimulation>[0])).toThrow('invalid-or-oversized-data');
  });

  it('rejects unknown metadata, accessors, custom serializers, cyclic/oversized JSON and malicious error objects', () => {
    const data = fixture();
    Object.assign(data.proposal, { authorization: sentinel });
    qualifyFixture(data);
    expect(() => prepare(data)).toThrow(SecurityEvidenceError);
    const getter = vi.fn(() => sentinel);
    const hostile = fixture();
    Object.defineProperty(hostile.proposal, 'description', { enumerable: true, get: getter });
    expect(() => prepare(hostile)).toThrow('invalid-or-oversized-data');
    expect(getter).not.toHaveBeenCalled();
    const cyclic = fixture();
    Object.assign(cyclic.proposal.operations[0]!.payload, { cycle: cyclic.proposal });
    expect(() => prepare(cyclic)).toThrow('invalid-or-oversized-data');
    const oversized = fixture();
    oversized.proposal.operations[0]!.payload = { text: 'a'.repeat(65_537) };
    expect(() => prepare(oversized)).toThrow('invalid-or-oversized-data');
    const proxy = new Proxy(fixture().proposal, {
      getPrototypeOf() { throw new SecurityEvidenceError(sentinel); }
    });
    expect(() => prepareHostedMigration(proxy, fixture().expected, now)).toThrow('invalid-or-oversized-data');
    const many = fixture();
    many.proposal.operations = Array(HOSTED_MIGRATION_LIMITS.operations + 1).fill(many.proposal.operations[0]);
    qualifyFixture(many);
    expect(() => prepare(many)).toThrow('invalid-list');
  });

  it('exposes a permanently disabled production boundary with independent authentication prerequisites', () => {
    expect(hostedMigrationProductionBoundary.enabled).toBe(false);
    expect(hostedMigrationProductionBoundary.requirements).toContain('independently-authenticated-exact-payload-bound-owner-authorization');
    expect(hostedMigrationProductionBoundary.requirements).toContain('fresh-authenticated-before-after-readback-and-qualified-conditional-write-semantics');
    expect(Object.isFrozen(hostedMigrationProductionBoundary.requirements)).toBe(true);
    expect(() => applyHostedMigrationProduction()).toThrow('production-disabled-independent-authentication-required');
  });
});
