import type {
  NativeArch, NativeOs, NativeReleaseManifest, NativeTarget, NativeTargetResources,
  NativeTargetRuntimeConstraints
} from './contracts.js';
import { canonicalProductName, canonicalRepository } from './contracts.js';
import { canonicalSha256 } from '../governance/activation/canonical-json.js';
import { DistributionError } from './errors.js';
import { digest, freeze, integer, object, publicHttpsUrl, sourceCommit, stableVersion, text, timestamp } from './validation.js';

export const nativeTrustRootPathParts = ['assets', 'distribution', 'native-trust.json'] as const;
export const nativeTrustRootMaximumBytes = 256 * 1024;
export const nativePublicationIndexMaximumBytes = 1024 * 1024;
export const nativePublicationIndexMaximumLifetimeMs = 24 * 60 * 60_000;

export interface NativeSignerRegistration {
  id: string;
  publicKeyPem: string;
}

export interface NativePublicationRegistration {
  version: string;
  sourceCommit: string;
  manifestUrl: string;
  signatureUrl: string;
  signerId: string;
  publicationAuthorized: boolean;
  manifestSha256?: string;
}

export interface NativeChannelRegistration {
  owner: 'homebrew-cask' | 'winget' | 'direct';
  packageId: string;
  sourceId: string;
  sourceUrl: string;
}

export interface NativeTrustRegistration {
  schemaVersion: 1;
  repository: typeof canonicalRepository;
  stableVersion: string;
  signers: readonly NativeSignerRegistration[];
  publications: readonly NativePublicationRegistration[];
  channels: readonly NativeChannelRegistration[];
}

interface NativeTrustRootIdentity {
  schemaVersion: 1;
  product: typeof canonicalProductName;
  repository: typeof canonicalRepository;
}

export interface UnconfiguredNativeTrustRoot extends NativeTrustRootIdentity {
  state: 'unconfigured';
}

export interface ConfiguredNativeTrustRoot extends NativeTrustRootIdentity {
  state: 'configured';
  signers: readonly NativeSignerRegistration[];
  publicationIndex: {
    url: string;
    signatureUrl: string;
    signerId: string;
    minimumSequence: number;
  };
  channels: readonly NativeChannelRegistration[];
}

export type NativeTrustRoot = UnconfiguredNativeTrustRoot | ConfiguredNativeTrustRoot;

export interface NativePublicationIndexEntry extends Omit<NativePublicationRegistration, 'publicationAuthorized'> {
  manifestSha256: string;
}

export interface NativePublicationIndex {
  schemaVersion: 1;
  product: typeof canonicalProductName;
  repository: typeof canonicalRepository;
  rootDigest: string;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  stableVersion: string;
  publications: readonly NativePublicationIndexEntry[];
}

export interface NativePayloadFile {
  path: string;
  sha256: string;
  size: number;
  mode: number;
}

export interface NativeArtifactProvenance {
  schemaVersion: 1;
  product: 'liftoff';
  repository: typeof canonicalRepository;
  version: string;
  sourceCommit: string;
  target: NativeTarget;
  checksumSha256: string;
  buildManifestSha256: string;
  buildInfoSha256: string;
  entrypoints: { launcher: string; runtime: string; cli: string };
  runtime: NativeTargetRuntimeConstraints;
  resources: NativeTargetResources;
  files: readonly NativePayloadFile[];
  channelDefinitions?: readonly {
    owner: 'homebrew-cask' | 'winget';
    packageId: string;
    sourceId: string;
    sha256: string;
  }[];
}

export interface NativeHost {
  os: NativeOs;
  arch: NativeArch;
  kernelRelease: string;
  hostVersion?: string;
  glibcVersion?: string;
  darwinRelease?: string;
  windowsBuild?: number;
}

export interface VerifiedNativeRelease {
  manifest: Readonly<NativeReleaseManifest>;
  manifestDigest: string;
  registrationDigest: string;
  publication: Readonly<NativePublicationRegistration>;
}

function strictTrustObject(raw: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const value = object(raw, keys, label);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null ||
      Object.getOwnPropertySymbols(value).length ||
      Object.getOwnPropertyNames(value).length !== Object.keys(value).length ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => !Object.hasOwn(entry, 'value'))) {
    throw new DistributionError(`${label} must be plain data without accessors, symbols, or hidden fields.`, 'invalid_metadata');
  }
  return value;
}

