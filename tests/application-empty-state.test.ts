import path from 'node:path';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { captureStateExecutable, inspectNativeLocalStateTools, nativeStateHostId } from '../src/adapters/state/native-system.js';
import { stopOwnedStateProcessesIn } from '../src/adapters/state/owned-process.js';
import { protectedStateScope } from '../src/adapters/state/protected-workspace.js';
import { stateDigest } from '../src/domain/repair/stateful-invariants.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import type { AzureArmTransport } from '../src/adapters/azure/activation-rest.js';
import type { PhaseAdapterExecutionInput, PhasePlanBuild } from '../src/governance-activation/transition-ports.js';
import type { TransitionOperation } from '../src/domain/governance/activation/types.js';
import type { ApplicationPrivateIntent } from '../src/application/azure-activation/application-private-contracts.js';
import type { ApplicationPrivateAdapters } from '../src/adapters/azure/application-private-runtime.js';
import {
  applicationPrivateContext
} from '../src/application/azure-activation/application-private-inputs.js';
import {
  applicationEmptyStateCoordinatorSeams,
  createCandidateEmptyState,
  readCandidateEmptyState,
  executeApplicationEmptyState,
  isApplicationEmptyStateOperation,
  planApplicationEmptyState
} from '../src/application/azure-activation/application-empty-state.js';
import {
  applicationEmptyStateProtocol,
  ApplicationEmptyStateCheckpointStore, ApplicationEmptyStateJournalHandle
} from '../src/application/azure-activation/application-empty-state-checkpoints.js';
import {
  custody,
  encryptedFixtureWorkspace,
  fixtureBinding,
  fixtureTime,
  privateActivationFixture,
  privateTarget
} from './helpers/private-activation-fixture.js';
import {
  privateStateHttpFixture,
  PrivateBlobHttpFixture
} from './helpers/private-state-http-fixture.js';

const fixtures: Awaited<ReturnType<typeof privateActivationFixture>>[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const fixture of fixtures.splice(0)) {
    await stopOwnedStateProcessesIn(fixture.root);
    await fixture.cleanup();
  }
});

