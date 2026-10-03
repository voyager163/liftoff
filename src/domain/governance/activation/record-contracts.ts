import type {
  ApprovalResourceValueV1, ApprovalDestinationValueV1, ApprovalCostValueV1
} from './approval-values.js';

export const releasedV3Values = {
  phaseStates: [
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
] as const,
  governanceScopes: ['local', 'activation', 'lifecycle'] as const,
  approvalGateKinds: [
  'none',
  'repository-publish',
  'activation-plan',
  'credential-enrollment',
  'infrastructure-cost',
  'enforcement',
  'destructive-disposal',
  'external-blocker'
] as const,
  mutationClasses: [
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
] as const,
  rollbackKinds: ['none', 'retain', 'reverse-to', 'dispose'] as const,
  runnerPreflightDisplayNameTemplate: '<repo>-runner-preflight-read' as const,
  runnerPreflightOrganizationPermissions: [
  'hosted-runners:read',
  'network-configurations:read'
] as const,
  runnerPreflightPatLifetimeDays: 30 as const,
  runnerPreflightRepositoryPermissions: ['metadata:read'] as const,
  runnerPreflightRotationLeadDays: 7 as const,
  runnerPreflightSecretName: 'RUNNER_CONFIGURATION_READ_TOKEN' as const
};

export type ReleasedV3PhaseId = "seed-valid" | "seed-verified" | "seed-archived" | "committed" | "pushed" | "phase-0-complete" | "activation-approved" | "bootstrap-workflow-source-ready" | "credential-ready" | "provider-ready" | "state-path-selected" | "existing-private-path" | "bootstrap-local" | "runner-ready" | "private-backend-proof" | "remote-import-verified" | "remote-ready" | "application-prerequisites-ready" | "workflow-source-ready" | "application-artifact-ready" | "application-foundation" | "dev-proof" | "staging-qualified" | "production-rehearsed" | "green-red-proof" | "enforcement-approved" | "rulesets-applied" | "live-readback" | "bootstrap-state-disposed";
export type ReleasedV1PhaseId = Exclude<ReleasedV3PhaseId,
  'bootstrap-workflow-source-ready' | 'application-prerequisites-ready' | 'application-artifact-ready'>;
export type ReleasedPhaseStateV3 = typeof releasedV3Values.phaseStates[number];
export type ReleasedGovernanceScopeV3 = typeof releasedV3Values.governanceScopes[number];
export type ReleasedMutationClassV3 = typeof releasedV3Values.mutationClasses[number];
export type ReleasedApprovalGateKindV3 = typeof releasedV3Values.approvalGateKinds[number];
export type ReleasedHumanAuthorityQuestionKindV3 = "repository-creation-initial-commit-push" | "credential-enrollment" | "billed-infrastructure-policy-exception-cost-ceiling" | "final-enforcement" | "destructive-operation" | "external-blocker";
export type ReleasedInvalidationInputKindV3 = "activation-identity" | "graph-hash" | "baseline-sha" | "project-files" | "policy" | "approval-envelope" | "credentials" | "provider-inventory" | "runner-inventory" | "remote-state" | "workflow-source" | "live-readback" | "security-evidence" | "ruleset-readback";
export type ReleasedRollbackKindV3 = typeof releasedV3Values.rollbackKinds[number];
export type ReleasedLiveReadbackProviderV3 = 'github' | 'azure';
export type ReleasedTransitionAdapterIdV3 =
  | 'local-evidence'
  | 'selected-spec-workflow'
  | 'git'
  | 'github'
  | 'azure-opentofu'
  | 'local-state';
export type ReleasedCredentialAuthKindV1 = 'github-app' | 'fine-grained-pat';
export type ReleasedCredentialStatusV1 = 'active' | 'expiring' | 'expired' | 'compromised';
export type ReleasedTerminalPhaseStateV3 = Extract<ReleasedPhaseStateV3,
  'approved' | 'verified' | 'failed' | 'inapplicable' | 'retained' | 'disposed'>;

export interface ActivationIdentityFieldsV1 {
  liftoffVersion: string;
  manifestArtifactVersion: number;
  policyVersion: string;
  activationContractVersion: number;
  phaseGraphSchemaVersion: number;
  phaseGraphHash: string;
  activationStateSchemaVersion: number;
  evidenceHeaderSchemaVersion: number;
  approvalEnvelopeSchemaVersion: number;
  supersessionSchemaVersion: number;
  credentialPolicySchemaVersion: number;
}

