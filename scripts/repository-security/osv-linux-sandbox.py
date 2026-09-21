import ctypes
import errno
import fcntl
import json
import os
import platform
import resource
import socket
import stat
import struct
import sys

phase = "platform"


class Filter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
                ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint32)]


class Program(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ushort), ("filters", ctypes.POINTER(Filter))]


def validate_stdio(descriptor, producer):
    global phase
    before = os.fstat(descriptor)
    if not stat.S_ISSOCK(before.st_mode):
        return
    phase = "stdio-producer"
    if producer is None:
        raise RuntimeError()
    parent, uid = producer
    if os.getppid() != parent or os.getuid() != uid or os.geteuid() != uid:
        raise RuntimeError()
    status_flags = fcntl.fcntl(descriptor, fcntl.F_GETFL)
    descriptor_flags = fcntl.fcntl(descriptor, fcntl.F_GETFD)
    with socket.socket(fileno=os.dup(descriptor)) as stream:
        phase = "stdio-domain"
        if stream.getsockopt(socket.SOL_SOCKET, socket.SO_DOMAIN) != socket.AF_UNIX:
            raise RuntimeError()
        if stream.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM:
            raise RuntimeError()
        phase = "stdio-address"
        if stream.getsockname() not in ("", b"") or stream.getpeername() not in ("", b""):
            raise RuntimeError()
        phase = "stdio-peer"
        peer_pid, peer_uid, _ = struct.unpack(
            "iII", stream.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("iII"))
        )
        if peer_pid != parent or peer_uid != uid:
            raise RuntimeError()
        duplicate = os.fstat(stream.fileno())
        if (duplicate.st_dev, duplicate.st_ino, duplicate.st_mode) != (before.st_dev, before.st_ino, before.st_mode):
            raise RuntimeError()
    phase = "stdio-flags"
    after = os.fstat(descriptor)
    if (after.st_dev, after.st_ino, after.st_mode) != (before.st_dev, before.st_ino, before.st_mode):
        raise RuntimeError()
    if fcntl.fcntl(descriptor, fcntl.F_GETFL) != status_flags or fcntl.fcntl(descriptor, fcntl.F_GETFD) != descriptor_flags:
        raise RuntimeError()
    if os.getppid() != parent or os.getuid() != uid or os.geteuid() != uid:
        raise RuntimeError()


def install(producer):
    global phase
    if sys.platform != "linux":
        raise RuntimeError()
    profiles = {
        "x86_64": (0xC000003E, list(range(41, 56)) + [101, 288, 299, 307, 311, 425, 426, 427, 438]),
        "aarch64": (0xC00000B7, list(range(198, 213)) + [117, 242, 243, 269, 271, 425, 426, 427, 438]),
    }
    profile = profiles.get(platform.machine())
    if profile is None:
        raise RuntimeError()
    if producer is not None:
        phase = "stdio-producer"
        if os.getppid() != producer[0] or os.getuid() != producer[1] or os.geteuid() != producer[1]:
            raise RuntimeError()
    phase = "stdio"
    for descriptor in range(3):
        validate_stdio(descriptor, producer)
    phase = "descriptor-closure"
    _, maximum = resource.getrlimit(resource.RLIMIT_NOFILE)
    if maximum < 3 or maximum > 1_048_576:
        raise RuntimeError()
    os.closerange(3, maximum)
    architecture, denied = profile
    # Reject other ABIs, including x32, before matching native syscall numbers.
    instructions = [
        Filter(0x20, 0, 0, 4), Filter(0x15, 1, 0, architecture), Filter(0x06, 0, 0, 0x80000000),
        Filter(0x20, 0, 0, 0), Filter(0x35, 0, 1, 0x40000000), Filter(0x06, 0, 0, 0x80000000),
    ]
    for number in sorted(set(denied)):
        instructions.extend([Filter(0x15, 0, 1, number), Filter(0x06, 0, 0, 0x00050000 | errno.EACCES)])
    instructions.append(Filter(0x06, 0, 0, 0x7FFF0000))
    filters = (Filter * len(instructions))(*instructions)
    program = Program(len(instructions), filters)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.restype = ctypes.c_int
    phase = "filter-install"
    ctypes.set_errno(0)
    if libc.prctl(38, 1, 0, 0, 0) != 0 or libc.prctl(22, 2, ctypes.byref(program), 0, 0) != 0:
        raise RuntimeError()
    phase = "filter-readback"
    if libc.prctl(21, 0, 0, 0, 0) != 2 or libc.prctl(39, 0, 0, 0, 0) != 1:
        raise RuntimeError()
    return libc


def probe(libc):
    global phase
    phase = "denial-probe"
    result = {}
    for name, family in [("ipv4", socket.AF_INET), ("ipv6", socket.AF_INET6), ("unix", socket.AF_UNIX)]:
        try:
            with socket.socket(family, socket.SOCK_STREAM):
                result[name] = False
        except OSError as error:
            result[name] = error.errno == errno.EACCES
    ctypes.set_errno(0)
    result["ioUring"] = libc.syscall(425, 0, 0) == -1 and ctypes.get_errno() == errno.EACCES
    result["seccomp"] = libc.prctl(21, 0, 0, 0, 0) == 2
    result["noNewPrivileges"] = libc.prctl(39, 0, 0, 0, 0) == 1
    if not all(result.values()):
        raise RuntimeError()
    print(json.dumps(result, separators=(",", ":")))


def main():
    global phase
    arguments = sys.argv[1:]
    producer = None
    if arguments and arguments[0] == "--stdio-parent-pid":
        phase = "stdio-producer"
        if len(arguments) < 5 or arguments[2] != "--stdio-parent-uid":
            raise RuntimeError()
        if not 1 <= len(arguments[1]) <= 10 or not 1 <= len(arguments[3]) <= 10:
            raise RuntimeError()
        if not arguments[1].isascii() or not arguments[1].isdecimal() or not arguments[3].isascii() or not arguments[3].isdecimal():
            raise RuntimeError()
        parent, uid = int(arguments[1]), int(arguments[3])
        if not 0 < parent <= 2_147_483_647 or not 0 <= uid < 4_294_967_295:
            raise RuntimeError()
        if str(parent) != arguments[1] or str(uid) != arguments[3]:
            raise RuntimeError()
        producer = (parent, uid)
        arguments = arguments[4:]
    if not arguments or (arguments != ["--probe"] and not os.path.isabs(arguments[0])):
        raise RuntimeError()
    libc = install(producer)
    if arguments == ["--probe"]:
        probe(libc)
    else:
        phase = "native-exec"
        os.execve(arguments[0], arguments, os.environ)


try:
    main()
except (OSError, RuntimeError, ValueError) as error:
    code = error.errno if isinstance(error, OSError) else ctypes.get_errno()
    sys.stderr.write(json.dumps({"boundary": "linux-osv-network", "phase": phase,
                                 "errno": code if isinstance(code, int) and 0 <= code <= 4095 else None}) + "\n")
    sys.exit(78)
