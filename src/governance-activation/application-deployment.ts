import { createHash } from 'node:crypto';
import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import type {
  ExternalOperationState, LiveReadbackProof
} from '../domain/governance/activation/types.js';
import type {
  PhaseAdapterExecutionInput, PhasePlanningInput
} from './transition-ports.js';
import {
  applicationBudget, applicationEnvironment, applicationError, applicationReadbackProof
} from './application-readiness.js';
import {
  applicationPrerequisiteBinding
} from './application-prerequisites.js';
import {
  readVerifiedApplicationArtifact, type VerifiedApplicationArtifact
} from './application-artifact.js';
import { azureBackendConfiguration } from './azure-backend-readiness.js';
import {
  activationInputPathIsObserved, isSensitiveActivationPath
} from './inputs.js';
import {
  azureObject, expectedAzureEnvironmentBindings, runAzureJson
} from './azure-discovery.js';

const sourceModePattern = /^100(?:644|755)$/u;
const sourceObjectPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const maximumSourceFiles = 512;
const maximumSourceBytes = 8 * 1024 * 1024;
const maximumFileBytes = 1024 * 1024;
const maximumHealthBodyBytes = 64 * 1024;

export interface ApplicationDeploymentStateTransition {
  resourceType: string;
  resourceId: string;
  disposition: 'move' | 'import' | 'retain-external';
  fromAddress: string | null;
  toAddress: string | null;
}

export interface ApplicationAuthoritativeRecord {
  phaseId: 'remote-import-verified' | 'application-prerequisites-ready' |
    'application-artifact-ready';
  evidenceId: string;
  headerDigest: string;
  bindingDigest: string;
}

export interface ApplicationOwnedResourceConfiguration {
  resourceType: string;
  resourceId: string;
  stateAddress: string;
  authoritativeRecord: ApplicationAuthoritativeRecord;
  attributes: Readonly<Record<string, unknown>>;
  configurationDigest: string;
}

export interface ApplicationDeploymentBinding {
  schemaVersion: 1;
  phaseId: 'application-foundation';
  sourceSha: string;
  environment: string;
  subscriptionId: string;
  tenantId: string;
  region: string;
  resourceGroup: string;
  resourceGroupId: string;
  applicationRoot: string;
  applicationModule: string;
  providerLockPath: string;
  localBackendPath: string;
  remoteBackendExamplePath: string;
  environmentVariablesPath: string;
  artifactBindingDigest: string;
  artifactDigest: string;
  immutableImage: string;
  prerequisiteBindingDigest: string;
  registryId: string;
  identityId: string;
  workloadPrincipalId: string;
  workloadClientId: string;
  pullRoleId: string;
  pushRoleId: string;
  backendBindingDigest: string;
  bootstrapBindingDigest: string;
  custodyIdentityDigest: string;
  custodyQualificationDigest: string;
  retentionObligationDigest: string;
  authoritativeRecords: {
    bootstrap: ApplicationAuthoritativeRecord;
    prerequisites: ApplicationAuthoritativeRecord;
    artifact: ApplicationAuthoritativeRecord;
  };
  expectedResourceNames: Record<string, string>;
  requiredResourceIds: readonly string[];
  stateTransitions: readonly ApplicationDeploymentStateTransition[];
  ownedResourceConfigurations: readonly ApplicationOwnedResourceConfiguration[];
  ownedResourceConfigurationDigest: string;
  variableOverrides: Readonly<Record<string, string>>;
  protectedVariableNames: readonly ['postgres_admin_password'];
  healthTargets: readonly {
    component: 'backend';
    method: 'GET';
    path: '/health';
  }[];
  budget: {
    currency: string;
    fixedMonthlyCents: number;
    usageMonthlyCents: number;
  };
  requirements: {
    newEnvironmentOnly: true;
    sameOperationOwnedPrerequisitesOnly: true;
    protectedExecutionRequired: true;
    protectedRemoteBackendRequired: true;
    localStateFallback: false;
    plaintextStateFallback: false;
    arbitraryStateImport: false;
    sourceReplacement: false;
    immutableArtifactRequired: true;
    uncertainRedispatch: false;
  };
  bindingDigest: string;
}

export interface ApplicationDeploymentSourceFile {
  path: string;
  mode: '100644' | '100755';
  objectId: string;
  bytes: number;
  sha256: string;
}

export interface ObservedApplicationDeploymentSource {
  binding: ApplicationDeploymentBinding;
  files: readonly ApplicationDeploymentSourceFile[];
  executionFiles: readonly ApplicationDeploymentSourceFile[];
  sourceInventoryDigest: string;
  executionInventoryDigest: string;
  providerLockDigest: string;
  localBackendDigest: string;
  backendOverlay: {
    path: 'backend.tf';
    bytes: number;
    sha256: string;
  };
  variableOverlay: {
    path: 'liftoff.auto.tfvars.json';
    digest: string;
    keys: readonly string[];
  };
  requiredProtectedVariables: readonly ['postgres_admin_password'];
}

export interface ProtectedApplicationPlanProof {
  schemaVersion: 1;
  kind: 'protected-application-plan.v1';
  bindingDigest: string;
  sourceInventoryDigest: string;
  executionInventoryDigest: string;
  providerLockDigest: string;
  backendOverlaySha256: string;
  variableOverlayDigest: string;
  planDigest: string;
  plannedAt: string;
  changes: {
    add: number;
    change: 0;
    destroy: 0;
  };
  resourceIds: readonly string[];
  stateTransitions: readonly ApplicationDeploymentStateTransition[];
  ownedResourceConfigurations: readonly {
    resourceId: string;
    stateAddress: string;
    configurationDigest: string;
  }[];
  cost: {
    currency: string;
    fixedMonthlyCents: number;
    usageMonthlyCents: number;
  };
  protectedInputs: readonly {
    name: 'postgres_admin_password';
    source: 'qualified-protected-input';
    valueIncluded: false;
  }[];
  checks: {
    initializedProtectedBackend: true;
    validatedConfiguration: true;
    providerLockVerified: true;
    artifactDigestBound: true;
    sourceUnchanged: true;
    plaintextStateAbsent: true;
    existingDeploymentAdoption: false;
  };
}

export interface ProtectedApplicationCompletionProof {
  schemaVersion: 1;
  kind: 'protected-application-apply.v1';
  bindingDigest: string;
  planDigest: string;
  sourceInventoryDigest: string;
  operation: ExternalOperationState;
  stateLineage: string;
  stateSerial: number;
  appliedResourceIds: readonly string[];
  outputs: {
    backendUrl: string;
    immutableImage: string;
  };
  health: readonly {
    component: 'backend';
    method: 'GET';
    path: '/health';
    endpoint: string;
    status: 200;
    bodyBytes: number;
    bodySha256: string;
    observedAt: string;
    healthy: true;
  }[];
  noChangePlanDigest: string;
  completedAt: string;
  checks: {
    protectedBackend: true;
    exactPlanApplied: true;
    providerReadbackComplete: true;
    noChangePlan: true;
    plaintextStateAbsent: true;
    sourceUnchanged: true;
  };
}

export interface ApplicationDeploymentReadback {
  observed: {
    kind: 'application-foundation-readback.v1';
    bindingDigest: string;
    sourceInventoryDigest: string;
    planDigest: string;
    operationId: string;
    resourceGroupId: string;
    backendResourceId: string;
    backendUrl: string;
    immutableImage: string;
    revision: unknown;
    health: {
      endpoint: string;
      status: 200;
      bodyBytes: number;
      bodySha256: string;
      observedAt: string;
    };
    noChangePlanDigest: string;
    appliedResourceCount: number;
  };
  liveReadback: readonly LiveReadbackProof[];
}

export interface ProtectedApplicationExecutionProvenance {
  executionHostId: string;
  runnerId: number;
  runnerLabel: string;
  runnerGroupId: number;
  networkConfigurationId: string;
  runnerQualificationDigest: string;
  networkQualificationDigest: string;
  custodyIdentityDigest: string;
  custodyQualificationDigest: string;
  workflow: {
    repository: string;
    path: string;
    ref: string;
    sourceSha: string;
    workflowDigest: string;
    executionSourceDigest: string;
  };
  provenanceDigest: string;
}

export interface ApplicationOriginalInvocation {
  phaseId: 'application-foundation' | 'staging-qualified' | 'production-rehearsed';
  graphHash: string;
  stateHash: string | null;
  baselineDigest: string;
  inputDigest: string;
  transitionDigest: string;
  planDigest: string;
  operationDigest: string;
  approvalEnvelopeId: string;
  approvalEnvelopeHash: string;
  createdAt: string;
  expiresAt: string;
  invocationDigest: string;
}

export interface ApplicationStateMappingProof {
  resourceType: string;
  resourceId: string;
  disposition: 'move' | 'import';
  fromAddress: string | null;
  toAddress: string;
  authoritativeRecord: ApplicationAuthoritativeRecord;
  expectedConfigurationDigest: string;
  before: {
    stateLineage: string;
    stateSerial: number;
    stateDigest: string;
    backupArtifactDigest: string;
    backupKeyRefDigest: string;
    lockProofDigest: string;
    writerQuiescenceDigest: string;
  };
  after: {
    stateLineage: string;
    stateSerial: number;
    stateDigest: string;
    lockProofDigest: string;
    writerQuiescenceDigest: string;
  };
  unmappedStateDigestBefore: string;
  unmappedStateDigestAfter: string;
  observedConfigurationDigest: string;
  resourceMutationPerformed: false;
  custodyIdentityDigest: string;
  custodyQualificationDigest: string;
  retentionObligationDigest: string;
  proofDigest: string;
}

