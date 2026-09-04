import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  applyProjectFileTransaction,
  readProjectFile,
  resolveProjectPath,
  validateArtifactPathParts
} from '../file-system.js';
import { generatedSeedChangeName } from './seed-lifecycle.js';
import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import {
  activationContractVersion,
  activationStateSchemaVersion,
  approvalEnvelopeSchemaVersion,
  credentialPolicySchemaVersion,
  evidenceHeaderSchemaVersion,
  governanceActivationPolicyVersion,
  liftoffActivationPackageVersion,
  liftoffManifestArtifactVersion,
  phaseGraphSchemaVersion,
  supersessionSchemaVersion
} from './identity.js';
import { calculateGraphReconciliation } from './reconciliation.js';
import {
  canonicalPhaseGraph,
  canonicalPhaseGraphHash,
  currentActivationIdentity,
  phaseContractDigests
} from './graph.js';
import {
  evidenceContextForPhase,
  validateEvidenceFreshness,
  type ValidatedPhaseEvidenceRecord
} from './evidence.js';
import type {
  ActivationIdentity,
  GraphReconciliationRecord,
  ManagedPhaseGraph,
  PhaseEvidenceRecord,
  PhaseId,
  SupersessionRecord,
  UserActivationState
} from './types.js';
import { phaseIds } from './types.js';
import { validateSupersessionRecord } from './validators.js';
import type { LiftoffManifest, SpecWorkflowId } from '../types.js';
import { toSafeProjectName } from '../planner.js';

export const governanceChangeMetadataFileName = 'liftoff-governance.json' as const;
export const governanceSupersessionPathParts = ['governance', 'supersessions'] as const;
export const governanceReconciliationPathParts = ['governance', 'reconciliation'] as const;
export const governanceSourceOfTruthMarker = 'liftoff-governance-source-of-truth' as const;
export const governanceChangeMetadataSchemaVersion = 1 as const;

const hex64Pattern = /^[a-f0-9]{64}$/u;
const isoLikePattern = /^\d{4}-\d{2}-\d{2}T/u;
const workflowKinds = new Set<SpecWorkflowId>(['openspec', 'spec-kit']);

export interface GovernancePhaseTaskMapping {
  phaseId: PhaseId;
  taskId: string;
  marker: `<!-- liftoff-phase: ${PhaseId} -->`;
  policy: 'evidence-projection-v1';
}

export interface GovernanceChangeMetadata {
  schemaVersion: typeof governanceChangeMetadataSchemaVersion;
  marker: typeof governanceSourceOfTruthMarker;
  changeId: string;
  workflowKind: SpecWorkflowId;
  activationIdentity: ActivationIdentity;
  phaseGraphHash: string;
  baselineSha: string;
  phaseTaskMapping: readonly GovernancePhaseTaskMapping[];
  currentPolicy: {
    phaseAuthority: 'managed-phase-graph';
    taskCompletion: 'authoritative-evidence-projection';
    approvalPolicy: 'approval-envelope-required-for-gated-phases';
  };
  createdFrom: {
    kind: 'approved-phase-0-facts';
    approvedFactDigest: string;
    evidenceIds: readonly string[];
  };
  acknowledgedAt: string;
  owner: string;
}

export interface ApprovedPhase0Fact {
  id: string;
  value: string | number | boolean | null;
}

export interface ApprovedPhase0Facts {
  projectName: string;
  repositoryId: string;
  repositoryName: string;
  defaultBranch: string;
  workflowKind: SpecWorkflowId;
  baselineSha: string;
  evidenceIds: readonly string[];
  approvedFacts: readonly ApprovedPhase0Fact[];
  approvedAt: string;
  approver: string;
}

export interface GovernanceChangeFilePlan {
  pathParts: readonly string[];
  content: string;
}

export interface GovernanceChangeWritePlan {
  changeId: string;
  workflowKind: SpecWorkflowId;
  metadata: GovernanceChangeMetadata;
  files: readonly GovernanceChangeFilePlan[];
  transactionalWrite: {
    functionName: 'writeGovernanceChangeArtifacts';
    writesAllFilesOrThrows: true;
  };
}

export type ActiveGovernanceCandidateStatus =
  | 'compatible'
  | 'identity-mismatch'
  | 'invalid-metadata'
  | 'missing-metadata';

export interface ActiveGovernanceCandidate {
  changeId: string;
  workflowKind: SpecWorkflowId;
  pathParts: readonly string[];
  status: ActiveGovernanceCandidateStatus;
  metadata?: GovernanceChangeMetadata;
  issues: readonly string[];
}

export type GovernanceSourceOfTruthInspection =
  | {
      status: 'seed-blocked';
      seedChangeId: string;
      blockers: readonly string[];
      selected: null;
      candidates: readonly ActiveGovernanceCandidate[];
    }
  | {
      status: 'none';
      selected: null;
      candidates: readonly ActiveGovernanceCandidate[];
      createPlan: GovernanceCreateChangePlanPreview;
    }
  | {
      status: 'selected';
      selected: ActiveGovernanceCandidate;
      candidates: readonly ActiveGovernanceCandidate[];
      recordActiveChangeOnNextMutation: boolean;
      reconciliation: GovernanceActiveReconciliationResult;
      supersession: GovernanceSupersessionInspection;
    }
  | {
      status: 'ambiguous';
      selected: null;
      candidates: readonly ActiveGovernanceCandidate[];
      blockers: readonly string[];
      supersession: GovernanceSupersessionInspection;
    }
  | {
      status: 'incompatible';
      selected: null;
      candidates: readonly ActiveGovernanceCandidate[];
      blockers: readonly string[];
      reconciliation: GovernanceActiveReconciliationResult;
    };

export interface GovernanceCreateChangePlanPreview {
  status: 'ready' | 'blocked';
  reason: string;
  changeId: string;
  workflowKind: SpecWorkflowId;
  requiredFacts: readonly string[];
}

