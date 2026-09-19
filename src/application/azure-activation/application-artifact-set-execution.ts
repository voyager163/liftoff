import { isUtf8 } from 'node:buffer';
import { lstat, realpath } from 'node:fs/promises';
import { applicationImageDigest, applicationObject } from '../../adapters/azure/application-provisioning.js';
import { AzureArmError } from '../../adapters/azure/activation-rest.js';
import { sanitizeAzureOutput } from '../../adapters/azure/production-adapter.js';
import { GitHubActivationError, positiveId } from '../../adapters/github/activation-rest.js';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { readProjectFile } from '../../adapters/filesystem/project-files.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import {
  approvalRequestForSavedPlan, canonicalApprovalEnvelopeHash, evaluateApprovalForTransitionPlan
} from '../../domain/governance/activation/approvals.js';
import { evidenceBodyDigest, evidenceHeaderDigest, validateEvidenceFreshness } from '../../domain/governance/activation/evidence.js';
import { canonicalPhaseGraph, currentActivationIdentity } from '../../domain/governance/activation/graph.js';
import { assertPlanOperationsAllowed } from '../../domain/governance/activation/operations.js';
import { validateApprovalEnvelope, validateEvidenceHeader, validateLiveReadbackProof, validateSavedTransitionPlan } from '../../domain/governance/activation/validators.js';
import type {
  ExternalOperationState, LiveReadbackProof, PhaseEvidenceRecord, PhaseOutputBindings, SavedTransitionPlan, TransitionOperation
} from '../../domain/governance/activation/types.js';
import { assertGovernanceApprovalIssued } from '../../governance-activation/authority-records.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import { githubPorts } from '../../governance-activation/github-ports.js';
import { evidencePathParts, transitionPlanPathParts } from '../../governance-activation/transition-records.js';
import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { assertGitHubPhaseAuthority } from '../repository-governance/workflow-authority.js';
import { readWorkflowEffect, type WorkflowEffectCheckpoints } from '../repository-governance/workflow-checkpoints.js';
import { assertAzurePhaseAuthority, AzureActivationAdmissionError } from './authority.js';
import type { ApplicationArtifactRole } from './application-artifact-inputs.js';
import { validateRecordedApplicationBuild } from './application-build-report.js';
import {
  applicationArtifactSetConfiguration, applicationArtifactSetDigest, applicationArtifactSetInputs, applicationArtifactSetOperations,
  applicationArtifactSetOutputs, applicationArtifactSetProtocol, artifactSetAssert as must,
  assertApplicationArtifactSetOperations, type ApplicationArtifactRoleEvidence, type ApplicationArtifactRoleInputs,
  type ApplicationArtifactRoleReference, type ApplicationArtifactSetEvidence, type ApplicationArtifactSetInputs,
  type ApplicationArtifactSetReference
} from './application-artifact-set.js';
import {
  executeApplicationArtifactRole, readApplicationArtifactRoleObservation, type ApplicationArtifactRoleResult
} from './producer-artifact.js';

interface ArtifactSetRoot {
  schemaVersion: 1;
  kind: 'application-artifact-set-prepared.v1';
  projectRoot: string;
  projectIdentity: { device: string; inode: string; birthtime: string };
  activationIdentityDigest: string;
  setDigest: string;
  planDigest: string;
  savedPlanDigest: string;
  approvalEnvelopeHash: string;
  preparedAt: string;
}

interface RoleCustody {
  started: boolean;
  checkpoints: WorkflowEffectCheckpoints | null;
  receipt: ApplicationArtifactRoleEvidence | null;
}

const rootKey = (config: ApplicationArtifactSetInputs) => canonicalSha256({
  protocol: applicationArtifactSetProtocol, phaseId: 'application-artifact-ready', source: config.source
});
const stageKey = (config: ApplicationArtifactSetInputs, stage: string) => canonicalSha256({ root: rootKey(config), stage });
type ArtifactSetReadInput = PhasePlanningInput & { clock?: () => Date };

const storeFor = (input: ArtifactSetReadInput) =>
  createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', githubPorts(input).storage);