interface ProtectedApplicationExecutionBase {
  schemaVersion: 1;
  binding: ApplicationDeploymentBinding;
  source: ObservedApplicationDeploymentSource;
  provenance: ProtectedApplicationExecutionProvenance;
  invocation: ApplicationOriginalInvocation;
}

interface ProtectedApplicationWriteBase extends ProtectedApplicationExecutionBase {
  mode: 'write';
  action: 'application-foundation';
  plan: ProtectedApplicationPlanProof;
  intent: ProtectedApplicationExecutionIntent;
  effects: {
    azureResourceProvision: true;
    azureRead: true;
    protectedBackendRead: true;
    protectedBackendWrite: true;
    stateMappings: readonly ApplicationDeploymentStateTransition[];
    arbitraryImport: false;
    resourceGroupReplacement: false;
    externalPushRoleRetained: true;
  };
}

export interface ProtectedApplicationWriteDispatchRequest
  extends ProtectedApplicationWriteBase {
  execution: 'dispatch';
  previousOperation: null;
}

export interface ProtectedApplicationWriteObservationRequest
  extends ProtectedApplicationWriteBase {
  execution: 'observe';
  previousOperation: ExternalOperationState | null;
  observationReason: 'accepted-handle' | 'intent-without-handle';
}

export type ProtectedApplicationWriteRequest =
  | ProtectedApplicationWriteDispatchRequest
  | ProtectedApplicationWriteObservationRequest;

export interface ProtectedApplicationReadRequest extends ProtectedApplicationExecutionBase {
  mode: 'read-only';
  action: 'staging-qualified' | 'production-rehearsed';
  execution: 'observe';
  previousOperation: ExternalOperationState;
  admittedOperation: ExternalOperationState;
  admittedCompletionDigest: string;
  expectedPlanDigest: string;
  expectedHealthDigest: string;
  permissions: {
    azureRead: true;
    stateRead: false;
    stateWrite: false;
    dispatch: false;
    import: false;
    move: false;
    apply: false;
  };
}

export interface ProtectedApplicationExecutionIntent {
  kind: 'protected-application-intent.v1';
  requestDigest: string;
  invocationDigest: string;
  provenanceDigest: string;
  bindingDigest: string;
  sourceInventoryDigest: string;
  protectedPlanDigest: string;
  intentId: string;
  recordedAt: string;
  checkpointDigest: string;
}

export interface ProtectedApplicationAcceptedCheckpoint {
  kind: 'protected-application-accepted.v1';
  requestDigest: string;
  intentCheckpointDigest: string;
  operation: ExternalOperationState;
  acceptedAt: string;
  checkpointDigest: string;
}

export interface ProtectedApplicationTerminalCheckpoint {
  kind: 'protected-application-terminal.v1';
  requestDigest: string;
  intentCheckpointDigest: string;
  acceptedCheckpointDigest: string;
  operation: ExternalOperationState;
  terminalAt: string;
  checkpointDigest: string;
}

export interface ProtectedApplicationExecutionCheckpoints {
  recordIntent(checkpoint: ProtectedApplicationExecutionIntent): Promise<void>;
  recordAccepted(checkpoint: ProtectedApplicationAcceptedCheckpoint): Promise<void>;
  recordTerminal(checkpoint: ProtectedApplicationTerminalCheckpoint): Promise<void>;
}

export type ProtectedApplicationExecutionFailureReason =
  | 'capability-unavailable'
  | 'stale-binding'
  | 'stale-invocation'
  | 'stale-execution-source'
  | 'ownership-unverified'
  | 'protected-input-unavailable'
  | 'backend-unavailable'
  | 'mapping-unverified'
  | 'configuration-mismatch'
  | 'concurrency-conflict'
  | 'cost-exceeded'
  | 'health-unverified'
  | 'verification-failed'
  | 'operation-failed';

export type ProtectedApplicationNoEffectResult = {
  status: 'blocked';
  effect: 'none';
  reason: ProtectedApplicationExecutionFailureReason;
};

export type ProtectedApplicationWriteResult =
  | ProtectedApplicationNoEffectResult
  | {
    status: 'uncertain';
    effect: 'intent';
    reason: ProtectedApplicationExecutionFailureReason;
    intent: ProtectedApplicationExecutionIntent;
  }
  | {
    status: 'accepted';
    effect: 'accepted';
    operation: ExternalOperationState;
    intent: ProtectedApplicationExecutionIntent;
    accepted: ProtectedApplicationAcceptedCheckpoint;
  }
  | {
    status: 'failed';
    effect: 'accepted' | 'terminal';
    reason: ProtectedApplicationExecutionFailureReason;
    operation: ExternalOperationState;
    intent: ProtectedApplicationExecutionIntent;
    accepted: ProtectedApplicationAcceptedCheckpoint;
    terminal?: ProtectedApplicationTerminalCheckpoint;
  }
  | {
    status: 'completed';
    effect: 'terminal';
    action: 'application-foundation';
    operation: ExternalOperationState;
    intent: ProtectedApplicationExecutionIntent;
    accepted: ProtectedApplicationAcceptedCheckpoint;
    terminal: ProtectedApplicationTerminalCheckpoint;
    provenance: ProtectedApplicationExecutionProvenance;
    plan: ProtectedApplicationPlanProof;
    mappings: readonly ApplicationStateMappingProof[];
    completion: ProtectedApplicationCompletionProof;
  };

export type ProtectedApplicationReadResult =
  | ProtectedApplicationNoEffectResult
  | {
    status: 'completed';
    effect: 'none';
    action: 'staging-qualified' | 'production-rehearsed';
    operation: ExternalOperationState;
    provenance: ProtectedApplicationExecutionProvenance;
    admittedCompletionDigest: string;
    observation: ApplicationDeploymentReadback;
  };

export interface ProtectedApplicationExecutionPort {
  dispatch(
    request: ProtectedApplicationWriteDispatchRequest,
    checkpoints: ProtectedApplicationExecutionCheckpoints
  ): Promise<ProtectedApplicationWriteResult>;
  observeWrite(
    request: ProtectedApplicationWriteObservationRequest,
    checkpoints: Pick<
      ProtectedApplicationExecutionCheckpoints,
      'recordAccepted' | 'recordTerminal'
    >
  ): Promise<ProtectedApplicationWriteResult>;
  observeRead(
    request: ProtectedApplicationReadRequest
  ): Promise<ProtectedApplicationReadResult>;
}

function exactDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !digestPattern.test(value)) {
    return applicationError('application-deployment-binding', `${label} is absent or invalid.`);
  }
  return value;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requiredResourceIds(
  groupId: string,
  names: ReturnType<typeof applicationEnvironment>['resources'],
  prerequisite: ReturnType<typeof applicationPrerequisiteBinding>
): string[] {
  const storage = `${groupId}/providers/Microsoft.Storage/storageAccounts/${names.storage}`;
  const serviceBus = `${groupId}/providers/Microsoft.ServiceBus/namespaces/${names.serviceBus}`;
  const postgres = `${groupId}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${names.postgres}`;
  return [
    groupId,
    prerequisite.registryId,
    prerequisite.identityId,
    prerequisite.roles[0]!.id,
    `${groupId}/providers/Microsoft.App/managedEnvironments/${names.containerAppEnvironment}`,
    `${groupId}/providers/Microsoft.App/containerApps/${names.backendContainerApp}`,
    postgres,
    `${postgres}/firewallRules/AllowAzureServices`,
    `${groupId}/providers/Microsoft.Cache/Redis/${names.redis}`,
    storage,
    `${storage}/blobServices/default/containers/documents`,
    serviceBus,
    `${serviceBus}/queues/events`,
    `${groupId}/providers/Microsoft.Communication/communicationServices/${names.communication}`,
    `${groupId}/providers/Microsoft.KeyVault/vaults/${names.keyVault}`
  ];
}

function stateTransitions(
  prerequisite: ReturnType<typeof applicationPrerequisiteBinding>
): ApplicationDeploymentStateTransition[] {
  return [
    {
      resourceType: 'Microsoft.Resources/resourceGroups',
      resourceId: prerequisite.groupId,
      disposition: 'move',
      fromAddress: 'azurerm_resource_group.bootstrap',
      toAddress: 'module.application.azurerm_resource_group.main'
    },
    {
      resourceType: 'Microsoft.ContainerRegistry/registries',
      resourceId: prerequisite.registryId,
      disposition: 'import',
      fromAddress: null,
      toAddress: 'module.application.azurerm_container_registry.main'
    },
    {
      resourceType: 'Microsoft.ManagedIdentity/userAssignedIdentities',
      resourceId: prerequisite.identityId,
      disposition: 'import',
      fromAddress: null,
      toAddress: 'module.application.azurerm_user_assigned_identity.app'
    },
    {
      resourceType: 'Microsoft.Authorization/roleAssignments',
      resourceId: prerequisite.roles[0]!.id,
      disposition: 'import',
      fromAddress: null,
      toAddress: 'module.application.azurerm_role_assignment.acr_pull'
    },
    {
      resourceType: 'Microsoft.Authorization/roleAssignments',
      resourceId: prerequisite.roles[1]!.id,
      disposition: 'retain-external',
      fromAddress: null,
      toAddress: null
    }
  ];
}

function authoritativeRecord(
  input: PhasePlanningInput | PhaseAdapterExecutionInput,
  phaseId: ApplicationAuthoritativeRecord['phaseId'],
  bindingDigest: string
): ApplicationAuthoritativeRecord {
  const reference = input.inspection.state.phases[phaseId].evidence.at(-1);
  if (!reference || reference.phaseId !== phaseId || reference.result !== 'verified' ||
    !reference.evidenceId || !digestPattern.test(reference.headerDigest)) {
    return applicationError(
      'application-deployment-record',
      `Application deployment requires the authoritative verified ${phaseId} evidence reference.`
    );
  }
  return {
    phaseId,
    evidenceId: reference.evidenceId,
    headerDigest: reference.headerDigest,
    bindingDigest
  };
}

