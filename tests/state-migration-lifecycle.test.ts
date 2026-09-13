import { describe, expect, it } from 'vitest';
import {
  buildStateDisposalPlan, buildStateMigrationPlan, disposeRetainedState, executeStateMigration,
  inspectApprovedState, observeStateMetadata
} from '../src/application/state-migration/index.js';
import {
  type RetainedStateKeyBinding, type RetainedStateKeyProvider, type StateMigrationJournal
} from '../src/domain/repair/stateful.js';
import { protectedStateScope } from '../src/adapters/state/protected-workspace.js';
import { context, fixtureScenario } from './fixtures/state-migration/fakes.js';

async function retained() {
  const scenario = fixtureScenario();
  const discovery = await observeStateMetadata(scenario.deps, { context: context(), bindings: scenario.bindings, live: true });
  const inspection = await inspectApprovedState(scenario.deps, {
    context: context(), bindings: scenario.bindings, discovery, live: true,
    approval: { kind: 'state-read', fingerprint: discovery.fingerprint, expiresAt: discovery.expiresAt }
  });
  const plan = await buildStateMigrationPlan(scenario.deps, { context: context(), inspectionRef: inspection.inspectionRef, intent: scenario.intent });
  const migration = await executeStateMigration(scenario.deps, {
    context: context(), planRef: plan.planRef!,
    approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
  });
  expect(migration.status).toBe('verified');
  const current = { ...context(), configurationDigest: scenario.writers.configurationDigest };
  const bytes = await scenario.deps.workspace.get(migration.journalRef!, 'journal', protectedStateScope(current));
  const journal = JSON.parse(Buffer.from(bytes).toString()) as StateMigrationJournal;
  bytes.fill(0);
  return { ...scenario, migration, current, journal };
}

