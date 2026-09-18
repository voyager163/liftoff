import { isUtf8 } from 'node:buffer';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { inspectStateBytes } from '../../domain/repair/stateful-invariants.js';
import type { StateBackendMetadata, StateSnapshot } from '../../domain/repair/stateful.js';
import {
  applicationPrivateAssert as must, applicationPrivateFullInventory, type ApplicationPrivateChange, type ApplicationPrivateIntent,
  type ApplicationPrivateSource, type ApplicationPrivateTarget
} from './application-private-contracts.js';
import { generatedResourceComputedAttributes } from './application-generated-resource-contracts.js';
import { applicationPrivateAddress } from './application-private-address.js';
import { applicationPrivateArtifactForTarget } from './application-private-artifacts.js';
import { parseApplicationImageReference } from '../../adapters/azure/application-provisioning.js';

export function applicationPrivateJson(bytes: Uint8Array): Record<string, unknown> {
  must(bytes.byteLength > 0 && bytes.byteLength <= 32 * 1024 * 1024 && isUtf8(bytes), 'private-json-bound');
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { must(false, 'private-json-format'); }
  must(isRecord(value), 'private-json-format');
  return value;
}

function record(value: unknown): Record<string, unknown> {
  must(isRecord(value), 'private-plan-format');
  return value;
}

export function applicationPrivateValue(value: unknown, field: string): unknown {
  let selected = value;
  for (const part of field.split('.')) {
    if (Array.isArray(selected) && /^(?:0|[1-9][0-9]*)$/u.test(part)) selected = selected[Number(part)];
    else if (isRecord(selected) && Object.hasOwn(selected, part)) selected = selected[part];
    else return undefined;
  }
  return selected;
}

export function applicationPrivateResourceId(target: ApplicationPrivateTarget, values: Record<string, unknown>): unknown {
  if (target.type !== 'azurerm_storage_container') return values.id;
  const id = values.resource_manager_id ?? values.id;
  if (typeof values.id === 'string' && values.id.startsWith('https://')) {
    const parts = target.resourceId.split('/');
    must(values.id === `https://${parts[8]}.blob.core.windows.net/${parts[12]}` &&
      typeof values.resource_manager_id === 'string', 'storage-container-state-identity');
  }
  return id;
}

export function applicationPrivateState(
  bytes: Uint8Array, metadata: StateBackendMetadata
): { snapshot: StateSnapshot; resources: Map<string, { values: Record<string, unknown>; raw: unknown; type: string; mode: string }> } {
  const snapshot = inspectStateBytes({ ...metadata, exists: true, size: bytes.byteLength }, bytes).snapshot;
  const root = applicationPrivateJson(bytes);
  must(root.terraform_version === '1.12.6' && Array.isArray(root.resources) && root.resources.length <= 64, 'state-format-or-tool');
  const resources = new Map<string, { values: Record<string, unknown>; raw: unknown; type: string; mode: string }>();
  for (const entry of root.resources) {
    const resource = record(entry);
    must(resource.provider === 'provider["registry.opentofu.org/hashicorp/azurerm"]' &&
      Array.isArray(resource.instances) && resource.instances.length >= 1 && resource.instances.length <= 64 &&
      typeof resource.type === 'string' && typeof resource.name === 'string' &&
      (resource.module === undefined || typeof resource.module === 'string' &&
        /^(?:module\.[A-Za-z_][A-Za-z0-9_-]*)(?:\.module\.[A-Za-z_][A-Za-z0-9_-]*)*$/u.test(resource.module)), 'state-provider-or-instances');
    for (const raw of resource.instances) {
      const instance = record(raw);
      must((instance.index_key === undefined || Number.isSafeInteger(instance.index_key) && Number(instance.index_key) >= 0) &&
        instance.deposed === undefined && instance.status !== 'tainted', 'state-instance');
      const address = `${resource.module ? `${resource.module}.` : ''}${resource.mode === 'data' ? 'data.' : ''}${resource.type}.${resource.name}` +
        (instance.index_key === undefined ? '' : `[${instance.index_key}]`);
      applicationPrivateAddress(address);
      must(!resources.has(address), 'state-duplicate-resource');
      resources.set(address, { values: record(instance.attributes), raw: { ...resource, instances: [instance] },
        type: resource.type, mode: String(resource.mode) });
    }
  }
  return { snapshot, resources };
}

