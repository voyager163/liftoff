import { randomUUID } from 'node:crypto';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { stateDigest, stateMetadataMatches, stateSnapshotMatches } from '../../domain/repair/stateful-invariants.js';
import type { StateArtifactDescriptor, StateBackendLease, StateSnapshot } from '../../domain/repair/stateful.js';
import { currentProjectMutationLease } from '../../adapters/filesystem/project-lock.js';
import {
  ApplicationPrivateOpenTofu
} from '../../adapters/azure/application-private-opentofu.js';
import {
  createApplicationPrivateRuntime, type ApplicationPrivateAdapters
} from '../../adapters/azure/application-private-runtime.js';
import { ApplicationPrivateResourceReadbackError } from '../../adapters/azure/application-private-readback.js';
import { readbackProof } from '../../governance-activation/transition-records.js';
import type {
  PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput
} from '../../governance-activation/transition-ports.js';
import type { PhaseOutputBindings } from '../../domain/governance/activation/types.js';
import { assertAzurePhaseAuthority } from './authority.js';
import {
  ApplicationPrivateError, applicationPrivateAssert as must, applicationPrivateProtocol,
  type ApplicationPrivateAuthority, type ApplicationPrivateConfiguration, type ApplicationPrivateIntent,
  type ApplicationPrivateResult, type ApplicationPrivateReview, type ApplicationPrivateRuntime,
  type ApplicationPrivateSavedPlan, type ApplicationPrivateSource
} from './application-private-contracts.js';
import {
  applicationPrivateContext, applicationPrivateInputs, applicationPrivateIntent, applicationPrivateOperations,
  applicationPrivateWindow, assertApplicationPrivateReview
} from './application-private-inputs.js';
import { inspectApplicationPrivateSource, verifyApplicationPrivateSource } from './application-private-source.js';
import {
  admitApplicationPrivatePlan, applicationPrivateJson, applicationPrivateResourceId, applicationPrivateState,
  applicationPrivateValue, inspectApplicationPrivateCandidate,
  type AdmittedApplicationPrivatePlan
} from './application-private-plan.js';
import {
  ApplicationPrivateCheckpointStore, type ApplicationPrivateJournalHandle
} from './application-private-checkpoints.js';
import {
  assertIssuedApplicationRehearsalAuthority, type ApplicationRehearsalPrivateAuthority
} from './application-rehearsal-authority.js';
import { assertIssuedStagingAuthority, type ApplicationStagingPrivateAuthority } from './application-staging-authority.js';
import { planApplicationEmptyState, executeApplicationEmptyState } from './application-empty-state.js';
import {
  applicationPrivateArtifactForTarget, assertApplicationPrivateArtifactVariables
} from './application-private-artifacts.js';
import {
  applicationPrivateFailureCode as safeCode, applicationPrivateResult as result,
  readApplicationPrivateArtifact, readApplicationPrivateSavedPlan,
  validateApplicationPrivateEffectIntents, verifyApplicationPrivateOriginalAuthority
} from './application-private-custody.js';
import {
  assertApplicationPrivateExecutionArtifact as assertExecutionArtifact, planApplicationPrivateResources
} from './application-private-planning.js';

export {
  completedApplicationPrivateResult, readApplicationPrivateArtifact, readApplicationPrivateSavedPlan,
  validateApplicationPrivateEffectIntents, verifyApplicationPrivateOriginalAuthority
} from './application-private-custody.js';

export type ApplicationPrivateOptions = ApplicationPrivateAdapters;
type ApplicationPrivateExternalAuthority = ApplicationRehearsalPrivateAuthority | ApplicationStagingPrivateAuthority;

/**
 * Concurrency boundary: an existing Azure Blob receives a real renewable lease.
 * OpenTofu runs against its backed-up copy on the attested private volume, with
 * local locking enabled. It never opens the leased remote backend. Publication
 * is one Azure Blob If-Match + owned-lease write, not an ARM-resource CAS.
 *
 * The lease excludes cooperating state writers, not portal/ARM writers. Fresh
 * resource observations bound admission and results but cannot make Azure
 * resources atomic with state. Failed/uncertain applies retain native state,
 * encrypted original backups, exact plans and individual effect intents.
 * Recovery never invokes apply. A lost lease/acquire response is allowed to
 * expire; there is no break-lease/force-unlock or cross-provider rollback.
 * Unproven process settlement never authorizes lease release or directory
 * cleanup. Renewal loses project authority when this bounded call exits; the
 * finite server lease then expires. The open checkpoint still blocks another
 * Liftoff apply. This does not fence unrelated ARM writers or prove that a
 * process surviving a CLI crash is gone.
 */
export const applicationPrivateConcurrencyContract = Object.freeze({
  protocol: applicationPrivateProtocol, remoteBackend: 'existing-private-azure-blob',
  nativeBackend: 'attested-private-local-copy', nativeLocking: true,
  publication: 'if-match-and-owned-blob-lease', resourceAtomicity: false,
  recovery: ['inspect', 'publish-retained', 'close-unapplied'],
  automaticResourceReapply: false, automaticDisposal: false
});

