import { isUtf8 } from 'node:buffer';
import { GitHubActivationError } from '../../adapters/github/activation-rest.js';
import { extractWorkflowReport } from '../../adapters/github/workflow-report-archive.js';

export const privateRunnerReportFilename = 'private-path-report.json';

function reportArchiveFailure(): GitHubActivationError {
  return new GitHubActivationError('private-report-archive', 'The private observation artifact must contain one bounded regular UTF-8 JSON report, with no additional payloads.');
}

// The caller owns and wipes the exact UTF-8 bytes; JSON semantics remain caller-owned.
export function extractPrivateReportArchive(archive: Uint8Array, expectedFilename = privateRunnerReportFilename): Buffer {
  if (typeof expectedFilename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.json$/u.test(expectedFilename) ||
    expectedFilename.includes('..')) throw reportArchiveFailure();
  if (!(archive instanceof Uint8Array) || archive.byteLength < 22 || archive.byteLength > 512 * 1024) throw reportArchiveFailure();
  try {
    return extractWorkflowReport(archive, { filename: expectedFilename, maxBytes: 128 * 1024 });
  } catch (error) {
    if (error instanceof GitHubActivationError &&
      (error.code === 'workflow-report-archive' || error.code === 'workflow-report-options')) throw reportArchiveFailure();
    throw error;
  }
}

export function readPrivateReportArchive(archive: Uint8Array, expectedFilename = privateRunnerReportFilename): unknown {
  const content = extractPrivateReportArchive(archive, expectedFilename);
  try {
    if (!isUtf8(content)) throw reportArchiveFailure();
    return JSON.parse(content.toString('utf8'));
  } catch { throw reportArchiveFailure(); }
  finally { content.fill(0); }
}
