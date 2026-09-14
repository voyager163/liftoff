import { describe, expect, it, vi } from 'vitest';
import {
  decodeWindowsEnvironmentBlock,
  defaultWindowsJobControllerId,
  deriveInvocationDigest,
  encodeWindowsEnvironmentBlock,
  formatWindowsArgvCommandLine,
  frameControlMessage,
  quoteWindowsArgvArgument,
  unframeControlMessages,
  validateWindowsJobControlResponse,
  WindowsJobExecutionSession,
  type WindowsJobAdmittedInvocation,
  type WindowsJobControlAck,
  type WindowsJobControlExpectedContext
} from '../src/adapters/process/windows-job-protocol.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { inspectApplicationPatch, verifyApplicationPatch } from '../src/application/repair/application-patch.js';
import { applicationVerificationFixtureContext } from './fixtures/repair-application.js';
import { createPreparationFixture } from './fixtures/repair-preparation.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

describe('Windows literal CommandLineToArgvW argument formatting', () => {
  it('formats empty argument as double quotes', () => {
    expect(quoteWindowsArgvArgument('')).toBe('""');
  });

  it('preserves simple arguments without spaces or metacharacters as-is', () => {
    expect(quoteWindowsArgvArgument('node')).toBe('node');
    expect(quoteWindowsArgvArgument('--test')).toBe('--test');
    expect(quoteWindowsArgvArgument('C:\\Windows\\System32\\node.exe')).toBe('C:\\Windows\\System32\\node.exe');
  });

  it('wraps arguments with spaces in quotes', () => {
    expect(quoteWindowsArgvArgument('hello world')).toBe('"hello world"');
    expect(quoteWindowsArgvArgument('Program Files')).toBe('"Program Files"');
  });

  it('correctly escapes trailing backslashes before closing quote', () => {
    expect(quoteWindowsArgvArgument('C:\\Path With Space\\To\\')).toBe('"C:\\Path With Space\\To\\\\"');
    expect(quoteWindowsArgvArgument('dir with spaces\\\\')).toBe('"dir with spaces\\\\\\\\"');
  });

  it('correctly escapes embedded double quotes and preceding backslashes', () => {
    expect(quoteWindowsArgvArgument('hello "world"')).toBe('"hello \\"world\\""');
    const input = 'a' + String.fromCharCode(92, 92, 34) + 'b';
    const expected = '"a' + String.fromCharCode(92, 92, 92, 92, 92, 34) + 'b"';
    expect(quoteWindowsArgvArgument(input)).toBe(expected);
  });

  it('formats full literal command line without cmd.exe shell escaping', () => {
    const commandLine = formatWindowsArgvCommandLine({
      executable: 'C:\\Program Files\\Node\\node.exe',
      args: ['--test', 'C:\\My Projects\\test suite\\check.test.js', 'with "embedded" quotes']
    });
    expect(commandLine).toBe(
      '"C:\\Program Files\\Node\\node.exe" --test "C:\\My Projects\\test suite\\check.test.js" "with \\"embedded\\" quotes"'
    );
    expect(commandLine).not.toContain('^');
    expect(commandLine).not.toContain('%');
  });

  it('rejects embedded null characters in arguments or executable', () => {
    expect(() => quoteWindowsArgvArgument('arg\0with\0null')).toThrow(/null character/);
    expect(() => formatWindowsArgvCommandLine({ executable: 'node\0.exe', args: [] })).toThrow(/null character/);
    expect(() => formatWindowsArgvCommandLine({ executable: 'node.exe', args: ['arg\0bad'] })).toThrow(/null character/);
  });

  it('rejects command lines exceeding the Win32 32767 character limit including null terminator', () => {
    // Exact boundary: 32766 characters + 1 NUL terminator = 32767 units (allowed)
    // 32767 characters + 1 NUL terminator = 32768 units (exceeds limit, rejected)
    const exactMaxArg = 'a'.repeat(32_766 - 5); // 'node ' is 5 chars
    const commandLine = formatWindowsArgvCommandLine({ executable: 'node', args: [exactMaxArg] });
    expect(commandLine.length).toBe(32_766);

    const overMaxArg = 'a'.repeat(32_767 - 5);
    expect(() => formatWindowsArgvCommandLine({ executable: 'node', args: [overMaxArg] })).toThrow(/exceeds Win32 limit/);
  });
});