function unresolvedReference(input: PhaseAdapterExecutionInput): { transactionId: string; journalRef: string } | null {
  for (const operation of input.plan.operations) {
    const config = operation.inputs.applicationPrivate;
    if (!isRecord(config)) continue;
    const ref = config.mode === 'recover' ? config.checkpoint : config.reviewed;
    if (isRecord(ref) && typeof ref.transactionId === 'string' && /^[a-f0-9-]{36}$/u.test(ref.transactionId) &&
      typeof ref.journalRef === 'string' && /^state-workspace:[a-f0-9-]{36}\/[a-f0-9-]{36}$/u.test(ref.journalRef)) {
      return { transactionId: ref.transactionId, journalRef: ref.journalRef };
    }
  }
  return null;
}

/**
 * Reads selected regular source, evidence and private producer custody. `--inputs` supplies
 * phases[phaseId].privateExecution; there is no new command, flag or engine.
 * Prepare needs its own approval because private tool/state/lease access is
 * effectful. Its result supplies the opaque review ticket for a second plan.
 */
export async function planApplicationPrivateExecution(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  const phaseConfig = (input.inspection.activationInputs ?? input.inspection.state.activationInputs)?.phases[input.phase.id];
  if (isRecord(phaseConfig?.privateExecution) && phaseConfig.privateExecution.mode === 'initialize') {
    return planApplicationEmptyState(input);
  }
  return planApplicationPrivateResources(input);
}

function authorityFor(
  input: PhaseAdapterExecutionInput, config: ApplicationPrivateConfiguration, source: ApplicationPrivateSource,
  externalAuthority?: ApplicationPrivateExternalAuthority
): ApplicationPrivateAuthority {
  const operations = applicationPrivateOperations(input, config, source), operation = operations[0]!;
  const remote = input.plan.operations.filter((entry) => entry.remote);
  const authorityProtocol = input.phase.id === 'production-rehearsed' ? 'private-application-rehearsal/1' :
    input.phase.id === 'staging-qualified' ? 'private-application-staging/1' : undefined;
  must(externalAuthority?.protocol === authorityProtocol &&
    canonicalSha256(remote) === canonicalSha256([...operations, ...(externalAuthority?.additionalOperations ?? [])]),
  'exact-private-operation-required');
  must(Boolean(input.recovery) === (config.mode === 'recover') && Boolean(input.plan.recovery) === (config.mode === 'recover'),
    'explicit-recovery-authority');
  const configurationDigest = canonicalSha256(config);
  const planDigest = canonicalSha256(input.plan);
  const check = async (release = false) => {
    if (externalAuthority) {
      must(canonicalSha256(externalAuthority.input.plan) === canonicalSha256(input.plan), 'exact-external-plan-required');
      if (externalAuthority.protocol === 'private-application-rehearsal/1') await assertIssuedApplicationRehearsalAuthority(externalAuthority);
      else await assertIssuedStagingAuthority(externalAuthority);
    }
    must(canonicalSha256(input.plan) === planDigest &&
      canonicalSha256(applicationPrivateInputs(input)) === configurationDigest, 'approved-input-changed');
    const held = await currentProjectMutationLease(input.inspection.projectRoot);
    must(held, 'real-project-mutation-lease-required');
    await held.assertHeld();
    for (const selected of operations) await assertAzurePhaseAuthority(input, selected);
    const now = (input.clock?.() ?? input.now).getTime(), window = applicationPrivateWindow(config);
    must(now >= Date.parse(window.notBefore) && now < Date.parse(release ? window.releaseUntil : window.expiresAt),
      'execution-window-expired');
    if (!release) {
      await verifyApplicationPrivateSource(input.inspection.projectRoot, source);
      if (config.mode !== 'recover' || config.recovery === 'publish-retained') await assertExecutionArtifact(input, config);
    }
  };
  return { input, operation, operations, assertCurrent: () => check(), assertRelease: () => check(true) };
}

async function underLease<T>(
  authority: ApplicationPrivateAuthority, lease: StateBackendLease, action: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  await authority.assertCurrent();
  await lease.assertHeld();
  const controller = new AbortController();
  const remaining = Date.parse(authority.input.plan.expiresAt) - (authority.input.clock?.() ?? authority.input.now).getTime();
  must(remaining > 0, 'approval-expired');
  const expiry = setTimeout(() => controller.abort(), remaining);
  let failure: unknown;
  let check: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (check || controller.signal.aborted) return;
    check = (async () => { await authority.assertCurrent(); await lease.assertHeld(); })()
      .catch((error) => { failure = error; controller.abort(); }).finally(() => { check = null; });
  }, 1_000);
  try {
    const result = await action(controller.signal);
    await check;
    if (failure) throw failure;
    must(!controller.signal.aborted, 'native-authority-expired');
    await authority.assertCurrent();
    await lease.assertHeld();
    return result;
  } finally {
    clearTimeout(expiry);
    clearInterval(timer);
    await check;
  }
}