export interface GovernanceSupersessionInspection {
  records: readonly SupersessionRecord[];
  invalidRecords: readonly string[];
  selectedChangeId: string | null;
  issues: readonly string[];
}

export type GovernanceActiveReconciliationResult =
  | {
      status: 'not-required';
      approvalRequired: false;
      preservedPhaseIds: readonly PhaseId[];
      invalidPhaseIds: readonly PhaseId[];
      issues: readonly string[];
    }
  | {
      status: 'required';
      approvalRequired: true;
      fromIdentity: ActivationIdentity;
      toIdentity: ActivationIdentity;
      record: GraphReconciliationRecord;
      preservedPhaseIds: readonly PhaseId[];
      invalidPhaseIds: readonly PhaseId[];
      evidenceToReview: readonly string[];
      issues: readonly string[];
    }
  | {
      status: 'blocked';
      approvalRequired: false;
      issues: readonly string[];
      preservedPhaseIds: readonly PhaseId[];
      invalidPhaseIds: readonly PhaseId[];
    };

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const item = record(value, label);
  for (const key of keys) {
    if (!Object.hasOwn(item, key)) {
      throw new Error(`${label}.${key} is required.`);
    }
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(item)) {
    if (!allowed.has(key)) {
      throw new Error(`${label}.${key} is not allowed.`);
    }
  }
  return item;
}