export type ActivationIdentityShapeFieldsV1<I extends ActivationIdentityFieldsV1> = Pick<I,
  'liftoffVersion' | 'manifestArtifactVersion' | 'policyVersion' | 'activationContractVersion' |
  'phaseGraphSchemaVersion' | 'activationStateSchemaVersion' | 'evidenceHeaderSchemaVersion' |
  'approvalEnvelopeSchemaVersion' | 'supersessionSchemaVersion' | 'credentialPolicySchemaVersion'
> & { phaseGraphHash: string };

export interface GraphVersionIdentityFieldsV2 {
  liftoffVersion: string;
  policyVersion: string;
  activationContractVersion: number;
  phaseGraphSchemaVersion: number;
}

export interface PhaseDependencyFieldsV2<P extends string> {
  anyOf: readonly P[];
  accepts: readonly ReleasedTerminalPhaseStateV3[];
  description: string;
}

export type PhaseApplicabilityFieldsV2<P extends string> =
  | { kind: 'always' }
  | {
      kind: 'conditional';
      discriminator: 'state-path' | 'private-staging-dast' | 'credential-required' | 'cloud-state-required' | 'private-runner-required';
      when: string;
      inapplicableWhen: string;
      exclusiveWith: readonly P[];
    };

export interface ApprovalGateFieldsV3 {
  kind: ReleasedApprovalGateKindV3;
  required: boolean;
  envelopeSchemaVersion: number;
}

export interface AllowedMutationsFieldsV3 {
  local: readonly ReleasedMutationClassV3[];
  remote: readonly ReleasedMutationClassV3[];
}

export interface EvidenceRequirementFieldsV3 {
  schema: string;
  required: boolean;
  headerSchemaVersion: number;
  liveReadbackProviders: readonly ReleasedLiveReadbackProviderV3[];
}

export interface RollbackBehaviorFieldsV2<P extends string> {
  kind: ReleasedRollbackKindV3;
  target: P | null;
  description: string;
}

export interface PhaseGraphNodeFieldsV2<P extends string> {
  id: P;
  label: string;
  dependencies: readonly PhaseDependencyFieldsV2<P>[];
  applicability: PhaseApplicabilityFieldsV2<P>;
  allowedMutations: AllowedMutationsFieldsV3;
  evidence: EvidenceRequirementFieldsV3;
  approvalGate: ApprovalGateFieldsV3;
  invalidationInputs: readonly ReleasedInvalidationInputKindV3[];
  rollback: RollbackBehaviorFieldsV2<P>;
  terminalStates: readonly ReleasedTerminalPhaseStateV3[];
}

export interface ManagedPhaseGraphFieldsV2<P extends string> {
  schemaVersion: number;
  versions: GraphVersionIdentityFieldsV2;
  phases: readonly PhaseGraphNodeFieldsV2<P>[];
  completionGroups: {
    local: readonly P[];
    activation: readonly P[];
    lifecycle: readonly P[];
  };
}

export interface BoundPhaseGraphFieldsV2<I extends ActivationIdentityFieldsV1, P extends string>
  extends ManagedPhaseGraphFieldsV2<P> {
  schemaVersion: I['phaseGraphSchemaVersion'];
  versions: Pick<I, 'liftoffVersion' | 'policyVersion' | 'activationContractVersion' | 'phaseGraphSchemaVersion'>;
  phases: readonly (PhaseGraphNodeFieldsV2<P> & {
    evidence: EvidenceRequirementFieldsV3 & { headerSchemaVersion: I['evidenceHeaderSchemaVersion'] };
    approvalGate: ApprovalGateFieldsV3 & { envelopeSchemaVersion: I['approvalEnvelopeSchemaVersion'] };
  })[];
}

export interface ActivationConfigurationFieldsV1<P extends string> {
  schemaVersion: 1;
  repository?: {
    name: string;
    defaultBranch?: string;
    visibility?: 'private' | 'public';
    create?: boolean;
  };
  azure?: {
    subscriptionId: string;
    tenantId: string;
    region: string;
  };
  budget?: ApprovalCostValueV1;
  phases: Partial<Record<P, Readonly<Record<string, unknown>>>>;
}

