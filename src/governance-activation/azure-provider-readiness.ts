import type { TransitionOperation } from '../domain/governance/activation/types.js';
import { operation, transitionDestination } from '../domain/governance/activation/operations.js';
import type {
  PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput
} from './transition-ports.js';
import {
  AzureDiscoveryError, azureObject, azureText, observeAzureIdentity, runAzureJson
} from './azure-discovery.js';
import { readbackProof } from './transition-records.js';

const providerAction = 'Microsoft.Resources/subscriptions/providers/register/action';
const featureAction = 'Microsoft.Features/providers/features/register/action';
const permissionApiVersion = '2022-04-01';
const pollIntervalMs = 5_000;
const pollLimit = 60;
const namespacePattern = /^[A-Z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/u;
const typeSegmentPattern = /^[A-Za-z][A-Za-z0-9]*$/u;
const unsupportedTypeSegments = new Set(['action', 'delete', 'listkeys', 'read', 'write']);
const recognizedStates = new Set(['NotRegistered', 'Registering', 'Registered', 'Unregistering']);

type RegistrationMode = 'automatic' | 'none';
type RegistrationState = 'NotRegistered' | 'Registering' | 'Registered' | 'Unregistering';

interface ProviderRequirement {
  kind: 'provider';
  namespace: string;
  requiredBy: readonly string[];
}

interface FeatureRequirement {
  kind: 'feature';
  namespace: string;
  name: string;
  requiredBy: readonly string[];
}

type Requirement = ProviderRequirement | FeatureRequirement;

interface ProviderObservation extends ProviderRequirement {
  id: string;
  registrationState: RegistrationState;
}

interface FeatureObservation extends FeatureRequirement {
  id: string;
  registrationState: RegistrationState;
}

type RequirementObservation = ProviderObservation | FeatureObservation;

interface PermissionObservation {
  providerRegistration: boolean;
  featureRegistration: boolean;
}

interface ReadinessConfiguration {
  registrationMode: RegistrationMode;
  resourceTypes: readonly string[];
  requirements: readonly Requirement[];
}

interface PlannedRequirement {
  kind: Requirement['kind'];
  namespace: string;
  name?: string;
  requiredBy: readonly string[];
  observedState: RegistrationState;
  registrationMode: RegistrationMode;
  refreshAfterFeature: boolean;
}

const featureRequirements = new Map<string, readonly Omit<FeatureRequirement, 'requiredBy'>[]>([
  ['microsoft.network/customipprefixes', [{
    kind: 'feature',
    namespace: 'Microsoft.Network',
    name: 'AllowBringYourOwnPublicIpAddress'
  }]]
]);

function readinessError(code: string, message: string): never {
  throw new AzureDiscoveryError(code, message);
}

function phaseConfiguration(input: PhasePlanningInput | PhaseAdapterExecutionInput): Record<string, unknown> {
  const configuration = input.inspection.activationInputs?.phases['provider-ready'] ??
    input.inspection.state.activationInputs?.phases['provider-ready'];
  if (!configuration) {
    return readinessError('configuration-required',
      'Provider readiness requires reviewed provider-ready inputs with resourceTypes and azureRmRegistrationMode.');
  }
  const allowed = new Set(['azureRmRegistrationMode', 'resourceTypes']);
  if (Object.keys(configuration).some((key) => !allowed.has(key))) {
    return readinessError('configuration-invalid',
      'Provider readiness inputs contain unsupported fields; review only resourceTypes and azureRmRegistrationMode.');
  }
  return configuration;
}

function resourceType(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256) {
    return readinessError('resource-type-invalid', 'Every approved Azure resource type must be a bounded string.');
  }
  const parts = value.split('/');
  if (parts.length < 2 || !namespacePattern.test(parts[0]!) ||
    parts.slice(1).some((segment) => !typeSegmentPattern.test(segment) ||
      unsupportedTypeSegments.has(segment.toLowerCase()))) {
    return readinessError('resource-type-invalid',
      'Approved Azure resource types must use namespace/type form and cannot be provider actions.');
  }
  return value;
}

