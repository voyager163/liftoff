import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activationProducerFixture, producerSubscription, producerTenant } from './helpers/activation-producer-fixture.js';
import { AzureArmError, type AzureArmRequest, type AzureArmTransport } from '../src/adapters/azure/activation-rest.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { executeAzureProviderReadiness } from '../src/application/azure-activation/producer-provider.js';
import { inspectProviderSources } from '../src/application/azure-activation/provider-inventory.js';
import { readProviderCheckpoints } from '../src/application/azure-activation/provider-checkpoints.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { phaseInputDigest } from '../src/domain/governance/activation/inputs.js';
import { evidenceHeaderDigest, validateEvidenceFreshness } from '../src/domain/governance/activation/evidence.js';
import { blockedState, evidenceHeaderFor, nextStateForOutcome, writeOutcomeTransaction } from '../src/governance-activation/transition-records.js';
import { readReviewedTransitionPlans } from '../src/governance-activation/proof-records.js';
import { buildSavedTransitionPlan, previewApplyNext } from '../src/governance-activation/transition-planning.js';
import { phaseCapabilities } from '../src/domain/governance/activation/capabilities.js';
import type { CommandRunner } from '../src/process-runner.js';
import type { PhaseAdapterExecutionInput } from '../src/governance-activation/transition-ports.js';
import { providerBootstrapConfiguration } from './helpers/provider-sdk-fixture.js';

const fixtures: Awaited<ReturnType<typeof activationProducerFixture>>[] = [];
const principal = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const sourceRoot = ['infrastructure', 'opentofu', 'azure', 'environments', 'dev'];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });

async function fixture(
  initial = 'NotRegistered', registration = 'register-missing',
  statePath: 'existing-private' | 'bootstrap-local' = 'existing-private'
) {
  let defaultState = initial;
  const states = new Map<string, string>();
  const state = (namespace: string) => states.get(namespace) ?? defaultState;
  const processCalls: string[][] = [];
  const requests: AzureArmRequest[] = [];
  const pollCounts = new Map<string, number>();
  let pollsToReady = 1;
  let lostResponse = false;
  let rejected = false;
  let rejectedNamespace: string | undefined;
  let alteredBeforePost: (() => Promise<void>) | undefined;
  const runner: CommandRunner = {
    async run(command) {
      processCalls.push(command.args);
      if (command.executable !== 'az') throw new Error('No unrelated process is allowed.');
      const namespace = command.args[command.args.indexOf('--namespace') + 1]!;
      const data = command.args[0] === 'account' ?
        { id: producerSubscription, tenantId: producerTenant, state: 'Enabled' } :
        { id: `/subscriptions/${producerSubscription}/providers/${namespace}`, namespace, registrationState: state(namespace) };
      return { status: 0, stdout: JSON.stringify(data), stderr: '', displayCommand: 'bounded provider fixture read' };
    }
  };
  const f = await activationProducerFixture('provider-ready', { rootPathParts: sourceRoot, principalId: principal, registration }, runner);
  fixtures.push(f);
  f.inspection.activationInputs!.phases['state-path-selected'] = { statePath };
  if (statePath === 'bootstrap-local') f.inspection.activationInputs!.phases['bootstrap-local'] = providerBootstrapConfiguration(f.root);
  const sourcePath = path.join(f.projectRoot, ...sourceRoot, 'main.tf');
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, 'resource "azurerm_storage_account" "state" {\n  name = "stfixture"\n}\n');
  await f.refreshInputs();
  let input: PhaseAdapterExecutionInput | undefined;
  const transport: AzureArmTransport = {
    async request(request, binding) {
      requests.push(structuredClone(request));
      expect(binding).toEqual({ subscriptionId: producerSubscription, tenantId: producerTenant, principalId: principal });
      const namespace = request.resourceId.match(/\/providers\/([^/]+)/u)?.[1];
      if (!namespace) throw new Error('Expected an exact namespace endpoint.');
      if (request.method === 'POST') {
        if (!input) throw new Error('Missing approved test input.');
        const operation = input.plan.operations.find((op) => op.inputs.namespace === namespace)!;
        const checkpoint = await readProviderCheckpoints(input, operation, namespace);
        expect(checkpoint?.prepared.clientRequestId).toBe(request.clientRequestId);
        expect(checkpoint?.submitted).toBeNull();
        await alteredBeforePost?.();
        if (rejected && (!rejectedNamespace || rejectedNamespace === namespace)) throw new AzureArmError('provider-response', 'The fixture provider rejected registration.', 403, randomUUID(), true);
        states.set(namespace, 'Registering');
        if (lostResponse) throw new AzureArmError('transport-failure', 'Simulated lost response after actual fixture submission.');
      } else if (state(namespace) === 'Registering') {
        const count = (pollCounts.get(namespace) ?? 0) + 1;
        pollCounts.set(namespace, count);
        if (count >= pollsToReady) states.set(namespace, 'Registered');
      }
      return {
        status: 200, requestId: randomUUID(),
        data: { id: `/subscriptions/${producerSubscription}/providers/${namespace}`, namespace, registrationState: state(namespace) }
      };
    }
  };
  const approve = async () => {
    input = await f.approve();
    input.adapters.azureActivation = { storage: f.storage, transport };
    return input;
  };
  const execute = (approved: PhaseAdapterExecutionInput) => withProjectMutationLock(f.projectRoot,
    (lease) => executeAzureProviderReadiness({ ...approved, lease }));
  return {
    ...f, requests, processCalls, sourcePath, approve, execute,
    setState: (value: string, namespace?: string) => {
      if (namespace) states.set(namespace, value);
      else { defaultState = value; states.clear(); }
    },
    pendingPolls: (value: number) => { pollsToReady = value; },
    loseResponse: () => { lostResponse = true; },
    rejectRequest: (value = true, namespace?: string) => { rejected = value; rejectedNamespace = namespace; },
    beforePost: (hook: () => Promise<void>) => { alteredBeforePost = hook; }
  };
}

