import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { stringify as stringifyToml } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseApplicationPreparation, resolveApplicationPreparationInputs
} from '../src/application/repair/application-preparation-inputs.js';
import {
  applicationPackageSources, applicationPreparationBounds
} from '../src/application/repair/application-preparation-policy.js';
import { inspectApplicationLayout } from '../src/application/repair/application-inventory.js';
import { inspectApplicationPatch } from '../src/application/repair/application-patch.js';
import { ApplicationFiles, ApplicationInspectionError, applicationDigest } from '../src/application/repair/application-files.js';
import { applicationCandidateFiles } from '../src/application/repair/application-candidate.js';
import type { ApplicationCandidate } from '../src/application/repair/application-types.js';
import type { ApplicationPreparationRequest, ApplicationResolvedPreparation } from '../src/application/repair/application-preparation-types.js';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { NodeCommandRunner, type CommandRunner } from '../src/process-runner.js';
import { createPreparationFixture, type PreparationFixture } from './fixtures/repair-preparation.js';
import { putApplicationFixtureFile } from './fixtures/repair-application.js';

type RecordValue = Record<string, unknown>;
interface Rejection<T> {
  label: string;
  change(value: T): void;
  error: string | RegExp;
}
interface OwnedRoot {
  path: string;
  device: number;
  inode: number;
  mode: number;
  birthtimeMs: number;
}
const roots: OwnedRoot[] = [];
let activeWork = 0;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const current = roots.splice(0);
  if (activeWork) throw new Error(`Retaining active input-boundary fixtures: ${current.map((entry) => entry.path).join(', ')}`);
  for (const root of current) {
    const actual = await lstat(root.path);
    if (!actual.isDirectory() || actual.isSymbolicLink() || await realpath(root.path) !== root.path ||
        actual.dev !== root.device || actual.ino !== root.inode ||
        actual.mode !== root.mode || actual.birthtimeMs !== root.birthtimeMs) {
      throw new Error(`Input-boundary fixture identity changed; preserving ${root.path}`);
    }
    await rm(root.path, { recursive: true });
  }
});

async function withFixture<T>(
  options: Parameters<typeof createPreparationFixture>[1],
  operation: (fixture: PreparationFixture) => Promise<T>
): Promise<T> {
  activeWork++;
  try {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-input-boundaries-')));
    const stat = await lstat(directory);
    roots.push({ path: directory, device: stat.dev, inode: stat.ino, mode: stat.mode, birthtimeMs: stat.birthtimeMs });
    const fixture = await createPreparationFixture(directory, options);
    return await operation(fixture);
  } finally { activeWork--; }
}

function record(value: unknown): RecordValue {
  if (!isRecord(value)) throw new Error('Invalid test document object.');
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid test document array.');
  return value;
}
function request(
  provider: ApplicationPreparationRequest['provider'] = 'npm-ci',
  options: Partial<Pick<ApplicationPreparationRequest, 'packageSource' | 'network' | 'cwdPathParts'>> = {}
): ApplicationPreparationRequest {
  return parseApplicationPreparation([{
    provider, version: 1, cwdPathParts: ['backend'],
    packageSource: provider === 'npm-ci' ? 'npmjs' : provider === 'uv-locked-sync' ? 'pypi' : 'go-proxy',
    network: false, lifecycle: 'disabled', ...options
  }])[0]!;
}

// This mirrors the observed private candidate before preparation/tool/approval admission.
async function observe(f: PreparationFixture): Promise<ApplicationCandidate> {
  const { report, snapshots } = await inspectApplicationLayout(f.root, f.manifest);
  expect(report.blockers).toEqual([]);
  expect(report.complete).toBe(true);
  expect(report.target).not.toBeNull();
  return {
    blockers: [], snapshots, mutations: [],
    scope: {
      projectRoot: report.projectRoot, inspectionDigest: report.inspectionDigest, target: report.target,
      staging: { root: f.stage }, directoryInventory: report.directoryInventory, preparation: [], toolchain: []
    },
    verificationPolicy: {
      kind: 'isolated-application-checks', commands: [], preparation: [], toolchain: [], executionCommands: [], outputRoles: [],
      effects: { projectCode: true, preparation: false, lifecycle: false, isolatedCopy: true, network: false, securitySandbox: false }
    },
    networkRequired: false
  };
}

function snapshotIdentity(candidate: ApplicationCandidate): string {
  return canonicalSha256(applicationCandidateFiles(candidate).map((entry) => ({
    path: entry.pathParts, digest: entry.content === undefined ? null : applicationDigest(entry.content), mode: entry.mode ?? null
  })));
}
function resolve(candidate: ApplicationCandidate, selected: ApplicationPreparationRequest): ApplicationResolvedPreparation {
  const before = snapshotIdentity(candidate);
  const [result] = resolveApplicationPreparationInputs(candidate, [selected]);
  expect(snapshotIdentity(candidate)).toBe(before);
  expect(result).toBeDefined();
  const { digest, ...body } = result!;
  expect(digest).toBe(canonicalSha256(body));
  expect(result!.inputs).toEqual(applicationCandidateFiles(candidate)
    .filter((entry) => result!.inputs.some((input) => input.pathParts.join('/') === entry.pathParts.join('/')))
    .sort((left, right) => result!.inputs.findIndex((input) => input.pathParts.join('/') === left.pathParts.join('/')) -
      result!.inputs.findIndex((input) => input.pathParts.join('/') === right.pathParts.join('/')))
    .map((entry) => ({ pathParts: entry.pathParts, mode: entry.mode, digest: applicationDigest(entry.content!) })));
  return result!;
}
function rejects(
  candidate: ApplicationCandidate, selected: ApplicationPreparationRequest, expected: string | RegExp
): ApplicationInspectionError {
  const before = snapshotIdentity(candidate);
  let observed: ApplicationInspectionError | undefined;
  assert.throws(() => resolveApplicationPreparationInputs(candidate, [selected]), (error: unknown) => {
    expect(error).toBeInstanceOf(ApplicationInspectionError);
    if (!(error instanceof ApplicationInspectionError)) throw error;
    if (typeof expected === 'string') expect(error.message).toContain(expected);
    else expect(error.message).toMatch(expected);
    observed = error;
    return true;
  });
  expect(snapshotIdentity(candidate)).toBe(before);
  return observed!;
}