function hash(value: unknown): string {
  must(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'digest', 'Artifact custody requires exact lowercase SHA-256 metadata commitments.');
  return value;
}

function timestamp(value: unknown): string {
  must(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    'time', 'Artifact custody requires an exact recorded UTC timestamp.');
  return value;
}

async function projectIdentity(root: string) {
  const stat = await lstat(root);
  must(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(root) === root,
    'project', 'Artifact custody belongs to one exact canonical project directory.');
  return { device: String(stat.dev), inode: String(stat.ino), birthtime: String(stat.birthtimeMs) };
}

async function expectedRoot(
  input: ArtifactSetReadInput, config: ApplicationArtifactSetInputs, plan: SavedTransitionPlan, preparedAt: string
): Promise<ArtifactSetRoot> {
  must(Date.parse(preparedAt) >= Date.parse(plan.createdAt) && Date.parse(preparedAt) < Date.parse(plan.expiresAt),
    'root-time', 'The original set must start within its whole-phase approval interval.');
  return {
    schemaVersion: 1, kind: 'application-artifact-set-prepared.v1',
    projectRoot: input.inspection.projectRoot, projectIdentity: await projectIdentity(input.inspection.projectRoot),
    activationIdentityDigest: canonicalSha256(currentActivationIdentity), setDigest: applicationArtifactSetDigest(config),
    planDigest: plan.planDigest, savedPlanDigest: canonicalSha256(plan),
    approvalEnvelopeHash: hash(plan.approval.envelopeHash), preparedAt
  };
}

async function readRoot(
  input: ArtifactSetReadInput, config: ApplicationArtifactSetInputs, plan: SavedTransitionPlan
): Promise<ArtifactSetRoot | null> {
  const record = await storeFor(input).read(rootKey(config));
  if (!record) return null;
  must(isRecord(record.value), 'root', 'The original private set checkpoint is malformed.');
  const expected = await expectedRoot(input, config, plan, timestamp(record.value.preparedAt));
  must(record.projectRoot === expected.projectRoot && canonicalSha256(record.value) === canonicalSha256(expected),
    'original-plan', 'The retained set requires its original whole reviewed plan, source, components, project and private issuance; do not replace them with role plans.');
  return expected;
}

function selectedOperations(config: ApplicationArtifactSetInputs, role: ApplicationArtifactRole) {
  return applicationArtifactSetOperations(config).filter((entry) => isRecord(entry.inputs.artifactSet) && entry.inputs.artifactSet.role === role);
}

function startRecord(root: ArtifactSetRoot, selected: ApplicationArtifactRoleInputs) {
  return {
    schemaVersion: 1, kind: 'application-artifact-set-role-started.v1',
    rootDigest: canonicalSha256(root), role: selected.role, selectionDigest: canonicalSha256(selected)
  };
}

function roleEvidence(
  value: unknown, selected: ApplicationArtifactRoleInputs, config: ApplicationArtifactSetInputs,
  root: ArtifactSetRoot, checkpoints: WorkflowEffectCheckpoints | null
): ApplicationArtifactRoleEvidence {
  const record = applicationObject(value, 'Retained role evidence', [
    'role', 'componentId', 'componentDigest', 'recipeDigest', 'context', 'dockerfile', 'workflow',
    'source', 'provenance', 'artifact', 'dispatchCheckpointDigest', 'originalPlanDigest', 'originalApprovalEnvelopeHash'
  ]);
  const source = applicationObject(record.source, 'Observed common application source', ['repository', 'repositoryId', 'sourceSha', 'treeSha']);
  must(typeof source.treeSha === 'string' && /^[a-f0-9]{40}$/u.test(source.treeSha), 'source-tree',
    'A role must retain the actual tree of its common immutable source commit.');
  const provenance = validateRecordedApplicationBuild(record.provenance, selected.application, selected.build.registry.loginServer);
  const artifact = applicationObject(record.artifact, 'Retained role report artifact', ['id', 'name', 'digest']);
  const id = positiveId(artifact.id), digest = applicationImageDigest(artifact.digest);
  must(checkpoints?.observed && checkpoints.prepared.planDigest === root.planDigest &&
    checkpoints.prepared.approvalEnvelopeHash === root.approvalEnvelopeHash &&
    checkpoints.observed.providerId === String(provenance.runId) &&
    checkpoints.observed.resourceId === `/repos/${config.source.repository}/actions/runs/${provenance.runId}`,
  'role-custody', 'The role receipt requires its original source/run-bound private dispatch checkpoint; public success is not custody.');
  const expected: ApplicationArtifactRoleEvidence = {
    role: selected.role, componentId: selected.component.id, componentDigest: canonicalSha256(selected.component),
    recipeDigest: canonicalSha256(selected.build), context: selected.build.context, dockerfile: selected.build.dockerfile,
    workflow: selected.application.workflow, source: { ...config.source, treeSha: source.treeSha }, provenance,
    artifact: { id, name: selected.application.artifactName, digest },
    dispatchCheckpointDigest: canonicalSha256(checkpoints.prepared),
    originalPlanDigest: root.planDigest, originalApprovalEnvelopeHash: root.approvalEnvelopeHash
  };
  must(canonicalSha256(record) === canonicalSha256(expected), 'role-receipt',
    'The retained immutable role receipt differs from its exact source, recipe, component, provider run, report or registry binding.');
  return expected;
}