async function observeEffects(
  runtime: ApplicationPrivateRuntime, journal: ApplicationPrivateJournalHandle, intent: ApplicationPrivateIntent,
  realized: readonly string[], values: ReadonlyMap<string, Record<string, unknown>>, at: () => string,
  requireComplete: boolean
): Promise<void> {
  let firstFailure: unknown;
  for (const target of intent.targets) {
    try {
      const record = async (verify: boolean) => {
        const observed = await runtime.observe(target, verify, undefined, verify ? values.get(target.address) : undefined);
        await journal.event('resource-observed', at(), {
          address: target.address, resourceId: observed.exists ? observed.resourceId : null,
          readbackRequestId: observed.readbackRequestId, verified: observed.verified
        }, (root) => { root.observations = [...root.observations.filter((entry) => entry.address !== target.address), observed]; });
        return observed;
      };
      const raw = await record(false);
      if (realized.includes(target.address)) {
        const observed = await record(true);
        const state = values.get(target.address)!;
        must(String(applicationPrivateResourceId(target, state)).toLowerCase() === observed.resourceId.toLowerCase(), 'candidate-arm-identity');
        if (state.tags !== undefined) must(canonicalSha256(state.tags) === canonicalSha256(observed.values.tags), 'candidate-resource-tags');
        if (target.type === 'azurerm_container_app') {
          const expectedIdentity = target.expected['identity.0.identity_ids.0'];
          const observedIdentity = applicationPrivateValue(observed.values, 'identity.0.identity_ids');
          must(Array.isArray(observedIdentity) && observedIdentity.length === 1 && observedIdentity[0] === expectedIdentity,
            'candidate-workload-identity');
          if (intent.artifactSet) must(canonicalSha256(observed.artifact ?? null) ===
            canonicalSha256(applicationPrivateArtifactForTarget(intent, target)), 'candidate-artifact-role');
        }
        for (const field of ['principal_id', 'client_id', 'tenant_id', 'login_server', 'default_domain', 'latest_revision_name']) {
          if (typeof state[field] === 'string' && state[field] !== '') {
            must(state[field] === observed.values[field], 'candidate-provider-output');
          }
        }
      } else {
        must(!requireComplete && (!values.has(target.address) ? !raw.exists : raw.exists), 'unaccounted-resource-effect');
      }
    } catch (error) {
      if (error instanceof ApplicationPrivateResourceReadbackError) {
        await journal.event('resource-observed', at(), { ...error.receipt, resourceId: null, verified: false });
      }
      firstFailure ??= error;
    }
  }
  if (firstFailure) throw firstFailure;
}

async function captureCandidate(
  runtime: ApplicationPrivateRuntime, native: ApplicationPrivateOpenTofu,
  journal: ApplicationPrivateJournalHandle, at: () => string
): Promise<void> {
  must(journal.value.processSettled && journal.value.directory, 'original-process-unsettled');
  const bytes = await native.candidate(journal.value.directory);
  try {
    const candidate = await runtime.storage.workspace.put('candidate', journal.scope, bytes);
    let snapshot: StateSnapshot | null = null;
    try { snapshot = applicationPrivateState(bytes, journal.value.originalSnapshot!).snapshot; } catch { /* Preserve even an invalid partial state. */ }
    await journal.event('candidate-preserved', at(), { candidateRef: candidate.ref }, (root) => {
      root.candidate = candidate; root.candidateSnapshot = snapshot;
    });
  } finally { bytes.fill(0); }
}

async function publishCandidate(
  runtime: ApplicationPrivateRuntime, journal: ApplicationPrivateJournalHandle, lease: StateBackendLease,
  candidate: Uint8Array, original: StateSnapshot, at: () => string
): Promise<void> {
  await lease.assertHeld();
  const correlationId = randomUUID();
  await journal.event('publication-intent', at(), {
    candidateRef: journal.value.candidate!.ref, correlationId, expectedEtag: original.etag
  }, (root) => { root.publication = 'intent'; root.publicationCorrelationId = correlationId; });
  try {
    await runtime.backend.writePrivate({
      bytes: candidate, expected: original, lease, context: runtime.context, operationId: correlationId
    });
    await journal.change((root) => { root.publication = 'returned'; });
  } catch (error) {
    await journal.change((root) => { root.publication = 'uncertain'; }).catch(() => undefined);
    throw error;
  }
}

async function verifyPublished(
  runtime: ApplicationPrivateRuntime, journal: ApplicationPrivateJournalHandle, lease: StateBackendLease,
  candidate: Uint8Array, at: () => string
): Promise<void> {
  const metadata = await runtime.backend.metadata(runtime.context);
  const remote = await runtime.backend.readPrivate(metadata, runtime.context, lease);
  try {
    must(stateDigest(remote) === stateDigest(candidate) && metadata.operationId === journal.value.publicationCorrelationId,
      'private-state-publication-readback');
    const state = applicationPrivateState(remote, metadata);
    must(state.snapshot.lineage === journal.value.originalSnapshot!.lineage &&
      state.snapshot.serial! >= journal.value.originalSnapshot!.serial!, 'private-state-publication-identity');
    await lease.assertHeld();
    await journal.event('state-readback', at(), { backendId: metadata.backendId, etag: metadata.etag, version: metadata.version },
      (root) => { root.publication = 'verified'; });
  } finally { remote.fill(0); }
}

