import {
  canonicalPhaseContractDigests,
  canonicalPhaseGraph,
  canonicalPhaseGraphHash,
  currentActivationIdentity
} from './graph.js';
import { canonicalSha256, isRecord } from './canonical-json.js';
import type {
  ActivationIdentity,
  EvidenceHeader,
  EvidenceTransitionIdentity,
  LiveReadbackProof,
  LiveReadbackProvider,
  ManagedPhaseGraph,
  PhaseEvidenceRecord,
  PhaseGraphNode,
  PhaseId,
  EvidenceReference,
  SavedTransitionPlan
} from './types.js';
import { phaseIds } from './types.js';
import { validateEvidenceHeader, validateLiveReadbackProof, validateSavedTransitionPlan } from './validators.js';
import { assertPlanOperationsAllowed, planDigestFor } from './operations.js';

export interface PhaseEvidenceSource {
  evidence: readonly PhaseEvidenceRecord[];
  contexts: Record<PhaseId, EvidenceFreshnessContext>;
}

export function rulesetSourceDigestFromEvidence(inspection: PhaseEvidenceSource): string | null {
  const record = latestRecordWithPayload(inspection, 'workflow-source-ready');
  if (!record || !isRecord(record.payload) || record.payload.kind !== 'workflow-source-ready.v1') return null;
  const digest = record.payload.rulesetSourceDigest;
  return typeof digest === 'string' && /^[a-f0-9]{64}$/u.test(digest) ? digest : null;
}

export function latestRecordWithPayload(inspection: PhaseEvidenceSource, phaseId: PhaseId): PhaseEvidenceRecord | null {
  const records = inspection.evidence.filter((record) => record.header.phaseId === phaseId);
  const selection = selectLatestPhaseEvidence(records, inspection.contexts[phaseId]);
  if (!selection.selected) return null;
  return {
    evidenceId: selection.selected.evidenceId,
    header: selection.selected.header,
    liveReadback: selection.selected.liveReadback,
    payload: selection.selected.payload
  };
}

const identityFields = [
  'liftoffVersion',
  'manifestArtifactVersion',
  'policyVersion',
  'activationContractVersion',
  'phaseGraphSchemaVersion',
  'phaseGraphHash',
  'activationStateSchemaVersion',
  'evidenceHeaderSchemaVersion',
  'approvalEnvelopeSchemaVersion',
  'supersessionSchemaVersion',
  'credentialPolicySchemaVersion'
] as const;

export interface EvidenceValidationIssue {
  evidenceId?: string;
  field: string;
  expected?: string | number | boolean;
  actual?: string | number | boolean;
  message: string;
}

export interface EvidenceFreshnessContext {
  repositoryId: string;
  identity: ActivationIdentity;
  phaseGraphHash: string;
  phaseId: PhaseId;
  phaseContractDigest: string;
  baselineSha: string;
  inputDigest: string;
  transition: EvidenceTransitionIdentity;
  remoteBindingDigest?: string;
  evidenceReferences?: readonly EvidenceReference[];
  reviewedPlans?: readonly SavedTransitionPlan[];
  workflowSpecDigest?: string;
  publicationDestination?: string;
  now?: Date;
  liveReadbackProviders?: readonly LiveReadbackProvider[];
}

export interface ValidatedPhaseEvidenceRecord {
  evidenceId: string;
  header: EvidenceHeader;
  headerDigest: string;
  producedAtEpochMs: number;
  liveReadback: readonly LiveReadbackProof[];
  payload?: unknown;
}

export interface EvidenceSelectionResult {
  selected: ValidatedPhaseEvidenceRecord | null;
  issues: readonly EvidenceValidationIssue[];
  ignoredOlderContradictions: readonly string[];
  historicalIssues?: readonly EvidenceValidationIssue[];
}

export function evidenceHeaderDigest(header: EvidenceHeader): string {
  return canonicalSha256(header);
}

