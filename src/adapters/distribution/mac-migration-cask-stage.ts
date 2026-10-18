import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { bundlePath, nativeBundleLimits } from '../../../distribution/native/native-bundle-contract.mjs';
import { MacMigrationFailure } from '../../domain/distribution/mac-migration.js';
import { SelfUpgradeFailure, selfUpgradeInstallTimeoutMs } from '../../domain/distribution/liftoff-upgrade.js';
import type { NativeCandidate, NativeReleasePolicy } from '../../domain/distribution/native-upgrade.js';
import { commandFailed } from '../../domain/distribution/liftoff-npm-installation.js';
import { NodeCommandRunner, type CommandRunner } from '../../process-runner.js';
import { installedPackageRoot } from '../packaged-assets/package-root.js';
import { verifyNativeArchiveInventory } from './native-archive.js';
import { admitNativeStableMaterial, authenticatedNativeCaskDefinition, snapshotNativeStableMaterial,
  type NativeStableMaterial } from './native-metadata.js';
import { assertMigrationMetadata, migrationDirectory, migrationNames } from './mac-npm-owner.js';
import { readUpgradeBytes } from './upgrade-host.js';

export interface PreparedCaskMigrationTarget {
  readonly identity: string;
}

/** Retained local material only; never Homebrew, namespace or installation authority. */
export interface CaskMigrationTargetStage {
  readonly root: string;
  readonly sha256: string;
  readonly identity: string;
}

interface StageFile {
  name: string;
  bytes: number;
  sha256: string;
  physical: string;
  metadata: string;
}

interface StageManifest {
  schemaVersion: 1;
  kind: 'liftoff-mac-cask-target-stage';
  candidateIdentity: string;
  policyIdentity: string;
  directoryIdentity: string;
  evidence: string[];
  files: StageFile[];
}

interface PreparedTarget {
  files: Map<string, Buffer>;
  evidence: string[];
  candidateIdentity: string;
  policyIdentity: string;
}

const preparedTargets = new WeakMap<PreparedCaskMigrationTarget, PreparedTarget>();
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const metadataLimit = 8 * 1024 * 1024;
const archiveLimit = 256 * 1024 * 1024;
const manifestLimit = 64 * 1024;
const invalid = () => new MacMigrationFailure('cask-target-stage-invalid');
const changed = () => new MacMigrationFailure('cask-target-stage-changed');
const physical = (stat: BigIntStats) => JSON.stringify(
  (['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const).map(key => String(stat[key]))
);

async function bounded<T>(signal: AbortSignal,
  operation: (check: () => void, signal: AbortSignal, remaining: () => number) => Promise<T>): Promise<T> {
  if (signal.aborted) throw new MacMigrationFailure('cask-target-stage-aborted');
  const started = performance.now();
  const deadline = new AbortController();
  const combined = AbortSignal.any([signal, deadline.signal]);
  const failure = () => new MacMigrationFailure(
    signal.aborted ? 'cask-target-stage-aborted' : 'cask-target-stage-timeout'
  );
  const remaining = () => selfUpgradeInstallTimeoutMs - (performance.now() - started);
  const check = () => { if (combined.aborted || remaining() <= 0) throw failure(); };
  let interrupt = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    interrupt = () => reject(failure());
    if (combined.aborted) interrupt();
    else combined.addEventListener('abort', interrupt, { once: true });
  });
  const timer = setTimeout(() => deadline.abort(), selfUpgradeInstallTimeoutMs);
  try {
    check();
    return await Promise.race([interrupted, (async () => {
      const value = await operation(check, combined, remaining);
      check();
      return value;
    })()]);
  } catch (error) {
    if (error instanceof MacMigrationFailure || error instanceof SelfUpgradeFailure) throw error;
    check();
    throw new MacMigrationFailure('cask-target-stage-unavailable');
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', interrupt);
    deadline.abort();
  }
}

