import { afterEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assembleNativeReleaseSet, verifyNativeReleaseSet } from '../scripts/native-release-set.mjs';
import { recordArtifact, releaseContext } from '../scripts/release-artifact.mjs';
import { bundleFile } from '../scripts/native-bundle-contract.mjs';
import {
  nativeMaterials, verifyNativeArchive, verifyNativeArchiveSignature, verifyNativeArchiveSubjects
} from '../scripts/native-release.mjs';
import {
  assertNativeReleaseCatalog, nativeCatalogSubjects, nativeEvidenceKinds,
  nativeReleaseAssetStem, nativeReleaseCatalogFilename, nativeReleaseTargets
} from '../distribution/native/native-release-catalog.mjs';
import policy from '../distribution/native/release-policy.json';
import inputs from '../distribution/native/inputs.json';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const git = (root: string, ...args: string[]) => {
  const result = spawnSync('git', ['-c', 'user.name=Native release fixture',
    '-c', 'user.email=native-release@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args],
  { cwd: root, encoding: 'utf8', shell: false, timeout: 30_000 });
  if (result.status !== 0) throw new Error(`Fixture Git failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
};

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'liftoff native release set '));
  roots.push(parent);
  const root = path.join(parent, 'source'), handoff = path.join(parent, 'handoff');
  await mkdir(root);
  await mkdir(handoff);
  git(root, 'init', '-b', 'main');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@msn-control/liftoff', version: '1.2.3' }));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Synthetic native release source');
  const commit = git(root, 'rev-parse', 'HEAD');
  git(root, 'update-ref', 'refs/remotes/origin/main', commit);
  git(root, 'tag', 'v1.2.3');
  const env = {
    GITHUB_REPOSITORY: 'voyager163/liftoff', GITHUB_SHA: commit, GITHUB_RUN_ID: '12345',
    GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', GITHUB_REF: 'refs/tags/v1.2.3'
  };
  const context = await releaseContext(root, env);
  const evidenceKey = generateKeyPairSync('ed25519'), archiveKey = generateKeyPairSync('ed25519');
  const approvedPolicy = {
    ...policy, approvedSigningKeySha256: hash(evidenceKey.publicKey.export({ type: 'spki', format: 'der' })),
    homebrew: { cask: 'synthetic/fixture/liftoff', sourceRepository: 'synthetic/fixture', developerTeamId: 'ABCDEFGHIJ' },
    winget: { packageIdentifier: 'Synthetic.Liftoff', publisher: 'Synthetic',
      certificateSha256: '6'.repeat(64), installerAppId: 'synthetic-fixture' },
    linux: { archiveSigningKeySha256: hash(archiveKey.publicKey.export({ type: 'spki', format: 'der' })) }
  };
  const options = { root, approvedPolicy };
  const npm = path.join(handoff, 'npm');
  await mkdir(npm);
  await writeFile(path.join(npm, context.filename), 'Synthetic npm fixture bytes, not an installable package.');
  const npmRecord = await recordArtifact(npm, context);
  const nativeManifests: Record<string, string> = {};
  for (const target of nativeReleaseTargets) {
    const directory = path.join(handoff, 'native', target), evidenceDirectory = path.join(handoff, 'evidence', target);
    await mkdir(directory, { recursive: true });
    await mkdir(evidenceDirectory, { recursive: true });
    const stem = nativeReleaseAssetStem(context.version, target);
    const filename = `${stem}.tar.gz`, archive = Buffer.from(`Synthetic ${target} archive fixture, not an installable tar.`);
    await writeFile(path.join(directory, filename), archive);
    const [platform, architecture] = target.split('-');
    const manifest = {
      package: { name: context.name, version: context.version },
      platform: { platform, architecture }, runtime: inputs.runtime,
      source: { repository: context.repository, commit, builderInputs: [] }, hclSource: inputs.hcl,
      inventory: { sha256: '2'.repeat(64) },
      dependencies: [{ name: 'synthetic-fixture', version: '1.0.0', path: 'node_modules/synthetic-fixture', license: 'MIT',
        integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, notices: [{ path: 'synthetic/LICENSE' }] }],
      supplementalNotices: []
    };
    const materials = nativeMaterials(manifest, { filename, sha256: hash(archive), runId: context.runId });
    const files = [{ filename, ...await bundleFile(path.join(directory, filename)) }];
    for (const [name, content] of [
      ['sbom.cdx.json', jsonBytes(materials.sbom)], ['provenance.json', jsonBytes(materials.provenance)], ['NOTICE', materials.notices]
    ] as const) {
      await writeFile(path.join(directory, name), content);
      files.push({ filename: name, ...await bundleFile(path.join(directory, name)) });
    }
    const record = {
      schemaVersion: 1, kind: 'liftoff-native-release-candidate', releaseReady: false,
      repository: context.repository, commit, version: context.version, target, runId: context.runId,
      manifestSha256: '1'.repeat(64), inventorySha256: manifest.inventory.sha256, files,
      qualification: { minimumHost: false, installerOwnership: false, signing: false,
        notarization: false, packageNamespace: false, hclSourceCorrespondence: false }
    };
    const raw = jsonBytes(record);
    await writeFile(path.join(directory, 'native-release.json'), raw);
    nativeManifests[target] = hash(raw);
    const kinds = [...nativeEvidenceKinds, ...(platform === 'darwin' ? ['notarization'] : [])];
    const evidenceDigests: Record<string, string> = {};
    for (const name of kinds) {
      const proof = jsonBytes({ syntheticContractFixture: true, target, kind: name, commit });
      await writeFile(path.join(evidenceDirectory, `${name}.json`), proof);
      evidenceDigests[name] = hash(proof);
    }
    const windowsInstaller = {
      filename: `${stem}-setup.exe`, sha256: hash('Synthetic installer, not an executable.'), bytes: Buffer.byteLength('Synthetic installer, not an executable.'),
      appId: approvedPolicy.winget.installerAppId, publisher: approvedPolicy.winget.publisher,
      certificateSha256: approvedPolicy.winget.certificateSha256, commandVerified: true,
      url: `https://github.com/${context.repository}/releases/download/v${context.version}/${stem}-setup.exe`
    };
    const evidence = {
      ...record, qualification: Object.fromEntries(kinds.map(name => [name, true])), evidenceDigests,
      platformSigningIdentity: platform === 'darwin' ? approvedPolicy.homebrew.developerTeamId
        : platform === 'win32' ? approvedPolicy.winget.certificateSha256 : approvedPolicy.linux.archiveSigningKeySha256,
      channel: platform === 'darwin' ? { id: approvedPolicy.homebrew.cask, source: approvedPolicy.homebrew.sourceRepository }
        : platform === 'win32' ? { id: approvedPolicy.winget.packageIdentifier } : {},
      artifactUrl: `https://github.com/${context.repository}/releases/download/v${context.version}/${filename}`,
      ...(platform === 'win32' ? { windowsInstaller } : {})
    };
    const qualification = jsonBytes(evidence);
    await writeFile(path.join(evidenceDirectory, 'qualification.json'), qualification);
    await writeFile(path.join(evidenceDirectory, 'qualification.sig'), sign(null, qualification, evidenceKey.privateKey));
    await writeFile(path.join(evidenceDirectory, 'qualification.pub'), evidenceKey.publicKey.export({ type: 'spki', format: 'pem' }));
    if (platform === 'linux') {
      await writeFile(path.join(evidenceDirectory, `${filename}.sig`), sign(null, archive, archiveKey.privateKey));
      await writeFile(path.join(evidenceDirectory, `${filename}.pub`), archiveKey.publicKey.export({ type: 'spki', format: 'pem' }));
    } else if (platform === 'win32') {
      await writeFile(path.join(evidenceDirectory, windowsInstaller.filename), 'Synthetic installer, not an executable.');
    }
  }
  const input = { schemaVersion: 1, npmSha256: npmRecord.sha256, nativeManifests };
  await writeFile(path.join(handoff, 'native-inputs.json'), jsonBytes(input));
  return { parent, root, handoff, env, options, context, input, inputDigest: hash(jsonBytes(input)) };
}

