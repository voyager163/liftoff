import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { validateArtifactPathParts } from '../../domain/project/paths.js';
import type { LiftoffManifest } from '../../domain/project/contracts.js';
import { captureHistoryFile } from '../../governance-activation/historical-state.js';
import { resolveProjectPath } from '../../adapters/filesystem/project-paths.js';
import { directReference, object, parseHcl, singleBlock } from '../../adapters/hcl/semantic.js';
import { readPrivateNativeFile, writePrivateNativeFile } from '../../adapters/state/native-files.js';
import { captureStateExecutable } from '../../adapters/state/native-system.js';
import { stateDigest } from '../../domain/repair/stateful-invariants.js';
import {
  applicationPrivateAssert as must, applicationPrivateResourceTypes,
  type ApplicationPrivateIntent, type ApplicationPrivateSource
} from './application-private-contracts.js';
import { applicationPrivateVersionMatches } from './application-private-version.js';
import { errorCode } from '../../adapters/filesystem/errors.js';
import type { ApplicationArtifactRole } from './application-artifact-inputs.js';
import { applicationPrivateArtifactForTarget, assertApplicationPrivateArtifactSet } from './application-private-artifacts.js';

const identifier = /^[A-Za-z_][A-Za-z0-9_-]*$/u;
const denied = new Set([
  'provisioner', 'connection', 'local-exec', 'remote-exec', 'import', 'moved', 'removed',
  'action', 'action_trigger', 'invoke', 'ephemeral', 'encryption', 'cloud',
  'client_secret', 'client_certificate_path', 'client_certificate_password', 'oidc_token',
  'oidc_request_token', 'oidc_request_url'
]);

const resourceFields: Readonly<Record<string, readonly string[]>> = {
  azurerm_resource_group: ['name', 'location', 'tags'],
  azurerm_container_registry: ['name', 'location', 'resource_group_name', 'sku', 'admin_enabled',
    'public_network_access_enabled', 'zone_redundancy_enabled', 'tags'],
  azurerm_user_assigned_identity: ['name', 'location', 'resource_group_name', 'tags'],
  azurerm_role_assignment: ['name', 'scope', 'principal_id', 'role_definition_id', 'role_definition_name', 'principal_type'],
  azurerm_container_app_environment: ['name', 'location', 'resource_group_name', 'infrastructure_subnet_id',
    'internal_load_balancer_enabled', 'log_analytics_workspace_id', 'zone_redundancy_enabled', 'tags'],
  azurerm_container_app: ['name', 'resource_group_name', 'container_app_environment_id', 'revision_mode',
    'identity', 'registry', 'template', 'ingress', 'secret', 'tags'],
  azurerm_postgresql_flexible_server: ['name', 'location', 'resource_group_name', 'administrator_login',
    'administrator_password', 'sku_name', 'storage_mb', 'version', 'public_network_access_enabled',
    'backup_retention_days', 'geo_redundant_backup_enabled', 'tags'],
  azurerm_postgresql_flexible_server_firewall_rule: ['name', 'server_id', 'start_ip_address', 'end_ip_address', 'count'],
  azurerm_redis_cache: ['name', 'location', 'resource_group_name', 'capacity', 'family', 'sku_name', 'minimum_tls_version',
    'redis_configuration', 'non_ssl_port_enabled', 'public_network_access_enabled', 'tags'],
  azurerm_storage_account: ['name', 'location', 'resource_group_name', 'account_replication_type', 'account_tier',
    'allow_nested_items_to_be_public', 'min_tls_version', 'public_network_access_enabled', 'blob_properties', 'tags'],
  azurerm_storage_container: ['name', 'storage_account_id', 'container_access_type'],
  azurerm_servicebus_namespace: ['name', 'location', 'resource_group_name', 'sku', 'minimum_tls_version', 'tags'],
  azurerm_servicebus_queue: ['name', 'namespace_id'],
  azurerm_communication_service: ['name', 'resource_group_name', 'data_location', 'tags'],
  azurerm_key_vault: ['name', 'location', 'resource_group_name', 'rbac_authorization_enabled', 'sku_name', 'tenant_id',
    'soft_delete_retention_days', 'purge_protection_enabled', 'tags'],
  azurerm_service_plan: ['name', 'location', 'resource_group_name', 'os_type', 'sku_name', 'tags'],
  azurerm_linux_function_app: ['name', 'location', 'resource_group_name', 'service_plan_id', 'storage_account_name',
    'storage_account_access_key', 'identity', 'app_settings', 'site_config', 'https_only', 'tags']
};

