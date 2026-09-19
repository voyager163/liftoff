import type {
  DarwinStateKeychainReference, ProtectedStateWorkspace, StateArtifactDescriptor, StateBackendAdapter,
  StateExecutionContext
} from '../../domain/repair/stateful.js';
import type { StateSnapshot, PrivateStateCommand, PrivateStateCommandResult, PrivateStateCommandRunner } from '../../domain/repair/stateful.js';
import type { AzureArmBinding } from '../../adapters/azure/activation-rest.js';
import type { PrivateStateEffectRecorder, PrivateStatePathTarget } from '../../adapters/azure/private-state-path.js';
import type { PrivateCustodyConfiguration } from './private-custody.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import type { SavedTransitionPlan, TransitionOperation } from '../../domain/governance/activation/types.js';
import { generatedApplicationResourceContracts } from './application-generated-resource-contracts.js';
import type { ApplicationArtifactRole } from './application-artifact-inputs.js';
import type { ApplicationArtifactRoleReference, ApplicationArtifactSetReference } from './application-artifact-set.js';
export { ApplicationPrivateError, applicationPrivateAssert } from './application-private-errors.js';

export const applicationPrivateProtocol = 'opentofu-private-application/1' as const;
export type ApplicationPrivatePhase = 'application-prerequisites-ready' | 'application-foundation' | 'staging-qualified' | 'production-rehearsed';
export type ApplicationPrivateScope = 'prerequisites-core' | 'prerequisites-rbac' | 'foundation-dependencies' | 'foundation' |
  'staging-dependencies' | 'staging' | 'rehearsal-rollout' | 'rehearsal-rollback';
export function applicationPrivateFullInventory(scope: ApplicationPrivateScope): boolean {
  return ['foundation', 'staging', 'rehearsal-rollout', 'rehearsal-rollback'].includes(scope);
}
export type ApplicationPrivateAction = 'create' | 'update' | 'no-op';
export type ApplicationPrivateRecovery = 'inspect' | 'publish-retained' | 'close-unapplied';
export type ApplicationPrivateScalar = string | number | boolean | null;

export const applicationPrivateResourceTypes = {
  ...generatedApplicationResourceContracts,
  azurerm_resource_group: { arm: 'Microsoft.Resources/resourceGroups', api: '2024-03-01' },
  azurerm_container_registry: { arm: 'Microsoft.ContainerRegistry/registries', api: '2023-07-01' },
  azurerm_user_assigned_identity: { arm: 'Microsoft.ManagedIdentity/userAssignedIdentities', api: '2023-01-31' },
  azurerm_role_assignment: { arm: 'Microsoft.Authorization/roleAssignments', api: '2022-04-01' },
  azurerm_container_app_environment: { arm: 'Microsoft.App/managedEnvironments', api: '2023-05-01' },
  azurerm_container_app: { arm: 'Microsoft.App/containerApps', api: '2023-05-01' }
} as const;
export type ApplicationPrivateResourceType = keyof typeof applicationPrivateResourceTypes;

export interface ApplicationPrivateProvider {
  source: 'registry.opentofu.org/hashicorp/azurerm';
  version: string;
  /** Preinstalled unpacked filesystem mirror; initialization cannot download providers. */
  mirrorDirectory: string;
  binary: { path: string; sha256: string };
}

export interface ApplicationPrivateWriter extends DarwinStateKeychainReference, AzureArmBinding {
  clientId: string;
}

export interface ApplicationPrivateTarget {
  address: string;
  type: ApplicationPrivateResourceType;
  /** A declared target, not an observation or a provider-assigned operation ID. */
  resourceId: string;
  actions: readonly ApplicationPrivateAction[];
  expected: Readonly<Record<string, ApplicationPrivateScalar>>;
  role: null | {
    scope: string;
    roleDefinitionId: string;
    principalId: string;
    identityResourceId: string;
    clientId: string;
    roleDefinitionName?: string;
  };
  runtime: null | ApplicationPrivateHealth;
}