function readinessConfiguration(input: PhasePlanningInput | PhaseAdapterExecutionInput): ReadinessConfiguration {
  const configuration = phaseConfiguration(input);
  if (configuration.azureRmRegistrationMode !== 'automatic' &&
    configuration.azureRmRegistrationMode !== 'none') {
    return readinessError('registration-mode-invalid',
      'provider-ready.azureRmRegistrationMode must be automatic or none.');
  }
  if (!Array.isArray(configuration.resourceTypes) || configuration.resourceTypes.length === 0 ||
    configuration.resourceTypes.length > 128) {
    return readinessError('resource-types-required',
      'provider-ready.resourceTypes must contain 1 to 128 approved Azure resource types.');
  }
  const byCanonicalType = new Map<string, string>();
  for (const value of configuration.resourceTypes) {
    const type = resourceType(value);
    byCanonicalType.set(type.toLowerCase(), type);
  }
  const resourceTypes = [...byCanonicalType.values()].sort((left, right) =>
    left.localeCompare(right, 'en', { sensitivity: 'base' }));
  const providers = new Map<string, { namespace: string; requiredBy: string[] }>();
  const features = new Map<string, { namespace: string; name: string; requiredBy: string[] }>();
  for (const type of resourceTypes) {
    const namespace = type.split('/')[0]!;
    const providerKey = namespace.toLowerCase();
    const provider = providers.get(providerKey) ?? { namespace, requiredBy: [] };
    provider.requiredBy.push(type);
    providers.set(providerKey, provider);
    for (const requirement of featureRequirements.get(type.toLowerCase()) ?? []) {
      const featureKey = `${requirement.namespace.toLowerCase()}/${requirement.name.toLowerCase()}`;
      const feature = features.get(featureKey) ?? { ...requirement, requiredBy: [] };
      feature.requiredBy.push(type);
      features.set(featureKey, feature);
    }
  }
  const requirements: Requirement[] = [
    ...[...features.values()]
      .sort((left, right) => `${left.namespace}/${left.name}`.localeCompare(`${right.namespace}/${right.name}`, 'en'))
      .map((requirement) => ({ kind: 'feature' as const, ...requirement })),
    ...[...providers.values()]
      .sort((left, right) => left.namespace.localeCompare(right.namespace, 'en'))
      .map((requirement) => ({ kind: 'provider' as const, ...requirement }))
  ];
  return {
    registrationMode: configuration.azureRmRegistrationMode,
    resourceTypes,
    requirements
  };
}

function registrationState(value: unknown, label: string): RegistrationState {
  const state = azureText(value, label);
  if (!recognizedStates.has(state)) {
    return readinessError('registration-state-invalid',
      `${label} is not a supported Azure registration state.`);
  }
  return state as RegistrationState;
}

function expectedProviderId(subscriptionId: string, namespace: string): string {
  return `/subscriptions/${subscriptionId}/providers/${namespace}`;
}

function expectedFeatureId(subscriptionId: string, namespace: string, name: string): string {
  return `/subscriptions/${subscriptionId}/providers/Microsoft.Features/providers/${namespace}/features/${name}`;
}

function exactResourceId(value: unknown, expected: string, label: string): string {
  const id = azureText(value, label);
  if (id.toLowerCase() !== expected.toLowerCase()) {
    return readinessError('registration-binding',
      `${label} differs from the exact approved subscription prerequisite.`);
  }
  return id;
}

async function observeProvider(
  input: PhasePlanningInput | PhaseAdapterExecutionInput,
  subscriptionId: string,
  requirement: ProviderRequirement
): Promise<ProviderObservation> {
  const response = azureObject(await runAzureJson(input, [
    'provider', 'show',
    '--subscription', subscriptionId,
    '--namespace', requirement.namespace,
    '--query', '{id:id,namespace:namespace,registrationState:registrationState}'
  ], `Azure provider discovery for ${requirement.namespace}`), 'Azure provider');
  if (azureText(response.namespace, 'Azure provider namespace').toLowerCase() !== requirement.namespace.toLowerCase()) {
    return readinessError('registration-binding',
      'Azure provider discovery returned a namespace outside the approved prerequisite.');
  }
  return {
    ...requirement,
    id: exactResourceId(response.id, expectedProviderId(subscriptionId, requirement.namespace), 'Azure provider id'),
    registrationState: registrationState(response.registrationState, 'Azure provider registration state')
  };
}

