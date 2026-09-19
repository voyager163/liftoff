import { mkdir, realpath, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../src/governance-activation/graph.js';
import { repairExecutionIdentity, repairRecipes, repairSchemaVersions } from '../src/domain/repair/identity.js';
import { repairCapabilities } from '../src/application/repair/capabilities.js';
import { buildRepairPreview, loadRepairPreview } from '../src/application/repair/preview.js';
import { readRepairVerification, saveRepairVerification } from '../src/application/repair/verification-receipt.js';
import { preserveRepairOriginals } from '../src/application/repair/backup.js';
import { liftoffVersion } from '../src/version.js';

const roots: string[] = [];
const now = new Date('2026-09-13T12:00:00Z');
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const directory = path.resolve('tests', `.repair-identity-${randomUUID()}`);
  await mkdir(path.join(directory, 'project', '.git'), { recursive: true });
  await mkdir(path.join(directory, 'home'), { recursive: true });
  const projectRoot = await realpath(path.join(directory, 'project'));
  const home = await realpath(path.join(directory, 'home'));
  roots.push(directory);
  const storage = { homedir: home, env: {} };
  const input = {
    projectRoot, snapshots: [{ pathParts: ['old', 'app.ts'], content: Buffer.from('custom source'), mode: 0o644 }],
    mutations: [{ type: 'write' as const, pathParts: ['backend', 'src', 'app.ts'], content: 'custom target', mode: 0o644 }],
    scope: { directories: [{ pathParts: ['old'], entries: ['app.ts'] }] },
    live: false, now
  };
  const application = () => buildRepairPreview({
    ...input, recipe: 'application-layout-patch', applicationPatchPath: path.join(home, 'staged patch.json'),
    verificationPolicy: { commands: [{ executable: 'node', args: ['--test'], cwdPathParts: ['backend'] }] }
  });
  return { input, storage, application };
}

describe('independent repair identities', () => {
  it('publishes exact repair schemas and recipes without extending activation identity', () => {
    expect(repairCapabilities).toMatchObject({
      schemaVersion: 1, cliVersion: liftoffVersion, repairContractVersion: 1,
      schemas: { report: 2, preview: 2, history: 2, journal: 2, applicationPatch: 1 },
      recipes: [repairRecipes['azure-local-layout'], repairRecipes['azure-baseline-settings'], repairRecipes['application-layout-patch']]
    });
    expect(currentActivationIdentity).toMatchObject({
      liftoffVersion: '0.13.0', manifestArtifactVersion: 8, policyVersion: '8', activationContractVersion: 4
    });
    expect(currentActivationIdentity).not.toHaveProperty('repairContractVersion');
  });

  it('binds exact bytes, modes, directory inventory, recipes, staging and verification', async () => {
    const { input, storage, application } = await fixture();
    const original = buildRepairPreview(input);
    const variants = [
      buildRepairPreview({ ...input, snapshots: [{ ...input.snapshots[0], mode: 0o755 }] }),
      buildRepairPreview({ ...input, mutations: [{ ...input.mutations[0], mode: 0o755 }] }),
      buildRepairPreview({ ...input, scope: { directories: [{ pathParts: ['old'], entries: ['app.ts', 'new.ts'] }] } }),
      buildRepairPreview({ ...input, verificationPolicy: { changed: true } }),
      application()
    ];
    expect(new Set([original, ...variants].map((entry) => entry.fingerprint)).size).toBe(variants.length + 1);
    expect(original).toMatchObject({
      schemaVersion: 2, ...repairExecutionIdentity(liftoffVersion, 'azure-local-layout'), applicationPatchPath: null
    });
    await createScopedUserLocalRecordStore(input.projectRoot, 'repair-preview', storage).write(original.fingerprint, original);
    expect(await loadRepairPreview(input.projectRoot, original.fingerprint, now, storage)).toEqual(original);
    const app = application();
    await createScopedUserLocalRecordStore(input.projectRoot, 'repair-preview', storage).write(app.fingerprint, app);
    expect(await loadRepairPreview(input.projectRoot, app.fingerprint, now, storage)).toEqual(app);
  });

  it.each(['legacy-schema', 'contract', 'recipe', 'layout', 'cli', 'scope'] as const)(
    'rejects %s even with a valid recomputed public fingerprint',
    async (change) => {
      const { input, storage } = await fixture();
      const { fingerprint: _fingerprint, ...body } = buildRepairPreview(input);
      const value: Record<string, unknown> = { ...body };
      if (change === 'legacy-schema') {
        value.schemaVersion = 1;
        value.recipe = 'azure-local-layout-v1';
        delete value.repairContractVersion;
        delete value.applicationPatchPath;
      }
      if (change === 'contract') value.repairContractVersion = 999;
      if (change === 'recipe') value.recipe = { ...body.recipe, version: 999 };
      if (change === 'layout') value.recipe = { ...body.recipe, targetLayout: 'unregistered-target' };
      if (change === 'cli') value.cliVersion = '0.12.1';
      if (change === 'scope') value.applicationPatchPath = path.join(input.projectRoot, 'unapproved.json');
      const fingerprint = canonicalSha256(value);
      await createScopedUserLocalRecordStore(input.projectRoot, 'repair-preview', storage).write(fingerprint, { ...value, fingerprint });
      await expect(loadRepairPreview(input.projectRoot, fingerprint, now, storage)).rejects.toThrow(
        /Unsupported|invalid|another project, recipe or CLI/
      );
    }
  );

  it('does not mix application verification with the Azure or live-discovery lane', async () => {
    const { input } = await fixture();
    expect(() => buildRepairPreview({ ...input, recipe: 'application-layout-patch' })).toThrow('one registered recipe');
    expect(() => buildRepairPreview({
      ...input, recipe: 'application-layout-patch', applicationPatchPath: '/stage/patch.json',
      verificationPolicy: {}, live: true
    })).toThrow('one registered recipe');
  });
});

