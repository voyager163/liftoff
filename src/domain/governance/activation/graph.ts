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
} from '../policy/identity.js';
import type {
  ActivationIdentity,
  ManagedPhaseGraph,
  MutationClass,
  PhaseGraphNode,
  PhaseId,
  LiveReadbackProvider,
  TerminalPhaseState
} from './types.js';
import { activationPhaseIds, lifecyclePhaseIds, localSetupPhaseIds, repositoryPhaseIds, sharedPublicationPhaseIds } from './types.js';

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
  return { local: normalizedLocal.filter((mutation) => mutation !== 'none'), remote };
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

const nonGovernanceTaskPhases = new Set<string>([
  'seed-valid',
  'seed-verified',
  'seed-archived',
  'committed',
  'pushed',
  'phase-0-complete'
]);

const rawPhases: readonly PhaseGraphNode[] = [
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
      allowedMutations: mutations(['read-worktree', 'write-seed-tasks', 'write-evidence']),
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
      allowedMutations: mutations(['read-worktree', 'write-openspec-seed', 'write-evidence']),
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
      allowedMutations: mutations(['read-worktree', 'git-remote-bind', 'write-evidence'], ['git-push', 'github-read', 'github-repository-create', 'github-write']),
      evidence: evidence('pushed.v1', true, ['github']),
      approvalGate: approval('repository-publish', true),
      invalidationInputs: ['baseline-sha', 'approval-envelope'],
      rollback: rollback('none', null, 'Never force-push, delete, or rewrite refs.'),
      terminalStates: terminalVerified
    },
    {
      id: 'repository-discovered',
      label: 'Repository identity, source refs and governance capabilities are observed',
      dependencies: [dep(['pushed'], 'The actual reviewed publication must be independently verified.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-evidence'], ['github-read']),
      evidence: evidence('repository-discovered.v1', true, ['github']),
      approvalGate: approval('none', false),
      invalidationInputs: ['baseline-sha', 'policy', 'live-readback'],
      rollback: rollback('none', null, 'Repository discovery cannot access Azure or change provider controls.'),
      terminalStates: terminalVerified
    },
    {
      id: 'repository-workflow-source-ready',
      label: 'Reviewed source-validation workflows are published through permitted GitFlow PRs',
      dependencies: [dep(['repository-discovered'], 'Workflow publication requires exact repository/ref/control discovery.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['read-worktree', 'write-workflows', 'write-ruleset-source', 'git-commit', 'write-evidence'], ['github-read', 'github-write', 'git-push']),
      evidence: evidence('repository-workflow-source-ready.v1', true, ['github']),
      approvalGate: approval('repository-publish', true),
      invalidationInputs: ['workflow-source', 'baseline-sha', 'approval-envelope', 'live-readback'],
      rollback: rollback('retain', null, 'Retain unmerged reviewed PRs and published commits; never bypass or force protected branches.'),
      terminalStates: terminalVerified
    },
    {
      id: 'repository-checks-qualified',
      label: 'Real source-validation checks pass and reject controlled unmerged negative fixtures',
      dependencies: [dep(['repository-workflow-source-ready'], 'Qualification binds the published workflow, source, actor, ref and exact jobs.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-evidence'], ['github-read', 'github-workflow-dispatch', 'github-write', 'git-push']),
      evidence: evidence('repository-checks-qualified.v1', true, ['github']),
      approvalGate: approval('repository-publish', true),
      invalidationInputs: ['workflow-source', 'baseline-sha', 'approval-envelope', 'security-evidence'],
      rollback: rollback('retain', null, 'Keep exact operation IDs and unmerged fixtures; infrastructure failure is not controlled negative proof.'),
      terminalStates: terminalVerified
    },
    {
      id: 'repository-enforcement-approved',
      label: 'Exact repository controls and any separately selected main hold are approved',
      dependencies: [dep(['repository-checks-qualified'], 'Actual repository-only check evidence precedes enforcement review.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-activation-state', 'write-evidence']),
      evidence: evidence('repository-enforcement-approved.v1', false),
      approvalGate: approval('enforcement', true),
      invalidationInputs: ['approval-envelope', 'ruleset-readback', 'baseline-sha', 'policy'],
      rollback: rollback('none', null, 'Approval cannot authorize production qualification or removal of foreign controls.'),
      terminalStates: terminalApproved
    },
    {
      id: 'repository-rulesets-applied',
      label: 'Approved owned repository controls are reconciled and individually read back',
      dependencies: [dep(['repository-enforcement-approved'], 'A current exact repository enforcement approval precedes each write.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-evidence'], ['github-ruleset-write', 'github-write', 'github-read']),
      evidence: evidence('repository-rulesets-applied.v1', true, ['github']),
      approvalGate: approval('enforcement', true),
      invalidationInputs: ['approval-envelope', 'ruleset-readback', 'baseline-sha'],
      rollback: rollback('retain', null, 'Retain protections after partial failure; recovery never automatically disables or deletes them.'),
      terminalStates: terminalVerified
    },
    {
      id: 'repository-live-readback',
      label: 'Repository enforcement is independently verified without production activation',
      dependencies: [dep(['repository-rulesets-applied'], 'Readback must observe the approved owned controls and unchanged main baseline.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-evidence'], ['github-read']),
      evidence: evidence('repository-live-readback.v1', true, ['github']),
      approvalGate: approval('none', false),
      invalidationInputs: ['ruleset-readback', 'live-readback', 'baseline-sha'],
      rollback: rollback('retain', null, 'A mismatch blocks repository completion without removing protection.'),
      terminalStates: terminalVerified
    },
    {
      id: 'phase-0-complete',
      label: 'Read-only Phase 0 discovery is complete',
      dependencies: [dep(['pushed'], 'Remote repository identity must be resolvable.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-evidence'], ['github-read', 'azure-read']),
      evidence: evidence('phase-0-complete.v1', true, ['github', 'azure']),
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
      allowedMutations: mutations(['write-openspec-governance', 'write-activation-state', 'write-evidence']),
      evidence: evidence('activation-approved.v1', false),
      approvalGate: approval('activation-plan', true),
      invalidationInputs: ['baseline-sha', 'approval-envelope', 'policy'],
      rollback: rollback('none', null, 'Approval expiry returns descendants to blocked.'),
      terminalStates: terminalApproved
    },
    {
      id: 'bootstrap-workflow-source-ready',
      label: 'Scoped bootstrap verification workflows are published',
      dependencies: [dep(['activation-approved'], 'Bootstrap workflow publication requires the reviewed activation scope.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['read-worktree', 'write-workflows', 'git-commit', 'write-evidence'], ['git-push', 'github-read', 'github-write']),
      evidence: evidence('bootstrap-workflow-source-ready.v1', true, ['github']),
      approvalGate: approval('repository-publish', true),
      invalidationInputs: ['workflow-source', 'approval-envelope', 'baseline-sha'],
      rollback: rollback('none', null, 'Preserve published history; repair only the approved workflow scope.'),
      terminalStates: terminalVerified
    },
    {
      id: 'credential-ready',
      label: 'Runner preflight credential policy is ready when required',
      dependencies: [dep(['bootstrap-workflow-source-ready'], 'Credential use is verified through the published approved bootstrap workflow.')],
      applicability: {
        kind: 'conditional',
        discriminator: 'credential-required',
        when: 'credentialRequired=true',
        inapplicableWhen: 'credentialRequired=false',
        exclusiveWith: []
      },
      allowedMutations: mutations(['write-credential-policy', 'write-evidence'], ['github-secret-write', 'github-read', 'github-workflow-dispatch', 'github-write']),
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
      applicability: { kind: 'always' },
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
        discriminator: 'cloud-state-required',
        when: 'cloudStateRequired=true',
        inapplicableWhen: 'cloudStateRequired=false',
        exclusiveWith: []
      },
      allowedMutations: mutations(['write-activation-state', 'write-evidence'], ['azure-read']),
      evidence: evidence('state-path-selected.v1', true, ['azure']),
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
      allowedMutations: mutations(['write-evidence'], ['azure-read', 'github-read', 'backend-state-read']),
      evidence: evidence('existing-private-path.v1', true, ['azure']),
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
      allowedMutations: mutations(['read-worktree', 'write-local-state', 'write-evidence'], ['azure-network-provision', 'azure-read']),
      evidence: evidence('bootstrap-local.v1', true, ['azure']),
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
      allowedMutations: mutations(['write-evidence'], ['github-read', 'github-write', 'github-workflow-dispatch']),
      evidence: evidence('runner-ready.v1', true, ['github']),
      approvalGate: approval('infrastructure-cost', true),
      invalidationInputs: ['runner-inventory', 'approval-envelope'],
      rollback: rollback('reverse-to', 'bootstrap-local', 'Remove repository runner assignment before network resources.'),
      terminalStates: terminalConditional
    },
    {
      id: 'private-backend-proof',
      label: 'Private backend identity and exclusive lease protocol are proven from the assigned runner',
      dependencies: [dep(['runner-ready'], 'Runner readiness precedes private backend proof.')],
      applicability: {
        kind: 'conditional',
        discriminator: 'state-path',
        when: 'statePath=bootstrap-local',
        inapplicableWhen: 'statePath!=bootstrap-local',
        exclusiveWith: []
      },
      allowedMutations: mutations(['write-evidence'], ['github-read', 'github-workflow-dispatch', 'azure-read', 'backend-state-read', 'backend-state-write']),
      evidence: evidence('private-backend-proof.v1', true, ['github', 'azure']),
      approvalGate: approval('activation-plan', true),
      invalidationInputs: ['runner-inventory', 'remote-state', 'live-readback', 'approval-envelope'],
      rollback: rollback('retain', null, 'Only the exact accepted probe lease may be released within its reviewed cleanup window; retain unknown outcomes and never break a lease or mutate state content.'),
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
      allowedMutations: mutations(['write-evidence'], ['azure-state-import', 'azure-read', 'backend-state-read', 'backend-state-write']),
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
        discriminator: 'cloud-state-required',
        when: 'cloudStateRequired=true',
        inapplicableWhen: 'cloudStateRequired=false',
        exclusiveWith: []
      },
      allowedMutations: mutations(['write-evidence'], ['azure-read', 'backend-state-read']),
      evidence: evidence('remote-ready.v1'),
      approvalGate: approval('none', false),
      invalidationInputs: ['remote-state', 'live-readback'],
      rollback: rollback('retain', null, 'Retain local bootstrap state read-only for exactly 30 days when used.'),
      terminalStates: ['verified', 'failed', 'inapplicable', 'retained']
    },
    {
      id: 'application-prerequisites-ready',
      label: 'Application registry and workload identity prerequisites are ready',
      dependencies: [dep(['remote-ready'], 'Registry and identity prerequisites require verified backend readiness.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['read-worktree', 'write-local-state', 'write-evidence', 'write-openspec-governance'], ['azure-resource-provision', 'azure-read', 'backend-state-read', 'backend-state-write']),
      evidence: evidence('application-prerequisites-ready.v1', true, ['azure']),
      approvalGate: approval('infrastructure-cost', true),
      invalidationInputs: ['project-files', 'remote-state', 'approval-envelope'],
      rollback: rollback('reverse-to', 'remote-ready', 'Compensate only owned prerequisites within the approved recovery scope.'),
      terminalStates: terminalVerified
    },
    {
      id: 'workflow-source-ready',
      label: 'Application workflow source and ruleset payloads are published through reviewed GitFlow PRs',
      dependencies: [dep(['application-prerequisites-ready'], 'Workflow source binds the verified registry and workload identities.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['read-worktree', 'write-workflows', 'write-ruleset-source', 'write-evidence'], ['github-read', 'github-write', 'git-push']),
      evidence: evidence('workflow-source-ready.v1', true, ['github']),
      approvalGate: approval('repository-publish', true),
      invalidationInputs: ['project-files', 'workflow-source', 'approval-envelope', 'policy'],
      rollback: rollback('retain', null, 'Retain reviewed PRs and published commits; recovery never bypasses protected refs or rewrites Git history.'),
      terminalStates: terminalVerified
    },
    {
      id: 'application-artifact-ready',
      label: 'Immutable application artifacts are built and published from approved source',
      dependencies: [dep(['workflow-source-ready'], 'The reviewed build workflow must be published before artifact production.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['read-worktree', 'write-evidence'], ['github-read', 'github-workflow-dispatch', 'registry-publish', 'azure-read']),
      evidence: evidence('application-artifact-ready.v1', true, ['github', 'azure']),
      approvalGate: approval('infrastructure-cost', true),
      invalidationInputs: ['project-files', 'workflow-source', 'approval-envelope'],
      rollback: rollback('retain', null, 'Keep immutable published artifacts; never replace an existing digest.'),
      terminalStates: terminalVerified
    },
    {
      id: 'application-foundation',
      label: 'Application infrastructure is deployed with the verified immutable artifact',
      dependencies: [dep(['application-artifact-ready'], 'Deployment requires real source-bound immutable application artifacts.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['read-worktree', 'write-local-state', 'write-evidence', 'write-openspec-governance'], ['azure-resource-provision', 'azure-read', 'backend-state-read', 'backend-state-write']),
      evidence: evidence('application-foundation.v1', true, ['azure']),
      approvalGate: approval('infrastructure-cost', true),
      invalidationInputs: ['project-files', 'remote-state', 'approval-envelope'],
      rollback: rollback('reverse-to', 'application-artifact-ready', 'Recover only approved owned resources; never unregister shared providers.'),
      terminalStates: terminalVerified
    },
    {
      id: 'dev-proof',
      label: 'Development proof is green',
      dependencies: [dep(['application-foundation'], 'The real application deployment precedes development proof.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['read-worktree', 'write-evidence'], ['github-read', 'github-workflow-dispatch', 'azure-read', 'backend-state-read']),
      evidence: evidence('dev-proof.v1', true, ['github', 'azure']),
      approvalGate: approval('activation-plan', true),
      invalidationInputs: ['workflow-source', 'project-files'],
      rollback: rollback('none', null, 'A failed check blocks descendants until fixed.'),
      terminalStates: terminalVerified
    },
    {
      id: 'staging-qualified',
      label: 'Staging release qualification is complete',
      dependencies: [dep(['dev-proof'], 'Development proof precedes staging qualification.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['read-worktree', 'write-local-state', 'write-evidence'], ['github-read', 'github-workflow-dispatch', 'azure-read', 'azure-resource-provision', 'backend-state-read', 'backend-state-write', 'registry-publish']),
      evidence: evidence('staging-qualified.v1', true, ['github', 'azure']),
      approvalGate: approval('infrastructure-cost', true),
      invalidationInputs: ['workflow-source', 'security-evidence', 'live-readback'],
      rollback: rollback('none', null, 'Qualification failures keep production blocked.'),
      terminalStates: terminalVerified
    },
    {
      id: 'production-rehearsed',
      label: 'Production promotion and rollback are rehearsed',
      dependencies: [dep(['staging-qualified'], 'Only a staging-qualified candidate may be rehearsed.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['read-worktree', 'write-local-state', 'write-evidence'], ['github-read', 'github-workflow-dispatch', 'azure-read', 'azure-resource-provision', 'backend-state-read', 'backend-state-write', 'registry-publish']),
      evidence: evidence('production-rehearsed.v1', true, ['github', 'azure']),
      approvalGate: approval('infrastructure-cost', true),
      invalidationInputs: ['live-readback', 'workflow-source'],
      rollback: rollback('retain', null, 'Execute only the exact separately approved bounded rollback plan; retain partial or uncertain rollout/rollback effects without cross-provider atomicity claims.'),
      terminalStates: terminalVerified
    },
    {
      id: 'green-red-proof',
      label: 'Required checks are proven green and deliberately red',
      dependencies: [dep(['production-rehearsed'], 'Promotion rehearsal precedes final context proof.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-evidence'], ['github-read', 'github-workflow-dispatch', 'github-write', 'git-push']),
      evidence: evidence('green-red-proof.v1', true, ['github']),
      approvalGate: approval('repository-publish', true),
      invalidationInputs: ['security-evidence', 'workflow-source', 'approval-envelope', 'baseline-sha'],
      rollback: rollback('retain', null, 'Retain exact unmerged controlled fixture refs and provider operation IDs; never bypass protected branches or replace production proof with repository-only checks.'),
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
      label: 'Approved owned repository settings and rulesets are applied idempotently last',
      dependencies: [dep(['enforcement-approved'], 'Final enforcement approval precedes ruleset mutation.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-evidence'], ['github-ruleset-write', 'github-write', 'github-read']),
      evidence: evidence('rulesets-applied.v1', true, ['github']),
      approvalGate: approval('enforcement', true),
      invalidationInputs: ['approval-envelope', 'ruleset-readback'],
      rollback: rollback('retain', null, 'Keep protections and recorded partial effects; changing controls requires a fresh exact approval.'),
      terminalStates: terminalVerified
    },
    {
      id: 'live-readback',
      label: 'Live enforcement readback matches source',
      dependencies: [dep(['rulesets-applied'], 'Live readback follows ruleset application.')],
      applicability: { kind: 'always' },
      allowedMutations: mutations(['write-evidence'], ['github-read']),
      evidence: evidence('live-readback.v1', true, ['github']),
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
  ] as const;

export const canonicalPhaseGraph = {
  schemaVersion: phaseGraphSchemaVersion,
  versions: {
    liftoffVersion: liftoffActivationPackageVersion,
    policyVersion: governanceActivationPolicyVersion,
    activationContractVersion,
    phaseGraphSchemaVersion
  },
  completionGroups: {
    local: localSetupPhaseIds,
    repository: [...sharedPublicationPhaseIds, ...repositoryPhaseIds],
    activation: activationPhaseIds,
    lifecycle: lifecyclePhaseIds
  },
  phases: rawPhases
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