function fileLimit(name: string): number {
  return name === 'archive.tar.gz' ? archiveLimit : name === 'snapshot.json' ? manifestLimit
    : name === 'qualification.sig' ? 64 : name === 'qualification.pub' ? 4096 : metadataLimit;
}

function privateFile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid?.() ?? -1) ||
    stat.gid !== BigInt(process.getgid?.() ?? -1) || (stat.mode & 0o7777n) !== 0o600n) throw invalid();
}

async function privateDirectory(root: string, remaining: () => number): Promise<string> {
  const identity = await migrationDirectory(root, true);
  if (((await lstat(root)).mode & 0o7777) !== 0o700) throw invalid();
  const metadata = (await assertMigrationMetadata([root], remaining())).get(root);
  if (!metadata) throw invalid();
  if (await migrationDirectory(root, true) !== identity) throw changed();
  return JSON.stringify([identity, metadata]);
}

async function captureFiles(root: string, names: string[], check: () => void, remaining: () => number) {
  const files: StageFile[] = [];
  const content = new Map<string, Buffer>();
  for (const name of names) {
    check();
    const filename = path.join(root, name);
    const before = await lstat(filename, { bigint: true });
    privateFile(before);
    const bytes = await readUpgradeBytes(filename, fileLimit(name));
    check();
    if (physical(await lstat(filename, { bigint: true })) !== physical(before)) throw changed();
    files.push({ name, bytes: bytes.length, sha256: hash(bytes), physical: physical(before), metadata: '' });
    content.set(name, bytes);
  }
  check();
  const metadata = await assertMigrationMetadata(names.map(name => path.join(root, name)), remaining());
  for (const file of files) {
    check();
    if (physical(await lstat(path.join(root, file.name), { bigint: true })) !== file.physical) throw changed();
    const identity = metadata.get(path.join(root, file.name));
    if (!identity) throw invalid();
    file.metadata = identity;
  }
  return { files, content };
}

const directoryPhysical = (stat: BigIntStats) =>
  JSON.stringify((['dev', 'ino', 'uid', 'gid', 'mode'] as const).map(key => String(stat[key])));

async function writeFiles(root: string, expectedIdentity: string, mode: 'create' | 'manifest', files: Map<string, Buffer>,
  runner: CommandRunner, check: () => void, signal: AbortSignal, remaining: () => number) {
  check();
  if (await privateDirectory(root, remaining) !== expectedIdentity) throw changed();
  const directoryIdentity = directoryPhysical(await lstat(root, { bigint: true }));
  if (await privateDirectory(root, remaining) !== expectedIdentity) throw changed();
  const header = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'liftoff-cask-stage-write', mode, root,
    directoryIdentity, files: [...files].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: hash(bytes) })) }));
  if (header.length > manifestLimit) throw invalid();
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  const stdin = Buffer.concat([length, header, ...files.values()]);
  check();
  const result = await runner.run({
    executable: process.execPath,
    args: [path.join(installedPackageRoot, 'distribution/native/cask-stage-worker.mjs')]
  }, {
    cwd: root, inheritEnvironment: false,
    env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, NODE_OPTIONS: '', NODE_PATH: '',
      CI: 'true', DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0' },
    stdin, signal,
    timeoutMs: Math.max(1, Math.floor(remaining())), maxOutputBytes: manifestLimit, ensureProcessTreeSettled: true
  });
  check();
  if (commandFailed(result) || result.timedOut !== false || result.processSpawned !== true ||
    result.processTreeSettled !== true || result.stderr !== '' || Buffer.byteLength(result.stdout) > manifestLimit) {
    throw new MacMigrationFailure('cask-target-stage-write-failed');
  }
  const value: unknown = JSON.parse(result.stdout);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const output = value as Record<string, unknown>;
  if (!isDeepStrictEqual(Object.keys(output).sort(), ['directoryIdentity', 'files', 'kind', 'schemaVersion']) ||
    output.schemaVersion !== 1 || output.kind !== 'liftoff-cask-stage-written' ||
    typeof output.directoryIdentity !== 'string' || output.directoryIdentity.length > 1024 ||
    !Array.isArray(output.files) || output.files.length !== files.size) throw invalid();
  const owned = new Map<string, string>();
  for (const file of output.files) {
    if (!file || typeof file !== 'object' || !isDeepStrictEqual(Object.keys(file).sort(), ['name', 'physical']) ||
      typeof file.name !== 'string' || !files.has(file.name) || owned.has(file.name) ||
      typeof file.physical !== 'string' || file.physical.length > 4096) throw invalid();
    owned.set(file.name, file.physical);
  }
  return { directoryIdentity: output.directoryIdentity, owned };
}

