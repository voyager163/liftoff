import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseHcl } from '@cdktf/hcl2json';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { builtinAssets } from '../src/plugins/builtin/assets.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import { templateDependencySets } from '../scripts/template-dependency-security.mjs';

// Content relations between the packaged dependency sets, the supported-stack baseline and the
// Dependabot configuration. Set structure and packaging are covered by the audit preflight tests.

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (relativePath: string) => readFileSync(path.join(repositoryRoot, ...relativePath.split('/')), 'utf8');
const baseline = JSON.parse(read('assets/supported-stack.json')) as Record<string, unknown>;

interface DependencySet {
  readonly id: string;
  readonly ecosystem: string;
  readonly baselineViews: readonly (readonly string[])[];
  readonly toolPins?: readonly (readonly string[])[];
}

interface Member {
  readonly set: string;
  readonly role: string;
  readonly path: string;
}

interface PythonView {
  readonly requiresPython: string;
  readonly dependencies: Record<string, string>;
  readonly optionalDependencies: Record<string, Record<string, string>>;
}

const sets = templateDependencySets as readonly DependencySet[];
const members: readonly Member[] = builtinAssets.map((asset) => ({
  set: asset.set,
  role: asset.role,
  path: asset.pathParts.join('/')
}));

function memberPath(set: string, role: string): string {
  const found = members.filter((member) => member.set === set && member.role === role);
  expect(found, `${set} ${role}`).toHaveLength(1);
  return found[0].path;
}

function resolvePointer(root: unknown, pointer: readonly string[]): unknown {
  let value = root;
  for (const key of pointer) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

// Every string array that starts with "assets" is a packaged asset path field.
function assetPathFields(value: unknown, pointer: readonly string[] = []): Array<{ pointer: string; path: string }> {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((entry) => typeof entry === 'string') && value[0] === 'assets'
      ? [{ pointer: pointer.join('.'), path: value.join('/') }]
      : value.flatMap((entry, index) => assetPathFields(entry, [...pointer, String(index)]));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => assetPathFields(entry, [...pointer, key]));
  }
  return [];
}

function baselineMappingIssues(
  stack: unknown,
  dependencySets: readonly DependencySet[],
  declared: readonly Member[]
): string[] {
  const issues: string[] = [];
  const claimed = new Map<string, string>();
  for (const set of dependencySets) {
    if (set.baselineViews.length === 0) issues.push(`${set.id}: declares no baseline view`);
    for (const view of set.baselineViews) {
      const key = view.join('.');
      if (claimed.has(key)) issues.push(`${key}: claimed by ${claimed.get(key)} and ${set.id}`);
      claimed.set(key, set.id);
      const value = resolvePointer(stack, view);
      if (typeof value !== 'object' || value === null) {
        issues.push(`${key}: unknown baseline view`);
        continue;
      }
      for (const field of assetPathFields(value, view)) {
        const owners = declared.filter((member) => member.path === field.path);
        if (owners.length !== 1) {
          issues.push(`${field.pointer}: ${field.path} is not exactly one declared member`);
        } else if (owners[0].set !== set.id) {
          issues.push(`${field.pointer}: ${field.path} belongs to ${owners[0].set}, not ${set.id}`);
        }
      }
    }
  }
  for (const field of assetPathFields(stack)) {
    if (![...claimed.keys()].some((view) => field.pointer.startsWith(`${view}.`))) {
      issues.push(`${field.pointer}: ${field.path} is outside every claimed view`);
    }
  }
  return issues;
}

const normalizedName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

function pinnedRequirements(values: readonly string[]): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const value of values) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?==([^\s;]+)$/.exec(value);
    if (!match) throw new Error(`Unpinned Python requirement: ${value}`);
    pins[match[1]] = match[2];
  }
  return pins;
}

