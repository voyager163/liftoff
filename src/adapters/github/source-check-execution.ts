import { isUtf8 } from 'node:buffer';
import { GitHubActivationError, githubRepository, positiveId, type GitHubActivationClient } from './activation-rest.js';
import { sourceCheckFixtureArtifact, type RequiredWorkflowCheck } from './workflow-check-recipes.js';

export function sourceCheckAssertionIdentity(recipe: unknown, directory: unknown, jobKey: string) {
  if ((recipe !== 'node-test.v1' && recipe !== 'vitest.v1' && recipe !== 'pytest.v1' && recipe !== 'go-test.v1') ||
    (directory !== '.' && directory !== 'backend' && directory !== 'frontend')) {
    throw new GitHubActivationError('check-assertion-execution', 'A source-bound assertion requires a registered recipe and working directory.');
  }
  return {
    kind: 'source-check-assertion-execution/1' as const,
    recipe,
    fixturePath: sourceCheckFixtureArtifact(jobKey, recipe, directory).path,
    testName: recipe === 'pytest.v1' ? 'test_reviewed_liftoff_source_validation_control' :
      recipe === 'go-test.v1' ? 'TestReviewedLiftoffSourceValidationControl' : 'reviewed Liftoff source-validation control'
  };
}

export type SourceCheckAssertionExecution = ReturnType<typeof sourceCheckAssertionIdentity> & { jobId: number };

export function verifySourceCheckAssertionLog(check: RequiredWorkflowCheck, bytes: Uint8Array): void {
  if (bytes.byteLength === 0 || bytes.byteLength > 4 * 1024 * 1024 || !isUtf8(bytes)) {
    throw new GitHubActivationError('check-assertion-execution', 'The source-bound assertion execution log is missing, oversized or not UTF-8.');
  }
  const text = Buffer.from(bytes).toString('utf8')
    .replace(/\u001b\[[0-9;]*m/gu, '')
    .replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\s/gmu, '');
  if (/ERR_MODULE_NOT_FOUND|Cannot find module|ModuleNotFoundError|ImportError|error collecting|build failed|compilation failed|runner lost communication|infrastructure error|no tests found/iu.test(text)) {
    throw new GitHubActivationError('check-assertion-execution', 'Dependency, collection, build or infrastructure failure cannot establish source-bound controlled assertion execution.');
  }
  const identity = sourceCheckAssertionIdentity(check.recipe, check.workingDirectory, check.jobId);
  const localPath = check.workingDirectory === '.' ? identity.fixturePath : identity.fixturePath.slice(check.workingDirectory.length + 1);
  const counts = check.recipe === 'node-test.v1' ? [...text.matchAll(/^(?:#|\u2139)\s+fail\s+(\d+)\s*$/gmu)].map((match) => Number(match[1])) :
    check.recipe === 'vitest.v1' ? [...text.matchAll(/^\s*Tests\s+(\d+) failed\b/gmu)].map((match) => Number(match[1])) :
      check.recipe === 'pytest.v1' ? [...text.matchAll(/(?:^=+\s*|^)(\d+) failed\b/gmu)].map((match) => Number(match[1])) :
        [(text.match(/^--- FAIL:/gmu) ?? []).length];
  if (counts.length !== 1 || counts[0] !== 1 ||
    check.recipe === 'go-test.v1' && !/^FAIL\s+\S*test\/liftoffcheck(?:\s|$)/mu.test(text)) {
    throw new GitHubActivationError('check-assertion-execution', 'A complete source-bound native assertion report must identify only the controlled test failure; truncated or mixed failures are not qualification.');
  }
  const blocks = text.split(/(?=^test at |^not ok \d+ - |^\s*FAIL\s|^FAILED\s|^--- FAIL:|^_{3,}\s+test_)/mu);
  const matches = blocks.filter((block) => {
    if (!block.includes(identity.testName)) return false;
    if (check.recipe === 'node-test.v1') {
      return block.includes(localPath) && /(?:^not ok \d+ - |[\u2716\u00d7] )reviewed Liftoff source-validation control/mu.test(block) &&
        /code:\s*['"]ERR_ASSERTION['"]/u.test(block) &&
        /actual:\s*['"]controlled-invalid['"]/u.test(block) && /expected:\s*['"]valid['"]/u.test(block);
    }
    if (check.recipe === 'vitest.v1') {
      return block.includes(localPath) && /^\s*FAIL\s/mu.test(block) &&
        /AssertionError: expected ['"]controlled-invalid['"] to be ['"]valid['"]/u.test(block);
    }
    if (check.recipe === 'pytest.v1') {
      return /^_{3,}\s+test_reviewed_liftoff_source_validation_control\s+_{3,}$/mu.test(block) &&
        block.includes(`${localPath}:`) && /^E\s+AssertionError: assert ['"]controlled-invalid['"] == ['"]valid['"]/mu.test(block) &&
        text.split('\n').filter((line) => line.startsWith(`FAILED ${localPath}::${identity.testName}`)).length === 1;
    }
    return /^--- FAIL: TestReviewedLiftoffSourceValidationControl\b/mu.test(block) &&
      /validation_test\.go:\d+:\s*reviewed controlled-invalid source-validation control/u.test(block);
  });
  if (matches.length !== 1) {
    throw new GitHubActivationError('check-assertion-execution', 'The exact reviewed source test has no unique native assertion-execution failure report; a failed step or archived source file is not proof.');
  }
}

export async function readSourceCheckAssertionExecution(
  client: GitHubActivationClient, repository: string, check: RequiredWorkflowCheck, jobId: number
): Promise<SourceCheckAssertionExecution> {
  const response = await client.transport.request({
    method: 'GET', path: `/repos/${githubRepository(repository)}/actions/jobs/${positiveId(jobId)}/logs`, text: true
  });
  const mediaType = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (response.status !== 200 || typeof response.data !== 'string' || response.data.includes('\uFFFD') ||
    !['text/plain', 'application/octet-stream'].includes(mediaType ?? '')) {
    throw new GitHubActivationError('check-assertion-execution', 'The exact source-bound assertion execution log could not be read; no alternative job or summary is accepted.');
  }
  const bytes = Buffer.from(response.data);
  try {
    verifySourceCheckAssertionLog(check, bytes);
    return { ...sourceCheckAssertionIdentity(check.recipe, check.workingDirectory, check.jobId), jobId };
  } finally { bytes.fill(0); }
}