const computed: Readonly<Record<ApplicationPrivateTarget['type'], readonly string[]>> = {
  ...generatedResourceComputedAttributes,
  azurerm_redis_cache: [...generatedResourceComputedAttributes.azurerm_redis_cache, 'primary_access_key', 'secondary_access_key',
    'primary_connection_string', 'secondary_connection_string'],
  azurerm_storage_account: [...generatedResourceComputedAttributes.azurerm_storage_account, 'primary_access_key', 'secondary_access_key',
    'primary_connection_string', 'secondary_connection_string'],
  azurerm_servicebus_namespace: [...generatedResourceComputedAttributes.azurerm_servicebus_namespace,
    'default_primary_connection_string', 'default_secondary_connection_string', 'default_primary_key', 'default_secondary_key'],
  azurerm_communication_service: [...generatedResourceComputedAttributes.azurerm_communication_service,
    'primary_connection_string', 'secondary_connection_string', 'primary_key', 'secondary_key'],
  azurerm_linux_function_app: [...generatedResourceComputedAttributes.azurerm_linux_function_app, 'site_credential'],
  azurerm_resource_group: ['id'],
  azurerm_container_registry: ['id', 'login_server', 'admin_username', 'admin_password'],
  azurerm_user_assigned_identity: ['id', 'principal_id', 'client_id', 'tenant_id'],
  azurerm_role_assignment: ['id'],
  azurerm_container_app_environment: ['id', 'default_domain', 'static_ip_address', 'custom_domain_verification_id'],
  azurerm_container_app: ['id', 'latest_revision_name', 'latest_revision_fqdn', 'custom_domain_verification_id',
    'outbound_ip_addresses', 'ingress.0.fqdn', 'identity.0.principal_id', 'identity.0.tenant_id']
};

function unknownFields(value: unknown, prefix = ''): string[] {
  if (value === true) return [prefix];
  if (value === false || value === null || value === undefined) return [];
  must(Array.isArray(value) || isRecord(value), 'plan-unknown-shape');
  return Object.entries(value).flatMap(([key, child]) => unknownFields(child, prefix ? `${prefix}.${key}` : key));
}

function configurationResources(value: unknown, prefix = ''): Map<string, Record<string, unknown>> {
  const module = record(value);
  const result = new Map<string, Record<string, unknown>>();
  if (module.resources !== undefined) {
    must(Array.isArray(module.resources), 'plan-configuration');
    for (const raw of module.resources) {
      const resource = record(raw);
      must(typeof resource.address === 'string' && resource.provider_config_key === 'azurerm', 'plan-provider-alias');
      const address = `${prefix}${resource.address}`;
      must(!result.has(address), 'plan-configuration-duplicate');
      result.set(address, resource);
    }
  }
  if (module.module_calls !== undefined) {
    for (const [name, raw] of Object.entries(record(module.module_calls))) {
      must(/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(name), 'plan-module');
      const call = record(raw);
      must(typeof call.source === 'string' && /^\.\.?\//u.test(call.source) &&
        call.count_expression === undefined && call.for_each_expression === undefined, 'plan-module');
      for (const [address, resource] of configurationResources(call.module, `${prefix}module.${name}.`)) {
        must(!result.has(address), 'plan-configuration-duplicate');
        result.set(address, resource);
      }
    }
  }
  return result;
}

