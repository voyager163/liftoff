export const statefulRecipeVersion = 'opentofu-state-migration/1' as const;

export type StateRecipe = 'address-refactor' | 'backend-relocation' | 'state-partition';
export type StateBackendKind = 'local' | 'azurerm';
export type StateAuthorityKind = 'state-read' | 'state-write' | 'state-recovery' | 'state-disposal';
export type StateArtifactPurpose = 'inspection' | 'state' | 'plan' | 'journal' | 'backup' | 'candidate' | 'recovery';
export type StateArtifactRef = string;

interface StateBackendBase {
  id: string;
  ownerId: string;
  format: 'opentofu-v4-json';
}

export interface LocalStateBinding extends StateBackendBase {
  kind: 'local';
  statePath: string;
  readOnlySource?: boolean;
}

export interface AzureBlobStateBinding extends StateBackendBase {
  kind: 'azurerm';
  tenantId: string;
  subscriptionId: string;
  resourceGroup: string;
  account: string;
  container: string;
  key: string;
  network: 'private' | 'public';
}

export type StateBackendBinding = LocalStateBinding | AzureBlobStateBinding;

export interface StateExecutionContext {
  projectRoot: string;
  projectId: string;
  configurationDigest: string;
  artifactDigest: string;
  cliDigest: string;
  hostId: string;
  principalId: string;
}

export interface StateAuthority {
  kind: StateAuthorityKind;
  fingerprint: string;
  expiresAt: number;
}

export const stateFailureCodes = [
  'invalid-binding', 'duplicate-binding', 'unsupported-backend', 'unsupported-encryption',
  'live-scope-required', 'state-read-approval-required', 'approval-mismatch', 'expired',
  'protected-workspace-required', 'key-unavailable', 'unsafe-path', 'storage-limit',
  'artifact-integrity', 'artifact-purpose', 'access-denied', 'incomplete-observation',
  'stale-state', 'lock-unavailable', 'lock-lost', 'native-lock-provider-required',
  'invalid-state', 'unsupported-state', 'mapping-incomplete', 'mapping-conflict',
  'resource-change', 'resource-identity-changed', 'destination-conflict',
  'configuration-changed', 'unsafe-planning-contract', 'unqualified-combination',
  'tool-unavailable', 'native-command-failed', 'timeout', 'cancelled',
  'writers-not-quiesced', 'verification-incomplete', 'recovery-required',
  'recovery-conflict', 'not-due', 'ownership-mismatch', 'operation-failed',
  'unsupported-local-state-operation', 'unsupported-native-platform',
  'process-tree-termination-unproven'
] as const;
export type StateFailureCode = typeof stateFailureCodes[number];

export interface StateBlocker {
  code: StateFailureCode;
  backendRef?: string;
}

export class StateMigrationError extends Error {
  readonly code: StateFailureCode;
  constructor(code: StateFailureCode) {
    const safe = stateFailureCodes.includes(code) ? code : 'operation-failed';
    super(`Protected state operation blocked: ${safe}.`);
    this.code = safe;
    this.name = 'StateMigrationError';
  }
}

export interface StateBackendMetadata {
  backendId: string;
  bindingDigest: string;
  exists: boolean;
  version: string | null;
  etag: string | null;
  size: number;
  observedAt: number;
  operationId?: string;
}

export interface StateSnapshot extends StateBackendMetadata {
  lineage: string | null;
  serial: number | null;
  digest: string | null;
  inventoryDigest: string;
}

export interface StateInstance {
  address: string;
  mode: 'managed' | 'data';
  type: string;
  provider: string;
  identityDigest: string;
  valueDigest: string;
}

export interface InspectedState {
  snapshot: StateSnapshot;
  instances: readonly StateInstance[];
  stateRef: StateArtifactRef | null;
}

export interface StateInspectionRecord {
  schemaVersion: 1;
  context: StateExecutionContext;
  bindings: readonly StateBackendBinding[];
  states: readonly InspectedState[];
  readFingerprint: string;
  live: boolean;
  expiresAt: number;
}

export interface StateMetadataResult {
  schemaVersion: 1;
  operationKind: 'state-metadata';
  contextDigest: string;
  bindingsDigest: string;
  fingerprint: string;
  observations: readonly StateBackendMetadata[];
  expiresAt: number;
  blockers: readonly StateBlocker[];
}

