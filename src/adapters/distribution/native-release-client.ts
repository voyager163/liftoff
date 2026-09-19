import { createHash, createPublicKey, verify } from 'node:crypto';
import path from 'node:path';
import { compareSemver } from '../../semver.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { parseNativeReleaseManifest } from '../../domain/distribution/release-manifest.js';
import { canonicalRepository, type NativeReleaseManifest } from '../../domain/distribution/contracts.js';
import {
  nativePublicationIndexMaximumBytes, nativeTrustRootDigest, nativeTrustRootMaximumBytes, nativeTrustRootPathParts,
  parseNativePublicationIndex, parseNativeTrustRegistration, parseNativeTrustRoot, publicNativeTrustUrl,
  type ConfiguredNativeTrustRoot, type NativePublicationIndex, type NativePublicationRegistration,
  type NativeSignerRegistration, type NativeTrustRegistration, type VerifiedNativeRelease
} from '../../domain/distribution/native-trust.js';
import { DistributionError, type DistributionReason } from '../../domain/distribution/errors.js';
import { freeze, publicHttpsUrl } from '../../domain/distribution/validation.js';
import { getPackageRoot } from '../packaged-assets/package-root.js';
import { PackagedResourceIntegrityError, PackagedResourceMissingError, readBoundedPackagedFile } from '../packaged-assets/resource-file.js';
import { hashNativeFile, nativeDirectorySnapshot, parseNativeJsonBytes } from './native-files.js';

export const nativeReleaseLookupTimeoutMs = 15_000;
export const nativeArtifactMaximumBytes = 512 * 1024 * 1024;
export const nativeArtifactMaximumRedirects = 3;

export type NativeReleaseLookupErrorKind =
  | 'timeout' | 'transport' | 'invalid_manifest' | 'unsupported_platform' | 'trust_unregistered' | 'signature_invalid'
  | 'trust_missing' | 'trust_unconfigured' | 'trust_invalid' | 'index_invalid' | 'index_stale' | 'index_replay' | 'redirect_rejected';

const lookupReasons: Record<NativeReleaseLookupErrorKind, DistributionReason> = {
  timeout: 'timeout', transport: 'transport', invalid_manifest: 'invalid_metadata', unsupported_platform: 'unsupported_host',
  trust_unregistered: 'trust_unregistered', signature_invalid: 'signature_invalid', trust_missing: 'trust_missing',
  trust_unconfigured: 'trust_unconfigured', trust_invalid: 'invalid_metadata', index_invalid: 'invalid_metadata',
  index_stale: 'source_stale', index_replay: 'source_changed', redirect_rejected: 'transport'
};

export class NativeReleaseLookupError extends DistributionError {
  constructor(readonly kind: NativeReleaseLookupErrorKind, message: string, cause?: unknown) {
    super(message, lookupReasons[kind], { cause });
    this.name = 'NativeReleaseLookupError';
  }
}