function targetFiles(evidence: string[]) {
  return ['release.json', 'qualification.json', 'qualification.sig', 'qualification.pub', 'archive.tar.gz',
    'sbom.cdx.json', 'provenance.json', 'NOTICE', 'definition.rb', ...evidence.map((_, index) => `evidence-${index}.bin`)];
}

async function authenticate(material: NativeStableMaterial, candidate: NativeCandidate, policy: NativeReleasePolicy,
  check: () => void, signal: AbortSignal): Promise<PreparedTarget> {
  check();
  if (candidate.target !== 'darwin-arm64' || material.assets.size !== 4 || material.platformEvidence.size > 32) throw invalid();
  const archiveName = `liftoff-${candidate.version}-darwin-arm64.tar.gz`;
  const assets = [archiveName, 'sbom.cdx.json', 'provenance.json', 'NOTICE'];
  let total = 0;
  for (const [name, bytes] of [['release.json', material.record], ['qualification.json', material.qualification],
    ['qualification.sig', material.signature], ['qualification.pub', material.publicKey],
    ...[...material.assets], ...[...material.platformEvidence]] as const) {
    const maximum = name === archiveName ? archiveLimit : name === 'qualification.sig' ? 64
      : name === 'qualification.pub' ? 4096 : metadataLimit;
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maximum ||
      (total += bytes.length) > nativeBundleLimits.totalBytes) throw invalid();
  }
  if (assets.some(name => !material.assets.has(name))) throw invalid();
  const snapshot = snapshotNativeStableMaterial({ ...material,
    bundleRoot: undefined, archiveSignature: undefined, archivePublicKey: undefined });
  const target = { ...candidate };
  delete target.bundleRoot;
  const admitted = await admitNativeStableMaterial(snapshot, { target: 'darwin-arm64' }, policy);
  check();
  if (!isDeepStrictEqual(admitted, target)) throw invalid();
  await verifyNativeArchiveInventory({ archive: snapshot.assets.get(archiveName)!, candidate: target,
    contract: { bundlePath, nativeBundleLimits }, signal });
  check();
  const definition = await authenticatedNativeCaskDefinition(snapshot, target, policy);
  check();
  if (total + definition.bytes > nativeBundleLimits.totalBytes) throw invalid();
  const evidence = [...snapshot.platformEvidence.keys()].sort();
  const files = new Map<string, Buffer>([
    ['release.json', snapshot.record], ['qualification.json', snapshot.qualification],
    ['qualification.sig', snapshot.signature], ['qualification.pub', snapshot.publicKey],
    ['archive.tar.gz', snapshot.assets.get(archiveName)!],
    ...assets.slice(1).map(name => [name, snapshot.assets.get(name)!] as const),
    ['definition.rb', Buffer.from(definition.content)],
    ...evidence.map((name, index) => [`evidence-${index}.bin`, snapshot.platformEvidence.get(name)!] as const)
  ]);
  return { files, evidence, candidateIdentity: target.identity, policyIdentity: hash(JSON.stringify(policy)) };
}

/** Pure preparation; archives are validated but never extracted or executed. */
export function prepareCaskMigrationTarget(options: {
  material: NativeStableMaterial; candidate: NativeCandidate; policy: NativeReleasePolicy; signal: AbortSignal;
}): Promise<PreparedCaskMigrationTarget> {
  return bounded(options.signal, async (check, signal) => {
    const candidate = structuredClone(options.candidate), policy = structuredClone(options.policy);
    const prepared = await authenticate(options.material, candidate, policy, check, signal);
    const result = Object.freeze({ identity: hash(JSON.stringify([prepared.candidateIdentity, prepared.policyIdentity,
      [...prepared.files].map(([name, bytes]) => [name, hash(bytes)])])) });
    preparedTargets.set(result, prepared);
    return result;
  });
}

