import { cp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildArtifacts } from '../src/templates.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import {
  loadPackagedProfilesCatalog, loadPackagedTemplateCatalog,
  resetResourceCatalogCache, setPackageRootOverride
} from '../src/adapters/packaged-assets/resource-catalog.js';

describe('actual generation resource admission', () => {
  let root: string;
  beforeEach(async () => {
    root = path.resolve('tests', `.generation-resource-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    await cp(path.resolve('assets'), path.join(root, 'assets'), { recursive: true });
    await cp(path.resolve('package.json'), path.join(root, 'package.json'));
    setPackageRootOverride(root);
    resetResourceCatalogCache();
  });
  afterEach(async () => {
    setPackageRootOverride(undefined);
    resetResourceCatalogCache();
    await rm(root, { recursive: true, force: true });
  });

  const plan = () => buildProjectPlan({
    projectName: 'resource-guard', projectType: 'standard', apiStack: 'node',
    includeFrontend: true, governanceProfile: 'none'
  }, { requireProjectName: true });

  it.each(['missing', 'damaged', 'linked'] as const)('blocks actual artifact generation for a %s selected asset', async (condition) => {
    expect(buildArtifacts(plan()).some((entry) => entry.logicalName === 'manifest')).toBe(true);
    const descriptor = loadPackagedTemplateCatalog().resources['templates.frontend.styles']!;
    const filename = path.join(root, descriptor.path);
    const original = await readFile(filename);
    if (condition === 'missing') await unlink(filename);
    else if (condition === 'damaged') await writeFile(filename, Buffer.concat([original, Buffer.from('\n')]));
    else {
      const retained = path.join(root, 'retained-styles.txt');
      await rename(filename, retained);
      await symlink(retained, filename);
    }
    expect(() => buildArtifacts(plan())).toThrow();
    await expect(readFile(path.join(root, 'liftoff.manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not let a cached profile conceal a changed invalid catalog', async () => {
    const original = loadPackagedProfilesCatalog();
    const filename = path.join(root, 'assets', 'profiles', 'catalog.json');
    const edited = JSON.parse(await readFile(filename, 'utf8'));
    edited.profiles['node-fastify'].capabilities.cloud = 'none';
    await writeFile(filename, JSON.stringify(edited));
    expect(() => loadPackagedProfilesCatalog()).toThrow();
    expect(() => buildArtifacts(plan())).toThrow();
    expect(original.profiles['node-fastify'].capabilities.cloud).toBe('azure');
  });

  it('does not let a cached template catalog conceal changed resource declarations', async () => {
    loadPackagedTemplateCatalog();
    const filename = path.join(root, 'assets', 'templates', 'catalog.json');
    const edited = JSON.parse(await readFile(filename, 'utf8'));
    edited.resources['templates.frontend.styles'].size += 1;
    await writeFile(filename, JSON.stringify(edited));
    expect(() => loadPackagedTemplateCatalog()).toThrow();
    expect(() => buildArtifacts(plan())).toThrow();
  });
});