const integrity = (algorithm = 'sha512') => `${algorithm}-${createHash(algorithm).update('test-only registry archive').digest('base64')}`;
interface NpmDocuments {
  project: RecordValue;
  lock: RecordValue;
  root: RecordValue;
  packages: RecordValue;
  dependency: RecordValue;
}
function npmDocuments(): NpmDocuments {
  const project: RecordValue = { name: 'boundary-node', version: '1.0.0', dependencies: { 'example-package': '^1.2.3' } };
  const root = structuredClone(project);
  const dependency: RecordValue = {
    version: '1.2.3', resolved: 'https://registry.npmjs.org/example-package/-/example-package-1.2.3.tgz',
    integrity: integrity(), hasInstallScript: true, bin: { example: 'bin/example.js' }
  };
  const packages = { '': root, 'node_modules/example-package': dependency };
  return { project, root, dependency, packages, lock: { name: 'boundary-node', version: '1.0.0', lockfileVersion: 3, packages } };
}
async function saveNpm(f: PreparationFixture, value: NpmDocuments, cwd = ['backend']): Promise<void> {
  await putApplicationFixtureFile(f.root, [...cwd, 'package.json'], JSON.stringify(value.project));
  await putApplicationFixtureFile(f.root, [...cwd, 'package-lock.json'], JSON.stringify(value.lock));
}

interface PythonDocuments {
  projectFile: RecordValue;
  project: RecordValue;
  uv: RecordValue;
  optional: RecordValue;
  lock: RecordValue;
  root: RecordValue;
  metadata: RecordValue;
  dependencies: unknown[];
  packages: unknown[];
}
function pythonDocuments(source: 'pypi' | 'microsoft-pypi' = 'pypi', functions = false): PythonDocuments {
  const optional: RecordValue = { test: ['pytest==8.4.1'], ...(functions ? { functions: ['azure-functions==1.23.0'] } : {}) };
  const project: RecordValue = {
    name: 'boundary-python', version: '1.0.0', 'requires-python': '==3.14.*',
    dependencies: ['httpx[socks]==0.28.1'], 'optional-dependencies': optional
  };
  const dependencies: unknown[] = [
    { name: 'httpx', specifier: '==0.28.1', extras: ['socks'] },
    { name: 'pytest', specifier: '==8.4.1', marker: "extra == 'test'" },
    ...(functions ? [{ name: 'azure-functions', specifier: '==1.23.0', marker: 'extra == "functions"' }] : [])
  ];
  const metadata = { 'requires-dist': dependencies };
  const root: RecordValue = { name: project.name, version: project.version, source: { virtual: '.' }, metadata };
  const packages: unknown[] = [root, ...dependencies.map((value) => {
    const dependency = record(value);
    return {
      name: dependency.name, version: String(dependency.specifier).slice(2),
      source: { registry: applicationPackageSources[source].registry },
      wheels: [{
        url: `https://files.pythonhosted.org/packages/${dependency.name}.whl`,
        hash: `sha256:${'a'.repeat(64)}`, size: 32
      }]
    };
  })];
  const uv = { package: false };
  return { project, optional, uv, projectFile: { project, tool: { uv } }, root, metadata, dependencies, packages,
    lock: { version: 1, 'requires-python': '>=3.14, <3.15', package: packages } };
}
async function savePython(f: PreparationFixture, value: PythonDocuments): Promise<void> {
  await putApplicationFixtureFile(f.root, ['backend', 'pyproject.toml'], stringifyToml(value.projectFile));
  await putApplicationFixtureFile(f.root, ['backend', 'uv.lock'], stringifyToml(value.lock));
}

interface GoDocuments { manifest: string; sums: string }
const goHash = `h1:${createHash('sha256').update('test-only module archive').digest('base64')}`;
function goDocuments(): GoDocuments {
  return {
    manifest: 'module example.com/boundary\n\ngo 1.26.0\ntoolchain go1.26.1\nrequire (\n example.com/dependency v1.2.3 // indirect\n)\n',
    sums: `example.com/dependency v1.2.3 ${goHash}\nexample.com/dependency v1.2.3/go.mod ${goHash}\n`
  };
}
async function saveGo(f: PreparationFixture, value: GoDocuments): Promise<void> {
  await putApplicationFixtureFile(f.root, ['backend', 'go.mod'], value.manifest);
  await putApplicationFixtureFile(f.root, ['backend', 'go.sum'], value.sums);
}

describe('preparation descriptor authority', () => {
  it('treats omitted preparation as none, and accepts only explicit registered descriptors', () => {
    expect(parseApplicationPreparation(undefined)).toEqual([]);
    expect(parseApplicationPreparation([])).toEqual([]);
    for (const provider of ['npm-ci', 'uv-locked-sync', 'go-mod-download'] as const) {
      const value = request(provider, { cwdPathParts: [] });
      expect(value).toEqual({ ...value, version: 1, cwdPathParts: [], network: false, lifecycle: 'disabled' });
    }
  });
  it.each([
    { label: 'a Boolean instead of descriptors', value: true },
    { label: 'a descriptor object without the array', value: { provider: 'npm-ci' } },
    { label: 'a null entry', value: [null] },
    { label: 'a missing lifecycle declaration', value: [{ provider: 'npm-ci', version: 1, cwdPathParts: [], packageSource: 'npmjs', network: false }] },
    { label: 'an extra installation argument', value: [{ ...request(), args: ['--global'] }] },
    { label: 'an unknown provider', value: [{ ...request(), provider: 'npm-install' }] },
    { label: 'a future provider version', value: [{ ...request(), version: 2 }] },
    { label: 'string network consent', value: [{ ...request(), network: 'yes' }] },
    { label: 'too many preparation providers', value: Array.from({ length: applicationPreparationBounds.providers + 1 }, () => request()) }
  ])('rejects $label before any preparation', ({ value }) => {
    expect(() => parseApplicationPreparation(value)).toThrow('[preparation-schema]');
  });
  it.each(['enabled', true, null])('rejects lifecycle authority %j', (lifecycle) => {
    expect(() => parseApplicationPreparation([{ ...request(), lifecycle }])).toThrow('[unsupported-lifecycle]');
  });
  it.each(['custom', 'https://private.example.invalid/feed', null])('rejects an unregistered package source %j', (packageSource) => {
    expect(() => parseApplicationPreparation([{ ...request(), packageSource }])).toThrow('[unsupported-package-source]');
  });
  it.each([['..', 'outside'], ['/absolute'], ['C:\\outside'], ['backend', 'CON'], ['backend', 'name.']])(
    'rejects a nonportable or escaping component path %j', (...cwdPathParts) => {
      expect(() => parseApplicationPreparation([{ ...request(), cwdPathParts }])).toThrow(/path/i);
    }
  );
});