export function evidenceBodyDigest(payload: unknown, liveReadback: readonly LiveReadbackProof[] = []): string {
  const normalized = [...liveReadback].map((proof) => validateLiveReadbackProof(proof))
    .sort((a, b) => canonicalSha256(a).localeCompare(canonicalSha256(b), 'en'));
  return canonicalSha256({ payload: payload ?? null, liveReadback: normalized });
}

function validatePhasePayload(record: PhaseEvidenceRecord): string[] {
  if (record.header.result === 'failed' || record.header.result === 'inapplicable') return [];
  const payload = record.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return [`${record.header.phaseId} requires a phase-specific evidence payload.`];
  }
  const value = payload as Record<string, unknown>;
  const expected = record.header.phaseId === 'phase-0-complete' ? 'phase-0-discovery.v1' : `${record.header.phaseId}.v1`;
  const issues = value.kind === expected ? [] : [`${record.header.phaseId} payload kind must be ${expected}.`];
  if (record.header.phaseId === 'seed-verified') {
    if (!Array.isArray(value.checks) || value.checks.length === 0 || value.checks.some((check) =>
      typeof check !== 'object' || check === null || !['passed', 'inapplicable'].includes(String(check.status)))) {
      issues.push('Local baseline evidence requires successful applicable check outcomes.');
    }
  }
  if (record.header.phaseId === 'phase-0-complete') {
    if (!Array.isArray(value.facts) || !['repository.id', 'repository.nameWithOwner', 'repository.defaultBranch']
      .every((id) => (value.facts as Array<{ id?: unknown; value?: unknown }>).some((fact) => fact.id === id && typeof fact.value === 'string' && fact.value))) {
      issues.push('Phase 0 requires independently observed repository identity facts.');
    }
  }
  if (['committed', 'pushed'].includes(record.header.phaseId) &&
    (typeof value.head !== 'string' || !/^[a-f0-9]{40,64}$/.test(value.head))) {
    issues.push('Publication evidence must record the actual Git HEAD separately from the SHA-256 baseline.');
  }
  if (record.header.phaseId === 'runner-ready') {
    if (typeof value.organization !== 'string' || !Number.isInteger(value.runnerId) || Number(value.runnerId) <= 0 ||
      !(value.groupId === null || Number.isInteger(value.groupId)) ||
      !(value.networkConfigurationId === null || typeof value.networkConfigurationId === 'string')) {
      issues.push('Runner proof requires an explicit organization, runner ID, group, and network-configuration binding.');
    }
    if (!(record.liveReadback ?? []).some((proof) => proof.provider === 'github' &&
      (proof.resourceId === String(value.runnerId) || proof.resourceId.endsWith(`/hosted-runners/${value.runnerId}`)))) {
      issues.push('Runner payload ID has no matching independent runner resource readback.');
    }
  }
  if (record.header.phaseId === 'state-path-selected' && !['existing-private', 'bootstrap-local'].includes(String(value.statePath))) {
    issues.push('State-path selection requires an explicit applicable backend path.');
  }
  if (record.header.phaseId === 'workflow-source-ready' && (typeof value.rulesetSourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.rulesetSourceDigest))) {
    issues.push('Workflow-source evidence must bind the reviewed ruleset source digest.');
  }
  if (record.header.phaseId === 'credential-ready' && (typeof value.policyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.policyDigest))) {
    issues.push('Credential evidence must bind the public credential policy and independent readback.');
  }
  const scope = typeof value.assessmentScope === 'object' && value.assessmentScope !== null
    ? value.assessmentScope as Record<string, unknown> : undefined;
  if (scope?.azure !== undefined) {
    if (!Array.isArray(scope.azure)) issues.push('Azure evidence scope must be an explicit resource inventory.');
    else for (const resource of scope.azure) {
      if (typeof resource !== 'object' || resource === null ||
        typeof resource.resourceId !== 'string' || typeof resource.resourceType !== 'string' ||
        !['dev', 'staging', 'prod'].includes(resource.environment) || typeof resource.role !== 'string' ||
        !(record.liveReadback ?? []).some((proof) => proof.provider === 'azure' && proof.resourceId === resource.resourceId && proof.resourceType === resource.resourceType)) {
        issues.push('Azure payload scope requires an explicit environment/role and matching resource readback.');
      }
    }
  }
  return issues;
}

