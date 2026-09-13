// The protocol is pinned to OpenTofu 1.12.6 internal/flock and statemgr.
// lockf uses POSIX fcntl record locks, NOT BSD flock. The holder must never
// open/close another descriptor to its state inode: POSIX would drop its locks.
export const posixStateLockProgram = String.raw`
import base64, datetime, errno, fcntl, hashlib, json, os, select, signal, stat, sys, time

MAX = 32 * 1024 * 1024
fd = None
info_path = None
info_bytes = None
current_digest = None

class Blocked(Exception):
    def __init__(self, code):
        self.code = code

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()

def version(s):
    value = {"dev": str(s.st_dev), "ino": str(s.st_ino), "size": str(s.st_size),
             "mtime": str(s.st_mtime_ns), "ctime": str(s.st_ctime_ns)}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

def read_state():
    s = os.fstat(fd)
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_size > MAX:
        raise Blocked("unsafe-path")
    pieces = []
    offset = 0
    while offset < s.st_size:
        part = os.pread(fd, min(65536, s.st_size - offset), offset)
        if not part:
            raise Blocked("stale-state")
        pieces.append(part)
        offset += len(part)
    return b"".join(pieces)

def assert_path():
    s = os.fstat(fd)
    p = os.lstat(target)
    if not stat.S_ISREG(p.st_mode) or p.st_nlink != 1 or (s.st_dev, s.st_ino) != (p.st_dev, p.st_ino):
        raise Blocked("lock-lost")
    if os.path.realpath(os.path.dirname(target)) != os.path.dirname(target):
        raise Blocked("lock-lost")
    with open(info_path, "rb") as marker:
        if marker.read(8193) != info_bytes:
            raise Blocked("lock-lost")
    # Reassert on the SAME descriptor. No additional state fd is opened.
    fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB, 0, 0, os.SEEK_SET)
    return s

def terminate(_number, _frame):
    raise Blocked("cancelled")

signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)

try:
    if sys.platform != "darwin":
        raise Blocked("unsupported-native-platform")
    if sys.version_info[:2] != (3, 14):
        raise Blocked("native-lock-provider-required")
    opening = sys.stdin.buffer.readline(16385)
    if len(opening) > 16384:
        raise Blocked("storage-limit")
    request = json.loads(opening)
    target = request["path"]
    operation = request["operationId"]
    if not os.path.isabs(target) or os.path.realpath(os.path.dirname(target)) != os.path.dirname(target):
        raise Blocked("unsafe-path")
    before = os.lstat(target)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.getuid() or before.st_mode & 0o077:
        raise Blocked("unsafe-path")
    fd = os.open(target, os.O_RDWR | os.O_NOFOLLOW)
    try:
        fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB, 0, 0, os.SEEK_SET)
    except OSError as error:
        if error.errno in (errno.EACCES, errno.EAGAIN):
            raise Blocked("lock-unavailable")
        raise
    held = os.fstat(fd)
    if (held.st_dev, held.st_ino) != (before.st_dev, before.st_ino) or version(held) != request["expectedVersion"]:
        raise Blocked("stale-state")
    current_digest = hashlib.sha256(read_state()).hexdigest()
    name = os.path.basename(target)
    if name.startswith("."):
        name = name[1:]
    info_path = os.path.join(os.path.dirname(target), "." + name + ".lock.info")
    info = {"ID": operation, "Operation": "liftoff-state-migration", "Info": "Protected existing-inode POSIX lock",
            "Who": "liftoff:" + str(os.getuid()), "Version": "1.12.6",
            "Created": datetime.datetime.now(datetime.timezone.utc).isoformat(), "Path": target,
            "LiftoffProtocol": "opentofu-1.12.6-posix-fcntl"}
    info_bytes = json.dumps(info, sort_keys=True, separators=(",", ":")).encode()
    try:
        marker_fd = os.open(info_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        # An unknown/stale marker is not permission to delete somebody else's record.
        info_bytes = None
        raise Blocked("lock-unavailable")
    try:
        os.write(marker_fd, info_bytes)
        os.fsync(marker_fd)
    finally:
        os.close(marker_fd)
    emit({"ok": True, "version": version(held)})
    deadline = time.monotonic() + min(int(request.get("holdSeconds", 1800)), 1800)
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise Blocked("timeout")
        ready, _, _ = select.select([sys.stdin.buffer], [], [], remaining)
        if not ready:
            raise Blocked("timeout")
        line = sys.stdin.buffer.readline(MAX * 2 + 1)
        if not line:
            break
        if len(line) > MAX * 2:
            raise Blocked("storage-limit")
        command = json.loads(line)
        action = command["action"]
        if action == "release":
            emit({"ok": True})
            break
        observed = assert_path()
        if action == "assert":
            emit({"ok": True, "version": version(observed)})
            continue
        if action != "replace":
            raise Blocked("unsupported-local-state-operation")
        if version(observed) != command["expectedVersion"]:
            raise Blocked("stale-state")
        prior = read_state()
        if hashlib.sha256(prior).hexdigest() != current_digest:
            raise Blocked("stale-state")
        candidate = base64.b64decode(command["bytes"], validate=True)
        if not candidate or len(candidate) > MAX:
            raise Blocked("storage-limit")
        old_state, new_state = json.loads(prior), json.loads(candidate)
        if old_state.get("version") != 4 or new_state.get("version") != 4:
            raise Blocked("unsupported-state")
        if old_state.get("lineage") != new_state.get("lineage") or new_state.get("serial", -1) < old_state.get("serial", 0):
            raise Blocked("stale-state")
        assert_path()
        # OpenTofu also writes in place. Rename/unlink would replace the inode
        # and let a second native writer bypass the lock. This is NOT atomic.
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
        try:
            os.ftruncate(fd, 0)
            offset = 0
            while offset < len(candidate):
                count = os.pwrite(fd, candidate[offset:], offset)
                if count <= 0:
                    raise Blocked("operation-failed")
                offset += count
            os.fsync(fd)
            current_digest = hashlib.sha256(candidate).hexdigest()
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        emit({"ok": True, "version": version(os.fstat(fd)), "digest": current_digest})
except Blocked as error:
    emit({"ok": False, "code": error.code})
except FileNotFoundError:
    emit({"ok": False, "code": "unsupported-local-state-operation"})
except Exception:
    emit({"ok": False, "code": "operation-failed"})
finally:
    if fd is not None:
        if info_path and info_bytes:
            try:
                entry = os.lstat(info_path)
                if stat.S_ISREG(entry.st_mode) and entry.st_nlink == 1:
                    with open(info_path, "rb") as marker:
                        matches = marker.read(8193) == info_bytes
                    if matches:
                        os.unlink(info_path)
            except Exception:
                pass
        try:
            fcntl.lockf(fd, fcntl.LOCK_UN, 0, 0, os.SEEK_SET)
        finally:
            os.close(fd)
`;