async function observeFeature(
  input: PhasePlanningInput | PhaseAdapterExecutionInput,
  subscriptionId: string,
  requirement: FeatureRequirement
): Promise<FeatureObservation> {
  const response = azureObject(await runAzureJson(input, [
    'feature', 'show',
    '--subscription', subscriptionId,
    '--namespace', requirement.namespace,
    '--name', requirement.name,
    '--query', '{id:id,name:name,state:properties.state}'
  ], `Azure feature discovery for ${requirement.namespace}/${requirement.name}`), 'Azure feature');
  if (azureText(response.name, 'Azure feature name').toLowerCase() !== requirement.name.toLowerCase()) {
    return readinessError('registration-binding',
      'Azure feature discovery returned a feature outside the approved prerequisite.');
  }
  return {
    ...requirement,
    id: exactResourceId(
      response.id,
      expectedFeatureId(subscriptionId, requirement.namespace, requirement.name),
      'Azure feature id'
    ),
    registrationState: registrationState(response.state, 'Azure feature registration state')
  };
}

async function observeRequirement(
  input: PhasePlanningInput | PhaseAdapterExecutionInput,
  subscriptionId: string,
  requirement: Requirement
): Promise<RequirementObservation> {
  return requirement.kind === 'provider'
    ? observeProvider(input, subscriptionId, requirement)
    : observeFeature(input, subscriptionId, requirement);
}

function wildcardMatches(pattern: string, action: string): boolean {
  if (!pattern || pattern.length > 512 || /[\u0000-\u001f\u007f]/u.test(pattern)) return false;
  const expression = pattern
    .replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')
    .replace(/\\\*/gu, '.*');
  return new RegExp(`^${expression}$`, 'iu').test(action);
}

function permissionEntries(value: unknown): readonly Record<string, unknown>[] {
  const response = azureObject(value, 'Azure effective permissions');
  if (response.nextLink !== undefined && response.nextLink !== null) {
    return readinessError('permission-bound',
      'Azure effective permissions were paginated; complete permission proof is required before provider writes.');
  }
  if (!Array.isArray(response.value) || response.value.length > 1_000) {
    return readinessError('permission-bound',
      'Azure effective permissions are invalid or exceed the 1,000-entry qualification bound.');
  }
  return response.value.map((entry) => azureObject(entry, 'Azure effective permission'));
}

function stringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 1_000 ||
    value.some((entry) => typeof entry !== 'string' || entry.length > 512)) {
    return readinessError('permission-invalid', `${label} is invalid or exceeds its qualification bound.`);
  }
  return value as string[];
}

function permits(entries: readonly Record<string, unknown>[], action: string): boolean {
  return entries.some((entry) => {
    const actions = stringList(entry.actions, 'Azure effective permission actions');
    const notActions = stringList(entry.notActions ?? [], 'Azure effective permission exclusions');
    return actions.some((candidate) => wildcardMatches(candidate, action)) &&
      !notActions.some((candidate) => wildcardMatches(candidate, action));
  });
}

async function observePermissions(
  input: PhasePlanningInput | PhaseAdapterExecutionInput,
  identity: Awaited<ReturnType<typeof observeAzureIdentity>>
): Promise<PermissionObservation> {
  const url = new URL(
    `subscriptions/${identity.subscription.id}/providers/Microsoft.Authorization/permissions?api-version=${permissionApiVersion}`,
    identity.cloud.resourceManager
  ).toString();
  const entries = permissionEntries(await runAzureJson(input, [
    'rest', '--method', 'GET', '--url', url, '--resource', identity.cloud.resourceManagerAudience
  ], 'Azure provider registration permission discovery'));
  return {
    providerRegistration: permits(entries, providerAction),
    featureRegistration: permits(entries, featureAction)
  };
}