function assertTarget(target: ApplicationPrivateTarget, values: Record<string, unknown>, allowComputedId = false): void {
  const id = applicationPrivateResourceId(target, values);
  must(allowComputedId && (id === undefined || id === null) ||
    typeof id === 'string' && id.toLowerCase() === target.resourceId.toLowerCase(), 'resource-identity');
  for (const [key, expected] of Object.entries(target.expected)) {
    must(applicationPrivateValue(values, key) === expected, 'planned-resource-input');
  }
  if (target.type === 'azurerm_container_app') {
    const containers = applicationPrivateValue(values, 'template.0.container');
    const identities = applicationPrivateValue(values, 'identity.0.identity_ids');
    must(Array.isArray(containers) && containers.length === 1 && Array.isArray(identities) && identities.length === 1 &&
      typeof identities[0] === 'string' &&
      /\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[^/]+$/u.test(identities[0]), 'application-runtime-inventory');
    const init = applicationPrivateValue(values, 'template.0.init_container');
    const secrets = values.secret;
    must(init === undefined || Array.isArray(init) && init.length === 0, 'unreviewed-container-execution');
    if (secrets !== undefined) {
      must(Array.isArray(secrets) && secrets.length <= 64 && secrets.every((item) => {
        const secret = record(item);
        return typeof secret.name === 'string' && /^[a-z0-9][a-z0-9-]{0,252}$/u.test(secret.name) &&
          (typeof secret.value === 'string' || typeof secret.key_vault_secret_id === 'string');
      }) && new Set(secrets.map((item) => record(item).name)).size === secrets.length, 'private-secret-inventory');
    }
    const container = record(containers[0]);
    for (const field of ['command', 'args']) must(container[field] === undefined ||
      Array.isArray(container[field]) && container[field].length === 0, 'unreviewed-container-execution');
    const traffic = applicationPrivateValue(values, 'ingress.0.traffic_weight');
    must(Array.isArray(traffic) && traffic.length === 1 && record(traffic[0]).percentage === 100 &&
      record(traffic[0]).latest_revision === true, 'unreviewed-traffic-effect');
  }
}

export interface AdmittedApplicationPrivatePlan {
  changes: readonly ApplicationPrivateChange[];
  resources: ReadonlyMap<string, { target: ApplicationPrivateTarget; before: unknown; after: Record<string, unknown>; unknown: unknown; action: ApplicationPrivateChange['action'] }>;
  value: Record<string, unknown>;
}