function guid(value: unknown, label: string): string {
  if (typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value)) {
    return applicationError('application-deployment-binding', `${label} is absent or invalid.`);
  }
  return value.toLowerCase();
}

function ownedResourceConfiguration(
  resourceType: string,
  resourceId: string,
  stateAddress: string,
  authoritative: ApplicationAuthoritativeRecord,
  attributes: Readonly<Record<string, unknown>>
): ApplicationOwnedResourceConfiguration {
  const value = {
    resourceType,
    resourceId,
    stateAddress,
    authoritativeRecord: authoritative,
    attributes
  };
  return { ...value, configurationDigest: canonicalSha256(value) };
}

export function bindApplicationDeployment(
  input: PhasePlanningInput | PhaseAdapterExecutionInput,
  artifact: VerifiedApplicationArtifact
): ApplicationDeploymentBinding {
  const workload = input.inspection.manifest.project.workload;
  if (workload.frontend || workload.kind !== 'standard') {
    return applicationError(
      'application-workload-unqualified',
      'The current immutable-artifact producer qualifies one backend image only; frontend and worker-bearing workloads remain blocked until every deployable artifact has independent immutable publication proof.'
    );
  }
  const environment = applicationEnvironment(input, artifact.environment);
  const prerequisite = applicationPrerequisiteBinding(input);
  const backend = azureBackendConfiguration(input, 'bootstrap-local');
  const budget = applicationBudget(input);
  const custodyIdentityDigest = exactDigest(
    input.inspection.state.phaseOutputs?.['remote-import-verified']?.values.custodyIdentityDigest,
    'Protected custody identity digest'
  );
  const custodyQualificationDigest = exactDigest(
    input.inspection.state.phaseOutputs?.['remote-import-verified']?.values.custodyQualificationDigest,
    'Protected custody qualification digest'
  );
  const bootstrapBindingDigest = exactDigest(
    input.inspection.state.phaseOutputs?.['remote-import-verified']?.values.bootstrapBindingDigest,
    'Protected bootstrap binding digest'
  );
  if (!input.inspection.state.bootstrapState ||
    input.inspection.state.bootstrapState.status !== 'retained') {
    return applicationError(
      'application-deployment-custody',
      'Application state mapping requires the retained protected bootstrap custody and disposal obligation.'
    );
  }
  const retentionObligationDigest = canonicalSha256(input.inspection.state.bootstrapState);
  const workloadPrincipalId = guid(
    input.inspection.state.phaseOutputs?.['application-prerequisites-ready']?.values.workloadPrincipalId,
    'Application workload principal ID'
  );
  const workloadClientId = guid(
    input.inspection.state.phaseOutputs?.['application-prerequisites-ready']?.values.workloadClientId,
    'Application workload client ID'
  );
  const loginServer = `${prerequisite.registryName}.azurecr.io`;
  if (artifact.environment !== prerequisite.environment ||
    artifact.registryResourceId !== prerequisite.registryId ||
    artifact.immutableImage !== `${loginServer}/${artifact.imageRepository}@${artifact.digest}` ||
    prerequisite.backendBindingDigest !== backend.bindingDigest) {
    return applicationError(
      'application-deployment-binding',
      'Application deployment requires the exact verified artifact, registry, environment and protected backend established by its predecessor phases.'
    );
  }
  if (!input.inspection.state.phaseOutputs?.['bootstrap-local']?.resources.some((resource) =>
    resource.provider === 'azure' &&
    resource.resourceType === 'Microsoft.Resources/resourceGroups' &&
    resource.resourceId.toLowerCase() === prerequisite.groupId.toLowerCase())) {
    return applicationError(
      'application-deployment-ownership',
      'The selected application resource group is not the exact same-operation-owned protected bootstrap group.'
    );
  }
  const applicationRoot =
    `infrastructure/opentofu/azure/environments/${environment.environment}`;
  const applicationModule = 'infrastructure/opentofu/azure/modules/application';
  const authoritativeRecords = {
    bootstrap: authoritativeRecord(
      input, 'remote-import-verified', bootstrapBindingDigest
    ),
    prerequisites: authoritativeRecord(
      input, 'application-prerequisites-ready', prerequisite.bindingDigest
    ),
    artifact: authoritativeRecord(
      input, 'application-artifact-ready', artifact.artifactBindingDigest
    )
  };
  const ownedResourceConfigurations = [
    ownedResourceConfiguration(
      'Microsoft.Resources/resourceGroups',
      prerequisite.groupId,
      'module.application.azurerm_resource_group.main',
      authoritativeRecords.bootstrap,
      {
        name: prerequisite.resourceGroup,
        location: prerequisite.region,
        tags: {
          'liftoff-managed-by': 'liftoff',
          'liftoff-phase': 'bootstrap-local',
          'liftoff-environment': prerequisite.environment,
          'liftoff-binding': bootstrapBindingDigest
        }
      }
    ),
    ownedResourceConfiguration(
      'Microsoft.ContainerRegistry/registries',
      prerequisite.registryId,
      'module.application.azurerm_container_registry.main',
      authoritativeRecords.prerequisites,
      {
        name: prerequisite.registryName,
        resourceGroup: prerequisite.resourceGroup,
        location: prerequisite.region,
        sku: 'Basic',
        adminEnabled: false,
        tags: {
          'liftoff-binding': prerequisite.bindingDigest,
          'liftoff-environment': prerequisite.environment
        }
      }
    ),
    ownedResourceConfiguration(
      'Microsoft.ManagedIdentity/userAssignedIdentities',
      prerequisite.identityId,
      'module.application.azurerm_user_assigned_identity.app',
      authoritativeRecords.prerequisites,
      {
        name: prerequisite.identityName,
        resourceGroup: prerequisite.resourceGroup,
        location: prerequisite.region,
        tenantId: prerequisite.tenantId,
        principalId: workloadPrincipalId,
        clientId: workloadClientId,
        tags: {
          'liftoff-binding': prerequisite.bindingDigest,
          'liftoff-environment': prerequisite.environment
        }
      }
    ),
    ownedResourceConfiguration(
      'Microsoft.Authorization/roleAssignments',
      prerequisite.roles[0]!.id,
      'module.application.azurerm_role_assignment.acr_pull',
      authoritativeRecords.prerequisites,
      {
        scope: prerequisite.registryId,
        roleDefinitionId: prerequisite.roles[0]!.roleDefinitionId,
        principalId: workloadPrincipalId,
        principalType: 'ServicePrincipal'
      }
    )
  ];
  const base = {
    schemaVersion: 1 as const,
    phaseId: 'application-foundation' as const,
    sourceSha: artifact.sourceSha,
    environment: environment.environment,
    subscriptionId: prerequisite.subscriptionId,
    tenantId: prerequisite.tenantId,
    region: prerequisite.region,
    resourceGroup: prerequisite.resourceGroup,
    resourceGroupId: prerequisite.groupId,
    applicationRoot,
    applicationModule,
    providerLockPath: `${applicationRoot}/.terraform.lock.hcl`,
    localBackendPath: `${applicationRoot}/backend.local.tf`,
    remoteBackendExamplePath: `${applicationRoot}/backend.remote.example.tf`,
    environmentVariablesPath: `${applicationRoot}/${environment.environment}.tfvars`,
    artifactBindingDigest: artifact.artifactBindingDigest,
    artifactDigest: artifact.digest,
    immutableImage: artifact.immutableImage,
    prerequisiteBindingDigest: prerequisite.bindingDigest,
    registryId: prerequisite.registryId,
    identityId: prerequisite.identityId,
    workloadPrincipalId,
    workloadClientId,
    pullRoleId: prerequisite.roles[0]!.id,
    pushRoleId: prerequisite.roles[1]!.id,
    backendBindingDigest: backend.bindingDigest,
    bootstrapBindingDigest,
    custodyIdentityDigest,
    custodyQualificationDigest,
    retentionObligationDigest,
    authoritativeRecords,
    expectedResourceNames: environment.resources,
    requiredResourceIds: requiredResourceIds(prerequisite.groupId, environment.resources, prerequisite),
    stateTransitions: stateTransitions(prerequisite),
    ownedResourceConfigurations,
    ownedResourceConfigurationDigest: canonicalSha256(ownedResourceConfigurations),
    variableOverrides: {
      backend_image: artifact.immutableImage,
      environment: environment.environment,
      location: prerequisite.region,
      resource_suffix: environment.resourceSuffix
    },
    protectedVariableNames: ['postgres_admin_password'] as const,
    healthTargets: [{
      component: 'backend' as const,
      method: 'GET' as const,
      path: '/health' as const
    }],
    budget,
    requirements: {
      newEnvironmentOnly: true as const,
      sameOperationOwnedPrerequisitesOnly: true as const,
      protectedExecutionRequired: true as const,
      protectedRemoteBackendRequired: true as const,
      localStateFallback: false as const,
      plaintextStateFallback: false as const,
      arbitraryStateImport: false as const,
      sourceReplacement: false as const,
      immutableArtifactRequired: true as const,
      uncertainRedispatch: false as const
    }
  };
  return { ...base, bindingDigest: canonicalSha256(base) };
}

export function applicationDeploymentBinding(
  input: PhasePlanningInput | PhaseAdapterExecutionInput
): ApplicationDeploymentBinding {
  return bindApplicationDeployment(input, readVerifiedApplicationArtifact(input.inspection));
}

