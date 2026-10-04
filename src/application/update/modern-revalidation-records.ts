import { randomUUID } from 'node:crypto';
import { createLocalRevalidationRecordStore, type LocalRevalidationRecordStore } from '../../adapters/filesystem/update-previews.js';
import { inspectLocalVerificationCandidate } from '../../adapters/filesystem/reviewed-update-transaction.js';
import {
  captureCompletionInputs, compareCompletionInputs, completionPreconditions, completionSnapshot,
  readCompletionFile, validateCompletionIndex
} from '../../adapters/filesystem/modern-local-publication-inputs.js';
import type { ProjectFileMutation } from '../../adapters/filesystem/project-transaction.js';
import { canonicalJson, canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { copyModernLocalData, localInputFailure, rawLocalDigest } from '../../domain/governance/activation/modern-local-inputs.js';
import {
  completedExecutionBinding, completionHash, completionTime, type CompletionProtectedIndex
} from '../../domain/governance/activation/modern-local-completion.js';
import {
  localRevalidationPolicy, revalidationArtifactBytes, revalidationPhaseIds, revalidationPublicationFingerprint,
  validateRevalidationIntent, validateRevalidationResult,
  type LocalRevalidationArtifact, type LocalRevalidationIntent, type LocalRevalidationResult, type LocalRevalidationTarget
} from '../../domain/governance/activation/modern-revalidation-publication.js';
import { createModernActivationRecordContract } from '../../domain/governance/activation/modern-records.js';
import { createManifestV8ProjectReader } from '../../domain/project/manifest/v8-project.js';
import { exactRecord } from '../../domain/project/manifest/fields.js';
import { createModernHistoryContract } from '../../governance-activation/modern-history-contracts.js';
import { readCompletedLocalExecutionRecords, readCompletedModernLocalExecution } from '../governance/modern-local-approval.js';
import { requireIdleCompletionBoundary } from '../governance/modern-local-finalization.js';
import { createLocalEvidencePlan } from '../governance/modern-local-evidence.js';
import { validateCapturedModernSuccessorSource, type ModernSuccessorSource } from '../governance/modern-installed-preflight.js';
import { projectCatalog } from '../project/catalog.js';
import { planModernSuccessorRevalidation, type ModernSuccessorRevalidationPlan } from './modern-revalidation.js';

export const revalidationStore = (root: string) => createLocalRevalidationRecordStore(root);

export async function readRevalidationIntent(root: string, fingerprint: string, store = revalidationStore(root)) {
  completionHash(fingerprint);
  const saved = await store.read('preview', fingerprint);
  if (!saved) localInputFailure('Original successor revalidation intent is missing.');
  const raw = copyModernLocalData(saved.value) as LocalRevalidationIntent;
  const intent = validateRevalidationIntent(raw, new Date(raw.createdAt));
  if (intent.projectRoot !== root || intent.fingerprint !== fingerprint || completionTime(intent.createdAt) > Date.now()) {
    localInputFailure('Revalidation intent root or issuance differs.');
  }
  return intent;
}

function artifact(intent: LocalRevalidationIntent, role: LocalRevalidationArtifact['role'], content: Buffer,
  pathParts: string[] | null, mode: number | null): LocalRevalidationArtifact {
  const value: LocalRevalidationArtifact = {
    kind: 'liftoff-local-revalidation-artifact', schemaVersion: 1, projectRoot: intent.projectRoot,
    operationId: intent.operationId, intentFingerprint: intent.fingerprint, role, pathParts, mode,
    contentBase64: content.toString('base64'), bytes: content.length, rawDigest: rawLocalDigest(content)
  };
  revalidationArtifactBytes(value, intent);
  return value;
}

async function loadArtifact(store: LocalRevalidationRecordStore, key: string, intent: LocalRevalidationIntent) {
  completionHash(key);
  const saved = await store.read('artifact', key);
  if (!saved) localInputFailure('Exact revalidation artifact is missing.');
  const value = copyModernLocalData(saved.value) as LocalRevalidationArtifact, bytes = revalidationArtifactBytes(value, intent);
  if (canonicalSha256(value) !== key) localInputFailure('Revalidation artifact key differs from its exact original bytes.');
  return { value, bytes };
}

export async function loadRevalidationResult(root: string, key: string, store = revalidationStore(root)) {
  completionHash(key);
  const saved = await store.read('result', key);
  if (!saved) localInputFailure('Exact revalidation result is missing.');
  const raw = copyModernLocalData(saved.value) as LocalRevalidationResult;
  const intent = await readRevalidationIntent(root, raw.fingerprint, store), result = validateRevalidationResult(raw, intent);
  if (key !== result.fingerprint && key !== result.publicationFingerprint || completionTime(result.completedAt) > Date.now()) {
    localInputFailure('Revalidation result belongs to another review or is dated in the future.');
  }
  const protectedArtifact = await loadArtifact(store, result.protectedIndexKey, intent);
  if (protectedArtifact.value.role !== 'protected-index') localInputFailure('Revalidation protected index has the wrong artifact role.');
  const index = validateCompletionIndex(JSON.parse(protectedArtifact.bytes.toString('utf8')) as CompletionProtectedIndex);
  if (index.projectRoot !== root || canonicalSha256(index) !== intent.protectedSetDigest) {
    localInputFailure('Revalidation protected inputs differ from the reviewed source.');
  }
  const mutations: ProjectFileMutation[] = [];
  for (const target of result.targets) {
    const item = await loadArtifact(store, target.artifactKey, intent);
    if (item.value.role !== 'target' || canonicalSha256(item.value.pathParts) !== canonicalSha256(target.pathParts) ||
        item.value.rawDigest !== target.target.rawDigest || item.value.bytes !== target.target.bytes || item.value.mode !== target.target.mode) {
      localInputFailure('Revalidation target differs from its exact attributed artifact.');
    }
    mutations.push({ type: 'write', pathParts: [...target.pathParts], content: item.bytes, mode: target.target.mode! });
  }
  return { intent, result, index, mutations };
}

export async function compareRevalidationExecution(intent: LocalRevalidationIntent) {
  const records = await readCompletedLocalExecutionRecords(intent.projectRoot, intent.execution.executionFingerprint);
  if (canonicalSha256(completedExecutionBinding(records, intent.execution.rootIdentity)) !== canonicalSha256(intent.execution)) {
    localInputFailure('Revalidation native execution provenance changed.');
  }
  return records;
}

function admissible(source: ModernSuccessorSource) {
  const state = source.current.state, manifest = source.manifest;
  if (manifest.governance.profile === 'none') localInputFailure('A successor requires its original governance identity.');
  if (state.remoteBinding || state.bootstrapState || state.activeChange || state.taskProjection ||
      Object.entries(state.phases).some(([id, phase]) => phase.operation ||
        !revalidationPhaseIds.some(local => local === id) &&
        (phase.state !== 'pending' || phase.evidence.length || phase.approvals.length || phase.executionPlanDigest || phase.blockers.length)) ||
      Object.keys(state.phaseOutputs ?? {}).length) {
    localInputFailure('Successor revalidation cannot reset active operations, nonlocal progression or current retained state.');
  }
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({ project: manifest.project, framework: manifest.framework });
  const context = {
    recordedIdentity: manifest.governance.activationIdentity, profile: manifest.governance.profile,
    policyVersion: manifest.governance.policyVersion, selection: { ...leaf, profile: manifest.governance.profile },
    pluginResolutionDigest: manifest.plugins.resolutionDigest, activeLayoutDigest: manifest.governance.activationIdentity.activeLayoutDigest
  };
  return { api: createModernActivationRecordContract(projectCatalog, context), history: createModernHistoryContract(projectCatalog, context) };
}

function protectRetention(source: ModernSuccessorSource, parts: readonly string[]) {
  const key = (value: readonly string[]) => value.join('/').normalize('NFC').toLowerCase(), target = key(parts);
  if (source.retention.some(obligation => obligation.protectedPaths.some(parts => {
    const retained = key(parts);
    return target === retained || target.startsWith(`${retained}/`) || retained.startsWith(`${target}/`);
  }))) localInputFailure('Revalidation target overlaps a preservation-only retained path.');
}

interface RecordSchedule {
  phases: { planCreatedAt: string; evidenceId: string | null; producedAt: string | null; updatedAt: string }[];
  completedAt: string;
}

function constructRecords(source: ModernSuccessorSource, current: Awaited<ReturnType<typeof readCompletedModernLocalExecution>>,
  intent: LocalRevalidationIntent, sourcePlan: ModernSuccessorRevalidationPlan, schedule?: RecordSchedule) {
  const { api, history } = admissible(source), canonical = intent.projectRoot;
  if (!current.preview.selectedPlan) localInputFailure('Revalidation lacks its actual native baseline plan.');
  if (api.identity.workflow === 'openspec' && sourcePlan.completionSource.status === 'already-completed-source' &&
      (current.preview.schemaVersion !== 5 || current.result.schemaVersion !== 4)) {
    localInputFailure('Archived successor completion requires fresh complete current/main/archive native validation.');
  }
  const refs = { plans: [...source.current.records.plans ?? []], evidence: [...source.current.records.evidence ?? []],
    approvals: [...source.current.records.approvals ?? []] };
  let activation = source.current.state, baselineEvidence: ReturnType<typeof api.createEvidence> | undefined;
  const review = { kind: 'revalidation' as const, fingerprint: intent.fingerprint, projectRoot: canonical, expiresAt: intent.expiresAt, execution: intent.execution };
  const produced: { pathParts: string[]; content: Buffer; purpose: LocalRevalidationTarget['purpose'] }[] = [];
  const phases: LocalRevalidationResult['phases'] = [];
  for (const [position, phaseId] of revalidationPhaseIds.entries()) {
    const times = schedule?.phases[position];
    const plan = position === 1 ? current.preview.selectedPlan :
      createLocalEvidencePlan(api, review, activation, phaseId, times?.planCreatedAt ?? new Date().toISOString());
    refs.plans = [...refs.plans.filter(value => canonicalSha256(value) !== canonicalSha256(plan)), plan];
    produced.push({ pathParts: ['governance', 'plans', `${canonicalSha256(plan)}.json`],
      content: Buffer.from(api.encodeRecord({ kind: 'plan', record: plan }, refs).content),
      purpose: position === 0 ? 'input-plan' : position === 1 ? 'baseline-plan' : 'completion-plan' });
    if (position === 2 && sourcePlan.completionSource.status === 'blocked') {
      const blockers = sourcePlan.completionSource.blockers;
      activation = api.stateAfterOutcome({ state: activation, plan, phaseState: 'blocked', updatedAt: times?.updatedAt ?? new Date().toISOString(), blocker: blockers.join(' ') }, refs);
      phases.push({ phaseId, status: 'blocked', evidenceId: null, blockers: [...blockers] });
      continue;
    }
    const payload = position === 0 ? { kind: 'local-inputs-valid.v1', schemaVersion: 1, workflow: api.identity.workflow, execution: intent.execution } :
      position === 1 ? { kind: 'local-baseline-verified.v1', schemaVersion: 1, workflow: api.identity.workflow,
        checks: current.result.checks, preparation: current.result.preparation, execution: intent.execution } :
        { kind: 'local-complete.v1', schemaVersion: 1, workflow: api.identity.workflow, frameworkValidation: 'verified',
          frameworkFinalization: api.identity.workflow === 'openspec' ? 'synced-archived' : 'finalized',
          baselineEvidenceId: baselineEvidence!.evidenceId, baselineHeaderDigest: canonicalSha256(baselineEvidence!.header),
          execution: intent.execution, revalidationFingerprint: intent.fingerprint, completionSource: sourcePlan.completionSource };
    const evidence = api.createEvidence({ plan, evidenceId: times ? times.evidenceId ?? localInputFailure('Revalidation proof identity is missing.') : randomUUID(),
      repositoryId: activation.repository.id, producedAt: times ? times.producedAt ?? localInputFailure('Revalidation proof time is missing.') : new Date().toISOString(),
      producer: 'liftoff-native-successor-revalidation', result: 'verified', payload }, refs);
    refs.evidence.push(evidence);
    activation = api.stateAfterOutcome({ state: activation, plan, phaseState: 'verified', updatedAt: times?.updatedAt ?? new Date().toISOString(), evidenceId: evidence.evidenceId }, refs);
    if (position === 1) {
      baselineEvidence = evidence;
      // Only this fresh native proof, before any nonlocal progress, can replace the current local anchor.
      activation = api.readState({ ...activation, baselineAnchor: intent.execution.baselineDigest }, refs);
    }
    phases.push({ phaseId, status: 'complete', evidenceId: evidence.evidenceId, blockers: [] });
    produced.push({ pathParts: ['governance', 'evidence', `${evidence.evidenceId}.json`],
      content: Buffer.from(api.encodeRecord({ kind: 'evidence', record: evidence }, refs).content),
      purpose: position === 0 ? 'input-evidence' : position === 1 ? 'baseline-evidence' : 'completion-evidence' });
  }
  const complete = phases.every(phase => phase.status === 'complete'), completedAt = schedule?.completedAt ?? new Date().toISOString();
  const journal = history.readJournal({ ...source.journal, revalidation: {
    status: complete ? 'complete' : 'blocked', updatedAt: completedAt,
    phases: phases.map(({ phaseId, status, evidenceId, blockers }) => ({ phaseId, status, evidenceIds: evidenceId ? [evidenceId] : [], blockers })),
    nextAction: complete ? null : 'Review the incomplete framework setup separately; successor revalidation does not edit or archive it.'
  } }, source.journal.semanticInput, completedAt, { state: activation, records: refs });
  produced.push({ pathParts: ['governance', 'activation-state.json'], content: Buffer.from(api.encodeRecord({ kind: 'state', record: activation }, refs).content), purpose: 'state' },
    { pathParts: ['governance', 'migration-state.json'], content: Buffer.from(canonicalJson(journal)), purpose: 'migration-journal' });
  return { produced, phases, completedAt };
}

/** Reconstructs every proposed proof/state/journal byte from live source and original native provenance before effects. */
export async function validateRevalidationConstruction(review: Awaited<ReturnType<typeof loadRevalidationResult>>) {
  const { intent, result } = review;
  const current = await readCompletedModernLocalExecution(intent.projectRoot, intent.execution.executionFingerprint);
  const source = await validateCapturedModernSuccessorSource(current.inspection.installed.snapshot);
  const sourcePlan = await planModernSuccessorRevalidation(current.inspection), { api } = admissible(source);
  if (current.inspection.local.status !== 'modern-observed') localInputFailure('Revalidation requires a complete actual local capture.');
  const index = await captureCompletionInputs(current.inspection.installed.snapshot, current.inspection.local.snapshot);
  if (canonicalSha256(index) !== intent.protectedSetDigest || canonicalSha256(index) !== canonicalSha256(review.index) ||
      index.physical.find(item => item.path === intent.projectRoot)?.identity !== intent.execution.rootIdentity) {
    localInputFailure('Revalidation protected capture or root identity differs from independently observed complete inputs.');
  }
  if (source.binding !== intent.sourceBinding || sourcePlan.fingerprint !== intent.sourcePlanFingerprint ||
      source.journal.semanticTransitionDigest !== intent.originalTransitionDigest ||
      canonicalSha256(source.journal.preparation) !== intent.originalPreparationDigest ||
      canonicalSha256(completedExecutionBinding(current, intent.execution.rootIdentity)) !== canonicalSha256(intent.execution)) {
    localInputFailure('Actual revalidation source or completed native operation differs from the original intent.');
  }
  const records = result.targets.map((target, index) => {
    const mutation = review.mutations[index];
    if (mutation.type !== 'write') localInputFailure('Revalidation requires exact write records.');
    return { purpose: target.purpose, value: JSON.parse(Buffer.from(mutation.content).toString('utf8')) as unknown };
  });
  const original = source.current.records, plans = [...original.plans ?? [], ...records.filter(r => r.purpose.endsWith('-plan')).map(r => r.value)];
  const refs = { plans: [...new Map(plans.map(plan => [canonicalSha256(plan), plan])).values()],
    evidence: [...original.evidence ?? [], ...records.filter(r => r.purpose.endsWith('-evidence')).map(r => r.value)], approvals: original.approvals };
  const state = api.readState(records.find(r => r.purpose === 'state')?.value, refs);
  const schedule: RecordSchedule = { completedAt: result.completedAt, phases: revalidationPhaseIds.map((id, index) => {
    const prefix = index === 0 ? 'input' : index === 1 ? 'baseline' : 'completion';
    const plan = api.readPlan(records.find(r => r.purpose === `${prefix}-plan`)?.value, refs);
    const proofValue = records.find(r => r.purpose === `${prefix}-evidence`);
    const proof = proofValue ? api.readEvidence(proofValue.value, refs) : null;
    const times = [state.phases[id].updatedAt, ...(index === 1 ? [] : [plan.createdAt]), ...(proof ? [proof.header.producedAt] : [])];
    if (times.some(time => completionTime(time) < completionTime(intent.createdAt) || completionTime(time) > completionTime(result.completedAt)) ||
        proof && completionTime(proof.header.producedAt) > completionTime(state.phases[id].updatedAt)) {
      localInputFailure('Revalidation record production is outside its actual construction interval.');
    }
    return { planCreatedAt: plan.createdAt, evidenceId: proof?.evidenceId ?? null,
      producedAt: proof?.header.producedAt ?? null, updatedAt: state.phases[id].updatedAt };
  }) };
  const expected = constructRecords(source, current, intent, sourcePlan, schedule);
  if (canonicalSha256(expected.phases) !== canonicalSha256(result.phases) || expected.produced.length !== review.mutations.length) {
    localInputFailure('Revalidation outcomes differ from the actual native/framework observations.');
  }
  for (const record of expected.produced) {
    protectRetention(source, record.pathParts);
    const mutation = review.mutations.find(item => item.pathParts.join('/') === record.pathParts.join('/'));
    if (!mutation || mutation.type !== 'write' || !Buffer.from(mutation.content).equals(record.content)) {
      localInputFailure('Proposed revalidation bytes differ from independently reconstructed current proof.');
    }
  }
  await compareCompletionInputs(review.index, result.targets, 'original');
}

/** Builds exact local record bytes from actual completed execution; publication is a separate consent. */
export async function prepareModernSuccessorRevalidation(root: string, request: {
  kind: 'revalidate-successor'; executionFingerprint: string;
}): Promise<LocalRevalidationResult> {
  ({ root, request } = copyModernLocalData({ root, request }));
  exactRecord(request, ['kind', 'executionFingerprint'], 'Successor revalidation request');
  if (request.kind !== 'revalidate-successor') localInputFailure('Only finite successor revalidation is registered.');
  const { root: canonical } = await requireIdleCompletionBoundary(root);
  const current = await readCompletedModernLocalExecution(canonical, request.executionFingerprint);
  const source = await validateCapturedModernSuccessorSource(current.inspection.installed.snapshot);
  admissible(source);
  const sourcePlan = await planModernSuccessorRevalidation(current.inspection), local = current.inspection.local;
  if (local.status !== 'modern-observed' || sourcePlan.runtime.status !== 'planned' || !current.preview.selectedPlan) {
    localInputFailure('Revalidation requires independently valid current inputs and the actual governed native baseline plan.');
  }
  const index = await captureCompletionInputs(current.inspection.installed.snapshot, local.snapshot);
  const identity = index.physical.find(item => item.path === canonical)?.identity;
  if (!identity) localInputFailure('Revalidation lacks its actual root identity.');
  const now = new Date(), createdAt = now.toISOString(), store = revalidationStore(canonical);
  const body = {
    kind: 'liftoff-local-revalidation-preview' as const, schemaVersion: 1 as const, operationKind: 'revalidate-successor' as const,
    projectRoot: canonical, operationId: randomUUID(), createdAt,
    expiresAt: new Date(now.getTime() + localRevalidationPolicy.approvalLifetimeMs).toISOString(),
    sourceBinding: source.binding, sourcePlanFingerprint: sourcePlan.fingerprint,
    originalTransitionDigest: source.journal.semanticTransitionDigest, originalPreparationDigest: canonicalSha256(source.journal.preparation),
    execution: completedExecutionBinding(current, identity), protectedSetDigest: canonicalSha256(index), policyDigest: canonicalSha256(localRevalidationPolicy)
  };
  const intent = validateRevalidationIntent({ ...body, fingerprint: canonicalSha256(body) }, now);
  await store.write('preview', intent.fingerprint, intent);
  const { produced, phases, completedAt } = constructRecords(source, current, intent, sourcePlan);
  const targets: LocalRevalidationTarget[] = [], mutations: ProjectFileMutation[] = [];
  for (const target of produced) {
    protectRetention(source, target.pathParts);
    const original = await readCompletionFile(canonical, target.pathParts), mode = original.mode ?? 0o600;
    if (target.purpose !== 'state' && target.purpose !== 'migration-journal' && original.content !== undefined && !original.content.equals(target.content)) {
      localInputFailure('Revalidation cannot replace original immutable proof or plan bytes.');
    }
    const value = artifact(intent, 'target', target.content, target.pathParts, mode), artifactKey = canonicalSha256(value);
    await store.write('artifact', artifactKey, value);
    targets.push({ pathParts: target.pathParts, operation: 'write', original: completionSnapshot(original),
      target: { exists: true, rawDigest: value.rawDigest, bytes: value.bytes, mode }, artifactKey, purpose: target.purpose });
    mutations.push({ type: 'write', pathParts: target.pathParts, content: target.content, mode });
  }
  const protectedArtifact = artifact(intent, 'protected-index', Buffer.from(canonicalJson(index)), null, null);
  const protectedIndexKey = canonicalSha256(protectedArtifact);
  await store.write('artifact', protectedIndexKey, protectedArtifact);
  const preconditions = await completionPreconditions(index, targets);
  const candidate = await inspectLocalVerificationCandidate(canonical, mutations, preconditions);
  validateRevalidationIntent(intent, new Date());
  const actual = await readCompletedModernLocalExecution(canonical, request.executionFingerprint);
  if (canonicalSha256(actual.preview) !== intent.execution.previewDigest ||
      (await planModernSuccessorRevalidation(actual.inspection)).fingerprint !== intent.sourcePlanFingerprint) {
    localInputFailure('Actual native source changed during revalidation construction.');
  }
  await compareCompletionInputs(index, targets, 'original');
  const reviewCreatedAt = new Date().toISOString(), core = {
    kind: 'liftoff-local-revalidation-result' as const, schemaVersion: 1 as const, projectRoot: canonical,
    operationId: intent.operationId, fingerprint: intent.fingerprint, execution: intent.execution,
    originalTransitionDigest: intent.originalTransitionDigest, originalPreparationDigest: intent.originalPreparationDigest,
    startedAt: createdAt, completedAt, protectedIndexKey, protectedSetDigest: intent.protectedSetDigest, phases, targets,
    targetSetDigest: canonicalSha256(targets), candidateBinding: candidate.binding, candidateSize: candidate.size,
    reviewCreatedAt, reviewExpiresAt: new Date(Date.parse(reviewCreatedAt) + localRevalidationPolicy.approvalLifetimeMs).toISOString()
  };
  const publication = { ...core, publicationFingerprint: revalidationPublicationFingerprint(core) };
  const result = validateRevalidationResult({ ...publication, resultDigest: canonicalSha256(publication) }, intent);
  await store.write('result', intent.fingerprint, result);
  await store.write('result', result.publicationFingerprint, result);
  return result;
}
