import { describe, expect, it } from 'vitest';
import {
  buildStateMigrationPlan, buildStateRecoveryPlan, createStateMigrationService, executeStateMigration, executeStateRecovery,
  inspectApprovedState, inspectStateMigration, observeStateMetadata, validateStateMigrationPlan
} from '../src/application/state-migration/index.js';
import {
  StateMigrationError, type StateAuthority, type StateInspectionRecord, type StateMigrationService
} from '../src/domain/repair/stateful.js';
import {
  inspectStateBytes, stateDigest, stateObjectDigest
} from '../src/domain/repair/stateful-invariants.js';
import { protectedStateScope } from '../src/adapters/state/protected-workspace.js';
import {
  context, fixtureScenario, sourceInstances, stateBytes, syntheticStateValue, type FixtureBackend
} from './fixtures/state-migration/fakes.js';

type Scenario = ReturnType<typeof fixtureScenario>;

async function inspected(scenario: Scenario, current = context()) {
  const discovery = await observeStateMetadata(scenario.deps, { context: current, bindings: scenario.bindings, live: true });
  const inspection = await inspectApprovedState(scenario.deps, {
    context: current, bindings: scenario.bindings, discovery, live: true,
    approval: { kind: 'state-read', fingerprint: discovery.fingerprint, expiresAt: discovery.expiresAt }
  });
  return { discovery, inspection };
}

async function reviewed(scenario: Scenario) {
  const { inspection } = await inspected(scenario);
  const plan = await buildStateMigrationPlan(scenario.deps, {
    context: context(), inspectionRef: inspection.inspectionRef, intent: scenario.intent
  });
  expect(plan.blockers).toEqual([]);
  expect(plan.executable).toBe(true);
  return plan;
}

async function execute(scenario: Scenario) {
  const plan = await reviewed(scenario);
  const result = await executeStateMigration(scenario.deps, {
    context: context(), planRef: plan.planRef!,
    approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
  });
  return { plan, result };
}

async function recover(scenario: Scenario, journalRef: string, mode: 'forward' | 'remove-new-destinations' = 'forward') {
  const current = { ...context(), configurationDigest: scenario.writers.configurationDigest };
  const { inspection } = await inspected(scenario, current);
  const recovery = await buildStateRecoveryPlan(scenario.deps, { context: current, journalRef, inspectionRef: inspection.inspectionRef, mode });
  expect(recovery.blockers).toEqual([]);
  expect(recovery.executable).toBe(true);
  const result = await executeStateRecovery(scenario.deps, {
    context: current, recoveryRef: recovery.recoveryRef!,
    approval: { kind: 'state-recovery', fingerprint: recovery.fingerprint!, expiresAt: recovery.expiresAt }
  });
  return { recovery, result };
}

function effects(scenario: Scenario): number {
  return [...scenario.backends.values()].reduce((total, backend) => total + backend.writes + backend.deletes, 0);
}