export interface StateInspectionResult {
  schemaVersion: 1;
  operationKind: 'state-inspection';
  inspectionRef: StateArtifactRef;
  fingerprint: string;
  workspaceRef: string;
  states: readonly {
    backendRef: string;
    exists: boolean;
    stateDigest: string | null;
    inventoryDigest: string;
    instanceCount: number;
    serial: number | null;
    lineageDigest: string | null;
  }[];
  expiresAt: number;
}

export interface StateInstanceMapping {
  sourceAddress: string;
  destinationBackendId: string;
  destinationAddress: string;
  disposition: 'move' | 'preserve';
}

export interface StateMigrationIntent {
  recipe: StateRecipe;
  sourceBackendId: string;
  destinationBackendIds: readonly string[];
  mappings: readonly StateInstanceMapping[];
  sourceConfigurationRef: string;
  targetConfigurationRefs: Readonly<Record<string, string>>;
  targetConfigurationDigest: string;
  targetInventoryDigest: string;
  writerInventoryDigest: string;
  retentionMs: number;
  recovery: readonly ('forward' | 'remove-new-destinations')[];
}

export interface StateNativeReview {
  configurationDigest: string;
  configurationDigests: Readonly<Record<string, string>>;
  contractDigest: string;
  savedPlanRefs: readonly StateArtifactRef[];
  savedPlanDigests: readonly string[];
}

export interface StateMigrationPlan {
  schemaVersion: 1;
  recipeVersion: typeof statefulRecipeVersion;
  context: StateExecutionContext;
  inspectionRef: StateArtifactRef;
  inspection: StateInspectionRecord;
  intent: StateMigrationIntent;
  review: StateNativeReview;
  fingerprint: string;
  expiresAt: number;
}

export interface StatePlanResult {
  schemaVersion: 1;
  operationKind: 'stateful-migration';
  executable: boolean;
  planRef: StateArtifactRef | null;
  fingerprint: string | null;
  recipe: StateRecipe;
  recipeVersion: typeof statefulRecipeVersion;
  authority: 'state-write';
  workspaceRef: string;
  mappingDigest: string;
  sourceRef: string;
  destinationRefs: readonly string[];
  instanceCount: number;
  expiresAt: number;
  blockers: readonly StateBlocker[];
}

export interface StateBackendLease {
  readonly backendId: string;
  readonly kind: 'native-file' | 'blob-lease' | 'conditional-create';
  assertHeld(signal?: AbortSignal): Promise<void>;
  release(): Promise<void>;
}

/** Adapter payloads are private; only application result projections may be rendered. */
export interface StateBackendAdapter {
  readonly binding: StateBackendBinding;
  metadata(context: StateExecutionContext, signal?: AbortSignal): Promise<StateBackendMetadata>;
  assertAccess(context: StateExecutionContext, write: boolean, signal?: AbortSignal): Promise<void>;
  readPrivate(expected: StateBackendMetadata, context: StateExecutionContext, lease?: StateBackendLease, signal?: AbortSignal): Promise<Uint8Array>;
  acquire(expected: StateBackendMetadata, context: StateExecutionContext, operationId: string, signal?: AbortSignal): Promise<StateBackendLease>;
  writePrivate(request: {
    bytes: Uint8Array;
    expected: StateSnapshot;
    lease: StateBackendLease;
    context: StateExecutionContext;
    operationId: string;
    signal?: AbortSignal;
  }): Promise<StateBackendMetadata>;
  remove(request: {
    expected: StateSnapshot;
    lease: StateBackendLease;
    context: StateExecutionContext;
    operationId: string;
    signal?: AbortSignal;
  }): Promise<StateBackendMetadata>;
}

export interface StateArtifactDescriptor {
  ref: StateArtifactRef;
  digest: string;
  purpose: StateArtifactPurpose;
  scope: string;
}

export interface ProtectedStateWorkspace {
  readonly workspaceRef: string;
  assertAvailable(context: StateExecutionContext): Promise<void>;
  put(purpose: StateArtifactPurpose, scope: string, bytes: Uint8Array, id?: string): Promise<StateArtifactDescriptor>;
  get(ref: StateArtifactRef, purpose: StateArtifactPurpose, scope: string): Promise<Uint8Array>;
  describe(ref: StateArtifactRef, purpose: StateArtifactPurpose, scope: string): Promise<StateArtifactDescriptor | null>;
  replace(ref: StateArtifactRef, purpose: StateArtifactPurpose, scope: string, previousDigest: string, bytes: Uint8Array): Promise<StateArtifactDescriptor>;
  removeExact(descriptor: StateArtifactDescriptor): Promise<void>;
  withScratch<T>(context: StateExecutionContext, action: (directory: string) => Promise<T>): Promise<T>;
}

