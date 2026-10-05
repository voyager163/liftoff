import path from 'node:path';
import type { IsolatedHclResult } from '../../adapters/hcl/isolated-parser.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { capturedFileBytes, localInputFailure, type ModernLocalFile } from '../../domain/governance/activation/modern-local-inputs.js';
import {
  manualInfrastructurePolicy, validateManualInfrastructureInputs, type ManualInfrastructureInputs,
  type ManualInfrastructureRoot
} from '../../domain/governance/activation/modern-manual-infrastructure.js';
import { isRecord } from '../../domain/project/manifest/fields.js';
import type { LiftoffManifestV8 } from '../../domain/project/manifest/v8.js';
import { renderTofuLocalState, renderTofuProviders } from '../../generators/infrastructure/azure.js';
import { modernSourceRegistry } from '../project/modern-plugins.js';

const key = (parts: readonly string[]) => parts.join('/');
const under = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`);
const same = (left: unknown, right: unknown) => canonicalSha256(left) === canonicalSha256(right);

/** Interprets already-captured source and parser results; this is not preparation or execution authority. */
export function deriveManualInfrastructureInputs(
  manifest: LiftoffManifestV8, files: ReadonlyMap<string, ModernLocalFile>,
  documents: ReadonlyMap<string, IsolatedHclResult>
): ManualInfrastructureInputs {
  if (manifest.project.specWorkflow !== 'manual') localInputFailure('Locked Manual preparation cannot replace an external framework recipe.');
  const assets = modernSourceRegistry().assetsFor({ kind: 'plugin', category: 'cloud', id: 'azure' }).own;
  const versions = assets['opentofu-azure-versions'], providerLock = assets['opentofu-azure-provider-lock'];
  if (typeof versions !== 'string' || typeof providerLock !== 'string') {
    localInputFailure('The qualified Azure plugin versions and provider lock must be available from the verified source registry.');
  }
  function component(id: string): readonly string[] {
    const value = manifest.activeLayout.bindings.find(binding => binding.kind === 'component' && binding.component === id);
    if (!value) localInputFailure('Manual infrastructure component has no explicit active binding.');
    return value.pathParts;
  }
  function artifact(logicalName: string, root: readonly string[], expected: string): ModernLocalFile {
    const binding = manifest.activeLayout.bindings.find(binding => binding.kind === 'artifact' && binding.logicalName === logicalName);
    if (!binding || binding.pathParts.length !== root.length + 1 || !under(key(root), key(binding.pathParts))) {
      localInputFailure('Manual infrastructure requires its explicit, directly loaded artifact binding.');
    }
    const file = files.get(key(binding.pathParts));
    if (!file || !capturedFileBytes(file)?.equals(Buffer.from(expected))) {
      localInputFailure('Manual infrastructure configuration or provider lock differs from the separately qualified packaged baseline.');
    }
    return file;
  }
  const modulePathParts = component('opentofu-application');
  const versionFiles = new Set<string>([key(artifact('opentofu-application-versions', modulePathParts,
    versions).pathParts)]);
  const providerFiles = new Set<string>(), backendFiles = new Map<string, string>();
  const rootInputs = manifest.project.workload.environments.map(id => {
    const cwdPathParts = component(`opentofu-environment:${id}`);
    versionFiles.add(key(artifact(`opentofu-${id}-versions`, cwdPathParts, versions).pathParts));
    providerFiles.add(key(artifact(`opentofu-${id}-providers`, cwdPathParts, renderTofuProviders()).pathParts));
    backendFiles.set(key(artifact(`opentofu-${id}-local-state`, cwdPathParts, renderTofuLocalState(id)).pathParts), id);
    const lock = artifact(`opentofu-${id}-provider-lock`, cwdPathParts, providerLock);
    return { component: `opentofu-environment:${id}`, cwdPathParts, lockPathParts: lock.pathParts, lockDigest: lock.digest! };
  });
  const directories = [modulePathParts, ...rootInputs.map(root => root.cwdPathParts)];
  if (directories.some((root, index) => directories.some((other, otherIndex) => index !== otherIndex &&
      under(key(root).toLowerCase(), key(other).toLowerCase())))) {
    localInputFailure('Manual module and environment roots require nonoverlapping captured components.');
  }
  const modules = new Map<string, ManualInfrastructureRoot['module']>();
  const parsedVersions = new Set<string>(), parsedProviders = new Set<string>(), parsedBackends = new Set<string>();
  const expectedVersions = {
    required_version: manualInfrastructurePolicy.requiredVersionRange,
    required_providers: [{ azurerm: {
      source: manualInfrastructurePolicy.providerSource.slice('registry.opentofu.org/'.length),
      version: manualInfrastructurePolicy.providerVersion
    } }]
  };
  for (const [filename, file] of files) {
    const owner = directories.find(root => under(key(root), filename));
    if (!owner || file.content === null) continue;
    if (/\.(?:tf|tofu)\.json$|\.tofu$/u.test(filename)) {
      localInputFailure('Additional OpenTofu configuration formats are not covered by the locked Manual recipe.');
    }
    if (!filename.endsWith('.tf')) continue;
    if (file.pathParts.length !== owner.length + 1 || /(?:^|_)override\.tf$/u.test(path.posix.basename(filename))) {
      localInputFailure('Nested or override HCL is outside the directly loaded Manual module graph.');
    }
    const document = documents.get(filename);
    if (!document) localInputFailure('Manual infrastructure is missing its actual captured HCL parse result.');
    const parsed = document.parsed;
    if (Object.keys(parsed).some(name => !['terraform', 'variable', 'locals', 'output', 'module', 'resource', 'data', 'provider'].includes(name))) {
      localInputFailure('Manual infrastructure contains an unsupported executable or lifecycle configuration block.');
    }
    if (parsed.terraform !== undefined) {
      if (!Array.isArray(parsed.terraform)) localInputFailure('Unsupported Terraform configuration representation.');
      for (const block of parsed.terraform) {
        if (!isRecord(block) || Object.keys(block).some(name => !['required_version', 'required_providers', 'backend'].includes(name))) {
          localInputFailure('Cloud integration, state encryption and other Terraform controls need a separately qualified recipe.');
        }
        if (block.required_version !== undefined || block.required_providers !== undefined) {
          if (!versionFiles.has(filename) || !same(block, expectedVersions)) {
            localInputFailure('Provider requirements must be the exact qualified declaration in its active versions artifact.');
          }
          parsedVersions.add(filename);
        }
        if (block.backend !== undefined) {
          if (!backendFiles.has(filename) ||
              !same(block.backend, { local: [{ path: `state/${backendFiles.get(filename)}.tfstate` }] })) {
            localInputFailure('Only the captured generated local backend is admitted with backend initialization disabled.');
          }
          parsedBackends.add(filename);
        }
      }
    }
    if (parsed.provider !== undefined) {
      if (!providerFiles.has(filename) || !same(parsed.provider, { azurerm: [{ features: [{}] }] })) {
        localInputFailure('Provider aliases, credentials and custom provider configuration are outside this Manual recipe.');
      }
      parsedProviders.add(filename);
    }
    for (const kind of ['resource', 'data']) {
      const declarations = parsed[kind];
      if (declarations === undefined) continue;
      if (!isRecord(declarations)) localInputFailure('Unsupported provider resource/data declaration.');
      for (const [type, named] of Object.entries(declarations)) {
        if (!/^azurerm_[a-z][a-z0-9_]*$/u.test(type) || !isRecord(named)) {
          localInputFailure('Only the explicitly locked AzureRM provider may supply resource/data schemas.');
        }
        for (const instances of Object.values(named)) {
          if (!Array.isArray(instances) || instances.some(instance => !isRecord(instance) ||
              instance.provider !== undefined || instance.provisioner !== undefined || instance.connection !== undefined)) {
            localInputFailure('Provider remapping and provisioner/connection execution are outside this Manual recipe.');
          }
        }
      }
    }
    if (parsed.module !== undefined) {
      const root = rootInputs.find(root => key(root.cwdPathParts) === key(owner));
      if (!root || !isRecord(parsed.module)) localInputFailure('Nested or unbound modules are not covered by locked environment-root validation.');
      for (const [name, declarations] of Object.entries(parsed.module)) {
        if (modules.has(root.component) || !Array.isArray(declarations) || declarations.length !== 1 ||
            !isRecord(declarations[0]) || typeof declarations[0].source !== 'string' ||
            declarations[0].version !== undefined || declarations[0].providers !== undefined) {
          localInputFailure('Each environment must reference exactly one captured local application module without external resolution or provider remapping.');
        }
        modules.set(root.component, { key: name, source: declarations[0].source, pathParts: [...modulePathParts] });
      }
    }
  }
  if (!same([...versionFiles].sort(), [...parsedVersions].sort()) ||
      !same([...providerFiles].sort(), [...parsedProviders].sort()) ||
      !same([...backendFiles.keys()].sort(), [...parsedBackends].sort())) {
    localInputFailure('Required infrastructure configuration was not present in the actual loaded HCL parse set.');
  }
  return validateManualInfrastructureInputs({
    kind: 'liftoff-manual-locked-infrastructure-inputs', schemaVersion: 1,
    policyDigest: canonicalSha256(manualInfrastructurePolicy), moduleComponent: 'opentofu-application', modulePathParts,
    roots: rootInputs.map((root, index) => {
      const module = modules.get(root.component);
      if (!module) localInputFailure('Application validation requires its actual local module reference in every selected environment.');
      return { ...root, dataPathParts: ['cache', 'manual-init', String(index)], module };
    })
  });
}