describe('complete native + npm release assembly (ephemeral synthetic signing only)', () => {
  it('restricts the installer source to native x64 rather than x64 emulation or any 64-bit Windows', async () => {
    const source = await readFile('distribution/windows/liftoff.iss', 'utf8');
    expect(source).toMatch(/^ArchitecturesAllowed=x64os$/m);
    expect(source).toMatch(/^ArchitecturesInstallIn64BitMode=x64os$/m);
    expect(source).not.toContain('Result := IsWin64');
    expect(source).toContain('SignedUninstaller=yes');
    expect(source).toContain('SignTool=liftoff');
    expect(source).toContain('CloseApplications=no');
  });

  it('assembles unique immutable locators without changing signed JSON, then reauthenticates all targets and npm', async () => {
    const f = await fixture();
    const result = await assembleNativeReleaseSet(f.handoff, f.inputDigest, f.env, f.options);
    expect(result.published).toBe(false);
    expect(result.catalog.targets.map(target => target.target)).toEqual([...nativeReleaseTargets]);
    expect(new Set(nativeCatalogSubjects(result.catalog).map(file => file.filename)).size)
      .toBe(nativeCatalogSubjects(result.catalog).length);
    for (const entry of result.catalog.targets) {
      expect(await readFile(path.join(result.directory, entry.qualification.filename))).toEqual(
        await readFile(path.join(f.handoff, 'evidence', entry.target, 'qualification.json')));
      for (const file of entry.files) expect(await readFile(path.join(result.directory, file.filename))).toEqual(
        await readFile(path.join(f.handoff, 'native', entry.target, file.sourceFilename)));
    }
    await expect(verifyNativeReleaseSet(result.directory, result.catalogSha256, f.env, f.options)).resolves.toEqual(result.catalog);
    const original = await readFile(path.join(result.directory, nativeReleaseCatalogFilename));
    await expect(assembleNativeReleaseSet(f.handoff, f.inputDigest, f.env, f.options)).rejects.toThrow('EEXIST');
    expect(await readFile(path.join(result.directory, nativeReleaseCatalogFilename))).toEqual(original);
  });

  it('retains the real missing-principal refusal and creates no publication directory', async () => {
    const f = await fixture();
    await expect(assembleNativeReleaseSet(f.handoff, f.inputDigest, f.env, { root: f.root })).rejects.toThrow('not configured');
    expect(await readdir(f.handoff)).not.toContain('publication');
  });

  it.each(['input-digest', 'missing-target', 'npm-digest', 'native-digest', 'run', 'source', 'missing-evidence', 'changed-evidence', 'linux-signature'])(
    'refuses an incomplete or changed original handoff before output: %s', async fault => {
      const f = await fixture();
      if (fault === 'input-digest') f.inputDigest = '0'.repeat(64);
      if (fault === 'missing-target') delete f.input.nativeManifests['linux-arm64'];
      if (fault === 'npm-digest') f.input.npmSha256 = '0'.repeat(64);
      if (fault === 'native-digest') f.input.nativeManifests['linux-x64'] = '0'.repeat(64);
      if (fault === 'run' || fault === 'source') {
        const file = path.join(f.handoff, 'native', 'linux-x64', 'native-release.json');
        const record = await readJson(file);
        if (fault === 'run') record.runId = '99999';
        else record.commit = '9'.repeat(40);
        await writeFile(file, jsonBytes(record));
        f.input.nativeManifests['linux-x64'] = hash(jsonBytes(record));
      }
      if (fault === 'missing-evidence') await rm(path.join(f.handoff, 'evidence', 'linux-x64', 'minimumHost.json'));
      if (fault === 'changed-evidence') await writeFile(path.join(f.handoff, 'evidence', 'linux-x64', 'minimumHost.json'), '{}');
      if (fault === 'linux-signature') {
        const file = path.join(f.handoff, 'evidence', 'linux-x64', 'liftoff-1.2.3-linux-x64.tar.gz.sig');
        await writeFile(file, Buffer.alloc(64));
      }
      if (fault !== 'input-digest') {
        await writeFile(path.join(f.handoff, 'native-inputs.json'), jsonBytes(f.input));
        f.inputDigest = hash(jsonBytes(f.input));
      }
      await expect(assembleNativeReleaseSet(f.handoff, f.inputDigest, f.env, f.options)).rejects.toThrow();
      expect(await readdir(f.handoff)).not.toContain('publication');
    });

  it.each(['manual', 'unqualified-main', 'dirty-source'])('retains existing source/ref publication gates: %s', async fault => {
    const f = await fixture();
    if (fault === 'manual') f.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
    else if (fault === 'dirty-source') await writeFile(path.join(f.root, 'unreviewed.txt'), 'unreviewed');
    else git(f.root, 'update-ref', '-d', 'refs/remotes/origin/main');
    await expect(assembleNativeReleaseSet(f.handoff, f.inputDigest, f.env, f.options)).rejects.toThrow();
    expect(await readdir(f.handoff)).not.toContain('publication');
  });

  it.each(['changed-artifact', 'changed-qualification', 'changed-catalog', 'extra-file', 'hardlink'])(
    'refuses a changed assembled publication without repairing it: %s', async fault => {
      const f = await fixture();
      const result = await assembleNativeReleaseSet(f.handoff, f.inputDigest, f.env, f.options);
      if (fault === 'changed-artifact') await writeFile(path.join(result.directory, result.catalog.npm.filename), 'changed');
      if (fault === 'changed-qualification') {
        await writeFile(path.join(result.directory, result.catalog.targets[0].qualification.filename), '{}');
      }
      if (fault === 'changed-catalog') {
        await writeFile(path.join(result.directory, nativeReleaseCatalogFilename), jsonBytes({ ...result.catalog, runId: '99999' }));
      }
      if (fault === 'extra-file') await writeFile(path.join(result.directory, 'unexpected.txt'), 'unexpected');
      if (fault === 'hardlink') {
        const file = path.join(result.directory, result.catalog.npm.filename);
        await link(file, path.join(f.parent, 'external-alias.tgz'));
      }
      await expect(verifyNativeReleaseSet(result.directory, result.catalogSha256, f.env, f.options)).rejects.toThrow();
    });

  it('separates cross-host subject hashes from native filesystem-mode qualification without normalization', async () => {
    const f = await fixture(), target = 'win32-x64';
    const directory = path.join(f.handoff, 'native', target), file = path.join(directory, 'native-release.json');
    const record = await readJson(file);
    const originalMode = (await bundleFile(path.join(directory, record.files[0].filename))).mode;
    for (const item of record.files) item.mode = originalMode === 0o666 ? 0o644 : 0o666;
    await writeFile(file, jsonBytes(record));
    const digest = hash(jsonBytes(record));
    await expect(verifyNativeArchive(directory, digest, f.context.commit)).rejects.toThrow('mode changed');
    await expect(verifyNativeArchiveSubjects(directory, digest, f.context.commit)).resolves.toEqual(record);
    expect((await bundleFile(path.join(directory, record.files[0].filename))).mode).toBe(originalMode);
  });

  it('rejects missing, duplicated, escaped or unauthenticated catalog locators', async () => {
    const f = await fixture();
    const result = await assembleNativeReleaseSet(f.handoff, f.inputDigest, f.env, f.options);
    for (const fault of ['missing', 'duplicate', 'escape', 'digest']) {
      const catalog = structuredClone(result.catalog);
      if (fault === 'missing') catalog.targets.pop();
      if (fault === 'duplicate') catalog.targets[1] = catalog.targets[0];
      if (fault === 'escape') catalog.targets[0].qualification.filename = '../outside.json';
      if (fault === 'digest') catalog.targets[0].qualification.sha256 = '';
      expect(() => assertNativeReleaseCatalog(catalog)).toThrow();
    }
    expect(() => nativeReleaseAssetStem('1.2.3/../outside', 'darwin-arm64')).toThrow();
    expect(() => nativeReleaseAssetStem('1.2.3', 'darwin-x64')).toThrow();
    const url = pathToFileURL(path.resolve('distribution/native/native-release-catalog.mjs')).href;
    const resultImport = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(url)}); console.log(m.nativeReleaseCatalogFilename);`],
    { cwd: f.parent, env: { PATH: '', NODE_OPTIONS: '', NODE_PATH: '' }, encoding: 'utf8', shell: false, timeout: 10_000 });
    expect(resultImport.status, resultImport.stderr).toBe(0);
    expect(resultImport.stdout.trim()).toBe(nativeReleaseCatalogFilename);
  });
});

describe('detached Linux archive authentication (test-only generated keys)', () => {
  it('checks original bytes, exact signature, approved SPKI and algorithm independently from operator claims', () => {
    const key = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519');
    const bytes = Buffer.from('Synthetic archive signature contract specimen.');
    const signature = sign(null, bytes, key.privateKey);
    const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' });
    const digest = hash(key.publicKey.export({ type: 'spki', format: 'der' }));
    expect(() => verifyNativeArchiveSignature(bytes, signature, publicKey, digest)).not.toThrow();
    expect(() => verifyNativeArchiveSignature(Buffer.from('changed'), signature, publicKey, digest)).toThrow('signature');
    expect(() => verifyNativeArchiveSignature(bytes, Buffer.alloc(63), publicKey, digest)).toThrow('exact Ed25519');
    expect(() => verifyNativeArchiveSignature(bytes, signature, publicKey, null)).toThrow('approved');
    expect(() => verifyNativeArchiveSignature(bytes, signature, other.publicKey.export({ type: 'spki', format: 'pem' }), digest)).toThrow('principal');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
    expect(() => verifyNativeArchiveSignature(bytes, signature, rsa, digest)).toThrow('Ed25519');
  });
});
