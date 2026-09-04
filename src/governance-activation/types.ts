export const phaseIds = [
  'seed-valid',
  'seed-verified',
  'seed-archived',
  'committed',
  'pushed',
  'phase-0-complete',
  'activation-approved',
  'credential-ready',
  'provider-ready',
  'state-path-selected',
  'existing-private-path',
  'bootstrap-local',
  'runner-ready',
  'private-backend-proof',
  'remote-import-verified',
  'remote-ready',
  'application-foundation',
  'workflow-source-ready',
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
  'write-openspec-governance',
  'write-local-state',
  'delete-local-state',
  'write-workflows',
  'write-ruleset-source',
  'git-commit',
  'git-push',
  'github-read',
  'github-write',
  'github-secret-write',
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

export interface ActivationIdentity {
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

export interface GraphVersionIdentity {
  liftoffVersion: string;
  policyVersion: string;
  activationContractVersion: number;
  phaseGraphSchemaVersion: number;
}

export interface PhaseDependency {
  anyOf: readonly PhaseId[];
  accepts: readonly TerminalPhaseState[];
  description: string;
}

export type PhaseApplicability =
  | { kind: 'always' }
  | {
      kind: 'conditional';
      discriminator: 'state-path' | 'private-staging-dast' | 'credential-required';
      when: string;
      inapplicableWhen: string;
      exclusiveWith: readonly PhaseId[];
    };

export interface ApprovalGate {
  kind: ApprovalGateKind;
  required: boolean;
  envelopeSchemaVersion: number;
}

export interface AllowedMutations {
  local: readonly MutationClass[];
  remote: readonly MutationClass[];
}

export type LiveReadbackProvider = 'github' | 'azure';

export interface EvidenceRequirement {
  schema: string;
  required: boolean;
  headerSchemaVersion: number;
  liveReadbackProviders: readonly LiveReadbackProvider[];
}

export interface RollbackBehavior {
  kind: RollbackKind;
  target: PhaseId | null;
  description: string;
}

export interface PhaseGraphNode {
  id: PhaseId;
  label: string;
  dependencies: readonly PhaseDependency[];
  applicability: PhaseApplicability;
  allowedMutations: AllowedMutations;
  evidence: EvidenceRequirement;
  approvalGate: ApprovalGate;
  invalidationInputs: readonly InvalidationInputKind[];
  rollback: RollbackBehavior;
  terminalStates: readonly TerminalPhaseState[];
}

export interface ManagedPhaseGraph {
  schemaVersion: number;
  versions: GraphVersionIdentity;
  phases: readonly PhaseGraphNode[];
}

export interface EvidenceReference {
  phaseId: PhaseId;
  evidenceId: string;
  headerDigest: string;
  result: Extract<TerminalPhaseState, 'verified' | 'failed' | 'inapplicable' | 'retained' | 'disposed'>;
}

export interface EvidenceTransitionIdentity {
  phaseId: PhaseId;
  baselineSha: string;
  inputDigest: string;
  transitionDigest: string;
}

export interface PhaseExecutionState {
  state: PhaseState;
  updatedAt: string;
  evidence: readonly EvidenceReference[];
  approvals: readonly string[];
  blockers: readonly string[];
}

export interface UserActivationState {
  schemaVersion: number;
  identity: ActivationIdentity;
  repository: {
    id: string;
    name: string;
    defaultBranch: string;
  };
  activeChange: {
    id: string;
    kind: 'openspec' | 'spec-kit';
  } | null;
  applicability: {
    statePath: 'existing-private' | 'bootstrap-local' | 'none';
    privateStagingDast: boolean;
    credentialRequired: boolean;
  };
  bootstrapState?: BootstrapStateRetention;
  phases: Record<PhaseId, PhaseExecutionState>;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceHeader {
  schemaVersion: number;
  repositoryId: string;
  identity: ActivationIdentity;
  phaseGraphHash: string;
  phaseId: PhaseId;
  phaseContractDigest: string;
  inputDigest: string;
  baselineSha: string;
  transition: EvidenceTransitionIdentity;
  producedAt: string;
  producer: string;
  result: Extract<TerminalPhaseState, 'verified' | 'failed' | 'inapplicable' | 'retained' | 'disposed'>;
}

export interface LiveReadbackProof {
  schemaVersion: number;
  repositoryId: string;
  identity: ActivationIdentity;
  phaseGraphHash: string;
  phaseId: PhaseId;
  baselineSha: string;
  inputDigest: string;
  transition: EvidenceTransitionIdentity;
  observedAt: string;
  provider: LiveReadbackProvider;
  resourceType: string;
  resourceId: string;
  sourceDigest: string;
  readbackDigest: string;
  matches: boolean;
}

export interface PhaseEvidenceRecord {
  evidenceId: string;
  header: EvidenceHeader;
  liveReadback?: readonly LiveReadbackProof[];
  payload?: unknown;
}

export type TransitionAdapterId =
  | 'local-evidence'
  | 'selected-spec-workflow'
  | 'git'
  | 'github'
  | 'azure-opentofu'
  | 'local-state';

export interface TransitionOperationDestination {
  type: 'local' | 'repository' | 'subscription' | 'environment' | 'tenant' | 'external';
  identity: string;
  pathParts?: readonly string[];
  repository?: string;
  subscriptionId?: string;
  ref?: string;
}

export interface TransitionOperation {
  adapter: TransitionAdapterId;
  actionId: string;
  mutationClass: MutationClass;
  phaseId: PhaseId;
  inputs: Record<string, unknown>;
  destination: TransitionOperationDestination;
  remote: boolean;
  destructive: boolean;
}

export interface RollbackOperation {
  adapter: TransitionAdapterId;
  actionId: string;
  mutationClass: MutationClass;
  phaseId: PhaseId;
  inputs: Record<string, unknown>;
  destination: TransitionOperationDestination;
  remote: boolean;
  destructive: boolean;
}

export interface TransitionRollbackPlan {
  phaseId: PhaseId;
  strategy: RollbackKind;
  target: PhaseId | null;
  operations: readonly RollbackOperation[];
  retained: readonly string[];
  cleanupWarnings: readonly string[];
}

export interface SavedTransitionPlan {
  schemaVersion: 1;
  phaseId: PhaseId;
  createdAt: string;
  expiresAt: string;
  identity: ActivationIdentity;
  graphHash: string;
  stateHash: string | null;
  baselineDigest: string;
  inputDigest: string;
  transitionDigest: string;
  planDigest: string;
  mutationClasses: AllowedMutations;
  operations: readonly TransitionOperation[];
  approval: {
    gateKind: ApprovalGateKind;
    required: boolean;
    evaluation: ApprovalEvaluation;
    envelopeId: string | null;
    envelopeHash: string | null;
  };
  rollbackPlan: TransitionRollbackPlan;
  noSecrets: true;
}

export interface BootstrapStateRetention {
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

export interface GraphReconciliationPhaseMapping {
  phaseId: PhaseId;
  fromContractDigest: string;
  toContractDigest: string;
  preserveEvidence: boolean;
}

export interface GraphReconciliationRecord {
  schemaVersion: number;
  fromGraphHash: string;
  toGraphHash: string;
  fromIdentity: ActivationIdentity;
  toIdentity: ActivationIdentity;
  phaseMappings: readonly GraphReconciliationPhaseMapping[];
  reconciledAt: string;
  producer: string;
}

export interface ApprovalResourceScope {
  type: string;
  identity: string;
}

export interface ApprovalDestinationScope {
  type: 'repository' | 'subscription' | 'environment' | 'tenant' | 'local' | 'external';
  identity: string;
  repository: string | null;
  subscriptionId: string | null;
}

export interface ApprovalCostCeiling {
  currency: string;
  fixedMonthlyCents: number;
  usageMonthlyCents: number;
}

export interface ApprovalEnvelope {
  schemaVersion: number;
  id: string;
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
  expiresAt: string;
  /**
   * Approval metadata is validated and persisted for audit display, but it is
   * deliberately excluded from the canonical approval-envelope hash so retries
   * inside the same reviewed scope remain hash-stable.
   */
  approvedAt: string;
  approver: string;
}

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
}

export interface ApprovalEvaluation {
  phaseId: PhaseId;
  gateKind: ApprovalGateKind;
  questionKind: HumanAuthorityQuestionKind | null;
  approvalRequired: boolean;
  status: 'not-required' | 'approval-required' | 'reused' | 'expired' | 'invalidated';
  envelopeId: string | null;
  envelopeHash: string | null;
  reasons: readonly string[];
  expansionReasons: readonly string[];
}

export interface SupersessionRecord {
  schemaVersion: number;
  identity: ActivationIdentity;
  supersededChangeId: string;
  supersedingChangeId: string;
  reason: string;
  approvedAt: string;
  approver: string;
}

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

export interface CredentialRepositoryIdentity {
  id: string;
  owner: string;
  name: string;
  fullName: string;
}

export interface CredentialPermissionSet {
  repository: readonly string[];
  organization: readonly string[];
}

export interface CredentialWorkflowAllowlistEntry {
  path: string;
  jobs: readonly string[];
}

export interface GitHubAppCredentialMetadata {
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

export interface FineGrainedPatCredentialMetadata {
  lifetimeDays: typeof runnerPreflightPatLifetimeDays;
  selectedRepositoryOnly: true;
  createdBy: 'manual-masked-entry';
}

export interface CredentialPolicyProofMetadata {
  verifiedAt: string;
  readbackDigest: string;
  readbackProvider: 'github-api' | 'adapter-fixture';
  payloadFree: true;
}

export interface CredentialPolicy {
  schemaVersion: number;
  identity: ActivationIdentity;
  repository: CredentialRepositoryIdentity;
  owner: string;
  authKind: CredentialAuthKind;
  displayNameTemplate: typeof runnerPreflightDisplayNameTemplate;
  displayName: string;
  secretName: typeof runnerPreflightSecretName;
  createdAt: string;
  expiresAt: string;
  rotationLeadDays: typeof runnerPreflightRotationLeadDays;
  rotationDueAt: string;
  permissions: CredentialPermissionSet;
  allowedWorkflows: readonly CredentialWorkflowAllowlistEntry[];
  nonForwarding: true;
  status: CredentialStatus;
  proof: CredentialPolicyProofMetadata;
  app: GitHubAppCredentialMetadata | null;
  pat: FineGrainedPatCredentialMetadata | null;
}
