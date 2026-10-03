import type * as Records from './record-contracts.js';
import type {
  ApprovalResourceValueV1, ApprovalDestinationValueV1, ApprovalCostValueV1
} from './approval-values.js';

export const phaseIds = [
  'seed-valid',
  'seed-verified',
  'seed-archived',
  'committed',
  'pushed',
  'phase-0-complete',
  'activation-approved',
  'bootstrap-workflow-source-ready',
  'credential-ready',
  'provider-ready',
  'state-path-selected',
  'existing-private-path',
  'bootstrap-local',
  'runner-ready',
  'private-backend-proof',
  'remote-import-verified',
  'remote-ready',
  'application-prerequisites-ready',
  'workflow-source-ready',
  'application-artifact-ready',
  'application-foundation',
  'dev-proof',
  'staging-qualified',
  'production-rehearsed',
  'green-red-proof',
  'enforcement-approved',
  'rulesets-applied',
  'live-readback',
  'bootstrap-state-disposed'
] as const;

export type PhaseId = typeof phaseIds[number];

export const governanceScopes = ['local', 'activation', 'lifecycle'] as const;
export type GovernanceScope = typeof governanceScopes[number];

export const localSetupPhaseIds = ['seed-valid', 'seed-verified', 'seed-archived'] as const satisfies readonly PhaseId[];
export const lifecyclePhaseIds = ['bootstrap-state-disposed'] as const satisfies readonly PhaseId[];
export const activationPhaseIds: readonly PhaseId[] = phaseIds.filter((id) =>
  !(localSetupPhaseIds as readonly PhaseId[]).includes(id) && !(lifecyclePhaseIds as readonly PhaseId[]).includes(id)
);

export function phaseScope(phaseId: PhaseId): GovernanceScope {
  if ((localSetupPhaseIds as readonly PhaseId[]).includes(phaseId)) return 'local';
  if ((lifecyclePhaseIds as readonly PhaseId[]).includes(phaseId)) return 'lifecycle';
  return 'activation';
}

export const phaseStates = [
  'pending',
  'blocked',
  'ready',
  'approved',
  'running',
  'verified',
  'failed',
  'inapplicable',
  'retained',
  'disposed'
] as const;

export type PhaseState = typeof phaseStates[number];
export type TerminalPhaseState = Extract<
  PhaseState,
  'approved' | 'verified' | 'failed' | 'inapplicable' | 'retained' | 'disposed'
>;

export const mutationClasses = [
  'none',
  'read-worktree',
  'write-activation-state',
  'write-evidence',
  'write-openspec-seed',
  'write-seed-tasks',
  'project-governance-tasks',
  'write-openspec-governance',
  'write-local-state',
  'delete-local-state',
  'write-workflows',
  'write-ruleset-source',
  'write-credential-policy',
  'git-commit',
  'git-remote-bind',
  'git-push',
  'github-read',
  'github-write',
  'github-repository-create',
  'github-workflow-dispatch',
  'github-secret-write',
  'registry-publish',
  'backend-state-read',
  'backend-state-write',
  'azure-read',
  'azure-provider-register',
  'azure-network-provision',
  'azure-state-import',
  'azure-resource-provision',
  'github-ruleset-write'
] as const;

export type MutationClass = typeof mutationClasses[number];

export const approvalGateKinds = [
  'none',
  'repository-publish',
  'activation-plan',
  'credential-enrollment',
  'infrastructure-cost',
  'enforcement',
  'destructive-disposal',
  'external-blocker'
] as const;

export type ApprovalGateKind = typeof approvalGateKinds[number];

export const humanAuthorityQuestionKinds = [
  'repository-creation-initial-commit-push',
  'credential-enrollment',
  'billed-infrastructure-policy-exception-cost-ceiling',
  'final-enforcement',
  'destructive-operation',
  'external-blocker'
] as const;

export type HumanAuthorityQuestionKind = typeof humanAuthorityQuestionKinds[number];

export const invalidationInputKinds = [
  'activation-identity',
  'graph-hash',
  'baseline-sha',
  'project-files',
  'policy',
  'approval-envelope',
  'credentials',
  'provider-inventory',
  'runner-inventory',
  'remote-state',
  'workflow-source',
  'live-readback',
  'security-evidence',
  'ruleset-readback'
] as const;

export type InvalidationInputKind = typeof invalidationInputKinds[number];

export const rollbackKinds = ['none', 'retain', 'reverse-to', 'dispose'] as const;
export type RollbackKind = typeof rollbackKinds[number];

export interface ActivationIdentity extends Records.ActivationIdentityFieldsV1 {}

export interface GraphVersionIdentity extends Records.GraphVersionIdentityFieldsV2 {}

export interface PhaseDependency extends Records.PhaseDependencyFieldsV2<PhaseId> {}

export type PhaseApplicability = Records.PhaseApplicabilityFieldsV2<PhaseId>;

export interface ApprovalGate extends Records.ApprovalGateFieldsV3 {}

export interface AllowedMutations extends Records.AllowedMutationsFieldsV3 {}

export type LiveReadbackProvider = 'github' | 'azure';

export interface EvidenceRequirement extends Records.EvidenceRequirementFieldsV3 {}

export interface RollbackBehavior extends Records.RollbackBehaviorFieldsV2<PhaseId> {}

export interface PhaseGraphNode extends Records.PhaseGraphNodeFieldsV2<PhaseId> {}

export interface ManagedPhaseGraph extends Records.ManagedPhaseGraphFieldsV2<PhaseId> {}

export interface ActivationConfiguration extends Records.ActivationConfigurationFieldsV1<PhaseId> {}

export interface ExternalOperationState extends Records.ExternalOperationStateFieldsV1 {}

