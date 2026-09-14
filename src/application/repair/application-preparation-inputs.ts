import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import {
  ApplicationInspectionError, applicationDigest, applicationParts, applicationPathKey
} from './application-files.js';
import { applicationCandidateFiles } from './application-candidate.js';
import { applicationText } from './application-references.js';
import { applicationPackageSources, applicationPreparationBounds, applicationPreparationSupport } from './application-preparation-policy.js';
import type {
  ApplicationPackageSourceId, ApplicationPreparationRequest, ApplicationPrivateOutputRole,
  ApplicationResolvedPreparation
} from './application-preparation-types.js';
import type { ApplicationPatchCandidate } from './application-types.js';

function reject(code: string, message: string): never {
  throw new ApplicationInspectionError(`[${code}] ${message}`);
}

export function parseApplicationPreparation(value: unknown): ApplicationPreparationRequest[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > applicationPreparationBounds.providers) {
    reject('preparation-schema', 'Preparation must be an explicit bounded array of registered providers.');
  }
  return value.map((entry) => {
    if (!isRecord(entry) || Object.keys(entry).length !== 6 ||
        !['provider', 'version', 'cwdPathParts', 'packageSource', 'network', 'lifecycle'].every((key) => Object.hasOwn(entry, key))) {
      reject('preparation-schema', 'Preparation descriptors require exactly provider, version, cwdPathParts, packageSource, network, and lifecycle.');
    }
    const { provider, version, packageSource, network, lifecycle } = entry;
    if ((provider !== 'npm-ci' && provider !== 'uv-locked-sync' && provider !== 'go-mod-download') ||
        version !== 1 || typeof network !== 'boolean') {
      reject('preparation-schema', 'Only explicitly registered version-1 preparation providers and boolean network declarations are supported.');
    }
    if (lifecycle !== 'disabled') reject('unsupported-lifecycle', 'Preparation cannot enable install, source-build, or project-install hooks.');
    if (packageSource !== 'npmjs' && packageSource !== 'microsoft-npm' && packageSource !== 'pypi' &&
        packageSource !== 'microsoft-pypi' && packageSource !== 'go-proxy') {
      reject('unsupported-package-source', 'Preparation requires an exact named credential-free package source.');
    }
    return {
      provider, version, cwdPathParts: applicationParts(entry.cwdPathParts, true),
      packageSource, network, lifecycle
    };
  });
}

function publicUrl(value: unknown, source: ApplicationPackageSourceId): string {
  if (typeof value !== 'string' || value.length > 2048) reject('unsupported-package-source', 'Package artifact URLs must be bounded HTTPS URLs.');
  let url: URL;
  try { url = new URL(value); }
  catch { reject('unsupported-package-source', 'A package artifact source is not a supported URL.'); }
  const origins: readonly string[] = applicationPackageSources[source].artifactOrigins;
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !origins.includes(url.origin) || /%(?:2f|5c|2e|00)/iu.test(url.pathname) ||
      /(?:^|\/)\.{1,2}(?:\/|$)/u.test(value) ||
      url.pathname.split('/').some((part) => part === '..' || part === '.')) {
    reject('unsupported-package-source', 'Authenticated, queried, escaping, local, VCS, and unregistered package URLs are unsupported.');
  }
  return url.href;
}

function json(bytes: Buffer, label: string): Record<string, unknown> {
  const text = applicationText(bytes);
  if (text === null) reject('preparation-input', `${label} must be bounded UTF-8 JSON.`);
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) reject('preparation-input', `${label} must be an object.`);
    return value;
  } catch (error) {
    if (error instanceof ApplicationInspectionError) throw error;
    reject('preparation-input', `${label} is not valid JSON.`);
  }
}