function stringField(item: Record<string, unknown>, key: string, label: string): string {
  const value = item[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string.`);
  }
  return value;
}

function numberField(item: Record<string, unknown>, key: string, expected: number, label: string): number {
  const value = item[key];
  if (value !== expected) {
    throw new Error(`${label}.${key} must be ${expected}.`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`${label}[${index}] must be a non-empty string.`);
    }
    return entry;
  });
}

function strictActivationIdentity(value: unknown, label: string): ActivationIdentity {
  const identity = exact(value, [
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
  ], label);
  const phaseGraphHash = stringField(identity, 'phaseGraphHash', label);
  if (!hex64Pattern.test(phaseGraphHash)) {
    throw new Error(`${label}.phaseGraphHash must be a SHA-256 hex digest.`);
  }
  return {
    liftoffVersion: stringField(identity, 'liftoffVersion', label),
    manifestArtifactVersion: numberField(identity, 'manifestArtifactVersion', liftoffManifestArtifactVersion, label),
    policyVersion: stringField(identity, 'policyVersion', label),
    activationContractVersion: numberField(identity, 'activationContractVersion', activationContractVersion, label),
    phaseGraphSchemaVersion: numberField(identity, 'phaseGraphSchemaVersion', phaseGraphSchemaVersion, label),
    phaseGraphHash,
    activationStateSchemaVersion: numberField(identity, 'activationStateSchemaVersion', activationStateSchemaVersion, label),
    evidenceHeaderSchemaVersion: numberField(identity, 'evidenceHeaderSchemaVersion', evidenceHeaderSchemaVersion, label),
    approvalEnvelopeSchemaVersion: numberField(identity, 'approvalEnvelopeSchemaVersion', approvalEnvelopeSchemaVersion, label),
    supersessionSchemaVersion: numberField(identity, 'supersessionSchemaVersion', supersessionSchemaVersion, label),
    credentialPolicySchemaVersion: numberField(identity, 'credentialPolicySchemaVersion', credentialPolicySchemaVersion, label)
  };
}

function validateCurrentIdentity(identity: ActivationIdentity, label: string): string[] {
  const issues: string[] = [];
  const expected = currentActivationIdentity;
  for (const key of Object.keys(expected) as (keyof ActivationIdentity)[]) {
    if (identity[key] !== expected[key]) {
      issues.push(`${label}.${key} expected ${JSON.stringify(expected[key])}, found ${JSON.stringify(identity[key])}.`);
    }
  }
  return issues;
}

function strictPhaseTaskMapping(value: unknown, label: string): GovernancePhaseTaskMapping {
  const mapping = exact(value, ['phaseId', 'taskId', 'marker', 'policy'], label);
  const phaseId = stringField(mapping, 'phaseId', label);
  if (!phaseIds.includes(phaseId as PhaseId)) {
    throw new Error(`${label}.phaseId contains unsupported phase ${phaseId}.`);
  }
  const taskId = stringField(mapping, 'taskId', label);
  const marker = stringField(mapping, 'marker', label);
  if (marker !== `<!-- liftoff-phase: ${phaseId} -->`) {
    throw new Error(`${label}.marker must match its phaseId.`);
  }
  if (mapping.policy !== 'evidence-projection-v1') {
    throw new Error(`${label}.policy must be evidence-projection-v1.`);
  }
  return { phaseId: phaseId as PhaseId, taskId, marker: marker as GovernancePhaseTaskMapping['marker'], policy: 'evidence-projection-v1' };
}

export function validateGovernanceChangeMetadata(value: unknown): GovernanceChangeMetadata {
  const metadata = exact(value, [
    'schemaVersion',
    'marker',
    'changeId',
    'workflowKind',
    'activationIdentity',
    'phaseGraphHash',
    'baselineSha',
    'phaseTaskMapping',
    'currentPolicy',
    'createdFrom',
    'acknowledgedAt',
    'owner'
  ], 'governanceChange');
  numberField(metadata, 'schemaVersion', governanceChangeMetadataSchemaVersion, 'governanceChange');
  if (metadata.marker !== governanceSourceOfTruthMarker) {
    throw new Error(`governanceChange.marker must be ${governanceSourceOfTruthMarker}.`);
  }
  const changeId = stringField(metadata, 'changeId', 'governanceChange');
  const workflowKind = stringField(metadata, 'workflowKind', 'governanceChange');
  if (!workflowKinds.has(workflowKind as SpecWorkflowId)) {
    throw new Error(`governanceChange.workflowKind contains unsupported workflow ${workflowKind}.`);
  }
  const activationIdentity = strictActivationIdentity(metadata.activationIdentity, 'governanceChange.activationIdentity');
  const phaseGraphHash = stringField(metadata, 'phaseGraphHash', 'governanceChange');
  if (phaseGraphHash !== activationIdentity.phaseGraphHash) {
    throw new Error('governanceChange.phaseGraphHash must match activationIdentity.phaseGraphHash.');
  }
  const baselineSha = stringField(metadata, 'baselineSha', 'governanceChange');
  if (!hex64Pattern.test(baselineSha)) {
    throw new Error('governanceChange.baselineSha must be a SHA-256 hex digest.');
  }
  if (!Array.isArray(metadata.phaseTaskMapping)) {
    throw new Error('governanceChange.phaseTaskMapping must be an array.');
  }
  const seenPhases = new Set<PhaseId>();
  const seenTasks = new Set<string>();
  const phaseTaskMapping = metadata.phaseTaskMapping.map((entry, index) => {
    const mapping = strictPhaseTaskMapping(entry, `governanceChange.phaseTaskMapping[${index}]`);
    if (seenPhases.has(mapping.phaseId)) {
      throw new Error(`governanceChange.phaseTaskMapping contains duplicate phase ${mapping.phaseId}.`);
    }
    if (seenTasks.has(mapping.taskId)) {
      throw new Error(`governanceChange.phaseTaskMapping contains duplicate task ${mapping.taskId}.`);
    }
    seenPhases.add(mapping.phaseId);
    seenTasks.add(mapping.taskId);
    return mapping;
  });
  for (const phaseId of phaseIds) {
    if (!seenPhases.has(phaseId)) {
      throw new Error(`governanceChange.phaseTaskMapping.${phaseId} is required.`);
    }
  }
  const policy = exact(metadata.currentPolicy, [
    'phaseAuthority',
    'taskCompletion',
    'approvalPolicy'
  ], 'governanceChange.currentPolicy');
  if (policy.phaseAuthority !== 'managed-phase-graph') {
    throw new Error('governanceChange.currentPolicy.phaseAuthority must be managed-phase-graph.');
  }
  if (policy.taskCompletion !== 'authoritative-evidence-projection') {
    throw new Error('governanceChange.currentPolicy.taskCompletion must be authoritative-evidence-projection.');
  }
  if (policy.approvalPolicy !== 'approval-envelope-required-for-gated-phases') {
    throw new Error('governanceChange.currentPolicy.approvalPolicy must be approval-envelope-required-for-gated-phases.');
  }
  const createdFrom = exact(metadata.createdFrom, [
    'kind',
    'approvedFactDigest',
    'evidenceIds'
  ], 'governanceChange.createdFrom');
  if (createdFrom.kind !== 'approved-phase-0-facts') {
    throw new Error('governanceChange.createdFrom.kind must be approved-phase-0-facts.');
  }
  const approvedFactDigest = stringField(createdFrom, 'approvedFactDigest', 'governanceChange.createdFrom');
  if (!hex64Pattern.test(approvedFactDigest)) {
    throw new Error('governanceChange.createdFrom.approvedFactDigest must be a SHA-256 hex digest.');
  }
  const acknowledgedAt = stringField(metadata, 'acknowledgedAt', 'governanceChange');
  if (!isoLikePattern.test(acknowledgedAt) || Number.isNaN(Date.parse(acknowledgedAt))) {
    throw new Error('governanceChange.acknowledgedAt must be a valid ISO timestamp.');
  }
  return {
    schemaVersion: governanceChangeMetadataSchemaVersion,
    marker: governanceSourceOfTruthMarker,
    changeId,
    workflowKind: workflowKind as SpecWorkflowId,
    activationIdentity,
    phaseGraphHash,
    baselineSha,
    phaseTaskMapping,
    currentPolicy: {
      phaseAuthority: 'managed-phase-graph',
      taskCompletion: 'authoritative-evidence-projection',
      approvalPolicy: 'approval-envelope-required-for-gated-phases'
    },
    createdFrom: {
      kind: 'approved-phase-0-facts',
      approvedFactDigest,
      evidenceIds: stringArray(createdFrom.evidenceIds, 'governanceChange.createdFrom.evidenceIds')
    },
    acknowledgedAt,
    owner: stringField(metadata, 'owner', 'governanceChange')
  };
}

export function governancePhaseTaskMappings(): GovernancePhaseTaskMapping[] {
  return phaseIds.map((phaseId, index) => ({
    phaseId,
    taskId: `${index + 1}.1`,
    marker: `<!-- liftoff-phase: ${phaseId} -->`,
    policy: 'evidence-projection-v1'
  }));
}

export function approvedPhase0FactDigest(facts: ApprovedPhase0Facts): string {
  return canonicalSha256({
    approvedFacts: facts.approvedFacts,
    baselineSha: facts.baselineSha,
    defaultBranch: facts.defaultBranch,
    evidenceIds: facts.evidenceIds,
    repositoryId: facts.repositoryId,
    repositoryName: facts.repositoryName,
    workflowKind: facts.workflowKind
  });
}

export function deterministicGovernanceChangeId(facts: Pick<ApprovedPhase0Facts, 'projectName' | 'baselineSha' | 'workflowKind'>): string {
  const safeProject = toSafeProjectName(facts.projectName);
  const suffix = facts.baselineSha.slice(0, 12);
  return facts.workflowKind === 'openspec'
    ? `governance-${safeProject}-${suffix}`
    : `001-liftoff-governance-${safeProject}-${suffix}`;
}

function metadataForFacts(facts: ApprovedPhase0Facts, changeId: string): GovernanceChangeMetadata {
  return validateGovernanceChangeMetadata({
    schemaVersion: governanceChangeMetadataSchemaVersion,
    marker: governanceSourceOfTruthMarker,
    changeId,
    workflowKind: facts.workflowKind,
    activationIdentity: currentActivationIdentity,
    phaseGraphHash: canonicalPhaseGraphHash,
    baselineSha: facts.baselineSha,
    phaseTaskMapping: governancePhaseTaskMappings(),
    currentPolicy: {
      phaseAuthority: 'managed-phase-graph',
      taskCompletion: 'authoritative-evidence-projection',
      approvalPolicy: 'approval-envelope-required-for-gated-phases'
    },
    createdFrom: {
      kind: 'approved-phase-0-facts',
      approvedFactDigest: approvedPhase0FactDigest(facts),
      evidenceIds: facts.evidenceIds
    },
    acknowledgedAt: facts.approvedAt,
    owner: facts.approver
  });
}

function approvedFactsMarkdown(facts: ApprovedPhase0Facts): string {
  if (facts.approvedFacts.length === 0) {
    return '- No additional Phase 0 facts were discovered.\n';
  }
  return facts.approvedFacts
    .map((fact) => `- ${fact.id}: ${fact.value === null ? 'null' : String(fact.value)}`)
    .join('\n') + '\n';
}

function openSpecGovernanceSpec(metadata: GovernanceChangeMetadata, facts: ApprovedPhase0Facts): string {
  return `## ADDED Requirements

### Requirement: Liftoff activation follows the installed phase graph
The project SHALL use the Liftoff governance activation identity acknowledged by
\`${metadata.changeId}\` and SHALL treat the managed phase graph as the sole
source of execution order.

#### Scenario: Phase evidence is authoritative
- **WHEN** a phase task is checked or unchecked
- **THEN** Liftoff reconciles it from current validated evidence for the same repository, baseline SHA, activation identity, graph hash, and phase mapping
- **AND** prose or checkbox state alone does not authorize a transition

#### Scenario: Phase 0 facts are the only creation input
- **WHEN** this governance change is inspected
- **THEN** only these approved Phase 0 facts are in scope:
${approvedFactsMarkdown(facts).split('\n').filter(Boolean).map((line) => `  ${line}`).join('\n')}
`;
}

function renderOpenSpecFiles(metadata: GovernanceChangeMetadata, facts: ApprovedPhase0Facts): GovernanceChangeFilePlan[] {
  const idLines = [
    `- Liftoff version: ${metadata.activationIdentity.liftoffVersion}`,
    `- Manifest artifact version: ${metadata.activationIdentity.manifestArtifactVersion}`,
    `- Policy version: ${metadata.activationIdentity.policyVersion}`,
    `- Activation contract version: ${metadata.activationIdentity.activationContractVersion}`,
    `- Phase-graph schema version: ${metadata.activationIdentity.phaseGraphSchemaVersion}`,
    `- Phase-graph hash: ${metadata.phaseGraphHash}`,
    `- Activation-state schema version: ${metadata.activationIdentity.activationStateSchemaVersion}`,
    `- Evidence-header schema version: ${metadata.activationIdentity.evidenceHeaderSchemaVersion}`,
    `- Approval-envelope schema version: ${metadata.activationIdentity.approvalEnvelopeSchemaVersion}`,
    `- Supersession schema version: ${metadata.activationIdentity.supersessionSchemaVersion}`,
    `- Credential-policy schema version: ${metadata.activationIdentity.credentialPolicySchemaVersion}`,
    `- Baseline SHA: ${metadata.baselineSha}`,
    `- Approved fact digest: ${metadata.createdFrom.approvedFactDigest}`
  ].join('\n');
  const taskSections = metadata.phaseTaskMapping.map((mapping) => `## ${mapping.taskId.split('.')[0]}. ${mapping.phaseId}

- [ ] ${mapping.taskId} Reconcile \`${mapping.phaseId}\` from validated phase evidence. ${mapping.marker}`).join('\n\n');
  const mappingLines = metadata.phaseTaskMapping.map((mapping) =>
    `- \`${mapping.phaseId}\` -> task \`${mapping.taskId}\` (${mapping.policy})`
  ).join('\n');
  return [
    {
      pathParts: ['openspec', 'changes', metadata.changeId, '.openspec.yaml'],
      content: 'schema: spec-driven\n'
    },
    {
      pathParts: ['openspec', 'changes', metadata.changeId, governanceChangeMetadataFileName],
      content: `${canonicalJson(metadata)}\n`
    },
    {
      pathParts: ['openspec', 'changes', metadata.changeId, 'proposal.md'],
      content: `# Proposal: ${metadata.changeId}

## Why

Activate repository governance using one deterministic Liftoff source of truth
created from approved Phase 0 facts.

## What Changes

- Acknowledge the complete compatible activation identity and phase graph hash.
- Map every Liftoff phase to a task marker that is projected from evidence.
- Keep implementation, credentials, remote resources, and approvals outside this change until their phase evidence and approval envelopes authorize them.

## Capabilities

### New Capabilities

- \`liftoff-governance-activation\`: Evidence-backed repository governance activation for ${facts.repositoryName}.

### Modified Capabilities

- None.

## Impact

- User-owned governance activation artifacts only.
- No product behavior, Git, GitHub, Azure, credential, or infrastructure mutation.
`
    },
    {
      pathParts: ['openspec', 'changes', metadata.changeId, 'design.md'],
      content: `# Design: ${metadata.changeId}

## Context

Repository: ${facts.repositoryName}
Baseline SHA: ${metadata.baselineSha}
Workflow: ${metadata.workflowKind}

## Activation identity

${idLines}

## Phase mapping and policy

The managed phase graph is the execution authority. Task completion is a
projection of authoritative evidence; approval-gated phases require a validated
approval envelope.

${mappingLines}

## Approved Phase 0 facts

${approvedFactsMarkdown(facts)}
`
    },
    {
      pathParts: ['openspec', 'changes', metadata.changeId, 'specs', 'liftoff-governance-activation', 'spec.md'],
      content: openSpecGovernanceSpec(metadata, facts)
    },
    {
      pathParts: ['openspec', 'changes', metadata.changeId, 'tasks.md'],
      content: `${taskSections}

`
    }
  ];
}

function renderSpecKitFiles(metadata: GovernanceChangeMetadata, facts: ApprovedPhase0Facts): GovernanceChangeFilePlan[] {
  const base = ['specs', metadata.changeId] as const;
  const taskSections = metadata.phaseTaskMapping.map((mapping) => `## ${mapping.taskId.split('.')[0]}. ${mapping.phaseId}

- [ ] ${mapping.taskId} Reconcile \`${mapping.phaseId}\` from validated phase evidence. ${mapping.marker}`).join('\n\n');
  return [
    {
      pathParts: [...base, governanceChangeMetadataFileName],
      content: `${canonicalJson(metadata)}\n`
    },
    {
      pathParts: [...base, 'spec.md'],
      content: `# Feature Specification: Liftoff Governance Activation

**Feature Branch**: \`${metadata.changeId}\`
**Created**: ${metadata.acknowledgedAt}
**Status**: Draft
**Input**: Approved Phase 0 facts for ${facts.repositoryName}

## User Scenarios & Testing

### Primary User Story

As the repository owner, I need governance activation to resume from one
deterministic Liftoff source of truth using validated evidence rather than
checkboxes or prose.

## Requirements

- **REQ-001**: Acknowledge activation identity \`${metadata.createdFrom.approvedFactDigest}\`, graph hash \`${metadata.phaseGraphHash}\`, and baseline \`${metadata.baselineSha}\`.
- **REQ-002**: Use the managed phase graph as the only execution-order authority.
- **REQ-003**: Project task completion from authoritative phase evidence and validated approval envelopes only.

## Approved Phase 0 Facts

${approvedFactsMarkdown(facts)}
`
    },
    {
      pathParts: [...base, 'plan.md'],
      content: `# Implementation Plan: Liftoff Governance Activation

**Branch**: \`${metadata.changeId}\` | **Date**: ${metadata.acknowledgedAt} | **Spec**: ./spec.md
**Input**: Approved Phase 0 facts from Liftoff governance status.

## Technical Context

Activation identity: \`${metadata.activationIdentity.liftoffVersion}/${metadata.activationIdentity.policyVersion}/${metadata.activationIdentity.activationContractVersion}\`
Phase graph hash: \`${metadata.phaseGraphHash}\`
Baseline SHA: \`${metadata.baselineSha}\`

## Constitution Check

No Git, GitHub, Azure, credential, product, or infrastructure mutation is
authorized by this plan. Later transition adapters must consume validated
approval envelopes and evidence.
`
    },
    {
      pathParts: [...base, 'tasks.md'],
      content: `# Tasks: Liftoff Governance Activation

${taskSections}
`
    }
  ];
}

export function renderGovernanceChangeWritePlan(facts: ApprovedPhase0Facts): GovernanceChangeWritePlan {
  if (!hex64Pattern.test(facts.baselineSha)) {
    throw new Error('Approved Phase 0 baselineSha must be a SHA-256 hex digest.');
  }
  if (!workflowKinds.has(facts.workflowKind)) {
    throw new Error(`Unsupported governance workflow kind ${facts.workflowKind}.`);
  }
  if (!isoLikePattern.test(facts.approvedAt) || Number.isNaN(Date.parse(facts.approvedAt))) {
    throw new Error('Approved Phase 0 approvedAt must be a valid ISO timestamp.');
  }
  const changeId = deterministicGovernanceChangeId(facts);
  const metadata = metadataForFacts(facts, changeId);
  const files = facts.workflowKind === 'openspec'
    ? renderOpenSpecFiles(metadata, facts)
    : renderSpecKitFiles(metadata, facts);
  return {
    changeId,
    workflowKind: facts.workflowKind,
    metadata,
    files,
    transactionalWrite: {
      functionName: 'writeGovernanceChangeArtifacts',
      writesAllFilesOrThrows: true
    }
  };
}

export async function writeGovernanceChangeArtifacts(projectRoot: string, plan: GovernanceChangeWritePlan): Promise<void> {
  const validated = validateGovernanceChangeMetadata(plan.metadata);
  if (validated.changeId !== plan.changeId || validated.workflowKind !== plan.workflowKind) {
    throw new Error('Governance change write plan metadata does not match plan identity.');
  }
  for (const file of plan.files) {
    validateArtifactPathParts([...file.pathParts], 'Governance change artifact path');
  }
  for (const file of plan.files) {
    const existing = await readProjectFile(projectRoot, [...file.pathParts]);
    if (existing !== undefined) {
      throw new Error(`Refusing to overwrite existing governance change artifact ${file.pathParts.join('/')}.`);
    }
  }
  try {
    await applyProjectFileTransaction(projectRoot, plan.files.map((file) => ({
      type: 'write' as const,
      pathParts: [...file.pathParts],
      content: file.content
    })));
  } catch (error) {
    throw new Error(`Unable to write governance change artifacts transactionally: ${errorMessage(error)}`);
  }
}

async function directoryEntries(projectRoot: string, pathParts: readonly string[]): Promise<string[]> {
  const directory = await resolveProjectPath(projectRoot, validateArtifactPathParts([...pathParts], 'Governance directory path'));
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en'));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return [];
    }
    throw new Error(`Unable to inspect ${pathParts.join('/')}: ${errorMessage(error)}.`);
  }
}