export interface PreparedStateMigration {
  candidates: Readonly<Record<string, InspectedState>>;
  verificationDigest: string;
}

export interface StateNativeDriver {
  quiesce?(): Promise<void>;
  review(plan: {
    context: StateExecutionContext;
    inspection: StateInspectionRecord;
    intent: StateMigrationIntent;
    signal?: AbortSignal;
  }): Promise<StateNativeReview>;
  prepare(plan: StateMigrationPlan, signal?: AbortSignal): Promise<PreparedStateMigration>;
  verifyDestinations(plan: StateMigrationPlan, current: Readonly<Record<string, InspectedState>>, signal?: AbortSignal): Promise<string>;
  verify(plan: StateMigrationPlan, current: Readonly<Record<string, InspectedState>>, signal?: AbortSignal): Promise<string>;
}

export interface StateWriterCoordinator {
  inspectConfiguration(context: StateExecutionContext, signal?: AbortSignal): Promise<string>;
  quiesce(request: {
    operationId: string;
    context: StateExecutionContext;
    backendIds: readonly string[];
    writerInventoryDigest: string;
    signal?: AbortSignal;
  }): Promise<string>;
  assertQuiesced(handle: string, writerInventoryDigest: string, signal?: AbortSignal): Promise<void>;
  commitConfiguration(request: {
    operationId: string;
    writerHandle: string;
    beforeDigest: string;
    afterDigest: string;
    mappingDigest: string;
    signal?: AbortSignal;
  }): Promise<void>;
  verifyCutover(request: {
    operationId: string;
    writerHandle: string;
    configurationDigest: string;
    mappingDigest: string;
    signal?: AbortSignal;
  }): Promise<string>;
  publishInventory(request: {
    operationId: string;
    planFingerprint: string;
    inventoryDigest: string;
    verificationDigest: string;
    signal?: AbortSignal;
  }): Promise<void>;
  resume(request: {
    operationId: string;
    writerHandle: string;
    configurationDigest: string;
    signal?: AbortSignal;
  }): Promise<void>;
}

export type StateCheckpointKind =
  | 'started' | 'writers-pause-intent' | 'writers-paused' | 'backups-verified' | 'prepared'
  | 'write-intent' | 'destination-written' | 'destinations-verified'
  | 'source-retirement-intent' | 'source-retired'
  | 'configuration-intent' | 'configuration-committed' | 'cutover-verified'
  | 'inventory-intent' | 'inventory-published' | 'writers-resumed'
  | 'compensation-intent' | 'compensated' | 'verified' | 'blocked';

export interface StateCheckpoint {
  sequence: number;
  kind: StateCheckpointKind;
  at: number;
  backendId?: string;
  snapshot?: StateSnapshot;
  code?: StateFailureCode;
}

export interface StateMigrationJournal {
  schemaVersion: 1;
  operationId: string;
  planRef: StateArtifactRef;
  plan: StateMigrationPlan;
  writerHandle: string | null;
  backups: readonly StateArtifactDescriptor[];
  prepared: PreparedStateMigration | null;
  checkpoints: readonly StateCheckpoint[];
  completedAt: number | null;
  compensated: boolean;
}

export interface StateMigrationResult {
  schemaVersion: 1;
  operationKind: 'stateful-migration' | 'state-recovery';
  status: 'rejected' | 'incomplete' | 'verified' | 'compensated';
  exitCode: 0 | 1 | 2;
  operationRef: string | null;
  journalRef: StateArtifactRef | null;
  planFingerprint: string;
  workspaceRef: string;
  repairScopeComplete: boolean;
  atomicAcrossBackends: false;
  checkpoints: readonly { sequence: number; kind: StateCheckpointKind; backendRef?: string }[];
  blockers: readonly StateBlocker[];
  lifecycle: { status: 'not-started' | 'retained'; notBefore: number | null; artifactCount: number };
}

export interface StateRecoveryPlan {
  schemaVersion: 1;
  journalRef: StateArtifactRef;
  journalDigest: string;
  inspection: StateInspectionRecord;
  mode: 'forward' | 'remove-new-destinations';
  context: StateExecutionContext;
  fingerprint: string;
  expiresAt: number;
}

