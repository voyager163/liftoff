import path from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import type {
  InspectedState, PrivateStateCommandRunner, ProtectedStateWorkspace, StateArtifactDescriptor,
  StateConfigurationAttestation, StateConfigurationProvider, StateExecutionContext
} from '../../domain/repair/stateful.js';
import {
  assertNoResourceChanges, inspectStateBytes, stateAssert, stateDigest, stateObjectDigest
} from '../../domain/repair/stateful-invariants.js';
import { captureHistoryFile } from '../../governance-activation/historical-state.js';
import { resolveProjectPath } from '../filesystem/project-paths.js';
import { validateArtifactPathParts } from '../../domain/project/paths.js';
import { object, parseHcl, singleBlock } from '../hcl/semantic.js';
import { protectedStateScope } from '../state/protected-workspace.js';
import { readPrivateNativeFile, writePrivateNativeFile } from '../state/native-files.js';
import { verifyStateExecutable } from '../state/native-system.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';

export interface BootstrapImportMapping {
  address: string;
  importId: string;
  managedResourceIds: readonly string[];
}

export interface PrivateImportConfigurationInput {
  rootPathParts: readonly string[];
  provider: {
    source: 'registry.opentofu.org/hashicorp/azurerm';
    version: string;
    mirrorDirectory: string;
    binary: { path: string; sha256: string };
  };
}

export interface PrivateImportConfiguration extends PrivateImportConfigurationInput {
  schemaVersion: 1;
  files: readonly { pathParts: readonly string[]; digest: string; mode: number }[];
  resourceAddresses: readonly string[];
  sourceDigest: string;
}

export const bootstrapImportArmTypes: Readonly<Record<string, readonly string[]>> = {
  azurerm_network_security_group: ['Microsoft.Network/networkSecurityGroups'],
  azurerm_route_table: ['Microsoft.Network/routeTables'],
  azurerm_public_ip: ['Microsoft.Network/publicIPAddresses'],
  azurerm_nat_gateway: ['Microsoft.Network/natGateways'],
  azurerm_nat_gateway_public_ip_association: ['Microsoft.Network/natGateways', 'Microsoft.Network/publicIPAddresses'],
  azurerm_virtual_network: ['Microsoft.Network/virtualNetworks'],
  azurerm_subnet: ['Microsoft.Network/virtualNetworks/subnets'],
  azurerm_subnet_network_security_group_association: ['Microsoft.Network/virtualNetworks/subnets'],
  azurerm_subnet_route_table_association: ['Microsoft.Network/virtualNetworks/subnets'],
  azurerm_subnet_nat_gateway_association: ['Microsoft.Network/virtualNetworks/subnets'],
  azurerm_private_dns_zone: ['Microsoft.Network/privateDnsZones'],
  azurerm_private_dns_zone_virtual_network_link: ['Microsoft.Network/privateDnsZones/virtualNetworkLinks'],
  azurerm_private_endpoint: ['Microsoft.Network/privateEndpoints', 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups']
};
const networkTypes = new Set(Object.keys(bootstrapImportArmTypes));

function rejectPrograms(value: unknown): void {
  if (typeof value === 'string') {
    stateAssert(!/\b(?:file|filebase64|templatefile|fileset|pathexpand|abspath)\s*\(/iu.test(value) &&
      !/\b(?:path\.(?:cwd|root)|terraform\.workspace)\b/u.test(value), 'unsafe-planning-contract');
  } else if (Array.isArray(value)) value.forEach(rejectPrograms);
  else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      stateAssert(!['provisioner', 'connection', 'local-exec', 'remote-exec', 'client_secret',
        'client_certificate_path', 'client_certificate_password', 'oidc_token', 'oidc_request_token',
        'oidc_request_url', 'environment'].includes(key) &&
        !/(?:password|credential|private_key|secret|access_token|sas_token)/iu.test(key), 'unsafe-planning-contract');
      rejectPrograms(child);
    }
  }
}

