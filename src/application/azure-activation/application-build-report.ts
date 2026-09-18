import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { applicationImageDigest, applicationObject, applicationRegistryHost } from '../../adapters/azure/application-provisioning.js';
import { GitHubActivationError } from '../../adapters/github/activation-rest.js';
import type { BoundWorkflowJob } from '../../adapters/github/production-checks.js';
import type { ApplicationArtifactInputs } from './application-artifact-inputs.js';
import { AzureActivationAdmissionError } from './authority.js';
import { readPrivateReportArchive } from './private-runner-workflow.js';

export const applicationBuildReportFilename = 'liftoff-application-build.json';
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function fail(): never {
  throw new AzureActivationAdmissionError('application-build-provenance',
    'The exact build artifact does not contain a bounded source/run/job-bound OCI manifest and configuration matching the approved registry, repository and platform.');
}

/** No disk extraction, extra files, links, ZIP64, comments, encryption or unbounded expansion. */
export function readApplicationBuildArchive(archive: Uint8Array): unknown {
  try { return readPrivateReportArchive(archive, applicationBuildReportFilename); }
  catch (error) {
    if (!(error instanceof GitHubActivationError) || error.code !== 'private-report-archive') throw error;
    return fail();
  }
}

function binary(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > 64 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) fail();
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.toString('base64') !== value || !isUtf8(bytes)) {
    bytes.fill(0); fail();
  }
  return bytes;
}

export interface VerifiedApplicationBuild {
  digest: string;
  configDigest: string;
  imageRef: string;
  registryResourceId: string;
  sourceSha: string;
  runId: number;
  runAttempt: number;
  workflowId: number;
  actorId: number;
  jobId: number;
  platform: string;
}

/** Validates retained metadata only. Live proof still requires the actual archive and registry readback. */
export function validateRecordedApplicationBuild(value: unknown, config: ApplicationArtifactInputs, loginServer: string): VerifiedApplicationBuild {
  const record = applicationObject(value, 'Recorded application build', [
    'digest', 'configDigest', 'imageRef', 'registryResourceId', 'sourceSha', 'runId',
    'runAttempt', 'workflowId', 'actorId', 'jobId', 'platform'
  ]);
  const imageDigest = applicationImageDigest(record.digest), configDigest = applicationImageDigest(record.configDigest);
  applicationRegistryHost(loginServer);
  if (record.imageRef !== `${loginServer}/${config.imageName}@${imageDigest}` ||
    record.registryResourceId !== config.registryResourceId || record.sourceSha !== config.workflow.sourceSha ||
    record.workflowId !== config.workflow.workflowId || record.actorId !== config.workflow.actorId ||
    record.runAttempt !== config.workflow.runAttempt || record.platform !== config.platform ||
    config.expectedDigest !== undefined && imageDigest !== config.expectedDigest ||
    !Number.isSafeInteger(record.runId) || Number(record.runId) <= 0 ||
    !Number.isSafeInteger(record.jobId) || Number(record.jobId) <= 0) fail();
  return {
    digest: imageDigest, configDigest, imageRef: record.imageRef,
    registryResourceId: config.registryResourceId, sourceSha: config.workflow.sourceSha,
    runId: Number(record.runId), runAttempt: config.workflow.runAttempt, workflowId: config.workflow.workflowId,
    actorId: config.workflow.actorId, jobId: Number(record.jobId), platform: config.platform
  };
}

