import { readFileSync } from 'node:fs';
import path from 'node:path';

export const supportedStackSchemaVersion = 1 as const;

export const supportedHostPlatforms = [
  'darwin/arm64',
  'darwin/x64',
  'linux/arm64',
  'linux/x64',
  'win32/x64'
] as const;

export const generatedContainerPlatforms = [
  'linux/amd64',
  'linux/arm64'
] as const;

export type SupportedHostPlatform = (typeof supportedHostPlatforms)[number];
export type GeneratedContainerPlatform = (typeof generatedContainerPlatforms)[number];

export const runtimeIds = ['node', 'python', 'go', 'opentofu'] as const;
export const packageManagerIds = ['npm', 'uv'] as const;
export const frameworkIds = ['openspec', 'spec-kit'] as const;
export const npmProjectIds = [
  'liftoff',
  'telemetry-ingest',
  'node-backend',
  'frontend',
  'power-apps-code-app'
] as const;
export const pythonProjectIds = [
  'genai-backend',
  'standard-backend',
  'function-worker'
] as const;
export const goModuleIds = ['go-backend'] as const;
export const opentofuProviderIds = ['azapi', 'azurerm', 'time'] as const;
export const githubActionIds = [
  'checkout',
  'setup-node',
  'setup-python',
  'setup-go',
  'setup-opentofu'
] as const;
export const containerIds = [
  'python-runtime',
  'uv-tool',
  'node-runtime',
  'go-build',
  'alpine-runtime',
  'nginx-runtime',
  'postgres',
  'pgvector',
  'redis',
  'azurite',
  'mailpit',
  'langfuse-web',
  'langfuse-worker',
  'clickhouse',
  'minio',
  'container-apps-bootstrap',
  'telemetry-node'
] as const;
export const upstreamIds = ['power-apps-code-app'] as const;

export type RuntimeId = (typeof runtimeIds)[number];
export type PackageManagerId = (typeof packageManagerIds)[number];
export type FrameworkId = (typeof frameworkIds)[number];
export type NpmProjectId = (typeof npmProjectIds)[number];
export type PythonProjectId = (typeof pythonProjectIds)[number];
export type GoModuleId = (typeof goModuleIds)[number];
export type OpenTofuProviderId = (typeof opentofuProviderIds)[number];
export type GitHubActionId = (typeof githubActionIds)[number];
export type ContainerId = (typeof containerIds)[number];
export type UpstreamId = (typeof upstreamIds)[number];

export interface VersionBaseline {
  version: string;
  minimumVersion?: string;
  releaseLine: string;
  channel: 'stable' | 'lts';
  source: string;
  selectionReason?: string;
}

export interface DependencySetBaseline {
  manifestPathParts: string[];
  lockPathParts?: string[];
  freshnessPolicy: 'latest' | 'declared-range';
  requirements: {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  resolved: {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  selectionExceptions?: Record<string, {
    selectedVersion: string;
    reviewedCandidateVersion: string;
    reason: string;
  }>;
}

export interface PythonDependencySetBaseline {
  lockTemplatePathParts: string[];
  requiresPython: string;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, Record<string, string>>;
}

export interface GoModuleBaseline {
  moduleTemplatePathParts: string[];
  goVersion: string;
  dependencies: Record<string, string>;
  tools: Record<string, string>;
}

export interface OpenTofuBaseline {
  version: VersionBaseline;
  lockPlatforms: string[];
  providers: Record<OpenTofuProviderId, {
    source: string;
    version: string;
  }>;
}

export interface ContainerBaseline {
  image: string;
  tag: string;
  digest: string;
  platforms: GeneratedContainerPlatform[];
  source: string;
  selectionReason?: string;
}

export interface GitHubActionBaseline {
  repository: string;
  ref: string;
  commit: string;
  source: string;
}

export interface UpstreamBaseline {
  repository: string;
  path: string;
  commit: string;
  compatibleSourceCommits: string[];
  source: string;
}

export interface SupportedStackBaseline {
  schemaVersion: typeof supportedStackSchemaVersion;
  id: string;
  verifiedOn: string;
  supportedHostPlatforms: SupportedHostPlatform[];
  runtimes: Record<RuntimeId, VersionBaseline>;
  packageManagers: Record<PackageManagerId, VersionBaseline>;
  frameworks: Record<FrameworkId, VersionBaseline>;
  npmProjects: Record<NpmProjectId, DependencySetBaseline>;
  pythonProjects: Record<PythonProjectId, PythonDependencySetBaseline>;
  goModules: Record<GoModuleId, GoModuleBaseline>;
  opentofu: OpenTofuBaseline;
  githubActions: Record<GitHubActionId, GitHubActionBaseline>;
  containers: Record<ContainerId, ContainerBaseline>;
  upstreams: Record<UpstreamId, UpstreamBaseline>;
}

export class SupportedStackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupportedStackError';
  }
}

const stableSemverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const releaseLinePattern = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const packageSpecifierPattern = /^(?:[~^]|>=?|<=?)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\s*,?\s*<(?:=)?\s*(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))?$/;
const goVersionPattern = /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9]{14}-[0-9a-f]{12})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SupportedStackError(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const unexpected = actual.filter((key) => !required.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    const detail = [
      missing.length > 0 ? `missing ${missing.join(', ')}` : '',
      unexpected.length > 0 ? `unsupported ${unexpected.join(', ')}` : ''
    ].filter(Boolean).join('; ');
    throw new SupportedStackError(`${label} fields are invalid: ${detail}.`);
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SupportedStackError(`${label} must be a nonempty string.`);
  }
  return value;
}

function stableVersion(value: unknown, label: string): string {
  const version = string(value, label);
  if (!stableSemverPattern.test(version)) {
    throw new SupportedStackError(`${label} must be a stable semantic version.`);
  }
  return version;
}

function url(value: unknown, label: string): string {
  const source = string(value, label);
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw new SupportedStackError(`${label} must be an absolute HTTPS URL.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new SupportedStackError(`${label} must be an absolute credential-free HTTPS URL.`);
  }
  return source;
}

function isoDate(value: unknown, label: string): string {
  const date = string(value, label);
  if (!isoDatePattern.test(date)) {
    throw new SupportedStackError(`${label} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new SupportedStackError(`${label} must be a valid calendar date.`);
  }
  return date;
}

function pathParts(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SupportedStackError(`${label} must be a nonempty path-part array.`);
  }
  return value.map((part, index) => {
    const item = string(part, `${label}[${index}]`);
    if (
      item === '.' ||
      item === '..' ||
      item.includes('/') ||
      item.includes('\\') ||
      path.posix.isAbsolute(item) ||
      path.win32.isAbsolute(item)
    ) {
      throw new SupportedStackError(`${label}[${index}] is not a safe portable path part.`);
    }
    return item;
  });
}

function uniqueEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string
): T[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SupportedStackError(`${label} must be a nonempty array.`);
  }
  const items = value.map((item, index) => {
    if (typeof item !== 'string' || !allowed.includes(item as T)) {
      throw new SupportedStackError(`${label}[${index}] is unsupported.`);
    }
    return item as T;
  });
  if (new Set(items).size !== items.length) {
    throw new SupportedStackError(`${label} must not contain duplicates.`);
  }
  return items;
}

function versionBaseline(value: unknown, label: string): VersionBaseline {
  const entry = record(value, label);
  const allowed = [
    'version',
    'minimumVersion',
    'releaseLine',
    'channel',
    'source',
    'selectionReason'
  ];
  const required = allowed.filter((key) =>
    key !== 'minimumVersion' && key !== 'selectionReason' ||
    Object.hasOwn(entry, key)
  );
  exactKeys(entry, required, label);
  const releaseLine = string(entry.releaseLine, `${label}.releaseLine`);
  if (!releaseLinePattern.test(releaseLine)) {
    throw new SupportedStackError(`${label}.releaseLine must contain one or two numeric components.`);
  }
  if (entry.channel !== 'stable' && entry.channel !== 'lts') {
    throw new SupportedStackError(`${label}.channel must be stable or lts.`);
  }
  return {
    version: stableVersion(entry.version, `${label}.version`),
    ...(entry.minimumVersion === undefined
      ? {}
      : { minimumVersion: stableVersion(entry.minimumVersion, `${label}.minimumVersion`) }),
    releaseLine,
    channel: entry.channel,
    source: url(entry.source, `${label}.source`),
    ...(entry.selectionReason === undefined
      ? {}
      : { selectionReason: string(entry.selectionReason, `${label}.selectionReason`) })
  };
}

