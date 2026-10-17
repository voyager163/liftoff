import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseContext, verifyArtifact } from './release-artifact.mjs';
import { readBundleFile, bundlePath } from './native-bundle-contract.mjs';
import {
  assertNativeReleaseRecord, nativePackageDefinitions, verifyNativeArchiveSubjects, verifyNativeQualification
} from './native-release.mjs';
import {
  assertNativeReleaseCatalog, nativeCatalogSubjects, nativeEvidenceKinds,
  nativeReleaseAssetStem, nativeReleaseCatalogFilename, nativeReleaseTargets
} from '../distribution/native/native-release-catalog.mjs';
import policy from '../distribution/native/release-policy.json' with { type: 'json' };

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async (directory, name, maximum) =>
  (await readBundleFile(path.join(directory, bundlePath(name)), maximum)).content;
const subject = (filename, bytes) => ({ filename, bytes: bytes.length, sha256: hash(bytes) });
const serialize = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function directoryAt(directory) {
  assert.ok((await lstat(directory)).isDirectory(), 'Release directory must not be a link.');
  return realpath(directory);
}

function cleanSource(root) {
  const result = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root, encoding: 'utf8', shell: false, timeout: 30_000, maxBuffer: 1024 * 1024
  });
  assert.equal(result.status, 0, 'Cannot establish clean release source.');
  assert.equal(result.stdout, '', 'Native release assembly requires a clean source.');
}

function assertContext(record, context) {
  for (const field of ['repository', 'version', 'commit', 'runId']) {
    assert.equal(record[field], context[field], `Native release set ${field} differs.`);
  }
}