async function readRole(
  input: ArtifactSetReadInput, config: ApplicationArtifactSetInputs, selected: ApplicationArtifactRoleInputs,
  root: ArtifactSetRoot | null
): Promise<RoleCustody> {
  const store = storeFor(input);
  const [started, completed] = await Promise.all([
    store.read(stageKey(config, `${selected.role}:started`)), store.read(stageKey(config, `${selected.role}:completed`))
  ]);
  const app = selected.application;
  const checkpoints = await readWorkflowEffect(input, selectedOperations(config, selected.role)[0]!, {
    repositoryId: app.workflow.repositoryId, ref: `${app.workflow.ref}:${app.workflow.workflowId}`,
    purpose: 'workflow-dispatch', step: 'dispatch'
  }, { workflow: app.workflow, dispatchInputs: app.dispatchInputs });
  if (!started) {
    must(!completed && !checkpoints, 'missing-role-index', 'A dispatch or success without its original private role index cannot authorize another build.');
    return { started: false, checkpoints: null, receipt: null };
  }
  must(root && started.projectRoot === root.projectRoot &&
    canonicalSha256(started.value) === canonicalSha256(startRecord(root, selected)), 'role-index',
  'Every attempted role requires its original whole-set private checkpoint.');
  must(checkpoints && checkpoints.prepared.planDigest === root.planDigest &&
    checkpoints.prepared.approvalEnvelopeHash === root.approvalEnvelopeHash, 'missing-dispatch',
  'A previously started role has no matching original private dispatch checkpoint. Preserve it for review; no blind replacement dispatch is authorized.');
  if (!completed) return { started: true, checkpoints, receipt: null };
  const record = applicationObject(completed.value, 'Private completed application role', ['schemaVersion', 'kind', 'rootDigest', 'evidence']);
  const evidence = roleEvidence(record.evidence, selected, config, root, checkpoints);
  must(completed.projectRoot === root.projectRoot && canonicalSha256(record) === canonicalSha256({
    schemaVersion: 1, kind: 'application-artifact-set-role-completed.v1', rootDigest: canonicalSha256(root), evidence
  }), 'private-role', 'The private role completion does not belong to this original set.');
  return { started: true, checkpoints, receipt: evidence };
}

function aggregate(config: ApplicationArtifactSetInputs, artifacts: readonly ApplicationArtifactRoleEvidence[]): ApplicationArtifactSetEvidence {
  must(artifacts.length === config.artifacts.length && artifacts.every((entry, index) =>
    entry.role === config.artifacts[index]!.role && canonicalSha256(entry.source) === canonicalSha256(artifacts[0]!.source)),
  'incomplete', 'Every required role must independently prove the same immutable application commit and tree.');
  for (const select of [
    (entry: ApplicationArtifactRoleEvidence) => entry.provenance.digest,
    (entry: ApplicationArtifactRoleEvidence) => String(entry.provenance.runId),
    (entry: ApplicationArtifactRoleEvidence) => String(entry.artifact.id)
  ]) {
    must(new Set(artifacts.map(select)).size === artifacts.length, 'shared-artifact',
      'Backend and frontend require distinct actual image bytes, provider runs and immutable report artifacts; copying the backend image is not frontend proof.');
  }
  return {
    schemaVersion: 1, kind: 'application-artifact-ready.v1', mode: 'artifact-set', protocol: applicationArtifactSetProtocol,
    setDigest: applicationArtifactSetDigest(config), source: artifacts[0]!.source,
    requiredRoles: config.artifacts.map((entry) => entry.role), artifacts
  };
}