async function activeSeedBlockers(projectRoot: string, manifest: LiftoffManifest): Promise<string[]> {
  if (manifest.project.specWorkflow !== 'openspec') {
    return [];
  }
  const expectedSeed = generatedSeedChangeName(manifest);
  const active = await directoryEntries(projectRoot, ['openspec', 'changes']);
  const activeSeeds = active.filter((entry) => entry.startsWith('bootstrap-') && entry !== 'archive');
  if (activeSeeds.length === 0) {
    return [];
  }
  if (activeSeeds.includes(expectedSeed)) {
    return [`Generated OpenSpec seed ${expectedSeed} is still active; archive it before governance creation.`];
  }
  return [`Active bootstrap seed changes overlap governance setup: ${activeSeeds.join(', ')}.`];
}

async function readMetadataCandidate(
  projectRoot: string,
  workflowKind: SpecWorkflowId,
  changeId: string,
  pathParts: readonly string[],
  requireMetadata: boolean
): Promise<ActiveGovernanceCandidate> {
  const metadataBytes = await readProjectFile(projectRoot, [...pathParts, governanceChangeMetadataFileName]);
  if (metadataBytes === undefined) {
    return {
      changeId,
      workflowKind,
      pathParts,
      status: requireMetadata ? 'missing-metadata' : 'invalid-metadata',
      issues: [`${[...pathParts, governanceChangeMetadataFileName].join('/')} is missing.`]
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataBytes.toString('utf8')) as unknown;
  } catch (error) {
    return {
      changeId,
      workflowKind,
      pathParts,
      status: 'invalid-metadata',
      issues: [`Unable to parse governance metadata: ${errorMessage(error)}`]
    };
  }
  try {
    const metadata = validateGovernanceChangeMetadata(parsed);
    const issues: string[] = [];
    if (metadata.changeId !== changeId) {
      issues.push(`metadata changeId ${metadata.changeId} does not match path ${changeId}.`);
    }
    if (metadata.workflowKind !== workflowKind) {
      issues.push(`metadata workflowKind ${metadata.workflowKind} does not match ${workflowKind}.`);
    }
    issues.push(...validateCurrentIdentity(metadata.activationIdentity, 'activationIdentity'));
    if (metadata.phaseGraphHash !== canonicalPhaseGraphHash) {
      issues.push(`phaseGraphHash expected ${canonicalPhaseGraphHash}, found ${metadata.phaseGraphHash}.`);
    }
    return {
      changeId,
      workflowKind,
      pathParts,
      status: issues.length === 0 ? 'compatible' : 'identity-mismatch',
      metadata,
      issues
    };
  } catch (error) {
    return {
      changeId,
      workflowKind,
      pathParts,
      status: 'invalid-metadata',
      issues: [errorMessage(error)]
    };
  }
}

