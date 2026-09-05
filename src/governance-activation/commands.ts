import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { readBooleanFlag, readStringFlag } from '../args.js';
import {
  findProjectRoot,
  loadManifest,
  readProjectFile,
  resolveProjectPath,
  validateArtifactPathParts
} from '../file-system.js';
import {
  governanceArtifactPaths,
  validateGovernancePolicy
} from '../repository-governance.js';
import type { PresentationSession } from '../terminal.js';
import type { LiftoffManifest, ParsedArgs } from '../types.js';
import type { CommandRunner } from '../process-runner.js';
import {
  activationStateFilePathParts,
  loadActivationState,
  type LoadedActivationState
} from './activation-state.js';
import { canonicalSha256 } from './canonical-json.js';
import {
  canonicalApprovalEnvelopeHash,
  evaluateApprovalForTransitionPlan,
  transitionPlanForPhase
} from './approvals.js';
import {
  buildPatEnrollmentGuidance,
  canonicalCredentialRepository,
  credentialPolicyPathParts,
  detectCredentialLeaks,
  runnerPreflightPermissions,
  validateCredentialPolicyUsage,
  type PatEnrollmentGuidance
} from './credentials.js';
import {
  evidenceContextForPhase,
  requiredLiveReadbackProviders,
  selectLatestPhaseEvidence,
  type EvidenceFreshnessContext,
  type EvidenceSelectionResult
} from './evidence.js';
import {
  canonicalPhaseGraph,
  canonicalPhaseGraphHash,
  currentActivationIdentity,
  phaseContractDigests
} from './graph.js';
import { governanceActivationPolicyVersion } from './identity.js';
import { calculatePhaseReadiness, type ReadinessResult } from './readiness.js';
import {
  projectOpenSpecTaskCheckboxes,
  type PhaseTaskMapping
} from './task-projection.js';
import {
  inspectGovernanceSourceOfTruth,
  type GovernanceSourceOfTruthInspection
} from './source-of-truth.js';
import {
  inspectArchivedSeedIntegrity,
  type ArchivedSeedIntegrity
} from './seed-lifecycle.js';
import {
  executeApplyNext,
  previewApplyNext,
  type ApplyNextExecutionResult,
  type ApplyNextPreview,
  type GovernanceTransitionInspection
} from './transitions.js';
import type {
  ApprovalEnvelope,
  ApprovalEvaluation,
  EvidenceHeader,
  LiveReadbackProof,
  ManagedPhaseGraph,
  PhaseEvidenceRecord,
  PhaseGraphNode,
  PhaseId,
  PhaseState,
  CredentialPolicy,
  UserActivationState
} from './types.js';
import { phaseIds } from './types.js';
import {
  validateApprovalEnvelope,
  validateEvidenceHeader,
  validateLiveReadbackProof,
  validateManagedPhaseGraph,
  validateCredentialPolicy
} from './validators.js';

interface GovernanceCommandContext {
  cwd: string;
  presentation: PresentationSession;
  runner?: CommandRunner;
}

type GovernanceSubcommand = 'status' | 'plan' | 'apply-next' | 'resume' | 'verify';
type GraphSource = 'packaged' | 'managed';
type CheckStatus = 'passed' | 'failed' | 'skipped';

interface LoadedGovernanceGraph {
  source: GraphSource;
  graph: ManagedPhaseGraph;
  hash: string;
}

interface EvidenceFreshnessEntry {
  phaseId: PhaseId;
  status: 'fresh' | 'missing' | 'stale';
  selectedEvidenceId: string | null;
  selectedResult: EvidenceHeader['result'] | null;
  requiresLiveReadback: boolean;
  liveReadbackProviders: readonly string[];
  issues: readonly string[];
}

interface GovernanceInspection {
  projectRoot: string;
  manifest: LiftoffManifest;
  graph: LoadedGovernanceGraph;
  loadedState?: LoadedActivationState;
  state: UserActivationState;
  stateSource: 'user' | 'not-started';
  approvals: readonly ApprovalEnvelope[];
  evidence: readonly PhaseEvidenceRecord[];
  contexts: Record<PhaseId, EvidenceFreshnessContext>;
  evidenceFreshness: Record<PhaseId, EvidenceFreshnessEntry>;
  readiness: ReadinessResult;
  sourceOfTruth: GovernanceSourceOfTruthInspection;
  credential: CredentialInspection;
  archivedSeedIntegrity: ArchivedSeedIntegrity;
}

interface CredentialInspection {
  applicable: boolean;
  readOnly: true;
  path: string;
  status: 'not-applicable' | 'missing' | 'valid' | 'invalid' | 'compromised' | 'not-ready';
  ready: boolean;
  guidance: PatEnrollmentGuidance | null;
  policy: CredentialPolicy | null;
  issues: readonly string[];
}

interface VerificationCheck {
  id: string;
  status: CheckStatus;
  issues: readonly string[];
}

type SetupCompletionStatus = 'not-started' | 'in-progress' | 'complete';

interface GovernanceVerificationResult {
  schemaVersion: 1;
  command: 'governance verify';
  projectRoot: string;
  readOnly: true;
  ok: boolean;
  consistent: boolean;
  verificationStatus: 'consistent' | 'inconsistent';
  complete: boolean;
  setupStatus: SetupCompletionStatus;
  stateSource: GovernanceInspection['stateSource'];
  summary: string;
  activationIdentity: UserActivationState['identity'];
  graphHash: string;
  activeChange: UserActivationState['activeChange'];
  activeSourceOfTruth: GovernanceSourceOfTruthInspection;
  nextReadyPhase: PhaseId | null;
  checks: readonly VerificationCheck[];
}