const npmName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const npmRange = /^(?:[~^<>=\s|]*v?\d[0-9A-Za-z.*+<>=~^| -]*|\*)$/u;
const npmIntegrity = /^(?:sha512-[A-Za-z0-9+/]{86}==|sha384-[A-Za-z0-9+/]{64}|sha256-[A-Za-z0-9+/]{43}=|sha1-[A-Za-z0-9+/]{27}=)$/u;
function npmDependencies(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > applicationPreparationBounds.lockPackages) {
    reject('unsupported-package-source', 'npm dependency declarations must be bounded registry-version maps.');
  }
  const result: Record<string, string> = {};
  for (const [name, version] of Object.entries(value)) {
    if (!npmName.test(name) || typeof version !== 'string' || version.length > 256 || !npmRange.test(version)) {
      reject('unsupported-package-source', 'npm preparation rejects tags, aliases, workspace/local/VCS/URL dependencies, and unregistered resolution syntax.');
    }
    result[name] = version;
  }
  return result;
}

function npmInputs(manifest: Buffer, lockBytes: Buffer, request: ApplicationPreparationRequest) {
  const project = json(manifest, 'package.json'), lock = json(lockBytes, 'package-lock.json');
  if (Object.hasOwn(project, 'workspaces') || Object.hasOwn(lock, 'workspaces') ||
      project.bundledDependencies !== undefined || project.bundleDependencies !== undefined) {
    reject('unsupported-package-source', 'npm workspaces and bundled/local dependency arrangements are unsupported.');
  }
  if (lock.lockfileVersion !== 3 || !isRecord(lock.packages) || !isRecord(lock.packages[''])) {
    reject('missing-lock', 'npm-ci requires a current version-3 package-lock.json packages inventory.');
  }
  const root = lock.packages[''];
  if (project.name !== root.name || project.version !== root.version ||
      typeof project.name !== 'string' || typeof project.version !== 'string') {
    reject('mismatched-lock', 'The candidate package identity does not match its lock root.');
  }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const declared = npmDependencies(project[field]), locked = npmDependencies(root[field]);
    if (canonicalSha256(declared) !== canonicalSha256(locked)) {
      reject('mismatched-lock', 'Candidate dependency declarations differ from the exact package-lock root.');
    }
  }
  const packages = Object.entries(lock.packages);
  if (packages.length > applicationPreparationBounds.lockPackages) reject('preparation-bound', 'The npm lock package count exceeds the preparation bound.');
  let hooks = 0;
  for (const [location, entry] of packages) {
    if (location === '') continue;
    if (!location.startsWith('node_modules/') || !isRecord(entry) || entry.link === true ||
        typeof entry.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(entry.version)) {
      reject('unsupported-package-source', 'npm lock entries must be exact registry packages, not links, workspaces, or local/VCS sources.');
    }
    applicationParts(location.split('/'));
    if (typeof entry.integrity !== 'string' || !npmIntegrity.test(entry.integrity)) {
      const split = location.lastIndexOf('/node_modules/');
      const parent = split < 0 ? undefined : lock.packages[location.slice(0, split)];
      const bundledName = split < 0 ? '' : location.slice(split + '/node_modules/'.length);
      if (entry.inBundle !== true || entry.resolved !== undefined || !isRecord(parent) ||
          typeof parent.integrity !== 'string' || !npmIntegrity.test(parent.integrity) ||
          !Array.isArray(parent.bundleDependencies) || !parent.bundleDependencies.includes(bundledName)) {
        reject('missing-lock', 'Every npm registry artifact must retain exact recorded SRI integrity, or be an explicitly listed bundled child of an integrity-bound registry artifact.');
      }
    }
    if (entry.resolved !== undefined) publicUrl(entry.resolved, request.packageSource);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) npmDependencies(entry[field]);
    if (entry.hasInstallScript === true) hooks++;
    if (entry.bin !== undefined) {
      const bins = typeof entry.bin === 'string' ? [entry.bin] : isRecord(entry.bin) ? Object.values(entry.bin) : null;
      if (!bins || bins.some((item) => typeof item !== 'string' || item.startsWith('/') ||
          /(^|[/\\])\.\.([/\\]|$)|[:\\\u0000-\u001f]/u.test(item))) {
        reject('unsupported-package-source', 'npm binary links must stay inside their installed registry package.');
      }
    }
  }
  const toolRequirements: Record<string, string> = {};
  if (isRecord(project.engines)) {
    for (const id of ['node', 'npm']) {
      if (project.engines[id] !== undefined && typeof project.engines[id] !== 'string') reject('preparation-input', 'Runtime engine requirements must be strings.');
      if (typeof project.engines[id] === 'string') toolRequirements[id] = project.engines[id];
    }
  }
  if (project.packageManager !== undefined) {
    if (typeof project.packageManager !== 'string' || !/^npm@\d+\.\d+\.\d+$/u.test(project.packageManager)) {
      reject('unsupported-tool-requirement', 'The selected npm provider cannot satisfy another package-manager or unregistered launcher declaration.');
    }
    toolRequirements['npm-exact'] = project.packageManager.slice(4);
  }
  return { packageCount: packages.length - 1, hooks, pythonExtras: [], toolRequirements };
}