async function activeGovernanceCandidates(
  projectRoot: string,
  manifest: LiftoffManifest,
  state: UserActivationState
): Promise<ActiveGovernanceCandidate[]> {
  const candidates: ActiveGovernanceCandidate[] = [];
  if (manifest.project.specWorkflow === 'openspec') {
    for (const changeId of await directoryEntries(projectRoot, ['openspec', 'changes'])) {
      if (changeId === 'archive' || changeId.startsWith('bootstrap-')) {
        continue;
      }
      const pathParts = ['openspec', 'changes', changeId] as const;
      const metadataBytes = await readProjectFile(projectRoot, [...pathParts, governanceChangeMetadataFileName]);
      if (metadataBytes !== undefined || state.activeChange?.id === changeId) {
        candidates.push(await readMetadataCandidate(
          projectRoot,
          'openspec',
          changeId,
          pathParts,
          state.activeChange?.id === changeId
        ));
      }
    }
  } else {
    for (const changeId of await directoryEntries(projectRoot, ['specs'])) {
      const pathParts = ['specs', changeId] as const;
      const metadataBytes = await readProjectFile(projectRoot, [...pathParts, governanceChangeMetadataFileName]);
      if (metadataBytes !== undefined || state.activeChange?.id === changeId) {
        candidates.push(await readMetadataCandidate(
          projectRoot,
          'spec-kit',
          changeId,
          pathParts,
          state.activeChange?.id === changeId
        ));
      }
    }
  }
  if (state.activeChange && !candidates.some((candidate) => candidate.changeId === state.activeChange?.id)) {
    const pathParts = state.activeChange.kind === 'openspec'
      ? ['openspec', 'changes', state.activeChange.id]
      : ['specs', state.activeChange.id];
    candidates.push({
      changeId: state.activeChange.id,
      workflowKind: state.activeChange.kind === 'openspec' ? 'openspec' : 'spec-kit',
      pathParts,
      status: 'missing-metadata',
      issues: [`Activation state activeChange ${state.activeChange.id} has no inspectable governance metadata.`]
    });
  }
  return candidates.sort((left, right) => left.changeId.localeCompare(right.changeId, 'en'));
}