export async function inspectPrivateImportConfiguration(
  projectRoot: string, input: PrivateImportConfigurationInput
): Promise<PrivateImportConfiguration> {
  stateAssert(isRecord(input) && Object.keys(input).sort().join(',') === 'provider,rootPathParts', 'invalid-binding');
  const root = validateArtifactPathParts([...input.rootPathParts], 'Exact bootstrap import root');
  stateAssert(root.length >= 4 && root.slice(0, 3).join('/') === 'infrastructure/opentofu/azure', 'unsafe-path');
  stateAssert(isRecord(input.provider) && Object.keys(input.provider).sort().join(',') === 'binary,mirrorDirectory,source,version' &&
    isRecord(input.provider.binary) && Object.keys(input.provider.binary).sort().join(',') === 'path,sha256' &&
    input.provider.source === 'registry.opentofu.org/hashicorp/azurerm' &&
    /^\d+\.\d+\.\d+$/u.test(input.provider.version) && path.isAbsolute(input.provider.mirrorDirectory) &&
    path.isAbsolute(input.provider.binary.path) &&
    /^[a-f0-9]{64}$/u.test(input.provider.binary.sha256) &&
    !/[\u0000-\u001f]/u.test(input.provider.mirrorDirectory) &&
    !path.relative(input.provider.mirrorDirectory, input.provider.binary.path).startsWith('..') &&
    path.relative(input.provider.mirrorDirectory, input.provider.binary.path) !== '', 'tool-unavailable');
  const directory = await resolveProjectPath(projectRoot, root);
  const entries = await readdir(directory, { withFileTypes: true });
  stateAssert(entries.length <= 128 && !entries.some((entry) => entry.isSymbolicLink()), 'unsafe-path');
  const selected = entries.filter((entry) => entry.name.endsWith('.tf') || entry.name === '.terraform.lock.hcl');
  stateAssert(!entries.some((entry) => entry.name.endsWith('.tf.json') || /(?:\.tfvars(?:\.json)?|(?:^|_)override\.tf)$/u.test(entry.name)) &&
    selected.length > 1 && selected.length <= 32 && selected.every((entry) => entry.isFile()) &&
    selected.some((entry) => entry.name === '.terraform.lock.hcl'), 'unsafe-planning-contract');
  const files: PrivateImportConfiguration['files'][number][] = [];
  const addresses: string[] = [];
  let providerCount = 0, providerDeclarationCount = 0, bytesRead = 0;
  for (const file of selected.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const parts = [...root, file.name];
    const captured = await captureHistoryFile(projectRoot, parts);
    stateAssert(captured.content && captured.mode !== undefined && captured.content.length <= 256 * 1024 &&
      (bytesRead += captured.content.length) <= 1024 * 1024 && isUtf8(captured.content), 'storage-limit');
    files.push({ pathParts: parts, digest: stateDigest(captured.content), mode: captured.mode });
    if (file.name === '.terraform.lock.hcl') continue;
    const document = await parseHcl(captured.content.toString('utf8'), 'Private bootstrap import configuration');
    stateAssert(Object.keys(document).every((key) => ['terraform', 'provider', 'resource', 'locals', 'variable', 'output'].includes(key)), 'unsafe-planning-contract');
    rejectPrograms(document);
    if (document.terraform !== undefined) {
      for (const terraform of document.terraform as unknown[]) {
        const block = object(terraform, 'Terraform configuration');
        stateAssert(Object.keys(block).every((key) => ['required_version', 'required_providers'].includes(key)), 'unsafe-planning-contract');
        if (block.required_providers !== undefined) {
          const providers = singleBlock(block.required_providers, 'Required providers');
          stateAssert(Object.keys(providers).join(',') === 'azurerm', 'unsafe-planning-contract');
          const provider = object(providers.azurerm, 'Azure provider');
          stateAssert(['hashicorp/azurerm', input.provider.source].includes(String(provider.source)) &&
            [input.provider.version, `= ${input.provider.version}`, `=${input.provider.version}`].includes(String(provider.version)), 'tool-unavailable');
          providerDeclarationCount++;
        }
      }
    }
    if (document.provider !== undefined) {
      const providers = object(document.provider, 'Provider');
      stateAssert(Object.keys(providers).join(',') === 'azurerm', 'unsafe-planning-contract');
      const provider = singleBlock(providers.azurerm, 'Azure provider');
      stateAssert(Object.keys(provider).every((key) => ['features', 'resource_provider_registrations'].includes(key)) &&
        provider.resource_provider_registrations === 'none', 'unsafe-planning-contract');
      providerCount++;
    }
    if (document.resource !== undefined) {
      for (const [type, names] of Object.entries(object(document.resource, 'Resources'))) {
        stateAssert(networkTypes.has(type), 'resource-change');
        for (const [name, entries] of Object.entries(object(names, 'Network resources'))) {
          const resource = singleBlock(entries, 'Network resource');
          stateAssert(/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(name) && resource.count === undefined &&
            resource.for_each === undefined && resource.provider === undefined, 'mapping-conflict');
          addresses.push(`${type}.${name}`);
        }
      }
    }
    if (document.variable !== undefined) {
      for (const variable of Object.values(object(document.variable, 'Variables'))) {
        const definition = singleBlock(variable, 'Variable');
        stateAssert(definition.default !== undefined && definition.sensitive !== true && definition.ephemeral !== true, 'unsafe-planning-contract');
      }
    }
  }
  stateAssert(providerCount === 1 && providerDeclarationCount === 1 && addresses.length > 0 && addresses.length <= 64 &&
    new Set(addresses).size === addresses.length, 'unsafe-planning-contract');
  const body = { schemaVersion: 1 as const, ...structuredClone(input), files, resourceAddresses: addresses.sort() };
  return { ...body, sourceDigest: canonicalSha256(body) };
}