describe('Windows UTF-16LE environment block encoding and decoding', () => {
  it('encodes and decodes an environment block preserving keys and values', () => {
    const env = {
      PATH: 'C:\\Windows\\System32;C:\\Program Files\\Node',
      NODE_ENV: 'test',
      CI: '1',
      TEMP: 'C:\\Temp'
    };
    const encoded = encodeWindowsEnvironmentBlock(env);
    expect(encoded.byteLength % 2).toBe(0);
    const decoded = decodeWindowsEnvironmentBlock(encoded);
    expect(decoded).toMatchObject(env);
  });

  it('sorts keys case-insensitively as expected by Windows CreateProcessW', () => {
    const env = { z_var: 'last', a_var: 'first', B_VAR: 'second' };
    const encoded = encodeWindowsEnvironmentBlock(env);
    const text = encoded.toString('utf16le');
    const keys = text.split('\0').filter(Boolean).map((line) => line.split('=')[0]);
    expect(keys).toEqual(['a_var', 'B_VAR', 'z_var']);
  });

  it('rejects duplicate case-insensitive environment keys', () => {
    expect(() => encodeWindowsEnvironmentBlock({ PATH: 'trusted', Path: 'shadow' })).toThrow(
      /Duplicate case-insensitive environment key detected/
    );
    expect(() => encodeWindowsEnvironmentBlock({ temp: 'first', TEMP: 'second' })).toThrow(
      /Duplicate case-insensitive environment key detected/
    );
  });

  it('rejects empty environment keys, null characters, and keys containing equals', () => {
    expect(() => encodeWindowsEnvironmentBlock({ '': 'value' })).toThrow(/empty/);
    expect(() => encodeWindowsEnvironmentBlock({ 'BAD\0KEY': 'val' })).toThrow(/null character/);
    expect(() => encodeWindowsEnvironmentBlock({ GOOD_KEY: 'bad\0val' })).toThrow(/null character/);
    expect(() => encodeWindowsEnvironmentBlock({ 'KEY=WITH_EQUALS': 'val' })).toThrow(/invalid '=' character/);
  });

  it('strictly validates UTF-16LE decoding bounds, even byte length, and double null termination', () => {
    expect(() => decodeWindowsEnvironmentBlock(Buffer.from([1, 2, 3]))).toThrow(/must be even/);
    expect(() => decodeWindowsEnvironmentBlock(Buffer.from([0, 0]))).toThrow(/at least 4 bytes/);
    // Missing double null terminator:
    expect(() => decodeWindowsEnvironmentBlock(Buffer.from('KEY=VAL\0', 'utf16le'))).toThrow(
      /not terminated with a double null/
    );
    // Malformed entry without '=':
    expect(() => decodeWindowsEnvironmentBlock(Buffer.from('BROKEN\0OK=val\0\0', 'utf16le'))).toThrow(
      /without '=' delimiter/
    );
    // Raw block exceeding 64 KiB bound:
    const largeBlock = Buffer.from(`KEY=${'a'.repeat(65 * 1024)}\0\0`, 'utf16le');
    expect(() => decodeWindowsEnvironmentBlock(largeBlock)).toThrow(/exceeds maximum bound/);
  });

  it('rejects duplicate case-insensitive environment keys in decoded raw blocks', () => {
    const raw = Buffer.from('PATH=trusted\0Path=shadow\0\0', 'utf16le');
    expect(() => decodeWindowsEnvironmentBlock(raw)).toThrow(
      /Duplicate case-insensitive environment key detected in decode/
    );
  });

  it('preserves legal "__proto__" environment entry using null-prototype object without prototype pollution', () => {
    const raw = Buffer.from('__proto__=polluted\0KEY=value\0\0', 'utf16le');
    const decoded = decodeWindowsEnvironmentBlock(raw);
    expect(decoded.__proto__).toBe('polluted');
    expect(Object.getPrototypeOf(decoded)).toBeNull();
    expect(({} as any).polluted).toBeUndefined();
  });
});

