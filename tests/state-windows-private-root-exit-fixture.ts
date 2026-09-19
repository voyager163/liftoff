import { WindowsPrivateProcessError } from '../src/adapters/state/windows-private-protocol.js';

// Node 24.20 libuv assigns non-detached children to its kill-on-parent-exit job.
// UV_PROCESS_DETACHED omits that job, but does not request CREATE_BREAKAWAY_FROM_JOB:
// https://github.com/nodejs/node/blob/v24.20.0/deps/uv/src/win/process.c
export const rootBeforeDescendantProgram = `
  const child = require('node:child_process').spawn(process.execPath, ['-e', \`
    setInterval(() => {}, 100);
    process.send({ kind: 'NONSECRET-descendant-ready', pid: process.pid }, () => {});
  \`], { detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  child.once('error', () => process.exit(71));
  child.once('message', (message) => {
    if (message?.kind !== 'NONSECRET-descendant-ready' || message.pid !== child.pid) process.exit(72);
    child.unref();
    process.exit(0);
  });
`;

const codes = new Set([
  'unsupported-host', 'helper-unavailable', 'executable-changed', 'invalid-request',
  'working-directory-too-long', 'authentication-failed', 'invalid-protocol',
  'cancelled', 'timeout', 'output-limit', 'native-command-failed', 'settlement-unproven'
]);
const uint32 = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;

export function rootExitSourceDiagnostic(observation: {
  rootPid?: number; returnedExitCode?: number; failure?: unknown; quiesced?: boolean;
}) {
  const failure = observation.failure instanceof WindowsPrivateProcessError ? observation.failure : undefined;
  const outcome = failure?.outcome;
  return {
    schemaVersion: 1,
    classification: 'windows-private-root-exit-nonsecret-source-only',
    fixture: 'detached-child-ipc-ready-before-root-exit',
    rootPid: uint32(observation.rootPid) && observation.rootPid! > 0 ? observation.rootPid : null,
    result: observation.failure !== undefined ? 'rejected' : observation.returnedExitCode !== undefined ? 'resolved' : 'not-observed',
    code: failure && codes.has(failure.code) ? failure.code : observation.failure !== undefined ? 'unclassified-error' : null,
    exitCode: uint32(outcome?.exitCode) ? outcome!.exitCode : uint32(observation.returnedExitCode) ? observation.returnedExitCode : null,
    reason: Number.isInteger(outcome?.reason) && outcome!.reason >= 0 && outcome!.reason <= 7 ? outcome!.reason : null,
    settled: typeof outcome?.settled === 'boolean' ? outcome.settled : null,
    processSpawned: typeof outcome?.processSpawned === 'boolean' ? outcome.processSpawned : null,
    quiesced: typeof observation.quiesced === 'boolean' ? observation.quiesced : null
  };
}