export class FilesystemPrivateImportConfiguration implements StateConfigurationProvider {
  constructor(private readonly projectRoot: string, readonly configuration: PrivateImportConfiguration) {}

  async materialize(reference: string, directory: string, context: StateExecutionContext): Promise<StateConfigurationAttestation> {
    stateAssert(reference === this.configuration.sourceDigest && context.projectRoot === this.projectRoot, 'configuration-changed');
    await this.verifySource();
    await verifyStateExecutable(this.configuration.provider.binary);
    for (const file of this.configuration.files) {
      const captured = await captureHistoryFile(this.projectRoot, file.pathParts);
      stateAssert(captured.content && stateDigest(captured.content) === file.digest && captured.mode === file.mode, 'configuration-changed');
      await writePrivateNativeFile(path.join(directory, file.pathParts.at(-1)!), captured.content);
    }
    return {
      configurationRef: reference, configurationDigest: this.configuration.sourceDigest, artifactDigest: context.artifactDigest,
      backendNeutral: true, stateFormat: 'opentofu-v4-json', providerRegistration: 'disabled',
      provisioners: [], externalPrograms: [], uninspectedDataSources: [], unresolvedModules: [],
      providers: [{ source: this.configuration.provider.source, version: this.configuration.provider.version, binaryDigest: this.configuration.provider.binary.sha256 }],
      providerMirrorDirectory: this.configuration.provider.mirrorDirectory, moduleDigests: []
    };
  }

  private async verifySource(): Promise<void> {
    const fresh = await inspectPrivateImportConfiguration(this.projectRoot, {
      rootPathParts: this.configuration.rootPathParts, provider: this.configuration.provider
    });
    stateAssert(canonicalSha256(fresh) === canonicalSha256(this.configuration), 'configuration-changed');
  }

  async verifyMaterialized(reference: string, directory: string, expected: StateConfigurationAttestation): Promise<void> {
    stateAssert(reference === this.configuration.sourceDigest && expected.configurationDigest === reference &&
      expected.providerMirrorDirectory === this.configuration.provider.mirrorDirectory, 'configuration-changed');
    await this.verifySource();
    await verifyStateExecutable(this.configuration.provider.binary);
    for (const file of this.configuration.files) {
      const bytes = await readPrivateNativeFile(path.join(directory, file.pathParts.at(-1)!), 256 * 1024);
      try { stateAssert(stateDigest(bytes) === file.digest, 'configuration-changed'); }
      finally { bytes.fill(0); }
    }
  }
}

export interface PrivateImportNoChangeProof {
  kind: 'bootstrap-import-no-change/1';
  configurationDigest: string;
  mappingsDigest: string;
  executableDigest: string;
  exitCode: 0;
  resourceCount: number;
  verifiedAt: number;
}

export class PrivateBootstrapImportDriver {
  constructor(private readonly options: {
    workspace: ProtectedStateWorkspace;
    runner: PrivateStateCommandRunner;
    configurations: StateConfigurationProvider;
    configuration: PrivateImportConfiguration;
    mappings: readonly BootstrapImportMapping[];
    context: StateExecutionContext;
    authorize: () => Promise<void>;
    now?: () => number;
  }) {}

  toJSON() { return { driver: 'bootstrap-declarative-import', recipe: 'bootstrap-declarative-import/1' }; }

  async quiesce(): Promise<void> {
    stateAssert(this.options.runner.quiesce, 'process-tree-termination-unproven');
    await this.options.runner.quiesce();
  }

  private async run(directory: string, args: string[], transform = false, allowed: readonly number[] = [0]) {
    await this.options.authorize();
    const result = await this.options.runner.run({ cwd: directory, args, operation: transform ? 'transform' : 'inspect' });
    if (!allowed.includes(result.exitCode)) { result.stdout.fill(0); stateAssert(false, 'native-command-failed'); }
    return result;
  }

