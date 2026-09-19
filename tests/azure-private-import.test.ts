import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FilesystemPrivateImportConfiguration, inspectPrivateImportConfiguration, PrivateBootstrapImportDriver,
  type BootstrapImportMapping, type PrivateImportConfigurationInput
} from '../src/adapters/azure/private-import-opentofu.js';
import { executeRemoteImportVerified, planRemoteImportVerified } from '../src/application/azure-activation/producer-remote-import.js';
import { preserveBootstrapCustody, privateStateContext } from '../src/application/azure-activation/private-custody.js';
import { privateExternalRetention, validatePrivateExternalCustody } from '../src/application/azure-activation/private-custody-lifecycle.js';
import { protectedStateScope } from '../src/adapters/state/protected-workspace.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { stateDigest } from '../src/domain/repair/stateful-invariants.js';
import { evidenceHeaderFor } from '../src/governance-activation/transition-records.js';
import { StateMigrationError, type PrivateStateCommand, type PrivateStateCommandRunner, type StateExecutionContext } from '../src/domain/repair/stateful.js';
import type { PhaseAdapterExecutionInput } from '../src/governance-activation/transition-ports.js';
import { stateBytes, syntheticStateValue } from './fixtures/state-migration/fakes.js';
import {
  custody, encryptedFixtureWorkspace, fixtureBinding, fixtureTime, fixtureVnet, privateActivationFixture, privateTarget
} from './helpers/private-activation-fixture.js';
import { privateStateHttpFixture } from './helpers/private-state-http-fixture.js';

const fixtures: Awaited<ReturnType<typeof privateActivationFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

const rootParts = ['infrastructure', 'opentofu', 'azure', 'bootstrap-import'];
const hcl = `terraform {
  required_version = "=1.12.6"
  required_providers {
    azurerm = {
      source = "hashicorp/azurerm"
      version = "=4.30.0"
    }
  }
}
provider "azurerm" {
  features {}
  resource_provider_registrations = "none"
}
resource "azurerm_virtual_network" "private" {
  name = "repo-vnet"
  location = "eastus"
  resource_group_name = "private-access"
  address_space = ["10.60.0.0/16"]
}
`;

