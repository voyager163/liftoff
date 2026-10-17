import { generateKeyPairSync, sign } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bundleInventory } from '../../scripts/native-bundle-contract.mjs';
import { defaultSelfUpgradeDependencies } from '../../src/adapters/distribution/upgrade-host.js';
import { macMigrationHash as hash } from '../../src/adapters/distribution/mac-npm-owner.js';
import { captureMigrationTree, copyMigrationTree } from '../../src/adapters/distribution/mac-migration-state.js';
import type { MacMigrationDependencies, MacMigrationRequest } from '../../src/application/upgrade/mac-migration.js';
import type { MacNpmManager } from '../../src/domain/distribution/mac-migration.js';
import type { NativeReleasePolicy } from '../../src/domain/distribution/native-upgrade.js';
import type { NativeStableMaterial } from '../../src/adapters/distribution/native-metadata.js';
import { isStableSemver } from '../../src/stable-release.js';

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

// Real private file/process fixtures, synthetic manager/publication evidence; never public qualification.
export async function macMigrationFixture(manager: MacNpmManager = 'custom', shared = false, observeChildEnvironment = false,
  nativeBundle?: string) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lf mac migration spaces ')));
  const childEnvironmentFile = path.join(root, 'child-environment.jsonl');
  const childEnvironmentProbe = path.join(root, 'child-environment-probe.cjs');
  if (observeChildEnvironment) await writeFile(childEnvironmentProbe, `
const fs = require('node:fs');
const keys = ['HOME','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','DO_NOT_TRACK','LIFTOFF_TELEMETRY',
'NODE_OPTIONS','NODE_PATH','LIFTOFF_MIGRATION_PARENT_ONLY_FIXTURE','HTTP_PROXY','npm_config_registry','VOLTA_HOME'];
const environment = Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
fs.appendFileSync(${JSON.stringify(childEnvironmentFile)}, JSON.stringify(environment) + '\\n');
if (['LIFTOFF_MIGRATION_PARENT_ONLY_FIXTURE','HTTP_PROXY','npm_config_registry','VOLTA_HOME']
.some(key => process.env[key] !== undefined)) process.exitCode = 95;
`, { mode: 0o600 });
  const childEnvironmentGuard = observeChildEnvironment
    ? `${JSON.stringify(process.execPath)} ${JSON.stringify(childEnvironmentProbe)} || exit $?\n` : '';
  const nvmRoot = path.join(root, 'nvm home');
  const voltaRoot = path.join(root, 'volta home');
  const prefix = manager === 'nvm' ? path.join(nvmRoot, 'versions/node/v24.21.0') :
    manager === 'volta' ? path.join(voltaRoot, 'tools/image/node/24.21.0') : path.join(root, 'old prefix');
  const brewPrefix = shared || manager === 'homebrew-node' ? prefix : path.join(root, 'brew prefix');
  const oldPackage = path.join(prefix, 'lib/node_modules/@msn-control/liftoff');
  const npm = path.join(prefix, 'lib/node_modules/npm/bin/npm-cli.js');
  const node = manager === 'homebrew-node' ? path.join(prefix, 'Cellar/node/24.21.0/bin/node') : path.join(prefix, 'bin/node');
  for (const directory of [path.dirname(npm), path.join(oldPackage, 'dist'), path.join(prefix, 'bin'),
    path.join(brewPrefix, 'bin'), path.dirname(node)]) await mkdir(directory, { recursive: true, mode: 0o755 });
  await writeFile(node, `#!/bin/sh\n${childEnvironmentGuard}exec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
  if (manager === 'homebrew-node') await symlink(node, path.join(prefix, 'bin/node'));
  await writeFile(path.join(path.dirname(path.dirname(npm)), 'package.json'), json({ name: 'npm', version: '12.0.2' }));
  await writeFile(npm, `#!/usr/bin/env node
import {rmSync} from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2);const prefix=args[args.indexOf('--prefix')+1];
if(args.includes('--version')) console.log('12.0.2');
else if(args[0]==='root' && prefix===${JSON.stringify(prefix)}) console.log(path.join(prefix,'lib/node_modules'));
else if(args[0]==='uninstall' && prefix===${JSON.stringify(prefix)} &&
args.includes('@msn-control/liftoff') && args.includes('--ignore-scripts')) {
  rmSync(path.join(prefix,'lib/node_modules/@msn-control/liftoff'),{recursive:true});
  console.log('removed exact isolated fixture package');
} else process.exitCode=1;
`, { mode: 0o755 });
  await writeFile(path.join(path.dirname(path.dirname(npm)), 'package.json'), json({ name: 'npm', version: '12.0.2', type: 'module' }));
  await writeFile(path.join(oldPackage, 'package.json'), json({
    name: '@msn-control/liftoff', version: '0.12.3', type: 'module', bin: { liftoff: 'dist/cli.js' }
  }));
  await writeFile(path.join(oldPackage, 'dist/cli.js'), 'import "./dependency.js"; console.log("Liftoff 0.12.3");\n');
  await writeFile(path.join(oldPackage, 'dist/dependency.js'), 'export const fixture = true;\n');
  const oldLauncher = path.join(prefix, 'bin/liftoff');
  await symlink('../lib/node_modules/@msn-control/liftoff/dist/cli.js', oldLauncher);
  const brew = path.join(brewPrefix, 'bin/brew');
  await writeFile(brew, `#!/bin/sh\n${childEnvironmentGuard}printf '%s\\n' ${JSON.stringify(brewPrefix)}\n`, { mode: 0o755 });
  let managerExecutable: string | undefined;
  if (manager === 'volta') {
    managerExecutable = path.join(voltaRoot, 'bin/volta');
    await mkdir(path.dirname(managerExecutable), { recursive: true });
    await writeFile(managerExecutable, `#!/bin/sh
case "$2" in
 node) printf '%s\\n' ${JSON.stringify(node)} ;;
 npm) printf '%s\\n' ${JSON.stringify(npm)} ;;
 liftoff) printf '%s\\n' ${JSON.stringify(path.join(oldPackage, 'dist/cli.js'))} ;;
 *) exit 1 ;;
esac
`, { mode: 0o755 });
  }
  const recovery = path.join(root, 'offline old package');
  await copyMigrationTree(oldPackage, recovery, await captureMigrationTree(oldPackage));
  const source = path.join(root, 'cask fixture bundle');
  if (nativeBundle) {
    await cp(nativeBundle, source, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  } else {
    for (const directory of ['bin', 'runtime', 'application/dist', 'installation']) {
      await mkdir(path.join(source, directory), { recursive: true });
    }
    await writeFile(path.join(source, 'runtime/node'), `#!/bin/sh\n${childEnvironmentGuard}exec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
    await writeFile(path.join(source, 'bin/liftoff'),
      `#!/bin/sh\nexec ${JSON.stringify(path.join(source, 'runtime/node'))} ${JSON.stringify(path.join(source, 'application/dist/cli.js'))} "$@"\n`,
      { mode: 0o755 });
    await writeFile(path.join(source, 'application/dist/cli.js'), 'console.log("Liftoff 0.13.0");\n');
    await copyFile(path.join('scripts', 'native-install.mjs'), path.join(source, 'installation/native-install.mjs'));
    for (const file of ['native-bundle-contract.mjs', 'native-release-admission.mjs', 'release-policy.json']) {
      await copyFile(path.join('distribution/native', file), path.join(source, 'installation', file));
    }
  }
  const inventory = await bundleInventory(source);
  const manifest = { schemaVersion: 1, kind: 'liftoff-native-development-bundle', releaseReady: true,
    package: { name: '@msn-control/liftoff', version: '0.13.0' },
    source: { repository: 'voyager163/liftoff', commit: 'd'.repeat(40) },
    platform: { platform: 'darwin', architecture: 'arm64' }, launcher: 'bin/liftoff',
    runtime: { executable: 'runtime/node' }, inventory };
  const manifestBytes = nativeBundle ? await readFile(path.join(source, 'bundle.json')) : json(manifest);
  if (!nativeBundle) await writeFile(path.join(source, 'bundle.json'), manifestBytes);
  const packaged = JSON.parse(manifestBytes.toString()) as typeof manifest;
  const targetVersion = packaged.package.version;
  const targetCommit = packaged.source.commit;
  const key = generateKeyPairSync('ed25519');
  const policy: NativeReleasePolicy = { schemaVersion: 1, repository: 'voyager163/liftoff',
    approvedSigningKeySha256: hash(key.publicKey.export({ format: 'der', type: 'spki' })),
    homebrew: { cask: 'fixture/tools/liftoff', sourceRepository: 'fixture/tools', developerTeamId: 'ABCDEFGHIJ' },
    winget: { packageIdentifier: null, publisher: null, certificateSha256: null, installerAppId: null },
    linux: { archiveSigningKeySha256: null } };
  const archive = `liftoff-${targetVersion}-darwin-arm64.tar.gz`;
  const assets = new Map([
    [archive, Buffer.from('fixture-only deployed archive')],
    ['NOTICE', Buffer.from('fixture-only licensed material')],
    ['sbom.cdx.json', json({ bomFormat: 'CycloneDX', specVersion: '1.6',
      components: [{ name: '@msn-control/liftoff', version: targetVersion }, { name: 'node' }, { name: 'fixture' }],
      properties: [{ name: 'liftoff:sourceCommit', value: targetCommit },
        { name: 'liftoff:inventorySha256', value: inventory.sha256 }] })]
  ]);
  assets.set('provenance.json', json({ _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: archive, digest: { sha256: hash(assets.get(archive)!) } }],
    predicate: { buildDefinition: { externalParameters: { repository: policy.repository, commit: targetCommit,
      packageVersion: targetVersion, target: { platform: 'darwin', architecture: 'arm64' } } } } }));
  const record = { schemaVersion: 1, kind: 'liftoff-native-release-candidate', repository: policy.repository,
    commit: targetCommit, version: targetVersion, target: 'darwin-arm64', manifestSha256: hash(manifestBytes),
    inventorySha256: inventory.sha256, files: [archive, 'sbom.cdx.json', 'provenance.json', 'NOTICE'].map(filename =>
      ({ filename, bytes: assets.get(filename)!.length, sha256: hash(assets.get(filename)!), mode: 0o644 })) };
  const platformEvidence = new Map(['minimumHost', 'installerOwnership', 'signing', 'packageNamespace', 'hclSourceCorrespondence', 'notarization']
    .map(name => [name, json({ fixtureOnly: true, name })]));
  const qualification = { ...record, channel: { id: policy.homebrew.cask, source: policy.homebrew.sourceRepository },
    platformSigningIdentity: policy.homebrew.developerTeamId,
    qualification: Object.fromEntries([...platformEvidence.keys()].map(name => [name, true])),
    evidenceDigests: Object.fromEntries([...platformEvidence].map(([name, bytes]) => [name, hash(bytes)])),
    artifactUrl: `https://github.com/voyager163/liftoff/releases/download/v${targetVersion}/${archive}` };
  const material: NativeStableMaterial = { record: json(record), qualification: json(qualification),
    signature: sign(null, json(qualification), key.privateKey), publicKey: Buffer.from(key.publicKey.export({ type: 'spki', format: 'pem' })),
    stableTag: `v${targetVersion}`, prerelease: !isStableSemver(targetVersion), draft: false, assets, platformEvidence };
  const channel = { status: 'available' as const,
    version: targetVersion, identity: 'fixture-channel-identity', exactApply: isStableSemver(targetVersion),
    artifactSha256: hash(assets.get(archive)!) };
  const base = defaultSelfUpgradeDependencies({ PATH: `${path.join(brewPrefix, 'bin')}:${path.join(prefix, 'bin')}`, HOME: root });
  const scratch = new Set<string>();
  const dependencies: MacMigrationDependencies = { upgrade: { ...base, platform: 'darwin', architecture: 'arm64',
    makeNeutralDirectory: async () => { const directory = await base.makeNeutralDirectory(); scratch.add(directory); return directory; },
    removeNeutralDirectory: async directory => { await base.removeNeutralDirectory(directory); scratch.delete(directory); },
    readJson: file => file.endsWith('/distribution/native/release-policy.json') ? Promise.resolve(policy) : base.readJson(file) },
    host: async () => ({ platform: 'darwin', architecture: 'arm64', nativeArchitecture: 'arm64', appleSilicon: '1',
      translated: '0', osVersion: '15.7', runtimeVersion: '24.21.0' }),
    cask: { policy, admitHost: async () => {}, target: async () => material, channel: async () => channel,
      destination: async () => path.join(brewPrefix, 'bin/liftoff'), absent: async () => true,
      preflight: async () => ({ identity: 'fixture-only-cask-write-scope', permissions: 'verified', collisions: 'clear' }),
      installExact: async () => { await symlink(path.join(source, 'bin/liftoff'), path.join(brewPrefix, 'bin/liftoff'));
        return { settled: true, installed: true }; },
      installed: async () => ({
        inventory: { packageRoot: path.join(source, 'application'), bundleRoot: source, runtime: path.join(source, 'runtime/node'),
          launcher: path.join(source, 'bin/liftoff'), version: targetVersion, target: 'darwin-arm64', sourceCommit: targetCommit,
          manifestSha256: record.manifestSha256, inventorySha256: inventory.sha256, identity: 'fixture-local-inventory' },
        ownership: { fullToken: policy.homebrew.cask!, sourceRepository: policy.homebrew.sourceRepository!,
          installedVersion: targetVersion, bundleRoot: source, launcher: path.join(source, 'bin/liftoff') }
      })
    } };
  const request: MacMigrationRequest = { selection: { npm, node, prefix, manager,
    ...(manager === 'nvm' ? { managerRoot: nvmRoot } : manager === 'volta' ? { managerRoot: voltaRoot, managerExecutable } :
      manager === 'homebrew-node' ? { managerRoot: prefix, managerExecutable: brew } : {}) }, brew, recovery };
  return { root, prefix, brewPrefix, oldPackage, oldLauncher, npm, node, recovery, source, policy, material, channel, childEnvironmentFile,
    dependencies, request, cleanup: async () => {
      for (const directory of scratch) await base.removeNeutralDirectory(directory);
      await rm(root, { recursive: true, force: true });
    } };
}
