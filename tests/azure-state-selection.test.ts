import { readFile, unlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeStatePathSelected, planStatePathSelection
} from '../src/application/azure-activation/producer-state-path.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { phaseCapabilities } from '../src/domain/governance/activation/capabilities.js';
import { canonicalApprovalEnvelopeHash } from '../src/domain/governance/activation/approvals.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { captureTreeState } from '../src/init-filesystem.js';
import { activationProducerFixture, producerSubscription, producerTenant } from './helpers/activation-producer-fixture.js';
import type { CommandResult, CommandRunner } from '../src/process-runner.js';
import type { PhaseAdapterExecutionInput } from '../src/governance-activation/transition-ports.js';

const fixtures: Awaited<ReturnType<typeof activationProducerFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });

async function fixture(statePath = 'existing-private') {
  let response = { id: producerSubscription, tenantId: producerTenant, state: 'Enabled', name: 'Fixture subscription' };
  const calls: Parameters<CommandRunner['run']>[] = [];
  let fault: Partial<CommandResult> = {};
  const runner: CommandRunner = {
    async run(command, options) {
      calls.push([command, options]);
      expect(command).toEqual({
        executable: 'az', args: ['account', 'show', '--subscription', producerSubscription, '--output', 'json']
      });
      return { status: 0, stdout: JSON.stringify(response), stderr: '', displayCommand: 'az account show', ...fault };
    }
  };
  const f = await activationProducerFixture('state-path-selected', { statePath }, runner);
  fixtures.push(f);
  const execute = (input: PhaseAdapterExecutionInput) => withProjectMutationLock(f.projectRoot, (lease) =>
    executeStatePathSelected({ ...input, lease }));
  return {
    ...f, calls, execute,
    response: (changed: Partial<typeof response>) => { response = { ...response, ...changed }; },
    fault: (changed: Partial<CommandResult>) => { fault = changed; }
  };
}

describe('production Azure state path selection', () => {
  it.each(['existing-private', 'bootstrap-local'])('binds approved %s selection to actual account readback without claiming a backend proof', async (statePath) => {
    const f = await fixture(statePath);
    const approved = await f.approve();
    const before = await captureTreeState(f.projectRoot);
    expect(f.calls).toEqual([]);
    const outcome = await f.execute(approved);
    expect(outcome).toMatchObject({
      status: 'completed', resultState: 'verified',
      stateOverride: { applicability: { statePath } },
      evidencePayload: {
        kind: 'state-path-selected.v1', statePath, subscriptionId: producerSubscription, tenantId: producerTenant,
        account: { id: producerSubscription, tenantId: producerTenant, state: 'Enabled' }, backendVerified: false
      }
    });
    expect(outcome.completedOperations).toEqual([approved.plan.operations.find((op) => op.actionId === 'azure.state-path.select')]);
    const observed = outcome.evidencePayload as { account: unknown };
    expect(outcome.liveReadback).toEqual([expect.objectContaining({
      resourceId: `/subscriptions/${producerSubscription}`, provider: 'azure',
      sourceDigest: canonicalSha256(observed.account), readbackDigest: canonicalSha256(observed.account)
    })]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]![1]).toMatchObject({ timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024, stream: false });
    expect(approved.inspection.state.applicability.statePath).toBe('none');
    expect(await captureTreeState(f.projectRoot)).toEqual(before);
    expect(outcome.fileMutations).toBeUndefined();
    expect(phaseCapabilities['state-path-selected']).toMatchObject({
      executor: 'built-in', implementation: 'complete', qualification: 'unqualified'
    });
  });

  it('does not reuse a state field as an unreviewed default path choice', async () => {
    const f = await fixture();
    f.inspection.activationInputs!.phases['state-path-selected'] = {};
    f.inspection.state.applicability.statePath = 'existing-private';
    const plan = planStatePathSelection({ inspection: f.inspection, phase: f.inspection.graph.phases.find((phase) => phase.id === 'state-path-selected')!, runner: f.runner, now: f.now });
    expect(plan.operations).toEqual([]);
    expect(plan.blockers?.join(' ')).toContain('explicit');
    expect(f.calls).toEqual([]);
  });

  it('rejects changed choices before touching the provider', async () => {
    const f = await fixture();
    const approved = await f.approve();
    f.inspection.activationInputs!.phases['state-path-selected'] = { statePath: 'bootstrap-local' };
    expect(await f.execute(approved)).toMatchObject({ status: 'blocked', completedOperations: [] });
    expect(f.calls).toEqual([]);
  });

  it('requires the real project lease and private issued approval, not a public JSON envelope', async () => {
    const f = await fixture();
    const approved = await f.approve();
    await expect(executeStatePathSelected(approved)).rejects.toThrow(/cooperating project mutation lease/);
    const envelope = f.inspection.approvals[0]!;
    const privateRecord = await createScopedUserLocalRecordStore(f.projectRoot, 'governance-approval', f.storage)
      .read(canonicalApprovalEnvelopeHash(envelope));
    if (!privateRecord) throw new Error('Real private approval was not issued.');
    await unlink(privateRecord.path);
    await expect(f.execute(approved)).rejects.toThrow(/no project-bound authority/);
    expect(f.calls).toEqual([]);
  });

  it('rejects expired exact authority before account discovery', async () => {
    const f = await fixture();
    const approved = await f.approve();
    await expect(f.execute({ ...approved, clock: () => new Date('2026-09-15T01:00:00.000Z') })).rejects.toThrow(/not current/);
    expect(f.calls).toEqual([]);
  });

  it.each(['subscription', 'tenant', 'disabled', 'incomplete'])('does not produce a choice receipt for %s readback', async (failure) => {
    const f = await fixture();
    const approved = await f.approve();
    if (failure === 'subscription') f.response({ id: producerTenant });
    if (failure === 'tenant') f.response({ tenantId: producerSubscription });
    if (failure === 'disabled') f.response({ state: 'Disabled' });
    if (failure === 'incomplete') f.fault({ outputLimitExceeded: true });
    const before = await readFile(`${f.projectRoot}/governance/activation-state.json`);
    const outcome = await f.execute(approved);
    expect(outcome.status).toBe('blocked');
    expect(outcome.evidencePayload).toBeUndefined();
    expect(outcome.stateOverride).toBeUndefined();
    expect(await readFile(`${f.projectRoot}/governance/activation-state.json`)).toEqual(before);
  });
});