function lockedPackages(lockText: string): Map<string, Map<string, Set<string>>> {
  const lock = parseToml(lockText) as {
    package: Array<{ name: string; version: string; sdist?: { hash?: string }; wheels?: Array<{ hash?: string }> }>;
  };
  const packages = new Map<string, Map<string, Set<string>>>();
  for (const entry of lock.package) {
    const versions = packages.get(normalizedName(entry.name)) ?? new Map<string, Set<string>>();
    const hashes = versions.get(entry.version) ?? new Set<string>();
    for (const hash of [entry.sdist?.hash, ...(entry.wheels ?? []).map((wheel) => wheel.hash)]) {
      if (hash) hashes.add(hash);
    }
    versions.set(entry.version, hashes);
    packages.set(normalizedName(entry.name), versions);
  }
  return packages;
}

function exportedPins(exportText: string): { pins: Map<string, { version: string; hashes: string[] }>; issues: string[] } {
  const pins = new Map<string, { version: string; hashes: string[] }>();
  const issues: string[] = [];
  let current: { version: string; hashes: string[] } | undefined;
  for (const line of exportText.split('\n')) {
    if (line === '') continue;
    const pin = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?==([^\s;\\]+)(?: ; [^\\]+)? \\$/.exec(line);
    const hash = /^ {4}--hash=(sha256:[0-9a-f]{64})(?: \\)?$/.exec(line);
    if (pin) {
      current = { version: pin[2], hashes: [] };
      if (pins.has(normalizedName(pin[1]))) issues.push(`${pin[1]} is exported twice`);
      pins.set(normalizedName(pin[1]), current);
    } else if (hash && current) {
      current.hashes.push(hash[1]);
    } else {
      issues.push(`unexpected export line: ${line}`);
    }
  }
  return { pins, issues };
}

function exportLockIssues(exportText: string, lockText: string): string[] {
  const { pins, issues } = exportedPins(exportText);
  const locked = lockedPackages(lockText);
  for (const [name, pin] of pins) {
    const hashes = locked.get(name)?.get(pin.version);
    if (!hashes) {
      issues.push(`${name}==${pin.version} is not locked`);
      continue;
    }
    if (pin.hashes.length === 0) issues.push(`${name}==${pin.version} exports no hash`);
    for (const hash of pin.hashes) {
      if (!hashes.has(hash)) issues.push(`${name}==${pin.version} hash ${hash} is not locked`);
    }
  }
  return issues;
}

function toolPinIssues(rendered: string, tool: string, version: unknown): string[] {
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = [...rendered.matchAll(new RegExp(`${escaped}(?:/[^@\\s"']*)?@([^\\s"']+)`, 'g'))].map((match) => match[1]);
  if (found.length === 0) return [`${tool} is not pinned in the rendered plan`];
  return [...new Set(found)].filter((pinned) => pinned !== version)
    .map((pinned) => `${tool} is pinned at ${pinned}, not ${String(version)}`);
}

interface OpenTofuProvider {
  readonly source: string;
  readonly version: string;
}

