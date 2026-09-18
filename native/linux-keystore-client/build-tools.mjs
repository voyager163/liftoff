import { execFileSync } from 'node:child_process';

export const buildCommandLimits = Object.freeze({ timeoutMs: 30_000, maximumBytes: 65_536, diagnosticBytes: 16_384 });

export class BuildFailure extends Error {
  constructor(code, diagnostics = '') {
    super(code);
    this.diagnostics = diagnostics;
  }
}

function boundedDiagnostics(output) {
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output ?? '');
  const text = bytes.subarray(0, buildCommandLimits.diagnosticBytes).toString('utf8')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, '');
  return text + (bytes.length > buildCommandLimits.diagnosticBytes ? '\n[compile diagnostics truncated]' : '');
}

export function runBuildCommand(command, args, {
  label, environment = process.env, diagnostics = false,
  timeoutMs = buildCommandLimits.timeoutMs
} = {}) {
  if (!/^[a-z0-9:-]+$/u.test(label ?? '') || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 || timeoutMs > buildCommandLimits.timeoutMs) throw new BuildFailure('invalid-build-command');
  try {
    return execFileSync(command, args, {
      encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: buildCommandLimits.maximumBytes
    }).trim();
  } catch (error) {
    const code = error.code === 'ENOENT' ? `missing-build-dependency:${label}`
      : error.code === 'ETIMEDOUT' ? `build-command-timeout:${label}`
        : error.code === 'ENOBUFS' ? `build-command-output-limit:${label}` : `build-command-failed:${label}`;
    // Never print the exec error object/message, command argv or environment.
    throw new BuildFailure(code, diagnostics ? boundedDiagnostics(error.stderr) : '');
  }
}
