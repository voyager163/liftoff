import { copyFile, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildStateMigrationPlan, executeStateMigration, inspectApprovedState, observeStateMetadata
} from '../src/application/state-migration/index.js';
import { OpenTofuStateDriver, type StateConfigurationAttestation } from '../src/adapters/state/opentofu.js';
import type { PrivateStateCommand, PrivateStateCommandRunner } from '../src/adapters/state/native-command.js';
import { StateMigrationError } from '../src/domain/repair/stateful.js';
import { assertNoResourceChanges, stateDigest, stateObjectDigest } from '../src/domain/repair/stateful-invariants.js';
import { context, fixtureScenario, sourceInstances, stateBytes, syntheticRoot, type SyntheticInstance } from './fixtures/state-migration/fakes.js';

afterAll(async () => { await rm(syntheticRoot, { recursive: true, force: true }); });

function syntheticInstances(bytes: Uint8Array): { instances: SyntheticInstance[]; serial: number; lineage: string } {
  const raw = JSON.parse(Buffer.from(bytes).toString());
  return {
    serial: raw.serial, lineage: raw.lineage,
    instances: raw.resources.flatMap((resource: any) => resource.instances.map((instance: any) => ({
      address: `${resource.module ? `${resource.module}.` : ''}${resource.type}.${resource.name}${instance.index_key === undefined ? '' : `[${JSON.stringify(instance.index_key)}]`}`,
      id: instance.attributes.id, value: instance.attributes.fixture_value
    })))
  };
}

/** Deterministic command-contract fixture, not an OpenTofu executable or live qualification. */
class SyntheticTofuRunner implements PrivateStateCommandRunner {
  identityDigest = stateDigest('synthetic-opentofu-binary');
  calls: PrivateStateCommand[] = [];
  cachedPaths = new Map<string, string>();
  targetActions: string[] | null = null;
  extraPlannedResource = false;
  async quiesce(): Promise<void> {}
  async run(command: PrivateStateCommand) {
    this.calls.push({ ...command, args: [...command.args], ...(command.stdin ? { stdin: Uint8Array.from(command.stdin) } : {}) });
    const args = command.args;
    const backend = JSON.parse(await readFile(path.join(command.cwd, 'liftoff-state-backend.tf.json'), 'utf8'));
    const statePath: string = backend.terraform.backend.local.path;
    if (args[0] === 'init') {
      if (args.includes('-migrate-state')) {
        expect(command.operation).toBe('transform');
        expect(Buffer.from(command.stdin!).toString()).toBe('yes\n');
        await copyFile(this.cachedPaths.get(command.cwd)!, statePath);
      }
      this.cachedPaths.set(command.cwd, statePath);
      return { exitCode: 0, stdout: Buffer.from('SYNTHETIC_PRIVATE_INIT_OUTPUT') };
    }
    if (args[0] === 'state' && args[1] === 'mv') {
      if (args.includes('-dry-run')) return { exitCode: 0, stdout: Buffer.from('SYNTHETIC_PRIVATE_DRY_RUN') };
      const source = args.find((arg) => arg.startsWith('-state='))!.slice('-state='.length);
      const destination = args.find((arg) => arg.startsWith('-state-out='))?.slice('-state-out='.length) ?? source;
      const before = syntheticInstances(await readFile(source));
      const selected = before.instances.find((instance) => instance.address === args.at(-2))!;
      expect(selected).toBeDefined();
      const remaining = before.instances.filter((instance) => instance !== selected);
      if (destination === source) {
        await writeFile(source, stateBytes([...remaining, { ...selected, address: args.at(-1)! }], before.lineage, before.serial + 1));
      } else {
        const target = await readFile(destination).then(syntheticInstances, () => ({ instances: [] as SyntheticInstance[], lineage: `synthetic-${stateDigest(destination).slice(0, 16)}`, serial: 0 }));
        await writeFile(source, stateBytes(remaining, before.lineage, before.serial + 1));
        await writeFile(destination, stateBytes([...target.instances, { ...selected, address: args.at(-1)! }], target.lineage, target.serial + 1));
      }
      return { exitCode: 0, stdout: Buffer.from('SYNTHETIC_PRIVATE_STATE_MOVE') };
    }
    if (args[0] === 'plan') {
      const state = syntheticInstances(await readFile(statePath));
      const actions = command.cwd.includes('target-prepare') && this.targetActions ? this.targetActions : ['no-op'];
      const resources = state.instances.map((instance) => ({ address: instance.address, values: { id: instance.id } }));
      if (this.extraPlannedResource) resources.push({ address: 'azurerm_resource_group.unapproved', values: { id: '/synthetic/extra' } });
      const shown = {
        format_version: '1.2', complete: true, errored: false,
        resource_changes: state.instances.map((instance) => ({ address: instance.address, mode: 'managed', change: { actions } })),
        planned_values: { root_module: { resources } }, output_changes: {}
      };
      await writeFile(args.find((arg) => arg.startsWith('-out='))!.slice(5), `SYNTHETIC_SAVED_PLAN\n${JSON.stringify(shown)}`);
      return { exitCode: actions[0] === 'no-op' ? 0 : 2, stdout: Buffer.from('SYNTHETIC_SECRET_PROVIDER_DIAGNOSTIC') };
    }
    if (args[0] === 'show') {
      const bytes = await readFile(args.at(-1)!, 'utf8');
      return { exitCode: 0, stdout: Buffer.from(bytes.slice('SYNTHETIC_SAVED_PLAN\n'.length)) };
    }
    if (args[0] === 'apply') return { exitCode: 0, stdout: Buffer.from('SYNTHETIC_PRIVATE_STATE_ONLY_APPLY') };
    throw new Error('Unexpected synthetic native command');
  }
}

