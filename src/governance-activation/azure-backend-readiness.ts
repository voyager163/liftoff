import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import type { TransitionOperation } from '../domain/governance/activation/types.js';
import { readPackagedSupportedStackBaseline } from '../adapters/packaged-assets/supported-stack.js';
import { nativeStateHostId } from '../adapters/state/native-system.js';
import type {
  PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanningInput
} from './transition-ports.js';
import {
  AzureDiscoveryError, azureObject, azureText, observeAzureIdentity, runAzureJson
} from './azure-discovery.js';
import { cloneState, readbackProof } from './transition-records.js';

const guidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const resourceGroupPattern = /^(?!.*\.$)[\p{L}\p{N}_.()\-]{1,90}$/u;
const storageAccountPattern = /^[a-z0-9]{3,24}$/u;
const containerPattern = /^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/u;
const expectedPath = 'existing-private' as const;
const azureBlobHostSuffixes = [
  '.blob.core.windows.net',
  '.blob.core.usgovcloudapi.net',
  '.blob.core.chinacloudapi.cn'
] as const;

interface ExistingPrivateBackendConfiguration {
  statePath: typeof expectedPath;
  resourceGroup: string;
  storageAccount: string;
  container: string;
  key: string;
  principalId: string;
}

interface BackendPlanBinding extends ExistingPrivateBackendConfiguration {
  subscriptionId: string;
  tenantId: string;
  executionHostId: string;
  storageAccountResourceId: string;
  containerResourceId: string;
  bindingDigest: string;
}

function configurationSource(input: PhasePlanningInput | PhaseAdapterExecutionInput) {
  return input.inspection.activationInputs ?? input.inspection.state.activationInputs;
}

function configurationError(message: string): never {
  throw new AzureDiscoveryError('backend-configuration', message);
}

function exactText(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    return configurationError(`${label} is absent or invalid in the reviewed existing-private backend configuration.`);
  }
  return value;
}

function stateKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024 ||
    /[\u0000-\u001f\u007f\\?#]/u.test(value) || value.startsWith('/') ||
    value.split('/').some((part) => part.length === 0 || part === '.' || part === '..')) {
    return configurationError('The reviewed existing-private blob key is absent or unsafe.');
  }
  return value;
}