export function applicationDeploymentExecutionMode(
  input: PhaseAdapterExecutionInput,
  binding = applicationDeploymentBinding(input)
): {
  mode: 'dispatch' | 'observe';
  previousOperation: ExternalOperationState | null;
} {
  const state = input.inspection.state.phases['application-foundation'];
  const previous = state.operation;
  if (!previous) {
    if (state.executionPlanDigest) {
      return applicationError(
        'application-deployment-uncertain',
        'A prior protected application execution recorded authority without a confirmed provider handle; inspect exact state and partial effects instead of redispatching.'
      );
    }
    return { mode: 'dispatch', previousOperation: null };
  }
  if (previous.provider !== 'azure' ||
    previous.actionId !== 'azure.application-foundation.apply' ||
    previous.resourceId.toLowerCase() !== binding.resourceGroupId.toLowerCase() ||
    previous.planDigest !== state.executionPlanDigest ||
    !previous.operationId || previous.operationId.length > 2048 ||
    /[\u0000-\u001f\u007f]/u.test(previous.operationId)) {
    return applicationError(
      'application-deployment-operation',
      'The recorded application operation is not the exact protected deployment handle; it cannot be observed, replaced or redispatched.'
    );
  }
  return { mode: 'observe', previousOperation: previous };
}

function actualBackendOverlay(
  input: PhasePlanningInput | PhaseAdapterExecutionInput,
  binding: ApplicationDeploymentBinding
): string {
  const backend = azureBackendConfiguration(input, 'bootstrap-local');
  if (backend.bindingDigest !== binding.backendBindingDigest) {
    return applicationError('application-backend-stale', 'The protected backend changed after deployment binding.');
  }
  return `terraform {
  backend "azurerm" {
    resource_group_name  = "${backend.resourceGroup}"
    storage_account_name = "${backend.storageAccount}"
    container_name       = "${backend.container}"
    key                  = "${backend.key}"
    use_azuread_auth     = true
  }
}
`;
}

async function gitText(
  input: PhasePlanningInput | PhaseAdapterExecutionInput,
  args: readonly string[],
  maxOutputBytes = 1024 * 1024
): Promise<string> {
  const result = await input.runner.run({ executable: 'git', args: [...args] }, {
    cwd: input.inspection.projectRoot,
    timeoutMs: 30_000,
    maxOutputBytes,
    stream: false,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' }
  });
  if (result.status !== 0 || result.timedOut || result.outputLimitExceeded ||
    result.aborted || result.errorCode) {
    return applicationError(
      'application-deployment-source',
      'Application deployment source could not be observed within its Git deadline and byte bound; diagnostics were withheld.'
    );
  }
  return result.stdout;
}

function exactLocalBackend(binding: ApplicationDeploymentBinding): string {
  return `terraform {
  backend "local" {
    path = "state/${binding.environment}.tfstate"
  }
}`;
}

function sourceEntry(entry: string): {
  mode: '100644' | '100755';
  objectId: string;
  path: string;
} {
  const match = entry.match(/^(100(?:644|755)) blob ([a-f0-9]{40})\t(.+)$/u);
  if (!match || !sourceModePattern.test(match[1]!) || !sourceObjectPattern.test(match[2]!)) {
    return applicationError(
      'application-deployment-source',
      'Application deployment source contains unsupported modes, links, submodules or malformed Git entries.'
    );
  }
  return {
    mode: match[1] as '100644' | '100755',
    objectId: match[2]!,
    path: match[3]!
  };
}

export async function observeApplicationDeploymentSource(
  input: PhasePlanningInput | PhaseAdapterExecutionInput,
  binding = applicationDeploymentBinding(input)
): Promise<ObservedApplicationDeploymentSource> {
  const head = (await gitText(input, ['rev-parse', '--verify', 'HEAD'])).trim();
  const diff = await gitText(input, [
    'diff', binding.sourceSha, '--', binding.applicationRoot, binding.applicationModule
  ]);
  const untracked = await gitText(input, [
    'ls-files', '--others', '--exclude-standard', '--',
    binding.applicationRoot, binding.applicationModule
  ]);
  const tree = await gitText(input, [
    'ls-tree', '-r', '-z', binding.sourceSha, '--',
    binding.applicationRoot, binding.applicationModule
  ], 2 * 1024 * 1024);
  const entries = tree.split('\0').filter(Boolean).map(sourceEntry);
  const required = new Set([
    `${binding.applicationModule}/versions.tf`,
    `${binding.applicationModule}/variables.tf`,
    `${binding.applicationModule}/main.tf`,
    `${binding.applicationModule}/outputs.tf`,
    `${binding.applicationRoot}/versions.tf`,
    binding.providerLockPath,
    `${binding.applicationRoot}/providers.tf`,
    `${binding.applicationRoot}/variables.tf`,
    `${binding.applicationRoot}/main.tf`,
    `${binding.applicationRoot}/outputs.tf`,
    binding.localBackendPath,
    binding.remoteBackendExamplePath,
    binding.environmentVariablesPath
  ]);
  if (head !== binding.sourceSha || diff || untracked ||
    entries.length < required.size || entries.length > maximumSourceFiles ||
    [...required].some((requiredPath) => !entries.some((entry) => entry.path === requiredPath)) ||
    entries.some((entry) => {
      const parts = entry.path.split('/');
      return !activationInputPathIsObserved(parts) ||
        isSensitiveActivationPath(parts, input.inspection.sensitivePathExclusions ?? []) ||
        ![binding.applicationRoot, binding.applicationModule]
          .some((root) => entry.path.startsWith(`${root}/`)) ||
        /(?:^|\/)(?:\.terraform|state)(?:\/|$)|\.tfstate(?:\.|$)|\.tfplan$/u.test(entry.path) ||
        entry.path === `${binding.applicationRoot}/backend.tf` ||
        /\.auto\.tfvars(?:\.json)?$/u.test(entry.path);
    })) {
    return applicationError(
      'application-deployment-source',
      'Application deployment requires the exact clean committed environment root and module; custom files are preserved only when they are bounded, tracked, non-sensitive and do not replace protected backend or variable overlays.'
    );
  }
  let totalBytes = 0;
  const files: ApplicationDeploymentSourceFile[] = [];
  const contents = new Map<string, string>();
  for (const entry of entries) {
    const content = await gitText(input, ['show', `${binding.sourceSha}:${entry.path}`], maximumFileBytes);
    const bytes = Buffer.byteLength(content);
    totalBytes += bytes;
    if (bytes > maximumFileBytes || totalBytes > maximumSourceBytes) {
      return applicationError(
        'application-deployment-source',
        'Application deployment source exceeds the bounded file or complete inventory limit.'
      );
    }
    contents.set(entry.path, content);
    files.push({
      ...entry,
      bytes,
      sha256: sha256(Buffer.from(content, 'utf8'))
    });
  }
  if (contents.get(binding.localBackendPath)?.replace(/\r\n/gu, '\n').trim() !==
    exactLocalBackend(binding) ||
    contents.get(binding.remoteBackendExamplePath)?.split(/\r?\n/u)
      .some((line) => line.trim() && !line.trim().startsWith('#')) ||
    [...contents.entries()].some(([file, content]) =>
      file.endsWith('.tfvars') && /^\s*postgres_admin_password\s*=/mu.test(content))) {
    return applicationError(
      'application-deployment-source',
      'The local backend placeholder, remote example or committed variables contain unsupported execution configuration or protected values.'
    );
  }
  const executionFiles = files.filter((file) => file.path !== binding.localBackendPath);
  const overlay = actualBackendOverlay(input, binding);
  const variables = canonicalSha256(binding.variableOverrides);
  return {
    binding,
    files,
    executionFiles,
    sourceInventoryDigest: canonicalSha256(files),
    executionInventoryDigest: canonicalSha256(executionFiles),
    providerLockDigest: files.find((file) => file.path === binding.providerLockPath)!.sha256,
    localBackendDigest: files.find((file) => file.path === binding.localBackendPath)!.sha256,
    backendOverlay: {
      path: 'backend.tf',
      bytes: Buffer.byteLength(overlay),
      sha256: sha256(overlay)
    },
    variableOverlay: {
      path: 'liftoff.auto.tfvars.json',
      digest: variables,
      keys: Object.keys(binding.variableOverrides).sort()
    },
    requiredProtectedVariables: binding.protectedVariableNames
  };
}

function exactTransitions(
  actual: readonly ApplicationDeploymentStateTransition[],
  expected: readonly ApplicationDeploymentStateTransition[]
): boolean {
  return canonicalSha256(actual) === canonicalSha256(expected);
}

function finiteCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return canonicalSha256(Object.keys(value).sort()) === canonicalSha256([...keys].sort());
}

export function validateProtectedApplicationExecutionProvenance(
  binding: ApplicationDeploymentBinding,
  provenance: ProtectedApplicationExecutionProvenance
): ProtectedApplicationExecutionProvenance {
  const { provenanceDigest, ...digestInput } = provenance;
  if (!exactKeys(provenance, [
    'executionHostId', 'runnerId', 'runnerLabel', 'runnerGroupId',
    'networkConfigurationId', 'runnerQualificationDigest',
    'networkQualificationDigest', 'custodyIdentityDigest',
    'custodyQualificationDigest', 'workflow', 'provenanceDigest'
  ]) ||
    !exactKeys(provenance.workflow, [
      'repository', 'path', 'ref', 'sourceSha', 'workflowDigest',
      'executionSourceDigest'
    ]) ||
    !provenance.executionHostId || provenance.executionHostId.length > 512 ||
    !Number.isSafeInteger(provenance.runnerId) || provenance.runnerId <= 0 ||
    !provenance.runnerLabel || provenance.runnerLabel.length > 256 ||
    !Number.isSafeInteger(provenance.runnerGroupId) || provenance.runnerGroupId <= 0 ||
    !provenance.networkConfigurationId ||
    provenance.networkConfigurationId.length > 512 ||
    !digestPattern.test(provenance.runnerQualificationDigest) ||
    !digestPattern.test(provenance.networkQualificationDigest) ||
    provenance.custodyIdentityDigest !== binding.custodyIdentityDigest ||
    provenance.custodyQualificationDigest !== binding.custodyQualificationDigest ||
    !provenance.workflow.repository || provenance.workflow.repository.length > 256 ||
    !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(provenance.workflow.path) ||
    !provenance.workflow.ref || provenance.workflow.ref.length > 256 ||
    provenance.workflow.sourceSha !== binding.sourceSha ||
    !digestPattern.test(provenance.workflow.workflowDigest) ||
    !digestPattern.test(provenance.workflow.executionSourceDigest) ||
    canonicalSha256(digestInput) !== provenanceDigest) {
    return applicationError(
      'application-deployment-provenance',
      'Protected application execution changed its qualified host, runner, network, custody or immutable current workflow source.'
    );
  }
  return provenance;
}