export async function assembleNativeReleaseSet(directory, expectedInputDigest, env = process.env,
  { root = repositoryRoot, approvedPolicy = policy } = {}) {
  const context = await releaseContext(root, env);
  cleanSource(root);
  const handoff = await directoryAt(directory);
  const sourceRoot = await realpath(root);
  assert.ok(handoff !== sourceRoot && !handoff.startsWith(`${sourceRoot}${path.sep}`),
    'Native release handoff must be outside the source checkout.');
  assert.match(expectedInputDigest ?? '', /^[a-f0-9]{64}$/, 'Exact native assembly input digest is required.');
  const inputBytes = await read(handoff, 'native-inputs.json');
  assert.equal(hash(inputBytes), expectedInputDigest, 'Native assembly input changed.');
  const input = JSON.parse(inputBytes);
  assert.deepEqual(Object.keys(input).sort(), ['nativeManifests', 'npmSha256', 'schemaVersion']);
  assert.equal(input.schemaVersion, 1);
  assert.match(input.npmSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(input.nativeManifests).sort(), [...nativeReleaseTargets]);
  const npmDirectory = await directoryAt(path.join(handoff, 'npm'));
  await directoryAt(path.join(handoff, 'native'));
  await directoryAt(path.join(handoff, 'evidence'));
  const npmRecord = await verifyArtifact(npmDirectory, context, input.npmSha256);
  const files = new Map();
  async function select(filename, sourceDirectory, sourceFilename, expectedDigest, maximum) {
    const bytes = await read(sourceDirectory, sourceFilename, maximum);
    assert.equal(hash(bytes), expectedDigest, `Release assembly subject changed: ${filename}`);
    assert.ok(!files.has(filename), 'Duplicate release assembly subject.');
    files.set(filename, { sourceDirectory, sourceFilename, identity: subject(filename, bytes), maximum });
    return files.get(filename).identity;
  }
  const npm = await select(context.filename, npmDirectory, context.filename, npmRecord.sha256, 256 * 1024 * 1024);
  const npmRecordBytes = await read(npmDirectory, 'release.json');
  assert.deepEqual(JSON.parse(npmRecordBytes), npmRecord, 'npm record changed during assembly.');
  const catalog = {
    schemaVersion: 1, kind: 'liftoff-native-release-catalog',
    repository: context.repository, name: context.name, version: context.version,
    commit: context.commit, runId: context.runId, tag: context.tag, distTag: context.distTag,
    npm, npmRecord: await select(context.filename.replace(/\.tgz$/, '.release.json'), npmDirectory,
      'release.json', hash(npmRecordBytes)), targets: []
  };
  for (const target of nativeReleaseTargets) {
    const artifactDirectory = await directoryAt(path.join(handoff, 'native', target));
    const evidenceDirectory = await directoryAt(path.join(handoff, 'evidence', target));
    const record = await verifyNativeArchiveSubjects(artifactDirectory, input.nativeManifests[target], context.commit);
    assert.equal(record.target, target, 'Native target handoff was swapped.');
    assertContext(record, context);
    const evidence = await verifyNativeQualification(record,
      (name, maximum) => read(artifactDirectory, name, maximum),
      (name, maximum) => read(evidenceDirectory, name, maximum), approvedPolicy);
    const stem = nativeReleaseAssetStem(context.version, target);
    const qualification = await read(evidenceDirectory, 'qualification.json');
    assert.deepEqual(JSON.parse(qualification), evidence, 'Qualification record changed during assembly.');
    const entry = {
      target,
      manifest: await select(`${stem}.native-release.json`, artifactDirectory, 'native-release.json', input.nativeManifests[target]),
      qualification: await select(`${stem}.qualification.json`, evidenceDirectory, 'qualification.json', hash(qualification)),
      signature: null, publicKey: null, files: [], evidence: [],
      archiveSignature: null, archivePublicKey: null, installer: null, definitions: []
    };
    for (const [field, name, maximum] of [['signature', 'qualification.sig', 64], ['publicKey', 'qualification.pub', 4096]]) {
      entry[field] = await select(`${stem}.${name}`, evidenceDirectory, name, hash(await read(evidenceDirectory, name, maximum)), maximum);
    }
    for (const item of record.files) {
      entry.files.push({ sourceFilename: item.filename, ...await select(
        item.filename === record.files[0].filename ? item.filename : `${stem}.${item.filename}`,
        artifactDirectory, item.filename, item.sha256, 256 * 1024 * 1024) });
    }
    for (const kind of [...nativeEvidenceKinds, ...(target === 'darwin-arm64' ? ['notarization'] : [])]) {
      entry.evidence.push({ kind, ...await select(`${stem}.evidence-${kind}.json`,
        evidenceDirectory, `${kind}.json`, evidence.evidenceDigests[kind]) });
    }
    if (target.startsWith('linux-')) {
      for (const [field, suffix, maximum] of [['archiveSignature', 'sig', 64], ['archivePublicKey', 'pub', 4096]]) {
        const name = `${stem}.tar.gz.${suffix}`;
        entry[field] = await select(name, evidenceDirectory, name, hash(await read(evidenceDirectory, name, maximum)), maximum);
      }
    } else {
      if (target === 'win32-x64') {
        const item = evidence.windowsInstaller;
        entry.installer = await select(item.filename, evidenceDirectory, item.filename, item.sha256, 256 * 1024 * 1024);
      }
      for (const [name, text] of Object.entries(nativePackageDefinitions(record, evidence, approvedPolicy))) {
        const bytes = Buffer.from(text);
        const item = subject(`${stem}.${name}`, bytes);
        assert.ok(!files.has(item.filename));
        files.set(item.filename, { content: bytes, identity: item });
        entry.definitions.push({ sourceFilename: name, ...item });
      }
    }
    catalog.targets.push(entry);
  }
  assertNativeReleaseCatalog(catalog);
  cleanSource(root);
  const output = path.join(handoff, 'publication');
  await mkdir(output, { mode: 0o700 });
  try {
    for (const item of files.values()) {
      const bytes = item.content ?? await read(item.sourceDirectory, item.sourceFilename, item.maximum);
      assert.deepEqual(subject(item.identity.filename, bytes), item.identity, 'Native handoff changed before assembly.');
      await writeFile(path.join(output, item.identity.filename), bytes, { flag: 'wx', mode: 0o644 });
    }
    await writeFile(path.join(output, nativeReleaseCatalogFilename), serialize(catalog), { flag: 'wx', mode: 0o644 });
    const catalogDigest = hash(serialize(catalog));
    await verifyNativeReleaseSet(output, catalogDigest, env, { root, approvedPolicy });
    return { directory: output, catalogSha256: catalogDigest, catalog, published: false };
  } catch (error) {
    throw new Error(`Native assembly failed; partial output retained at ${output}: ${error.message}`, { cause: error });
  }
}

