import { inspect } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  consumeLinuxKeyClientOutput, linuxKeystoreClientProtocol, maximumLinuxKeystoreOutputBytes,
  LinuxKeyClientOutputCapture, PrivateLinuxKeySnapshot
} from '../src/adapters/state/linux-keystore-client-protocol.js';
import { OwnedPrivateStateProcessRunner } from '../src/adapters/state/owned-process.js';

const item = '/org/freedesktop/secrets/collection/login/42';
const settled = { exitCode: 0, processTreeSettled: true };
function frame(change: Record<string, unknown> = {}, key = Buffer.alloc(0), text?: string): Buffer {
  const metadata = Buffer.from(text ?? JSON.stringify({
    protocol: linuxKeystoreClientProtocol, event: 'result', effect: 'no-dispatch',
    code: 'ok', item, keyBytes: key.length, ...change
  }));
  const header = Buffer.alloc(12);
  header.write('LKC1');
  header.writeUInt32BE(metadata.length, 4); header.writeUInt32BE(key.length, 8);
  return Buffer.concat([header, metadata, key]);
}
const before = () => frame({ event: 'before-create', effect: 'possible-mutation', item: null });
const returned = (path = item) => frame({ event: 'created-identity', effect: 'returned-identity', item: path });
const success = () => frame({ effect: 'returned-identity' }, Buffer.alloc(32, 0xa5));
function expectCleared(bytes: Buffer) { expect(bytes.every((byte) => byte === 0)).toBe(true); }