function issue(
  field: string,
  message: string,
  expected?: string | number | boolean,
  actual?: string | number | boolean,
  evidenceId?: string
): EvidenceValidationIssue {
  return { field, message, expected, actual, evidenceId };
}

function compareIdentity(
  actual: ActivationIdentity,
  expected: ActivationIdentity,
  evidenceId?: string
): EvidenceValidationIssue[] {
  const issues: EvidenceValidationIssue[] = [];
  for (const field of identityFields) {
    if (actual[field] !== expected[field]) {
      issues.push(issue(
        `identity.${field}`,
        `Evidence activation identity field ${field} is stale or mismatched.`,
        expected[field],
        actual[field],
        evidenceId
      ));
    }
  }
  return issues;
}

function compareTransition(
  actual: EvidenceTransitionIdentity,
  expected: EvidenceTransitionIdentity,
  path: string,
  evidenceId?: string
): EvidenceValidationIssue[] {
  const issues: EvidenceValidationIssue[] = [];
  if (actual.phaseId !== expected.phaseId) {
    issues.push(issue(`${path}.phaseId`, 'Evidence transition phase does not match the current transition.', expected.phaseId, actual.phaseId, evidenceId));
  }
  if (actual.baselineSha !== expected.baselineSha) {
    issues.push(issue(`${path}.baselineSha`, 'Evidence transition baseline SHA does not match the current transition.', expected.baselineSha, actual.baselineSha, evidenceId));
  }
  if (actual.inputDigest !== expected.inputDigest) {
    issues.push(issue(`${path}.inputDigest`, 'Evidence transition input digest does not match the current transition.', expected.inputDigest, actual.inputDigest, evidenceId));
  }
  if (actual.transitionDigest !== expected.transitionDigest) {
    issues.push(issue(`${path}.transitionDigest`, 'Evidence transition digest does not match the current transition.', expected.transitionDigest, actual.transitionDigest, evidenceId));
  }
  return issues;
}

