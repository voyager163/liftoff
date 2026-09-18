import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nativeBuildInfoDocument } from '../scripts/distribution/assemble-native-bundle.mjs';
import { resetBuildInfoCache, validateNativeBuildInfo } from '../src/adapters/packaged-assets/build-info.js';
import {
  computeResourceInventorySummary, loadPackagedProfilesCatalog, loadPackagedTemplateCatalog,
  resetResourceCatalogCache, validateInstalledPackageContext
} from '../src/adapters/packaged-assets/resource-catalog.js';
import { setPackageRootOverride } from '../src/adapters/packaged-assets/package-root.js';
import { allNativeTargets } from '../src/domain/distribution/contracts.js';
import { liftoffVersion } from '../src/version.js';

describe('native auxiliary writer and reader agreement, not release qualification', () => {
  it.each(allNativeTargets)('uses the registered schema and independent full catalog bindings for %s', (target) => {
    const templates = loadPackagedTemplateCatalog(), profiles = loadPackagedProfilesCatalog();
    const inventory = computeResourceInventorySummary(templates);
    const document = nativeBuildInfoDocument({
      version: liftoffVersion, sourceCommit: 'a'.repeat(40), target, nodeVersion: '24.20.0',
      resourcesDigest: templates.digest, profilesDigest: profiles.digest, builtAt: '2026-09-15T00:00:00.000Z'
    });
    expect(validateNativeBuildInfo(JSON.parse(JSON.stringify(document)))).toEqual(document);
    expect(document.resourcesDigest).toBe(templates.digest);
    expect(document.resourcesDigest).not.toBe(`sha256:${inventory.inventoryHash}`);
    expect(document.profilesDigest).toBe(profiles.digest);
    expect(document.target.platform).toBe(target);
  });

  it('does not substitute an old source commit or absent catalog identity', () => {
    const document = nativeBuildInfoDocument({
      version: liftoffVersion, target: 'darwin-arm64', nodeVersion: '24.20.0',
      builtAt: '2026-09-15T00:00:00.000Z'
    });
    expect(document.commit).toBeUndefined();
    expect(document.profilesDigest).toBeUndefined();
    expect(document.resourcesDigest).toBeUndefined();
    expect(() => validateNativeBuildInfo(document)).toThrow();
  });

  it('loads actual serialized release-writer output through strict installed context, not development fallback', () => {
    const root = path.join(process.cwd(), 'tests', `.native-writer-context-${randomUUID()}`);
    fs.mkdirSync(root);
    try {
      for (const relative of ['package.json', 'assets/templates/catalog.json', 'assets/profiles/catalog.json']) {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        fs.copyFileSync(path.join(process.cwd(), relative), path.join(root, relative));
      }
      setPackageRootOverride(root);
      resetBuildInfoCache();
      resetResourceCatalogCache();
      const templates = loadPackagedTemplateCatalog();
      const profiles = loadPackagedProfilesCatalog();
      const inventory = computeResourceInventorySummary(templates);
      const document = nativeBuildInfoDocument({
        version: liftoffVersion, sourceCommit: 'a'.repeat(40),
        target: `${process.platform}-${process.arch}`, nodeVersion: process.versions.node,
        resourcesDigest: templates.digest, profilesDigest: profiles.digest, builtAt: '2026-09-15T00:00:00.000Z'
      });
      const metadata = path.join(root, 'build-info.json');
      fs.writeFileSync(metadata, JSON.stringify(document));
      const accepted = validateInstalledPackageContext();
      expect(accepted.buildInfo.kind).toBe('native-release');
      expect(accepted.buildInfo.resourcesDigest).toBe(accepted.templateCatalog.digest);
      expect(accepted.resourceSummary).toEqual(inventory);
      fs.writeFileSync(metadata, JSON.stringify({ ...document, resourcesDigest: `sha256:${inventory.inventoryHash}` }));
      expect(() => validateInstalledPackageContext()).toThrow(/resourcesDigest mismatch/);
    } finally {
      setPackageRootOverride(undefined);
      resetBuildInfoCache();
      resetResourceCatalogCache();
      fs.rmSync(root, { recursive: true, force: false });
    }
  });
});