  private async quiet(directory: string, args: string[], transform = false) {
    const result = await this.run(directory, args, transform);
    result.stdout.fill(0);
  }

  private importedOnly(plan: unknown): void {
    stateAssert(isRecord(plan) && plan.errored !== true && plan.complete !== false &&
      (plan.action_invocations === undefined || Array.isArray(plan.action_invocations) && plan.action_invocations.length === 0) &&
      (plan.deferred_changes === undefined || Array.isArray(plan.deferred_changes) && plan.deferred_changes.length === 0) &&
      Array.isArray(plan.resource_changes), 'verification-incomplete');
    const imports = new Set<string>();
    for (const value of plan.resource_changes) {
      stateAssert(isRecord(value) && typeof value.address === 'string' && value.mode === 'managed' && isRecord(value.change) &&
        canonicalSha256(value.change.actions) === canonicalSha256(['no-op']) &&
        (value.action_reason === undefined || !String(value.action_reason).includes('replace')), 'resource-change');
      if (value.change.importing !== undefined) {
        const mapping = this.options.mappings.find((entry) => entry.address === value.address);
        stateAssert(mapping && isRecord(value.change.importing) && value.change.importing.id === mapping.importId &&
          !imports.has(mapping.address), 'mapping-conflict');
        imports.add(mapping.address);
      }
    }
  }

  private async plan(directory: string, filename: string, importing: boolean, attestation: StateConfigurationAttestation): Promise<void> {
    const saved = path.join(directory, filename);
    const result = await this.run(directory, ['plan', '-input=false', '-no-color', '-refresh=true',
      '-lock=true', '-lock-timeout=10s', '-detailed-exitcode', `-out=${saved}`], false, [0, 2]);
    result.stdout.fill(0);
    const shown = await this.run(directory, ['show', '-json', saved]);
    let value: unknown;
    try { value = JSON.parse(Buffer.from(shown.stdout).toString('utf8')); }
    finally { shown.stdout.fill(0); }
    stateAssert(isRecord(value) && typeof value.format_version === 'string' && /^1\.\d+$/u.test(value.format_version) &&
      value.terraform_version === '1.12.6', 'verification-incomplete');
    if (importing) this.importedOnly(value);
    else { stateAssert(result.exitCode === 0, 'verification-incomplete'); assertNoResourceChanges(value, true); }
    if (importing && result.exitCode === 2) {
      const planned = await readPrivateNativeFile(saved, 64 * 1024 * 1024);
      try {
        const digest = stateDigest(planned);
        await this.options.configurations.verifyMaterialized(this.options.configuration.sourceDigest, directory, attestation);
        const current = await readPrivateNativeFile(saved, 64 * 1024 * 1024);
        try { stateAssert(stateDigest(current) === digest, 'artifact-integrity'); } finally { current.fill(0); }
        await this.quiet(directory, ['apply', '-input=false', '-no-color', saved], true);
      } finally { planned.fill(0); }
    }
  }

  private inspect(bytes: Uint8Array): InspectedState {
    const state = inspectStateBytes({
      backendId: 'private-bootstrap-candidate', bindingDigest: stateObjectDigest({ kind: 'private-bootstrap-candidate' }),
      exists: true, version: 'protected-candidate', etag: null, size: bytes.byteLength, observedAt: this.options.now?.() ?? Date.now()
    }, bytes);
    for (const mapping of this.options.mappings) {
      stateAssert(state.instances.some((instance) => instance.address === mapping.address &&
        instance.identityDigest === stateDigest(mapping.importId)), 'resource-identity-changed');
    }
    return { ...state, stateRef: null };
  }

  async prepare(original: Uint8Array | null, retention: {
    id: string; beforeCreate(descriptor: StateArtifactDescriptor): Promise<void>;
  }): Promise<{ candidate: StateArtifactDescriptor; proof: PrivateImportNoChangeProof }> {
    stateAssert(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(retention.id), 'invalid-binding');
    const result = await this.perform(original, retention);
    stateAssert(result.candidate, 'artifact-integrity');
    return { candidate: result.candidate, proof: result.proof };
  }

  async verify(current: Uint8Array): Promise<{ proof: PrivateImportNoChangeProof }> {
    const { proof } = await this.perform(current);
    return { proof };
  }