function completionRecord(root: ArtifactSetRoot, evidence: ApplicationArtifactSetEvidence) {
  return { schemaVersion: 1, kind: 'application-artifact-set-completed.v1', rootDigest: canonicalSha256(root), evidence };
}

async function assertCurrent(input: PhaseAdapterExecutionInput, config: ApplicationArtifactSetInputs, savedPlanDigest: string) {
  must(canonicalSha256(input.plan) === savedPlanDigest &&
    applicationArtifactSetDigest(applicationArtifactSetInputs(input)) === applicationArtifactSetDigest(config), 'changed',
  'The original whole-phase plan and complete role configuration must remain unchanged throughout execution.');
  for (const operation of assertApplicationArtifactSetOperations(input, config)) {
    if (operation.adapter === 'github') await assertGitHubPhaseAuthority(input, operation);
    else await assertAzurePhaseAuthority(input, operation);
  }
}

/** Direct concrete adapter execution only. Partial successes never become aggregate evidence or image outputs. */
export async function executeApplicationArtifactSetReady(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  const completed: TransitionOperation[] = [], warnings: string[] = [];
  const values: Record<string, string | number | boolean | null> = { 'application.artifactSet.status': 'incomplete' };
  const resources: PhaseOutputBindings['resources'][number][] = [];
  let operation: ExternalOperationState | undefined = input.inspection.state.phases['application-artifact-ready']?.operation;
  const progress = () => ({ values, resources });
  const retain = (entries: readonly TransitionOperation[]) => {
    for (const entry of entries) if (!completed.some((other) => canonicalSha256(entry) === canonicalSha256(other))) completed.push(entry);
  };
  try {
    const config = applicationArtifactSetInputs(input), savedPlanDigest = canonicalSha256(input.plan);
    await assertCurrent(input, config, savedPlanDigest);
    let root = await readRoot(input, config, input.plan);
    const custody = new Map<ApplicationArtifactRole, RoleCustody>();
    for (const selected of config.artifacts) {
      const current = await readRole(input, config, selected, root);
      custody.set(selected.role, current);
      if (current.checkpoints?.observed) retain([selectedOperations(config, selected.role)[0]!]);
      values[`application.artifactSet.roles.${selected.role}.status`] = current.receipt ? 'retained-awaiting-readback' : current.started ? 'recorded' : 'not-started';
    }
    if (!root) {
      const previous = input.inspection.state.phases['application-artifact-ready'];
      must(!input.recovery && !input.plan.recovery && !previous.operation && !previous.executionPlanDigest,
        'missing-root', 'A recorded or recovery execution requires the original private whole-set root, not a new dispatch.');
      root = await expectedRoot(input, config, input.plan, (input.clock?.() ?? input.now).toISOString());
      await assertCurrent(input, config, savedPlanDigest);
      await storeFor(input).write(rootKey(config), root);
    }
    if (operation) {
      must([...custody.values()].some(({ checkpoints }) => {
        const recorded = checkpoints?.observed ?? (checkpoints?.response?.status === 200 ? checkpoints.response : null);
        return recorded?.providerId === operation!.operationId && recorded.resourceId === operation!.resourceId &&
          checkpoints?.prepared.planDigest === operation!.planDigest;
      }), 'recorded-operation', 'The current phase operation must belong to one of the original set dispatches.');
    }
    values['application.artifactSet.digest'] = applicationArtifactSetDigest(config);
    values['application.artifactSet.requiredCount'] = config.artifacts.length;
    const verified = new Map<ApplicationArtifactRole, ApplicationArtifactRoleEvidence>();
    const liveReadback: LiveReadbackProof[] = [];
    // Revalidate retained successes before any not-yet-started role may incur new effects.
    const order = [...config.artifacts.filter((entry) => custody.get(entry.role)!.receipt),
      ...config.artifacts.filter((entry) => !custody.get(entry.role)!.receipt)];
    for (const selected of order) {
      const current = custody.get(selected.role)!;
      await assertCurrent(input, config, savedPlanDigest);
      if (!current.started) {
        await storeFor(input).write(stageKey(config, `${selected.role}:started`), startRecord(root, selected));
        await assertCurrent(input, config, savedPlanDigest);
      }
      const result: ApplicationArtifactRoleResult = await executeApplicationArtifactRole(input, selected.role);
      operation = result.operation ?? operation;
      retain(result.completedOperations);
      warnings.push(...(result.cleanupWarnings ?? []));
      if (result.operation) resources.push({ provider: 'github', resourceType: 'workflow-run', resourceId: result.operation.resourceId });
      const prefix = `application.artifactSet.roles.${selected.role}`;
      values[`${prefix}.status`] = result.status;
      values[`${prefix}.runId`] = result.operation?.operationId ?? null;
      values[`${prefix}.checkpointDigest`] = result.progress?.values['application.artifact.checkpointDigest'] ?? null;
      values[`${prefix}.responseRunId`] = result.progress?.values['application.artifact.responseRunId'] ?? null;
      values[`${prefix}.providerRequestId`] = result.progress?.values['application.artifact.providerRequestId'] ?? null;
      if (result.status !== 'completed') {
        return {
          status: result.status, blocker: `${selected.role}: ${result.blocker ?? 'The exact role is incomplete; no aggregate application artifact is available.'}`,
          completedOperations: completed, cleanupWarnings: warnings, outputs: progress(), ...(operation ? { operation } : {})
        };
      }
      const observation = readApplicationArtifactRoleObservation(result);
      if (current.receipt) must(canonicalSha256(observation) === canonicalSha256(current.receipt), 'continuation-drift',
        'An independently re-read role differs from its retained successful receipt. Preserve the original image and do not substitute another report or run.');
      await assertCurrent(input, config, savedPlanDigest);
      await storeFor(input).write(stageKey(config, `${selected.role}:completed`), {
        schemaVersion: 1, kind: 'application-artifact-set-role-completed.v1', rootDigest: canonicalSha256(root), evidence: observation
      });
      verified.set(selected.role, observation);
      liveReadback.push(...(result.readbacks ?? []));
    }
    const evidence = aggregate(config, config.artifacts.map((entry) => verified.get(entry.role)!));
    await assertCurrent(input, config, savedPlanDigest);
    await storeFor(input).write(stageKey(config, 'completed'), completionRecord(root, evidence));
    await assertCurrent(input, config, savedPlanDigest);
    return {
      status: 'completed', resultState: 'verified', evidencePayload: evidence,
      outputs: applicationArtifactSetOutputs(evidence), liveReadback, completedOperations: completed,
      ...(operation ? { operation } : {}), ...(warnings.length ? { cleanupWarnings: warnings } : {})
    };
  } catch (error) {
    const message = error instanceof AzureActivationAdmissionError || error instanceof AzureArmError || error instanceof GitHubActivationError
      ? sanitizeAzureOutput(error.message) : 'Artifact-set execution is incomplete; preserve all original private dispatch checkpoints and role receipts for reviewed recovery.';
    return { status: 'blocked', blocker: message, completedOperations: completed, cleanupWarnings: warnings,
      outputs: progress(), ...(operation ? { operation } : {}) };
  }
}

