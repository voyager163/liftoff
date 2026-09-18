// ABI 3 UAPI: https://github.com/torvalds/linux/blob/v6.2/include/uapi/linux/landlock.h
// Syscalls 444..446: v6.2 arch/x86/entry/syscalls/syscall_64.tbl and include/uapi/asm-generic/unistd.h.
// No compatibility fallback: WRITE_FILE without TRUNCATE is not a read-only boundary.
export const linuxReadonlyProcessProgram = String.raw`
import ctypes, hashlib, json, os, resource, stat, sys

class Blocked(Exception):
    def __init__(self, code):
        self.code = code

def require(condition, code):
    if not condition:
        raise Blocked(code)

def identity(s):
    return {"device": str(s.st_dev), "inode": str(s.st_ino), "ctime": str(s.st_ctime_ns),
            "uid": s.st_uid, "mode": stat.S_IMODE(s.st_mode)}

retained = []

def open_directory(name):
    require(name.startswith("/") and name != "/" and os.path.normpath(name) == name, "unsafe-path")
    fd = os.open("/", os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    retained.append(fd)
    for component in name.split("/")[1:]:
        fd = os.open(component, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
        retained.append(fd)
    return fd

def observe(item):
    fd = open_directory(item["path"])
    observed = os.fstat(fd)
    require(identity(observed) == item["identity"], "unsafe-path")
    require(observed.st_uid == os.getuid() and not observed.st_mode & 0o077, "unsafe-path")
    return fd

def below(parent, child):
    return child.startswith(parent + "/")

def mount_id(fd):
    with open("/proc/self/fdinfo/" + str(fd), "r") as info:
        fields = dict(line.split(":", 1) for line in info if ":" in line)
    return int(fields["mnt_id"].strip())

def executable(item):
    require(os.path.isabs(item["path"]) and os.path.realpath(item["path"]) == item["path"], "tool-unavailable")
    fd = os.open(item["path"], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    retained.append(fd)
    s = os.fstat(fd)
    require(stat.S_ISREG(s.st_mode) and not s.st_mode & 0o022 and s.st_mode & 0o111, "tool-unavailable")
    require(identity(s) == item["identity"], "tool-unavailable")
    digest = hashlib.sha256()
    while True:
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        digest.update(chunk)
    require(digest.hexdigest() == item["sha256"], "tool-unavailable")
    return fd

try:
    require(sys.platform == "linux", "unsupported-native-platform")
    require(sys.implementation.name == "cpython" and sys.version_info[:2] == (3, 14), "unqualified-combination")
    require(os.uname().machine in ("x86_64", "aarch64") and ctypes.sizeof(ctypes.c_void_p) == 8, "unqualified-combination")
    require(os.getuid() != 0 and os.getuid() == os.geteuid() and os.getgid() == os.getegid(), "access-denied")
    with open("/proc/self/status", "r") as status:
        fields = dict(line.split(":", 1) for line in status if ":" in line)
    require(all(int(fields[key].strip(), 16) == 0 for key in ("CapEff", "CapPrm", "CapInh", "CapAmb")), "access-denied")
    require(len(os.listdir("/proc/self/task")) == 1, "unqualified-combination")
    require(all(stat.S_ISFIFO(os.fstat(fd).st_mode) or stat.S_ISSOCK(os.fstat(fd).st_mode)
                for fd in (0, 1, 2)), "unsafe-path")
    maximum_fd = resource.getrlimit(resource.RLIMIT_NOFILE)[1]
    require(3 <= maximum_fd <= 2147483647, "unqualified-combination")
    os.closerange(3, maximum_fd)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    request = json.loads(sys.argv[1])
    scope, store = request["scope"], request["store"]
    writable = request["writable"]
    require(len(writable) == 3, "invalid-binding")
    entries = [store] + writable
    require(all(below(scope["path"], item["path"]) for item in entries), "unsafe-path")
    require(all(a["path"] != b["path"] and not below(a["path"], b["path"]) and not below(b["path"], a["path"])
                for index, a in enumerate(entries) for b in entries[index + 1:]), "unsafe-path")
    scope_fd = observe(scope)
    store_fd = observe(store)
    writable_fds = [observe(item) for item in writable]
    require(len({(os.fstat(fd).st_dev, os.fstat(fd).st_ino) for fd in [scope_fd, store_fd] + writable_fds}) == 5, "unsafe-path")
    # An empty bind-mounted alias of a store subdirectory must not become writable.
    require(len({mount_id(fd) for fd in [scope_fd, store_fd] + writable_fds}) == 1, "unsafe-path")
    for fd in writable_fds:
        readable = os.open(".", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC, dir_fd=fd)
        retained.append(readable)
        require(not os.listdir(readable), "unsafe-path")
    target_fd = executable(request["executable"])
    require(os.execve in os.supports_fd, "unqualified-combination")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    libc.prctl.restype = ctypes.c_int
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    abi = libc.syscall(ctypes.c_long(444), ctypes.c_void_p(), ctypes.c_size_t(0), ctypes.c_uint(1))
    require(abi >= 3, "unqualified-combination")
    class Ruleset(ctypes.Structure):
        _fields_ = [("handled_access_fs", ctypes.c_uint64)]
    class PathBeneath(ctypes.Structure):
        _pack_ = 1
        _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]
    require(ctypes.sizeof(Ruleset) == 8 and ctypes.sizeof(PathBeneath) == 12, "unqualified-combination")
    # Handle every ABI-3 mutation right. Reading, execution and networking are not restricted.
    WRITE_FILE = 1 << 1
    REMOVE_DIR, REMOVE_FILE = 1 << 4, 1 << 5
    MAKE_CHAR, MAKE_DIR, MAKE_REG = 1 << 6, 1 << 7, 1 << 8
    MAKE_SOCK, MAKE_FIFO, MAKE_BLOCK, MAKE_SYM = 1 << 9, 1 << 10, 1 << 11, 1 << 12
    REFER, TRUNCATE = 1 << 13, 1 << 14
    handled = WRITE_FILE | REMOVE_DIR | REMOVE_FILE | MAKE_CHAR | MAKE_DIR | MAKE_REG | MAKE_SOCK | MAKE_FIFO | MAKE_BLOCK | MAKE_SYM | REFER | TRUNCATE
    # No device creation or cross-directory reparenting is needed by this primitive.
    allowed = handled & ~(MAKE_CHAR | MAKE_BLOCK | REFER)
    ruleset = Ruleset(handled)
    ruleset_fd = libc.syscall(ctypes.c_long(444), ctypes.byref(ruleset), ctypes.c_size_t(8), ctypes.c_uint(0))
    require(ruleset_fd >= 0, "unqualified-combination")
    retained.append(ruleset_fd)
    for fd in writable_fds:
        rule = PathBeneath(allowed, fd)
        require(libc.syscall(ctypes.c_long(445), ctypes.c_int(ruleset_fd), ctypes.c_int(1),
                             ctypes.byref(rule), ctypes.c_uint(0)) == 0, "unqualified-combination")
    # Re-open by absolute path while all rule FDs remain pinned: reject path substitution.
    for item in [scope, store] + writable:
        observe(item)
    require(libc.prctl(38, 1, 0, 0, 0) == 0, "unqualified-combination")
    require(libc.syscall(ctypes.c_long(446), ctypes.c_int(ruleset_fd), ctypes.c_uint(0)) == 0, "unqualified-combination")
    for item in [scope, store] + writable:
        observe(item)
    os.fchdir(writable_fds[2])
    require(os.getcwd() == writable[2]["path"], "unsafe-path")
    # stdin is never read, decoded, copied or logged here; exec inherits the private channel.
    for fd in retained:
        if fd != target_fd:
            os.close(fd)
    os.execve(target_fd, [request["executable"]["path"]] + request["args"], os.environ)
except Blocked as error:
    os.write(2, ("liftoff-readonly:" + error.code + "\n").encode("ascii"))
    os._exit(125)
except BaseException:
    os.write(2, b"liftoff-readonly:operation-failed\n")
    os._exit(125)
`;