function nativeScenario(recipe: Parameters<typeof fixtureScenario>[0]) {
  const scenario = fixtureScenario(recipe, ['azurerm', 'local']);
  const runner = new SyntheticTofuRunner();
  let unsafe = false;
  let unsafeFile: string | null = null;
  const contract = (reference: string): StateConfigurationAttestation => ({
    configurationRef: reference, configurationDigest: stateDigest(reference), artifactDigest: context().artifactDigest,
    backendNeutral: true, providerRegistration: 'disabled', provisioners: [], externalPrograms: [],
    stateFormat: 'opentofu-v4-json',
    uninspectedDataSources: [], unresolvedModules: [],
    providers: [{ source: 'registry.opentofu.org/hashicorp/azurerm', version: '4.45.0', binaryDigest: stateDigest('synthetic-provider') }],
    providerMirrorDirectory: path.join(syntheticRoot, 'synthetic-preinstalled-mirror'),
    moduleDigests: []
  });
  scenario.intent.targetConfigurationDigest = stateObjectDigest(
    Object.values(scenario.intent.targetConfigurationRefs).map((reference) => [reference, stateDigest(reference)]).sort()
  );
  const qualifications: unknown[] = [];
  scenario.deps.native = new OpenTofuStateDriver({
    workspace: scenario.deps.workspace, runner, now: () => scenario.now.value,
    qualification: { async assertQualified(request) { qualifications.push(request); } },
    configurations: {
      async materialize(reference, directory) {
        await writeFile(path.join(directory, 'main.tf'), '# synthetic inspected configuration, not live HCL\n');
        if (unsafeFile) await link(unsafeFile, path.join(directory, 'liftoff.private.tfrc'));
        else await writeFile(path.join(directory, 'liftoff.private.tfrc'), '# synthetic provider mirror contract\n');
        return { ...contract(reference), ...(unsafe ? { externalPrograms: ['unapproved'] as never[] } : {}) };
      },
      async verifyMaterialized(_reference, directory) {
        expect(await readFile(path.join(directory, 'main.tf'), 'utf8')).toContain('synthetic inspected');
      }
    }
  });
  return {
    ...scenario, runner, qualifications, makeUnsafe() { unsafe = true; },
    useUnsafeFile(filename: string) { unsafeFile = filename; }
  };
}

async function nativePlan(scenario: ReturnType<typeof nativeScenario>) {
  const discovery = await observeStateMetadata(scenario.deps, { context: context(), bindings: scenario.bindings, live: true });
  const inspection = await inspectApprovedState(scenario.deps, {
    context: context(), bindings: scenario.bindings, discovery, live: true,
    approval: { kind: 'state-read', fingerprint: discovery.fingerprint, expiresAt: discovery.expiresAt }
  });
  return buildStateMigrationPlan(scenario.deps, { context: context(), inspectionRef: inspection.inspectionRef, intent: scenario.intent });
}