export interface NativeArtifactSource {
  readBytes(url: string, maximumBytes: number): Promise<Buffer>;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const githubAssetHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

function artifactRedirect(initial: URL, current: URL, location: string | null): URL {
  if (!location || location.length > 16_384 || /[\u0000-\u0020\u007f]/u.test(location)) {
    throw new NativeReleaseLookupError('redirect_rejected', 'Native source returned an invalid redirect.');
  }
  let target: URL;
  try { target = new URL(location); }
  catch { throw new NativeReleaseLookupError('redirect_rejected', 'Native source returned an invalid redirect.'); }
  const registeredGithubAsset = initial.origin === 'https://github.com' &&
    /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[^/]+\/[^/]+$/u.test(initial.pathname);
  const firstHop = current.origin === initial.origin && current.href === initial.href &&
    githubAssetHosts.has(target.hostname) && /^\/github-production-release-asset(?:-2e65be)?\//u.test(target.pathname);
  const continuedHop = githubAssetHosts.has(current.hostname) && target.origin === current.origin &&
    target.pathname === current.pathname;
  if (!registeredGithubAsset || target.protocol !== 'https:' || target.port || target.username || target.password ||
      target.hash || target.href !== location || /%2f|%5c|%2e/iu.test(target.pathname) || !(firstHop || continuedHop)) {
    throw new NativeReleaseLookupError('redirect_rejected', 'Native source redirect escaped the registered GitHub asset delivery path.');
  }
  return target;
}

export class HttpNativeArtifactSource implements NativeArtifactSource {
  constructor(private readonly fetchFn: typeof fetch = globalThis.fetch, private readonly timeoutMs = nativeReleaseLookupTimeoutMs) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new DistributionError('Native lookup timeout is outside its bounded range.');
    }
  }

  async readBytes(url: string, maximumBytes: number): Promise<Buffer> {
    publicNativeTrustUrl(url, 'Native artifact URL');
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > nativeArtifactMaximumBytes) {
      throw new DistributionError('Native response limit is outside its bounded range.');
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new NativeReleaseLookupError('timeout', 'Native metadata or artifact body lookup timed out.'));
      }, this.timeoutMs);
    });
    const read = async (): Promise<Buffer> => {
      const initial = new URL(url);
      let current = initial;
      const visited = new Set<string>();
      for (let redirects = 0; ; redirects++) {
        if (visited.has(current.href)) throw new NativeReleaseLookupError('redirect_rejected', 'Native source redirect loop was refused.');
        visited.add(current.href);
        const response = await this.fetchFn(current.href, {
          signal: controller.signal, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
          headers: { Accept: 'application/octet-stream, application/json', 'User-Agent': 'liftoff-cli' }
        });
        if (response.redirected || response.url && response.url !== current.href) {
          await response.body?.cancel();
          throw new NativeReleaseLookupError('redirect_rejected', 'Native transport did not preserve explicit redirect admission.');
        }
        if (redirectStatuses.has(response.status)) {
          try {
            if (redirects >= nativeArtifactMaximumRedirects) {
              throw new NativeReleaseLookupError('redirect_rejected', 'Native source exceeded its redirect limit.');
            }
            current = artifactRedirect(initial, current, response.headers.get('location'));
          } finally { await response.body?.cancel(); }
          continue;
        }
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new NativeReleaseLookupError('transport', `Native source returned HTTP ${response.status}.`);
        }
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
          await response.body.cancel();
          throw new NativeReleaseLookupError('invalid_manifest', 'Native source exceeded its bounded response limit.');
        }
        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let length = 0;
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            length += item.value.byteLength;
            if (length > maximumBytes) throw new NativeReleaseLookupError('invalid_manifest', 'Native source exceeded its bounded response limit.');
            chunks.push(Buffer.from(item.value));
          }
          return Buffer.concat(chunks, length);
        } finally {
          if (!controller.signal.aborted) await reader.cancel();
          reader.releaseLock();
        }
      }
    };
    try { return await Promise.race([read(), deadline]); }
    catch (error) {
      if (error instanceof DistributionError) throw error;
      throw new NativeReleaseLookupError(controller.signal.aborted ? 'timeout' : 'transport', 'Native source transport failed.', error);
    } finally { clearTimeout(timer); controller.abort(); }
  }
}

export interface NativeReleaseClientOptions {
  /** Explicit non-production registration seam retained for isolated adapters/tests. */
  trust?: NativeTrustRegistration;
  source?: NativeArtifactSource;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

interface LoadedTrustRoot {
  root: Readonly<ConfiguredNativeTrustRoot>;
  policyDigest: string;
  sourceDigest: string;
  bindingDigest: string;
}

interface ResolvedAuthority {
  registration: Readonly<NativeTrustRegistration>;
  root?: LoadedTrustRoot;
  index?: Readonly<NativePublicationIndex>;
}

interface IndexWatermark {
  sequence: number;
  digest: string;
  issuedAt: number;
  stableVersion: string;
  observedAt: number;
  publications: ReadonlyMap<string, string>;
}

function verifyDetachedSignature(
  bytes: Buffer, signatureBytes: Buffer, signer: NativeSignerRegistration | undefined
): void {
  if (!signer) throw new NativeReleaseLookupError('trust_unregistered', 'Native metadata signer is not registered.');
  const encoded = signatureBytes.toString('utf8').trim();
  const signature = signatureBytes.length === 64 ? signatureBytes
    : /^[A-Za-z0-9+/]{86}==$/u.test(encoded) ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
  const key = createPublicKey(signer.publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !verify(null, bytes, key, signature)) {
    throw new NativeReleaseLookupError('signature_invalid', 'Native metadata signature does not match the registered public signer.');
  }
}

export class NativeReleaseClient {
  private readonly source: NativeArtifactSource;
  private readonly registration?: Readonly<NativeTrustRegistration>;
  private readonly packageRoot: string;
  private readonly now: () => Date;
  private readonly admitted = new WeakMap<VerifiedNativeRelease, ResolvedAuthority>();
  private readonly publicationContexts = new WeakMap<NativePublicationRegistration, ResolvedAuthority>();
  private readonly indexes = new Map<string, IndexWatermark>();