/** Exclusive private writes only. Failed or interrupted material is retained, never broadly cleaned up. */
export function stageCaskMigrationTarget(prepared: PreparedCaskMigrationTarget,
  journal: { root: string; rootIdentity: string }, signal: AbortSignal, runner: CommandRunner = new NodeCommandRunner()):
  Promise<CaskMigrationTargetStage> {
  return bounded(signal, async (check, combined, remaining) => {
    const target = preparedTargets.get(prepared);
    if (!target || process.platform === 'win32') throw invalid();
    const journalRoot = journal.root, rootIdentity = journal.rootIdentity;
    const journalIdentity = await privateDirectory(journalRoot, remaining);
    if (await migrationDirectory(journalRoot, true) !== rootIdentity) throw changed();
    check();
    const root = path.join(journalRoot, 'cask-target');
    const written = await writeFiles(journalRoot, journalIdentity, 'create', target.files, runner, check, combined, remaining);
    check();
    const directoryIdentity = await privateDirectory(root, remaining);
    if (directoryPhysical(await lstat(root, { bigint: true })) !== written.directoryIdentity) throw changed();
    const captured = await captureFiles(root, [...target.files.keys()], check, remaining);
    if (captured.files.some(file => file.physical !== written.owned.get(file.name) ||
      !captured.content.get(file.name)!.equals(target.files.get(file.name)!))) throw changed();
    const manifest: StageManifest = { schemaVersion: 1, kind: 'liftoff-mac-cask-target-stage',
      candidateIdentity: target.candidateIdentity, policyIdentity: target.policyIdentity,
      directoryIdentity, evidence: target.evidence, files: captured.files };
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (bytes.length > manifestLimit) throw invalid();
    const savedManifest = await writeFiles(root, directoryIdentity, 'manifest', new Map([['snapshot.json', bytes]]),
      runner, check, combined, remaining);
    const saved = await captureFiles(root, ['snapshot.json'], check, remaining);
    const finalFiles = await captureFiles(root, [...target.files.keys()], check, remaining);
    if (saved.files[0].physical !== savedManifest.owned.get('snapshot.json') ||
      directoryPhysical(await lstat(root, { bigint: true })) !== savedManifest.directoryIdentity ||
      !saved.content.get('snapshot.json')!.equals(bytes) ||
      !isDeepStrictEqual(finalFiles.files, captured.files) ||
      await privateDirectory(root, remaining) !== directoryIdentity ||
      !isDeepStrictEqual((await migrationNames(root, target.files.size + 1)).sort(),
        [...target.files.keys(), 'snapshot.json'].sort())) throw changed();
    check();
    return Object.freeze({ root, sha256: hash(bytes), identity: hash(JSON.stringify([directoryIdentity, saved.files[0]])) });
  });
}

