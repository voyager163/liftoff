import { readdir } from 'node:fs/promises';
import { loadManifest } from '../project/manifest.js';
import { readProjectFile } from '../../adapters/filesystem/project-files.js';
import { resolveProjectPath } from '../../adapters/filesystem/project-paths.js';
import { validateArtifactPathParts } from '../../domain/project/paths.js';
import { governanceArtifactPaths } from '../../domain/project/catalog.js';
import { validateGovernancePolicy } from '../../domain/governance/policy/content-validation.js';
import type { LiftoffManifest } from '../../domain/project/contracts.js';
import type { CommandRunner } from '../../process-runner.js';
import { loadActivationState } from '../../governance-activation/activation-state.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { canonicalApprovalEnvelopeHash } from '../../domain/governance/activation/approvals.js';
import { buildPatEnrollmentGuidance, canonicalCredentialRepository, credentialPolicyPathParts, detectCredentialLeaks, runnerPreflightPermissions, validateCredentialPolicyUsage } from '../../governance-activation/credentials.js';
import { assertPhaseOutputsBound, selectLatestPhaseEvidence, type EvidenceFreshnessContext, type EvidenceSelectionResult } from '../../domain/governance/activation/evidence.js';
import { canonicalPhaseGraph, canonicalPhaseGraphHash, currentActivationIdentity } from '../../domain/governance/activation/graph.js';
import { governanceActivationPolicyVersion } from '../../domain/governance/policy/identity.js';
import { calculatePhaseReadiness } from '../../domain/governance/activation/readiness.js';
import { inspectGovernanceSourceOfTruth } from '../../governance-activation/source-of-truth.js';
import { discoverGeneratedSeed, inspectArchivedSeedIntegrity, seedInfrastructureBaselineBlocker } from '../../governance-activation/seed-lifecycle.js';
import { type GovernanceTransitionInspection } from '../../governance-activation/transitions.js';
import type { ApprovalEnvelope, ManagedPhaseGraph, PhaseEvidenceRecord, PhaseGraphNode, PhaseId, UserActivationState } from '../../domain/governance/activation/types.js';
import { phaseIds } from '../../domain/governance/activation/types.js';
import { activationEvidenceContexts, activationSensitivePathExclusions, protectedLocalInputBlockers, readActivationInputSnapshot } from '../../governance-activation/inputs.js';
import { phaseCapabilities } from '../../domain/governance/activation/capabilities.js';
import { readActivationEvidence, readReviewedTransitionPlans } from '../../governance-activation/read-only.js';
import { inspectActivationMigrationHistory, historicalLifecyclePhaseBlockers } from '../../governance-activation/migration-history.js';
import { validateApprovalEnvelope, validateManagedPhaseGraph, validateCredentialPolicy, validateManifestActivationForExecution } from '../../domain/governance/activation/validators.js';
import { remoteRepository } from '../../domain/governance/activation/inputs.js';
import { isRecord } from '../../domain/governance/activation/canonical-json.js';
import { assertGovernanceConfigurationBinding } from './configuration.js';
import path from 'node:path';
import type { LoadedGovernanceGraph, EvidenceFreshnessEntry, GovernanceInspection, CredentialInspection, GovernanceInspectionOptions } from './inspection-contracts.js';
import { readPhaseReviews } from '../../governance-activation/phase-reviews.js';

export const managedPhaseGraphPathParts = ['.liftoff', 'governance', 'phase-graph.json'] as const;

