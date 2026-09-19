import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createZstdDecompress } from 'node:zlib';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { commandSucceeded } from '../../governance-activation/transition-process.js';
import type { CommandRunner } from '../../process-runner.js';
import {
  assertApplicationRegistryPromotionAuthority,
  type ApplicationRegistryPromotionAdmission, type ApplicationRegistryPromotionConfiguration,
  type ApplicationRegistryPromotionEffect, type ApplicationRegistryPromotionEffectPrepared,
  type ApplicationRegistryTransferBounds
} from '../../application/azure-activation/application-registry-promotion-admission.js';
import { createAzureCliArmTransport, type AzureArmTransport } from './activation-rest.js';
import {
  AzureApplicationProvisioningClient, applicationImageDigest, applicationRegistryHost, applicationUuid,
  type ApplicationRegistryObservation
} from './application-provisioning.js';
import { NIL_UUID, UUID_PATTERN } from './production-adapter.js';
import {
  ApplicationRegistryCopyError, allManifestMediaTypes, configMediaTypes, indexMediaTypes, layerMediaTypes, manifestMediaTypes,
  validateApplicationRegistryPromotionReadback,
  type ApplicationRegistryByteObservation, type ApplicationRegistryPromotionReadback
} from './application-registry-readback.js';

export {
  ApplicationRegistryCopyError, type ApplicationRegistryByteObservation, type ApplicationRegistryPromotionReadback
} from './application-registry-readback.js';

const metadataLimit = 1024 * 1024;
const tokenLimit = 64 * 1024;
const emptyDigest = `sha256:${createHash('sha256').digest('hex')}`;

function requireValue(value: unknown, code: string, message: string, status?: number): asserts value {
  if (!value) throw new ApplicationRegistryCopyError(`registry-copy-${code}`, message, status);
}

const sha = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function object(bytes: Uint8Array, code: string): Record<string, unknown> {
  requireValue(isUtf8(bytes), code, 'The bounded registry document is not UTF-8; response bytes were withheld.');
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    requireValue(isRecord(parsed), code, 'The registry document is not a supported JSON object.');
    return parsed;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ApplicationRegistryCopyError(`registry-copy-${code}`, 'The registry document is malformed JSON; private response bytes were withheld.');
  }
}

function integer(value: unknown, minimum: number, maximum: number, code = 'size'): number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    code, 'The actual registry size or count is outside the explicitly supported bound.');
  return value;
}

export interface ApplicationRegistryOciPlatform {
  os: 'linux';
  architecture: 'amd64' | 'arm64';
  variant?: 'v8';
}

export interface ApplicationRegistryOciDescriptor {
  digest: string;
  size: number;
  mediaType: string;
  platform?: ApplicationRegistryOciPlatform;
}

export type ApplicationRegistryOciManifest =
  | { kind: 'image'; mediaType: string; config: ApplicationRegistryOciDescriptor; layers: readonly ApplicationRegistryOciDescriptor[] }
  | { kind: 'index'; mediaType: string; manifests: readonly ApplicationRegistryOciDescriptor[] };

function platform(value: unknown): ApplicationRegistryOciPlatform {
  requireValue(isRecord(value) && value.os === 'linux' && (value.architecture === 'amd64' || value.architecture === 'arm64') &&
    Object.keys(value).every((key) => ['os', 'architecture', 'variant'].includes(key)) &&
    (value.variant === undefined || value.architecture === 'arm64' && value.variant === 'v8'),
  'platform', 'Only explicit Linux amd64/arm64 image platforms are supported; foreign OS/features and ambiguous variants are refused.');
  return { os: 'linux', architecture: value.architecture, ...(value.variant === 'v8' ? { variant: 'v8' as const } : {}) };
}

function descriptor(value: unknown, mediaTypes: readonly string[], maximum: number): ApplicationRegistryOciDescriptor {
  requireValue(isRecord(value) && typeof value.mediaType === 'string' && mediaTypes.includes(value.mediaType) &&
    (value.urls === undefined || Array.isArray(value.urls) && value.urls.length === 0) &&
    value.data === undefined && value.artifactType === undefined,
  'descriptor', 'OCI descriptors must use supported distributable media types and registry-owned blobs, without alternate URLs, embedded data or foreign artifacts.');
  return {
    digest: applicationImageDigest(value.digest), size: integer(value.size, 0, maximum), mediaType: value.mediaType,
    ...(value.platform === undefined ? {} : { platform: platform(value.platform) })
  };
}

/** Pure byte validation. This does not issue access authority or a promotion receipt. */
export function inspectApplicationRegistryOciManifest(
  bytes: Uint8Array, expectedDigest: string, bounds: Pick<ApplicationRegistryTransferBounds, 'maxManifestBytes' | 'maxConfigBytes' | 'maxBlobBytes' | 'maxBlobs' | 'maxManifests'>
): ApplicationRegistryOciManifest {
  requireValue(bytes.byteLength > 0 && bytes.byteLength <= bounds.maxManifestBytes &&
    sha(bytes) === applicationImageDigest(expectedDigest), 'manifest-digest', 'The exact manifest/index bytes do not match their immutable digest or size bound.');
  const manifest = object(bytes, 'manifest');
  requireValue(manifest.schemaVersion === 2 && typeof manifest.mediaType === 'string' &&
    allManifestMediaTypes.includes(manifest.mediaType) && manifest.subject === undefined && manifest.artifactType === undefined,
  'manifest', 'Only schema-2 OCI/Docker image manifests and image indexes are admitted.');
  if ((indexMediaTypes as readonly string[]).includes(manifest.mediaType)) {
    requireValue(Array.isArray(manifest.manifests) && manifest.manifests.length > 0 &&
      manifest.manifests.length <= bounds.maxManifests && manifest.config === undefined && manifest.layers === undefined,
    'index', 'An image index needs a bounded nonempty concrete manifest inventory.');
    const manifests = manifest.manifests.map((entry) => descriptor(entry, allManifestMediaTypes, bounds.maxManifestBytes));
    requireValue(new Set(manifests.map((entry) => entry.digest)).size === manifests.length &&
      manifests.every((entry) => (indexMediaTypes as readonly string[]).includes(entry.mediaType) || entry.platform),
    'index', 'Image indexes cannot repeat a manifest or omit a leaf platform.');
    return { kind: 'index', mediaType: manifest.mediaType, manifests };
  }
  requireValue(Array.isArray(manifest.layers) && manifest.layers.length <= bounds.maxBlobs && manifest.manifests === undefined,
    'layers', 'An image manifest needs a bounded concrete layer inventory.');
  const config = descriptor(manifest.config, configMediaTypes, bounds.maxConfigBytes);
  const layers = manifest.layers.map((entry) => descriptor(entry, layerMediaTypes, bounds.maxBlobBytes));
  requireValue(config.size > 0 && config.platform === undefined && layers.every((entry) => entry.platform === undefined) &&
    (manifest.mediaType === manifestMediaTypes[0] ? config.mediaType === configMediaTypes[0] : config.mediaType === configMediaTypes[1]),
  'config', 'The OCI configuration descriptor must match its image manifest media type.');
  return { kind: 'image', mediaType: manifest.mediaType, config, layers };
}