function namedRecord<T, K extends string>(
  value: unknown,
  keys: readonly K[],
  label: string,
  parse: (entry: unknown, entryLabel: string) => T
): Record<K, T> {
  const entries = record(value, label);
  exactKeys(entries, keys, label);
  return Object.fromEntries(
    keys.map((key) => [key, parse(entries[key], `${label}.${key}`)])
  ) as Record<K, T>;
}

function dependencyVersions(value: unknown, label: string, resolved: boolean): Record<string, string> {
  const entries = record(value, label);
  const result: Record<string, string> = {};
  for (const name of Object.keys(entries).sort()) {
    const specifier = string(entries[name], `${label}.${name}`);
    if (resolved ? !stableSemverPattern.test(specifier) : !packageSpecifierPattern.test(specifier)) {
      throw new SupportedStackError(
        `${label}.${name} must be a ${resolved ? 'stable exact version' : 'stable version constraint'}.`
      );
    }
    result[name] = specifier;
  }
  return result;
}

function npmDependencyGroups(
  value: unknown,
  label: string,
  resolved: boolean
): DependencySetBaseline['requirements'] {
  const groups = record(value, label);
  exactKeys(groups, ['dependencies', 'devDependencies'], label);
  return {
    dependencies: dependencyVersions(groups.dependencies, `${label}.dependencies`, resolved),
    devDependencies: dependencyVersions(groups.devDependencies, `${label}.devDependencies`, resolved)
  };
}

function npmProject(value: unknown, label: string): DependencySetBaseline {
  const entry = record(value, label);
  const allowed = [
    'manifestPathParts',
    'lockPathParts',
    'freshnessPolicy',
    'requirements',
    'resolved',
    'selectionExceptions'
  ];
  const required = allowed.filter((key) =>
    key !== 'lockPathParts' && key !== 'selectionExceptions' ||
    Object.hasOwn(entry, key)
  );
  exactKeys(entry, required, label);
  const result: DependencySetBaseline = {
    manifestPathParts: pathParts(entry.manifestPathParts, `${label}.manifestPathParts`),
    ...(entry.lockPathParts === undefined
      ? {}
      : { lockPathParts: pathParts(entry.lockPathParts, `${label}.lockPathParts`) }),
    freshnessPolicy: entry.freshnessPolicy === 'latest' ||
      entry.freshnessPolicy === 'declared-range'
      ? entry.freshnessPolicy
      : (() => {
          throw new SupportedStackError(
            `${label}.freshnessPolicy must be latest or declared-range.`
          );
        })(),
    requirements: npmDependencyGroups(entry.requirements, `${label}.requirements`, false),
    resolved: npmDependencyGroups(entry.resolved, `${label}.resolved`, true)
  };
  if (entry.selectionExceptions === undefined) {
    return result;
  }
  const exceptions = record(entry.selectionExceptions, `${label}.selectionExceptions`);
  result.selectionExceptions = Object.fromEntries(
    Object.keys(exceptions).sort().map((name) => {
      const exception = record(exceptions[name], `${label}.selectionExceptions.${name}`);
      exactKeys(
        exception,
        ['selectedVersion', 'reviewedCandidateVersion', 'reason'],
        `${label}.selectionExceptions.${name}`
      );
      const selectedVersion = stableVersion(
        exception.selectedVersion,
        `${label}.selectionExceptions.${name}.selectedVersion`
      );
      const resolvedVersion =
        result.resolved.dependencies[name] ?? result.resolved.devDependencies[name];
      if (resolvedVersion !== selectedVersion) {
        throw new SupportedStackError(
          `${label}.selectionExceptions.${name}.selectedVersion must match its resolved direct dependency.`
        );
      }
      const reviewedCandidateVersion = stableVersion(
        exception.reviewedCandidateVersion,
        `${label}.selectionExceptions.${name}.reviewedCandidateVersion`
      );
      return [name, {
        selectedVersion,
        reviewedCandidateVersion,
        reason: string(exception.reason, `${label}.selectionExceptions.${name}.reason`)
      }];
    })
  );
  return result;
}