export interface StateRecoveryResult {
  schemaVersion: 1;
  operationKind: 'state-recovery-plan';
  executable: boolean;
  recoveryRef: StateArtifactRef | null;
  fingerprint: string | null;
  mode: StateRecoveryPlan['mode'];
  blockers: readonly StateBlocker[];
  expiresAt: number;
}

export interface StateMigrationDependencies {
  workspace: ProtectedStateWorkspace;
  backend(binding: StateBackendBinding): StateBackendAdapter;
  native: StateNativeDriver;
  writers: StateWriterCoordinator;
  now?: () => number;
  observationTtlMs?: number;
  maxStateBytes?: number;
  operationTimeoutMs?: number;
}

export interface RetainedStateKeyBinding {
  keyRef: string;
  version: string;
  ownerProjectId: string;
  operationId: string;
  exclusiveArtifactRefs: readonly StateArtifactRef[];
}

export interface RetainedStateKeyProvider {
  inspect(keyRef: string, context: StateExecutionContext, signal?: AbortSignal): Promise<RetainedStateKeyBinding | null>;
  destroy(expected: RetainedStateKeyBinding, context: StateExecutionContext, signal?: AbortSignal): Promise<void>;
}

export interface StateDisposalPlan {
  schemaVersion: 1;
  context: StateExecutionContext;
  journalRef: StateArtifactRef;
  journalDigest: string;
  operationId: string;
  artifacts: readonly StateArtifactDescriptor[];
  keys: readonly RetainedStateKeyBinding[];
  notBefore: number;
  expiresAt: number;
  fingerprint: string;
}

export interface StateLifecycleResult {
  schemaVersion: 1;
  operationKind: 'state-lifecycle';
  status: 'retained' | 'due' | 'disposed' | 'blocked';
  executable: boolean;
  disposalRef: StateArtifactRef | null;
  progressRef: StateArtifactRef | null;
  fingerprint: string | null;
  artifactCount: number;
  keyCount: number;
  notBefore: number | null;
  expiresAt: number | null;
  blockers: readonly StateBlocker[];
}

export interface ObserveStateMetadataRequest {
  context: StateExecutionContext;
  bindings: readonly StateBackendBinding[];
  live: boolean;
  signal?: AbortSignal;
}

export interface InspectApprovedStateRequest extends ObserveStateMetadataRequest {
  discovery: StateMetadataResult;
  approval: StateAuthority;
}

export interface BuildStateMigrationPlanRequest {
  context: StateExecutionContext;
  inspectionRef: StateArtifactRef;
  intent: StateMigrationIntent;
  signal?: AbortSignal;
}

export interface ValidateStateMigrationPlanRequest {
  context: StateExecutionContext;
  planRef: StateArtifactRef;
  approval: StateAuthority;
}

export interface ExecuteStateMigrationRequest extends ValidateStateMigrationPlanRequest {
  signal?: AbortSignal;
}

export interface BuildStateRecoveryPlanRequest {
  context: StateExecutionContext;
  journalRef: StateArtifactRef;
  inspectionRef: StateArtifactRef;
  mode: StateRecoveryPlan['mode'];
  signal?: AbortSignal;
}

export interface ExecuteStateRecoveryRequest {
  context: StateExecutionContext;
  recoveryRef: StateArtifactRef;
  approval: StateAuthority;
  signal?: AbortSignal;
}

export interface InspectStateMigrationRequest {
  context: StateExecutionContext;
  journalRef: StateArtifactRef;
}

export interface BuildStateDisposalPlanRequest extends InspectStateMigrationRequest {
  keyRefs?: readonly string[];
  signal?: AbortSignal;
}

export interface DisposeRetainedStateRequest {
  context: StateExecutionContext;
  disposalRef: StateArtifactRef;
  approval: StateAuthority;
  signal?: AbortSignal;
}

export interface StateMigrationService {
  readonly workspaceRef: string;
  observeMetadata(request: ObserveStateMetadataRequest): Promise<StateMetadataResult>;
  inspect(request: InspectApprovedStateRequest): Promise<StateInspectionResult>;
  plan(request: BuildStateMigrationPlanRequest): Promise<StatePlanResult>;
  validate(request: ValidateStateMigrationPlanRequest): Promise<readonly StateBlocker[]>;
  execute(request: ExecuteStateMigrationRequest): Promise<StateMigrationResult>;
  inspectOperation(request: InspectStateMigrationRequest): Promise<StateMigrationResult>;
  planRecovery(request: BuildStateRecoveryPlanRequest): Promise<StateRecoveryResult>;
  recover(request: ExecuteStateRecoveryRequest): Promise<StateMigrationResult>;
  planDisposal(request: BuildStateDisposalPlanRequest): Promise<StateLifecycleResult>;
  dispose(request: DisposeRetainedStateRequest): Promise<StateLifecycleResult>;
}

