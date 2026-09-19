import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32, gzipSync } from 'node:zlib';
import type { NativeReleaseManifest, NativeTarget, NativeTargetPayload, NativeTargetResources } from '../../src/domain/distribution/contracts.js';
import {
  nativeTrustRootDigest, parseNativeTrustRoot,
  type NativeArtifactProvenance, type NativeHost, type NativeTrustRegistration
} from '../../src/domain/distribution/native-trust.js';
import { allNativeTargets, nativeTargetFloors } from '../../src/domain/distribution/contracts.js';
import {
  computeComponentDigest, computeTemplateCatalogDigest, validateTemplateCatalog,
  type ResourceDescriptor, type TemplateComponentDescriptor
} from '../../src/domain/standards/resource-catalog-schema.js';
import { validateStandardsProfileCatalog } from '../../src/domain/standards/profile-schema.js';
import { NativeReleaseClient, type NativeArtifactSource } from '../../src/adapters/distribution/native-release-client.js';
import { NativeAdmission, observeNativeHost } from '../../src/adapters/distribution/native-admission.js';
import { InstallationDetector } from '../../src/adapters/distribution/installation-detector.js';
import { NpmInstallationAdapter } from '../../src/adapters/distribution/npm-installation.js';
import { ReceiptStore } from '../../src/adapters/distribution/receipt-store.js';
import { NodeCommandRunner, type CommandResult, type CommandRunner, type RunCommandOptions } from '../../src/process-runner.js';
import type { ExternalCommand } from '../../src/domain/project/contracts.js';
import { createNativeLauncher, nativeEntrypoints, posixLauncher } from '../../scripts/distribution/assemble-native-bundle.mjs';
import { cleanBuildEnvironment } from '../../scripts/distribution/native-build-files.mjs';
import { ForeignHostRuntimeDouble } from './foreign-host-runtime-double.js';

export const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export class RecordingRunner implements CommandRunner {
  readonly calls: Array<{ command: ExternalCommand; options?: RunCommandOptions }> = [];
  constructor(readonly runner: CommandRunner = new NodeCommandRunner()) {}
  beforeRun?: (command: ExternalCommand, options?: RunCommandOptions) => Promise<void>;
  afterRun?: (command: ExternalCommand, result: CommandResult) => Promise<CommandResult>;
  private activeCalls = 0;
  private unsettled = false;
  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push({ command, options });
    this.activeCalls += 1;
    try {
      await this.beforeRun?.(command, options);
      const result = await this.runner.run(command, options);
      if (result.processTreeSettled === false) this.unsettled = true;
      return this.afterRun ? await this.afterRun(command, result) : result;
    } finally { this.activeCalls -= 1; }
  }
  assertSettled(): void {
    if (this.activeCalls || this.unsettled) throw new Error('Preserve this exact native fixture: an actual subprocess has not settled.');
  }
}

export class FileArtifactSource implements NativeArtifactSource {
  readonly urls = new Map<string, string>();
  readonly reads: string[] = [];
  async readBytes(url: string, maximumBytes: number): Promise<Buffer> {
    this.reads.push(url);
    const file = this.urls.get(url);
    if (!file) throw new Error('Fixture artifact is not registered.');
    const bytes = await readFile(file);
    if (bytes.length > maximumBytes) throw new Error('Fixture artifact exceeds the requested bound.');
    return bytes;
  }
}

export async function writeFixtureFile(file: string, content: string | Buffer, mode = 0o644): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, content, { mode });
  await chmod(file, mode);
}

export interface SignedFixture {
  root: string;
  home: string;
  project: string;
  candidate: string;
  prefix: string;
  packageRoot: string;
  legacyLauncher: string;
  launcher: string;
  installRoot: string;
  env: NodeJS.ProcessEnv;
  source: FileArtifactSource;
  trust: NativeTrustRegistration;
  manifest: NativeReleaseManifest;
  provenance: NativeArtifactProvenance;
  runner: RecordingRunner;
  runtimeExecution: 'current-host' | 'foreign-host-test-double';
  client: NativeReleaseClient;
  admission: NativeAdmission;
  detector: InstallationDetector;
  store: ReceiptStore;
  npmAdapter: NpmInstallationAdapter;
  reviewNow(): Date;
  registerRelease(version: string): Promise<{ candidate: string; manifest: NativeReleaseManifest; provenance: NativeArtifactProvenance }>;
  resignProvenance(provenance: NativeArtifactProvenance): Promise<void>;
  publishIndex(stableVersion: string, sequence: number, now: Date): Promise<void>;
  cleanup(): Promise<void>;
}