export function validateApplicationArtifactSetReference(value: unknown): ApplicationArtifactSetReference {
  const ref = applicationObject(value, 'Application artifact-set reference', [
    'evidenceId', 'headerDigest', 'bodyDigest', 'planPathParts', 'savedPlanDigest', 'setDigest'
  ]);
  must(typeof ref.evidenceId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u.test(ref.evidenceId) &&
    Array.isArray(ref.planPathParts) && ref.planPathParts.length === 3 &&
    ref.planPathParts[0] === 'governance' && ref.planPathParts[1] === 'plans' &&
    typeof ref.planPathParts[2] === 'string' && /^application-artifact-ready-[A-Za-z0-9-]+\.json$/u.test(ref.planPathParts[2]),
  'reference', 'Role readers require an explicit registered evidence identity and its exact original saved phase plan.');
  return {
    evidenceId: ref.evidenceId, headerDigest: hash(ref.headerDigest), bodyDigest: hash(ref.bodyDigest),
    planPathParts: [...ref.planPathParts], savedPlanDigest: hash(ref.savedPlanDigest), setDigest: hash(ref.setDigest)
  };
}

async function jsonFile(root: string, pathParts: readonly string[]) {
  const bytes = await readProjectFile(root, [...pathParts]);
  must(bytes && bytes.length <= 256 * 1024 && isUtf8(bytes), 'stored-reference', 'The original bounded application evidence or saved plan is missing.');
  try { return JSON.parse(bytes.toString('utf8')) as unknown; }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new AzureActivationAdmissionError('application-artifact-set-stored-reference', 'Original application evidence or plan is malformed JSON.');
  } finally { bytes.fill(0); }
}

