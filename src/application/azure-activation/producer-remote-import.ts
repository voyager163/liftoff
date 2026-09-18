import { randomUUID } from 'node:crypto';
import {
  type DarwinAzureReaderReference, type ProtectedStateWorkspace, type StateArtifactDescriptor,
  type StateBackendAdapter, type StateBackendLease, type StateExecutionContext, type StateSnapshot
} from '../../domain/repair/stateful.js';
import {
  inspectStateBytes, isStateDigest, stateAssert, stateBindingDigest, stateDigest, stateObjectDigest, stateSnapshotMatches
} from '../../domain/repair/stateful-invariants.js';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { operation, transitionDestination } from '../../domain/governance/activation/operations.js';
import { readbackProof } from '../../governance-activation/transition-records.js';
import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanningInput, PhasePlanBuild } from '../../governance-activation/transition-ports.js';
import { protectedStateScope } from '../../adapters/state/protected-workspace.js';
import { azureStateUrl } from '../../adapters/state/azure-blob.js';
import {
  createAzureCliPrivateStatePath, safePrivateStateFailure, validatePrivateStatePathTarget,
  type PrivateStateEffect, type PrivateStateEffectRecorder, type PrivateStatePathTarget
} from '../../adapters/azure/private-state-path.js';
import {
  bootstrapImportArmTypes, inspectPrivateImportConfiguration, type BootstrapImportMapping, type PrivateImportConfiguration,
  type PrivateImportConfigurationInput, type PrivateBootstrapImportDriver, type PrivateImportNoChangeProof
} from '../../adapters/azure/private-import-opentofu.js';
import { createPrivateImportRuntime } from '../../adapters/azure/private-import-runtime.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import { validateAzureBindings } from '../../adapters/azure/production-adapter.js';
import { resolveAzureInputs } from './producer-discovery.js';
import { assertAzurePhaseAuthority, AzureActivationAdmissionError } from './authority.js';
import { exactObject } from './private-resource-plans.js';
import {
  privateStateContext, readBootstrapCustody, validatePrivateCustody,
  type PrivateCustodyConfiguration, type PrivateCustodyInventory, type PrivateCustodyMaterial
} from './private-custody.js';
import { registerPrivateCustodyForDisposal } from './private-custody-lifecycle.js';

export interface PrivateRemoteImportPlan {
  schemaVersion: 1;
  recipe: 'bootstrap-declarative-import/1';
  target: PrivateStatePathTarget;
  custody: PrivateCustodyConfiguration;
  readerReference: DarwinAzureReaderReference;
  configuration: PrivateImportConfiguration;
  mappings: readonly BootstrapImportMapping[];
  retainedArmResourceIds: readonly string[];
  expiresAt: string;
  planDigest: string;
}

interface RemoteStateEffect {
  sequence: number;
  effect: PrivateStateEffect;
  at: string;
  planDigest: string;
  approvalEnvelopeHash: string;
  state: 'prepared' | 'returned' | 'unknown';
  returned?: { requestId: string; status: number; etag: string | null; versionId: string | null };
}

export interface RemoteImportJournal {
  schemaVersion: 2;
  kind: 'private-bootstrap-remote-import';
  intentDigest: string;
  operationId: string;
  approvalEnvelopeHash: string;
  planDigest: string;
  retainedAt: string;
  disposeAfter: string;
  originalRef: string | null;
  original: StateSnapshot | null;
  candidate: StateArtifactDescriptor | null;
  materials: PrivateCustodyMaterial[];
  effects: RemoteStateEffect[];
  proof: PrivateImportNoChangeProof | null;
  state: 'prepared' | 'candidate-verified' | 'state-written' | 'verified' | 'blocked';
  verifiedAt: string | null;
}

type OriginalObservation =
  | { kind: 'unobserved' }
  | { kind: 'absent' | 'present'; snapshot: StateSnapshot };