async function opentofuIssues(
  versionsText: string,
  lockText: string,
  baselineProviders: Record<string, OpenTofuProvider>
): Promise<string[]> {
  const versions = await parseHcl('versions.tf', versionsText) as {
    terraform?: Array<{ required_providers?: Array<Record<string, OpenTofuProvider>> }>;
  };
  const lock = await parseHcl('.terraform.lock.hcl', lockText) as {
    provider?: Record<string, Array<{ version: string; constraints?: string }>>;
  };
  const required: Record<string, OpenTofuProvider> = Object.assign(
    {},
    ...(versions.terraform ?? []).flatMap((block) => block.required_providers ?? [])
  );
  const issues: string[] = [];
  if (Object.keys(required).length === 0) issues.push('versions.tf requires no providers');
  const baselineVersions = new Map(Object.values(baselineProviders).map((provider) => [provider.source.toLowerCase(), provider.version]));
  for (const [name, provider] of Object.entries(required)) {
    const pinned = baselineVersions.get(provider.source.toLowerCase());
    if (pinned === undefined) issues.push(`${name} (${provider.source}) is not a baseline provider`);
    else if (pinned !== provider.version) issues.push(`${name} (${provider.source}) pins ${provider.version}; the baseline pins ${pinned}`);
  }
  const address = (provider: OpenTofuProvider) => `registry.opentofu.org/${provider.source}`.toLowerCase();
  const lockedAddresses = Object.keys(lock.provider ?? {}).sort();
  const requiredAddresses = Object.values(required).map(address).sort();
  if (!isDeepStrictEqual(lockedAddresses, requiredAddresses)) {
    issues.push(`provider lock covers ${lockedAddresses.join(', ')}; versions.tf requires ${requiredAddresses.join(', ')}`);
  }
  for (const provider of Object.values(required)) {
    const [entry] = lock.provider?.[address(provider)] ?? [];
    if (entry && entry.version !== provider.version) {
      issues.push(`provider lock pins ${provider.source} ${entry.version}; versions.tf pins ${provider.version}`);
    }
    if (entry && entry.constraints !== provider.version) {
      issues.push(`provider lock constrains ${provider.source} to ${String(entry.constraints)}; versions.tf pins ${provider.version}`);
    }
  }
  return issues;
}

interface DependabotConfig {
  readonly updates: ReadonlyArray<{ readonly 'package-ecosystem': string; readonly directory: string }>;
}

function dependabotIssues(config: DependabotConfig, dependencySets: readonly DependencySet[]): string[] {
  const configured = config.updates
    .filter((update) => update['package-ecosystem'] === 'npm' && update.directory.startsWith('/assets/'))
    .map((update) => update.directory)
    .sort();
  const declared = dependencySets
    .filter((set) => set.ecosystem === 'npm')
    .map((set) => `/${path.posix.dirname(memberPath(set.id, 'lock'))}`)
    .sort();
  return isDeepStrictEqual(configured, declared)
    ? []
    : [`Dependabot npm template directories ${configured.join(', ')} differ from the npm set directories ${declared.join(', ')}`];
}

describe('dependency-set baseline mappings', () => {
  it('maps every baseline asset path to exactly one member of the set whose view claims it', () => {
    expect(baselineMappingIssues(baseline, sets, members)).toEqual([]);
    expect(assetPathFields(baseline).length).toBeGreaterThan(0);
    for (const set of sets) expect(set.baselineViews.length, set.id).toBeGreaterThan(0);
    expect(sets.find((set) => set.id === 'python-genai')?.baselineViews.map((view) => view.join('.')))
      .toEqual(['pythonProjects.genai-backend', 'pythonProjects.function-worker']);
  });

  it('rejects unknown member paths, sets without views, unknown views and foreign views', () => {
    const unknownPath = structuredClone(baseline) as { npmProjects: Record<string, { lockPathParts: string[] }> };
    unknownPath.npmProjects['node-backend'].lockPathParts = ['assets', 'plugins', 'node-fastify', 'node-backend', 'missing.json'];
    expect(baselineMappingIssues(unknownPath, sets, members)).toEqual([
      'npmProjects.node-backend.lockPathParts: assets/plugins/node-fastify/node-backend/missing.json is not exactly one declared member'
    ]);

    const replaceViews = (views: string[][]) =>
      sets.map((set) => (set.id === 'python-standard' ? { ...set, baselineViews: views } : set));
    const standardLock = 'pythonProjects.standard-backend.lockTemplatePathParts: assets/plugins/python-fastapi/python-standard/uv.lock is outside every claimed view';
    expect(baselineMappingIssues(baseline, replaceViews([]), members))
      .toEqual(['python-standard: declares no baseline view', standardLock]);
    expect(baselineMappingIssues(baseline, replaceViews([['pythonProjects', 'missing']]), members))
      .toEqual(['pythonProjects.missing: unknown baseline view', standardLock]);
    expect(baselineMappingIssues(baseline, replaceViews([['pythonProjects', 'genai-backend']]), members)).toEqual([
      'pythonProjects.genai-backend.lockTemplatePathParts: assets/plugins/python-fastapi/python-genai/uv.lock belongs to python-genai, not python-standard',
      'pythonProjects.genai-backend: claimed by python-standard and python-genai',
      standardLock
    ]);
  });
});

