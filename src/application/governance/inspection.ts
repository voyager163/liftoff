import { readProjectJsonDirectory } from '../../adapters/filesystem/governance-records.js';
import { readProjectFile } from '../../adapters/filesystem/project-files.js';
import {
  approvalRequestForSavedPlan,
  canonicalApprovalEnvelopeHash,
  evaluateApprovalForTransitionPlan,
  transitionPlanForPhase
} from '../../domain/governance/activation/approvals.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { phaseCapabilities } from '../../domain/governance/activation/capabilities.js';
import {
  type EvidenceFreshnessContext,
  type EvidenceSelectionResult,
  assertPhaseOutputsBound,
  selectLatestPhaseEvidence
} from '../../domain/governance/activation/evidence.js';
import {
  canonicalPhaseGraph,
  canonicalPhaseGraphHash,
  currentActivationIdentity
} from '../../domain/governance/activation/graph.js';
import { remoteRepository } from '../../domain/governance/activation/inputs.js';
import { type ReadinessResult, calculatePhaseReadiness } from '../../domain/governance/activation/readiness.js';
import {
  type ActivationConfiguration,
  type ApprovalEnvelope,
  type ApprovalEvaluation,
  type CredentialPolicy,
  type EvidenceHeader,
  type GovernanceScope,
  type ManagedPhaseGraph,
  type PhaseEvidenceRecord,
  type PhaseGraphNode,
  type PhaseId,
  type UserActivationState,
  phaseIds
} from '../../domain/governance/activation/types.js';
import {
  validateApprovalEnvelope,
  validateCredentialPolicy,
  validateManagedPhaseGraph,
  validateManifestActivationForExecution
} from '../../domain/governance/activation/validators.js';
import { governanceActivationPolicyVersion } from '../../domain/governance/policy/identity.js';
import { validateGovernancePolicy } from '../../domain/governance/policy/policy-contract.js';
import { governanceArtifactPaths } from '../../domain/project/catalog.js';
import type { LiftoffManifest } from '../../domain/project/contracts.js';
import { type LoadedActivationState, loadActivationState } from '../../governance-activation/activation-state.js';
import {
  type PatEnrollmentGuidance,
  buildPatEnrollmentGuidance,
  canonicalCredentialRepository,
  credentialPolicyPathParts,
  detectCredentialLeaks,
  runnerPreflightPermissions,
  validateCredentialPolicyUsage
} from '../../governance-activation/credentials.js';
import { type MigrationJournal, migrationRevalidationPhaseIds } from '../../governance-activation/history-contracts.js';
import {
  activationEvidenceContexts,
  activationSensitivePathExclusions,
  protectedLocalInputBlockers,
  readActivationInputSnapshot
} from '../../governance-activation/inputs.js';
import {
  type HistoricalLifecycleObligation,
  historicalLifecyclePhaseBlockers,
  inspectActivationMigrationHistory
} from '../../governance-activation/migration-history.js';
import { readActivationEvidence, readReviewedTransitionPlans } from '../../governance-activation/read-only.js';
import {
  type ArchivedSeedIntegrity,
  discoverGeneratedSeed,
  inspectArchivedSeedIntegrity,
  seedInfrastructureBaselineBlocker
} from '../../governance-activation/seed-lifecycle.js';
import {
  type GovernanceSourceOfTruthInspection,
  inspectGovernanceSourceOfTruth
} from '../../governance-activation/source-of-truth.js';
import { errorMessage } from '../../governance-activation/transition-process.js';
import type { GovernanceTransitionInspection } from '../../governance-activation/transitions.js';
import type { CommandRunner } from '../../process-runner.js';
import { loadManifest } from '../project/manifest.js';
import { formatUpdateCommand } from '../update/command-guidance.js';

type GraphSource = 'packaged' | 'managed';

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

export interface GovernanceInspection {
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

export interface GovernanceMigrationSummary {
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

export const managedPhaseGraphPathParts = ['.liftoff', 'governance', 'phase-graph.json'] as const;

const approvalDirectoryPathParts = ['governance', 'approvals'] as const;

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

async function loadApprovals(projectRoot: string, identity: UserActivationState['identity']): Promise<ApprovalEnvelope[]> {
  const entries = await readProjectJsonDirectory(projectRoot, approvalDirectoryPathParts, 'Approval');
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
      issues: [`${pathLabel} is missing. Review and approve a credential-ready plan, then use governance credential-enroll with a private TTY or explicitly selected protected stdin.`]
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

export interface GovernanceInspectionOptions {
  scope?: GovernanceScope;
  command?: string;
  activationInputs?: ActivationConfiguration;
  recoverPhase?: PhaseId;
}

export async function inspectGovernance(
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
    const payload = proof && isRecord(proof.payload) ? proof.payload : null;
    const usageDigest = payload?.usageDigest;
    credential.ready = !!proof && !!payload &&
      payload.policyDigest === canonicalSha256(credential.policy) &&
      usageDigest === credential.policy.proof.readbackDigest &&
      typeof usageDigest === 'string' &&
      (proof.liveReadback ?? []).some((readback) =>
        readback.provider === 'github' && readback.matches && readback.readbackDigest === usageDigest
      );
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

export function approvalEvaluationForPhase(
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

export function summarizeMigration(inspection: GovernanceInspection): GovernanceMigrationSummary | null {
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

export function transitionInspection(inspection: GovernanceInspection): GovernanceTransitionInspection {
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