function trustArray(raw: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > maximum ||
      Object.getOwnPropertyNames(raw).length !== raw.length + 1 || Object.getOwnPropertySymbols(raw).length ||
      Object.keys(raw).some((key, index) => key !== String(index)) ||
      Object.keys(raw).length !== raw.length ||
      Object.values(Object.getOwnPropertyDescriptors(raw)).some((entry) => !Object.hasOwn(entry, 'value'))) {
    throw new DistributionError(`${label} must be a bounded nonempty dense array.`, 'invalid_metadata');
  }
  return [...raw];
}

export function publicNativeTrustUrl(raw: unknown, label: string): string {
  const value = publicHttpsUrl(raw, label);
  const hostname = new URL(value).hostname.toLowerCase();
  if (hostname.startsWith('[') || /^\d+(?:\.\d+){3}$/u.test(hostname) || !hostname.includes('.') ||
      /(?:^|\.)(?:localhost|local|internal)$/u.test(hostname) || hostname.endsWith('.')) {
    throw new DistributionError(`${label} must identify a public named HTTPS source.`, 'invalid_metadata');
  }
  return value;
}

function parseSigner(raw: unknown): NativeSignerRegistration {
  const signer = object(raw, ['id', 'publicKeyPem'], 'Native signer');
  if (typeof signer.publicKeyPem !== 'string' || signer.publicKeyPem.length > 8192 ||
      !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/u.test(signer.publicKeyPem)) {
    throw new DistributionError('A native signer needs a registered public key, never a private key.', 'trust_unregistered');
  }
  return { id: text(signer.id, 'Signer ID', 128), publicKeyPem: signer.publicKeyPem };
}

function parseChannel(raw: unknown): NativeChannelRegistration {
  const channel = object(raw, ['owner', 'packageId', 'sourceId', 'sourceUrl'], 'Native owner channel');
  const owner = channel.owner;
  if (owner !== 'homebrew-cask' && owner !== 'winget' && owner !== 'direct') {
    throw new DistributionError('Unknown native owner channel.', 'trust_unregistered');
  }
  return {
    owner, packageId: text(channel.packageId, 'Registered package ID', 192),
    sourceId: text(channel.sourceId, 'Registered source ID', 192),
    sourceUrl: publicHttpsUrl(channel.sourceUrl, 'Registered source URL')
  };
}

function publicationFields(
  publication: Record<string, unknown>, signers: readonly NativeSignerRegistration[]
): Omit<NativePublicationRegistration, 'publicationAuthorized'> {
  const version = stableVersion(publication.version);
  const manifestUrl = publicHttpsUrl(publication.manifestUrl, 'Publication manifest URL');
  const signatureUrl = publicHttpsUrl(publication.signatureUrl, 'Publication signature URL');
  const prefix = `https://github.com/${canonicalRepository}/releases/download/v${version}/`;
  if (!manifestUrl.startsWith(prefix) || !signatureUrl.startsWith(prefix) || manifestUrl === signatureUrl ||
      new URL(manifestUrl).pathname.endsWith('/') || new URL(signatureUrl).pathname.endsWith('/')) {
    throw new DistributionError('Native publication must identify an immutable registered source release.', 'trust_unregistered');
  }
  const signerId = text(publication.signerId, 'Publication signer', 128);
  if (!signers.some((signer) => signer.id === signerId)) {
    throw new DistributionError('Publication signer is not registered.', 'trust_unregistered');
  }
  return {
    version, sourceCommit: sourceCommit(publication.sourceCommit), manifestUrl, signatureUrl, signerId,
    ...(publication.manifestSha256 !== undefined ? { manifestSha256: digest(publication.manifestSha256, 'Registered manifest digest') } : {})
  };
}