describe('Python dependency sets', () => {
  it('keeps each project manifest equal to one baseline view and satisfies the others from the export and lock', () => {
    for (const set of sets.filter((candidate) => candidate.ecosystem === 'pypi')) {
      const project = parseToml(read(memberPath(set.id, 'manifest'))) as {
        project: { 'requires-python': string; dependencies: string[]; 'optional-dependencies'?: Record<string, string[]> };
      };
      const manifestView: PythonView = {
        requiresPython: project.project['requires-python'],
        dependencies: pinnedRequirements(project.project.dependencies),
        optionalDependencies: Object.fromEntries(Object.entries(project.project['optional-dependencies'] ?? {})
          .map(([group, values]) => [group, pinnedRequirements(values)]))
      };
      const views = set.baselineViews.map((view) => resolvePointer(baseline, view) as PythonView & Record<string, unknown>);
      const projectViews = views.filter((view) => isDeepStrictEqual({
        requiresPython: view.requiresPython,
        dependencies: view.dependencies,
        optionalDependencies: view.optionalDependencies
      }, manifestView));
      expect(projectViews, set.id).toHaveLength(1);

      const others = views.filter((view) => !projectViews.includes(view));
      if (others.length === 0) continue;
      const exported = exportedPins(read(memberPath(set.id, 'export')));
      const locked = lockedPackages(read(memberPath(set.id, 'lock')));
      for (const view of others) {
        expect(view.requiresPython, set.id).toBe(manifestView.requiresPython);
        for (const [name, version] of Object.entries(view.dependencies)) {
          expect(exported.pins.get(normalizedName(name))?.version, `${set.id} export ${name}`).toBe(version);
        }
        for (const [name, version] of Object.values(view.optionalDependencies).flatMap(Object.entries)) {
          expect(locked.get(normalizedName(name))?.has(version), `${set.id} lock ${name}@${version}`).toBe(true);
        }
      }
    }
  });

  it('pins every exported function requirement and hash to the genai lock', () => {
    const exportText = read(memberPath('python-genai', 'export'));
    expect(exportedPins(exportText).pins.size).toBeGreaterThan(0);
    expect(exportLockIssues(exportText, read(memberPath('python-genai', 'lock')))).toEqual([]);
  });

  it('rejects exported pins, versions and hashes that the lock does not contain', () => {
    const lockText = read(memberPath('python-genai', 'lock'));
    const [firstPin] = read(memberPath('python-genai', 'export')).split('\n');
    const [, name, version] = /^([^=]+)==(\S+) /.exec(firstPin)!;
    const hashLine = (hex: string) => `    --hash=sha256:${hex.repeat(64)}`;
    expect(exportLockIssues(`missing-package==1.0.0 \\\n${hashLine('0')}\n`, lockText))
      .toEqual(['missing-package==1.0.0 is not locked']);
    expect(exportLockIssues(`${name}==999.0.0 \\\n${hashLine('0')}\n`, lockText))
      .toEqual([`${normalizedName(name)}==999.0.0 is not locked`]);
    expect(exportLockIssues(`${name}==${version} \\\n${hashLine('f')}\n`, lockText))
      .toEqual([`${normalizedName(name)}==${version} hash sha256:${'f'.repeat(64)} is not locked`]);
    expect(exportLockIssues('--index-url https://example.invalid/simple\n', lockText))
      .toEqual(['unexpected export line: --index-url https://example.invalid/simple']);
  });
});

