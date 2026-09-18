import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { canonicalRepository, type NativeTarget } from '../../domain/distribution/contracts.js';
import { DistributionError, NativeCommandFailure } from '../../domain/distribution/errors.js';
import {
  parseNativeResources, parseNativeTarget, parseRuntimeConstraints, verifyTargetFloor
} from '../../domain/distribution/release-manifest.js';
import {
  parsePayloadFile, type NativeArtifactProvenance, type NativeHost, type VerifiedNativeRelease
} from '../../domain/distribution/native-trust.js';
import { digest, freeze, object, sourceCommit, stableVersion, text } from '../../domain/distribution/validation.js';
import { validateNativeBuildInfo } from '../packaged-assets/build-info.js';
import { type CommandRunner, type CommandResult } from '../../process-runner.js';
import { NativeCommandRunner, assertNativeCommandInvocation } from './native-command-runner.js';
import type { ProjectMutationLease } from '../filesystem/project-lock.js';
import { NativeReleaseClient } from './native-release-client.js';
import { verifyNativeMetadata } from './native-metadata.js';
import { observeLauncher } from './launcher-observation.js';
import {
  canonicalNativeRoot, hashNativeFile, inventoryNativeTree, ioCode, nativePathParts, nativePayloadMode,
  parseNativeJsonBytes, readNativeJson,
  type NativeDirectorySnapshot, type NativeFileSnapshot
} from './native-files.js';

export interface AdmittedNativeArtifact {
  version: string;
  sourceCommit: string;
  target: NativeTarget;
  release: VerifiedNativeRelease;
  provenance: NativeArtifactProvenance;
  provenanceDigest: string;
  archiveDigest: string;
  archiveRoot: string;
}

export interface AdmittedNativeCandidate extends AdmittedNativeArtifact {
  bundleRoot: string;
  files: readonly NativeFileSnapshot[];
  directories: readonly NativeDirectorySnapshot[];
  identityDigest: string;
}

export interface NativeAdmissionOptions {
  releaseClient?: NativeReleaseClient;
  host?: NativeHost;
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function nativeProbeEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const keyOf = (key: string): string => platform === 'win32' ? key.toUpperCase() : key;
  const result: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map((key) => [keyOf(key), undefined]));
  const selected = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    const canonical = keyOf(key);
    if (selected.has(canonical)) throw new DistributionError('Native process environment contains ambiguous case aliases.', 'unsafe_path');
    selected.add(canonical);
    result[canonical] = value;
  }
  for (const key of new Set([...Object.keys(result), 'NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV'])) {
    if (/^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_ICU_DATA|BASH_ENV|ENV|LD_.*|DYLD_.*|OPENSSL_CONF|OPENSSL_ENGINES)$/iu.test(key)) result[key] = undefined;
  }
  result.LIFTOFF_TELEMETRY = '0';
  result.DO_NOT_TRACK = '1';
  return result;
}

export function assertNativeCommandSucceeded(result: CommandResult, operation: string): void {
  if (result.status !== 0 || result.signal !== null || result.timedOut !== false || result.aborted ||
      typeof result.stdout !== 'string' || typeof result.stderr !== 'string' ||
      result.errorCode || result.errorMessage || result.outputLimitExceeded || result.processTreeSettled !== true) {
    throw new NativeCommandFailure(operation, result.status, result.signal, result.timedOut, result.errorCode, result.processTreeSettled);
  }
}

