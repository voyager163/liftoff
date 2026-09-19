import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import { canonicalSha256, sha256Hex } from '../../domain/governance/activation/canonical-json.js';
import { validateArtifactPathParts } from '../../domain/project/paths.js';
import { resolveProjectPath } from '../../adapters/filesystem/project-paths.js';
import { object, parseHcl, singleBlock } from '../../adapters/hcl/semantic.js';
import { captureHistoryFile } from '../../governance-activation/historical-state.js';
import type { GovernanceTransitionInspection } from '../../governance-activation/transition-ports.js';
import { AzureActivationAdmissionError } from './authority.js';

const resourceNamespaces: Readonly<Record<string, string>> = {
  azurerm_resource_group: 'Microsoft.Resources',
  azurerm_role_assignment: 'Microsoft.Authorization',
  azurerm_container_registry: 'Microsoft.ContainerRegistry',
  azurerm_user_assigned_identity: 'Microsoft.ManagedIdentity',
  azurerm_container_app_environment: 'Microsoft.App',
  azurerm_container_app: 'Microsoft.App',
  azurerm_postgresql_flexible_server: 'Microsoft.DBforPostgreSQL',
  azurerm_postgresql_flexible_server_firewall_rule: 'Microsoft.DBforPostgreSQL',
  azurerm_redis_cache: 'Microsoft.Cache',
  azurerm_storage_account: 'Microsoft.Storage',
  azurerm_storage_container: 'Microsoft.Storage',
  azurerm_storage_management_policy: 'Microsoft.Storage',
  azurerm_servicebus_namespace: 'Microsoft.ServiceBus',
  azurerm_servicebus_queue: 'Microsoft.ServiceBus',
  azurerm_communication_service: 'Microsoft.Communication',
  azurerm_key_vault: 'Microsoft.KeyVault',
  azurerm_service_plan: 'Microsoft.Web',
  azurerm_linux_function_app: 'Microsoft.Web',
  azurerm_virtual_network: 'Microsoft.Network',
  azurerm_subnet: 'Microsoft.Network',
  azurerm_network_security_group: 'Microsoft.Network',
  azurerm_subnet_network_security_group_association: 'Microsoft.Network',
  azurerm_route_table: 'Microsoft.Network',
  azurerm_route: 'Microsoft.Network',
  azurerm_subnet_route_table_association: 'Microsoft.Network',
  azurerm_nat_gateway: 'Microsoft.Network',
  azurerm_public_ip: 'Microsoft.Network',
  azurerm_private_endpoint: 'Microsoft.Network',
  azurerm_private_dns_zone: 'Microsoft.Network',
  azurerm_private_dns_zone_virtual_network_link: 'Microsoft.Network',
  azurerm_log_analytics_workspace: 'Microsoft.OperationalInsights',
  azurerm_application_insights: 'Microsoft.Insights',
  azurerm_cognitive_account: 'Microsoft.CognitiveServices',
  azurerm_search_service: 'Microsoft.Search'
};

export interface ProviderSourceInventory {
  schemaVersion: 1;
  rootPathParts: readonly string[];
  roots: readonly (readonly string[])[];
  sourceDigest: string;
  files: readonly { path: string; digest: string; mode: number }[];
  resources: readonly { path: string; address: string; type: string; namespace: string }[];
  namespaces: readonly string[];
}