export function validateEvidenceFreshness(
  record: PhaseEvidenceRecord,
  context: EvidenceFreshnessContext
): { valid: true; record: ValidatedPhaseEvidenceRecord } | { valid: false; issues: readonly EvidenceValidationIssue[] } {
  const issues: EvidenceValidationIssue[] = [];
  let header: EvidenceHeader;
  const inspectedAt = context.now ?? new Date();
  try {
    header = validateEvidenceHeader(record.header);
  } catch (error) {
    return {
      valid: false,
      issues: [issue('schema', error instanceof Error ? error.message : String(error), undefined, undefined, record.evidenceId)]
    };
  }

  try {
    if (header.bodyDigest !== evidenceBodyDigest(record.payload, record.liveReadback)) {
      issues.push(issue('bodyDigest', 'Evidence payload or normalized readback body commitment does not match.', undefined, undefined, record.evidenceId));
    }
  } catch (error) {
    issues.push(issue('bodyDigest', error instanceof Error ? error.message : String(error), undefined, undefined, record.evidenceId));
  }
  issues.push(...validatePhasePayload(record).map((message) => issue('payload', message, undefined, undefined, record.evidenceId)));
  if (header.phaseId === 'seed-archived' && typeof record.payload === 'object' && record.payload !== null) {
    const payload = record.payload as Record<string, unknown>;
    if ((context.workflowSpecDigest !== undefined || payload.synchronizedSpecDigest !== undefined) &&
      payload.synchronizedSpecDigest !== context.workflowSpecDigest) {
      issues.push(issue('payload.synchronizedSpecDigest', 'The archived seed receipt does not bind the current synchronized main capability.', undefined, undefined, record.evidenceId));
    }
  }
  if (header.remoteBindingDigest !== undefined && header.remoteBindingDigest !== context.remoteBindingDigest) {
    issues.push(issue('remoteBindingDigest', 'Evidence verified remote binding does not match the current binding.', context.remoteBindingDigest, header.remoteBindingDigest, record.evidenceId));
  }
  if (context.evidenceReferences && !['seed-valid', 'seed-verified', 'seed-archived', 'committed', 'pushed'].includes(header.phaseId) &&
    (!context.remoteBindingDigest || header.remoteBindingDigest !== context.remoteBindingDigest)) {
    issues.push(issue('remoteBindingDigest', 'Remote evidence requires a matching verified binding separate from the immutable local anchor.', undefined, undefined, record.evidenceId));
  }
  if (context.evidenceReferences && !context.evidenceReferences.some((reference) =>
    reference.evidenceId === record.evidenceId && reference.headerDigest === evidenceHeaderDigest(header) &&
    reference.phaseId === header.phaseId && reference.result === header.result)) {
    issues.push(issue('reference', 'Evidence body/header is not bound by an authoritative state reference.', undefined, undefined, record.evidenceId));
  }
  if (context.reviewedPlans) {
    const payload = typeof record.payload === 'object' && record.payload !== null ? record.payload as Record<string, unknown> : {};
    const saved = context.reviewedPlans.find((plan) => plan.planDigest === payload.planDigest &&
      canonicalSha256(plan) === payload.savedPlanDigest);
    if (!saved) {
      issues.push(issue('plan', 'Evidence does not reference an independently loaded reviewed transition plan.', undefined, undefined, record.evidenceId));
    } else {
      let plan: SavedTransitionPlan;
      try {
        plan = validateSavedTransitionPlan(saved);
        const phase = phaseNode(canonicalPhaseGraph, header.phaseId);
        assertPlanOperationsAllowed(plan, phase);
        const approvalPlanDigest = canonicalSha256({
          phaseId: phase.id, gateKind: phase.approvalGate.kind, transitionDigest: plan.transitionDigest,
          allowedMutations: phase.allowedMutations
        });
        if (plan.planDigest !== planDigestFor({ phase, transitionDigest: plan.transitionDigest, approvalPlanDigest, operations: plan.operations })) {
          throw new Error('Reviewed transition plan digest does not commit its actual operations.');
        }
      } catch (error) {
        return { valid: false, issues: [issue('plan', error instanceof Error ? error.message : String(error), undefined, undefined, record.evidenceId)] };
      }
      if (plan.phaseId !== header.phaseId || plan.baselineDigest !== context.baselineSha ||
        plan.inputDigest !== context.inputDigest || plan.transitionDigest !== header.transition.transitionDigest ||
        Date.parse(header.producedAt) < Date.parse(plan.createdAt) || Date.parse(header.producedAt) >= Date.parse(plan.expiresAt)) {
        issues.push(issue('plan', 'Evidence phase, current inputs, or timing differ from the reviewed transition plan.', undefined, undefined, record.evidenceId));
      }
      if (header.phaseId === 'seed-verified') {
        const expected = plan.operations.find((operation) => operation.actionId === 'openspec.seed.baseline-verify')?.inputs.checks;
        const actual = payload.checks;
        if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length ||
          expected.some((check) => !actual.some((outcome) => outcome.id === check.id &&
            outcome.taskId === check.taskId && outcome.status === (check.applicable ? 'passed' : 'inapplicable')))) {
          issues.push(issue('payload.checks', 'Baseline outcome must cover every planned applicable check exactly once.', undefined, undefined, record.evidenceId));
        }
      }
      for (const proof of record.liveReadback ?? []) {
        if (Date.parse(proof.observedAt) < Date.parse(plan.createdAt)) {
          issues.push(issue('liveReadback.observedAt', 'Independent readback predates the reviewed transition plan.', undefined, undefined, record.evidenceId));
        }
        const operations = plan.operations.filter((operation) => operation.remote &&
          (proof.provider === 'github' ? operation.adapter === 'github' || operation.adapter === 'git' : operation.adapter === 'azure-opentofu'));
        if (!operations.some((operation) => {
          const destination = operation.destination;
          const scopeMatches = destination.identity === proof.resourceId ||
            destination.repository === proof.resourceId ||
            (destination.repository && (proof.resourceId.startsWith(`/repos/${destination.repository}/`) ||
              proof.resourceId.startsWith(`https://api.github.com/repos/${destination.repository}/`))) ||
            (destination.subscriptionId && proof.resourceId.toLowerCase().startsWith(`/subscriptions/${destination.subscriptionId.toLowerCase()}/`));
          return scopeMatches && (operation.inputs.sourceDigest === undefined || operation.inputs.sourceDigest === proof.sourceDigest);
        })) {
          issues.push(issue('liveReadback.destination', 'Readback resource or source is outside the reviewed plan destinations.', undefined, undefined, record.evidenceId));
        }
      }
    }
  }
  if (header.repositoryId !== context.repositoryId) {
    issues.push(issue('repositoryId', 'Evidence repository ID does not match the active repository.', context.repositoryId, header.repositoryId, record.evidenceId));
  }
  issues.push(...compareIdentity(header.identity, context.identity, record.evidenceId));
  if (header.phaseGraphHash !== context.phaseGraphHash) {
    issues.push(issue('phaseGraphHash', 'Evidence phase graph hash is stale or mismatched.', context.phaseGraphHash, header.phaseGraphHash, record.evidenceId));
  }
  if (header.phaseId !== context.phaseId) {
    issues.push(issue('phaseId', 'Evidence phase ID does not match the requested phase.', context.phaseId, header.phaseId, record.evidenceId));
  }
  if (header.phaseContractDigest !== context.phaseContractDigest) {
    issues.push(issue(
      'phaseContractDigest',
      'Evidence phase contract digest is stale or mismatched.',
      context.phaseContractDigest,
      header.phaseContractDigest,
      record.evidenceId
    ));
  }
  if (header.baselineSha !== context.baselineSha) {
    issues.push(issue('baselineSha', 'Evidence baseline SHA is stale or mismatched.', context.baselineSha, header.baselineSha, record.evidenceId));
  }
  if (header.inputDigest !== context.inputDigest) {
    issues.push(issue('inputDigest', 'Evidence phase input digest is stale or mismatched.', context.inputDigest, header.inputDigest, record.evidenceId));
  }
  issues.push(...compareTransition(header.transition, context.transition, 'transition', record.evidenceId));

  const producedAtEpochMs = Date.parse(header.producedAt);
  if (Number.isNaN(producedAtEpochMs)) {
    issues.push(issue('producedAt', 'Evidence timestamp is not a valid ISO timestamp.', undefined, header.producedAt, record.evidenceId));
  } else if (producedAtEpochMs > inspectedAt.getTime()) {
    issues.push(issue('producedAt', 'Evidence timestamp is in the future.', inspectedAt.toISOString(), header.producedAt, record.evidenceId));
  }

  const requiredProviders = ['failed', 'inapplicable'].includes(header.result) ? [] : [...new Set([
    ...phaseNode(canonicalPhaseGraph, context.phaseId).evidence.liveReadbackProviders,
    ...(context.liveReadbackProviders ?? [])
  ])];
  const liveReadback = record.liveReadback ?? [];
  const validatedProofs: LiveReadbackProof[] = [];
  for (const proof of liveReadback) {
    try {
      validatedProofs.push(validateLiveReadbackProof(proof));
    } catch (error) {
      issues.push(issue('liveReadback', error instanceof Error ? error.message : String(error), undefined, undefined, record.evidenceId));
    }
    for (const proof of validatedProofs) {
      if (Date.parse(proof.observedAt) > producedAtEpochMs ||
        Date.parse(proof.observedAt) > inspectedAt.getTime() ||
        producedAtEpochMs - Date.parse(proof.observedAt) > 15 * 60 * 1000) {
        issues.push(issue('liveReadback.observedAt', 'Independent readback must occur within the transition interval and not after the receipt.', undefined, undefined, record.evidenceId));
      }
      if (!proof.matches || proof.sourceDigest !== proof.readbackDigest) {
        issues.push(issue('liveReadback.matches', 'Readback must independently match its normalized reviewed source digest.', undefined, undefined, record.evidenceId));
      }
      if (proof.repositoryId !== header.repositoryId || proof.phaseId !== header.phaseId ||
        proof.baselineSha !== header.baselineSha || proof.inputDigest !== header.inputDigest ||
        proof.phaseGraphHash !== header.phaseGraphHash) {
        issues.push(issue('liveReadback.binding', 'Every readback must bind this repository, phase, and current inputs.', undefined, undefined, record.evidenceId));
      }
      issues.push(...compareIdentity(proof.identity, header.identity, record.evidenceId));
      issues.push(...compareTransition(proof.transition, header.transition, 'liveReadback.transition', record.evidenceId));
    }
  }
  for (const provider of requiredProviders) {
    const matchingProof = validatedProofs.find((proof) => proof.provider === provider);
    if (!matchingProof) {
      issues.push(issue('liveReadback', `Evidence for ${context.phaseId} requires ${provider} live readback proof.`, provider, undefined, record.evidenceId));
      continue;
    }
    if (matchingProof.repositoryId !== header.repositoryId) {
      issues.push(issue('liveReadback.repositoryId', 'Live readback repository ID must match evidence.', header.repositoryId, matchingProof.repositoryId, record.evidenceId));
    }
    issues.push(...compareIdentity(matchingProof.identity, header.identity, record.evidenceId).map((entry) => ({
      ...entry,
      field: `liveReadback.${entry.field}`
    })));
    if (matchingProof.phaseGraphHash !== header.phaseGraphHash) {
      issues.push(issue('liveReadback.phaseGraphHash', 'Live readback graph hash must match evidence.', header.phaseGraphHash, matchingProof.phaseGraphHash, record.evidenceId));
    }
    if (matchingProof.phaseId !== header.phaseId) {
      issues.push(issue('liveReadback.phaseId', 'Live readback phase must match evidence.', header.phaseId, matchingProof.phaseId, record.evidenceId));
    }
    if (matchingProof.baselineSha !== header.baselineSha) {
      issues.push(issue('liveReadback.baselineSha', 'Live readback baseline must match evidence.', header.baselineSha, matchingProof.baselineSha, record.evidenceId));
    }
    if (matchingProof.inputDigest !== header.inputDigest) {
      issues.push(issue('liveReadback.inputDigest', 'Live readback input digest must match evidence.', header.inputDigest, matchingProof.inputDigest, record.evidenceId));
    }
    issues.push(...compareTransition(matchingProof.transition, header.transition, 'liveReadback.transition', record.evidenceId));
    if (!matchingProof.matches) {
      issues.push(issue('liveReadback.matches', 'Live readback must match the reviewed source or plan.', true, false, record.evidenceId));
    }
  }

  if (issues.length > 0 || Number.isNaN(producedAtEpochMs)) {
    return { valid: false, issues };
  }
  return {
    valid: true,
    record: {
      evidenceId: record.evidenceId,
      header,
      headerDigest: evidenceHeaderDigest(header),
      producedAtEpochMs,
      liveReadback: validatedProofs,
      payload: record.payload
    }
  };
}

