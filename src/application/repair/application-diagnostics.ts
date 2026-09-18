import type { CommandResult } from '../../process-runner.js';
import {
  windowsWorkingDirectoryErrorCode, windowsWorkingDirectoryRemedy
} from '../../domain/execution/windows-working-directory.js';
import { applicationBounds, type ApplicationVerificationCommand } from './application-types.js';

export interface ApplicationCommandFailure {
  kind: 'missing-executable' | 'missing-dependencies' | 'execution-failed' | 'check-failed' |
    'timed-out' | 'output-limit' | 'interrupted' | 'termination-unconfirmed';
  message: string;
  cleanupUnsafe: boolean;
}

const failure = (
  kind: ApplicationCommandFailure['kind'], message: string, cleanupUnsafe = false
): ApplicationCommandFailure => ({ kind, message, cleanupUnsafe });

const missingExecutable = () => failure('missing-executable',
  'The launch diagnostics or exit status indicate that a required executable or interpreter could not be found. Make the declared host tool available through separately approved workstation setup, then request a fresh review. Missing project-local check tools remain subject to the excluded-dependency limitation. Repair does not install global tools.');

const executionFailure = () => failure('execution-failed',
  'The command runner could not complete the declared check. Review the installed executable, candidate working directory, and local execution prerequisites before requesting a fresh verification. Private diagnostics are withheld.');

function outputBudget(command: ApplicationVerificationCommand): number {
  return Number.isSafeInteger(command.maxOutputBytes) && command.maxOutputBytes > 0
    ? Math.min(command.maxOutputBytes, applicationBounds.commandOutputBytes) : applicationBounds.commandOutputBytes;
}

function outputExceedsBudget(result: CommandResult, budget: number): boolean {
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (stdout.length > budget || stderr.length > budget) return true;
  return Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') > budget;
}

function diagnosticText(result: CommandResult, budget: number): string {
  const half = Math.min(Math.floor(budget / 2), 16 * 1024);
  const prefix = (value: string): string => typeof value === 'string'
    ? Buffer.from(value.slice(0, half), 'utf8').subarray(0, half).toString('utf8') : '';
  return `${prefix(result.stderr)}\n${prefix(result.stdout)}`
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
}

export function applicationDiagnosticMatches(
  result: CommandResult, maximumBytes: number, pattern: RegExp
): boolean {
  return pattern.test(diagnosticText(result, Math.min(maximumBytes, applicationBounds.commandOutputBytes)));
}