describe('retained state lifecycle independent of migration completion', () => {
  it('does not wait for retention to complete migration, and read-only planning never deletes', async () => {
    const scenario = await retained();
    expect(scenario.migration.repairScopeComplete).toBe(true);
    const before = [...scenario.storage.files.keys()];
    const early = await buildStateDisposalPlan(scenario.deps, { context: scenario.current, journalRef: scenario.migration.journalRef! });
    expect(early.status).toBe('retained');
    expect(early.blockers).toEqual([{ code: 'not-due' }]);
    expect(early.notBefore).toBe(scenario.migration.lifecycle.notBefore);
    expect([...scenario.storage.files.keys()]).toEqual(before);
    scenario.now.value = early.notBefore! + 1;
    const due = await buildStateDisposalPlan(scenario.deps, { context: scenario.current, journalRef: scenario.migration.journalRef! });
    expect(due.status).toBe('due');
    expect(due.executable).toBe(true);
    expect(before.every((id) => scenario.storage.files.has(id))).toBe(true);
  });

  it('removes only approved authenticated backups and preserves the immutable migration journal', async () => {
    const scenario = await retained();
    const originalJournal = await scenario.deps.workspace.get(scenario.migration.journalRef!, 'journal', protectedStateScope(scenario.current));
    const neighbor = await scenario.deps.workspace.put('backup', protectedStateScope(scenario.current), Buffer.from('UNRELATED_SYNTHETIC_BACKUP'));
    scenario.now.value = scenario.migration.lifecycle.notBefore! + 1;
    const plan = await buildStateDisposalPlan(scenario.deps, { context: scenario.current, journalRef: scenario.migration.journalRef! });
    const request = {
      context: scenario.current, disposalRef: plan.disposalRef!,
      approval: { kind: 'state-disposal' as const, fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt! }
    };
    const disposed = await disposeRetainedState(scenario.deps, request);
    expect(disposed.blockers).toEqual([]);
    expect(disposed.status).toBe('disposed');
    for (const artifact of scenario.journal.backups) {
      expect(await scenario.deps.workspace.describe(artifact.ref, 'backup', artifact.scope)).toBeNull();
    }
    expect(await scenario.deps.workspace.describe(neighbor.ref, 'backup', neighbor.scope)).toEqual(neighbor);
    expect(await scenario.deps.workspace.get(scenario.migration.journalRef!, 'journal', protectedStateScope(scenario.current))).toEqual(originalJournal);
    expect((await disposeRetainedState(scenario.deps, request)).status).toBe('disposed');
    expect(scenario.backends.get('target')!.writes).toBe(1);
    expect(scenario.backends.get('source')!.deletes).toBe(1);
  });

  it('refuses wrong hosts, unrelated authority, early execution and stale plans', async () => {
    const scenario = await retained();
    scenario.now.value = scenario.migration.lifecycle.notBefore! + 1;
    const plan = await buildStateDisposalPlan(scenario.deps, { context: scenario.current, journalRef: scenario.migration.journalRef! });
    const request = {
      context: scenario.current, disposalRef: plan.disposalRef!,
      approval: { kind: 'state-disposal' as const, fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt! }
    };
    expect((await disposeRetainedState(scenario.deps, { ...request, approval: { ...request.approval, kind: 'state-write' } })).blockers)
      .toEqual([{ code: 'approval-mismatch' }]);
    expect((await disposeRetainedState(scenario.deps, { ...request, context: { ...scenario.current, hostId: 'wrong-host' } })).status).toBe('blocked');
    scenario.now.value = scenario.migration.lifecycle.notBefore! - 1;
    expect((await disposeRetainedState(scenario.deps, request)).blockers).toEqual([{ code: 'not-due' }]);
    scenario.now.value = plan.expiresAt!;
    expect((await disposeRetainedState(scenario.deps, request)).blockers).toEqual([{ code: 'expired' }]);
    for (const artifact of scenario.journal.backups) expect(await scenario.deps.workspace.describe(artifact.ref, 'backup', artifact.scope)).toEqual(artifact);
  });

  it('requires exact exclusive key ownership and conditionally disposes only separately approved retained keys', async () => {
    const scenario = await retained();
    scenario.now.value = scenario.migration.lifecycle.notBefore! + 1;
    let actual: RetainedStateKeyBinding | null = {
      keyRef: 'synthetic-dedicated-retained-key', version: 'version-7', ownerProjectId: scenario.current.projectId,
      operationId: scenario.journal.operationId, exclusiveArtifactRefs: scenario.journal.backups.map((artifact) => artifact.ref)
    };
    let destroys = 0;
    const provider: RetainedStateKeyProvider = {
      async inspect() { return actual ? structuredClone(actual) : null; },
      async destroy(expected) {
        expect(expected).toEqual(actual);
        destroys++;
        actual = null;
      }
    };
    const shared = { ...actual, exclusiveArtifactRefs: ['unrelated-key-use'] };
    actual = shared;
    const invalid = await buildStateDisposalPlan(scenario.deps, {
      context: scenario.current, journalRef: scenario.migration.journalRef!, keyRefs: ['synthetic-dedicated-retained-key']
    }, provider);
    expect(invalid.blockers).toEqual([{ code: 'ownership-mismatch' }]);
    expect(destroys).toBe(0);
    actual = { ...shared, exclusiveArtifactRefs: scenario.journal.backups.map((artifact) => artifact.ref) };
    const plan = await buildStateDisposalPlan(scenario.deps, {
      context: scenario.current, journalRef: scenario.migration.journalRef!, keyRefs: ['synthetic-dedicated-retained-key']
    }, provider);
    expect(plan.executable).toBe(true);
    const request = {
      context: scenario.current, disposalRef: plan.disposalRef!,
      approval: { kind: 'state-disposal' as const, fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt! }
    };
    const disposed = await disposeRetainedState(scenario.deps, request, provider);
    expect(disposed.status).toBe('disposed');
    expect(destroys).toBe(1);
    expect(JSON.stringify(disposed)).not.toContain('synthetic-dedicated-retained-key');
    expect((await disposeRetainedState(scenario.deps, request, provider)).status).toBe('disposed');
    expect(destroys).toBe(1);
  });
});