describe('private Linux key helper framing', () => {
  it('consumes a complete read only after settled process success and never makes a readiness claim', async () => {
    const bytes = frame({}, Buffer.alloc(32, 0xa5));
    const result = consumeLinuxKeyClientOutput(bytes, { operation: 'read', item }, settled);
    expect(result).toMatchObject({
      status: 'completed', creation: 'no-dispatch', issue: null, observedItemPaths: [item], readiness: false
    });
    expectCleared(bytes);
    expect(inspect(result.key)).toBe('[PrivateLinuxKeySnapshot]');
    expect(() => JSON.stringify(result)).toThrow('access-denied');
    let borrowed: Uint8Array | undefined;
    await result.key!.consume(async (key) => {
      borrowed = key;
      expect(key.byteLength === 32 && key.every((byte) => byte === 0xa5)).toBe(true);
      await Promise.resolve();
    });
    expect(borrowed!.every((byte) => byte === 0)).toBe(true);
    await expect(result.key!.consume(() => undefined)).rejects.toMatchObject({ code: 'key-unavailable' });
  });

  it('retains creation stages and clears private output after successful decoding', async () => {
    const bytes = Buffer.concat([before(), returned(), success()]);
    const result = consumeLinuxKeyClientOutput(bytes, { operation: 'create' }, settled);
    expect(result).toMatchObject({
      status: 'completed', creation: 'returned-identity', observedItemPaths: [item], issue: null, readiness: false
    });
    expectCleared(bytes);
    await expect(result.key!.consume(() => { throw new Error('callback fixture'); })).rejects.toThrow('callback fixture');
    await expect(result.key!.consume(() => undefined)).rejects.toThrow('key-unavailable');
  });

  it.each([
    { bytes: () => frame({ code: 'invalid-arguments', item: null }), creation: 'no-dispatch', paths: [] },
    { bytes: () => Buffer.concat([before(), frame({ effect: 'possible-mutation', code: 'provider-failure', item: null })]),
      creation: 'possible-mutation', paths: [] },
    { bytes: () => Buffer.concat([before(), returned(), frame({ effect: 'returned-identity', code: 'identity-changed' })]),
      creation: 'returned-identity', paths: [item] }
  ])('reports failed creation without claiming earlier effects were absent: $creation', ({ bytes: make, creation, paths }) => {
    const bytes = make();
    const result = consumeLinuxKeyClientOutput(bytes, { operation: 'create' }, { ...settled, exitCode: 1 });
    expect(result).toMatchObject({ status: 'failed', creation, observedItemPaths: paths, key: null });
    expectCleared(bytes);
  });

  it.each([
    { exitCode: 0, processTreeSettled: false },
    { exitCode: 1, processTreeSettled: true },
    { exitCode: null, processTreeSettled: true },
    { exitCode: -1, processTreeSettled: true }
  ])('does not release a key on incomplete or failed process evidence: %j', (process) => {
    const bytes = Buffer.concat([before(), returned(), success()]);
    const result = consumeLinuxKeyClientOutput(bytes, { operation: 'create' }, process);
    expect(result).toMatchObject({
      status: 'incomplete', creation: 'returned-identity', observedItemPaths: [item], key: null
    });
    expectCleared(bytes);
  });

  it('retains an observed foreign returned identity without admitting it as a key or cleanup scope', () => {
    const foreign = '/org/freedesktop/secrets/collection/foreign/7';
    const bytes = Buffer.concat([
      before(), returned(foreign), frame({ effect: 'returned-identity', code: 'item-mismatch', item: foreign })
    ]);
    expect(consumeLinuxKeyClientOutput(bytes, { operation: 'create' }, { ...settled, exitCode: 1 }))
      .toMatchObject({ status: 'failed', creation: 'returned-identity', observedItemPaths: [foreign], key: null });
    const wrongSuccess = Buffer.concat([before(), returned(foreign),
      frame({ effect: 'returned-identity', item: foreign }, Buffer.alloc(32, 0xa5))]);
    expect(consumeLinuxKeyClientOutput(wrongSuccess, { operation: 'create' }, settled))
      .toMatchObject({ status: 'incomplete', issue: 'invalid-output', observedItemPaths: [foreign], key: null });
  });

  it.each([
    () => Buffer.alloc(0),
    () => before(),
    () => Buffer.concat([before(), returned()]),
    () => Buffer.concat([before(), returned(), success().subarray(0, -1)]),
    () => Buffer.concat([before(), returned(), success(), Buffer.from('trailing')]),
    () => Buffer.concat([before(), before(), returned(), success()]),
    () => Buffer.concat([before(), returned(), frame({ code: 'provider-failure', item: null })]),
    () => frame({ effect: 'returned-identity' }, Buffer.alloc(32, 0xa5)),
    () => Buffer.concat([before(), frame({ event: 'created-identity', effect: 'returned-identity', item: null })])
  ])('rejects missing, truncated, contradictory or extra creation frames %#', (make) => {
    const bytes = make();
    const result = consumeLinuxKeyClientOutput(bytes, { operation: 'create' }, settled);
    expect(result.status).toBe('incomplete');
    expect(result.key).toBeNull();
    expect(result.creation).not.toBe('no-dispatch');
    expectCleared(bytes);
  });

  it('never downgrades a returned identity after malformed or contradictory output', () => {
    const bytes = Buffer.concat([before(), returned(), frame({ code: 'provider-failure', item: null })]);
    expect(consumeLinuxKeyClientOutput(bytes, { operation: 'create' }, { ...settled, exitCode: 1 }))
      .toMatchObject({ status: 'incomplete', creation: 'returned-identity', observedItemPaths: [item], key: null });
  });

  it.each([
    { protocol: 'foreign' }, { event: 'native-success' }, { effect: 'untouched' }, { code: 'PRIVATE_DIAGNOSTIC' },
    { extra: 'PRIVATE_VALUE' }, { item: '/private/"value' }, { keyBytes: 1 },
    { event: { toString: 'PRIVATE_VALUE' } }, { effect: null }
  ])('rejects unregistered metadata without reflecting payload values %#', (change) => {
    const bytes = frame(change, Buffer.alloc(32, 0xa5));
    const result = consumeLinuxKeyClientOutput(bytes, { operation: 'read', item }, settled);
    expect(result).toMatchObject({ status: 'incomplete', issue: 'invalid-output', key: null });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expectCleared(bytes);
  });

  it('rejects duplicate JSON fields, malformed UTF-8, oversized output and invalid lengths', () => {
    const duplicate = frame({}, Buffer.alloc(0),
      `{"protocol":"${linuxKeystoreClientProtocol}","event":"result","effect":"no-dispatch","code":"locked","item":null,"keyBytes":0,"code":"ok"}`);
    const invalidUtf8 = frame({ code: 'locked', item: null });
    invalidUtf8[12] = 0xff;
    const badMagic = frame(); badMagic[0] = 0;
    const badLength = frame(); badLength.writeUInt32BE(2049, 4);
    const emptyMetadata = frame(); emptyMetadata.writeUInt32BE(0, 4);
    const wrongKeyLength = frame(); wrongKeyLength.writeUInt32BE(31, 8);
    for (const bytes of [duplicate, invalidUtf8, badMagic, badLength, emptyMetadata, wrongKeyLength,
      Buffer.alloc(maximumLinuxKeystoreOutputBytes + 1)]) {
      expect(consumeLinuxKeyClientOutput(bytes, { operation: 'read', item }, settled))
        .toMatchObject({ status: 'incomplete', issue: 'invalid-output', key: null });
      expectCleared(bytes);
    }
  });

  it('rejects read target substitution and success-exit/error-frame contradictions', () => {
    expect(consumeLinuxKeyClientOutput(frame({}, Buffer.alloc(32)), {
      operation: 'read', item: '/org/freedesktop/secrets/collection/login/99'
    }, settled)).toMatchObject({ status: 'incomplete', key: null });
    expect(consumeLinuxKeyClientOutput(frame({ code: 'locked', item: null }), { operation: 'read', item }, settled))
      .toMatchObject({ status: 'incomplete', issue: 'invalid-output', key: null });
  });

  it('clears output even when the requested operation binding is invalid', () => {
    const bytes = frame({}, Buffer.alloc(32, 0xa5));
    expect(() => consumeLinuxKeyClientOutput(bytes, { operation: 'read', item: '/foreign' }, settled))
      .toThrow('invalid-binding');
    expectCleared(bytes);
  });

  it('allows explicit private-snapshot release and refuses wrong-sized keys', async () => {
    expect(() => new PrivateLinuxKeySnapshot(Buffer.alloc(31))).toThrow('key-unavailable');
    const key = new PrivateLinuxKeySnapshot(Buffer.alloc(32));
    key.release();
    await expect(key.consume(() => undefined)).rejects.toThrow('key-unavailable');
  });
});

