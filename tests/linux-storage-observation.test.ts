import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  decodeLinuxFscryptPolicy, decodeLinuxFscryptKeyStatus, linuxStorageInterfaceAudit,
  parseLinuxStorageDirectoryObservation
} from '../src/domain/repair/linux-storage-observation.js';
import {
  decodeLinuxStorageDirectoryReadback, hasNativeLinuxStorageDirectoryProvenance, LinuxFscryptDirectoryObserver
} from '../src/adapters/state/linux-storage-observer.js';
import { linuxStorageDirectoryProgram } from '../src/adapters/state/linux-storage-program.js';

const digest = (name: string) => canonicalSha256(name);
function policy() {
  const bytes = Buffer.alloc(32);
  bytes.writeBigUInt64LE(24n);
  bytes.set([2, 1, 4, 3], 8);
  bytes.fill(0xa5, 16);
  return bytes;
}
function keyStatus() {
  const bytes = Buffer.alloc(128);
  bytes.writeUInt32LE(2);
  bytes.fill(0xa5, 8, 24);
  bytes.writeUInt32LE(2, 64);
  bytes.writeUInt32LE(1, 68);
  bytes.writeUInt32LE(1, 72);
  return bytes;
}
const context = {
  path: '/private/observed', kind: 'directory' as const,
  hostRef: `native-host:${digest('host')}`, principalUid: 1001,
  architecture: 'x64' as const, observedAt: 1000
};
function readback() {
  return {
    path: context.path,
    object: {
      kind: 'directory', device: '2049', inode: '3', ctime: '4', size: '4096',
      uid: 1001, gid: 1001, mode: 0o700, links: 2, mountId: '31'
    },
    filesystem: {
      type: 'ext4', magic: 0xef53, fsid: '0102030405060708', blockSize: 4096, readOnly: false,
      mountInfoDigest: digest('mount namespace snapshot'), mountRecordDigest: digest('selected mount'), namespace: '4:44'
    },
    ancestryDigest: digest('retained descriptor chain'),
    policyHex: policy().toString('hex'), keyStatusHex: keyStatus().toString('hex')
  };
}
const decode = (value: unknown) => decodeLinuxStorageDirectoryReadback(Buffer.from(canonicalJson(value)), context);