export type ApplicationPrivateHealth =
  | { kind?: never; url: string; statusField: string; statusValue: string }
  | { kind: 'frontend-html/1'; url: string };

export interface ApplicationPrivateArtifact {
  evidenceId: string;
  headerDigest: string;
  imageRef: string;
  sourceSha: string;
  registryResourceId: string;
  /** Original build location when this immutable artifact is deployed from a separately verified mirror. */
  sourceRegistryResourceId?: string;
}

export interface ApplicationPrivateArtifactDeployment {
  address: string;
  imageRef: string;
  registryResourceId: string;
  /** Required only for an exact immutable mirror; must match this role's producer registry. */
  sourceRegistryResourceId?: string;
}

/** An explicit complete role set, never an implicit replacement for the legacy backend artifact. */
export interface ApplicationPrivateArtifactSet {
  reference: ApplicationArtifactSetReference;
  sourceSha: string;
  deployments: {
    backend: ApplicationPrivateArtifactDeployment;
    frontend?: ApplicationPrivateArtifactDeployment;
  };
}

export interface ApplicationPrivateArtifactSelection extends ApplicationPrivateArtifactDeployment {
  role: ApplicationArtifactRole;
  reference: ApplicationArtifactRoleReference;
  sourceSha: string;
}

export interface ApplicationPrivateIntent {
  schemaVersion: 1;
  scope: ApplicationPrivateScope;
  binding: AzureArmBinding;
  backend: PrivateStatePathTarget;
  custody: PrivateCustodyConfiguration;
  writer: ApplicationPrivateWriter;
  source: {
    rootPathParts: readonly string[];
    backendPathParts: readonly string[];
    /** Existing encrypted `inspection` artifact containing a JSON variable object. */
    variablesRef: string;
    provider: ApplicationPrivateProvider;
  };
  targets: readonly ApplicationPrivateTarget[];
  artifact: ApplicationPrivateArtifact | null;
  artifactSet?: ApplicationPrivateArtifactSet;
  notBefore: string;
  expiresAt: string;
  releaseUntil: string;
  maxCommandMs: number;
}

export type ApplicationPrivateConfiguration = ApplicationPrivateIntent & (
  | { mode: 'prepare' }
  | { mode: 'apply'; reviewed: ApplicationPrivateReview }
  | {
    mode: 'recover'; reviewed: ApplicationPrivateReview | null; recovery: ApplicationPrivateRecovery;
    checkpoint: { transactionId: string; journalRef: string };
    candidateRef: string | null;
    recoveryWindow: { notBefore: string; expiresAt: string; releaseUntil: string };
  }
);

export interface ApplicationPrivateSource {
  schemaVersion: 1;
  rootPathParts: readonly string[];
  backendPathParts: readonly string[];
  files: readonly {
    pathParts: readonly string[];
    privatePath: string;
    digest: string;
    mode: number;
    kind: 'hcl' | 'lock' | 'backend';
  }[];
  directories: readonly { pathParts: readonly string[]; entries: readonly string[] }[];
  resources: readonly {
    address: string; type: string; mode: 'managed' | 'data'; counted?: boolean;
    artifactRole?: ApplicationArtifactRole;
  }[];
  artifactSet?: ApplicationPrivateArtifactSet;
  projections?: readonly { privatePath: string; content: string; digest: string }[];
  digest: string;
}

export interface ApplicationPrivateDirectory {
  path: string;
  identity: { device: string; inode: string; birthtime: string; uid: number; mode: number };
}

export interface ApplicationPrivateChange {
  address: string;
  type: ApplicationPrivateResourceType;
  action: ApplicationPrivateAction;
  targetResourceId: string;
  changedAttributes: readonly string[];
  computedOutputs: readonly string[];
}

/**
 * The opaque immutable plan reference commits to the private bytes. Neither a
 * state hash nor a saved-plan/variable content hash is a public commitment.
 */