async function setupFixture(nativeTofu?: string, nativeFault?: string) {
  const f = await privateActivationFixture('application-prerequisites-ready', {});
  fixtures.push(f);
  const held = custody(f.root);
  held.tools.hostId = nativeStateHostId();
  await mkdir(held.workspaceRoot, { recursive: true, mode: 0o700 });
  const nativeRoot = path.join(f.root, 'native');
  await mkdir(nativeRoot, { mode: 0o700 });
  const node = await realpath(process.execPath);

  const tofuScript = `#!${node}
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const fault = ${JSON.stringify(nativeFault ?? null)};
fs.appendFileSync(new URL('./invocations.jsonl', import.meta.url), JSON.stringify(args) + '\\n');
if (args[0] === 'version') {
  process.stdout.write(JSON.stringify({
    terraform_version: '1.12.6',
    platform: ${JSON.stringify(`darwin_${process.arch === 'arm64' ? 'arm64' : 'amd64'}`)}
  }));
  process.exit(0);
}
const workspace = 'liftoff-initial-empty';
const statePath = path.join(process.cwd(), 'terraform.tfstate.d', workspace, 'terraform.tfstate');
if (args[0] === 'init') process.exit(0);
if (args[0] === 'workspace') {
  fs.mkdirSync('.terraform', { mode: 0o700 });
  fs.writeFileSync('.terraform/environment', workspace);
} else if (args[0] === 'plan') {
  if (fault === 'native-failure') process.exit(1);
  fs.writeFileSync('empty.tfplan', JSON.stringify({
    format_version: '1.2', terraform_version: '1.12.6', planned_values: { root_module: {} },
    ...(fault === 'resource-change' ? { resource_changes: [{}] } : {}),
    ...(fault === 'resource-drift' ? { resource_drift: [{}] } : {}),
    ...(fault === 'deferred-change' ? { deferred_changes: [{}] } : {}),
    ...(fault === 'output-change' ? { output_changes: { unexpected: {} } } : {})
  }));
  if (fault === 'extra-configuration') fs.writeFileSync('foreign.tf', 'resource "unexpected" "effect" {}');
} else if (args[0] === 'show') {
  process.stdout.write(fs.readFileSync('empty.tfplan'));
  if (fault === 'changed-plan') fs.appendFileSync('empty.tfplan', 'changed');
} else if (args[0] === 'apply') {
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath, JSON.stringify({
    version: 4, terraform_version: '1.12.6', serial: 1,
    lineage: '88888888-7777-4666-8555-444444444444', outputs: {}, resources: [], check_results: null
  }, null, 2) + '\\n', { mode: 0o600 });
} else if (args[0] === 'state') {
  if (fault === 'readback-mismatch') process.stdout.write('{}');
  else process.stdout.write(fs.readFileSync(statePath));
} else process.exit(1);
process.exit(0);
`;
  const pythonScript = `#!${node}
process.stdout.write(JSON.stringify({ implementation: 'CPython', version: '3.14.0' }));
`;

  const tofuPath = path.join(nativeRoot, 'tofu');
  const pythonPath = path.join(nativeRoot, 'python');
  await writeFile(tofuPath, tofuScript, { mode: 0o500 });
  await writeFile(pythonPath, pythonScript, { mode: 0o500 });
  held.tools.tofu = { path: tofuPath, sha256: stateDigest(tofuScript) };
  if (nativeTofu) held.tools.tofu = await captureStateExecutable(nativeTofu);
  held.tools.python = { path: pythonPath, sha256: stateDigest(pythonScript) };

  const providerDirectory = path.join(
    nativeRoot, 'mirror', 'registry.opentofu.org', 'hashicorp', 'azurerm', '4.30.0',
    `darwin_${process.arch === 'arm64' ? 'arm64' : 'amd64'}`
  );
  await mkdir(providerDirectory, { recursive: true, mode: 0o700 });
  const providerPath = path.join(providerDirectory, 'terraform-provider-azurerm_v4.30.0');
  await writeFile(providerPath, 'ISOLATED_PROVIDER_PACKAGE_NEVER_EXECUTED', { mode: 0o500 });
  const provider = {
    source: 'registry.opentofu.org/hashicorp/azurerm' as const,
    version: '4.30.0',
    mirrorDirectory: path.join(nativeRoot, 'mirror'),
    binary: { path: providerPath, sha256: stateDigest('ISOLATED_PROVIDER_PACKAGE_NEVER_EXECUTED') }
  };

  const { workspace, storage } = encryptedFixtureWorkspace(held);
  const variableId = randomUUID();
  const target = { ...privateTarget(), hostId: held.tools.hostId };
  const rootParts = ['infrastructure', 'opentofu', 'azure', 'environments', 'dev'];
  const moduleParts = ['infrastructure', 'opentofu', 'azure', 'modules', 'core'];

  const intent: ApplicationPrivateIntent = {
    schemaVersion: 1,
    scope: 'prerequisites-core',
    binding: fixtureBinding,
    backend: target,
    custody: held,
    writer: {
      ...fixtureBinding,
      clientId: '12345678-1111-4222-8333-555555555555',
      keychainPath: path.join(f.root, 'writer.keychain'),
      service: 'org.liftoff.azure-application-writer.fixture',
      account: '42'
    },
    source: {
      rootPathParts: rootParts,
      backendPathParts: [...rootParts, 'backend.tf'],
      variablesRef: `${workspace.workspaceRef}/${variableId}`,
      provider
    },
    targets: [
      {
        address: 'module.core.azurerm_container_registry.registry',
        type: 'azurerm_container_registry',
        resourceId: `/subscriptions/${fixtureBinding.subscriptionId}/resourceGroups/rg-app/providers/Microsoft.ContainerRegistry/registries/crliftoff`,
        actions: ['create'],
        expected: {
          name: 'crliftoff',
          location: 'eastus',
          resource_group_name: 'rg-app',
          sku: 'Basic',
          admin_enabled: false,
          'tags.liftoff-repository-id': '42'
        },
        role: null,
        runtime: null
      },
      {
        address: 'module.core.azurerm_user_assigned_identity.workload',
        type: 'azurerm_user_assigned_identity',
        resourceId: `/subscriptions/${fixtureBinding.subscriptionId}/resourceGroups/rg-app/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-workload`,
        actions: ['create'],
        expected: {
          name: 'id-workload',
          location: 'eastus',
          resource_group_name: 'rg-app',
          'tags.liftoff-repository-id': '42'
        },
        role: null,
        runtime: null
      }
    ],
    artifact: null,
    notBefore: fixtureTime.toISOString(),
    expiresAt: '2026-09-15T00:15:00.000Z',
    releaseUntil: '2026-09-15T00:17:00.000Z',
    maxCommandMs: 5_000
  };

  const sourceFiles = [
    {
      parts: [...rootParts, 'main.tf'],
      bytes: `terraform {
  required_version = "=1.12.6"
  required_providers { azurerm = { source = "hashicorp/azurerm", version = "=4.30.0" } }
}
provider "azurerm" {
  features {}
  resource_provider_registrations = "none"
}
variable "private_input" {
  type = string
  sensitive = true
}
module "core" {
  source = "../../modules/core"
  private_input = var.private_input
}
`
    },
    {
      parts: [...rootParts, 'backend.tf'],
      bytes: `terraform {
  backend "azurerm" {
    resource_group_name = "${target.backend.resourceGroup}"
    storage_account_name = "${target.backend.account}"
    container_name = "${target.backend.container}"
    key = "${target.backend.key}"
    subscription_id = "${fixtureBinding.subscriptionId}"
    tenant_id = "${fixtureBinding.tenantId}"
    use_azuread_auth = true
  }
}\n`
    },
    {
      parts: [...rootParts, '.terraform.lock.hcl'],
      bytes: `provider "${provider.source}" {
  version = "${provider.version}"
  hashes = ["zh:${'a'.repeat(64)}"]
}\n`
    },
    {
      parts: [...moduleParts, 'main.tf'],
      bytes: `variable "private_input" {
  type = string
  sensitive = true
}
resource "azurerm_container_registry" "registry" {
  name = "crliftoff"
  resource_group_name = "rg-app"
  location = "eastus"
  sku = "Basic"
  admin_enabled = false
  tags = { liftoff-repository-id = "42" }
}
resource "azurerm_user_assigned_identity" "workload" {
  name = "id-workload"
  resource_group_name = "rg-app"
  location = "eastus"
  tags = { liftoff-repository-id = "42" }
}
output "private_output" {
  value = var.private_input
  sensitive = true
}\n`
    }
  ];

  for (const source of sourceFiles) {
    await mkdir(path.join(f.projectRoot, ...source.parts.slice(0, -1)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(f.projectRoot, ...source.parts), source.bytes);
  }

  f.inspection.activationInputs!.budget = { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 100 };
  f.inspection.activationInputs!.phases[f.phase.id] = {
    privateExecution: { ...intent, mode: 'initialize' },
    initialization: { mode: 'create', checkpoint: null, readbackWindow: null }
  };
  const context = applicationPrivateContext(f.planning(), { ...intent, mode: 'prepare' });
  await workspace.assertAvailable(context);
  await workspace.put(
    'inspection',
    protectedStateScope(context),
    Buffer.from(JSON.stringify({ private_input: 'secret' })),
    variableId
  );

  const arm: AzureArmTransport = {
    async request(request) {
      return { status: 200, requestId: randomUUID(), data: { id: request.resourceId } };
    }
  };

  let http: ReturnType<typeof privateStateHttpFixture> | undefined;
  const faults = {
    staleWrite: false,
    unknownWrite: false,
    initialBytes: null as Uint8Array | null
  };

  const adapters: ApplicationPrivateAdapters = {
    storage: {
      workspace,
      async assertDirectory(directory: string, selected: StateExecutionContext) {
        expect(selected.hostId).toBe(nativeStateHostId());
        const relative = path.relative(held.workspaceRoot, directory);
        expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(false);
      }
    },
    backend(recorder) {
      const fresh = privateStateHttpFixture(target, recorder);
      fresh.blob.bytes = http
        ? (http.blob.bytes ? Uint8Array.from(http.blob.bytes) : null)
        : (faults.initialBytes ? Uint8Array.from(faults.initialBytes) : null);
      if (http) {
        fresh.blob.version = http.blob.version;
        fresh.blob.operationId = http.blob.operationId;
        fresh.blob.calls = http.blob.calls;
        fresh.blob.leaseId = http.blob.leaseId;
      }
      fresh.blob.staleWrite = faults.staleWrite;
      fresh.blob.unknownWrite = faults.unknownWrite;
      http = fresh;
      return fresh.path.backend;
    }
  };

  let lastOutcome: Awaited<ReturnType<typeof executeApplicationEmptyState>> | undefined;
  const issuePlan = async (options?: {
    recovery?: boolean;
    issued?: boolean;
    customPlan?: PhasePlanBuild;
  }) => {
    f.now.setTime(f.now.getTime() + 1_000);
    if (options?.recovery) {
      const result = lastOutcome?.evidencePayload;
      if (!result || typeof result !== 'object' || !('transactionId' in result) || !('journalRef' in result)) throw new Error('Missing actual original initializer checkpoint.');
      f.inspection.activationInputs!.phases[f.phase.id]!.initialization = {
        mode: 'readback', checkpoint: { transactionId: result.transactionId, journalRef: result.journalRef },
        readbackWindow: { notBefore: fixtureTime.toISOString(), expiresAt: '2026-09-15T00:20:00.000Z' }
      };
    }
    const planToExecute = options?.customPlan ?? await planApplicationEmptyState(f.planning());
    const input = await f.execution(planToExecute, {
      recovery: options?.recovery ?? false,
      issue: options?.issued ?? true
    });
    input.adapters.azureActivation!.transport = arm;
    return input;
  };

  const execute = async (input: PhaseAdapterExecutionInput) => {
    lastOutcome = await withProjectMutationLock(f.projectRoot, (lease) =>
      executeApplicationEmptyState({ ...input, lease }, adapters)
    );
    return lastOutcome;
  };

  const blobProxy = {
    get bytes() { return http?.blob.bytes ?? faults.initialBytes; },
    set bytes(val: Uint8Array | null) {
      faults.initialBytes = val;
      if (http) http.blob.bytes = val;
    },
    get calls() { return http?.blob.calls ?? []; },
    get leaseId() { return http?.blob.leaseId ?? null; },
    get staleWrite() { return faults.staleWrite; },
    set staleWrite(val: boolean) {
      faults.staleWrite = val;
      if (http) http.blob.staleWrite = val;
    },
    get unknownWrite() { return faults.unknownWrite; },
    set unknownWrite(val: boolean) {
      faults.unknownWrite = val;
      if (http) http.blob.unknownWrite = val;
    }
  };

  return {
    f, held, target, intent, workspace, storage, blob: blobProxy, adapters, issuePlan, execute,
    async nativeCalls(): Promise<string[][]> {
      return (await readFile(path.join(nativeRoot, 'invocations.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    }
  };
}

describe('producer for initial empty private application state', () => {
  it.each(['resource-change', 'resource-drift', 'deferred-change', 'output-change', 'extra-configuration', 'changed-plan', 'native-failure'])(
    'retains pre-effect custody and refuses native apply/publication for %s', async (fault) => {
      const fixture = await setupFixture(undefined, fault);
      const outcome = await fixture.execute(await fixture.issuePlan());
      expect(outcome.status).toBe('blocked');
      expect(outcome.evidencePayload).toMatchObject({
        protocol: applicationEmptyStateProtocol, nativeSettled: false, publication: 'none'
      });
      expect((await fixture.nativeCalls()).some((args) => args[0] === 'apply')).toBe(false);
      expect(fixture.blob.bytes).toBeNull();
      expect(fixture.blob.calls.some((call) => call.method === 'PUT')).toBe(false);
      const retry = await fixture.execute(await fixture.issuePlan({ recovery: true }));
      expect(retry.status).toBe('blocked');
      expect(retry.blocker).toContain('original-native-initialization-incomplete');
      expect((await fixture.nativeCalls()).filter((args) => args[0] === 'init')).toHaveLength(1);
    }
  );

  it('refuses publication when native state-pull readback differs from the generated candidate', async () => {
    const fixture = await setupFixture(undefined, 'readback-mismatch');
    const outcome = await fixture.execute(await fixture.issuePlan());
    expect(outcome.status).toBe('blocked');
    expect(outcome.blocker).toContain('empty-native-readback');
    expect(fixture.blob.bytes).toBeNull();
    expect((await fixture.nativeCalls()).filter((args) => args[0] === 'apply')).toHaveLength(1);
  });

  it('reports failure-checkpoint persistence errors after an uncertain PUT instead of suppressing them', async () => {
    const fixture = await setupFixture();
    fixture.blob.unknownWrite = true;
    const original = ApplicationEmptyStateJournalHandle.prototype.event;
    vi.spyOn(ApplicationEmptyStateJournalHandle.prototype, 'event').mockImplementation(async function (...args) {
      if (args[0] === 'blocked') throw new Error('controlled private persistence failure');
      return original.apply(this, args);
    });
    const outcome = await fixture.execute(await fixture.issuePlan());
    expect(outcome.status).toBe('blocked');
    expect(fixture.blob.bytes).not.toBeNull();
    expect(outcome.cleanupWarnings).toEqual([
      expect.stringContaining('failure checkpoint could not be persisted')
    ]);
    expect(JSON.stringify(outcome)).not.toContain('controlled private persistence failure');
    expect(fixture.blob.calls.filter((call) => call.method === 'PUT' && call.target === 'blob')).toHaveLength(1);
  });

  it.each(['missing-lock', 'fake-lock', 'unissued-approval', 'prepare-alias'] as const)(
    'rejects %s without provider effects or an alternate authorization path', async (fault) => {
      const fixture = await setupFixture();
      const actual = await planApplicationEmptyState(fixture.f.planning());
      const customPlan = fault === 'prepare-alias' ? {
        operations: actual.operations.map((operation) => ({ ...operation, actionId: 'azure.application-private.prepare' }))
      } : actual;
      const input = await fixture.issuePlan({ issued: fault !== 'unissued-approval', customPlan });
      const outcome = fault === 'missing-lock' || fault === 'fake-lock'
        ? await executeApplicationEmptyState({
          ...input, ...(fault === 'fake-lock' ? { lease: { async assertHeld() {} } } : {})
        }, fixture.adapters)
        : await fixture.execute(input);
      expect(outcome.status).toBe('blocked');
      expect(fixture.blob.calls).toEqual([]);
      expect(fixture.blob.bytes).toBeNull();
    }
  );

  it('initializes absent backend to empty ToFu 1.12.6 state using conditional-create CAS with real lock and authentic approval', async () => {
    const fixture = await setupFixture();
    expect(fixture.blob.bytes).toBeNull();

    const input = await fixture.issuePlan();
    const outcome = await fixture.execute(input);

    expect(outcome.status, outcome.blocker).toBe('review-required');
    expect(outcome.resultState).toBeUndefined();
    expect(outcome.blocker).toContain('Initial empty private state initialized with conditional-create CAS');
    expect(outcome.review).toBeDefined();
    expect(outcome.review?.schemaVersion).toBe(1);
    expect(outcome.review?.kind).toBe('application-private-plan');
    expect((outcome.review?.payload as Record<string, unknown>).nextMode).toBe('prepare');

    // State body check in HTTP fixture
    expect(fixture.blob.bytes).not.toBeNull();
    const stateObj = JSON.parse(Buffer.from(fixture.blob.bytes!).toString('utf8'));
    expect(stateObj.version).toBe(4);
    expect(stateObj.terraform_version).toBe('1.12.6');
    expect(stateObj.serial).toBe(1);
    expect(typeof stateObj.lineage).toBe('string');
    expect(stateObj.lineage).toMatch(/^[a-f0-9-]{36}$/u);
    expect(stateObj.outputs).toEqual({});
    expect(stateObj.resources).toEqual([]);

    // Check CAS conditional-create PUT
    const putCalls = fixture.blob.calls.filter((c) => c.method === 'PUT' && c.target === 'blob');
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]!.headers?.['if-none-match']).toBe('*');
    expect(putCalls[0]!.headers?.['if-match']).toBeUndefined();

    // Verify blob is NOT left leased in HTTP fixture
    expect(fixture.blob.leaseId).toBeNull();

    // Output bindings check
    expect(outcome.outputs?.values['backend.emptyStateInitialized']).toBe(true);
    expect(outcome.outputs?.values['backend.exclusiveLeaseAcquired']).toBe(false);
    expect(fixture.blob.calls.some((call) => call.target === 'lease' && call.method === 'PUT')).toBe(false);
    expect(outcome.outputs?.values['application.emptyState.status']).toBe('initialized');

    // Evidence payload check
    const payload = outcome.evidencePayload as Record<string, unknown>;
    expect(payload.protocol).toBe(applicationEmptyStateProtocol);
    expect(payload.locking).toEqual({
      capability: 'conditional-create-cas',
      acquiredExclusiveLease: false
    });
    expect(payload.nextRequired).toBe('prepare');
  });

  it.runIf(process.platform === 'darwin' && process.env.LIFTOFF_NATIVE_STATE_QUALIFICATION === '1')(
    'publishes exact state bytes generated and read back by actual OpenTofu, with Azure and custody confined to fixtures', async () => {
      const fixture = await setupFixture(process.env.LIFTOFF_TOFU_EXECUTABLE ?? '/opt/homebrew/bin/tofu');
      await expect(inspectNativeLocalStateTools({
        pythonPath: fixture.held.tools.python.path, tofuPath: fixture.held.tools.tofu.path,
        workingDirectory: fixture.held.workspaceRoot
      })).resolves.toEqual(fixture.held.tools);
      const input = await fixture.issuePlan();
      const outcome = await fixture.execute(input);
      expect(outcome.status, JSON.stringify(outcome)).toBe('review-required');
      const store = new ApplicationEmptyStateCheckpointStore({
        authority: { input, operation: input.plan.operations[0]!, assertCurrent: async () => {} },
        workspace: fixture.workspace,
        context: applicationPrivateContext(fixture.f.planning(), { ...fixture.intent, mode: 'prepare' }),
        backend: fixture.target.backend
      });
      const found = await store.find();
      expect(found.closed).toBe(true);
      const journal = await store.open(found.slot!);
      const nativeBytes = await readFile(path.join(journal.value.native.directory!.path,
        'terraform.tfstate.d', 'liftoff-initial-empty', 'terraform.tfstate'));
      try {
        expect(Buffer.from(fixture.blob.bytes!)).toEqual(nativeBytes);
        expect(readCandidateEmptyState(nativeBytes).serial).toBe(1);
        expect(journal.value.native.settled).toBe(true);
        expect(input.plan.operations[0]!.inputs.nativeExecution).not.toBe('none');
      } finally { nativeBytes.fill(0); }
    }
  );

  it('rejects concurrent creation via 412 CAS and does not overwrite existing body', async () => {
    const fixture = await setupFixture();
    fixture.blob.staleWrite = true;

    const input = await fixture.issuePlan();
    const outcome = await fixture.execute(input);

    expect(outcome.status).toBe('blocked');
    expect(outcome.completedOperations).toHaveLength(0);
    expect(fixture.blob.bytes).toBeNull();
  });

  it('refuses to adopt foreign or preexisting empty state', async () => {
    const fixture = await setupFixture();
    const foreignLineage = randomUUID();
    const foreignBytes = Buffer.from(JSON.stringify({
      version: 4,
      terraform_version: '1.12.6',
      serial: 0,
      lineage: foreignLineage,
      outputs: {},
      resources: []
    }));
    fixture.blob.bytes = Uint8Array.from(foreignBytes);

    const input = await fixture.issuePlan();
    const outcome = await fixture.execute(input);

    expect(outcome.status).toBe('blocked');
    expect(outcome.blocker).toContain('backend-already-exists');
    // Ensure foreign bytes were NOT overwritten
    expect(Buffer.from(fixture.blob.bytes!)).toEqual(foreignBytes);
  });

  it('detects source changes and refuses to execute', async () => {
    const fixture = await setupFixture();
    const input = await fixture.issuePlan();

    // Tamper with main.tf after approval
    const mainTfPath = path.join(fixture.f.projectRoot, 'infrastructure', 'opentofu', 'azure', 'environments', 'dev', 'main.tf');
    await writeFile(mainTfPath, '# TAMPERED SOURCE CONTENT\n');

    const outcome = await fixture.execute(input);
    expect(outcome.status).toBe('blocked');
    expect(outcome.blocker).toBeDefined();
    expect(fixture.blob.bytes).toBeNull();
  });

  it('maintains durable pre-effect checkpoint slot independent of changing config or approval', async () => {
    const fixture = await setupFixture();
    const input = await fixture.issuePlan();

    const outcome = await fixture.execute(input);
    expect(outcome.status).toBe('review-required');

    const store = new ApplicationEmptyStateCheckpointStore({
      authority: {
        input,
        operation: input.plan.operations[0]!,
        assertCurrent: async () => {}
      },
      workspace: fixture.workspace,
      context: applicationPrivateContext(fixture.f.planning(), { ...fixture.intent, mode: 'prepare' }),
      backend: fixture.target.backend
    });

    const found = await store.find();
    expect(found.slot).not.toBeNull();
    expect(found.closed).toBe(true);
    expect(found.slot?.backendKey).toBe(store.backendKey);
    expect(found.slot?.transactionId).toBe(outcome.outputs?.values['application.emptyState.transactionId']);

    // Verify unencrypted slot does NOT contain sensitive bytes or state hashes
    const slotJson = JSON.stringify(found.slot);
    expect(slotJson).not.toContain(stateDigest(fixture.blob.bytes!));
    expect(slotJson).not.toContain('terraform_version');
  });

  it('performs idempotent repeat without duplicate write', async () => {
    const fixture = await setupFixture();
    const input1 = await fixture.issuePlan();
    const outcome1 = await fixture.execute(input1);
    expect(outcome1.status).toBe('review-required');

    const putCallsCount1 = fixture.blob.calls.filter((c) => c.method === 'PUT' && c.target === 'blob').length;
    expect(putCallsCount1).toBe(1);

    // Second execution with fresh plan
    const input2 = await fixture.issuePlan();
    const outcome2 = await fixture.execute(input2);
    expect(outcome2.status).toBe('review-required');
    expect(outcome2.outputs?.values['application.emptyState.transactionId']).toBe(
      outcome1.outputs?.values['application.emptyState.transactionId']
    );

    // No duplicate PUT call made
    const putCallsCount2 = fixture.blob.calls.filter((c) => c.method === 'PUT' && c.target === 'blob').length;
    expect(putCallsCount2).toBe(1);
  });

  it('recovers read-only from lost response under fresh explicit approval without second PUT', async () => {
    const fixture = await setupFixture();
    // Simulate lost response on first PUT
    fixture.blob.unknownWrite = true;

    const input1 = await fixture.issuePlan();
    const outcome1 = await fixture.execute(input1);
    expect(outcome1.status).toBe('blocked');
    expect(fixture.blob.bytes).not.toBeNull(); // The PUT reached Azure before network dropped

    // Recovery run with fresh approval and recovery: true
    fixture.blob.unknownWrite = false;
    const input2 = await fixture.issuePlan({ recovery: true });
    const outcome2 = await fixture.execute(input2);

    expect(outcome2.status).toBe('review-required');
    expect(outcome2.outputs?.values['backend.emptyStateInitialized']).toBe(true);

    // Verify no second PUT was performed (read-only recovery)
    const putCalls = fixture.blob.calls.filter((c) => c.method === 'PUT' && c.target === 'blob');
    expect(putCalls).toHaveLength(1);
  });

  it('blocks recovery when previous PUT outcome is missing and does not perform second PUT', async () => {
    const fixture = await setupFixture();
    fixture.blob.staleWrite = true;

    const input1 = await fixture.issuePlan();
    const outcome1 = await fixture.execute(input1);
    expect(outcome1.status).toBe('blocked');
    expect(fixture.blob.bytes).toBeNull(); // PUT failed, blob remains absent

    // Recovery run
    fixture.blob.staleWrite = false;
    const input2 = await fixture.issuePlan({ recovery: true });
    const outcome2 = await fixture.execute(input2);

    expect(outcome2.status).toBe('blocked');
    expect(outcome2.blocker).toContain('Previous PUT outcome is missing from backend');
    expect(fixture.blob.bytes).toBeNull();
  });

  it('suppresses private state bytes and candidate state hashes from public results and unencrypted records', async () => {
    const fixture = await setupFixture();
    const input = await fixture.issuePlan();
    const outcome = await fixture.execute(input);

    const publicResultText = JSON.stringify(outcome);
    const candidateBytes = fixture.blob.bytes!;
    const stateHash = stateDigest(candidateBytes);

    expect(publicResultText).not.toContain(stateHash);
    expect(publicResultText).not.toContain('"terraform_version":"1.12.6"');
    expect(publicResultText).not.toContain('"resources":[]');
  });

  it('exports coordinator seams, planning, operation contract, and candidate creator', async () => {
    expect(applicationEmptyStateCoordinatorSeams.actionId).toBe('azure.application-private.initialize');
    expect(applicationEmptyStateCoordinatorSeams.mode).toBe('initialize');
    expect(applicationEmptyStateCoordinatorSeams.protocol).toBe(applicationEmptyStateProtocol);
    expect(typeof applicationEmptyStateCoordinatorSeams.plan).toBe('function');
    expect(typeof applicationEmptyStateCoordinatorSeams.execute).toBe('function');
    expect(typeof applicationEmptyStateCoordinatorSeams.operation).toBe('function');
    expect(typeof applicationEmptyStateCoordinatorSeams.isOperation).toBe('function');

    const candidate = readCandidateEmptyState(Buffer.from(JSON.stringify({
      version: 4, terraform_version: '1.12.6', serial: 1,
      lineage: '88888888-7777-4666-8555-444444444444', outputs: {}, resources: [], check_results: null
    })));
    expect(candidate.payload.version).toBe(4);
    expect(candidate.payload.terraform_version).toBe('1.12.6');
    expect(candidate.payload.serial).toBe(1);
    expect(candidate.payload.resources).toEqual([]);
    expect(candidate.payload.outputs).toEqual({});
    expect(typeof candidate.lineage).toBe('string');
    expect(candidate.lineage).toMatch(/^[a-f0-9-]{36}$/u);
    expect(candidate.digest).toBe(stateDigest(candidate.bytes));

    const fixture = await setupFixture();
    const plan = await planApplicationEmptyState(fixture.f.planning());
    expect(plan.operations).toHaveLength(1);
    const op = plan.operations[0]!;
    expect(isApplicationEmptyStateOperation(op)).toBe(true);
    expect(op.actionId).toBe('azure.application-private.initialize');
    expect(op.mutationClass).toBe('backend-state-write');
    expect(op.remote).toBe(true);
    expect(op.destructive).toBe(false);
    expect(op.effects).toHaveLength(13); // backend-state-read + write-local-state + 11 private path reads
    expect(op.effects?.some((e) => e.mutationClass === 'backend-state-read')).toBe(true);
    expect(op.effects?.some((e) => e.mutationClass === 'write-local-state')).toBe(true);
    expect(op.effects?.some((e) => e.mutationClass === 'azure-read')).toBe(true);
    expect(op.inputs.lockingCapability).toBe('conditional-create-cas');
    expect(op.inputs.acquiredExclusiveLease).toBe(false);
  });
});