async function readSupersessionRecords(projectRoot: string, candidates: readonly ActiveGovernanceCandidate[]): Promise<GovernanceSupersessionInspection> {
  const directory = await resolveProjectPath(projectRoot, [...governanceSupersessionPathParts]);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { records: [], invalidRecords: [], selectedChangeId: null, issues: [] };
    }
    throw new Error(`Unable to inspect ${governanceSupersessionPathParts.join('/')}: ${errorMessage(error)}.`);
  }
  const byId = new Map(candidates.map((candidate) => [candidate.changeId, candidate]));
  const records: SupersessionRecord[] = [];
  const invalidRecords: string[] = [];
  const issues: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const pathParts = [...governanceSupersessionPathParts, entry.name];
    const bytes = await readProjectFile(projectRoot, pathParts);
    if (bytes === undefined) {
      throw new Error(`${pathParts.join('/')} disappeared during inspection.`);
    }
    try {
      const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
      const record = validateSupersessionRecord(parsed);
      const superseded = byId.get(record.supersededChangeId);
      const superseding = byId.get(record.supersedingChangeId);
      if (!superseded || !superseding) {
        issues.push(`${pathParts.join('/')} references a change that is not active and valid in this inspection.`);
      } else if (superseded.status !== 'compatible' || superseding.status !== 'compatible') {
        issues.push(`${pathParts.join('/')} references a change without a compatible identity.`);
      } else {
        records.push(record);
      }
    } catch (error) {
      invalidRecords.push(`${pathParts.join('/')}: ${errorMessage(error)}`);
    }
  }

  const compatible = candidates.filter((candidate) => candidate.status === 'compatible');
  if (invalidRecords.length > 0 || issues.length > 0) {
    return {
      records,
      invalidRecords,
      selectedChangeId: null,
      issues
    };
  }
  const selectable = compatible.filter((candidate) =>
    compatible
      .filter((other) => other.changeId !== candidate.changeId)
      .every((other) => records.some((record) =>
        record.supersededChangeId === other.changeId &&
        record.supersedingChangeId === candidate.changeId
      ))
  );
  return {
    records,
    invalidRecords,
    selectedChangeId: selectable.length === 1 ? selectable[0]!.changeId : null,
    issues
  };
}

