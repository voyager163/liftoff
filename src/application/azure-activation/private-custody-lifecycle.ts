import { randomUUID } from 'node:crypto';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, canonicalPhaseGraphHash } from '../../domain/governance/activation/graph.js';
import { approvalRequestForSavedPlan, evaluateApprovalForTransitionPlan } from '../../domain/governance/activation/approvals.js';
import { assertOperationAllowed, assertPlanOperationsAllowed, operation, transitionDestination } from '../../domain/governance/activation/operations.js';
import { validateManifestActivationForExecution, validateSavedTransitionPlan } from '../../domain/governance/activation/validators.js';
import { latestRecordWithPayload, evidenceHeaderDigest } from '../../domain/governance/activation/evidence.js';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { darwinStateKeyReferenceId } from '../../adapters/state/darwin-capabilities.js';
import { protectedStateScope } from '../../adapters/state/protected-workspace.js';
import { stateAssert, validateStateContext } from '../../domain/repair/stateful-invariants.js';
import { safePrivateStateFailure } from '../../adapters/azure/private-state-path.js';
import { assertGovernanceApprovalIssued } from '../../governance-activation/authority-records.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import { assertAzurePhaseAuthority, AzureActivationAdmissionError } from './authority.js';
import { privateAccessProjectIdentity } from './private-checkpoints.js';
import { exactObject, privateDigest } from './private-resource-plans.js';
import { bootstrapCustodyArtifactRef, openPrivateCustody, validatePrivateCustody, type PrivateCustodyConfiguration } from './private-custody.js';
import type { ProtectedStateWorkspace, StateArtifactDescriptor, StateExecutionContext } from '../../domain/repair/stateful.js';
import type { PhaseEvidenceRecord, TransitionOperation } from '../../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput } from '../../governance-activation/transition-ports.js';

export const privateCustodyDisposalAction = 'local.bootstrap-custody.dispose-artifacts';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const handlePrefix = 'private-bootstrap-custody:';

export interface PrivateExternalCustodyReference {
  schemaVersion: 1;
  kind: 'protected-external';
  handle: string;
  workspaceRef: string;
  keyRef: string;
  keyDisposition: 'retain-preexisting-external-key';
  retainedAt: string;
  disposeAfter: string;
  materialRefs: readonly string[];
}

export interface PrivateExternalBootstrapRetention {
  status: 'retained' | 'disposed';
  remoteImportEvidenceId: string;
  remoteImportEvidenceDigest: string;
  retainedAt: string;
  disposeAfter: string;
  externalCustody: PrivateExternalCustodyReference;
  disposedAt?: string;
  deletionEvidenceId?: string;
  incompleteCleanup?: readonly string[];
}

interface CustodyLocator {
  schemaVersion: 1;
  kind: 'private-bootstrap-custody-locator';
  projectRoot: string;
  projectIdentity: { device: string; inode: string; birthtime: string };
  originIdentityDigest: string;
  originPlanDigest: string;
  originApprovalEnvelopeHash: string;
  reference: PrivateExternalCustodyReference;
  configuration: PrivateCustodyConfiguration;
  context: StateExecutionContext;
  artifacts: readonly StateArtifactDescriptor[];
}

function fail(error: unknown): string {
  return error instanceof AzureActivationAdmissionError ? error.message : safePrivateStateFailure(error);
}

function text(value: unknown): string {
  stateAssert(typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !/[\u0000-\u001f\u007f]/u.test(value), 'invalid-binding');
  return value;
}

function artifactRef(value: unknown, workspaceRef: string): string {
  const ref = text(value);
  stateAssert(ref.startsWith(`${workspaceRef}/`) && uuid.test(ref.slice(workspaceRef.length + 1)), 'artifact-integrity');
  return ref;
}