export async function verifyApplicationRegistryOciLayer(input: {
  bytes: Uint8Array;
  descriptor: ApplicationRegistryOciDescriptor;
  diffId: string;
  maxExpandedBytes: number;
  timeoutMs: number;
}): Promise<{ digest: string; diffId: string; compressedBytes: number; expandedBytes: number }> {
  const { bytes, descriptor: expected } = input;
  integer(input.maxExpandedBytes, 1, 256 * 1024 * 1024);
  integer(input.timeoutMs, 1, 30_000);
  applicationImageDigest(input.diffId);
  requireValue((layerMediaTypes as readonly string[]).includes(expected.mediaType) && bytes.byteLength === expected.size &&
    sha(bytes) === applicationImageDigest(expected.digest), 'layer-descriptor', 'The concrete layer differs from its exact OCI size, digest or distributable media type.');
  if (expected.mediaType === 'application/vnd.oci.image.layer.v1.tar') {
    requireValue(bytes.byteLength <= input.maxExpandedBytes && sha(bytes) === input.diffId,
      'layer-identity', 'The actual uncompressed layer does not match the source configuration diff ID or expansion bound.');
    return { digest: expected.digest, diffId: input.diffId, compressedBytes: bytes.byteLength, expandedBytes: bytes.byteLength };
  }
  const hash = createHash('sha256');
  let expanded = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      expanded += chunk.length;
      if (expanded > input.maxExpandedBytes) {
        chunk.fill(0);
        done(new ApplicationRegistryCopyError('registry-copy-layer-expansion', 'A layer exceeds its explicitly reviewed decompression ceiling.'));
        return;
      }
      hash.update(chunk);
      chunk.fill(0);
      done();
    }
  });
  try {
    await pipeline(
      Readable.from([bytes]), expected.mediaType.endsWith('+zstd') ? createZstdDecompress() : createGunzip(),
      sink, { signal: AbortSignal.timeout(input.timeoutMs) }
    );
  } catch (error) {
    if (error instanceof ApplicationRegistryCopyError) throw error;
    throw new ApplicationRegistryCopyError('registry-copy-layer-encoding', 'The bounded layer cannot be decoded as its declared OCI media type; no layer bytes or diagnostics were disclosed.');
  }
  requireValue(`sha256:${hash.digest('hex')}` === input.diffId, 'layer-identity',
    'The actual decompressed layer bytes differ from the original source configuration diff ID.');
  return { digest: expected.digest, diffId: input.diffId, compressedBytes: bytes.byteLength, expandedBytes: expanded };
}

export interface ApplicationRegistryTransferUsage {
  /** HTTP requests plus bounded private Azure CLI account/token acquisitions. */
  requests: number;
  writeRequests: number;
  transferredBytes: number;
  imageBytes: number;
  blobs: number;
  manifests: number;
}

export interface ApplicationRegistryCopyOptions {
  /** Transport-only seam for isolated HTTP fixtures; never an authorizer or readback callback. */
  fetch?: typeof globalThis.fetch;
}

interface RegistryResponse {
  status: number;
  headers: Headers;
  bytes: Buffer;
  requestId: string | null;
}

interface ImageEntry {
  descriptor: ApplicationRegistryOciDescriptor;
  bytes: Buffer;
  observation: ApplicationRegistryByteObservation;
}

interface ImageGraph {
  manifests: Map<string, ImageEntry>;
  blobs: Map<string, ImageEntry>;
  publicationOrder: string[];
  selectedConfig: ImageEntry | null;
  platforms: Set<string>;
}

interface VolatileUpload {
  id: string;
  url: string;
  state: 'uuid-only' | 'volatile-state-required';
}

const issuedReadbacks = new WeakMap<ApplicationRegistryPromotionReadback, { authority: ApplicationRegistryPromotionAdmission; digest: string }>();

function providerId(value: string | null, clientCorrelationId?: string): string | null {
  return value && UUID_PATTERN.test(value) && value !== NIL_UUID && value.toLowerCase() !== clientCorrelationId?.toLowerCase()
    ? value.toLowerCase() : null;
}

function claims(secret: string, now: number, requiredLifetime: number): Record<string, unknown> {
  requireValue(secret.length > 0 && secret.length <= tokenLimit, 'credential', 'A bounded scoped credential was not returned; credential bytes were withheld.');
  const segments = secret.split('.');
  requireValue(segments.length === 3 && segments.every((part) => /^[A-Za-z0-9_-]+$/u.test(part)),
    'credential', 'The credential has no supported bound identity claims.');
  const bytes = Buffer.from(segments[1]!, 'base64url');
  try {
    requireValue(bytes.toString('base64url') === segments[1], 'credential', 'Credential claims are not canonically encoded.');
    const value = object(bytes, 'credential');
    requireValue(Number.isSafeInteger(value.exp) && Number(value.exp) * 1000 > now + requiredLifetime &&
      (value.nbf === undefined || Number.isSafeInteger(value.nbf) && Number(value.nbf) * 1000 <= now),
    'credential-time', 'The actual scoped credential is expired, premature or too short-lived for the bounded request.');
    return value;
  } finally { bytes.fill(0); }
}

/**
 * Only this client performs the registry effects. It reuses the existing private
 * Azure CLI ARM token path through its protected HTTP adapter; no token is an
 * argument, public result, checkpoint, file, Docker login or child environment.
 */