export function buildApprovedPhase0FactsFromState(
  manifest: LiftoffManifest,
  state: UserActivationState,
  evidence: readonly PhaseEvidenceRecord[]
): ApprovedPhase0Facts | undefined {
  const validPhase0 = evidence
    .filter((record) => record.header.phaseId === 'phase-0-complete')
    .flatMap((record): ValidatedPhaseEvidenceRecord[] => {
      const context = evidenceContextForPhase('phase-0-complete', {
        repositoryId: state.repository.id,
        identity: state.identity,
        phaseGraphHash: state.identity.phaseGraphHash,
        baselineSha: record.header.baselineSha,
        inputDigest: record.header.inputDigest
      });
      const validation = validateEvidenceFreshness(record, context);
      return validation.valid ? [validation.record] : [];
    })
    .sort((left, right) => {
      const time = right.producedAtEpochMs - left.producedAtEpochMs;
      if (time !== 0) {
        return time;
      }
      const evidenceId = right.evidenceId.localeCompare(left.evidenceId, 'en');
      return evidenceId === 0 ? right.headerDigest.localeCompare(left.headerDigest, 'en') : evidenceId;
    });
  const phase0 = validPhase0[0];
  if (!phase0) {
    return undefined;
  }
  const latestResults = new Set(
    validPhase0
      .filter((record) => record.producedAtEpochMs === phase0.producedAtEpochMs)
      .map((record) => record.header.result)
  );
  if (latestResults.size !== 1 || phase0.header.result !== 'verified') {
    return undefined;
  }
  return {
    projectName: manifest.project.name,
    repositoryId: state.repository.id,
    repositoryName: state.repository.name,
    defaultBranch: state.repository.defaultBranch,
    workflowKind: manifest.project.specWorkflow,
    baselineSha: phase0.header.baselineSha,
    evidenceIds: [phase0.evidenceId],
    approvedFacts: [
      { id: 'repositoryId', value: state.repository.id },
      { id: 'repositoryName', value: state.repository.name },
      { id: 'defaultBranch', value: state.repository.defaultBranch },
      { id: 'specWorkflow', value: manifest.project.specWorkflow }
    ],
    approvedAt: phase0.header.producedAt,
    approver: phase0.header.producer
  };
}

function createPreview(manifest: LiftoffManifest, state: UserActivationState, evidence: readonly PhaseEvidenceRecord[]): GovernanceCreateChangePlanPreview {
  const facts = buildApprovedPhase0FactsFromState(manifest, state, evidence);
  if (facts) {
    return {
      status: 'ready',
      reason: 'Verified Phase 0 evidence is available for deterministic governance change rendering.',
      changeId: deterministicGovernanceChangeId(facts),
      workflowKind: facts.workflowKind,
      requiredFacts: []
    };
  }
  const fallback = {
    projectName: manifest.project.name,
    baselineSha: '0'.repeat(64),
    workflowKind: manifest.project.specWorkflow
  };
  return {
    status: 'blocked',
    reason: 'Verified Phase 0 evidence is required before rendering user-owned governance artifacts.',
    changeId: deterministicGovernanceChangeId(fallback),
    workflowKind: manifest.project.specWorkflow,
    requiredFacts: ['phase-0-complete verified evidence', 'repository id', 'repository name', 'default branch', 'baseline SHA']
  };
}