function values(value: unknown): void {
  if (typeof value === 'string') {
    must(!/\b(?:file(?:base64)?(?:sha(?:1|256|512)|md5)?|fileexists|templatefile|fileset|pathexpand|abspath|timestamp|plantimestamp|uuid)\s*\(/iu.test(value) &&
      !/\b(?:path\.(?:cwd|root|module)|terraform\.workspace|provider::)\b/u.test(value), 'unapproved-program-or-input');
  } else if (Array.isArray(value)) value.forEach(values);
  else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      must(!denied.has(key), 'unapproved-program-or-input');
      values(child);
    }
  }
}

async function inventory(projectRoot: string, parts: readonly string[]): Promise<string[]> {
  const entries = await readdir(await resolveProjectPath(projectRoot, [...parts]), { withFileTypes: true });
  must(entries.length <= 256 && !entries.some((entry) => entry.isSymbolicLink()), 'source-directory');
  must(!entries.some((entry) => /\.tf\.json$/u.test(entry.name) ||
    /(?:^|_)override\.tf(?:\.json)?$/u.test(entry.name) ||
    /(?:\.auto\.tfvars(?:\.json)?|^terraform\.tfvars(?:\.json)?)$/u.test(entry.name)), 'implicit-source-input');
  const selected = entries.filter((entry) => entry.name.endsWith('.tf') || entry.name === '.terraform.lock.hcl');
  must(selected.length > 0 && selected.length <= 64 && selected.every((entry) => entry.isFile()), 'source-files');
  const names = selected.map((entry) => entry.name).sort();
  must(new Set(names.map((name) => name.toLowerCase())).size === names.length, 'source-path-alias');
  return names;
}

export async function assertApplicationPrivateExecutable(executable: { path: string; sha256: string }): Promise<void> {
  const actual = await captureStateExecutable(executable.path);
  must(actual.path === executable.path && actual.sha256 === executable.sha256, 'executable-changed');
}