export class AzureApplicationRegistryCopyClient {
  readonly #config: ApplicationRegistryPromotionConfiguration;
  readonly #fetch: typeof globalThis.fetch;
  readonly #arm: AzureArmTransport;
  readonly #usage: ApplicationRegistryTransferUsage = {
    requests: 0, writeRequests: 0, transferredBytes: 0, imageBytes: 0, blobs: 0, manifests: 0
  };
  readonly #started = performance.now();
  readonly #remainingAtStart: number;
  #aad: Buffer | undefined;
  #sourceToken: Buffer | undefined;
  #targetToken: Buffer | undefined;
  #sourceRegistry: ApplicationRegistryObservation | undefined;
  #targetRegistry: ApplicationRegistryObservation | undefined;
  #graph: ImageGraph | undefined;
  #disposed = false;
  #executed = false;

  constructor(readonly authority: ApplicationRegistryPromotionAdmission, options: ApplicationRegistryCopyOptions = {}) {
    this.#config = authority.configuration;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#remainingAtStart = Date.parse(this.#config.transfer.deadline) - authority.now();
    const runner: CommandRunner = {
      run: async (command, settings) => {
        await this.#guard();
        this.#count();
        return authority.runner.run(command, {
          ...settings, timeoutMs: Math.min(settings?.timeoutMs ?? 30_000, this.#timeout()),
          signal: AbortSignal.any([AbortSignal.timeout(this.#timeout()), ...(settings?.signal ? [settings.signal] : [])]),
          stream: false
        });
      }
    };
    this.#arm = createAzureCliArmTransport(runner, authority.projectRoot, {
      now: () => authority.now(),
      fetch: async (resource, init) => {
        const url = new URL(String(resource));
        requireValue(url.origin === 'https://management.azure.com' && init?.method === 'GET' &&
          [this.#config.sourceRegistryResourceId, this.#config.targetRegistryResourceId].includes(url.pathname),
        'arm-scope', 'Promotion may independently read only its two exact ARM registries; ARM mutations are not supported.');
        const authorization = new Headers(init.headers).get('authorization');
        requireValue(authorization !== null && authorization.startsWith('Bearer '), 'arm-credential', 'The existing protected ARM adapter did not supply its private bearer credential.');
        const token = authorization.slice(7);
        const identity = claims(token, authority.now(), this.#timeout());
        this.#assertAadIdentity(identity);
        this.#aad?.fill(0);
        this.#aad = Buffer.from(token);
        const response = await this.#send(url, 'GET', new Headers(init.headers), undefined, metadataLimit, undefined, init.signal ?? undefined);
        try {
          return new Response(new Uint8Array(response.bytes), { status: response.status, headers: response.headers });
        } finally { response.bytes.fill(0); }
      }
    });
  }

  get usage(): ApplicationRegistryTransferUsage { return { ...this.#usage }; }

  #timeout(): number {
    const remaining = Math.min(
      this.#remainingAtStart - (performance.now() - this.#started),
      Date.parse(this.#config.transfer.deadline) - this.authority.now()
    );
    requireValue(remaining >= 1, 'deadline', 'The explicit transfer deadline has elapsed; in-flight effects retain their original checkpoints.');
    return Math.max(1, Math.floor(Math.min(remaining, this.#config.transfer.requestTimeoutMs)));
  }

  async #guard(): Promise<void> {
    requireValue(!this.#disposed, 'disposed', 'Disposed registry credentials cannot be reused.');
    this.#timeout();
    await assertApplicationRegistryPromotionAuthority(this.authority);
    this.#timeout();
  }

  #count(): void {
    requireValue(this.#usage.requests < this.#config.transfer.maxRequests, 'request-bound', 'The explicit registry/credential request count is exhausted; no implicit retry is permitted.');
    this.#usage.requests++;
  }

  #charge(size: number): void {
    requireValue(this.#usage.transferredBytes + size <= this.#config.transfer.maxTransferBytes,
      'transfer-bound', 'The concrete transfer exceeded its reviewed byte ceiling; original partial effects are retained.');
    this.#usage.transferredBytes += size;
  }

  #assertAadIdentity(identity: Record<string, unknown>): void {
    const binding = this.#config.binding;
    requireValue(typeof identity.oid === 'string' && identity.oid.toLowerCase() === binding.principalId &&
      typeof identity.tid === 'string' && identity.tid.toLowerCase() === binding.tenantId &&
      ['https://management.azure.com/', 'https://management.azure.com', 'https://management.core.windows.net/',
        '797f4846-ba00-4fd7-ba43-dac1f8f63013'].includes(String(identity.aud)) &&
      (binding.clientId === null ||
        (typeof identity.appid === 'string' && identity.appid.toLowerCase() === binding.clientId ||
          typeof identity.azp === 'string' && identity.azp.toLowerCase() === binding.clientId)) &&
      (identity.appid === undefined || identity.azp === undefined || identity.appid === identity.azp),
    'actor', 'The actual ARM credential does not match the exact subscription/tenant/principal/client binding.');
  }

  async #account(): Promise<void> {
    await this.#guard();
    this.#count();
    const result = await this.authority.runner.run({
      executable: 'az', args: ['account', 'show', '--subscription', this.#config.binding.subscriptionId, '--output', 'json', '--only-show-errors']
    }, {
      cwd: this.authority.projectRoot, timeoutMs: this.#timeout(), maxOutputBytes: tokenLimit,
      signal: AbortSignal.timeout(this.#timeout()), stream: false,
      env: { AZURE_CORE_COLLECT_TELEMETRY: 'false', AZURE_CORE_ONLY_SHOW_ERRORS: 'true', AZURE_CORE_NO_COLOR: 'true' }
    });
    try {
      requireValue(commandSucceeded(result) && !result.aborted && !result.outputLimitExceeded,
        'account', 'The bounded actual Azure account could not be read; private command diagnostics were withheld.');
      const bytes = Buffer.from(result.stdout);
      let account: Record<string, unknown>;
      try {
        requireValue(bytes.length <= tokenLimit, 'account', 'Azure account metadata exceeded its bound.');
        account = object(bytes, 'account');
      } finally { bytes.fill(0); }
      const binding = this.#config.binding;
      requireValue(typeof account.id === 'string' && account.id.toLowerCase() === binding.subscriptionId &&
        typeof account.tenantId === 'string' && account.tenantId.toLowerCase() === binding.tenantId &&
        account.state === 'Enabled' && account.environmentName === 'AzureCloud' && isRecord(account.user) &&
        (account.user.type === 'user' && typeof account.user.name === 'string' && account.user.name.length > 0 ||
          account.user.type === 'servicePrincipal' && binding.clientId !== null &&
          typeof account.user.name === 'string' && account.user.name.toLowerCase() === binding.clientId),
      'account', 'Promotion requires an Enabled, exact commercial Azure account and an explicit client for a service principal; no ambient account is substituted.');
    } finally { result.stdout = ''; result.stderr = ''; }
  }

  async #registries(): Promise<void> {
    await this.#account();
    const client = new AzureApplicationProvisioningClient(this.#arm, this.#config.binding);
    const read = async (id: string, host: string) => {
      await this.#guard();
      const parts = id.split('/');
      const registry = await client.getAcr(parts[4]!, parts[8]!);
      requireValue(registry.id.toLowerCase() === id.toLowerCase() && registry.loginServer === host &&
        registry.provisioningState === 'Succeeded' && registry.adminUserEnabled === false,
      'registry-binding', 'Independent ARM readback must confirm both exact registry IDs/login servers, successful provisioning and disabled admin credentials.');
      return registry;
    };
    this.#sourceRegistry = await read(this.#config.sourceRegistryResourceId, this.#config.sourceLoginServer);
    this.#targetRegistry = await read(this.#config.targetRegistryResourceId, this.#config.targetLoginServer);
  }

  #uploadLocation(header: string | null, id: string): VolatileUpload {
    requireValue(header && header.length <= 16 * 1024 && !/[\u0000-\u0020\u007f\\]/u.test(header),
      'upload-location', 'The registry upload location is missing or outside the supported private in-memory contract.');
    let url: URL;
    try { url = new URL(header, `https://${this.#config.targetLoginServer}`); }
    catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new ApplicationRegistryCopyError('registry-copy-upload-location', 'The registry returned a malformed upload location; URL bytes were withheld.');
    }
    requireValue(url.origin === `https://${this.#config.targetLoginServer}` && !url.username && !url.password && !url.hash &&
      url.pathname === `/v2/${this.#config.targetRepository}/blobs/uploads/${id}` &&
      [...url.searchParams.keys()].every((key) => key === '_state') && url.searchParams.getAll('_state').length <= 1 &&
      (!url.search || /^[A-Za-z0-9_=%+./-]{1,16384}$/u.test(url.search.slice(1)) && Boolean(url.searchParams.get('_state'))),
    'upload-origin', 'Upload continuation must remain at the exact target registry/repository/provider UUID; foreign, SAS and unexpected query targets are refused.');
    return { id, url: url.href, state: url.search ? 'volatile-state-required' : 'uuid-only' };
  }

  async #send(
    url: URL, method: 'GET' | 'POST' | 'PATCH' | 'PUT', headers: Headers, body: Buffer | undefined,
    limit: number, effect?: ApplicationRegistryPromotionEffectPrepared, outerSignal?: AbortSignal
  ): Promise<RegistryResponse> {
    await this.#guard();
    requireValue([`https://${this.#config.sourceLoginServer}`, `https://${this.#config.targetLoginServer}`, 'https://management.azure.com'].includes(url.origin) &&
      !url.username && !url.password && !url.hash, 'origin', 'The request would leave the exact approved origins.');
    this.#count();
    if (body) this.#charge(body.length);
    if (effect) {
      requireValue(url.origin === `https://${this.#config.targetLoginServer}` && method !== 'GET',
        'effect-target', 'Registry writes can target only the independently approved target registry.');
      requireValue(this.#usage.writeRequests < this.#config.transfer.maxWriteRequests, 'write-bound', 'The explicit registry effect count is exhausted.');
      this.#usage.writeRequests++;
      headers.set('x-ms-client-request-id', effect.clientCorrelationId);
    }
    headers.set('accept-encoding', 'identity');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout());
    const signal = AbortSignal.any([controller.signal, ...(outerSignal ? [outerSignal] : [])]);
    const chunks: Uint8Array[] = [];
    let total = 0;
    let status: number | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.#fetch(url, {
        method, headers, redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
        ...(body === undefined ? {} : { body: new Uint8Array(body) })
      });
      status = response.status;
      const requestId = providerId(response.headers.get('x-ms-request-id'), effect?.clientCorrelationId);
      if (effect) {
        const uploadId = providerId(response.headers.get('docker-upload-uuid'), effect.clientCorrelationId);
        let uploadState: 'uuid-only' | 'volatile-state-required' | 'unknown' | null = null;
        if (effect.kind === 'begin-blob' || effect.kind === 'upload-chunk') {
          uploadState = 'unknown';
          if (uploadId) {
            try { uploadState = this.#uploadLocation(response.headers.get('location'), uploadId).state; }
            catch (error) { if (!(error instanceof ApplicationRegistryCopyError)) throw error; }
          }
        }
        await this.authority.recordResponse(effect, { status: response.status, providerRequestId: requestId, uploadId, uploadState });
        requireValue(response.headers.get('docker-upload-uuid') === null || uploadId !== null,
          'upload-id', 'A malformed or echoed client correlation cannot stand in for an actual provider-issued upload UUID.', response.status);
      }
      requireValue(!response.redirected && (response.headers.get('content-encoding') === null ||
        response.headers.get('content-encoding') === 'identity'), 'encoding', 'Redirects and HTTP content transformation cannot stand in for exact OCI bytes.', response.status);
      const contentLength = response.headers.get('content-length');
      requireValue(contentLength === null || /^(?:0|[1-9]\d*)$/u.test(contentLength) && Number.isSafeInteger(Number(contentLength)) &&
        Number(contentLength) <= limit, 'response-bound', 'The registry response declares a size outside its exact bounded request.', response.status);
      reader = response.body?.getReader();
      if (reader) while (true) {
        const part = await reader.read();
        if (part.done) break;
        chunks.push(part.value);
        total += part.value.byteLength;
        this.#charge(part.value.byteLength);
        requireValue(total <= limit, 'response-bound', 'The actual registry response exceeded its bounded byte limit.', response.status);
      }
      requireValue(contentLength === null || total === Number(contentLength), 'partial-response', 'The registry returned only part of its declared response.', response.status);
      this.#timeout();
      return { status: response.status, headers: response.headers, bytes: Buffer.concat(chunks), requestId };
    } catch (error) {
      if (error instanceof ApplicationRegistryCopyError) throw error;
      throw new ApplicationRegistryCopyError(signal.aborted ? 'registry-copy-timeout' : 'registry-copy-unknown-response',
        'The bounded request did not produce a verified response. Original pre-effect IDs are retained; recover by exact output readback, never by repeating a request.', status);
    } finally {
      clearTimeout(timer);
      controller.abort();
      reader?.releaseLock();
      for (const chunk of chunks) chunk.fill(0);
      headers.delete('authorization');
    }
  }

  async #token(host: string, repository: string, actions: readonly string[]): Promise<Buffer> {
    requireValue(this.#aad, 'credential', 'A private ARM credential and independent registry readback are required before ACR exchange.');
    const exchange = async (pathname: string, fields: Record<string, string>, field: 'refresh_token' | 'access_token') => {
      const body = Buffer.from(new URLSearchParams(fields).toString());
      let response: RegistryResponse | undefined;
      try {
        response = await this.#send(new URL(`https://${host}${pathname}`), 'POST',
          new Headers({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }), body, tokenLimit);
        requireValue(response.status === 200, 'token-exchange', 'The exact scoped ACR token exchange was not accepted.', response.status);
        const result = object(response.bytes, 'token-exchange');
        const token = result[field];
        requireValue(typeof token === 'string', 'token-exchange', 'The registry omitted the actual scoped credential.');
        const identity = claims(token, this.authority.now(), this.#timeout());
        const binding = this.#config.binding;
        requireValue(identity.aud === host && identity.grant_type === field &&
          typeof identity.sub === 'string' && identity.sub.toLowerCase() === binding.principalId &&
          (identity.oid === undefined || identity.oid === binding.principalId) &&
          (field !== 'refresh_token' || identity.tenant === binding.tenantId) &&
          (identity.tenant === undefined || identity.tenant === binding.tenantId) &&
          (identity.tid === undefined || identity.tid === binding.tenantId) &&
          (identity.appid === undefined || identity.appid === binding.clientId) &&
          (identity.azp === undefined || identity.azp === binding.clientId),
        'token-binding', 'The registry token belongs to another service, tenant, principal, client or grant.');
        if (field === 'access_token') {
          requireValue(Array.isArray(identity.access) && identity.access.length === 1 && isRecord(identity.access[0]),
            'token-scope', 'Only one exact repository scope is admitted per registry credential.');
          const scope = identity.access[0];
          const scopedActions = scope.actions;
          requireValue(scope.type === 'repository' && scope.name === repository && Array.isArray(scopedActions) &&
            scopedActions.length === actions.length && new Set(scopedActions).size === actions.length &&
            actions.every((action) => scopedActions.includes(action)),
          'token-scope', 'Source credentials must be pull-only; only the exact target repository may receive pull/push scope.');
        }
        delete result[field];
        return Buffer.from(token);
      } finally { body.fill(0); response?.bytes.fill(0); }
    };
    let refresh: Buffer | undefined;
    try {
      refresh = await exchange('/oauth2/exchange', {
        grant_type: 'access_token', service: host, tenant: this.#config.binding.tenantId, access_token: this.#aad.toString('utf8')
      }, 'refresh_token');
      return await exchange('/oauth2/token', {
        grant_type: 'refresh_token', service: host, scope: `repository:${repository}:${actions.join(',')}`,
        refresh_token: refresh.toString('utf8')
      }, 'access_token');
    } finally { refresh?.fill(0); }
  }

  #registryHeaders(side: 'source' | 'target', accept = 'application/octet-stream'): Headers {
    const token = side === 'source' ? this.#sourceToken : this.#targetToken;
    requireValue(token, 'credential', 'A privately acquired exact repository token is required.');
    claims(token.toString('utf8'), this.authority.now(), this.#timeout());
    return new Headers({ accept, authorization: `Bearer ${token.toString('utf8')}` });
  }

  async #get(side: 'source' | 'target', kind: 'manifests' | 'blobs', digest: string, maximum: number): Promise<RegistryResponse | null> {
    const host = side === 'source' ? this.#config.sourceLoginServer : this.#config.targetLoginServer;
    const repository = side === 'source' ? this.#config.sourceRepository : this.#config.targetRepository;
    const response = await this.#send(new URL(`https://${host}/v2/${repository}/${kind}/${applicationImageDigest(digest)}`),
      'GET', this.#registryHeaders(side, kind === 'manifests' ? allManifestMediaTypes.join(', ') : 'application/octet-stream'),
      undefined, Math.max(maximum, 4096));
    try {
      requireValue(response.requestId, 'request-id', 'An actual provider-issued registry GET request ID is required, not a client correlation.', response.status);
      if (response.status === 404 && side === 'target') {
        const absent = object(response.bytes, 'absence');
        requireValue(Array.isArray(absent.errors) && absent.errors.length > 0 && absent.errors.length <= 8 &&
          absent.errors.every((entry) => isRecord(entry) &&
            [kind === 'manifests' ? 'MANIFEST_UNKNOWN' : 'BLOB_UNKNOWN', 'NAME_UNKNOWN'].includes(String(entry.code))),
        'absence', 'A malformed or ambiguous registry error cannot prove target absence.', response.status);
        response.bytes.fill(0);
        return null;
      }
      requireValue(response.status === 200, 'read', 'The exact immutable registry object could not be independently read.', response.status);
      requireValue(response.bytes.length <= maximum && response.headers.get('docker-content-digest') === digest && sha(response.bytes) === digest,
        'digest', 'The actual registry bytes, size or Docker-Content-Digest differ from the approved immutable object.', response.status);
      return response;
    } catch (error) { response.bytes.fill(0); throw error; }
  }

  #mediaType(headers: Headers): string {
    const contentType = headers.get('content-type');
    requireValue(contentType && /^[a-z0-9.+/-]+(?:;\s*charset=utf-8)?$/iu.test(contentType),
      'media-type', 'Registry byte readback requires an explicit supported untransformed content type.');
    return contentType.split(';')[0]!.toLowerCase();
  }

  #retain(graph: ImageGraph, kind: 'manifests' | 'blobs', entry: ImageEntry): void {
    requireValue(!graph[kind].has(entry.descriptor.digest), 'duplicate', 'The OCI graph unexpectedly repeats an object.');
    requireValue(this.#usage.imageBytes + entry.bytes.length <= this.#config.transfer.maxImageBytes,
      'image-bound', 'The complete in-memory OCI graph exceeds its reviewed unique-byte ceiling.');
    requireValue(graph[kind].size < (kind === 'manifests' ? this.#config.transfer.maxManifests : this.#config.transfer.maxBlobs),
      'object-bound', 'The concrete OCI object count exceeds its reviewed bound.');
    graph[kind].set(entry.descriptor.digest, entry);
    this.#usage.imageBytes += entry.bytes.length;
    this.#usage[kind]++;
  }

  #sameDescriptor(left: ApplicationRegistryOciDescriptor, right: ApplicationRegistryOciDescriptor): void {
    requireValue(left.digest === right.digest && left.size === right.size && left.mediaType === right.mediaType,
      'descriptor-conflict', 'A repeated OCI digest has conflicting size or media type declarations.');
  }

  async #sourceBlob(graph: ImageGraph, descriptor: ApplicationRegistryOciDescriptor): Promise<ImageEntry> {
    const prior = graph.blobs.get(descriptor.digest);
    if (prior) { this.#sameDescriptor(prior.descriptor, descriptor); return prior; }
    requireValue(graph.blobs.size < this.#config.transfer.maxBlobs &&
      this.#usage.imageBytes + descriptor.size <= this.#config.transfer.maxImageBytes,
    'object-bound', 'The next concrete source blob exceeds the reviewed object or in-memory byte bound.');
    const response = await this.#get('source', 'blobs', descriptor.digest, descriptor.size);
    requireValue(response, 'source-blob', 'The exact source blob is absent.');
    try {
      const mediaType = this.#mediaType(response.headers);
      requireValue(response.bytes.length === descriptor.size && (mediaType === 'application/octet-stream' || mediaType === descriptor.mediaType),
        'blob-size', 'Source blob readback does not match the descriptor size/media type.');
      const entry = { descriptor, bytes: response.bytes,
        observation: { digest: descriptor.digest, size: descriptor.size, mediaType: descriptor.mediaType, requestId: response.requestId! } };
      this.#retain(graph, 'blobs', entry);
      return entry;
    } catch (error) { response.bytes.fill(0); throw error; }
  }

  #configIdentity(entry: ImageEntry, manifest: Extract<ApplicationRegistryOciManifest, { kind: 'image' }>, expected?: ApplicationRegistryOciPlatform): {
    platform: ApplicationRegistryOciPlatform; diffIds: string[];
  } {
    const value = object(entry.bytes, 'image-config');
    const observed = platform({ os: value.os, architecture: value.architecture, ...(value.variant === undefined ? {} : { variant: value.variant }) });
    const source = this.authority.source;
    requireValue(isRecord(value.config) && isRecord(value.config.Labels) &&
      value['os.version'] === undefined && value['os.features'] === undefined &&
      value.config.Labels['org.opencontainers.image.source'] === `https://github.com/${source.repository}` &&
      value.config.Labels['org.opencontainers.image.revision'] === source.provenance.sourceSha &&
      isRecord(value.rootfs) && value.rootfs.type === 'layers' && Array.isArray(value.rootfs.diff_ids) &&
      value.rootfs.diff_ids.length === manifest.layers.length &&
      value.rootfs.diff_ids.every((digest) => typeof digest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(digest)),
    'config-identity', 'The actual OCI configuration must retain the original source/revision, concrete platform and layer identity inventory.');
    requireValue(!expected || expected.os === observed.os && expected.architecture === observed.architecture &&
      (expected.variant ?? null) === (observed.variant ?? null),
    'config-platform', 'The actual OCI configuration platform differs from its index descriptor.');
    return { platform: observed, diffIds: value.rootfs.diff_ids.map((digest) => applicationImageDigest(digest)) };
  }

  async #layerIdentity(entry: ImageEntry, expectedDiffId: string): Promise<void> {
    await verifyApplicationRegistryOciLayer({
      bytes: entry.bytes, descriptor: entry.descriptor, diffId: expectedDiffId,
      maxExpandedBytes: this.#config.transfer.maxExpandedLayerBytes, timeoutMs: this.#timeout()
    });
  }

  async #sourceManifest(
    graph: ImageGraph, digest: string, expected?: ApplicationRegistryOciDescriptor, depth = 0, ancestors: readonly string[] = []
  ): Promise<void> {
    requireValue(depth <= 4 && !ancestors.includes(digest), 'index-depth', 'The OCI index graph is cyclic or exceeds its bounded depth.');
    requireValue(!graph.manifests.has(digest), 'index-alias', 'A manifest cannot be adopted twice through ambiguous OCI platform paths.');
    const remaining = this.#config.transfer.maxImageBytes - this.#usage.imageBytes;
    requireValue(graph.manifests.size < this.#config.transfer.maxManifests && remaining > 0 &&
      (expected === undefined || expected.size <= remaining),
    'object-bound', 'The next concrete manifest exceeds the reviewed object or in-memory byte bound.');
    const response = await this.#get('source', 'manifests', digest, expected?.size ?? Math.min(remaining, this.#config.transfer.maxManifestBytes));
    requireValue(response, 'source-manifest', 'The exact source image manifest is absent.');
    let retained = false;
    try {
      const parsed = inspectApplicationRegistryOciManifest(response.bytes, digest, this.#config.transfer);
      const actual: ApplicationRegistryOciDescriptor = { digest, size: response.bytes.length, mediaType: parsed.mediaType };
      requireValue(this.#mediaType(response.headers) === parsed.mediaType, 'manifest-type', 'The manifest response media type does not match its actual immutable bytes.');
      if (expected) this.#sameDescriptor(actual, expected);
      this.#retain(graph, 'manifests', {
        descriptor: actual, bytes: response.bytes, observation: { ...actual, requestId: response.requestId! }
      });
      retained = true;
      if (parsed.kind === 'index') {
        requireValue(expected?.platform === undefined, 'index-platform', 'A nested image index cannot hide an unverified inherited platform.');
        for (const child of parsed.manifests) await this.#sourceManifest(graph, child.digest, child, depth + 1, [...ancestors, digest]);
      } else {
        const config = await this.#sourceBlob(graph, parsed.config);
        const identity = this.#configIdentity(config, parsed, expected?.platform);
        const observed = identity.platform;
        const key = `${observed.os}/${observed.architecture}`;
        requireValue(!graph.platforms.has(key), 'ambiguous-platform', 'An OCI index must have one unambiguous image per supported platform.');
        graph.platforms.add(key);
        if (key === this.authority.source.provenance.platform) {
          requireValue(config.descriptor.digest === this.authority.source.provenance.configDigest,
            'source-config-digest', 'The selected platform configuration differs from the original registered build provenance.');
          graph.selectedConfig = config;
        }
        for (const [index, layer] of parsed.layers.entries()) {
          const bytes = await this.#sourceBlob(graph, layer);
          await this.#layerIdentity(bytes, identity.diffIds[index]!);
        }
      }
      graph.publicationOrder.push(digest);
    } finally { if (!retained) response.bytes.fill(0); }
  }

  async #targetEntry(kind: 'manifests' | 'blobs', expected: ImageEntry): Promise<ApplicationRegistryByteObservation | null> {
    const response = await this.#get('target', kind, expected.descriptor.digest, expected.descriptor.size);
    if (!response) return null;
    try {
      const mediaType = this.#mediaType(response.headers);
      requireValue(response.bytes.length === expected.bytes.length && response.bytes.equals(expected.bytes) &&
        (mediaType === expected.descriptor.mediaType || kind === 'blobs' && mediaType === 'application/octet-stream'),
      'target-conflict', 'The exact target object contains conflicting bytes, size or media type; it will not be overwritten.');
      return { ...expected.descriptor, requestId: response.requestId! };
    } finally { response.bytes.fill(0); }
  }

  async #effect(
    effect: ApplicationRegistryPromotionEffect, url: URL, method: 'POST' | 'PATCH' | 'PUT', body: Buffer, contentType: string
  ): Promise<RegistryResponse> {
    // Fresh actor/account and independent registry reads precede every registry effect.
    await this.#registries();
    requireValue(this.#usage.transferredBytes + body.length <= this.#config.transfer.maxTransferBytes,
      'transfer-bound', 'The next registry effect would exceed its reviewed transfer byte ceiling.');
    const prepared = await this.authority.prepareEffect(effect);
    const headers = this.#registryHeaders('target', 'application/json');
    headers.set('content-type', contentType);
    headers.set('content-length', String(body.length));
    if (effect.kind === 'upload-chunk') headers.set('content-range', `${effect.offset}-${effect.offset + body.length - 1}`);
    if (effect.kind === 'put-manifest') headers.set('if-none-match', '*');
    return this.#send(url, method, headers, body, metadataLimit, prepared);
  }

  #accepted(response: RegistryResponse, expected: number): void {
    requireValue(response.status === expected && response.requestId, 'write-response',
      'The registry effect did not return its required actual provider-issued response. Preserve its pre-effect record and recover by exact output readback.', response.status);
  }

  async #upload(entry: ImageEntry): Promise<void> {
    if (await this.#targetEntry('blobs', entry)) return;
    const digest = entry.descriptor.digest;
    const size = entry.bytes.length;
    const started = await this.#effect(
      { kind: 'begin-blob', digest, size, offset: 0, uploadId: null, bodyDigest: emptyDigest },
      new URL(`https://${this.#config.targetLoginServer}/v2/${this.#config.targetRepository}/blobs/uploads/`),
      'POST', Buffer.alloc(0), 'application/octet-stream'
    );
    let upload: VolatileUpload;
    try {
      this.#accepted(started, 202);
      const id = providerId(started.headers.get('docker-upload-uuid'));
      requireValue(id, 'upload-id', 'The registry did not return its actual scoped upload UUID.');
      upload = this.#uploadLocation(started.headers.get('location'), id);
      requireValue(started.headers.get('range') === null || started.headers.get('range') === '0-0',
        'upload-range', 'The new provider upload unexpectedly contains bytes; no existing upload is adopted.');
    } finally { started.bytes.fill(0); }
    for (let offset = 0; offset < size;) {
      const chunk = entry.bytes.subarray(offset, Math.min(offset + this.#config.transfer.chunkBytes, size));
      const response = await this.#effect(
        { kind: 'upload-chunk', digest, size: chunk.length, offset, uploadId: upload.id, bodyDigest: sha(chunk) },
        new URL(upload.url), 'PATCH', chunk, 'application/octet-stream'
      );
      try {
        this.#accepted(response, 202);
        requireValue(response.headers.get('docker-upload-uuid')?.toLowerCase() === upload.id &&
          response.headers.get('range') === `0-${offset + chunk.length - 1}`,
        'upload-range', 'The provider did not confirm the exact upload UUID and byte range; no partial chunk is blindly repeated.');
        upload = this.#uploadLocation(response.headers.get('location'), upload.id);
      } finally { response.bytes.fill(0); }
      offset += chunk.length;
    }
    const destination = new URL(upload.url);
    destination.searchParams.set('digest', digest);
    const completed = await this.#effect(
      { kind: 'complete-blob', digest, size, offset: size, uploadId: upload.id, bodyDigest: emptyDigest },
      destination, 'PUT', Buffer.alloc(0), 'application/octet-stream'
    );
    try {
      this.#accepted(completed, 201);
      requireValue(completed.headers.get('docker-content-digest') === digest &&
        (completed.headers.get('docker-upload-uuid') === null || completed.headers.get('docker-upload-uuid')?.toLowerCase() === upload.id),
      'upload-completion', 'The provider did not confirm the exact completed blob digest/upload identity.');
      const location = completed.headers.get('location');
      if (location !== null) {
        const expected = `https://${this.#config.targetLoginServer}/v2/${this.#config.targetRepository}/blobs/${digest}`;
        requireValue(location === expected || location === new URL(expected).pathname,
          'blob-location', 'The completed blob location names a different or credential-bearing target.');
      }
    } finally { completed.bytes.fill(0); }
    requireValue(await this.#targetEntry('blobs', entry), 'blob-readback', 'The completed blob was not independently re-read from the exact target.');
  }

  async #publish(entry: ImageEntry): Promise<void> {
    if (await this.#targetEntry('manifests', entry)) return;
    const response = await this.#effect({
      kind: 'put-manifest', digest: entry.descriptor.digest, size: entry.bytes.length,
      offset: 0, uploadId: null, bodyDigest: sha(entry.bytes)
    }, new URL(`https://${this.#config.targetLoginServer}/v2/${this.#config.targetRepository}/manifests/${entry.descriptor.digest}`),
    'PUT', entry.bytes, entry.descriptor.mediaType);
    try {
      this.#accepted(response, 201);
      requireValue(response.headers.get('docker-content-digest') === entry.descriptor.digest,
        'manifest-publish', 'The target did not confirm the unchanged immutable manifest digest.');
    } finally { response.bytes.fill(0); }
  }

  async #readback(graph: ImageGraph): Promise<ApplicationRegistryPromotionReadback> {
    const targetManifests: ApplicationRegistryByteObservation[] = [];
    const targetBlobs: ApplicationRegistryByteObservation[] = [];
    for (const entry of graph.manifests.values()) {
      const observed = await this.#targetEntry('manifests', entry);
      requireValue(observed, 'unresolved',
        'The exact target image is incomplete or absent. Original effects/upload UUIDs remain retained; recovery cannot repeat uploads or reconstruct lost opaque upload state.');
      targetManifests.push(observed);
    }
    for (const entry of graph.blobs.values()) {
      const observed = await this.#targetEntry('blobs', entry);
      requireValue(observed, 'unresolved',
        'The exact target image is missing a concrete config/layer. Preserve original effects; a UUID is not a retained opaque upload credential.');
      targetBlobs.push(observed);
    }
    await this.#registries();
    const selected = graph.selectedConfig!;
    const confirmation = await this.#get('source', 'blobs', selected.descriptor.digest, selected.descriptor.size);
    requireValue(confirmation, 'source-readback', 'The actual original source configuration is no longer readable.');
    try {
      const mediaType = this.#mediaType(confirmation.headers);
      requireValue(confirmation.bytes.equals(selected.bytes) && (mediaType === 'application/octet-stream' || mediaType === selected.descriptor.mediaType),
        'source-readback', 'The actual source configuration changed during promotion.');
      selected.observation.requestId = confirmation.requestId!;
    } finally { confirmation.bytes.fill(0); }
    await this.#guard();
    const source = this.authority.source;
    const sourceManifests = [...graph.manifests.values()].map((entry) => ({ ...entry.observation }));
    const sourceBlobs = [...graph.blobs.values()].map((entry) => ({ ...entry.observation }));
    const identity = (entries: readonly ApplicationRegistryByteObservation[]) => entries.map(({ digest, size, mediaType }) => ({ digest, size, mediaType }));
    const result: ApplicationRegistryPromotionReadback = {
      schemaVersion: 1, imageDigest: this.#config.imageDigest, configDigest: source.provenance.configDigest,
      sourceSha: source.provenance.sourceSha, sourceRepository: source.repository,
      platform: source.provenance.platform === 'linux/amd64' ? 'linux/amd64' : 'linux/arm64',
      graphDigest: canonicalSha256({ manifests: identity(sourceManifests), blobs: identity(sourceBlobs) }),
      sourceRegistry: { ...this.#sourceRegistry! }, targetRegistry: { ...this.#targetRegistry! },
      sourceManifests, sourceBlobs, targetManifests, targetBlobs
    };
    issuedReadbacks.set(result, { authority: this.authority, digest: canonicalSha256(result) });
    return result;
  }

  async execute(): Promise<ApplicationRegistryPromotionReadback> {
    await this.#guard();
    requireValue(!this.#executed, 'one-shot', 'A registry transfer instance cannot be repeated.');
    this.#executed = true;
    const prior = await this.authority.checkpoint();
    const allowWrites = this.#config.mode === 'promote' && prior === null;
    await this.#registries();
    this.#sourceToken = await this.#token(this.#config.sourceLoginServer, this.#config.sourceRepository, ['pull']);
    this.#targetToken = await this.#token(this.#config.targetLoginServer, this.#config.targetRepository,
      allowWrites ? ['pull', 'push'] : ['pull']);
    this.#aad?.fill(0); this.#aad = undefined;
    const graph: ImageGraph = {
      manifests: new Map(), blobs: new Map(), publicationOrder: [], selectedConfig: null, platforms: new Set()
    };
    this.#graph = graph;
    await this.#sourceManifest(graph, this.#config.imageDigest);
    requireValue(graph.selectedConfig, 'source-platform', 'The immutable image graph does not contain the exact original build platform/configuration.');
    const root = graph.manifests.get(this.#config.imageDigest)!;
    if (await this.#targetEntry('manifests', root)) return this.#readback(graph);
    if (!allowWrites) return this.#readback(graph);
    const missingBlobs: ImageEntry[] = [];
    const missingManifests: ImageEntry[] = [];
    for (const entry of graph.blobs.values()) if (!await this.#targetEntry('blobs', entry)) missingBlobs.push(entry);
    for (const digest of graph.publicationOrder) {
      const entry = graph.manifests.get(digest)!;
      if (!await this.#targetEntry('manifests', entry)) missingManifests.push(entry);
    }
    const writes = missingBlobs.reduce((sum, entry) => sum + 2 + Math.ceil(entry.bytes.length / this.#config.transfer.chunkBytes), missingManifests.length);
    requireValue(writes <= this.#config.transfer.maxWriteRequests, 'write-bound',
      'The concrete missing blob/chunk/manifest inventory exceeds the reviewed effect count; no registry writes were started.');
    for (const entry of missingBlobs) await this.#upload(entry);
    for (const entry of missingManifests) await this.#publish(entry);
    return this.#readback(graph);
  }

  dispose(): void {
    this.#disposed = true;
    this.#aad?.fill(0); this.#sourceToken?.fill(0); this.#targetToken?.fill(0);
    this.#aad = undefined; this.#sourceToken = undefined; this.#targetToken = undefined;
    if (this.#graph) for (const entry of [...this.#graph.manifests.values(), ...this.#graph.blobs.values()]) entry.bytes.fill(0);
    this.#graph = undefined;
  }

  static assertIssuedReadback(authority: ApplicationRegistryPromotionAdmission, readback: ApplicationRegistryPromotionReadback): void {
    const issued = issuedReadbacks.get(readback);
    requireValue(issued?.authority === authority && issued.digest === canonicalSha256(readback),
      'readback-authority', 'Only this authority\'s independently verified actual target bytes can produce a promotion receipt.');
  }

  static validateReadback(value: unknown): ApplicationRegistryPromotionReadback {
    return validateApplicationRegistryPromotionReadback(value);
  }
}
