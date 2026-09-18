import { AzureActivationAdmissionError } from '../../application/azure-activation/authority.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import {
  applicationImageDigest, applicationRegistryHost, applicationUuid, containerRegistryResourceId,
  type ApplicationRegistryObservation
} from './application-provisioning.js';

export const manifestMediaTypes = Object.freeze([
  'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'
] as const);
export const indexMediaTypes = Object.freeze([
  'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'
] as const);
export const configMediaTypes = Object.freeze(['application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json'] as const);
export const layerMediaTypes = Object.freeze([
  'application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip',
  'application/vnd.oci.image.layer.v1.tar+zstd', 'application/vnd.docker.image.rootfs.diff.tar.gzip'
] as const);
export const allManifestMediaTypes: readonly string[] = Object.freeze([...manifestMediaTypes, ...indexMediaTypes]);

export class ApplicationRegistryCopyError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message);
    this.name = 'ApplicationRegistryCopyError';
  }
}

function requireValue(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new ApplicationRegistryCopyError(`registry-copy-${code}`, message);
}

function integer(value: unknown, minimum: number, maximum: number): number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    'size', 'The actual registry size or count is outside the explicitly supported bound.');
  return value;
}

export function applicationRegistryPromotionRegistryId(value: unknown, subscriptionId: string): string {
  const match = typeof value === 'string'
    ? /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ContainerRegistry\/registries\/([^/]+)$/u.exec(value) : null;
  if (!match || match[1] !== subscriptionId) {
    throw new AzureActivationAdmissionError('registry-promotion-registry', 'Each registry must name an exact canonical ACR resource in the approved subscription.');
  }
  const id = containerRegistryResourceId(subscriptionId, match[2]!, match[3]!);
  if (id !== value) {
    throw new AzureActivationAdmissionError('registry-promotion-registry', 'An aliased registry resource ID cannot select a promotion destination.');
  }
  return id;
}

export interface ApplicationRegistryByteObservation {
  digest: string;
  size: number;
  mediaType: string;
  requestId: string;
}

export interface ApplicationRegistryPromotionReadback {
  schemaVersion: 1;
  imageDigest: string;
  configDigest: string;
  sourceSha: string;
  sourceRepository: string;
  platform: 'linux/amd64' | 'linux/arm64';
  graphDigest: string;
  sourceRegistry: ApplicationRegistryObservation;
  targetRegistry: ApplicationRegistryObservation;
  sourceManifests: readonly ApplicationRegistryByteObservation[];
  sourceBlobs: readonly ApplicationRegistryByteObservation[];
  targetManifests: readonly ApplicationRegistryByteObservation[];
  targetBlobs: readonly ApplicationRegistryByteObservation[];
}

/** Retained metadata validation only: this never issues live readback or access authority. */
export function validateApplicationRegistryPromotionReadback(value: unknown): ApplicationRegistryPromotionReadback {
  requireValue(isRecord(value) && value.schemaVersion === 1 &&
    (value.platform === 'linux/amd64' || value.platform === 'linux/arm64') &&
    typeof value.sourceSha === 'string' && /^[a-f0-9]{40,64}$/u.test(value.sourceSha) &&
    typeof value.sourceRepository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.sourceRepository) &&
    typeof value.graphDigest === 'string' && /^[a-f0-9]{64}$/u.test(value.graphDigest),
  'stored-readback', 'Retained registry readback metadata is malformed.');
  const observations = (raw: unknown, maximum: number, types: readonly string[]) => {
    requireValue(Array.isArray(raw) && raw.length > 0 && raw.length <= maximum, 'stored-readback', 'Retained OCI inventory is outside its supported bound.');
    return raw.map((entry): ApplicationRegistryByteObservation => {
      requireValue(isRecord(entry) && typeof entry.mediaType === 'string' && types.includes(entry.mediaType),
        'stored-readback', 'Retained OCI object metadata is malformed.');
      return {
        digest: applicationImageDigest(entry.digest), size: integer(entry.size, 0, 256 * 1024 * 1024), mediaType: entry.mediaType,
        requestId: applicationUuid(entry.requestId, 'Actual retained registry GET request')
      };
    });
  };
  const registry = (raw: unknown): ApplicationRegistryObservation => {
    requireValue(isRecord(raw) && typeof raw.id === 'string' && typeof raw.name === 'string' &&
      typeof raw.location === 'string' && typeof raw.loginServer === 'string' &&
      raw.provisioningState === 'Succeeded' && raw.adminUserEnabled === false,
    'stored-readback', 'Retained registry resource identity is malformed.');
    const subscription = applicationUuid(raw.id.split('/')[2], 'Retained registry subscription');
    applicationRegistryPromotionRegistryId(raw.id, subscription);
    requireValue(raw.id.split('/').at(-1) === raw.name && /^[a-z0-9-]+$/u.test(raw.location),
      'stored-readback', 'Retained registry name/location does not match its exact resource identity.');
    return {
      id: raw.id, name: raw.name, location: raw.location, loginServer: applicationRegistryHost(raw.loginServer),
      provisioningState: 'Succeeded', adminUserEnabled: false, requestId: applicationUuid(raw.requestId, 'Actual retained ARM request')
    };
  };
  const result: ApplicationRegistryPromotionReadback = {
    schemaVersion: 1, imageDigest: applicationImageDigest(value.imageDigest), configDigest: applicationImageDigest(value.configDigest),
    sourceSha: value.sourceSha, sourceRepository: value.sourceRepository, platform: value.platform, graphDigest: value.graphDigest,
    sourceRegistry: registry(value.sourceRegistry), targetRegistry: registry(value.targetRegistry),
    sourceManifests: observations(value.sourceManifests, 32, allManifestMediaTypes),
    sourceBlobs: observations(value.sourceBlobs, 256, [...configMediaTypes, ...layerMediaTypes]),
    targetManifests: observations(value.targetManifests, 32, allManifestMediaTypes),
    targetBlobs: observations(value.targetBlobs, 256, [...configMediaTypes, ...layerMediaTypes])
  };
  const identity = (entries: readonly ApplicationRegistryByteObservation[]) => entries.map(({ digest, size, mediaType }) => ({ digest, size, mediaType }));
  requireValue(result.sourceRegistry.id.toLowerCase() !== result.targetRegistry.id.toLowerCase() &&
    result.sourceRegistry.loginServer !== result.targetRegistry.loginServer &&
    new Set(result.sourceManifests.map((entry) => entry.digest)).size === result.sourceManifests.length &&
    new Set(result.sourceBlobs.map((entry) => entry.digest)).size === result.sourceBlobs.length &&
    result.sourceManifests.some((entry) => entry.digest === result.imageDigest) &&
    result.sourceBlobs.some((entry) => entry.digest === result.configDigest && (configMediaTypes as readonly string[]).includes(entry.mediaType)) &&
    canonicalSha256(identity(result.sourceManifests)) === canonicalSha256(identity(result.targetManifests)) &&
    canonicalSha256(identity(result.sourceBlobs)) === canonicalSha256(identity(result.targetBlobs)) &&
    result.graphDigest === canonicalSha256({ manifests: identity(result.sourceManifests), blobs: identity(result.sourceBlobs) }),
  'stored-readback', 'Retained readback does not bind a unique identical source/target OCI graph.');
  requireValue(canonicalSha256(result) === canonicalSha256(value), 'stored-readback', 'Retained readback contains unsupported or changed fields.');
  return result;
}