function toml(bytes: Buffer, label: string): Record<string, unknown> {
  const text = applicationText(bytes);
  if (text === null) reject('preparation-input', `${label} must be bounded UTF-8 TOML.`);
  try {
    const value: unknown = parseToml(text);
    if (!isRecord(value)) reject('preparation-input', `${label} must be a TOML document.`);
    return value;
  } catch {
    reject('preparation-input', `${label} is not valid TOML.`);
  }
}

const pythonName = (value: string) => value.toLowerCase().replace(/[-_.]+/gu, '-');
function pythonPin(value: unknown): { name: string; version: string; extras: string[] } {
  if (typeof value !== 'string' || value.length > 512) reject('unsupported-package-source', 'Python dependency declarations must be bounded exact registry pins.');
  const match = value.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[([A-Za-z0-9_,.-]+)\])?==([0-9][0-9A-Za-z.+!-]*)$/u);
  if (!match) reject('unsupported-package-source', 'This Python provider supports exact registry pins, not URL/VCS/local/workspace dependencies or unresolved markers.');
  return { name: pythonName(match[1]!), version: match[3]!, extras: (match[2]?.split(',') ?? []).map(pythonName).sort() };
}

function pythonRange(value: unknown): string {
  if (typeof value !== 'string') reject('mismatched-lock', 'Python requirements must be explicit in pyproject and lock.');
  const normalized = value.replaceAll(' ', '');
  const wildcard = normalized.match(/^==(\d+)\.(\d+)\.\*$/u);
  if (wildcard) return `>=${wildcard[1]}.${wildcard[2]},<${wildcard[1]}.${Number(wildcard[2]) + 1}`;
  if (!/^>=\d+\.\d+(?:\.\d+)?,<\d+\.\d+(?:\.\d+)?$/u.test(normalized)) {
    reject('unsupported-python-requirement', 'Python preparation requires a bounded explicit supported interpreter release range.');
  }
  return normalized;
}