function sortEvidence(left: ValidatedPhaseEvidenceRecord, right: ValidatedPhaseEvidenceRecord): number {
  if (left.producedAtEpochMs !== right.producedAtEpochMs) {
    return right.producedAtEpochMs - left.producedAtEpochMs;
  }
  const evidenceId = right.evidenceId.localeCompare(left.evidenceId);
  if (evidenceId !== 0) {
    return evidenceId;
  }
  return right.headerDigest.localeCompare(left.headerDigest);
}

export function selectLatestPhaseEvidence(
  records: readonly PhaseEvidenceRecord[],
  context: EvidenceFreshnessContext
): EvidenceSelectionResult {
  const issues: EvidenceValidationIssue[] = [];
  const validRecords: ValidatedPhaseEvidenceRecord[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const validation = validateEvidenceFreshness(record, context);
    if (!validation.valid) {
      issues.push(...validation.issues);
      continue;
    }
    const duplicateKey = `${validation.record.evidenceId}\0${validation.record.headerDigest}`;
    if (seen.has(duplicateKey)) {
      continue;
    }
    seen.add(duplicateKey);
    validRecords.push(validation.record);
  }
  if (validRecords.length === 0) {
    return { selected: null, issues, ignoredOlderContradictions: [] };
  }
  validRecords.sort(sortEvidence);
  const latestTimestamp = validRecords[0]!.producedAtEpochMs;
  const latestTies = validRecords.filter((record) => record.producedAtEpochMs === latestTimestamp);
  const latestResults = new Set(latestTies.map((record) => record.header.result));
  if (latestResults.size > 1 || new Set(latestTies.map((record) => record.header.bodyDigest)).size > 1) {
    return {
      selected: null,
      issues: [
        ...issues,
        issue(
          'producedAt',
          `Latest evidence for ${context.phaseId} has a contradictory deterministic tie at ${latestTies[0]!.header.producedAt}.`,
          undefined,
          Array.from(latestResults).sort().join(',')
        )
      ],
      ignoredOlderContradictions: []
    };
  }
  const selected = validRecords[0]!;
  const ignoredOlderContradictions = validRecords
    .filter((record) =>
      record.producedAtEpochMs < selected.producedAtEpochMs &&
      record.header.result !== selected.header.result
    )
    .map((record) => record.evidenceId);
  return { selected, issues: [], historicalIssues: issues, ignoredOlderContradictions };
}