describe('registered native OpenTofu command sequences on protected synthetic copies', () => {
  it.each(['address-refactor', 'backend-relocation', 'state-partition'] as const)('uses only inspection operations while reviewing %s', async (recipe) => {
    const scenario = nativeScenario(recipe);
    const plan = await nativePlan(scenario);
    expect(plan.blockers).toEqual([]);
    expect(plan.executable).toBe(true);
    expect(scenario.runner.calls.length).toBeGreaterThan(0);
    for (const command of scenario.runner.calls) {
      expect(command.operation).toBe('inspect');
      expect(command.args[0]).not.toBe('apply');
      expect(command.args).not.toContain('-migrate-state');
      if (command.args[0] === 'state') expect(command.args).toContain('-dry-run');
    }
    expect([...scenario.backends.values()].every((backend) => backend.writes === 0 && backend.deletes === 0)).toBe(true);
  });

  it.each(['address-refactor', 'backend-relocation', 'state-partition'] as const)('executes tested %s primitives without remote legacy flag misuse', async (recipe) => {
    const scenario = nativeScenario(recipe);
    const plan = await nativePlan(scenario);
    expect(plan.blockers).toEqual([]);
    const reviewCallCount = scenario.runner.calls.length;
    const result = await executeStateMigration(scenario.deps, {
      context: context(), planRef: plan.planRef!,
      approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
    });
    expect(result.blockers).toEqual([]);
    expect(result.status).toBe('verified');
    const calls = scenario.runner.calls.slice(reviewCallCount);
    for (const call of calls) {
      expect(Array.isArray(call.args)).toBe(true);
      expect(call.cwd.startsWith(syntheticRoot)).toBe(true);
      for (const argument of call.args.filter((arg) => /^-state(?:-out)?=/.test(arg))) {
        expect(argument.split('=').slice(1).join('=').startsWith(syntheticRoot)).toBe(true);
        expect(argument).not.toContain('.blob.core.windows.net');
        expect(argument).not.toContain('state-fixtures');
      }
      expect(call.args.some((arg) => ['-force', '-force-copy', '-reconfigure', '-lock=false', 'force-unlock', 'push'].includes(arg))).toBe(false);
    }
    if (recipe === 'backend-relocation') {
      const migration = calls.find((call) => call.args.includes('-migrate-state'))!;
      expect(migration.args[0]).toBe('init');
      expect(Buffer.from(migration.stdin!).toString()).toBe('yes\n');
      expect(calls.some((call) => call.args[0] === 'state')).toBe(false);
    } else {
      const moves = calls.filter((call) => call.args[0] === 'state' && call.args[1] === 'mv');
      expect(moves).toHaveLength(sourceInstances.length);
      expect(moves.every((call) => call.args.includes('-lock=true'))).toBe(true);
      expect(moves.every((call) => call.args.some((arg) => arg.startsWith('-state-out=')))).toBe(recipe === 'state-partition');
    }
    expect(scenario.qualifications.length).toBeGreaterThan(1);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET_PROVIDER_DIAGNOSTIC');
  });

  it.each([['create'], ['update'], ['delete'], ['delete', 'create'], ['create', 'delete']])(
    'rejects native %j effects before applying a private plan or publishing a backend', async (...actions) => {
      const scenario = nativeScenario('state-partition');
      const plan = await nativePlan(scenario);
      expect(plan.executable).toBe(true);
      scenario.runner.targetActions = actions as string[];
      const result = await executeStateMigration(scenario.deps, {
        context: context(), planRef: plan.planRef!,
        approval: { kind: 'state-write', fingerprint: plan.fingerprint!, expiresAt: plan.expiresAt }
      });
      expect(result.blockers).toEqual([{ code: 'resource-change' }]);
      expect([...scenario.backends.values()].every((backend) => backend.writes === 0 && backend.deletes === 0)).toBe(true);
      expect(scenario.runner.calls.some((call) => call.args[0] === 'apply')).toBe(false);
    }
  );

  it('rejects unregistered external data programs before invoking the native planner', async () => {
    const scenario = nativeScenario('state-partition');
    scenario.makeUnsafe();
    const plan = await nativePlan(scenario);
    expect(plan.blockers).toEqual([{ code: 'unsafe-planning-contract' }]);
    expect(scenario.runner.calls).toHaveLength(0);
  });

  it('rejects linked native control files rather than overwriting an unowned neighboring file', async () => {
    const scenario = nativeScenario('backend-relocation');
    await mkdir(syntheticRoot, { recursive: true, mode: 0o700 });
    const neighbor = path.join(syntheticRoot, 'unrelated-native-configuration');
    await writeFile(neighbor, 'SYNTHETIC_UNRELATED_CONFIGURATION');
    scenario.useUnsafeFile(neighbor);
    const plan = await nativePlan(scenario);
    expect(plan.blockers).toEqual([{ code: 'unsafe-path' }]);
    expect(await readFile(neighbor, 'utf8')).toBe('SYNTHETIC_UNRELATED_CONFIGURATION');
    expect(scenario.runner.calls).toHaveLength(0);
  });

  it('rejects an unaccounted planned resource rather than accepting a zero exit', async () => {
    const scenario = nativeScenario('backend-relocation');
    scenario.runner.extraPlannedResource = true;
    const plan = await nativePlan(scenario);
    expect(plan.blockers).toEqual([{ code: 'resource-identity-changed' }]);
  });

  it('does not accept deferred, import, malformed, or output-changing plans as no-change proof', () => {
    for (const plan of [
      { complete: false }, { errored: true }, { deferred_changes: [{}] },
      { action_invocations: [{ type: 'unapproved-provider-action' }] },
      { resource_changes: [{ mode: 'managed', change: { actions: ['read'] } }] },
      { resource_changes: [{ mode: 'managed', change: { actions: ['no-op'], importing: { id: 'not-approved' } } }] },
      { output_changes: { secret: { actions: ['update'] } } }
    ]) expect(() => assertNoResourceChanges(plan, true)).toThrow(StateMigrationError);
    expect(() => assertNoResourceChanges({ resource_changes: [{ mode: 'data', change: { actions: ['read'] } }] })).not.toThrow();
  });
});
