const stages = ['spawn', 'standard-fds', 'socket-bind', 'configuration', 'address-output', 'unclassified'];
const reasons = ['native-exec', 'dev-null-open', 'dev-null-dup', 'unix-bind', 'config-read', 'early-exit', 'no-guid', 'unclassified'];
const errors = ['EACCES', 'EPERM', 'ENOENT', 'ENOEXEC', 'ENOMEM', 'ENOSPC', 'EROFS',
  'EMFILE', 'ENFILE', 'ENAMETOOLONG', 'EADDRINUSE', 'EINVAL', 'unclassified'];
const signals = ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGPIPE'];
const messages = [
  ['Too many open files in system', 'ENFILE'], ['Too many open files', 'EMFILE'],
  ['Permission denied', 'EACCES'], ['Operation not permitted', 'EPERM'],
  ['No such file or directory', 'ENOENT'], ['Read-only file system', 'EROFS'],
  ['Address already in use', 'EADDRINUSE'], ['File name too long', 'ENAMETOOLONG'],
  ['Cannot allocate memory', 'ENOMEM'], ['No space left on device', 'ENOSPC'],
  ['Invalid argument', 'EINVAL']
];
export function safeNativeErrno(value) {
  return errors.includes(value) ? value : 'unclassified';
}

/** Copy only finite diagnostic enums/numbers; never return provider text or paths. */
export function safeBusDiagnostic(value) {
  if (!value || typeof value !== 'object') return null;
  return Object.freeze({
    stage: stages.includes(value.stage) ? value.stage : 'unclassified',
    reason: reasons.includes(value.reason) ? value.reason : 'unclassified',
    errno: safeNativeErrno(value.errno),
    exitCode: Number.isSafeInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255 ? value.exitCode : null,
    signal: signals.includes(value.signal) ? value.signal : null,
    addressObserved: value.addressObserved === true,
    nullReadWrite: value.nullReadWrite === 'allowed' ? 'allowed' : safeNativeErrno(value.nullReadWrite)
  });
}

/** Consumes an owned stderr copy. Error messages are classification inputs only. */
export function consumeBusStartupDiagnostic(stderr, process) {
  let stage = 'address-output', reason = process.closed ? 'early-exit' : 'no-guid', errno = 'unclassified';
  try {
    if (process.spawnError) {
      stage = 'spawn'; reason = 'native-exec'; errno = safeNativeErrno(process.spawnError);
    } else {
      const text = Buffer.from(stderr.buffer, stderr.byteOffset, stderr.byteLength).toString('utf8');
      const standard = /^dbus-daemon(?:\[[0-9]+\])?: fatal error setting up standard fds: (Failed to open \/dev\/null|Failed to dup2 \/dev\/null onto a standard fd): ([^\r\n]*)$/mu.exec(text);
      if (standard) {
        stage = 'standard-fds';
        reason = standard[1] === 'Failed to open /dev/null' ? 'dev-null-open' : 'dev-null-dup';
        errno = messages.find(([message]) => standard[2] === message)?.[1] ?? 'unclassified';
      } else if (/Failed to bind socket/u.test(text)) {
        stage = 'socket-bind'; reason = 'unix-bind';
        errno = messages.find(([message]) => text.trimEnd().endsWith(message))?.[1] ?? 'unclassified';
      } else if (/Failed to open.*configuration|Failed to load configuration/u.test(text)) {
        stage = 'configuration'; reason = 'config-read';
        errno = messages.find(([message]) => text.trimEnd().endsWith(message))?.[1] ?? 'unclassified';
      }
    }
    return safeBusDiagnostic({ ...process, stage, reason, errno });
  } finally { stderr.fill(0); }
}