export function validatePrivateExternalCustody(value: unknown): PrivateExternalCustodyReference {
  const reference = exactObject(value, [
    'schemaVersion', 'kind', 'handle', 'workspaceRef', 'keyRef', 'keyDisposition', 'retainedAt', 'disposeAfter', 'materialRefs'
  ], 'Exact external bootstrap custody reference');
  const workspaceRef = text(reference.workspaceRef), handle = text(reference.handle);
  const retainedAt = text(reference.retainedAt), disposeAfter = text(reference.disposeAfter), keyRef = text(reference.keyRef);
  stateAssert(reference.schemaVersion === 1 && reference.kind === 'protected-external' &&
    workspaceRef.startsWith('state-workspace:') && uuid.test(workspaceRef.slice('state-workspace:'.length)) &&
    handle.startsWith(handlePrefix) && uuid.test(handle.slice(handlePrefix.length)) &&
    /^keychain:[a-f0-9]{64}$/u.test(keyRef) && reference.keyDisposition === 'retain-preexisting-external-key' &&
    [retainedAt, disposeAfter].every((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value) &&
    Date.parse(disposeAfter) - Date.parse(retainedAt) >= 30 * 86_400_000 &&
    Array.isArray(reference.materialRefs) && reference.materialRefs.length >= 3 && reference.materialRefs.length <= 130,
  'invalid-binding');
  const materialRefs = reference.materialRefs.map((ref) => artifactRef(ref, workspaceRef));
  stateAssert(new Set(materialRefs).size === materialRefs.length, 'artifact-integrity');
  return { schemaVersion: 1, kind: 'protected-external', handle, workspaceRef, keyRef,
    keyDisposition: 'retain-preexisting-external-key', retainedAt, disposeAfter, materialRefs };
}

export function privateExternalRetention(
  record: PhaseEvidenceRecord, previous?: PrivateExternalBootstrapRetention
): PrivateExternalBootstrapRetention {
  stateAssert(record.header.phaseId === 'remote-import-verified' && record.header.result === 'verified' &&
    isRecord(record.payload) && record.payload.kind === 'remote-import-verified.v1', 'verification-incomplete');
  const externalCustody = validatePrivateExternalCustody(record.payload.custody);
  const current: PrivateExternalBootstrapRetention = {
    status: 'retained', remoteImportEvidenceId: record.evidenceId,
    remoteImportEvidenceDigest: evidenceHeaderDigest(record.header),
    retainedAt: externalCustody.retainedAt, disposeAfter: externalCustody.disposeAfter, externalCustody
  };
  if (previous) {
    const checked = validatePrivateExternalBootstrapRetention(previous);
    const { status: _status, disposedAt: _disposedAt, deletionEvidenceId: _deletionEvidenceId,
      incompleteCleanup: _incompleteCleanup, ...original } = checked;
    stateAssert(canonicalSha256({ ...original, status: 'retained' }) === canonicalSha256(current), 'recovery-conflict');
    return checked;
  }
  return current;
}

export function validatePrivateExternalBootstrapRetention(value: unknown): PrivateExternalBootstrapRetention {
  stateAssert(isRecord(value), 'recovery-required');
  const optional = ['disposedAt', 'deletionEvidenceId', 'incompleteCleanup'].filter((key) => Object.hasOwn(value, key));
  const record = exactObject(value, ['status', 'remoteImportEvidenceId', 'remoteImportEvidenceDigest', 'retainedAt',
    'disposeAfter', 'externalCustody', ...optional], 'Recorded external bootstrap retention');
  const externalCustody = validatePrivateExternalCustody(record.externalCustody);
  stateAssert((record.status === 'retained' || record.status === 'disposed') &&
    record.retainedAt === externalCustody.retainedAt && record.disposeAfter === externalCustody.disposeAfter, 'recovery-conflict');
  const result: PrivateExternalBootstrapRetention = {
    status: record.status, remoteImportEvidenceId: text(record.remoteImportEvidenceId),
    remoteImportEvidenceDigest: privateDigest(record.remoteImportEvidenceDigest, 'Original import evidence'),
    retainedAt: externalCustody.retainedAt, disposeAfter: externalCustody.disposeAfter, externalCustody
  };
  if (record.disposedAt !== undefined) {
    const disposedAt = text(record.disposedAt);
    stateAssert(Number.isFinite(Date.parse(disposedAt)) && new Date(disposedAt).toISOString() === disposedAt &&
      Date.parse(disposedAt) >= Date.parse(externalCustody.disposeAfter), 'invalid-binding');
    result.disposedAt = disposedAt;
  }
  stateAssert(result.status !== 'disposed' || result.disposedAt, 'recovery-required');
  if (record.deletionEvidenceId !== undefined) result.deletionEvidenceId = text(record.deletionEvidenceId);
  if (record.incompleteCleanup !== undefined) {
    stateAssert(Array.isArray(record.incompleteCleanup), 'invalid-binding');
    result.incompleteCleanup = record.incompleteCleanup.map(text);
  }
  return result;
}

function locatorKey(handle: string): string {
  return canonicalSha256({ kind: 'private-bootstrap-custody-locator/1', handle });
}

function descriptor(value: unknown, workspaceRef: string, scope: string): StateArtifactDescriptor {
  const item = exactObject(value, ['ref', 'purpose', 'scope', 'digest'], 'Private retained artifact descriptor');
  stateAssert(['backup', 'candidate', 'journal'].includes(String(item.purpose)) && item.scope === scope, 'artifact-purpose');
  return { ref: artifactRef(item.ref, workspaceRef), purpose: item.purpose === 'backup' ? 'backup' : item.purpose === 'candidate' ? 'candidate' : 'journal',
    scope, digest: privateDigest(item.digest, 'Private retained artifact') };
}

function storedContext(value: unknown): StateExecutionContext {
  const item = exactObject(value, ['projectRoot', 'projectId', 'hostId', 'principalId', 'configurationDigest', 'artifactDigest', 'cliDigest'], 'Original custody context');
  const context = {
    projectRoot: text(item.projectRoot), projectId: text(item.projectId), hostId: text(item.hostId),
    principalId: text(item.principalId), configurationDigest: text(item.configurationDigest),
    artifactDigest: text(item.artifactDigest), cliDigest: text(item.cliDigest)
  };
  validateStateContext(context);
  return context;
}

async function readLocator(input: PhasePlanningInput, reference: PrivateExternalCustodyReference): Promise<CustodyLocator> {
  const stored = await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', azurePorts(input).storage)
    .read(locatorKey(reference.handle));
  stateAssert(stored && stored.projectRoot === input.inspection.projectRoot, 'recovery-required');
  const value = exactObject(stored.value, [
    'schemaVersion', 'kind', 'projectRoot', 'projectIdentity', 'originIdentityDigest', 'originPlanDigest',
    'originApprovalEnvelopeHash', 'reference', 'configuration', 'context', 'artifacts'
  ], 'Private external custody locator');
  const project = await privateAccessProjectIdentity(input.inspection.projectRoot);
  const configuration = validatePrivateCustody(value.configuration), context = storedContext(value.context);
  stateAssert(value.schemaVersion === 1 && value.kind === 'private-bootstrap-custody-locator' &&
    value.projectRoot === project.projectRoot && canonicalSha256(value.projectIdentity) === canonicalSha256(project.projectIdentity) &&
    canonicalSha256(value.reference) === canonicalSha256(reference) &&
    context.projectRoot === project.projectRoot && context.projectId === input.inspection.state.remoteBinding?.id &&
    context.hostId === configuration.tools.hostId && configuration.keyReference.account === context.projectId &&
    reference.workspaceRef === `state-workspace:${configuration.workspaceId}` &&
    reference.keyRef === darwinStateKeyReferenceId(configuration.keyReference) &&
    reference.retainedAt === configuration.retainedAt && reference.disposeAfter === configuration.disposeAfter &&
    Array.isArray(value.artifacts), 'ownership-mismatch');
  const artifacts = value.artifacts.map((item) => descriptor(item, reference.workspaceRef, protectedStateScope(context)));
  stateAssert(canonicalSha256(artifacts.map((item) => item.ref)) === canonicalSha256(reference.materialRefs), 'artifact-integrity');
  return {
    schemaVersion: 1, kind: 'private-bootstrap-custody-locator', ...project,
    originIdentityDigest: privateDigest(value.originIdentityDigest, 'Original custody identity'),
    originPlanDigest: privateDigest(value.originPlanDigest, 'Original custody plan'),
    originApprovalEnvelopeHash: privateDigest(value.originApprovalEnvelopeHash, 'Original custody approval'),
    reference, configuration, context, artifacts
  };
}

export async function registerPrivateCustodyForDisposal(input: PhaseAdapterExecutionInput, options: {
  configuration: PrivateCustodyConfiguration; context: StateExecutionContext; workspace: ProtectedStateWorkspace;
  importJournalRef: string;
}): Promise<PrivateExternalCustodyReference> {
  const op = input.plan.operations.find((entry) => entry.actionId === 'azure.remote-import.verify');
  stateAssert(input.phase.id === 'remote-import-verified' && op, 'approval-mismatch');
  await assertAzurePhaseAuthority(input, op);
  const configuration = validatePrivateCustody(options.configuration), context = options.context, workspace = options.workspace;
  stateAssert(workspace.workspaceRef === `state-workspace:${configuration.workspaceId}`, 'ownership-mismatch');
  await workspace.assertAvailable(context);
  const scope = protectedStateScope(context);
  const bytes = await workspace.get(artifactRef(options.importJournalRef, workspace.workspaceRef), 'journal', scope);
  const artifacts: StateArtifactDescriptor[] = [];
  try {
    const journal: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    stateAssert(isRecord(journal) && journal.schemaVersion === 2 && journal.kind === 'private-bootstrap-remote-import' &&
      journal.state === 'verified' && journal.retainedAt === configuration.retainedAt && journal.disposeAfter === configuration.disposeAfter &&
      isRecord(journal.original) && isRecord(journal.candidate) && isRecord(journal.proof) &&
      journal.proof.kind === 'bootstrap-import-no-change/1' && journal.proof.exitCode === 0 &&
      Array.isArray(journal.effects) && journal.effects.length > 0 &&
      journal.effects.every((effect) => isRecord(effect) && effect.state === 'returned') &&
      Array.isArray(journal.materials) && journal.materials.length > 0 && journal.materials.length <= 128, 'recovery-required');
    for (const entry of journal.materials) {
      const material = exactObject(entry, ['descriptor', 'state'], 'Recorded private custody material');
      stateAssert(material.state === 'retained' || material.state === 'absent', 'recovery-required');
      const expected = descriptor(material.descriptor, workspace.workspaceRef, scope);
      const actual = await workspace.describe(expected.ref, expected.purpose, expected.scope);
      if (material.state === 'absent') stateAssert(actual === null, 'recovery-conflict');
      else {
        stateAssert(actual && canonicalSha256(actual) === canonicalSha256(expected), 'artifact-integrity');
        artifacts.push(expected);
      }
    }
    const original = journal.original;
    stateAssert(artifacts.some((item) => canonicalSha256(item) === canonicalSha256(journal.candidate)) &&
      (original.exists === false ? journal.originalRef === null : original.exists === true &&
        artifacts.some((item) => item.purpose === 'backup' && item.ref === journal.originalRef && item.digest === original.digest)),
    'recovery-required');
  } finally { bytes.fill(0); }
  for (const ref of [bootstrapCustodyArtifactRef(configuration.workspaceId), options.importJournalRef]) {
    const actual = await workspace.describe(artifactRef(ref, workspace.workspaceRef), 'journal', scope);
    stateAssert(actual, 'recovery-required');
    artifacts.push(actual);
  }
  stateAssert(artifacts.some((item) => item.purpose === 'candidate') &&
    new Set(artifacts.map((item) => item.ref)).size === artifacts.length, 'artifact-integrity');
  for (const artifact of artifacts) {
    const actual = await workspace.describe(artifact.ref, artifact.purpose, artifact.scope);
    stateAssert(actual && canonicalSha256(actual) === canonicalSha256(artifact), 'artifact-integrity');
  }
  const reference = validatePrivateExternalCustody({
    schemaVersion: 1, kind: 'protected-external', handle: `${handlePrefix}${randomUUID()}`, workspaceRef: workspace.workspaceRef,
    keyRef: darwinStateKeyReferenceId(configuration.keyReference), keyDisposition: 'retain-preexisting-external-key',
    retainedAt: configuration.retainedAt, disposeAfter: configuration.disposeAfter, materialRefs: artifacts.map((item) => item.ref)
  });
  const locator: CustodyLocator = {
    schemaVersion: 1, kind: 'private-bootstrap-custody-locator',
    ...await privateAccessProjectIdentity(input.inspection.projectRoot),
    originIdentityDigest: canonicalSha256(input.plan.identity), originPlanDigest: input.plan.planDigest,
    originApprovalEnvelopeHash: input.plan.approval.envelopeHash!, reference, configuration, context, artifacts
  };
  await assertAzurePhaseAuthority(input, op);
  await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', azurePorts(input).storage)
    .write(locatorKey(reference.handle), locator);
  await input.lease!.assertHeld();
  return reference;
}

async function disposal(input: PhasePlanningInput) {
  stateAssert(input.phase.id === 'bootstrap-state-disposed' && (input.inspection.scope ?? 'activation') === 'lifecycle' &&
    input.inspection.state.applicability.statePath === 'bootstrap-local', 'approval-mismatch');
  const record = latestRecordWithPayload(input.inspection, 'remote-import-verified');
  stateAssert(record, 'recovery-required');
  const retention = privateExternalRetention(record, validatePrivateExternalBootstrapRetention(input.inspection.state.bootstrapState));
  const locator = await readLocator(input, retention.externalCustody);
  stateAssert(locator.originIdentityDigest === canonicalSha256(record.header.identity), 'ownership-mismatch');
  const operations = locator.artifacts.map((artifact) => operation({
    adapter: 'local-state', phaseId: 'bootstrap-state-disposed', actionId: privateCustodyDisposalAction,
    mutationClass: 'delete-local-state', remote: false, destructive: true,
    destination: transitionDestination('external', artifact.ref),
    inputs: { custody: retention.externalCustody, purpose: artifact.purpose, remoteImportEvidenceId: record.evidenceId,
      remoteImportEvidenceDigest: retention.remoteImportEvidenceDigest, keyDisposition: 'retain-preexisting-external-key' }
  }));
  return { locator, retention, operations };
}

export async function planPrivateCustodyDisposal(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  try {
    const { operations, retention } = await disposal(input);
    stateAssert(Date.parse(retention.disposeAfter) <= input.now.getTime(), 'not-due');
    for (const op of operations) {
      try { assertOperationAllowed(input.phase, op); }
      catch { throw new AzureActivationAdmissionError('private-disposal-contract',
        'External custody requires the exact local.bootstrap-custody.dispose-artifacts contract and explicit retention of the preexisting external key. It cannot be mislabeled as key destruction or project-relative deletion.'); }
    }
    return { operations };
  } catch (error) { return { operations: [], blockers: [fail(error)] }; }
}

async function authorizeDisposal(input: PhaseAdapterExecutionInput, op: TransitionOperation) {
  validateManifestActivationForExecution(input.inspection.manifest);
  const plan = validateSavedTransitionPlan(input.plan);
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'bootstrap-state-disposed');
  stateAssert(phase && input.phase.id === phase.id && canonicalSha256(input.phase) === canonicalSha256(phase) &&
    input.inspection.graphHash === canonicalPhaseGraphHash && plan.graphHash === canonicalPhaseGraphHash &&
    plan.scope === 'lifecycle' && (plan.selectionScope ?? plan.scope) === 'lifecycle' && input.inspection.scope === 'lifecycle' &&
    plan.operations.some((entry) => canonicalSha256(entry) === canonicalSha256(op)) &&
    op.actionId === privateCustodyDisposalAction && phase.approvalGate.kind === 'destructive-disposal' && input.lease, 'approval-mismatch');
  assertPlanOperationsAllowed(plan, phase);
  await input.lease.assertHeld();
  const now = input.clock?.() ?? input.now;
  stateAssert(Date.parse(plan.createdAt) <= now.getTime() && Date.parse(plan.expiresAt) > now.getTime() &&
    canonicalSha256(plan.configuration ?? null) === canonicalSha256(input.inspection.activationInputs ?? input.inspection.state.activationInputs ?? null), 'expired');
  const requested = approvalRequestForSavedPlan(plan, phase, input.inspection.state);
  const candidates = input.inspection.approvals.filter((entry) => entry.id === plan.approval.envelopeId);
  const approval = evaluateApprovalForTransitionPlan(requested, candidates, { now });
  stateAssert(candidates.length === 1 && !approval.approvalRequired && approval.envelopeId === plan.approval.envelopeId &&
    approval.envelopeHash === plan.approval.envelopeHash, 'approval-mismatch');
  const envelope = input.inspection.approvals.find((entry) => entry.id === approval.envelopeId);
  stateAssert(envelope, 'approval-mismatch');
  await assertGovernanceApprovalIssued(input.inspection.projectRoot, envelope, azurePorts(input).storage);
  await input.lease.assertHeld();
}

