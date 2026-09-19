"""Test-only enrollment launcher: bound private stdin survives exec unchanged."""
import os
import resource
import sys

if (sys.platform != "linux" or sys.version_info[:2] != (3, 14)
        or len(sys.argv) != 4 or not os.path.isabs(sys.argv[1])
        or not os.path.isabs(sys.argv[2]) or len(sys.argv[3].encode()) > 32768):
    os._exit(125)
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
os.umask(0o077)
os.execv(sys.argv[1], sys.argv[1:])
