import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BuildInfoValidationError, loadBuildInfo, resetBuildInfoCache, validateNativeBuildInfo
} from '../src/adapters/packaged-assets/build-info.js';
import {
  computeResourceInventorySummary, loadPackagedProfilesCatalog, loadPackagedTemplateCatalog,
  resetResourceCatalogCache, validateInstalledPackageContext
} from '../src/adapters/packaged-assets/resource-catalog.js';
import { installedPackageRoot, setPackageRootOverride } from '../src/adapters/packaged-assets/package-root.js';
import { PackagedResourceMissingError, readBoundedPackagedFile } from '../src/adapters/packaged-assets/resource-file.js';
import { computeProfileCatalogDigest, computeProfileDigest } from '../src/domain/standards/profile-schema.js';
import { computeTemplateCatalogDigest } from '../src/domain/standards/resource-catalog-schema.js';
import { liftoffVersion } from '../src/version.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  setPackageRootOverride(undefined);
  resetBuildInfoCache();
  resetResourceCatalogCache();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.resolve('tests', '.build-info-admission-'));
  roots.push(root);
  for (const family of ['profiles', 'templates']) {
    const relative = path.join('assets', family, 'catalog.json');
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.copyFileSync(path.join(installedPackageRoot, relative), path.join(root, relative));
  }
  fs.copyFileSync(path.join(installedPackageRoot, 'package.json'), path.join(root, 'package.json'));
  setPackageRootOverride(root);
  const profiles = loadPackagedProfilesCatalog(), templates = loadPackagedTemplateCatalog();
  const info = {
    schemaVersion: 1, kind: 'native-release', product: 'liftoff', version: liftoffVersion,
    commit: 'a'.repeat(40), buildDate: '2026-09-14T00:00:00.000Z',
    target: { os: process.platform, arch: process.arch, platform: `${process.platform}-${process.arch}` },
    runtime: { name: 'node', version: process.versions.node },
    resourcesDigest: templates.digest, profilesDigest: profiles.digest
  };
  const file = path.join(root, 'build-info.json');
  const write = (value: unknown = info) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return { root, info, file, write };
}

