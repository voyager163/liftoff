import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { buildWindowsControllerHostEnvironment, runWindowsJobCommand } from '../src/adapters/process/windows-job-runner.js';

const safeCodes = new Set([
  'ABORTED', 'CORRUPTED_CONTROLLER_ASSET', 'UNSUPPORTED_PROCESS_SETTLEMENT', 'ENOENT',
  'LOG_CLEANUP_FAILED', 'SUPERVISOR_TIMEOUT', 'INVALID_CONTROL_FRAME', 'CONTROL_PIPE_ERROR',
  'CONTROL_PIPE_DISCONNECTED', 'AUTHENTICATION_FAILED', 'SPAWN_REQUEST_FAILED', 'ADMISSION_DENIED',
  'INVALID_CONTROL_RESPONSE', 'JOB_EXECUTION_ERROR', 'POWERSHELL_SPAWN_FAILED',
  'CONTROLLER_LAUNCH_FAILED', 'RESTRICTED_EXECUTION_POLICY', 'CONSTRAINED_LANGUAGE_MODE',
  'CONTROLLER_EXITED_UNEXPECTEDLY', 'CONTROL_SERVER_ERROR'
]);

it.runIf(process.platform === 'win32' && process.env.LIFTOFF_WINDOWS_CONTROLLER_DIAGNOSTIC === '1')(
  'records actual controller stages for a non-writing native Node target without changing settlement requirements',
  async () => {
    const host = buildWindowsControllerHostEnvironment();
    const result = await runWindowsJobCommand(
      { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
      {
        timeoutMs: 10_000, maxOutputBytes: 1024,
        env: { SystemRoot: host.SystemRoot, PATH: path.dirname(process.execPath), TEMP: os.tmpdir(), TMP: os.tmpdir() }
      },
      { captureDiagnostics: true }
    );
    const receipt = {
      kind: 'native-windows-controller-diagnostic', platform: process.platform, architecture: process.arch,
      status: result.status, timedOut: result.timedOut, processSpawned: result.processSpawned,
      processTreeSettled: result.processTreeSettled,
      errorCode: result.errorCode ? safeCodes.has(result.errorCode) ? result.errorCode : 'UNRECOGNIZED_ERROR' : null,
      controller: result.controllerDiagnostics ?? null,
      commandContentsRecorded: false, processOutputRecorded: false, credentialsRecorded: false,
      completeApplicationQualification: false
    };
    console.log(JSON.stringify(receipt));
    expect(receipt).toMatchObject({ status: 0, timedOut: false, processSpawned: true, processTreeSettled: true, errorCode: null });
  }, 15_000
);
