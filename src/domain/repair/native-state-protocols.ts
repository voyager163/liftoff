// Existing native receipts bind this exact tuple's canonical digest.
export const posixNativeStateProtocol = Object.freeze({
  version: 'opentofu-1.12.6-posix-fcntl' as const,
  tofuVersion: '1.12.6' as const,
  sourceCommit: 'b4305e5a5dd2fb79a27897ae30784a181d3a26cb',
  lockSource: 'internal/flock/filesystem_lock_unix.go',
  lockBlob: 'c396e445a0eede26b32b97068216fe3691070d9f',
  stateSource: 'internal/states/statemgr/filesystem.go',
  stateBlob: '3f01209ea1635c9cad5f499f4f08ce356aef9a4c',
  lockOperation: 'F_SETLK/F_WRLCK/start=0/length=0',
  writeOperation: 'seek/truncate/write/sync on the same open inode'
});
