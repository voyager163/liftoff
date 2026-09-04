import { canonicalJson, canonicalSha256, sha256Hex } from './canonical-json.js';
import {
  activationContractVersion,
  approvalEnvelopeSchemaVersion,
  buildActivationCompatibilityMap,
  createActivationIdentity,
  evidenceHeaderSchemaVersion,
  governanceActivationPolicyVersion,
  liftoffActivationPackageVersion,
  phaseGraphSchemaVersion
} from './identity.js';
import type {
  ActivationIdentity,
  ManagedPhaseGraph,
  MutationClass,
  PhaseGraphNode,
  PhaseId,
  LiveReadbackProvider,
  TerminalPhaseState
} from './types.js';

const terminalVerified = ['verified', 'failed'] as const satisfies readonly TerminalPhaseState[];
const terminalApproved = ['approved', 'failed'] as const satisfies readonly TerminalPhaseState[];
const terminalConditional = ['verified', 'failed', 'inapplicable'] as const satisfies readonly TerminalPhaseState[];

function dep(anyOf: readonly PhaseId[], description: string): PhaseGraphNode['dependencies'][number] {
  return { anyOf, accepts: ['approved', 'verified', 'inapplicable', 'retained', 'disposed'], description };
}

function mutations(
  local: readonly MutationClass[],
  remote: readonly MutationClass[] = ['none']
): PhaseGraphNode['allowedMutations'] {
  const normalizedLocal = [...local];
  if (
    normalizedLocal.includes('write-evidence') &&
    !normalizedLocal.includes('write-activation-state')
  ) {
    normalizedLocal.push('write-activation-state');
  }
  return { local: normalizedLocal, remote };
}

function evidence(
  schema: string,
  required = true,
  liveReadbackProviders: readonly LiveReadbackProvider[] = []
): PhaseGraphNode['evidence'] {
  return { schema, required, headerSchemaVersion: evidenceHeaderSchemaVersion, liveReadbackProviders };
}

function approval(kind: PhaseGraphNode['approvalGate']['kind'], required: boolean): PhaseGraphNode['approvalGate'] {
  return { kind, required, envelopeSchemaVersion: approvalEnvelopeSchemaVersion };
}

function rollback(kind: PhaseGraphNode['rollback']['kind'], target: PhaseId | null, description: string): PhaseGraphNode['rollback'] {
  return { kind, target, description };
}