function pythonInputs(manifest: Buffer, lockBytes: Buffer, request: ApplicationPreparationRequest, functions: boolean) {
  const projectFile = toml(manifest, 'pyproject.toml'), lock = toml(lockBytes, 'uv.lock');
  if (!isRecord(projectFile.project) || !Array.isArray(lock.package) || lock.version !== 1 ||
      lock.package.length > applicationPreparationBounds.lockPackages) {
    reject('missing-lock', 'uv-locked-sync requires an exact version-1 uv.lock package inventory and project metadata.');
  }
  const project = projectFile.project;
  const uv = isRecord(projectFile.tool) && isRecord(projectFile.tool.uv) ? projectFile.tool.uv : {};
  if (['workspace', 'sources', 'index', 'index-url', 'extra-index-url', 'find-links', 'allow-insecure-host', 'dependency-metadata']
    .some((field) => Object.hasOwn(uv, field)) || project.dynamic !== undefined || projectFile['dependency-groups'] !== undefined) {
    reject('unsupported-package-source', 'Python workspaces, local/VCS source overrides, dynamic metadata, custom indexes, and dependency groups are unsupported.');
  }
  if (pythonRange(project['requires-python']) !== pythonRange(lock['requires-python'])) {
    reject('mismatched-lock', 'The candidate Python requirement differs from its locked interpreter range.');
  }
  const optional = project['optional-dependencies'] ?? {};
  if (!Array.isArray(project.dependencies) || !isRecord(optional) ||
      Object.keys(optional).some((key) => !['test', 'functions'].includes(key))) {
    reject('unsupported-package-source', 'Python preparation supports explicit runtime pins and the selected test/functions extras only.');
  }
  const extras = ['test', ...(functions ? ['functions'] : [])];
  for (const extra of extras) if (!Array.isArray(optional[extra])) reject('missing-dependencies', 'The selected Python component lacks its required declared test/functions extra.');
  if (typeof project.name !== 'string' || typeof project.version !== 'string') reject('mismatched-lock', 'Python project identity is missing.');
  const packages = lock.package;
  const root = packages.find((entry) => isRecord(entry) && entry.name === project.name);
  if (!isRecord(root) || root.version !== project.version || !isRecord(root.source) ||
      Object.keys(root.source).length !== 1 || !(root.source.editable === '.' || root.source.virtual === '.') ||
      !isRecord(root.metadata) || !Array.isArray(root.metadata['requires-dist'])) {
    reject('mismatched-lock', 'The uv lock lacks the exact selected root project and dependency metadata. The root project is never installed by preparation.');
  }
  const expected = [
    ...project.dependencies.map((item) => ({ ...pythonPin(item), group: null })),
    ...Object.entries(optional).flatMap(([group, dependencies]) => {
      if (!Array.isArray(dependencies)) reject('preparation-input', 'Python extras must contain exact dependency pins.');
      return dependencies.map((item) => ({ ...pythonPin(item), group }));
    })
  ];
  const actual = root.metadata['requires-dist'].map((item) => {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.specifier !== 'string' || !item.specifier.startsWith('==') ||
        item.url !== undefined || item.path !== undefined || item.git !== undefined) {
      reject('unsupported-package-source', 'Locked root dependencies must be exact registry pins.');
    }
    let group: string | null = null;
    if (item.marker !== undefined) {
      if (typeof item.marker !== 'string') reject('mismatched-lock', 'Locked dependency markers are unsupported.');
      const match = item.marker.match(/^extra == ['"](test|functions)['"]$/u);
      if (!match) reject('mismatched-lock', 'Locked root dependency markers differ from supported selected extras.');
      group = match[1]!;
    }
    const extra = item.extras ?? [];
    if (!Array.isArray(extra) || !extra.every((entry) => typeof entry === 'string')) reject('mismatched-lock', 'Locked dependency extras are malformed.');
    return { name: pythonName(item.name), version: item.specifier.slice(2), extras: extra.map(pythonName).sort(), group };
  });
  const ordered = (items: typeof expected) => [...items].sort((a, b) => canonicalSha256(a).localeCompare(canonicalSha256(b), 'en'));
  if (canonicalSha256(ordered(expected)) !== canonicalSha256(ordered(actual))) {
    reject('mismatched-lock', 'The candidate Python dependency pins do not match the exact uv.lock root metadata.');
  }
  for (const dependency of expected) {
    if (!packages.some((entry) => isRecord(entry) && entry.name === dependency.name && entry.version === dependency.version)) {
      reject('mismatched-lock', 'A direct Python dependency does not have its exact pinned locked package.');
    }
  }
  for (const item of packages) {
    if (item === root) continue;
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.version !== 'string' ||
        !/^[a-z0-9][a-z0-9-]*$/u.test(item.name) || !/^[0-9][0-9A-Za-z.+!-]*$/u.test(item.version) ||
        !isRecord(item.source) || Object.keys(item.source).length !== 1 ||
        item.source.registry !== applicationPackageSources[request.packageSource].registry) {
      reject('unsupported-package-source', 'Python lock packages must use the exact selected credential-free registry, not local, VCS, authenticated, or mismatched sources.');
    }
    const artifacts = [
      ...(item.sdist === undefined ? [] : [item.sdist]),
      ...(Array.isArray(item.wheels) ? item.wheels : [])
    ];
    if (!artifacts.length || item.wheels !== undefined && !Array.isArray(item.wheels)) {
      reject('missing-lock', 'Python registry packages require a bounded integrity-bound artifact inventory.');
    }
    for (const artifact of artifacts) {
      if (!isRecord(artifact) || typeof artifact.hash !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(artifact.hash)) {
        reject('missing-lock', 'Python artifacts need exact SHA-256 integrity bindings.');
      }
      publicUrl(artifact.url, request.packageSource);
    }
  }
  return { packageCount: packages.length - 1, hooks: 0, pythonExtras: extras, toolRequirements: { python: pythonRange(project['requires-python']) } };
}