function plannedOperation(
  input: PhasePlanningInput,
  subscriptionId: string,
  observation: RequirementObservation,
  configuration: ReadinessConfiguration,
  refreshAfterFeature: boolean
): TransitionOperation {
  const shouldRegister = observation.kind === 'feature'
    ? observation.registrationState === 'NotRegistered'
    : observation.registrationState === 'NotRegistered' ||
      refreshAfterFeature;
  return operation({
    adapter: 'azure-opentofu',
    actionId: 'azure.provider.ensure-ready',
    mutationClass: shouldRegister ? 'azure-provider-register' : 'azure-read',
    phaseId: input.phase.id,
    inputs: {
      kind: observation.kind,
      namespace: observation.namespace,
      ...(observation.kind === 'feature' ? { name: observation.name } : {}),
      requiredBy: observation.requiredBy,
      observedState: observation.registrationState,
      registrationMode: configuration.registrationMode,
      refreshAfterFeature
    },
    destination: transitionDestination('subscription', subscriptionId, { subscriptionId }),
    remote: true,
    destructive: false
  });
}

export async function planAzureProviderReadiness(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  const configuration = readinessConfiguration(input);
  const identity = await observeAzureIdentity(input);
  const observations: RequirementObservation[] = [];
  for (const requirement of configuration.requirements) {
    observations.push(await observeRequirement(input, identity.subscription.id, requirement));
  }
  const permissions = await observePermissions(input, identity);
  const missingProviders = observations.filter((entry) =>
    entry.kind === 'provider' && entry.registrationState === 'NotRegistered');
  const missingFeatures = observations.filter((entry) =>
    entry.kind === 'feature' && entry.registrationState === 'NotRegistered');
  const nonTerminal = observations.filter((entry) => entry.registrationState === 'Unregistering');
  if (nonTerminal.length) {
    return {
      operations: [],
      blockers: ['Azure provider readiness found an approved prerequisite that is Unregistering; wait for a stable state and re-plan.']
    };
  }
  if (configuration.registrationMode === 'automatic' && missingProviders.length) {
    return {
      operations: [],
      blockers: [
        'AzureRM automatic provider registration has not established every approved namespace; review the provider configuration instead of adding duplicate explicit registrations.'
      ]
    };
  }
  if (configuration.registrationMode === 'none' && missingProviders.length && !permissions.providerRegistration) {
    return {
      operations: [],
      blockers: [
        'The current Azure identity lacks Microsoft.Resources/subscriptions/providers/register/action for an approved missing namespace.'
      ]
    };
  }
  if (missingFeatures.length && !permissions.featureRegistration) {
    return {
      operations: [],
      blockers: [
        'The current Azure identity lacks Microsoft.Features/providers/features/register/action for an approved required feature.'
      ]
    };
  }
  const namespacesWithMissingFeatures = new Set(missingFeatures.map((entry) => entry.namespace.toLowerCase()));
  return {
    operations: observations.map((observation) =>
      plannedOperation(
        input,
        identity.subscription.id,
        observation,
        configuration,
        observation.kind === 'provider' && namespacesWithMissingFeatures.has(observation.namespace.toLowerCase())
      ))
  };
}

function plannedRequirement(operation: TransitionOperation): PlannedRequirement {
  const inputs = operation.inputs;
  const allowed = new Set([
    'kind', 'namespace', 'name', 'requiredBy', 'observedState', 'registrationMode', 'refreshAfterFeature'
  ]);
  if (operation.actionId !== 'azure.provider.ensure-ready' ||
    Object.keys(inputs).some((key) => !allowed.has(key)) ||
    (inputs.kind !== 'provider' && inputs.kind !== 'feature') ||
    typeof inputs.namespace !== 'string' || !namespacePattern.test(inputs.namespace) ||
    !Array.isArray(inputs.requiredBy) || inputs.requiredBy.length === 0 ||
    inputs.requiredBy.some((entry) => typeof entry !== 'string') ||
    !recognizedStates.has(String(inputs.observedState)) ||
    (inputs.registrationMode !== 'automatic' && inputs.registrationMode !== 'none') ||
    typeof inputs.refreshAfterFeature !== 'boolean') {
    return readinessError('plan-invalid', 'The approved provider-ready operation is malformed.');
  }
  if (inputs.kind === 'feature' &&
    (typeof inputs.name !== 'string' || !typeSegmentPattern.test(inputs.name))) {
    return readinessError('plan-invalid', 'The approved provider-ready feature operation is malformed.');
  }
  if (inputs.kind === 'provider' && inputs.name !== undefined) {
    return readinessError('plan-invalid', 'A provider-ready namespace operation cannot contain a feature name.');
  }
  return {
    kind: inputs.kind,
    namespace: inputs.namespace,
    ...(inputs.kind === 'feature' ? { name: inputs.name as string } : {}),
    requiredBy: inputs.requiredBy as string[],
    observedState: inputs.observedState as RegistrationState,
    registrationMode: inputs.registrationMode,
    refreshAfterFeature: inputs.refreshAfterFeature
  };
}

