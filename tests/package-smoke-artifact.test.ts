import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inspectPackageArchive, parseSmokeArguments, prepareSmokeArtifact, verifyInstalledArchiveFiles
} from '../scripts/package-smoke-artifact.mjs';

const expected = { name: '@msn-control/liftoff', version: '1.2.3' };
const roots: string[] = [];
type Entry = { name: string; body?: string | Buffer; type?: string; link?: string; mode?: number };

function record(entry: Entry): Buffer {
  const header = Buffer.alloc(512);
  const body = Buffer.from(entry.body ?? '');
  const number = (value: number, start: number, size: number) =>
    header.write(`${value.toString(8).padStart(size - 1, '0')}\0`, start, size, 'ascii');
  header.write(entry.name, 0, 100);
  number(entry.mode ?? 0o644, 100, 8);
  number(0, 108, 8);
  number(0, 116, 8);
  number(body.length, 124, 12);
  number(0, 136, 12);
  header.fill(32, 148, 156);
  header.write(entry.type ?? '0', 156, 1);
  if (entry.link) header.write(entry.link, 157, 100);
  header.write('ustar\0' + '00', 257, 8);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}

function archive(entries: Entry[] = [], metadata: unknown = expected): Buffer {
  return gzipSync(Buffer.concat([
    ...(metadata === null ? [] : [record({ name: 'package/package.json', body: JSON.stringify(metadata) })]),
    ...entries.map(record), Buffer.alloc(1024)
  ]));
}

function pax(key: string, value: string): string {
  const payload = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(payload) + 1;
  while (String(length).length + Buffer.byteLength(payload) !== length) {
    length = String(length).length + Buffer.byteLength(payload);
  }
  return `${length}${payload}`;
}