describe('real bounded provider registration producer', () => {
  it('declares the implemented producer unqualified and keeps public execution blocked despite complete namespace observations', async () => {
    const f = await fixture('Registered', 'read-only', 'bootstrap-local');
    expect(phaseCapabilities['provider-ready']).toMatchObject({
      executor: 'built-in', implementation: 'complete', qualification: 'unqualified', blockerKind: 'unqualified'
    });
    const preview = await previewApplyNext({ inspection: f.inspection, runner: f.runner, now: f.now, execute: true });
    expect(preview).toMatchObject({ authorized: false, applied: false, reason: 'blocked', noWrites: true });
    expect(preview.blockers.join(' ')).toContain('separately authorized disposable qualification');
    expect(preview.proposedMutations.operations.filter((operation) => operation.actionId === 'azure.provider.ensure-ready')).toHaveLength(3);
    expect(f.requests).toEqual([]);
  });

  it('registers and independently reads every actual HCL and planned bootstrap/runner namespace under the same private approval', async () => {
    const f = await fixture('NotRegistered', 'register-missing', 'bootstrap-local');
    const approved = await f.approve();
    const operations = approved.plan.operations.filter((operation) => operation.actionId === 'azure.provider.ensure-ready');
    expect(operations.map((operation) => operation.inputs.namespace)).toEqual(['GitHub.Network', 'Microsoft.Network', 'Microsoft.Storage']);
    const outcome = await f.execute(approved);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'completed', resultState: 'verified' });
    expect(f.requests.filter((request) => request.method === 'POST').map((request) => request.resourceId)).toEqual([
      `/subscriptions/${producerSubscription}/providers/GitHub.Network/register`,
      `/subscriptions/${producerSubscription}/providers/Microsoft.Network/register`,
      `/subscriptions/${producerSubscription}/providers/Microsoft.Storage/register`
    ]);
    expect(outcome.liveReadback).toHaveLength(3);
    expect(operations.every((operation) => !Object.hasOwn(operation.inputs, 'sourceDigest'))).toBe(true);
    const payload = { ...(outcome.evidencePayload as Record<string, unknown>), planDigest: approved.plan.planDigest, savedPlanDigest: canonicalSha256(approved.plan) };
    const header = evidenceHeaderFor({
      inspection: f.inspection, phase: approved.phase, plan: approved.plan, result: 'verified', now: approved.now,
      payload, liveReadback: outcome.liveReadback
    });
    const proof = validateEvidenceFreshness({ evidenceId: 'complete-provider-inventory', header, payload, liveReadback: outcome.liveReadback }, {
      ...f.inspection.contexts['provider-ready'], reviewedPlans: [approved.plan],
      evidenceReferences: [{ phaseId: 'provider-ready', evidenceId: 'complete-provider-inventory', headerDigest: evidenceHeaderDigest(header), result: 'verified' }]
    });
    expect(proof.valid, JSON.stringify(proof)).toBe(true);
  });

  it('rejects changed SDK resource definitions before any registration access even when their namespace set is unchanged', async () => {
    const f = await fixture('NotRegistered', 'register-missing', 'bootstrap-local');
    const approved = await f.approve();
    const changed = providerBootstrapConfiguration(f.root);
    changed.access.network = { ...changed.access.network, vnetName: 'changed-after-approval' };
    f.inspection.activationInputs!.phases['bootstrap-local'] = changed;
    expect(await f.execute(approved)).toMatchObject({ status: 'blocked', completedOperations: [] });
    expect(f.requests).toEqual([]);
  });

  it('does not register already-ready HCL or SDK namespaces again', async () => {
    const f = await fixture('Registered', 'register-missing', 'bootstrap-local');
    const approved = await f.approve();
    const operations = approved.plan.operations.filter((operation) => operation.actionId === 'azure.provider.ensure-ready');
    expect(operations.map((operation) => operation.inputs.namespace)).toEqual(['GitHub.Network', 'Microsoft.Network', 'Microsoft.Storage']);
    expect(operations.every((operation) => operation.mutationClass === 'azure-read')).toBe(true);
    const outcome = await f.execute(approved);
    expect(outcome).toMatchObject({ status: 'completed', resultState: 'verified' });
    expect(outcome.liveReadback).toHaveLength(3);
    expect(f.requests).toHaveLength(6);
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('derives exact namespaces from actual parsed resources rather than a workload baseline guess', async () => {
    const f = await fixture();
    await writeFile(f.sourcePath, [
      'resource "azurerm_storage_account" "state" {}',
      'resource "azurerm_postgresql_flexible_server" "db" {}',
      'resource "azurerm_redis_cache" "cache" {}',
      'resource "azurerm_servicebus_namespace" "queue" {}',
      'resource "azurerm_role_assignment" "access" {}'
    ].join('\n'));
    const inventory = await inspectProviderSources(f.inspection, sourceRoot);
    expect(inventory.namespaces).toEqual([
      'Microsoft.Authorization', 'Microsoft.Cache', 'Microsoft.DBforPostgreSQL', 'Microsoft.ServiceBus', 'Microsoft.Storage'
    ]);
    expect(inventory.resources).toHaveLength(5);
    expect(inventory.files).toHaveLength(1);
    expect(f.requests).toEqual([]);
  });

  it('uses released private approval and persists the pre-effect record before POST, then independently reads terminal registration', async () => {
    const f = await fixture();
    const approved = await f.approve();
    expect(f.requests).toEqual([]);
    const outcome = await f.execute(approved);
    expect(outcome).toMatchObject({ status: 'completed', resultState: 'verified' });
    expect(f.requests.map((entry) => entry.method)).toEqual(['GET', 'GET', 'POST', 'GET', 'GET']);
    expect(f.requests[2]!.resourceId).toBe(`/subscriptions/${producerSubscription}/providers/Microsoft.Storage/register`);
    const checkpoint = await readProviderCheckpoints(approved, approved.plan.operations[0]!, 'Microsoft.Storage');
    expect(checkpoint?.submitted?.requestId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(checkpoint?.prepared.clientRequestId).not.toBe(checkpoint?.submitted?.requestId);
    expect(outcome.evidencePayload).toMatchObject({ resourceInventoryDigest: expect.any(String), observations: [expect.objectContaining({ state: 'Registered' })] });
    const payload = { ...(outcome.evidencePayload as Record<string, unknown>), planDigest: approved.plan.planDigest, savedPlanDigest: canonicalSha256(approved.plan) };
    const header = evidenceHeaderFor({
      inspection: f.inspection, phase: approved.phase, plan: approved.plan, result: 'verified', now: approved.now,
      payload, liveReadback: outcome.liveReadback
    });
    const next = nextStateForOutcome({
      inspection: f.inspection, phase: approved.phase, plan: approved.plan, resultState: 'verified', now: f.now,
      evidenceReference: { phaseId: 'provider-ready', evidenceId: 'provider-registration', headerDigest: evidenceHeaderDigest(header), result: 'verified' }
    });
    const context = { ...f.inspection.contexts['provider-ready'], reviewedPlans: [approved.plan],
      evidenceReferences: next.phases['provider-ready'].evidence };
    const proof = validateEvidenceFreshness({ evidenceId: 'provider-registration', header, payload, liveReadback: outcome.liveReadback }, context);
    expect(proof.valid, JSON.stringify(proof)).toBe(true);
  });

  it('returns bounded pending operation with a provider-issued ID and never dispatches on readback continuation', async () => {
    const f = await fixture();
    f.pendingPolls(10);
    const approved = await f.approve();
    const first = await f.execute(approved);
    expect(first.status).toBe('pending');
    expect(first.operation).toMatchObject({ provider: 'azure', actionId: 'azure.provider.ensure-ready', status: 'running' });
    expect(f.requests.map((entry) => entry.method)).toEqual(['GET', 'GET', 'POST', 'GET', 'GET', 'GET']);
    const checkpoint = await readProviderCheckpoints(approved, approved.plan.operations[0]!, 'Microsoft.Storage');
    expect(first.operation?.operationId).toBe(checkpoint?.submitted?.requestId);
    f.setState('Registered');
    expect(await f.execute(approved)).toMatchObject({ status: 'completed' });
    expect(f.requests.filter((entry) => entry.method === 'POST')).toHaveLength(1);
  });

  it('preserves a lost-response checkpoint and refuses blind resubmission even when the provider still reports NotRegistered', async () => {
    const f = await fixture();
    f.loseResponse();
    const approved = await f.approve();
    const first = await f.execute(approved);
    expect(first).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('lost response') });
    f.setState('NotRegistered');
    const second = await f.execute(approved);
    expect(second).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('cannot be retried blindly') });
    expect(f.requests.filter((entry) => entry.method === 'POST')).toHaveLength(1);
    const checkpoint = await readProviderCheckpoints(approved, approved.plan.operations[0]!, 'Microsoft.Storage');
    expect(checkpoint?.prepared).toBeDefined();
    expect(checkpoint?.submitted).toBeNull();
    f.setState('Registered');
    expect(await f.execute(approved)).toMatchObject({ status: 'completed' });
    expect(f.requests.filter((entry) => entry.method === 'POST')).toHaveLength(1);
  });

  it('recovers a rejected request only with a new exact private approval and retains both immutable attempts', async () => {
    const f = await fixture();
    f.rejectRequest();
    const original = await f.approve();
    const failure = await f.execute(original);
    expect(failure.status).toBe('blocked');
    const originalOperation = original.plan.operations[0]!;
    const firstCheckpoint = await readProviderCheckpoints(original, originalOperation, 'Microsoft.Storage');
    expect(firstCheckpoint?.settled).toMatchObject({ outcome: 'rejected', status: 403 });
    expect(await f.execute(original)).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('fresh separately approved recovery') });
    expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    const next = blockedState({
      inspection: f.inspection, phase: original.phase, plan: original.plan, now: f.now,
      blocker: failure.blocker!, executionStarted: true, operation: failure.operation
    });
    await writeOutcomeTransaction({
      projectRoot: f.projectRoot, plan: original.plan, nextState: next,
      expectedStateHash: f.inspection.loadedState!.contentHash
    });
    f.inspection.state = next;
    await f.refreshInputs();
    f.inspection.recoverPhase = 'provider-ready';
    f.inspection.readiness.phases['provider-ready'] = { state: 'blocked', plannable: true, blockers: ['Explicit recovery requested.'] };
    f.inspection.contexts['provider-ready'].reviewedPlans = await readReviewedTransitionPlans(f.projectRoot);
    const recovery = await f.approve();
    recovery.recovery = true;
    expect(recovery.plan.recovery).toBe(true);
    expect(recovery.plan.approval.envelopeHash).not.toBe(original.plan.approval.envelopeHash);
    f.rejectRequest(false);
    expect(await f.execute(recovery)).toMatchObject({ status: 'completed' });
    expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(2);
    const finalCheckpoint = await readProviderCheckpoints(recovery, recovery.plan.operations[0]!, 'Microsoft.Storage');
    expect(finalCheckpoint?.prepared.attempt).toBe(1);
    expect(finalCheckpoint?.prepared.clientRequestId).not.toBe(firstCheckpoint?.prepared.clientRequestId);
    expect(finalCheckpoint?.settled?.outcome).toBe('registered');
  });

  it('keeps the original operation-plan pointer when an explicit recovery remains running or blocked', async () => {
    const f = await fixture();
    const original = await f.approve();
    f.inspection.state.phases['provider-ready'].executionPlanDigest = original.plan.planDigest;
    f.inspection.recoverPhase = 'provider-ready';
    f.inspection.readiness.phases['provider-ready'] = { state: 'blocked', plannable: true, blockers: ['Explicit recovery requested.'] };
    f.inspection.contexts['provider-ready'].reviewedPlans = [original.plan];
    const recoveryPlan = await buildSavedTransitionPlan({ inspection: f.inspection, runner: f.runner, now: f.now });
    if (!recoveryPlan) throw new Error('Expected an actual reviewed recovery plan.');
    expect(recoveryPlan.planDigest).not.toBe(original.plan.planDigest);
    const running = nextStateForOutcome({
      inspection: f.inspection, phase: original.phase, plan: recoveryPlan, resultState: 'running', now: f.now
    });
    const blocked = blockedState({
      inspection: f.inspection, phase: original.phase, plan: recoveryPlan, blocker: 'Still unsettled.', now: f.now, executionStarted: true
    });
    expect(running.phases['provider-ready'].executionPlanDigest).toBe(original.plan.planDigest);
    expect(blocked.phases['provider-ready'].executionPlanDigest).toBe(original.plan.planDigest);
  });

  it('performs zero writes for already-registered namespaces, with real readback each time', async () => {
    const f = await fixture('Registered', 'read-only');
    const approved = await f.approve();
    expect(approved.plan.operations[0]?.mutationClass).toBe('azure-read');
    expect(await f.execute(approved)).toMatchObject({ status: 'completed' });
    expect(await f.execute(approved)).toMatchObject({ status: 'completed' });
    expect(f.requests.map((entry) => entry.method)).toEqual(['GET', 'GET', 'GET', 'GET']);
    expect(await readProviderCheckpoints(approved, approved.plan.operations[0]!, 'Microsoft.Storage')).toBeNull();
  });

  it('refuses provider precondition or source changes before a registration write', async () => {
    const changedProvider = await fixture();
    const approved = await changedProvider.approve();
    changedProvider.setState('Registered');
    expect(await changedProvider.execute(approved)).toMatchObject({ status: 'blocked' });
    expect(changedProvider.requests.map((entry) => entry.method)).toEqual(['GET']);
    const changedSource = await fixture();
    const sourcePlan = await changedSource.approve();
    await writeFile(changedSource.sourcePath, 'resource "azurerm_storage_account" "changed" {}\n');
    expect(await changedSource.execute(sourcePlan)).toMatchObject({ status: 'blocked' });
    expect(changedSource.requests).toEqual([]);
  });

  it('retains completed namespace effects when a later exact registration is rejected', async () => {
    const f = await fixture();
    await writeFile(f.sourcePath, 'resource "azurerm_storage_account" "state" {}\nresource "azurerm_redis_cache" "cache" {}\n');
    await f.refreshInputs();
    f.rejectRequest(true, 'Microsoft.Storage');
    const approved = await f.approve();
    const outcome = await f.execute(approved);
    expect(outcome.status).toBe('blocked');
    expect(outcome.completedOperations?.map((op) => op.inputs.namespace)).toEqual(['Microsoft.Cache']);
    expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(2);
    const cache = approved.plan.operations.find((op) => op.inputs.namespace === 'Microsoft.Cache')!;
    const storage = approved.plan.operations.find((op) => op.inputs.namespace === 'Microsoft.Storage')!;
    expect((await readProviderCheckpoints(approved, cache, 'Microsoft.Cache'))?.settled?.outcome).toBe('registered');
    expect((await readProviderCheckpoints(approved, storage, 'Microsoft.Storage'))?.settled?.outcome).toBe('rejected');
  });

  it('checks every namespace precondition before performing the first provider write', async () => {
    const f = await fixture();
    await writeFile(f.sourcePath, 'resource "azurerm_storage_account" "state" {}\nresource "azurerm_redis_cache" "cache" {}\n');
    await f.refreshInputs();
    const approved = await f.approve();
    f.setState('Registering', 'Microsoft.Storage');
    expect(await f.execute(approved)).toMatchObject({ status: 'blocked', completedOperations: [] });
    expect(f.requests.filter((request) => request.method === 'POST')).toEqual([]);
  });

  it('binds provider phase evidence to infrastructure changes but leaves committed Azure isolation intact', () => {
    const snapshot = {
      schemaVersion: 2 as const, project: {}, git: { head: null, branch: null, pushUrls: [] }, baselineSha: 'a'.repeat(64),
      files: [{ path: [...sourceRoot, 'main.tf'].join('/'), digest: 'b'.repeat(64) }]
    };
    const changed = { ...snapshot, files: [{ ...snapshot.files[0]!, digest: 'c'.repeat(64) }] };
    expect(phaseInputDigest('provider-ready', snapshot)).not.toBe(phaseInputDigest('provider-ready', changed));
  });

  it.each([
    'resource "azurerm_new_unmapped_type" "unknown" {}',
    'module "remote" { source = "owner/module/azurerm" }',
    'module "escape" { source = "../../../../../../../outside" }',
    'terraform { required_providers { azurerm = { source = "foreign/not-azure" } } }\nresource "azurerm_storage_account" "state" {}',
    'resource "azurerm_storage_account" "conditional" { count = var.unresolved }'
  ])('blocks unsupported or escaping source without planning any provider request %#', async (content) => {
    const f = await fixture();
    await writeFile(f.sourcePath, `${content}\n`);
    await expect(inspectProviderSources(f.inspection, sourceRoot)).rejects.toThrow();
    expect(f.requests).toEqual([]);
    expect(f.processCalls).toEqual([]);
  });

  it('does not register namespaces for disabled resources or uninstantiated modules', async () => {
    const f = await fixture();
    await writeFile(f.sourcePath, [
      'resource "azurerm_storage_account" "state" {}',
      'resource "azurerm_redis_cache" "disabled" { count = 0 }',
      'module "disabled" {\n  count = 0\n  source = "foreign/unused/azurerm"\n}'
    ].join('\n'));
    expect((await inspectProviderSources(f.inspection, sourceRoot)).namespaces).toEqual(['Microsoft.Storage']);
  });
});