/** Diagnostics select fixed messages only; no extracted package name, path, snippet, or raw error is returned. */
export function applicationCommandFailure(
  command: ApplicationVerificationCommand, result: CommandResult
): ApplicationCommandFailure | null {
  if (result.errorCode === 'PROCESS_TREE_TERMINATION_FAILED' ||
      result.errorCode === 'DESCENDANT_PROCESSES_ACTIVE' ||
      result.errorCode === 'UNSUPPORTED_PROCESS_SETTLEMENT') {
    return failure('termination-unconfirmed',
      result.errorCode === 'UNSUPPORTED_PROCESS_SETTLEMENT'
        ? 'Process-tree settlement verification is unsupported on the current platform. The private workspace is retained and no successful receipt is allowed.'
        : 'The runner could not confirm that all verifier processes stopped. Earlier host effects may continue. Resolve process termination before another verification; the private workspace is retained and no successful receipt is allowed.', true);
  }
  const budget = outputBudget(command);
  if (result.outputLimitExceeded || result.errorCode === 'MAX_OUTPUT_BYTES_EXCEEDED' || outputExceedsBudget(result, budget)) {
    return failure('output-limit',
      `The declared combined output bound (${budget} bytes) was exceeded. Reduce check verbosity or explicitly review a different bounded check before retrying. Output is withheld because it may contain secrets.`);
  }
  if (result.timedOut || result.errorCode === 'ETIMEDOUT') {
    return failure('timed-out',
      `The declared timeout (${command.timeoutMs} ms) was exceeded. Review hangs and external waits, or request a fresh plan with an explicitly reviewed timeout within the supported bound. No automatic retry or timeout increase is authorized.`);
  }
  if (result.aborted || result.errorCode === 'ABORT_ERR' || result.signal === 'SIGINT') {
    return failure('interrupted',
      'The declared check was interrupted or cancelled before successful completion. Earlier verifier effects are not undone. Obtain fresh action-specific consent before retrying.');
  }
  if (typeof result.stdout !== 'string' || typeof result.stderr !== 'string') return executionFailure();
  if (result.status === 0 && !result.signal && !result.errorCode && !result.errorMessage) return null;
  if (result.errorCode === 'ENOENT') return missingExecutable();
  if (result.errorCode === windowsWorkingDirectoryErrorCode) {
    return failure('execution-failed', windowsWorkingDirectoryRemedy);
  }
  if (result.errorCode === 'RESTRICTED_EXECUTION_POLICY') {
    return failure('execution-failed',
      'Windows PowerShell execution policy (Restricted or AllSigned) prevents running the controller script. Adjust execution policy (e.g. Set-ExecutionPolicy RemoteSigned -Scope CurrentUser) to permit script execution; Liftoff does not bypass execution policies.');
  }
  if (result.errorCode === 'CONSTRAINED_LANGUAGE_MODE') {
    return failure('execution-failed',
      'Windows PowerShell is in ConstrainedLanguage mode or restricted by AppLocker/WDAC. Win32 Job Object creation requires FullLanguage mode.');
  }
  if (result.errorCode === 'CORRUPTED_CONTROLLER_ASSET') {
    return failure('execution-failed',
      'The packaged Windows Job Object controller asset failed integrity verification. Reinstall or verify the Liftoff package installation.');
  }
  if (result.errorCode === 'POWERSHELL_SPAWN_FAILED') {
    return failure('execution-failed',
      result.errorMessage
        ? `Failed to launch Windows PowerShell 5.1: ${result.errorMessage}`
        : 'Failed to launch Windows PowerShell 5.1. Ensure Windows PowerShell 5.1 is installed and available in SystemRoot System32.');
  }
  if (result.errorCode === 'EACCES' || result.errorCode === 'EPERM' || result.status === 126) {
    return failure('execution-failed',
      'Execution permission was denied for a required tool or launch path. Review executable access and workstation prerequisites separately; repair does not change host permissions to bypass the failure.');
  }
  if (result.errorCode === 'ENOEXEC') {
    return failure('execution-failed',
      'The installed executable or interpreter has an unsupported launch format. Prepare a compatible existing tool through a separate workstation action, then request a fresh review.');
  }
  const text = diagnosticText(result, budget);
  if (result.errorCode === 'ERR_MODULE_NOT_FOUND' || result.errorCode === 'MODULE_NOT_FOUND' ||
      /\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b/u.test(text) ||
      /\b(?:Error:\s*Cannot find (?:module|package)|TS2307:\s*Cannot find module|TS2688:\s*Cannot find type definition file|TS7016:\s*Could not find a declaration file)\b/iu.test(text) ||
      /(?:^|[\s"'])(?:tsc|vue-tsc|vite|vitest|jest|eslint|webpack|rollup|tsx|ts-node|mocha|next|nuxt|vue-cli-service)["']?:\s*(?:command )?not found\b/iu.test(text) ||
      /["'](?:tsc|vue-tsc|vite|vitest|jest|eslint|webpack|rollup|tsx|ts-node|mocha|next|nuxt|vue-cli-service)["']\s+is not recognized as an internal or external command\b/iu.test(text) ||
      /\bcommand not found:\s*(?:tsc|vue-tsc|vite|vitest|jest|eslint|webpack|rollup|tsx|ts-node|mocha|next|nuxt|vue-cli-service)\b/iu.test(text)) {
    return failure('missing-dependencies',
      'Diagnostics indicate an unavailable Node package, type declaration, project-local check tool, or required build output. Live node_modules and build output are excluded from the initial copy; npm ci/install are currently rejected here. Review the declared build order and inputs, or request a separate preparation scope; do not claim unavailable framework checks passed.');
  }
  if (/\b(?:ModuleNotFoundError|ImportError):\s*No module named\b/u.test(text) ||
      /(?:^|\n)[^\r\n]{0,512}:\s*No module named\b/u.test(text)) {
    return failure('missing-dependencies',
      'Diagnostics indicate an unavailable Python module in the selected interpreter/private candidate. Live virtual environments are excluded and Python environment preparation is currently absent. Report this check as unavailable or request a separate preparation scope; verification does not run pip or create a prepared environment.');
  }
  if (/\b(?:module lookup disabled by GOPROXY|no required module provides package|missing go\.sum entry|cannot find module providing package)\b/iu.test(text)) {
    return failure('missing-dependencies',
      'Diagnostics indicate unavailable Go module/checksum or private-cache inputs. ' +
      (command.network
        ? 'This command declared network effects; review the module inputs and download availability without rewriting protected go.mod/go.sum. '
        : 'This command did not declare network effects, so Go proxy lookup is disabled; any additional network scope needs a fresh plan and separate consent. ') +
      'Go test/vet can download modules under explicit declared-network consent; GOTOOLCHAIN stays local. No generic installer or automatic toolchain download is authorized.');
  }
  if (command.executable === 'go' && /\bgo\.mod requires go\s*>=/iu.test(text)) {
    return failure('execution-failed',
      'The installed Go toolchain does not satisfy the candidate module requirement. Prepare a compatible Go executable separately; GOTOOLCHAIN remains local and repair does not download a replacement toolchain.');
  }
  if (command.executable === 'go' && /\b(?:go\.mod file not found|updates to go\.mod needed)\b/iu.test(text)) {
    return failure('check-failed',
      'The declared Go check lacks the required module context or consistent module inputs. Review its exact candidate working directory and go.mod/go.sum in a new plan; do not initialize a module or silently run go mod tidy during verification.');
  }
  if (command.executable === 'npm' && /\bMissing script:\s*["']/iu.test(text)) {
    return failure('check-failed',
      'The candidate package does not declare the requested npm script. Review the existing package.json scripts and request a corrected plan. Missing frontend tests are not test coverage, and dependency installation cannot create a legitimate missing check.');
  }
  if (/\bValidationError\b/u.test(text) && /\b(?:database_url|redis_url)\b/u.test(text) &&
      /\b(?:Field required|type=missing)\b/iu.test(text)) {
    return failure('check-failed',
      '[missing-test-configuration] The declared check requires explicit nonsecret test configuration. Live dotenv files and credential environment are not inherited. Review/stage the test setup and its inputs; do not copy live secrets or assume dependency preparation supplies application configuration.');
  }
  if (result.status === 127 ||
      /(?:^|[\s"'])(?:node|npm|python3?|go)(?:\.exe|\.cmd)?["']?:\s*(?:command )?not found\b/iu.test(text) ||
      /["'](?:node|npm|python3?|go)(?:\.exe|\.cmd)?["']\s+is not recognized as an internal or external command\b/iu.test(text)) {
    return missingExecutable();
  }
  if (result.signal) {
    return failure('check-failed',
      'The declared check terminated on a signal before success. Review resource limits, external interruption, and the trusted check before requesting a fresh verification; earlier effects are not undone.');
  }
  if (!Number.isSafeInteger(result.status) || result.status === 0 && (result.errorCode || result.errorMessage)) return executionFailure();
  return failure('check-failed',
    'The declared check returned a non-success status or signal. Review its assertions, build errors, or staged source/reference edits in a trusted environment, then request a fresh review. No dependency restore, automatic retry, or full-conformance claim follows from this failure.');
}

export function applicationRunnerFailure(
  command: ApplicationVerificationCommand, error: unknown
): ApplicationCommandFailure {
  let code: string | undefined;
  try {
    if (typeof error === 'object' && error !== null && 'code' in error &&
        typeof error.code === 'string' &&
        ['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC', 'ETIMEDOUT', 'ABORT_ERR',
          'MAX_OUTPUT_BYTES_EXCEEDED', 'PROCESS_TREE_TERMINATION_FAILED'].includes(error.code)) {
      code = error.code;
    }
  } catch { /* An arbitrary thrown object is not trusted diagnostic data. */ }
  return applicationCommandFailure(command, {
    command: { executable: command.executable, args: command.args }, displayCommand: '',
    status: null, signal: null, stdout: '', stderr: '', timedOut: false, errorCode: code
  }) ?? executionFailure();
}

export function applicationFailureBlocker(
  index: number, command: ApplicationVerificationCommand, diagnostic: ApplicationCommandFailure
): string {
  const executable = ['node', 'npm', 'python', 'python3', 'go'].includes(command.executable)
    ? command.executable : 'declared runtime';
  return `Application verification command ${index + 1} (${executable}) [${diagnostic.kind}]: ${diagnostic.message}`;
}
