import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  buildWindowsControllerHostEnvironment, createWindowsJobDiagnosticRecorder, readWindowsJobDiagnosticRecorder,
  runWindowsJobCommand, type WindowsJobDiagnosticRecorder
} from '../src/adapters/process/windows-job-runner.js';

const safeCodes = new Set([
  'ABORTED', 'CORRUPTED_CONTROLLER_ASSET', 'UNSUPPORTED_PROCESS_SETTLEMENT', 'UNSUPPORTED_CONTROLLER_RUNTIME', 'ENOENT',
  'LOG_CLEANUP_FAILED', 'SUPERVISOR_TIMEOUT', 'INVALID_CONTROL_FRAME', 'CONTROL_PIPE_ERROR',
  'CONTROL_PIPE_DISCONNECTED', 'AUTHENTICATION_FAILED', 'SPAWN_REQUEST_FAILED', 'ADMISSION_DENIED',
  'INVALID_CONTROL_RESPONSE', 'JOB_EXECUTION_ERROR', 'POWERSHELL_SPAWN_FAILED',
  'CONTROLLER_LAUNCH_FAILED', 'RESTRICTED_EXECUTION_POLICY', 'CONSTRAINED_LANGUAGE_MODE',
  'CONTROLLER_EXITED_UNEXPECTEDLY', 'CONTROL_SERVER_ERROR'
]);

let recorder: WindowsJobDiagnosticRecorder | undefined;
let hostEnvironment: { keys: string[]; digest: string } | undefined;
let completed: { status: number | null; timedOut: boolean; processSpawned: boolean | undefined;
  processTreeSettled: boolean | undefined; errorCode: string | null } | undefined;
afterEach(() => {
  if (!recorder) return;
  console.log(JSON.stringify({
    kind: 'native-windows-controller-diagnostic', platform: process.platform, architecture: process.arch,
    resultReturned: completed !== undefined, result: completed ?? null,
    controller: readWindowsJobDiagnosticRecorder(recorder),
    hostEnvironment,
    commandContentsRecorded: false, processOutputRecorded: false, credentialsRecorded: false,
    completeApplicationQualification: false
  }));
  recorder = undefined; completed = undefined; hostEnvironment = undefined;
});

it.runIf(process.platform === 'win32' && process.env.LIFTOFF_WINDOWS_CONTROLLER_DIAGNOSTIC === '1').each(['absent', 'explicit'] as const)(
  'records actual controller stages and preserves %s target module environment without changing settlement requirements',
  async targetModule => {
    const host = buildWindowsControllerHostEnvironment();
    hostEnvironment = {
      keys: Object.keys(host).sort(),
      digest: createHash('sha256').update(JSON.stringify(Object.entries(host).sort())).digest('hex')
    };
    recorder = createWindowsJobDiagnosticRecorder();
    const target = {
      SystemRoot: host.SystemRoot, PATH: path.dirname(process.execPath), TEMP: os.tmpdir(), TMP: os.tmpdir(),
      ...(targetModule === 'explicit' ? { PSModulePath: 'NONFUNCTIONAL_TARGET_MODULE_SCOPE' } : {})
    };
    const expected = targetModule === 'explicit' ? JSON.stringify('NONFUNCTIONAL_TARGET_MODULE_SCOPE') : 'undefined';
    const result = await runWindowsJobCommand(
      { executable: process.execPath, args: ['-e', `process.exit(process.env.PSModulePath === ${expected} ? 0 : 97)`] },
      {
        timeoutMs: 10_000, maxOutputBytes: 1024,
        env: target
      },
      { diagnosticRecorder: recorder }
    );
    completed = {
      status: result.status, timedOut: result.timedOut, processSpawned: result.processSpawned,
      processTreeSettled: result.processTreeSettled,
      errorCode: result.errorCode ? safeCodes.has(result.errorCode) ? result.errorCode : 'UNRECOGNIZED_ERROR' : null
    };
    expect(completed).toMatchObject({ status: 0, timedOut: false, processSpawned: true, processTreeSettled: true, errorCode: null });
  }, 15_000
);