async function fixture(existing = false) {
  const target = privateTarget();
  const f = await privateActivationFixture('remote-import-verified', {});
  fixtures.push(f);
  const held = custody(f.root);
  const { workspace, storage } = encryptedFixtureWorkspace(held);
  await mkdir(path.join(f.projectRoot, ...rootParts), { recursive: true });
  await writeFile(path.join(f.projectRoot, ...rootParts, 'main.tf'), hcl);
  await writeFile(path.join(f.projectRoot, ...rootParts, '.terraform.lock.hcl'), `provider "registry.opentofu.org/hashicorp/azurerm" { version = "4.30.0" }\n`);
  const mirror = path.join(f.root, 'mirror');
  await mkdir(mirror);
  const binary = path.join(mirror, 'terraform-provider-azurerm');
  await writeFile(binary, 'FIXTURE_PROVIDER_BYTES_NOT_EXECUTED', { mode: 0o500 });
  const configuration: PrivateImportConfigurationInput = {
    rootPathParts: rootParts, provider: {
      source: 'registry.opentofu.org/hashicorp/azurerm', version: '4.30.0', mirrorDirectory: mirror,
      binary: { path: binary, sha256: stateDigest('FIXTURE_PROVIDER_BYTES_NOT_EXECUTED') }
    }
  };
  const mappings: BootstrapImportMapping[] = [{ address: 'azurerm_virtual_network.private', importId: fixtureVnet, managedResourceIds: [fixtureVnet] }];
  f.inspection.activationInputs!.phases['remote-import-verified'] = {
    target, custody: held, configuration, mappings, retainedArmResourceIds: [], expiresAt: '2026-09-15T00:30:00.000Z',
    readerReference: {
      keychainPath: path.join(f.root, 'reader.keychain'), service: 'org.liftoff.azure-state-reader.fixture', account: '42',
      tenantId: fixtureBinding.tenantId, subscriptionId: fixtureBinding.subscriptionId,
      clientId: '12345678-1111-4222-8333-555555555555', principalId: '22345678-1111-4222-8333-555555555555'
    }
  };
  const inspected = await inspectPrivateImportConfiguration(f.projectRoot, configuration);
  const input = await f.execution(await planRemoteImportVerified(f.planning()));
  const context = privateStateContext(f.planning(), target.binding, target.hostId, target.backend.ownerId);
  await workspace.assertAvailable(context);
  await preserveBootstrapCustody(workspace, context, held, {
    schemaVersion: 1, kind: 'private-bootstrap-custody', repositoryId: '42', workspaceRef: workspace.workspaceRef,
    planDigest: canonicalSha256('original approved bootstrap'), retainedAt: held.retainedAt, disposeAfter: held.disposeAfter,
    resources: [{ resourceId: fixtureVnet, resourceType: 'Microsoft.Network/virtualNetworks', apiVersion: '2024-05-01', bodyDigest: canonicalSha256({ network: 'fixture' }) }]
  });
  let http: ReturnType<typeof privateStateHttpFixture> | null = null;
  let original = existing ? stateBytes([{ address: mappings[0]!.address, id: mappings[0]!.importId }], 'preserved-original-lineage', 7) : null;
  const commands: PrivateStateCommand[] = [];
  const captures: Uint8Array[] = [];
  const savedPlans = new Map<string, object>();
  const faults = { resourceChange: false, badImport: false, failFinalProof: false, unknownWrite: false,
    staleWrite: false, changedSource: false, denyStateObservation: false };
  let imports = 0, verifications = 0, quiesced = 0;
  const native: PrivateStateCommandRunner = {
    identityDigest: held.tools.tofu.sha256,
    async run(command) {
      commands.push({ ...command, args: [...command.args] });
      const statePath = JSON.parse(await readFile(path.join(command.cwd, 'liftoff-state-backend.tf.json'), 'utf8')).terraform.backend.local.path;
      const bytes = await readFile(statePath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      const current = bytes ? JSON.parse(bytes.toString('utf8')) : null;
      const present = (address: string) => current?.resources.some((resource: any) => `${resource.type}.${resource.name}` === address);
      const result = (exitCode = 0, text = '') => {
        const stdout = Buffer.from(text);
        captures.push(stdout);
        return { exitCode, stdout };
      };
      if (command.args[0] === 'init') return result();
      if (command.args[0] === 'plan') {
        const filename = command.args.find((arg) => arg.startsWith('-out='))!.slice(5);
        const importing = filename.endsWith('/import.tfplan');
        if (importing) imports++;
        else verifications++;
        const fail = !importing && faults.failFinalProof && http?.blob.operationId;
        const missing = mappings.filter((entry) => !present(entry.address));
        const value = {
          format_version: '1.2', terraform_version: '1.12.6', complete: true, errored: false,
          configuration: { root_module: { private_fixture: syntheticStateValue } },
          resource_changes: mappings.map((entry) => ({
            address: entry.address, mode: 'managed', type: entry.address.split('.')[0],
            change: { actions: fail || faults.resourceChange ? ['update'] : ['no-op'],
              ...(importing && !present(entry.address) ? { importing: { id: faults.badImport ? `${entry.importId}-foreign` : entry.importId } } : {}) }
          }))
        };
        savedPlans.set(filename, value);
        await writeFile(filename, JSON.stringify(value), { mode: 0o600 });
        return result(fail || faults.resourceChange || importing && missing.length ? 2 : 0);
      }
      if (command.args[0] === 'show') return result(0, JSON.stringify(savedPlans.get(command.args[2]!)));
      if (command.args[0] === 'apply') {
        const state = current ?? { version: 4, lineage: randomUUID(), serial: 0, outputs: {}, resources: [] };
        for (const entry of mappings) if (!present(entry.address)) {
          state.resources.push(JSON.parse(Buffer.from(stateBytes([{ address: entry.address, id: entry.importId }])).toString()).resources[0]);
        }
        state.serial++;
        state.terraform_version = '1.12.6';
        await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
        return result();
      }
      throw new Error('No unregistered native command is allowed in this fixture.');
    },
    async quiesce() { quiesced++; }
  };
  let currentInput = input;
  let observedJournalRef: string | null = null;
  const runtime = async (selectedContext: StateExecutionContext, _owned: readonly string[], authorize: () => Promise<void>) => ({
    workspace, driver: new PrivateBootstrapImportDriver({
      workspace, runner: native, configurations: new FilesystemPrivateImportConfiguration(f.projectRoot, inspected),
      configuration: inspected, mappings, context: selectedContext, authorize, now: () => fixtureTime.getTime()
    })
  });
  const execute = async (selected: PhaseAdapterExecutionInput = input) => {
    currentInput = selected;
    const result = await withProjectMutationLock(f.projectRoot, (lease) => executeRemoteImportVerified({ ...currentInput, lease }, {
      runtime,
      backend: (effects) => {
        const fresh = privateStateHttpFixture(target, effects);
        if (http) {
          fresh.blob.bytes = http.blob.bytes ? Uint8Array.from(http.blob.bytes) : null;
          fresh.blob.version = http.blob.version; fresh.blob.operationId = http.blob.operationId;
          fresh.blob.calls = http.blob.calls;
        } else fresh.blob.bytes = original ? Uint8Array.from(original) : null;
        fresh.blob.unknownWrite = faults.unknownWrite; fresh.blob.staleWrite = faults.staleWrite;
        http = fresh;
        if (faults.denyStateObservation) fresh.path.backend.metadata = async () => { throw new StateMigrationError('access-denied'); };
        return fresh.path.backend;
      }
    }));
    if (isRecord(result.evidencePayload) && typeof result.evidencePayload.journalRef === 'string') {
      observedJournalRef = result.evidencePayload.journalRef;
    } else {
      const reference = result.cleanupWarnings?.join(' ').match(/state-workspace:[a-f0-9-]{36}\/[a-f0-9-]{36}/u)?.[0];
      if (reference) observedJournalRef = reference;
    }
    return result;
  };
  const journal = async () => {
    if (!observedJournalRef) throw new Error('No fixture import journal was recorded.');
    const scope = protectedStateScope(context);
    const bytes = await workspace.get(observedJournalRef, 'journal', scope);
    try {
      const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (!isRecord(value)) throw new Error('Fixture journal is malformed.');
      return { ref: observedJournalRef, value, scope };
    } finally { bytes.fill(0); }
  };
  return {
    f, input, target, held, workspace, storage, configuration, inspected, mappings, context, commands, captures, faults, execute,
    blob: () => http!.blob, original, counts: () => ({ imports, verifications, quiesced }), journal,
    async changeJournal(change: (value: Record<string, unknown>) => void) {
      const current = await journal();
      const descriptor = await workspace.describe(current.ref, 'journal', current.scope);
      if (!descriptor) throw new Error('Fixture journal unexpectedly disappeared.');
      change(current.value);
      const bytes = Buffer.from(JSON.stringify(current.value));
      try { await workspace.replace(current.ref, 'journal', current.scope, descriptor.digest, bytes); }
      finally { bytes.fill(0); }
    }
  };
}

describe('protected declarative bootstrap import and fresh no-change verification', () => {
  it('links every actual retained artifact through opaque handles without exposing state hashes or invented paths', async () => {
    const f = await fixture(true);
    const result = await f.execute();
    expect(result.status).toBe('completed');
    if (!isRecord(result.evidencePayload)) throw new Error('Missing exact import evidence.');
    const reference = validatePrivateExternalCustody(result.evidencePayload.custody);
    expect(reference).toMatchObject({
      kind: 'protected-external', workspaceRef: f.workspace.workspaceRef,
      retainedAt: f.held.retainedAt, disposeAfter: f.held.disposeAfter,
      keyDisposition: 'retain-preexisting-external-key'
    });
    expect(reference.materialRefs).toHaveLength(4);
    expect(reference.materialRefs.map((ref) => ref.slice(f.workspace.workspaceRef.length + 1)).sort())
      .toEqual([...f.storage.files.keys()].sort());
    expect(result.outputs?.values['backend.custodyHandle']).toBe(reference.handle);
    expect(JSON.stringify(result)).not.toContain(stateDigest(f.original!));
    expect(JSON.stringify({ payload: result.evidencePayload, outputs: result.outputs })).not.toContain(f.held.workspaceRoot);
    expect(result.evidencePayload).not.toHaveProperty('encryptedStatePathParts');
    expect(result.evidencePayload).not.toHaveProperty('encryptionKeyPathParts');
    const count = f.storage.files.size;
    expect((await f.execute()).status).toBe('completed');
    expect(f.storage.files.size).toBe(count);
  });

  it('durably records exact backup and candidate descriptors before protected creation', async () => {
    const f = await fixture(true);
    const put = f.workspace.put.bind(f.workspace);
    let journalRef: string | null = null;
    const observed: string[] = [];
    f.workspace.put = async (purpose, scope, bytes, id) => {
      if (purpose === 'backup' || purpose === 'candidate') {
        if (!journalRef || !id) throw new Error('Material creation has no original private journal or exact ID.');
        const saved = await f.workspace.get(journalRef, 'journal', scope);
        try {
          const value: unknown = JSON.parse(Buffer.from(saved).toString('utf8'));
          if (!isRecord(value) || !Array.isArray(value.materials)) throw new Error('Missing private material pre-record.');
          expect(value.materials).toContainEqual({ state: 'prepared', descriptor: {
            ref: `${f.workspace.workspaceRef}/${id}`, purpose, scope, digest: stateDigest(bytes)
          } });
          observed.push(purpose);
        } finally { saved.fill(0); }
      }
      const result = await put(purpose, scope, bytes, id);
      if (purpose === 'journal') journalRef = result.ref;
      return result;
    };
    expect((await f.execute()).status).toBe('completed');
    expect(observed).toEqual(['backup', 'candidate']);
    expect((await f.journal()).value).toMatchObject({
      schemaVersion: 2, materials: [{ state: 'retained' }, { state: 'retained' }]
    });
  });

  it('preserves the original backup after a lost protected-create return and resolves its exact descriptor without creating another backup', async () => {
    const f = await fixture(true);
    const put = f.workspace.put.bind(f.workspace);
    let loseBackup = true, backups = 0;
    f.workspace.put = async (purpose, scope, bytes, id) => {
      const created = await put(purpose, scope, bytes, id);
      if (purpose === 'backup') {
        backups++;
        if (loseBackup) { loseBackup = false; throw new StateMigrationError('recovery-required'); }
      }
      return created;
    };
    expect((await f.execute()).status).toBe('blocked');
    const original = (await f.journal()).value.original;
    const recovery = await f.f.execution(await planRemoteImportVerified(f.f.planning()), { recovery: true });
    expect((await f.execute(recovery)).status).toBe('completed');
    expect((await f.journal()).value.original).toEqual(original);
    expect(backups).toBe(1);
  });

  it('does not reinterpret an older incomplete private material journal or discover disposable files by scanning', async () => {
    const f = await fixture(true);
    expect((await f.execute()).status).toBe('completed');
    await f.changeJournal((journal) => { journal.schemaVersion = 1; delete journal.materials; });
    const count = f.blob().calls.length;
    const materialIds = [...f.storage.files.keys()].sort();
    const result = await f.execute();
    expect(result.status).toBe('blocked');
    expect(result.blocker).toContain('complete pre-recorded protected material inventory');
    expect(f.blob().calls).toHaveLength(count);
    expect([...f.storage.files.keys()].sort()).toEqual(materialIds);
  });

  it('keeps original external retention dates and disposal status instead of starting a new thirty-day clock', async () => {
    const f = await fixture(true);
    const result = await f.execute();
    if (result.status !== 'completed') throw new Error('No independently verified import result.');
    const record = {
      evidenceId: 'private-import-custody-fixture',
      header: evidenceHeaderFor({ ...f.input, result: 'verified', payload: result.evidencePayload, liveReadback: result.liveReadback }),
      payload: result.evidencePayload, liveReadback: result.liveReadback
    };
    const retention = privateExternalRetention(record);
    expect(retention.retainedAt).toBe(f.held.retainedAt);
    expect(retention.disposeAfter).toBe(f.held.disposeAfter);
    expect(Date.parse(retention.disposeAfter) - Date.parse(retention.retainedAt)).toBe(61 * 86_400_000);
    const disposed = { ...retention, status: 'disposed' as const, disposedAt: f.held.disposeAfter };
    expect(privateExternalRetention(record, disposed)).toEqual(disposed);
    expect(() => privateExternalRetention(record, { ...retention, retainedAt: '2026-09-16T00:00:00.000Z' })).toThrow();
    expect(() => privateExternalRetention(record, { ...disposed, disposedAt: retention.retainedAt })).toThrow();
    expect(() => validatePrivateExternalCustody({ ...retention.externalCustody, encryptedStatePathParts: [['invented']] })).toThrow();
    expect(() => validatePrivateExternalCustody({ ...retention.externalCustody, keyDisposition: 'destroy-key' })).toThrow();
  });

  it('imports only declared existing resource IDs under conditional create/real lease, preserving encrypted state and dates', async () => {
    const f = await fixture();
    const outcome = await f.execute();
    expect(outcome).toMatchObject({
      status: 'completed', evidencePayload: {
        kind: 'remote-import-verified.v1', stateDisposition: 'imported-and-verified',
        noChangeProof: { exitCode: 0, resourceCount: 1 },
        custody: { kind: 'protected-external', retainedAt: f.held.retainedAt, disposeAfter: f.held.disposeAfter },
        atomicAcrossProviders: false
      }
    });
    expect(f.blob().calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toHaveLength(1);
    expect(f.blob().calls.some((call) => call.headers?.['x-ms-lease-action'] === 'acquire')).toBe(true);
    expect(f.blob().calls.some((call) => call.headers?.['x-ms-lease-action'] === 'release')).toBe(true);
    expect(f.blob().leaseId).toBeNull();
    expect(f.counts().imports).toBe(1);
    expect(f.counts().verifications).toBe(2);
    expect((await f.journal()).value).toMatchObject({
      originalRef: null, original: { exists: false, digest: null, lineage: null, serial: null, etag: null, version: null, size: 0 }
    });
    expect(f.commands.every((command) => !command.args.some((arg) => /-force|-target|-replace|-lock=false/.test(arg)))).toBe(true);
    expect(f.commands.filter((command) => command.args[0] === 'apply')).toHaveLength(1);
    expect(f.captures.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
    const publicText = JSON.stringify(outcome);
    expect(publicText).not.toContain(syntheticStateValue);
    expect(publicText).not.toContain(stateDigest(f.blob().bytes!));
    expect(publicText).not.toContain('encryptedStatePathParts');
    for (const bytes of f.storage.files.values()) expect(Buffer.from(bytes).toString()).not.toContain(syntheticStateValue);
    expect((await f.execute()).status).toBe('completed');
    expect(f.blob().calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toHaveLength(1);
    expect(f.counts().imports).toBe(1);
  });

  it('leaves already-imported existing state byte-identical and verifies without a state PUT', async () => {
    const f = await fixture(true);
    const outcome = await f.execute();
    expect(outcome).toMatchObject({ status: 'completed', evidencePayload: { stateDisposition: 'existing-no-change' } });
    expect(Buffer.from(f.blob().bytes!)).toEqual(Buffer.from(f.original!));
    expect(f.blob().calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toHaveLength(0);
    expect(f.commands.some((command) => command.args[0] === 'apply')).toBe(false);
    expect((await f.execute()).status).toBe('completed');
    expect(Buffer.from(f.blob().bytes!)).toEqual(Buffer.from(f.original!));
    expect(JSON.stringify(outcome)).not.toContain(stateDigest(f.original!));
  });

  it.each(['resourceChange', 'badImport'] as const)('rejects %s before state publication or private apply', async (fault) => {
    const f = await fixture();
    f.faults[fault] = true;
    expect((await f.execute()).status).toBe('blocked');
    expect(f.blob().bytes).toBeNull();
    expect(f.blob().calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    expect(f.commands.some((command) => command.args[0] === 'apply')).toBe(false);
  });

  it('preserves a racing existing backend instead of replacing it', async () => {
    const f = await fixture();
    f.faults.staleWrite = true;
    expect((await f.execute()).status).toBe('blocked');
    expect(f.blob().bytes).toBeNull();
    expect(f.blob().calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toHaveLength(1);
    expect(f.blob().calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('never blindly retries an unknown state write; raw state and its hash stay private', async () => {
    const f = await fixture();
    f.faults.unknownWrite = true;
    const outcome = await f.execute();
    expect(outcome.status).toBe('blocked');
    expect(JSON.stringify(outcome)).not.toContain(syntheticStateValue);
    expect(JSON.stringify(outcome)).not.toContain(stateDigest(f.blob().bytes!));
    expect((await f.execute()).status).toBe('blocked');
    expect(f.blob().calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toHaveLength(1);
  });

  it('recovers a known persisted write with fresh approval and a fresh no-change plan, without rewriting state or resetting dates', async () => {
    const f = await fixture();
    f.faults.failFinalProof = true;
    expect((await f.execute()).status).toBe('blocked');
    const preserved = Uint8Array.from(f.blob().bytes!);
    expect((await f.execute()).status).toBe('blocked');
    f.faults.failFinalProof = false;
    const recovery = await f.f.execution(await planRemoteImportVerified(f.f.planning()), { recovery: true });
    const outcome = await f.execute(recovery);
    expect(outcome).toMatchObject({ status: 'completed', evidencePayload: {
      custody: { retainedAt: f.held.retainedAt, disposeAfter: f.held.disposeAfter }
    } });
    expect(f.blob().bytes).toEqual(preserved);
    expect(f.blob().calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toHaveLength(1);
  });

  it('keeps an unobserved original distinct from absence and only observes it after fresh recovery approval with no prior state effects', async () => {
    const f = await fixture();
    f.faults.denyStateObservation = true;
    expect((await f.execute()).status).toBe('blocked');
    expect((await f.journal()).value).toMatchObject({ original: null, originalRef: null, candidate: null, effects: [] });
    expect(f.commands).toHaveLength(0);
    expect((await f.execute()).status).toBe('blocked');
    f.faults.denyStateObservation = false;
    const recovery = await f.f.execution(await planRemoteImportVerified(f.f.planning()), { recovery: true });
    expect((await f.execute(recovery)).status).toBe('completed');
    expect((await f.journal()).value).toMatchObject({ originalRef: null, original: { exists: false, digest: null } });
    expect(f.blob().calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toHaveLength(1);
  });

  it('does not replace a lost original observation with the current already-written state during recovery', async () => {
    const f = await fixture();
    f.faults.failFinalProof = true;
    expect((await f.execute()).status).toBe('blocked');
    const bytes = Uint8Array.from(f.blob().bytes!);
    const calls = f.blob().calls.length;
    await f.changeJournal((journal) => { journal.original = null; journal.originalRef = null; });
    const damaged = (await f.journal()).value;
    f.faults.failFinalProof = false;
    const recovery = await f.f.execution(await planRemoteImportVerified(f.f.planning()), { recovery: true });
    const outcome = await f.execute(recovery);
    expect(outcome.status).toBe('blocked');
    expect(outcome.blocker).toContain('recovery-required');
    expect(f.blob().calls).toHaveLength(calls);
    expect(f.blob().bytes).toEqual(bytes);
    expect((await f.journal()).value).toEqual(damaged);
  });

  it('does not recreate missing original backup material or reset its retention dates', async () => {
    const f = await fixture(true);
    expect((await f.execute()).status).toBe('completed');
    const journal = await f.journal();
    if (typeof journal.value.originalRef !== 'string') throw new Error('The existing original needs a recorded backup.');
    const backup = await f.workspace.describe(journal.value.originalRef, 'backup', journal.scope);
    if (!backup) throw new Error('The fixture original backup was not created.');
    await f.workspace.removeExact(backup);
    const artifactCount = f.storage.files.size;
    const calls = f.blob().calls.length;
    expect((await f.execute()).status).toBe('blocked');
    expect(f.storage.files.size).toBe(artifactCount);
    expect(f.blob().calls).toHaveLength(calls);
    expect((await f.journal()).value).toEqual(journal.value);
  });

  it('rejects changed configuration bytes before provider access', async () => {
    const f = await fixture();
    await writeFile(path.join(f.f.projectRoot, ...rootParts, 'main.tf'), hcl.replace('10.60.0.0/16', '10.61.0.0/16'));
    expect((await f.execute()).status).toBe('blocked');
    expect(f.f.calls).toEqual([]);
    expect(f.commands).toEqual([]);
  });

  it('refuses undeclared or empty import mappings before any provider or private native operation', async () => {
    const f = await fixture();
    const configuration = f.f.inspection.activationInputs!.phases['remote-import-verified']! as Record<string, unknown>;
    configuration.mappings = [];
    expect((await f.execute()).status).toBe('blocked');
    expect(f.f.calls).toEqual([]);
    expect(f.commands).toEqual([]);
  });

  it('does not recreate or reopen material already recorded as disposed', async () => {
    const f = await fixture();
    f.f.inspection.state.bootstrapState = {
      status: 'disposed', remoteImportEvidenceId: 'prior-import', remoteImportEvidenceDigest: 'f'.repeat(64),
      retainedAt: f.held.retainedAt, disposeAfter: f.held.disposeAfter,
      encryptedStatePathParts: [['retained', 'state.sealed']], encryptionKeyPathParts: [['retained', 'key.reference']],
      disposedAt: fixtureTime.toISOString(), deletionEvidenceId: 'prior-disposal'
    };
    expect((await f.execute()).status).toBe('blocked');
    expect(f.commands).toEqual([]);
  });

  it.each([
    ['application resource', `${hcl}\nresource "azurerm_container_app" "app" { name = "not-bootstrap" }\n`],
    ['uninspected module', `${hcl}\nmodule "external" { source = "https://example.invalid/module" }\n`],
    ['external data source', `${hcl}\ndata "external" "program" { program = ["sh","-c","echo no"] }\n`],
    ['provider auto-registration', hcl.replace('resource_provider_registrations = "none"', 'resource_provider_registrations = "all"')],
    ['backend change', hcl.replace('required_version = "=1.12.6"', 'backend "azurerm" {}\n required_version = "=1.12.6"')]
  ])('refuses %s in the import source closure', async (_name, source) => {
    const f = await fixture();
    await writeFile(path.join(f.f.projectRoot, ...rootParts, 'main.tf'), source);
    await expect(inspectPrivateImportConfiguration(f.f.projectRoot, f.configuration)).rejects.toThrow();
    expect(f.commands).toEqual([]);
  });
});