export async function verifyNativeReleaseSet(directory, expectedDigest, env = process.env,
  { root = repositoryRoot, approvedPolicy = policy } = {}) {
  const context = await releaseContext(root, env);
  cleanSource(root);
  const output = await directoryAt(directory);
  assert.match(expectedDigest ?? '', /^[a-f0-9]{64}$/, 'Exact native release catalog digest is required.');
  const bytes = await read(output, nativeReleaseCatalogFilename);
  assert.equal(hash(bytes), expectedDigest, 'Native release catalog changed.');
  const catalog = assertNativeReleaseCatalog(JSON.parse(bytes));
  assertContext(catalog, context);
  for (const field of ['name', 'tag', 'distTag']) assert.equal(catalog[field], context[field]);
  const subjects = nativeCatalogSubjects(catalog);
  assert.deepEqual((await readdir(output)).sort(), [nativeReleaseCatalogFilename, ...subjects.map(s => s.filename)].sort(),
    'Unexpected or missing release set material.');
  for (const item of subjects) {
    const content = await read(output, item.filename, 256 * 1024 * 1024);
    assert.deepEqual(subject(item.filename, content), { filename: item.filename, bytes: item.bytes, sha256: item.sha256 },
      'Release set subject changed.');
  }
  const npmRecord = JSON.parse(await read(output, catalog.npmRecord.filename));
  for (const [field, expected] of Object.entries(context)) assert.equal(npmRecord[field], expected, `npm release ${field} differs.`);
  assert.equal(npmRecord.sha256, catalog.npm.sha256);
  for (const entry of catalog.targets) {
    const record = assertNativeReleaseRecord(JSON.parse(await read(output, entry.manifest.filename)), context.commit);
    assertContext(record, context);
    assert.equal(record.target, entry.target);
    for (const [index, item] of record.files.entries()) {
      assert.equal(item.filename, entry.files[index].sourceFilename);
      assert.equal(item.sha256, entry.files[index].sha256);
      assert.equal(item.bytes, entry.files[index].bytes);
    }
    const evidenceNames = new Map([
      ['qualification.json', entry.qualification], ['qualification.sig', entry.signature], ['qualification.pub', entry.publicKey],
      ...entry.evidence.map(item => [`${item.kind}.json`, item]),
      ...[entry.installer, entry.archiveSignature, entry.archivePublicKey].filter(Boolean).map(item => [item.filename, item])
    ]);
    const evidence = await verifyNativeQualification(record,
      (name, maximum) => {
        const item = entry.files.find(file => file.sourceFilename === name);
        assert.ok(item, 'Missing catalog archive subject.');
        return read(output, item.filename, maximum);
      }, (name, maximum) => {
        const item = evidenceNames.get(name);
        assert.ok(item, 'Missing catalog qualification subject.');
        return read(output, item.filename, maximum);
      }, approvedPolicy);
    for (const item of entry.evidence) assert.equal(item.sha256, evidence.evidenceDigests[item.kind]);
    const definitions = entry.target.startsWith('linux-') ? {} : nativePackageDefinitions(record, evidence, approvedPolicy);
    assert.deepEqual(entry.definitions.map(item => item.sourceFilename), Object.keys(definitions));
    for (const item of entry.definitions) {
      assert.equal((await read(output, item.filename)).toString('utf8'), definitions[item.sourceFilename]);
    }
  }
  cleanSource(root);
  return catalog;
}