export const canonicalPhaseGraph = {
  schemaVersion: phaseGraphSchemaVersion,
  versions: {
    liftoffVersion: liftoffActivationPackageVersion,
    policyVersion: governanceActivationPolicyVersion,
    activationContractVersion,
    phaseGraphSchemaVersion
  },
  phases: [
    {
      id: 'seed-valid',
      label: 'Generated bootstrap seed is strict-valid',
      dependencies: [],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['read-worktree', 'write-evidence']),
      evidence: evidence('seed-valid.v1'),
      approvalGate: approval('none', false),
      invalidationInputs: ['project-files', 'policy', 'activation-identity'],
      rollback: rollback('none', null, 'No mutation is authorized by seed validation.'),
      terminalStates: terminalVerified
    },
    {
      id: 'seed-verified',
      label: 'Generated bootstrap baseline checks are verified',
      dependencies: [dep(['seed-valid'], 'Seed strict validation must pass first.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['read-worktree', 'write-evidence']),
      evidence: evidence('seed-verified.v1'),
      approvalGate: approval('none', false),
      invalidationInputs: ['project-files', 'activation-identity'],
      rollback: rollback('none', null, 'A failed baseline leaves the seed active.'),
      terminalStates: terminalVerified
    },
    {
      id: 'seed-archived',
      label: 'Generated bootstrap seed is synced and archived',
      dependencies: [dep(['seed-verified'], 'Only a verified seed may be archived.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-openspec-seed', 'write-evidence']),
      evidence: evidence('seed-archived.v1'),
      approvalGate: approval('none', false),
      invalidationInputs: ['project-files', 'activation-identity'],
      rollback: rollback('none', null, 'Archive failures keep the seed active.'),
      terminalStates: terminalVerified
    },
    {
      id: 'committed',
      label: 'Initial repository baseline is committed',
      dependencies: [dep(['seed-archived'], 'Generated seed must be complete before commit guidance.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['read-worktree', 'git-commit', 'write-evidence']),
      evidence: evidence('committed.v1'),
      approvalGate: approval('repository-publish', true),
      invalidationInputs: ['baseline-sha', 'project-files', 'approval-envelope'],
      rollback: rollback('none', null, 'Never rewrite a committed user history automatically.'),
      terminalStates: terminalVerified
    },
    {
      id: 'pushed',
      label: 'Initial repository baseline is pushed',
      dependencies: [dep(['committed'], 'Commit evidence precedes initial push.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['read-worktree', 'write-evidence'], ['git-push', 'github-read']),
      evidence: evidence('pushed.v1'),
      approvalGate: approval('repository-publish', true),
      invalidationInputs: ['baseline-sha', 'approval-envelope'],
      rollback: rollback('none', null, 'Never force-push, delete, or rewrite refs.'),
      terminalStates: terminalVerified
    },
    {
      id: 'phase-0-complete',
      label: 'Read-only Phase 0 discovery is complete',
      dependencies: [dep(['pushed'], 'Remote repository identity must be resolvable.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-evidence'], ['github-read', 'azure-read']),
      evidence: evidence('phase-0-complete.v1'),
      approvalGate: approval('none', false),
      invalidationInputs: ['baseline-sha', 'policy', 'live-readback'],
      rollback: rollback('none', null, 'Discovery is read-only and can be refreshed.'),
      terminalStates: terminalVerified
    },
    {
      id: 'activation-approved',
      label: 'Governance activation plan is approved',
      dependencies: [dep(['phase-0-complete'], 'Approval reviews Phase 0 evidence.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-activation-state', 'write-evidence']),
      evidence: evidence('activation-approved.v1', false),
      approvalGate: approval('activation-plan', true),
      invalidationInputs: ['baseline-sha', 'approval-envelope', 'policy'],
      rollback: rollback('none', null, 'Approval expiry returns descendants to blocked.'),
      terminalStates: terminalApproved
    },
    {
      id: 'credential-ready',
      label: 'Runner preflight credential policy is ready when required',
      dependencies: [dep(['activation-approved'], 'Credential enrollment follows approved activation scope.')],
      applicability: {
        kind: 'conditional',
        discriminator: 'credential-required',
        when: 'credentialRequired=true',
        inapplicableWhen: 'credentialRequired=false',
        exclusiveWith: []
      },
      allowedMutations: mutations(['write-evidence'], ['github-secret-write', 'github-read']),
      evidence: evidence('credential-ready.v1', true, ['github']),
      approvalGate: approval('credential-enrollment', true),
      invalidationInputs: ['credentials', 'approval-envelope', 'activation-identity'],
      rollback: rollback('none', null, 'Leaked or expired credentials block use and require rotation.'),
      terminalStates: terminalConditional
    },
    {
      id: 'provider-ready',
      label: 'Azure provider namespaces are terminal ready',
      dependencies: [
        dep(['activation-approved'], 'Provider readiness belongs to approved infrastructure scope.'),
        dep(['credential-ready'], 'Runner preflight credential readiness or inapplicability precedes provider work.')
      ],
      applicability: {
        kind: 'conditional',
        discriminator: 'private-staging-dast',
        when: 'privateStagingDast=true',
        inapplicableWhen: 'privateStagingDast=false',
        exclusiveWith: []
      },
      allowedMutations: mutations(['write-evidence'], ['azure-read', 'azure-provider-register']),
      evidence: evidence('provider-ready.v1', true, ['azure']),
      approvalGate: approval('infrastructure-cost', true),
      invalidationInputs: ['provider-inventory', 'approval-envelope', 'policy'],
      rollback: rollback('retain', null, 'Provider registrations are retained subscription capabilities.'),
      terminalStates: ['verified', 'failed', 'inapplicable', 'retained']
    },
    {
      id: 'state-path-selected',
      label: 'Private state path is selected',
      dependencies: [dep(['provider-ready'], 'Provider readiness precedes private state path selection.')],
      applicability: {
        kind: 'conditional',
        discriminator: 'private-staging-dast',
        when: 'privateStagingDast=true',
        inapplicableWhen: 'privateStagingDast=false',
        exclusiveWith: []
      },
      allowedMutations: mutations(['write-activation-state', 'write-evidence'], ['azure-read']),
      evidence: evidence('state-path-selected.v1'),
      approvalGate: approval('infrastructure-cost', true),
      invalidationInputs: ['remote-state', 'provider-inventory', 'approval-envelope'],
      rollback: rollback('none', null, 'A changed path selection invalidates mutually exclusive descendants.'),
      terminalStates: terminalConditional
    },
    {
      id: 'existing-private-path',
      label: 'Existing private backend management path is verified',
      dependencies: [dep(['state-path-selected'], 'State path selection chooses this branch.')],
      applicability: {
        kind: 'conditional',
        discriminator: 'state-path',
        when: 'statePath=existing-private',
        inapplicableWhen: 'statePath!=existing-private',
        exclusiveWith: ['bootstrap-local']
      },
      allowedMutations: mutations(['write-evidence'], ['azure-read']),
      evidence: evidence('existing-private-path.v1'),
      approvalGate: approval('none', false),
      invalidationInputs: ['remote-state', 'live-readback'],
      rollback: rollback('none', null, 'Existing path verification is read-only.'),
      terminalStates: terminalConditional
    },
    {
      id: 'bootstrap-local',
      label: 'Bounded local bootstrap creates access-establishing resources',
      dependencies: [
        dep(['provider-ready'], 'Provider readiness precedes local bootstrap.'),
        dep(['state-path-selected'], 'State path selection precedes local bootstrap.')
      ],
      applicability: {
        kind: 'conditional',
        discriminator: 'state-path',
        when: 'statePath=bootstrap-local',
        inapplicableWhen: 'statePath!=bootstrap-local',
        exclusiveWith: ['existing-private-path']
      },
      allowedMutations: mutations(['write-local-state', 'write-evidence'], ['azure-network-provision', 'github-write']),
      evidence: evidence('bootstrap-local.v1', true, ['github', 'azure']),
      approvalGate: approval('infrastructure-cost', true),
      invalidationInputs: ['approval-envelope', 'provider-inventory', 'remote-state'],
      rollback: rollback('reverse-to', 'provider-ready', 'Remove only repository-owned bootstrap resources in dependency order.'),
      terminalStates: terminalConditional
    },
    {
      id: 'runner-ready',
      label: 'Restricted larger runner is assigned and ready',
      dependencies: [dep(['bootstrap-local'], 'Local bootstrap must establish runner networking before runner proof.')],
      applicability: {
        kind: 'conditional',
        discriminator: 'state-path',
        when: 'statePath=bootstrap-local',
        inapplicableWhen: 'statePath!=bootstrap-local',
        exclusiveWith: []
      },
      allowedMutations: mutations(['write-evidence'], ['github-read', 'github-write']),
      evidence: evidence('runner-ready.v1', true, ['github']),
      approvalGate: approval('infrastructure-cost', true),
      invalidationInputs: ['runner-inventory', 'approval-envelope'],
      rollback: rollback('reverse-to', 'bootstrap-local', 'Remove repository runner assignment before network resources.'),
      terminalStates: terminalConditional
    },
    {
      id: 'private-backend-proof',
      label: 'Private backend is reachable from runner',
      dependencies: [dep(['runner-ready'], 'Runner readiness precedes private backend proof.')],
      applicability: {
        kind: 'conditional',
        discriminator: 'state-path',
        when: 'statePath=bootstrap-local',
        inapplicableWhen: 'statePath!=bootstrap-local',
        exclusiveWith: []
      },
      allowedMutations: mutations(['write-evidence'], ['github-read', 'azure-read']),
      evidence: evidence('private-backend-proof.v1'),
      approvalGate: approval('none', false),
      invalidationInputs: ['runner-inventory', 'remote-state', 'live-readback'],
      rollback: rollback('reverse-to', 'runner-ready', 'Failed proof keeps remote import blocked.'),
      terminalStates: terminalConditional
    },
    {
      id: 'remote-import-verified',
      label: 'Declarative remote import and no-change plan are verified',
      dependencies: [dep(['private-backend-proof'], 'Private backend proof precedes remote import.')],
      applicability: {
        kind: 'conditional',
        discriminator: 'state-path',
        when: 'statePath=bootstrap-local',
        inapplicableWhen: 'statePath!=bootstrap-local',
        exclusiveWith: []
      },
      allowedMutations: mutations(['write-evidence'], ['azure-state-import']),
      evidence: evidence('remote-import-verified.v1', true, ['azure']),
      approvalGate: approval('infrastructure-cost', true),
      invalidationInputs: ['remote-state', 'approval-envelope'],
      rollback: rollback('reverse-to', 'private-backend-proof', 'Failed import leaves local state retained for remediation.'),
      terminalStates: terminalConditional
    },
    {
      id: 'remote-ready',
      label: 'Remote state is ready and local bootstrap state is frozen',
      dependencies: [dep(['existing-private-path', 'remote-import-verified'], 'Remote readiness follows either existing private path or verified remote import.')],
      applicability: {
        kind: 'conditional',
        discriminator: 'private-staging-dast',
        when: 'privateStagingDast=true',
        inapplicableWhen: 'privateStagingDast=false',
        exclusiveWith: []
      },
      allowedMutations: mutations(['write-evidence'], ['azure-read']),
      evidence: evidence('remote-ready.v1'),
      approvalGate: approval('none', false),
      invalidationInputs: ['remote-state', 'live-readback'],
      rollback: rollback('retain', null, 'Retain local bootstrap state read-only for exactly 30 days when used.'),
      terminalStates: ['verified', 'failed', 'inapplicable', 'retained']
    },
    {
      id: 'application-foundation',
      label: 'Application infrastructure foundation is reconciled',
      dependencies: [dep(['remote-ready'], 'Application resources wait for remote state readiness or inapplicability.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-evidence', 'write-openspec-governance'], ['azure-resource-provision']),
      evidence: evidence('application-foundation.v1', true, ['azure']),
      approvalGate: approval('infrastructure-cost', true),
      invalidationInputs: ['project-files', 'remote-state', 'approval-envelope'],
      rollback: rollback('reverse-to', 'remote-ready', 'Application resources are removed without unregistering providers.'),
      terminalStates: terminalVerified
    },
    {
      id: 'workflow-source-ready',
      label: 'Workflow source and ruleset payloads are ready',
      dependencies: [dep(['application-foundation'], 'Workflow source targets the reconciled application foundation.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-workflows', 'write-ruleset-source', 'write-evidence']),
      evidence: evidence('workflow-source-ready.v1'),
      approvalGate: approval('none', false),
      invalidationInputs: ['project-files', 'policy'],
      rollback: rollback('reverse-to', 'application-foundation', 'Remove or repair only workflow/ruleset source changes.'),
      terminalStates: terminalVerified
    },
    {
      id: 'dev-proof',
      label: 'Development proof is green',
      dependencies: [dep(['workflow-source-ready'], 'Workflow source must exist before proving checks.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-evidence'], ['github-read']),
      evidence: evidence('dev-proof.v1'),
      approvalGate: approval('none', false),
      invalidationInputs: ['workflow-source', 'project-files'],
      rollback: rollback('none', null, 'A failed check blocks descendants until fixed.'),
      terminalStates: terminalVerified
    },
    {
      id: 'staging-qualified',
      label: 'Staging release qualification is complete',
      dependencies: [dep(['dev-proof'], 'Development proof precedes staging qualification.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-evidence'], ['github-read', 'azure-read']),
      evidence: evidence('staging-qualified.v1'),
      approvalGate: approval('none', false),
      invalidationInputs: ['workflow-source', 'security-evidence', 'live-readback'],
      rollback: rollback('none', null, 'Qualification failures keep production blocked.'),
      terminalStates: terminalVerified
    },
    {
      id: 'production-rehearsed',
      label: 'Production promotion and rollback are rehearsed',
      dependencies: [dep(['staging-qualified'], 'Only a staging-qualified candidate may be rehearsed.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-evidence'], ['github-read', 'azure-read']),
      evidence: evidence('production-rehearsed.v1'),
      approvalGate: approval('none', false),
      invalidationInputs: ['live-readback', 'workflow-source'],
      rollback: rollback('none', null, 'Rollback remains ungated and documented.'),
      terminalStates: terminalVerified
    },
    {
      id: 'green-red-proof',
      label: 'Required checks are proven green and deliberately red',
      dependencies: [dep(['production-rehearsed'], 'Promotion rehearsal precedes final context proof.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-evidence'], ['github-read']),
      evidence: evidence('green-red-proof.v1'),
      approvalGate: approval('none', false),
      invalidationInputs: ['security-evidence', 'workflow-source'],
      rollback: rollback('none', null, 'Missing red proof prevents enforcement.'),
      terminalStates: terminalVerified
    },
    {
      id: 'enforcement-approved',
      label: 'Final ruleset enforcement is approved',
      dependencies: [dep(['green-red-proof'], 'Only exact green/red evidence may request enforcement.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-activation-state', 'write-evidence']),
      evidence: evidence('enforcement-approved.v1', false),
      approvalGate: approval('enforcement', true),
      invalidationInputs: ['approval-envelope', 'ruleset-readback'],
      rollback: rollback('none', null, 'Approval expiry blocks ruleset application.'),
      terminalStates: terminalApproved
    },
    {
      id: 'rulesets-applied',
      label: 'Repository rulesets are applied idempotently last',
      dependencies: [dep(['enforcement-approved'], 'Final enforcement approval precedes ruleset mutation.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-evidence'], ['github-ruleset-write', 'github-read']),
      evidence: evidence('rulesets-applied.v1', true, ['github']),
      approvalGate: approval('enforcement', true),
      invalidationInputs: ['approval-envelope', 'ruleset-readback'],
      rollback: rollback('reverse-to', 'green-red-proof', 'Rulesets can be disabled or repaired without approval-gating rollback.'),
      terminalStates: terminalVerified
    },
    {
      id: 'live-readback',
      label: 'Live enforcement readback matches source',
      dependencies: [dep(['rulesets-applied'], 'Live readback follows ruleset application.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-evidence'], ['github-read']),
      evidence: evidence('live-readback.v1'),
      approvalGate: approval('none', false),
      invalidationInputs: ['ruleset-readback', 'live-readback'],
      rollback: rollback('reverse-to', 'rulesets-applied', 'Mismatched live readback blocks completion.'),
      terminalStates: terminalVerified
    },
    {
      id: 'bootstrap-state-disposed',
      label: 'Retained local bootstrap state is disposed after day 30',
      dependencies: [dep(['live-readback'], 'Disposal is scheduled only after live enforcement readback.')],
      applicability: {
        kind: 'conditional',
        discriminator: 'state-path',
        when: 'statePath=bootstrap-local',
        inapplicableWhen: 'statePath!=bootstrap-local',
        exclusiveWith: []
      },
      allowedMutations: mutations(['delete-local-state', 'write-evidence']),
      evidence: evidence('bootstrap-state-disposed.v1'),
      approvalGate: approval('destructive-disposal', true),
      invalidationInputs: ['remote-state', 'approval-envelope'],
      rollback: rollback('dispose', null, 'Deletion destroys only the local encryption key and records no payload.'),
      terminalStates: ['disposed', 'failed', 'inapplicable']
    }
  ]
} as const satisfies ManagedPhaseGraph;

export type CanonicalPhaseGraph = typeof canonicalPhaseGraph;

function phaseBehavior(node: PhaseGraphNode): Omit<PhaseGraphNode, 'label'> {
  return {
    id: node.id,
    dependencies: node.dependencies,
    applicability: node.applicability,
    allowedMutations: node.allowedMutations,
    evidence: node.evidence,
    approvalGate: node.approvalGate,
    invalidationInputs: node.invalidationInputs,
    rollback: node.rollback,
    terminalStates: node.terminalStates
  };
}

export function phaseContractDigest(node: PhaseGraphNode): string {
  return sha256Hex(canonicalJson(phaseBehavior(node)));
}

export function phaseContractDigests(
  graph: ManagedPhaseGraph = canonicalPhaseGraph
): Record<PhaseId, string> {
  return Object.fromEntries(
    graph.phases.map((node) => [node.id, phaseContractDigest(node)])
  ) as Record<PhaseId, string>;
}

export const canonicalPhaseGraphJson = canonicalJson(canonicalPhaseGraph);
export const canonicalPhaseGraphHash = canonicalSha256(canonicalPhaseGraph);
export const canonicalPhaseContractDigests = phaseContractDigests(canonicalPhaseGraph);
export const currentActivationIdentity: ActivationIdentity = createActivationIdentity(canonicalPhaseGraphHash);
export const activationCompatibility = buildActivationCompatibilityMap([
  currentActivationIdentity
]);