/** Resource-scoped actual result primitive; it does not grant rehearsal or phase completion. */
export async function executeApplicationPrivatePlan(
  supplied: PhaseAdapterExecutionInput, adapters: ApplicationPrivateOptions = {},
  externalAuthority?: ApplicationPrivateExternalAuthority
): Promise<ApplicationPrivateResult> {
  const started = performance.now();
  const input: PhaseAdapterExecutionInput = { ...supplied, clock: supplied.clock ??
    (() => new Date(supplied.now.getTime() + performance.now() - started)) };
  const at = () => input.clock!().toISOString();
  let config: ApplicationPrivateConfiguration | undefined, runtime: ApplicationPrivateRuntime | undefined;
  let journal: ApplicationPrivateJournalHandle | undefined, review: ApplicationPrivateReview | undefined;
  let lease: StateBackendLease | null = null, native: ApplicationPrivateOpenTofu | undefined;
  let finalResult: ApplicationPrivateResult | undefined;
  try {
    config = applicationPrivateInputs(input);
    const source = await inspectApplicationPrivateSource(input.inspection.projectRoot, input.inspection.manifest, config);
    review = assertApplicationPrivateReview(input, config, source) ?? undefined;
    const authority = authorityFor(input, config, source, externalAuthority);
    await authority.assertCurrent();
    must(!input.inspection.state.phases[input.phase.id].operation, 'unresolved-external-operation');
    const context = applicationPrivateContext(input, config);
    runtime = await createApplicationPrivateRuntime(input, applicationPrivateIntent(config), source, context, authority, adapters);
    const store = new ApplicationPrivateCheckpointStore({ authority, workspace: runtime.storage.workspace, context, configuration: config });
    const previous = await store.find();
    let slot = previous.slot;
    if (config.mode === 'prepare' && (!slot || previous.closed)) {
      if (slot) must(slot.approvalEnvelopeHash !== input.plan.approval.envelopeHash, 'fresh-preparation-approval-required');
      const created = await store.create(previous.next);
      slot = created.slot; journal = created.journal;
    } else {
      must(slot, 'original-private-checkpoint-required');
      journal = await store.open(slot);
    }
    const activeJournal = journal;
    runtime.setBackendEffects(journal.backendRecorder(authority, config));
    await verifyApplicationPrivateOriginalAuthority(input, journal);
    const requestRef = config.mode === 'recover' ? config.checkpoint : review;
    if (config.mode !== 'prepare') must(requestRef && requestRef.transactionId === slot.transactionId &&
      requestRef.journalRef === slot.journalRef, 'original-private-checkpoint-required');
    if (config.mode === 'recover') must(input.plan.approval.envelopeHash !== journal.value.originalApprovalEnvelopeHash &&
      input.plan.approval.envelopeHash !== journal.value.applyApprovalEnvelopeHash, 'fresh-recovery-approval-required');
    if (config.mode === 'recover') await journal.event('recovery-authorized', at(), {
      governancePlan: input.plan, recovery: config.recovery, candidateRef: config.candidateRef
    });
    if (config.mode === 'prepare' && journal.value.planRef) {
      must(!journal.value.nativeStarted && !journal.value.final &&
        journal.value.prepareOperationDigest === canonicalSha256(authority.operations), 'open-private-transaction');
      const saved = await readApplicationPrivateSavedPlan(runtime, journal, config);
      return result(journal, config, 'prepared', saved.review);
    }
    if (config.mode === 'prepare') must(journal.value.original === null && journal.value.events.length === 0,
      'recover-interrupted-preparation');
    let saved: ApplicationPrivateSavedPlan | undefined;
    if (journal.value.planRef) {
      saved = await readApplicationPrivateSavedPlan(runtime, journal, config);
      review = saved.review;
    }
    if (config.mode === 'apply') must(saved && !journal.value.nativeStarted && !journal.value.final && !previous.closed,
      'saved-plan-already-attempted');
    if (config.mode === 'recover' && config.recovery === 'close-unapplied') {
      must(!journal.value.nativeStarted && journal.value.publication === 'none', 'resource-effects-cannot-be-abandoned');
    }
    const selectedSource = saved?.source ?? source;
    native = new ApplicationPrivateOpenTofu({
      runner: runtime.runner, intent: applicationPrivateIntent(config), context, source: selectedSource,
      assertDirectory: (directory) => runtime!.assertDirectory(directory), authorize: () => authority.assertCurrent()
    });
    const metadata = await runtime.backend.metadata(context);
    must(metadata.exists && metadata.etag && metadata.version, 'existing-private-state-required');
    if (config.mode === 'apply') must(stateMetadataMatches(metadata, saved!.originalSnapshot), 'private-backend-changed');
    lease = await runtime.backend.acquire(metadata, context, randomUUID());
    must(lease.kind === 'blob-lease' && lease.backendId === config.backend.backend.id, 'real-runtime-blob-lease-required');
    await lease.assertHeld();
    const observedBytes = await runtime.backend.readPrivate(metadata, context, lease);
    try {
      const observedState = applicationPrivateState(observedBytes, metadata);
      if (config.mode === 'prepare') {
        const original = await runtime.storage.workspace.put('backup', journal.scope, observedBytes);
        await journal.change((root) => { root.original = original; root.originalSnapshot = observedState.snapshot; });
        const variables = await runtime.storage.workspace.describe(config.source.variablesRef, 'inspection', journal.scope);
        must(variables, 'private-variable-input-missing');
        const variableBytes = await readApplicationPrivateArtifact(runtime, variables, 'inspection');
        try {
          assertApplicationPrivateArtifactVariables(applicationPrivateJson(variableBytes), config);
          await runtime.assertProviders();
          await runtime.assertArtifact();
          const before = [];
          for (const target of config.targets) {
            const observation = await runtime.observe(target, false);
            const prior = observedState.resources.get(target.address);
            must(prior ? observation.exists && String(applicationPrivateResourceId(target, prior.values)).toLowerCase() ===
              target.resourceId.toLowerCase() : !observation.exists,
              'unowned-or-missing-resource');
            if (prior && !target.role && isRecord(observation.values.tags) &&
              observation.values.tags['liftoff-repository-id'] !== undefined) {
              must(observation.values.tags['liftoff-repository-id'] === context.projectId, 'unowned-resource');
            }
            if (observation.ownership) must(observation.ownership.ownerId === context.projectId, 'unowned-resource');
            before.push(observation);
          }
          const directory = await runtime.createDirectory();
          await journal.change((root) => { root.directory = directory; });
          const prepared = await underLease(authority, lease, (signal) => native!.prepare(directory, observedBytes, variableBytes, signal));
          try {
            const admitted = admitApplicationPrivatePlan(prepared.shown, observedBytes, metadata, source, config);
            const savedPlan = await runtime.storage.workspace.put('plan', journal.scope, prepared.saved);
            const shownPlan = await runtime.storage.workspace.put('inspection', journal.scope, prepared.shown);
            const planId = randomUUID(), planRef = `${runtime.storage.workspace.workspaceRef}/${planId}`;
            review = {
              schemaVersion: 1, protocol: applicationPrivateProtocol, transactionId: slot.transactionId,
              journalRef: journal.ref, planRef, phaseId: slot.phaseId, intentDigest: context.configurationDigest,
              sourceDigest: source.digest, backendBindingDigest: metadata.bindingDigest, binding: config.binding,
              artifact: config.artifact, ...(config.artifactSet ? { artifactSet: structuredClone(config.artifactSet) } : {}), tools: {
                tofu: config.custody.tools.tofu.sha256, python: config.custody.tools.python.sha256,
                provider: config.source.provider.binary.sha256, providerVersion: config.source.provider.version, hostId: context.hostId
              }, changes: admitted.changes, expiresAt: config.expiresAt
            };
            const plan: ApplicationPrivateSavedPlan = {
              schemaVersion: 1, protocol: applicationPrivateProtocol, transactionId: slot.transactionId,
              context, intent: applicationPrivateIntent(config), source, directory, original, originalSnapshot: observedState.snapshot,
              variables, savedPlan, shownPlan, installedFiles: prepared.installedFiles, before, review
            };
            const bytes = Buffer.from(canonicalJson(plan));
            try { await runtime.storage.workspace.put('plan', journal.scope, bytes, planId); }
            finally { bytes.fill(0); }
            await journal.change((root) => { root.planRef = planRef; });
          } finally { prepared.saved.fill(0); prepared.shown.fill(0); }
        } finally { variableBytes.fill(0); }
        await lease.release(); lease = null;
        finalResult = result(journal, config, 'prepared', review);
      } else if (config.mode === 'recover' && config.recovery === 'close-unapplied') {
        must(!journal.value.originalSnapshot || stateSnapshotMatches(journal.value.originalSnapshot, observedState.snapshot), 'original-state-changed');
        await lease.release(); lease = null;
        await journal.event('finished', at(), { disposition: 'closed-unapplied' }, (root) => { root.final = 'closed-unapplied'; });
        if (!previous.closed) await store.close(slot, 'closed-unapplied');
        finalResult = result(journal, config, 'closed-unapplied', review);
      } else {
        if (!saved) {
          must(config.mode === 'recover' && config.recovery === 'inspect', 'original-saved-plan-missing');
          await lease.release(); lease = null;
          return result(journal, config, 'inspected', review);
        }
        const privateBytes: Uint8Array[] = [];
        const load = async (descriptor: StateArtifactDescriptor, purpose: StateArtifactDescriptor['purpose']) => {
          const bytes = await readApplicationPrivateArtifact(runtime!, descriptor, purpose);
          privateBytes.push(bytes);
          return bytes;
        };
        let admitted: AdmittedApplicationPrivatePlan;
        try {
          const original = await load(saved.original, 'backup');
          const shown = await load(saved.shownPlan, 'inspection');
          const exactPlan = await load(saved.savedPlan, 'plan');
          const variables = await load(saved.variables, 'inspection');
          assertApplicationPrivateArtifactVariables(applicationPrivateJson(variables), saved.intent);
          must(stateSnapshotMatches(applicationPrivateState(original, saved.originalSnapshot).snapshot, saved.originalSnapshot), 'original-backup-changed');
          admitted = admitApplicationPrivatePlan(shown, original, saved.originalSnapshot, saved.source, saved.intent);
          must(canonicalSha256(admitted.changes) === canonicalSha256(saved.review.changes), 'saved-plan-projection-changed');
          if (config.mode === 'apply') {
            must(stateSnapshotMatches(observedState.snapshot, saved.originalSnapshot), 'private-backend-changed');
            await native.verifySaved(saved, exactPlan, original, variables);
            await runtime.assertProviders();
            await runtime.assertArtifact();
            for (const target of config.targets) {
              const fresh = await runtime.observe(target, false);
              must(fresh.privateDigest === saved.before.find((entry) => entry.address === target.address)?.privateDigest, 'resource-drift-after-review');
            }
            must(journal.value.applyApprovalEnvelopeHash === null ||
              journal.value.applyApprovalEnvelopeHash === input.plan.approval.envelopeHash, 'original-apply-approval-required');
            await journal.change((root) => {
              root.applyApprovalEnvelopeHash = input.plan.approval.envelopeHash!;
              root.applyGovernancePlan = structuredClone(input.plan);
            });
            for (const change of review!.changes.filter((entry) => entry.action !== 'no-op')) {
              await authority.assertCurrent(); await lease.assertHeld();
              const target = config.targets.find((item) => item.address === change.address)!;
              const artifact = config.artifactSet ? applicationPrivateArtifactForTarget(config, target) : null;
              const descriptor = await journal.resourceIntent({
                schemaVersion: 1, protocol: applicationPrivateProtocol, kind: 'resource-effect-intent',
                transactionId: slot.transactionId, planRef: saved.review.planRef, savedPlanDigest: saved.savedPlan.digest,
                address: change.address, action: change.action as 'create' | 'update', targetResourceId: change.targetResourceId,
                originalObservationDigest: saved.before.find((entry) => entry.address === change.address)!.privateDigest,
                operationDigest: canonicalSha256(authority.operations.find((operation) =>
                  isRecord(operation.inputs.resourceEffect) && operation.inputs.resourceEffect.address === change.address)),
                governancePlanDigest: input.plan.planDigest, approvalEnvelopeHash: input.plan.approval.envelopeHash!, preparedAt: at(),
                ...(config.artifactSet ? { artifactSet: structuredClone(config.artifactSet) } : {}),
                ...(artifact && 'role' in artifact ? { artifactRole: artifact.role } : {})
              });
              if (!journal.value.effectIntents.some((entry) => entry.ref === descriptor.ref)) {
                await journal.event('resource-intent', at(), { address: change.address, intentRef: descriptor.ref },
                  (root) => { root.effectIntents = [...root.effectIntents, descriptor]; });
              }
            }
            await validateApplicationPrivateEffectIntents(runtime, journal, saved);
            await journal.event('native-started', at(), { savedPlanRef: saved.savedPlan.ref }, (root) => {
              root.nativeStarted = true; root.processSettled = false;
            });
            let nativeFailure: unknown, exit: number | null = null;
            try { exit = await underLease(authority, lease, (signal) => native!.applySaved(saved!, signal)); }
            catch (error) { nativeFailure = error; }
            await native.quiesce();
            await journal.event('native-settled', at(), { exitCode: exit }, (root) => {
              root.processSettled = true; root.nativeExitCode = exit;
            });
            await captureCandidate(runtime, native, journal, at);
            if (nativeFailure || exit !== 0) {
              const candidate = await readApplicationPrivateArtifact(runtime, journal.value.candidate!, 'candidate');
              try {
                const checked = inspectApplicationPrivateCandidate(candidate, original, saved.originalSnapshot, admitted);
                await observeEffects(runtime, journal, saved.intent, checked.realized, checked.values, at, false).catch(() => undefined);
              } finally { candidate.fill(0); }
              throw nativeFailure ?? new ApplicationPrivateError('native-apply-failed');
            }
          } else {
            if (config.recovery === 'inspect' && !journal.value.nativeStarted) {
              must(stateSnapshotMatches(observedState.snapshot, saved.originalSnapshot), 'original-state-changed');
              await lease.release(); lease = null;
              return result(journal, config, 'inspected', review);
            }
            must(journal.value.nativeStarted && journal.value.processSettled, 'original-process-unsettled');
            await validateApplicationPrivateEffectIntents(runtime, journal, saved);
            if (!journal.value.candidate) await captureCandidate(runtime, native, journal, at);
            if (config.recovery === 'publish-retained') must(config.candidateRef === journal.value.candidate!.ref, 'reviewed-candidate-changed');
          }
          const candidate = await readApplicationPrivateArtifact(runtime, journal.value.candidate!, 'candidate');
          try {
            const checked = inspectApplicationPrivateCandidate(candidate, original, saved.originalSnapshot, admitted);
            const originalCurrent = stateSnapshotMatches(observedState.snapshot, saved.originalSnapshot);
            const candidateCurrent = stateDigest(observedBytes) === journal.value.candidate!.digest &&
              metadata.operationId === journal.value.publicationCorrelationId && journal.value.publicationCorrelationId !== null;
            must(originalCurrent || candidateCurrent, 'recovery-state-precondition');
            await observeEffects(runtime, journal, saved.intent, checked.realized, checked.values, at, false);
            if (config.mode === 'apply') must(checked.complete, 'native-apply-incomplete');
            for (const target of saved.intent.targets.filter((entry) => !checked.realized.includes(entry.address) && checked.values.has(entry.address))) {
              must(journal.value.observations.find((entry) => entry.address === target.address)?.privateDigest ===
                saved.before.find((entry) => entry.address === target.address)?.privateDigest, 'partial-resource-drift');
            }
            if (config.mode === 'recover' && config.recovery === 'inspect') {
              await lease.release(); lease = null;
              return result(journal, config, 'inspected', review);
            }
            await authority.assertCurrent();
            await runtime.assertArtifact();
            await underLease(authority, lease, (signal) => native!.verifyReadback(saved!.directory, candidate, signal));
            await journal.event('state-readback', at(), { kind: 'independent-private-resource-refresh', result: 'no-change',
              toolIdentity: config.custody.tools.tofu.sha256 });
            if (originalCurrent && stateDigest(candidate) !== saved.original.digest) {
              await publishCandidate(runtime, journal, lease, candidate, saved.originalSnapshot, at);
            } else if (originalCurrent) {
              await journal.event('state-readback', at(), { disposition: 'unchanged-original' });
            }
            if (!originalCurrent || stateDigest(candidate) !== saved.original.digest) await verifyPublished(runtime, journal, lease, candidate, at);
            else {
              const fresh = await runtime.backend.metadata(context);
              const bytes = await runtime.backend.readPrivate(fresh, context, lease);
              try { must(stateSnapshotMatches(applicationPrivateState(bytes, fresh).snapshot, saved.originalSnapshot), 'unchanged-state-readback'); }
              finally { bytes.fill(0); }
            }
            await lease.release(); lease = null;
            const disposition = checked.complete ? 'completed' as const : 'partial-published' as const;
            await journal.event('finished', at(), { disposition }, (root) => { root.final = disposition; });
            if (!previous.closed) await store.close(slot, disposition);
            finalResult = result(journal, config, checked.complete ? 'executed' : 'partial-published', review);
          } finally { candidate.fill(0); }
        } finally { for (const bytes of privateBytes) bytes.fill(0); }
      }
    } finally { observedBytes.fill(0); }
    must(activeJournal === journal, 'private-journal-replaced');
  } catch (error) {
    if (runtime && journal?.value.nativeStarted && journal.value.processSettled && config &&
      journal.value.observations.length < config.targets.length) {
      await observeEffects(runtime, journal, config, [], new Map(), at, false).catch(() => undefined);
    }
    await journal?.event('blocked', at(), { code: safeCode(error) }).catch(() => undefined);
    finalResult = result(journal, config, 'blocked', review, error);
    const unresolved = !journal ? unresolvedReference(input) : null;
    if (unresolved) finalResult = { ...finalResult, ...unresolved, state: 'unresolved-private-record' };
  } finally {
    let cleanupFailure: unknown;
    try { await native?.quiesce(); } catch (error) { cleanupFailure = error; }
    if (lease && !cleanupFailure) {
      try { await lease.release(); } catch (error) { cleanupFailure ??= error; }
    }
    if (cleanupFailure) {
      await journal?.event('blocked', at(), { code: 'owned-process-or-lease-settlement-incomplete' }).catch(() => undefined);
      finalResult = result(journal, config, 'blocked', review, new ApplicationPrivateError('owned-process-or-lease-settlement-incomplete'));
    }
  }
  return finalResult ?? result(journal, config, 'blocked', review, new ApplicationPrivateError('private-execution-incomplete'));
}