export function validateApplicationOriginalInvocation(
  invocation: ApplicationOriginalInvocation
): ApplicationOriginalInvocation {
  const { invocationDigest, ...digestInput } = invocation;
  if (!exactKeys(invocation, [
    'phaseId', 'graphHash', 'stateHash', 'baselineDigest', 'inputDigest',
    'transitionDigest', 'planDigest', 'operationDigest', 'approvalEnvelopeId',
    'approvalEnvelopeHash', 'createdAt', 'expiresAt', 'invocationDigest'
  ]) ||
    !['application-foundation', 'staging-qualified', 'production-rehearsed']
      .includes(invocation.phaseId) ||
    !digestPattern.test(invocation.graphHash) ||
    invocation.stateHash !== null && !digestPattern.test(invocation.stateHash) ||
    !digestPattern.test(invocation.baselineDigest) ||
    !digestPattern.test(invocation.inputDigest) ||
    !digestPattern.test(invocation.transitionDigest) ||
    !digestPattern.test(invocation.planDigest) ||
    !digestPattern.test(invocation.operationDigest) ||
    !invocation.approvalEnvelopeId || invocation.approvalEnvelopeId.length > 256 ||
    !digestPattern.test(invocation.approvalEnvelopeHash) ||
    !Number.isFinite(Date.parse(invocation.createdAt)) ||
    !Number.isFinite(Date.parse(invocation.expiresAt)) ||
    Date.parse(invocation.createdAt) >= Date.parse(invocation.expiresAt) ||
    canonicalSha256(digestInput) !== invocationDigest) {
    return applicationError(
      'application-deployment-invocation',
      'Protected application execution is not bound to the exact original current plan, operation and approval invocation.'
    );
  }
  return invocation;
}

export function validateProtectedApplicationPlanProof(
  binding: ApplicationDeploymentBinding,
  source: ObservedApplicationDeploymentSource,
  proof: ProtectedApplicationPlanProof
): ProtectedApplicationPlanProof {
  const { planDigest, ...digestInput } = proof;
  const resourceIds = new Set(proof.resourceIds.map((resourceId) => resourceId.toLowerCase()));
  const groupPrefix = `${binding.resourceGroupId}/`.toLowerCase();
  if (!exactKeys(proof, [
    'schemaVersion', 'kind', 'bindingDigest', 'sourceInventoryDigest',
    'executionInventoryDigest', 'providerLockDigest', 'backendOverlaySha256',
    'variableOverlayDigest', 'planDigest', 'plannedAt', 'changes', 'resourceIds',
    'stateTransitions', 'ownedResourceConfigurations', 'cost', 'protectedInputs', 'checks'
  ]) ||
    !exactKeys(proof.changes, ['add', 'change', 'destroy']) ||
    !exactKeys(proof.cost, ['currency', 'fixedMonthlyCents', 'usageMonthlyCents']) ||
    !exactKeys(proof.checks, [
      'initializedProtectedBackend', 'validatedConfiguration', 'providerLockVerified',
      'artifactDigestBound', 'sourceUnchanged', 'plaintextStateAbsent',
      'existingDeploymentAdoption'
    ]) ||
    proof.protectedInputs.some((entry) =>
      !exactKeys(entry, ['name', 'source', 'valueIncluded'])) ||
    proof.ownedResourceConfigurations.some((entry) =>
      !exactKeys(entry, ['resourceId', 'stateAddress', 'configurationDigest'])) ||
    proof.schemaVersion !== 1 || proof.kind !== 'protected-application-plan.v1' ||
    proof.bindingDigest !== binding.bindingDigest ||
    proof.sourceInventoryDigest !== source.sourceInventoryDigest ||
    proof.executionInventoryDigest !== source.executionInventoryDigest ||
    proof.providerLockDigest !== source.providerLockDigest ||
    proof.backendOverlaySha256 !== source.backendOverlay.sha256 ||
    proof.variableOverlayDigest !== source.variableOverlay.digest ||
    !digestPattern.test(proof.planDigest) ||
    canonicalSha256(digestInput) !== planDigest ||
    !Number.isFinite(Date.parse(proof.plannedAt)) ||
    !Number.isSafeInteger(proof.changes.add) || proof.changes.add <= 0 ||
    proof.changes.change !== 0 || proof.changes.destroy !== 0 ||
    !exactTransitions(proof.stateTransitions, binding.stateTransitions) ||
    canonicalSha256(proof.ownedResourceConfigurations) !== canonicalSha256(
      binding.ownedResourceConfigurations.map((resource) => ({
        resourceId: resource.resourceId,
        stateAddress: resource.stateAddress,
        configurationDigest: resource.configurationDigest
      }))
    ) ||
    proof.resourceIds.length > 256 ||
    proof.resourceIds.length !== resourceIds.size ||
    binding.requiredResourceIds.some((resourceId) => !resourceIds.has(resourceId.toLowerCase())) ||
    proof.resourceIds.some((resourceId) =>
      resourceId.toLowerCase() !== binding.resourceGroupId.toLowerCase() &&
      !resourceId.toLowerCase().startsWith(groupPrefix)) ||
    proof.cost.currency !== binding.budget.currency ||
    !finiteCents(proof.cost.fixedMonthlyCents) ||
    !finiteCents(proof.cost.usageMonthlyCents) ||
    proof.cost.fixedMonthlyCents > binding.budget.fixedMonthlyCents ||
    proof.cost.usageMonthlyCents > binding.budget.usageMonthlyCents ||
    canonicalSha256(proof.protectedInputs) !== canonicalSha256([{
      name: 'postgres_admin_password',
      source: 'qualified-protected-input',
      valueIncluded: false
    }]) ||
    !proof.checks.initializedProtectedBackend ||
    !proof.checks.validatedConfiguration ||
    !proof.checks.providerLockVerified ||
    !proof.checks.artifactDigestBound ||
    !proof.checks.sourceUnchanged ||
    !proof.checks.plaintextStateAbsent ||
    proof.checks.existingDeploymentAdoption) {
    return applicationError(
      'application-deployment-plan',
      'Protected OpenTofu planning changed source, backend, state mapping, immutable artifact, cost, resource scope or secret handling; no apply is permitted.'
    );
  }
  return proof;
}

export function validateApplicationStateMappingProofs(
  binding: ApplicationDeploymentBinding,
  proofs: readonly ApplicationStateMappingProof[]
): readonly ApplicationStateMappingProof[] {
  const expected = binding.ownedResourceConfigurations.map((configuration) => {
    const transition = binding.stateTransitions.find((candidate) =>
      candidate.resourceId.toLowerCase() === configuration.resourceId.toLowerCase());
    if (!transition || transition.disposition === 'retain-external' ||
      !transition.toAddress) {
      return applicationError(
        'application-deployment-mapping',
        'Owned application resource configuration is missing its fixed state mapping.'
      );
    }
    return { configuration, transition };
  });
  if (proofs.length !== expected.length) {
    return applicationError(
      'application-deployment-mapping',
      'Protected application state proof omitted or added an owned state mapping.'
    );
  }
  for (const { configuration, transition } of expected) {
    const proof = proofs.find((candidate) =>
      candidate.resourceId.toLowerCase() === configuration.resourceId.toLowerCase());
    if (!proof) {
      return applicationError(
        'application-deployment-mapping',
        'Protected application state proof omitted an exact owned resource.'
      );
    }
    const { proofDigest, ...digestInput } = proof;
    if (!exactKeys(proof, [
      'resourceType', 'resourceId', 'disposition', 'fromAddress', 'toAddress',
      'authoritativeRecord', 'expectedConfigurationDigest', 'before', 'after',
      'unmappedStateDigestBefore', 'unmappedStateDigestAfter',
      'observedConfigurationDigest', 'resourceMutationPerformed',
      'custodyIdentityDigest', 'custodyQualificationDigest',
      'retentionObligationDigest', 'proofDigest'
    ]) ||
      !exactKeys(proof.authoritativeRecord, [
        'phaseId', 'evidenceId', 'headerDigest', 'bindingDigest'
      ]) ||
      !exactKeys(proof.before, [
        'stateLineage', 'stateSerial', 'stateDigest', 'backupArtifactDigest',
        'backupKeyRefDigest', 'lockProofDigest', 'writerQuiescenceDigest'
      ]) ||
      !exactKeys(proof.after, [
        'stateLineage', 'stateSerial', 'stateDigest', 'lockProofDigest',
        'writerQuiescenceDigest'
      ]) ||
      proof.resourceType !== configuration.resourceType ||
      proof.resourceId.toLowerCase() !== configuration.resourceId.toLowerCase() ||
      proof.disposition !== transition.disposition ||
      proof.fromAddress !== transition.fromAddress ||
      proof.toAddress !== transition.toAddress ||
      canonicalSha256(proof.authoritativeRecord) !==
        canonicalSha256(configuration.authoritativeRecord) ||
      proof.expectedConfigurationDigest !== configuration.configurationDigest ||
      proof.observedConfigurationDigest !== configuration.configurationDigest ||
      !proof.before.stateLineage ||
      proof.before.stateLineage !== proof.after.stateLineage ||
      !Number.isSafeInteger(proof.before.stateSerial) || proof.before.stateSerial <= 0 ||
      !Number.isSafeInteger(proof.after.stateSerial) ||
      proof.after.stateSerial <= proof.before.stateSerial ||
      [
        proof.before.stateDigest,
        proof.before.backupArtifactDigest,
        proof.before.backupKeyRefDigest,
        proof.before.lockProofDigest,
        proof.before.writerQuiescenceDigest,
        proof.after.stateDigest,
        proof.after.lockProofDigest,
        proof.after.writerQuiescenceDigest,
        proof.unmappedStateDigestBefore,
        proof.unmappedStateDigestAfter,
        proof.proofDigest
      ].some((digest) => !digestPattern.test(digest)) ||
      proof.unmappedStateDigestBefore !== proof.unmappedStateDigestAfter ||
      proof.resourceMutationPerformed ||
      proof.custodyIdentityDigest !== binding.custodyIdentityDigest ||
      proof.custodyQualificationDigest !== binding.custodyQualificationDigest ||
      proof.retentionObligationDigest !== binding.retentionObligationDigest ||
      canonicalSha256(digestInput) !== proofDigest) {
      return applicationError(
        'application-deployment-mapping',
        'Protected application state mapping changed resource identity, configuration, unmapped state, custody, locking, backup or writer quiescence.'
      );
    }
  }
  return proofs;
}

