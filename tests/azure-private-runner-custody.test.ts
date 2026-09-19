import path from 'node:path';
import { unlink } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertPrivateRunnerAssignmentCustody, type PrivateRunnerAssignmentCustodyReference
} from '../src/application/azure-activation/producer-runner.js';
import { assertAzurePhaseAuthority } from '../src/application/azure-activation/authority.js';
import {
  createScopedUserLocalRecordStore, nodeUpdatePreviewFileSystem, type ScopedUserLocalRecord
} from '../src/adapters/filesystem/update-previews.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { githubOperation } from '../src/governance-activation/github-config.js';
import type { PhaseAdapterExecutionInput } from '../src/governance-activation/transition-ports.js';
import { privateActivationFixture } from './helpers/private-activation-fixture.js';
import { privateApplicationSourceFixture } from './helpers/private-runner-application-fixture.js';
import { environmentRunnerAssignmentFixture } from './helpers/environment-runner-assignment-fixture.js';

const fixtures: Awaited<ReturnType<typeof privateActivationFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function fixture() {
  const f = await privateActivationFixture('runner-ready', {});
  fixtures.push(f);
  const application = privateApplicationSourceFixture({
    repository: 'owner/repo', repositoryId: 42, runnerGroupName: 'repo-private-group', runnerName: 'repo-private-linux'
  }, 'environment-runtime');
  const assigned = await environmentRunnerAssignmentFixture({
    ...f.planning(), adapters: { azureActivation: { storage: f.storage }, githubActivation: { storage: f.storage } }
  }, application);
  const expected: PrivateRunnerAssignmentCustodyReference = {
    reference: assigned.reference, binding: assigned.binding, sources: [application]
  };
  const operations = createScopedUserLocalRecordStore(f.projectRoot, 'governance-operation', f.storage);
  const approvals = createScopedUserLocalRecordStore(f.projectRoot, 'governance-approval', f.storage);
  const admit = (input = assigned.assignmentInput, reference = expected) =>
    withProjectMutationLock(f.projectRoot, (lease) => assertPrivateRunnerAssignmentCustody({ ...input, lease }, reference, {
      authorize: () => assertAzurePhaseAuthority({ ...input, lease }, input.plan.operations[0]!)
    }));
  const remove = async (record: ScopedUserLocalRecord | null | undefined) => {
    if (!record || !record.path.startsWith(`${f.home}${path.sep}`)) throw new Error('Missing exact owned private fixture metadata.');
    await unlink(record.path);
  };
  return { f, assigned, application, expected, operations, approvals, admit, remove };
}