export interface RecordedApplicationArtifactSet {
  reference: ApplicationArtifactSetReference;
  evidence: ApplicationArtifactSetEvidence;
  originalPlanDigest: string;
  originalApprovalEnvelopeHash: string;
}

/**
 * Stored producer reference, not fresh cloud/deployment authority. Requires ALL role receipts,
 * whole-plan issuance, original checkpoints and current body-bound evidence; never a latest image.
 */
export async function readApplicationArtifactSetReference(
  input: ArtifactSetReadInput, value: ApplicationArtifactSetReference
): Promise<RecordedApplicationArtifactSet> {
  const reference = validateApplicationArtifactSetReference(value);
  const raw = applicationObject(await jsonFile(input.inspection.projectRoot, evidencePathParts(reference.evidenceId)),
    'Registered artifact-set evidence', ['evidenceId', 'header', 'payload', 'liveReadback']);
  must(raw.evidenceId === reference.evidenceId && Array.isArray(raw.liveReadback), 'registered-evidence',
    'An artifact-set reference must name actual registered producer evidence, not a supplied success result.');
  const record: PhaseEvidenceRecord = {
    evidenceId: reference.evidenceId, header: validateEvidenceHeader(raw.header), payload: raw.payload,
    liveReadback: raw.liveReadback.map(validateLiveReadbackProof)
  };
  const plan = validateSavedTransitionPlan(await jsonFile(input.inspection.projectRoot, reference.planPathParts));
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'application-artifact-ready')!;
  assertPlanOperationsAllowed(plan, phase);
  const config = applicationArtifactSetConfiguration(input.inspection, plan.configuration);
  assertApplicationArtifactSetOperations({ plan }, config);
  const active = input.inspection.state.phases[phase.id];
  const known = input.inspection.evidence.filter((entry) => entry.evidenceId === reference.evidenceId);
  must(known.length === 1 && canonicalSha256(known[0]) === canonicalSha256(record) &&
    record.header.phaseId === phase.id && record.header.scope === 'activation' && record.header.result === 'verified' &&
    record.header.producer === 'liftoff-governance-transition-engine' && active.state === 'verified' &&
    evidenceHeaderDigest(record.header) === reference.headerDigest && record.header.bodyDigest === reference.bodyDigest &&
    evidenceBodyDigest(record.payload, record.liveReadback) === reference.bodyDigest &&
    canonicalSha256(plan) === reference.savedPlanDigest &&
    canonicalSha256(transitionPlanPathParts(plan)) === canonicalSha256(reference.planPathParts) &&
    applicationArtifactSetDigest(config) === reference.setDigest,
  'registered-evidence', 'Artifact-set references require exact current stored evidence, source configuration and the original reviewed whole-phase plan.');
  const freshness = validateEvidenceFreshness(record, {
    ...input.inspection.contexts[phase.id], evidenceReferences: active.evidence, reviewedPlans: [plan], now: input.clock?.() ?? input.now
  });
  must(freshness.valid, 'freshness', 'The original artifact-set evidence no longer matches the registered project, inputs, graph or reviewed plan.');
  const issued = await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-approval', githubPorts(input).storage)
    .read(hash(plan.approval.envelopeHash));
  must(issued && isRecord(issued.value) && issued.value.kind === 'liftoff-governance-approval',
    'original-approval', 'The original privately issued whole-set approval must remain available.');
  const envelope = validateApprovalEnvelope(issued.value.envelope);
  const envelopes = input.inspection.approvals.filter((entry) => entry.id === plan.approval.envelopeId);
  must(envelope.id === plan.approval.envelopeId && canonicalApprovalEnvelopeHash(envelope) === plan.approval.envelopeHash &&
    envelopes.every((entry) => canonicalApprovalEnvelopeHash(entry) === plan.approval.envelopeHash),
    'original-approval', 'The original whole-set approval envelope differs from its private issuance or public reference.');
  for (const storage of [githubPorts(input).storage, azurePorts(input).storage]) {
    await assertGovernanceApprovalIssued(input.inspection.projectRoot, envelope, storage);
  }
  const approval = evaluateApprovalForTransitionPlan(approvalRequestForSavedPlan(plan, phase, input.inspection.state), [envelope], {
    now: new Date(record.header.producedAt)
  });
  must(!approval.approvalRequired && approval.envelopeHash === plan.approval.envelopeHash, 'original-approval',
    'The original set must have completed under its own exact privately issued whole-phase approval.');
  const root = await readRoot(input, config, plan);
  must(root, 'private-root', 'The original private artifact-set root is required.');
  const roles: ApplicationArtifactRoleEvidence[] = [];
  for (const selected of config.artifacts) {
    const custody = await readRole(input, config, selected, root);
    must(custody.receipt, 'incomplete', 'No role reference can be consumed while any required role lacks its original successful private receipt.');
    roles.push(custody.receipt);
  }
  const evidence = aggregate(config, roles);
  const completion = await storeFor(input).read(stageKey(config, 'completed'));
  must(completion?.projectRoot === root.projectRoot && canonicalSha256(completion.value) === canonicalSha256(completionRecord(root, evidence)),
    'private-completion', 'An application artifact set requires the actual private aggregate completion, not assembled public role claims.');
  const outputs = applicationArtifactSetOutputs(evidence);
  must(canonicalSha256(record.payload) === canonicalSha256({
    ...evidence, planDigest: plan.planDigest, savedPlanDigest: canonicalSha256(plan), outputBindings: outputs
  }) && canonicalSha256(input.inspection.state.phaseOutputs?.[phase.id] ?? null) === canonicalSha256(outputs) &&
    outputs.resources.every((resource) => record.liveReadback?.some((proof) => proof.provider === resource.provider &&
      proof.resourceType === resource.resourceType && proof.resourceId === resource.resourceId && proof.matches)),
  'outputs', 'Every required image output must remain bound to the registered complete set and actual original provider readbacks.');
  return { reference, evidence, originalPlanDigest: root.planDigest, originalApprovalEnvelopeHash: root.approvalEnvelopeHash };
}

export interface RecordedApplicationArtifactRole {
  reference: ApplicationArtifactRoleReference;
  artifact: ApplicationArtifactRoleEvidence;
}

export async function readApplicationArtifactRoleReference(
  input: ArtifactSetReadInput, value: ApplicationArtifactRoleReference
): Promise<RecordedApplicationArtifactRole> {
  const ref = applicationObject(value, 'Explicit application artifact role reference', ['set', 'role']);
  must(ref.role === 'backend' || ref.role === 'frontend', 'reference-role', 'An application consumer must explicitly select backend or frontend.');
  const set = await readApplicationArtifactSetReference(input, validateApplicationArtifactSetReference(ref.set));
  const selected = set.evidence.artifacts.filter((entry) => entry.role === ref.role);
  must(selected.length === 1, 'reference-role', 'The requested role is not in this complete application artifact set; no backend fallback is permitted.');
  return { reference: { set: set.reference, role: ref.role }, artifact: selected[0]! };
}