function exactApplicationOperation(
  binding: ApplicationDeploymentBinding,
  operation: ExternalOperationState,
  governancePlanDigest?: string
): boolean {
  return operation.provider === 'azure' &&
    operation.actionId === 'azure.application-foundation.apply' &&
    operation.resourceId.toLowerCase() === binding.resourceGroupId.toLowerCase() &&
    typeof operation.planDigest === 'string' &&
    digestPattern.test(operation.planDigest) &&
    (governancePlanDigest === undefined || operation.planDigest === governancePlanDigest) &&
    Boolean(operation.operationId) &&
    operation.operationId.length <= 2048 &&
    !/[\u0000-\u001f\u007f]/u.test(operation.operationId);
}

function writeEffects(binding: ApplicationDeploymentBinding) {
  return {
    azureResourceProvision: true as const,
    azureRead: true as const,
    protectedBackendRead: true as const,
    protectedBackendWrite: true as const,
    stateMappings: binding.stateTransitions,
    arbitraryImport: false as const,
    resourceGroupReplacement: false as const,
    externalPushRoleRetained: true as const
  };
}

function executionRequestDigest(
  binding: ApplicationDeploymentBinding,
  source: ObservedApplicationDeploymentSource,
  plan: ProtectedApplicationPlanProof,
  provenance: ProtectedApplicationExecutionProvenance,
  invocation: ApplicationOriginalInvocation
): string {
  return canonicalSha256({
    action: 'application-foundation',
    bindingDigest: binding.bindingDigest,
    sourceInventoryDigest: source.sourceInventoryDigest,
    executionInventoryDigest: source.executionInventoryDigest,
    protectedPlanDigest: plan.planDigest,
    provenanceDigest: provenance.provenanceDigest,
    invocationDigest: invocation.invocationDigest,
    effects: writeEffects(binding)
  });
}

export function protectedApplicationExecutionIntent(
  binding: ApplicationDeploymentBinding,
  source: ObservedApplicationDeploymentSource,
  plan: ProtectedApplicationPlanProof,
  provenance: ProtectedApplicationExecutionProvenance,
  invocation: ApplicationOriginalInvocation,
  recordedAt: string
): ProtectedApplicationExecutionIntent {
  validateProtectedApplicationPlanProof(binding, source, plan);
  validateProtectedApplicationExecutionProvenance(binding, provenance);
  validateApplicationOriginalInvocation(invocation);
  if (invocation.phaseId !== 'application-foundation' ||
    !Number.isFinite(Date.parse(recordedAt))) {
    return applicationError(
      'application-deployment-invocation',
      'Application write intent changed the approved phase or has no exact pre-effect checkpoint time.'
    );
  }
  const requestDigest = executionRequestDigest(
    binding, source, plan, provenance, invocation
  );
  const value = {
    kind: 'protected-application-intent.v1' as const,
    requestDigest,
    invocationDigest: invocation.invocationDigest,
    provenanceDigest: provenance.provenanceDigest,
    bindingDigest: binding.bindingDigest,
    sourceInventoryDigest: source.sourceInventoryDigest,
    protectedPlanDigest: plan.planDigest,
    intentId: `application-foundation:${requestDigest}`,
    recordedAt
  };
  return { ...value, checkpointDigest: canonicalSha256(value) };
}

export function validateProtectedApplicationExecutionIntent(
  binding: ApplicationDeploymentBinding,
  source: ObservedApplicationDeploymentSource,
  plan: ProtectedApplicationPlanProof,
  provenance: ProtectedApplicationExecutionProvenance,
  invocation: ApplicationOriginalInvocation,
  intent: ProtectedApplicationExecutionIntent
): ProtectedApplicationExecutionIntent {
  const expected = protectedApplicationExecutionIntent(
    binding, source, plan, provenance, invocation, intent.recordedAt
  );
  if (!exactKeys(intent, [
    'kind', 'requestDigest', 'invocationDigest', 'provenanceDigest',
    'bindingDigest', 'sourceInventoryDigest', 'protectedPlanDigest',
    'intentId', 'recordedAt', 'checkpointDigest'
  ]) || canonicalSha256(intent) !== canonicalSha256(expected)) {
    return applicationError(
      'application-deployment-checkpoint',
      'Application pre-effect intent changed its request, approval, execution source or checkpoint identity.'
    );
  }
  return intent;
}

export function protectedApplicationDispatchRequest(
  binding: ApplicationDeploymentBinding,
  source: ObservedApplicationDeploymentSource,
  plan: ProtectedApplicationPlanProof,
  provenance: ProtectedApplicationExecutionProvenance,
  invocation: ApplicationOriginalInvocation,
  intent: ProtectedApplicationExecutionIntent
): ProtectedApplicationWriteDispatchRequest {
  validateProtectedApplicationExecutionIntent(
    binding, source, plan, provenance, invocation, intent
  );
  return {
    schemaVersion: 1,
    mode: 'write',
    action: 'application-foundation',
    execution: 'dispatch',
    binding,
    source,
    provenance,
    invocation,
    previousOperation: null,
    plan,
    intent,
    effects: writeEffects(binding)
  };
}

export function protectedApplicationWriteObservationRequest(
  binding: ApplicationDeploymentBinding,
  source: ObservedApplicationDeploymentSource,
  plan: ProtectedApplicationPlanProof,
  provenance: ProtectedApplicationExecutionProvenance,
  invocation: ApplicationOriginalInvocation,
  intent: ProtectedApplicationExecutionIntent,
  previousOperation: ExternalOperationState | null
): ProtectedApplicationWriteObservationRequest {
  validateProtectedApplicationExecutionIntent(
    binding, source, plan, provenance, invocation, intent
  );
  if (previousOperation && !exactApplicationOperation(
    binding, previousOperation, invocation.planDigest
  )) {
    return applicationError(
      'application-deployment-invocation',
      'Application observation changed the recorded provider handle.'
    );
  }
  return {
    schemaVersion: 1,
    mode: 'write',
    action: 'application-foundation',
    execution: 'observe',
    binding,
    source,
    provenance,
    invocation,
    previousOperation,
    observationReason: previousOperation
      ? 'accepted-handle'
      : 'intent-without-handle',
    plan,
    intent,
    effects: writeEffects(binding)
  };
}

export function protectedApplicationReadRequest(
  action: ProtectedApplicationReadRequest['action'],
  binding: ApplicationDeploymentBinding,
  source: ObservedApplicationDeploymentSource,
  plan: ProtectedApplicationPlanProof,
  completion: ProtectedApplicationCompletionProof,
  provenance: ProtectedApplicationExecutionProvenance,
  invocation: ApplicationOriginalInvocation
): ProtectedApplicationReadRequest {
  validateProtectedApplicationCompletionProof(binding, source, plan, completion);
  validateProtectedApplicationExecutionProvenance(binding, provenance);
  validateApplicationOriginalInvocation(invocation);
  if (invocation.phaseId !== action ||
    !exactApplicationOperation(binding, completion.operation)) {
    return applicationError(
      'application-deployment-invocation',
      'Application read-only execution changed the approved phase or admitted deployment handle.'
    );
  }
  return {
    schemaVersion: 1,
    mode: 'read-only',
    action,
    execution: 'observe',
    binding,
    source,
    provenance,
    invocation,
    previousOperation: completion.operation,
    admittedOperation: completion.operation,
    admittedCompletionDigest: canonicalSha256(completion),
    expectedPlanDigest: plan.planDigest,
    expectedHealthDigest: canonicalSha256(completion.health),
    permissions: {
      azureRead: true,
      stateRead: false,
      stateWrite: false,
      dispatch: false,
      import: false,
      move: false,
      apply: false
    }
  };
}

function sameOperationIdentity(
  left: ExternalOperationState,
  right: ExternalOperationState
): boolean {
  return left.provider === right.provider &&
    left.actionId === right.actionId &&
    left.operationId === right.operationId &&
    left.resourceId.toLowerCase() === right.resourceId.toLowerCase() &&
    left.startedAt === right.startedAt &&
    left.planDigest === right.planDigest;
}

