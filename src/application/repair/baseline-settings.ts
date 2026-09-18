import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ProjectFileMutation, ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { captureProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { workspaceFileIdentity } from '../../adapters/filesystem/repair-workspaces.js';
import { object, singleBlock, parseHcl, unsupported, type HclObject } from '../../adapters/hcl/semantic.js';
import { packagedSupportedStack } from '../../adapters/packaged-assets/supported-stack.js';
import type { EnvironmentId, LiftoffManifest } from '../../domain/project/contracts.js';
import { assessInfrastructureLayout, type InfrastructureLayoutKind } from '../../domain/project/infrastructure-layout.js';
import { inspectInfrastructureRepair } from './infrastructure.js';
import { infrastructureRoot, type InfrastructureDirectoryObservation } from './infra-files.js';
import { baselineResourceSources } from './baseline-source.js';
import type { RepairWorkspaceFileIdentity } from './workspaces-types.js';

// AzureRM v5.3.0 documents only TLS 1.2 for these resources. Unknown future values are not downgrade authority.
export const azureBaselineProviderContract = {
  source: 'hashicorp/azurerm', version: '5.3.0',
  documentation: 'https://github.com/hashicorp/terraform-provider-azurerm/tree/v5.3.0/website/docs/r',
  settings: {
    azurerm_redis_cache: { minimum_tls_version: { target: '1.2', weaker: ['1.0', '1.1'], compliant: ['1.2'] } },
    azurerm_servicebus_namespace: { minimum_tls_version: { target: '1.2', weaker: ['1.0', '1.1'], compliant: ['1.2'] } },
    azurerm_storage_account: {
      min_tls_version: { target: 'TLS1_2', weaker: ['TLS1_0', 'TLS1_1'], compliant: ['TLS1_2'] },
      allow_nested_items_to_be_public: { target: false, weaker: [true], compliant: [false] }
    }
  }
} as const;

export interface AzureBaselineSettingChange {
  resourceType: string;
  resourceName: string;
  attribute: string;
  action: 'add' | 'update';
  currentValue?: unknown;
  targetValue: string | boolean;
}

export interface AzureBaselineSettingsCandidate {
  recipe: 'azure-baseline-settings';
  layout: InfrastructureLayoutKind;
  blockers: string[];
  snapshots: ProjectFileSnapshot[];
  mutations: ProjectFileMutation[];
  files: { pathParts: string[]; content: string }[];
  directoryInventory: Array<InfrastructureDirectoryObservation & { mode: number | null; identity: RepairWorkspaceFileIdentity | null }>;
  resourceGroups: { environment: EnvironmentId; name: string }[];
  statePaths: string[][];
  changes: AzureBaselineSettingChange[];
}

interface SettingRule { target: string | boolean; weaker: readonly (string | boolean)[]; compliant: readonly (string | boolean)[] }
const rules: Readonly<Record<string, Readonly<Record<string, SettingRule>>>> = azureBaselineProviderContract.settings;

function resource(document: HclObject, type: string, name: string): HclObject {
  const resources = object(document.resource, 'main.tf resource');
  return singleBlock(object(resources[type], `main.tf ${type}`)[name], `${type}.${name}`);
}

export async function applyBaselineSettingChanges(content: string, changes: readonly AzureBaselineSettingChange[]): Promise<string> {
  const before = await parseHcl(content, 'modules/application/main.tf'), expected = structuredClone(before);
  const sources = baselineResourceSources(content);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const additions = new Map<number, string[]>();
  const seen = new Set<string>();
  for (const change of changes) {
    const id = `${change.resourceType}.${change.resourceName}`, key = `${id}.${change.attribute}`;
    const rule = rules[change.resourceType]?.[change.attribute];
    if (!rule || change.targetValue !== rule.target || seen.has(key)) unsupported(`${key}: unsupported or duplicate baseline effect.`);
    seen.add(key);
    const original = resource(before, change.resourceType, change.resourceName);
    const source = sources.get(id);
    if (!source) unsupported(`${id}: exact resource source block is missing.`);
    const value = source.attributes.get(change.attribute);
    if (source.blocks.has(change.attribute)) unsupported(`${key}: dynamic or nested setting cannot be safely edited.`);
    if (change.action === 'update') {
      if (!value || value.length !== 1 || !['word', 'string'].includes(value[0]!.kind) ||
          !isDeepStrictEqual(original[change.attribute], change.currentValue) ||
          !rule.weaker.some((entry) => entry === change.currentValue)) {
        unsupported(`${key}: dynamic, malformed or changed setting cannot be safely edited.`);
      }
      edits.push({ start: value[0]!.start, end: value[0]!.end, text: JSON.stringify(change.targetValue) });
    } else if (change.action === 'add') {
      if (value || Object.hasOwn(original, change.attribute)) unsupported(`${key}: expected setting absence changed.`);
      const start = content.lastIndexOf('\n', source.close - 1) + 1;
      const closingIndent = content.slice(start, source.close);
      if (!/^[ \t]*$/u.test(closingIndent) || start <= source.open) {
        unsupported(`${id}: adding settings requires an unambiguous multiline resource body.`);
      }
      const newline = content.includes('\r\n') ? '\r\n' : '\n';
      const lines = additions.get(start) ?? [];
      lines.push(`${closingIndent}  ${change.attribute} = ${JSON.stringify(change.targetValue)}${newline}`);
      additions.set(start, lines);
    } else unsupported(`${key}: unsupported baseline action.`);
    resource(expected, change.resourceType, change.resourceName)[change.attribute] = change.targetValue;
  }
  for (const [start, lines] of additions) edits.push({ start, end: start, text: lines.join('') });
  let after = content, boundary = content.length;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    if (edit.end > boundary) unsupported('Baseline source edits overlap; no ambiguous replacement is authorized.');
    after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
    boundary = edit.start;
  }
  if (!isDeepStrictEqual(await parseHcl(after, 'remediated modules/application/main.tf'), expected)) {
    unsupported('Baseline semantic delta differs from the exact approved attributes; unrelated configuration was preserved.');
  }
  return after;
}