  constructor(options: NativeReleaseClientOptions = {}) {
    this.registration = options.trust === undefined ? undefined : parseNativeTrustRegistration(options.trust);
    this.packageRoot = getPackageRoot();
    this.now = options.now ?? (() => new Date());
    this.source = options.source ?? new HttpNativeArtifactSource(options.fetchFn, options.timeoutMs);
  }

  private clock(): number {
    const value = this.now().getTime();
    if (!Number.isFinite(value)) throw new NativeReleaseLookupError('index_stale', 'Native publication clock is invalid.');
    return value;
  }

  private async loadRoot(): Promise<LoadedTrustRoot> {
    let bytes: Buffer;
    try {
      bytes = readBoundedPackagedFile(this.packageRoot, nativeTrustRootPathParts, { maximumBytes: nativeTrustRootMaximumBytes });
    } catch (error) {
      if (error instanceof PackagedResourceMissingError) {
        throw new NativeReleaseLookupError('trust_missing', 'The packaged public native trust root is missing; no operational qualification file was consulted.');
      }
      if (!(error instanceof PackagedResourceIntegrityError)) throw error;
      throw new NativeReleaseLookupError('trust_invalid', 'The packaged public native trust root cannot be read safely.', error);
    }
    try {
      const file = await hashNativeFile(this.packageRoot, nativeTrustRootPathParts, nativeTrustRootMaximumBytes);
      const directories = await Promise.all([
        this.packageRoot, path.join(this.packageRoot, 'assets'), path.join(this.packageRoot, 'assets', 'distribution')
      ].map(nativeDirectorySnapshot));
      const sourceDigest = createHash('sha256').update(bytes).digest('hex');
      if (file.sha256 !== sourceDigest) throw new DistributionError('Public native trust root changed during its guarded read.', 'stale_plan');
      if (process.platform !== 'win32') {
        const user = process.getuid?.();
        if (user === undefined || [file, ...directories].some((entry) =>
          (entry.mode & 0o022) !== 0 || entry.uid !== user && entry.uid !== 0)) {
          throw new DistributionError('Public native trust files must be controlled by the current user or system.', 'unsafe_path');
        }
      }
      const root = parseNativeTrustRoot(parseNativeJsonBytes(bytes, 'Public native trust root'));
      if (root.state === 'unconfigured') {
        throw new NativeReleaseLookupError('trust_unconfigured',
          'The packaged public native trust root is explicitly unconfigured. No publisher keys, publication endpoints, or owner channels are authorized.');
      }
      return { root, sourceDigest, policyDigest: nativeTrustRootDigest(root),
        bindingDigest: canonicalSha256({ packageRoot: this.packageRoot, file, directories }) };
    } catch (error) {
      if (error instanceof NativeReleaseLookupError) throw error;
      if (!(error instanceof Error)) throw error;
      throw new NativeReleaseLookupError('trust_invalid', 'The packaged public native trust root is malformed, unsafe, or changed.', error);
    }
  }

  private async assertRootCurrent(root: LoadedTrustRoot): Promise<void> {
    if ((await this.loadRoot()).bindingDigest !== root.bindingDigest) {
      throw new NativeReleaseLookupError('trust_invalid', 'The packaged public trust root bytes, owner, mode, or directory identity changed.');
    }
  }

