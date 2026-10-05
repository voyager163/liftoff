import path from 'node:path';
import { canonicalSha256 } from './canonical-json.js';
import { copyModernLocalData, localInputFailure, localPath, modernLocalBounds } from './modern-local-inputs.js';
import { exactRecord } from '../../project/manifest/fields.js';

export const manualInfrastructurePolicy = Object.freeze({
  kind: 'liftoff-manual-locked-infrastructure',
  version: 1,
  qualifiedPlatform: 'darwin',
  qualifiedArchitecture: 'arm64',
  tofuVersion: '1.12.6',
  requiredVersionRange: '>= 1.12.6, < 2.0.0',
  providerSource: 'registry.opentofu.org/hashicorp/azurerm',
  providerVersion: '5.3.0',
  providerConfiguration: 'default-azurerm-with-empty-features-only',
  providerLock: 'exact-packaged-lock-with-readonly-initialization',
  moduleGraph: 'one-captured-application-module-per-environment-without-nested-modules',
  roots: 3,
  outputFiles: 32,
  outputDirectories: 16,
  outputDepth: 12,
  outputFileBytes: 256 * 1024 * 1024,
  outputBytes: 256 * 1024 * 1024,
  outputReadChunkBytes: 1024 * 1024,
  moduleIndexBytes: 8192,
  providerBinary: 'terraform-provider-azurerm',
  providerDocuments: Object.freeze([
    'CHANGELOG-v0.md', 'CHANGELOG-v1.md', 'CHANGELOG-v2.md', 'CHANGELOG-v3.md', 'CHANGELOG-v4.md',
    'CHANGELOG.md', 'LICENSE', 'README.md'
  ]),
  temporaryDirectoryBytes: modernLocalBounds.depth * 3 + 'scratch'.length,
  temporaryDirectory: 'existing-owned-scratch-relative-to-approved-command-cwd',
  additionalPureFunctions: Object.freeze(['regex', 'urlencode']),
  initArgs: Object.freeze(['init', '-backend=false', '-input=false', '-no-color', '-lockfile=readonly']),
  validateArgs: Object.freeze(['validate', '-no-color']),
  network: 'explicit-provider-distribution-consent-no-network-sandbox',
  outputs: 'complete-regular-single-link-files-and-unchanged-physical-identities',
  originals: 'never-written'
} as const);

export interface ManualInfrastructureRoot {
  readonly component: string;
  readonly cwdPathParts: readonly string[];
  readonly dataPathParts: readonly string[];
  readonly lockPathParts: readonly string[];
  readonly lockDigest: string;
  readonly module: {
    readonly key: string;
    readonly source: string;
    readonly pathParts: readonly string[];
  };
}

export interface ManualInfrastructureInputs {
  readonly kind: 'liftoff-manual-locked-infrastructure-inputs';
  readonly schemaVersion: 1;
  readonly policyDigest: string;
  readonly moduleComponent: 'opentofu-application';
  readonly modulePathParts: readonly string[];
  readonly roots: readonly ManualInfrastructureRoot[];
}

export interface ManualInfrastructureOutputEntry {
  readonly pathParts: readonly string[];
  readonly kind: 'file' | 'directory';
  readonly mode: number;
  readonly bytes: number;
  readonly digest: string | null;
  readonly physical: string;
}
export interface ManualInfrastructureOutput {
  readonly kind: 'liftoff-manual-infrastructure-output';
  readonly schemaVersion: 1;
  readonly component: string;
  readonly inputDigest: string;
  readonly sourceDigest: string;
  readonly toolDigest: string;
  readonly environmentDigest: string;
  readonly dataPathParts: readonly string[];
  readonly entries: readonly ManualInfrastructureOutputEntry[];
  readonly outputDigest: string;
}

export function manualInfrastructureOutputPaths(): ReadonlyMap<string, 'file' | 'directory'> {
  const provider = ['providers', ...manualInfrastructurePolicy.providerSource.split('/'), manualInfrastructurePolicy.providerVersion];
  const platform = `${manualInfrastructurePolicy.qualifiedPlatform}_${manualInfrastructurePolicy.qualifiedArchitecture}`;
  const files = [
    ['modules', 'modules.json'], [...provider, `${platform}.lock`],
    ...[manualInfrastructurePolicy.providerBinary, ...manualInfrastructurePolicy.providerDocuments].map(name => [...provider, platform, name])
  ];
  const entries = new Map<string, 'file' | 'directory'>([['', 'directory']]);
  for (const parts of files) {
    for (let length = 1; length < parts.length; length++) entries.set(parts.slice(0, length).join('/'), 'directory');
    entries.set(parts.join('/'), 'file');
  }
  return entries;
}