export function observeNativeHost(): NativeHost {
  const platform = process.platform;
  const arch = process.arch;
  if ((platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') || (arch !== 'x64' && arch !== 'arm64')) {
    throw new DistributionError('This host operating system or architecture is not a registered native target.', 'unsupported_host');
  }
  const kernelRelease = os.release();
  if (platform === 'linux') {
    const report = process.report.getReport();
    const header = isRecord(report) && isRecord(report.header) ? report.header : undefined;
    return { os: platform, arch, kernelRelease, ...(typeof header?.glibcVersionRuntime === 'string' ? { glibcVersion: header.glibcVersionRuntime } : {}) };
  }
  return {
    os: platform, arch, kernelRelease,
    ...(platform === 'darwin' ? { darwinRelease: kernelRelease, hostVersion: observeMacOsVersion() } : { windowsBuild: Number(kernelRelease.split('.')[2]) })
  };
}

function observeMacOsVersion(): string {
  const source = '/System/Library/CoreServices/SystemVersion.plist';
  const before = lstatSync(source);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 64 * 1024) {
    throw new DistributionError('The native macOS product-version observation is unavailable.', 'unsupported_host');
  }
  const file = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(file);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new DistributionError('The native macOS host observation changed.', 'unsupported_host');
    }
    const bytes = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const size = readSync(file, bytes, count, bytes.length - count, count);
      if (!size) break;
      count += size;
    }
    const after = fstatSync(file);
    const values = [...bytes.subarray(0, count).toString('utf8').matchAll(/<key>ProductVersion<\/key>\s*<string>([0-9]+(?:\.[0-9]+){1,2})<\/string>/gu)];
    if (count !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || values.length !== 1) {
      throw new DistributionError('The native macOS product-version observation is incomplete or changed.', 'unsupported_host');
    }
    return values[0][1];
  } finally { closeSync(file); }
}

function parseProvenance(raw: unknown): NativeArtifactProvenance {
  const value = object(raw, [
    'schemaVersion', 'product', 'repository', 'version', 'sourceCommit', 'target', 'checksumSha256',
    'buildManifestSha256', 'buildInfoSha256', 'entrypoints', 'runtime', 'resources', 'files', 'channelDefinitions'
  ], 'Native artifact provenance');
  if (value.schemaVersion !== 1 || value.product !== 'liftoff' || value.repository !== canonicalRepository ||
      !Array.isArray(value.files) || value.files.length < 6 || value.files.length > 16_384) {
    throw new DistributionError('Native provenance lacks the canonical complete payload inventory.', 'invalid_metadata');
  }
  const entrypoints = object(value.entrypoints, ['launcher', 'runtime', 'cli'], 'Native entrypoints');
  const entry = (key: string): string => {
    if (typeof entrypoints[key] !== 'string') throw new DistributionError('Missing registered native entrypoint.');
    return nativePathParts(entrypoints[key]).join('/');
  };
  const target = parseNativeTarget(value.target);
  const files = value.files.map(parsePayloadFile);
  const names = files.map((file) => nativePathParts(file.path).join('/'));
  if (new Set(names.map((name) => name.normalize('NFC').toLowerCase())).size !== names.length ||
      names.some((name, index) => name !== files[index].path)) {
    throw new DistributionError('Native provenance contains ambiguous payload destinations.', 'unsafe_path');
  }
  let channelDefinitions: NativeArtifactProvenance['channelDefinitions'];
  if (value.channelDefinitions !== undefined) {
    if (!Array.isArray(value.channelDefinitions) || value.channelDefinitions.length > 2) {
      throw new DistributionError('Invalid native owner-definition inventory.');
    }
    channelDefinitions = value.channelDefinitions.map((raw) => {
      const entry = object(raw, ['owner', 'packageId', 'sourceId', 'sha256'], 'Native owner definition');
      const owner = entry.owner;
      if (owner !== 'homebrew-cask' && owner !== 'winget') throw new DistributionError('Unknown native definition owner.');
      return { owner, packageId: text(entry.packageId, 'Definition package'), sourceId: text(entry.sourceId, 'Definition source'),
        sha256: digest(entry.sha256, 'Native owner definition digest') };
    });
    if (new Set(channelDefinitions.map((entry) => entry.owner)).size !== channelDefinitions.length) throw new DistributionError('Duplicate native owner definitions.');
  }
  return {
    schemaVersion: 1, product: 'liftoff', repository: canonicalRepository, version: stableVersion(value.version),
    sourceCommit: sourceCommit(value.sourceCommit), target,
    checksumSha256: digest(value.checksumSha256, 'Final archive digest'),
    buildManifestSha256: digest(value.buildManifestSha256, 'Build manifest digest'),
    buildInfoSha256: digest(value.buildInfoSha256, 'Build info digest'),
    entrypoints: { launcher: entry('launcher'), runtime: entry('runtime'), cli: entry('cli') },
    runtime: parseRuntimeConstraints(value.runtime, target), resources: parseNativeResources(value.resources), files,
    ...(channelDefinitions ? { channelDefinitions } : {})
  };
}