export interface ExternalOperationStateFieldsV1 {
  provider: ReleasedLiveReadbackProviderV3;
  actionId: string;
  operationId: string;
  resourceId: string;
  startedAt: string;
  observedAt: string;
  status: 'running' | 'completed' | 'failed';
  pollUrl?: string;
  planDigest?: string;
}

export type TaskProjectionSourceFieldsV1 = {
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

export interface PlannedFileChangeFieldsV1 {
  pathParts: readonly string[];
  beforeHash: string | null;
  afterHash: string | null;
}

export interface InputTransitionBindingFieldsV1 {
  beforeDigest: string;
  afterDigest: string;
  files: readonly PlannedFileChangeFieldsV1[];
  git?: {
    before: { head: string | null; branch: string | null; pushUrls: readonly string[] };
    after: { head: string | null; branch: string | null; pushUrls: readonly string[] };
  };
}

export interface GovernanceTaskProjectionRecordFieldsV1<P extends string> {
  schemaVersion: 1;
  purpose: 'projection-audit-only';
  phaseId: P;
  planDigest: string;
  contractDigest: string;
  taskPathParts: readonly string[];
  metadataHash: string;
  layoutHash: string;
  status: 'complete' | 'blocked';
  observedAt: string;
  beforeHash: string | null;
  afterHash: string | null;
  states: Readonly<Record<P, ReleasedPhaseStateV3 | 'identity-incompatible'>> | null;
  blockers: readonly string[];
}

export interface PhaseOutputBindingsFieldsV1 {
  values: Readonly<Record<string, string | number | boolean | null>>;
  resources: readonly {
    provider: ReleasedLiveReadbackProviderV3;
    resourceType: string;
    resourceId: string;
  }[];
}

export interface EvidenceReferenceFieldsV3<P extends string> {
  phaseId: P;
  evidenceId: string;
  headerDigest: string;
  result: Extract<ReleasedTerminalPhaseStateV3, 'verified' | 'failed' | 'inapplicable' | 'retained' | 'disposed'>;
}

export interface EvidenceTransitionIdentityFieldsV3<P extends string> {
  phaseId: P;
  baselineSha: string;
  inputDigest: string;
  transitionDigest: string;
}

export interface PhaseExecutionStateFieldsV3<P extends string> {
  state: ReleasedPhaseStateV3;
  updatedAt: string;
  evidence: readonly EvidenceReferenceFieldsV3<P>[];
  approvals: readonly string[];
  blockers: readonly string[];
  operation?: ExternalOperationStateFieldsV1;
  executionPlanDigest?: string;
}

export interface ActivationSuccessorHistoryFieldsV1 {
  schemaVersion: 1;
  snapshotId: string;
  journalPathParts: readonly ['governance', 'migration-state.json'];
  historyIndexPathParts: readonly string[];
  historyIndexDigest: string;
  sourceActiveChange: { id: string; kind: 'openspec' | 'spec-kit' } | null;
}

export interface UserActivationStateFieldsV3<I extends ActivationIdentityFieldsV1, P extends string> {
  schemaVersion: I['activationStateSchemaVersion'];
  identity: I;
  repository: {
    id: string;
    name: string;
    defaultBranch: string;
  };
  remoteBinding?: {
    id: string;
    name: string;
    defaultBranch: string;
    pushUrl: string;
    verifiedAt: string;
  };
  activeChange: {
    id: string;
    kind: 'openspec' | 'spec-kit';
  } | null;
  applicability: {
    statePath: 'existing-private' | 'bootstrap-local' | 'none';
    privateStagingDast: boolean | 'unknown';
    credentialRequired: boolean | 'unknown';
    cloudStateRequired?: boolean | 'unknown';
    privateRunnerRequired?: boolean | 'unknown';
  };
  baselineAnchor?: string;
  successorHistory?: ActivationSuccessorHistoryFieldsV1;
  taskProjection?: GovernanceTaskProjectionRecordFieldsV1<P>;
  activationInputs?: ActivationConfigurationFieldsV1<P>;
  phaseOutputs?: Partial<Record<P, PhaseOutputBindingsFieldsV1>>;
  bootstrapState?: BootstrapStateRetentionFieldsV1;
  phases: Record<P, PhaseExecutionStateFieldsV3<P>>;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceHeaderFieldsV3<I extends ActivationIdentityFieldsV1, P extends string> {
  schemaVersion: I['evidenceHeaderSchemaVersion'];
  repositoryId: string;
  identity: I;
  phaseGraphHash: string;
  phaseId: P;
  phaseContractDigest: string;
  inputDigest: string;
  baselineSha: string;
  transition: EvidenceTransitionIdentityFieldsV3<P>;
  producedAt: string;
  producer: string;
  bodyDigest: string;
  remoteBindingDigest?: string;
  scope?: ReleasedGovernanceScopeV3;
  inputBindings?: InputTransitionBindingFieldsV1;
  result: Extract<ReleasedTerminalPhaseStateV3, 'verified' | 'failed' | 'inapplicable' | 'retained' | 'disposed'>;
}

export interface LiveReadbackProofFieldsV3<I extends ActivationIdentityFieldsV1, P extends string> {
  schemaVersion: I['evidenceHeaderSchemaVersion'];
  repositoryId: string;
  identity: I;
  phaseGraphHash: string;
  phaseId: P;
  baselineSha: string;
  inputDigest: string;
  transition: EvidenceTransitionIdentityFieldsV3<P>;
  observedAt: string;
  provider: ReleasedLiveReadbackProviderV3;
  resourceType: string;
  resourceId: string;
  sourceDigest: string;
  readbackDigest: string;
  matches: boolean;
}

export interface PhaseEvidenceRecordFieldsV3<I extends ActivationIdentityFieldsV1, P extends string> {
  evidenceId: string;
  header: EvidenceHeaderFieldsV3<I, P>;
  liveReadback?: readonly LiveReadbackProofFieldsV3<I, P>[];
  payload?: unknown;
}

export interface TransitionOperationDestinationFieldsV1 {
  type: 'local' | 'repository' | 'subscription' | 'environment' | 'tenant' | 'external';
  identity: string;
  pathParts?: readonly string[];
  repository?: string;
  subscriptionId?: string;
  ref?: string;
}

export interface TransitionOperationFieldsV2<P extends string> {
  adapter: ReleasedTransitionAdapterIdV3;
  actionId: string;
  mutationClass: ReleasedMutationClassV3;
  phaseId: P;
  inputs: Record<string, unknown>;
  destination: TransitionOperationDestinationFieldsV1;
  remote: boolean;
  destructive: boolean;
  effects?: readonly {
    mutationClass: ReleasedMutationClassV3;
    destination: TransitionOperationDestinationFieldsV1;
    remote: boolean;
    destructive: boolean;
  }[];
}

export interface RollbackOperationFieldsV2<P extends string> {
  adapter: ReleasedTransitionAdapterIdV3;
  actionId: string;
  mutationClass: ReleasedMutationClassV3;
  phaseId: P;
  inputs: Record<string, unknown>;
  destination: TransitionOperationDestinationFieldsV1;
  remote: boolean;
  destructive: boolean;
}

export interface TransitionRollbackPlanFieldsV2<P extends string> {
  phaseId: P;
  strategy: ReleasedRollbackKindV3;
  target: P | null;
  operations: readonly RollbackOperationFieldsV2<P>[];
  retained: readonly string[];
  cleanupWarnings: readonly string[];
}

export interface SavedTransitionPlanFieldsV2<I extends ActivationIdentityFieldsV1, P extends string> {
  schemaVersion: 2;
  scope: ReleasedGovernanceScopeV3;
  phaseId: P;
  createdAt: string;
  expiresAt: string;
  identity: I;
  graphHash: string;
  stateHash: string | null;
  baselineDigest: string;
  inputDigest: string;
  transitionDigest: string;
  planDigest: string;
  mutationClasses: AllowedMutationsFieldsV3;
  operations: readonly TransitionOperationFieldsV2<P>[];
  approval: {
    gateKind: ReleasedApprovalGateKindV3;
    required: boolean;
    evaluation: ApprovalEvaluationFieldsV1<P>;
    envelopeId: string | null;
    envelopeHash: string | null;
  };
  rollbackPlan: TransitionRollbackPlanFieldsV2<P>;
  noSecrets: true;
  configuration?: ActivationConfigurationFieldsV1<P>;
  fileChanges?: readonly PlannedFileChangeFieldsV1[];
  recovery?: boolean;
  approvalBundle?: readonly {
    phaseId: P;
    inputDigest: string;
    transitionDigest: string;
    operations: readonly TransitionOperationFieldsV2<P>[];
    fileChanges: readonly PlannedFileChangeFieldsV1[];
  }[];
}

export interface BootstrapStateRetentionFieldsV1 {
  status: 'retained' | 'disposed';
  remoteImportEvidenceId: string;
  remoteImportEvidenceDigest: string;
  retainedAt: string;
  disposeAfter: string;
  encryptedStatePathParts: readonly (readonly string[])[];
  encryptionKeyPathParts: readonly (readonly string[])[];
  disposedAt?: string;
  deletionEvidenceId?: string;
  incompleteCleanup?: readonly string[];
}

export interface GraphReconciliationPhaseMappingFieldsV3<P extends string> {
  phaseId: P;
  fromContractDigest: string;
  toContractDigest: string;
  preserveEvidence: boolean;
}

export interface GraphReconciliationRecordFieldsV3<I extends ActivationIdentityFieldsV1, P extends string> {
  schemaVersion: I['activationStateSchemaVersion'];
  fromGraphHash: string;
  toGraphHash: string;
  fromIdentity: I;
  toIdentity: I;
  phaseMappings: readonly GraphReconciliationPhaseMappingFieldsV3<P>[];
  reconciledAt: string;
  producer: string;
}

export interface ApprovalEnvelopeFieldsV3<I extends ActivationIdentityFieldsV1, P extends string> {
  schemaVersion: I['approvalEnvelopeSchemaVersion'];
  id: string;
  phaseId: P;
  gateKind: ReleasedApprovalGateKindV3;
  identity: I;
  baselineSha: string;
  planDigest: string;
  resources: readonly ApprovalResourceValueV1[];
  destinations: readonly ApprovalDestinationValueV1[];
  permissions: readonly string[];
  costCeiling: ApprovalCostValueV1;
  policyExceptions: readonly string[];
  destructiveScope: readonly string[];
  expiresAt: string;
  approvedAt: string;
  approver: string;
  scope?: ReleasedGovernanceScopeV3;
  coveredPhases?: readonly P[];
  operationDigests?: readonly string[];
  phasePlanDigests?: Readonly<Partial<Record<P, string>>>;
}

export interface ApprovalEvaluationFieldsV1<P extends string> {
  phaseId: P;
  gateKind: ReleasedApprovalGateKindV3;
  questionKind: ReleasedHumanAuthorityQuestionKindV3 | null;
  approvalRequired: boolean;
  status: 'not-required' | 'approval-required' | 'reused' | 'expired' | 'invalidated';
  envelopeId: string | null;
  envelopeHash: string | null;
  reasons: readonly string[];
  expansionReasons: readonly string[];
}

export interface SupersessionRecordFieldsV1<I extends ActivationIdentityFieldsV1> {
  schemaVersion: I['supersessionSchemaVersion'];
  identity: I;
  supersededChangeId: string;
  supersedingChangeId: string;
  reason: string;
  approvedAt: string;
  approver: string;
}

export interface CredentialRepositoryIdentityFieldsV1 {
  id: string;
  owner: string;
  name: string;
  fullName: string;
}

export interface CredentialPermissionSetFieldsV1 {
  repository: readonly string[];
  organization: readonly string[];
}

export interface CredentialWorkflowAllowlistEntryFieldsV1 {
  path: string;
  jobs: readonly string[];
}

export interface GitHubAppCredentialMetadataFieldsV1 {
  installationId: number;
  appSlug: string;
  selection: 'selected-repository';
  repositoryFullName: string;
  permissionsVerifiedAt: string;
  token: {
    strategy: 'installation-token';
    ttlSeconds: number;
    generatedBy: 'github-app';
  };
}

export interface FineGrainedPatCredentialMetadataFieldsV1 {
  lifetimeDays: typeof releasedV3Values.runnerPreflightPatLifetimeDays;
  selectedRepositoryOnly: true;
  createdBy: 'manual-masked-entry';
}

export interface CredentialPolicyProofMetadataFieldsV1 {
  verifiedAt: string;
  readbackDigest: string;
  readbackProvider: 'github-api' | 'adapter-fixture';
  payloadFree: true;
}

export interface CredentialPolicyFieldsV1<I extends ActivationIdentityFieldsV1> {
  schemaVersion: I['credentialPolicySchemaVersion'];
  identity: I;
  repository: CredentialRepositoryIdentityFieldsV1;
  owner: string;
  authKind: ReleasedCredentialAuthKindV1;
  displayNameTemplate: typeof releasedV3Values.runnerPreflightDisplayNameTemplate;
  displayName: string;
  secretName: typeof releasedV3Values.runnerPreflightSecretName;
  createdAt: string;
  expiresAt: string;
  rotationLeadDays: typeof releasedV3Values.runnerPreflightRotationLeadDays;
  rotationDueAt: string;
  permissions: CredentialPermissionSetFieldsV1;
  allowedWorkflows: readonly CredentialWorkflowAllowlistEntryFieldsV1[];
  nonForwarding: true;
  status: ReleasedCredentialStatusV1;
  proof: CredentialPolicyProofMetadataFieldsV1;
  app: GitHubAppCredentialMetadataFieldsV1 | null;
  pat: FineGrainedPatCredentialMetadataFieldsV1 | null;
}

export type PhaseExecutionStateFieldsV1<P extends string> = Pick<PhaseExecutionStateFieldsV3<P>,
  'state' | 'updatedAt' | 'evidence' | 'approvals' | 'blockers'>;

export interface UserActivationStateFieldsV1<I extends ActivationIdentityFieldsV1, P extends string> {
  schemaVersion: 1;
  identity: I;
  repository: { id: string; name: string; defaultBranch: string };
  activeChange: { id: string; kind: 'openspec' | 'spec-kit' } | null;
  applicability: {
    statePath: 'existing-private' | 'bootstrap-local' | 'none';
    privateStagingDast: boolean;
    credentialRequired: boolean;
  };
  bootstrapState?: BootstrapStateRetentionFieldsV1;
  phases: Record<P, PhaseExecutionStateFieldsV1<P>>;
  createdAt: string;
  updatedAt: string;
}

export type EvidenceHeaderFieldsV1<I extends ActivationIdentityFieldsV1, P extends string> = Pick<
  EvidenceHeaderFieldsV3<I, P>,
  'repositoryId' | 'phaseGraphHash' | 'phaseId' | 'phaseContractDigest' | 'inputDigest' |
  'baselineSha' | 'transition' | 'producedAt' | 'producer' | 'result'
> & { schemaVersion: 1; identity: I };

export type ApprovalEnvelopeFieldsV1<I extends ActivationIdentityFieldsV1, P extends string> = Pick<
  ApprovalEnvelopeFieldsV3<I, P>,
  'id' | 'phaseId' | 'gateKind' | 'baselineSha' | 'planDigest' | 'resources' | 'destinations' |
  'permissions' | 'costCeiling' | 'policyExceptions' | 'destructiveScope' | 'expiresAt' | 'approvedAt' | 'approver'
> & { schemaVersion: 1; identity: I };

export interface TransitionOperationFieldsV1<P extends string, M extends string> {
  adapter: ReleasedTransitionAdapterIdV3;
  actionId: string;
  mutationClass: M;
  phaseId: P;
  inputs: Record<string, unknown>;
  destination: TransitionOperationDestinationFieldsV1;
  remote: boolean;
  destructive: boolean;
}

export interface TransitionRollbackPlanFieldsV1<P extends string, M extends string> {
  phaseId: P;
  strategy: ReleasedRollbackKindV3;
  target: P | null;
  operations: readonly TransitionOperationFieldsV1<P, M>[];
  retained: readonly string[];
  cleanupWarnings: readonly string[];
}

export interface SavedTransitionPlanFieldsV1<I extends ActivationIdentityFieldsV1, P extends string, M extends string> {
  schemaVersion: 1;
  phaseId: P;
  createdAt: string;
  expiresAt: string;
  identity: I;
  graphHash: string;
  stateHash: string | null;
  baselineDigest: string;
  inputDigest: string;
  transitionDigest: string;
  planDigest: string;
  mutationClasses: { local: readonly M[]; remote: readonly M[] };
  operations: readonly TransitionOperationFieldsV1<P, M>[];
  approval: {
    gateKind: ReleasedApprovalGateKindV3;
    required: boolean;
    evaluation: ApprovalEvaluationFieldsV1<P>;
    envelopeId: string | null;
    envelopeHash: string | null;
  };
  rollbackPlan: TransitionRollbackPlanFieldsV1<P, M>;
  noSecrets: true;
}