/** This admits resource changes for application authority, never for a state repair/import. */
export function admitApplicationPrivatePlan(
  shown: Uint8Array, original: Uint8Array, originalMetadata: StateBackendMetadata,
  source: ApplicationPrivateSource, intent: ApplicationPrivateIntent
): AdmittedApplicationPrivatePlan {
  must(canonicalSha256(source.artifactSet ?? null) === canonicalSha256(intent.artifactSet ?? null), 'artifact-set-plan-source');
  if (intent.artifactSet) {
    must(intent.artifact === null, 'artifact-set-stage');
    const apps = source.resources.filter((resource) => resource.type === 'azurerm_container_app');
    const deployments = Object.entries(intent.artifactSet.deployments);
    must(apps.length === deployments.length && deployments.every(([role, deployment]) => apps.filter((resource) =>
      resource.mode === 'managed' && !resource.counted && resource.address === deployment.address &&
      resource.artifactRole === role).length === 1), 'artifact-set-plan-source');
  }
  const value = applicationPrivateJson(shown);
  must(typeof value.format_version === 'string' && /^1\.\d+$/u.test(value.format_version) &&
    value.terraform_version === '1.12.6' && value.errored !== true && value.complete !== false &&
    value.applyable !== false && Array.isArray(value.resource_changes) && value.resource_changes.length <= 64, 'saved-plan-incomplete');
  for (const field of ['resource_drift', 'deferred_changes', 'action_invocations']) {
    must(value[field] === undefined || Array.isArray(value[field]) && value[field].length === 0, 'plan-drift-or-deferred-effects');
  }
  const before = applicationPrivateState(original, originalMetadata);
  const config = record(value.configuration);
  const providers = record(config.provider_config);
  must(Object.keys(providers).join(',') === 'azurerm' && record(providers.azurerm).full_name === intent.source.provider.source,
    'plan-provider');
  const declared = configurationResources(config.root_module);
  must(canonicalSha256([...declared.keys()].sort()) === canonicalSha256(source.resources.map((resource) => resource.address).sort()),
    'plan-source-inventory');
  const targets = new Map(intent.targets.map((target) => [target.address, target]));
  const seen = new Set<string>();
  const changes: ApplicationPrivateChange[] = [];
  const resources = new Map<string, AdmittedApplicationPrivatePlan['resources'] extends ReadonlyMap<string, infer T> ? T : never>();
  for (const raw of value.resource_changes) {
    const resource = record(raw);
    const address = applicationPrivateAddress(resource.address);
    must(!seen.has(address.address) && declared.has(address.declaration) &&
      resource.provider_name === intent.source.provider.source && resource.previous_address === undefined &&
      resource.deposed === undefined && resource.importing === undefined &&
      !String(resource.action_reason ?? '').includes('replace'), 'plan-resource-inventory');
    const declaredSource = source.resources.find((entry) => entry.address === address.declaration);
    must(declaredSource && Boolean(declaredSource.counted) === (address.index !== null), 'plan-instance-inventory');
    seen.add(address.address);
    const change = record(resource.change);
    must(Array.isArray(change.actions) && change.actions.length === 1 &&
      change.importing === undefined && change.generated_config === undefined &&
      (change.replace_paths === undefined || Array.isArray(change.replace_paths) && change.replace_paths.length === 0),
    'deletion-replacement-or-import');
    const action = change.actions[0];
    const prior = before.resources.get(address.address);
    if (resource.mode === 'data') {
      must(resource.type === 'azurerm_client_config' && ['read', 'no-op'].includes(String(action)), 'unapproved-data-source');
      const after = record(change.after);
      must(after.tenant_id === intent.binding.tenantId && after.subscription_id === intent.binding.subscriptionId &&
        after.object_id === intent.binding.principalId && after.client_id === intent.writer.clientId, 'provider-actor-changed');
      continue;
    }
    must(resource.mode === 'managed' && ['create', 'update', 'no-op'].includes(String(action)), 'deletion-replacement-or-import');
    const selected = targets.get(address.address);
    if (!selected) {
      must(action === 'no-op' && prior && canonicalSha256(change.before) === canonicalSha256(prior.values) &&
        canonicalSha256(change.after) === canonicalSha256(prior.values) && unknownFields(change.after_unknown).length === 0,
      'unapproved-resource-effect');
      continue;
    }
    must(resource.type === selected.type && selected.actions.includes(action as ApplicationPrivateChange['action']) &&
      (action === 'create' ? change.before === null && !prior :
        prior && canonicalSha256(change.before) === canonicalSha256(prior.values)), 'resource-ownership-or-drift');
    const after = record(change.after);
    const unknown = unknownFields(change.after_unknown);
    must(unknown.every((field) => computed[selected.type].includes(field)), 'unknown-effect-requires-additional-plan');
    if (selected.type === 'azurerm_role_assignment') {
      must(selected.role && !unknown.some((field) => field !== 'id'), 'additional-rbac-plan-required');
    }
    assertTarget(selected, after, action === 'create' && unknown.includes('id'));
    if (intent.artifactSet && selected.type === 'azurerm_container_app') {
      const artifact = applicationPrivateArtifactForTarget(intent, selected);
      must(artifact, 'artifact-set-plan-source');
      const image = parseApplicationImageReference(artifact.imageRef);
      must(applicationPrivateValue(after, 'template.0.container.0.image') === artifact.imageRef &&
        Array.isArray(after.registry) && after.registry.length === 1 &&
        applicationPrivateValue(after, 'registry.0.server') === image.loginServer &&
        applicationPrivateValue(after, 'registry.0.identity') === selected.expected['identity.0.identity_ids.0'],
      'artifact-set-plan-registry');
    }
    if (action !== 'create') {
      must(prior!.values.id === after.id && applicationPrivateResourceId(selected, prior!.values) ===
        applicationPrivateResourceId(selected, after) && !unknown.includes('id') && !unknown.includes('resource_manager_id'),
      'resource-identity-or-unknown-update');
    }
    const priorValues = change.before === null ? {} : record(change.before);
    const fields = [...new Set([...Object.keys(priorValues), ...Object.keys(after)])].filter((key) =>
      canonicalSha256(priorValues[key] ?? null) !== canonicalSha256(after[key] ?? null));
    must(fields.every((key) => /^[a-z][a-z0-9_]{0,100}$/u.test(key)), 'plan-attribute-name');
    changes.push({
      address: selected.address, type: selected.type, action: action as ApplicationPrivateChange['action'],
      targetResourceId: selected.resourceId, changedAttributes: fields.sort(),
      computedOutputs: [...new Set(unknown.map((field) => field.split('.')[0]!))].sort()
    });
    resources.set(selected.address, {
      target: selected, before: change.before, after, unknown: change.after_unknown,
      action: action as ApplicationPrivateChange['action']
    });
  }
  must(targets.size === changes.length && (!applicationPrivateFullInventory(intent.scope) ||
    [...before.resources.keys()].every((address) => seen.has(address)) &&
      source.resources.every((resource) => resource.counted || seen.has(resource.address))), 'plan-inventory-incomplete');
  return { changes: changes.sort((a, b) => a.address.localeCompare(b.address, 'en')), resources, value };
}