export async function executePrivateCustodyDisposal(
  input: PhaseAdapterExecutionInput, ports: { workspace?: ProtectedStateWorkspace } = {}
): Promise<PhaseAdapterOutcome> {
  const completed: TransitionOperation[] = [];
  try {
    const build = await planPrivateCustodyDisposal(input);
    const reviewed = input.plan.operations.filter((op) => op.actionId === privateCustodyDisposalAction);
    if (build.blockers?.length || canonicalSha256(build.operations) !== canonicalSha256(reviewed)) return {
      status: 'blocked', blocker: build.blockers?.join(' ') ?? 'The exact external custody disposal inventory changed.', completedOperations: []
    };
    const { locator, retention } = await disposal(input);
    await authorizeDisposal(input, reviewed[0]!);
    const workspace = await openPrivateCustody(input, locator.configuration, locator.context, ports.workspace);
    const store = createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', azurePorts(input).storage);
    const records = [];
    for (let index = 0; index < locator.artifacts.length; index++) {
      const artifact = locator.artifacts[index]!, op = reviewed[index]!;
      const key = canonicalSha256({ kind: 'private-bootstrap-disposal/1', handle: retention.externalCustody.handle, ref: artifact.ref });
      const preparedKey = canonicalSha256({ key, stage: 'prepared' }), observedKey = canonicalSha256({ key, stage: 'observed' });
      const prepared = await store.read(preparedKey), observed = await store.read(observedKey);
      if (prepared) {
        const value = exactObject(prepared.value, ['schemaVersion', 'kind', 'handle', 'artifact', 'operationDigest', 'planDigest', 'approvalEnvelopeHash', 'preparedAt'], 'Private custody deletion intent');
        stateAssert(value.schemaVersion === 1 && value.kind === 'private-bootstrap-disposal-prepared' &&
          value.handle === retention.externalCustody.handle && canonicalSha256(value.artifact) === canonicalSha256(artifact) &&
          value.operationDigest === canonicalSha256(op) && typeof value.preparedAt === 'string' &&
          Number.isFinite(Date.parse(value.preparedAt)) && typeof value.planDigest === 'string' &&
          typeof value.approvalEnvelopeHash === 'string', 'recovery-conflict');
      } else stateAssert(!observed, 'recovery-required');
      const actual = await workspace.describe(artifact.ref, artifact.purpose, artifact.scope);
      if (!prepared) stateAssert(actual && canonicalSha256(actual) === canonicalSha256(artifact), 'recovery-required');
      else if (actual) {
        stateAssert(!observed && canonicalSha256(actual) === canonicalSha256(artifact), 'recovery-conflict');
        throw new AzureActivationAdmissionError('private-disposal-recovery',
          'An earlier exact deletion has an unresolved outcome and its artifact is still present. Preserve its checkpoint; no blind retry or replacement is authorized.');
      }
      if (observed) {
        const value = exactObject(observed.value, ['schemaVersion', 'kind', 'preparedDigest', 'ref', 'observedAt'], 'Private custody deletion readback');
        stateAssert(prepared && value.schemaVersion === 1 && value.kind === 'private-bootstrap-disposal-observed' &&
          value.preparedDigest === canonicalSha256(prepared.value) && value.ref === artifact.ref &&
          typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt)), 'recovery-conflict');
      }
      records.push({ artifact, op, preparedKey, observedKey, prepared, observed, actual });
    }
    for (const entry of records) {
      await authorizeDisposal(input, entry.op);
      stateAssert(Date.parse(retention.disposeAfter) <= (input.clock?.() ?? input.now).getTime(), 'not-due');
      let prepared = entry.prepared;
      if (!prepared) prepared = await store.write(entry.preparedKey, {
        schemaVersion: 1, kind: 'private-bootstrap-disposal-prepared', handle: retention.externalCustody.handle,
        artifact: entry.artifact, operationDigest: canonicalSha256(entry.op), planDigest: input.plan.planDigest,
        approvalEnvelopeHash: input.plan.approval.envelopeHash, preparedAt: (input.clock?.() ?? input.now).toISOString()
      });
      if (entry.actual) {
        await input.lease!.assertHeld();
        await workspace.removeExact(entry.artifact);
      }
      stateAssert(await workspace.describe(entry.artifact.ref, entry.artifact.purpose, entry.artifact.scope) === null, 'verification-incomplete');
      if (!entry.observed) await store.write(entry.observedKey, {
        schemaVersion: 1, kind: 'private-bootstrap-disposal-observed', preparedDigest: canonicalSha256(prepared.value),
        ref: entry.artifact.ref, observedAt: (input.clock?.() ?? input.now).toISOString()
      });
      completed.push(entry.op);
    }
    return {
      status: 'completed', resultState: 'disposed', completedOperations: completed,
      evidencePayload: { kind: 'bootstrap-state-disposed.v1', scope: 'owned-encrypted-artifacts-only',
        custody: retention.externalCustody, remoteImportEvidenceId: retention.remoteImportEvidenceId,
        remoteImportEvidenceDigest: retention.remoteImportEvidenceDigest, disposedMaterialRefs: locator.reference.materialRefs,
        keyDisposition: 'retain-preexisting-external-key', cryptographicErasure: 'not-claimed',
        retainedAt: retention.retainedAt, disposeAfter: retention.disposeAfter },
      outputs: { values: { 'bootstrap.custodyHandle': retention.externalCustody.handle,
        'bootstrap.disposedMaterialCount': locator.artifacts.length, 'bootstrap.externalKeyDestroyed': false }, resources: [] },
      cleanupWarnings: ['Only exact owned encrypted artifacts were removed. The preexisting external key remains intact; no cryptographic erasure, snapshot purge or unrelated workspace cleanup is claimed.']
    };
  } catch (error) {
    return { status: 'blocked', blocker: fail(error), completedOperations: completed,
      cleanupWarnings: ['External custody and exact deletion checkpoints are retained. No unknown deletion is retried and no preexisting key or broad workspace is removed.'] };
  }
}