async function assertPinnedProvider(files: AzureBaselineSettingsCandidate['files']): Promise<void> {
  if (packagedSupportedStack.opentofu.providers.azurerm.version !== azureBaselineProviderContract.version) {
    unsupported('The packaged AzureRM version lacks a registered baseline-setting value contract.');
  }
  for (const file of files.filter((entry) => entry.pathParts.at(-1) === '.terraform.lock.hcl')) {
    const parsed = await parseHcl(file.content, file.pathParts.join('/'));
    const providers = object(parsed.provider, 'provider lock');
    if (Object.keys(providers).length !== 1) unsupported('Baseline validation supports only its exact registered AzureRM provider, not additional executable providers.');
    const entry = providers['registry.opentofu.org/hashicorp/azurerm'] ?? providers['registry.terraform.io/hashicorp/azurerm'];
    const locked = singleBlock(entry, 'AzureRM provider lock');
    if (locked.version !== azureBaselineProviderContract.version || !Array.isArray(locked.hashes) || !locked.hashes.length ||
        locked.hashes.some((value) => typeof value !== 'string' || !/^(h1|zh):[A-Za-z0-9+/=]+$/u.test(value))) {
      unsupported('Baseline settings require the exact registered AzureRM provider lock; no provider upgrade is implied.');
    }
  }
  for (const file of files.filter((entry) => entry.pathParts.at(-1)?.endsWith('.tf'))) {
    const parsed = await parseHcl(file.content, file.pathParts.join('/'));
    for (const kind of ['resource', 'data']) {
      if (parsed[kind] !== undefined && Object.keys(object(parsed[kind], `baseline ${kind}`)).some((type) => !type.startsWith('azurerm_'))) {
        unsupported('Baseline validation rejects resources from unregistered executable providers.');
      }
    }
    if (parsed.module !== undefined) {
      const modules = object(parsed.module, 'baseline module calls');
      if (!file.pathParts.includes('environments') || file.pathParts.at(-1) !== 'main.tf' ||
          Object.keys(modules).length !== 1 || singleBlock(modules.application, 'environment application module').source !== '../../modules/application') {
        unsupported('Baseline validation rejects remote, dynamic or unregistered module sources; only the exact local application module is supported.');
      }
    }
    if (file.pathParts.at(-1) === 'versions.tf') {
      const terraform = singleBlock(parsed.terraform, 'versions.tf terraform');
      const required = singleBlock(terraform.required_providers, 'versions.tf required_providers');
      const azure = object(required.azurerm, 'versions.tf AzureRM');
      if (Object.keys(required).length !== 1 || !['hashicorp/azurerm', 'registry.opentofu.org/hashicorp/azurerm', 'registry.terraform.io/hashicorp/azurerm'].includes(String(azure.source)) ||
          typeof azure.version !== 'string' || !/^(?:=\s*)?5\.3\.0$/u.test(azure.version)) {
        unsupported('Baseline validation requires the exact registered AzureRM provider requirement; no alternate provider or version is authorized.');
      }
    }
  }
}