export function reconcileActiveGovernanceChange(input: {
  metadata: GovernanceChangeMetadata;
  evidence: readonly PhaseEvidenceRecord[];
  fromGraph?: ManagedPhaseGraph;
  toGraph?: ManagedPhaseGraph;
  toIdentity?: ActivationIdentity;
  recognizedGraphHashes?: ReadonlySet<string>;
  reconciledAt?: string;
}): GovernanceActiveReconciliationResult {
  const toGraph = input.toGraph ?? canonicalPhaseGraph;
  const fromGraph = input.fromGraph ?? toGraph;
  const toIdentity = input.toIdentity ?? currentActivationIdentity;
  if (canonicalJson(input.metadata.activationIdentity) === canonicalJson(toIdentity)) {
    return {
      status: 'not-required',
      approvalRequired: false,
      preservedPhaseIds: phaseIds,
      invalidPhaseIds: [],
      issues: []
    };
  }
  if (
    input.metadata.activationIdentity.policyVersion !== toIdentity.policyVersion ||
    input.metadata.activationIdentity.activationContractVersion !== toIdentity.activationContractVersion ||
    input.metadata.activationIdentity.phaseGraphSchemaVersion !== toIdentity.phaseGraphSchemaVersion
  ) {
    return {
      status: 'blocked',
      approvalRequired: false,
      issues: ['Active governance change identity is incompatible with the installed policy, contract, or graph schema.'],
      preservedPhaseIds: [],
      invalidPhaseIds: phaseIds
    };
  }
  const fromHash = input.metadata.activationIdentity.phaseGraphHash;
  const toHash = toIdentity.phaseGraphHash;
  if (fromHash !== toHash && input.fromGraph === undefined) {
    return {
      status: 'blocked',
      approvalRequired: false,
      issues: [
        'Active governance change records a different phase-graph hash, but no recognized source graph or explicit mapping was provided for phase contract reconciliation.'
      ],
      preservedPhaseIds: [],
      invalidPhaseIds: phaseIds
    };
  }
  const fromDigests = phaseContractDigests(fromGraph);
  const toDigests = phaseContractDigests(toGraph);
  const record: GraphReconciliationRecord = {
    schemaVersion: currentActivationIdentity.activationStateSchemaVersion,
    fromGraphHash: fromHash,
    toGraphHash: toHash,
    fromIdentity: input.metadata.activationIdentity,
    toIdentity,
    phaseMappings: phaseIds.map((phaseId) => ({
      phaseId,
      fromContractDigest: fromDigests[phaseId],
      toContractDigest: toDigests[phaseId],
      preserveEvidence: fromDigests[phaseId] === toDigests[phaseId]
    })),
    reconciledAt: input.reconciledAt ?? new Date().toISOString(),
    producer: 'liftoff-governance-source-of-truth'
  };
  try {
    const reconciliation = calculateGraphReconciliation(record, {
      fromGraph,
      toGraph,
      recognizedGraphHashes: input.recognizedGraphHashes ?? new Set([toHash])
    });
    const invalid = new Set(reconciliation.invalidPhaseIds);
    return {
      status: 'required',
      approvalRequired: true,
      fromIdentity: input.metadata.activationIdentity,
      toIdentity,
      record: reconciliation.record,
      preservedPhaseIds: reconciliation.preservedPhaseIds,
      invalidPhaseIds: reconciliation.invalidPhaseIds,
      evidenceToReview: input.evidence
        .filter((entry) => invalid.has(entry.header.phaseId))
        .map((entry) => entry.evidenceId),
      issues: ['Active governance change must acknowledge the installed activation identity before execution can continue.']
    };
  } catch (error) {
    return {
      status: 'blocked',
      approvalRequired: false,
      issues: [errorMessage(error)],
      preservedPhaseIds: [],
      invalidPhaseIds: phaseIds
    };
  }
}

export function stateWithSelectedActiveChange(
  state: UserActivationState,
  selected: ActiveGovernanceCandidate
): UserActivationState {
  if (selected.status !== 'compatible') {
    throw new Error(`Cannot record incompatible active change ${selected.changeId}.`);
  }
  return {
    ...state,
    activeChange: {
      id: selected.changeId,
      kind: selected.workflowKind === 'openspec' ? 'openspec' : 'spec-kit'
    }
  };
}

export async function inspectGovernanceSourceOfTruth(input: {
  projectRoot: string;
  manifest: LiftoffManifest;
  state: UserActivationState;
  evidence: readonly PhaseEvidenceRecord[];
}): Promise<GovernanceSourceOfTruthInspection> {
  const seedBlockers = await activeSeedBlockers(input.projectRoot, input.manifest);
  const candidates = await activeGovernanceCandidates(input.projectRoot, input.manifest, input.state);
  if (seedBlockers.length > 0) {
    return {
      status: 'seed-blocked',
      seedChangeId: generatedSeedChangeName(input.manifest),
      blockers: seedBlockers,
      selected: null,
      candidates
    };
  }
  const invalid = candidates.filter((candidate) => candidate.status === 'invalid-metadata' || candidate.status === 'missing-metadata');
  if (invalid.length > 0) {
    return {
      status: 'incompatible',
      selected: null,
      candidates,
      blockers: invalid.flatMap((candidate) => candidate.issues.map((issue) => `${candidate.changeId}: ${issue}`)),
      reconciliation: {
        status: 'blocked',
        approvalRequired: false,
        issues: invalid.flatMap((candidate) => candidate.issues),
        preservedPhaseIds: [],
        invalidPhaseIds: phaseIds
      }
    };
  }
  const mismatched = candidates.filter((candidate) => candidate.status === 'identity-mismatch');
  if (mismatched.length > 0) {
    return {
      status: 'incompatible',
      selected: null,
      candidates,
      blockers: mismatched.flatMap((candidate) => candidate.issues.map((issue) => `${candidate.changeId}: ${issue}`)),
      reconciliation: mismatched[0]?.metadata
        ? reconcileActiveGovernanceChange({ metadata: mismatched[0].metadata, evidence: input.evidence })
        : {
            status: 'blocked',
            approvalRequired: false,
            issues: ['Active governance change lacks valid metadata.'],
            preservedPhaseIds: [],
            invalidPhaseIds: phaseIds
          }
    };
  }
  const compatible = candidates.filter((candidate) => candidate.status === 'compatible');
  if (compatible.length === 0) {
    return {
      status: 'none',
      selected: null,
      candidates,
      createPlan: createPreview(input.manifest, input.state, input.evidence)
    };
  }
  const supersession = await readSupersessionRecords(input.projectRoot, compatible);
  if (compatible.length > 1) {
    if (supersession.selectedChangeId) {
      const selected = compatible.find((candidate) => candidate.changeId === supersession.selectedChangeId)!;
      return {
        status: 'selected',
        selected,
        candidates,
        recordActiveChangeOnNextMutation: input.state.activeChange?.id !== selected.changeId,
        reconciliation: reconcileActiveGovernanceChange({ metadata: selected.metadata!, evidence: input.evidence }),
        supersession
      };
    }
    return {
      status: 'ambiguous',
      selected: null,
      candidates,
      blockers: [
        'Multiple compatible governance changes overlap activation scope.',
        'Add explicit schema-valid supersession records; Liftoff never selects by timestamp or name.',
        ...supersession.invalidRecords,
        ...supersession.issues
      ],
      supersession
    };
  }
  const selected = compatible[0]!;
  return {
    status: 'selected',
    selected,
    candidates,
    recordActiveChangeOnNextMutation: input.state.activeChange?.id !== selected.changeId,
    reconciliation: reconcileActiveGovernanceChange({ metadata: selected.metadata!, evidence: input.evidence }),
    supersession
  };
}
