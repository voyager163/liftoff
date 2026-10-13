#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleFile, bundlePath, nativeArchiveTool, readBundleFile } from './native-bundle-contract.mjs';
import { verifyNativeBundle } from './native-bundle.mjs';
import { releaseContext } from './release-artifact.mjs';
import policy from '../distribution/native/release-policy.json' with { type: 'json' };
import platforms from '../distribution/native/platforms.json' with { type: 'json' };
import { stringify } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse((await readBundleFile(file)).content.toString('utf8'));

export function nativeMaterials(manifest, artifact) {
  const components = [
    { type: 'application', name: manifest.package.name, version: manifest.package.version,
      licenses: [{ license: { id: 'GPL-3.0-only' } }] },
    { type: 'application', name: 'node', version: manifest.runtime.version,
      hashes: [{ alg: 'SHA-256', content: manifest.runtime.executableSha256 }],
      licenses: [{ license: { name: 'Node.js and bundled third-party notices in runtime/LICENSE' } }] },
    ...manifest.dependencies.map(dependency => ({
      type: 'library', name: dependency.name, version: dependency.version,
      purl: `pkg:npm/${dependency.name.replace('@', '%40')}@${dependency.version}`,
      'bom-ref': dependency.path,
      hashes: [{ alg: 'SHA-512', content: Buffer.from(dependency.integrity.slice(7), 'base64').toString('hex') }],
      licenses: [{ expression: dependency.license }]
    }))
  ];
  return {
    sbom: { bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, components,
      properties: [
        { name: 'liftoff:sourceCommit', value: manifest.source.commit },
        { name: 'liftoff:inventorySha256', value: manifest.inventory.sha256 },
        { name: 'liftoff:hclModifiedSource', value: String(manifest.hclSource.upstreamBuildReportsModifiedSource) }
      ] },
    provenance: {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [{ name: artifact.filename, digest: { sha256: artifact.sha256 } }],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: {
        buildDefinition: {
          buildType: 'https://github.com/voyager163/liftoff/native-directory-bundle/v1',
          externalParameters: { repository: manifest.source.repository, commit: manifest.source.commit,
            packageVersion: manifest.package.version, target: manifest.platform },
          internalParameters: { releaseReady: false },
          resolvedDependencies: [
            { uri: `git+https://github.com/${manifest.source.repository}`, digest: { gitCommit: manifest.source.commit } },
            { uri: manifest.runtime.url, digest: { sha256: manifest.runtime.sha256 } },
            ...manifest.source.builderInputs.map(input => ({ uri: input.path, digest: { sha256: input.sha256 } }))
          ]
        },
        runDetails: {
          builder: { id: 'https://github.com/voyager163/liftoff/scripts/native-bundle.mjs' },
          metadata: { invocationId: artifact.runId === null ? `local:${artifact.sha256}` : `https://github.com/voyager163/liftoff/actions/runs/${artifact.runId}` }
        }
      }
    },
    notices: [
      `Liftoff ${manifest.package.version}: GPL-3.0-only (application/LICENSE).`,
      `Node.js ${manifest.runtime.version}: runtime/LICENSE includes its original third-party notices.`,
      ...manifest.dependencies.map(dependency =>
        `${dependency.name}@${dependency.version}: ${dependency.license}; ${dependency.notices.map(notice => notice.path).join(', ')}`),
      ...manifest.supplementalNotices.map(notice => `${notice.path}: original source ${notice.sourceUrl}; sha256 ${notice.sha256}`),
      'The upstream HCL WASM reports modified source; reproducible source correspondence is not qualified.',
      'These unsigned development materials are inventory/provenance records, not signed release attestations.'
    ].join('\n') + '\n'
  };
}