export async function inspectAzureBaselineSettings(projectRoot: string, manifest: LiftoffManifest): Promise<AzureBaselineSettingsCandidate> {
  const candidate: AzureBaselineSettingsCandidate = {
    recipe: 'azure-baseline-settings', layout: assessInfrastructureLayout(manifest).kind,
    blockers: [], snapshots: [], mutations: [], files: [], directoryInventory: [], resourceGroups: [], statePaths: [], changes: []
  };
  try {
    if (manifest.project.workload.kind === 'components' || manifest.project.workload.cloud !== 'azure') {
      unsupported('Only recorded Azure infrastructure is supported by this repair recipe.');
    }
    if (manifest.projectArtifacts.some((entry) => entry.category === 'infrastructure' && (entry.adoption || entry.addition))) {
      unsupported('Infrastructure repair requires exact generated infrastructure provenance, not adopted or added artifacts.');
    }
    if (candidate.layout !== 'independent') {
      unsupported('Recorded infrastructure layout is not independent; run azure-local-layout repair first to reorganize flat-root layout.');
    }
    const observed = await inspectInfrastructureRepair(projectRoot, manifest);
    if (observed.blockers.length) unsupported(observed.blockers.join(' '));
    candidate.snapshots = observed.snapshots;
    candidate.files = observed.files;
    candidate.statePaths = observed.statePaths;
    for (const directory of observed.directoryInventory) {
      const details = directory.exists ? await lstat(path.join(projectRoot, ...directory.pathParts), { bigint: true }) : null;
      const mode = details ? Number(details.mode & 0o7777n) : null;
      if (mode !== null && mode & 0o7000) unsupported('Special infrastructure directory modes are unsupported.');
      candidate.directoryInventory.push({ ...directory, mode, identity: details ? workspaceFileIdentity(details) : null });
    }
    for (const parts of [['liftoff.manifest.json'], ['liftoff.config.json']]) {
      const snapshot = await captureProjectFileSnapshot(projectRoot, parts);
      if (snapshot.content === undefined || snapshot.mode === undefined) unsupported(`${parts.join('/')}: required repair input is missing.`);
      candidate.snapshots.push(snapshot);
    }
    await assertPinnedProvider(candidate.files);
    const mainPath = [...infrastructureRoot, 'modules', 'application', 'main.tf'];
    const main = candidate.snapshots.find((entry) => entry.pathParts.join('/') === mainPath.join('/'));
    if (main?.content === undefined || main.mode === undefined) unsupported('Application main.tf is missing or unreadable.');
    const content = main.content.toString('utf8'), parsed = await parseHcl(content, 'modules/application/main.tf');
    const sources = baselineResourceSources(content);
    let supportedResources = 0;
    for (const [type, named] of Object.entries(object(parsed.resource, 'main.tf resource'))) {
      for (const name of Object.keys(object(named, `main.tf ${type}`))) {
        const block = resource(parsed, type, name), id = `${type}.${name}`;
        const source = sources.get(id);
        if (!source) unsupported(`${id}: exact resource source block is missing.`);
        const settings = rules[type];
        if (!settings) continue;
        supportedResources++;
        for (const [attribute, rule] of Object.entries(settings)) {
          const value = block[attribute], literal = source.attributes.get(attribute);
          if (source.blocks.has(attribute)) {
            candidate.blockers.push(`${id}.${attribute}: dynamic or nested setting requires explicit review.`);
          } else if (!Object.hasOwn(block, attribute)) {
            if (literal) unsupported(`${id}.${attribute}: semantic/source presence mismatch.`);
            candidate.changes.push({ resourceType: type, resourceName: name, attribute, action: 'add', targetValue: rule.target });
          } else if (!literal || literal.length !== 1 || !['word', 'string'].includes(literal[0]!.kind) ||
              typeof value !== typeof rule.target || ![...rule.compliant, ...rule.weaker].some((entry) => entry === value)) {
            candidate.blockers.push(`${id}.${attribute}: dynamic, malformed or unsupported value under AzureRM ${azureBaselineProviderContract.version}; explicit review required.`);
          } else if (rule.weaker.some((entry) => entry === value)) {
            candidate.changes.push({ resourceType: type, resourceName: name, attribute, action: 'update', currentValue: value, targetValue: rule.target });
          }
        }
      }
    }
    if (!supportedResources) unsupported('No supported Azure baseline resource block was found; compliance is not established.');
    if (!candidate.blockers.length && candidate.changes.length) {
      const updated = await applyBaselineSettingChanges(content, candidate.changes);
      candidate.mutations.push({ type: 'write', pathParts: mainPath, content: updated, mode: main.mode });
      candidate.files = candidate.files.map((entry) => entry.pathParts.join('/') === mainPath.join('/') ? { ...entry, content: updated } : entry);
    }
    for (const before of candidate.snapshots) {
      const after = await captureProjectFileSnapshot(projectRoot, before.pathParts);
      if (before.mode !== after.mode || !isDeepStrictEqual(before.content, after.content)) unsupported('Infrastructure inputs changed during inspection.');
    }
  } catch (error) {
    candidate.blockers.push(error instanceof Error ? error.message : 'Infrastructure inputs could not be inspected safely.');
  }
  if (candidate.blockers.length) {
    candidate.mutations = [];
    candidate.files = [];
  }
  return candidate;
}
