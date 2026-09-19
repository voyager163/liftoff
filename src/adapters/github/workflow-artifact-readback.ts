import { createHash } from 'node:crypto';
import {
  expectStatus, GitHubActivationError, object, positiveId, text, type GitHubActivationClient
} from './activation-rest.js';
import type { WorkflowRunBinding } from './workflow-run-readback.js';

export interface WorkflowArtifactDescriptor {
  artifactId: number;
  name: string;
  digest: string;
}

export interface WorkflowArtifactReadback extends WorkflowArtifactDescriptor {
  size: number;
  runId: number;
  sourceSha: string;
  archive: Buffer;
}

/** Transport integrity only; the caller must first admit the exact producer and its result. */
export async function readWorkflowArtifactBytes(input: {
  client: GitHubActivationClient;
  binding: WorkflowRunBinding;
  runId: number;
  artifactId: number;
  name: string;
  expectedDigest?: string;
  creationWindow?: { notBefore: number; notAfter: number };
}): Promise<WorkflowArtifactReadback> {
  const id = positiveId(input.artifactId, 'Actual workflow artifact ID');
  const artifact = await input.client.get(`/repos/${input.binding.repository}/actions/artifacts/${id}`);
  const producer = object(artifact.workflow_run);
  if (artifact.id !== id || artifact.name !== text(input.name, 'Expected artifact name') || artifact.expired !== false ||
    producer.id !== input.runId || producer.repository_id !== input.binding.repositoryId ||
    producer.head_repository_id !== input.binding.repositoryId || producer.head_sha !== input.binding.sourceSha ||
    producer.head_branch !== input.binding.ref || typeof artifact.digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest) ||
    input.expectedDigest !== undefined && artifact.digest !== input.expectedDigest ||
    !Number.isSafeInteger(artifact.size_in_bytes) || Number(artifact.size_in_bytes) < 1 || Number(artifact.size_in_bytes) > 4 * 1024 * 1024) {
    throw new GitHubActivationError('artifact-binding', 'The immutable artifact is not independently bound to the exact producer run, repository, source, name and digest.');
  }
  if (input.creationWindow && (typeof artifact.created_at !== 'string' || !Number.isFinite(Date.parse(artifact.created_at)) ||
    Date.parse(artifact.created_at) < input.creationWindow.notBefore || Date.parse(artifact.created_at) > input.creationWindow.notAfter)) {
    throw new GitHubActivationError('artifact-clock', 'The actual artifact was not created within its independently observed producer job interval.');
  }
  const response = expectStatus(await input.client.transport.request({
    method: 'GET', path: `/repos/${input.binding.repository}/actions/artifacts/${id}/zip`, binary: true
  }), [200], 'Read exact workflow artifact bytes');
  if (!Buffer.isBuffer(response.data) || response.data.length < 1 || response.data.length > 4 * 1024 * 1024 ||
    `sha256:${createHash('sha256').update(response.data).digest('hex')}` !== artifact.digest) {
    throw new GitHubActivationError('artifact-bytes', 'Actual bounded artifact bytes differ from the provider committed digest.');
  }
  return { artifactId: id, name: input.name, digest: artifact.digest, size: response.data.length,
    runId: input.runId, sourceSha: input.binding.sourceSha, archive: Buffer.from(response.data) };
}