export interface StateEncryptionKeyProvider {
  describe(keyRef: string, context: StateExecutionContext): Promise<{
    keyRef: string;
    ownerId: string;
    hostId: string;
    storage: 'external-key-provider';
    algorithm: 'aes-256-gcm';
  }>;
  withKey<T>(keyRef: string, action: (key: Uint8Array) => Promise<T>): Promise<T>;
}

export interface ProtectedArtifactStorage {
  assertAvailable(context: StateExecutionContext): Promise<void>;
  create(id: string, bytes: Uint8Array): Promise<void>;
  read(id: string): Promise<Uint8Array>;
  compareExchange(id: string, previousDigest: string, bytes: Uint8Array): Promise<void>;
  remove(id: string, expectedDigest: string): Promise<void>;
  withScratch<T>(context: StateExecutionContext, action: (directory: string) => Promise<T>): Promise<T>;
}

export interface ProtectedVolumeAttestor {
  verify(directory: string, context: StateExecutionContext): Promise<{
    canonicalDirectory: string;
    hostId: string;
    encryptedVolume: true;
    privateAccess: true;
    storageClass: 'protected-state-workspace';
    expiresAt: number;
  }>;
}

/**
 * Must use OpenTofu-compatible OS file locking, not just a sibling lock file.
 * Replacement/removal must retain that boundary, including an absent destination.
 */
export interface NativeLocalStateLockProvider {
  readonly capabilities?: {
    protocol: 'opentofu-1.12.6-posix-fcntl';
    existingInPlace: true;
    createAbsent: false;
    remove: false;
  };
  acquire(request: {
    path: string;
    operationId: string;
    expectedVersion: string | null;
    signal?: AbortSignal;
  }): Promise<{
    assertHeld(): Promise<void>;
    replace(bytes: Uint8Array, expectedVersion: string | null): Promise<void>;
    remove(expectedVersion: string): Promise<void>;
    release(): Promise<void>;
  }>;
}

export interface AzureStateTokenProvider {
  getToken(request: {
    tenantId: string;
    principalId: string;
    scope: 'https://storage.azure.com/.default';
    signal: AbortSignal;
  }): Promise<{ token: string; tenantId: string; principalId: string; expiresAt: number }>;
}

export interface AzureBlobAccessProvider {
  observe(binding: AzureBlobStateBinding, context: StateExecutionContext, write: boolean, signal?: AbortSignal): Promise<{
    bindingDigest: string;
    ownerId: string;
    hostId: string;
    principalId: string;
    network: 'private' | 'public';
    reachable: boolean;
    canRead: boolean;
    canWrite: boolean;
    serverSideEncryption: boolean;
    versioning: boolean;
    softDelete: boolean;
    expiresAt: number;
  }>;
}

export interface AzureStateRequest {
  binding: AzureBlobStateBinding;
  context: StateExecutionContext;
  method: 'HEAD' | 'GET' | 'PUT' | 'DELETE';
  target: 'blob' | 'container' | 'lease';
  headers?: Readonly<Record<string, string>>;
  body?: Uint8Array;
  operationId?: string;
  signal?: AbortSignal;
}

export interface AzureStateResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}

export interface AzureStateTransport {
  request(request: AzureStateRequest): Promise<AzureStateResponse>;
}

export interface PrivateStateCommand {
  args: readonly string[];
  cwd: string;
  operation: 'inspect' | 'transform';
  stdin?: Uint8Array;
  signal?: AbortSignal;
}

export interface PrivateStateCommandResult {
  exitCode: number;
  stdout: Uint8Array;
}

export interface PrivateStateCommandRunner {
  readonly identityDigest: string;
  run(command: PrivateStateCommand): Promise<PrivateStateCommandResult>;
  quiesce?(): Promise<void>;
}

export interface NativeStateHost {
  verify(directory: string, operation: PrivateStateCommand['operation']): Promise<{
    directory: string;
    encryptedVolume: true;
    isolated: true;
    providerIdentityReadOnly: true;
    providerRegistrationDisabled: true;
  }>;
  privateEnvironment(directory: string): Promise<Readonly<Record<string, string>>>;
  quiesce?(): Promise<void>;
  /** Legacy host hook; private runners use their own owned-process supervisor. */
  terminateProcessTree?(pid: number): Promise<void>;
}