export function validateApplicationBuildReport(
  value: unknown,
  config: ApplicationArtifactInputs,
  observation: { runId: number; jobs: readonly BoundWorkflowJob[]; loginServer: string }
): VerifiedApplicationBuild {
  const report = applicationObject(value, 'Application build report', ['schemaVersion', 'kind', 'source', 'producer', 'image', 'oci']);
  if (report.schemaVersion !== 1 || report.kind !== 'liftoff-application-build') fail();
  const source = applicationObject(report.source, 'Build source', ['repository', 'repositoryId', 'commitSha']);
  const producer = applicationObject(report.producer, 'Build producer', [
    'workflowId', 'workflowPath', 'workflowDigest', 'runId', 'runAttempt', 'actorId', 'jobId'
  ]);
  const image = applicationObject(report.image, 'Build image', ['registryResourceId', 'loginServer', 'repository', 'digest']);
  const oci = applicationObject(report.oci, 'Build OCI chain', ['manifestBase64', 'configBase64']);
  const workflow = config.workflow;
  if (source.repository !== workflow.repository || source.repositoryId !== workflow.repositoryId ||
    source.commitSha !== workflow.sourceSha || producer.workflowId !== workflow.workflowId ||
    producer.workflowPath !== workflow.workflowPath || producer.workflowDigest !== workflow.workflowDigest ||
    producer.runId !== observation.runId || producer.runAttempt !== workflow.runAttempt ||
    producer.actorId !== workflow.actorId || typeof producer.jobId !== 'number' ||
    !observation.jobs.some((job) => job.id === producer.jobId && job.conclusion === 'success') ||
    observation.jobs.some((job) => job.conclusion !== 'success') ||
    typeof image.registryResourceId !== 'string' || image.registryResourceId.toLowerCase() !== config.registryResourceId.toLowerCase() ||
    image.repository !== config.imageName || image.loginServer !== observation.loginServer) fail();
  const imageDigest = applicationImageDigest(image.digest);
  if (config.expectedDigest !== undefined && imageDigest !== config.expectedDigest) fail();
  applicationRegistryHost(image.loginServer);
  const manifestBytes = binary(oci.manifestBase64);
  let configBytes: Buffer | undefined;
  try {
    configBytes = binary(oci.configBase64);
    if (digest(manifestBytes) !== imageDigest) fail();
    const manifest = applicationObject(JSON.parse(manifestBytes.toString('utf8')), 'OCI image manifest');
    if (manifest.schemaVersion !== 2 || !['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].includes(String(manifest.mediaType)) ||
      !Array.isArray(manifest.layers) || manifest.layers.length > 128) fail();
    const descriptor = applicationObject(manifest.config, 'OCI configuration descriptor');
    const configDigest = digest(configBytes);
    if (descriptor.digest !== configDigest || descriptor.size !== configBytes.length ||
      !['application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json'].includes(String(descriptor.mediaType))) fail();
    for (const entry of manifest.layers) {
      const layer = applicationObject(entry, 'OCI layer descriptor');
      applicationImageDigest(layer.digest);
      if (!Number.isSafeInteger(layer.size) || Number(layer.size) < 0 || Number(layer.size) > 2 ** 31 ||
        !['application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip', 'application/vnd.oci.image.layer.v1.tar+zstd',
          'application/vnd.docker.image.rootfs.diff.tar.gzip'].includes(String(layer.mediaType))) fail();
    }
    const imageConfig = applicationObject(JSON.parse(configBytes.toString('utf8')), 'OCI image configuration');
    const labels = applicationObject(applicationObject(imageConfig.config, 'OCI runtime configuration').Labels, 'OCI source labels');
    const [os, architecture] = config.platform.split('/');
    if (imageConfig.os !== os || imageConfig.architecture !== architecture ||
      labels['org.opencontainers.image.source'] !== `https://github.com/${workflow.repository}` ||
      labels['org.opencontainers.image.revision'] !== workflow.sourceSha) fail();
    return {
      digest: imageDigest, configDigest, imageRef: `${observation.loginServer}/${config.imageName}@${imageDigest}`,
      registryResourceId: config.registryResourceId, sourceSha: workflow.sourceSha,
      runId: observation.runId, runAttempt: workflow.runAttempt, workflowId: workflow.workflowId,
      actorId: workflow.actorId, jobId: producer.jobId, platform: config.platform
    };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return fail();
  } finally { manifestBytes.fill(0); configBytes?.fill(0); }
}