export const approvalDirectoryPathParts = ['governance', 'approvals'] as const;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function emptyPhaseState(now: string): UserActivationState['phases'] {
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

export function notStartedState(manifest: LiftoffManifest): UserActivationState {
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

export async function loadGovernanceGraph(projectRoot: string): Promise<LoadedGovernanceGraph> {
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

export async function readJsonFiles(projectRoot: string, directoryPathParts: readonly string[], label: string): Promise<Array<{
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

export async function loadApprovals(projectRoot: string, identity: UserActivationState['identity']): Promise<ApprovalEnvelope[]> {
  const entries = await readJsonFiles(projectRoot, approvalDirectoryPathParts, 'Approval');
  return entries.map((entry) => {
    try {
      return validateApprovalEnvelope(entry.value, { expectedIdentity: identity });
    } catch (error) {
      throw new Error(`Invalid ${approvalDirectoryPathParts.join('/')}/${entry.name}: ${errorMessage(error)}`);
    }
  });
}

export async function loadEvidence(projectRoot: string): Promise<PhaseEvidenceRecord[]> {
  return readActivationEvidence(projectRoot);
}

export function repositoryFromState(state: UserActivationState): ReturnType<typeof canonicalCredentialRepository> {
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

export async function inspectCredentialPolicy(projectRoot: string, state: UserActivationState): Promise<CredentialInspection> {
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

export function phaseMap(graph: ManagedPhaseGraph): Record<PhaseId, PhaseGraphNode> {
  return Object.fromEntries(graph.phases.map((phase) => [phase.id, phase])) as Record<PhaseId, PhaseGraphNode>;
}

export function freshnessEntry(
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

export function buildEvidenceFreshness(
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
  const loadedState = await loadActivationState(projectRoot, options.storage);
  const migration = await inspectActivationMigrationHistory(projectRoot, options.storage);
  const state = { ...(loadedState?.state ?? notStartedState(manifest)),
    ...(options.activationInputs ? { activationInputs: options.activationInputs } : {}) };
  const scope = options.scope ?? 'activation';
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
  const reviews = await readPhaseReviews(projectRoot, state, reviewedPlans, options.storage);
  let configurationBinding = options.configurationBinding ?? state.configurationBinding;
  if (!options.activationInputs && !state.activationInputs) {
    const approvedConfigurationPlan = reviewedPlans.filter((plan) => plan.configuration &&
      approvals.some((approval) => approval.id === plan.approval.envelopeId &&
        canonicalApprovalEnvelopeHash(approval) === plan.approval.envelopeHash))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
    if (approvedConfigurationPlan) {
      state.activationInputs = approvedConfigurationPlan.configuration;
      configurationBinding = approvedConfigurationPlan.configurationBinding;
    }
  }
  if (configurationBinding) {
    const bound = await assertGovernanceConfigurationBinding(configurationBinding);
    if (canonicalSha256(bound) !== canonicalSha256(state.activationInputs ?? null)) {
      throw new Error('The selected normalized configuration differs from its exact bound public input file. Request a fresh reviewed plan.');
    }
    state.configurationBinding = configurationBinding;
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
    contexts,
    storage: options.storage
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
  const credential: CredentialInspection = scope === 'activation' ? await inspectCredentialPolicy(projectRoot, state) : {
    applicable: false, readOnly: true, path: credentialPolicyPathParts.join('/'),
    status: 'not-applicable', ready: false, guidance: null, policy: null, issues: []
  };
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
  const phaseBlockers: Partial<Record<PhaseId, readonly string[]>> = {
    ...Object.fromEntries(Object.entries(phaseCapabilities).filter(([, capability]) => capability.blocker)
      .map(([id, capability]) => [id, [capability.blocker!]])),
    ...(archivedSeedIntegrity.status === 'invalid' ? { 'seed-archived': archivedSeedIntegrity.issues } : {}),
    ...(seedDiscovery.state === 'blocked' ? { 'seed-valid': seedDiscovery.issues } : {}),
    ...(localInputBlockers.length ? { 'seed-verified': localInputBlockers } : {}),
    ...historicalProtection
  };
  for (const review of reviews) {
    const source = reviewedPlans.find((plan) => plan.planDigest === review.sourcePlanDigest);
    if (source?.inputDigest === contexts[review.phaseId].inputDigest && source.baselineDigest === contexts[review.phaseId].baselineSha) {
      phaseBlockers[review.phaseId] = [...phaseBlockers[review.phaseId] ?? [],
        'This bounded stage is already settled. Review its retained result and provide the separately approved next-stage inputs; do not repeat it.'];
    }
  }
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
    phaseBlockers,
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
    reviews,
    contexts,
    evidenceFreshness,
    readiness,
    sourceOfTruth,
    credential,
    archivedSeedIntegrity,
    retryArchivedSeedBaseline,
    expectedActiveSeed,
    migration: migration.status === 'committed' ? migration.journal : null
    , scope,
    ...(state.activationInputs ? { activationInputs: state.activationInputs } : {}),
    ...(configurationBinding ? { configurationBinding } : {}),
    ...(options.recoverPhase ? { recoverPhase: options.recoverPhase } : {})
    , sensitivePathExclusions,
    historicalLifecycleObligations
  };
}

export async function assertPolicyIdentity(projectRoot: string, manifest: LiftoffManifest): Promise<void> {
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

export function transitionInspection(inspection: GovernanceInspection): GovernanceTransitionInspection {
  return {
    projectRoot: inspection.projectRoot,
    manifest: inspection.manifest,
    graph: inspection.graph.graph,
    graphHash: inspection.graph.hash,
    scope: inspection.scope,
    ...(inspection.activationInputs ? { activationInputs: inspection.activationInputs } : {}),
    ...(inspection.configurationBinding ? { configurationBinding: inspection.configurationBinding } : {}),
    ...(inspection.recoverPhase ? { recoverPhase: inspection.recoverPhase } : {}),
    sensitivePathExclusions: inspection.sensitivePathExclusions,
    historicalLifecycleObligations: inspection.historicalLifecycleObligations,
    ...(inspection.loadedState ? { loadedState: inspection.loadedState } : {}),
    state: inspection.state,
    approvals: inspection.approvals,
    evidence: inspection.evidence,
    reviews: inspection.reviews,
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
