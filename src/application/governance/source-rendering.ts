import { canonicalJson } from '../../domain/governance/activation/canonical-json.js';
import type { ActivationIdentityFieldsV1 } from '../../domain/governance/activation/record-contracts.js';

export interface GovernanceSourceRenderingMetadata {
  readonly changeId: string;
  readonly workflowKind: 'openspec' | 'spec-kit';
  readonly activationIdentity: ActivationIdentityFieldsV1;
  readonly phaseGraphHash: string;
  readonly baselineSha: string;
  readonly phaseTaskMapping: readonly {
    readonly phaseId: string;
    readonly taskId: string;
    readonly marker: string;
    readonly policy: string;
  }[];
  readonly createdFrom: { readonly approvedFactDigest: string };
  readonly acknowledgedAt: string;
}

export interface GovernanceSourceRenderingFacts {
  readonly repositoryName: string;
  readonly approvedFacts: readonly { readonly id: string; readonly value: string | number | boolean | null }[];
}

export interface GovernanceSourceFile {
  readonly pathParts: readonly string[];
  readonly content: string;
}

function approvedFactsMarkdown(facts: GovernanceSourceRenderingFacts): string {
  if (facts.approvedFacts.length === 0) {
    return '- No additional Phase 0 facts were discovered.\n';
  }
  return facts.approvedFacts
    .map((fact) => `- ${fact.id}: ${fact.value === null ? 'null' : String(fact.value)}`)
    .join('\n') + '\n';
}

function openSpecGovernanceSpec(metadata: GovernanceSourceRenderingMetadata, facts: GovernanceSourceRenderingFacts): string {
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

function renderOpenSpecFiles(metadata: GovernanceSourceRenderingMetadata, facts: GovernanceSourceRenderingFacts): GovernanceSourceFile[] {
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
      pathParts: ['openspec', 'changes', metadata.changeId, 'liftoff-governance.json'],
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

function renderSpecKitFiles(metadata: GovernanceSourceRenderingMetadata, facts: GovernanceSourceRenderingFacts): GovernanceSourceFile[] {
  const base = ['specs', metadata.changeId] as const;
  const taskSections = metadata.phaseTaskMapping.map((mapping) => `## ${mapping.taskId.split('.')[0]}. ${mapping.phaseId}

- [ ] ${mapping.taskId} Reconcile \`${mapping.phaseId}\` from validated phase evidence. ${mapping.marker}`).join('\n\n');
  return [
    {
      pathParts: [...base, 'liftoff-governance.json'],
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

/** Render already validated source values; the resulting files confer no write authority. */
export function renderGovernanceSourceFiles(
  metadata: GovernanceSourceRenderingMetadata, facts: GovernanceSourceRenderingFacts
): GovernanceSourceFile[] {
  switch (metadata.workflowKind) {
    case 'openspec': return renderOpenSpecFiles(metadata, facts);
    case 'spec-kit': return renderSpecKitFiles(metadata, facts);
    default: throw new Error('Governance source rendering requires an explicitly selected external workflow.');
  }
}
