import { governanceAgentIntegrations } from '../../domain/project/catalog.js';
import type { CodingAgentId } from '../../domain/project/contracts.js';
import type { ManifestV8ProjectLeaf } from '../../domain/project/manifest/v8-project.js';
import type { ModernGovernanceProfile } from '../../domain/governance/activation/modern-record-contracts.js';
import type { ModernPhaseGraph } from '../../domain/governance/activation/modern-graph.js';
import type { ModernGovernanceContext } from '../../domain/governance/policy/modern-context.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { nativeIntegrationHeader, renderRepairInstructions } from './integrations.js';

type HandoffSelection = ManifestV8ProjectLeaf & { readonly profile: 'none' | ModernGovernanceProfile };

function frameworkMeaning(selection: HandoffSelection): string {
  if (selection.framework.state === 'not-required') {
    return 'Manual records external framework as not-required. No executable, framework version, marker, seed, constitution, task bundle or archive is required or created. Native local completion requires actual approved checks and its own completion receipt; this handoff is not that receipt.';
  }
  if (selection.framework.state === 'legacy') {
    return `The recorded ${selection.project.specWorkflow} workflow has legacy framework uncertainty, no recorded contract version and no configured agents. This is not Manual or successful initialization. Stop dependent operations until separate reviewed reconciliation establishes the required actual inputs.`;
  }
  return `The recorded ${selection.project.specWorkflow} contract is ${selection.framework.contractVersion}; this metadata does not verify an installed framework or tool. ${
    selection.project.specWorkflow === 'openspec'
      ? 'The local protocol requires actual validation, synchronization and archive; none is marked complete here.'
      : 'The local protocol requires actual Spec Kit validation and finalization, not an OpenSpec archive or a new Git branch.'
  }`;
}

function supportBoundary(selection: HandoffSelection): string {
  return `## Source contract, not execution permission

This handoff targets manifest 8 and ${selection.profile === 'none' ? 'disabled governance' : `the ${selection.profile} modern governance source`}.
It is source-contract-only metadata. Current public defaults are not promoted by
these files, and no released minimum or installed v8 execution support is claimed.
Schema validity, a package version or a plugin hash is not approval or readiness.

An existing read-only compatibility probe is
\`liftoff governance status --scope local --json\` from the exact project.
If it reports an unsupported manifest or identity, STOP: do not edit versions,
retag proof, reinitialize, manufacture receipts or emulate an unavailable command.
Project-independent \`liftoff --help\`, \`liftoff --version\` and
\`liftoff repair --capabilities --json\` describe the installed CLI; the repair
capability report alone does not declare v8 manifest support.
Do not invent a capabilities command or a supported-manifest response field.

Only a CLI that actually accepts this exact source and reports its applicable
operation may supply a next action. Preserve its executable, argument array, cwd,
scope, approval requirements and disclosed effects. Missing producers remain
blockers; nothing here authorizes execution, tool/dependency preparation, network
access, publication, credentials, billed resources, enforcement or destructive work.

${frameworkMeaning(selection)}
`;
}