export function existingPrivateBackendConfiguration(
  input: PhasePlanningInput | PhaseAdapterExecutionInput
): BackendPlanBinding {
  const source = configurationSource(input);
  const value = source?.phases['state-path-selected'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return configurationError(
      'Existing-private backend readiness requires reviewed state-path-selected inputs.'
    );
  }
  const allowed = new Set([
    'statePath', 'resourceGroup', 'storageAccount', 'container', 'key', 'principalId'
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return configurationError(
      'Existing-private backend inputs contain unsupported fields; commands, credentials, and inferred targets are forbidden.'
    );
  }
  if (value.statePath !== expectedPath) {
    return configurationError(
      'Task 13.1 supports only the explicitly reviewed existing-private state path; bootstrap-local remains unavailable.'
    );
  }
  const azure = source.azure;
  if (!azure) {
    return configurationError(
      'Existing-private backend readiness requires exact reviewed Azure subscription and tenant inputs.'
    );
  }
  const configuration: ExistingPrivateBackendConfiguration = {
    statePath: expectedPath,
    resourceGroup: exactText(value.resourceGroup, 'Azure backend resource group', resourceGroupPattern),
    storageAccount: exactText(value.storageAccount, 'Azure backend storage account', storageAccountPattern),
    container: exactText(value.container, 'Azure backend container', containerPattern),
    key: stateKey(value.key),
    principalId: exactText(value.principalId, 'Azure backend principal id', guidPattern).toLowerCase()
  };
  const subscriptionId = exactText(azure.subscriptionId, 'Azure subscription id', guidPattern).toLowerCase();
  const tenantId = exactText(azure.tenantId, 'Azure tenant id', guidPattern).toLowerCase();
  const storageAccountResourceId =
    `/subscriptions/${subscriptionId}/resourceGroups/${configuration.resourceGroup}` +
    `/providers/Microsoft.Storage/storageAccounts/${configuration.storageAccount}`;
  const containerResourceId =
    `${storageAccountResourceId}/blobServices/default/containers/${configuration.container}`;
  const executionHostId = nativeStateHostId();
  return {
    ...configuration,
    subscriptionId,
    tenantId,
    executionHostId,
    storageAccountResourceId,
    containerResourceId,
    bindingDigest: canonicalSha256({
      ...configuration,
      subscriptionId,
      tenantId,
      executionHostId,
      storageAccountResourceId,
      containerResourceId
    })
  };
}

export function existingPrivateBackendPlanInputs(
  input: PhasePlanningInput | PhaseAdapterExecutionInput
): Record<string, unknown> {
  const binding = existingPrivateBackendConfiguration(input);
  return {
    statePath: binding.statePath,
    resourceGroup: binding.resourceGroup,
    storageAccount: binding.storageAccount,
    container: binding.container,
    key: binding.key,
    principalId: binding.principalId,
    executionHostId: binding.executionHostId,
    storageAccountResourceId: binding.storageAccountResourceId,
    containerResourceId: binding.containerResourceId,
    bindingDigest: binding.bindingDigest,
    adoptExistingState: false
  };
}

function operationFor(input: PhaseAdapterExecutionInput): TransitionOperation {
  const actionId = input.phase.id === 'state-path-selected'
    ? 'azure.state-path.select'
    : 'azure.existing-private-path.verify';
  const operation = input.plan.operations.find((candidate) => candidate.actionId === actionId);
  if (!operation ||
    canonicalSha256(operation.inputs) !== canonicalSha256(existingPrivateBackendPlanInputs(input))) {
    throw new AzureDiscoveryError(
      'backend-plan-stale',
      'The approved backend operation no longer matches the exact reviewed private backend and execution path.'
    );
  }
  return operation;
}

function expectedTofuPlatform(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  return `${os}_${arch}`;
}

async function observeOpenTofuExecution(input: PhaseAdapterExecutionInput): Promise<{
  version: string;
  platform: string;
  hostId: string;
}> {
  const result = await input.runner.run({
    executable: 'tofu',
    args: ['version', '-json']
  }, {
    cwd: input.inspection.projectRoot,
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
    stream: false,
    env: { CHECKPOINT_DISABLE: '1', TF_IN_AUTOMATION: '1', TF_LOG: 'OFF' }
  });
  if (result.status !== 0 || result.timedOut || result.outputLimitExceeded || result.errorCode || result.aborted) {
    throw new AzureDiscoveryError(
      'execution-host',
      'The reviewed execution host could not run the packaged OpenTofu prerequisite; command diagnostics were withheld.'
    );
  }
  let value: Record<string, unknown>;
  try {
    value = azureObject(JSON.parse(result.stdout), 'OpenTofu version readback');
  } catch {
    throw new AzureDiscoveryError(
      'execution-host',
      'The reviewed execution host returned invalid OpenTofu version readback.'
    );
  }
  const baseline = readPackagedSupportedStackBaseline().opentofu;
  const version = azureText(value.terraform_version, 'OpenTofu version');
  const platform = azureText(value.platform, 'OpenTofu platform');
  const expectedPlatform = expectedTofuPlatform();
  if (version !== baseline.version.version || platform !== expectedPlatform ||
    !baseline.lockPlatforms.includes(platform)) {
    throw new AzureDiscoveryError(
      'execution-host',
      `The reviewed execution host must use qualified OpenTofu ${baseline.version.version} for ${expectedPlatform}.`
    );
  }
  return { version, platform, hostId: nativeStateHostId() };
}

async function observeStorageAccount(
  input: PhaseAdapterExecutionInput,
  binding: BackendPlanBinding
) {
  const value = azureObject(await runAzureJson(input, [
    'storage', 'account', 'show',
    '--subscription', binding.subscriptionId,
    '--resource-group', binding.resourceGroup,
    '--name', binding.storageAccount,
    '--query',
    '{id:id,name:name,resourceGroup:resourceGroup,kind:kind,location:primaryLocation,' +
    'provisioningState:provisioningState,publicNetworkAccess:publicNetworkAccess,' +
    'allowSharedKeyAccess:allowSharedKeyAccess,allowBlobPublicAccess:allowBlobPublicAccess,' +
    'minimumTlsVersion:minimumTlsVersion,defaultToOAuthAuthentication:defaultToOAuthAuthentication,' +
    'httpsOnly:enableHttpsTrafficOnly,blobEndpoint:primaryEndpoints.blob}'
  ], 'Azure private backend storage-account readback'), 'Azure private backend storage account');
  const id = azureText(value.id, 'Azure private backend storage account id');
  let blobEndpoint: URL;
  try {
    blobEndpoint = new URL(azureText(value.blobEndpoint, 'Azure private backend blob endpoint'));
  } catch {
    throw new AzureDiscoveryError(
      'backend-protection',
      'The exact Azure backend account returned an invalid blob endpoint.'
    );
  }
  if (id.toLowerCase() !== binding.storageAccountResourceId.toLowerCase() ||
    value.name !== binding.storageAccount ||
    String(value.resourceGroup).toLowerCase() !== binding.resourceGroup.toLowerCase() ||
    !['StorageV2', 'BlobStorage'].includes(String(value.kind)) ||
    value.provisioningState !== 'Succeeded' ||
    value.publicNetworkAccess !== 'Disabled' ||
    value.allowSharedKeyAccess !== false ||
    value.allowBlobPublicAccess !== false ||
    value.minimumTlsVersion !== 'TLS1_2' ||
    value.defaultToOAuthAuthentication !== true ||
    value.httpsOnly !== true ||
    blobEndpoint.protocol !== 'https:' ||
    blobEndpoint.username || blobEndpoint.password || blobEndpoint.search || blobEndpoint.hash ||
    blobEndpoint.port || blobEndpoint.pathname !== '/' ||
    !azureBlobHostSuffixes.some((suffix) => blobEndpoint.hostname === `${binding.storageAccount}${suffix}`)) {
    throw new AzureDiscoveryError(
      'backend-protection',
      'The exact Azure backend account does not satisfy private OAuth-only HTTPS protection requirements.'
    );
  }
  return {
    id,
    name: binding.storageAccount,
    resourceGroup: binding.resourceGroup,
    kind: value.kind,
    location: azureText(value.location, 'Azure private backend location'),
    publicNetworkAccess: 'Disabled' as const,
    sharedKeyAccess: false,
    blobPublicAccess: false,
    minimumTlsVersion: 'TLS1_2' as const,
    defaultToOAuthAuthentication: true,
    httpsOnly: true
  };
}

async function observeBlobProtection(
  input: PhaseAdapterExecutionInput,
  binding: BackendPlanBinding
) {
  const value = azureObject(await runAzureJson(input, [
    'storage', 'account', 'blob-service-properties', 'show',
    '--subscription', binding.subscriptionId,
    '--resource-group', binding.resourceGroup,
    '--account-name', binding.storageAccount,
    '--query',
    '{isVersioningEnabled:isVersioningEnabled,' +
    'deleteRetentionEnabled:deleteRetentionPolicy.enabled,' +
    'deleteRetentionDays:deleteRetentionPolicy.days}'
  ], 'Azure private backend blob-protection readback'), 'Azure private backend blob protection');
  const days = Number(value.deleteRetentionDays);
  if (value.isVersioningEnabled !== true || value.deleteRetentionEnabled !== true ||
    !Number.isInteger(days) || days < 1 || days > 365) {
    throw new AzureDiscoveryError(
      'backend-versioning',
      'The exact Azure backend must enable blob versioning and bounded soft-delete retention.'
    );
  }
  return { versioning: true as const, softDelete: true as const, softDeleteDays: days };
}

async function observeContainerReachability(
  input: PhaseAdapterExecutionInput,
  binding: BackendPlanBinding
) {
  const value = azureObject(await runAzureJson(input, [
    'storage', 'container', 'show',
    '--auth-mode', 'login',
    '--account-name', binding.storageAccount,
    '--name', binding.container,
    '--query',
    '{name:name,publicAccess:properties.publicAccess,' +
    'leaseState:properties.leaseState,leaseStatus:properties.leaseStatus}'
  ], 'Azure private backend container data-plane readback'), 'Azure private backend container');
  const publicAccess = value.publicAccess;
  if (value.name !== binding.container ||
    !(publicAccess === null || publicAccess === undefined || publicAccess === 'None') ||
    String(value.leaseState).toLowerCase() !== 'available' ||
    String(value.leaseStatus).toLowerCase() !== 'unlocked') {
    throw new AzureDiscoveryError(
      'backend-locking',
      'The exact Azure backend container is public, identity-mismatched, or unavailable for blob-lease locking.'
    );
  }
  return {
    id: binding.containerResourceId,
    name: binding.container,
    reachable: true as const,
    publicAccess: false,
    locking: 'azure-blob-lease' as const,
    leaseState: 'available' as const,
    leaseStatus: 'unlocked' as const
  };
}

async function observeTargetAbsence(
  input: PhaseAdapterExecutionInput,
  binding: BackendPlanBinding
) {
  const value = azureObject(await runAzureJson(input, [
    'storage', 'blob', 'exists',
    '--auth-mode', 'login',
    '--account-name', binding.storageAccount,
    '--container-name', binding.container,
    '--name', binding.key,
    '--query', '{exists:exists}'
  ], 'Azure private backend target-state absence readback'), 'Azure private backend target state');
  if (value.exists !== false) {
    throw new AzureDiscoveryError(
      'pre-existing-state',
      'The exact backend key already contains state; this release refuses to read, import, or adopt it.'
    );
  }
  return { exists: false as const, keyDigest: canonicalSha256(binding.key) };
}

async function observeBackendIdentity(
  input: PhaseAdapterExecutionInput,
  binding: BackendPlanBinding
) {
  const identity = await observeAzureIdentity(input);
  if (identity.principal.objectId !== binding.principalId ||
    identity.subscription.id !== binding.subscriptionId ||
    identity.subscription.tenantId !== binding.tenantId) {
    throw new AzureDiscoveryError(
      'backend-principal',
      'The current Azure identity differs from the exact reviewed backend principal, subscription, or tenant.'
    );
  }
  const execution = await observeOpenTofuExecution(input);
  if (execution.hostId !== binding.executionHostId) {
    throw new AzureDiscoveryError(
      'execution-host',
      'The backend plan was reviewed for a different execution host.'
    );
  }
  return { identity, execution };
}

function backendOutputs(binding: BackendPlanBinding, execution: {
  version: string;
  platform: string;
  hostId: string;
}, targetStateExists?: false, includeContainer = false) {
  return {
    values: {
      statePath: binding.statePath,
      backendBindingDigest: binding.bindingDigest,
      backendKeyDigest: canonicalSha256(binding.key),
      executionHostId: execution.hostId,
      openTofuVersion: execution.version,
      openTofuPlatform: execution.platform,
      ...(targetStateExists === undefined ? {} : { targetStateExists })
    },
    resources: [
      {
        provider: 'azure' as const,
        resourceType: 'Microsoft.Storage/storageAccounts',
        resourceId: binding.storageAccountResourceId
      },
      ...(includeContainer ? [{
        provider: 'azure' as const,
        resourceType: 'Microsoft.Storage/storageAccounts/blobServices/containers',
        resourceId: binding.containerResourceId
      }] : [])
    ]
  };
}

export async function executeAzureStatePathSelection(
  input: PhaseAdapterExecutionInput
): Promise<PhaseAdapterOutcome | null> {
  if (input.phase.id !== 'state-path-selected') return null;
  try {
    const operation = operationFor(input);
    const binding = existingPrivateBackendConfiguration(input);
    const { identity, execution } = await observeBackendIdentity(input, binding);
    const account = await observeStorageAccount(input, binding);
    const state = cloneState(input.inspection.state);
    state.applicability = { ...state.applicability, statePath: expectedPath };
    return {
      status: 'completed',
      resultState: 'verified',
      stateOverride: state,
      evidencePayload: {
        kind: 'state-path-selected.v1',
        statePath: expectedPath,
        backendBindingDigest: binding.bindingDigest,
        backendKeyDigest: canonicalSha256(binding.key),
        execution,
        principal: identity.principal,
        account,
        adoptExistingState: false
      },
      liveReadback: [
        readbackProof(
          input,
          'azure',
          'private-state-backend-selection',
          binding.storageAccountResourceId,
          { bindingDigest: binding.bindingDigest, account, execution, principal: identity.principal }
        )
      ],
      outputs: backendOutputs(binding, execution),
      completedOperations: [operation]
    };
  } catch (error) {
    if (!(error instanceof AzureDiscoveryError)) throw error;
    return {
      status: 'blocked',
      resultState: 'failed',
      blocker: error.message,
      completedOperations: []
    };
  }
}

export async function executeExistingPrivateBackendReadiness(
  input: PhaseAdapterExecutionInput
): Promise<PhaseAdapterOutcome | null> {
  if (input.phase.id !== 'existing-private-path') return null;
  try {
    const operation = operationFor(input);
    const binding = existingPrivateBackendConfiguration(input);
    if (input.inspection.state.applicability.statePath !== expectedPath) {
      throw new AzureDiscoveryError(
        'backend-selection',
        'The activation state does not select the reviewed existing-private backend path.'
      );
    }
    const { identity, execution } = await observeBackendIdentity(input, binding);
    const account = await observeStorageAccount(input, binding);
    const protection = await observeBlobProtection(input, binding);
    const container = await observeContainerReachability(input, binding);
    const target = await observeTargetAbsence(input, binding);
    return {
      status: 'completed',
      resultState: 'verified',
      evidencePayload: {
        kind: 'existing-private-path.v1',
        backendBindingDigest: binding.bindingDigest,
        backendKeyDigest: target.keyDigest,
        execution,
        principal: identity.principal,
        account,
        protection,
        container,
        target,
        adoptExistingState: false
      },
      liveReadback: [
        readbackProof(
          input,
          'azure',
          'private-state-backend',
          binding.storageAccountResourceId,
          {
            bindingDigest: binding.bindingDigest,
            account,
            protection,
            container,
            target,
            execution,
            principal: identity.principal
          }
        )
      ],
      outputs: backendOutputs(binding, execution, false, true),
      completedOperations: [operation]
    };
  } catch (error) {
    if (!(error instanceof AzureDiscoveryError)) throw error;
    return {
      status: 'blocked',
      resultState: 'failed',
      blocker: error.message,
      completedOperations: []
    };
  }
}
