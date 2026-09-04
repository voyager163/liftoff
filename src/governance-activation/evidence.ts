import {
  canonicalPhaseContractDigests,
  canonicalPhaseGraph,
  canonicalPhaseGraphHash,
  currentActivationIdentity
} from './graph.js';
import { canonicalSha256 } from './canonical-json.js';
import type {
  ActivationIdentity,
  EvidenceHeader,
  EvidenceTransitionIdentity,
  LiveReadbackProof,
  LiveReadbackProvider,
  ManagedPhaseGraph,
  PhaseEvidenceRecord,
  PhaseGraphNode,
  PhaseId
} from './types.js';
import { phaseIds } from './types.js';
import { validateEvidenceHeader, validateLiveReadbackProof } from './validators.js';

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
  now?: Date;
  liveReadbackProviders?: readonly LiveReadbackProvider[];
}

export interface ValidatedPhaseEvidenceRecord {
  evidenceId: string;
  header: EvidenceHeader;
  headerDigest: string;
  producedAtEpochMs: number;
  liveReadback: readonly LiveReadbackProof[];
}

export interface EvidenceSelectionResult {
  selected: ValidatedPhaseEvidenceRecord | null;
  issues: readonly EvidenceValidationIssue[];
  ignoredOlderContradictions: readonly string[];
}

export function evidenceHeaderDigest(header: EvidenceHeader): string {
  return canonicalSha256(header);
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
  try {
    header = validateEvidenceHeader(record.header);
  } catch (error) {
    return {
      valid: false,
      issues: [issue('schema', error instanceof Error ? error.message : String(error), undefined, undefined, record.evidenceId)]
    };
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
  } else if (context.now && producedAtEpochMs > context.now.getTime()) {
    issues.push(issue('producedAt', 'Evidence timestamp is in the future.', context.now.toISOString(), header.producedAt, record.evidenceId));
  }

  const requiredProviders = context.liveReadbackProviders ?? [];
  const liveReadback = record.liveReadback ?? [];
  const validatedProofs: LiveReadbackProof[] = [];
  for (const proof of liveReadback) {
    try {
      validatedProofs.push(validateLiveReadbackProof(proof));
    } catch (error) {
      issues.push(issue('liveReadback', error instanceof Error ? error.message : String(error), undefined, undefined, record.evidenceId));
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
      liveReadback: validatedProofs
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
  if (latestResults.size > 1) {
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
  return { selected, issues, ignoredOlderContradictions };
}

export function evidenceContextForPhase(
  phaseId: PhaseId,
  overrides: Partial<Omit<EvidenceFreshnessContext, 'phaseId' | 'phaseContractDigest' | 'transition'>> & {
    transitionDigest?: string;
  } = {}
): EvidenceFreshnessContext {
  const baselineSha = overrides.baselineSha ?? '0'.repeat(64);
  const inputDigest = overrides.inputDigest ?? '1'.repeat(64);
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
    repositoryId: overrides.repositoryId ?? 'R_123',
    identity: overrides.identity ?? currentActivationIdentity,
    phaseGraphHash: overrides.phaseGraphHash ?? canonicalPhaseGraphHash,
    phaseId,
    phaseContractDigest: canonicalPhaseContractDigests[phaseId],
    baselineSha,
    inputDigest,
    transition,
    now: overrides.now,
    liveReadbackProviders: overrides.liveReadbackProviders
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
