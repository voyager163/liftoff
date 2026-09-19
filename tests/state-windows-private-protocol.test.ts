import { describe, expect, it } from 'vitest';
import {
  WindowsPrivateProtocolSession, windowsPrivateFrame, windowsPrivateMessage
} from '../src/adapters/state/windows-private-protocol.js';

const nonce = 'a'.repeat(64);
const ready = { schemaVersion: 1, nonce, controllerPid: 200, controllerCreated: '2000', parentPid: 100, parentCreated: '1000' };
const assigned = { nonce, pid: 300, created: '3000', assignedBeforeExecution: true };
const complete = { nonce, settled: true, activeProcesses: 0, rootExited: true, processSpawned: true, exitCode: 0, reason: 0, inputDisposed: true };
const feed = (session: WindowsPrivateProtocolSession, type: number, value: unknown) =>
  session.feed(windowsPrivateMessage(type, value), () => {});
function running(maximum = 1024, observer?: (bytes: Uint8Array) => void) {
  const session = new WindowsPrivateProtocolSession(nonce, 200, 100, maximum, observer);
  feed(session, 11, ready); feed(session, 12, assigned);
  return session;
}

describe('Windows private binary protocol (portable, not native execution evidence)', () => {
  it('preserves bounded NUL/non-UTF8 stdout and separate stderr across fragmented pipe frames', () => {
    const session = running();
    const stdout = Buffer.from([0, 255, 128, 10, 13, 0, 65]);
    const stderr = Buffer.from([255, 0, 66]);
    const frame = windowsPrivateFrame(13, stdout);
    for (const byte of frame) {
      const fragment = Buffer.from([byte]);
      session.feed(fragment, () => {});
      expect(fragment[0]).toBe(0);
    }
    session.feed(windowsPrivateFrame(14, stderr), () => {});
    feed(session, 15, complete);
    const result = session.takeOutput();
    expect(Buffer.from(result.stdout).equals(stdout)).toBe(true);
    expect(Buffer.from(result.stderr).equals(stderr)).toBe(true);
    expect(() => session.takeOutput()).toThrow();
    result.stdout.fill(0); result.stderr.fill(0);
  });

  it.each([
    { nonce: 'b'.repeat(64) }, { controllerPid: 201 }, { parentPid: 101 },
    { controllerCreated: '0002' }, { parentCreated: '3000' }
  ])('requires the spawned controller, inherited-pipe challenge and parent creation identity: %j', (change) => {
    const session = new WindowsPrivateProtocolSession(nonce, 200, 100, 32);
    expect(() => feed(session, 11, { ...ready, ...change })).toThrow(/authentication-failed/);
    expect(() => session.takeOutput()).toThrow();
  });

  it.each([{ pid: 100 }, { pid: 200 }, { created: '1000' }, { assignedBeforeExecution: false }])(
    'refuses execution without authenticated assignment-before-resume: %j', (change) => {
      const session = new WindowsPrivateProtocolSession(nonce, 200, 100, 32);
      feed(session, 11, ready);
      expect(() => feed(session, 12, { ...assigned, ...change })).toThrow(/authentication-failed/);
    }
  );

  it('rejects output before job admission and bounds combined stdout/stderr exactly', () => {
    const waiting = new WindowsPrivateProtocolSession(nonce, 200, 100, 32);
    expect(() => waiting.feed(windowsPrivateFrame(13, Buffer.from('NONSECRET')), () => {})).toThrow(/invalid-protocol/);
    const exact = running(4);
    exact.feed(windowsPrivateFrame(13, Buffer.from([0, 255])), () => {});
    exact.feed(windowsPrivateFrame(14, Buffer.from([128, 0])), () => {});
    feed(exact, 15, complete);
    const result = exact.takeOutput();
    expect(result.stdout.length + result.stderr.length).toBe(4);
    result.stdout.fill(0); result.stderr.fill(0);
    const exceeded = running(4);
    exceeded.feed(windowsPrivateFrame(13, Buffer.alloc(4)), () => {});
    expect(() => exceeded.feed(windowsPrivateFrame(14, Buffer.from([1])), () => {})).toThrow(/output-limit/);
    expect(() => exceeded.takeOutput()).toThrow();
  });

  it.each([
    { settled: false }, { activeProcesses: 1 }, { rootExited: false }, { inputDisposed: false }
  ])('never turns %j into process-tree or buffer-disposal proof', (change) => {
    const session = running();
    feed(session, 15, { ...complete, ...change });
    expect(session.completion?.settled).toBe(false);
    expect(() => session.takeOutput()).toThrow();
  });

  it('can discard private output on cancellation without losing a fragmented terminal frame', () => {
    const session = running();
    session.feed(windowsPrivateFrame(13, Buffer.from('NONSECRET fixture')), () => {});
    const terminal = windowsPrivateMessage(15, { ...complete, reason: 2 });
    session.feed(Buffer.from(terminal.subarray(0, 7)), () => {});
    session.discardOutput();
    session.feed(Buffer.from(terminal.subarray(7)), () => {});
    expect(session.completion).toMatchObject({ settled: true, reason: 2 });
    expect(() => session.takeOutput()).toThrow();
    terminal.fill(0);
  });

  it('wipes borrowed private observations and rejects malformed terminal types or replay', () => {
    let observed: Uint8Array | undefined;
    const session = running(100, (bytes) => { observed = bytes; expect(bytes[0]).toBe(255); });
    session.feed(windowsPrivateFrame(13, Buffer.from([255, 0])), () => {});
    expect([...observed!]).toEqual([0, 0]);
    expect(() => feed(session, 15, { ...complete, exitCode: '0' })).toThrow();
    const replay = running();
    feed(replay, 15, complete);
    expect(() => feed(replay, 15, complete)).toThrow();
  });

  it('does not treat a raw output payload as control authority or disclose rejected bytes', () => {
    const session = running();
    const bytes = windowsPrivateMessage(15, complete);
    session.feed(windowsPrivateFrame(13, bytes), () => {});
    expect(session.completion).toBeUndefined();
    session.dispose(); bytes.fill(0);
    const invalid = Buffer.from([15, 0, 0, 128, 0]);
    expect(() => running().feed(invalid, () => {})).toThrow(/invalid-protocol/);
    expect(invalid.every((byte) => byte === 0)).toBe(true);
  });
});