const same = (left: unknown, right: unknown) => canonicalSha256(left) === canonicalSha256(right);

function relativeScratch(cwd: readonly string[]): string {
  const value = `${'../'.repeat(cwd.length + 1)}scratch`;
  if (Buffer.byteLength(value) > manualInfrastructurePolicy.temporaryDirectoryBytes) {
    localInputFailure('Owned relative scratch path exceeds the qualified native socket-parent bound.');
  }
  return value;
}

export function validateManualInfrastructureInputs(input: ManualInfrastructureInputs): ManualInfrastructureInputs {
  const value = copyModernLocalData(input);
  exactRecord(value, ['kind', 'schemaVersion', 'policyDigest', 'moduleComponent', 'modulePathParts', 'roots'], 'Manual infrastructure inputs');
  if (value.kind !== 'liftoff-manual-locked-infrastructure-inputs' || value.schemaVersion !== 1 ||
      value.policyDigest !== canonicalSha256(manualInfrastructurePolicy) || value.moduleComponent !== 'opentofu-application' ||
      !Array.isArray(value.roots) || !value.roots.length || value.roots.length > manualInfrastructurePolicy.roots) {
    localInputFailure('Manual infrastructure requires its exact bounded input and policy identity.');
  }
  const module = localPath(value.modulePathParts).join('/');
  const components = new Set<string>(), directories = new Set<string>([module.toLowerCase()]);
  for (const [index, root] of value.roots.entries()) {
    exactRecord(root, ['component', 'cwdPathParts', 'dataPathParts', 'lockPathParts', 'lockDigest', 'module'], 'Manual initialization root');
    const cwd = localPath(root.cwdPathParts).join('/');
    relativeScratch(root.cwdPathParts);
    localPath(root.dataPathParts);
    localPath(root.lockPathParts);
    if (typeof root.component !== 'string' || !/^opentofu-environment:[a-z][a-z0-9-]{0,63}$/u.test(root.component) ||
        components.has(root.component) || directories.has(cwd.toLowerCase()) ||
        !same(root.dataPathParts, ['cache', 'manual-init', String(index)]) ||
        !same(root.lockPathParts, [...root.cwdPathParts, '.terraform.lock.hcl']) ||
        typeof root.lockDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(root.lockDigest)) {
      localInputFailure('Manual initialization root, provider lock or private output mapping is invalid.');
    }
    exactRecord(root.module, ['key', 'source', 'pathParts'], 'Manual local module');
    localPath(root.module.pathParts);
    const relative = path.posix.relative(cwd, module);
    const source = relative.startsWith('.') ? relative : `./${relative}`;
    if (typeof root.module.key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(root.module.key) ||
        root.module.source !== source || !same(root.module.pathParts, value.modulePathParts)) {
      localInputFailure('Manual module source must resolve exactly to the captured application component.');
    }
    components.add(root.component);
    directories.add(cwd.toLowerCase());
  }
  return value;
}

export function manualInfrastructureEnvironment(
  workspace: string, input: ManualInfrastructureInputs, component: string
): Record<string, string> {
  const initialization = validateManualInfrastructureInputs(input);
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || path.normalize(workspace) !== workspace ||
      /[\u0000-\u001f\u007f]/u.test(workspace)) localInputFailure('Manual initialization requires its canonical owned workspace.');
  const root = initialization.roots.find(root => root.component === component);
  if (!root) localInputFailure('Manual initialization has no approved component mapping.');
  return {
    TF_DATA_DIR: path.join(workspace, ...root.dataPathParts),
    TF_CLI_CONFIG_FILE: path.join(workspace, 'cache', 'manual-init', 'tofu.rc'),
    TF_CLI_ARGS: '', TF_CLI_ARGS_init: '', TF_CLI_ARGS_validate: '',
    TF_INPUT: '0', TF_IN_AUTOMATION: '1', CHECKPOINT_DISABLE: '1',
    TF_REGISTRY_DISCOVERY_RETRY: '0', TF_REGISTRY_CLIENT_TIMEOUT: '15',
    TMPDIR: relativeScratch(root.cwdPathParts)
  };
}