export interface StateConfigurationAttestation {
  configurationRef: string;
  configurationDigest: string;
  artifactDigest: string;
  backendNeutral: true;
  stateFormat: 'opentofu-v4-json';
  providerRegistration: 'disabled';
  provisioners: readonly never[];
  externalPrograms: readonly never[];
  uninspectedDataSources: readonly never[];
  unresolvedModules: readonly never[];
  providers: readonly { source: string; version: string; binaryDigest: string }[];
  providerMirrorDirectory: string;
  moduleDigests: readonly string[];
}

export interface StateConfigurationProvider {
  materialize(reference: string, directory: string, context: StateExecutionContext, signal?: AbortSignal): Promise<StateConfigurationAttestation>;
  verifyMaterialized(reference: string, directory: string, expected: StateConfigurationAttestation, signal?: AbortSignal): Promise<void>;
}

export interface StateRecipeQualification {
  assertQualified(request: {
    recipeVersion: typeof statefulRecipeVersion;
    recipe: StateRecipe;
    source: StateBackendKind;
    destinations: readonly StateBackendKind[];
    executableDigest: string;
    hostId: string;
  }): Promise<void>;
}

export interface StateRegisteredExecutable {
  path: string;
  sha256: string;
}

export interface NativeLocalStateTools {
  python: StateRegisteredExecutable;
  tofu: StateRegisteredExecutable;
  pythonVersion: string;
  tofuVersion: '1.12.6';
  hostId: string;
}

export interface NativeLocalQualificationResult {
  schemaVersion: 1;
  kind: 'native-local-state-qualification';
  status: 'verified';
  platform: 'darwin';
  hostRef: string;
  tofuVersion: '1.12.6';
  tofuBinaryDigest: string;
  pythonBinaryDigest: string;
  protocolDigest: string;
  sourceCommit: string;
  observedAt: number;
  checks: readonly string[];
  stateScope: 'synthetic-disposable-only';
  azureLiveQualification: 'not-performed';
  atomicStateReplacement: false;
}

export interface LinuxNativeLocalQualificationResult extends Omit<NativeLocalQualificationResult, 'schemaVersion' | 'platform'> {
  schemaVersion: 2;
  platform: 'linux';
  architecture: 'x64' | 'arm64';
  encryptedCustodyQualification: 'not-performed';
}

export interface DarwinStateVolumeObservation {
  canonicalDirectory: string;
  deviceNode: string;
  volumeId: string;
  filesystem: string;
  fileVault: boolean;
  encrypted: boolean;
  locked: boolean;
  ownerUid: number;
  mode: number;
  aclEntries: number;
  hostId: string;
}

export interface DarwinStateKeychainReference {
  keychainPath: string;
  service: string;
  account: string;
}

export interface DarwinStateSystemBridge {
  request(operation: 'volume' | 'keychain-metadata' | 'keychain-secret', input: object, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

export interface DarwinStateStorageProfileOptions {
  tools: NativeLocalStateTools;
  workspaceRoot: string;
  workspaceId?: string;
  keyReference: DarwinStateKeychainReference;
  projectId: string;
}

export interface DarwinStateStorageProfile {
  workspace: ProtectedStateWorkspace;
  volume: ProtectedVolumeAttestor;
  keys: StateEncryptionKeyProvider;
  keyRef: string;
  locks: NativeLocalStateLockProvider;
  hostId: string;
}

export interface DarwinAzureReaderReference extends DarwinStateKeychainReference {
  tenantId: string;
  subscriptionId: string;
  clientId: string;
  principalId: string;
}

export interface DarwinLocalStateExecutionProfileOptions extends DarwinStateStorageProfileOptions {
  context: StateExecutionContext;
  readerReference: DarwinAzureReaderReference;
  nativeQualification: NativeLocalQualificationResult;
  liveQualification?: StateRecipeQualification;
  configurations: StateConfigurationProvider;
  writers: StateWriterCoordinator;
}

export interface DarwinLocalStateExecutionProfile extends DarwinStateStorageProfile {
  service: StateMigrationService;
  qualification: StateRecipeQualification;
  nativeQualification: NativeLocalQualificationResult;
  liveQualification: 'supplied' | 'required';
}