function knownMatches(expected: unknown, actual: unknown, unknown: unknown): boolean {
  if (unknown === true) return actual !== undefined;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length &&
      expected.every((item, index) => knownMatches(item, actual[index], Array.isArray(unknown) ? unknown[index] : undefined));
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    const mask = isRecord(unknown) ? unknown : {};
    return Object.keys(actual).every((key) => Object.hasOwn(expected, key) || mask[key] === true) &&
      [...new Set([...Object.keys(expected), ...Object.keys(mask)])].every((key) => knownMatches(expected[key], actual[key], mask[key]));
  }
  return expected === actual;
}

export function inspectApplicationPrivateCandidate(
  candidate: Uint8Array, original: Uint8Array, metadata: StateBackendMetadata, admitted: AdmittedApplicationPrivatePlan
): { snapshot: StateSnapshot; realized: readonly string[]; complete: boolean; values: ReadonlyMap<string, Record<string, unknown>> } {
  const before = applicationPrivateState(original, metadata);
  const after = applicationPrivateState(candidate, metadata);
  must(after.snapshot.lineage === before.snapshot.lineage && after.snapshot.serial! >= before.snapshot.serial! &&
    (after.snapshot.digest === before.snapshot.digest || after.snapshot.serial! > before.snapshot.serial!), 'candidate-lineage-or-serial');
  for (const [address, resource] of before.resources) {
    if (resource.mode === 'data') continue;
    const current = after.resources.get(address);
    must(current, 'candidate-dropped-owned-resource');
    if (!admitted.resources.has(address)) must(canonicalSha256(current.raw) === canonicalSha256(resource.raw), 'candidate-unapproved-resource');
  }
  const realized: string[] = [];
  for (const [address, resource] of after.resources) {
    if (resource.mode === 'data') {
      must(resource.type === 'azurerm_client_config', 'candidate-data');
      continue;
    }
    const change = admitted.resources.get(address);
    must(change || before.resources.has(address), 'candidate-unapproved-resource');
    if (!change) continue;
    const id = applicationPrivateResourceId(change.target, resource.values);
    must(typeof id === 'string' && id.toLowerCase() === change.target.resourceId.toLowerCase(), 'candidate-resource-identity');
    if (knownMatches(change.after, resource.values, change.unknown)) {
      assertTarget(change.target, resource.values);
      realized.push(address);
    } else {
      must(change.action !== 'create' && canonicalSha256(resource.raw) === canonicalSha256(before.resources.get(address)?.raw),
        'candidate-partially-changed-resource');
    }
  }
  return {
    snapshot: after.snapshot, realized, complete: [...admitted.resources.keys()].every((address) => realized.includes(address)),
    values: new Map([...after.resources].map(([address, resource]) => [address, resource.values]))
  };
}