function asRequirement(planned: PlannedRequirement): Requirement {
  return planned.kind === 'provider'
    ? { kind: 'provider', namespace: planned.namespace, requiredBy: planned.requiredBy }
    : { kind: 'feature', namespace: planned.namespace, name: planned.name!, requiredBy: planned.requiredBy };
}

async function registerRequirement(
  input: PhaseAdapterExecutionInput,
  subscriptionId: string,
  requirement: Requirement
): Promise<void> {
  if (requirement.kind === 'provider') {
    await runAzureJson(input, [
      'provider', 'register',
      '--subscription', subscriptionId,
      '--namespace', requirement.namespace
    ], `Azure provider registration for ${requirement.namespace}`);
    return;
  }
  await runAzureJson(input, [
    'feature', 'register',
    '--subscription', subscriptionId,
    '--namespace', requirement.namespace,
    '--name', requirement.name
  ], `Azure feature registration for ${requirement.namespace}/${requirement.name}`);
}

async function waitForRegistered(
  input: PhaseAdapterExecutionInput,
  subscriptionId: string,
  requirement: Requirement
): Promise<RequirementObservation> {
  for (let attempt = 0; attempt < pollLimit; attempt += 1) {
    const observation = await observeRequirement(input, subscriptionId, requirement);
    if (observation.registrationState === 'Registered') return observation;
    if (observation.registrationState === 'Unregistering') {
      return readinessError('registration-conflict',
        `Azure ${requirement.kind} ${requirement.namespace} entered Unregistering before readiness was established.`);
    }
    if (attempt + 1 < pollLimit) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  return readinessError('registration-timeout',
    `Azure ${requirement.kind} ${requirement.namespace} did not reach terminal Registered state within five minutes.`);
}

function registrationLabel(requirement: Requirement): string {
  return requirement.kind === 'provider'
    ? requirement.namespace
    : `${requirement.namespace}/${requirement.name}`;
}

export async function executeAzureProviderReadiness(
  input: PhaseAdapterExecutionInput
): Promise<PhaseAdapterOutcome> {
  const operations = input.plan.operations.filter((entry) => entry.actionId === 'azure.provider.ensure-ready');
  if (!operations.length) {
    return {
      status: 'blocked',
      blocker: 'The approved provider-ready plan contains no Azure prerequisite operations.',
      completedOperations: []
    };
  }
  const completedOperations: TransitionOperation[] = [];
  const retained: string[] = [];
  try {
    const configuration = readinessConfiguration(input);
    const identity = await observeAzureIdentity(input);
    const permissions = await observePermissions(input, identity);
    const expectedRequirements = configuration.requirements.map((entry) => ({
      kind: entry.kind,
      namespace: entry.namespace,
      ...(entry.kind === 'feature' ? { name: entry.name } : {}),
      requiredBy: entry.requiredBy,
      registrationMode: configuration.registrationMode
    }));
    const planned = operations.map((entry) => plannedRequirement(entry));
    const plannedRequirements = planned.map((entry) => ({
      kind: entry.kind,
      namespace: entry.namespace,
      ...(entry.kind === 'feature' ? { name: entry.name } : {}),
      requiredBy: entry.requiredBy,
      registrationMode: entry.registrationMode
    }));
    if (JSON.stringify(plannedRequirements) !== JSON.stringify(expectedRequirements)) {
      return readinessError('plan-stale',
        'The approved provider-ready operations no longer match the reviewed resource-type prerequisites.');
    }
    const observations: RequirementObservation[] = [];
    for (let index = 0; index < operations.length; index += 1) {
      const approvedOperation = operations[index]!;
      const approved = planned[index]!;
      const requirement = asRequirement(approved);
      let observation = await observeRequirement(input, identity.subscription.id, requirement);
      const plannedRegistration = approvedOperation.mutationClass === 'azure-provider-register';
      if (observation.registrationState !== 'Registered') {
        if (observation.registrationState === 'Unregistering') {
          return readinessError('registration-conflict',
            `Azure prerequisite ${registrationLabel(requirement)} is Unregistering; no dependent write is permitted.`);
        }
        if (!plannedRegistration) {
          if (observation.registrationState === 'Registering') {
            observation = await waitForRegistered(input, identity.subscription.id, requirement);
          } else {
            return readinessError('plan-stale',
              `Azure prerequisite ${registrationLabel(requirement)} now requires an unapproved registration write.`);
          }
        } else {
          const permitted = requirement.kind === 'provider'
            ? permissions.providerRegistration
            : permissions.featureRegistration;
          if (!permitted) {
            return readinessError('registration-permission',
              `The current Azure identity lacks live permission to register ${registrationLabel(requirement)}.`);
          }
          if (requirement.kind === 'provider' && approved.registrationMode === 'automatic' &&
            !approved.refreshAfterFeature) {
            return readinessError('registration-mode',
              'Explicit provider registration is not authorized while AzureRM automatic registration is selected.');
          }
          if (observation.registrationState === 'NotRegistered') {
            await registerRequirement(input, identity.subscription.id, requirement);
            retained.push(registrationLabel(requirement));
          } else if (observation.registrationState === 'Registering' &&
            requirement.kind === 'provider' && approved.refreshAfterFeature) {
            observation = await waitForRegistered(input, identity.subscription.id, requirement);
            await registerRequirement(input, identity.subscription.id, requirement);
            retained.push(registrationLabel(requirement));
          }
          observation = await waitForRegistered(input, identity.subscription.id, requirement);
        }
      } else if (plannedRegistration && approved.refreshAfterFeature) {
        if (!permissions.providerRegistration) {
          return readinessError('registration-permission',
            `The current Azure identity lacks live permission to refresh ${registrationLabel(requirement)} after feature registration.`);
        }
        await registerRequirement(input, identity.subscription.id, requirement);
        retained.push(registrationLabel(requirement));
        observation = await waitForRegistered(input, identity.subscription.id, requirement);
      }
      observations.push(observation);
      completedOperations.push(approvedOperation);
    }
    const liveReadback = observations.map((observation) =>
      readbackProof(
        input,
        'azure',
        observation.kind === 'provider' ? 'provider-registration' : 'subscription-feature',
        observation.id,
        observation
      ));
    return {
      status: 'completed',
      resultState: 'verified',
      evidencePayload: {
        kind: 'provider-ready.v1',
        subscriptionId: identity.subscription.id,
        principal: identity.principal,
        registrationMode: configuration.registrationMode,
        resourceTypes: configuration.resourceTypes,
        permissions,
        prerequisites: observations
      },
      liveReadback,
      outputs: {
        values: {
          subscriptionId: identity.subscription.id,
          registrationMode: configuration.registrationMode,
          resourceTypeCount: configuration.resourceTypes.length,
          namespaceCount: observations.filter((entry) => entry.kind === 'provider').length,
          featureCount: observations.filter((entry) => entry.kind === 'feature').length,
          providerRegistrationPermitted: permissions.providerRegistration,
          featureRegistrationPermitted: permissions.featureRegistration
        },
        resources: observations.map((observation) => ({
          provider: 'azure' as const,
          resourceType: observation.kind === 'provider' ? 'provider-registration' : 'subscription-feature',
          resourceId: observation.id
        }))
      },
      completedOperations,
      cleanupWarnings: retained.map((entry) =>
        `Retained Azure registration ${entry}; subscription capabilities are never unregistered by repository rollback.`)
    };
  } catch (error) {
    return {
      status: 'blocked',
      resultState: 'failed',
      blocker: error instanceof AzureDiscoveryError
        ? error.message
        : 'Azure provider readiness failed unexpectedly; provider diagnostics were withheld.',
      completedOperations,
      cleanupWarnings: retained.map((entry) =>
        `Retained Azure registration ${entry}; subscription capabilities are never unregistered by repository rollback.`)
    };
  }
}