const governanceSubcommands = new Set<GovernanceSubcommand>([
  'status',
  'plan',
  'apply-next',
  'resume',
  'verify'
]);
const managedPhaseGraphPathParts = ['.liftoff', 'governance', 'phase-graph.json'] as const;
const approvalDirectoryPathParts = ['governance', 'approvals'] as const;
const evidenceDirectoryPathParts = ['governance', 'evidence'] as const;
const terminalEvidenceStates = new Set<PhaseState>([
  'verified',
  'failed',
  'inapplicable',
  'retained',
  'disposed'
]);
const successfulSetupStates = new Set<PhaseState>([
  'approved',
  'verified',
  'inapplicable',
  'retained',
  'disposed'
]);
const terminalPhaseStates = new Set<PhaseState>([
  ...successfulSetupStates,
  'failed'
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function json(presentation: PresentationSession, value: unknown): void {
  presentation.rawStdout(`${JSON.stringify(value, null, 2)}\n`);
}

function parseGovernanceSubcommand(parsed: ParsedArgs): GovernanceSubcommand | undefined {
  if (!parsed.subcommand || !governanceSubcommands.has(parsed.subcommand as GovernanceSubcommand)) {
    return undefined;
  }
  return parsed.subcommand as GovernanceSubcommand;
}

async function resolveGovernanceProjectRoot(
  parsed: ParsedArgs,
  context: GovernanceCommandContext
): Promise<string | undefined> {
  const positionalProject = parsed.positional[0];
  const flagProject = readStringFlag(parsed.flags, 'project');
  if (positionalProject && flagProject) {
    throw new Error('Provide a project path either positionally or with --project, not both.');
  }
  const explicit = positionalProject ?? flagProject;
  const start = explicit ? path.resolve(context.cwd, explicit) : context.cwd;
  return await findProjectRoot(start);
}

function projectRootError(start: string): { message: string; remedy: string } {
  return {
    message: `No liftoff.manifest.json found in ${start} or any parent directory.`,
    remedy: 'Run this command inside a Liftoff project or provide its path explicitly.'
  };
}

function emptyPhaseState(now: string): UserActivationState['phases'] {
  const phases = {} as UserActivationState['phases'];
  for (const phaseId of phaseIds) {
    phases[phaseId] = {
      state: 'pending',
      updatedAt: now,
      evidence: [],
      approvals: [],
      blockers: []
    };
  }
  return phases;
}

function notStartedState(manifest: LiftoffManifest): UserActivationState {
  const now = '1970-01-01T00:00:00.000Z';
  return {
    schemaVersion: currentActivationIdentity.activationStateSchemaVersion,
    identity: currentActivationIdentity,
    repository: {
      id: `local:${manifest.project.name}`,
      name: manifest.project.name,
      defaultBranch: 'develop'
    },
    activeChange: null,
    applicability: {
      statePath: 'none',
      privateStagingDast: false,
      credentialRequired: false
    },
    phases: emptyPhaseState(now),
    createdAt: now,
    updatedAt: now
  };
}

async function loadGovernanceGraph(projectRoot: string): Promise<LoadedGovernanceGraph> {
  const managed = await readProjectFile(projectRoot, [...managedPhaseGraphPathParts]);
  if (managed === undefined) {
    const graph = validateManagedPhaseGraph(canonicalPhaseGraph);
    return { source: 'packaged', graph, hash: canonicalPhaseGraphHash };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(managed.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse ${managedPhaseGraphPathParts.join('/')}: ${errorMessage(error)}`);
  }
  const graph = validateManagedPhaseGraph(parsed);
  const hash = canonicalSha256(graph);
  if (hash !== canonicalPhaseGraphHash || hash !== currentActivationIdentity.phaseGraphHash) {
    throw new Error(
      `${managedPhaseGraphPathParts.join('/')} identity drift: expected graph hash ${canonicalPhaseGraphHash}, found ${hash}.`
    );
  }
  return { source: 'managed', graph, hash };
}

async function readJsonFiles(projectRoot: string, directoryPathParts: readonly string[], label: string): Promise<Array<{
  name: string;
  value: unknown;
}>> {
  const directory = await resolveProjectPath(
    projectRoot,
    validateArtifactPathParts([...directoryPathParts], `${label} directory path`)
  );
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return [];
    }
    throw new Error(`Unable to read ${directoryPathParts.join('/')}: ${errorMessage(error)}`);
  }

  const values: Array<{ name: string; value: unknown }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    if (!entry.name.endsWith('.json')) {
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`${directoryPathParts.join('/')}/${entry.name} must be a regular JSON file.`);
    }
    const pathParts = validateArtifactPathParts([...directoryPathParts, entry.name], `${label} file path`);
    const bytes = await readProjectFile(projectRoot, pathParts);
    if (bytes === undefined) {
      throw new Error(`${pathParts.join('/')} disappeared during governance inspection.`);
    }
    try {
      values.push({ name: entry.name, value: JSON.parse(bytes.toString('utf8')) as unknown });
    } catch (error) {
      throw new Error(`Unable to parse ${pathParts.join('/')}: ${errorMessage(error)}`);
    }
  }
  return values;
}

async function loadApprovals(projectRoot: string, identity: UserActivationState['identity']): Promise<ApprovalEnvelope[]> {
  const entries = await readJsonFiles(projectRoot, approvalDirectoryPathParts, 'Approval');
  return entries.map((entry) => {
    try {
      return validateApprovalEnvelope(entry.value, { expectedIdentity: identity });
    } catch (error) {
      throw new Error(`Invalid ${approvalDirectoryPathParts.join('/')}/${entry.name}: ${errorMessage(error)}`);
    }
  });
}

function asRecord(value: unknown, pathLabel: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${pathLabel} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function validateEvidenceRecord(value: unknown, evidenceId: string, pathLabel: string): PhaseEvidenceRecord {
  const record = asRecord(value, pathLabel);
  if (Object.hasOwn(record, 'header')) {
    const allowed = new Set(['evidenceId', 'header', 'liveReadback', 'payload']);
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) {
        throw new Error(`${pathLabel}.${key} is not allowed.`);
      }
    }
    if (typeof record.evidenceId !== 'string' || record.evidenceId.length === 0) {
      throw new Error(`${pathLabel}.evidenceId must be a non-empty string.`);
    }
    const liveReadback = record.liveReadback === undefined
      ? undefined
      : validateLiveReadbackArray(record.liveReadback, `${pathLabel}.liveReadback`);
    return {
      evidenceId: record.evidenceId,
      header: validateEvidenceHeader(record.header),
      ...(liveReadback ? { liveReadback } : {}),
      ...(Object.hasOwn(record, 'payload') ? { payload: record.payload } : {})
    };
  }
  return {
    evidenceId,
    header: validateEvidenceHeader(value)
  };
}

function validateLiveReadbackArray(value: unknown, pathLabel: string): LiveReadbackProof[] {
  if (!Array.isArray(value)) {
    throw new Error(`${pathLabel} must be an array.`);
  }
  return value.map((entry, index) => {
    try {
      return validateLiveReadbackProof(entry);
    } catch (error) {
      throw new Error(`${pathLabel}[${index}]: ${errorMessage(error)}`);
    }
  });
}

async function loadEvidence(projectRoot: string): Promise<PhaseEvidenceRecord[]> {
  const entries = await readJsonFiles(projectRoot, evidenceDirectoryPathParts, 'Evidence');
  return entries.map((entry) => {
    try {
      const evidenceId = entry.name.replace(/\.json$/u, '');
      return validateEvidenceRecord(entry.value, evidenceId, `${evidenceDirectoryPathParts.join('/')}/${entry.name}`);
    } catch (error) {
      throw new Error(`Invalid ${evidenceDirectoryPathParts.join('/')}/${entry.name}: ${errorMessage(error)}`);
    }
  });
}

function repositoryFromState(state: UserActivationState): ReturnType<typeof canonicalCredentialRepository> {
  const repositoryName = state.repository.name.includes('/')
    ? state.repository.name.split('/').at(-1)!
    : state.repository.name;
  const owner = state.repository.name.includes('/')
    ? state.repository.name.split('/')[0]!
    : 'local';
  return canonicalCredentialRepository({
    id: state.repository.id,
    owner,
    name: repositoryName
  });
}

async function inspectCredentialPolicy(projectRoot: string, state: UserActivationState): Promise<CredentialInspection> {
  const pathLabel = credentialPolicyPathParts.join('/');
  if (!state.applicability.credentialRequired) {
    return {
      applicable: false,
      readOnly: true,
      path: pathLabel,
      status: 'not-applicable',
      ready: false,
      guidance: null,
      policy: null,
      issues: []
    };
  }
  const repository = repositoryFromState(state);
  const guidance = buildPatEnrollmentGuidance({ repository });
  const bytes = await readProjectFile(projectRoot, [...credentialPolicyPathParts]);
  if (bytes === undefined) {
    return {
      applicable: true,
      readOnly: true,
      path: pathLabel,
      status: 'missing',
      ready: false,
      guidance,
      policy: null,
      issues: [`${pathLabel} is missing; deterministic PAT enrollment is required if no selected-repository App is available.`]
    };
  }
  const text = bytes.toString('utf8');
  const leaks = detectCredentialLeaks([{ source: 'imported-evidence', label: pathLabel, text }]);
  if (leaks.status === 'compromised') {
    return {
      applicable: true,
      readOnly: true,
      path: pathLabel,
      status: 'compromised',
      ready: false,
      guidance,
      policy: null,
      issues: leaks.guidance
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      applicable: true,
      readOnly: true,
      path: pathLabel,
      status: 'invalid',
      ready: false,
      guidance,
      policy: null,
      issues: [`Unable to parse ${pathLabel}: ${errorMessage(error)}`]
    };
  }
  try {
    const policy = validateCredentialPolicy(parsed);
    const usage = validateCredentialPolicyUsage(policy, {
      repository: policy.repository,
      permissions: runnerPreflightPermissions(),
      references: policy.allowedWorkflows.flatMap((entry) =>
        entry.jobs.map((job) => ({ workflowPath: entry.path, job }))
      ),
      forwardsCredential: false,
      verifiedReadbackDigest: policy.proof.readbackDigest
    });
    return {
      applicable: true,
      readOnly: true,
      path: pathLabel,
      status: usage.ready ? 'valid' : 'not-ready',
      ready: usage.ready,
      guidance: usage.ready ? null : guidance,
      policy,
      issues: usage.issues
    };
  } catch (error) {
    return {
      applicable: true,
      readOnly: true,
      path: pathLabel,
      status: 'invalid',
      ready: false,
      guidance,
      policy: null,
      issues: [errorMessage(error)]
    };
  }
}

function phaseMap(graph: ManagedPhaseGraph): Record<PhaseId, PhaseGraphNode> {
  return Object.fromEntries(graph.phases.map((phase) => [phase.id, phase])) as Record<PhaseId, PhaseGraphNode>;
}

function buildEvidenceContexts(
  graph: ManagedPhaseGraph,
  state: UserActivationState,
  now: Date
): Record<PhaseId, EvidenceFreshnessContext> {
  const digests = phaseContractDigests(graph);
  return Object.fromEntries(graph.phases.map((phase) => {
    const context = evidenceContextForPhase(phase.id, {
      repositoryId: state.repository.id,
      identity: state.identity,
      phaseGraphHash: state.identity.phaseGraphHash,
      now,
      liveReadbackProviders: requiredLiveReadbackProviders(phase)
    });
    return [phase.id, {
      ...context,
      phaseContractDigest: digests[phase.id]
    }];
  })) as Record<PhaseId, EvidenceFreshnessContext>;
}

function freshnessEntry(
  phase: PhaseGraphNode,
  selection: EvidenceSelectionResult
): EvidenceFreshnessEntry {
  return {
    phaseId: phase.id,
    status: selection.selected ? 'fresh' : selection.issues.length > 0 ? 'stale' : 'missing',
    selectedEvidenceId: selection.selected?.evidenceId ?? null,
    selectedResult: selection.selected?.header.result ?? null,
    requiresLiveReadback: phase.evidence.liveReadbackProviders.length > 0,
    liveReadbackProviders: phase.evidence.liveReadbackProviders,
    issues: selection.issues.map((issue) =>
      `${issue.evidenceId ? `${issue.evidenceId}: ` : ''}${issue.message}`
    )
  };
}

function buildEvidenceFreshness(
  graph: ManagedPhaseGraph,
  evidence: readonly PhaseEvidenceRecord[],
  contexts: Record<PhaseId, EvidenceFreshnessContext>
): Record<PhaseId, EvidenceFreshnessEntry> {
  return Object.fromEntries(graph.phases.map((phase) => {
    const records = evidence.filter((record) => record.header.phaseId === phase.id);
    const selection = selectLatestPhaseEvidence(records, contexts[phase.id]);
    return [phase.id, freshnessEntry(phase, selection)];
  })) as Record<PhaseId, EvidenceFreshnessEntry>;
}

async function inspectGovernance(projectRoot: string): Promise<GovernanceInspection> {
  const manifest = await loadManifest(projectRoot);
  const graph = await loadGovernanceGraph(projectRoot);
  await assertPolicyIdentity(projectRoot, manifest);
  const loadedState = await loadActivationState(projectRoot);
  const state = loadedState?.state ?? notStartedState(manifest);
  if (state.identity.phaseGraphHash !== graph.hash) {
    throw new Error(
      `Activation state graph hash ${state.identity.phaseGraphHash} does not match loaded graph hash ${graph.hash}.`
    );
  }
  if (state.identity.policyVersion !== governanceActivationPolicyVersion) {
    throw new Error(
      `Activation state policy version ${state.identity.policyVersion} does not match supported policy ${governanceActivationPolicyVersion}.`
    );
  }
  const approvals = await loadApprovals(projectRoot, state.identity);
  const evidence = await loadEvidence(projectRoot);
  const sourceOfTruth = await inspectGovernanceSourceOfTruth({
    projectRoot,
    manifest,
    state,
    evidence
  });
  const archivedSeedIntegrity = await inspectArchivedSeedIntegrity(projectRoot, manifest);
  const now = new Date();
  const credential = await inspectCredentialPolicy(projectRoot, state);
  const contexts = buildEvidenceContexts(graph.graph, state, now);
  const evidenceFreshness = buildEvidenceFreshness(graph.graph, evidence, contexts);
  const readiness = calculatePhaseReadiness({
    graph: graph.graph,
    state,
    approvals,
    evidence,
    transitionContexts: contexts,
    phaseBlockers: archivedSeedIntegrity.status === 'invalid'
      ? { 'seed-archived': archivedSeedIntegrity.issues }
      : undefined,
    now
  });
  return {
    projectRoot,
    manifest,
    graph,
    loadedState,
    state,
    stateSource: loadedState ? 'user' : 'not-started',
    approvals,
    evidence,
    contexts,
    evidenceFreshness,
    readiness,
    sourceOfTruth,
    credential,
    archivedSeedIntegrity
  };
}

async function assertPolicyIdentity(projectRoot: string, manifest: LiftoffManifest): Promise<void> {
  if (manifest.governance.profile === 'none' || manifest.governance.profile === 'unspecified') {
    return;
  }
  if (manifest.governance.policyVersion !== governanceActivationPolicyVersion) {
    throw new Error(
      `Manifest governance policyVersion ${manifest.governance.policyVersion ?? 'missing'} does not match ${governanceActivationPolicyVersion}.`
    );
  }
  const bytes = await readProjectFile(projectRoot, [...governanceArtifactPaths.policy]);
  if (bytes === undefined) {
    throw new Error(`${governanceArtifactPaths.policy.join('/')} is missing.`);
  }
  validateGovernancePolicy(bytes.toString('utf8'));
}

function approvalStatus(approval: ApprovalEnvelope, now = new Date()): 'valid' | 'expired' {
  return Date.parse(approval.expiresAt) > now.getTime() ? 'valid' : 'expired';
}

function approvalEvaluationForPhase(
  phase: PhaseGraphNode,
  inspection: GovernanceInspection
): ApprovalEvaluation {
  const plan = transitionPlanForPhase(
    phase,
    inspection.state,
    inspection.contexts[phase.id].transition,
    inspection.projectRoot
  );
  return evaluateApprovalForTransitionPlan(plan, inspection.approvals);
}

function approvalEvaluationJson(evaluation: ApprovalEvaluation): Record<string, unknown> {
  return {
    questionKind: evaluation.questionKind,
    approvalRequired: evaluation.approvalRequired,
    status: evaluation.status,
    envelopeId: evaluation.envelopeId,
    envelopeHash: evaluation.envelopeHash,
    reasons: evaluation.reasons,
    expansionReasons: evaluation.expansionReasons
  };
}

function statusJson(inspection: GovernanceInspection, command: GovernanceSubcommand): Record<string, unknown> {
  const blockers = phaseIds.flatMap((phaseId) =>
    inspection.readiness.phases[phaseId].blockers.map((message) => ({ phaseId, message }))
  );
  return {
    schemaVersion: 1,
    command: `governance ${command}`,
    projectRoot: inspection.projectRoot,
    readOnly: command !== 'apply-next',
    stateSource: inspection.stateSource,
    activationIdentity: inspection.state.identity,
    graphHash: inspection.graph.hash,
    graph: {
      source: inspection.graph.source,
      hash: inspection.graph.hash,
      schemaVersion: inspection.graph.graph.schemaVersion
    },
    activeChange: inspection.state.activeChange,
    activeSourceOfTruth: inspection.sourceOfTruth,
    credential: inspection.credential,
    phases: inspection.graph.graph.phases.map((phase) => ({
      id: phase.id,
      label: phase.label,
      state: inspection.readiness.phases[phase.id].state,
      storedState: inspection.state.phases[phase.id].state,
      blockers: inspection.readiness.phases[phase.id].blockers,
      evidence: {
        schema: phase.evidence.schema,
        required: phase.evidence.required,
        freshness: inspection.evidenceFreshness[phase.id]
      },
      approvalGate: phase.approvalGate,
      approval: approvalEvaluationJson(approvalEvaluationForPhase(phase, inspection)),
      allowedMutations: phase.allowedMutations
    })),
    nextReadyPhase: inspection.readiness.nextReadyPhase,
    blockers,
    approvals: inspection.approvals.map((approval) => ({
      id: approval.id,
      phaseId: approval.phaseId,
      gateKind: approval.gateKind,
      status: approvalStatus(approval),
      envelopeHash: canonicalApprovalEnvelopeHash(approval),
      expiresAt: approval.expiresAt
    })),
    evidenceFreshness: phaseIds.map((phaseId) => inspection.evidenceFreshness[phaseId])
  };
}

function renderStatusHuman(inspection: GovernanceInspection, command: GovernanceSubcommand): void {
  const presentation = inspectionPresentation(inspection);
  presentation.commandIdentity(`governance ${command}`, 'Deterministic activation status');
  presentation.definitions('Activation identity', [
    { label: 'Project', value: inspection.projectRoot },
    { label: 'State', value: inspection.stateSource },
    { label: 'Policy', value: inspection.state.identity.policyVersion },
    { label: 'Contract', value: String(inspection.state.identity.activationContractVersion) },
    { label: 'Graph hash', value: inspection.graph.hash },
    { label: 'Active change', value: inspection.state.activeChange?.id ?? 'none' },
    {
      label: 'Active source',
      value: inspection.sourceOfTruth.status === 'selected'
        ? inspection.sourceOfTruth.selected.changeId
        : inspection.sourceOfTruth.status
    }
  ]);
  if (inspection.sourceOfTruth.status === 'seed-blocked') {
    presentation.status('error', 'Seed blocker', inspection.sourceOfTruth.blockers.join('; '));
  } else if (inspection.sourceOfTruth.status === 'ambiguous' || inspection.sourceOfTruth.status === 'incompatible') {
    presentation.status('error', 'Active source blocked', inspection.sourceOfTruth.blockers.join('; '));
  } else if (inspection.sourceOfTruth.status === 'selected') {
    presentation.status(
      inspection.sourceOfTruth.reconciliation.status === 'not-required' ? 'success' : 'pending',
      'Source acknowledgment',
      inspection.sourceOfTruth.reconciliation.status
    );
  } else {
    presentation.status('pending', 'Governance change plan', inspection.sourceOfTruth.createPlan.reason);
  }
  if (inspection.credential.applicable) {
    presentation.status(
    inspection.credential.ready ? 'success' : inspection.credential.status === 'compromised' ? 'error' : 'pending',
    'Credential policy',
    inspection.credential.ready
      ? 'credential-ready metadata has verified payload-free readback'
      : inspection.credential.issues[0] ?? 'deterministic credential enrollment required'
    );
  }
  const next = inspection.readiness.nextReadyPhase ?? 'none';
  presentation.status(next === 'none' ? 'info' : 'pending', 'Next ready phase', next);
  if (inspection.readiness.nextReadyPhase) {
    const phase = phaseMap(inspection.graph.graph)[inspection.readiness.nextReadyPhase];
    const approval = approvalEvaluationForPhase(phase, inspection);
    presentation.status(
      approval.approvalRequired ? 'pending' : 'success',
      'Approval',
      `${approval.questionKind ?? 'none'}; ${approval.status}; ${approval.reasons.join('; ')}`
    );
  }
  const blockerRows = phaseIds
    .filter((phaseId) => inspection.readiness.phases[phaseId].blockers.length > 0)
    .slice(0, 6)
    .map((phaseId) => [
      phaseId,
      inspection.readiness.phases[phaseId].state,
      inspection.readiness.phases[phaseId].blockers[0] ?? ''
    ]);
  if (blockerRows.length > 0) {
    presentation.table('Current blockers', ['Phase', 'State', 'Reason'], blockerRows);
  }
}

function inspectionPresentation(inspection: GovernanceInspection): PresentationSession {
  return (inspection as GovernanceInspection & { presentation?: PresentationSession }).presentation!;
}

function planJson(inspection: GovernanceInspection): Record<string, unknown> {
  const ready = inspection.graph.graph.phases
    .filter((phase) => inspection.readiness.phases[phase.id].state === 'ready')
    .map((phase) => planPhase(phase, inspection));
  const blocked = inspection.graph.graph.phases
    .filter((phase) => inspection.readiness.phases[phase.id].state === 'blocked')
    .map((phase) => ({
      ...planPhase(phase, inspection),
      blockers: inspection.readiness.phases[phase.id].blockers
    }));
  return {
    schemaVersion: 1,
    command: 'governance plan',
    projectRoot: inspection.projectRoot,
    readOnly: true,
    noWrites: true,
    activationIdentity: inspection.state.identity,
    graphHash: inspection.graph.hash,
    activeChange: inspection.state.activeChange,
    activeSourceOfTruth: inspection.sourceOfTruth,
    credential: inspection.credential,
    readyPhases: ready,
    blockedPhases: blocked
  };
}

function planPhase(phase: PhaseGraphNode, inspection: GovernanceInspection): Record<string, unknown> {
  return {
    id: phase.id,
    label: phase.label,
    requiredEvidence: {
      schema: phase.evidence.schema,
      required: phase.evidence.required,
      liveReadbackProviders: phase.evidence.liveReadbackProviders
    },
    approvalGate: phase.approvalGate,
    approval: approvalEvaluationJson(approvalEvaluationForPhase(phase, inspection)),
    permittedMutations: phase.allowedMutations,
    costEnvelope: costEnvelope(phase),
    evidenceFreshness: inspection.evidenceFreshness[phase.id]
    ,
    ...(phase.id === 'credential-ready' && inspection.credential.applicable
      ? { credential: inspection.credential }
      : {})
  };
}

function costEnvelope(phase: PhaseGraphNode): Record<string, unknown> {
  const relevant = phase.approvalGate.kind === 'infrastructure-cost' ||
    phase.allowedMutations.remote.some((entry) => entry.startsWith('azure-'));
  return {
    relevant,
    gate: phase.approvalGate.kind,
    reason: relevant
      ? 'Infrastructure approval may constrain resource classes, destinations, and cost ceilings.'
      : 'No infrastructure cost envelope is required for this phase.'
  };
}

function renderPlanHuman(inspection: GovernanceInspection, presentation: PresentationSession): void {
  presentation.commandIdentity('governance plan', 'Read-only activation transition plan');
  const ready = inspection.graph.graph.phases.filter((phase) => inspection.readiness.phases[phase.id].state === 'ready');
  const blocked = inspection.graph.graph.phases.filter((phase) => inspection.readiness.phases[phase.id].state === 'blocked');
  presentation.status('info', 'Read-only', 'No files, remotes, credentials, or cloud resources are changed.');
  presentation.table('Ready phases', ['Phase', 'Evidence', 'Question', 'Approval', 'Mutations'], ready.map((phase) => {
    const approval = approvalEvaluationForPhase(phase, inspection);
    return [
    phase.id,
    phase.evidence.schema,
    approval.questionKind ?? 'none',
    phase.approvalGate.required ? phase.approvalGate.kind : 'none',
    `local=${phase.allowedMutations.local.join(',')} remote=${phase.allowedMutations.remote.join(',')}`
    ];
  }));
  presentation.table('Blocked phases', ['Phase', 'Reason'], blocked.slice(0, 12).map((phase) => [
    phase.id,
    inspection.readiness.phases[phase.id].blockers.join('; ')
  ]));
}

function validatePolicyIdentity(inspection: GovernanceInspection): VerificationCheck {
  const issues: string[] = [];
  if (inspection.manifest.governance.profile !== 'none' && inspection.manifest.governance.profile !== 'unspecified') {
    if (inspection.manifest.governance.policyVersion !== governanceActivationPolicyVersion) {
      issues.push(
        `Manifest governance policyVersion ${inspection.manifest.governance.policyVersion ?? 'missing'} does not match ${governanceActivationPolicyVersion}.`
      );
    }
  }
  return { id: 'manifest-policy-identity', status: issues.length === 0 ? 'passed' : 'failed', issues };
}

async function validateManagedPolicy(projectRoot: string, manifest: LiftoffManifest): Promise<VerificationCheck> {
  if (manifest.governance.profile === 'none' || manifest.governance.profile === 'unspecified') {
    return { id: 'managed-policy', status: 'skipped', issues: [] };
  }
  const bytes = await readProjectFile(projectRoot, [...governanceArtifactPaths.policy]);
  const issues: string[] = [];
  if (bytes === undefined) {
    issues.push(`${governanceArtifactPaths.policy.join('/')} is missing.`);
  } else {
    try {
      validateGovernancePolicy(bytes.toString('utf8'));
    } catch (error) {
      issues.push(errorMessage(error));
    }
  }
  return { id: 'managed-policy', status: issues.length === 0 ? 'passed' : 'failed', issues };
}

function validateStateEvidence(inspection: GovernanceInspection): VerificationCheck {
  const issues: string[] = [];
  if (inspection.stateSource === 'not-started') {
    return { id: 'state-evidence', status: 'passed', issues };
  }
  for (const phaseId of phaseIds) {
    const stored = inspection.state.phases[phaseId];
    if (!terminalEvidenceStates.has(stored.state)) {
      continue;
    }
    const records = inspection.evidence.filter((record) => record.header.phaseId === phaseId);
    const current = selectLatestPhaseEvidence(records, inspection.contexts[phaseId]);
    if (!current.selected || current.selected.header.result !== stored.state) {
      issues.push(`Phase ${phaseId} is stored as ${stored.state} but has no current matching authoritative evidence.`);
    }
  }
  return { id: 'state-evidence', status: issues.length === 0 ? 'passed' : 'failed', issues };
}

function validatePhaseTerminalStates(inspection: GovernanceInspection): VerificationCheck {
  const issues: string[] = [];
  for (const phase of inspection.graph.graph.phases) {
    const allowed = phase.terminalStates as readonly string[];
    const stored = inspection.state.phases[phase.id].state;
    const selected = selectLatestPhaseEvidence(
      inspection.evidence.filter((record) => record.header.phaseId === phase.id),
      inspection.contexts[phase.id]
    ).selected;
    if (selected && !allowed.includes(selected.header.result)) {
      issues.push(
        `Evidence ${selected.evidenceId} reports ${selected.header.result}, ` +
          `which is not an allowed terminal state for ${phase.id}.`
      );
    }
    if (terminalPhaseStates.has(stored) && !allowed.includes(stored)) {
      issues.push(`Phase ${phase.id} is stored as ${stored}, which is not an allowed terminal state.`);
    }
    const calculated = inspection.readiness.phases[phase.id].state;
    if (
      calculated !== 'identity-incompatible' &&
      terminalPhaseStates.has(calculated) &&
      !allowed.includes(calculated)
    ) {
      issues.push(`Phase ${phase.id} resolves to ${calculated}, which is not an allowed terminal state.`);
    }
  }
  return {
    id: 'phase-terminal-state',
    status: issues.length === 0 ? 'passed' : 'failed',
    issues
  };
}

function validateEvidenceFreshnessCheck(inspection: GovernanceInspection): VerificationCheck {
  const issues = phaseIds.flatMap((phaseId) => {
    const freshness = inspection.evidenceFreshness[phaseId];
    return freshness.status === 'fresh'
      ? []
      : freshness.issues.map((issue) => `${phaseId}: ${issue}`);
  });
  return { id: 'evidence-freshness', status: issues.length === 0 ? 'passed' : 'failed', issues };
}

function archivedSeedIntegrityCheck(inspection: GovernanceInspection): VerificationCheck {
  if (inspection.archivedSeedIntegrity.status === 'invalid') {
    return {
      id: 'archived-seed-integrity',
      status: 'failed',
      issues: inspection.archivedSeedIntegrity.issues
    };
  }
  return {
    id: 'archived-seed-integrity',
    status: inspection.archivedSeedIntegrity.status === 'valid' ? 'passed' : 'skipped',
    issues: []
  };
}

function validateReadinessCheck(inspection: GovernanceInspection): VerificationCheck {
  if (inspection.readiness.identityCompatible) {
    return { id: 'readiness', status: 'passed', issues: [] };
  }
  return {
    id: 'readiness',
    status: 'failed',
    issues: [inspection.readiness.identityBlocker ?? 'Activation identity is incompatible.']
  };
}

async function activeTaskProjectionCheck(inspection: GovernanceInspection): Promise<VerificationCheck> {
  const activeChange = inspection.state.activeChange;
  if (!activeChange || activeChange.kind !== 'openspec') {
    return { id: 'task-projection', status: 'skipped', issues: [] };
  }
  const pathParts = validateArtifactPathParts(
    ['openspec', 'changes', activeChange.id, 'tasks.md'],
    'Active OpenSpec task path'
  );
  const bytes = await readProjectFile(inspection.projectRoot, pathParts);
  if (bytes === undefined) {
    return { id: 'task-projection', status: 'skipped', issues: [] };
  }
  const markdown = bytes.toString('utf8');
  const mappings = extractPhaseTaskMappings(markdown);
  if (mappings.length === 0) {
    return { id: 'task-projection', status: 'skipped', issues: [] };
  }
  const projection = projectOpenSpecTaskCheckboxes(markdown, mappings, inspection.readiness.phases);
  const issues = projection.changes.map((change) =>
    `Task ${change.taskId} for ${change.phaseId} is ${change.fromChecked ? 'checked' : 'unchecked'} but authoritative phase state is ${change.state}.`
  );
  return { id: 'task-projection', status: issues.length === 0 ? 'passed' : 'failed', issues };
}

function extractPhaseTaskMappings(markdown: string): PhaseTaskMapping[] {
  const phaseIdSet = new Set<string>(phaseIds);
  const mappings: PhaseTaskMapping[] = [];
  const pattern = /^\s*[-*]\s+\[[ xX]\]\s+(\S+).*<!--\s*liftoff-phase:\s*([a-z0-9-]+)\s*-->/u;
  for (const line of markdown.split(/\r?\n/u)) {
    const match = line.match(pattern);
    if (!match) {
      continue;
    }
    const phaseId = match[2]!;
    if (!phaseIdSet.has(phaseId)) {
      throw new Error(`Task projection references unknown phase ${phaseId}.`);
    }
    mappings.push({ phaseId: phaseId as PhaseId, taskId: match[1]! });
  }
  return mappings;
}

function activeChangeIdentityCheck(inspection: GovernanceInspection): VerificationCheck {
  const activeChange = inspection.state.activeChange;
  if (!activeChange) {
    return { id: 'active-change-identity', status: 'skipped', issues: [] };
  }
  const issues: string[] = [];
  try {
    validateArtifactPathParts(
      activeChange.kind === 'openspec'
        ? ['openspec', 'changes', activeChange.id]
        : ['specs', activeChange.id],
      'Active change path'
    );
  } catch (error) {
    issues.push(errorMessage(error));
  }
  return { id: 'active-change-identity', status: issues.length === 0 ? 'passed' : 'failed', issues };
}

function liveReadbackCheck(inspection: GovernanceInspection): VerificationCheck {
  const issues = inspection.graph.graph.phases.flatMap((phase) => {
    if (phase.evidence.liveReadbackProviders.length === 0) {
      return [];
    }
    const freshness = inspection.evidenceFreshness[phase.id];
    return freshness.status === 'fresh'
      ? []
      : freshness.issues.map((issue) => `${phase.id}: ${issue}`);
  });
  return { id: 'live-readback', status: issues.length === 0 ? 'passed' : 'failed', issues };
}

function credentialPolicyCheck(inspection: GovernanceInspection): VerificationCheck {
  if (!inspection.credential.applicable) {
    return { id: 'credential-policy', status: 'skipped', issues: [] };
  }
  return {
    id: 'credential-policy',
    status: inspection.credential.ready ? 'passed' : 'failed',
    issues: inspection.credential.issues
  };
}

function activeSourceOfTruthCheck(inspection: GovernanceInspection): VerificationCheck {
  const source = inspection.sourceOfTruth;
  if (source.status === 'selected' || source.status === 'none') {
    if (source.status === 'selected' && source.reconciliation.status !== 'not-required') {
      return {
        id: 'active-source-of-truth',
        status: 'failed',
        issues: source.reconciliation.issues
      };
    }
    return { id: 'active-source-of-truth', status: 'passed', issues: [] };
  }
  if (source.status === 'seed-blocked' || source.status === 'ambiguous' || source.status === 'incompatible') {
    return {
      id: 'active-source-of-truth',
      status: 'failed',
      issues: source.blockers
    };
  }
  return { id: 'active-source-of-truth', status: 'failed', issues: ['Unknown active source-of-truth status.'] };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function verifyChecks(inspection: GovernanceInspection): Promise<VerificationCheck[]> {
  const managedGraphPresent = await pathExists(await resolveProjectPath(inspection.projectRoot, [...managedPhaseGraphPathParts]));
  return [
    { id: 'phase-graph', status: 'passed', issues: [] },
    {
      id: 'graph-identity',
      status: inspection.graph.hash === currentActivationIdentity.phaseGraphHash ? 'passed' : 'failed',
      issues: inspection.graph.hash === currentActivationIdentity.phaseGraphHash
        ? []
        : [`Graph hash ${inspection.graph.hash} does not match activation identity.`]
    },
    {
      id: 'managed-graph-source',
      status: managedGraphPresent || inspection.graph.source === 'packaged' ? 'passed' : 'failed',
      issues: []
    },
    validatePolicyIdentity(inspection),
    await validateManagedPolicy(inspection.projectRoot, inspection.manifest),
    {
      id: 'activation-state',
      status: inspection.stateSource === 'not-started' ? 'skipped' : 'passed',
      issues: inspection.stateSource === 'not-started'
        ? ['No user activation state exists; reporting deterministic not-started view.']
        : []
    },
    activeChangeIdentityCheck(inspection),
    activeSourceOfTruthCheck(inspection),
    archivedSeedIntegrityCheck(inspection),
    validateEvidenceFreshnessCheck(inspection),
    validateStateEvidence(inspection),
    validatePhaseTerminalStates(inspection),
    credentialPolicyCheck(inspection),
    liveReadbackCheck(inspection),
    await activeTaskProjectionCheck(inspection),
    validateReadinessCheck(inspection)
  ];
}

function setupCompletion(inspection: GovernanceInspection): {
  status: SetupCompletionStatus;
  complete: boolean;
  summary: string;
} {
  if (inspection.stateSource === 'not-started') {
    return {
      status: 'not-started',
      complete: false,
      summary: `Verification is consistent, but setup has not started. Next ready phase: ${inspection.readiness.nextReadyPhase ?? 'none'}.`
    };
  }
  const terminal = inspection.readiness.phases['bootstrap-state-disposed'].state;
  const everyPhaseComplete = inspection.graph.graph.phases.every((phase) => {
    const phaseId = phase.id;
    const state = inspection.readiness.phases[phaseId].state;
    return state !== 'identity-incompatible' &&
      successfulSetupStates.has(state) &&
      (phase.terminalStates as readonly string[]).includes(state);
  });
  if (everyPhaseComplete && (terminal === 'disposed' || terminal === 'inapplicable')) {
    return {
      status: 'complete',
      complete: true,
      summary: 'Verification is consistent and deterministic setup is complete.'
    };
  }
  return {
    status: 'in-progress',
    complete: false,
    summary: inspection.readiness.nextReadyPhase
      ? `Verification is consistent, but setup is incomplete. Next ready phase: ${inspection.readiness.nextReadyPhase}.`
      : 'Verification is consistent, but setup is incomplete and currently blocked.'
  };
}

async function verifyJson(inspection: GovernanceInspection): Promise<GovernanceVerificationResult> {
  const checks = await verifyChecks(inspection);
  const consistent = checks.every((check) => check.status !== 'failed');
  const completion = setupCompletion(inspection);
  const summary = consistent
    ? completion.summary
    : 'Verification found inconsistent governance state; setup is not complete.';
  const setupStatus = consistent || completion.status === 'not-started'
    ? completion.status
    : 'in-progress';
  return {
    schemaVersion: 1,
    command: 'governance verify',
    projectRoot: inspection.projectRoot,
    readOnly: true,
    ok: consistent,
    consistent,
    verificationStatus: consistent ? 'consistent' : 'inconsistent',
    complete: consistent && completion.complete,
    setupStatus,
    stateSource: inspection.stateSource,
    summary,
    activationIdentity: inspection.state.identity,
    graphHash: inspection.graph.hash,
    activeChange: inspection.state.activeChange,
    activeSourceOfTruth: inspection.sourceOfTruth,
    nextReadyPhase: inspection.readiness.nextReadyPhase,
    checks
  };
}

async function renderVerifyHuman(inspection: GovernanceInspection, presentation: PresentationSession): Promise<number> {
  const result = await verifyJson(inspection);
  const checks = result.checks;
  presentation.commandIdentity('governance verify', 'Read-only activation verification');
  presentation.status(
    result.complete ? 'success' : result.consistent ? 'pending' : 'error',
    'setup-completion',
    result.summary
  );
  for (const check of checks) {
    presentation.status(check.status === 'failed' ? 'error' : check.status === 'skipped' ? 'info' : 'success', check.id, check.issues[0]);
  }
  return result.ok === true ? 0 : 1;
}

function renderInspectionFailure(
  subcommand: GovernanceSubcommand,
  projectRoot: string,
  error: unknown,
  presentation: PresentationSession,
  jsonMode: boolean
): number {
  const result = {
    schemaVersion: 1,
    command: `governance ${subcommand}`,
    projectRoot,
    readOnly: true,
    ok: false,
    ...(subcommand === 'verify'
      ? {
          consistent: false,
          verificationStatus: 'inconsistent',
          complete: false,
          setupStatus: 'indeterminate',
          stateSource: 'unavailable',
          summary: 'Verification could not inspect governance state; setup completion is indeterminate.'
        }
      : {}),
    checks: [{
      id: 'inspection',
      status: 'failed',
      issues: [errorMessage(error)]
    }]
  };
  if (jsonMode) {
    json(presentation, result);
  } else {
    presentation.error(errorMessage(error), 'Fix the malformed governance file or restore it from version control, then rerun verification.');
  }
  return 1;
}

function attachPresentation<T extends GovernanceInspection>(inspection: T, presentation: PresentationSession): T {
  (inspection as T & { presentation?: PresentationSession }).presentation = presentation;
  return inspection;
}

function transitionInspection(inspection: GovernanceInspection): GovernanceTransitionInspection {
  return {
    projectRoot: inspection.projectRoot,
    manifest: inspection.manifest,
    graph: inspection.graph.graph,
    graphHash: inspection.graph.hash,
    ...(inspection.loadedState ? { loadedState: inspection.loadedState } : {}),
    state: inspection.state,
    approvals: inspection.approvals,
    evidence: inspection.evidence,
    contexts: inspection.contexts,
    readiness: inspection.readiness,
    sourceOfTruth: inspection.sourceOfTruth
  };
}

function renderApplyNextHuman(
  result: ApplyNextPreview | ApplyNextExecutionResult,
  presentation: PresentationSession
): void {
  presentation.commandIdentity('governance apply-next', 'Controlled activation transition');
  presentation.status(
    result.applied ? 'success' : result.authorized ? 'pending' : 'error',
    result.reason,
    result.message
  );
  presentation.table('Proposed operations', ['Adapter', 'Action', 'Mutation', 'Remote', 'Destructive'], result.proposedMutations.operations.map((op) => [
    op.adapter,
    op.actionId,
    op.mutationClass,
    String(op.remote),
    String(op.destructive)
  ]));
  if ('executedOperations' in result) {
    presentation.table('Executed operations', ['Adapter', 'Action', 'Mutation'], result.executedOperations.map((op) => [
      op.adapter,
      op.actionId,
      op.mutationClass
    ]));
    if (result.savedPlan) {
      presentation.status('info', 'Saved plan', `${result.savedPlan.pathParts.join('/')} (${result.savedPlan.digest})`);
    }
    if (result.evidence) {
      presentation.status('info', 'Evidence', `${result.evidence.pathParts.join('/')} (${result.evidence.headerDigest})`);
    }
    if (result.stateHash) {
      presentation.status('info', 'State hash', result.stateHash);
    }
  } else {
    presentation.status('info', 'Preview only', 'No writes occurred; rerun with --execute to execute at most one phase.');
  }
}

export async function governanceCommand(parsed: ParsedArgs, context: GovernanceCommandContext): Promise<number> {
  const presentation = context.presentation;
  const jsonMode = readBooleanFlag(parsed.flags, 'json') ?? false;
  const subcommand = parseGovernanceSubcommand(parsed);
  if (!subcommand) {
    presentation.error(
      'Missing governance subcommand.',
      'Run `liftoff governance --help` and choose one of: status, plan, apply-next, resume, verify.'
    );
    return 1;
  }
  let projectRoot: string | undefined;
  try {
    projectRoot = await resolveGovernanceProjectRoot(parsed, context);
  } catch (error) {
    presentation.error(errorMessage(error), 'Run `liftoff governance --help` to review accepted project arguments.');
    return 1;
  }
  if (!projectRoot) {
    const start = parsed.positional[0] ?? readStringFlag(parsed.flags, 'project') ?? context.cwd;
    const failure = projectRootError(path.resolve(context.cwd, start));
    presentation.error(failure.message, failure.remedy);
    return 1;
  }

  let inspection: GovernanceInspection;
  try {
    inspection = attachPresentation(await inspectGovernance(projectRoot), presentation);
  } catch (error) {
    if (subcommand === 'verify') {
      return renderInspectionFailure(subcommand, projectRoot, error, presentation, jsonMode);
    }
    throw error;
  }

  if (subcommand === 'status') {
    if (jsonMode) {
      json(presentation, statusJson(inspection, 'status'));
    } else {
      renderStatusHuman(inspection, 'status');
    }
    return 0;
  }
  if (subcommand === 'plan') {
    if (jsonMode) {
      json(presentation, planJson(inspection));
    } else {
      renderPlanHuman(inspection, presentation);
    }
    return 0;
  }
  if (subcommand === 'resume') {
    const result = {
      ...statusJson(inspection, 'resume'),
      deterministicPreflights: ['phase-graph', 'activation-state', 'approvals', 'evidence-freshness', 'readiness'],
      executedOperations: [],
      noWrites: true
    };
    if (jsonMode) {
      json(presentation, result);
    } else {
      renderStatusHuman(inspection, 'resume');
      presentation.status('info', 'Resume scope', 'Recalculated blockers and readiness only; no verified operation was rerun.');
    }
    return 0;
  }
  if (subcommand === 'verify') {
    try {
      if (jsonMode) {
        const result = await verifyJson(inspection);
        json(presentation, result);
        return result.ok === true ? 0 : 1;
      }
      return await renderVerifyHuman(inspection, presentation);
    } catch (error) {
      return renderInspectionFailure(subcommand, projectRoot, error, presentation, jsonMode);
    }
  }

  const execute = readBooleanFlag(parsed.flags, 'execute') ?? false;
  const transitionInput = transitionInspection(inspection);
  const result = execute
    ? await executeApplyNext({
        inspection: transitionInput,
        runner: context.runner,
        reinspect: async () => transitionInspection(
          attachPresentation(await inspectGovernance(projectRoot), presentation)
        )
      })
    : await previewApplyNext({
        inspection: transitionInput,
        runner: context.runner,
        execute: false
      });
  if (jsonMode) {
    json(presentation, result);
  } else {
    renderApplyNextHuman(result, presentation);
  }
  return result.applied || result.reason === 'execute-required' ? 0 : 1;
}