function manifest(value: unknown): asserts value is StageManifest {
  const closed = (input: unknown, keys: string[]): input is Record<string, unknown> =>
    !!input && typeof input === 'object' && !Array.isArray(input) &&
    isDeepStrictEqual(Object.keys(input).sort(), [...keys].sort());
  if (!closed(value, ['schemaVersion', 'kind', 'candidateIdentity', 'policyIdentity', 'directoryIdentity', 'evidence', 'files']) ||
    value.schemaVersion !== 1 || value.kind !== 'liftoff-mac-cask-target-stage' ||
    !digest(value.candidateIdentity) || !digest(value.policyIdentity) ||
    typeof value.directoryIdentity !== 'string' || value.directoryIdentity.length > 10000 ||
    !Array.isArray(value.evidence) || value.evidence.length > 32 ||
    value.evidence.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(name) || name.includes('..')) ||
    new Set(value.evidence).size !== value.evidence.length || !isDeepStrictEqual([...value.evidence].sort(), value.evidence) ||
    !Array.isArray(value.files) || value.files.length !== 9 + value.evidence.length ||
    value.files.some(file => !closed(file, ['name', 'bytes', 'sha256', 'physical', 'metadata']) ||
      typeof file.name !== 'string' || !/^[A-Za-z0-9.-]{1,128}$/.test(file.name) ||
      !Number.isSafeInteger(file.bytes) || Number(file.bytes) <= 0 || Number(file.bytes) > fileLimit(file.name) ||
      !digest(file.sha256) || !digest(file.metadata) || typeof file.physical !== 'string' || file.physical.length > 4096) ||
    value.files.reduce((sum, file) => sum + Number(file.bytes), 0) > nativeBundleLimits.totalBytes) throw invalid();
}

/** Reauthenticates retained exact material; it does not assert that this release is still latest. */
export function readCaskMigrationTarget(options: {
  stage: CaskMigrationTargetStage; candidate: NativeCandidate; policy: NativeReleasePolicy; signal: AbortSignal;
}): Promise<NativeStableMaterial> {
  return bounded(options.signal, async (check, signal, remaining) => {
    const stage = { ...options.stage }, candidate = structuredClone(options.candidate), policy = structuredClone(options.policy);
    if (!isDeepStrictEqual(Object.keys(stage).sort(), ['identity', 'root', 'sha256']) ||
      typeof stage.root !== 'string' || !digest(stage.sha256) || !digest(stage.identity) ||
      process.platform === 'win32') throw invalid();
    const directoryIdentity = await privateDirectory(stage.root, remaining);
    const saved = await captureFiles(stage.root, ['snapshot.json'], check, remaining);
    if (saved.files[0].sha256 !== stage.sha256 ||
      hash(JSON.stringify([directoryIdentity, saved.files[0]])) !== stage.identity) throw changed();
    const value: unknown = JSON.parse(saved.content.get('snapshot.json')!.toString('utf8'));
    manifest(value);
    const names = targetFiles(value.evidence);
    if (value.directoryIdentity !== directoryIdentity || value.candidateIdentity !== candidate.identity ||
      value.policyIdentity !== hash(JSON.stringify(policy)) ||
      !isDeepStrictEqual(value.files.map(file => file.name), names)) throw changed();
    const captured = await captureFiles(stage.root, names, check, remaining);
    if (!isDeepStrictEqual(captured.files, value.files)) throw changed();
    const bytes = (name: string) => captured.content.get(name)!;
    const archiveName = `liftoff-${candidate.version}-darwin-arm64.tar.gz`;
    const material: NativeStableMaterial = {
      record: bytes('release.json'), qualification: bytes('qualification.json'),
      signature: bytes('qualification.sig'), publicKey: bytes('qualification.pub'),
      assets: new Map([[archiveName, bytes('archive.tar.gz')],
        ...['sbom.cdx.json', 'provenance.json', 'NOTICE'].map(name => [name, bytes(name)] as const)]),
      platformEvidence: new Map(value.evidence.map((name, index) => [name, bytes(`evidence-${index}.bin`)])),
      stableTag: `v${candidate.version}`, draft: false, prerelease: false
    };
    const authenticated = await authenticate(material, candidate, policy, check, signal);
    if ([...authenticated.files].some(([name, content]) => !content.equals(bytes(name)))) throw changed();
    const finalPayload = await captureFiles(stage.root, names, check, remaining);
    const final = await captureFiles(stage.root, ['snapshot.json'], check, remaining);
    if (!isDeepStrictEqual(finalPayload.files, captured.files) || !isDeepStrictEqual(final.files, saved.files) ||
      await privateDirectory(stage.root, remaining) !== directoryIdentity ||
      !isDeepStrictEqual((await migrationNames(stage.root, names.length + 1)).sort(), [...names, 'snapshot.json'].sort())) throw changed();
    check();
    return material;
  });
}