describe('original private runner assignment custody admission', () => {
  it('joins real original creation, separate assignment, private issuance and exact published source without effects or new records', async () => {
    const f = await fixture();
    const before = await f.operations.readAll();
    const calls = structuredClone(f.assigned.http.calls);
    expect(await f.admit()).toBeUndefined();
    expect(await f.operations.readAll()).toEqual(before);
    expect(f.assigned.http.calls).toEqual(calls);
    expect(f.f.calls).toEqual([]);
    expect(f.assigned.http.calls.filter((call) => call.method === 'POST')).toHaveLength(4);
    expect(f.assigned.http.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('evaluates original runner custody under its own phase while current privately issued authority belongs to dev-proof', async () => {
    const f = await fixture();
    const phase = f.f.inspection.graph.phases.find((entry) => entry.id === 'dev-proof')!;
    const operation = githubOperation({ ...f.f.planning(), phase }, 'github.checks.dev-proof', 'github-workflow-dispatch', {
      purpose: 'isolated-current-authority-admission-without-dispatch'
    });
    const current = await f.f.execution({ operations: [operation] }, { phaseId: 'dev-proof' });
    expect(current.plan.approval.envelopeHash).not.toBe(f.assigned.originInput.plan.approval.envelopeHash);
    expect(current.inspection.approvals).toHaveLength(1);
    const calls = f.assigned.http.calls.length;
    expect(await f.admit(current)).toBeUndefined();
    expect(f.assigned.http.calls).toHaveLength(calls);
  });

  it('rejects a structurally asserted lease outside the real current project lease', async () => {
    const f = await fixture();
    const authorize = vi.fn(async () => {});
    await expect(assertPrivateRunnerAssignmentCustody({
      ...f.assigned.assignmentInput, lease: { async assertHeld() {} }
    }, f.expected, { authorize })).rejects.toThrow('actual current project lease');
    expect(authorize).not.toHaveBeenCalled();
    expect(f.assigned.http.calls.filter((call) => call.method === 'POST')).toHaveLength(4);
  });

  it('refuses expired current authority instead of borrowing the original runner approvals', async () => {
    const f = await fixture();
    const calls = f.assigned.http.calls.length;
    await expect(withProjectMutationLock(f.f.projectRoot, (lease) => assertPrivateRunnerAssignmentCustody({
      ...f.assigned.assignmentInput, lease
    }, f.expected, {
      authorize: async () => { throw new Error('Current phase authority expired.'); }
    }))).rejects.toThrow('Current phase authority expired.');
    expect(f.assigned.http.calls).toHaveLength(calls);
  });

  it.each(['receipt', 'state-reference', 'assignment-plan'] as const)('requires the exact original public %s before private custody can qualify it', async (missing) => {
    const f = await fixture();
    if (missing === 'receipt') f.f.inspection.evidence = [];
    if (missing === 'state-reference') f.f.inspection.contexts['runner-ready'].evidenceReferences = [];
    if (missing === 'assignment-plan') f.f.inspection.contexts['runner-ready'].reviewedPlans = [f.assigned.originInput.plan];
    const calls = f.assigned.http.calls.length;
    await expect(f.admit()).rejects.toThrow();
    expect(f.assigned.http.calls).toHaveLength(calls);
  });

  it.each(['original-approval', 'assignment-approval'] as const)('blocks a retained public receipt when its %s is absent privately', async (missing) => {
    const f = await fixture();
    const plan = missing === 'original-approval' ? f.assigned.originInput.plan : f.assigned.assignmentInput.plan;
    if (!plan.approval.envelopeHash) throw new Error('Original fixture plan has no approval identity.');
    await f.remove(await f.approvals.read(plan.approval.envelopeHash));
    const calls = f.assigned.http.calls.length;
    await expect(f.admit()).rejects.toThrow();
    expect(f.assigned.http.calls).toHaveLength(calls);
  });

  it.each([
    ['network-prepared', 'runner-network-configuration', 'private-access-prepared'],
    ['group-returned', 'runner-group', 'private-access-returned'],
    ['definition-settled', 'runner-hosted-runner', 'private-access-settled'],
    ['assignment-prepared', 'runner-group-assignment', 'private-access-prepared'],
    ['assignment-index', 'runner-group-assignment', 'private-runner-group-revision'],
    ['network-dispatch-prepared', 'runner-workflow-dispatch', 'github-workflow-effect-prepared']
  ] as const)('does not replace missing %s custody with current matching provider names or IDs', async (_name, effect, kind) => {
    const f = await fixture();
    const inventory = (await f.operations.readAll()).records;
    const prepared = inventory.find(({ value }) => isRecord(value) && value.kind === 'private-access-prepared' &&
      isRecord(value.intent) && value.intent.kind === effect);
    const selected = kind === 'private-runner-group-revision' || kind === 'github-workflow-effect-prepared'
      ? inventory.find(({ value }) => isRecord(value) && value.kind === kind)
      : kind === 'private-access-prepared' ? prepared
        : inventory.find(({ value }) => isRecord(value) && value.kind === kind &&
          value.preparedDigest === canonicalSha256(prepared?.value));
    await f.remove(selected);
    const calls = f.assigned.http.calls.length;
    await expect(f.admit()).rejects.toThrow();
    expect(f.assigned.http.calls).toHaveLength(calls);
    expect(f.assigned.http.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('retains an unknown assignment effect and rejects admission without another provider request', async () => {
    const f = await fixture();
    const inventory = (await f.operations.readAll()).records;
    const prepared = inventory.find(({ value }) => isRecord(value) && value.kind === 'private-access-prepared' &&
      isRecord(value.intent) && value.intent.kind === 'runner-group-assignment');
    if (!prepared) throw new Error('Actual fixture assignment pre-effect custody is missing.');
    for (const record of inventory) if (isRecord(record.value) &&
      ['private-access-returned', 'private-access-settled'].includes(String(record.value.kind)) &&
      record.value.preparedDigest === canonicalSha256(prepared.value)) await f.remove(record);
    const before = await f.operations.readAll();
    const calls = f.assigned.http.calls.length;
    await expect(f.admit()).rejects.toThrow('unresolved provider effect');
    expect(await f.operations.readAll()).toEqual(before);
    expect(f.assigned.http.calls).toHaveLength(calls);
  });

  it.each(['groupId', 'definitionId', 'networkConfigurationId'] as const)('refuses a substituted %s despite original source and group names', async (field) => {
    const f = await fixture();
    const expected = structuredClone(f.expected);
    if (field === 'networkConfigurationId') expected.binding.networkConfigurationId = 'foreign-network';
    else expected.binding[field] = 999;
    const calls = f.assigned.http.calls.length;
    await expect(f.admit(undefined, expected)).rejects.toThrow('original runner receipt and plan');
    expect(f.assigned.http.calls).toHaveLength(calls);
  });

  it('requires the exact original source declaration rather than a same-name future dispatcher', async () => {
    const f = await fixture();
    const source = { ...f.application, actorId: 999 };
    const calls = f.assigned.http.calls.length;
    await expect(f.admit(undefined, { ...f.expected, sources: [source] })).rejects.toThrow('exact published application source');
    expect(f.assigned.http.calls).toHaveLength(calls);
  });

  it.each(['gap', 'overflow'] as const)('blocks the complete private revision inventory on %s without changing original records', async (fault) => {
    const f = await fixture();
    const revision = (await f.operations.readAll()).records.find(({ value }) =>
      isRecord(value) && value.kind === 'private-runner-group-revision');
    if (!revision || !isRecord(revision.value)) throw new Error('Missing actual retained revision.');
    const original = structuredClone(revision);
    const sequences = fault === 'gap' ? [2] : Array.from({ length: 32 }, (_, i) => i + 1);
    for (const sequence of sequences) await f.operations.write(canonicalSha256({
      kind: 'private-runner-group-revision/1', repositoryId: f.expected.binding.repositoryId,
      organizationId: f.expected.binding.organizationId, groupId: f.expected.binding.groupId, sequence
    }), { ...revision.value, sequence });
    const before = await f.operations.readAll();
    const calls = f.assigned.http.calls.length;
    await expect(f.admit()).rejects.toThrow(fault === 'gap' ? 'gap or an unindexed record' : 'thirty-two retained revisions');
    expect((await f.operations.readAll()).records.find((record) => record.path === original.path)).toEqual(original);
    expect(await f.operations.readAll()).toEqual(before);
    expect(f.assigned.http.calls).toHaveLength(calls);
  });

  it('refuses incomplete selected custom-filesystem enumeration without a Node fallback', async () => {
    const f = await fixture();
    const storage = { ...f.f.storage, fileSystem: { ...nodeUpdatePreviewFileSystem, openDirectory: undefined } };
    const input: PhaseAdapterExecutionInput = {
      ...f.assigned.assignmentInput, adapters: {
        azureActivation: { storage }, githubActivation: { storage }
      }
    };
    const calls = f.assigned.http.calls.length;
    await expect(f.admit(input)).rejects.toThrow('private metadata inventory');
    expect(f.assigned.http.calls).toHaveLength(calls);
  });

  it('blocks at the exact ten-second custody deadline before further metadata or provider access', async () => {
    const f = await fixture();
    const calls = f.assigned.http.calls.length;
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    await expect(withProjectMutationLock(f.f.projectRoot, (lease) => assertPrivateRunnerAssignmentCustody({
      ...f.assigned.assignmentInput, lease
    }, f.expected, { authorize: async () => { time = 10_000; } }))).rejects.toThrow('ten-second bound');
    expect(f.assigned.http.calls).toHaveLength(calls);
  });
});
