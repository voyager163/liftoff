import ctypes
import errno
import json
import os
import platform
import resource
import socket
import stat
import sys

phase = "platform"


class Filter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
                ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint32)]


class Program(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ushort), ("filters", ctypes.POINTER(Filter))]


def install():
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
    phase = "stdio"
    for descriptor in range(3):
        if stat.S_ISSOCK(os.fstat(descriptor).st_mode):
            raise RuntimeError()
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
    if not arguments or (arguments != ["--probe"] and not os.path.isabs(arguments[0])):
        raise RuntimeError()
    libc = install()
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