export async function archiveNativeBundle({ bundle, output, env = process.env }) {
  const manifest = await verifyNativeBundle(bundle);
  assert.equal(manifest.source.dirty, false, 'Native archive handoff requires a clean committed source.');
  const current = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(current.status, 0, 'Cannot establish current source revision.');
  assert.equal(current.stdout.trim(), manifest.source.commit, 'Native bundle belongs to another source revision.');
  const directory = path.resolve(output);
  const parent = await realpath(path.dirname(directory));
  const canonical = path.join(parent, path.basename(directory));
  const sourceRoot = await realpath(root);
  assert.ok(canonical !== sourceRoot && !canonical.startsWith(`${sourceRoot}${path.sep}`),
    'Native archive output must be outside the checkout.');
  await mkdir(canonical, { mode: 0o700 });
  const target = `${manifest.platform.platform}-${manifest.platform.architecture}`;
  const filename = `liftoff-${manifest.package.version}-${target}.tar.gz`;
  bundlePath(filename);
  const archive = path.join(canonical, filename);
  const tar = nativeArchiveTool();
  const result = spawnSync(tar, ['-czf', archive, '-C', await realpath(bundle), '.'], {
    encoding: 'utf8', shell: false, timeout: 120_000, maxBuffer: 1024 * 1024
  });
  assert.equal(result.status, 0, `Native archiving failed: ${result.error?.message ?? result.stderr}`);
  await verifyNativeBundle(bundle);
  const archiveIdentity = await bundleFile(archive);
  const artifact = { filename, ...archiveIdentity, runId: env.GITHUB_RUN_ID ?? null };
  const materials = nativeMaterials(manifest, artifact);
  const files = [{ filename, ...archiveIdentity }];
  for (const [name, content] of [
    ['sbom.cdx.json', `${JSON.stringify(materials.sbom, null, 2)}\n`],
    ['provenance.json', `${JSON.stringify(materials.provenance, null, 2)}\n`],
    ['NOTICE', materials.notices]
  ]) {
    await writeFile(path.join(canonical, name), content, { flag: 'wx', mode: 0o644 });
    files.push({ filename: name, ...await bundleFile(path.join(canonical, name)) });
  }
  const record = {
    schemaVersion: 1, kind: 'liftoff-native-release-candidate', releaseReady: false,
    repository: manifest.source.repository, commit: manifest.source.commit,
    version: manifest.package.version, target, runId: artifact.runId,
    manifestSha256: (await bundleFile(path.join(bundle, 'bundle.json'))).sha256,
    inventorySha256: manifest.inventory.sha256, files,
    qualification: { minimumHost: false, installerOwnership: false, signing: false,
      notarization: false, packageNamespace: false, hclSourceCorrespondence: false }
  };
  await writeFile(path.join(canonical, 'native-release.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  return verifyNativeArchive(canonical, hash(await readFile(path.join(canonical, 'native-release.json'))), record.commit);
}

export async function verifyNativeArchive(directory, expectedDigest, expectedCommit) {
  assert.match(expectedDigest ?? '', /^[a-f0-9]{64}$/, 'Exact native manifest digest must come from qualification.');
  assert.match(expectedCommit ?? '', /^[a-f0-9]{40}$/, 'Exact source revision must come from qualification.');
  const inspected = await readBundleFile(path.join(directory, 'native-release.json'));
  assert.equal(inspected.identity.sha256, expectedDigest, 'Native artifact manifest changed.');
  const record = JSON.parse(inspected.content.toString('utf8'));
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.kind, 'liftoff-native-release-candidate');
  assert.equal(record.repository, 'voyager163/liftoff');
  assert.equal(record.commit, expectedCommit, 'Native artifact source revision changed.');
  assert.match(record.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
  assert.ok(['darwin-arm64', 'win32-x64', 'linux-x64', 'linux-arm64'].includes(record.target));
  assert.equal(record.releaseReady, false, 'A development archive cannot mint release approval.');
  assert.match(record.manifestSha256, /^[a-f0-9]{64}$/);
  assert.match(record.inventorySha256, /^[a-f0-9]{64}$/);
  assert.ok(record.runId === null || /^[1-9]\d*$/.test(record.runId), 'Native run identity is malformed.');
  assert.deepEqual(record.qualification, { minimumHost: false, installerOwnership: false, signing: false,
    notarization: false, packageNamespace: false, hclSourceCorrespondence: false },
  'A development handoff cannot claim platform qualification.');
  const expectedFiles = [`liftoff-${record.version}-${record.target}.tar.gz`, 'sbom.cdx.json', 'provenance.json', 'NOTICE'];
  assert.deepEqual(record.files.map(file => file.filename), expectedFiles, 'Native sidecar inventory differs.');
  assert.deepEqual((await readdir(directory)).sort(), [...expectedFiles, 'native-release.json'].sort(), 'Unexpected native artifact material.');
  for (const file of record.files) {
    assert.deepEqual(await bundleFile(path.join(directory, bundlePath(file.filename))),
      { bytes: file.bytes, sha256: file.sha256, mode: file.mode }, 'Native artifact digest, bytes or mode changed.');
  }
  const sbom = await json(path.join(directory, 'sbom.cdx.json'));
  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.equal(sbom.specVersion, '1.6');
  assert.ok(sbom.components.length >= 3, 'Native dependency SBOM is empty.');
  assert.equal(sbom.components[0].version, record.version, 'SBOM package version differs.');
  assert.equal(sbom.components[0].name, '@msn-control/liftoff');
  assert.equal(sbom.properties.find(item => item.name === 'liftoff:sourceCommit')?.value, record.commit);
  assert.equal(sbom.properties.find(item => item.name === 'liftoff:inventorySha256')?.value, record.inventorySha256);
  const provenance = await json(path.join(directory, 'provenance.json'));
  assert.equal(provenance._type, 'https://in-toto.io/Statement/v1');
  assert.equal(provenance.predicateType, 'https://slsa.dev/provenance/v1');
  assert.deepEqual(provenance.subject, [{ name: record.files[0].filename, digest: { sha256: record.files[0].sha256 } }]);
  const [platform, architecture] = record.target.split('-');
  assert.deepEqual(provenance.predicate.buildDefinition.externalParameters, {
    repository: record.repository, commit: record.commit, packageVersion: record.version,
    target: { platform, architecture }
  });
  assert.deepEqual(provenance.predicate.buildDefinition.internalParameters, { releaseReady: false });
  return record;
}

export function assertNativePublicationEvidence(record, evidence, approvedPolicy = policy) {
  assert.equal(approvedPolicy.repository, record.repository);
  assert.match(approvedPolicy.approvedSigningKeySha256 ?? '', /^[a-f0-9]{64}$/, 'No approved native release signing identity is configured.');
  assert.ok(['darwin-arm64', 'win32-x64', 'linux-x64', 'linux-arm64'].includes(record.target), 'Unsupported native publication target.');
  for (const key of ['repository', 'commit', 'version', 'target', 'manifestSha256', 'inventorySha256']) {
    assert.equal(evidence[key], record[key], `Native qualification ${key} differs.`);
  }
  assert.deepEqual(evidence.files, record.files, 'Signing/qualification is not bound to the exact native artifacts.');
  for (const key of ['minimumHost', 'installerOwnership', 'signing', 'packageNamespace', 'hclSourceCorrespondence']) {
    assert.equal(evidence.qualification[key], true, `Native publication lacks ${key} evidence.`);
    assert.match(evidence.evidenceDigests[key] ?? '', /^[a-f0-9]{64}$/, `Native publication lacks the ${key} evidence artifact.`);
  }
  if (record.target === 'darwin-arm64') {
    assert.equal(evidence.qualification.notarization, true, 'macOS notarization is required.');
    assert.match(evidence.evidenceDigests.notarization ?? '', /^[a-f0-9]{64}$/);
    assert.match(approvedPolicy.homebrew.cask ?? '', /^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/, 'No approved cask namespace.');
    assert.match(approvedPolicy.homebrew.sourceRepository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    assert.match(approvedPolicy.homebrew.developerTeamId ?? '', /^[A-Z0-9]{10}$/, 'No approved Developer ID team.');
    assert.equal(evidence.channel.id, approvedPolicy.homebrew.cask);
    assert.equal(evidence.channel.source, approvedPolicy.homebrew.sourceRepository);
    assert.equal(evidence.platformSigningIdentity, approvedPolicy.homebrew.developerTeamId);
  } else if (record.target === 'win32-x64') {
    assert.match(approvedPolicy.winget.packageIdentifier ?? '', /^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+$/, 'No approved WinGet ID.');
    assert.match(approvedPolicy.winget.certificateSha256 ?? '', /^[a-f0-9]{64}$/, 'No approved Authenticode certificate.');
    assert.ok(approvedPolicy.winget.publisher && approvedPolicy.winget.installerAppId, 'No approved installer publisher/AppId.');
    assert.equal(evidence.channel.id, approvedPolicy.winget.packageIdentifier);
    assert.equal(evidence.platformSigningIdentity, approvedPolicy.winget.certificateSha256);
  } else {
    assert.match(approvedPolicy.linux.archiveSigningKeySha256 ?? '', /^[a-f0-9]{64}$/, 'No approved Linux archive signing key.');
    assert.equal(evidence.platformSigningIdentity, approvedPolicy.linux.archiveSigningKeySha256);
  }
  return evidence;
}

export function verifyNativeEvidenceSignature(bytes, signature, publicKey, expectedKeySha256) {
  const key = createPublicKey(publicKey);
  assert.equal(key.asymmetricKeyType, 'ed25519', 'Native evidence requires the approved Ed25519 signing algorithm.');
  const der = key.export({ format: 'der', type: 'spki' });
  assert.match(expectedKeySha256 ?? '', /^[a-f0-9]{64}$/, 'Native signing principal is not approved.');
  assert.equal(hash(der), expectedKeySha256, 'Native signing principal differs.');
  assert.ok(verify(null, bytes, key, signature), 'Native qualification signature did not verify.');
  return JSON.parse(bytes.toString('utf8'));
}

export function nativePackageDefinitions(record, evidence, approvedPolicy = policy) {
  assertNativePublicationEvidence(record, evidence, approvedPolicy);
  assert.match(record.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
  const base = `https://github.com/${record.repository}/releases/download/v${record.version}/`;
  if (record.target === 'darwin-arm64') {
    const token = approvedPolicy.homebrew.cask.split('/').at(-1);
    assert.equal(record.files[0].filename, `liftoff-${record.version}-darwin-arm64.tar.gz`);
    assert.match(record.files[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(evidence.artifactUrl, `${base}${record.files[0].filename}`, 'Cask URL must identify the exact qualified release asset.');
    return { [`${token}.rb`]: [
      `cask "${token}" do`,
      `  version "${record.version}"`,
      `  sha256 "${record.files[0].sha256}"`,
      `  url "${evidence.artifactUrl}"`,
      '  name "Liftoff"',
      '  desc "CLI for governed GenAI applications and APIs"',
      `  homepage "https://github.com/${record.repository}"`,
      '  depends_on arch: :arm64',
      '  depends_on macos: ">= :ventura"',
      '  preflight do',
      '    odie "Native Apple Silicon is required" unless Hardware::CPU.arm? && !Hardware::CPU.in_rosetta2?',
      `    odie "The qualified runtime requires macOS ${platforms.targets['darwin-arm64'].minimumOs} or newer" if MacOS.version < MacOSVersion.new("${platforms.targets['darwin-arm64'].minimumOs}")`,
      '  end',
      '  binary "bin/liftoff"',
      'end', ''
    ].join('\n') };
  }
  assert.equal(record.target, 'win32-x64', 'Linux archives do not use Homebrew or WinGet definitions.');
  const installer = evidence.windowsInstaller;
  assert.equal(installer.filename, `liftoff-${record.version}-win32-x64-setup.exe`);
  assert.match(installer.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(installer.bytes) && installer.bytes > 0);
  assert.equal(installer.appId, approvedPolicy.winget.installerAppId);
  assert.equal(installer.publisher, approvedPolicy.winget.publisher);
  assert.equal(installer.certificateSha256, approvedPolicy.winget.certificateSha256);
  assert.equal(installer.commandVerified, true, 'Installed command ownership must be qualified before a WinGet command can be declared.');
  assert.equal(installer.url, `${base}${installer.filename}`, 'WinGet URL must identify the exact qualified installer.');
  const common = { PackageIdentifier: approvedPolicy.winget.packageIdentifier,
    PackageVersion: record.version, ManifestVersion: '1.10.0' };
  return {
    [`${common.PackageIdentifier}.yaml`]: stringify({ ...common, DefaultLocale: 'en-US', ManifestType: 'version' }),
    [`${common.PackageIdentifier}.locale.en-US.yaml`]: stringify({ ...common, PackageLocale: 'en-US',
      Publisher: installer.publisher, PackageName: 'Liftoff', License: 'GPL-3.0-only',
      ShortDescription: 'CLI for governed GenAI applications and APIs', ManifestType: 'defaultLocale' }),
    [`${common.PackageIdentifier}.installer.yaml`]: stringify({ ...common, InstallerType: 'inno', Scope: 'user',
      MinimumOSVersion: platforms.targets['win32-x64'].minimumOs, UpgradeBehavior: 'install', Commands: ['liftoff'],
      Installers: [{ Architecture: 'x64', InstallerUrl: installer.url, InstallerSha256: installer.sha256.toUpperCase() }],
      ManifestType: 'installer' })
  };
}

export async function verifyNativeReleaseForPublication(directory, digest, commit, env = process.env) {
  const record = await verifyNativeArchive(directory, digest, commit);
  const context = await releaseContext(root, env);
  assert.equal(context.commit, record.commit);
  assert.equal(context.version, record.version);
  assert.equal(record.runId, context.runId, 'Native artifacts must come from this exact release qualification run.');
  assert.match(policy.approvedSigningKeySha256 ?? '', /^[a-f0-9]{64}$/, 'Native signing/namespace qualification is not configured.');
  assert.ok(env.LIFTOFF_NATIVE_EVIDENCE_DIRECTORY, 'An exact signed evidence handoff is required.');
  const evidenceRoot = env.LIFTOFF_NATIVE_EVIDENCE_DIRECTORY;
  const bytes = (await readBundleFile(path.join(evidenceRoot, 'qualification.json'))).content;
  const signature = (await readBundleFile(path.join(evidenceRoot, 'qualification.sig'), 64)).content;
  const key = (await readBundleFile(path.join(evidenceRoot, 'qualification.pub'), 4096)).content;
  const evidence = verifyNativeEvidenceSignature(bytes, signature, key, policy.approvedSigningKeySha256);
  assertNativePublicationEvidence(record, evidence);
  for (const [name, expected] of Object.entries(evidence.evidenceDigests)) {
    assert.equal(bundlePath(name).split('/').length, 1, 'Evidence names must be bounded direct filenames.');
    assert.equal((await bundleFile(path.join(evidenceRoot, `${bundlePath(name)}.json`))).sha256, expected,
      'Referenced platform evidence changed.');
  }
  if (record.target === 'win32-x64') {
    nativePackageDefinitions(record, evidence);
    const installer = await bundleFile(path.join(evidenceRoot, bundlePath(evidence.windowsInstaller.filename)));
    assert.equal(installer.sha256, evidence.windowsInstaller.sha256, 'Exact qualified Windows installer changed.');
    assert.equal(installer.bytes, evidence.windowsInstaller.bytes, 'Qualified Windows installer size changed.');
  }
  return { record, evidence };
}

async function main() {
  const [operation, directory, digest, commit, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0, 'Unexpected native release arguments.');
  if (operation === 'archive') {
    assert.ok(directory && digest && commit === undefined, 'archive requires a bundle and a new output directory.');
    console.log(JSON.stringify(await archiveNativeBundle({ bundle: path.resolve(directory), output: digest }), null, 2));
    return;
  }
  assert.ok(directory && digest && commit, 'verify/check-publication/definitions require directory, approved manifest digest and source SHA.');
  const record = await verifyNativeArchive(path.resolve(directory), digest, commit);
  if (operation === 'check-publication' || operation === 'definitions') {
    const verified = await verifyNativeReleaseForPublication(path.resolve(directory), digest, commit);
    if (operation === 'definitions') {
      console.log(JSON.stringify(nativePackageDefinitions(verified.record, verified.evidence), null, 2));
      return;
    }
  } else assert.equal(operation, 'verify', 'Unknown native release operation.');
  console.log(JSON.stringify({ status: 'verified', releaseReady: false, ...record }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Native release remains blocked: ${error.message}`);
    process.exitCode = 1;
  });
}