export function renderModernGovernanceGuide(context: ModernGovernanceContext, graph: ModernPhaseGraph): string {
  const identity = context.governance.activationIdentity;
  if (identity.phaseGraphHash !== canonicalSha256(graph) ||
    graph.profileContract.profile !== identity.profile || graph.workflowContract.workflow !== identity.workflow) {
    throw new Error('Modern guide source profile/workflow contradicts its context.');
  }
  const selection: HandoffSelection = { ...context, profile: context.governance.profile };
  const invocations = context.project.agents.length
    ? context.project.agents.map((agent) => `- ${agent}: \`${governanceAgentIntegrations[agent].setup.invocation}\` (agent-native, not shell).`).join('\n')
    : context.framework.state === 'not-required'
      ? 'No agents are selected. Manual remains CLI-only; no agent is required or installed by this handoff.'
      : 'No agents are recorded. Preserve legacy uncertainty; no integration was initialized by rendering this handoff.';
  const review = graph.profileContract.pullRequestReview.kind === 'independent-human'
    ? 'Team requires one independent human approval on the actual current head. Authors, bots and stale approvals do not satisfy it.'
    : 'Single-maintainer requires zero additional human PR approvals; applicable automated exact-head checks remain required.';
  return `# Modern Liftoff governance handoff

Profile: ${identity.profile}; policy: ${identity.policyVersion}; source: ${identity.liftoffVersion}.
Activation contract: ${identity.activationContractVersion}; graph: ${identity.phaseGraphHash}.
Policy digest: ${identity.policyDigest}.
Live enforcement: **not observed**. No branches, settings, tools, resources or providers were changed.

${supportBoundary(selection)}
## Selected integrations

${invocations}

There is no \`liftoff setup\` shell command. Native setup, assessment and repair are
separate guidance surfaces, not permission to perform each other's effects.

## Recorded layout and verification

Active layout state: ${context.activeLayout.state}; bindings: ${context.activeLayout.bindings.length}.
Read exact bindings in context.json. Bound can be partial; unresolved remains
unknown. No directory, script, dependency, tool or deployed resource was inspected.
Historical generation/adoption paths are provenance, not current access or write
authority. Do not restore or move application files to match starter paths.
Finite verification commands must come from separately reviewed actual bound files.
No checks or native completion evidence have been produced.

## Profile safeguards

${review}
Preserve existing CODEOWNERS and stronger controls; review any proposed reduction.
No mandatory deployment reviewers are introduced. Protected back-merges require
their exact-head checks. Enforcement comes last after real green/red proof.
Pre-existing deployment and OpenTofu state changes remain planning-only; absent
state files do not establish safe adoption or authority to import, move or publish state.

## Actual graph requirements, not completed work

Local group: ${graph.completionGroups.local.join(', ')}.
Activation and lifecycle are separate requested scopes with their own evidence and approval.

${graph.phases.map((phase) => `- ${phase.id}: ${phase.label}`).join('\n')}

## Source and history boundaries

Modern external source-metadata2 creation and task projection are not supplied by
this handoff. Do not create liftoff-governance.json, project-governance-tasks,
framework task files or an operational plan to simulate missing producers.
Manual requires no replacement specification framework.
Context2 is managed interpretation, not activation source-metadata2.
Keep original source history and references unchanged. Syntax validation does not
verify stored copies. Metadata commit, local revalidation and live activation are
distinct outcomes; report committed-but-incomplete work without automatic downgrade.
`;
}

export function renderModernGovernanceIntegration(
  agent: CodingAgentId,
  operation: 'setup' | 'assessment' | 'repair',
  selection: HandoffSelection
): string {
  if (!selection.project.agents.some((selected) => selected === agent) || selection.profile === 'none' && operation !== 'repair') {
    throw new Error('Modern integration is not applicable to the selected agent/profile.');
  }
  const introduction = `${nativeIntegrationHeader(agent, operation)}
${supportBoundary(selection)}
`;
  if (operation === 'repair') {
    return `${introduction}
## Conditional repair protocol

The following existing repair protocol is reference guidance only until the
installed CLI accepts this exact v8 project and advertises the selected recipe.
Do not execute per-project verification or writes after an unsupported-source
read/preview. Governance none stays disabled: no setup, assessment, activation
state or provider authority is created to use repair.
Require \`currentApplication.manifestVersion: 8\`, the selected supported profile,
and recipe \`application-active-layout-patch\` v1. Targets use explicit active
artifact bindings, not original generation paths. The current recipe does not
publish binding changes or transform infrastructure. The Azure recipe mentioned
in the shared protocol below is historical reference, not current v8 authority.
${renderRepairInstructions('application-active-layout-patch')}`;
  }
  if (operation === 'assessment') {
    return `${introduction}
## Read-only assessment

After actual source support is established, use only the installed CLI's
\`liftoff governance assess --json\` for local governance assessment.
Live reads need a separate explicit request and existing permissions; never
enroll credentials or broaden access. Explain reported target identity, observed
facts, coverage, differences and unknowns exactly. Source metadata is not an
assessment result or activation evidence, and missing evidence is not compliance.
Do not run project scripts, author patches, change settings or execute a recommendation.
Setup, repair, workflow/profile transition and deployed-state work have separate
approval boundaries. Stop after explaining the report.
`;
  }
  return `${introduction}
## Setup handoff

Read the exact policy.md, context.json, phase-graph.json and compatibility.json.
Compatibility5 says source-contract-only, not currently executable.
Follow only a supported CLI's actual returned nextActions and independently
approved scope; no unconditional apply journey is supplied here.
Honor local-only requests and declined later consent. Separate finite local
verification from repository publication, credential preparation, provider work,
live enforcement and later lifecycle retention.
Modern source-metadata2/task-projection creation is unavailable in this handoff.
Do not edit task checkboxes or fabricate liftoff-governance.json, plans, approvals,
successor state or evidence. Old phase success is not current proof.
If work fails, preserve actual progress and original history; recovery must name
its exact approved inventory. Never repeat an unchanged failure or silently restore an older identity.
`;
}