export interface SignedFixtureOptions {
  // Foreign targets use an explicit execution-port double, never native qualification.
  host?: NativeHost;
  catalogSource?: 'repository';
  beforeSigning?: (bundleRoot: string, resources: Readonly<NativeTargetResources>) => Promise<void>;
}

export async function signedFixture(name: string, options: SignedFixtureOptions = {}): Promise<SignedFixture> {
  const root = await realpath(await mkdtemp(path.join(await realpath('tests'), `.native-admission-${name}-`)));
  const rootIdentity = await lstat(root);
  const home = path.join(root, 'isolated home');
  const project = path.join(root, 'existing project');
  const prefix = path.join(home, 'legacy npm prefix');
  const packageRoot = path.join(prefix, 'lib', 'node_modules', '@msn-control', 'liftoff');
  const legacyLauncher = path.join(prefix, 'bin', 'liftoff');
  const launcher = path.join(home, 'bin', process.platform === 'win32' ? 'liftoff.exe' : 'liftoff');
  const installRoot = path.join(home, 'native liftoff');
  const tool = path.join(home, 'tools', 'npm');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(launcher), { recursive: true });
  await writeFixtureFile(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFixtureFile(path.join(project, 'liftoff.manifest.json'), '{"schemaVersion":7,"version":"historical"}\n');
  await writeFixtureFile(path.join(project, 'package-lock.json'), '{"lockfileVersion":3,"untouched":true}\n');
  await writeFixtureFile(path.join(project, 'node_modules', 'application-dependency', 'index.js'), 'export const business = 42;\n');
  await writeFixtureFile(path.join(project, '.liftoff', 'activation-history.json'), '{"preserve":"history"}\n');
  await writeFixtureFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@msn-control/liftoff', version: '0.12.3', bin: { liftoff: 'dist/cli.js' }
  }));
  await writeFixtureFile(path.join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\nprocess.stdout.write("Liftoff 0.12.3\\n");\n', 0o755);
  await writeFixtureFile(path.join(prefix, 'lib', 'node_modules', '.package-lock.json'), JSON.stringify({
    lockfileVersion: 3, packages: {
      '@msn-control/liftoff': {
        version: '0.12.3', resolved: 'https://registry.npmjs.org/@msn-control/liftoff/-/liftoff-0.12.3.tgz',
        integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`
      }
    }
  }));
  await mkdir(path.dirname(legacyLauncher), { recursive: true });
  await symlink(path.join(packageRoot, 'dist', 'cli.js'), legacyLauncher);
  const listing = path.join(home, 'npm-installed-record.json');
  await writeFixtureFile(listing, JSON.stringify({
    dependencies: { '@msn-control/liftoff': { version: '0.12.3', path: packageRoot } }
  }));
  await writeFixtureFile(tool, `#!/bin/sh
case "$1" in
  config) case "$3" in
    @msn-control:registry) printf 'undefined\\n';;
    registry) printf 'https://registry.npmjs.org/\\n';;
    *) exit 64;;
  esac;;
  root) printf '%s\\n' ${quote(path.join(prefix, 'lib', 'node_modules'))};;
  ls) /bin/cat ${quote(listing)};;
  uninstall) /bin/rm ${quote(legacyLauncher)} && /bin/rm -r ${quote(packageRoot)};;
  *) exit 64;;