  private assertIndexTime(index: NativePublicationIndex): void {
    const now = this.clock();
    if (now < Date.parse(index.issuedAt) || now >= Date.parse(index.expiresAt)) {
      throw new NativeReleaseLookupError('index_stale', 'The signed native publication index is expired or not yet valid.');
    }
  }

  private async resolveAuthority(): Promise<ResolvedAuthority> {
    if (this.registration) return { registration: this.registration };
    const root = await this.loadRoot();
    const [bytes, signature] = await Promise.all([
      this.readArtifact(root.root.publicationIndex.url, nativePublicationIndexMaximumBytes),
      this.readArtifact(root.root.publicationIndex.signatureUrl, 1024)
    ]);
    verifyDetachedSignature(bytes, signature, root.root.signers.find((entry) => entry.id === root.root.publicationIndex.signerId));
    let index: Readonly<NativePublicationIndex>;
    try { index = parseNativePublicationIndex(parseNativeJsonBytes(bytes, 'Signed native publication index'), root.root); }
    catch (error) {
      if (!(error instanceof DistributionError)) throw error;
      throw new NativeReleaseLookupError('index_invalid', 'The signed publication index has invalid source, version, channel-root, or metadata bindings.', error);
    }
    this.assertIndexTime(index);
    await this.assertRootCurrent(root);
    this.assertIndexTime(index);
    const observedAt = this.clock();
    const indexDigest = createHash('sha256').update(bytes).digest('hex');
    const previous = this.indexes.get(root.policyDigest);
    if (index.sequence < root.root.publicationIndex.minimumSequence || previous && (
      index.sequence < previous.sequence || observedAt < previous.observedAt ||
      Date.parse(index.issuedAt) < previous.issuedAt ||
      compareSemver(index.stableVersion, previous.stableVersion) < 0 ||
      index.sequence === previous.sequence && indexDigest !== previous.digest
    )) throw new NativeReleaseLookupError('index_replay', 'The signed publication index violates its sequence, stable-version, or replay boundary.');
    const publicationBindings = new Map(previous?.publications);
    for (const publication of index.publications) {
      const binding = canonicalSha256(publication);
      const known = publicationBindings.get(publication.version);
      if (known !== undefined && known !== binding) {
        throw new NativeReleaseLookupError('index_replay', 'A previously observed immutable native publication changed its source, signer, or manifest binding.');
      }
      publicationBindings.set(publication.version, binding);
    }
    if (publicationBindings.size > 512 || !previous && this.indexes.size >= 16) {
      throw new NativeReleaseLookupError('index_replay', 'Native publication observation exceeded its bounded in-process history.');
    }
    const registration = parseNativeTrustRegistration({
      schemaVersion: 1, repository: canonicalRepository, stableVersion: index.stableVersion,
      signers: root.root.signers, channels: root.root.channels,
      publications: index.publications.map((entry) => ({ ...entry, publicationAuthorized: true }))
    });
    this.indexes.set(root.policyDigest, {
      sequence: index.sequence, digest: indexDigest, issuedAt: Date.parse(index.issuedAt), stableVersion: index.stableVersion, observedAt,
      publications: publicationBindings
    });
    const authority = { registration, root, index };
    for (const publication of registration.publications) this.publicationContexts.set(publication, authority);
    return authority;
  }

  async trustRegistration(): Promise<Readonly<NativeTrustRegistration>> {
    return (await this.resolveAuthority()).registration;
  }

  async readArtifact(url: string, maximumBytes: number): Promise<Buffer> {
    publicHttpsUrl(url, 'Native artifact URL');
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > nativeArtifactMaximumBytes) {
      throw new DistributionError('Native response limit is outside its bounded range.');
    }
    const bytes = await this.source.readBytes(url, maximumBytes);
    if (!Buffer.isBuffer(bytes) || bytes.length > maximumBytes) {
      throw new NativeReleaseLookupError('invalid_manifest', 'Native source exceeded its bounded response limit.');
    }
    return Buffer.from(bytes);
  }