export async function inspectApplicationPrivateSource(
  projectRoot: string, manifest: LiftoffManifest, intent: ApplicationPrivateIntent
): Promise<ApplicationPrivateSource> {
  const root = validateArtifactPathParts([...intent.source.rootPathParts], 'Exact private application root');
  const backend = validateArtifactPathParts([...intent.source.backendPathParts], 'Exact private application backend');
  const common = ['infrastructure', 'opentofu', 'azure'];
  must(root.length >= 4 && root.length <= 10 && root.slice(0, 3).join('/') === common.join('/') &&
    backend.slice(0, -1).join('/') === root.join('/') && backend.at(-1)?.endsWith('.tf') &&
    manifest.project.workload.kind !== 'components' &&
    manifest.projectArtifacts.some((artifact) => artifact.category === 'infrastructure' &&
      artifact.pathParts.join('/') === [...root, 'main.tf'].join('/')), 'selected-source-root');
  assertApplicationPrivateArtifactSet(intent, manifest);
  const files: ApplicationPrivateSource['files'][number][] = [];
  const directories: ApplicationPrivateSource['directories'][number][] = [];
  const resources: ApplicationPrivateSource['resources'][number][] = [];
  let totalBytes = 0, backendCount = 0, providerCount = 0, lockCount = 0, rootPins = 0, visits = 0;
  const captured = new Map<string, Buffer>();
  const aliases = new Map<string, string>();
  const roleOverrides = new Map<string, Record<string, Record<string, unknown>>>();
  const p = intent.source.provider;

  async function visit(parts: string[], prefix: string, ancestors: ReadonlySet<string>): Promise<ReadonlySet<ApplicationArtifactRole>> {
    const key = parts.join('/');
    must(!ancestors.has(key) && ++visits <= 32, 'local-module-cycle-or-bound');
    const alias = aliases.get(key.toLowerCase());
    must(alias === undefined || alias === key, 'source-path-alias');
    aliases.set(key.toLowerCase(), key);
    const imageRoles = new Set<ApplicationArtifactRole>();
    const imageVariables = new Map<string, unknown>();
    const names = await inventory(projectRoot, parts);
    if (!directories.some((entry) => entry.pathParts.join('/') === key)) directories.push({ pathParts: parts, entries: names });
    for (const name of names) {
      const fileParts = [...parts, name], filename = fileParts.join('/');
      let bytes = captured.get(filename);
      if (!bytes) {
        const file = await captureHistoryFile(projectRoot, fileParts);
        must(file.content && file.mode !== undefined && isUtf8(file.content) &&
          file.content.length <= 512 * 1024 && (totalBytes += file.content.length) <= 4 * 1024 * 1024, 'source-limit');
        bytes = file.content;
        captured.set(filename, bytes);
        files.push({
          pathParts: fileParts, privatePath: path.posix.relative(common.join('/'), filename),
          digest: stateDigest(bytes), mode: file.mode,
          kind: filename === backend.join('/') ? 'backend' : name === '.terraform.lock.hcl' ? 'lock' : 'hcl'
        });
      }
      let document: Record<string, unknown>;
      try { document = await parseHcl(bytes.toString('utf8'), 'Private application source'); }
      catch { must(false, 'source-hcl'); }
      if (name === '.terraform.lock.hcl') {
        must(prefix === '', 'child-provider-lock');
        const providers = object(document.provider, 'Private application locked provider');
        must(Object.keys(document).join(',') === 'provider' && Object.keys(providers).join(',') === p.source, 'provider-lock');
        const pin = singleBlock(providers[p.source], 'Private application provider pin');
        must(pin.version === p.version && Array.isArray(pin.hashes) && pin.hashes.length > 0 && pin.hashes.length <= 64 &&
          pin.hashes.every((hash) => typeof hash === 'string' && /^(?:h1:[A-Za-z0-9+/]{43}=|zh:[a-f0-9]{64})$/u.test(hash)),
        'provider-lock');
        lockCount++;
        continue;
      }
      if (intent.artifactSet) must(manifest.projectArtifacts.some((artifact) =>
        artifact.category === 'infrastructure' && artifact.pathParts.join('/') === filename), 'artifact-set-unregistered-source');
      if (filename === backend.join('/')) {
        must(prefix === '' && Object.keys(document).join(',') === 'terraform', 'mixed-backend-source');
        const terraform = singleBlock(document.terraform, 'Private application backend declaration');
        must(Object.keys(terraform).join(',') === 'backend', 'mixed-backend-source');
        const kinds = object(terraform.backend, 'Private application backend kind');
        const kind = Object.keys(kinds).join(',');
        must(kind === 'azurerm' || kind === 'local', 'backend-source');
        const actual = singleBlock(kinds[kind], 'Private application source backend');
        const expected = {
          resource_group_name: intent.backend.backend.resourceGroup,
          storage_account_name: intent.backend.backend.account,
          container_name: intent.backend.backend.container, key: intent.backend.backend.key,
          tenant_id: intent.binding.tenantId, subscription_id: intent.binding.subscriptionId, use_azuread_auth: true
        };
        if (kind === 'azurerm') {
          must(Object.entries(actual).every(([key, value]) => Object.hasOwn(expected, key) &&
            value === expected[key as keyof typeof expected]), 'backend-source');
        } else {
          must(Object.keys(actual).join(',') === 'path' && typeof actual.path === 'string', 'backend-source');
          const local = validateArtifactPathParts(actual.path.split('/'), 'Unexecuted source local-backend path');
          try {
            await lstat(await resolveProjectPath(projectRoot, [...root, ...local]));
            must(false, 'local-state-migration-required');
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error;
          }
        }
        backendCount++;
        continue;
      }
      must(Object.keys(document).every((key) =>
        ['terraform', 'provider', 'resource', 'data', 'locals', 'variable', 'output', 'module'].includes(key)), 'source-execution-contract');
      values(document);
      if (intent.artifactSet && document.variable !== undefined) {
        for (const [name, raw] of Object.entries(object(document.variable, 'Private application variables'))) {
          if (!['backend_image', 'frontend_image'].includes(name)) continue;
          must(!imageVariables.has(name), 'artifact-set-variable-declaration');
          imageVariables.set(name, singleBlock(raw, 'Private application image variable').type);
        }
      }
      if (document.terraform !== undefined) {
        must(Array.isArray(document.terraform), 'terraform-source');
        for (const raw of document.terraform) {
          const block = object(raw, 'Private application Terraform declaration');
          must(Object.keys(block).every((key) => ['required_version', 'required_providers'].includes(key)), 'terraform-source');
          if (block.required_version !== undefined) must(applicationPrivateVersionMatches(intent.custody.tools.tofuVersion, block.required_version), 'tool-version-pin');
          if (block.required_providers !== undefined) {
            const providers = singleBlock(block.required_providers, 'Private application required providers');
            must(Object.keys(providers).join(',') === 'azurerm', 'provider-pin');
            const pin = object(providers.azurerm, 'Private application required provider');
            must(Object.keys(pin).sort().join(',') === 'source,version' &&
              ['hashicorp/azurerm', p.source].includes(String(pin.source)) &&
              applicationPrivateVersionMatches(p.version, pin.version), 'provider-pin');
            if (prefix === '') rootPins++;
          }
        }
      }
      if (document.provider !== undefined) {
        const providers = object(document.provider, 'Private application provider');
        must(prefix === '' && Object.keys(providers).join(',') === 'azurerm', 'provider-alias');
        const provider = singleBlock(providers.azurerm, 'Private application provider configuration');
        must(Object.keys(provider).every((key) => ['features', 'resource_provider_registrations'].includes(key)) &&
          (provider.resource_provider_registrations === undefined || provider.resource_provider_registrations === 'none'),
        'provider-identity-or-registration');
        const features = singleBlock(provider.features, 'Private application provider features');
        must(Object.keys(features).length === 0, 'provider-side-effects');
        providerCount++;
      }
      for (const mode of ['resource', 'data'] as const) {
        if (document[mode] === undefined) continue;
        for (const [type, declarations] of Object.entries(object(document[mode], 'Private application resources'))) {
          must(mode === 'data' ? type === 'azurerm_client_config' : Object.hasOwn(applicationPrivateResourceTypes, type),
            'unapproved-resource-type');
          for (const [resourceName, raw] of Object.entries(object(declarations, 'Private application resource names'))) {
            must(identifier.test(resourceName), 'resource-name');
            const resource = singleBlock(raw, 'Private application resource');
            must(resource.for_each === undefined && resource.provider === undefined &&
              resource.provisioner === undefined && resource.lifecycle === undefined, 'dynamic-or-lifecycle-effect');
            must(resource.count === undefined || mode === 'resource' &&
              (typeof resource.count === 'string' || Number.isSafeInteger(resource.count) && Number(resource.count) >= 0), 'resource-count');
            const address = `${prefix}${mode === 'data' ? 'data.' : ''}${type}.${resourceName}`;
            let artifactRole: ApplicationArtifactRole | undefined;
            if (mode === 'resource') {
              must(Object.keys(resource).every((key) => resourceFields[type]!.includes(key) || key === 'depends_on'), 'unsupported-resource-input');
              const selected = intent.targets.find((target) => target.address === address);
              if (intent.artifactSet && type === 'azurerm_container_app') {
                must(selected && resource.count === undefined, 'artifact-set-source-inventory');
                const artifact = applicationPrivateArtifactForTarget(intent, selected);
                must(artifact && 'role' in artifact, 'artifact-set-source-inventory');
                const template = singleBlock(resource.template, 'Private application template');
                const container = singleBlock(template.container, 'Private application role container');
                const reference = await directReference(container.image);
                must(reference?.length === 2 && reference[0] === 'var' && reference[1] === `${artifact.role}_image`,
                  'artifact-set-image-expression');
                artifactRole = artifact.role;
                imageRoles.add(artifactRole);
              }
              if (type === 'azurerm_role_assignment' && selected?.role) {
                const override: Record<string, unknown> = {};
                if (resource.name === undefined) override.name = selected.expected.name;
                if (resource.role_definition_id === undefined && resource.role_definition_name !== undefined) {
                  must(typeof resource.role_definition_name === 'string' &&
                    resource.role_definition_name === selected.role.roleDefinitionName, 'exact-role-name-resolution');
                  override.role_definition_id = selected.role.roleDefinitionId;
                  override.role_definition_name = null;
                }
                if (Object.keys(override).length) {
                  const output = `${path.posix.relative(common.join('/'), key)}/liftoff-application_override.tf.json`;
                  const prior = roleOverrides.get(output) ?? {};
                  prior[resourceName] = override;
                  roleOverrides.set(output, prior);
                }
              }
              if (selected) for (const key of Object.keys(resource)) {
                if (!['tags', 'depends_on', 'identity', 'registry', 'template', 'ingress', 'count', 'role_definition_name',
                  'administrator_password', 'storage_account_access_key', 'app_settings', 'site_config', 'secret', 'blob_properties', 'redis_configuration'].includes(key)) {
                  must(Object.hasOwn(selected.expected, key), 'unreviewed-resource-input');
                }
              }
            }
            resources.push({ address, mode: mode === 'data' ? 'data' : 'managed', type,
              ...(resource.count !== undefined ? { counted: true } : {}),
              ...(artifactRole ? { artifactRole } : {}) });
          }
        }
      }
      if (document.module !== undefined) {
        for (const [moduleName, raw] of Object.entries(object(document.module, 'Private application local modules'))) {
          const module = singleBlock(raw, 'Private application local module');
          must(identifier.test(moduleName) && typeof module.source === 'string' && /^\.\.?\//u.test(module.source) &&
            !/[\\%?#$\s]/u.test(module.source) && module.count === undefined && module.for_each === undefined &&
            module.providers === undefined && module.version === undefined, 'remote-or-dynamic-module');
          const child = validateArtifactPathParts(path.posix.normalize(`${key}/${module.source}`).split('/'), 'Private local module');
          must(child.slice(0, 3).join('/') === common.join('/') && child.length >= 4, 'local-module-escape');
          const childRoles = await visit(child, `${prefix}module.${moduleName}.`, new Set([...ancestors, key]));
          for (const role of childRoles) {
            const reference = await directReference(module[`${role}_image`]);
            must(reference?.length === 2 && reference[0] === 'var' && reference[1] === `${role}_image`,
              'artifact-set-module-image-expression');
            imageRoles.add(role);
          }
        }
      }
    }
    for (const role of imageRoles) {
      const type = await directReference(imageVariables.get(`${role}_image`));
      must(type?.length === 1 && type[0] === 'string', 'artifact-set-variable-declaration');
    }
    return imageRoles;
  }
  try {
    await visit(root, '', new Set());
    must(backendCount === 1 && providerCount === 1 && lockCount === 1 && rootPins === 1 && resources.length > 0 &&
      resources.length <= 64 && new Set(resources.map((resource) => resource.address)).size === resources.length, 'source-inventory');
    if (intent.artifactSet) {
      for (const role of ['backend', 'frontend'] as const) {
        const deployment = intent.artifactSet.deployments[role];
        if (deployment) must(resources.filter((resource) =>
          resource.address === deployment.address && resource.artifactRole === role).length === 1, 'artifact-set-source-inventory');
      }
    }
    const projections = [...roleOverrides].map(([privatePath, roles]) => {
      const content = JSON.stringify({ resource: { azurerm_role_assignment: roles } });
      return { privatePath, content, digest: stateDigest(content) };
    }).sort((a, b) => a.privatePath.localeCompare(b.privatePath, 'en'));
    const body = {
      schemaVersion: 1 as const, rootPathParts: root, backendPathParts: backend,
      files: files.sort((a, b) => a.privatePath.localeCompare(b.privatePath, 'en')),
      directories: directories.sort((a, b) => a.pathParts.join('/').localeCompare(b.pathParts.join('/'), 'en')),
      resources: resources.sort((a, b) => a.address.localeCompare(b.address, 'en')),
      ...(intent.artifactSet ? { artifactSet: structuredClone(intent.artifactSet) } : {}),
      ...(projections.length ? { projections } : {})
    };
    return { ...body, digest: canonicalSha256(body) };
  } finally { for (const bytes of captured.values()) bytes.fill(0); }
}

export async function verifyApplicationPrivateSource(projectRoot: string, source: ApplicationPrivateSource): Promise<void> {
  const { digest, ...body } = source;
  must(canonicalSha256(body) === digest, 'source-record-integrity');
  for (const directory of source.directories) {
    must(canonicalSha256(await inventory(projectRoot, directory.pathParts)) === canonicalSha256(directory.entries), 'source-inventory-changed');
  }
  for (const file of source.files) {
    const actual = await captureHistoryFile(projectRoot, file.pathParts);
    try { must(actual.content && actual.mode === file.mode && stateDigest(actual.content) === file.digest, 'source-changed'); }
    finally { actual.content?.fill(0); }
  }
  for (const projection of source.projections ?? []) {
    must(stateDigest(projection.content) === projection.digest &&
      projection.privatePath.endsWith('/liftoff-application_override.tf.json'), 'private-projection-contract');
    validateArtifactPathParts(projection.privatePath.split('/'), 'Exact private application projection');
  }
}

export function applicationPrivateNativeRoot(directory: string, source: ApplicationPrivateSource): string {
  return path.join(directory, ...source.rootPathParts.slice(3));
}

export async function materializeApplicationPrivateSource(
  projectRoot: string, source: ApplicationPrivateSource, directory: string
): Promise<string> {
  await verifyApplicationPrivateSource(projectRoot, source);
  for (const file of source.files) {
    if (file.kind === 'backend') continue;
    const actual = await captureHistoryFile(projectRoot, file.pathParts);
    try {
      must(actual.content && actual.mode === file.mode && stateDigest(actual.content) === file.digest, 'source-changed');
      const destination = path.join(directory, ...file.privatePath.split('/'));
      must(path.relative(directory, destination) !== '' && !path.relative(directory, destination).startsWith('..'), 'private-source-path');
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writePrivateNativeFile(destination, actual.content, true);
    } finally { actual.content?.fill(0); }
  }
  for (const projection of source.projections ?? []) {
    const destination = path.join(directory, ...projection.privatePath.split('/'));
    await writePrivateNativeFile(destination, projection.content, true);
  }
  return applicationPrivateNativeRoot(directory, source);
}

export async function verifyApplicationPrivateProjection(source: ApplicationPrivateSource, directory: string): Promise<void> {
  for (const file of source.files) {
    if (file.kind === 'backend') continue;
    const destination = path.join(directory, ...file.privatePath.split('/'));
    must(await realpath(destination) === destination, 'private-source-path');
    const bytes = await readPrivateNativeFile(destination, 512 * 1024);
    try { must(stateDigest(bytes) === file.digest, 'private-source-changed'); }
    finally { bytes.fill(0); }
  }
  for (const declaration of source.directories) {
    const directoryPath = path.join(directory, ...declaration.pathParts.slice(3));
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const names = entries.filter((entry) => entry.name.endsWith('.tf') || entry.name.endsWith('.tf.json') ||
      entry.name === '.terraform.lock.hcl').map((entry) => entry.name).sort();
    const expected = [...declaration.entries.filter((name) =>
      [...declaration.pathParts, name].join('/') !== source.backendPathParts.join('/'))];
    const relative = declaration.pathParts.slice(3).join('/');
    expected.push(...(source.projections ?? []).filter((projection) => path.posix.dirname(projection.privatePath) === relative)
      .map((projection) => path.posix.basename(projection.privatePath)));
    if (declaration.pathParts.join('/') === source.rootPathParts.join('/')) expected.push('liftoff-application-backend.tf.json');
    must(canonicalSha256(names) === canonicalSha256(expected.sort()) &&
      !entries.some((entry) => entry.isSymbolicLink()) &&
      !entries.some((entry) => /(?:\.auto\.tfvars(?:\.json)?|^terraform\.tfvars(?:\.json)?)$/u.test(entry.name)), 'private-source-inventory');
  }
  for (const projection of source.projections ?? []) {
    const destination = path.join(directory, ...projection.privatePath.split('/'));
    must(await realpath(destination) === destination, 'private-source-path');
    const bytes = await readPrivateNativeFile(destination, 64 * 1024);
    try { must(stateDigest(bytes) === projection.digest, 'private-source-changed'); }
    finally { bytes.fill(0); }
  }
}