export function parseNativeTrustRoot(raw: unknown): Readonly<NativeTrustRoot> {
  const value = strictTrustObject(raw, [
    'schemaVersion', 'product', 'repository', 'state', 'signers', 'publicationIndex', 'channels'
  ], 'Public native trust root');
  if (value.schemaVersion !== 1 || value.product !== canonicalProductName || value.repository !== canonicalRepository) {
    throw new DistributionError('Public native trust root has a different schema, product, or repository.', 'invalid_metadata');
  }
  if (value.state === 'unconfigured') {
    strictTrustObject(value, ['schemaVersion', 'product', 'repository', 'state'], 'Unconfigured native trust root');
    return freeze({ schemaVersion: 1, product: canonicalProductName, repository: canonicalRepository, state: 'unconfigured' });
  }
  if (value.state !== 'configured') throw new DistributionError('Public native trust root requires an explicit configured state.', 'invalid_metadata');
  const signers = trustArray(value.signers, 16, 'Public metadata signers').map((rawSigner) => {
    strictTrustObject(rawSigner, ['id', 'publicKeyPem'], 'Public metadata signer');
    const signer = parseSigner(rawSigner);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(signer.id)) throw new DistributionError('Public signer ID is not canonical.', 'invalid_metadata');
    let key;
    try { key = createPublicKey(signer.publicKeyPem); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new DistributionError('Public metadata signer key is malformed.', 'invalid_metadata', { cause: error });
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new DistributionError('Public metadata trust requires an Ed25519 public key.', 'invalid_metadata');
    return { id: signer.id, publicKeyPem: key.export({ type: 'spki', format: 'pem' }).toString() };
  });
  const channels = trustArray(value.channels, 3, 'Public owner channels').map((rawChannel) => {
    strictTrustObject(rawChannel, ['owner', 'packageId', 'sourceId', 'sourceUrl'], 'Public owner channel');
    const channel = parseChannel(rawChannel);
    if (![channel.packageId, channel.sourceId].every((entry) => /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(entry))) {
      throw new DistributionError('Public owner channel identities are not canonical.', 'invalid_metadata');
    }
    if (channel.owner === 'direct' && channel.packageId !== canonicalProductName ||
        channel.owner === 'homebrew-cask' && (
          !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(channel.packageId) ||
          channel.sourceId !== channel.packageId.split('/').slice(0, 2).join('/')
        ) || channel.owner === 'winget' && !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/u.test(channel.packageId)) {
      throw new DistributionError('Public channel does not identify an exact supported owner package.', 'invalid_metadata');
    }
    publicNativeTrustUrl(channel.sourceUrl, 'Public owner channel source');
    return channel;
  });
  if (new Set(signers.map((signer) => signer.id)).size !== signers.length ||
      new Set(signers.map((signer) => signer.publicKeyPem)).size !== signers.length ||
      new Set(channels.map((channel) => channel.owner)).size !== channels.length) {
    throw new DistributionError('Public native trust root has duplicate signer or owner identities.', 'invalid_metadata');
  }
  const index = strictTrustObject(value.publicationIndex, ['url', 'signatureUrl', 'signerId', 'minimumSequence'], 'Public publication-index source');
  const url = publicNativeTrustUrl(index.url, 'Publication-index URL');
  const signatureUrl = publicNativeTrustUrl(index.signatureUrl, 'Publication-index signature URL');
  const signerId = text(index.signerId, 'Publication-index signer', 128);
  if (url === signatureUrl || !signers.some((signer) => signer.id === signerId)) {
    throw new DistributionError('Publication-index source or signer is not independently registered.', 'invalid_metadata');
  }
  return freeze({
    schemaVersion: 1, product: canonicalProductName, repository: canonicalRepository, state: 'configured',
    signers, channels, publicationIndex: {
      url, signatureUrl, signerId, minimumSequence: integer(index.minimumSequence, 'Publication-index sequence floor', 1, Number.MAX_SAFE_INTEGER)
    }
  });
}

export function nativeTrustRootDigest(root: ConfiguredNativeTrustRoot): string {
  const parsed = parseNativeTrustRoot(root);
  if (parsed.state !== 'configured') throw new DistributionError('An unconfigured root cannot bind a publication index.', 'invalid_metadata');
  return canonicalSha256(parsed);
}

