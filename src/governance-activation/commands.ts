import { access, open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { readBooleanFlag, readStringFlag } from '../cli/args/readers.js';
import { findProjectRoot } from '../adapters/filesystem/project-discovery.js';
import { loadManifest } from '../application/project/manifest.js';
import { formatUpdateCommand } from '../application/update/command-guidance.js';
import { readProjectFile } from '../adapters/filesystem/project-files.js';
import { resolveProjectPath } from '../adapters/filesystem/project-paths.js';
import { validateArtifactPathParts } from '../domain/project/paths.js';
import {
  governanceArtifactPaths,
  validateGovernancePolicy
} from '../repository-governance.js';
import type { PresentationSession } from '../terminal.js';
import type { LiftoffManifest, ParsedArgs } from '../domain/project/contracts.js';
import type { CommandRunner } from '../process-runner.js';
import { governanceAssessmentCommand } from '../governance-assessment/command.js';
import {
  activationStateFilePathParts,
  loadActivationState,
  type LoadedActivationState
} from './activation-state.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import {
  approvalRequestForSavedPlan,
  canonicalApprovalEnvelopeHash,
  evaluateApprovalForTransitionPlan,
  transitionPlanForPhase
} from '../domain/governance/activation/approvals.js';
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
  assertPhaseOutputsBound,
  selectLatestPhaseEvidence,
  type EvidenceFreshnessContext,
  type EvidenceSelectionResult
} from '../domain/governance/activation/evidence.js';
import {
  canonicalPhaseGraph,
  canonicalPhaseGraphHash,
  currentActivationIdentity
} from '../domain/governance/activation/graph.js';
import { governanceActivationPolicyVersion } from '../domain/governance/policy/identity.js';
import { calculatePhaseReadiness, type ReadinessResult } from '../domain/governance/activation/readiness.js';
import {
  projectGovernanceChangeTasks,
  projectOpenSpecTaskCheckboxes
} from './task-projection.js';
import {
  inspectGovernanceSourceOfTruth,
  type GovernanceSourceOfTruthInspection
} from './source-of-truth.js';
import {
  discoverGeneratedSeed,
  inspectArchivedSeedIntegrity,
  seedInfrastructureBaselineBlocker,
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
  ManagedPhaseGraph,
  PhaseEvidenceRecord,
  PhaseGraphNode,
  PhaseId,
  PhaseState,
  CredentialPolicy,
  UserActivationState
} from '../domain/governance/activation/types.js';
import {
  phaseIds, phaseScope, type GovernanceScope, type ActivationConfiguration, type SavedTransitionPlan
} from '../domain/governance/activation/types.js';
import {
  activationEvidenceContexts, activationSensitivePathExclusions, protectedLocalInputBlockers, readActivationInputSnapshot
} from './inputs.js';
import { phaseCapabilities } from '../domain/governance/activation/capabilities.js';
import { readActivationEvidence, readReviewedTransitionPlans } from './read-only.js';
import {
  inspectActivationMigrationHistory, historicalLifecyclePhaseBlockers, type HistoricalLifecycleObligation
} from './migration-history.js';
import { migrationRevalidationPhaseIds, type MigrationJournal } from './history-contracts.js';
import {
  validateApprovalEnvelope,
  validateManagedPhaseGraph,
  validateCredentialPolicy,
  validateManifestActivationForExecution
} from '../domain/governance/activation/validators.js';
import { validateActivationConfiguration } from '../domain/governance/activation/validators.js';
import { remoteRepository } from '../domain/governance/activation/inputs.js';
import { isRecord } from '../domain/governance/activation/canonical-json.js';
import {
  approveGovernancePreview, assertGovernanceApprovalIssued, loadGovernancePreview, saveGovernancePreview
} from './public-plans.js';
import { parseArgs } from '../cli/args/parser.js';

interface GovernanceCommandContext {
  cwd: string;
  presentation: PresentationSession;
  runner?: CommandRunner;
}

type GovernanceSubcommand = 'status' | 'plan' | 'approve' | 'apply-next' | 'credential-enroll' | 'recover' | 'resume' | 'verify';
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
  retryArchivedSeedBaseline: boolean;
  expectedActiveSeed: boolean;
  migration: MigrationJournal | null;
  scope: GovernanceScope;
  activationInputs?: ActivationConfiguration;
  recoverPhase?: PhaseId;
  sensitivePathExclusions: readonly (readonly string[])[];
  historicalLifecycleObligations: readonly HistoricalLifecycleObligation[];
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

interface GovernanceMigrationSummary {
  localCommit: MigrationJournal['transaction'];
  snapshot: {
    id: string;
    indexPathParts: readonly string[];
    indexDigest: string;
    linkage: 'validated';
    successor: MigrationJournal['successor'];
  };
  revalidation: MigrationJournal['revalidation'];
  nextRecordedPhase: PhaseId | null;
  currentProofRequired: true;
  remedy: string | null;
}

type SetupCompletionStatus = 'not-started' | 'in-progress' | 'complete';

interface GovernanceVerificationResult {
  schemaVersion: 2;
  scope: GovernanceScope;
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
  migration: MigrationJournal | null;
  migrationSummary: GovernanceMigrationSummary | null;
  graphHash: string;
  activeChange: UserActivationState['activeChange'];
  activeSourceOfTruth: GovernanceSourceOfTruthInspection;
  nextReadyPhase: PhaseId | null;
  checks: readonly VerificationCheck[];
  progress: Record<GovernanceScope, boolean>;
  historicalLifecycleObligations: readonly HistoricalLifecycleObligation[];
  taskProjectionAudit: UserActivationState['taskProjection'] | null;
  nextActions: readonly GovernanceNextAction[];
}

