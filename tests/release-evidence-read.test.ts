import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectFile, readJsonFile } from '../scripts/release-evidence.mjs';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(content: Buffer | string = '{"observed":true}\r\n') {
  const root = fs.mkdtempSync(path.resolve('tests', '.evidence-read-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'nested'));
  const file = path.join(root, 'nested', 'report.json');
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return { root, file, bytes, relative: 'nested/report.json' };
}

describe('bounded release evidence reads', () => {
  it('decodes the same captured descriptor bytes without reopening the pathname', () => {
    const source = fixture();
    const reopen = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('An integrity-checked pathname must not be reopened for JSON.');
    });
    const closed = vi.spyOn(fs, 'closeSync');
    const result = readJsonFile(source.root, source.relative);
    expect(result.value).toEqual({ observed: true });
    expect(result.file).toEqual({
      path: source.relative, absolutePath: source.file, name: 'report.json',
      sha256: createHash('sha256').update(source.bytes).digest('hex'), size: source.bytes.length
    });
    expect(reopen).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('stops a growing file after the captured byte count plus one and closes the descriptor', () => {
    const source = fixture();
    const actualRead = fs.readSync;
    const read = vi.spyOn(fs, 'readSync').mockImplementationOnce((...args) => {
      fs.appendFileSync(source.file, Buffer.alloc(4096, 'x'));
      return Reflect.apply(actualRead, fs, args);
    });
    const closed = vi.spyOn(fs, 'closeSync');
    expect(() => inspectFile(source.root, source.relative, undefined, source.bytes.length))
      .toThrow(/captured byte bound/);
    const bytesRead = read.mock.results.reduce((total, result) => total + (result.type === 'return' ? result.value : 0), 0);
    expect(bytesRead).toBe(source.bytes.length + 1);
    expect(closed.mock.calls.filter(([fd]) => fd === read.mock.calls[0]?.[0])).toHaveLength(1);
  });

  it('rejects a shortened file rather than hashing a partial observation', () => {
    const source = fixture();
    const actualRead = fs.readSync;
    const read = vi.spyOn(fs, 'readSync').mockImplementationOnce((...args) => {
      fs.truncateSync(source.file, 0);
      return Reflect.apply(actualRead, fs, args);
    });
    const closed = vi.spyOn(fs, 'closeSync');
    expect(() => readJsonFile(source.root, source.relative)).toThrow(/changed during integrity/);
    expect(closed.mock.calls.filter(([fd]) => fd === read.mock.calls[0]?.[0])).toHaveLength(1);
  });

  it('refuses a replacement between selection and open before consuming any payload', () => {
    const source = fixture();
    const actualOpen = fs.openSync;
    const closed = vi.spyOn(fs, 'closeSync');
    let selectedFd: number | undefined;
    let fixtureClosures = 0;
    vi.spyOn(fs, 'openSync').mockImplementationOnce((...args) => {
      fs.renameSync(source.file, `${source.file}.retained`);
      fs.writeFileSync(source.file, '{"different":true}', { mode: 0o600 });
      selectedFd = Reflect.apply(actualOpen, fs, args);
      fixtureClosures = closed.mock.calls.length;
      return selectedFd;
    });
    const read = vi.spyOn(fs, 'readSync');
    expect(() => readJsonFile(source.root, source.relative)).toThrow(/changed before integrity/);
    expect(read).not.toHaveBeenCalled();
    expect(closed.mock.calls.slice(fixtureClosures)).toEqual([[selectedFd]]);
  });

  it('rejects changed pathname identity even when the replacement has identical bytes', () => {
    const source = fixture();
    const actualRead = fs.readSync;
    vi.spyOn(fs, 'readSync').mockImplementationOnce((...args) => {
      const count = Reflect.apply(actualRead, fs, args);
      fs.renameSync(source.file, `${source.file}.retained`);
      fs.writeFileSync(source.file, source.bytes, { mode: 0o600 });
      return count;
    });
    expect(() => readJsonFile(source.root, source.relative)).toThrow(/changed during integrity/);
  });

  it('does not interpret hard-linked files as independently observed evidence', () => {
    const source = fixture();
    fs.linkSync(source.file, path.join(source.root, 'alias.json'));
    const read = vi.spyOn(fs, 'readSync');
    expect(() => readJsonFile(source.root, source.relative)).toThrow(/linked/);
    expect(read).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('rejects linked ancestors without following their payloads', () => {
    const source = fixture();
    fs.renameSync(path.join(source.root, 'nested'), path.join(source.root, 'original'));
    fs.symlinkSync(path.join(source.root, 'original'), path.join(source.root, 'nested'));
    const read = vi.spyOn(fs, 'readSync');
    expect(() => readJsonFile(source.root, source.relative)).toThrow(/Linked/);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    Buffer.from('\ufeff{"observed":true}'),
    Buffer.from('{"token":"private-value", broken}')
  ])('rejects malformed UTF-8/JSON without disclosing its payload', (bytes) => {
    const source = fixture(bytes);
    expect(() => readJsonFile(source.root, source.relative)).toThrow('Invalid UTF-8 JSON evidence/source document: nested/report.json');
  });

  it('requires exact digest and bounded-size inputs', () => {
    const source = fixture();
    expect(() => inspectFile(source.root, source.relative, `${'a'.repeat(64)}\n`)).toThrow(/Invalid SHA-256/);
    expect(() => inspectFile(source.root, source.relative, undefined, Infinity)).toThrow(/positive safe integer/);
    expect(() => inspectFile(source.root, source.relative, undefined, source.bytes.length - 1)).toThrow(/oversized/);
    expect(() => readJsonFile(source.root, source.relative, '0'.repeat(64))).toThrow(/checksum mismatch/);
  });
});