export function parseNativePublicationIndex(raw: unknown, root: ConfiguredNativeTrustRoot): Readonly<NativePublicationIndex> {
  const value = strictTrustObject(raw, [
    'schemaVersion', 'product', 'repository', 'rootDigest', 'sequence', 'issuedAt', 'expiresAt', 'stableVersion', 'publications'
  ], 'Signed native publication index');
  if (value.schemaVersion !== 1 || value.product !== canonicalProductName || value.repository !== canonicalRepository ||
      digest(value.rootDigest, 'Publication-index root binding') !== nativeTrustRootDigest(root)) {
    throw new DistributionError('Publication index names a different product, repository, or public trust root.', 'invalid_metadata');
  }
  const issuedAt = timestamp(value.issuedAt, 'Publication-index issue time');
  const expiresAt = timestamp(value.expiresAt, 'Publication-index expiry');
  if (Date.parse(expiresAt) <= Date.parse(issuedAt) ||
      Date.parse(expiresAt) - Date.parse(issuedAt) > nativePublicationIndexMaximumLifetimeMs) {
    throw new DistributionError('Publication-index validity exceeds its bounded lifetime.', 'invalid_metadata');
  }
  const publications = trustArray(value.publications, 512, 'Signed publications').map((rawPublication) => {
    const publication = strictTrustObject(rawPublication, [
      'version', 'sourceCommit', 'manifestUrl', 'signatureUrl', 'signerId', 'manifestSha256'
    ], 'Signed publication');
    return { ...publicationFields(publication, root.signers), manifestSha256: digest(publication.manifestSha256, 'Signed manifest digest') };
  });
  const stable = stableVersion(value.stableVersion);
  if (new Set(publications.map((entry) => entry.version)).size !== publications.length ||
      !publications.some((entry) => entry.version === stable)) {
    throw new DistributionError('Publication index has duplicate releases or omits its stable release.', 'invalid_metadata');
  }
  return freeze({
    schemaVersion: 1, product: canonicalProductName, repository: canonicalRepository,
    rootDigest: nativeTrustRootDigest(root), sequence: integer(value.sequence, 'Publication-index sequence', 1, Number.MAX_SAFE_INTEGER),
    issuedAt, expiresAt, stableVersion: stable, publications
  });
}

export function parseNativeTrustRegistration(raw: unknown): Readonly<NativeTrustRegistration> {
  const value = object(raw, ['schemaVersion', 'repository', 'stableVersion', 'signers', 'publications', 'channels'], 'Native trust registration');
  if (value.schemaVersion !== 1 || value.repository !== canonicalRepository ||
      !Array.isArray(value.signers) || !value.signers.length || value.signers.length > 16 ||
      !Array.isArray(value.publications) || !value.publications.length || value.publications.length > 512 ||
      !Array.isArray(value.channels) || !value.channels.length || value.channels.length > 3) {
    throw new DistributionError('Native signing, publication, and owner-channel registrations are required.', 'trust_unregistered');
  }
  const signers = value.signers.map(parseSigner);
  const publications = value.publications.map((entry): NativePublicationRegistration => {
    const publication = object(entry, ['version', 'sourceCommit', 'manifestUrl', 'signatureUrl', 'signerId', 'publicationAuthorized', 'manifestSha256'], 'Native publication');
    if (typeof publication.publicationAuthorized !== 'boolean') {
      throw new DistributionError('Native publication must identify an immutable registered source release.', 'trust_unregistered');
    }
    return {
      ...publicationFields(publication, signers), publicationAuthorized: publication.publicationAuthorized
    };
  });
  const channels = value.channels.map(parseChannel);
  if (new Set(signers.map((entry) => entry.id)).size !== signers.length ||
      new Set(publications.map((entry) => entry.version)).size !== publications.length ||
      new Set(channels.map((entry) => entry.owner)).size !== channels.length) {
    throw new DistributionError('Native trust registration contains ambiguous duplicate identities.', 'trust_unregistered');
  }
  const stable = stableVersion(value.stableVersion);
  if (!publications.some((entry) => entry.version === stable && entry.publicationAuthorized)) {
    throw new DistributionError('Stable native publication has not been authorized.', 'trust_unregistered');
  }
  return freeze({ schemaVersion: 1, repository: canonicalRepository, stableVersion: stable, signers, publications, channels });
}

export function parsePayloadFile(raw: unknown): NativePayloadFile {
  const file = object(raw, ['path', 'sha256', 'size', 'mode'], 'Native payload file');
  return {
    path: text(file.path, 'Payload path'), sha256: digest(file.sha256, 'Payload digest'),
    size: integer(file.size, 'Payload size', 0, 256 * 1024 * 1024),
    mode: integer(file.mode, 'Payload mode', 0, 0o777)
  };
}
import { createPublicKey } from 'node:crypto';
