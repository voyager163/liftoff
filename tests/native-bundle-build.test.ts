import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assembleNativeBundle, createNativeLauncher, nativeEntrypoints, nativePlanSmokeCases, parseNativeBuildArgs, posixLauncher
} from '../scripts/distribution/assemble-native-bundle.mjs';
import {
  assertOwnedOutput, captureSource, cleanBuildEnvironment, compilerLockSubset, confinedPath,
  createOwnedOutput, fileIdentity, inventoryTree, readSourceIdentity, REQUIRED_ASSET_ROOTS, REQUIRED_BUILD_HELPERS,
  seedLockedPublicCache, verifyDependencyTree
} from '../scripts/distribution/native-build-files.mjs';
import { inspectNativeMachine, pinnedRuntime, runtimeDefinition, verifyRuntimeArchive } from '../scripts/distribution/node-runtime.mjs';
import { verifyDevelopmentBundle } from '../scripts/distribution/verify-native-build.mjs';
import { directArtifactDescriptor, renderHomebrewDefinition, renderWinGetDefinitions } from '../scripts/distribution/channel-definitions.mjs';
import { generateChannelManifests } from '../scripts/distribution/generate-channel-manifests.mjs';
import { loadReleaseScope } from '../scripts/release-evidence.mjs';
import { allNativeTargets, nativeTargetFloors } from '../src/domain/distribution/contracts.js';
import { compareNumericVersions, parseRuntimeConstraints } from '../src/domain/distribution/release-manifest.js';
import { NATIVE_LAUNCHER_MAX_BYTES } from '../src/adapters/distribution/native-launcher-limits.js';
import { OPERATOR_DOCUMENTS, REQUIRED_PUBLIC_DOCUMENTS } from '../scripts/distribution/native-document-links.mjs';
import { parse } from 'yaml';

const parent = path.join(process.env.LIFTOFF_NATIVE_BUILD_TEST_PARENT ?? path.join(process.cwd(), 'tests'), `.native-build-tests-${randomUUID()}`);
const integration = process.env.LIFTOFF_NATIVE_BUILDER_INTEGRATION === '1';