export function protectedApplicationAcceptedCheckpoint(
  request: ProtectedApplicationWriteRequest,
  operation: ExternalOperationState,
  acceptedAt: string
): ProtectedApplicationAcceptedCheckpoint {
  if (!exactApplicationOperation(
    request.binding, operation, request.invocation.planDigest
  ) || !Number.isFinite(Date.parse(acceptedAt))) {
    return applicationError(
      'application-deployment-checkpoint',
      'Application acceptance checkpoint changed the original operation or has no exact acceptance time.'
    );
  }
  const value = {
    kind: 'protected-application-accepted.v1' as const,
    requestDigest: request.intent.requestDigest,
    intentCheckpointDigest: request.intent.checkpointDigest,
    operation,
    acceptedAt
  };
  return { ...value, checkpointDigest: canonicalSha256(value) };
}

export function validateProtectedApplicationAcceptedCheckpoint(
  request: ProtectedApplicationWriteRequest,
  checkpoint: ProtectedApplicationAcceptedCheckpoint
): ProtectedApplicationAcceptedCheckpoint {
  const expected = protectedApplicationAcceptedCheckpoint(
    request, checkpoint.operation, checkpoint.acceptedAt
  );
  if (!exactKeys(checkpoint, [
    'kind', 'requestDigest', 'intentCheckpointDigest', 'operation',
    'acceptedAt', 'checkpointDigest'
  ]) || canonicalSha256(checkpoint) !== canonicalSha256(expected)) {
    return applicationError(
      'application-deployment-checkpoint',
      'Application accepted-handle checkpoint changed the original intent or provider operation.'
    );
  }
  return checkpoint;
}

export function protectedApplicationTerminalCheckpoint(
  request: ProtectedApplicationWriteRequest,
  accepted: ProtectedApplicationAcceptedCheckpoint,
  operation: ExternalOperationState,
  terminalAt: string
): ProtectedApplicationTerminalCheckpoint {
  validateProtectedApplicationAcceptedCheckpoint(request, accepted);
  if (!sameOperationIdentity(accepted.operation, operation) ||
    !['completed', 'failed'].includes(operation.status) ||
    !Number.isFinite(Date.parse(terminalAt))) {
    return applicationError(
      'application-deployment-checkpoint',
      'Application terminal checkpoint changed the accepted handle or lacks an exact terminal provider status.'
    );
  }
  const value = {
    kind: 'protected-application-terminal.v1' as const,
    requestDigest: request.intent.requestDigest,
    intentCheckpointDigest: request.intent.checkpointDigest,
    acceptedCheckpointDigest: accepted.checkpointDigest,
    operation,
    terminalAt
  };
  return { ...value, checkpointDigest: canonicalSha256(value) };
}

export function validateProtectedApplicationTerminalCheckpoint(
  request: ProtectedApplicationWriteRequest,
  accepted: ProtectedApplicationAcceptedCheckpoint,
  checkpoint: ProtectedApplicationTerminalCheckpoint
): ProtectedApplicationTerminalCheckpoint {
  const expected = protectedApplicationTerminalCheckpoint(
    request, accepted, checkpoint.operation, checkpoint.terminalAt
  );
  if (!exactKeys(checkpoint, [
    'kind', 'requestDigest', 'intentCheckpointDigest',
    'acceptedCheckpointDigest', 'operation', 'terminalAt', 'checkpointDigest'
  ]) || canonicalSha256(checkpoint) !== canonicalSha256(expected)) {
    return applicationError(
      'application-deployment-checkpoint',
      'Application terminal checkpoint changed the accepted handle, intent or terminal provider status.'
    );
  }
  return checkpoint;
}

export function validateProtectedApplicationWriteResult(
  request: ProtectedApplicationWriteRequest,
  result: ProtectedApplicationWriteResult
): ProtectedApplicationWriteResult {
  if (result.status === 'blocked') {
    if (request.execution !== 'dispatch' || result.effect !== 'none' ||
      !exactKeys(result, ['status', 'effect', 'reason'])) {
      return applicationError(
        'application-deployment-result',
        'No-effect blocking is permitted only before the first dispatch effect.'
      );
    }
    return result;
  }
  if (result.status === 'uncertain') {
    if (request.execution !== 'observe' || request.previousOperation !== null ||
      result.effect !== 'intent' ||
      canonicalSha256(result.intent) !== canonicalSha256(request.intent) ||
      !exactKeys(result, ['status', 'effect', 'reason', 'intent'])) {
      return applicationError(
        'application-deployment-result',
        'An intent-only recovery must preserve the exact pre-effect checkpoint and cannot redispatch.'
      );
    }
    return result;
  }
  if (!result.operation || !result.intent || !result.accepted) {
    return applicationError(
      'application-deployment-result',
      'Application effects require the durable original intent and accepted provider handle.'
    );
  }
  validateProtectedApplicationAcceptedCheckpoint(request, result.accepted);
  if (!sameOperationIdentity(result.operation, result.accepted.operation) ||
    canonicalSha256(result.intent) !== canonicalSha256(request.intent)) {
    return applicationError(
      'application-deployment-result',
      'Application result changed the accepted provider handle or original intent.'
    );
  }
  if (result.status === 'accepted') {
    if (result.effect !== 'accepted' || result.operation.status !== 'running' ||
      !exactKeys(result, ['status', 'effect', 'operation', 'intent', 'accepted'])) {
      return applicationError(
        'application-deployment-result',
        'An accepted application result must preserve a running provider handle for observation.'
      );
    }
    return result;
  }
  if (result.status === 'failed') {
    const terminal = result.terminal;
    if (!exactKeys(result, [
      'status', 'effect', 'reason', 'operation', 'intent', 'accepted',
      ...(terminal ? ['terminal'] : [])
    ]) ||
      result.effect === 'accepted' && (terminal !== undefined ||
        result.operation.status !== 'running') ||
      result.effect === 'terminal' && (!terminal ||
        !['completed', 'failed'].includes(result.operation.status))) {
      return applicationError(
        'application-deployment-result',
        'Post-acceptance failure must preserve either the running handle or its durable terminal checkpoint.'
      );
    }
    if (terminal) {
      validateProtectedApplicationTerminalCheckpoint(request, result.accepted, terminal);
      if (!sameOperationIdentity(result.operation, terminal.operation) ||
        result.operation.status !== terminal.operation.status) {
        return applicationError(
          'application-deployment-result',
          'Post-terminal verification failure changed the durable terminal operation.'
        );
      }
    }
    return result;
  }
  if (!result.terminal || !result.provenance || !result.plan ||
    !result.mappings || !result.completion) {
    return applicationError(
      'application-deployment-result',
      'Completed application execution requires terminal-before-readback durability and complete proof.'
    );
  }
  validateProtectedApplicationTerminalCheckpoint(
    request, result.accepted, result.terminal
  );
  validateProtectedApplicationExecutionProvenance(
    request.binding, result.provenance
  );
  validateProtectedApplicationPlanProof(
    request.binding, request.source, result.plan
  );
  validateApplicationStateMappingProofs(request.binding, result.mappings);
  validateProtectedApplicationCompletionProof(
    request.binding, request.source, result.plan, result.completion
  );
  if (result.effect !== 'terminal' ||
    result.action !== 'application-foundation' ||
    result.operation.status !== 'completed' ||
    !sameOperationIdentity(result.operation, result.terminal.operation) ||
    result.terminal.operation.status !== 'completed' ||
    !sameOperationIdentity(result.operation, result.completion.operation) ||
    result.plan.planDigest !== request.plan.planDigest ||
    result.provenance.provenanceDigest !== request.provenance.provenanceDigest ||
    !exactKeys(result, [
      'status', 'effect', 'action', 'operation', 'intent', 'accepted',
      'terminal', 'provenance', 'plan', 'mappings', 'completion'
    ])) {
    return applicationError(
      'application-deployment-result',
      'Completed application execution changed its durable checkpoints, protected plan, mappings, provenance or completion proof.'
    );
  }
  return result;
}

export function validateProtectedApplicationReadResult(
  request: ProtectedApplicationReadRequest,
  result: ProtectedApplicationReadResult,
  expectedObservation: ApplicationDeploymentReadback
): ProtectedApplicationReadResult {
  if (result.status === 'blocked') {
    if (result.effect !== 'none' ||
      !exactKeys(result, ['status', 'effect', 'reason'])) {
      return applicationError(
        'application-deployment-result',
        'Read-only blocking cannot report or imply a provider effect.'
      );
    }
    return result;
  }
  if (result.effect !== 'none' ||
    result.action !== request.action ||
    !sameOperationIdentity(result.operation, request.admittedOperation) ||
    result.operation.status !== request.admittedOperation.status ||
    result.provenance.provenanceDigest !== request.provenance.provenanceDigest ||
    result.admittedCompletionDigest !== request.admittedCompletionDigest ||
    canonicalSha256(result.observation) !== canonicalSha256(expectedObservation) ||
    !exactKeys(result, [
      'status', 'effect', 'action', 'operation', 'provenance',
      'admittedCompletionDigest', 'observation'
    ])) {
    return applicationError(
      'application-deployment-result',
      'Read-only result changed the admitted handle, provenance, completion or independently observed health proof.'
    );
  }
  return result;
}

function httpsUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return applicationError('application-deployment-readback', `${label} is not a valid URL.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
    parsed.search || parsed.hash || parsed.port) {
    return applicationError('application-deployment-readback', `${label} is not an exact credential-free HTTPS endpoint.`);
  }
  return parsed;
}

export function validateProtectedApplicationCompletionProof(
  binding: ApplicationDeploymentBinding,
  source: ObservedApplicationDeploymentSource,
  plan: ProtectedApplicationPlanProof,
  proof: ProtectedApplicationCompletionProof
): ProtectedApplicationCompletionProof {
  validateProtectedApplicationPlanProof(binding, source, plan);
  const operation = proof.operation;
  const health = proof.health[0];
  const backend = httpsUrl(proof.outputs.backendUrl, 'Application backend output');
  const endpoint = health ? httpsUrl(health.endpoint, 'Application backend health endpoint') : null;
  const applied = new Set(proof.appliedResourceIds.map((resourceId) => resourceId.toLowerCase()));
  if (!exactKeys(proof, [
    'schemaVersion', 'kind', 'bindingDigest', 'planDigest',
    'sourceInventoryDigest', 'operation', 'stateLineage', 'stateSerial',
    'appliedResourceIds', 'outputs', 'health', 'noChangePlanDigest',
    'completedAt', 'checks'
  ]) ||
    !exactKeys(proof.outputs, ['backendUrl', 'immutableImage']) ||
    !exactKeys(proof.checks, [
      'protectedBackend', 'exactPlanApplied', 'providerReadbackComplete',
      'noChangePlan', 'plaintextStateAbsent', 'sourceUnchanged'
    ]) ||
    proof.health.some((entry) => !exactKeys(entry, [
      'component', 'method', 'path', 'endpoint', 'status', 'bodyBytes',
      'bodySha256', 'observedAt', 'healthy'
    ])) ||
    proof.schemaVersion !== 1 || proof.kind !== 'protected-application-apply.v1' ||
    proof.bindingDigest !== binding.bindingDigest ||
    proof.planDigest !== plan.planDigest ||
    proof.sourceInventoryDigest !== source.sourceInventoryDigest ||
    operation.provider !== 'azure' ||
    operation.actionId !== 'azure.application-foundation.apply' ||
    operation.status !== 'completed' ||
    operation.resourceId.toLowerCase() !== binding.resourceGroupId.toLowerCase() ||
    typeof operation.planDigest !== 'string' ||
    !digestPattern.test(operation.planDigest) ||
    !proof.stateLineage || proof.stateLineage.length > 256 ||
    !Number.isSafeInteger(proof.stateSerial) || proof.stateSerial <= 0 ||
    proof.appliedResourceIds.length > 256 ||
    proof.appliedResourceIds.length !== applied.size ||
    plan.resourceIds.some((resourceId) => !applied.has(resourceId.toLowerCase())) ||
    proof.outputs.immutableImage !== binding.immutableImage ||
    backend.pathname !== '/' ||
    proof.health.length !== 1 || !health ||
    health.component !== 'backend' || health.method !== 'GET' ||
    health.path !== '/health' || health.status !== 200 || health.healthy !== true ||
    !endpoint || endpoint.origin !== backend.origin || endpoint.pathname !== '/health' ||
    !Number.isSafeInteger(health.bodyBytes) || health.bodyBytes < 0 ||
    health.bodyBytes > maximumHealthBodyBytes || !digestPattern.test(health.bodySha256) ||
    !Number.isFinite(Date.parse(health.observedAt)) ||
    !digestPattern.test(proof.noChangePlanDigest) ||
    !Number.isFinite(Date.parse(proof.completedAt)) ||
    !proof.checks.protectedBackend || !proof.checks.exactPlanApplied ||
    !proof.checks.providerReadbackComplete || !proof.checks.noChangePlan ||
    !proof.checks.plaintextStateAbsent || !proof.checks.sourceUnchanged) {
    return applicationError(
      'application-deployment-completion',
      'Application completion is not bound to the exact protected plan, immutable image, resource inventory, no-change state and successful bounded workload health observation.'
    );
  }
  return proof;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 1024) {
    return applicationError('application-deployment-readback', `${label} is absent or invalid.`);
  }
  return value;
}

function isTopLevelResource(groupId: string, resourceId: string): boolean {
  const prefix = `${groupId}/providers/`.toLowerCase();
  if (!resourceId.toLowerCase().startsWith(prefix)) return false;
  return resourceId.slice(prefix.length).split('/').length === 3;
}

export async function observeApplicationDeploymentReadback(
  input: PhaseAdapterExecutionInput,
  source: ObservedApplicationDeploymentSource,
  plan: ProtectedApplicationPlanProof,
  completion: ProtectedApplicationCompletionProof
): Promise<ApplicationDeploymentReadback> {
  const binding = source.binding;
  validateProtectedApplicationCompletionProof(binding, source, plan, completion);
  const group = azureObject(await runAzureJson(input, [
    'group', 'show',
    '--subscription', binding.subscriptionId,
    '--name', binding.resourceGroup,
    '--query', '{id:id,name:name,location:location,provisioningState:properties.provisioningState}'
  ], 'Application resource group readback'), 'Application resource group');
  const appId = `${binding.resourceGroupId}/providers/Microsoft.App/containerApps/${binding.expectedResourceNames.backendContainerApp}`;
  const app = azureObject(await runAzureJson(input, [
    'containerapp', 'show',
    '--subscription', binding.subscriptionId,
    '--ids', appId,
    '--query', '{id:id,name:name,location:location,provisioningState:properties.provisioningState,' +
      'latestRevisionName:properties.latestRevisionName,ingress:properties.configuration.ingress,' +
      'template:properties.template,identity:identity}'
  ], 'Application container readback'), 'Application container');
  const revisions = await runAzureJson(input, [
    'containerapp', 'revision', 'list',
    '--subscription', binding.subscriptionId,
    '--name', binding.expectedResourceNames.backendContainerApp,
    '--resource-group', binding.resourceGroup,
    '--query', '[].{name:name,active:properties.active,healthState:properties.healthState,' +
      'provisioningState:properties.provisioningState,runningState:properties.runningState,' +
      'trafficWeight:properties.trafficWeight,containers:properties.template.containers}'
  ], 'Application revision readback');
  const inventory = await runAzureJson(input, [
    'resource', 'list',
    '--subscription', binding.subscriptionId,
    '--resource-group', binding.resourceGroup,
    '--query', '[].{id:id}'
  ], 'Application resource inventory readback');
  const ingress = azureObject(app.ingress, 'Application ingress');
  const template = azureObject(app.template, 'Application template');
  const identity = azureObject(app.identity, 'Application identity');
  const identities = isRecord(identity.userAssignedIdentities)
    ? Object.keys(identity.userAssignedIdentities) : [];
  const containers = Array.isArray(template.containers) ? template.containers : [];
  const backendContainer = containers.find((container) =>
    isRecord(container) && container.name === 'backend');
  const currentRevision = Array.isArray(revisions)
    ? revisions.find((revision) => isRecord(revision) &&
      revision.name === app.latestRevisionName) : null;
  const revisionContainers = isRecord(currentRevision) &&
    Array.isArray(currentRevision.containers) ? currentRevision.containers : [];
  const inventoryIds = Array.isArray(inventory) ? inventory.map((entry) =>
    isRecord(entry) ? text(entry.id, 'Application inventory resource ID') : '') : [];
  const fqdn = text(ingress.fqdn, 'Application ingress FQDN');
  const health = completion.health[0]!;
  if (text(group.id, 'Application resource group ID').toLowerCase() !== binding.resourceGroupId.toLowerCase() ||
    group.name !== binding.resourceGroup || group.location !== binding.region ||
    group.provisioningState !== 'Succeeded' ||
    text(app.id, 'Application container ID').toLowerCase() !== appId.toLowerCase() ||
    app.name !== binding.expectedResourceNames.backendContainerApp ||
    app.location !== binding.region || app.provisioningState !== 'Succeeded' ||
    ingress.external !== true || !Array.isArray(ingress.traffic) ||
    !ingress.traffic.some((entry) => isRecord(entry) &&
      entry.latestRevision === true && entry.weight === 100) ||
    !isRecord(backendContainer) || backendContainer.image !== binding.immutableImage ||
    !identities.some((id) => id.toLowerCase() ===
      `${binding.resourceGroupId}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${binding.expectedResourceNames.identity}`.toLowerCase()) ||
    !isRecord(currentRevision) || currentRevision.active !== true ||
    currentRevision.healthState !== 'Healthy' ||
    currentRevision.provisioningState !== 'Provisioned' ||
    currentRevision.runningState !== 'Running' ||
    currentRevision.trafficWeight !== 100 ||
    !revisionContainers.some((container) =>
      isRecord(container) && container.name === 'backend' &&
      container.image === binding.immutableImage) ||
    completion.appliedResourceIds
      .filter((resourceId) => isTopLevelResource(binding.resourceGroupId, resourceId))
      .some((resourceId) =>
      !inventoryIds.some((observed) => observed.toLowerCase() === resourceId.toLowerCase())) ||
    completion.outputs.backendUrl !== `https://${fqdn}` ||
    health.endpoint !== `https://${fqdn}/health`) {
    return applicationError(
      'application-deployment-readback',
      'Azure application readback changed resource identity, region, immutable image, managed identity, active traffic, revision health or complete applied inventory.'
    );
  }
  const observed = {
    kind: 'application-foundation-readback.v1' as const,
    bindingDigest: binding.bindingDigest,
    sourceInventoryDigest: source.sourceInventoryDigest,
    planDigest: plan.planDigest,
    operationId: completion.operation.operationId,
    resourceGroupId: binding.resourceGroupId,
    backendResourceId: appId,
    backendUrl: completion.outputs.backendUrl,
    immutableImage: binding.immutableImage,
    revision: app.latestRevisionName,
    health: {
      endpoint: health.endpoint,
      status: health.status,
      bodyBytes: health.bodyBytes,
      bodySha256: health.bodySha256,
      observedAt: health.observedAt
    },
    noChangePlanDigest: completion.noChangePlanDigest,
    appliedResourceCount: completion.appliedResourceIds.length
  };
  return {
    observed,
    liveReadback: [
      applicationReadbackProof(input, 'azure', 'resource-group', binding.resourceGroupId, group),
      applicationReadbackProof(input, 'azure', 'container-app', appId, observed)
    ]
  };
}