describe('private streamed key-helper observations', () => {
  it('accepts arbitrary frame fragmentation without exposing keys before settlement', async () => {
    const capture = new LinuxKeyClientOutputCapture({ operation: 'create' });
    const bytes = Buffer.concat([before(), returned(), success()]);
    for (const byte of bytes) capture.append(Buffer.from([byte]));
    expect(capture.observed()).toEqual({ creation: 'returned-identity', observedItemPaths: [item] });
    expect(inspect(capture)).toBe('[LinuxKeyClientOutputCapture]');
    expect(() => JSON.stringify(capture)).toThrow('access-denied');
    const result = capture.finish(settled);
    expect(result.status).toBe('completed');
    await result.key!.consume((key) => expect(key.every((byte) => byte === 0xa5)).toBe(true));
    expect(() => capture.append(Buffer.alloc(0))).toThrow('invalid-binding');
    expect(() => capture.finish(settled)).toThrow('invalid-binding');
    bytes.fill(0);
  });

  it('retains bounded returned identities on overflow without handing out a key', () => {
    const capture = new LinuxKeyClientOutputCapture({ operation: 'create' });
    const bytes = Buffer.concat([before(), returned(), Buffer.alloc(maximumLinuxKeystoreOutputBytes)]);
    capture.append(bytes);
    capture.append(Buffer.from('ignored overflow'));
    expect(capture.finish(settled)).toMatchObject({
      status: 'incomplete', issue: 'invalid-output', creation: 'returned-identity',
      observedItemPaths: [item], key: null
    });
    bytes.fill(0);
  });

  it('binds the original requested item and allows disposal of incomplete private capture', () => {
    const request = { operation: 'read' as const, item };
    const capture = new LinuxKeyClientOutputCapture(request);
    request.item = '/org/freedesktop/secrets/collection/login/99';
    capture.append(frame({}, Buffer.alloc(32, 0xa5)));
    const result = capture.finish(settled);
    expect(result.status).toBe('completed');
    result.key!.release();
    const incomplete = new LinuxKeyClientOutputCapture({ operation: 'create' });
    incomplete.append(before());
    incomplete.release();
    expect(incomplete.observed().creation).toBe('possible-mutation');
    expect(() => incomplete.finish(settled)).toThrow('invalid-binding');
  });

  it.runIf(process.platform !== 'win32')('keeps returned metadata when owned execution times out and private output is discarded', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'liftoff-key-stream-'));
    const runner = new OwnedPrivateStateProcessRunner();
    const capture = new LinuxKeyClientOutputCapture({ operation: 'create' });
    const bytes = Buffer.concat([before(), returned()]);
    const borrowed: Uint8Array[] = [];
    try {
      await expect(runner.run({
        executable: process.execPath,
        args: ['-e', `process.stdout.write(Buffer.from(${JSON.stringify(bytes.toString('hex'))}, 'hex')); setInterval(() => {}, 1000);`],
        cwd: root, environment: {}, timeoutMs: 1000, maximumBytes: 8192,
        observePrivateStdout(chunk) { borrowed.push(chunk); capture.append(chunk); }
      })).rejects.toMatchObject({ code: 'timeout' });
      expect(borrowed.length).toBeGreaterThan(0);
      expect(borrowed.every((chunk) => chunk.every((byte) => byte === 0))).toBe(true);
      expect(capture.finish({ exitCode: null, processTreeSettled: false })).toMatchObject({
        status: 'incomplete', creation: 'returned-identity', observedItemPaths: [item], key: null
      });
    } finally {
      bytes.fill(0); capture.release();
      await runner.quiesce();
      await rm(root, { recursive: true });
    }
  });

  it.runIf(process.platform !== 'win32')('fails closed and clears observation copies without exposing observer errors', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'liftoff-key-observer-'));
    const runner = new OwnedPrivateStateProcessRunner();
    let borrowed: Uint8Array | undefined;
    try {
      const execution = runner.run({
        executable: process.execPath, args: ['-e', "process.stdout.write('NONSECRET'); setInterval(() => {}, 1000);"],
        cwd: root, environment: {}, timeoutMs: 1000, maximumBytes: 8192,
        observePrivateStdout(chunk) { borrowed = chunk; throw new Error('PRIVATE_OBSERVER_MESSAGE'); }
      });
      await expect(execution).rejects.toMatchObject({ code: 'operation-failed' });
      await expect(execution).rejects.not.toThrow('PRIVATE_OBSERVER_MESSAGE');
      expect(borrowed?.every((byte) => byte === 0)).toBe(true);
    } finally {
      await runner.quiesce();
      await rm(root, { recursive: true });
    }
  });
});