function directory(name: string) {
  const root = path.join(parent, `${name}-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function write(root: string, name: string, data: unknown) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
}

function sourceFixture() {
  const root = directory('source');
  const files = ['dist', ...REQUIRED_ASSET_ROOTS, 'assets/supported-stack.json', 'docs', ...REQUIRED_PUBLIC_DOCUMENTS, 'LICENSE'];
  const pkg = { name: '@msn-control/liftoff', version: '0.13.0', type: 'module', private: true,
    license: 'GPL-3.0-only', repository: { url: 'git+https://github.com/voyager163/liftoff.git' },
    bin: { liftoff: 'dist/cli.js' }, files, dependencies: {}, devDependencies: {} };
  write(root, 'package.json', pkg);
  write(root, 'package-lock.json', { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg } });
  for (const folder of [...REQUIRED_ASSET_ROOTS, 'src', 'docs', 'scripts/distribution']) write(root, `${folder}/fixture.txt`, 'explicit source inventory fixture\n');
  for (const file of [...REQUIRED_PUBLIC_DOCUMENTS, 'LICENSE', 'assets/supported-stack.json', 'tsconfig.json']) write(root, file, '{}\n');
  for (const file of REQUIRED_BUILD_HELPERS) write(root, file, 'explicit build helper source fixture\n');
  return root;
}

beforeAll(() => fs.mkdirSync(parent, { recursive: true }));
afterAll(() => {
  const makeWritable = (root: string) => {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { fs.chmodSync(file, 0o700); makeWritable(file); }
      else fs.chmodSync(file, 0o600);
    }
  };
  makeWritable(parent);
  fs.rmSync(parent, { recursive: true, force: false });
});

describe('native build source and output admission', () => {
  it('requires explicit mode/target/output and does not retain positional version or baseline defaults', async () => {
    expect(() => parseNativeBuildArgs([])).toThrow('Usage');
    expect(() => parseNativeBuildArgs(['darwin-arm64', '0.13.0', 'a'.repeat(40)])).toThrow();
    expect(() => parseNativeBuildArgs(['--mode', 'development', '--mode', 'release'])).toThrow('duplicate');
    await expect(assembleNativeBundle({ mode: 'development', target: 'darwin-arm64', version: '0.13.0' })).rejects.toThrow('overrides');
    await expect(assembleNativeBundle({ mode: 'development', target: 'darwin-arm64', sourceCommit: 'a'.repeat(40), outputDirectory: 'build/no-output' })).rejects.toThrow('not a supplied commit');
  });

  it('rejects dirty baseline HEAD as a release identity without creating output', async () => {
    const output = `build/must-not-create-${randomUUID()}`;
    await expect(assembleNativeBundle({ mode: 'release', target: 'darwin-arm64', projectRoot: process.cwd(),
      sourceCommit: '70d10881b46d873118d825735696f39b6d35ebe0', outputDirectory: output })).rejects.toThrow();
    expect(fs.existsSync(output)).toBe(false);
  });

  it('rejects package/lock identity drift and incomplete asset closure', () => {
    const root = sourceFixture();
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    lock.packages[''].version = '0.12.3';
    write(root, 'package-lock.json', lock);
    expect(() => readSourceIdentity(root)).toThrow('disagree');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    lock.packages[''].version = '0.13.0';
    write(root, 'package-lock.json', lock);
    pkg.files = pkg.files.filter((name: string) => name !== 'assets/skills');
    write(root, 'package.json', pkg);
    expect(() => readSourceIdentity(root)).toThrow('omits');
  });

  it('captures actual source bytes and a content identity, not a synthetic release commit', () => {
    const source = sourceFixture();
    const first = captureSource(source, directory('snapshot'));
    expect(first.treeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.files.some((file: any) => file.path === 'assets/skills/fixture.txt')).toBe(true);
    write(source, 'src/fixture.txt', 'changed working-tree bytes');
    const second = captureSource(source, directory('snapshot'));
    expect(second.treeSha256).not.toBe(first.treeSha256);
    expect(first).not.toHaveProperty('sourceCommit');
  });

  it('does not broaden public-document shipping into whole asset or infrastructure trees', () => {
    const root = sourceFixture();
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    write(root, 'package.json', { ...pkg, files: [...pkg.files, 'assets'] });
    expect(() => readSourceIdentity(root)).toThrow('whole assets');
    write(root, 'package.json', { ...pkg, files: [...pkg.files, 'infrastructure'] });
    expect(() => readSourceIdentity(root)).toThrow('exact public operator README');
  });

  it('fails when selected code/assets are missing or linked', () => {
    const source = sourceFixture();
    fs.rmSync(path.join(source, 'assets/skills'), { recursive: true });
    expect(() => captureSource(source, directory('snapshot'))).toThrow();
    fs.symlinkSync(path.join(source, 'assets/templates'), path.join(source, 'assets/skills'), 'junction');
    expect(() => captureSource(source, directory('snapshot'))).toThrow(/Linked|linked/);
  });

  it('never merges existing output or accepts outside/source destinations', async () => {
    const source = sourceFixture();
    expect(() => createOwnedOutput(source, '../outside')).toThrow('descendant');
    fs.mkdirSync(path.join(source, 'existing'));
    write(source, 'existing/user.txt', 'preserve');
    expect(() => createOwnedOutput(source, 'existing')).toThrow('already exists');
    await expect(assembleNativeBundle({ mode: 'development', target: 'darwin-arm64', projectRoot: source, outputDirectory: 'src/output' })).rejects.toThrow('outside every selected');
    expect(fs.readFileSync(path.join(source, 'existing/user.txt'), 'utf8')).toBe('preserve');
  });

  it('rejects native case aliases, escapes, and source links before copying', () => {
    const root = directory('paths');
    write(root, 'Assets/data.json', '{}');
    expect(() => confinedPath(root, 'assets/data.json')).toThrow('alias');
    expect(() => confinedPath(root, '../outside')).toThrow('Unsafe');
    fs.symlinkSync(path.join(root, 'Assets'), path.join(root, 'link'), 'junction');
    expect(() => inventoryTree(root)).toThrow('Linked');
  });

  it('detects changed output ownership rather than cleaning another work area', () => {
    const root = directory('ownership');
    const output = createOwnedOutput(root, 'build/new');
    const marker = path.join(output.root, '.liftoff-native-build-owner.json');
    fs.writeFileSync(marker, JSON.stringify({ id: 'foreign-owner' }));
    expect(() => assertOwnedOutput(output)).toThrow('ownership changed');
  });

  it('restores only exact locked public tarballs into a private cache, not ambient modules or cache indexes', () => {
    const source = directory('public-cache');
    const destination = directory('private-cache');
    const bytes = Buffer.from('bounded cache integrity fixture');
    const digest = createHash('sha512').update(bytes).digest('base64');
    const hex = Buffer.from(digest, 'base64').toString('hex');
    const relative = `_cacache/content-v2/sha512/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4)}`;
    write(source, relative, bytes.toString());
    write(source, '_cacache/index-v5/private-metadata', 'must not copy');
    const lock = { packages: { 'node_modules/fixture': { version: '1.0.0', integrity: `sha512-${digest}` } } };
    expect(seedLockedPublicCache(lock, source, destination).tarballs).toBe(1);
    expect(fs.existsSync(path.join(destination, '_cacache/index-v5'))).toBe(false);
    fs.writeFileSync(path.join(source, relative), 'changed');
    expect(() => seedLockedPublicCache(lock, source, directory('private-cache'))).toThrow('exact source lock');
  });

  it('selects only source-locked compiler dependencies, without pulling the unrelated Vitest/Vite graph', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
    const tools = compilerLockSubset({ pkg, lock });
    expect(Object.keys(tools.pkg.dependencies).sort()).toEqual(['@types/cross-spawn', '@types/node', 'typescript']);
    expect(tools.lock.packages).not.toHaveProperty('node_modules/vitest');
    for (const [name, entry] of Object.entries(tools.lock.packages) as any[]) {
      if (name) expect(entry.integrity).toBe(lock.packages[name].integrity);
    }
  });

  it('fails explicitly for missing/mismatched locked runtime dependencies', () => {
    const root = directory('dependencies');
    const lock = { packages: { 'node_modules/fixture': { version: '1.0.0', integrity: 'sha512-YQ==' } } };
    expect(() => verifyDependencyTree(root, lock, 'darwin-arm64')).toThrow();
    write(root, 'node_modules/fixture/package.json', { name: 'fixture', version: '2.0.0' });
    expect(() => verifyDependencyTree(root, lock, 'darwin-arm64')).toThrow('differs from lock');
  });
});

describe('official runtime and native launcher build contracts', () => {
  it('binds all six formats to explicit official Node 24.20 archives and upstream floor evidence', () => {
    for (const target of Object.keys(pinnedRuntime.targets)) {
      const definition = runtimeDefinition(target);
      expect(definition.version).toBe('24.20.0');
      expect(definition.url).toMatch(/^https:\/\/nodejs\.org\/dist\/v24\.20\.0\//);
      expect(definition.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(definition.archive.endsWith(target.startsWith('win32') ? '.zip' : '.tar.gz')).toBe(true);
      expect(definition.upstream.vendorSupportPolicy).toBe('vendor-supported-platforms-only');
    }
    expect(runtimeDefinition('darwin-arm64').upstream.minimumHostVersion).toBe('13.5.0');
    expect(runtimeDefinition('win32-arm64').upstream.exactMinimumBuild).toBeNull();
  });

  it.each(['darwin-x64', 'darwin-arm64'])('keeps the parent-owned %s matrix aligned without granting qualification', (target) => {
    const registration = loadReleaseScope();
    expect(registration.valid).toBe(true);
    expect(registration.scope?.candidate.publicationAuthorized).toBe(false);
    const row = registration.scope?.nativeQualificationMatrix.find((entry: { target: string }) => entry.target === target);
    expect(row).toMatchObject({
      target, nodeEngineFloor: pinnedRuntime.version,
      hostFloor: `macOS ${nativeTargetFloors.darwin.minimumHostVersion} (Darwin ${nativeTargetFloors.darwin.minimumDarwinRelease})`,
      qualified: false
    });
  });

  it.each(allNativeTargets)('keeps %s canonical floors compatible with the pinned runtime without claiming host qualification', (target) => {
    const runtime = runtimeDefinition(target);
    const floors = target.startsWith('darwin-') ? nativeTargetFloors.darwin
      : target.startsWith('linux-') ? nativeTargetFloors.linux : nativeTargetFloors.win32;
    const constraints = { nodeVersion: runtime.version, ...floors };
    expect(parseRuntimeConstraints(constraints, target)).toEqual(constraints);
    if (target.startsWith('darwin-')) {
      expect(compareNumericVersions(nativeTargetFloors.darwin.minimumHostVersion, runtime.upstream.minimumHostVersion)).toBeGreaterThanOrEqual(0);
    } else if (target.startsWith('linux-')) {
      expect(compareNumericVersions(nativeTargetFloors.linux.minimumGlibc, runtime.upstream.minimumGlibc)).toBeGreaterThanOrEqual(0);
      expect(compareNumericVersions(nativeTargetFloors.linux.minimumKernelVersion, runtime.upstream.minimumKernelVersion)).toBeGreaterThanOrEqual(0);
      expect(runtime.upstream.minimumLibstdcxx).toBe('6.0.25');
      expect(runtime.upstream.minimumGlibcxx).toBe('3.4.25');
    } else {
      expect(runtime.upstream.exactMinimumBuild).toBeNull();
    }
  });

  it('rejects corrupt/unregistered runtime bytes before execution', () => {
    const root = directory('runtime');
    const file = write(root, 'runtime.tar.gz', 'not verified Node bytes');
    expect(() => verifyRuntimeArchive(file, 'darwin-arm64')).toThrow('checksum mismatch');
    expect(() => runtimeDefinition('linux-mips')).toThrow('Unsupported');
    expect(() => inspectNativeMachine(file, 'win32-arm64')).toThrow('PE executable');
  });

  it('never resolves ambient Node/npm or uses a cmd wrapper as a Windows executable', () => {
    expect(posixLauncher()).toContain('exec "$ROOT/runtime/node" "$ROOT/dist/cli.js" "$@"');
    expect(posixLauncher()).not.toContain('exec node');
    expect(posixLauncher()).not.toContain('/usr/bin/env');
    expect(posixLauncher()).toContain('unset NODE_OPTIONS NODE_PATH');
    expect(nativeEntrypoints('win32-arm64').launcher).toBe('bin/liftoff.exe');
  });

  it.runIf(integration).each(['win32-x64', 'win32-arm64'])('compiles a real matching PE bootstrap for %s without network or claiming native-host qualification', async (target) => {
    const root = directory('windows-launcher');
    const bundle = path.join(root, 'payload');
    const work = path.join(root, 'work');
    fs.mkdirSync(bundle);
    fs.mkdirSync(work);
    const result = await createNativeLauncher(bundle, process.cwd(), target, work, cleanBuildEnvironment(work), process.cwd());
    expect(result.kind).toBe('windows-pe');
    expect(inspectNativeMachine(path.join(bundle, result.entrypoint), target)).toMatchObject({ os: 'win32', arch: target.split('-')[1] });
    expect(fileIdentity(path.join(bundle, result.entrypoint)).size).toBeLessThanOrEqual(NATIVE_LAUNCHER_MAX_BYTES);
  }, 180000);

  it.runIf(integration)('proves a REAL development bundle outside checkout with an independently verified private runtime and no ambient tools', async () => {
    expect(process.env.LIFTOFF_NATIVE_BUILD_STATUS).toBeTruthy();
    const result = await verifyDevelopmentBundle({
      projectRoot: process.cwd(), buildStatus: process.env.LIFTOFF_NATIVE_BUILD_STATUS,
      nodeArchive: process.env.LIFTOFF_NATIVE_NODE_ARCHIVE, outsideParent: path.dirname(process.cwd())
    });
    expect(result.status).toBe('DEVELOPMENT_RUNTIME_CLOSURE_OBSERVED');
    expect(result.runtime.version).toBe('24.20.0');
    expect(result.productionQualified).toBe(false);
    expect(result.runtime.upstream.vendorSupportPolicy).toBe('vendor-supported-platforms-only');
    if (result.target.startsWith('darwin-')) {
      expect(result.runtime.machine.minimumMacosVersion).toBe(runtimeDefinition(result.target).upstream.minimumHostVersion);
      expect(compareNumericVersions(nativeTargetFloors.darwin.minimumHostVersion, result.runtime.machine.minimumMacosVersion)).toBeGreaterThanOrEqual(0);
    }
    expect(result.probes.observations.map((entry: any) => entry.args)).toContainEqual(['skills', 'list', '--json']);
    for (const args of nativePlanSmokeCases) expect(result.probes.observations.map((entry: any) => entry.args)).toContainEqual(args);
    const generated = result.probes.observations.find((entry: any) => entry.result?.kind === 'packaged-generation-source-smoke').result;
    expect(generated.results.map((entry: any) => entry.id)).toEqual(['node-fastify', 'genai-rag']);
    expect(generated.results.every((entry: any) => entry.files > 0 && entry.buildInfoKind === 'development')).toBe(true);
    expect(generated.initializedProject).toBe(false);
    expect(generated.frameworkExecuted).toBe(false);
    expect(generated.providerExecuted).toBe(false);
    expect(result.negative['missing-template-catalog'].exitCode).not.toBe(0);
    expect(result.negative['missing-profile-catalog'].exitCode).not.toBe(0);
    const documentation = result.probes.observations.find((entry: any) =>
      entry.result?.kind === 'packaged-public-document-closure').result;
    expect(result.archiveDocumentation).toEqual(documentation);
    for (const name of REQUIRED_PUBLIC_DOCUMENTS) expect(documentation.documents).toContain(name);
    for (const name of ['CONTRIBUTING.md', 'SECURITY.md', ...OPERATOR_DOCUMENTS]) {
      expect(result.negative[`missing-document:${name}`]).toEqual({ reasonCode: 'missing-document', target: name });
    }
  }, 180000);

    describe('build-only channel preparation', () => {
      function manifest() {
        return { schemaVersion: 1, product: 'liftoff', version: '0.13.0', sourceCommit: 'a'.repeat(40),
          targets: Object.fromEntries(Object.keys(pinnedRuntime.targets).map((target) => [target, {
            archiveFormat: target.startsWith('win32') ? 'zip' : 'tar.gz',
            archiveUrl: `https://github.com/voyager163/liftoff/releases/download/v0.13.0/liftoff-v0.13.0-${target}.${target.startsWith('win32') ? 'zip' : 'tar.gz'}`,
            checksumSha256: 'b'.repeat(64),
            runtime: { nodeVersion: pinnedRuntime.version, ...(target.startsWith('darwin-') ? nativeTargetFloors.darwin
              : target.startsWith('linux-') ? nativeTargetFloors.linux : nativeTargetFloors.win32) }
          }])) };
      }
      it('renders the real Windows PE layout as nested ZIP portable metadata', () => {
        const definitions = renderWinGetDefinitions(manifest(), { packageId: 'Fixture.Liftoff', publisher: 'Fixture Publisher' });
        const installer = parse(definitions.installer);
        expect(installer.InstallerType).toBe('zip');
        expect(installer.NestedInstallerType).toBe('portable');
        expect(installer.Installers.map((entry: any) => entry.Architecture)).toEqual(['x64', 'arm64']);
        for (const entry of installer.Installers) expect(entry.NestedInstallerFiles[0].RelativeFilePath).toMatch(/\\bin\\liftoff\.exe$/);
      });
      it('does not generate a Node-dependent cask or delete user state', () => {
        const cask = renderHomebrewDefinition(manifest(), { packageId: 'fixture/tap/liftoff' });
        expect(cask).toContain('depends_on macos: ">= 13.5.0"');
        expect(cask).not.toContain('zap');
        expect(cask).not.toContain('depends_on "node"');
      });
      it('never manufactures an installation receipt from artifact preparation', () => {
        const descriptor = directArtifactDescriptor(manifest());
        expect(descriptor.kind).toBe('native-direct-artifacts-not-an-installation-receipt');
        expect(Object.keys(descriptor.targets)).toEqual(['linux-x64', 'linux-arm64']);
        for (const key of ['installedAt', 'installRoot', 'versionRoot', 'launcherPath']) expect(descriptor).not.toHaveProperty(key);
      });
      it('rejects old approval booleans, zero/default sources, and incomplete target inventories', async () => {
        await expect(generateChannelManifests({ version: '0.13.0', hasSigningKeys: true })).rejects.toThrow('not approval booleans');
        const incomplete = manifest();
        delete incomplete.targets['linux-arm64'];
        expect(() => directArtifactDescriptor(incomplete)).toThrow('all six');
        expect(() => renderWinGetDefinitions(manifest(), { isPublisherApproved: true })).toThrow('registered');
      });
    });
});