/**
 * Invoke once for the combined per-resource operations, inside the existing
 * project mutation lock. Core prerequisites return actual identities but not
 * ready state: an additional exact scoped-RBAC plan is mandatory. Foundation
 * consumes current verified build evidence and performs ARM, ACR, health and
 * private state readback. Rehearsal callers may reuse the typed plan/observation
 * primitives only under their separately registered authority.
 *
 * Recovery keeps the original intent/review/checkpoint and separately approves
 * a recovery window plus an exact retained candidateRef. Inspect never applies;
 * publish-retained never plans or applies; close-unapplied cannot discard effects.
 * Protected directories, plans and backups are retained, not auto-disposed.
 */
export async function executeApplicationPrivateExecution(
  input: PhaseAdapterExecutionInput, options: ApplicationPrivateOptions = {}
): Promise<PhaseAdapterOutcome> {
  const phaseConfig = (input.inspection.activationInputs ?? input.inspection.state.activationInputs)?.phases[input.phase.id];
  if (isRecord(phaseConfig?.privateExecution) && phaseConfig.privateExecution.mode === 'initialize') {
    return executeApplicationEmptyState(input, options);
  }
  const actual = await executeApplicationPrivatePlan(input, options);
  const completed = actual.status === 'executed' && actual.additionalReview === null;
  const resourceOperations = input.plan.operations.filter((entry) =>
    entry.actionId === (input.phase.id === 'application-foundation' ? 'azure.application-foundation.apply' : 'azure.prerequisites.apply'));
  const control = input.plan.operations.find((entry) => entry.actionId.startsWith('azure.application-private.'));
  const observedEffects = resourceOperations.filter((operation) => {
    const selected = operation.inputs.resourceEffect;
    return isRecord(selected) && actual.effects.some((effect) => effect.address === selected.address && effect.status === 'observed');
  });
  const preparedReview = actual.reviewed !== undefined && (actual.status === 'prepared' ||
    actual.status === 'inspected' && actual.state === 'unchanged' && actual.effects.every((effect) => effect.status === 'not-attempted'));
  const reviewRequired = preparedReview ||
    actual.status === 'executed' && actual.additionalReview !== null;
  const settledControl = ['prepared', 'executed', 'inspected', 'partial-published', 'closed-unapplied'].includes(actual.status);
  const values: Record<string, string | number | boolean | null> = {
    'application.private.status': actual.status, 'application.private.transactionId': actual.transactionId,
    'application.private.journalRef': actual.journalRef, 'application.private.planRef': actual.reviewed?.planRef ?? null,
    'application.private.candidateRef': actual.retainedCandidateRef
  };
  for (const identity of actual.identities) {
    values[`application.private.${identity.address}.principalId`] = identity.principalId;
    values[`application.private.${identity.address}.clientId`] = identity.clientId;
    values[`application.private.${identity.address}.tenantId`] = identity.tenantId;
  }
  const observed = actual.observations.filter((entry) => entry.exists && entry.verified);
  const resources = [...new Map(observed.flatMap((entry) => [
    { resourceId: entry.resourceId, resourceType: entry.resourceType, readbackRequestId: entry.readbackRequestId,
      observedAt: entry.observedAt, runtime: entry.runtime },
    ...entry.dependencies.map((dependency) => ({
      resourceId: dependency.resourceId, resourceType: dependency.resourceType, readbackRequestId: dependency.readbackRequestId,
      observedAt: entry.observedAt, runtime: null
    }))
  ]).map((entry) => [entry.resourceId, entry])).values()];
  const outputs: PhaseOutputBindings = {
    values, resources: resources.map((entry) => ({ provider: 'azure', resourceType: entry.resourceType, resourceId: entry.resourceId }))
  };
  const blockers: Record<ApplicationPrivateResult['status'], string> = {
    prepared: 'Exact private saved-plan bytes are prepared. Review the returned public projection in a separate apply plan; no application resources have been applied.',
    executed: actual.additionalReview === 'complete-application-deployment'
      ? 'Application dependencies are observed. Prepare and separately approve the complete application plan using their actual outputs; this is not application deployment proof.'
      : 'The prerequisite core is observed. Create a separate exact RBAC plan using the actual returned workload principal/client IDs; no unknown principal or blanket RBAC approval was used.',
    inspected: 'Original private execution inspected without applying. Review exact retained candidate publication or close only an unapplied transaction.',
    'partial-published': 'Accounted partial state was published and independently read back. Retain the original records and review a new resource plan for remaining effects.',
    'closed-unapplied': 'Only the never-applied private transaction was closed; originals remain retained. A new exact preparation and approval are required.',
    blocked: 'Private execution is incomplete. Preserve its exact original checkpoint; do not repeat apply.'
  };
  return {
    status: completed ? 'completed' : reviewRequired ? 'review-required' : 'blocked',
    ...(completed ? { resultState: 'verified' as const } : { blocker: actual.blocker ?? blockers[actual.status] }),
    evidencePayload: { kind: `${input.phase.id}.v1`, applicationPrivate: actual },
    outputs,
    liveReadback: resources.map((entry) => readbackProof({ ...input, clock: () => new Date(entry.observedAt) }, 'azure', entry.resourceType, entry.resourceId, {
      readbackRequestId: entry.readbackRequestId, observedAt: entry.observedAt, runtime: entry.runtime
    })),
    completedOperations: [...(control && settledControl ? [control] : []), ...observedEffects],
    ...(reviewRequired ? { review: {
      schemaVersion: 1 as const,
      kind: preparedReview || actual.additionalReview === 'complete-application-deployment'
        ? 'application-private-plan' as const : 'application-prerequisites-rbac' as const,
      phaseId: input.phase.id, sourcePlanDigest: input.plan.planDigest,
      payload: preparedReview
        ? { nextMode: 'apply', reviewed: actual.reviewed }
        : { nextScope: actual.additionalReview === 'complete-application-deployment' ? 'foundation' : 'prerequisites-rbac',
          identities: actual.identities, resources: actual.observations }
    } } : {}),
    ...(input.inspection.state.phases[input.phase.id].operation
      ? { operation: input.inspection.state.phases[input.phase.id].operation } : {}),
    cleanupWarnings: actual.journalRef ? [
      `Retained private application checkpoint ${actual.journalRef}; no automatic state/resource rollback, reapply or disposal.`
    ] : []
  };
}