describe('read-only Linux fscrypt interface audit, not protected-volume qualification', () => {
  it('pins exact public UAPI layouts and keeps the candidate scope explicitly per-object', () => {
    expect(linuxStorageInterfaceAudit).toMatchObject({
      kernelSourceCommit: 'adc218676eef25575469234709c2d87185ca223a',
      kernelSourceTag: 'v6.12', filesystem: 'ext4', ABI: 'little-endian-LP64',
      ioctls: {
        getPolicy: { request: 0xc0096616, bufferBytes: 32, policyBytes: 24 },
        getKeyStatus: { request: 0xc080661a, bufferBytes: 128, identifierType: 2 }
      },
      coverage: 'selected-existing-directory-policy-only', volumeEncryption: 'not-observed',
      backingDeviceLocality: 'not-observed', keyCustody: 'not-observed', descendantCoverage: 'not-observed',
      authorization: 'none', nativeQualification: 'required', readiness: false
    });
  });

  it('uses retained no-follow anchors and only read-only policy/status queries', () => {
    expect(linuxStorageDirectoryProgram).toContain('os.O_PATH');
    expect(linuxStorageDirectoryProgram).toContain('os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd');
    expect(linuxStorageDirectoryProgram).toContain('os.open(str(anchor), os.O_RDONLY | os.O_DIRECTORY | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=proc_fds)');
    expect(linuxStorageDirectoryProgram).toContain('require(request["kind"] == "directory"');
    expect(linuxStorageDirectoryProgram).toContain('stat_identity(fd) == identity and mount_id(fd) == mid');
    expect(linuxStorageDirectoryProgram).toContain('policy(fd) == selected and key_status(fd, selected) == status');
    expect(linuxStorageDirectoryProgram).toContain('kernel_file(proc_self, "mountinfo", 1024 * 1024) == mounts');
    expect(linuxStorageDirectoryProgram).toContain('test_dummy_encryption');
    expect(linuxStorageDirectoryProgram).not.toMatch(/O_CREAT|O_TRUNC|O_RDWR|O_WRONLY|chmod\(|setxattr\(|subprocess|(?<!selected_)mount\(|keyctl|FS_IOC_ADD|FS_IOC_REMOVE|sys\.stdin/u);
    expect(linuxStorageDirectoryProgram.match(/fcntl\.ioctl\(/gu)).toHaveLength(2);
    expect(linuxStorageDirectoryProgram).not.toMatch(/os\.read\(fd,\s*(?:size|identity)|with open\(target/u);
  });

  if (process.platform !== 'linux') {
    it('refuses native observation before inspecting a supplied object or spawning a helper on this host', async () => {
      const observer = new LinuxFscryptDirectoryObserver();
      await expect(observer.observe({
        python: { path: '/must-not-run', sha256: 'a'.repeat(64) }, path: '/must-not-read', kind: 'directory'
      })).rejects.toMatchObject({ code: 'unsupported-native-platform' });
      await observer.quiesce();
    });
  }
});

describe('fscrypt UAPI decoding using synthetic metadata bytes only', () => {
  it.each([0, 1, 2, 3])('decodes registered v2 padding flag %i without treating the key identifier as key material', (flags) => {
    const bytes = policy(); bytes[11] = flags;
    const result = decodeLinuxFscryptPolicy(bytes);
    expect(result).toEqual({
      version: 2, contentsMode: 1, filenamesMode: 4, flags, log2DataUnitSize: 0, keyIdentifier: 'a5'.repeat(16)
    });
    expect(decodeLinuxFscryptKeyStatus(keyStatus(), result)).toEqual({ status: 'present', addedByCurrentFsUid: true, userCount: 1 });
  });

  it.each([
    [8, 0], [8, 1], [8, 3], [9, 9], [10, 10], [11, 4], [11, 8], [11, 16], [11, 255], [12, 12], [13, 1], [15, 1]
  ])('rejects unsupported policy byte %i=%i', (offset, value) => {
    const bytes = policy(); bytes[offset!] = value!;
    expect(() => decodeLinuxFscryptPolicy(bytes)).toThrow('unsupported-encryption');
  });

  it.each([0, 12, 25])('rejects returned policy size %i without legacy fallback', (size) => {
    const bytes = policy(); bytes.writeBigUInt64LE(BigInt(size));
    expect(() => decodeLinuxFscryptPolicy(bytes)).toThrow('unsupported-encryption');
  });

  it.each([0, 1, 3, 4])('rejects unavailable, incompletely removed or unknown key status %i', (status) => {
    const bytes = keyStatus(); bytes.writeUInt32LE(status, 64);
    expect(() => decodeLinuxFscryptKeyStatus(bytes, decodeLinuxFscryptPolicy(policy()))).toThrow('key-unavailable');
  });

  it.each([[68, 0], [68, 2], [68, 3], [72, 0]])('rejects missing/unknown current-fsuid claim fields %i=%i', (offset, value) => {
    const bytes = keyStatus(); bytes.writeUInt32LE(value!, offset!);
    expect(() => decodeLinuxFscryptKeyStatus(bytes, decodeLinuxFscryptPolicy(policy()))).toThrow('ownership-mismatch');
  });

  it.each([0, 4, 8, 24, 40, 76, 127])('rejects changed key specifier or nonzero reserved byte %i', (offset) => {
    const bytes = keyStatus(); bytes[offset] ^= 1;
    expect(() => decodeLinuxFscryptKeyStatus(bytes, decodeLinuxFscryptPolicy(policy()))).toThrow('artifact-integrity');
  });

  it('rejects all truncated and overlong ioctl layouts', () => {
    for (let length = 0; length < 32; length++)
      expect(() => decodeLinuxFscryptPolicy(policy().subarray(0, length))).toThrow('unsupported-encryption');
    for (let length = 0; length < 128; length++)
      expect(() => decodeLinuxFscryptKeyStatus(keyStatus().subarray(0, length), decodeLinuxFscryptPolicy(policy())))
        .toThrow('key-unavailable');
    expect(() => decodeLinuxFscryptPolicy(Buffer.alloc(33))).toThrow('unsupported-encryption');
  });
});

describe('per-object observation records cannot supply legacy macOS volume authority', () => {
  it('roundtrips bounded metadata without minting native provenance, volume coverage or readiness', () => {
    const observed = decode(readback());
    expect(parseLinuxStorageDirectoryObservation(JSON.parse(canonicalJson(observed)))).toEqual(observed);
    expect(hasNativeLinuxStorageDirectoryProvenance(observed)).toBe(false);
    expect(Object.isFrozen(observed)).toBe(true);
    expect(observed).toMatchObject({
      volumeEncryption: 'not-observed', descendantCoverage: 'not-observed', keyCustody: 'not-observed',
      backingDeviceLocality: 'not-observed', authorization: 'none', readiness: false
    });
    expect(Object.hasOwn(observed, 'encryptedVolume')).toBe(false);
    expect(Object.hasOwn(observed, 'privateAccess')).toBe(false);
    expect(Object.hasOwn(observed, 'expiresAt')).toBe(false);
    expect('verify' in new LinuxFscryptDirectoryObserver()).toBe(false);
  });

  it.each([
    { encryptedVolume: true }, { privateAccess: true }, { storageClass: 'protected-state-workspace' },
    { volumeEncryption: 'verified' }, { readiness: true }, { nativeQualification: 'verified' },
    { authorization: 'state-write' }, { descendantCoverage: 'encrypted-tree' }, { rawKey: 'PRIVATE' }
  ])('rejects expanded claims and unsupported fields %#', (change) => {
    expect(() => parseLinuxStorageDirectoryObservation({ ...decode(readback()), ...change })).toThrow();
  });

  it.each([
    { kind: 'directory', mode: 0o755 }, { kind: 'directory', uid: 1002 },
    { kind: 'regular-file', mode: 0o600, links: 2 }, { kind: 'symbolic-link', mode: 0o600 }
  ])('refuses foreign or nonprivate object identity %#', (change) => {
    const value = readback();
    expect(() => decode({ ...value, object: { ...value.object, ...change } })).toThrow();
  });

  it.each([
    { type: 'overlay' }, { magic: 0x794c7630 }, { blockSize: 123 }, { fsid: 'unknown' }, { namespace: 'unknown' }
  ])('refuses unsupported/inconsistent filesystem observations %#', (change) => {
    const value = readback();
    expect(() => decode({ ...value, filesystem: { ...value.filesystem, ...change } })).toThrow();
  });

  it('rejects mismatched request identity, duplicate JSON and raw provider diagnostics', () => {
    const value = readback();
    expect(() => decode({ ...value, path: '/other/object' })).toThrow('artifact-integrity');
    expect(() => decode({ ...value, rawDiagnostic: 'PRIVATE' })).toThrow('artifact-integrity');
    const duplicate = canonicalJson(value).replace('"policyHex":', `"policyHex":"${value.policyHex}","policyHex":`);
    expect(() => decodeLinuxStorageDirectoryReadback(Buffer.from(duplicate), context)).toThrow('artifact-integrity');
    expect(() => decode({ blocked: 'key-unavailable', message: 'PRIVATE' })).toThrow('artifact-integrity');
    expect(() => decode({ blocked: 'PRIVATE' })).toThrow('operation-failed');
  });

  it.each(['unsupported-encryption', 'key-unavailable', 'stale-state', 'unsafe-path', 'ownership-mismatch'])(
    'retains the fixed native refusal %s without fabricating an observation', (blocked) => {
      expect(() => decode({ blocked })).toThrow(blocked);
    }
  );
});