function goInputs(manifest: Buffer, lock: Buffer) {
  const source = applicationText(manifest), sums = applicationText(lock);
  if (source === null || sums === null) reject('preparation-input', 'Go module and checksum inputs must be bounded UTF-8 text.');
  const modulePath = /^[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9][A-Za-z0-9._~+-]*)+$/u;
  const version = /^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u;
  const required: { name: string; version: string }[] = [];
  let inRequire = false, hasModule = false, hasGo = false;
  const toolRequirements: Record<string, string> = {};
  for (const raw of source.split(/\r?\n/u)) {
    const line = raw.replace(/\s*\/\/.*$/u, '').trim();
    if (!line) continue;
    if (line === 'require (') { if (inRequire) reject('preparation-input', 'Go require blocks must be well formed.'); inRequire = true; continue; }
    if (line === ')') { if (!inRequire) reject('preparation-input', 'Unexpected Go module block.'); inRequire = false; continue; }
    const parts = line.split(/\s+/u);
    if (!inRequire && parts[0] === 'module' && parts.length === 2 && modulePath.test(parts[1]!)) { hasModule = true; continue; }
    if (!inRequire && parts[0] === 'go' && parts.length === 2 && /^\d+\.\d+(?:\.\d+)?$/u.test(parts[1]!)) {
      hasGo = true; toolRequirements.go = `>=${parts[1]}`; continue;
    }
    if (!inRequire && parts[0] === 'toolchain' && parts.length === 2 && /^go\d+\.\d+\.\d+$/u.test(parts[1]!)) {
      toolRequirements['go-toolchain'] = `>=${parts[1]!.slice(2)}`; continue;
    }
    const dependency = inRequire ? parts : parts[0] === 'require' ? parts.slice(1) : [];
    if (dependency.length !== 2 || !modulePath.test(dependency[0]!) || !version.test(dependency[1]!)) {
      reject('unsupported-package-source', 'Go preparation rejects replacements, workspaces, local/VCS sources, and unsupported module directives.');
    }
    required.push({ name: dependency[0]!, version: dependency[1]! });
  }
  if (!hasModule || !hasGo || inRequire || required.length > applicationPreparationBounds.lockPackages) {
    reject('preparation-input', 'Go preparation requires complete bounded module metadata.');
  }
  const hashes = new Set<string>();
  for (const line of sums.split(/\r?\n/u).filter((item) => item.trim())) {
    const parts = line.trim().split(/\s+/u);
    if (parts.length !== 3 || !modulePath.test(parts[0]!) ||
        !version.test(parts[1]!.replace(/\/go\.mod$/u, '')) || !/^h1:[A-Za-z0-9+/]{43}=$/u.test(parts[2]!)) {
      reject('missing-lock', 'go.sum must contain exact bounded module/checksum records.');
    }
    hashes.add(`${parts[0]} ${parts[1]}`);
    if (hashes.size > applicationPreparationBounds.lockPackages * 2) reject('preparation-bound', 'Go checksum inventory exceeds its bound.');
  }
  for (const dependency of required) {
    if (!hashes.has(`${dependency.name} ${dependency.version}`) || !hashes.has(`${dependency.name} ${dependency.version}/go.mod`)) {
      reject('mismatched-lock', 'A required Go module lacks its exact module and go.mod checksums; no checksum generation is authorized.');
    }
  }
  return { packageCount: required.length, hooks: 0, pythonExtras: [], toolRequirements };
}

