import { createHash } from 'node:crypto';
import { canonicalJson, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { DistributionError } from '../../domain/distribution/errors.js';
import {
  nativeTrustRootMaximumBytes, nativeTrustRootPathParts, parseNativeTrustRoot,
  type NativeArtifactProvenance, type NativePayloadFile
} from '../../domain/distribution/native-trust.js';
import { parseNativeResources, parseRuntimeConstraints } from '../../domain/distribution/release-manifest.js';
import { object, stableVersion } from '../../domain/distribution/validation.js';
import { validateTemplateCatalog } from '../../domain/standards/resource-catalog-schema.js';
import { validateStandardsProfileCatalog } from '../../domain/standards/profile-schema.js';
import { validateNativeBuildInfo, type NativeBuildInfo } from '../packaged-assets/build-info.js';
import { nativePathParts } from './native-files.js';

export async function verifyNativeMetadata(
  provenance: NativeArtifactProvenance,
  readJson: (relativePath: string, expected: NativePayloadFile) => Promise<unknown>
): Promise<NativeBuildInfo> {
  const signed = new Map(provenance.files.map((file) => [file.path, file]));
  const requiredFile = (name: string): NativePayloadFile => {
    const file = signed.get(name);
    if (!file) throw new DistributionError(`Native bundle omits required signed metadata or entrypoint: ${name}.`, 'artifact_mismatch');
    return file;
  };
  for (const name of ['LICENSE', 'package.json', ...Object.values(provenance.entrypoints)]) requiredFile(name);
  if (requiredFile('build-info.json').sha256 !== provenance.buildInfoSha256 ||
      requiredFile('liftoff-build-manifest.json').sha256 !== provenance.buildManifestSha256) {
    throw new DistributionError('Native build metadata does not match signed final provenance.', 'artifact_mismatch');
  }
  const trustPath = nativeTrustRootPathParts.join('/');
  if (requiredFile(trustPath).size > nativeTrustRootMaximumBytes) {
    throw new DistributionError('Native release trust root exceeds the installed reader bound.', 'artifact_mismatch');
  }
  const metadataFiles = [
    'build-info.json', 'liftoff-build-manifest.json', 'assets/templates/catalog.json', 'assets/profiles/catalog.json', trustPath
  ].map(requiredFile);
  const [rawInfo, rawBuild, rawCatalog, rawProfiles, rawTrust] = await Promise.all(metadataFiles.map((file) => readJson(file.path, file)));
  const trust = parseNativeTrustRoot(rawTrust);
  if (trust.state !== 'configured') {
    throw new DistributionError('A native release payload requires configured public release trust; development trust cannot acquire an installation.', 'trust_unconfigured');
  }
  if (provenance.channelDefinitions?.some((definition) => !trust.channels.some((channel) =>
    channel.owner === definition.owner && channel.packageId === definition.packageId && channel.sourceId === definition.sourceId))) {
    throw new DistributionError('Native release trust drops or substitutes its signed owner-channel identity.', 'artifact_mismatch');
  }
  const buildInfo = validateNativeBuildInfo(rawInfo);
  stableVersion(buildInfo.version);
  if (buildInfo.version !== provenance.version || buildInfo.commit !== provenance.sourceCommit ||
      buildInfo.target.platform !== provenance.target || buildInfo.runtime.version !== provenance.runtime.nodeVersion) {
    throw new DistributionError('Native build identity differs from the authenticated artifact.', 'artifact_mismatch');
  }
  const build = object(rawBuild, [
    'schemaVersion', 'product', 'version', 'target', 'sourceCommit', 'builtAt', 'runtime', 'resources'
  ], 'Native build manifest');
  if (build.schemaVersion !== 1 || build.product !== 'liftoff' || build.version !== provenance.version ||
      build.target !== provenance.target || build.sourceCommit !== provenance.sourceCommit ||
      canonicalJson(parseRuntimeConstraints(build.runtime, provenance.target)) !== canonicalJson(provenance.runtime) ||
      canonicalJson(parseNativeResources(build.resources)) !== canonicalJson(provenance.resources) ||
      build.builtAt !== buildInfo.buildDate) {
    throw new DistributionError('Native build manifest disagrees with its admitted release.', 'artifact_mismatch');
  }
  const catalog = validateTemplateCatalog(rawCatalog, true);
  const profiles = validateStandardsProfileCatalog(rawProfiles, true);
  if (buildInfo.resourcesDigest !== catalog.digest || buildInfo.profilesDigest !== profiles.digest) {
    throw new DistributionError('Native build-info does not bind the exact full template and profile catalog identities.', 'artifact_mismatch');
  }
  const entries = Object.entries(catalog.resources).sort(([left], [right]) => left.localeCompare(right));
  const resourceHash = createHash('sha256');
  for (const [id, resource] of entries) {
    if (!id || id.length > 256 || !isRecord(resource) || typeof resource.path !== 'string' ||
        typeof resource.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(resource.digest) ||
        !Number.isSafeInteger(resource.size)) {
      throw new DistributionError('Native resource inventory contains an unregistered or malformed resource identity.', 'artifact_mismatch');
    }
    const file = signed.get(nativePathParts(resource.path).join('/'));
    if (!file || file.size !== resource.size || `sha256:${file.sha256}` !== resource.digest) {
      throw new DistributionError('A registered native resource differs from its signed final payload file.', 'artifact_mismatch');
    }
    resourceHash.update(`${id}:${resource.path}:${resource.digest}:${resource.size};`);
  }
  if (entries.length !== provenance.resources.count || resourceHash.digest('hex') !== provenance.resources.inventoryHash) {
    throw new DistributionError('Native packaged-resource count or inventory digest does not match its signed build identity.', 'artifact_mismatch');
  }
  return buildInfo;
}