async function fixture() {
  const root = await mkdtemp(path.join(process.cwd(), '.liftoff-smoke-artifact-test-'));
  roots.push(root);
  const packageRoot = path.join(root, 'source with spaces');
  const packDirectory = path.join(root, 'private pack');
  await mkdir(packageRoot);
  await mkdir(packDirectory);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(expected));
  const tarball = path.join(root, 'exact artifact with spaces.tgz');
  const bytes = archive([{ name: 'package/README.md', body: '# Fixture\n' }]);
  await writeFile(tarball, bytes, { mode: 0o600 });
  return { root, packageRoot, packDirectory, tarball, bytes };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('exact package smoke artifact', () => {
  it('accepts only the default invocation or one absolute tarball, including native paths with spaces', () => {
    expect(parseSmokeArguments([])).toBeUndefined();
    for (const [paths, file] of [
      [path.posix, '/workspace with spaces/candidate.tgz'],
      [path.win32, 'C:\\workspace with spaces\\candidate.tgz']
    ] as const) expect(parseSmokeArguments(['--tarball', file], paths)).toBe(file);
    for (const args of [['--tarball'], ['candidate.tgz'], ['--tarball', 'relative.tgz'],
      ['--tarball', '/one', '--tarball', '/two'], ['--other', '/one'], ['--tarball', '/bad\nname']]) {
      expect(() => parseSmokeArguments(args, path.posix)).toThrow('usage');
    }
  });

  it('derives package identity, exact files, sizes and hashes from gzip/tar bytes', () => {
    const bytes = archive([{ name: 'package/README.md', body: '# Fixture\n' }]);
    const result = inspectPackageArchive(bytes, expected);
    expect(result).toMatchObject({
      ...expected, size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    });
    expect(result.files.map((file: { path: string }) => file.path)).toEqual(['package.json', 'README.md']);
    expect(result.unpackedSize).toBe(Buffer.byteLength(JSON.stringify(expected)) + 10);
  });

  it('supports bounded local PAX path metadata without extracting its header', () => {
    const bytes = archive([
      { name: 'PaxHeader/README', type: 'x', body: pax('path', 'package/docs/a long guide.md') },
      { name: 'package/ignored-name', body: '# Long guide\n' }
    ]);
    expect(inspectPackageArchive(bytes, expected).files.map((file: { path: string }) => file.path))
      .toEqual(['package.json', 'docs/a long guide.md']);
  });

  it.each([
    { name: 'other-package', version: expected.version },
    { name: expected.name, version: '9.9.9' },
    { name: expected.name },
    null
  ])('rejects missing or mismatched package identity before installation: %j', metadata => {
    expect(() => inspectPackageArchive(archive([], metadata), expected)).toThrow(/name\/version|package.json/);
  });

  it.each([
    'package/../escape', '/package/README.md', 'package/a\\escape', 'package/C:escape',
    'package/CON.txt', 'package/trailing.', 'package/a//b'
  ])('rejects unsafe or non-portable member %s', name => {
    expect(() => inspectPackageArchive(archive([{ name, body: 'unsafe' }]), expected)).toThrow('tar path');
  });

  it.each(['1', '2', '3', '4', '6', 'g', 'L'])('rejects links and unsupported special entry type %s', type => {
    expect(() => inspectPackageArchive(archive([{ name: 'package/link', type }]), expected)).toThrow('forbidden');
  });

  it('rejects duplicate, case-alias, file/directory, privileged-mode and PAX override ambiguity', () => {
    const cases: Entry[][] = [
      [{ name: 'package/package.json', body: '{}' }],
      [{ name: 'package/README.md' }, { name: 'package/readme.md' }],
      [{ name: 'package/docs/child' }, { name: 'package/docs' }],
      [{ name: 'package/file', mode: 0o4755 }],
      [{ name: 'PaxHeader/entry', type: 'x', body: pax('linkpath', '../../outside') }],
      [{ name: 'PaxHeader/entry', type: 'x', body: pax('path', 'package/README.md') }],
      [{ name: 'PaxHeader/entry', type: 'x', body: pax('path', 'package/a') + pax('path', 'package/b') },
        { name: 'package/entry' }]
    ];
    for (const entries of cases) expect(() => inspectPackageArchive(archive(entries), expected)).toThrow('Invalid package smoke artifact');
  });

  it('rejects bad gzip, checksum, truncation, trailing content and decompression bombs', () => {
    expect(() => inspectPackageArchive(Buffer.from('not gzip'), expected)).toThrow('gzip');
    const entry = record({ name: 'package/package.json', body: JSON.stringify(expected) });
    const checksumMismatch = Buffer.from(entry);
    checksumMismatch[2] ^= 1;
    for (const tar of [
      Buffer.concat([checksumMismatch, Buffer.alloc(1024)]),
      entry.subarray(0, 600),
      Buffer.concat([entry, Buffer.alloc(512)]),
      Buffer.concat([entry, Buffer.alloc(1024), Buffer.from('unexpected trailer')])
    ]) expect(() => inspectPackageArchive(gzipSync(tar), expected)).toThrow('Invalid package smoke artifact');
    expect(() => inspectPackageArchive(gzipSync(Buffer.alloc(32 * 1024 * 1024 + 1), { level: 1 }), expected)).toThrow('oversized');
  });

  it('uses an immutable byte-for-byte snapshot in exact mode without calling npm at all', async () => {
    const f = await fixture();
    const runNpm = vi.fn(() => { throw new Error('npm must not be called to inspect an exact archive'); });
    const selected = await prepareSmokeArtifact({ ...f, runNpm });
    expect(runNpm).not.toHaveBeenCalled();
    expect(selected.packResult).toMatchObject(expected);
    expect(selected.tarballPath).not.toBe(f.tarball);
    expect(await readFile(selected.tarballPath)).toEqual(f.bytes);
    await selected.verifyUnchanged();
    expect(await readFile(f.tarball)).toEqual(f.bytes);
    await writeFile(f.tarball, archive([{ name: 'package/new-file' }]));
    await expect(selected.verifyUnchanged()).rejects.toThrow('changed after inspection');
  });

  it('packs exactly once in default mode and verifies returned metadata against actual bytes', async () => {
    const f = await fixture();
    const filename = 'msn-control-liftoff-1.2.3.tgz';
    const metadata = inspectPackageArchive(f.bytes, expected);
    const runNpm = vi.fn((args: string[]) => {
      expect(args).toEqual(['pack', '--json', '--pack-destination', f.packDirectory]);
      writeFileSync(path.join(f.packDirectory, filename), f.bytes, { mode: 0o600 });
      return { stdout: JSON.stringify({ [expected.name]: { ...metadata, filename } }) };
    });
    const selected = await prepareSmokeArtifact({ ...f, tarball: undefined, runNpm });
    expect(runNpm).toHaveBeenCalledTimes(1);
    await selected.verifyUnchanged();
    const other = await fixture();
    const badNpm = () => {
      writeFileSync(path.join(other.packDirectory, filename), other.bytes, { mode: 0o600 });
      return { stdout: JSON.stringify([{ ...metadata, filename, files: [] }]) };
    };
    await expect(prepareSmokeArtifact({ ...other, tarball: undefined, runNpm: badNpm })).rejects.toThrow('metadata differs');
  });

  it('rejects missing files, directory inputs, hardlinks and changed snapshots', async () => {
    const f = await fixture();
    const runNpm = vi.fn();
    await expect(prepareSmokeArtifact({ ...f, tarball: path.join(f.root, 'missing.tgz'), runNpm })).rejects.toThrow();
    await expect(prepareSmokeArtifact({ ...f, tarball: f.root, runNpm })).rejects.toThrow('ownership/type/size');
    const alias = path.join(f.root, 'hardlink.tgz');
    await link(f.tarball, alias);
    await expect(prepareSmokeArtifact({ ...f, runNpm })).rejects.toThrow('ownership/type/size');
    await rm(alias);
    const selected = await prepareSmokeArtifact({ ...f, runNpm });
    await chmod(selected.tarballPath, 0o600);
    await writeFile(selected.tarballPath, 'changed');
    await expect(selected.verifyUnchanged()).rejects.toThrow('changed after inspection');
    expect(await readFile(f.tarball)).toEqual(f.bytes);
    expect(runNpm).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('rejects writable-by-others and symlink archive paths', async () => {
    const f = await fixture();
    await chmod(f.tarball, 0o666);
    await expect(prepareSmokeArtifact({ ...f, runNpm: vi.fn() })).rejects.toThrow('ownership');
    await chmod(f.tarball, 0o600);
    const alias = path.join(f.root, 'alias.tgz');
    await symlink(f.tarball, alias);
    await expect(prepareSmokeArtifact({ ...f, tarball: alias, runNpm: vi.fn() })).rejects.toThrow('ownership');
    const directoryAlias = path.join(f.root, 'linked directory');
    await symlink(f.packDirectory, directoryAlias);
    await writeFile(path.join(f.packDirectory, 'candidate.tgz'), f.bytes);
    await expect(prepareSmokeArtifact({ ...f, tarball: path.join(directoryAlias, 'candidate.tgz'), runNpm: vi.fn() }))
      .rejects.toThrow('traverses a link');
  });

  it('checks installed contents against the actual inspected archive', async () => {
    const f = await fixture();
    const inspected = inspectPackageArchive(f.bytes, expected);
    await writeFile(path.join(f.packageRoot, 'README.md'), '# Fixture\n');
    await verifyInstalledArchiveFiles(f.packageRoot, inspected.files);
    await writeFile(path.join(f.packageRoot, 'README.md'), 'replacement');
    await expect(verifyInstalledArchiveFiles(f.packageRoot, inspected.files)).rejects.toThrow('installed file differs');
  });

  it('routes the executable --tarball path through existing file assertions without implicit repacking', async () => {
    const f = await fixture();
    const actualPackage = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
    const bytes = archive([{ name: 'package/README.md', body: '# Fixture\n' }], actualPackage);
    await writeFile(f.tarball, bytes);
    const marker = path.join(f.root, 'npm-was-called');
    const guard = path.join(f.root, 'npm-guard.mjs');
    await writeFile(guard, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '));\nprocess.exit(99);\n`);
    const child = spawnSync(process.execPath, ['scripts/package-smoke-test.mjs', '--tarball', f.tarball], {
      cwd: process.cwd(), env: { ...process.env, npm_execpath: guard, LIFTOFF_TELEMETRY: '0' },
      encoding: 'utf8', timeout: 30_000, shell: false
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('Packed package is missing CONTRIBUTING.md');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(f.tarball)).toEqual(bytes);
  });
});