describe('npm manifest and lock admission', () => {
  const cases: Rejection<NpmDocuments>[] = [
    { label: 'project workspaces', change: (d) => { d.project.workspaces = []; }, error: '[unsupported-package-source]' },
    { label: 'lock workspaces', change: (d) => { d.lock.workspaces = []; }, error: '[unsupported-package-source]' },
    { label: 'project bundledDependencies', change: (d) => { d.project.bundledDependencies = []; }, error: '[unsupported-package-source]' },
    { label: 'project bundleDependencies', change: (d) => { d.project.bundleDependencies = []; }, error: '[unsupported-package-source]' },
    { label: 'legacy lock version', change: (d) => { d.lock.lockfileVersion = 2; }, error: '[missing-lock]' },
    { label: 'nonobject package inventory', change: (d) => { d.lock.packages = []; }, error: '[missing-lock]' },
    { label: 'missing lock root', change: (d) => { delete d.packages['']; }, error: '[missing-lock]' },
    { label: 'mismatching package name', change: (d) => { d.root.name = 'other'; }, error: '[mismatched-lock]' },
    { label: 'mismatching package version', change: (d) => { d.root.version = '2.0.0'; }, error: '[mismatched-lock]' },
    { label: 'nontext package names', change: (d) => { d.root.name = d.project.name = 7; }, error: '[mismatched-lock]' },
    { label: 'nontext package versions', change: (d) => { d.root.version = d.project.version = 7; }, error: '[mismatched-lock]' },
    { label: 'nonmap dependencies', change: (d) => { d.project.dependencies = []; }, error: '[unsupported-package-source]' },
    { label: 'nontext dependency versions', change: (d) => { record(d.project.dependencies)['example-package'] = false; }, error: '[unsupported-package-source]' },
    { label: 'invalid package name', change: (d) => { d.project.dependencies = { BadPackage: '1.0.0' }; }, error: '[unsupported-package-source]' },
    { label: 'mutable dist tags', change: (d) => { record(d.project.dependencies)['example-package'] = 'latest'; }, error: '[unsupported-package-source]' },
    { label: 'oversized dependency ranges', change: (d) => { record(d.project.dependencies)['example-package'] = '1'.repeat(257); }, error: '[unsupported-package-source]' },
    { label: 'local dependencies', change: (d) => { record(d.project.dependencies)['example-package'] = 'file:../private'; }, error: '[unsupported-package-source]' },
    { label: 'package aliases', change: (d) => { record(d.project.dependencies)['example-package'] = 'npm:other@1.0.0'; }, error: '[unsupported-package-source]' },
    { label: 'nonregistry package locations', change: (d) => { d.packages['elsewhere/example-package'] = d.dependency; }, error: '[unsupported-package-source]' },
    { label: 'nonobject lock package', change: (d) => { d.packages['node_modules/example-package'] = false; }, error: '[unsupported-package-source]' },
    { label: 'linked lock package', change: (d) => { d.dependency.link = true; }, error: '[unsupported-package-source]' },
    { label: 'nontext locked version', change: (d) => { d.dependency.version = 1; }, error: '[unsupported-package-source]' },
    { label: 'unresolved locked version', change: (d) => { d.dependency.version = '^1.2.3'; }, error: '[unsupported-package-source]' },
    { label: 'unbound artifact integrity', change: (d) => { delete d.dependency.integrity; }, error: '[missing-lock]' },
    { label: 'malformed artifact integrity', change: (d) => { d.dependency.integrity = 'sha512-unbound'; }, error: '[missing-lock]' },
    { label: 'array binary declarations', change: (d) => { d.dependency.bin = ['bin.js']; }, error: '[unsupported-package-source]' },
    { label: 'nontext binary paths', change: (d) => { d.dependency.bin = { example: 4 }; }, error: '[unsupported-package-source]' },
    { label: 'absolute binary paths', change: (d) => { d.dependency.bin = '/outside/entry.js'; }, error: '[unsupported-package-source]' },
    { label: 'traversing binary paths', change: (d) => { d.dependency.bin = '../entry.js'; }, error: '[unsupported-package-source]' },
    { label: 'Windows binary path overrides', change: (d) => { d.dependency.bin = 'C:\\outside.exe'; }, error: '[unsupported-package-source]' },
    { label: 'control characters in binary paths', change: (d) => { d.dependency.bin = 'bin/\u0000entry'; }, error: '[unsupported-package-source]' },
    { label: 'nontext runtime requirements', change: (d) => { d.project.engines = { node: 24 }; }, error: '[preparation-input]' },
    { label: 'another package manager', change: (d) => { d.project.packageManager = 'pnpm@10.0.0'; }, error: '[unsupported-tool-requirement]' },
    { label: 'nontext package-manager declaration', change: (d) => { d.project.packageManager = false; }, error: '[unsupported-tool-requirement]' }
  ];
  it.each(cases)('rejects $label without changing the observed candidate', async ({ change, error }) => withFixture({}, async (f) => {
    const value = npmDocuments();
    change(value);
    await saveNpm(f, value);
    rejects(await observe(f), request(), error);
  }));

  it.each(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])(
    'requires exact lock-root agreement for %s', async (field) => withFixture({}, async (f) => {
      const value = npmDocuments();
      value.project[field] = { changed: '1.0.0' };
      await saveNpm(f, value);
      rejects(await observe(f), request(), '[mismatched-lock]');
    })
  );
  it.each(['node', 'npm'])('retains declared %s engine requirements and rejects nonstrings', async (id) => withFixture({}, async (f) => {
    const value = npmDocuments();
    value.project.engines = { node: '>=24.0.0 <25.0.0', npm: '>=11.0.0 <12.0.0' };
    value.project.packageManager = 'npm@11.6.2';
    await saveNpm(f, value);
    expect(resolve(await observe(f), request()).toolRequirements).toEqual({
      node: '>=24.0.0 <25.0.0', npm: '>=11.0.0 <12.0.0', 'npm-exact': '11.6.2'
    });
    record(value.project.engines)[id] = false;
    await saveNpm(f, value);
    rejects(await observe(f), request(), '[preparation-input]');
  }));

  it.each(['npmjs', 'microsoft-npm'] as const)('derives exact %s commands, raw bindings and private output roles', async (source) => withFixture({ frontend: true }, async (f) => {
    for (const network of [false, true]) {
      const value = npmDocuments();
      value.dependency.bin = 'bin/example.js';
      value.dependency.dependencies = { transitive: '*' };
      value.dependency.optionalDependencies = { optional: '~1.0.0' };
      value.dependency.peerDependencies = { peer: '>=1.0.0 <2.0.0' };
      await saveNpm(f, value);
      await saveNpm(f, value, ['frontend']);
      const candidate = await observe(f);
      for (const cwdPathParts of [['backend'], ['frontend']]) {
        const result = resolve(candidate, request('npm-ci', { packageSource: source, network, cwdPathParts }));
        expect(result).toMatchObject({ schemaVersion: 1, version: 1, provider: 'npm-ci', packageCount: 1,
          suppressedLifecyclePackages: 1, lifecycle: 'disabled', network, tools: ['node', 'npm'], pythonExtras: [] });
        expect(result.registry).toBe(applicationPackageSources[source].registry);
        expect(result.commands).toEqual([{
          tool: 'npm', cwdPathParts, timeoutMs: applicationPreparationBounds.preparationTimeoutMs,
          maxOutputBytes: applicationPreparationBounds.preparationOutputBytes,
          args: ['--replace-registry-host=never', ...(source === 'microsoft-npm' ? ['--allow-remote=all'] : []),
            'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--no-progress', '--no-update-notifier',
            `--registry=${applicationPackageSources[source].registry}`, ...(!network ? ['--offline'] : [])]
        }]);
        expect(result.outputRoles).toContainEqual({
          id: `npm-dependencies-${cwdPathParts[0]}`, kind: 'dependency',
          pathParts: ['project', ...cwdPathParts, 'node_modules'], protectedAfterPreparation: true
        });
        expect(result.outputRoles).toHaveLength(5);
        expect(result.outputRoles.filter((role) => role.protectedAfterPreparation)).toHaveLength(1);
      }
    }
  }));

  it.each(['sha512', 'sha384', 'sha256', 'sha1'])('retains supported exact %s artifact integrity', async (algorithm) => withFixture({}, async (f) => {
    const value = npmDocuments();
    value.dependency.integrity = integrity(algorithm);
    delete value.dependency.resolved;
    delete value.dependency.bin;
    value.dependency.hasInstallScript = false;
    await saveNpm(f, value);
    expect(resolve(await observe(f), request())).toMatchObject({ packageCount: 1, suppressedLifecyclePackages: 0 });
  }));

  it.each([
    { label: 'nontext URL', url: 3 },
    { label: 'oversized URL', url: `https://registry.npmjs.org/${'a'.repeat(2048)}` },
    { label: 'relative URL', url: '../archive.tgz' },
    { label: 'HTTP source', url: 'http://registry.npmjs.org/pkg.tgz' },
    { label: 'username-bearing URL', url: 'https://fixture-user@registry.npmjs.org/pkg.tgz' },
    { label: 'password-bearing URL', url: 'https://:fixture-secret@registry.npmjs.org/pkg.tgz' },
    { label: 'query-bearing URL', url: 'https://registry.npmjs.org/pkg.tgz?token=fixture-secret' },
    { label: 'fragment-bearing URL', url: 'https://registry.npmjs.org/pkg.tgz#fixture-secret' },
    { label: 'unregistered origin', url: 'https://packages.example.invalid/pkg.tgz' },
    { label: 'encoded path separator', url: 'https://registry.npmjs.org/a%2Fb.tgz' },
    { label: 'encoded Windows separator', url: 'https://registry.npmjs.org/a%5Cb.tgz' },
    { label: 'encoded traversal', url: 'https://registry.npmjs.org/a/%2E%2E/b.tgz' },
    { label: 'lowercase encoded traversal', url: 'https://registry.npmjs.org/a/%2e%2e/b.tgz' },
    { label: 'encoded single dot segment', url: 'https://registry.npmjs.org/a/%2e/b.tgz' },
    { label: 'mixed encoded parent suffix', url: 'https://registry.npmjs.org/a/.%2e/b.tgz' },
    { label: 'mixed encoded parent prefix', url: 'https://registry.npmjs.org/a/%2e./b.tgz' },
    { label: 'backslash traversal', url: 'https://registry.npmjs.org/a\\..\\b.tgz' },
    { label: 'control-normalized traversal', url: 'https://registry.npmjs.org/a/.\t./b.tgz' },
    { label: 'newline-normalized traversal', url: 'https://registry.npmjs.org/a/.\n./b.tgz' },
    { label: 'trimmed terminal traversal', url: 'https://registry.npmjs.org/a/.. ' },
    { label: 'leading URL whitespace', url: ' https://registry.npmjs.org/pkg.tgz' },
    { label: 'encoded NUL', url: 'https://registry.npmjs.org/a%00b.tgz' },
    { label: 'literal parent traversal', url: 'https://registry.npmjs.org/a/../pkg.tgz' },
    { label: 'literal dot traversal', url: 'https://registry.npmjs.org/a/./pkg.tgz' }
  ])('rejects $label without echoing sensitive source details', async ({ url }) => withFixture({}, async (f) => {
    const value = npmDocuments();
    value.dependency.resolved = url;
    await saveNpm(f, value);
    const candidate = await observe(f);
    const failure = rejects(candidate, request(), '[unsupported-package-source]');
    expect(failure.message).not.toContain('fixture-secret');
  }));

  it.each([
    'https://registry.npmjs.org/packages/a%20b/example-package.tgz',
    'https://registry.npmjs.org/packages/%E2%82%AC/example-package.tgz'
  ])('retains safe encoded artifact path data: %s', async (url) => withFixture({}, async (f) => {
    const value = npmDocuments();
    value.dependency.resolved = url;
    await saveNpm(f, value);
    expect(resolve(await observe(f), request()).packageCount).toBe(1);
  }));

  it.each([
    { label: 'missing bundle declaration', change: (parent: RecordValue) => { delete parent.bundleDependencies; } },
    { label: 'nonarray bundle declaration', change: (parent: RecordValue) => { parent.bundleDependencies = 'inner'; } },
    { label: 'unlisted child', change: (parent: RecordValue) => { parent.bundleDependencies = ['other']; } },
    { label: 'unbound parent integrity', change: (parent: RecordValue) => { parent.integrity = false; } },
    { label: 'malformed parent integrity', change: (parent: RecordValue) => { parent.integrity = 'sha256-unbound'; } }
  ])('rejects a bundled child with $label regardless of lock entry order', async ({ change }) => withFixture({}, async (f) => {
    const value = npmDocuments();
    const parent = { ...value.dependency, bundleDependencies: ['inner'] };
    const child = { version: '2.0.0', inBundle: true };
    change(parent);
    value.lock.packages = { '': value.root, 'node_modules/example-package/node_modules/inner': child, 'node_modules/example-package': parent };
    await saveNpm(f, value);
    rejects(await observe(f), request(), '[missing-lock]');
  }));
  it('accepts only explicitly listed integrity-bound bundled children and never grants them a new source URL', async () => withFixture({}, async (f) => {
    const value = npmDocuments();
    value.dependency.bundleDependencies = ['inner'];
    const child: RecordValue = { version: '2.0.0', inBundle: true };
    value.packages['node_modules/example-package/node_modules/inner'] = child;
    await saveNpm(f, value);
    expect(resolve(await observe(f), request()).packageCount).toBe(2);
    child.resolved = 'https://registry.npmjs.org/inner.tgz';
    await saveNpm(f, value);
    rejects(await observe(f), request(), '[missing-lock]');
  }));
  it('admits exactly the npm lock package bound and rejects one additional package', async () => withFixture({}, async (f) => {
    const value = npmDocuments(), sri = integrity('sha1');
    for (let i = 0; i < applicationPreparationBounds.lockPackages - 2; i++) {
      value.packages[`node_modules/optional-${i}`] = { version: '1.0.0', integrity: sri, optional: true };
    }
    expect(Object.keys(value.packages)).toHaveLength(applicationPreparationBounds.lockPackages);
    expect(Buffer.byteLength(JSON.stringify(value.lock))).toBeLessThan(applicationPreparationBounds.manifestBytes);
    await saveNpm(f, value);
    expect(resolve(await observe(f), request()).packageCount).toBe(applicationPreparationBounds.lockPackages - 1);
    value.packages['node_modules/overflow'] = { version: '1.0.0', integrity: sri, optional: true };
    await saveNpm(f, value);
    rejects(await observe(f), request(), '[preparation-bound]');
  }));
});

