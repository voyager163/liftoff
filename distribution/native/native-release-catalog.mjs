import assert from 'node:assert/strict';

export const nativeReleaseCatalogFilename = 'liftoff-native-release.json';
export const nativeReleaseTargets = Object.freeze(['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64']);
export const nativeEvidenceKinds = Object.freeze([
  'minimumHost', 'installerOwnership', 'signing', 'packageNamespace', 'hclSourceCorrespondence'
]);

export function nativeReleaseAssetStem(version, target) {
  assert.match(version ?? '', /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
  assert.ok(nativeReleaseTargets.includes(target), 'Unknown native release target.');
  return `liftoff-${version}-${target}`;
}

export function nativeCatalogSubjects(catalog) {
  return [catalog.npm, catalog.npmRecord, ...catalog.targets.flatMap(target => [
    target.manifest, target.qualification, target.signature, target.publicKey,
    ...target.files, ...target.evidence, ...target.definitions,
    ...[target.installer, target.archiveSignature, target.archivePublicKey].filter(Boolean)
  ])];
}

// This validates locators only. Authenticity still requires the approved
// qualification key, exact signed subjects and the independent release ref gate.
export function assertNativeReleaseCatalog(catalog) {
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.kind, 'liftoff-native-release-catalog');
  assert.equal(catalog.repository, 'voyager163/liftoff');
  assert.equal(catalog.name, '@msn-control/liftoff');
  nativeReleaseAssetStem(catalog.version, nativeReleaseTargets[0]);
  assert.match(catalog.commit ?? '', /^[a-f0-9]{40}$/);
  assert.match(catalog.runId ?? '', /^[1-9]\d*$/);
  assert.equal(catalog.tag, `v${catalog.version}`);
  assert.equal(catalog.distTag, catalog.version.includes('-') ? 'next' : 'latest');
  assert.equal(catalog.npm.filename, `msn-control-liftoff-${catalog.version}.tgz`);
  assert.equal(catalog.npmRecord.filename, `msn-control-liftoff-${catalog.version}.release.json`);
  assert.deepEqual(catalog.targets.map(target => target.target), [...nativeReleaseTargets],
    'The catalog must contain every native target exactly once in canonical order.');
  for (const target of catalog.targets) {
    const stem = nativeReleaseAssetStem(catalog.version, target.target);
    for (const [field, suffix] of [
      ['manifest', 'native-release.json'], ['qualification', 'qualification.json'],
      ['signature', 'qualification.sig'], ['publicKey', 'qualification.pub']
    ]) assert.equal(target[field].filename, `${stem}.${suffix}`);
    const originals = [`${stem}.tar.gz`, 'sbom.cdx.json', 'provenance.json', 'NOTICE'];
    assert.deepEqual(target.files.map(file => file.sourceFilename), originals);
    for (const file of target.files) {
      assert.equal(file.filename, file.sourceFilename === originals[0] ? originals[0] : `${stem}.${file.sourceFilename}`);
    }
    const kinds = [...nativeEvidenceKinds, ...(target.target === 'darwin-arm64' ? ['notarization'] : [])];
    assert.deepEqual(target.evidence.map(file => file.kind), kinds);
    for (const file of target.evidence) assert.equal(file.filename, `${stem}.evidence-${file.kind}.json`);
    if (target.target.startsWith('linux-')) {
      assert.equal(target.archiveSignature.filename, `${stem}.tar.gz.sig`);
      assert.equal(target.archivePublicKey.filename, `${stem}.tar.gz.pub`);
    } else {
      assert.equal(target.archiveSignature, null);
      assert.equal(target.archivePublicKey, null);
    }
    if (target.target === 'win32-x64') assert.equal(target.installer.filename, `${stem}-setup.exe`);
    else assert.equal(target.installer, null);
    assert.ok(Array.isArray(target.definitions));
    if (target.target === 'darwin-arm64') {
      assert.equal(target.definitions.length, 1);
      assert.match(target.definitions[0].sourceFilename, /^[a-z0-9-]+\.rb$/);
    } else if (target.target === 'win32-x64') {
      assert.equal(target.definitions.length, 3);
      const id = target.definitions[0].sourceFilename.replace(/\.yaml$/, '');
      assert.match(id, /^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+$/);
      assert.deepEqual(target.definitions.map(file => file.sourceFilename), [
        `${id}.yaml`, `${id}.locale.en-US.yaml`, `${id}.installer.yaml`
      ]);
    } else assert.deepEqual(target.definitions, []);
    for (const file of target.definitions) assert.equal(file.filename, `${stem}.${file.sourceFilename}`);
  }
  const names = new Set([nativeReleaseCatalogFilename]);
  for (const file of nativeCatalogSubjects(catalog)) {
    assert.match(file.filename ?? '', /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/, 'Release asset must be a bounded flat filename.');
    assert.ok(!names.has(file.filename), 'Duplicate release asset filename.');
    names.add(file.filename);
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= 256 * 1024 * 1024);
    assert.match(file.sha256 ?? '', /^[a-f0-9]{64}$/);
  }
  return catalog;
}