  async verifySignature(bytes: Buffer, signatureBytes: Buffer, publication: NativePublicationRegistration): Promise<void> {
    const bound = this.publicationContexts.get(publication);
    if (!this.registration && !bound) {
      throw new NativeReleaseLookupError('trust_unregistered', 'Production signature verification requires an admitted publication, not caller approval fields.');
    }
    if (bound?.index) this.assertIndexTime(bound.index);
    const authority = await this.resolveAuthority();
    const registered = authority.registration.publications.find((entry) => entry.version === publication.version);
    if (!registered?.publicationAuthorized || canonicalSha256(registered) !== canonicalSha256(publication)) {
      throw new NativeReleaseLookupError('trust_unregistered', 'Native publication does not match its registered authority.');
    }
    if (bound?.root && authority.root?.bindingDigest !== bound.root.bindingDigest) {
      throw new NativeReleaseLookupError('trust_invalid', 'The public trust root changed after release admission.');
    }
    verifyDetachedSignature(bytes, signatureBytes, authority.registration.signers.find((entry) => entry.id === publication.signerId));
    if (authority.root) await this.assertRootCurrent(authority.root);
    if (authority.index) this.assertIndexTime(authority.index);
  }

  async fetchVerifiedRelease(version?: string): Promise<VerifiedNativeRelease> {
    const authority = await this.resolveAuthority();
    const trust = authority.registration;
    const publication = trust.publications.find((entry) => entry.version === (version ?? trust.stableVersion));
    if (!publication?.publicationAuthorized) {
      throw new NativeReleaseLookupError('trust_unregistered', 'The requested native version has no authorized publication registration.');
    }
    const [bytes, signature] = await Promise.all([
      this.readArtifact(publication.manifestUrl, 1024 * 1024),
      this.readArtifact(publication.signatureUrl, 1024)
    ]);
    const manifestDigest = createHash('sha256').update(bytes).digest('hex');
    if (publication.manifestSha256 !== undefined && publication.manifestSha256 !== manifestDigest) {
      throw new NativeReleaseLookupError('invalid_manifest', 'Native manifest bytes differ from the authenticated publication index.');
    }
    verifyDetachedSignature(bytes, signature, trust.signers.find((entry) => entry.id === publication.signerId));
    let manifest: NativeReleaseManifest;
    try { manifest = parseNativeReleaseManifest(parseNativeJsonBytes(bytes, 'Native release manifest')); }
    catch (error) {
      if (!(error instanceof DistributionError)) throw error;
      throw new NativeReleaseLookupError('invalid_manifest', 'Native release metadata is not valid.', error);
    }
    if (manifest.version !== publication.version || manifest.sourceCommit !== publication.sourceCommit) {
      throw new NativeReleaseLookupError('invalid_manifest', 'Native release source or version differs from the authorized publication.');
    }
    if (authority.index && Date.parse(manifest.publishedAt) > Date.parse(authority.index.issuedAt)) {
      throw new NativeReleaseLookupError('invalid_manifest', 'Native release publication time is later than its authenticated index.');
    }
    if (authority.index) this.assertIndexTime(authority.index);
    if (authority.root) await this.assertRootCurrent(authority.root);
    const result: VerifiedNativeRelease = freeze({
      manifest, publication, manifestDigest,
      registrationDigest: authority.root
        ? canonicalSha256({ policy: authority.root.policyDigest, source: authority.root.sourceDigest, publication })
        : canonicalSha256(trust)
    });
    this.admitted.set(result, authority);
    this.publicationContexts.set(publication, authority);
    return result;
  }

  assertAdmitted(release: VerifiedNativeRelease): void {
    const authority = this.admitted.get(release);
    if (!authority) throw new DistributionError('Release identity was not admitted by this trusted source.', 'trust_unregistered');
    if (authority.index) this.assertIndexTime(authority.index);
  }

  async assertCurrent(release: VerifiedNativeRelease): Promise<void> {
    this.assertAdmitted(release);
    const authority = this.admitted.get(release);
    if (authority?.root) await this.assertRootCurrent(authority.root);
  }

  async fetchReleaseManifest(): Promise<NativeReleaseManifest> {
    return (await this.fetchVerifiedRelease()).manifest;
  }
}