export interface PlannedFileChange extends Records.PlannedFileChangeFieldsV1 {}

export interface InputTransitionBinding extends Records.InputTransitionBindingFieldsV1 {}

export type GovernanceTaskProjectionContract = {
  schemaVersion: 1;
  derivation: 'validated-current-readiness';
  changeId: string;
  workflowKind: 'openspec' | 'spec-kit';
  taskPathParts: readonly string[];
  metadataPathParts: readonly string[];
  metadataHash: string;
  layoutHash: string;
} & (
  | { source: 'existing' }
  | { source: 'create'; template: string; metadataText: string }
);

export interface GovernanceTaskProjectionRecord extends Records.GovernanceTaskProjectionRecordFieldsV1<PhaseId> {}

export interface PhaseOutputBindings extends Records.PhaseOutputBindingsFieldsV1 {}

export interface EvidenceReference extends Records.EvidenceReferenceFieldsV3<PhaseId> {}

export interface EvidenceTransitionIdentity extends Records.EvidenceTransitionIdentityFieldsV3<PhaseId> {}

export interface PhaseExecutionState extends Records.PhaseExecutionStateFieldsV3<PhaseId> {}

export interface ActivationSuccessorHistory extends Records.ActivationSuccessorHistoryFieldsV1 {}

export interface UserActivationState extends Records.UserActivationStateFieldsV3<ActivationIdentity, PhaseId> {}

export interface EvidenceHeader extends Records.EvidenceHeaderFieldsV3<ActivationIdentity, PhaseId> {}

export interface LiveReadbackProof extends Records.LiveReadbackProofFieldsV3<ActivationIdentity, PhaseId> {}

export interface PhaseEvidenceRecord extends Records.PhaseEvidenceRecordFieldsV3<ActivationIdentity, PhaseId> {}

export type TransitionAdapterId =
  | 'local-evidence'
  | 'selected-spec-workflow'
  | 'git'
  | 'github'
  | 'azure-opentofu'
  | 'local-state';

export interface TransitionOperationDestination extends Records.TransitionOperationDestinationFieldsV1 {}

export interface TransitionOperation extends Records.TransitionOperationFieldsV2<PhaseId> {}

export interface RollbackOperation extends Records.RollbackOperationFieldsV2<PhaseId> {}

export interface TransitionRollbackPlan extends Records.TransitionRollbackPlanFieldsV2<PhaseId> {}

export interface SavedTransitionPlan extends Records.SavedTransitionPlanFieldsV2<ActivationIdentity, PhaseId> {}

export interface BootstrapStateRetention extends Records.BootstrapStateRetentionFieldsV1 {}

export interface GraphReconciliationPhaseMapping extends Records.GraphReconciliationPhaseMappingFieldsV3<PhaseId> {}

export interface GraphReconciliationRecord extends Records.GraphReconciliationRecordFieldsV3<ActivationIdentity, PhaseId> {}

export interface ApprovalResourceScope extends ApprovalResourceValueV1 {}

export interface ApprovalDestinationScope extends ApprovalDestinationValueV1 {}

export interface ApprovalCostCeiling extends ApprovalCostValueV1 {}

export interface ApprovalEnvelope extends Records.ApprovalEnvelopeFieldsV3<ActivationIdentity, PhaseId> {}

export interface RequestedTransitionPlan {
  phaseId: PhaseId;
  gateKind: ApprovalGateKind;
  identity: ActivationIdentity;
  baselineSha: string;
  planDigest: string;
  resources: readonly ApprovalResourceScope[];
  destinations: readonly ApprovalDestinationScope[];
  permissions: readonly string[];
  costCeiling: ApprovalCostCeiling;
  policyExceptions: readonly string[];
  destructiveScope: readonly string[];
  scope?: GovernanceScope;
  coveredPhases?: readonly PhaseId[];
  operationDigests?: readonly string[];
  phasePlanDigests?: Readonly<Partial<Record<PhaseId, string>>>;
}

export interface ApprovalEvaluation extends Records.ApprovalEvaluationFieldsV1<PhaseId> {}

export interface SupersessionRecord extends Records.SupersessionRecordFieldsV1<ActivationIdentity> {}

export const runnerPreflightDisplayNameTemplate = '<repo>-runner-preflight-read' as const;
export const runnerPreflightSecretName = 'RUNNER_CONFIGURATION_READ_TOKEN' as const;
export const runnerPreflightPatLifetimeDays = 30 as const;
export const runnerPreflightRotationLeadDays = 7 as const;
export const runnerPreflightRepositoryPermissions = ['metadata:read'] as const;
export const runnerPreflightOrganizationPermissions = [
  'hosted-runners:read',
  'network-configurations:read'
] as const;

export type CredentialAuthKind = 'github-app' | 'fine-grained-pat';
export type CredentialStatus = 'active' | 'expiring' | 'expired' | 'compromised';

export interface CredentialRepositoryIdentity extends Records.CredentialRepositoryIdentityFieldsV1 {}

export interface CredentialPermissionSet extends Records.CredentialPermissionSetFieldsV1 {}

export interface CredentialWorkflowAllowlistEntry extends Records.CredentialWorkflowAllowlistEntryFieldsV1 {}

export interface GitHubAppCredentialMetadata extends Records.GitHubAppCredentialMetadataFieldsV1 {}

export interface FineGrainedPatCredentialMetadata extends Records.FineGrainedPatCredentialMetadataFieldsV1 {}

export interface CredentialPolicyProofMetadata extends Records.CredentialPolicyProofMetadataFieldsV1 {}

export interface CredentialPolicy extends Records.CredentialPolicyFieldsV1<ActivationIdentity> {}