function pythonProject(value: unknown, label: string): PythonDependencySetBaseline {
  const entry = record(value, label);
  exactKeys(entry, ['lockTemplatePathParts', 'requiresPython', 'dependencies', 'optionalDependencies'], label);
  const optional = record(entry.optionalDependencies, `${label}.optionalDependencies`);
  return {
    lockTemplatePathParts: pathParts(entry.lockTemplatePathParts, `${label}.lockTemplatePathParts`),
    requiresPython: string(entry.requiresPython, `${label}.requiresPython`),
    dependencies: dependencyVersions(entry.dependencies, `${label}.dependencies`, true),
    optionalDependencies: Object.fromEntries(Object.keys(optional).sort().map((group) => [
      group,
      dependencyVersions(optional[group], `${label}.optionalDependencies.${group}`, true)
    ]))
  };
}

function goModule(value: unknown, label: string): GoModuleBaseline {
  const entry = record(value, label);
  exactKeys(entry, ['moduleTemplatePathParts', 'goVersion', 'dependencies', 'tools'], label);
  const moduleVersions = (versions: unknown, versionsLabel: string): Record<string, string> => {
    const entries = record(versions, versionsLabel);
    return Object.fromEntries(Object.keys(entries).sort().map((name) => {
      const moduleVersion = string(entries[name], `${versionsLabel}.${name}`);
      if (!goVersionPattern.test(moduleVersion)) {
        throw new SupportedStackError(
          `${versionsLabel}.${name} must be a stable Go module version.`
        );
      }
      return [name, moduleVersion];
    }));
  };
  return {
    moduleTemplatePathParts: pathParts(entry.moduleTemplatePathParts, `${label}.moduleTemplatePathParts`),
    goVersion: string(entry.goVersion, `${label}.goVersion`),
    dependencies: moduleVersions(entry.dependencies, `${label}.dependencies`),
    tools: moduleVersions(entry.tools, `${label}.tools`)
  };
}

function opentofuBaseline(value: unknown, label: string): OpenTofuBaseline {
  const entry = record(value, label);
  exactKeys(entry, ['version', 'lockPlatforms', 'providers'], label);
  const providers = namedRecord(
    entry.providers,
    opentofuProviderIds,
    `${label}.providers`,
    (providerValue, providerLabel) => {
      const provider = record(providerValue, providerLabel);
      exactKeys(provider, ['source', 'version'], providerLabel);
      return {
        source: string(provider.source, `${providerLabel}.source`),
        version: stableVersion(provider.version, `${providerLabel}.version`)
      };
    }
  );
  return {
    version: versionBaseline(entry.version, `${label}.version`),
    lockPlatforms: uniqueEnumArray(
      entry.lockPlatforms,
      ['darwin_amd64', 'darwin_arm64', 'linux_amd64', 'linux_arm64', 'windows_amd64'],
      `${label}.lockPlatforms`
    ),
    providers
  };
}

function container(value: unknown, label: string): ContainerBaseline {
  const entry = record(value, label);
  const allowed = ['image', 'tag', 'digest', 'platforms', 'source', 'selectionReason'];
  exactKeys(
    entry,
    allowed.filter((key) => key !== 'selectionReason' || Object.hasOwn(entry, key)),
    label
  );
  const image = string(entry.image, `${label}.image`);
  const tag = string(entry.tag, `${label}.tag`);
  const digest = string(entry.digest, `${label}.digest`);
  if (image.includes('@') || image.endsWith(':latest') || tag === 'latest' || tag.includes('@')) {
    throw new SupportedStackError(`${label} must separate a non-latest image, tag, and digest.`);
  }
  if (!digestPattern.test(digest)) {
    throw new SupportedStackError(`${label}.digest must be a sha256 digest.`);
  }
  return {
    image,
    tag,
    digest,
    platforms: uniqueEnumArray(entry.platforms, generatedContainerPlatforms, `${label}.platforms`),
    source: url(entry.source, `${label}.source`),
    ...(entry.selectionReason === undefined
      ? {}
      : { selectionReason: string(entry.selectionReason, `${label}.selectionReason`) })
  };
}

function githubAction(value: unknown, label: string): GitHubActionBaseline {
  const entry = record(value, label);
  exactKeys(entry, ['repository', 'ref', 'commit', 'source'], label);
  const commit = string(entry.commit, `${label}.commit`);
  if (!commitPattern.test(commit)) {
    throw new SupportedStackError(`${label}.commit must be a full lowercase Git commit SHA.`);
  }
  return {
    repository: string(entry.repository, `${label}.repository`),
    ref: string(entry.ref, `${label}.ref`),
    commit,
    source: url(entry.source, `${label}.source`)
  };
}