export interface ApplicationPrivateReview {
  schemaVersion: 1;
  protocol: typeof applicationPrivateProtocol;
  transactionId: string;
  journalRef: string;
  planRef: string;
  phaseId: ApplicationPrivatePhase;
  intentDigest: string;
  sourceDigest: string;
  backendBindingDigest: string;
  binding: AzureArmBinding;
  artifact: ApplicationPrivateArtifact | null;
  artifactSet?: ApplicationPrivateArtifactSet;
  tools: { tofu: string; python: string; provider: string; providerVersion: string; hostId: string };
  changes: readonly ApplicationPrivateChange[];
  expiresAt: string;
}

export interface ApplicationPrivateObservation {
  address: string;
  resourceId: string;
  resourceType: string;
  exists: boolean;
  verified: boolean;
  /** Always a verification GET identity, never a mutation identity. */
  readbackRequestId: string;
  observedAt: string;
  values: Readonly<Record<string, unknown>>;
  privateDigest: string;
  runtime: null | {
    url: string; healthy: true; observedAt: string;
    /** Document/runtime health only: no browser, project program or JavaScript execution. */
    kind?: 'frontend-html/1';
    status?: 200;
    contentType?: 'text/html';
    bodyDigest?: string;
  };
  artifact?: ApplicationPrivateArtifactSelection;
  revisionName?: string;
  dependencies: readonly {
    resourceId: string;
    resourceType: string;
    readbackRequestId: string;
    method?: 'GET' | 'POST';
    principalId?: string;
    clientId?: string;
    tenantId?: string;
  }[];
  ownership?: { ownerId: string; resourceId: string; readbackRequestId: string; source: 'resource-tags' | 'parent-tags' };
}

export interface ApplicationPrivateSavedPlan {
  schemaVersion: 1;
  protocol: typeof applicationPrivateProtocol;
  transactionId: string;
  context: StateExecutionContext;
  intent: ApplicationPrivateIntent;
  source: ApplicationPrivateSource;
  directory: ApplicationPrivateDirectory;
  original: StateArtifactDescriptor;
  originalSnapshot: StateSnapshot;
  variables: StateArtifactDescriptor;
  savedPlan: StateArtifactDescriptor;
  shownPlan: StateArtifactDescriptor;
  installedFiles: readonly { path: string; digest: string; realPath: string }[];
  before: readonly ApplicationPrivateObservation[];
  review: ApplicationPrivateReview;
}

export interface ApplicationPrivateResourceIntent {
  schemaVersion: 1;
  protocol: typeof applicationPrivateProtocol;
  kind: 'resource-effect-intent';
  transactionId: string;
  planRef: string;
  savedPlanDigest: string;
  address: string;
  action: Exclude<ApplicationPrivateAction, 'no-op'>;
  targetResourceId: string;
  originalObservationDigest: string;
  governancePlanDigest: string;
  operationDigest: string;
  approvalEnvelopeHash: string;
  preparedAt: string;
  artifactSet?: ApplicationPrivateArtifactSet;
  artifactRole?: ApplicationArtifactRole;
}

export interface ApplicationPrivateEvent {
  sequence: number;
  kind: 'backend-intent' | 'backend-returned' | 'backend-uncertain' | 'resource-intent' |
    'native-started' | 'native-settled' | 'candidate-preserved' | 'resource-observed' |
    'publication-intent' | 'state-readback' | 'recovery-authorized' | 'blocked' | 'finished';
  at: string;
  details: Readonly<Record<string, unknown>>;
}