export async function inspectProviderSources(
  inspection: Pick<GovernanceTransitionInspection, 'projectRoot' | 'manifest'>, rootPathParts: readonly string[]
): Promise<ProviderSourceInventory> {
  const root = validateArtifactPathParts([...rootPathParts], 'Provider source root');
  if (inspection.manifest.project.workload.kind === 'components' ||
    root.slice(0, 3).join('/') !== 'infrastructure/opentofu/azure' ||
    !inspection.manifest.projectArtifacts.some((artifact) => artifact.category === 'infrastructure' &&
      artifact.pathParts.slice(0, -1).join('/') === root.join('/') && artifact.pathParts.at(-1) === 'main.tf')) {
    throw new AzureActivationAdmissionError('source-root-required', 'Provider inventory requires an explicitly selected manifest-declared Azure OpenTofu root, not inferred workload namespaces.');
  }
  const files: Array<{ path: string; digest: string; mode: number }> = [];
  const resources: Array<{ path: string; address: string; type: string; namespace: string }> = [];
  const unconditionalNamespaces = new Set<string>();
  const conditional: Array<{ path: string; address: string; namespace: string }> = [];
  const directories: Array<{ parts: string[]; names: string[] }> = [];
  const visited = new Set<string>();
  let bytesRead = 0;
  const roots = [root];
  if (root.length === 5 && root[3] === 'environments') {
    const environments = inspection.manifest.project.workload.environments;
    if (!environments.some((environment) => environment === root[4])) {
      throw new AzureActivationAdmissionError('source-environment', 'Provider source root is not a selected project environment.');
    }
    for (const environment of environments) {
      const parts = [...root.slice(0, 4), environment];
      if (!inspection.manifest.projectArtifacts.some((artifact) => artifact.category === 'infrastructure' &&
        artifact.pathParts.join('/') === [...parts, 'main.tf'].join('/'))) {
        throw new AzureActivationAdmissionError('source-environment', 'A selected environment has no complete manifest-declared infrastructure root.');
      }
      if (parts.join('/') !== root.join('/')) roots.push(parts);
    }
  }
  async function visit(parts: string[], ancestry: ReadonlySet<string>): Promise<void> {
    const key = parts.join('/');
    if (ancestry.has(key)) throw new AzureActivationAdmissionError('module-cycle', 'Provider inventory found a cyclic local module graph.');
    if (visited.has(key)) return;
    if (visited.size >= 16) throw new AzureActivationAdmissionError('source-limit', 'Provider inventory exceeds its sixteen-module bound.');
    visited.add(key);
    const directory = await resolveProjectPath(inspection.projectRoot, parts);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > 256) throw new AzureActivationAdmissionError('source-limit', 'Provider source directory exceeds its bounded inventory.');
    const hcl = entries.filter((entry) => entry.name.endsWith('.tf') || entry.name.endsWith('.tf.json'));
    if (hcl.length === 0 || hcl.some((entry) => entry.name.endsWith('.tf.json') || !entry.isFile())) {
      throw new AzureActivationAdmissionError('unsupported-source', 'Provider inventory requires regular HCL .tf sources; absent, linked and JSON configuration sources require a separately supported reader.');
    }
    const childModules: string[][] = [];
    directories.push({ parts, names: entries.filter((entry) => entry.name.endsWith('.tf') || entry.name.endsWith('.tf.json')).map((entry) => entry.name).sort() });
    for (const entry of hcl.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const fileParts = [...parts, entry.name];
      const label = fileParts.join('/');
      const captured = await captureHistoryFile(inspection.projectRoot, fileParts);
      if (!captured.content || captured.mode === undefined || !isUtf8(captured.content) || captured.content.length > 256 * 1024 ||
        (bytesRead += captured.content.length) > 2 * 1024 * 1024 || files.length >= 64) {
        throw new AzureActivationAdmissionError('source-limit', 'Provider source read exceeded its bounded regular UTF-8 inventory.');
      }
      const source = captured.content.toString('utf8');
      files.push({ path: label, digest: sha256Hex(source), mode: captured.mode });
      const document = await parseHcl(source, label);
      if (document.terraform !== undefined) {
        if (!Array.isArray(document.terraform)) throw new AzureActivationAdmissionError('provider-source', 'Terraform provider declarations have an unsupported shape.');
        for (const value of document.terraform) {
          const terraform = object(value, label);
          if (terraform.required_providers === undefined) continue;
          const providers = singleBlock(terraform.required_providers, `${label} required providers`);
          if (providers.azurerm !== undefined) {
            const azure = object(providers.azurerm, `${label} azurerm`);
            if (azure.source !== undefined && !['hashicorp/azurerm', 'registry.terraform.io/hashicorp/azurerm',
              'registry.opentofu.org/hashicorp/azurerm'].includes(String(azure.source))) {
              throw new AzureActivationAdmissionError('provider-source', 'The azurerm local name does not refer to the registered Azure provider source.');
            }
          }
        }
      }
      if (document.resource !== undefined) {
        for (const [type, names] of Object.entries(object(document.resource, label))) {
          const namespace = Object.hasOwn(resourceNamespaces, type) ? resourceNamespaces[type] : undefined;
          if (!namespace) throw new AzureActivationAdmissionError('unsupported-resource-type', 'Provider namespace mapping is not implemented for one of the declared resource types; no namespace was guessed.');
          for (const [name, blocks] of Object.entries(object(names, `${label} resource names`))) {
            if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/u.test(name) || resources.length >= 128 ||
              resources.some((resource) => resource.path.startsWith(`${key}/`) && resource.address === `${type}.${name}`)) {
              throw new AzureActivationAdmissionError('resource-inventory', 'Provider source contains duplicate, invalid or oversized resource declarations.');
            }
            const body = singleBlock(blocks, `${label} resource body`);
            if (body.count === 0 || (Array.isArray(body.for_each) && body.for_each.length === 0)) continue;
            if (body.count !== undefined && (typeof body.count !== 'number' || !Number.isSafeInteger(body.count) || body.count < 1) ||
              body.for_each !== undefined) {
              conditional.push({ path: label, address: `${type}.${name}`, namespace });
            } else {
              unconditionalNamespaces.add(namespace);
            }
            resources.push({ path: label, address: `${type}.${name}`, type, namespace });
          }
        }
      }
      if (document.module !== undefined) {
        for (const blocks of Object.values(object(document.module, `${label} modules`))) {
          const module = singleBlock(blocks, `${label} module`);
          if (module.count === 0 || (Array.isArray(module.for_each) && module.for_each.length === 0)) continue;
          if (module.count !== undefined && (typeof module.count !== 'number' || !Number.isSafeInteger(module.count) || module.count < 1) ||
            module.for_each !== undefined) {
            throw new AzureActivationAdmissionError('conditional-module', 'A conditional module has no exact statically bound instance inventory; provider registration cannot guess whether its namespace is needed.');
          }
          if (typeof module.source !== 'string' || !/^\.\.?\//u.test(module.source) ||
            /[\\%?#$\s]/u.test(module.source)) {
            throw new AzureActivationAdmissionError('unsupported-module', 'Provider inventory supports only explicit local modules; it cannot download or infer remote-module resources.');
          }
          const child = path.posix.normalize(`${key}/${module.source}`).split('/');
          validateArtifactPathParts(child, 'Provider module path');
          if (child.slice(0, 3).join('/') !== 'infrastructure/opentofu/azure') {
            throw new AzureActivationAdmissionError('module-boundary', 'Provider module source escapes the declared Azure infrastructure boundary.');
          }
          childModules.push(child);
        }
      }
    }
    for (const child of childModules) await visit(child, new Set([...ancestry, key]));
  }
  for (const selected of roots) await visit(selected, new Set());
  if (resources.length === 0) throw new AzureActivationAdmissionError('resource-inventory', 'No actual supported resource declarations establish required provider namespaces.');
  const sortedFiles = files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const sortedResources = resources.sort((left, right) => `${left.path}:${left.address}`.localeCompare(`${right.path}:${right.address}`, 'en'));
  for (const entry of conditional) {
    if (!unconditionalNamespaces.has(entry.namespace)) {
      throw new AzureActivationAdmissionError('conditional-resource', `Resource ${entry.address} condition is unresolved and is the only reason to register ${entry.namespace}; a concrete source plan is required.`);
    }
  }
  for (const directory of directories) {
    const current = await readdir(await resolveProjectPath(inspection.projectRoot, directory.parts), { withFileTypes: true });
    const names = current.filter((entry) => entry.name.endsWith('.tf') || entry.name.endsWith('.tf.json')).map((entry) => entry.name).sort();
    if (canonicalSha256(names) !== canonicalSha256(directory.names)) {
      throw new AzureActivationAdmissionError('source-changed', 'Provider source inventory changed while it was being captured.');
    }
  }
  for (const file of sortedFiles) {
    const current = await captureHistoryFile(inspection.projectRoot, file.path.split('/'));
    if (!current.content || current.mode !== file.mode || !isUtf8(current.content) ||
      sha256Hex(current.content.toString('utf8')) !== file.digest) {
      throw new AzureActivationAdmissionError('source-changed', 'Provider source bytes or mode changed while the exact resource inventory was captured.');
    }
  }
  return {
    schemaVersion: 1, rootPathParts: root, roots, files: sortedFiles, resources: sortedResources,
    namespaces: [...new Set(resources.map((entry) => entry.namespace))].sort(),
    sourceDigest: canonicalSha256({ roots, files: sortedFiles, resources: sortedResources })
  };
}