export function evidenceContextForPhase(
  phaseId: PhaseId,
  overrides: Partial<Omit<EvidenceFreshnessContext, 'phaseId' | 'phaseContractDigest' | 'transition'>> & {
    transitionDigest?: string;
  } = {}
): EvidenceFreshnessContext {
  if (!overrides.baselineSha || !overrides.inputDigest || !overrides.repositoryId) {
    throw new Error('Current explicit repository, baseline SHA-256, and phase input SHA-256 bindings are required; placeholder contexts are not executable.');
  }
  const baselineSha = overrides.baselineSha;
  const inputDigest = overrides.inputDigest;
  const transition: EvidenceTransitionIdentity = {
    phaseId,
    baselineSha,
    inputDigest,
    transitionDigest: overrides.transitionDigest ?? canonicalSha256({
      baselineSha,
      inputDigest,
      phaseId
    })
  };
  return {
    repositoryId: overrides.repositoryId,
    identity: overrides.identity ?? currentActivationIdentity,
    phaseGraphHash: overrides.phaseGraphHash ?? canonicalPhaseGraphHash,
    phaseId,
    phaseContractDigest: canonicalPhaseContractDigests[phaseId],
    baselineSha,
    inputDigest,
    transition,
    now: overrides.now,
    liveReadbackProviders: overrides.liveReadbackProviders,
    remoteBindingDigest: overrides.remoteBindingDigest
  };
}

export function requiredLiveReadbackProviders(node: PhaseGraphNode): readonly LiveReadbackProvider[] {
  return node.evidence.liveReadbackProviders;
}

export function phaseRequiresLiveReadback(node: PhaseGraphNode): boolean {
  return requiredLiveReadbackProviders(node).length > 0;
}

export function phaseNode(graph: ManagedPhaseGraph, phaseId: PhaseId): PhaseGraphNode {
  const node = graph.phases.find((candidate) => candidate.id === phaseId);
  if (!node) {
    throw new Error(`Unknown phase ${phaseId}.`);
  }
  return node;
}

export function canonicalEvidenceContextForPhase(phaseId: PhaseId): EvidenceFreshnessContext {
  const node = phaseNode(canonicalPhaseGraph, phaseId);
  return evidenceContextForPhase(phaseId, {
    liveReadbackProviders: requiredLiveReadbackProviders(node)
  });
}

export function emptyEvidenceRecordsByPhase(): Record<PhaseId, readonly PhaseEvidenceRecord[]> {
  const records = {} as Record<PhaseId, readonly PhaseEvidenceRecord[]>;
  for (const phaseId of phaseIds) {
    records[phaseId] = [];
  }
  return records;
}