export function resolveApplicationPreparationInputs(
  candidate: ApplicationPatchCandidate, requests: readonly ApplicationPreparationRequest[]
): ApplicationResolvedPreparation[] {
  const files = new Map(applicationCandidateFiles(candidate).filter((item) => item.content !== undefined)
    .map((item) => [applicationPathKey(item.pathParts), item]));
  const targets = candidate.scope.target?.artifacts ?? [];
  const seen = new Set<string>();
  const read = (parts: string[]): ProjectFileSnapshot => {
    const value = files.get(applicationPathKey(parts));
    if (!value?.content || value.mode === undefined || value.content.byteLength > applicationPreparationBounds.manifestBytes) {
      reject('missing-lock', 'The selected candidate component requires exact inspected manifest and lock inputs.');
    }
    return value;
  };
  return requests.map((request) => {
    const definition = applicationPreparationSupport.providers.find((item) => item.id === request.provider)!;
    const cwd = applicationPathKey(request.cwdPathParts);
    if (seen.has(cwd)) reject('preparation-schema', 'Only one explicit preparation provider may own each selected component.');
    seen.add(cwd);
    const identityNames: readonly string[] = definition.targetIdentities;
    const component = targets.find((item) => identityNames.includes(item.logicalName) &&
      applicationPathKey(item.pathParts.slice(0, -1)) === cwd);
    const sources: readonly string[] = definition.packageSources;
    if (!component || !sources.includes(request.packageSource)) {
      reject('unselected-preparation-component', 'Preparation must match a selected current component identity and its registered package source.');
    }
    if ([...files.keys()].some((file) => path.posix.basename(file) === 'go.work' || path.posix.basename(file) === 'go.work.sum')) {
      if (request.provider === 'go-mod-download') reject('unsupported-package-source', 'Go workspace inputs cannot participate in this module-only preparation lane.');
    }
    const inputs = definition.inputs.map((name) => read([...request.cwdPathParts, name]));
    const functions = targets.some((item) => item.logicalName === 'function-worker-app');
    const details = request.provider === 'npm-ci' ? npmInputs(inputs[0]!.content!, inputs[1]!.content!, request) :
      request.provider === 'uv-locked-sync' ? pythonInputs(inputs[0]!.content!, inputs[1]!.content!, request, functions) :
        goInputs(inputs[0]!.content!, inputs[1]!.content!);
    const key = request.cwdPathParts.join('-');
    const outputRoles: ApplicationPrivateOutputRole[] = request.provider === 'npm-ci' ? [
      { id: `npm-dependencies-${key}`, kind: 'dependency', pathParts: ['project', ...request.cwdPathParts, 'node_modules'], protectedAfterPreparation: true },
      { id: `npm-cache-${key}`, kind: 'cache', pathParts: ['cache', 'npm', key], protectedAfterPreparation: false },
      { id: `node-test-cache-${key}`, kind: 'cache', pathParts: ['project', ...request.cwdPathParts, 'node_modules', '.vite'], protectedAfterPreparation: false },
      { id: `node-build-cache-${key}`, kind: 'cache', pathParts: ['project', ...request.cwdPathParts, 'node_modules', '.vite-temp'], protectedAfterPreparation: false },
      { id: `node-build-${key}`, kind: 'build-output', pathParts: ['project', ...request.cwdPathParts, 'dist'], protectedAfterPreparation: false }
    ] : request.provider === 'uv-locked-sync' ? [
      { id: `python-environment-${key}`, kind: 'dependency', pathParts: ['project', ...request.cwdPathParts, '.venv'], protectedAfterPreparation: true },
      { id: `python-cache-${key}`, kind: 'cache', pathParts: ['cache', 'uv', key], protectedAfterPreparation: false },
      { id: `python-tests-${key}`, kind: 'cache', pathParts: ['project', ...request.cwdPathParts, '.pytest_cache'], protectedAfterPreparation: false },
      ...targets.filter((item) => item.logicalName === 'function-worker-app').map((item): ApplicationPrivateOutputRole => ({
        id: 'python-worker-tests', kind: 'cache', pathParts: ['project', ...item.componentRootPathParts, '.pytest_cache'], protectedAfterPreparation: false
      }))
    ] : [
      { id: `go-modules-${key}`, kind: 'dependency', pathParts: ['cache', 'go-mod', key], protectedAfterPreparation: true },
      { id: `go-build-${key}`, kind: 'cache', pathParts: ['cache', 'go-build', key], protectedAfterPreparation: false },
      { id: `go-path-${key}`, kind: 'cache', pathParts: ['cache', 'go-path', key], protectedAfterPreparation: false }
    ];
    const registry = applicationPackageSources[request.packageSource].registry;
    const args = request.provider === 'npm-ci'
      ? ['--replace-registry-host=never', ...(applicationPackageSources[request.packageSource].remoteProxyOptIn ? ['--allow-remote=all'] : []),
        'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--no-progress', '--no-update-notifier', `--registry=${registry}`,
        ...(!request.network ? ['--offline'] : [])]
      : request.provider === 'uv-locked-sync'
        ? ['--no-config', 'sync', '--locked', '--no-build', '--no-install-project', '--no-install-workspace',
          '--no-editable', '--no-python-downloads', '--no-managed-python', '--no-default-groups',
          ...details.pythonExtras.flatMap((extra) => ['--extra', extra]), '--python', '$APPROVED_PYTHON',
          '--default-index', registry, ...(!request.network ? ['--offline'] : [])]
        : ['mod', 'download', '-json'];
    const body: Omit<ApplicationResolvedPreparation, 'digest'> = {
      schemaVersion: 1, ...request, component, registry,
      inputs: inputs.map((item) => ({ pathParts: item.pathParts, digest: applicationDigest(item.content!), mode: item.mode! })),
      commands: [
        ...(request.provider === 'uv-locked-sync' ? [{
          tool: 'python' as const,
          args: ['-I', '-S', '-m', 'venv', '--copies', '--without-pip', '$PRIVATE_PYTHON_ENVIRONMENT'],
          cwdPathParts: request.cwdPathParts, timeoutMs: applicationPreparationBounds.preparationTimeoutMs,
          maxOutputBytes: applicationPreparationBounds.preparationOutputBytes
        }] : []),
        { tool: request.provider === 'npm-ci' ? 'npm' : request.provider === 'uv-locked-sync' ? 'uv' : 'go',
          args, cwdPathParts: request.cwdPathParts, timeoutMs: applicationPreparationBounds.preparationTimeoutMs,
          maxOutputBytes: applicationPreparationBounds.preparationOutputBytes }
      ],
      tools: request.provider === 'npm-ci' ? ['node', 'npm'] : request.provider === 'uv-locked-sync' ? ['python', 'uv'] : ['go'],
      outputRoles, packageCount: details.packageCount, suppressedLifecyclePackages: details.hooks,
      pythonExtras: details.pythonExtras, toolRequirements: details.toolRequirements
    };
    return { ...body, digest: canonicalSha256(body) };
  });
}