async function inspectRecordedOriginal(
  journal: RemoteImportJournal, target: PrivateStatePathTarget,
  workspace: ProtectedStateWorkspace, scope: string
): Promise<OriginalObservation> {
  const snapshot = journal.original;
  if (snapshot === null) {
    stateAssert(journal.originalRef === null && journal.candidate === null && journal.proof === null &&
      journal.materials.length === 0 &&
      journal.verifiedAt === null && ['prepared', 'blocked'].includes(journal.state) &&
      journal.effects.every((entry) => isRecord(entry.effect) && ['acquire', 'renew', 'release'].includes(entry.effect.action)),
    'recovery-required');
    return { kind: 'unobserved' };
  }
  stateAssert(isRecord(snapshot) && snapshot.backendId === target.backend.id &&
    snapshot.bindingDigest === stateBindingDigest(target.backend) && typeof snapshot.exists === 'boolean' &&
    Number.isSafeInteger(snapshot.size) && snapshot.size >= 0 && Number.isFinite(snapshot.observedAt) &&
    isStateDigest(snapshot.inventoryDigest), 'recovery-conflict');
  if (!snapshot.exists) {
    stateAssert(journal.originalRef === null && snapshot.size === 0 && snapshot.version === null &&
      snapshot.etag === null && snapshot.lineage === null && snapshot.serial === null && snapshot.digest === null &&
      snapshot.inventoryDigest === stateObjectDigest([]), 'recovery-conflict');
    return { kind: 'absent', snapshot };
  }
  stateAssert(snapshot.size > 0 && typeof snapshot.etag === 'string' && /^"0x[a-f0-9]+"$/iu.test(snapshot.etag) &&
    typeof snapshot.version === 'string' && snapshot.version.length > 0 && snapshot.version.length <= 128 &&
    typeof snapshot.lineage === 'string' && snapshot.lineage.length > 0 &&
    Number.isSafeInteger(snapshot.serial) && Number(snapshot.serial) >= 0 && isStateDigest(snapshot.digest) &&
    typeof journal.originalRef === 'string' && journal.originalRef.startsWith(`${workspace.workspaceRef}/`), 'recovery-required');
  const backup = await workspace.describe(journal.originalRef, 'backup', scope);
  stateAssert(backup && backup.digest === snapshot.digest, 'recovery-required');
  return { kind: 'present', snapshot };
}

export interface PrivateRemoteImportPorts {
  runtime?: (context: StateExecutionContext, ownedResourceIds: readonly string[], authorize: () => Promise<void>) => Promise<{
    workspace: ProtectedStateWorkspace; driver: PrivateBootstrapImportDriver;
  }>;
  backend?: (effects: PrivateStateEffectRecorder) => StateBackendAdapter;
}