export interface ApplicationPrivateJournal {
  schemaVersion: 1;
  protocol: typeof applicationPrivateProtocol;
  transactionId: string;
  phaseId: ApplicationPrivatePhase;
  context: StateExecutionContext;
  intentDigest: string;
  originalApprovalEnvelopeHash: string;
  originalGovernancePlan: SavedTransitionPlan;
  applyGovernancePlan: SavedTransitionPlan | null;
  prepareOperationDigest: string;
  original: StateArtifactDescriptor | null;
  originalSnapshot: StateSnapshot | null;
  directory: ApplicationPrivateDirectory | null;
  planRef: string | null;
  effectIntents: readonly StateArtifactDescriptor[];
  nativeStarted: boolean;
  processSettled: boolean;
  nativeExitCode: number | null;
  candidate: StateArtifactDescriptor | null;
  candidateSnapshot: StateSnapshot | null;
  observations: readonly ApplicationPrivateObservation[];
  publication: 'none' | 'intent' | 'returned' | 'uncertain' | 'verified';
  publicationCorrelationId: string | null;
  applyApprovalEnvelopeHash: string | null;
  final: null | 'completed' | 'partial-published' | 'closed-unapplied';
  events: readonly ApplicationPrivateEvent[];
}

export interface ApplicationPrivateEffectResult {
  address: string;
  action: ApplicationPrivateAction;
  status: 'not-attempted' | 'attempted-uncertain' | 'observed';
  resourceId: string | null;
  mutationRequestId: null;
  readbackRequestId: string | null;
}

export interface ApplicationPrivateResult {
  status: 'prepared' | 'executed' | 'inspected' | 'partial-published' | 'closed-unapplied' | 'blocked';
  transactionId: string | null;
  journalRef: string | null;
  retainedCandidateRef: string | null;
  reviewed?: ApplicationPrivateReview;
  effects: readonly ApplicationPrivateEffectResult[];
  state: 'unchanged' | 'candidate-retained' | 'published-verified' | 'publication-uncertain' | 'unresolved-private-record';
  observations: readonly Omit<ApplicationPrivateObservation, 'values' | 'privateDigest'>[];
  identities: readonly { address: string; resourceId: string; principalId: string; clientId: string; tenantId: string }[];
  blocker?: string;
  additionalReview: 'exact-workload-rbac' | 'complete-application-deployment' | null;
  atomicAcrossProviders: false;
  qualification: 'unqualified-source-component';
}

export interface ApplicationPrivateCommandRunner extends PrivateStateCommandRunner {
  readonly purpose: 'application-resource-changes';
  run(command: ApplicationPrivateCommand): Promise<PrivateStateCommandResult>;
  quiesce(): Promise<void>;
}

export interface ApplicationPrivateCommand extends PrivateStateCommand {
  privatePlan?: {
    directory: string;
    savedPlanDigest: string;
    variablesDigest: string;
    originalDigest: string;
    installedFiles: ApplicationPrivateSavedPlan['installedFiles'];
  };
}

export interface ApplicationPrivateAuthority {
  input: PhaseAdapterExecutionInput;
  operation: TransitionOperation;
  operations: readonly TransitionOperation[];
  assertCurrent(): Promise<void>;
  assertRelease(): Promise<void>;
}

/** Explicit trusted adapter seam for synthetic fixtures, not qualification evidence. */
export interface ApplicationPrivateStorage {
  workspace: ProtectedStateWorkspace;
  assertDirectory(directory: string, context: StateExecutionContext): Promise<void>;
}

export interface ApplicationPrivateRuntime {
  storage: ApplicationPrivateStorage;
  context: StateExecutionContext;
  backend: StateBackendAdapter;
  runner: ApplicationPrivateCommandRunner;
  createDirectory(): Promise<ApplicationPrivateDirectory>;
  assertDirectory(directory: ApplicationPrivateDirectory): Promise<void>;
  observe(target: ApplicationPrivateTarget, verify: boolean, signal?: AbortSignal, expectedState?: Record<string, unknown>): Promise<ApplicationPrivateObservation>;
  assertProviders(signal?: AbortSignal): Promise<void>;
  assertArtifact(signal?: AbortSignal): Promise<void>;
  setBackendEffects(recorder: PrivateStateEffectRecorder): void;
}