export function validateManualInfrastructureOutput(
  input: ManualInfrastructureOutput, initialization: ManualInfrastructureInputs,
  sourceDigest: string, toolDigest: string, workspace: string
): ManualInfrastructureOutput {
  const value = copyModernLocalData(input), selected = validateManualInfrastructureInputs(initialization);
  exactRecord(value, ['kind', 'schemaVersion', 'component', 'inputDigest', 'sourceDigest', 'toolDigest',
    'environmentDigest', 'dataPathParts', 'entries', 'outputDigest'], 'Manual infrastructure output');
  const root = selected.roots.find(root => root.component === value.component);
  const expected = manualInfrastructureOutputPaths();
  if (!root || value.kind !== 'liftoff-manual-infrastructure-output' || value.schemaVersion !== 1 ||
      value.inputDigest !== canonicalSha256(selected) || value.sourceDigest !== sourceDigest || value.toolDigest !== toolDigest ||
      value.environmentDigest !== canonicalSha256(manualInfrastructureEnvironment(workspace, selected, root.component)) ||
      !same(value.dataPathParts, root.dataPathParts) || !Array.isArray(value.entries) || value.entries.length !== expected.size) {
    localInputFailure('Manual infrastructure output is disconnected from its complete source, tool, environment or owned mapping.');
  }
  for (const digest of [sourceDigest, toolDigest, value.outputDigest]) {
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest)) localInputFailure('Manual infrastructure output requires raw digest identities.');
  }
  const seen = new Set<string>();
  let total = 0, files = 0, directories = 0, prior = '', owner: string | undefined;
  for (const entry of value.entries) {
    exactRecord(entry, ['pathParts', 'kind', 'mode', 'bytes', 'digest', 'physical'], 'Manual output entry');
    const name = localPath(entry.pathParts, true).join('/');
    if (seen.has(name) || name < prior || expected.get(name) !== entry.kind ||
        entry.pathParts.length > manualInfrastructurePolicy.outputDepth ||
        !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || (entry.mode & 0o022) !== 0 ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > manualInfrastructurePolicy.outputFileBytes ||
        typeof entry.physical !== 'string' || !/^\d+(?::\d+){9}$/u.test(entry.physical)) {
      localInputFailure('Manual output inventory contains an unsupported, aliased or malformed entry.');
    }
    prior = name;
    seen.add(name);
    const physical = entry.physical.split(':');
    if (!name) owner = physical[5];
    else if (physical[5] !== owner) localInputFailure('Manual output ownership differs from its captured root.');
    if ((Number(physical[2]) & 0o7777) !== entry.mode ||
        (Number(physical[2]) & 0o170000) !== (entry.kind === 'file' ? 0o100000 : 0o040000) ||
        (entry.kind === 'file' ? physical[3] !== '1' || Number(physical[4]) !== entry.bytes ||
          typeof entry.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.digest) :
          entry.bytes !== 0 || entry.digest !== null)) {
      localInputFailure('Manual output physical identity contradicts the captured file representation.');
    }
    if (entry.kind === 'file') {
      files++;
      total += entry.bytes;
      if (name === 'modules/modules.json' && (!entry.bytes || entry.bytes > manualInfrastructurePolicy.moduleIndexBytes) ||
          name.endsWith('.lock') && entry.bytes !== 0 ||
          entry.pathParts.at(-1) === manualInfrastructurePolicy.providerBinary && (!entry.bytes || (entry.mode & 0o100) === 0)) {
        localInputFailure('Manual module index, provider lock or executable output is invalid.');
      }
    } else directories++;
  }
  if (files > manualInfrastructurePolicy.outputFiles || directories > manualInfrastructurePolicy.outputDirectories ||
      total > manualInfrastructurePolicy.outputBytes || value.entries[0]?.pathParts.length !== 0 ||
      value.entries[0]?.mode !== 0o700 || value.outputDigest !== canonicalSha256(value.entries)) {
    localInputFailure('Manual output requires complete bounded owned-root contents and their exact digest.');
  }
  return value;
}