function mapping(value: unknown): BootstrapImportMapping {
  const item = exactObject(value, ['address', 'importId', 'managedResourceIds'], 'Declared bootstrap import mapping');
  stateAssert(typeof item.address === 'string' && /^azurerm_[a-z0-9_]+\.[A-Za-z_][A-Za-z0-9_-]*$/u.test(item.address) &&
    typeof item.importId === 'string' && item.importId.length > 0 && item.importId.length <= 4096 &&
    !/[\s\u0000-\u001f\u007f"'\\?#%]/u.test(item.importId) &&
    Array.isArray(item.managedResourceIds) && item.managedResourceIds.length <= 16 &&
    item.managedResourceIds.every((id) => typeof id === 'string') &&
    new Set(item.managedResourceIds).size === item.managedResourceIds.length, 'mapping-conflict');
  return structuredClone(item) as unknown as BootstrapImportMapping;
}

async function importPlan(input: PhasePlanningInput): Promise<PrivateRemoteImportPlan> {
  const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  const config = exactObject(configuration?.phases['remote-import-verified'], [
    'target', 'custody', 'readerReference', 'configuration', 'mappings', 'retainedArmResourceIds', 'expiresAt'
  ], 'Remote bootstrap import inputs');
  const target = validatePrivateStatePathTarget(config.target as PrivateStatePathTarget);
  const azure = validateAzureBindings(resolveAzureInputs(input));
  stateAssert(azure.valid && azure.subscriptionId === target.binding.subscriptionId && azure.tenantId === target.binding.tenantId &&
    azure.region === target.region, 'invalid-binding');
  const custody = validatePrivateCustody(config.custody);
  const reader = exactObject(config.readerReference,
    ['keychainPath', 'service', 'account', 'tenantId', 'subscriptionId', 'clientId', 'principalId'], 'Existing read-only provider identity');
  stateAssert(reader.tenantId === target.binding.tenantId && reader.subscriptionId === target.binding.subscriptionId &&
    reader.account === target.backend.ownerId && reader.principalId !== target.binding.principalId &&
    [reader.clientId, reader.principalId].every((id) => typeof id === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(id) &&
      id !== '00000000-0000-0000-0000-000000000000') &&
    typeof reader.keychainPath === 'string' && typeof reader.service === 'string', 'access-denied');
  stateAssert(input.inspection.state.remoteBinding?.id === target.backend.ownerId &&
    custody.keyReference.account === target.backend.ownerId && custody.tools.hostId === target.hostId &&
    typeof config.expiresAt === 'string' && Number.isFinite(Date.parse(config.expiresAt)) &&
    new Date(config.expiresAt).toISOString() === config.expiresAt && Date.parse(config.expiresAt) > input.now.getTime() &&
    Array.isArray(config.mappings) && config.mappings.length > 0 && config.mappings.length <= 64 &&
    Array.isArray(config.retainedArmResourceIds) && config.retainedArmResourceIds.length <= 16 &&
    config.retainedArmResourceIds.every((id) => typeof id === 'string'), 'invalid-binding');
  const mappings = config.mappings.map(mapping);
  stateAssert(new Set(mappings.map((entry) => entry.address)).size === mappings.length &&
    new Set(mappings.map((entry) => `${entry.address.split('.')[0]}:${entry.importId}`)).size === mappings.length &&
    new Set(config.retainedArmResourceIds).size === config.retainedArmResourceIds.length, 'mapping-conflict');
  const inspected = await inspectPrivateImportConfiguration(input.inspection.projectRoot, config.configuration as PrivateImportConfigurationInput);
  stateAssert(canonicalSha256([...mappings.map((entry) => entry.address)].sort()) === canonicalSha256(inspected.resourceAddresses), 'mapping-incomplete');
  const body = {
    schemaVersion: 1 as const, recipe: 'bootstrap-declarative-import/1' as const, target, custody,
    readerReference: reader as unknown as DarwinAzureReaderReference, configuration: inspected,
    mappings, retainedArmResourceIds: config.retainedArmResourceIds as string[], expiresAt: config.expiresAt
  };
  return { ...body, planDigest: canonicalSha256(body) };
}

export async function planRemoteImportVerified(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  try {
    stateAssert(input.phase.id === 'remote-import-verified' && (input.inspection.scope ?? 'activation') === 'activation' &&
      input.inspection.state.applicability.statePath === 'bootstrap-local' &&
      input.inspection.state.bootstrapState?.status !== 'disposed', 'approval-mismatch');
    const plan = await importPlan(input);
    const destination = transitionDestination('external', azureStateUrl(plan.target.backend, 'blob'));
    return { operations: [operation({
      phaseId: 'remote-import-verified', adapter: 'azure-opentofu', actionId: 'azure.remote-import.verify',
      mutationClass: 'azure-state-import', remote: true, destructive: false,
      destination, inputs: { plan },
      effects: [
        { mutationClass: 'backend-state-read', destination, remote: true, destructive: false },
        { mutationClass: 'backend-state-write', destination, remote: true, destructive: false },
        { mutationClass: 'azure-read', destination: transitionDestination('subscription', plan.target.binding.subscriptionId,
          { subscriptionId: plan.target.binding.subscriptionId }), remote: true, destructive: false }
      ]
    })] };
  } catch (error) {
    return { operations: [], blockers: [error instanceof AzureActivationAdmissionError ? error.message : safePrivateStateFailure(error)] };
  }
}

function assertMappingCustody(plan: PrivateRemoteImportPlan, inventory: PrivateCustodyInventory): void {
  const ids = new Map(inventory.resources.map((resource) => [resource.resourceId, resource.resourceType]));
  const seen = new Set<string>();
  for (const entry of plan.mappings) {
    const allowedTypes = bootstrapImportArmTypes[entry.address.split('.')[0]!];
    const importIds = entry.importId.split('|');
    stateAssert(allowedTypes && importIds.every((id) => ids.has(id) && allowedTypes.includes(ids.get(id)!)) &&
      ids.get(importIds[0]!) === allowedTypes[0] &&
      entry.managedResourceIds.every((id) => ids.has(id) && !seen.has(id) &&
        allowedTypes.includes(ids.get(id)!)), 'ownership-mismatch');
    for (const id of entry.managedResourceIds) seen.add(id);
  }
  for (const id of plan.retainedArmResourceIds) {
    stateAssert(ids.get(id) === 'GitHub.Network/networkSettings' && !seen.has(id), 'mapping-conflict');
    seen.add(id);
  }
  stateAssert(seen.size === ids.size, 'mapping-incomplete');
}

function journalId(workspaceId: string, backendId: string): string {
  const hash = canonicalSha256({ kind: 'bootstrap-remote-import-journal/1', workspaceId, backendId });
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function intentDigest(plan: PrivateRemoteImportPlan): string {
  const { expiresAt: _expires, planDigest: _digest, ...intent } = plan;
  return canonicalSha256(intent);
}

export async function executeRemoteImportVerified(
  input: PhaseAdapterExecutionInput, ports: PrivateRemoteImportPorts = {}
): Promise<PhaseAdapterOutcome> {
  let lease: StateBackendLease | null = null;
  let driver: PrivateBootstrapImportDriver | null = null;
  let journalRef: string | null = null;
  let journal: RemoteImportJournal | null = null;
  let save: ((change: () => void) => Promise<void>) | null = null;
  try {
    const current = await planRemoteImportVerified(input);
    const reviewed = input.plan.operations.filter((entry) => entry.actionId === 'azure.remote-import.verify');
    if (current.blockers?.length || reviewed.length !== 1 || canonicalSha256(current.operations) !== canonicalSha256(reviewed)) return {
      status: 'blocked', blocker: current.blockers?.join(' ') ?? 'The exact import mappings, private backend or source bytes changed after review.', completedOperations: []
    };
    const op = reviewed[0]!;
    const plan = await importPlan(input);
    const authorize = async () => {
      await assertAzurePhaseAuthority(input, op);
      stateAssert(Date.parse(plan.expiresAt) > (input.clock?.() ?? input.now).getTime() &&
        op.effects?.some((effect) => effect.mutationClass === 'backend-state-write') &&
        input.inspection.state.bootstrapState?.status !== 'disposed', 'approval-mismatch');
    };
    await authorize();
    const context = privateStateContext(input, plan.target.binding, plan.target.hostId, plan.target.backend.ownerId);
    const ownedIds = [...new Set([...plan.mappings.flatMap((entry) => entry.managedResourceIds), ...plan.retainedArmResourceIds])];
    const runtime = await (ports.runtime ? ports.runtime(context, ownedIds, authorize) : createPrivateImportRuntime({
      custody: plan.custody, context, reader: plan.readerReference, configuration: plan.configuration,
      mappings: plan.mappings, ownedResourceIds: ownedIds, authorize, now: () => (input.clock?.() ?? input.now).getTime()
    }));
    driver = runtime.driver;
    const workspace = runtime.workspace;
    stateAssert(workspace.workspaceRef === `state-workspace:${plan.custody.workspaceId}`, 'ownership-mismatch');
    await workspace.assertAvailable(context);
    const custody = await readBootstrapCustody(workspace, context, plan.custody);
    assertMappingCustody(plan, custody);
    const scope = protectedStateScope(context);
    const id = journalId(plan.custody.workspaceId, plan.target.backend.id);
    journalRef = `${workspace.workspaceRef}/${id}`;
    let descriptor = await workspace.describe(journalRef, 'journal', scope);
    if (descriptor) {
      const bytes = await workspace.get(journalRef, 'journal', scope);
      try {
        const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
        if (isRecord(value) && value.schemaVersion === 1) throw new AzureActivationAdmissionError('private-custody-inventory',
          'The original import journal has no complete pre-recorded protected material inventory. Preserve it for explicit custody reconciliation; do not reinterpret it or sweep untracked workspace files.');
        stateAssert(isRecord(value) && value.schemaVersion === 2 && value.kind === 'private-bootstrap-remote-import' &&
          value.intentDigest === intentDigest(plan) && value.retainedAt === plan.custody.retainedAt &&
          value.disposeAfter === plan.custody.disposeAfter && Array.isArray(value.effects) && value.effects.length <= 256 &&
          typeof value.operationId === 'string' && /^[a-f0-9-]{36}$/u.test(value.operationId) &&
          Array.isArray(value.materials) && value.materials.length <= 128, 'recovery-conflict');
        journal = value as unknown as RemoteImportJournal;
      } finally { bytes.fill(0); }
      stateAssert(journal.effects.every((effect) => effect.state === 'returned'), 'recovery-required');
      stateAssert(journal.state === 'verified' || input.recovery && input.plan.recovery === true &&
        journal.approvalEnvelopeHash !== input.plan.approval.envelopeHash, 'recovery-required');
    } else {
      stateAssert(Date.parse(plan.custody.disposeAfter) >= (input.clock?.() ?? input.now).getTime() + 30 * 86_400_000,
        'not-due');
      journal = {
        schemaVersion: 2, kind: 'private-bootstrap-remote-import', intentDigest: intentDigest(plan),
        operationId: randomUUID(), approvalEnvelopeHash: input.plan.approval.envelopeHash!,
        planDigest: plan.planDigest, retainedAt: plan.custody.retainedAt, disposeAfter: plan.custody.disposeAfter,
        originalRef: null, original: null, candidate: null, materials: [], effects: [], proof: null, state: 'prepared', verifiedAt: null
      };
      const bytes = Buffer.from(canonicalJson(journal));
      try { descriptor = await workspace.put('journal', scope, bytes, id); }
      finally { bytes.fill(0); }
    }
    let recordedOriginal = await inspectRecordedOriginal(journal, plan.target, workspace, scope);
    let queue: Promise<void> = Promise.resolve();
    const stored = journal;
    save = (change) => {
      const work = queue.then(async () => {
        change();
        const bytes = Buffer.from(canonicalJson(stored));
        try { descriptor = await workspace.replace(journalRef!, 'journal', scope, descriptor!.digest, bytes); }
        finally { bytes.fill(0); }
      });
      queue = work;
      return work;
    };
    const persist = save;
    const prepareMaterial = async (material: StateArtifactDescriptor) => {
      stateAssert(stored.materials.length < 128 && !stored.materials.some((entry) => entry.descriptor.ref === material.ref) &&
        ['backup', 'candidate'].includes(material.purpose) && material.scope === scope &&
        material.ref.startsWith(`${workspace.workspaceRef}/`) && isStateDigest(material.digest), 'artifact-integrity');
      await persist(() => { stored.materials.push({ descriptor: material, state: 'prepared' }); });
    };
    const retainMaterial = async (material: StateArtifactDescriptor) => {
      const entry = stored.materials.find((entry) => entry.descriptor.ref === material.ref);
      stateAssert(entry?.state === 'prepared' && canonicalSha256(entry.descriptor) === canonicalSha256(material), 'artifact-integrity');
      await persist(() => { entry.state = 'retained'; });
    };
    const effects: PrivateStateEffectRecorder = {
      async before(effect) {
        await authorize();
        stateAssert(effect.operationId === stored.operationId && effect.backendId === plan.target.backend.id &&
          effect.action !== 'delete' && stored.effects.length < 256, 'approval-mismatch');
        let sequence = 0;
        await persist(() => {
          sequence = stored.effects.length + 1;
          stored.effects.push({
            sequence, effect, at: (input.clock?.() ?? input.now).toISOString(), state: 'prepared',
            planDigest: input.plan.planDigest, approvalEnvelopeHash: input.plan.approval.envelopeHash!
          });
        });
        return String(sequence);
      },
      async returned(checkpoint, response) {
        await persist(() => {
          const entry = stored.effects[Number(checkpoint) - 1];
          stateAssert(entry?.state === 'prepared', 'recovery-conflict');
          entry.state = 'returned';
          entry.returned = response;
        });
      },
      async uncertain(checkpoint) {
        await persist(() => {
          const entry = stored.effects[Number(checkpoint) - 1];
          stateAssert(entry && entry.state !== 'returned', 'recovery-conflict');
          entry.state = 'unknown';
          stored.state = 'blocked';
        });
      }
    };
    const backend = ports.backend?.(effects) ?? createAzureCliPrivateStatePath(input.runner, input.inspection.projectRoot, plan.target, {
      arm: azurePorts(input).transport, effects, now: () => (input.clock?.() ?? input.now).getTime()
    }).backend;
    stateAssert(stateBindingDigest(backend.binding) === stateBindingDigest(plan.target.backend), 'ownership-mismatch');
    await authorize();
    const metadata = await backend.metadata(context);
    lease = await backend.acquire(metadata, context, stored.operationId);
    const original = metadata.exists ? await backend.readPrivate(metadata, context, lease) : null;
    try {
      const inspected = inspectStateBytes(metadata, original);
      if (recordedOriginal.kind === 'unobserved') {
        if (original) {
          const id = randomUUID();
          const expected: StateArtifactDescriptor = {
            ref: `${workspace.workspaceRef}/${id}`, purpose: 'backup', scope, digest: stateDigest(original)
          };
          await prepareMaterial(expected);
          await persist(() => { stored.original = inspected.snapshot; stored.originalRef = expected.ref; });
          const backup = await workspace.put('backup', scope, original, id);
          await retainMaterial(backup);
        } else await persist(() => { stored.original = inspected.snapshot; stored.originalRef = null; });
        recordedOriginal = await inspectRecordedOriginal(stored, plan.target, workspace, scope);
      }
      stateAssert(recordedOriginal.kind !== 'unobserved', 'recovery-required');
      const originalSnapshot = recordedOriginal.snapshot;
      const previousWrite = stored.effects.some((entry) => entry.effect.action === 'write' && entry.returned?.status === 201);
      if (previousWrite || stored.state === 'verified') {
        stateAssert((previousWrite ? metadata.operationId === stored.operationId :
          stateSnapshotMatches(originalSnapshot, inspected.snapshot)) && original && stored.candidate &&
          stateDigest(original) === stored.candidate.digest, 'recovery-conflict');
      } else {
        stateAssert(stateSnapshotMatches(originalSnapshot, inspected.snapshot), 'stale-state');
        const prepared = await driver.prepare(original, { id: randomUUID(), beforeCreate: prepareMaterial });
        await retainMaterial(prepared.candidate);
        await persist(() => { stored.candidate = prepared.candidate; stored.proof = prepared.proof; stored.state = 'candidate-verified'; });
        if (!metadata.exists || prepared.candidate.digest !== inspected.snapshot.digest) {
          const bytes = await workspace.get(prepared.candidate.ref, 'candidate', scope);
          try {
            await authorize();
            stateAssert(Date.parse(stored.disposeAfter) >= (input.clock?.() ?? input.now).getTime() + 30 * 86_400_000, 'not-due');
            await lease.assertHeld();
            await backend.writePrivate({ bytes, expected: inspected.snapshot, lease, context, operationId: stored.operationId });
            await persist(() => { stored.state = 'state-written'; });
          } finally { bytes.fill(0); }
        }
      }
    } finally { original?.fill(0); }
    await authorize();
    await lease.assertHeld();
    const remote = await backend.metadata(context);
    const remoteBytes = await backend.readPrivate(remote, context, lease);
    let proof: PrivateImportNoChangeProof;
    try {
      const originalSnapshot = recordedOriginal.snapshot;
      const written = stored.effects.some((entry) => entry.effect.action === 'write' && entry.returned?.status === 201);
      stateAssert(stored.candidate && stateDigest(remoteBytes) === stored.candidate.digest &&
        (written ? remote.operationId === stored.operationId :
          stateSnapshotMatches(originalSnapshot, inspectStateBytes(remote, remoteBytes).snapshot)), 'stale-state');
      proof = (await driver.verify(remoteBytes)).proof;
    } finally { remoteBytes.fill(0); }
    await lease.assertHeld();
    await lease.release();
    lease = null;
    await driver.quiesce();
    for (const material of stored.materials) {
      stateAssert(isRecord(material) && isRecord(material.descriptor) &&
        ['prepared', 'retained', 'absent'].includes(material.state), 'recovery-conflict');
      const actual = await workspace.describe(material.descriptor.ref, material.descriptor.purpose, material.descriptor.scope);
      if (material.state === 'prepared') {
        stateAssert(actual === null || canonicalSha256(actual) === canonicalSha256(material.descriptor), 'artifact-integrity');
        await persist(() => { material.state = actual ? 'retained' : 'absent'; });
      } else stateAssert(material.state === 'absent' ? actual === null :
        actual && canonicalSha256(actual) === canonicalSha256(material.descriptor), 'artifact-integrity');
    }
    await persist(() => { stored.proof = proof; stored.state = 'verified'; stored.verifiedAt ??= (input.clock?.() ?? input.now).toISOString(); });
    await authorize();
    const requestIds = stored.effects.flatMap((entry) => entry.returned ? [entry.returned.requestId] : []);
    stateAssert(requestIds.length > 0 &&
      stored.effects.some((entry) => entry.effect.action === 'acquire' && entry.returned?.status === 201) &&
      stored.effects.some((entry) => entry.effect.action === 'release' && entry.returned?.status === 200), 'verification-incomplete');
    const retainedCustody = await registerPrivateCustodyForDisposal(input, {
      configuration: plan.custody, context, workspace, importJournalRef: journalRef
    });
    const payload = {
      kind: 'remote-import-verified.v1', recipe: plan.recipe, mappings: plan.mappings,
      stateDisposition: stored.effects.some((entry) => entry.effect.action === 'write' && entry.returned?.status === 201)
        ? 'imported-and-verified' : 'existing-no-change',
      retainedArmResourceIds: plan.retainedArmResourceIds, providerRequestIds: requestIds,
      remoteBackendDigest: stateBindingDigest(plan.target.backend), noChangePlanDigest: canonicalSha256(proof),
      noChangeProof: proof, journalRef,
      custody: retainedCustody,
      atomicAcrossProviders: false
    };
    const resourceId = `/subscriptions/${plan.target.binding.subscriptionId}/resourceGroups/${plan.target.backend.resourceGroup}` +
      `/providers/Microsoft.Storage/storageAccounts/${plan.target.backend.account}/blobServices/default/containers/${plan.target.backend.container}`;
    return {
      status: 'completed', resultState: 'verified', evidencePayload: payload, completedOperations: [op],
      liveReadback: [readbackProof(input, 'azure', 'private-state-import', resourceId, payload)],
      outputs: {
        values: { 'backend.id': plan.target.backend.id, 'backend.importJournalRef': journalRef,
          'backend.noChangeProofDigest': canonicalSha256(proof), 'backend.custodyRetainedAt': stored.retainedAt,
          'backend.custodyDisposeAfter': stored.disposeAfter, 'backend.custodyHandle': retainedCustody.handle,
          'backend.custodyWorkspaceRef': retainedCustody.workspaceRef, 'backend.custodyKeyRef': retainedCustody.keyRef },
        resources: [{ provider: 'azure', resourceType: 'private-state-import', resourceId }]
      },
      cleanupWarnings: [
        'Original encrypted state and original retention dates are preserved through an exact private custody handle. The preexisting external key is not exclusively owned by these artifacts and is retained; no key destruction or cryptographic erasure is implied.'
      ]
    };
  } catch (error) {
    let journalFailure: string | null = null;
    if (save && journal) {
      try { await save(() => { journal!.state = 'blocked'; }); }
      catch (failure) { journalFailure = safePrivateStateFailure(failure); }
    }
    return {
      status: 'blocked', blocker: error instanceof AzureActivationAdmissionError ? error.message : safePrivateStateFailure(error),
      completedOperations: [],
      cleanupWarnings: journalRef ? [
        `Protected import journal retained at ${journalRef}; unknown dispatches are never blindly retried, and no state/resource rollback was attempted.`,
        ...(journalFailure ? [`The final blocked journal marker could not be persisted: ${journalFailure}. Preserve the original custody and effect records.`] : [])
      ] : []
    };
  } finally {
    await driver?.quiesce();
    if (lease) await lease.release();
  }
}
