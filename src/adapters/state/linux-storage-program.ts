// Read-only UAPI audited at Linux adc218676eef25575469234709c2d87185ca223a.
// No contents reads, key provisioning, policy changes, mounts or permission repair.
export const linuxStorageDirectoryProgram = String.raw`
import ctypes, errno, fcntl, hashlib, json, os, stat, struct, sys, unicodedata

class Blocked(Exception):
    def __init__(self, code):
        self.code = code

def require(condition, code):
    if not condition:
        raise Blocked(code)

def digest(value):
    return hashlib.sha256(value).hexdigest()

held = []

def retain(fd):
    held.append(fd)
    return fd

def stat_identity(fd):
    s = os.fstat(fd)
    return {"device": str(s.st_dev), "inode": str(s.st_ino), "ctime": str(s.st_ctime_ns),
            "size": str(s.st_size), "uid": s.st_uid, "gid": s.st_gid,
            "mode": stat.S_IMODE(s.st_mode), "links": s.st_nlink,
            "kind": "directory" if stat.S_ISDIR(s.st_mode) else "regular-file" if stat.S_ISREG(s.st_mode) else "unsupported"}

class Statfs(ctypes.Structure):
    _fields_ = [("type", ctypes.c_long), ("bsize", ctypes.c_long),
                ("blocks", ctypes.c_ulong), ("bfree", ctypes.c_ulong), ("bavail", ctypes.c_ulong),
                ("files", ctypes.c_ulong), ("ffree", ctypes.c_ulong), ("fsid", ctypes.c_int * 2),
                ("namelen", ctypes.c_long), ("frsize", ctypes.c_long), ("flags", ctypes.c_long),
                ("spare", ctypes.c_long * 4)]

def filesystem(fd):
    result = Statfs()
    if libc.syscall(ctypes.c_long(statfs_number), ctypes.c_int(fd), ctypes.byref(result)) != 0:
        raise Blocked("unsupported-encryption")
    return (result.type, result.bsize, bytes(result.fsid).hex(), result.frsize, result.flags)

def kernel_file(parent, name, maximum):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    try:
        require(filesystem(fd)[0] == 0x9fa0, "unqualified-combination")
        chunks = []
        length = 0
        while True:
            data = os.read(fd, min(65536, maximum + 1 - length))
            if not data:
                break
            length += len(data)
            require(length <= maximum, "storage-limit")
            chunks.append(data)
        return b"".join(chunks)
    finally:
        os.close(fd)

def mount_id(fd):
    raw = kernel_file(fdinfo, str(fd), 16384)
    fields = [line.split(b":", 1)[1].strip() for line in raw.splitlines() if line.startswith(b"mnt_id:")]
    require(len(fields) == 1 and fields[0].isdigit(), "unqualified-combination")
    return fields[0].decode("ascii")

def walk(target):
    components = target.split("/")[1:]
    require(1 <= len(components) <= 128, "unsafe-path")
    fd = retain(os.open("/", os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC))
    chain = [(fd, stat_identity(fd), mount_id(fd))]
    for index, name in enumerate(components):
        flags = os.O_PATH if index == len(components) - 1 else (os.O_PATH | os.O_DIRECTORY)
        fd = retain(os.open(name, flags | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd))
        chain.append((fd, stat_identity(fd), mount_id(fd)))
    return fd, chain

def selected_mount(raw, fd, mid):
    rows = []
    for line in raw.splitlines():
        parts = line.split(b" ")
        separator = parts.index(b"-")
        require(separator >= 6 and len(parts) >= separator + 4, "unqualified-combination")
        rows.append((parts, separator, line))
    selected = [row for row in rows if row[0][0].decode("ascii") == mid]
    require(len(selected) == 1, "unqualified-combination")
    parts, separator, line = selected[0]
    s = os.fstat(fd)
    device = (str(os.major(s.st_dev)) + ":" + str(os.minor(s.st_dev))).encode("ascii")
    require(parts[2] == device and parts[3] == b"/" and parts[separator + 1] == b"ext4",
            "unsupported-encryption")
    require(sum(row[0][2] == device for row in rows) == 1, "unqualified-combination")
    options = parts[5].split(b",") + parts[separator + 3].split(b",")
    require(not any(option.split(b"=", 1)[0] == b"test_dummy_encryption" for option in options),
            "unsupported-encryption")
    require(not any(option == b"dax" or option.startswith(b"dax=") and option != b"dax=never"
                    for option in options), "unsupported-encryption")
    return line

def policy(fd):
    # UAPI command size is 9, while the supplied v2 buffer is 8 + 24 bytes.
    value = bytearray(struct.pack("<Q", 24) + bytes(24))
    fcntl.ioctl(fd, 0xc0096616, value, True)
    require(struct.unpack_from("<Q", value)[0] == 24 and value[8:11] == bytes((2, 1, 4))
            and value[11] <= 3 and value[12:16] == bytes(4), "unsupported-encryption")
    return bytes(value)

def key_status(fd, selected):
    value = bytearray(128)
    struct.pack_into("<I", value, 0, 2)
    value[8:24] = selected[16:32]
    fcntl.ioctl(fd, 0xc080661a, value, True)
    require(struct.unpack_from("<I", value, 0)[0] == 2 and value[4:8] == bytes(4)
            and value[8:24] == selected[16:32] and value[24:64] == bytes(40)
            and value[76:] == bytes(52), "unqualified-combination")
    status, flags, users = struct.unpack_from("<III", value, 64)
    require(status == 2, "key-unavailable")
    require(flags == 1 and users >= 1, "ownership-mismatch")
    return bytes(value)

try:
    require(sys.platform == "linux", "unsupported-native-platform")
    require(sys.implementation.name == "cpython" and sys.version_info[:2] == (3, 14)
            and sys.byteorder == "little" and ctypes.sizeof(ctypes.c_void_p) == 8
            and ctypes.sizeof(ctypes.c_long) == 8 and ctypes.sizeof(Statfs) == 120, "unqualified-combination")
    machine = os.uname().machine
    require(machine in ("x86_64", "aarch64"), "unqualified-combination")
    statfs_number = 138 if machine == "x86_64" else 44
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    require(len(sys.argv) == 2 and len(sys.argv[1].encode()) <= 8192, "invalid-binding")
    request = json.loads(sys.argv[1])
    require(set(request) == {"path", "kind", "principalUid"}, "invalid-binding")
    target = request["path"]
    require(isinstance(target, str) and 1 < len(target.encode()) <= 4095 and target.startswith("/")
            and not target.endswith("/") and os.path.normpath(target) == target
            and unicodedata.normalize("NFC", target) == target
            and not any(ord(c) < 32 or ord(c) == 127 or c == "\\" for c in target), "unsafe-path")
    require(request["kind"] == "directory", "invalid-binding")
    require(isinstance(request["principalUid"], int) and not isinstance(request["principalUid"], bool)
            and request["principalUid"] == os.getuid() == os.geteuid() and os.getuid() > 0, "ownership-mismatch")
    proc = retain(os.open("/proc", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC))
    require(filesystem(proc)[0] == 0x9fa0, "unqualified-combination")
    require(os.readlink("self", dir_fd=proc) == str(os.getpid()), "unqualified-combination")
    proc_self = retain(os.open(str(os.getpid()), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=proc))
    require(filesystem(proc_self)[0] == 0x9fa0, "unqualified-combination")
    status = kernel_file(proc_self, "status", 65536)
    fields = dict(line.split(b":", 1) for line in status.splitlines() if b":" in line)
    require([int(value) for value in fields[b"Uid"].split()] == [os.getuid()] * 4, "ownership-mismatch")
    require(all(int(fields[name].strip(), 16) == 0 for name in (b"CapEff", b"CapPrm", b"CapInh", b"CapAmb")), "ownership-mismatch")
    fdinfo = retain(os.open("fdinfo", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=proc_self))
    proc_fds = retain(os.open("fd", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=proc_self))
    require(filesystem(fdinfo)[0] == 0x9fa0 and filesystem(proc_fds)[0] == 0x9fa0, "unqualified-combination")
    namespace_fd = retain(os.open("ns/mnt", os.O_RDONLY | os.O_CLOEXEC, dir_fd=proc_self))
    require(filesystem(namespace_fd)[0] == 0x6e736673, "unqualified-combination")
    namespace = os.fstat(namespace_fd)
    mounts = kernel_file(proc_self, "mountinfo", 1024 * 1024)
    anchor, ancestry = walk(target)
    identity = stat_identity(anchor)
    mid = mount_id(anchor)
    require(identity["kind"] == request["kind"], "unsafe-path")
    require(identity["uid"] == os.getuid(), "ownership-mismatch")
    require(identity["mode"] in (0o500, 0o700), "unsafe-path")
    fs = filesystem(anchor)
    require(fs[0] == 0xef53 and fs[1] in (1024, 2048, 4096, 8192, 16384, 32768, 65536), "unsupported-encryption")
    mount = selected_mount(mounts, anchor, mid)
    # Reopen only the retained, type/owner-checked object via authentic procfs.
    # This fixed kernel fd link is not a caller-supplied symlink or pathname fallback.
    fd = retain(os.open(str(anchor), os.O_RDONLY | os.O_DIRECTORY | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=proc_fds))
    require(stat_identity(fd) == identity and mount_id(fd) == mid, "unsafe-path")
    selected = policy(fd)
    status = key_status(fd, selected)
    require(policy(fd) == selected and key_status(fd, selected) == status, "stale-state")
    require(filesystem(fd) == fs and stat_identity(fd) == identity and mount_id(fd) == mid, "stale-state")
    reopened, current = walk(target)
    require([(row[1], row[2]) for row in current] == [(row[1], row[2]) for row in ancestry], "unsafe-path")
    require(all(stat_identity(handle) == prior and mount_id(handle) == mount
                for handle, prior, mount in ancestry), "unsafe-path")
    require(kernel_file(proc_self, "mountinfo", 1024 * 1024) == mounts, "stale-state")
    current_namespace_fd = retain(os.open("ns/mnt", os.O_RDONLY | os.O_CLOEXEC, dir_fd=proc_self))
    current_namespace = os.fstat(current_namespace_fd)
    require(filesystem(current_namespace_fd)[0] == 0x6e736673
            and (current_namespace.st_dev, current_namespace.st_ino) == (namespace.st_dev, namespace.st_ino), "stale-state")
    require(policy(fd) == selected and key_status(fd, selected) == status
            and stat_identity(fd) == identity, "stale-state")
    identity["mountId"] = mid
    print(json.dumps({
        "path": target, "object": identity,
        "filesystem": {"type": "ext4", "magic": fs[0], "fsid": fs[2], "blockSize": fs[1],
                       "readOnly": bool(fs[4] & 1), "mountInfoDigest": digest(mounts), "mountRecordDigest": digest(mount),
                       "namespace": str(namespace.st_dev) + ":" + str(namespace.st_ino)},
        "ancestryDigest": digest(json.dumps([(row[1], row[2]) for row in ancestry], sort_keys=True, separators=(",", ":")).encode()),
        "policyHex": selected.hex(), "keyStatusHex": status.hex()
    }, separators=(",", ":")))
except Blocked as error:
    print(json.dumps({"blocked": error.code}, separators=(",", ":")))
except OSError as error:
    code = ("key-unavailable" if error.errno in (errno.ENOKEY, errno.EKEYREVOKED)
            else "unsupported-encryption" if error.errno in (errno.ENODATA, errno.ENOTTY, errno.EOPNOTSUPP, errno.EOVERFLOW, errno.EINVAL)
            else "unsafe-path" if error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP)
            else "access-denied" if error.errno in (errno.EACCES, errno.EPERM)
            else "operation-failed")
    print(json.dumps({"blocked": code}, separators=(",", ":")))
except Exception:
    print('{"blocked":"operation-failed"}')
finally:
    for fd in reversed(held):
        os.close(fd)
`;