describe('Go dependency set', () => {
  it('pins the baseline goose tool in the rendered Go plan and never as a go.mod requirement', () => {
    const goSet = sets.find((set) => set.id === 'go-backend')!;
    expect(goSet.toolPins?.map((pointer) => pointer.join('.')))
      .toEqual(['goModules.go-backend.tools.github.com/pressly/goose/v3']);
    const pointer = goSet.toolPins![0];
    const version = resolvePointer(baseline, pointer);
    expect(typeof version).toBe('string');
    const tool = pointer.at(-1)!;
    const plan = buildProjectPlan({
      projectName: 'Goose Pin', cloud: 'azure', region: 'eastus', projectType: 'standard', apiStack: 'go'
    }, { requireProjectName: true });
    const rendered = buildArtifacts(plan).map((artifact) => artifact.content).join('\n');
    expect(toolPinIssues(rendered, tool, version)).toEqual([]);
    expect(read(memberPath('go-backend', 'manifest'))).not.toContain('github.com/pressly/goose');

    expect(toolPinIssues(`go run ${tool}/cmd/goose@v3.0.0 up`, tool, version))
      .toEqual([`${tool} is pinned at v3.0.0, not ${String(version)}`]);
    expect(toolPinIssues('go run ./cmd/migrate', tool, version)).toEqual([`${tool} is not pinned in the rendered plan`]);
  });
});

describe('OpenTofu dependency set', () => {
  const versionsText = read(memberPath('opentofu-azure', 'manifest'));
  const lockText = read(memberPath('opentofu-azure', 'lock'));
  const providers = (baseline.opentofu as { providers: Record<string, OpenTofuProvider> }).providers;

  it('keeps the template providers a version-equal subset of the baseline providers', async () => {
    expect(await opentofuIssues(versionsText, lockText, providers)).toEqual([]);
  });

  it('rejects provider version drift, providers outside the baseline and lock drift', async () => {
    expect(versionsText).toContain('version = "5.3.0"');
    expect(await opentofuIssues(versionsText.replace('version = "5.3.0"', 'version = "5.2.0"'), lockText, providers)).toEqual([
      'azurerm (hashicorp/azurerm) pins 5.2.0; the baseline pins 5.3.0',
      'provider lock pins hashicorp/azurerm 5.3.0; versions.tf pins 5.2.0',
      'provider lock constrains hashicorp/azurerm to 5.3.0; versions.tf pins 5.2.0'
    ]);
    const withRandom = versionsText.replace(
      'required_providers {',
      'required_providers {\n    random = {\n      source  = "hashicorp/random"\n      version = "3.6.0"\n    }'
    );
    expect(await opentofuIssues(withRandom, lockText, providers)).toEqual([
      'random (hashicorp/random) is not a baseline provider',
      'provider lock covers registry.opentofu.org/hashicorp/azurerm; versions.tf requires registry.opentofu.org/hashicorp/azurerm, registry.opentofu.org/hashicorp/random'
    ]);
    expect(lockText).toContain('version     = "5.3.0"');
    expect(await opentofuIssues(versionsText, lockText.replace('version     = "5.3.0"', 'version     = "5.2.0"'), providers))
      .toEqual(['provider lock pins hashicorp/azurerm 5.2.0; versions.tf pins 5.3.0']);
  });
});

describe('npm dependency sets', () => {
  it('maps the npm dependency sets to exactly the Dependabot template directories', () => {
    const config = parseYaml(read('.github/dependabot.yml')) as DependabotConfig;
    expect(dependabotIssues(config, sets)).toEqual([]);
    const withoutFrontend = {
      updates: config.updates.filter((update) => update.directory !== '/assets/templates/common/frontend')
    };
    expect(dependabotIssues(withoutFrontend, sets)).toEqual([
      'Dependabot npm template directories /assets/plugins/node-fastify/node-backend differ from the npm set directories /assets/plugins/node-fastify/node-backend, /assets/templates/common/frontend'
    ]);
  });
});