describe('Windows Job control message protocol and framing', () => {
  it('frames and unframes control messages with length prefix', () => {
    const payload = {
      schemaVersion: 1,
      kind: 'spawn',
      nonce: 'a'.repeat(64),
      sequence: 1,
      commandLine: 'node.exe --test'
    };
    const framed = frameControlMessage(payload);
    expect(framed.readUInt32BE(0)).toBe(Buffer.byteLength(JSON.stringify(payload), 'utf8'));

    const { messages, remainder } = unframeControlMessages(framed);
    expect(messages).toEqual([payload]);
    expect(remainder.byteLength).toBe(0);
  });

  it('unframes multiple batched messages and preserves partial buffer remainder', () => {
    const msg1 = { schemaVersion: 1, kind: 'spawn', sequence: 1 };
    const msg2 = { schemaVersion: 1, kind: 'spawn', sequence: 2 };
    const framed1 = frameControlMessage(msg1);
    const framed2 = frameControlMessage(msg2);
    const combined = Buffer.concat([framed1, framed2, Buffer.from([0, 0, 0, 10, 123])]);

    const { messages, remainder } = unframeControlMessages(combined);
    expect(messages).toEqual([msg1, msg2]);
    expect(remainder).toEqual(Buffer.from([0, 0, 0, 10, 123]));
  });

  const validExpected: WindowsJobControlExpectedContext = {
    nonce: 'a'.repeat(64),
    sequence: 5,
    workspaceId: 'b'.repeat(64),
    invocationId: 'c'.repeat(64),
    controllerId: defaultWindowsJobControllerId
  };

  it('validates natural zero-members completion without requiring jobTerminated: true', () => {
    const naturalValid = {
      schemaVersion: 1,
      kind: 'response',
      controllerId: defaultWindowsJobControllerId,
      workspaceId: 'b'.repeat(64),
      invocationId: 'c'.repeat(64),
      nonce: 'a'.repeat(64),
      sequence: 5,
      phase: 'completed',
      status: 0,
      signal: null,
      activeProcesses: 0,
      jobTerminated: false,
      settled: true
    };
    const validated = validateWindowsJobControlResponse(naturalValid, validExpected);
    expect(validated.settled).toBe(true);
    expect(validated.jobTerminated).toBe(false);
    expect(validated.activeProcesses).toBe(0);
  });

  it('validates clean terminated completion with jobTerminated: true', () => {
    const terminatedValid = {
      schemaVersion: 1,
      kind: 'response',
      controllerId: defaultWindowsJobControllerId,
      workspaceId: 'b'.repeat(64),
      invocationId: 'c'.repeat(64),
      nonce: 'a'.repeat(64),
      sequence: 5,
      phase: 'terminated',
      status: null,
      signal: 'SIGKILL',
      activeProcesses: 0,
      jobTerminated: true,
      settled: true
    };
    const validated = validateWindowsJobControlResponse(terminatedValid, validExpected);
    expect(validated.settled).toBe(true);
    expect(validated.jobTerminated).toBe(true);
  });

  it('rejects unadmitted expected context with non-hex nonces or negative sequences', () => {
    expect(() => validateWindowsJobControlResponse({}, { ...validExpected, nonce: 'not-hex' })).toThrow(/nonce/);
    expect(() => validateWindowsJobControlResponse({}, { ...validExpected, workspaceId: 'not-hex' })).toThrow(/workspaceId/);
    expect(() => validateWindowsJobControlResponse({}, { ...validExpected, sequence: -1 })).toThrow(/sequence/);
  });

  it('rejects unknown fields in control response to prevent schema smuggling', () => {
    const smudged = {
      schemaVersion: 1, kind: 'response', controllerId: defaultWindowsJobControllerId,
      workspaceId: 'b'.repeat(64), invocationId: 'c'.repeat(64), nonce: 'a'.repeat(64), sequence: 5,
      phase: 'completed', status: 0, signal: null, activeProcesses: 0, jobTerminated: false, settled: true,
      untrustedSmuggledField: 'malicious'
    };
    expect(() => validateWindowsJobControlResponse(smudged, validExpected)).toThrow(/unexpected field "untrustedSmuggledField"/);
  });

  it('rejects mismatched controller, workspace, invocation, nonce or sequence bindings', () => {
    const base = {
      schemaVersion: 1, kind: 'response', controllerId: defaultWindowsJobControllerId,
      workspaceId: 'b'.repeat(64), invocationId: 'c'.repeat(64), nonce: 'a'.repeat(64), sequence: 5,
      phase: 'completed', status: 0, signal: null, activeProcesses: 0, jobTerminated: false, settled: true
    };
    expect(() => validateWindowsJobControlResponse({ ...base, nonce: 'f'.repeat(64) }, validExpected)).toThrow(/nonce/);
    expect(() => validateWindowsJobControlResponse({ ...base, workspaceId: 'f'.repeat(64) }, validExpected)).toThrow(/workspace/);
    expect(() => validateWindowsJobControlResponse({ ...base, invocationId: 'f'.repeat(64) }, validExpected)).toThrow(/invocation/);
    expect(() => validateWindowsJobControlResponse({ ...base, sequence: 6 }, validExpected)).toThrow(/sequence/);
    expect(() => validateWindowsJobControlResponse({ ...base, controllerId: 'wrong-controller' }, validExpected)).toThrow(/controller/);
  });

  it('rejects invalid error or status types without coercing them to success', () => {
    const base = {
      schemaVersion: 1, kind: 'response', controllerId: defaultWindowsJobControllerId,
      workspaceId: 'b'.repeat(64), invocationId: 'c'.repeat(64), nonce: 'a'.repeat(64), sequence: 5,
      phase: 'completed', status: 0, signal: null, activeProcesses: 0, jobTerminated: false, settled: true
    };
    // Non-string error object must throw, not normalize to undefined/settled: true:
    expect(() => validateWindowsJobControlResponse({ ...base, error: { message: 'failed' } }, validExpected)).toThrow(
      /Invalid error in control response/
    );
    // Invalid non-integer status must throw:
    expect(() => validateWindowsJobControlResponse({ ...base, status: '0' }, validExpected)).toThrow(
      /Invalid status in control response/
    );
  });

  it('rejects contradictory terminated versus completed phases', () => {
    const base = {
      schemaVersion: 1, kind: 'response', controllerId: defaultWindowsJobControllerId,
      workspaceId: 'b'.repeat(64), invocationId: 'c'.repeat(64), nonce: 'a'.repeat(64), sequence: 5,
      status: 0, signal: null, activeProcesses: 0, settled: true
    };
    // Phase completed with jobTerminated true:
    expect(() => validateWindowsJobControlResponse({ ...base, phase: 'completed', jobTerminated: true }, validExpected)).toThrow(
      /job is marked terminated but phase is "completed"/
    );
    // Phase terminated with jobTerminated false:
    expect(() => validateWindowsJobControlResponse({ ...base, phase: 'terminated', jobTerminated: false, status: null, signal: 'SIGKILL' }, validExpected)).toThrow(
      /phase is "terminated" but jobTerminated is false/
    );
  });

  it('rejects contradictory settlement claims', () => {
    const base = {
      schemaVersion: 1, kind: 'response', controllerId: defaultWindowsJobControllerId,
      workspaceId: 'b'.repeat(64), invocationId: 'c'.repeat(64), nonce: 'a'.repeat(64), sequence: 5,
      phase: 'completed', status: 0, signal: null, activeProcesses: 0, jobTerminated: false, settled: true
    };
    // Active processes remain:
    expect(() => validateWindowsJobControlResponse({ ...base, activeProcesses: 1 }, validExpected)).toThrow(/Contradictory/);
    // Running phase claimed settled:
    expect(() => validateWindowsJobControlResponse({ ...base, phase: 'running' }, validExpected)).toThrow(/Contradictory/);
    // Error present but claimed settled:
    expect(() => validateWindowsJobControlResponse({ ...base, error: 'subprocess crash' }, validExpected)).toThrow(/Contradictory/);
    // Neither status nor signal:
    expect(() => validateWindowsJobControlResponse({ ...base, status: null, signal: null }, validExpected)).toThrow(/Contradictory/);
  });
});