describe('Python project and uv lock admission', () => {
  const cases: Rejection<PythonDocuments>[] = [
    { label: 'missing project metadata', change: (d) => { delete d.projectFile.project; }, error: '[missing-lock]' },
    { label: 'nonarray lock inventory', change: (d) => { d.lock.package = {}; }, error: '[missing-lock]' },
    { label: 'future lock version', change: (d) => { d.lock.version = 2; }, error: '[missing-lock]' },
    { label: 'dynamic project metadata', change: (d) => { d.project.dynamic = []; }, error: '[unsupported-package-source]' },
    { label: 'dependency groups', change: (d) => { d.projectFile['dependency-groups'] = {}; }, error: '[unsupported-package-source]' },
    { label: 'missing Python requirement', change: (d) => { delete d.project['requires-python']; }, error: '[mismatched-lock]' },
    { label: 'unsupported Python range', change: (d) => { d.project['requires-python'] = '>=3.14'; }, error: '[unsupported-python-requirement]' },
    { label: 'different locked interpreter range', change: (d) => { d.lock['requires-python'] = '>=3.13,<3.14'; }, error: '[mismatched-lock]' },
    { label: 'nonarray runtime dependencies', change: (d) => { d.project.dependencies = 'httpx==0.28.1'; }, error: '[unsupported-package-source]' },
    { label: 'nonobject optional dependencies', change: (d) => { d.project['optional-dependencies'] = []; }, error: '[unsupported-package-source]' },
    { label: 'unknown extra', change: (d) => { d.optional.docs = []; }, error: '[unsupported-package-source]' },
    { label: 'missing test extra', change: (d) => { delete d.project['optional-dependencies']; }, error: '[missing-dependencies]' },
    { label: 'nonarray required extra', change: (d) => { d.optional.test = 'pytest==8.4.1'; }, error: '[missing-dependencies]' },
    { label: 'nonarray unselected functions extra', change: (d) => { d.optional.functions = 'azure-functions==1.23.0'; }, error: '[preparation-input]' },
    { label: 'missing project name', change: (d) => { delete d.project.name; }, error: '[mismatched-lock]' },
    { label: 'nontext project version', change: (d) => { d.project.version = 1; }, error: '[mismatched-lock]' },
    { label: 'missing lock root', change: (d) => { d.packages.shift(); }, error: '[mismatched-lock]' },
    { label: 'mismatched root version', change: (d) => { d.root.version = '2.0.0'; }, error: '[mismatched-lock]' },
    { label: 'nonobject root source', change: (d) => { d.root.source = 'local'; }, error: '[mismatched-lock]' },
    { label: 'ambiguous root sources', change: (d) => { d.root.source = { editable: '.', virtual: '.' }; }, error: '[mismatched-lock]' },
    { label: 'external editable root', change: (d) => { d.root.source = { editable: '../other' }; }, error: '[mismatched-lock]' },
    { label: 'missing root metadata', change: (d) => { delete d.root.metadata; }, error: '[mismatched-lock]' },
    { label: 'nonarray root dependency metadata', change: (d) => { d.metadata['requires-dist'] = {}; }, error: '[mismatched-lock]' },
    { label: 'nontext runtime pin', change: (d) => { d.project.dependencies = [123]; }, error: '[unsupported-package-source]' },
    { label: 'oversized runtime pin', change: (d) => { d.project.dependencies = ['a'.repeat(513)]; }, error: '[unsupported-package-source]' },
    { label: 'unresolved runtime range', change: (d) => { d.project.dependencies = ['httpx>=0.28']; }, error: '[unsupported-package-source]' },
    { label: 'nonobject locked root requirement', change: (d) => { d.dependencies[0] = 'httpx'; }, error: '[unsupported-package-source]' },
    { label: 'nontext locked dependency name', change: (d) => { record(d.dependencies[0]).name = 4; }, error: '[unsupported-package-source]' },
    { label: 'nontext locked specifier', change: (d) => { record(d.dependencies[0]).specifier = 4; }, error: '[unsupported-package-source]' },
    { label: 'unlocked root specifier', change: (d) => { record(d.dependencies[0]).specifier = '>=0.28.1'; }, error: '[unsupported-package-source]' },
    { label: 'URL root dependency', change: (d) => { record(d.dependencies[0]).url = 'https://private.example.invalid/pkg'; }, error: '[unsupported-package-source]' },
    { label: 'local root dependency', change: (d) => { record(d.dependencies[0]).path = '../private'; }, error: '[unsupported-package-source]' },
    { label: 'VCS root dependency', change: (d) => { record(d.dependencies[0]).git = 'https://example.invalid/repo'; }, error: '[unsupported-package-source]' },
    { label: 'nontext locked marker', change: (d) => { record(d.dependencies[0]).marker = 4; }, error: '[mismatched-lock]' },
    { label: 'unsupported environment marker', change: (d) => { record(d.dependencies[0]).marker = "sys_platform == 'win32'"; }, error: '[mismatched-lock]' },
    { label: 'nonarray locked extras', change: (d) => { record(d.dependencies[0]).extras = 'socks'; }, error: '[mismatched-lock]' },
    { label: 'nontext locked extra', change: (d) => { record(d.dependencies[0]).extras = [4]; }, error: '[mismatched-lock]' },
    { label: 'different root dependency pins', change: (d) => { record(d.dependencies[0]).specifier = '==0.28.2'; }, error: '[mismatched-lock]' },
    { label: 'missing directly pinned package', change: (d) => { d.packages.splice(1, 1); }, error: '[mismatched-lock]' },
    { label: 'different directly pinned version', change: (d) => { record(d.packages[1]).version = '0.28.2'; }, error: '[mismatched-lock]' },
    { label: 'unregistered registry', change: (d) => { record(d.packages[1]).source = { registry: 'https://private.example.invalid/simple' }; }, error: '[unsupported-package-source]' },
    { label: 'ambiguous package source', change: (d) => { record(d.packages[1]).source = { registry: 'https://pypi.org/simple', path: '../private' }; }, error: '[unsupported-package-source]' },
    { label: 'missing package artifacts', change: (d) => { delete record(d.packages[1]).wheels; }, error: '[missing-lock]' },
    { label: 'nonarray wheels', change: (d) => { record(d.packages[1]).wheels = {}; }, error: '[missing-lock]' },
    { label: 'nonobject wheel artifact', change: (d) => { record(d.packages[1]).wheels = ['wheel']; }, error: '[missing-lock]' },
    { label: 'nontext wheel integrity', change: (d) => { record(array(record(d.packages[1]).wheels)[0]).hash = 4; }, error: '[missing-lock]' },
    { label: 'incorrect wheel hash algorithm', change: (d) => { record(array(record(d.packages[1]).wheels)[0]).hash = integrity(); }, error: '[missing-lock]' }
  ];
  it.each(cases)('rejects $label before tool or installer execution', async ({ change, error }) => withFixture({ stack: 'python-fastapi' }, async (f) => {
    const value = pythonDocuments();
    change(value);
    await savePython(f, value);
    rejects(await observe(f), request('uv-locked-sync'), error);
  }));
  it.each(['workspace', 'sources', 'index', 'index-url', 'extra-index-url', 'find-links', 'allow-insecure-host', 'dependency-metadata'])(
    'rejects uv %s overrides rather than borrowing ambient source authority', async (field) => withFixture({ stack: 'python-fastapi' }, async (f) => {
      const value = pythonDocuments();
      value.uv[field] = [];
      await savePython(f, value);
      rejects(await observe(f), request('uv-locked-sync'), '[unsupported-package-source]');
    })
  );

  it.each(['pypi', 'microsoft-pypi'] as const)('derives %s wheel-only commands without interpreter downloads or project installation', async (source) => withFixture({ stack: 'python-fastapi' }, async (f) => {
    const value = pythonDocuments(source);
    value.root.source = { editable: '.' };
    value.project['requires-python'] = ' >=3.14, <3.15 ';
    delete value.projectFile.tool;
    await savePython(f, value);
    const candidate = await observe(f);
    for (const network of [false, true]) {
      const result = resolve(candidate, request('uv-locked-sync', { packageSource: source, network }));
      expect(result).toMatchObject({ registry: applicationPackageSources[source].registry, tools: ['python', 'uv'],
        pythonExtras: ['test'], toolRequirements: { python: '>=3.14,<3.15' }, packageCount: 2, suppressedLifecyclePackages: 0 });
      expect(result.commands[0]).toMatchObject({ tool: 'python',
        args: ['-I', '-S', '-m', 'venv', '--copies', '--without-pip', '$PRIVATE_PYTHON_ENVIRONMENT'] });
      expect(result.commands[1]!.args).toEqual([
        '--no-config', 'sync', '--locked', '--no-build', '--no-install-project', '--no-install-workspace',
        '--no-editable', '--no-python-downloads', '--no-managed-python', '--no-default-groups',
        '--extra', 'test', '--python', '$APPROVED_PYTHON', '--default-index', applicationPackageSources[source].registry,
        ...(!network ? ['--offline'] : [])
      ]);
      expect(result.outputRoles).toContainEqual({ id: 'python-environment-backend', kind: 'dependency',
        pathParts: ['project', 'backend', '.venv'], protectedAfterPreparation: true });
    }
  }));
  it('binds actual selected GenAI worker extras and each worker test-cache role', async () => withFixture({ stack: 'python-fastapi', genai: true }, async (f) => {
    const value = pythonDocuments('pypi', true);
    await savePython(f, value);
    const candidate = await observe(f);
    const workers = candidate.scope.target!.artifacts.filter((item) => item.logicalName === 'function-worker-app');
    expect(workers.length).toBeGreaterThan(0);
    const result = resolve(candidate, request('uv-locked-sync'));
    expect(result.pythonExtras).toEqual(['test', 'functions']);
    expect(result.outputRoles.filter((role) => role.id === 'python-worker-tests')).toEqual(workers.map((worker) => ({
      id: 'python-worker-tests', kind: 'cache',
      pathParts: ['project', ...worker.componentRootPathParts, '.pytest_cache'], protectedAfterPreparation: false
    })));
    delete value.optional.functions;
    await savePython(f, value);
    rejects(await observe(f), request('uv-locked-sync'), '[missing-dependencies]');
  }));
  it('normalizes dependency names and extras but binds their exact versions and groups', async () => withFixture({ stack: 'python-fastapi' }, async (f) => {
    const value = pythonDocuments();
    value.project.dependencies = ['HTTPX[SOCKS]==0.28.1'];
    record(value.dependencies[0]).name = 'HTTPX';
    record(value.dependencies[0]).extras = ['SOCKS'];
    record(value.packages[1]).sdist = {
      url: 'https://files.pythonhosted.org/packages/httpx.tar.gz', hash: `sha256:${'b'.repeat(64)}`
    };
    delete record(value.packages[1]).wheels;
    await savePython(f, value);
    expect(resolve(await observe(f), request('uv-locked-sync')).packageCount).toBe(2);
  }));
  it.each(['wheels', 'sdist'] as const)('rejects encoded traversal in Python %s artifact URLs', async (kind) =>
    withFixture({ stack: 'python-fastapi' }, async (f) => {
      const value = pythonDocuments();
      const dependency = record(value.packages[1]);
      const artifact = {
        url: 'https://files.pythonhosted.org/packages/%2e%2E/httpx.whl',
        hash: `sha256:${'a'.repeat(64)}`, size: 32
      };
      if (kind === 'wheels') dependency.wheels = [artifact];
      else {
        dependency.sdist = artifact;
        delete dependency.wheels;
      }
      await savePython(f, value);
      rejects(await observe(f), request('uv-locked-sync'), '[unsupported-package-source]');
    }));
});