describe('protected state discovery and exact authority', () => {
  it('provides the coordinator a domain-typed facade without exposing private dependencies', async () => {
    const scenario = fixtureScenario();
    const service: StateMigrationService = createStateMigrationService(scenario.deps);
    expect(Object.isFrozen(service)).toBe(true);
    expect(JSON.stringify(service)).toBe(JSON.stringify({ workspaceRef: scenario.deps.workspace.workspaceRef }));
    const discovery = await service.observeMetadata({ context: context(), bindings: scenario.bindings, live: true });
    const inspection = await service.inspect({
      context: context(), bindings: scenario.bindings, discovery, live: true,
      approval: { kind: 'state-read', fingerprint: discovery.fingerprint, expiresAt: discovery.expiresAt }
    });
    const plan = await service.plan({ context: context(), inspectionRef: inspection.inspectionRef, intent: scenario.intent });
    expect(plan.executable).toBe(true);
    const request = {
      context: context(), planRef: plan.planRef!,
      approval: { kind: 'state-write' as const, fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    };
    expect(await service.validate(request)).toEqual([]);
    expect((await service.execute(request)).status).toBe('verified');
  });

  it('does no provider request without live scope and never obtains state or keys for metadata', async () => {
    const scenario = fixtureScenario();
    scenario.storage.available = false;
    const result = await observeStateMetadata(scenario.deps, { context: context(), bindings: scenario.bindings, live: false });
    expect(result.blockers.map((item) => item.code)).toEqual(['live-scope-required', 'live-scope-required']);
    expect([...scenario.backends.values()].map((backend) => backend.metadataReads)).toEqual([0, 0]);
    const live = await observeStateMetadata(scenario.deps, { context: context(), bindings: scenario.bindings, live: true });
    expect(live.blockers).toEqual([]);
    expect([...scenario.backends.values()].every((backend) => backend.sensitiveReads === 0)).toBe(true);
    expect(scenario.storage.files.size).toBe(0);
  });

  it.each(['access-denied', 'incomplete-observation'] as const)('does not interpret %s as absence', async (code) => {
    const scenario = fixtureScenario();
    scenario.backends.get('source')![code === 'access-denied' ? 'denied' : 'incomplete'] = true;
    const discovery = await observeStateMetadata(scenario.deps, { context: context(), bindings: scenario.bindings, live: true });
    expect(discovery.blockers).toContainEqual({ code, backendRef: stateDigest('source') });
    await expect(inspectApprovedState(scenario.deps, {
      context: context(), bindings: scenario.bindings, discovery, live: true,
      approval: { kind: 'state-read', fingerprint: discovery.fingerprint, expiresAt: discovery.expiresAt }
    })).rejects.toMatchObject({ code: 'approval-mismatch' });
    expect(scenario.backends.get('source')!.sensitiveReads).toBe(0);
  });

  it('requires an exact, current state-read approval before accessing protected payloads', async () => {
    const scenario = fixtureScenario();
    const discovery = await observeStateMetadata(scenario.deps, { context: context(), bindings: scenario.bindings, live: true });
    for (const approval of [
      { kind: 'state-write', fingerprint: discovery.fingerprint, expiresAt: discovery.expiresAt },
      { kind: 'state-read', fingerprint: 'f'.repeat(64), expiresAt: discovery.expiresAt },
      { kind: 'local-repair', fingerprint: discovery.fingerprint, expiresAt: discovery.expiresAt }
    ]) {
      await expect(inspectApprovedState(scenario.deps, {
        context: context(), bindings: scenario.bindings, discovery, live: true, approval: approval as StateAuthority
      })).rejects.toMatchObject({ code: 'state-read-approval-required' });
    }
    expect(scenario.backends.get('source')!.sensitiveReads).toBe(0);
    scenario.now.value = discovery.expiresAt;
    await expect(inspectApprovedState(scenario.deps, {
      context: context(), bindings: scenario.bindings, discovery, live: true,
      approval: { kind: 'state-read', fingerprint: discovery.fingerprint, expiresAt: discovery.expiresAt }
    })).rejects.toMatchObject({ code: 'expired' });
  });

  it('rejects cross-project, changed backend, and changed metadata read receipts', async () => {
    const scenario = fixtureScenario();
    const discovery = await observeStateMetadata(scenario.deps, { context: context(), bindings: scenario.bindings, live: true });
    const approval = { kind: 'state-read' as const, fingerprint: discovery.fingerprint, expiresAt: discovery.expiresAt };
    await expect(inspectApprovedState(scenario.deps, {
      context: { ...context(), projectId: 'other-project' }, bindings: scenario.bindings, discovery, live: true, approval
    })).rejects.toMatchObject({ code: 'approval-mismatch' });
    const mutated = structuredClone(discovery);
    mutated.observations[0].size++;
    await expect(inspectApprovedState(scenario.deps, {
      context: context(), bindings: scenario.bindings, discovery: mutated, live: true, approval
    })).rejects.toMatchObject({ code: 'approval-mismatch' });
    scenario.backends.get('source')!.version++;
    await expect(inspectApprovedState(scenario.deps, {
      context: context(), bindings: scenario.bindings, discovery, live: true, approval
    })).rejects.toMatchObject({ code: 'stale-state' });
    expect(scenario.backends.get('source')!.sensitiveReads).toBe(0);
  });

  it('blocks when private storage is unavailable instead of falling back to plaintext', async () => {
    const scenario = fixtureScenario();
    const discovery = await observeStateMetadata(scenario.deps, { context: context(), bindings: scenario.bindings, live: true });
    scenario.storage.available = false;
    await expect(inspectApprovedState(scenario.deps, {
      context: context(), bindings: scenario.bindings, discovery, live: true,
      approval: { kind: 'state-read', fingerprint: discovery.fingerprint, expiresAt: discovery.expiresAt }
    })).rejects.toMatchObject({ code: 'protected-workspace-required' });
    expect(scenario.backends.get('source')!.sensitiveReads).toBe(0);
  });

  it('allows only metadata and opaque handles in public inspection, plan, execution, and error output', async () => {
    const scenario = fixtureScenario();
    const { discovery, inspection } = await inspected(scenario);
    const plan = await buildStateMigrationPlan(scenario.deps, { context: context(), inspectionRef: inspection.inspectionRef, intent: scenario.intent });
    scenario.events.failAt = 'after-write:target';
    const result = await executeStateMigration(scenario.deps, {
      context: context(), planRef: plan.planRef!,
      approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    });
    const output = JSON.stringify([discovery, inspection, plan, result, scenario.deps.workspace]);
    expect(output).not.toContain(syntheticStateValue);
    expect(output).not.toContain('/synthetic/resource-groups/');
    expect(output).not.toContain('fixture-source-lineage');
    expect(output).not.toContain(context().projectRoot);
    expect(output).not.toContain('SYNTHETIC_NATIVE_PLAN');
    for (const envelope of scenario.storage.files.values()) {
      const text = Buffer.from(envelope).toString('utf8');
      expect(text).not.toContain(syntheticStateValue);
      expect(text).not.toContain('"resources"');
      expect(text).not.toContain('fixture-source-lineage');
    }
  });

  it('withholds malformed provider errors even if they masquerade as a typed state failure', async () => {
    const scenario = fixtureScenario();
    scenario.backends.get('source')!.metadata = async () => {
      throw new StateMigrationError(syntheticStateValue as any);
    };
    const discovery = await observeStateMetadata(scenario.deps, { context: context(), bindings: scenario.bindings, live: true });
    expect(discovery.blockers[0].code).toBe('operation-failed');
    expect(JSON.stringify(discovery)).not.toContain(syntheticStateValue);
  });

  it('does not reuse a read fingerprint or a changed/currently expired plan as write authority', async () => {
    const scenario = fixtureScenario();
    const plan = await reviewed(scenario);
    for (const kind of ['state-read', 'state-recovery', 'local-repair']) {
      const result = await executeStateMigration(scenario.deps, {
        context: context(), planRef: plan.planRef!,
        approval: { kind, fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt } as StateAuthority
      });
      expect(result.exitCode).toBe(1);
      expect(result.blockers).toEqual([{ code: 'approval-mismatch' }]);
    }
    const changed = await validateStateMigrationPlan(scenario.deps, {
      context: { ...context(), artifactDigest: stateDigest('changed') }, planRef: plan.planRef!,
      approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    });
    expect(changed).toEqual([{ code: 'configuration-changed' }]);
    scenario.now.value = plan.expiresAt;
    expect(await validateStateMigrationPlan(scenario.deps, {
      context: context(), planRef: plan.planRef!,
      approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    })).toEqual([{ code: 'expired' }]);
    expect(effects(scenario)).toBe(0);
  });

  it('requires live resource-verification scope even when all state backends are local', async () => {
    const scenario = fixtureScenario('backend-relocation', ['local']);
    const discovery = await observeStateMetadata(scenario.deps, { context: context(), bindings: scenario.bindings, live: false });
    const inspection = await inspectApprovedState(scenario.deps, {
      context: context(), bindings: scenario.bindings, discovery, live: false,
      approval: { kind: 'state-read', fingerprint: discovery.fingerprint, expiresAt: discovery.expiresAt }
    });
    const plan = await buildStateMigrationPlan(scenario.deps, { context: context(), inspectionRef: inspection.inspectionRef, intent: scenario.intent });
    expect(plan.blockers).toEqual([{ code: 'live-scope-required' }]);
    expect(scenario.events.events).not.toContain('native-review');
    expect(effects(scenario)).toBe(0);
  });
});

describe('complete explicit mappings and blocked recipes', () => {
  it.each(['missing', 'duplicate-source', 'duplicate-target', 'wrong-type', 'foreign-backend', 'unmapped-source'] as const)(
    'rejects %s without any migration', async (fault) => {
      const scenario = fixtureScenario('state-partition');
      const { inspection } = await inspected(scenario);
      if (fault === 'missing') scenario.intent.mappings = scenario.intent.mappings.slice(1);
      if (fault === 'duplicate-source') scenario.intent.mappings = [...scenario.intent.mappings, scenario.intent.mappings[0]];
      if (fault === 'duplicate-target') scenario.intent.mappings = scenario.intent.mappings.map((item) => ({ ...item, destinationBackendId: 'dev', destinationAddress: 'azurerm_resource_group.same' }));
      if (fault === 'wrong-type') scenario.intent.mappings = scenario.intent.mappings.map((item) => ({ ...item, destinationAddress: 'azurerm_storage_account.changed' }));
      if (fault === 'foreign-backend') scenario.intent.mappings = scenario.intent.mappings.map((item) => ({ ...item, destinationBackendId: 'unapproved' }));
      if (fault === 'unmapped-source') scenario.intent.mappings = scenario.intent.mappings.map((item) => ({ ...item, sourceAddress: 'azurerm_resource_group.not_in_source' }));
      const plan = await buildStateMigrationPlan(scenario.deps, { context: context(), inspectionRef: inspection.inspectionRef, intent: scenario.intent });
      expect(plan.executable).toBe(false);
      expect(['mapping-incomplete', 'mapping-conflict']).toContain(plan.blockers[0].code);
      expect(effects(scenario)).toBe(0);
    }
  );

  it('does not overwrite or adopt an existing destination', async () => {
    const scenario = fixtureScenario();
    scenario.backends.get('target')!.bytes = stateBytes([]);
    const { inspection } = await inspected(scenario);
    const plan = await buildStateMigrationPlan(scenario.deps, { context: context(), inspectionRef: inspection.inspectionRef, intent: scenario.intent });
    expect(plan.blockers).toEqual([{ code: 'destination-conflict' }]);
    expect(effects(scenario)).toBe(0);
  });

  it('rejects duplicate managed ownership even when the source addresses differ', async () => {
    const scenario = fixtureScenario('state-partition');
    scenario.backends.get('source')!.bytes = stateBytes([
      sourceInstances[0], { ...sourceInstances[1], id: sourceInstances[0].id }
    ]);
    const { inspection } = await inspected(scenario);
    const plan = await buildStateMigrationPlan(scenario.deps, { context: context(), inspectionRef: inspection.inspectionRef, intent: scenario.intent });
    expect(plan.blockers).toEqual([{ code: 'mapping-conflict' }]);
    expect(effects(scenario)).toBe(0);
  });

  it('rejects unsupported state encryption, deposed/tainted objects and provider kinds', async () => {
    const scenario = fixtureScenario();
    const source = scenario.backends.get('source')!;
    const metadata = await source.metadata();
    for (const mutate of [
      (state: any) => { state.version = 5; },
      (state: any) => { state.encrypted_data = 'SYNTHETIC_ENCRYPTED'; },
      (state: any) => { state.resources[0].instances[0].deposed = 'old'; },
      (state: any) => { state.resources[0].instances[0].status = 'tainted'; },
      (state: any) => { state.resources[0].type = 'aws_instance'; }
    ]) {
      const state = JSON.parse(Buffer.from(source.bytes!).toString());
      mutate(state);
      const bytes = Buffer.from(JSON.stringify(state));
      expect(() => inspectStateBytes({ ...metadata, size: bytes.length }, bytes)).toThrow(StateMigrationError);
    }
    await expect(observeStateMetadata(scenario.deps, {
      context: context(), bindings: [{ ...scenario.bindings[0], kind: 's3' } as any], live: true
    })).rejects.toMatchObject({ code: 'unsupported-backend' });
  });

  it('does not treat synthetic qualification as permission for an unqualified native combination', async () => {
    const scenario = fixtureScenario();
    const { inspection } = await inspected(scenario);
    scenario.deps.native.review = async () => { throw new StateMigrationError('unqualified-combination'); };
    const plan = await buildStateMigrationPlan(scenario.deps, { context: context(), inspectionRef: inspection.inspectionRef, intent: scenario.intent });
    expect(plan.blockers).toEqual([{ code: 'unqualified-combination' }]);
    expect(effects(scenario)).toBe(0);
  });

  it('does not offer address refactoring that would write state into an existing project-source binding', async () => {
    const scenario = fixtureScenario('address-refactor', ['local']);
    const source = scenario.bindings[0];
    if (source.kind !== 'local') throw new Error('fixture');
    source.readOnlySource = true;
    const { inspection } = await inspected(scenario);
    const plan = await buildStateMigrationPlan(scenario.deps, { context: context(), inspectionRef: inspection.inspectionRef, intent: scenario.intent });
    expect(plan.blockers).toEqual([{ code: 'unsupported-state' }]);
    expect(effects(scenario)).toBe(0);
  });
});

describe('destination-first state migration and current verification', () => {
  it.each([
    ['address-refactor', ['local']], ['address-refactor', ['azurerm']],
    ['backend-relocation', ['local']], ['backend-relocation', ['local', 'azurerm']],
    ['backend-relocation', ['azurerm', 'local']], ['backend-relocation', ['azurerm']],
    ['state-partition', ['local']], ['state-partition', ['azurerm']],
    ['state-partition', ['local', 'azurerm']], ['state-partition', ['azurerm', 'local']]
  ] as const)('executes %s with explicitly bound %j adapters (synthetic contract test)', async (recipe, kinds) => {
    const scenario = fixtureScenario(recipe, [...kinds]);
    const { result } = await execute(scenario);
    expect(result.blockers).toEqual([]);
    expect(result.status).toBe('verified');
    expect(result.exitCode).toBe(0);
    expect(result.atomicAcrossBackends).toBe(false);
    expect(result.repairScopeComplete).toBe(true);
    expect(result.lifecycle.status).toBe('retained');
    expect(result.lifecycle.notBefore).toBe(scenario.now.value + scenario.intent.retentionMs);
    expect(scenario.writers.inventoryPublications.size).toBe(1);
    expect(scenario.writers.paused).toBe(false);
    expect(scenario.events.events.indexOf('native-destinations')).toBeLessThan(scenario.events.events.indexOf('before-configuration'));
    if (recipe !== 'address-refactor') {
      expect(scenario.backends.get('source')!.bytes).toBeNull();
      expect(scenario.events.events.indexOf('native-destinations')).toBeLessThan(scenario.events.events.indexOf('before-delete:source'));
    }
  });

  it('accounts for explicit preserved source instances during partitioning', async () => {
    const scenario = fixtureScenario('state-partition');
    scenario.intent.destinationBackendIds = ['dev'];
    scenario.intent.mappings = [
      scenario.intent.mappings[0],
      { sourceAddress: sourceInstances[1].address, destinationBackendId: 'source', destinationAddress: sourceInstances[1].address, disposition: 'preserve' }
    ];
    scenario.intent.targetConfigurationRefs = { dev: 'dev-configuration', source: 'preserved-source-configuration' };
    scenario.bindings = scenario.bindings.filter((entry) => entry.id !== 'prod');
    scenario.backends.delete('prod');
    const { result } = await execute(scenario);
    expect(result.status).toBe('verified');
    const source = await scenario.backends.get('source')!.current();
    expect(source.instances.map((instance) => instance.address)).toEqual([sourceInstances[1].address]);
    expect(scenario.backends.get('source')!.deletes).toBe(0);
    expect(scenario.backends.get('source')!.writes).toBe(1);
    expect(scenario.events.events.indexOf('native-destinations')).toBeLessThan(scenario.events.events.indexOf('before-write:source'));
  });

  it.each(['version', 'serial', 'lineage', 'digest'] as const)('blocks changed %s even with a saved write approval', async (field) => {
    const scenario = fixtureScenario();
    const plan = await reviewed(scenario);
    const source = scenario.backends.get('source')!;
    if (field === 'version') source.version++;
    else {
      const text = Buffer.from(source.bytes!).toString();
      source.bytes = Buffer.from(field === 'serial' ? text.replace('"serial":7', '"serial":8')
        : field === 'lineage' ? text.replace('fixture-source-lineage', 'fixture-source-lineagX')
          : text.replace(syntheticStateValue, `${syntheticStateValue.slice(0, -1)}X`));
    }
    const result = await executeStateMigration(scenario.deps, {
      context: context(), planRef: plan.planRef!,
      approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    });
    expect(result.blockers).toEqual([{ code: 'stale-state' }]);
    expect(effects(scenario)).toBe(0);
    expect(scenario.writers.inventoryPublications.size).toBe(0);
  });

  it('blocks writes if a native lock is lost during protected preparation', async () => {
    const scenario = fixtureScenario();
    const plan = await reviewed(scenario);
    scenario.events.onEvent = (event) => {
      if (event === 'native-prepare') scenario.backends.get('source')!.lastLease!.lost = true;
    };
    const result = await executeStateMigration(scenario.deps, {
      context: context(), planRef: plan.planRef!,
      approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    });
    expect(result.blockers).toEqual([{ code: 'lock-lost' }]);
    expect(effects(scenario)).toBe(0);
    expect(scenario.writers.paused).toBe(true);
  });

  it('rejects unapproved resource changes before any backend publication', async () => {
    const scenario = fixtureScenario();
    const plan = await reviewed(scenario);
    scenario.deps.native.prepare = async () => { throw new StateMigrationError('resource-change'); };
    const result = await executeStateMigration(scenario.deps, {
      context: context(), planRef: plan.planRef!,
      approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    });
    expect(result.blockers).toEqual([{ code: 'resource-change' }]);
    expect(effects(scenario)).toBe(0);
    expect(result.checkpoints.some((item) => item.kind === 'backups-verified')).toBe(true);
  });

  it('does not let an injected native implementation mutate the approved scope', async () => {
    const scenario = fixtureScenario();
    const plan = await reviewed(scenario);
    scenario.deps.native.prepare = async (approved) => {
      (approved.intent.destinationBackendIds as string[]).push('unapproved');
      throw new Error('This must never be reached');
    };
    const result = await executeStateMigration(scenario.deps, {
      context: context(), planRef: plan.planRef!,
      approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    });
    expect(result.blockers).toEqual([{ code: 'operation-failed' }]);
    expect(effects(scenario)).toBe(0);
    expect(scenario.writers.inventoryPublications.size).toBe(0);
  });

  it('reverifies encrypted backups immediately before publishing state', async () => {
    const scenario = fixtureScenario();
    const plan = await reviewed(scenario);
    const backups: string[] = [];
    const put = scenario.deps.workspace.put.bind(scenario.deps.workspace);
    scenario.deps.workspace.put = async (...args) => {
      const saved = await put(...args);
      if (args[0] === 'backup') backups.push(saved.ref.split('/').at(-1)!);
      return saved;
    };
    scenario.events.onEvent = (event) => {
      if (event !== 'native-prepare') return;
      for (const id of backups) {
        const bytes = scenario.storage.files.get(id)!;
        const envelope = JSON.parse(Buffer.from(bytes).toString());
        // Corrupt only authenticated storage; no plaintext state is exported.
        const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
        ciphertext[0] ^= 1;
        envelope.ciphertext = ciphertext.toString('base64');
        scenario.storage.files.set(id, Buffer.from(JSON.stringify(envelope)));
      }
    };
    const result = await executeStateMigration(scenario.deps, {
      context: context(), planRef: plan.planRef!,
      approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    });
    expect(result.blockers).toEqual([{ code: 'artifact-integrity' }]);
    expect(effects(scenario)).toBe(0);
  });

  it('does not retire source or publish provenance when destination verification fails', async () => {
    const scenario = fixtureScenario();
    const plan = await reviewed(scenario);
    scenario.events.failAt = 'native-destinations';
    const result = await executeStateMigration(scenario.deps, {
      context: context(), planRef: plan.planRef!,
      approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    });
    expect(result.status).toBe('incomplete');
    expect(scenario.backends.get('target')!.writes).toBe(1);
    expect(scenario.backends.get('source')!.bytes).not.toBeNull();
    expect(scenario.writers.inventoryPublications.size).toBe(0);
    expect(scenario.writers.paused).toBe(true);
  });

  it('inspection of a completed journal is historical, not fresh success', async () => {
    const scenario = fixtureScenario();
    const { result } = await execute(scenario);
    const before = [...scenario.backends.values()].map((backend) => backend.sensitiveReads);
    const inspected = await inspectStateMigration(scenario.deps, {
      context: { ...context(), configurationDigest: scenario.writers.configurationDigest }, journalRef: result.journalRef!
    });
    expect(inspected.repairScopeComplete).toBe(false);
    expect(inspected.blockers).toEqual([{ code: 'verification-incomplete' }]);
    expect([...scenario.backends.values()].map((backend) => backend.sensitiveReads)).toEqual(before);
    expect(effects(scenario)).toBe(2);
  });
});

describe('observed checkpoint recovery, not distributed rollback', () => {
  it.each([
    'before-quiesce', 'after-quiesce', 'acquire:source', 'native-prepare',
    'before-write:target', 'after-write:target', 'native-destinations',
    'before-delete:source', 'after-delete:source', 'native-final',
    'before-configuration', 'after-configuration', 'verify-cutover',
    'before-inventory', 'after-inventory', 'before-resume', 'after-resume'
  ])('recovers forward after %s without blindly replaying state writes', async (failurePoint) => {
    const scenario = fixtureScenario();
    const plan = await reviewed(scenario);
    scenario.events.failAt = failurePoint;
    const partial = await executeStateMigration(scenario.deps, {
      context: context(), planRef: plan.planRef!,
      approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    });
    expect(partial.status).toBe('incomplete');
    const { result } = await recover(scenario, partial.journalRef!);
    expect(result.blockers).toEqual([]);
    expect(result.status).toBe('verified');
    expect(scenario.backends.get('target')!.writes).toBe(1);
    expect(scenario.backends.get('source')!.deletes).toBe(1);
    expect(scenario.writers.inventoryPublications.size).toBe(1);
  });

  it('compensates only newly owned destinations while the unchanged source remains authoritative', async () => {
    const scenario = fixtureScenario('state-partition');
    const plan = await reviewed(scenario);
    scenario.events.failAt = 'after-write:dev';
    const partial = await executeStateMigration(scenario.deps, {
      context: context(), planRef: plan.planRef!,
      approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    });
    const original = Uint8Array.from(scenario.backends.get('source')!.bytes!);
    const { result } = await recover(scenario, partial.journalRef!, 'remove-new-destinations');
    expect(result.status).toBe('compensated');
    expect(result.repairScopeComplete).toBe(false);
    expect(scenario.backends.get('source')!.bytes).toEqual(original);
    expect(scenario.backends.get('source')!.writes).toBe(0);
    expect(scenario.backends.get('dev')!.bytes).toBeNull();
    expect(scenario.backends.get('prod')!.bytes).toBeNull();
    expect(scenario.writers.inventoryPublications.size).toBe(0);
    expect(scenario.writers.paused).toBe(false);
  });

  it('rejects recovery over a newer concurrent state and never restores old serials', async () => {
    const scenario = fixtureScenario();
    const plan = await reviewed(scenario);
    scenario.events.failAt = 'after-write:target';
    const partial = await executeStateMigration(scenario.deps, {
      context: context(), planRef: plan.planRef!,
      approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    });
    const target = scenario.backends.get('target')!;
    target.bytes = stateBytes(sourceInstances, 'fixture-source-lineage', 9);
    target.version++;
    const { inspection } = await inspected(scenario);
    const recovery = await buildStateRecoveryPlan(scenario.deps, {
      context: context(), journalRef: partial.journalRef!, inspectionRef: inspection.inspectionRef, mode: 'forward'
    });
    expect(recovery.blockers).toEqual([{ code: 'recovery-conflict' }]);
    expect(target.writes).toBe(1);
    expect(target.bytes).toEqual(stateBytes(sourceInstances, 'fixture-source-lineage', 9));
  });

  it('requires a fresh recovery fingerprint and protects the journal from concurrent recovery', async () => {
    const scenario = fixtureScenario();
    const plan = await reviewed(scenario);
    scenario.events.failAt = 'after-write:target';
    const partial = await executeStateMigration(scenario.deps, {
      context: context(), planRef: plan.planRef!,
      approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    });
    const { inspection } = await inspected(scenario);
    const recovery = await buildStateRecoveryPlan(scenario.deps, {
      context: context(), journalRef: partial.journalRef!, inspectionRef: inspection.inspectionRef, mode: 'forward'
    });
    const denied = await executeStateRecovery(scenario.deps, {
      context: context(), recoveryRef: recovery.recoveryRef!,
      approval: { kind: 'state-write', fingerprint: recovery.fingerprint!, expiresAt: recovery.expiresAt }
    });
    expect(denied.blockers).toEqual([{ code: 'approval-mismatch' }]);
    const correct = { kind: 'state-recovery' as const, fingerprint: recovery.fingerprint!, expiresAt: recovery.expiresAt };
    const first = await executeStateRecovery(scenario.deps, { context: context(), recoveryRef: recovery.recoveryRef!, approval: correct });
    expect(first.status).toBe('verified');
    const again = await executeStateRecovery(scenario.deps, { context: context(), recoveryRef: recovery.recoveryRef!, approval: correct });
    expect(again.blockers).toEqual([{ code: 'recovery-conflict' }]);
    expect(scenario.backends.get('target')!.writes).toBe(1);
  });

  it('retains the same operation/journal identity when the original approval is replayed', async () => {
    const scenario = fixtureScenario();
    const plan = await reviewed(scenario);
    scenario.events.failAt = 'after-write:target';
    const request = {
      context: context(), planRef: plan.planRef!,
      approval: { kind: 'state-write' as const, fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    };
    const first = await executeStateMigration(scenario.deps, request);
    const repeat = await executeStateMigration(scenario.deps, request);
    expect(repeat.blockers).toEqual([{ code: 'recovery-required' }]);
    expect(repeat.operationRef).toBe(first.operationRef);
    expect(repeat.journalRef).toBe(first.journalRef);
    expect(scenario.backends.get('target')!.writes).toBe(1);
  });

  it('returns a bounded incomplete operation if a registered native capability stops responding', async () => {
    const scenario = fixtureScenario();
    const plan = await reviewed(scenario);
    scenario.deps.operationTimeoutMs = 25;
    scenario.deps.native.prepare = () => new Promise(() => undefined);
    const result = await executeStateMigration(scenario.deps, {
      context: context(), planRef: plan.planRef!,
      approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    });
    expect(result.blockers).toEqual([{ code: 'timeout' }]);
    expect(result.status).toBe('incomplete');
    expect(result.journalRef).toBeTruthy();
    expect(effects(scenario)).toBe(0);
    expect(scenario.writers.paused).toBe(true);
  });

  it('retains backend locks until native termination is proven and then recovers with the original owned handles', async () => {
    const scenario = fixtureScenario();
    const plan = await reviewed(scenario);
    scenario.events.onEvent = (event) => {
      if (event === 'native-prepare') {
        scenario.deps.native.quiesce = async () => { throw new StateMigrationError('process-tree-termination-unproven'); };
      }
    };
    const partial = await executeStateMigration(scenario.deps, {
      context: context(), planRef: plan.planRef!,
      approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    });
    expect(partial.blockers).toEqual([{ code: 'process-tree-termination-unproven' }]);
    const held = [...scenario.backends.values()].map((backend) => backend.lastLease!);
    expect(held.every((lease) => !lease.released)).toBe(true);
    expect(scenario.writers.paused).toBe(true);
    expect(effects(scenario)).toBe(0);
    scenario.events.onEvent = null;
    scenario.deps.native.quiesce = async () => {};
    const recovery = await recover(scenario, partial.journalRef!);
    expect(recovery.result.status).toBe('verified');
    expect(held.every((lease) => lease.released)).toBe(true);
  });

  it('records cancellation at an uncertain write boundary and recovers without another publication', async () => {
    const scenario = fixtureScenario();
    const plan = await reviewed(scenario);
    const abort = new AbortController();
    scenario.events.onEvent = (event) => { if (event === 'after-write:target') abort.abort(); };
    const partial = await executeStateMigration(scenario.deps, {
      context: context(), planRef: plan.planRef!, signal: abort.signal,
      approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    });
    expect(partial.blockers).toEqual([{ code: 'cancelled' }]);
    expect(partial.checkpoints.some((entry) => entry.kind === 'write-intent')).toBe(true);
    expect(scenario.backends.get('target')!.writes).toBe(1);
    scenario.events.onEvent = null;
    const recovery = await recover(scenario, partial.journalRef!);
    expect(recovery.result.status).toBe('verified');
    expect(scenario.backends.get('target')!.writes).toBe(1);
  });

  it('recovers from loss of the post-write journal acknowledgement using the durable prior intent', async () => {
    const scenario = fixtureScenario();
    const plan = await reviewed(scenario);
    scenario.events.onEvent = (event) => {
      if (event === 'after-write:target') scenario.storage.failExchange = true;
    };
    const partial = await executeStateMigration(scenario.deps, {
      context: context(), planRef: plan.planRef!,
      approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    });
    expect(partial.blockers).toEqual([{ code: 'artifact-integrity' }]);
    expect(scenario.backends.get('target')!.writes).toBe(1);
    expect(scenario.backends.get('source')!.bytes).not.toBeNull();
    scenario.storage.failExchange = false;
    scenario.events.onEvent = null;
    const recovered = await recover(scenario, partial.journalRef!);
    expect(recovered.result.status).toBe('verified');
    expect(scenario.backends.get('target')!.writes).toBe(1);
  });
});
