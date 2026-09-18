import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateTemplateCatalog } from '../../src/domain/standards/resource-catalog-schema.js';
import { validateStandardsProfileCatalog } from '../../src/domain/standards/profile-schema.js';
import { planInstallationMigration } from '../../src/application/distribution/plan-migration.js';
import { executeInstallationMigration } from '../../src/application/distribution/execute-migration.js';
import { validateNativeBuildInfo } from '../../src/adapters/packaged-assets/build-info.js';
import { sha, signedFixture, type SignedFixture } from './native-fixture.js';

const fixtures: SignedFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

async function catalogs(root = process.cwd()) {
  const [templates, profiles] = await Promise.all([
    readFile(path.join(root, 'assets', 'templates', 'catalog.json')),
    readFile(path.join(root, 'assets', 'profiles', 'catalog.json'))
  ]);
  return { templates, profiles };
}

describe('fresh signed native admission of repository catalogs', () => {
  it('stages and commits the exact current full catalogs and every declared resource', async () => {
    const source = await catalogs();
    const templates = validateTemplateCatalog(JSON.parse(source.templates.toString('utf8')), true);
    const profiles = validateStandardsProfileCatalog(JSON.parse(source.profiles.toString('utf8')), true);
    const value = await signedFixture('repository-catalog-cutover', { catalogSource: 'repository' });
    fixtures.push(value);
    const candidate = await value.admission.admitBundle(value.candidate);
    expect(value.runner.calls).toHaveLength(0);
    expect(await catalogs(value.candidate)).toEqual(source);
    expect(candidate.provenance.resources.count).toBe(Object.keys(templates.resources).length);
    const signed = new Map(candidate.provenance.files.map((file) => [file.path, file]));
    expect(signed.get('assets/templates/catalog.json')?.sha256).toBe(sha(source.templates));
    expect(signed.get('assets/profiles/catalog.json')?.sha256).toBe(sha(source.profiles));
    expect(JSON.parse(await readFile(path.join(value.candidate, 'build-info.json'), 'utf8'))).toMatchObject({
      resourcesDigest: templates.digest, profilesDigest: profiles.digest
    });
    for (const resource of Object.values(templates.resources)) {
      expect(signed.get(resource.path)).toMatchObject({ size: resource.size, sha256: resource.digest.slice(7) });
    }
    const plan = await planInstallationMigration({
      toOwner: 'direct', detector: value.detector, receiptStore: value.store, runner: value.runner,
      candidatePath: value.candidate, destinationDirectory: value.installRoot, launcherPath: value.launcher,
      now: value.reviewNow
    });
    const record = await executeInstallationMigration({ plan, approvePlan: plan.planFingerprint });
    expect(record.status, record.failure?.message).toBe('completed');
    expect(record.verification).toMatchObject({ explicitPathVerified: true, pathResolutionVerified: true, resourcesVerified: true });
    const receipt = await value.store.loadDirectReceipt(value.installRoot);
    if (!receipt) throw new Error('The exact native cutover must establish its private receipt.');
    expect(await catalogs(receipt.versionRoot)).toEqual(source);
    expect((await value.admission.admitBundle(receipt.versionRoot)).provenanceDigest).toBe(candidate.provenanceDigest);
    expect(await catalogs()).toEqual(source);
  });

  it.each(['missing', 'damaged'] as const)('rejects a %s repository resource before candidate execution', async (damage) => {
    const source = await catalogs();
    const templates = validateTemplateCatalog(JSON.parse(source.templates.toString('utf8')), true);
    const value = await signedFixture(`repository-resource-${damage}`, { catalogSource: 'repository' });
    fixtures.push(value);
    const resource = Object.values(templates.resources)[0];
    if (!resource) throw new Error('The repository catalog must contain registered resources.');
    const resourcePath = path.join(value.candidate, resource.path);
    if (damage === 'missing') await unlink(resourcePath);
    else await writeFile(resourcePath, 'Changed after final-byte signing.\n');
    await expect(value.admission.admitBundle(value.candidate)).rejects.toMatchObject({ reasonCode: 'artifact_mismatch' });
    expect(value.runner.calls).toHaveLength(0);
    expect(await catalogs()).toEqual(source);
  });

  it.each([
    'missing-profiles-digest', 'inventory-as-template-digest', 'template-as-profiles-digest', 'missing-profile-catalog'
  ] as const)('rejects genuinely signed %s metadata before release-target availability or execution', async (failure) => {
    const value = await signedFixture(`signed-auxiliary-${failure}`, {
      beforeSigning: async (bundleRoot, resources) => {
        const filename = path.join(bundleRoot, 'build-info.json');
        const info = validateNativeBuildInfo(JSON.parse(await readFile(filename, 'utf8')));
        if (failure === 'missing-profile-catalog') {
          await unlink(path.join(bundleRoot, 'assets', 'profiles', 'catalog.json'));
        } else if (failure === 'missing-profiles-digest') {
          const { profilesDigest: _omitted, ...missing } = info;
          await writeFile(filename, JSON.stringify(missing));
        } else {
          await writeFile(filename, JSON.stringify(failure === 'inventory-as-template-digest'
            ? { ...info, resourcesDigest: `sha256:${resources.inventoryHash}` }
            : { ...info, profilesDigest: info.resourcesDigest }));
        }
      }
    });
    fixtures.push(value);
    const templates = validateTemplateCatalog(JSON.parse(await readFile(path.join(value.candidate, 'assets', 'templates', 'catalog.json'), 'utf8')), true);
    expect(Object.values(templates.resources).some((resource) => resource.path === 'assets/profiles/catalog.json')).toBe(false);
    const release = await value.client.fetchVerifiedRelease('0.13.0');
    expect(release.manifest.targets[value.provenance.target].checksumSha256).toBe(value.provenance.checksumSha256);
    await expect(value.admission.admitReleaseTarget(release)).rejects.toThrow(/profilesDigest|catalog|metadata/);
    expect(value.runner.calls).toHaveLength(0);
  });

  it.each(['missing', 'unconfigured'] as const)('rejects a genuinely signed release with %s public trust', async (state) => {
    const value = await signedFixture(`signed-public-root-${state}`, {
      beforeSigning: async (bundleRoot) => {
        const filename = path.join(bundleRoot, 'assets', 'distribution', 'native-trust.json');
        if (state === 'missing') await unlink(filename);
        else await writeFile(filename, JSON.stringify({
          schemaVersion: 1, product: 'liftoff', repository: 'voyager163/liftoff', state: 'unconfigured'
        }));
      }
    });
    fixtures.push(value);
    const release = await value.client.fetchVerifiedRelease('0.13.0');
    await expect(value.admission.admitReleaseTarget(release)).rejects.toThrow(/trust/);
    expect(value.runner.calls).toHaveLength(0);
  });
});