describe('Go module and checksum admission', () => {
  const cases: Rejection<GoDocuments>[] = [
    { label: 'nested require blocks', change: (d) => { d.manifest += 'require (\nrequire (\n'; }, error: '[preparation-input]' },
    { label: 'unexpected closing block', change: (d) => { d.manifest += ')\n'; }, error: '[preparation-input]' },
    { label: 'missing module declaration', change: (d) => { d.manifest = 'go 1.26.0\n'; }, error: '[preparation-input]' },
    { label: 'missing Go release', change: (d) => { d.manifest = 'module example.com/project\n'; }, error: '[preparation-input]' },
    { label: 'unclosed require block', change: (d) => { d.manifest = 'module example.com/project\ngo 1.26.0\nrequire (\n'; }, error: '[preparation-input]' },
    { label: 'local replacement', change: (d) => { d.manifest += 'replace example.com/dependency => ../private\n'; }, error: '[unsupported-package-source]' },
    { label: 'unsupported directive', change: (d) => { d.manifest += 'exclude example.com/dependency v1.2.3\n'; }, error: '[unsupported-package-source]' },
    { label: 'unversioned module', change: (d) => { d.manifest += 'require example.com/dependency latest\n'; }, error: '[unsupported-package-source]' },
    { label: 'invalid module path', change: (d) => { d.manifest += 'require ../private v1.2.3\n'; }, error: '[unsupported-package-source]' },
    { label: 'extra require operands', change: (d) => { d.manifest += 'require example.com/dependency v1.2.3 unexpected\n'; }, error: '[unsupported-package-source]' },
    { label: 'missing checksums', change: (d) => { d.sums = ''; }, error: '[mismatched-lock]' },
    { label: 'missing go.mod checksum', change: (d) => { d.sums = `example.com/dependency v1.2.3 ${goHash}\n`; }, error: '[mismatched-lock]' },
    { label: 'missing archive checksum', change: (d) => { d.sums = `example.com/dependency v1.2.3/go.mod ${goHash}\n`; }, error: '[mismatched-lock]' },
    { label: 'incomplete checksum record', change: (d) => { d.sums = 'example.com/dependency v1.2.3\n'; }, error: '[missing-lock]' },
    { label: 'invalid checksum module path', change: (d) => { d.sums = `../private v1.2.3 ${goHash}\n`; }, error: '[missing-lock]' },
    { label: 'invalid checksum version', change: (d) => { d.sums = `example.com/dependency latest ${goHash}\n`; }, error: '[missing-lock]' },
    { label: 'invalid checksum algorithm', change: (d) => { d.sums = 'example.com/dependency v1.2.3 sha256:unbound\n'; }, error: '[missing-lock]' }
  ];
  it.each(cases)('rejects $label without generating or updating checksums', async ({ change, error }) => withFixture({ stack: 'go-huma' }, async (f) => {
    const value = goDocuments();
    change(value);
    await saveGo(f, value);
    rejects(await observe(f), request('go-mod-download'), error);
  }));
  it('binds CRLF, comments, exact prereleases and standalone require declarations', async () => withFixture({ stack: 'go-huma' }, async (f) => {
    const value = goDocuments();
    value.manifest += 'require example.com/second v2.0.0-rc.1\n';
    value.sums += `example.com/second v2.0.0-rc.1 ${goHash}\nexample.com/second v2.0.0-rc.1/go.mod ${goHash}\n`;
    value.manifest = value.manifest.replaceAll('\n', '\r\n');
    await saveGo(f, value);
    const result = resolve(await observe(f), request('go-mod-download'));
    expect(result).toMatchObject({
      registry: 'https://proxy.golang.org', packageCount: 2, tools: ['go'], pythonExtras: [],
      toolRequirements: { go: '>=1.26.0', 'go-toolchain': '>=1.26.1' }
    });
    expect(result.commands[0]).toMatchObject({ tool: 'go', args: ['mod', 'download', '-json'], cwdPathParts: ['backend'] });
    expect(result.outputRoles).toEqual([
      { id: 'go-modules-backend', kind: 'dependency', pathParts: ['cache', 'go-mod', 'backend'], protectedAfterPreparation: true },
      { id: 'go-build-backend', kind: 'cache', pathParts: ['cache', 'go-build', 'backend'], protectedAfterPreparation: false },
      { id: 'go-path-backend', kind: 'cache', pathParts: ['cache', 'go-path', 'backend'], protectedAfterPreparation: false }
    ]);
  }));
  it.each(['go.work', 'go.work.sum'])('rejects a nested %s instead of acquiring workspace authority', async (name) => withFixture({ stack: 'go-huma' }, async (f) => {
    await saveGo(f, goDocuments());
    await putApplicationFixtureFile(f.root, ['another-component', name], 'workspace control');
    rejects(await observe(f), request('go-mod-download'), '[unsupported-package-source]');
  }));
  it('admits the exact Go checksum inventory bound and rejects overflow without updating it', async () => withFixture({ stack: 'go-huma' }, async (f) => {
    const value = goDocuments();
    for (let i = 0; i < applicationPreparationBounds.lockPackages - 1; i++) {
      value.sums += `example.com/extra-${i} v1.0.0 ${goHash}\nexample.com/extra-${i} v1.0.0/go.mod ${goHash}\n`;
    }
    expect(value.sums.trimEnd().split('\n')).toHaveLength(applicationPreparationBounds.lockPackages * 2);
    expect(Buffer.byteLength(value.sums)).toBeLessThan(applicationPreparationBounds.manifestBytes);
    await saveGo(f, value);
    expect(resolve(await observe(f), request('go-mod-download')).packageCount).toBe(1);
    value.sums += `example.com/overflow v1.0.0 ${goHash}\n`;
    await saveGo(f, value);
    rejects(await observe(f), request('go-mod-download'), '[preparation-bound]');
  }));
  it('does not apply the Go-workspace restriction to a separately selected npm component', async () => withFixture({}, async (f) => {
    await saveNpm(f, npmDocuments());
    const before = resolve(await observe(f), request());
    await putApplicationFixtureFile(f.root, ['unselected-go', 'go.work'], 'go 1.26.0\n');
    expect(resolve(await observe(f), request())).toEqual(before);
  }));
});