describe('Fail-before-target-spawn admission guard on Windows', () => {
  it('blocks in NodeCommandRunner immediately without spawning when ensureProcessTreeSettled is requested on Windows', async () => {
    const originalPlatform = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const runner = new NodeCommandRunner();
      const command = { executable: 'node.exe', args: ['--test', 'test.js'] };
      const result = await runner.run(command, { ensureProcessTreeSettled: true });
      expect(result.status).toBeNull();
      expect(result.processTreeSettled).toBe(false);
      expect(result.errorCode).toBe('UNSUPPORTED_PROCESS_SETTLEMENT');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('fails closed in assertAdmission before creating a workspace or running commands when platform is win32', async () => {
    const originalPlatform = process.platform;
    const rootDir = path.resolve(`.test-win-admission-${randomUUID()}`);
    try {
      const f = await createPreparationFixture(rootDir, { frontend: false });
      const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
      expect(candidate.blockers).toEqual([]);

      const runner = new NodeCommandRunner();
      const runSpy = vi.spyOn(runner, 'run');

      const context = await applicationVerificationFixtureContext(f.root, candidate, {
        projectCode: true, dependencyPreparation: false, network: false
      });

      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      const verified = await verifyApplicationPatch(f.root, candidate, runner, context);
      expect(verified.status).toBe('blocked');
      expect(verified.blockers.join(' ')).toContain('[unsupported-platform-settlement]');
      expect(verified.commands).toHaveLength(0);
      expect(runSpy).not.toHaveBeenCalled();
      expect(verified.workspaceId).toBeUndefined();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe('Windows Job execution session state machine', () => {
  const nonce = 'a'.repeat(64);
  const invocation: WindowsJobAdmittedInvocation = {
    workspaceId: 'b'.repeat(64),
    controllerId: defaultWindowsJobControllerId,
    executable: 'C:\\Program Files\\Node\\node.exe',
    args: ['--test', 'C:\\Project\\test.js'],
    cwd: 'C:\\Project',
    envDigest: 'c'.repeat(64),
    timeoutMs: 45_000,
    maxOutputBytes: 32_768
  };

  it('rejects mismatched controller identity on controller-ready', () => {
    const session = new WindowsJobExecutionSession();
    expect(() => session.onControllerReady('untrusted-controller')).toThrow(
      /Mismatched controller identity "untrusted-controller"/
    );
    expect(session.getState()).toBe('uninitialized');
  });

  it('enforces controller-ready -> scope-admitted -> root-requested -> root-started -> settled sequence', () => {
    const session = new WindowsJobExecutionSession();
    session.onControllerReady();
    expect(session.getState()).toBe('controller-ready');

    const invocationId = session.admitScope(invocation, nonce);
    expect(session.getState()).toBe('scope-admitted');
    expect(invocationId).toBe(deriveInvocationDigest(invocation));
    expect(session.getInvocationId()).toBe(invocationId);

    // Request root start transitions to root-requested (NOT root-started):
    const spawnRequest = session.requestRootStart();
    expect(session.getState()).toBe('root-requested');
    expect(spawnRequest.sequence).toBe(1);
    expect(spawnRequest.timeoutMs).toBe(45_000);
    expect(spawnRequest.maxOutputBytes).toBe(32_768);
    expect(spawnRequest.invocationId).toBe(invocationId);
    expect(spawnRequest.controllerId).toBe(defaultWindowsJobControllerId);
    expect(spawnRequest.envDigest).toBe('c'.repeat(64));

    // Terminal response before controller ack is rejected:
    const terminalResponse = {
      schemaVersion: 1,
      kind: 'response',
      controllerId: defaultWindowsJobControllerId,
      workspaceId: invocation.workspaceId,
      invocationId,
      nonce,
      sequence: 1,
      phase: 'completed',
      status: 0,
      signal: null,
      activeProcesses: 0,
      jobTerminated: false,
      settled: true
    };
    expect(() => session.ingestResponse(terminalResponse)).toThrow(
      /Cannot process execution response in session state "root-requested": root start was not acknowledged by controller/
    );

    // Controller acknowledges root start:
    const ack: WindowsJobControlAck = {
      schemaVersion: 1,
      kind: 'ack',
      controllerId: defaultWindowsJobControllerId,
      workspaceId: invocation.workspaceId,
      invocationId,
      nonce,
      sequence: 1,
      admitted: true
    };
    session.onRootStartAcknowledged(ack);
    expect(session.getState()).toBe('root-started');

    // Now valid terminal response is accepted as settled:
    const response = session.ingestResponse(terminalResponse);
    expect(response.settled).toBe(true);
    expect(session.getState()).toBe('settled');
    expect(session.getSequence()).toBe(2);
  });

  it('transitions to failed without fake root-started when root admission is denied by controller', () => {
    const session = new WindowsJobExecutionSession();
    session.onControllerReady();
    const invocationId = session.admitScope(invocation, nonce);
    session.requestRootStart();
    expect(session.getState()).toBe('root-requested');

    const deniedAck: WindowsJobControlAck = {
      schemaVersion: 1,
      kind: 'ack',
      controllerId: defaultWindowsJobControllerId,
      workspaceId: invocation.workspaceId,
      invocationId,
      nonce,
      sequence: 1,
      admitted: false,
      error: 'CreateProcessW failed with ERROR_ACCESS_DENIED'
    };
    expect(() => session.onRootStartAcknowledged(deniedAck)).toThrow(/Root process admission was denied by controller/);
    expect(session.getState()).toBe('failed');
  });

  it('rejects stale or out-of-order sequence responses', () => {
    const session = new WindowsJobExecutionSession();
    session.onControllerReady();
    const invocationId = session.admitScope(invocation, nonce);
    session.requestRootStart();
    session.onRootStartAcknowledged({
      schemaVersion: 1, kind: 'ack', controllerId: defaultWindowsJobControllerId,
      workspaceId: invocation.workspaceId, invocationId, nonce, sequence: 1, admitted: true
    });
    expect(session.getState()).toBe('root-started');

    const staleResponse = {
      schemaVersion: 1, kind: 'response', controllerId: defaultWindowsJobControllerId,
      workspaceId: invocation.workspaceId, invocationId, nonce, sequence: 999,
      phase: 'completed', status: 0, signal: null, activeProcesses: 0, jobTerminated: false, settled: true
    };
    expect(() => session.ingestResponse(staleResponse)).toThrow(/Mismatched control response sequence number/);
  });

  it('rejects wrong controller ID on controller-ready and in admitted scope (wrong-ready-id)', () => {
    const session1 = new WindowsJobExecutionSession();
    expect(() => session1.onControllerReady('different-controller-id')).toThrow(
      /Mismatched controller identity "different-controller-id"/
    );

    const session2 = new WindowsJobExecutionSession('custom-controller-id');
    expect(() => session2.onControllerReady('wrong-controller-id')).toThrow(
      /Mismatched controller identity "wrong-controller-id"/
    );
    session2.onControllerReady('custom-controller-id');

    expect(() => session2.admitScope({
      ...invocation,
      controllerId: 'mismatched-controller-in-invocation'
    }, nonce)).toThrow(/Mismatched controller identity in invocation/);
  });

  it('rejects changed command, bounds, or env vs admitted invocation digest', () => {
    const baseDigest = deriveInvocationDigest(invocation);

    const changedCommand = deriveInvocationDigest({
      ...invocation,
      executable: 'C:\\Different\\node.exe'
    });
    expect(changedCommand).not.toBe(baseDigest);

    const changedArgs = deriveInvocationDigest({
      ...invocation,
      args: ['--test', 'C:\\Project\\other.js']
    });
    expect(changedArgs).not.toBe(baseDigest);

    const changedCwd = deriveInvocationDigest({
      ...invocation,
      cwd: 'C:\\DifferentDir'
    });
    expect(changedCwd).not.toBe(baseDigest);

    const changedEnv = deriveInvocationDigest({
      ...invocation,
      envDigest: 'd'.repeat(64)
    });
    expect(changedEnv).not.toBe(baseDigest);

    const changedTimeout = deriveInvocationDigest({
      ...invocation,
      timeoutMs: 90_000
    });
    expect(changedTimeout).not.toBe(baseDigest);

    const changedMaxOutput = deriveInvocationDigest({
      ...invocation,
      maxOutputBytes: 65_536
    });
    expect(changedMaxOutput).not.toBe(baseDigest);

    // If controller response attempts to use a different invocationId, validation rejects it:
    expect(() => validateWindowsJobControlResponse({
      schemaVersion: 1,
      kind: 'response',
      controllerId: defaultWindowsJobControllerId,
      workspaceId: invocation.workspaceId,
      invocationId: changedCommand,
      nonce,
      sequence: 1,
      phase: 'completed',
      status: 0,
      signal: null,
      activeProcesses: 0,
      jobTerminated: false,
      settled: true
    }, {
      controllerId: defaultWindowsJobControllerId,
      workspaceId: invocation.workspaceId,
      invocationId: baseDigest,
      nonce,
      sequence: 1
    })).toThrow(/Mismatched or unauthenticated invocation binding in control response/);
  });

  it('verifies spawn request preserves exact output bounds, timeout, commandLine, and environment digest', () => {
    const customInvocation: WindowsJobAdmittedInvocation = {
      workspaceId: 'f'.repeat(64),
      controllerId: defaultWindowsJobControllerId,
      executable: 'C:\\Tools\\custom.exe',
      args: ['param with spaces', '"quoted"'],
      cwd: 'C:\\Workspace',
      envDigest: 'e'.repeat(64),
      timeoutMs: 12_345,
      maxOutputBytes: 131_072
    };
    const session = new WindowsJobExecutionSession();
    session.onControllerReady();
    const invId = session.admitScope(customInvocation, nonce);
    const spawnReq = session.requestRootStart();

    expect(spawnReq.timeoutMs).toBe(12_345);
    expect(spawnReq.maxOutputBytes).toBe(131_072);
    expect(spawnReq.cwd).toBe('C:\\Workspace');
    expect(spawnReq.executable).toBe('C:\\Tools\\custom.exe');
    expect(spawnReq.commandLine).toBe('C:\\Tools\\custom.exe "param with spaces" "\\"quoted\\""');
    expect(spawnReq.envDigest).toBe('e'.repeat(64));
    expect(spawnReq.invocationId).toBe(invId);
    expect(spawnReq.controllerId).toBe(defaultWindowsJobControllerId);
    expect(spawnReq.workspaceId).toBe('f'.repeat(64));
    expect(spawnReq.nonce).toBe(nonce);
  });

  it('rejects terminal response when root start was not acknowledged by controller (no-ack terminal reply)', () => {
    const session = new WindowsJobExecutionSession();
    session.onControllerReady();
    const invocationId = session.admitScope(invocation, nonce);
    session.requestRootStart();
    expect(session.getState()).toBe('root-requested');

    const reply = {
      schemaVersion: 1,
      kind: 'response',
      controllerId: defaultWindowsJobControllerId,
      workspaceId: invocation.workspaceId,
      invocationId,
      nonce,
      sequence: 1,
      phase: 'completed',
      status: 0,
      signal: null,
      activeProcesses: 0,
      jobTerminated: false,
      settled: true
    };

    expect(() => session.ingestResponse(reply)).toThrow(
      /Cannot process execution response in session state "root-requested": root start was not acknowledged by controller/
    );
    expect(session.getState()).toBe('root-requested');
  });

  it('rejects mismatched scope or sequence in controller acknowledgement frame', () => {
    const session = new WindowsJobExecutionSession();
    session.onControllerReady();
    const invocationId = session.admitScope(invocation, nonce);
    session.requestRootStart();

    // Mismatched invocationId:
    expect(() => session.onRootStartAcknowledged({
      schemaVersion: 1, kind: 'ack', controllerId: defaultWindowsJobControllerId,
      workspaceId: invocation.workspaceId, invocationId: '0'.repeat(64), nonce, sequence: 1, admitted: true
    })).toThrow(/Mismatched scope binding or sequence in root start acknowledgement/);
    expect(session.getState()).toBe('failed');
  });
});