const governanceSubcommands = new Set<GovernanceSubcommand>([
  'status',
  'plan',
  'approve',
  'apply-next',
  'credential-enroll',
  'recover',
  'resume',
  'verify'
]);
const managedPhaseGraphPathParts = ['.liftoff', 'governance', 'phase-graph.json'] as const;
const approvalDirectoryPathParts = ['governance', 'approvals'] as const;
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
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const scan = detectCredentialLeaks([{ source: 'generated-artifact', label: 'governance command output', text }]);
  if (scan.status === 'compromised') {
    throw new Error('Governance output contained credential-shaped data and was withheld; inspect the protected execution checkpoint.');
  }
  presentation.rawStdout(text);
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
      id: 'unbound',
      name: manifest.project.name,
      defaultBranch: 'develop'
    },
    activeChange: null,
    applicability: {
      statePath: 'none',
      privateStagingDast: 'unknown',
      credentialRequired: 'unknown',
      cloudStateRequired: 'unknown',
      privateRunnerRequired: 'unknown'
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

async function loadEvidence(projectRoot: string): Promise<PhaseEvidenceRecord[]> {
  return readActivationEvidence(projectRoot);
}

function repositoryFromState(state: UserActivationState): ReturnType<typeof canonicalCredentialRepository> {
  const remote = remoteRepository(state);
  const repositoryName = remote.name.includes('/')
    ? remote.name.split('/').at(-1)!
    : remote.name;
  const owner = remote.name.includes('/')
    ? remote.name.split('/')[0]!
    : 'local';
  return canonicalCredentialRepository({
    id: remote.id,
    owner,
    name: repositoryName
  });
}

async function inspectCredentialPolicy(projectRoot: string, state: UserActivationState): Promise<CredentialInspection> {
  const pathLabel = credentialPolicyPathParts.join('/');
  if (state.applicability.credentialRequired === 'unknown') {
    return { applicable: true, readOnly: true, path: pathLabel, status: 'not-ready', ready: false,
      guidance: null, policy: null, issues: ['Credential applicability is unknown; independent discovery and a supported enrollment/readback capability are required.'] };
  }
  if (state.applicability.credentialRequired === false) {
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
      issues: [`${pathLabel} is missing. Preview credential-ready and use governance credential-enroll with the approved plan and a private input channel.`]
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
      ready: false,
      guidance: null,
      policy,
      issues: [...usage.issues]
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

interface GovernanceInspectionOptions {
  scope?: GovernanceScope;
  command?: string;
  activationInputs?: ActivationConfiguration;
  recoverPhase?: PhaseId;
}

async function inspectGovernance(
  projectRoot: string,
  runner?: CommandRunner,
  now = new Date(),
  options: GovernanceInspectionOptions = {}
): Promise<GovernanceInspection> {
  const manifest = await loadManifest(projectRoot);
  validateManifestActivationForExecution(manifest);
  const graph = await loadGovernanceGraph(projectRoot);
  await assertPolicyIdentity(projectRoot, manifest);
  const loadedState = await loadActivationState(projectRoot);
  const migration = await inspectActivationMigrationHistory(projectRoot);
  const state = { ...(loadedState?.state ?? notStartedState(manifest)),
    ...(options.activationInputs ? { activationInputs: options.activationInputs } : {}) };
  const isStatusOrVerify = options.command === 'status' || options.command === 'verify';
  const scope = options.scope ?? (isStatusOrVerify ? 'activation' : 'local');
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
  assertPhaseOutputsBound(state, evidence);
  const reviewedPlans = await readReviewedTransitionPlans(projectRoot);
  if (!options.activationInputs) {
    const approvedConfiguration = reviewedPlans.filter((plan) => plan.configuration &&
      approvals.some((approval) => approval.id === plan.approval.envelopeId &&
        canonicalApprovalEnvelopeHash(approval) === plan.approval.envelopeHash))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]?.configuration;
    if (approvedConfiguration) state.activationInputs = approvedConfiguration;
  }
  const sensitivePathExclusions = activationSensitivePathExclusions(
    state, migration.status === 'committed' ? migration.lifecycleObligations.map((obligation) => obligation.retention) : []
  );
  const snapshot = await readActivationInputSnapshot(projectRoot, manifest, runner, { sensitivePathExclusions });
  const contexts = activationEvidenceContexts(graph.graph, state, snapshot, now);
  for (const phase of phaseIds) contexts[phase].reviewedPlans = reviewedPlans;
  const sourceOfTruth = await inspectGovernanceSourceOfTruth({
    projectRoot,
    manifest,
    state,
    evidence,
    contexts
  });
  const archivedSeedIntegrity = await inspectArchivedSeedIntegrity(projectRoot, manifest);
  const archivedBaselineBlocked =
    state.phases['seed-verified'].state === 'blocked' &&
    archivedSeedIntegrity.status === 'valid';
  const seedDiscovery = await discoverGeneratedSeed(projectRoot);
  const retryArchivedSeedBaseline = archivedBaselineBlocked && seedDiscovery?.state === 'archived';
  const archiveAndLaterPhases = phaseIds.slice(phaseIds.indexOf('seed-archived'));
  const expectedActiveSeed =
    sourceOfTruth.status === 'seed-blocked' &&
    sourceOfTruth.candidates.length === 0 &&
    seedDiscovery?.state === 'active' &&
    state.activeChange === null &&
    archiveAndLaterPhases.every((phaseId) =>
      state.phases[phaseId].state === 'pending' || state.phases[phaseId].state === 'blocked'
    ) &&
    !evidence.some((record) => archiveAndLaterPhases.includes(record.header.phaseId));
  const credential = await inspectCredentialPolicy(projectRoot, state);
  const evidenceFreshness = buildEvidenceFreshness(graph.graph, evidence, contexts);
  if (credential.policy && credential.status === 'valid') {
    const proof = selectLatestPhaseEvidence(evidence.filter((entry) => entry.header.phaseId === 'credential-ready'), contexts['credential-ready']).selected;
    credential.ready = !!proof && isRecord(proof.payload) && proof.payload.policyDigest === canonicalSha256(credential.policy);
    if (!credential.ready) credential.issues = ['Independent credential readback and current verification are required; a policy file alone is not proof.'];
  }
  const infrastructureBlocker = seedInfrastructureBaselineBlocker(manifest);
  const localInputBlockers = [
    ...(infrastructureBlocker ? [infrastructureBlocker] : []),
    ...protectedLocalInputBlockers(sensitivePathExclusions)
  ];
  const historicalLifecycleObligations = migration.status === 'committed' ? migration.lifecycleObligations : [];
  const historicalProtection = historicalLifecyclePhaseBlockers(historicalLifecycleObligations);
  const readiness = calculatePhaseReadiness({
    graph: graph.graph,
    state,
    approvals,
    evidence,
    transitionContexts: contexts,
    retryArchivedSeedBaseline,
    scope,
    recoverPhase: options.recoverPhase,
    historicalLifecycleBlockers: historicalProtection['bootstrap-state-disposed'],
    phaseBlockers: {
      ...Object.fromEntries(Object.entries(phaseCapabilities).filter(([, capability]) => capability.blocker)
        .map(([id, capability]) => [id, [capability.blocker!]])),
      ...(archivedSeedIntegrity.status === 'invalid' ? { 'seed-archived': archivedSeedIntegrity.issues } : {}),
      ...(seedDiscovery.state === 'blocked' ? { 'seed-valid': seedDiscovery.issues } : {}),
      ...(localInputBlockers.length ? { 'seed-verified': localInputBlockers } : {})
      , ...historicalProtection
    },
    now
  });
  let resolvedScope = options.scope ?? (isStatusOrVerify ? 'activation' : (readiness.completion.local ? 'activation' : 'local'));
  let finalReadiness = readiness;
  if (resolvedScope !== scope) {
    finalReadiness = calculatePhaseReadiness({
      graph: graph.graph,
      state,
      approvals,
      evidence,
      transitionContexts: contexts,
      retryArchivedSeedBaseline,
      scope: resolvedScope,
      recoverPhase: options.recoverPhase,
      historicalLifecycleBlockers: historicalProtection['bootstrap-state-disposed'],
      phaseBlockers: {
        ...Object.fromEntries(Object.entries(phaseCapabilities).filter(([, capability]) => capability.blocker)
          .map(([id, capability]) => [id, [capability.blocker!]])),
        ...(archivedSeedIntegrity.status === 'invalid' ? { 'seed-archived': archivedSeedIntegrity.issues } : {}),
        ...(seedDiscovery.state === 'blocked' ? { 'seed-valid': seedDiscovery.issues } : {}),
        ...(localInputBlockers.length ? { 'seed-verified': localInputBlockers } : {})
        , ...historicalProtection
      },
      now
    });
  }
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
    readiness: finalReadiness,
    sourceOfTruth,
    credential,
    archivedSeedIntegrity,
    retryArchivedSeedBaseline,
    expectedActiveSeed,
    migration: migration.status === 'committed' ? migration.journal : null
    , scope: resolvedScope,
    ...(state.activationInputs ? { activationInputs: state.activationInputs } : {}),
    ...(options.recoverPhase ? { recoverPhase: options.recoverPhase } : {})
    , sensitivePathExclusions,
    historicalLifecycleObligations
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
  const reviewed = inspection.contexts[phase.id].reviewedPlans?.filter((plan) => plan.phaseId === phase.id &&
    plan.inputDigest === inspection.contexts[phase.id].inputDigest && plan.baselineDigest === inspection.contexts[phase.id].baselineSha)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  const plan = reviewed ? approvalRequestForSavedPlan(reviewed, phase, inspection.state) : transitionPlanForPhase(
    phase,
    inspection.state,
    inspection.contexts[phase.id].transition,
    inspection.projectRoot,
    inspection.contexts[phase.id].publicationDestination
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

function summarizeMigration(inspection: GovernanceInspection): GovernanceMigrationSummary | null {
  const journal = inspection.migration;
  if (!journal) return null;
  const phases = migrationRevalidationPhaseIds.map((phaseId) =>
    journal.revalidation.phases.find((phase) => phase.phaseId === phaseId)!
  );
  const needsRevalidation = journal.revalidation.status !== 'complete' ||
    migrationRevalidationPhaseIds.some((phaseId) => inspection.readiness.phases[phaseId].state !== 'verified');
  const checkCommand = formatUpdateCommand(inspection.projectRoot, 'check');
  return {
    localCommit: journal.transaction,
    snapshot: {
      id: journal.snapshotId,
      indexPathParts: journal.historyIndexPathParts,
      indexDigest: journal.historyIndexDigest,
      linkage: 'validated',
      successor: journal.successor
    },
    revalidation: { ...journal.revalidation, phases },
    nextRecordedPhase: phases.find((phase) => phase.status !== 'complete')?.phaseId ?? null,
    currentProofRequired: true,
    remedy: needsRevalidation
      ? `Keep the committed v3 successor and preserved v1/v2 history. Repair the named blockers or stale current proof, run ${checkCommand} for a fresh preview, then explicitly approve the exact remaining local plan before retrying. Prior migration approval does not authorize new work.`
      : null
  };
}

function renderMigrationHuman(
  summary: GovernanceMigrationSummary | null,
  presentation: PresentationSession
): void {
  if (!summary) return;
  presentation.definitions('Migration progress (journal)', [
    { label: 'Local migration', value: `${summary.localCommit.status} at ${summary.localCommit.committedAt}` },
    { label: 'History snapshot', value: summary.snapshot.id },
    { label: 'History index', value: summary.snapshot.indexPathParts.join('/') },
    { label: 'History index digest', value: summary.snapshot.indexDigest },
    { label: 'History linkage', value: `${summary.snapshot.linkage}; successor ${summary.snapshot.successor.repositoryId}` },
    { label: 'Recorded revalidation', value: summary.revalidation.status },
    { label: 'Next recorded phase', value: summary.nextRecordedPhase ?? 'none' }
  ]);
  presentation.table('Recorded local revalidation', ['Phase', 'Progress', 'Blockers'], summary.revalidation.phases.map((phase) => [
    phase.phaseId,
    phase.status,
    phase.blockers.join('; ') || 'none recorded'
  ]));
  if (summary.revalidation.nextAction) {
    presentation.status('pending', 'Recorded next action', summary.revalidation.nextAction);
  }
  presentation.status(
    'info',
    'Migration scope',
    'Journal progress is audit information, not current proof, governance completion, approval, or provider authority. Current readiness is evaluated separately from v3 evidence.'
  );
  if (summary.remedy) presentation.remedy(summary.remedy);
}

function statusJson(inspection: GovernanceInspection, command: GovernanceSubcommand): Record<string, unknown> {
  const blockers = verificationPhaseIds(inspection).flatMap((phaseId) =>
    inspection.readiness.phases[phaseId].blockers.map((message) => ({ phaseId, message }))
  );
  return {
    schemaVersion: 2,
    scope: inspection.scope,
    command: `governance ${command}`,
    projectRoot: inspection.projectRoot,
    readOnly: command !== 'apply-next',
    stateSource: inspection.stateSource,
    activationDisabled: inspection.manifest.governance.profile === 'none',
    progress: inspection.readiness.completion,
    localComplete: inspection.readiness.completion.local,
    activationComplete: inspection.readiness.completion.activation,
    lifecycleComplete: inspection.readiness.completion.lifecycle,
    nextActions: governanceNextActions(inspection),
    blockerFingerprint: canonicalSha256({
      scope: inspection.scope, stateHash: inspection.loadedState?.contentHash ?? null,
      inputs: verificationPhaseIds(inspection).map((id) => [id, inspection.contexts[id].inputDigest]), blockers
    }),
    activationIdentity: inspection.state.identity,
    migration: inspection.migration,
    migrationSummary: summarizeMigration(inspection),
    taskProjectionAudit: inspection.state.taskProjection ?? null,
    historicalLifecycleObligations: inspection.historicalLifecycleObligations,
    executionAnchor: inspection.state.repository.id === 'unbound' ? null : inspection.state.repository.id,
    remoteBinding: inspection.state.remoteBinding ?? null,
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
      scope: phaseScope(phase.id),
      plannable: inspection.readiness.phases[phase.id].plannable ?? false,
      externalOperation: inspection.state.phases[phase.id].operation ?? null,
      executionPlanDigest: inspection.state.phases[phase.id].executionPlanDigest ?? null,
      storedBlockers: inspection.state.phases[phase.id].blockers,
      retryable: phaseCapabilities[phase.id].retry === 'explicit-local' &&
        ['failed', 'blocked'].includes(inspection.state.phases[phase.id].state),
      capability: phaseCapabilities[phase.id],
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
    nextPlannablePhase: inspection.readiness.nextPlannablePhase,
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

interface GovernanceNextAction {
  id: string;
  label: string;
  command: { executable: 'liftoff'; args: readonly string[] };
  cwd: string;
  scope: GovernanceScope;
  approvalRequired: boolean;
}

function governanceAction(
  inspection: GovernanceInspection,
  subcommand: GovernanceSubcommand,
  scope: GovernanceScope,
  extras: readonly string[] = [],
  approvalRequired = false
): GovernanceNextAction {
  const args = ['governance', subcommand, '--project', inspection.projectRoot, '--scope', scope, ...extras, '--json'];
  parseArgs(args);
  return {
    id: `governance-${subcommand}-${scope}`, label: `${subcommand} ${scope} governance`,
    command: { executable: 'liftoff', args }, cwd: inspection.projectRoot, scope, approvalRequired
  };
}

function governanceNextActions(
  inspection: GovernanceInspection,
  preview?: { fingerprint: string; plan: SavedTransitionPlan }
): GovernanceNextAction[] {
  if (inspection.manifest.governance.profile === 'none' && inspection.scope === 'activation') return [];
  if (inspection.readiness.completion[inspection.scope]) {
    if (inspection.scope === 'local') return [governanceAction(inspection, 'plan', 'activation')];
    if (inspection.scope === 'activation' && !inspection.readiness.completion.lifecycle) {
      return [governanceAction(inspection, 'status', 'lifecycle')];
    }
    return [];
  }
  if (preview) {
    const planArgs = ['--plan', preview.fingerprint];
    if (preview.plan.approval.evaluation.approvalRequired) {
      return [governanceAction(inspection, 'approve', preview.plan.scope, planArgs, true)];
    }
    const subcommand = preview.plan.recovery ? 'recover' : 'apply-next';
    return [governanceAction(inspection, subcommand, preview.plan.scope,
      [...(inspection.stateSource === 'not-started' ? [] : planArgs), '--execute'])];
  }
  const interrupted = phaseIds.find((id) => phaseScope(id) === inspection.scope && inspection.readiness.phases[id].recoveryRequired);
  if (interrupted) return [governanceAction(inspection, 'plan', inspection.scope, ['--recover-phase', interrupted])];
  if (inspection.scope !== 'local' && !inspection.readiness.completion.local) {
    return [governanceAction(inspection, 'plan', 'local')];
  }
  return [governanceAction(inspection, 'plan', inspection.scope)];
}

function verificationPhaseIds(inspection: GovernanceInspection): readonly PhaseId[] {
  return phaseIds.filter((id) => phaseScope(id) === inspection.scope ||
    inspection.scope === 'activation' && phaseScope(id) === 'local');
}

function renderStatusHuman(inspection: GovernanceInspection, command: GovernanceSubcommand): void {
  const presentation = inspectionPresentation(inspection);
  presentation.commandIdentity(`governance ${command}`, 'Deterministic activation status');
  presentation.definitions('Activation identity', [
    { label: 'Project', value: inspection.projectRoot },
    { label: 'Scope', value: inspection.scope },
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
  renderMigrationHuman(summarizeMigration(inspection), presentation);
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
  if (inspection.retryArchivedSeedBaseline) {
    presentation.status(
      'pending',
      'Archived baseline retry',
      `The prior baseline failure is preserved. Explicit execution reruns all local checks: ${inspection.state.phases['seed-verified'].blockers.join('; ')}`
    );
  }
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
  const scopedPhases = inspection.scope === 'local'
    ? inspection.graph.graph.phases.filter((phase) => phaseScope(phase.id) === 'local')
    : inspection.scope === 'lifecycle'
      ? inspection.graph.graph.phases.filter((phase) => phaseScope(phase.id) === 'lifecycle')
      : inspection.graph.graph.phases.filter((phase) => phaseScope(phase.id) !== 'lifecycle');
  const ready = scopedPhases
    .filter((phase) => inspection.readiness.phases[phase.id].state === 'ready')
    .map((phase) => planPhase(phase, inspection));
  const blocked = scopedPhases
    .filter((phase) => inspection.readiness.phases[phase.id].state === 'blocked')
    .map((phase) => ({
      ...planPhase(phase, inspection),
      blockers: inspection.readiness.phases[phase.id].blockers
    }));
  return {
    schemaVersion: 2,
    scope: inspection.scope,
    command: 'governance plan',
    projectRoot: inspection.projectRoot,
    readOnly: true,
    noWrites: true,
    activationIdentity: inspection.state.identity,
    graphHash: inspection.graph.hash,
    activeChange: inspection.state.activeChange,
    activeSourceOfTruth: inspection.sourceOfTruth,
    credential: inspection.credential,
    progress: inspection.readiness.completion,
    nextReadyPhase: inspection.readiness.nextReadyPhase,
    nextPlannablePhase: inspection.readiness.nextPlannablePhase,
    nextActions: governanceNextActions(inspection),
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
  presentation.commandIdentity('governance plan', `Project-read-only ${inspection.scope} transition plan`);
  const scopedPhases = inspection.scope === 'local'
    ? inspection.graph.graph.phases.filter((phase) => phaseScope(phase.id) === 'local')
    : inspection.scope === 'lifecycle'
      ? inspection.graph.graph.phases.filter((phase) => phaseScope(phase.id) === 'lifecycle')
      : inspection.graph.graph.phases.filter((phase) => phaseScope(phase.id) !== 'lifecycle');
  const ready = scopedPhases.filter((phase) => inspection.readiness.phases[phase.id].state === 'ready');
  const blocked = scopedPhases.filter((phase) => inspection.readiness.phases[phase.id].state === 'blocked');
  presentation.status('info', 'Project-read-only', 'No project or provider data is changed; any external preview receipt is disclosed separately.');
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
  for (const phaseId of verificationPhaseIds(inspection)) {
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
  for (const phase of inspection.graph.graph.phases.filter((phase) => verificationPhaseIds(inspection).includes(phase.id))) {
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
  const issues = verificationPhaseIds(inspection).flatMap((phaseId) => {
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

function extractPhaseTaskMappings(markdown: string): Array<{ phaseId: PhaseId; taskId: string }> {
  const phaseIdSet = new Set<string>(phaseIds);
  const mappings: Array<{ phaseId: PhaseId; taskId: string }> = [];
  const pattern = /^\s*[-*]\s+\[[ xX]\]\s+(\S+).*<!--\s*liftoff-phase:\s*([a-z0-9-]+)\s*-->/u;
  for (const line of markdown.split(/\r?\n/u)) {
    const match = line.match(pattern);
    if (!match) continue;
    const phaseId = match[2]!;
    if (!phaseIdSet.has(phaseId)) {
      throw new Error(`Task projection references unknown phase ${phaseId}.`);
    }
    mappings.push({ phaseId: phaseId as PhaseId, taskId: match[1]! });
  }
  return mappings;
}

async function activeTaskProjectionCheck(inspection: GovernanceInspection): Promise<VerificationCheck> {
  const issues: string[] = [];
  let inspected = false;
  if (inspection.scope !== 'lifecycle' && inspection.manifest.project.specWorkflow === 'spec-kit') {
    inspected = true;
    const bytes = await readProjectFile(inspection.projectRoot, ['specs', '000-liftoff-bootstrap', 'tasks.md']);
    if (!bytes) return { id: 'task-projection', status: 'failed', issues: ['Spec Kit seed-adoption-required: real bootstrap tasks are missing.'] };
    const expected = inspection.readiness.phases['seed-verified'].state === 'verified';
    const tasks = [...bytes.toString('utf8').matchAll(/^\s*- \[([ xX])\] (B00[1-6]) /gm)];
    issues.push(...tasks.filter((match) => (match[1]!.toLowerCase() === 'x') !== expected)
      .map((match) => `Spec Kit task ${match[2]} differs from the authoritative local baseline projection. Verification did not edit it.`));
  }
  const activeChange = inspection.state.activeChange;
  if (activeChange && activeChange.kind === 'openspec') {
    const pathParts = validateArtifactPathParts(['openspec', 'changes', activeChange.id, 'tasks.md'], 'Active OpenSpec task path');
    const bytes = await readProjectFile(inspection.projectRoot, pathParts);
    if (bytes !== undefined) {
      inspected = true;
      const markdown = bytes.toString('utf8');
      const mappings = extractPhaseTaskMappings(markdown);
      if (mappings.length > 0) {
        const projection = projectOpenSpecTaskCheckboxes(markdown, mappings, inspection.readiness.phases);
        issues.push(...projection.changes.filter((change) => verificationPhaseIds(inspection).includes(change.phaseId)).map((change) =>
          `Task ${change.taskId} for ${change.phaseId} is ${change.fromChecked ? 'checked' : 'unchecked'} but authoritative phase state is ${change.state}.`
        ));
      }
    }
  }
  const source = inspection.sourceOfTruth;
  if (inspection.scope !== 'local' && source.status === 'selected') {
    inspected = true;
    if (!source.selected.metadata) {
      issues.push('The selected current governance source has no validated metadata.');
    } else {
      const pathParts = validateArtifactPathParts([...source.selected.pathParts, 'tasks.md'], 'Current governance task path');
      const bytes = await readProjectFile(inspection.projectRoot, pathParts);
      if (!bytes) issues.push(`Current governance tasks ${pathParts.join('/')} are missing.`);
      else {
        const projection = projectGovernanceChangeTasks(bytes.toString('utf8'), source.selected.metadata, inspection.readiness.phases);
        issues.push(...projection.changes.filter((change) => verificationPhaseIds(inspection).includes(change.phaseId)).map((change) =>
          `Task ${change.taskId} for ${change.phaseId} is ${change.fromChecked ? 'checked' : 'unchecked'} but current authoritative phase state is ${change.state}.`
        ));
      }
    }
  }
  return { id: 'task-projection', status: issues.length ? 'failed' : inspected ? 'passed' : 'skipped', issues };
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
  const issues = inspection.graph.graph.phases.filter((phase) => verificationPhaseIds(inspection).includes(phase.id)).flatMap((phase) => {
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
  if (inspection.scope !== 'activation') return { id: 'credential-policy', status: 'skipped', issues: [] };
  if (!inspection.credential.applicable) {
    return { id: 'credential-policy', status: 'skipped', issues: [] };
  }
  if (inspection.state.applicability.credentialRequired === 'unknown' &&
    !terminalEvidenceStates.has(inspection.state.phases['credential-ready'].state)) {
    return { id: 'credential-policy', status: 'skipped', issues: inspection.credential.issues };
  }
  return {
    id: 'credential-policy',
    status: inspection.credential.ready ? 'passed' : 'failed',
    issues: inspection.credential.issues
  };
}

function activeSourceOfTruthCheck(inspection: GovernanceInspection): VerificationCheck {
  const source = inspection.sourceOfTruth;
  if (inspection.scope === 'local') {
    if (source.status === 'seed-blocked' && !inspection.expectedActiveSeed) {
      return { id: 'active-source-of-truth', status: 'failed', issues: source.blockers };
    }
    return { id: 'active-source-of-truth', status: 'skipped', issues: [] };
  }
  if (inspection.expectedActiveSeed) {
    return {
      id: 'active-source-of-truth',
      status: 'skipped',
      issues: ['The generated bootstrap seed is still active; governance creation remains gated until its baseline and archive phases finish.']
    };
  }
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
  if (inspection.readiness.completion[inspection.scope]) {
    return {
      status: 'complete',
      complete: true,
      summary: inspection.scope === 'local'
        ? 'Local setup is complete. Repository publication, cloud deployment, and governance activation are separate approved work.'
        : inspection.scope === 'activation'
          ? 'Governance activation is complete. Delayed retained-state disposal is tracked separately.'
          : 'Lifecycle work is complete.'
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
    schemaVersion: 2,
    scope: inspection.scope,
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
    migration: inspection.migration,
    migrationSummary: summarizeMigration(inspection),
    graphHash: inspection.graph.hash,
    activeChange: inspection.state.activeChange,
    activeSourceOfTruth: inspection.sourceOfTruth,
    nextReadyPhase: inspection.readiness.nextReadyPhase,
    progress: inspection.readiness.completion,
    nextActions: governanceNextActions(inspection),
    checks,
    historicalLifecycleObligations: inspection.historicalLifecycleObligations,
    taskProjectionAudit: inspection.state.taskProjection ?? null
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
  renderMigrationHuman(result.migrationSummary, presentation);
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
  jsonMode: boolean,
  scope: GovernanceScope = 'activation'
): number {
  const result = {
    schemaVersion: 2,
    scope,
    command: `governance ${subcommand}`,
    projectRoot,
    readOnly: true,
    ok: false,
    nextActions: [],
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
    scope: inspection.scope,
    ...(inspection.activationInputs ? { activationInputs: inspection.activationInputs } : {}),
    ...(inspection.recoverPhase ? { recoverPhase: inspection.recoverPhase } : {}),
    sensitivePathExclusions: inspection.sensitivePathExclusions,
    historicalLifecycleObligations: inspection.historicalLifecycleObligations,
    ...(inspection.loadedState ? { loadedState: inspection.loadedState } : {}),
    state: inspection.state,
    approvals: inspection.approvals,
    evidence: inspection.evidence,
    contexts: inspection.contexts,
    readiness: inspection.readiness,
    sourceOfTruth: inspection.sourceOfTruth
  };
}

export async function inspectGovernanceTransition(
  projectRoot: string,
  options: GovernanceInspectionOptions & { runner?: CommandRunner; now?: Date } = {}
): Promise<GovernanceTransitionInspection> {
  return transitionInspection(await inspectGovernance(projectRoot, options.runner, options.now, options));
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
  if (result.selectedPhase) {
    presentation.status('info', 'Selected phase', result.selectedPhase);
  }
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
    if (result.executedPhase) {
      presentation.status(
        'info',
        'Next phase',
        'Run governance verify or status for post-transition readiness.'
      );
    }
  } else {
    presentation.status('info', 'Preview only', 'No writes occurred; rerun with --execute to execute at most one phase.');
  }
}

function governanceScopeFlag(parsed: ParsedArgs): GovernanceScope {
  const value = readStringFlag(parsed.flags, 'scope') ?? 'activation';
  if (value !== 'local' && value !== 'activation' && value !== 'lifecycle') throw new Error('Governance scope must be local, activation, or lifecycle.');
  return value;
}

async function publicActivationInputs(filePath: string): Promise<ActivationConfiguration> {
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) {
      throw new Error('Activation inputs must be a singly linked regular public JSON file no larger than 64 KiB.');
    }
    const text = await handle.readFile('utf8');
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new Error('Activation inputs are not valid JSON; credential or state content must not be supplied here.'); }
    return validateActivationConfiguration(value);
  } finally {
    await handle.close();
  }
}

export async function governanceCommand(parsed: ParsedArgs, context: GovernanceCommandContext): Promise<number> {
  if (parsed.subcommand === 'assess') {
    return governanceAssessmentCommand(parsed, context);
  }
  const presentation = context.presentation;
  const jsonMode = readBooleanFlag(parsed.flags, 'json') ?? false;
  const subcommand = parseGovernanceSubcommand(parsed);
  if (!subcommand) {
    presentation.error(
      'Missing governance subcommand.',
      'Run `liftoff governance --help` to choose a supported planning, approval, execution, or inspection command.'
    );
    return 1;
  }
  const rawScope = readStringFlag(parsed.flags, 'scope');
  if (rawScope && rawScope !== 'local' && rawScope !== 'activation' && rawScope !== 'lifecycle') {
    throw new Error('Governance scope must be local, activation, or lifecycle.');
  }
  const scope = rawScope as GovernanceScope | undefined;
  let projectRoot: string | undefined;
  try {
    projectRoot = await resolveGovernanceProjectRoot(parsed, context);
  } catch (error) {
    throw new Error(`${errorMessage(error)} Run liftoff governance --help to review accepted project arguments.`);
  }
  if (!projectRoot) {
    const start = parsed.positional[0] ?? readStringFlag(parsed.flags, 'project') ?? context.cwd;
    const failure = projectRootError(path.resolve(context.cwd, start));
    presentation.error(failure.message, failure.remedy);
    return 1;
  }

  const inputsFile = readStringFlag(parsed.flags, 'inputs');
  const activationInputs = inputsFile ? await publicActivationInputs(path.resolve(context.cwd, inputsFile)) : undefined;
  const fingerprint = readStringFlag(parsed.flags, 'plan');
  const reviewed = fingerprint ? await loadGovernancePreview(projectRoot, fingerprint) : undefined;
  if (reviewed && scope && reviewed.plan.scope !== scope) throw new Error('The selected scope does not match the reviewed plan.');
  if (subcommand === 'recover' && !reviewed?.plan.recovery) throw new Error('Recovery requires a preview explicitly created with governance plan --recover-phase.');
  if (subcommand === 'apply-next' && reviewed?.plan.recovery) throw new Error('A recovery preview can be executed only with governance recover.');
  if (subcommand === 'credential-enroll' && reviewed?.plan.phaseId !== 'credential-ready') {
    throw new Error('Credential enrollment requires a credential-ready preview, not another activation or repair plan.');
  }
  const requestedRecovery = readStringFlag(parsed.flags, 'recover-phase');
  const recoverPhase = reviewed?.plan.recovery ? reviewed.plan.phaseId : phaseIds.find((id) => id === requestedRecovery);
  const options: GovernanceInspectionOptions = {
    ...(scope ? { scope } : {}),
    command: subcommand,
    ...(activationInputs ?? reviewed?.plan.configuration ? { activationInputs: activationInputs ?? reviewed?.plan.configuration } : {}),
    ...(recoverPhase ? { recoverPhase } : {})
  };
  let inspection: GovernanceInspection;
  try {
    inspection = attachPresentation(await inspectGovernance(projectRoot, context.runner, new Date(), options), presentation);
  } catch (error) {
    if (subcommand === 'verify') {
      return renderInspectionFailure(subcommand, projectRoot, error, presentation, jsonMode, scope);
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
    let saved: Awaited<ReturnType<typeof saveGovernancePreview>>;
    try {
      saved = await saveGovernancePreview(transitionInspection(inspection), { runner: context.runner });
    } catch (error) {
      if (jsonMode) json(presentation, {
        ...planJson(inspection), ready: false, reason: 'planning-blocked',
        blockers: [errorMessage(error)], preview: null
      });
      else presentation.error(errorMessage(error), 'Supply the named supported inputs or resolve the prerequisite, then request a fresh plan.');
      return 1;
    }
    if (jsonMode) {
      json(presentation, {
        ...planJson(inspection),
        preview: saved ? { fingerprint: saved.preview.fingerprint, path: saved.path, expiresAt: saved.preview.plan.expiresAt } : null,
        plan: saved?.preview.plan ?? null,
        projectWrites: false,
        providerWrites: false,
        noWrites: true,
        externalPreviewWritten: saved !== null,
        nextActions: governanceNextActions(inspection, saved?.preview)
      });
    } else {
      renderPlanHuman(inspection, presentation);
      if (saved) {
        presentation.status('info', 'External preview', `${saved.path}; fingerprint ${saved.preview.fingerprint}. This is not approval.`);
        const next = governanceNextActions(inspection, saved.preview)[0];
        if (next) presentation.remedy([next.command.executable, ...next.command.args.map((arg) => /\s/u.test(arg) ? JSON.stringify(arg) : arg)].join(' '));
      }
    }
    return 0;
  }
  if (subcommand === 'approve') {
    const approved = await approveGovernancePreview({
      projectRoot, fingerprint: fingerprint!,
      inspect: async () => transitionInspection(await inspectGovernance(projectRoot, context.runner, new Date(), options)),
      runner: context.runner
    });
    const refreshed = attachPresentation(await inspectGovernance(projectRoot, context.runner, new Date(), options), presentation);
    const result = {
      schemaVersion: 2, command: 'governance approve', projectRoot, scope,
      approved: true, executed: false, envelopeId: approved.envelope.id,
      envelopeHash: canonicalApprovalEnvelopeHash(approved.envelope), expiresAt: approved.envelope.expiresAt,
      nextActions: governanceNextActions(refreshed, { fingerprint: fingerprint!, plan: approved.plan })
    };
    if (jsonMode) json(presentation, result);
    else presentation.status('success', 'Plan approved', `Approval ${approved.envelope.id} was saved without executing its operations.`);
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
      return renderInspectionFailure(subcommand, projectRoot, error, presentation, jsonMode, scope);
    }
  }

  const execute = subcommand === 'credential-enroll' || (readBooleanFlag(parsed.flags, 'execute') ?? false);
  const transitionInput = transitionInspection(inspection);
  const result = execute
    ? await executeApplyNext({
        inspection: transitionInput,
        runner: context.runner,
        reviewedPlan: reviewed?.plan,
        recovery: subcommand === 'recover',
        ...(subcommand === 'credential-enroll' ? {
          credentialEnrollment: { protectedStdin: readBooleanFlag(parsed.flags, 'protected-stdin') ?? false }
        } : {}),
        reinspect: async () => transitionInspection(
          attachPresentation(await inspectGovernance(projectRoot, context.runner, new Date(), options), presentation)
        )
      })
    : await previewApplyNext({
        inspection: transitionInput,
        runner: context.runner,
        execute: false
      });
  if (jsonMode) {
    const refreshed = execute
      ? await inspectGovernance(projectRoot, context.runner, new Date(), { ...options, recoverPhase: undefined })
      : inspection;
    json(presentation, {
      ...result, command: `governance ${subcommand}`,
      progress: refreshed.readiness.completion,
      nextActions: governanceNextActions(refreshed)
    });
  } else {
    renderApplyNextHuman(result, presentation);
  }
  return result.applied || ['execute-required', 'external-operation-pending'].includes(result.reason) ? 0 : 1;
}