esac
`, 0o755);
  const env: NodeJS.ProcessEnv = {
    HOME: home, USERPROFILE: home, PATH: `${path.dirname(launcher)}${path.delimiter}${path.dirname(legacyLauncher)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    LIFTOFF_TELEMETRY: '0', DO_NOT_TRACK: '1'
  };
  const source = new FileArtifactSource();
  const keys = generateKeyPairSync('ed25519');
  const host = options.host ?? observeNativeHost();
  const target: NativeTarget = `${host.os}-${host.arch}`;
  const entrypoints = nativeEntrypoints(target);
  const foreignRuntime = host.os !== process.platform || host.arch !== process.arch
    ? new ForeignHostRuntimeDouble(root, target) : undefined;
  const trust: NativeTrustRegistration = {
    schemaVersion: 1, repository: 'voyager163/liftoff', stableVersion: '0.13.0',
    signers: [{ id: 'isolated-fixture-only', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
    publications: [],
    channels: [{ owner: 'direct', packageId: 'liftoff', sourceId: 'isolated-fixture-only', sourceUrl: 'https://github.com/voyager163/liftoff/releases' }]
  };
  const publications: NativeTrustRegistration['publications'][number][] = [];
  trust.publications = publications;
  const registerRelease = async (version: string) => {
    const candidate = path.join(home, `unlinked ${version}`);
    await mkdir(path.join(candidate, 'runtime'), { recursive: true });
    const runtimePath = path.join(candidate, entrypoints.runtime);
    if (foreignRuntime) await writeFile(runtimePath, foreignRuntime.runtimeBytes);
    else await copyFile(await realpath(process.execPath), runtimePath);
    await chmod(runtimePath, 0o755);
    if (!foreignRuntime && process.platform === 'darwin') {
      const runtimeLibraries = path.resolve(process.execPath, '..', '..', 'lib');
      for (const name of (await readdir(runtimeLibraries)).filter((entry) => /^libnode\.\d+\.dylib$/u.test(entry))) {
        const destination = path.join(candidate, 'runtime', name);
        await copyFile(path.join(runtimeLibraries, name), destination);
        await chmod(destination, 0o755);
      }
    }
    await writeFixtureFile(path.join(candidate, 'dist', 'cli.js'), `process.stdout.write("Liftoff ${version}\\\\n".replace("\\\\n", "\\n"));\n`);
    if (host.os === 'win32') {
      if (foreignRuntime) throw new Error('Windows execution fixtures require the actual Windows host and native runtime; use parser-only fixtures for foreign PE metadata.');
      const work = path.join(root, 'launcher-build', version);
      await mkdir(work, { recursive: true, mode: 0o700 });
      await createNativeLauncher(candidate, process.cwd(), target, work, cleanBuildEnvironment(work), process.cwd());
    } else {
      await writeFixtureFile(path.join(candidate, entrypoints.launcher), posixLauncher(), 0o755);
    }
    await writeFixtureFile(path.join(candidate, 'LICENSE'), 'Isolated signed fixture, not production qualification.\n');
    await writeFixtureFile(path.join(candidate, 'package.json'), JSON.stringify({ name: '@msn-control/liftoff', version, type: 'module' }));
    const license = await readFile(path.join(candidate, 'LICENSE'));
    const resource: ResourceDescriptor = {
      id: 'fixture-license', componentId: 'fixture-core', category: 'template',
      path: 'LICENSE', digest: `sha256:${sha(license)}`, size: license.length
    };
    const componentBase: Omit<TemplateComponentDescriptor, 'digest'> = {
      id: 'fixture-core', label: 'Native fixture only', category: 'common', revision: '1',
      dependencies: [], resources: ['fixture-license'], artifactLifecycles: {}
    };
    const resourceMap = { 'fixture-license': resource };
    const templateBase = {
      schemaVersion: 1 as const, catalogId: 'native-fixture', revision: '1',
      components: { 'fixture-core': { ...componentBase, digest: computeComponentDigest(componentBase, resourceMap) } },
      resources: resourceMap
    };
    const fixtureCatalog = { ...templateBase, digest: computeTemplateCatalogDigest(templateBase) };
    const templateBytes = options.catalogSource === 'repository'
      ? await readFile(path.resolve('assets', 'templates', 'catalog.json'))
      : Buffer.from(JSON.stringify(fixtureCatalog));
    const templateCatalog = validateTemplateCatalog(JSON.parse(templateBytes.toString('utf8')), true);
    if (options.catalogSource === 'repository') {
      for (const descriptor of Object.values(templateCatalog.resources)) {
        const bytes = await readFile(path.resolve(descriptor.path));
        if (bytes.length !== descriptor.size || `sha256:${sha(bytes)}` !== descriptor.digest) {
          throw new Error(`Repository resource changed or differs from its catalog: ${descriptor.path}`);
        }
        await writeFixtureFile(path.join(candidate, descriptor.path), bytes);
      }
    }
    const resourceEntries = Object.entries(templateCatalog.resources).sort(([left], [right]) => left.localeCompare(right));
    const resources = {
      inventoryHash: sha(resourceEntries.map(([id, entry]) => `${id}:${entry.path}:${entry.digest}:${entry.size};`).join('')),
      count: resourceEntries.length
    };
    await writeFixtureFile(path.join(candidate, 'assets', 'templates', 'catalog.json'), templateBytes);
    const profileBytes = await readFile(path.resolve('assets', 'profiles', 'catalog.json'));
    const profiles = validateStandardsProfileCatalog(JSON.parse(profileBytes.toString('utf8')), true);
    await writeFixtureFile(path.join(candidate, 'assets', 'profiles', 'catalog.json'), profileBytes);
    const runtime = {
      nodeVersion: process.versions.node,
      ...(host.os === 'darwin' ? nativeTargetFloors.darwin : {}),
      ...(host.os === 'linux' ? { minimumGlibc: '2.31', minimumKernelVersion: '4.18.0' } : {}),
      ...(host.os === 'win32' ? { minimumHostVersion: '10.0.17763', minimumBuild: 17763 } : {})
    };
    const builtAt = '2026-09-14T00:00:00.000Z';
    const sourceCommit = '7'.repeat(40);
    await writeFixtureFile(path.join(candidate, 'liftoff-build-manifest.json'), JSON.stringify({
      schemaVersion: 1, product: 'liftoff', version, target, sourceCommit, builtAt, runtime, resources
    }));
    await writeFixtureFile(path.join(candidate, 'build-info.json'), JSON.stringify({
      schemaVersion: 1, kind: 'native-release', product: 'liftoff', version, commit: sourceCommit,
      target: { os: host.os, arch: host.arch, platform: target },
      runtime: { name: 'node', version: process.versions.node }, resourcesDigest: templateCatalog.digest,
      profilesDigest: profiles.digest, buildDate: builtAt
    }));
    await writeFixtureFile(path.join(candidate, 'assets', 'distribution', 'native-trust.json'), JSON.stringify({
      schemaVersion: 1, product: 'liftoff', repository: 'voyager163/liftoff', state: 'configured',
      signers: trust.signers,
      publicationIndex: {
        url: 'https://github.com/voyager163/liftoff/releases/download/isolated-fixture-index/stable.json',
        signatureUrl: 'https://github.com/voyager163/liftoff/releases/download/isolated-fixture-index/stable.sig',
        signerId: 'isolated-fixture-only', minimumSequence: 1
      },
      channels: [...trust.channels, {
        owner: 'homebrew-cask', packageId: 'voyager163/liftoff/liftoff', sourceId: 'voyager163/liftoff',
        sourceUrl: 'https://github.com/voyager163/homebrew-liftoff'
      }]
    }));
    await options.beforeSigning?.(candidate, resources);
    const files = await readTree(candidate);
    const archiveRoot = `liftoff-v${version}-${target}`;
    const archiveFiles = files.map((file) => ({ ...file, path: `${archiveRoot}/${file.path}` }));
    const archive = host.os === 'win32' ? zipArchive(archiveFiles) : tarArchive(archiveFiles);
    const provenance: NativeArtifactProvenance = {
      schemaVersion: 1, product: 'liftoff', repository: 'voyager163/liftoff', version, sourceCommit, target,
      checksumSha256: sha(archive), buildManifestSha256: sha(await readFile(path.join(candidate, 'liftoff-build-manifest.json'))),
      buildInfoSha256: sha(await readFile(path.join(candidate, 'build-info.json'))),
      entrypoints, runtime, resources,
      files: files.map((file) => ({ path: file.path, sha256: sha(file.bytes), size: file.bytes.length, mode: file.mode }))
    };
    const baseUrl = `https://github.com/voyager163/liftoff/releases/download/v${version}/`;
    const payload = (platform: NativeTarget): NativeTargetPayload => {
      const [os, arch] = platform.split('-');
      if ((os !== 'darwin' && os !== 'linux' && os !== 'win32') || (arch !== 'x64' && arch !== 'arm64')) throw new Error('Fixture target invalid.');
      return {
        os, arch, archiveFormat: os === 'win32' ? 'zip' : 'tar.gz', archiveUrl: `${baseUrl}${platform}.${os === 'win32' ? 'zip' : 'tar.gz'}`,
        checksumSha256: sha(archive), signatureUrl: `${baseUrl}${platform}.sig`, provenanceUrl: `${baseUrl}${platform}.provenance.json`,
        runtime: {
          nodeVersion: process.versions.node,
          ...(os === 'darwin' ? nativeTargetFloors.darwin : {}),
          ...(os === 'linux' ? { minimumGlibc: '2.31', minimumKernelVersion: '4.18.0' } : {}),
          ...(os === 'win32' ? { minimumHostVersion: '10.0.17763', minimumBuild: 17763 } : {})
        }, resources
      };
    };
    const manifest: NativeReleaseManifest = {
      schemaVersion: 1, product: 'liftoff', version, sourceCommit, publishedAt: builtAt,
      targets: {
        'darwin-x64': payload('darwin-x64'), 'darwin-arm64': payload('darwin-arm64'),
        'linux-x64': payload('linux-x64'), 'linux-arm64': payload('linux-arm64'),
        'win32-x64': payload('win32-x64'), 'win32-arm64': payload('win32-arm64')
      }
    };
    const publication = {
      version, sourceCommit, manifestUrl: `${baseUrl}manifest.json`, signatureUrl: `${baseUrl}manifest.sig`,
      signerId: 'isolated-fixture-only', publicationAuthorized: true
    };
    publications.push(publication);
    const emit = async (url: string, bytes: Buffer) => {
      const file = path.join(root, 'registered artifacts', version, path.basename(new URL(url).pathname));
      await writeFixtureFile(file, bytes);
      source.urls.set(url, file);
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    await emit(publication.manifestUrl, manifestBytes);
    await emit(publication.signatureUrl, sign(null, manifestBytes, keys.privateKey));
    const provenanceBytes = Buffer.from(JSON.stringify(provenance));
    const archiveFile = path.join(root, 'registered artifacts', version, host.os === 'win32' ? 'payload.zip' : 'payload.tar.gz');
    await writeFixtureFile(archiveFile, archive);
    for (const platform of allNativeTargets) {
      const item = manifest.targets[platform];
      source.urls.set(item.archiveUrl, archiveFile);
      await emit(item.provenanceUrl!, provenanceBytes);
      await emit(item.signatureUrl!, sign(null, provenanceBytes, keys.privateKey));
    }
    return { candidate, manifest, provenance };
  };
  const initial = await registerRelease('0.13.0');
  const resignProvenance = async (provenance: NativeArtifactProvenance): Promise<void> => {
    const bytes = Buffer.from(JSON.stringify(provenance));
    const base = `https://github.com/voyager163/liftoff/releases/download/v${provenance.version}/`;
    for (const platform of allNativeTargets) {
      const payload = source.urls.get(`${base}${platform}.provenance.json`);
      const signature = source.urls.get(`${base}${platform}.sig`);
      if (!payload || !signature) throw new Error('Fixture provenance is not registered.');
      await writeFile(payload, bytes);
      await writeFile(signature, sign(null, bytes, keys.privateKey));
    }
  };
  const publishIndex = async (stableVersion: string, sequence: number, now: Date): Promise<void> => {
    const publicRoot = parseNativeTrustRoot(JSON.parse(await readFile(
      path.join(initial.candidate, 'assets', 'distribution', 'native-trust.json'), 'utf8'
    )));
    if (publicRoot.state !== 'configured') throw new Error('The fixture publication index requires a configured test-only root.');
    const entries = await Promise.all(publications.map(async (publication) => {
      const manifestFile = source.urls.get(publication.manifestUrl);
      if (!manifestFile || !publication.publicationAuthorized) throw new Error('The fixture publication is not registered.');
      const { publicationAuthorized: _authority, ...fields } = publication;
      return { ...fields, manifestSha256: sha(await readFile(manifestFile)) };
    }));
    const bytes = Buffer.from(JSON.stringify({
      schemaVersion: 1, product: 'liftoff', repository: 'voyager163/liftoff',
      rootDigest: nativeTrustRootDigest(publicRoot), sequence,
      issuedAt: new Date(now.getTime() - 1000).toISOString(),
      expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
      stableVersion, publications: entries
    }));
    const indexFile = path.join(root, 'registered artifacts', 'stable-index.json');
    const signatureFile = path.join(root, 'registered artifacts', 'stable-index.sig');
    await writeFixtureFile(indexFile, bytes);
    await writeFixtureFile(signatureFile, sign(null, bytes, keys.privateKey));
    source.urls.set(publicRoot.publicationIndex.url, indexFile);
    source.urls.set(publicRoot.publicationIndex.signatureUrl, signatureFile);
  };
  const runner = new RecordingRunner(foreignRuntime);
  const client = new NativeReleaseClient({ trust, source });
  const admission = new NativeAdmission({ releaseClient: client, runner, env, cwd: project, host });
  const store = new ReceiptStore({ env, homedir: home });
  const npmAdapter = new NpmInstallationAdapter({ runner, env, cwd: project, npmExecutable: tool });
  const detector = new InstallationDetector({
    entrypoint: path.join(initial.candidate, 'dist', 'cli.js'), admission, env, cwd: project,
    receiptStore: store, npmAdapter, ownerAdapters: []
  });
  return {
    root, home, project, candidate: initial.candidate, prefix, packageRoot, legacyLauncher, launcher, installRoot,
    env, source, trust, manifest: initial.manifest, provenance: initial.provenance, runner,
    runtimeExecution: foreignRuntime ? 'foreign-host-test-double' : 'current-host',
    client, admission, detector, store,
    npmAdapter, reviewNow: () => new Date('2026-09-14T00:10:00.000Z'),
    registerRelease, resignProvenance, publishIndex, cleanup: async () => {
      runner.assertSettled();
      const current = await lstat(root);
      if (await realpath(root) !== root || current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) {
        throw new Error('Preserve the native fixture: its exact created root identity changed.');
      }
      await rm(root, { recursive: true });
    }
  };
}

export async function readTree(root: string): Promise<Array<{ path: string; bytes: Buffer; mode: number }>> {
  const files: Array<{ path: string; bytes: Buffer; mode: number }> = [];
  const visit = async (parts: string[]) => {
    for (const name of (await readdir(path.join(root, ...parts))).sort()) {
      const child = [...parts, name];
      const file = path.join(root, ...child);
      const stat = await lstat(file);
      if (stat.isDirectory()) await visit(child);
      else if (stat.isFile()) files.push({ path: child.join('/'), bytes: await readFile(file), mode: stat.mode & 0o7777 });
    }
  };
  await visit([]);
  return files;
}

export function tarArchive(files: readonly { path: string; bytes: Buffer; mode: number }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    const split = Buffer.byteLength(file.path) > 100 ? file.path.lastIndexOf('/') : -1;
    const name = file.path.slice(split + 1);
    const prefix = split < 0 ? '' : file.path.slice(0, split);
    if (!name || Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) {
      throw new Error('Fixture resource path exceeds bounded USTAR name/prefix fields.');
    }
    header.write(name, 0, 100, 'utf8');
    header.write(prefix, 345, 155, 'utf8');
    header.write(`${file.mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${file.bytes.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    chunks.push(header, file.bytes, Buffer.alloc((512 - file.bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 1 });
}

export function zipArchive(files: readonly { path: string; bytes: Buffer; mode: number }[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const checksum = crc32(file.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(file.bytes.length, 18);
    header.writeUInt32LE(file.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x0314, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(33, 14);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(file.bytes.length, 20);
    entry.writeUInt32LE(file.bytes.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(((0o100000 | file.mode) << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    local.push(header, name, file.bytes);
    central.push(entry, name);
    offset += header.length + name.length + file.bytes.length;
  }
  const directory = Buffer.concat(central);
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(files.length, 8);
  footer.writeUInt16LE(files.length, 10);
  footer.writeUInt32LE(directory.length, 12);
  footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, footer]);
}