  private async perform(original: Uint8Array | null, retention?: {
    id: string; beforeCreate(descriptor: StateArtifactDescriptor): Promise<void>;
  }) {
    const { context, workspace, configuration, configurations } = this.options;
    const importing = retention !== undefined;
    await workspace.assertAvailable(context);
    return workspace.withScratch(context, async (directory) => {
      try {
        const root = path.join(directory, 'import');
        await mkdir(root, { mode: 0o700 });
        const statePath = path.join(directory, 'private.tfstate');
        if (original) await writePrivateNativeFile(statePath, original, true);
        const attestation = await configurations.materialize(configuration.sourceDigest, root, context);
        stateAssert(attestation.backendNeutral && attestation.providerRegistration === 'disabled' &&
          attestation.configurationDigest === configuration.sourceDigest && attestation.artifactDigest === context.artifactDigest &&
          attestation.provisioners.length === 0 && attestation.externalPrograms.length === 0 &&
          attestation.uninspectedDataSources.length === 0 && attestation.unresolvedModules.length === 0 &&
          attestation.providers.length === 1 && attestation.providers[0]!.source === configuration.provider.source &&
          attestation.providers[0]!.version === configuration.provider.version &&
          attestation.providers[0]!.binaryDigest === configuration.provider.binary.sha256, 'unsafe-planning-contract');
        await writePrivateNativeFile(path.join(root, 'liftoff-state-backend.tf.json'), JSON.stringify({ terraform: { backend: { local: { path: statePath } } } }));
        await writePrivateNativeFile(path.join(root, 'liftoff.private.tfrc'),
          `disable_checkpoint = true\nprovider_installation {\n filesystem_mirror {\n path = ${JSON.stringify(attestation.providerMirrorDirectory)}\n include = ["registry.opentofu.org/hashicorp/azurerm"]\n }\n}\n`);
        if (importing) await writePrivateNativeFile(path.join(root, 'liftoff-import.tf.json'), JSON.stringify({
          import: this.options.mappings.map((mapping) => ({ to: `\${${mapping.address}}`, id: mapping.importId }))
        }));
        await this.quiet(root, ['init', '-input=false', '-no-color', '-get=false', '-lockfile=readonly']);
        await configurations.verifyMaterialized(configuration.sourceDigest, root, attestation);
        if (importing) await this.plan(root, 'import.tfplan', true, attestation);
        await configurations.verifyMaterialized(configuration.sourceDigest, root, attestation);
        await this.plan(root, 'no-change.tfplan', false, attestation);
        const bytes = await readPrivateNativeFile(statePath, 32 * 1024 * 1024);
        try {
          const candidate = this.inspect(bytes);
          if (original) {
            const before = inspectStateBytes({ ...candidate.snapshot, size: original.byteLength }, original);
            stateAssert(candidate.snapshot.lineage === before.snapshot.lineage && candidate.snapshot.serial! >= before.snapshot.serial! &&
              before.instances.every((old) => candidate.instances.some((current) => current.address === old.address &&
                current.provider === old.provider && current.identityDigest === old.identityDigest)), 'resource-identity-changed');
            stateAssert(candidate.instances.every((instance) => before.instances.some((old) => old.address === instance.address) ||
              this.options.mappings.some((mapping) => mapping.address === instance.address)), 'mapping-conflict');
          } else stateAssert(candidate.instances.length === this.options.mappings.length, 'mapping-incomplete');
          await configurations.verifyMaterialized(configuration.sourceDigest, root, attestation);
          let retained: StateArtifactDescriptor | null = null;
          if (retention) {
            const descriptor: StateArtifactDescriptor = {
              ref: `${workspace.workspaceRef}/${retention.id}`, purpose: 'candidate',
              scope: protectedStateScope(context), digest: stateDigest(bytes)
            };
            await retention.beforeCreate(descriptor);
            retained = await workspace.put('candidate', descriptor.scope, bytes, retention.id);
            stateAssert(canonicalSha256(retained) === canonicalSha256(descriptor), 'artifact-integrity');
          }
          return {
            candidate: retained,
            proof: {
              kind: 'bootstrap-import-no-change/1' as const, configurationDigest: configuration.sourceDigest,
              mappingsDigest: canonicalSha256(this.options.mappings), executableDigest: this.options.runner.identityDigest,
              exitCode: 0 as const, resourceCount: candidate.instances.length, verifiedAt: this.options.now?.() ?? Date.now()
            }
          };
        } finally { bytes.fill(0); }
      } finally { await this.quiesce(); }
    });
  }
}