function upstream(value: unknown, label: string): UpstreamBaseline {
  const entry = record(value, label);
  exactKeys(entry, ['repository', 'path', 'commit', 'compatibleSourceCommits', 'source'], label);
  const commit = string(entry.commit, `${label}.commit`);
  if (!commitPattern.test(commit)) {
    throw new SupportedStackError(`${label}.commit must be a full lowercase Git commit SHA.`);
  }
  const compatibleSourceCommits = uniqueEnumArray(
    entry.compatibleSourceCommits,
    (entry.compatibleSourceCommits as unknown[]).filter(
      (item): item is string => typeof item === 'string'
    ),
    `${label}.compatibleSourceCommits`
  );
  for (const [index, compatibleCommit] of compatibleSourceCommits.entries()) {
    if (!commitPattern.test(compatibleCommit)) {
      throw new SupportedStackError(
        `${label}.compatibleSourceCommits[${index}] must be a full lowercase Git commit SHA.`
      );
    }
  }
  if (!compatibleSourceCommits.includes(commit)) {
    throw new SupportedStackError(`${label}.compatibleSourceCommits must include the current commit.`);
  }
  return {
    repository: url(entry.repository, `${label}.repository`),
    path: string(entry.path, `${label}.path`),
    commit,
    compatibleSourceCommits,
    source: url(entry.source, `${label}.source`)
  };
}

export function parseSupportedStackBaseline(value: unknown): SupportedStackBaseline {
  const baseline = record(value, 'baseline');
  exactKeys(baseline, [
    'schemaVersion',
    'id',
    'verifiedOn',
    'supportedHostPlatforms',
    'runtimes',
    'packageManagers',
    'frameworks',
    'npmProjects',
    'pythonProjects',
    'goModules',
    'opentofu',
    'githubActions',
    'containers',
    'upstreams'
  ], 'baseline');
  if (baseline.schemaVersion !== supportedStackSchemaVersion) {
    throw new SupportedStackError(
      `baseline.schemaVersion must be ${supportedStackSchemaVersion}.`
    );
  }
  const id = string(baseline.id, 'baseline.id');
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)) {
    throw new SupportedStackError('baseline.id must be a stable lowercase identifier.');
  }
  return {
    schemaVersion: supportedStackSchemaVersion,
    id,
    verifiedOn: isoDate(baseline.verifiedOn, 'baseline.verifiedOn'),
    supportedHostPlatforms: uniqueEnumArray(
      baseline.supportedHostPlatforms,
      supportedHostPlatforms,
      'baseline.supportedHostPlatforms'
    ),
    runtimes: namedRecord(baseline.runtimes, runtimeIds, 'baseline.runtimes', versionBaseline),
    packageManagers: namedRecord(
      baseline.packageManagers,
      packageManagerIds,
      'baseline.packageManagers',
      versionBaseline
    ),
    frameworks: namedRecord(
      baseline.frameworks,
      frameworkIds,
      'baseline.frameworks',
      versionBaseline
    ),
    npmProjects: namedRecord(
      baseline.npmProjects,
      npmProjectIds,
      'baseline.npmProjects',
      npmProject
    ),
    pythonProjects: namedRecord(
      baseline.pythonProjects,
      pythonProjectIds,
      'baseline.pythonProjects',
      pythonProject
    ),
    goModules: namedRecord(baseline.goModules, goModuleIds, 'baseline.goModules', goModule),
    opentofu: opentofuBaseline(baseline.opentofu, 'baseline.opentofu'),
    githubActions: namedRecord(
      baseline.githubActions,
      githubActionIds,
      'baseline.githubActions',
      githubAction
    ),
    containers: namedRecord(
      baseline.containers,
      containerIds,
      'baseline.containers',
      container
    ),
    upstreams: namedRecord(baseline.upstreams, upstreamIds, 'baseline.upstreams', upstream)
  };
}

export function readSupportedStackBaseline(file: URL): SupportedStackBaseline {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new SupportedStackError(
      `Unable to read supported-stack baseline: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return parseSupportedStackBaseline(value);
}

export const supportedStack = readSupportedStackBaseline(
  new URL('../assets/supported-stack.json', import.meta.url)
);

export function formatContainerImage(entry: ContainerBaseline): string {
  return `${entry.image}:${entry.tag}@${entry.digest}`;
}