describe('real snapshot, configuration and admission boundaries', () => {
  it('uses prospective candidate bytes, rejects deleted inputs, and requires selected component/source ownership', async () => withFixture({}, async (f) => {
    const value = npmDocuments();
    await saveNpm(f, value);
    const candidate = await observe(f);
    const original = resolve(candidate, request());
    candidate.mutations = [{ type: 'write', pathParts: ['backend', 'package.json'],
      content: JSON.stringify({ ...value.project, engines: { node: '>=24.0.0 <25.0.0' } }), mode: 0o644 }];
    const changed = resolve(candidate, request());
    expect(changed.digest).not.toBe(original.digest);
    expect(changed.toolRequirements.node).toBe('>=24.0.0 <25.0.0');
    expect(JSON.parse(await readFile(path.join(f.root, 'backend', 'package.json'), 'utf8'))).toEqual(value.project);
    candidate.mutations = [{ type: 'delete', pathParts: ['backend', 'package-lock.json'] }];
    rejects(candidate, request(), '[missing-lock]');
    candidate.mutations = [];
    rejects(candidate, request('npm-ci', { cwdPathParts: ['unselected'] }), '[unselected-preparation-component]');
    rejects(candidate, request('npm-ci', { packageSource: 'pypi' }), '[unselected-preparation-component]');
    expect(() => resolveApplicationPreparationInputs(candidate, [request(), request()])).toThrow('[preparation-schema]');
    candidate.scope.target = null;
    rejects(candidate, request(), '[unselected-preparation-component]');
  }));
  it('changes plan input identity for byte-preserving semantics and file permission changes', async () => withFixture({}, async (f) => {
    const value = npmDocuments();
    await saveNpm(f, value);
    const original = resolve(await observe(f), request());
    const file = path.join(f.root, 'backend', 'package.json');
    await writeFile(file, `${JSON.stringify(value.project, null, 2)}\r\n`);
    const whitespace = resolve(await observe(f), request());
    expect(whitespace.commands).toEqual(original.commands);
    expect(whitespace.digest).not.toBe(original.digest);
    const mode = (await lstat(file)).mode & 0o777;
    await chmod(file, 0o400);
    const permissions = resolve(await observe(f), request());
    expect(permissions.inputs[0]!.digest).toBe(whitespace.inputs[0]!.digest);
    expect(permissions.inputs[0]!.mode).not.toBe(whitespace.inputs[0]!.mode);
    expect(permissions.digest).not.toBe(whitespace.digest);
    await chmod(file, mode);
  }));
  it.each([
    { name: 'package.json', bytes: Buffer.from('[]') },
    { name: 'package-lock.json', bytes: Buffer.from('{not json') },
    { name: 'package.json', bytes: Buffer.from([0xff, 0]) }
  ])('rejects invalid JSON/text in $name through real captured bytes', async ({ name, bytes }) => withFixture({}, async (f) => {
    await saveNpm(f, npmDocuments());
    await putApplicationFixtureFile(f.root, ['backend', name], bytes);
    rejects(await observe(f), request(), '[preparation-input]');
  }));
  it.each([
    { provider: 'uv-locked-sync' as const, stack: 'python-fastapi' as const, name: 'pyproject.toml', bytes: Buffer.from([0xff]) },
    { provider: 'uv-locked-sync' as const, stack: 'python-fastapi' as const, name: 'uv.lock', bytes: Buffer.from('[invalid') },
    { provider: 'go-mod-download' as const, stack: 'go-huma' as const, name: 'go.mod', bytes: Buffer.from([0xff]) },
    { provider: 'go-mod-download' as const, stack: 'go-huma' as const, name: 'go.sum', bytes: Buffer.from([0]) }
  ])('rejects invalid encoded $name without a decoding fallback', async ({ provider, stack, name, bytes }) => withFixture({ stack }, async (f) => {
    if (provider === 'uv-locked-sync') await savePython(f, pythonDocuments());
    else await saveGo(f, goDocuments());
    await putApplicationFixtureFile(f.root, ['backend', name], bytes);
    rejects(await observe(f), request(provider), '[preparation-input]');
  }));
  it('does not let ambient manager configuration supply source or lifecycle authority', async () => withFixture({}, async (f) => {
    await saveNpm(f, npmDocuments());
    const candidate = await observe(f), original = resolve(candidate, request());
    vi.stubEnv('npm_config_registry', 'https://private.example.invalid/');
    vi.stubEnv('npm_config_ignore_scripts', 'false');
    vi.stubEnv('GOPROXY', 'direct');
    vi.stubEnv('UV_INDEX_URL', 'https://private.example.invalid/simple');
    expect(resolve(candidate, request())).toEqual(original);
    expect(original.commands[0]!.args).toContain('--ignore-scripts');
    expect(original.commands[0]!.args).toContain('--offline');
  }));
  it.each(['hardlink', 'linked-parent', 'oversized-file'] as const)(
    'fails closed on %s before tool probing, without modifying external files', async (boundary) => withFixture({}, async (f) => {
      const outside = path.join(f.directory, 'outside');
      await mkdir(outside);
      const sentinel = path.join(outside, 'sentinel');
      await writeFile(sentinel, 'owned external sentinel');
      if (boundary === 'hardlink') {
        await link(path.join(f.root, 'backend', 'package-lock.json'), path.join(outside, 'linked-lock'));
      } else if (boundary === 'linked-parent') {
        await symlink(outside, path.join(f.root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
      } else {
        await writeFile(path.join(f.root, 'backend', 'package-lock.json'), Buffer.alloc(applicationPreparationBounds.manifestBytes + 1, 0x20));
      }
      const runner: CommandRunner = { run: vi.fn(async () => { throw new Error('Unexpected process invocation.'); }) };
      const inspected = await inspectApplicationPatch(f.root, f.manifest, f.patchPath, { runner });
      expect(inspected.blockers.join(' ')).toMatch(/singly linked|link|junction|bound/i);
      expect(inspected.mutations).toEqual([]);
      expect(runner.run).not.toHaveBeenCalled();
      expect(await readFile(sentinel, 'utf8')).toBe('owned external sentinel');
    })
  );
  it('keeps stale observations and missing tool environments out of executable preparation', async () => withFixture({}, async (f) => {
    const runner: CommandRunner = { run: vi.fn(async () => { throw new Error('Unexpected process invocation.'); }) };
    const missing = await inspectApplicationPatch(f.root, f.manifest, f.patchPath, { runner, env: { PATH: '', Path: '' } });
    expect(missing.blockers.join(' ')).toContain('[missing-tool]');
    expect(runner.run).not.toHaveBeenCalled();
    await putApplicationFixtureFile(f.root, ['backend', 'package.json'], JSON.stringify(npmDocuments().project));
    const stale = await inspectApplicationPatch(f.root, f.manifest, f.patchPath, { runner });
    expect(stale.blockers.join(' ')).toMatch(/changed|inspection/i);
    expect(stale.mutations).toEqual([]);
    expect(runner.run).not.toHaveBeenCalled();
  }));
  it('never opens linked source bytes with the generic guarded reader', async () => withFixture({}, async (f) => {
    const external = path.join(f.directory, 'external-inputs');
    await mkdir(external);
    await writeFile(path.join(external, 'package.json'), '{"private":"untouched"}');
    await symlink(external, path.join(f.root, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir');
    const reader = new ApplicationFiles(f.root);
    await expect(reader.read(['external-link', 'package.json'])).rejects.toThrow(/link|junction/);
    expect(await readFile(path.join(external, 'package.json'), 'utf8')).toBe('{"private":"untouched"}');
  }));
  it('does not invoke an ambient native runner for input-only resolution', async () => withFixture({}, async (f) => {
    await saveNpm(f, npmDocuments());
    const native = vi.spyOn(NodeCommandRunner.prototype, 'run').mockRejectedValue(new Error('Forbidden native preparation effect'));
    resolve(await observe(f), request());
    expect(native).not.toHaveBeenCalled();
  }));
});