describe('fresh packaged build metadata admission', () => {
  it('rechecks an absent file after a development cache fill instead of hiding new native metadata', () => {
    const source = fixture();
    expect(loadBuildInfo()).toMatchObject({
      kind: 'development', commit: 'uncommitted', resourcesDigest: 'unqualified', profilesDigest: 'unqualified'
    });
    source.write();
    expect(loadBuildInfo()).toMatchObject({
      kind: 'native-release', commit: source.info.commit, profilesDigest: source.info.profilesDigest
    });
  });

  it('rejects malformed or oversized same-root metadata after a valid cache fill', () => {
    const source = fixture();
    source.write();
    expect(loadBuildInfo().kind).toBe('native-release');
    fs.writeFileSync(source.file, '{ malformed');
    expect(() => loadBuildInfo()).toThrow(BuildInfoValidationError);
    source.write();
    expect(loadBuildInfo().kind).toBe('native-release');
    fs.writeFileSync(source.file, Buffer.alloc(256 * 1024 + 1, ' '));
    expect(() => loadBuildInfo()).toThrow(/bound/);
  });

  it('revalidates modified valid bytes and prevents callers from poisoning the cached object', () => {
    const source = fixture();
    source.write();
    const original = loadBuildInfo();
    expect(() => { original.runtime.version = '99.0.0'; }).toThrow(TypeError);
    expect(loadBuildInfo()).toBe(original);
    source.write({ ...source.info, commit: 'b'.repeat(40) });
    expect(loadBuildInfo().commit).toBe('b'.repeat(40));
    expect(loadBuildInfo()).not.toBe(original);
  });

  it('binds every cache entry to the selected package root', () => {
    const first = fixture();
    first.write();
    expect(loadBuildInfo().commit).toBe(first.info.commit);
    const second = fixture();
    expect(loadBuildInfo().kind).toBe('development');
    second.write({ ...second.info, commit: 'b'.repeat(40) });
    expect(loadBuildInfo().commit).toBe('b'.repeat(40));
    setPackageRootOverride(first.root);
    expect(loadBuildInfo().commit).toBe(first.info.commit);
  });

  it('never downgrades missing native metadata into a development success', () => {
    const source = fixture();
    source.write();
    loadBuildInfo();
    fs.unlinkSync(source.file);
    expect(() => loadBuildInfo()).toThrow(/cannot fall back to development/);
    resetBuildInfoCache();
    fs.writeFileSync(path.join(source.root, 'liftoff-build-manifest.json'), '{"schemaVersion":1}');
    expect(() => loadBuildInfo()).toThrow(/cannot fall back to development/);
  });

  it('distinguishes a verified absent leaf from a missing or unsafe package root', () => {
    const source = fixture();
    expect(() => readBoundedPackagedFile(source.root, ['build-info.json'])).toThrow(PackagedResourceMissingError);
    setPackageRootOverride(path.join(source.root, 'ENOENT missing root'));
    expect(() => loadBuildInfo()).toThrow(BuildInfoValidationError);
    expect(() => loadBuildInfo('')).toThrow(/explicit build-info path/);
    expect(() => loadBuildInfo(path.join(source.root, 'missing.json'))).toThrow(/Explicit build-info file not found/);
  });

  it.skipIf(process.platform === 'win32')('rejects dangling and linked metadata after a cache fill', () => {
    const source = fixture();
    source.write();
    loadBuildInfo();
    fs.renameSync(source.file, `${source.file}.retained`);
    fs.symlinkSync(`${source.file}.retained`, source.file);
    expect(() => loadBuildInfo()).toThrow(BuildInfoValidationError);
    fs.unlinkSync(source.file);
    fs.symlinkSync(path.join(source.root, 'absent.json'), source.file);
    expect(() => loadBuildInfo()).toThrow(BuildInfoValidationError);
  });

  it('rejects hard-link aliases even when cached bytes remain unchanged', () => {
    const source = fixture();
    source.write();
    loadBuildInfo();
    fs.linkSync(source.file, path.join(source.root, 'alias.json'));
    expect(() => loadBuildInfo()).toThrow(/singly linked/);
  });

  it('rejects duplicate fields and invalid UTF-8 instead of accepting parser-dependent identities', () => {
    const source = fixture();
    const text = JSON.stringify(source.info);
    fs.writeFileSync(source.file, text.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'));
    expect(() => loadBuildInfo()).toThrow(/duplicate or malformed/);
    fs.writeFileSync(source.file, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
    expect(() => loadBuildInfo()).toThrow(/Invalid UTF-8/);
  });

  it.each([
    { kind: undefined }, { profilesDigest: undefined }, { version: '01.13.0' },
    { version: '0.13.0-01' }, { commit: `${'a'.repeat(40)}\n` },
    { resourcesDigest: `sha256:${'a'.repeat(64)}\n` }, { buildDate: 'September 14, 2026' },
    { runtime: { name: 'node', version: '24.x' } }, { futureField: true }
  ])('refuses ambiguous or undeclared native metadata %j', (changed) => {
    const source = fixture();
    expect(() => validateNativeBuildInfo({ ...source.info, ...changed })).toThrow(BuildInfoValidationError);
  });

  it('refuses accessors before evaluating their values', () => {
    const source = fixture();
    const getter = vi.fn(() => source.info.runtime);
    const proposed = { ...source.info };
    Object.defineProperty(proposed, 'runtime', { enumerable: true, get: getter });
    expect(() => validateNativeBuildInfo(proposed)).toThrow(/without accessors/);
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('installed metadata catalog bindings, not native signature qualification', () => {
  it('binds full semantic template and profile digests independently from the resource-byte inventory', () => {
    const source = fixture();
    source.write();
    const context = validateInstalledPackageContext();
    expect(context.buildInfo).toMatchObject({
      resourcesDigest: context.templateCatalog.digest, profilesDigest: context.profilesCatalog.digest
    });
    source.write({ ...source.info, resourcesDigest: `sha256:${computeResourceInventorySummary().inventoryHash}` });
    expect(() => validateInstalledPackageContext()).toThrow(/resourcesDigest mismatch/);
    source.write({ ...source.info, profilesDigest: `sha256:${'0'.repeat(64)}` });
    expect(() => validateInstalledPackageContext()).toThrow(/profilesDigest/);
  });

  it('rejects a self-rehashed profile catalog that no longer matches the native build binding', () => {
    const source = fixture();
    source.write();
    validateInstalledPackageContext();
    const catalog = structuredClone(loadPackagedProfilesCatalog());
    catalog.profiles['node-fastify'].label = 'Changed profile semantics';
    catalog.profiles['node-fastify'].digest = computeProfileDigest(catalog.profiles['node-fastify']);
    catalog.digest = computeProfileCatalogDigest(catalog);
    fs.writeFileSync(path.join(source.root, 'assets', 'profiles', 'catalog.json'), JSON.stringify(catalog));
    expect(loadPackagedProfilesCatalog().digest).toBe(catalog.digest);
    expect(() => validateInstalledPackageContext()).toThrow(/profilesDigest/);
  });

  it('rejects changed template metadata even when registered resource bytes and their inventory hash are unchanged', () => {
    const source = fixture();
    source.write();
    const before = validateInstalledPackageContext();
    const catalog = structuredClone(loadPackagedTemplateCatalog());
    catalog.revision = '2026.09.02';
    catalog.digest = computeTemplateCatalogDigest(catalog);
    fs.writeFileSync(path.join(source.root, 'assets', 'templates', 'catalog.json'), JSON.stringify(catalog));
    expect(computeResourceInventorySummary().inventoryHash).toBe(before.resourceSummary.inventoryHash);
    expect(() => validateInstalledPackageContext()).toThrow(/resourcesDigest mismatch/);
  });

  it('does not accept metadata for a different running CLI, host or declared Node runtime', () => {
    const source = fixture();
    for (const changed of [
      { version: '99.0.0' },
      { runtime: { name: 'node', version: '99.0.0' } },
      { target: process.platform === 'win32'
        ? { os: 'linux', arch: 'x64', platform: 'linux-x64' }
        : { os: 'win32', arch: 'x64', platform: 'win32-x64' } }
    ]) {
      source.write({ ...source.info, ...changed });
      expect(() => validateInstalledPackageContext()).toThrow(/running CLI version, host and declared Node runtime/);
    }
  });
});
