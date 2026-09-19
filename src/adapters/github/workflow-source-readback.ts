import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { canonicalSha256, sha256Hex } from '../../domain/governance/activation/canonical-json.js';
import { sourceSha } from '../../governance-activation/github-config.js';
import { GitHubActivationError, githubRepository, type GitHubActivationClient } from './activation-rest.js';

export interface WorkflowFileDefinition {
  path: string;
  content: string;
  digest: string;
}

export interface ObservedWorkflowContent {
  path: string;
  digest: string;
  contentDigest: string;
  size: number;
  blobSha: string;
  sourceSha: string;
  content: string;
}

export const workflowSourcePathPattern = /^\.github\/(?:workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml|rulesets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json)$/u;
export const controlledNodeTestPath = 'test/liftoff-repository-check.test.mjs';
const sourceFixturePaths = [
  controlledNodeTestPath, 'test/liftoff-repository-check.test.ts',
  'tests/test_liftoff_repository_check.py', 'test/liftoffcheck/validation_test.go'
] as const;
export const controlledSourceFixturePaths: readonly string[] = sourceFixturePaths.flatMap((path) =>
  [path, `backend/${path}`, `frontend/${path}`]);

export async function readbackWorkflowContent(
  client: GitHubActivationClient,
  repository: string,
  path: string,
  ref: string
): Promise<ObservedWorkflowContent> {
  if (!workflowSourcePathPattern.test(path)) throw new GitHubActivationError('workflow-path', 'Workflow readback requires an exact reviewed workflow/ruleset path.');
  return readbackSourceContent(client, repository, path, ref);
}

export async function readbackControlledNodeFixture(
  client: GitHubActivationClient, repository: string, ref: string
): Promise<ObservedWorkflowContent> {
  return readbackSourceContent(client, repository, controlledNodeTestPath, ref);
}

export async function readbackValidationSource(
  client: GitHubActivationClient, repository: string, path: string, ref: string
): Promise<ObservedWorkflowContent> {
  if (!['package.json', 'backend/package.json', 'frontend/package.json'].includes(path) && !controlledSourceFixturePaths.includes(path)) {
    throw new GitHubActivationError('validation-source-path', 'Validation readback is limited to the exact registered manifest and controlled fixture paths.');
  }
  return readbackSourceContent(client, repository, path, ref);
}

async function readbackSourceContent(
  client: GitHubActivationClient, repository: string, path: string, ref: string
): Promise<ObservedWorkflowContent> {
  const repo = githubRepository(repository);
  const cleanPath = path;
  const source = sourceSha(ref);
  const response = await client.get(`/repos/${repo}/contents/${cleanPath}?ref=${source}`);

  if (response.type !== 'file' || response.path !== cleanPath ||
    response.encoding !== 'base64' || typeof response.content !== 'string' ||
    !Number.isSafeInteger(response.size) || Number(response.size) < 0 || Number(response.size) > 256 * 1024 ||
    response.content.length > 360 * 1024) {
    throw new GitHubActivationError(
      'workflow-readback',
      `Workflow file ${cleanPath} at the exact source commit was not returned with a matching bounded file identity.`
    );
  }

  const encoded = response.content.replace(/\r?\n/gu, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new GitHubActivationError('workflow-readback', 'Workflow readback contains malformed base64 bytes.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (bytes.length !== response.size || bytes.toString('base64') !== encoded ||
    !isUtf8(bytes) || response.sha !== blobSha) {
    throw new GitHubActivationError('workflow-readback', 'Workflow byte length, UTF-8 encoding or Git blob identity differs from the returned file.');
  }
  const content = bytes.toString('utf8');
  return {
    path: cleanPath, digest: canonicalSha256(content), contentDigest: sha256Hex(content),
    size: bytes.length, blobSha, sourceSha: source, content
  };
}