export class NativeAdmission {
  readonly releaseClient: NativeReleaseClient;
  readonly host: Readonly<NativeHost>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  private readonly runner: CommandRunner;
  private readonly admitted = new WeakSet<AdmittedNativeCandidate>();
  private readonly artifacts = new WeakMap<AdmittedNativeArtifact, Buffer>();

  constructor(options: NativeAdmissionOptions = {}) {
    this.releaseClient = options.releaseClient ?? new NativeReleaseClient();
    this.host = freeze(options.host ?? observeNativeHost());
    this.env = Object.freeze({ ...options.env ?? process.env });
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.runner = options.runner ?? new NativeCommandRunner();
  }

  async findBundleRoot(entrypoint: string): Promise<string | undefined> {
    let current = path.resolve(this.cwd, entrypoint);
    const entry = await lstat(current);
    if (!entry.isDirectory()) current = path.dirname(current);
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        const details = await lstat(path.join(current, 'liftoff-build-manifest.json'));
        if (!details.isFile() || details.isSymbolicLink()) throw new DistributionError('Native build manifest is not a regular file.', 'unsafe_path');
        return canonicalNativeRoot(current);
      } catch (error) { if (ioCode(error) !== 'ENOENT') throw error; }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return undefined;
  }

  async admitReleaseTarget(release: VerifiedNativeRelease): Promise<AdmittedNativeArtifact> {
    await this.releaseClient.assertCurrent(release);
    const target = parseNativeTarget(`${this.host.os}-${this.host.arch}`);
    const payload = release.manifest.targets[target];
    verifyTargetFloor(target, this.host, payload.runtime);
    if (!payload.provenanceUrl || !payload.signatureUrl) throw new DistributionError('Native artifact provenance/signature is not registered.', 'trust_unregistered');
    const [provenanceBytes, signature] = await Promise.all([
      this.releaseClient.readArtifact(payload.provenanceUrl, 4 * 1024 * 1024),
      this.releaseClient.readArtifact(payload.signatureUrl, 1024)
    ]);
    await this.releaseClient.verifySignature(provenanceBytes, signature, release.publication);
    let raw: unknown;
    try { raw = JSON.parse(provenanceBytes.toString('utf8')); }
    catch { throw new DistributionError('Native provenance is not valid JSON.', 'invalid_metadata'); }
    const provenance = parseProvenance(raw);
    if (provenance.version !== release.manifest.version ||
        provenance.sourceCommit !== release.manifest.sourceCommit ||
        provenance.target !== target || provenance.checksumSha256 !== payload.checksumSha256 ||
        canonicalJson(provenance.runtime) !== canonicalJson(payload.runtime) ||
        canonicalJson(provenance.resources) !== canonicalJson(payload.resources)) {
      throw new DistributionError('Native source, build, resource, runtime, or final-artifact identity disagrees.', 'artifact_mismatch');
    }
    const archive = await this.releaseClient.readArtifact(payload.archiveUrl, 512 * 1024 * 1024);
    const archiveDigest = createHash('sha256').update(archive).digest('hex');
    if (archiveDigest !== payload.checksumSha256) throw new DistributionError('Final signed native archive checksum differs from its registered manifest.', 'artifact_mismatch');
    const { inspectNativeArchive } = await import('./native-archive.js');
    const archiveLayout = inspectNativeArchive(archive, provenance, payload.archiveFormat);
    const archiveFiles = new Map(archiveLayout.files.map((file) => [file.path, file]));
    await verifyNativeMetadata(provenance, async (relativePath) => {
      const file = archiveFiles.get(relativePath);
      if (!file) throw new DistributionError('Native archive omits required signed metadata.', 'artifact_mismatch');
      return parseNativeJsonBytes(file.bytes, relativePath);
    });
    await this.releaseClient.assertCurrent(release);
    const artifact: AdmittedNativeArtifact = freeze({
      version: provenance.version, sourceCommit: provenance.sourceCommit, target, release, provenance,
      provenanceDigest: createHash('sha256').update(provenanceBytes).digest('hex'), archiveDigest, archiveRoot: archiveLayout.archiveRoot
    });
    this.artifacts.set(artifact, archive);
    return artifact;
  }

  assertArtifact(artifact: AdmittedNativeArtifact): void {
    if (!this.artifacts.has(artifact)) throw new DistributionError('Native artifact was not admitted by this source and host verifier.', 'trust_unregistered');
  }

  async materializeArtifact(artifact: AdmittedNativeArtifact, destination: string, lease: ProjectMutationLease): Promise<AdmittedNativeCandidate> {
    this.assertArtifact(artifact);
    const archive = this.artifacts.get(artifact);
    if (!archive) throw new DistributionError('Admitted native archive bytes are unavailable.', 'artifact_mismatch');
    const { extractNativeArchive } = await import('./native-archive.js');
    await extractNativeArchive(archive, artifact, destination, lease);
    return this.admitBundle(destination, artifact.release);
  }

  async admitBundle(candidatePath: string, selectedRelease?: VerifiedNativeRelease): Promise<AdmittedNativeCandidate> {
    const bundleRoot = await canonicalNativeRoot(path.resolve(this.cwd, candidatePath));
    const buildInfo = validateNativeBuildInfo(await readNativeJson(bundleRoot, 'build-info.json'));
    stableVersion(buildInfo.version);
    const target = parseNativeTarget(buildInfo.target.platform);
    if (target !== `${this.host.os}-${this.host.arch}`) {
      throw new DistributionError('Native candidate target does not match this host operating system and architecture.', 'unsupported_host');
    }
    const release = selectedRelease ?? await this.releaseClient.fetchVerifiedRelease(buildInfo.version);
    const artifact = await this.admitReleaseTarget(release);
    const { provenance, archiveDigest } = artifact;
    if (provenance.version !== buildInfo.version || provenance.sourceCommit !== buildInfo.commit ||
        buildInfo.runtime.version !== provenance.runtime.nodeVersion) {
      throw new DistributionError('Native build identity differs from the authenticated artifact.', 'artifact_mismatch');
    }
    const signed = new Map(provenance.files.map((file) => [file.path, file]));
    const inventory = await inventoryNativeTree(bundleRoot, { expectedFiles: new Set(signed.keys()) });
    if (process.platform !== 'win32') {
      const user = process.getuid?.();
      if (user === undefined || [...inventory.files, ...inventory.directories].some((entry) =>
        (entry.mode & 0o022) !== 0 || entry.uid !== user && entry.uid !== 0)) {
        throw new DistributionError('Native candidate bytes and directories must be controlled by the current user or the system, not writable by another owner.', 'unsafe_path');
      }
    }
    if (inventory.files.length !== signed.size || inventory.files.some((file) => {
      const expected = signed.get(file.path);
      const expectedMode = expected ? nativePayloadMode(expected.mode) : undefined;
      return !expected || file.sha256 !== expected.sha256 || file.size !== expected.size || file.mode !== expectedMode;
    })) {
      throw new DistributionError('Candidate bytes, modes, or complete payload inventory differ from signed final-artifact provenance.', 'artifact_mismatch');
    }
    const currentBuildInfo = await verifyNativeMetadata(provenance,
      (relativePath, expected) => readNativeJson(bundleRoot, relativePath, expected));
    if (canonicalJson(currentBuildInfo) !== canonicalJson(buildInfo)) {
      throw new DistributionError('Native build metadata changed during candidate admission.', 'stale_plan');
    }
    const result: AdmittedNativeCandidate = freeze({
      bundleRoot, version: provenance.version, sourceCommit: provenance.sourceCommit, target, release, provenance,
      provenanceDigest: artifact.provenanceDigest, archiveDigest, archiveRoot: artifact.archiveRoot,
      files: inventory.files, directories: inventory.directories,
      identityDigest: canonicalSha256({ root: bundleRoot, inventory: inventory.digest, release: release.manifestDigest,
        registration: release.registrationDigest, provenance: canonicalSha256(provenance), host: this.host })
    });
    this.admitted.add(result);
    const archive = this.artifacts.get(artifact);
    if (archive) this.artifacts.set(result, archive);
    return result;
  }

  assertAdmitted(candidate: AdmittedNativeCandidate): void {
    if (!this.admitted.has(candidate)) throw new DistributionError('Candidate has not passed trusted native admission.', 'trust_unregistered');
  }

  async recheck(candidate: AdmittedNativeCandidate): Promise<void> {
    this.assertAdmitted(candidate);
    await this.releaseClient.assertCurrent(candidate.release);
    const current = await this.admitBundle(candidate.bundleRoot);
    if (current.identityDigest !== candidate.identityDigest) throw new DistributionError('Native candidate, source, host, or directory identity changed after selection.', 'stale_plan');
  }

  async probeLinkedLauncher(candidate: AdmittedNativeCandidate, launcher: string): Promise<void> {
    await this.recheck(candidate);
    const expected = path.join(candidate.bundleRoot, ...nativePathParts(candidate.provenance.entrypoints.launcher));
    const before = await observeLauncher(launcher);
    if (before.state !== 'link' || before.resolved !== expected) {
      throw new DistributionError('The owner launcher does not resolve to the exact admitted native entrypoint.', 'unsafe_path');
    }
    const command = { executable: launcher, args: ['--version'] };
    const options = {
      cwd: candidate.bundleRoot, env: nativeProbeEnvironment(this.env), timeoutMs: 15_000,
      maxOutputBytes: 4096, ensureProcessTreeSettled: true
    };
    assertNativeCommandInvocation(command, options, this.host.os);
    const result = await this.runner.run(command, options);
    assertNativeCommandSucceeded(result, 'Native owner launcher verification');
    if (result.stdout.trim() !== `Liftoff ${candidate.version}` || result.stderr.trim() ||
        canonicalJson(await observeLauncher(launcher)) !== canonicalJson(before)) {
      throw new DistributionError('The actual owner launcher changed or did not report the exact native target.', 'verification_failed');
    }
    await this.recheck(candidate);
  }

  async probe(candidate: AdmittedNativeCandidate, launcher?: string): Promise<void> {
    await this.recheck(candidate);
    const admittedLauncher = path.join(candidate.bundleRoot, ...nativePathParts(candidate.provenance.entrypoints.launcher));
    if (launcher !== undefined && launcher !== admittedLauncher) {
      throw new DistributionError('A candidate probe cannot execute a launcher outside the admitted payload.', 'unsafe_path');
    }
    assertNativeCommandInvocation({ executable: admittedLauncher, args: ['--version'] }, { cwd: candidate.bundleRoot }, this.host.os);
    const runtime = path.join(candidate.bundleRoot, ...nativePathParts(candidate.provenance.entrypoints.runtime));
    const cli = path.join(candidate.bundleRoot, ...nativePathParts(candidate.provenance.entrypoints.cli));
    const options = {
      cwd: candidate.bundleRoot, env: nativeProbeEnvironment(this.env), timeoutMs: 15_000,
      maxOutputBytes: 4096, ensureProcessTreeSettled: true
    };
    const runtimeResult = await this.runner.run({ executable: runtime, args: ['--version'] }, options);
    assertNativeCommandSucceeded(runtimeResult, 'Private runtime verification');
    if (runtimeResult.stdout.trim() !== `v${candidate.provenance.runtime.nodeVersion}` || runtimeResult.stderr.trim()) {
      throw new DistributionError('Private runtime did not report its exact registered version.', 'verification_failed');
    }
    const version = await this.runner.run(launcher
      ? { executable: launcher, args: ['--version'] }
      : { executable: runtime, args: [cli, '--version'] }, options);
    assertNativeCommandSucceeded(version, 'Native executable verification');
    if (version.stdout.trim() !== `Liftoff ${candidate.version}` || version.stderr.trim()) {
      throw new DistributionError('Native executable did not report the exact canonical Liftoff version.', 'verification_failed');
    }
    if (launcher === undefined) {
      const launched = await this.runner.run({ executable: admittedLauncher, args: ['--version'] }, options);
      assertNativeCommandSucceeded(launched, 'Unlinked native launcher verification');
      if (launched.stdout.trim() !== `Liftoff ${candidate.version}` || launched.stderr.trim()) {
        throw new DistributionError('Unlinked launcher did not report the exact canonical Liftoff version.', 'verification_failed');
      }
    }
    await this.recheck(candidate);
  }
}