describe('bound verification and private originals', () => {
  it('retains successful verification only for the exact unchanged fresh plan', async () => {
    const { application, storage } = await fixture();
    const preview = application();
    expect(await readRepairVerification(preview, now, storage)).toBeNull();
    const receipt = await saveRepairVerification(preview, now, false, storage);
    expect(receipt.dependencyPreparationAuthorized).toBe(false);
    expect(await readRepairVerification(preview, now, storage)).toEqual(receipt);
    for (const changes of [
      { inputDigest: 'c'.repeat(64) }, { effectsDigest: 'd'.repeat(64) }, { verificationDigest: 'e'.repeat(64) },
      { recipe: repairRecipes['azure-local-layout'] }, { cliVersion: '0.12.1' }
    ]) {
      await expect(readRepairVerification({ ...preview, ...changes }, now, storage)).rejects.toThrow('different inputs, staged bytes or checks');
    }
    await expect(readRepairVerification(preview, new Date(preview.expiresAt), storage)).rejects.toThrow('stale');
    await expect(saveRepairVerification(preview, new Date(preview.expiresAt), false, storage)).rejects.toThrow('expired during verification');
  });

  it('does not infer dependency preparation permission from earlier receipt shapes', async () => {
    const { application, storage } = await fixture();
    const preview = application();
    const receipt = await saveRepairVerification(preview, now, true, storage, true);
    expect(await readRepairVerification(preview, now, storage)).toMatchObject({
      networkAuthorized: true, dependencyPreparationAuthorized: true
    });
    const other = await fixture();
    const store = createScopedUserLocalRecordStore(preview.projectRoot, 'repair-verification', other.storage);
    const { dependencyPreparationAuthorized: _permission, ...oldShape } = receipt;
    await store.write(preview.fingerprint, oldShape);
    await expect(readRepairVerification(preview, now, other.storage)).rejects.toThrow('invalid, stale');
  });

  it('preserves chunked original bytes and modes outside project history without granting restore authority', async () => {
    const { input, application, storage } = await fixture();
    const preview = application();
    const bytes = Buffer.alloc(70_000, 0x41);
    const backup = await preserveRepairOriginals(preview, [
      { pathParts: ['legacy', 'custom.ts'], content: bytes, mode: 0o755 },
      { pathParts: ['backend', 'custom.ts'] }
    ], storage);
    expect(path.relative(input.projectRoot, backup.path).startsWith('..')).toBe(true);
    const store = createScopedUserLocalRecordStore(input.projectRoot, 'repair-backup', storage);
    const record = (await store.read(backup.indexKey))?.value;
    expect(record).toMatchObject({ schemaVersion: repairSchemaVersions.applicationBackup, fingerprint: preview.fingerprint });
    if (!isRecord(record) || !Array.isArray(record.files) || !isRecord(record.files[0])) throw new Error('Expected backup index.');
    const file = record.files[0];
    expect(file).toMatchObject({ mode: 0o755, chunks: 3 });
    const parts: Buffer[] = [];
    for (let index = 0; index < 3; index++) {
      const chunk = (await store.read(canonicalSha256({ fileKey: file.fileKey, index })))?.value;
      if (!isRecord(chunk) || typeof chunk.bytes !== 'string') throw new Error('Expected private backup chunk.');
      parts.push(Buffer.from(chunk.bytes, 'base64'));
    }
    expect(Buffer.concat(parts)).toEqual(bytes);
    expect(record.files[1]).toMatchObject({ digest: null, mode: null, chunks: 0 });
    expect(JSON.stringify(record)).not.toContain(bytes.toString('base64'));
  });
});
