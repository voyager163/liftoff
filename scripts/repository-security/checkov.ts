import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  capturePrivateFixtureProcess, createPrivateFixtureWorkspace, FixtureError, fixtureGitEnvironment
} from './gitleaks.ts';
import { portableParts } from './evidence.ts';

/**
 * Fixture-only Checkov qualification, not repository IaC coverage. Uses the
 * installed launcher's Python environment and Checkov's CLI argument parser/run
 * path, replacing ONLY the report printer before it can serialize source blocks.
 * Python audit hooks deny network, child processes, filesystem writes and reads
 * of the real home/worktree; these hooks are not an OS sandbox or toolchain seal.
 */
export const CHECKOV_FIXTURE_POLICY = Object.freeze({
  version: '3.3.10',
  framework: 'terraform',
  rule: 'CKV_AZURE_3',
  attribute: 'enable_https_traffic_only',
  timeoutMs: 60_000,
  reportBytes: 4_096,
  ipv6ProbeModuleDigest: '2633bbdb69731e5ccb5cf4e4afd65605d86c7979cc5633126f50c92d5ad74a74',
  larkModuleDigest: 'be9e5c96ba62375dc9d9fc1bc5fdc79ca8fd1f9b21629da2a1fcdaae09460d2a',
  hclParserModuleDigest: 'c81200a66067b72b3eb217d81afd6888078836aace43975f1c3d7606b0333133',
  hclGrammarDigest: '50b8fcc6c59b814af173efa572ecce358939172334b7523a9639b6088b703de3',
  platformModuleDigest: '240eba74565cd0dc4f99f182f7afc32bbea0593016ddb34165b529b5bcb6be0a',
  gitPythonModuleDigest: 'cbeed3569f0f5565645dc42b2aaad23b6bda0fa05d8ae7bbdd9cc5956ccbaf25',
  executableBytes: 67_108_864,
  launcherBytes: 16_384
});

const MARKER = 'CHECKOV_NONFUNCTIONAL_BOUNDARY_SENTINEL_000000';
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
type Failure = 'invalid-input' | 'invalid-report' | 'incomplete-analysis' | 'identity-mismatch'
  | 'unexpected-result' | 'version-mismatch' | 'unsafe-output' | 'network-attempt'
  | 'subprocess-attempt' | 'filesystem-attempt' | 'process-error' | 'timeout' | 'cleanup-failed'
  | 'unresolved-variables' | 'unregistered-module' | 'invalid-local-closure' | 'unresolved-policy-binding';

const NETWORK_OPERATIONS = ['unknown', 'socket.connect', 'socket.getaddrinfo', 'socket.gethostbyname',
  'socket.gethostbyaddr', 'socket.getnameinfo', 'socket.sendto', 'socket.sendmsg', 'socket.bind', 'http.client.connect'] as const;
const NETWORK_FAMILIES = ['unknown', 'AF_UNIX', 'AF_INET', 'AF_INET6'] as const;
const NETWORK_FRAMES = ['unknown', 'urllib3.util.connection._has_ipv6', 'urllib3.util.connection.create_connection'] as const;
const FILESYSTEM_OPERATIONS = ['unknown', 'open-read', 'open-write', 'mkdir', 'rename', 'remove', 'rmdir', 'link', 'symlink', 'open-readwrite', 'open-append'] as const;
const FILESYSTEM_DESTINATIONS = ['unknown', 'registered-workspace', 'installed-tool', 'source-checkout', 'real-home', 'system-runtime', 'outside', 'null-device'] as const;
const FILESYSTEM_CALLERS = ['unknown', 'tempfile._get_default_tempdir', 'lark.lark.Lark.__init__'] as const;
const PROCESS_CALLERS = ['unknown', 'git.cmd', 'platform', 'multiprocessing', 'checkov',
  'platform.unexpected-event', 'platform.unexpected-executable', 'platform.unexpected-arguments',
  'platform.unexpected-environment', 'platform.unverified-caller', 'platform.source-mismatch',
  'platform.file', 'platform.sw_vers', 'platform.absolute-sw_vers', 'platform.byte-uname'] as const;

export interface CheckovFilesystemDiagnostic {
  readonly operation: typeof FILESYSTEM_OPERATIONS[number];
  readonly destination: typeof FILESYSTEM_DESTINATIONS[number];
  readonly caller: typeof FILESYSTEM_CALLERS[number];
}

export interface CheckovNetworkDiagnostic {
  readonly operation: typeof NETWORK_OPERATIONS[number];
  readonly family: typeof NETWORK_FAMILIES[number];
  readonly installedFrame: typeof NETWORK_FRAMES[number];
}

export class CheckovFixtureError extends Error {
  readonly code: Failure;
  scopeDiagnostic?: {
    tupleLength: number; scalarFields: (number | null)[];
    parsedFileIndexes: number[]; recordCount: number | null; recordMetadata: number[][];
  };
  readonly networkDiagnostic: CheckovNetworkDiagnostic | undefined;
  readonly filesystemDiagnostic: CheckovFilesystemDiagnostic | undefined;
  readonly processDiagnostic: typeof PROCESS_CALLERS[number] | undefined;
  constructor(code: Failure, diagnostic?: CheckovNetworkDiagnostic, filesystem?: CheckovFilesystemDiagnostic, process?: typeof PROCESS_CALLERS[number]) {
    super(`Checkov fixture rejected: ${code}.`);
    this.code = code;
    this.name = 'CheckovFixtureError';
    this.networkDiagnostic = diagnostic;
    this.filesystemDiagnostic = filesystem;
    this.processDiagnostic = process;
  }
}
function fail(code: Failure, diagnostic?: CheckovNetworkDiagnostic, filesystem?: CheckovFilesystemDiagnostic, process?: typeof PROCESS_CALLERS[number]): never {
  throw new CheckovFixtureError(code, diagnostic, filesystem, process);
}
async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error: unknown) {
    if (error instanceof CheckovFixtureError) throw error;
    if (error instanceof FixtureError) {
      if (error.code === 'timeout') fail('timeout');
      if (error.code === 'unsafe-stderr' || error.code === 'output-limit') fail('unsafe-output');
      if (error.code === 'cleanup-failed') fail('cleanup-failed');
    }
    return fail('process-error');
  }
}

export function checkovFixtureEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    ...fixtureGitEnvironment(root, path.join(root, 'bin')),
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
    CHECKOV_WORKERS_NUMBER: '1', CHECKOV_PARALLELIZATION_TYPE: 'none',
    GIT_PYTHON_REFRESH: 'quiet',
    BC_SKIP_MAPPING: 'TRUE', CKV_PARSE_ERROR_FAIL: 'true', CKV_SKIP_PACKAGE_UPDATE_CHECK: 'true',
    DOWNLOAD_EXTERNAL_MODULES: 'False', ANSI_COLORS_DISABLED: '1', LOG_LEVEL: 'ERROR'
  };
}

function fixture(secure: boolean): string {
  return `resource "azurerm_storage_account" "fixture" {
  name                     = "liftofffixture000"
  resource_group_name      = "nonfunctional-fixture-group"
  location                 = "West Europe"
  account_tier             = "Standard"
  account_replication_type = "LRS"
  enable_https_traffic_only = ${secure}
  tags = { boundary_probe = "${MARKER}" }
}
`;
}

// This trusted printer never serializes a Report/Record, code block, logger
// buffer, scanner exception or native JSON. All output fields are integers.
const PROJECTOR = String.raw`
import hashlib, io, json, logging, os, re, socket, stat, sys, tempfile

ROOT, PROJECT, REAL_HOME, MODE = sys.argv[1:5]
ROOT, PROJECT, REAL_HOME = map(os.path.realpath, (ROOT, PROJECT, REAL_HOME))
RULE = "CKV_AZURE_3"
RESOURCE = "azurerm_storage_account.fixture"
EXPECTED_VERSION = "3.3.10"
EXPECTED_PROBE_SOURCE = "${CHECKOV_FIXTURE_POLICY.ipv6ProbeModuleDigest}"
EXPECTED_LARK_SOURCE = "${CHECKOV_FIXTURE_POLICY.larkModuleDigest}"
EXPECTED_HCL_SOURCE = "${CHECKOV_FIXTURE_POLICY.hclParserModuleDigest}"
EXPECTED_HCL_GRAMMAR = "${CHECKOV_FIXTURE_POLICY.hclGrammarDigest}"
EXPECTED_PLATFORM_SOURCE = "${CHECKOV_FIXTURE_POLICY.platformModuleDigest}"
EXPECTED_GITPYTHON_SOURCE = "${CHECKOV_FIXTURE_POLICY.gitPythonModuleDigest}"
os.umask(0o077)
# The parent already created and ownership-checked this exact private directory.
# Avoid tempfile probing unrelated fallback directories to establish writability.
tempfile.tempdir = os.path.join(ROOT, "scratch")
original_output = sys.stdout
attempts = [0, 0, 0]
network_diagnostic = None
filesystem_diagnostic = None
process_diagnostic = 0
denied_ipv6_probes = 0
registered_grammar_caches = set()
null_sink = os.path.abspath(os.devnull)
null_sink_stat = os.lstat(null_sink)
null_sink_identity = (null_sink_stat.st_dev, null_sink_stat.st_ino, null_sink_stat.st_rdev)
discarded_null_writes = 0
denied_processor_probes = 0
denied_architecture_probes = 0
denied_git_import_probes = 0
processor_probe_rejection = 0
input_reads = set()
closure_proof = []
role_facts = [0] * 14
generated_role_facts = [0] * 12
generated_optional_facts = [0] * 4
generated_optional_indexes = [[], [], [], []]
generated_default_facts = [0] * 4
generated_default_indexes = [[], [], [], []]
generated_registry_indexes = []
bootstrap_graph = [False, False]
telemetry_graph = [False, False]
registry_result_indexes = []
compose_proof = []

class BoundaryFailure(Exception):
    pass

class ScopeFailure(Exception):
    def __init__(self, code):
        self.code = code

class Sink:
    encoding = "utf-8"
    errors = "strict"
    def __init__(self, limit=4096):
        self.count, self.limit = 0, limit
        self.buffer = self
    def write(self, value):
        size = len(value)
        self.count += size
        if self.count > self.limit:
            raise BoundaryFailure()
        return size
    def flush(self): pass
    def isatty(self): return False
    def seek(self, *args): return 0
    def truncate(self, *args): return 0
    def getvalue(self): return ""

stdout_sink, stderr_sink = Sink(), Sink()
sys.stdout, sys.stderr = stdout_sink, stderr_sink

def inside(location, root):
    return location == root or location.startswith(root + os.sep)

def filesystem_identity(operation, name):
    destination = 0
    if isinstance(name, (str, bytes)):
        absolute = os.path.realpath(os.fsdecode(name))
        if absolute == os.path.realpath(os.devnull):
            destination = 7
        elif inside(absolute, ROOT):
            destination = 1
        elif inside(absolute, os.path.realpath(sys.prefix)):
            destination = 2
        elif inside(absolute, PROJECT):
            destination = 3
        elif inside(absolute, REAL_HOME):
            destination = 4
        elif inside(absolute, os.path.realpath(sys.base_prefix)):
            destination = 5
        else:
            destination = 6
    caller = 0
    frame = sys._getframe(1)
    for _ in range(16):
        if frame is None:
            break
        module = sys.modules.get("tempfile")
        if frame.f_globals.get("__name__") == "tempfile" and frame.f_code is getattr(getattr(module, "_get_default_tempdir", None), "__code__", None):
            caller = 1
            break
        module = sys.modules.get("lark.lark")
        constructor = getattr(getattr(module, "Lark", None), "__init__", None)
        if frame.f_globals.get("__name__") == "lark.lark" and frame.f_code is getattr(constructor, "__code__", None):
            caller = 2
            break
        frame = frame.f_back
    return [operation, destination, caller]

def deny_filesystem(operation, name):
    global filesystem_diagnostic
    attempts[2] += 1
    if filesystem_diagnostic is None:
        filesystem_diagnostic = filesystem_identity(operation, name)
    raise BoundaryFailure()

def reviewed_source(module, suffix, expected):
    origin = getattr(getattr(module, "__spec__", None), "origin", None)
    if not isinstance(origin, str) or not origin.endswith(suffix):
        return False
    with open(origin, "rb") as source:
        content = source.read(131073)
    return len(content) <= 131072 and hashlib.sha256(content).hexdigest() == expected

def exact_null_sink_write(name, flags):
    if (
        not isinstance(name, str) or name != null_sink
        or os.path.realpath(name) != null_sink
        or not flags & (os.O_WRONLY | os.O_RDWR) or flags & os.O_APPEND
    ):
        return False
    current = os.lstat(name)
    return (
        stat.S_ISCHR(current.st_mode)
        and (current.st_dev, current.st_ino, current.st_rdev) == null_sink_identity
    )

def processor_capability_probe(event, args):
    global processor_probe_rejection
    if event != "subprocess.Popen" or len(args) != 4:
        processor_probe_rejection = 5
        return False
    if args[0] != "uname":
        processor_probe_rejection = 6
        return False
    if type(args[1]) is not list or args[1] != ["uname", "-p"]:
        processor_probe_rejection = 7
        return False
    if args[2] is not None or args[3] is not None:
        processor_probe_rejection = 8
        return False
    module = sys.modules.get("platform")
    probe = getattr(getattr(module, "_Processor", None), "from_subprocess", None)
    frame = sys._getframe(1)
    for _ in range(16):
        if frame is None:
            processor_probe_rejection = 9
            return False
        if frame.f_code is getattr(probe, "__code__", None):
            verified = reviewed_source(module, "/platform.py", EXPECTED_PLATFORM_SOURCE)
            processor_probe_rejection = 0 if verified else 10
            return verified
        frame = frame.f_back
    processor_probe_rejection = 9
    return False

def architecture_capability_probe(event, args):
    if (
        event != "subprocess.Popen" or len(args) != 4 or args[0] != "file"
        or type(args[1]) is not list or len(args[1]) != 3 or args[1][:2] != ["file", "-b"]
        or type(args[1][2]) is not str
        or os.path.realpath(args[1][2]) != os.path.realpath(sys.executable)
        or args[2] is not None or args[3] != dict(os.environ, LC_ALL="C")
    ):
        return False
    module = sys.modules.get("platform")
    probe = getattr(module, "_syscmd_file", None)
    frame = sys._getframe(1)
    for _ in range(16):
        if frame is None:
            return False
        if frame.f_code is getattr(probe, "__code__", None):
            return reviewed_source(module, "/platform.py", EXPECTED_PLATFORM_SOURCE)
        frame = frame.f_back
    return False

def git_import_capability_probe(event, args):
    if (
        event != "subprocess.Popen" or len(args) != 4 or args[0] != "git"
        or type(args[1]) is not list or args[1] != ["git", "version"]
        or args[2] not in (None, ROOT)
        or os.environ.get("GIT_PYTHON_REFRESH") != "quiet"
    ):
        return False
    module = sys.modules.get("git.cmd")
    probe = getattr(getattr(module, "Git", None), "refresh", None)
    frame = sys._getframe(1)
    for _ in range(24):
        if frame is None:
            return False
        if frame.f_code is getattr(probe, "__code__", None):
            return (
                frame.f_locals.get("old_git") is None
                and frame.f_locals.get("path") is None
                and reviewed_source(module, "/git/cmd.py", EXPECTED_GITPYTHON_SOURCE)
            )
        frame = frame.f_back
    return False

def registered_grammar_cache_access(name, flags):
    if not isinstance(name, (str, bytes)):
        return False
    absolute = os.path.abspath(os.fsdecode(name))
    if os.path.dirname(absolute) != os.path.join(ROOT, "scratch") or os.path.realpath(absolute) != absolute:
        return False
    frame = sys._getframe(1)
    for _ in range(16):
        if frame is None:
            return False
        module = sys.modules.get("lark.lark")
        constructor = getattr(getattr(module, "Lark", None), "__init__", None)
        if frame.f_globals.get("__name__") == "lark.lark" and frame.f_code is getattr(constructor, "__code__", None):
            break
        frame = frame.f_back
    else:
        return False
    if frame.f_locals.get("cache_fn") != absolute:
        return False
    hcl = sys.modules.get("hcl2.parser")
    grammar = getattr(hcl, "LARK_GRAMMAR", None)
    if not isinstance(grammar, str) or frame.f_locals.get("grammar") != grammar:
        return False
    if (
        not reviewed_source(module, "/lark/lark.py", EXPECTED_LARK_SOURCE)
        or not reviewed_source(hcl, "/hcl2/parser.py", EXPECTED_HCL_SOURCE)
        or hashlib.sha256(grammar.encode("utf-8")).hexdigest() != EXPECTED_HCL_GRAMMAR
    ):
        return False
    writing = bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
    if not writing:
        if registered_grammar_caches and absolute not in registered_grammar_caches:
            return False
        registered_grammar_caches.add(absolute)
        return True
    if absolute not in registered_grammar_caches or flags & (os.O_RDWR | os.O_APPEND):
        return False
    if os.path.lexists(absolute) and not stat.S_ISREG(os.lstat(absolute).st_mode):
        return False
    return True

def expected_denied_probe(operation, family, registered_frame, socket_type, address, verified_caller):
    return (
        operation == 8 and family == 3 and registered_frame == 1
        and socket_type == socket.SOCK_STREAM and verified_caller is True
        and type(address) is tuple and len(address) == 2
        and type(address[0]) is str and address[0] == "::1"
        and type(address[1]) is int and address[1] == 0
    )

def reviewed_probe_source(module):
    origin = getattr(getattr(module, "__spec__", None), "origin", None)
    if not isinstance(origin, str) or not origin.endswith("/urllib3/util/connection.py"):
        return False
    with open(origin, "rb") as source:
        content = source.read(65537)
    return len(content) <= 65536 and hashlib.sha256(content).hexdigest() == EXPECTED_PROBE_SOURCE

def verified_probe_caller(frame):
    module = sys.modules.get("urllib3.util.connection")
    probe = getattr(module, "_has_ipv6", None)
    return (
        frame.f_globals.get("__name__") == "urllib3.util.connection"
        and frame.f_code is getattr(probe, "__code__", None)
        and reviewed_probe_source(module)
    )

def network_identity(event, args):
    # Only fixed registry ordinals leave this process. Neither arguments nor
    # arbitrary frame/module strings are retained, formatted or serialized.
    operations = ("unknown", "socket.connect", "socket.getaddrinfo", "socket.gethostbyname",
                  "socket.gethostbyaddr", "socket.getnameinfo", "socket.sendto",
                  "socket.sendmsg", "socket.bind", "http.client.connect")
    operation = operations.index(event) if event in operations else 0
    family = 0
    if args and isinstance(args[0], socket.socket):
        families = (None, socket.AF_UNIX, socket.AF_INET, socket.AF_INET6)
        family = families.index(args[0].family) if args[0].family in families else 0
    elif event == "socket.getaddrinfo" and len(args) > 2:
        families = (None, socket.AF_UNIX, socket.AF_INET, socket.AF_INET6)
        family = families.index(args[2]) if args[2] in families else 0
    registered_frame = 0
    frame = sys._getframe(1)
    for _ in range(16):
        if frame is None:
            break
        if frame.f_globals.get("__name__") == "urllib3.util.connection":
            module = sys.modules.get("urllib3.util.connection")
            origin = getattr(getattr(module, "__spec__", None), "origin", None)
            if isinstance(origin, str) and frame.f_code.co_filename == origin:
                if frame.f_code.co_name == "_has_ipv6":
                    registered_frame = 1
                elif frame.f_code.co_name == "create_connection":
                    registered_frame = 2
        if registered_frame:
            break
        frame = frame.f_back
    del frame
    return [operation, family, registered_frame]

def audit(event, args):
    global network_diagnostic, denied_ipv6_probes, discarded_null_writes, process_diagnostic, denied_processor_probes, denied_architecture_probes, denied_git_import_probes
    if event in ("socket.connect", "socket.getaddrinfo", "socket.gethostbyname",
                 "socket.gethostbyaddr", "socket.getnameinfo", "socket.sendto",
                 "socket.sendmsg", "socket.bind", "http.client.connect"):
        identity = network_identity(event, args)
        if identity == [8, 3, 1] and len(args) == 2 and type(args[0]) is socket.socket:
            if denied_ipv6_probes == 0 and expected_denied_probe(
                *identity, args[0].type, args[1], verified_probe_caller(sys._getframe(1))
            ):
                denied_ipv6_probes += 1
                # Still DENY the bind. urllib3 already handles an unavailable
                # IPv6 capability; no address, bind or connection is permitted.
                raise BoundaryFailure()
        attempts[0] += 1
        if network_diagnostic is None:
            network_diagnostic = identity
        raise BoundaryFailure()
    if event in ("subprocess.Popen", "os.system", "os.posix_spawn", "os.fork",
                 "os.forkpty", "pty.spawn", "os.exec"):
        if denied_processor_probes < 4 and processor_capability_probe(event, args):
            denied_processor_probes += 1
            # No process is started. The pinned stdlib explicitly treats an
            # unavailable CPU-name probe as unknown metadata.
            raise PermissionError()
        if denied_architecture_probes < 4 and architecture_capability_probe(event, args):
            denied_architecture_probes += 1
            raise PermissionError()
        if denied_git_import_probes == 0 and git_import_capability_probe(event, args):
            denied_git_import_probes += 1
            raise PermissionError()
        attempts[1] += 1
        frame = sys._getframe(1)
        for _ in range(32):
            if frame is None:
                break
            name = frame.f_globals.get("__name__", "")
            if name == "git.cmd":
                process_diagnostic = 1
                break
            if name == "platform":
                process_diagnostic = processor_probe_rejection or 2
                executables = ("file", "sw_vers", "/usr/bin/sw_vers", b"uname")
                if event == "subprocess.Popen" and args and args[0] in executables:
                    process_diagnostic = 11 + executables.index(args[0])
                break
            if name.startswith("multiprocessing."):
                process_diagnostic = 3
                break
            if name.startswith("checkov."):
                process_diagnostic = 4
                break
            frame = frame.f_back
        raise BoundaryFailure()
    if event in ("os.mkdir", "os.rename", "os.remove", "os.rmdir", "os.link", "os.symlink"):
        operations = ("os.mkdir", "os.rename", "os.remove", "os.rmdir", "os.link", "os.symlink")
        name = args[1] if event in ("os.rename", "os.link", "os.symlink") and len(args) > 1 else args[0] if args else None
        deny_filesystem(operations.index(event) + 3, name)
    if event == "open":
        name, mode, flags = args
        if registered_grammar_cache_access(name, flags):
            return
        # The real tool opens the OS discard device. Bind that nonpersisting
        # destination exactly; never grant an outside-directory write.
        if exact_null_sink_write(name, flags):
            discarded_null_writes += 1
            return
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
            deny_filesystem(10 if flags & os.O_APPEND else 9 if flags & os.O_RDWR else 2, name)
        if isinstance(name, (str, bytes)):
            absolute = os.path.realpath(os.fsdecode(name))
            if ".git" in absolute.split(os.sep) or (
                not inside(absolute, ROOT)
                and (inside(absolute, PROJECT) or inside(absolute, REAL_HOME))
            ):
                deny_filesystem(1, name)
            if inside(absolute, os.path.join(ROOT, "inputs")):
                input_reads.add(absolute)

sys.addaudithook(audit)

def prepare_local_closure(scope):
    import hcl2
    context = scope.get("terraformContext")
    if not context:
        return []
    source_root = os.path.join(ROOT, "inputs")
    root = os.path.join(source_root, *context["rootDirectory"])
    modules = [os.path.join(source_root, *parts) for parts in context["moduleDirectories"]]
    directories = [root, *modules]
    edges, declarations, assignments = [], {}, {}
    for entry in scope["files"]:
        filename = os.path.join(source_root, *entry["pathParts"])
        with open(filename, "r") as source:
            document = hcl2.load(source)
        if os.path.dirname(filename) == root:
            for variable in document.get("variable", []):
                for name, configuration in variable.items():
                    if name in declarations:
                        raise ScopeFailure(9)
                    declarations[name] = configuration
        for module in document.get("module", []):
            for configuration in module.values():
                value = configuration.get("source")
                if isinstance(value, list) and len(value) == 1:
                    value = value[0]
                if not isinstance(value, str) or not value.startswith(("./", "../")):
                    raise ScopeFailure(8)
                target = os.path.realpath(os.path.join(os.path.dirname(filename), value))
                if target not in modules or target == os.path.dirname(filename):
                    raise ScopeFailure(8)
                edges.append((os.path.dirname(filename), target))
    reachable = {root}
    for _ in directories:
        reachable.update(target for origin, target in edges if origin in reachable)
    if set(directories) != reachable or len({target for _, target in edges}) != len(modules):
        raise ScopeFailure(8)
    def visit(origin, ancestors):
        if origin in ancestors:
            raise ScopeFailure(8)
        for parent, target in edges:
            if parent == origin:
                visit(target, ancestors | {origin})
    visit(root, set())
    for entry in context["variableFiles"]:
        with open(os.path.join(source_root, *entry["pathParts"]), "r") as source:
            values = hcl2.load(source)
        if any(key in assignments or key not in declarations for key in values):
            raise ScopeFailure(9)
        for name, value in values.items():
            if not isinstance(value, list) or len(value) != 1:
                raise ScopeFailure(9)
            assignments[name] = value[0]
    required = [name for name, conf in declarations.items() if "default" not in conf]
    if any(name not in assignments or assignments[name] is None for name in required):
        raise ScopeFailure(7)
    return [len(edges), len(required)]

def project_reports(reports, exact_file):
    if not isinstance(reports, list) or len(reports) != 1:
        raise BoundaryFailure()
    report = reports[0]
    summary = report.get_summary()
    expected_keys = {"passed", "failed", "skipped", "parsing_errors", "resource_count", "checkov_version"}
    if set(summary) != expected_keys or summary["checkov_version"] != EXPECTED_VERSION:
        raise BoundaryFailure()
    numbers = [summary[k] for k in ("resource_count", "passed", "failed", "skipped", "parsing_errors")]
    if any(type(n) is not int or n < 0 or n > 10000 for n in numbers):
        raise BoundaryFailure()
    records = report.passed_checks + report.failed_checks + report.skipped_checks
    if len(records) != sum(numbers[1:4]):
        raise BoundaryFailure()
    identity_ok, status_ok, first, last = 1, 1, 0, 0
    for group, expected in ((report.passed_checks, "PASSED"), (report.failed_checks, "FAILED"), (report.skipped_checks, "SKIPPED")):
        for record in group:
            if record.check_id != RULE or record.resource != RESOURCE or record.file_abs_path != exact_file:
                identity_ok = 0
            result = record.check_result
            status = result.get("result")
            if getattr(status, "name", None) != expected or result.get("suppress_comment"):
                status_ok = 0
            lines = record.file_line_range
            if not isinstance(lines, (list, tuple)) or len(lines) != 2 or any(type(n) is not int for n in lines):
                raise BoundaryFailure()
            first, last = lines
    error_status = getattr(report.error_status, "name", None)
    return [2, int(report.check_type == "terraform"), *numbers, identity_ok, status_ok,
            first, last, int(error_status == "SUCCESS")]

def bootstrap_scope(scope):
    return (scope["framework"] == "terraform" and all(
        entry["pathParts"][:-1] == ["infrastructure", "opentofu", "bootstrap"] for entry in scope["files"]))

def operator_prefixes(configuration):
    values = configuration.get("address_prefixes")
    if isinstance(values, list) and len(values) == 1 and isinstance(values[0], list):
        values = values[0]
    if not isinstance(values, list) or any(not isinstance(value, str) or "$" + "{" in value for value in values):
        return None
    return values

def bootstrap_graph_scope(scope):
    return (bootstrap_scope(scope) and scope.get("terraformContext") is not None
            and sorted(entry["pathParts"][-1] for entry in scope["files"])
                == ["main.tf", "outputs.tf", "variables.tf", "versions.tf"])

def bootstrap_graph_contract(scope):
    import hcl2
    resources = {}
    data_sources = set()
    for entry in scope["files"]:
        with open(os.path.join(ROOT, "inputs", *entry["pathParts"]), "r") as source:
            contents = source.read()
        if entry["pathParts"][-1] == "variables.tf" and hashlib.sha256(contents.encode()).hexdigest() != "82937a4dedecd7600989f909faafd45343059bbadfe80989f2af841c3f41bfbd":
            return [False, False]
        document = hcl2.loads(contents)
        for block in document.get("data", []):
            for kind, instances in block.items():
                for name in instances:
                    identity = kind + "." + name
                    if identity in data_sources:
                        return [False, False]
                    data_sources.add(identity)
        for block in document.get("resource", []):
            for kind, instances in block.items():
                for name, conf in instances.items():
                    identity = kind + "." + name
                    if identity in resources:
                        return [False, False]
                    resources[identity] = conf
    expected = {
        "azurerm_resource_group.state", "azurerm_network_security_perimeter.telemetry",
        "azurerm_network_security_perimeter_profile.telemetry_storage",
        "azurerm_network_security_perimeter_access_rule.operators", "azapi_resource.state_storage",
        "azurerm_network_security_perimeter_association.state_storage", "azapi_update_resource.blob_service",
        "azapi_resource.state_container", "azurerm_role_assignment.state_blob_contributor", "time_sleep.role_propagation"
    }
    if set(resources) != expected or data_sources != {"azurerm_client_config.current"}:
        return [False, False]
    def value(resource, key):
        conf = resources[resource]
        for part in key.split("."):
            if isinstance(conf, list) and len(conf) == 1:
                conf = conf[0]
            if not isinstance(conf, dict):
                return None
            conf = conf.get(part)
        return conf[0] if isinstance(conf, list) and len(conf) == 1 else conf
    reference = lambda name: "$" + "{" + name + "}"
    profile = reference("azurerm_network_security_perimeter_profile.telemetry_storage.id")
    storage = reference("azapi_resource.state_storage.id")
    blob = storage + "/blobServices/default"
    contracts = [
        ("azurerm_network_security_perimeter.telemetry", "resource_group_name", reference("azurerm_resource_group.state.name")),
        ("azurerm_network_security_perimeter_profile.telemetry_storage", "network_security_perimeter_id", reference("azurerm_network_security_perimeter.telemetry.id")),
        ("azurerm_network_security_perimeter_access_rule.operators", "network_security_perimeter_profile_id", profile),
        ("azurerm_network_security_perimeter_association.state_storage", "network_security_perimeter_profile_id", profile),
        ("azurerm_network_security_perimeter_association.state_storage", "resource_id", storage),
        ("azapi_resource.state_storage", "parent_id", reference("azurerm_resource_group.state.id")),
        ("azapi_resource.state_storage", "type", "Microsoft.Storage/storageAccounts@2023-05-01"),
        ("azapi_resource.state_container", "parent_id", blob),
        ("azapi_resource.state_container", "type", "Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01"),
        ("azapi_update_resource.blob_service", "resource_id", blob),
        ("azapi_update_resource.blob_service", "type", "Microsoft.Storage/storageAccounts/blobServices@2023-05-01"),
        ("azurerm_role_assignment.state_blob_contributor", "scope", storage),
        ("azurerm_role_assignment.state_blob_contributor", "role_definition_name", "Storage Blob Data Contributor"),
        ("azurerm_role_assignment.state_blob_contributor", "principal_id", reference("data.azurerm_client_config.current.object_id")),
        ("time_sleep.role_propagation", "triggers.role_assignment_id", reference("azurerm_role_assignment.state_blob_contributor.id"))
    ]
    for resource, key, expected in contracts:
        if key == "type":
            actual = value(resource, key)
            if not isinstance(actual, str) or actual.lower() != expected.lower():
                return [False, False]
    values = [(value(resource, key), expected) for resource, key, expected in contracts if key != "type"]
    if any(actual is not None and (not isinstance(actual, str) or "$" + "{var." in actual or "$" + "{local." in actual)
           for actual, expected in values):
        return [False, False]
    protected = ("azurerm_resource_group.state", "azurerm_network_security_perimeter.telemetry",
                 "azurerm_network_security_perimeter_profile.telemetry_storage", "azapi_resource.state_storage",
                 "azapi_resource.state_container")
    lifecycle = [value(resource, "lifecycle.prevent_destroy") for resource in protected]
    if any(actual is not None and type(actual) is not bool for actual in lifecycle):
        return [False, False]
    return [True, all(actual == expected for actual, expected in values) and all(actual is True for actual in lifecycle)]

def telemetry_graph_scope(scope):
    return (scope["framework"] == "terraform"
            and all(entry["pathParts"][:-1] == ["infrastructure", "opentofu", "telemetry"] for entry in scope["files"])
            and sorted(entry["pathParts"][-1] for entry in scope["files"])
                == ["container-app.tf", "main.tf", "outputs.tf", "variables.tf", "versions.tf"])

def telemetry_graph_contract(scope):
    import hcl2
    resources = {}
    local_values = {}
    for entry in scope["files"]:
        with open(os.path.join(ROOT, "inputs", *entry["pathParts"]), "r") as source:
            contents = source.read()
        if entry["pathParts"][-1] == "variables.tf" and hashlib.sha256(contents.encode()).hexdigest() != "6a6f775393ae1d423486616459530fc75da85b59d30f4ae8a95cb54fbd22af3c":
            return [False, False]
        document = hcl2.loads(contents)
        if document.get("data") or document.get("module"):
            return [False, False]
        for block in document.get("locals", []):
            for name, value in block.items():
                if name in ("__start_line__", "__end_line__"):
                    if type(value) is not int or not 0 < value <= len(contents.splitlines()):
                        return [False, False]
                    continue
                if name in local_values:
                    return [False, False]
                local_values[name] = value[0] if isinstance(value, list) and len(value) == 1 else value
        for block in document.get("resource", []):
            for kind, instances in block.items():
                for name, conf in instances.items():
                    identity = kind + "." + name
                    if identity in resources:
                        return [False, False]
                    resources[identity] = conf
    expected = {
        "azurerm_resource_group.telemetry", "azurerm_user_assigned_identity.telemetry",
        "azurerm_log_analytics_workspace.telemetry", "azurerm_log_analytics_workspace_table_custom_log.command_events",
        "azurerm_monitor_data_collection_endpoint.telemetry", "azurerm_monitor_data_collection_rule.telemetry",
        "azurerm_role_assignment.monitor_ingestion", "azurerm_container_registry.telemetry",
        "azapi_resource.telemetry_image_build_task", "azurerm_container_registry_task_schedule_run_now.telemetry_image",
        "azurerm_role_assignment.container_registry_pull", "time_sleep.container_registry_pull_propagation",
        "azurerm_container_app_environment.telemetry", "azurerm_container_app.telemetry"
    }
    if set(resources) != expected:
        return [False, False]
    def value(resource, key):
        conf = resources[resource]
        for part in key.split("."):
            if isinstance(conf, list) and len(conf) == 1:
                conf = conf[0]
            if not isinstance(conf, dict):
                return None
            conf = conf.get(part)
        return conf[0] if isinstance(conf, list) and len(conf) == 1 else conf
    ref = lambda name: "$" + "{" + name + "}"
    revision_expression = local_values.get("image_build_revisions")
    # The pinned HCL transformer serializes tuple expression members with
    # their own interpolation wrapper before rendering the outer function.
    expected_revisions = ref("setunion(var.retained_image_revisions,toset(['" + ref("var.source_revision") + "']))")
    if (not isinstance(revision_expression, str)
            or re.sub(r"\s+", "", revision_expression) != re.sub(r"\s+", "", expected_revisions)):
        return [False, False]
    if (local_values.get("image_repository") != "telemetry-ingest"
            or local_values.get("input_stream_name") != "Custom-LiftoffCommandEvents"
            or local_values.get("output_stream_name") != "Custom-LiftoffCommandEvents_CL"):
        return [False, False]
    group = "azurerm_resource_group.telemetry"
    identity = "azurerm_user_assigned_identity.telemetry"
    registry = "azurerm_container_registry.telemetry"
    workspace = "azurerm_log_analytics_workspace.telemetry"
    table = "azurerm_log_analytics_workspace_table_custom_log.command_events"
    endpoint = "azurerm_monitor_data_collection_endpoint.telemetry"
    rule = "azurerm_monitor_data_collection_rule.telemetry"
    app = "azurerm_container_app.telemetry"
    environment = "azurerm_container_app_environment.telemetry"
    task = "azapi_resource.telemetry_image_build_task"
    expected_api = "Microsoft.ContainerRegistry/registries/tasks@2019-04-01"
    if not isinstance(value(task, "type"), str) or value(task, "type").lower() != expected_api.lower():
        return [False, False]
    contracts = [
        (group, "lifecycle.prevent_destroy", True),
        (workspace, "local_authentication_enabled", False),
        (workspace, "internet_ingestion_access_type", "Enabled"),
        (workspace, "internet_query_access_type", "Enabled"),
        (workspace, "retention_in_days", 180),
        (table, "workspace_id", ref(workspace + ".id")),
        (table, "retention_in_days", 180), (table, "total_retention_in_days", 180),
        (endpoint, "public_network_access_enabled", True),
        (rule, "data_collection_endpoint_id", ref(endpoint + ".id")),
        (rule, "destinations.log_analytics.workspace_resource_id", ref(workspace + ".id")),
        (rule, "data_flow.transform_kql", "source | project TimeGenerated, EventName, SchemaVersion, Command, CliVersion, Outcome"),
        ("azurerm_role_assignment.monitor_ingestion", "scope", ref(rule + ".id")),
        ("azurerm_role_assignment.monitor_ingestion", "role_definition_name", "Monitoring Metrics Publisher"),
        ("azurerm_role_assignment.monitor_ingestion", "principal_id", ref(identity + ".principal_id")),
        (registry, "sku", "Basic"), (registry, "admin_enabled", False),
        (registry, "anonymous_pull_enabled", False), (registry, "public_network_access_enabled", True),
        ("azurerm_role_assignment.container_registry_pull", "scope", ref(registry + ".id")),
        ("azurerm_role_assignment.container_registry_pull", "role_definition_name", "AcrPull"),
        ("azurerm_role_assignment.container_registry_pull", "principal_id", ref(identity + ".principal_id")),
        ("time_sleep.container_registry_pull_propagation", "triggers.role_assignment_id", ref("azurerm_role_assignment.container_registry_pull.id")),
        (task, "parent_id", ref(registry + ".id")),
        (task, "body.properties.step.contextPath", "https://github.com/voyager163/liftoff.git#" + ref("each.value")),
        (task, "body.properties.step.dockerFilePath", "services/telemetry-ingest/Dockerfile"),
        (task, "body.properties.step.imageNames", ref("local.image_repository") + ":" + ref("each.value")),
        (task, "body.properties.platform.architecture", "amd64"), (task, "body.properties.platform.os", "Linux"),
        (task, "body.properties.credentials.sourceRegistry.loginMode", "Default"),
        ("azurerm_container_registry_task_schedule_run_now.telemetry_image", "container_registry_task_id", ref("azapi_resource.telemetry_image_build_task[each.value].id")),
        (app, "container_app_environment_id", ref(environment + ".id")),
        (app, "identity.type", "UserAssigned"), (app, "identity.identity_ids", [ref(identity + ".id")]),
        (app, "registry.server", ref(registry + ".login_server")), (app, "registry.identity", ref(identity + ".id")),
        (app, "ingress.allow_insecure_connections", False),
        (app, "ingress.external_enabled", ref("var.ingestion_enabled")),
        (app, "template.container.image", ref(registry + ".login_server") + "/" + ref("local.image_repository") + "@" + ref("var.image_digest"))
    ]
    for resource in (identity, workspace, endpoint, rule, registry, environment, app):
        contracts.append((resource, "resource_group_name", ref(group + ".name")))
    values = [(value(resource, key), expected) for resource, key, expected in contracts]
    if any(actual is not None and type(actual) is not type(expected) for actual, expected in values):
        return [False, False]
    if (value(environment, "log_analytics_workspace_id") is not None
            or value(environment, "logs_destination") not in (None, "none")
            or value(app, "secret") is not None or value(app, "registry.username") is not None
            or value(app, "registry.password_secret_name") is not None):
        return [True, False]
    credentials = value(task, "body.properties.credentials")
    source_registry = value(task, "body.properties.credentials.sourceRegistry")
    if (not isinstance(credentials, dict) or set(credentials) != {"sourceRegistry"}
            or not isinstance(source_registry, dict) or set(source_registry) != {"loginMode"}):
        return [True, False]
    expected_columns = {"TimeGenerated", "EventName", "SchemaVersion", "Command", "CliVersion", "Outcome"}
    def columns(conf, time_type):
        if not isinstance(conf, dict):
            return False
        entries = conf.get("column")
        if not isinstance(entries, list) or len(entries) != 6:
            return False
        observed = {}
        for item in entries:
            name, kind = item.get("name"), item.get("type")
            if not isinstance(name, list) or len(name) != 1 or not isinstance(kind, list) or len(kind) != 1:
                return False
            if name[0] in observed:
                return False
            observed[name[0]] = kind[0]
        return (set(observed) == expected_columns and all(
            kind == (time_type if name == "TimeGenerated" else "int" if name == "SchemaVersion" else "string")
            for name, kind in observed.items()))
    stream = value(rule, "stream_declaration")
    envs = value(app, "template.container.env")
    required_env = {
        "AZURE_CLIENT_ID": ref(identity + ".client_id"),
        "TELEMETRY_DCE_ENDPOINT": ref(endpoint + ".logs_ingestion_endpoint"),
        "TELEMETRY_DCR_IMMUTABLE_ID": ref(rule + ".immutable_id"),
        "TELEMETRY_STREAM_NAME": ref("local.input_stream_name")
    }
    actual_env = {}
    if not isinstance(envs, list) or len(envs) != len(required_env):
        return [False, False]
    for env in envs:
        if not isinstance(env, dict) or set(env) != {"name", "value"}:
            return [False, False]
        name, configured = env["name"], env["value"]
        if not isinstance(name, list) or len(name) != 1 or not isinstance(configured, list) or len(configured) != 1:
            return [False, False]
        if name[0] in actual_env:
            return [False, False]
        actual_env[name[0]] = configured[0]
    return [True, all(actual == expected for actual, expected in values)
            and columns(resources[table], "dateTime") and columns(stream, "datetime") and actual_env == required_env]

def project_scope(reports, runners, scope):
    global role_facts, registry_result_indexes, compose_proof, generated_role_facts, generated_registry_indexes
    global generated_optional_facts, generated_optional_indexes
    global generated_default_facts, generated_default_indexes
    frameworks = ("terraform", "dockerfile", "yaml")
    prefixes = ("CKV_AZURE_", "CKV2_AZURE_", "CKV_DOCKER_", "CKV2_LIFTOFF_")
    files = [os.path.join(ROOT, "inputs", *entry["pathParts"]) for entry in scope["files"]]
    if len(reports) != 1 or reports[0].check_type != scope["framework"]:
        raise BoundaryFailure()
    report = reports[0]
    summary = report.get_summary()
    expected_keys = {"passed", "failed", "skipped", "parsing_errors", "resource_count", "checkov_version"}
    if set(summary) != expected_keys or summary["checkov_version"] != EXPECTED_VERSION:
        raise BoundaryFailure()
    numbers = [summary[k] for k in ("resource_count", "passed", "failed", "skipped", "parsing_errors")]
    if any(type(n) is not int or n < 0 or n > 10000 for n in numbers):
        raise BoundaryFailure()
    parsed = set()
    resource_configurations = {}
    compose_services = {}
    selected = [runner for runner in runners if runner.check_type == scope["framework"]]
    if len(selected) != 1:
        raise BoundaryFailure()
    for key in selected[0].definitions:
        name = key if isinstance(key, str) else key.file_path
        if name not in files:
            raise BoundaryFailure()
        parsed.add(files.index(name))
        if scope["framework"] == "yaml":
            definition = selected[0].definitions[key]
            services = definition.get("services") if isinstance(definition, dict) else None
            if not isinstance(services, dict):
                raise ScopeFailure(9)
            for service, configuration in services.items():
                if service in ("__startline__", "__endline__"):
                    continue
                if not isinstance(configuration, dict):
                    raise ScopeFailure(9)
                compose_services[(name, service)] = configuration
        if scope["framework"] == "terraform":
            for entity in selected[0].definitions[key].get("resource", []):
                for resource_type, instances in entity.items():
                    for resource_name, configuration in instances.items():
                        resource_configurations[(name, resource_type + "." + resource_name)] = configuration
    def configuration(filename, resource):
        return resource_configurations.get((os.path.join(ROOT, "inputs", "infrastructure", "opentofu", "telemetry", filename), resource), {})
    def one(configuration, name):
        value = configuration.get(name) if isinstance(configuration, dict) else None
        return value[0] if isinstance(value, list) and len(value) == 1 else None
    def block(configuration, name):
        value = one(configuration, name)
        return value if isinstance(value, dict) else {}
    generated_role_facts = [0] * 12
    generated_optional_facts = [0] * 4
    generated_default_facts = [0] * 4
    generated_registry_file = None
    generated_context = scope.get("terraformContext")
    expected_module = ["infrastructure", "opentofu", "azure", "modules", "application"]
    if (scope["framework"] == "terraform" and generated_context
            and generated_context["moduleDirectories"] == [expected_module]
            and generated_context["rootDirectory"][:-1] == ["infrastructure", "opentofu", "azure", "environments"]
            and generated_context["rootDirectory"][-1] in ("dev", "staging", "prod")):
        import hcl2
        generated_registry_file = os.path.join(ROOT, "inputs", *expected_module, "main.tf")
        provider_file = os.path.join(ROOT, "inputs", *generated_context["rootDirectory"], "versions.tf")
        generated = {}
        if generated_registry_file in files and provider_file in files:
            with open(generated_registry_file, "r") as source:
                document = hcl2.load(source)
            for entity in document.get("resource", []):
                for kind, instances in entity.items():
                    for name, conf in instances.items():
                        generated[kind + "." + name] = conf
            with open(provider_file, "r") as source:
                provider_document = hcl2.load(source)
            terraform = provider_document.get("terraform", [])
            providers = block(terraform[0], "required_providers") if len(terraform) == 1 else {}
            provider = block(providers, "azurerm")
            provider_source, provider_version = provider.get("source"), provider.get("version")
            if isinstance(provider_source, list) and len(provider_source) == 1:
                provider_source = provider_source[0]
            if isinstance(provider_version, list) and len(provider_version) == 1:
                provider_version = provider_version[0]
            provider_pin = provider_source == "hashicorp/azurerm" and provider_version == "5.3.0"
            registry = generated.get("azurerm_container_registry.main", {})
            assignment = generated.get("azurerm_role_assignment.acr_pull", {})
            identity = generated.get("azurerm_user_assigned_identity.app", {})
            backend = generated.get("azurerm_container_app.backend", {})
            app_identity, app_registry = block(backend, "identity"), block(backend, "registry")
            def native_boolean(name, default):
                if name not in registry:
                    return default if provider_pin else None
                value = one(registry, name)
                return value if type(value) is bool else None
            identity_ref = "$" + "{azurerm_user_assigned_identity.app.id}"
            consumers = [conf for name, conf in generated.items() if name.startswith("azurerm_container_app.")]
            consumer_identities = [block(conf, "identity") for conf in consumers]
            consumer_registries = [block(conf, "registry") for conf in consumers]
            generated_role_facts = [int(value) for value in (
                provider_pin, bool(registry), one(registry, "sku") == "Basic",
                native_boolean("admin_enabled", False) is False,
                native_boolean("anonymous_pull_enabled", False) is False,
                native_boolean("public_network_access_enabled", True) is True,
                bool(identity),
                one(assignment, "scope") == "$" + "{azurerm_container_registry.main.id}",
                one(assignment, "principal_id") == "$" + "{azurerm_user_assigned_identity.app.principal_id}",
                one(assignment, "role_definition_name") == "AcrPull",
                bool(backend) and bool(consumers) and all(one(conf, "type") == "UserAssigned"
                    and one(conf, "identity_ids") == [identity_ref] for conf in consumer_identities),
                bool(consumers) and all(one(conf, "server") == "$" + "{azurerm_container_registry.main.login_server}"
                    and one(conf, "identity") == identity_ref for conf in consumer_registries)
            )]
            postgres = generated.get("azurerm_postgresql_flexible_server.main", {})
            redis = generated.get("azurerm_redis_cache.main", {})
            storage = generated.get("azurerm_storage_account.main", {})
            plan = generated.get("azurerm_service_plan.functions", {})
            worker = generated.get("azurerm_linux_function_app.worker", {})
            servicebus = generated.get("azurerm_servicebus_namespace.main", {})
            generated_default_facts = [int(provider_pin and bool(conf)
                and all(key not in conf for key in (field, "lifecycle", "provider", "dynamic")))
                for conf, field in (
                    (storage, "min_tls_version"), (redis, "minimum_tls_version"),
                    (storage, "allow_nested_items_to_be_public"), (servicebus, "minimum_tls_version")
                )]
            generated_optional_facts = [int(value) for value in (
                provider_pin and one(postgres, "sku_name") == "B_Standard_B1ms"
                    and "geo_redundant_backup_enabled" not in postgres and "high_availability" not in postgres,
                provider_pin and one(redis, "sku_name") == "Basic" and one(redis, "capacity") == 0
                    and one(redis, "family") == "C",
                provider_pin and one(storage, "account_tier") == "Standard"
                    and one(storage, "account_replication_type") == "LRS",
                provider_pin and one(plan, "sku_name") == "Y1" and one(plan, "os_type") == "Linux"
                    and "worker_count" not in plan and "zone_balancing_enabled" not in plan
                    and one(worker, "service_plan_id") == "$" + "{azurerm_service_plan.functions.id}"
            )]
    original_references = {}
    bootstrap_original = {}
    bootstrap_assignments = {}
    if scope["framework"] == "terraform":
        import hcl2
        if bootstrap_scope(scope):
            for filename in files:
                with open(filename, "r") as source:
                    document = hcl2.load(source)
                for entity in document.get("resource", []):
                    for resource_type, instances in entity.items():
                        for resource_name, conf in instances.items():
                            bootstrap_original[(filename, resource_type + "." + resource_name)] = conf
            for entry in (scope.get("terraformContext") or {}).get("variableFiles", []):
                with open(os.path.join(ROOT, "inputs", *entry["pathParts"]), "r") as source:
                    for key, value in hcl2.load(source).items():
                        if key in bootstrap_assignments:
                            raise ScopeFailure(10)
                        bootstrap_assignments[key] = value
        for name in ("main.tf", "container-app.tf"):
            original = os.path.join(ROOT, "inputs", "infrastructure", "opentofu", "telemetry", name)
            if original not in files:
                continue
            with open(original, "r") as source:
                document = hcl2.load(source)
            for entity in document.get("resource", []):
                for resource_type, instances in entity.items():
                    for resource_name, conf in instances.items():
                        original_references[resource_type + "." + resource_name] = conf
    registry = configuration("container-app.tf", "azurerm_container_registry.telemetry")
    assignment = original_references.get("azurerm_role_assignment.container_registry_pull", {})
    identity = configuration("main.tf", "azurerm_user_assigned_identity.telemetry")
    application = configuration("container-app.tf", "azurerm_container_app.telemetry")
    original_app = original_references.get("azurerm_container_app.telemetry", {})
    app_identity, app_registry = block(original_app, "identity"), block(original_app, "registry")
    identity_ref = "$" + "{azurerm_user_assigned_identity.telemetry.id}"
    port = one(block(application, "ingress"), "target_port")
    container = block(block(application, "template"), "container")
    def valid_probe(kind):
        probe = block(container, kind)
        return (type(port) is int and 0 < port < 65536 and one(probe, "port") == port
                and one(probe, "transport") == "TCP"
                and type(one(probe, "timeout")) is int and one(probe, "timeout") > 0
                and type(one(probe, "interval_seconds")) is int and one(probe, "interval_seconds") > 0
                and type(one(probe, "failure_count_threshold")) is int and one(probe, "failure_count_threshold") > 0)
    role_facts = [int(value) for value in (
        bool(registry), one(registry, "sku") == "Basic",
        one(registry, "public_network_access_enabled") is True,
        one(registry, "admin_enabled") is False, one(registry, "anonymous_pull_enabled") is False,
        bool(identity),
        one(assignment, "scope") == "$" + "{azurerm_container_registry.telemetry.id}",
        one(assignment, "principal_id") == "$" + "{azurerm_user_assigned_identity.telemetry.principal_id}",
        one(assignment, "role_definition_name") == "AcrPull",
        one(app_identity, "type") == "UserAssigned" and one(app_identity, "identity_ids") == [identity_ref],
        one(app_registry, "server") == "$" + "{azurerm_container_registry.telemetry.login_server}"
            and one(app_registry, "identity") == identity_ref,
        valid_probe("startup_probe"), valid_probe("readiness_probe"), valid_probe("liveness_probe")
    )]
    records = []
    registry_result_indexes = []
    generated_registry_indexes = []
    generated_optional_indexes = [[], [], [], []]
    generated_default_indexes = [[], [], [], []]
    yaml_native_ranges = []
    checked_resources = set()
    for group, status in ((report.passed_checks, 0), (report.failed_checks, 1), (report.skipped_checks, 2)):
        for entry in group:
            if (generated_registry_file is not None and entry.file_abs_path == generated_registry_file
                    and (entry.resource == "azurerm_container_registry.main"
                         or entry.resource.endswith(".azurerm_container_registry.main"))):
                generated_registry_indexes.append(len(records))
            optional_resources = ("azurerm_postgresql_flexible_server.main", "azurerm_redis_cache.main",
                                  "azurerm_storage_account.main", "azurerm_service_plan.functions")
            if generated_registry_file is not None and entry.file_abs_path == generated_registry_file:
                for index, resource in enumerate(optional_resources):
                    if entry.resource == resource or entry.resource.endswith("." + resource):
                        generated_optional_indexes[index].append(len(records))
                default_resources = (
                    ("CKV_AZURE_44", "azurerm_storage_account.main"),
                    ("CKV_AZURE_148", "azurerm_redis_cache.main"),
                    ("CKV_AZURE_190", "azurerm_storage_account.main"),
                    ("CKV_AZURE_205", "azurerm_servicebus_namespace.main")
                )
                for index, (rule, resource) in enumerate(default_resources):
                    if entry.check_id == rule and entry.resource in (resource, "module.application." + resource):
                        generated_default_indexes[index].append(len(records))
            prefix_index = next((i for i, prefix in enumerate(prefixes) if entry.check_id.startswith(prefix)), None)
            if prefix_index is None or entry.file_abs_path not in files:
                raise BoundaryFailure()
            suffix = entry.check_id[len(prefixes[prefix_index]):]
            if not suffix.isascii() or not suffix.isdecimal() or str(int(suffix)) != suffix:
                raise BoundaryFailure()
            result = entry.check_result
            if getattr(result.get("result"), "name", None) != ("PASSED", "FAILED", "SKIPPED")[status]:
                raise BoundaryFailure()
            if result.get("suppress_comment") and status != 2:
                raise BoundaryFailure()
            if (entry.resource == "azurerm_container_registry.telemetry"
                and entry.file_abs_path == os.path.join(ROOT, "inputs", "infrastructure", "opentofu", "telemetry", "container-app.tf")):
                registry_result_indexes.append(len(records))
            lines = entry.file_line_range
            if not isinstance(lines, (list, tuple)) or len(lines) != 2 or any(type(n) is not int for n in lines):
                raise BoundaryFailure()
            applicability = 3
            if scope["framework"] == "yaml":
                if prefix_index != 3 or suffix != "6":
                    raise BoundaryFailure()
                selected_service = None
                for (filename, service), conf in compose_services.items():
                    key = "services." + service + ".CKV2_LIFTOFF_6[" + str(conf["__startline__"]) + ":" + str(conf["__endline__"]) + "]"
                    if entry.resource == filename + "." + key:
                        selected_service = conf
                        break
                if selected_service is None:
                    raise BoundaryFailure()
                if lines != [selected_service["__startline__"], selected_service["__endline__"] + 1]:
                    raise BoundaryFailure()
                yaml_native_ranges.append([len(records), *lines])
                # The pinned generic YAML runner adds one to an exclusive
                # parser end. Keep its native range and emit inclusive lines.
                lines = [lines[0], selected_service["__endline__"] - 1]
                applicability = 0 if "image" not in selected_service and status == 0 else 1
            elif prefix_index == 3 and suffix == "10":
                if not telemetry_graph_scope(scope) or entry.resource != "azurerm_container_app.telemetry" or not telemetry_graph[0]:
                    raise ScopeFailure(10)
                applicability = 1
            elif prefix_index == 3 and suffix == "9":
                if not bootstrap_graph_scope(scope) or entry.resource != "azurerm_network_security_perimeter_association.state_storage":
                    raise ScopeFailure(10)
                if not bootstrap_graph[0]:
                    raise ScopeFailure(10)
                applicability = 1
            elif prefix_index == 3 and suffix == "8":
                configuration = resource_configurations.get((entry.file_abs_path, entry.resource))
                if not bootstrap_scope(scope) or not entry.resource.startswith("azurerm_network_security_perimeter_access_rule."):
                    raise BoundaryFailure()
                if not isinstance(configuration, dict) or operator_prefixes(configuration) is None:
                    raise ScopeFailure(10)
                original = bootstrap_original.get((entry.file_abs_path, entry.resource), {})
                declared = operator_prefixes(original)
                if declared is None:
                    value = one(original, "address_prefixes")
                    reference = re.fullmatch(r"\$\{var\.([A-Za-z_][A-Za-z0-9_]*)\}", value) if isinstance(value, str) else None
                    if reference is None or reference.group(1) not in bootstrap_assignments:
                        raise ScopeFailure(10)
                    declared = operator_prefixes({"address_prefixes": bootstrap_assignments[reference.group(1)]})
                if declared is None or sorted(declared) != sorted(operator_prefixes(configuration)):
                    raise ScopeFailure(10)
                direction = one(configuration, "direction")
                if direction is not None and (not isinstance(direction, str) or "$" + "{" in direction):
                    raise ScopeFailure(10)
                applicability = 1
            elif prefix_index == 3:
                policy = next((item for item in scope["customPolicies"] if item["id"] == int(suffix)), None)
                if policy is None:
                    raise BoundaryFailure()
                configuration = resource_configurations.get((entry.file_abs_path, entry.resource))
                if not isinstance(configuration, dict):
                    raise BoundaryFailure()
                applicability = 1
                if policy["apiType"] is not None:
                    api_type = configuration.get("type")
                    if not isinstance(api_type, list) or len(api_type) != 1 or not isinstance(api_type[0], str):
                        raise ScopeFailure(10)
                    expected_type = policy["apiType"].lower()
                    prefix = expected_type.split("@")[0] + "@"
                    applicability = 0
                    if api_type[0].lower().startswith(prefix):
                        applicability = 1 if api_type[0].lower() == expected_type else 2
                if applicability == 1:
                    for attribute, expected in policy["propertyTypes"].items():
                        value = configuration
                        for part in attribute.split("."):
                            if isinstance(value, list) and len(value) == 1:
                                value = value[0]
                            if not isinstance(value, dict):
                                value = None
                                break
                            value = value.get(part)
                        if isinstance(value, list) and len(value) == 1:
                            value = value[0]
                        if value is not None and (
                            expected == "boolean" and type(value) is not bool
                            or expected == "string" and (not isinstance(value, str) or "$" + "{" in value)
                        ):
                            raise ScopeFailure(10)
                if applicability == 2 and status != 1 or applicability == 0 and status != 0:
                    raise BoundaryFailure()
            records.append([prefix_index, int(suffix), files.index(entry.file_abs_path), *lines, status, applicability])
            if applicability in (1, 3):
                checked_resources.add((entry.file_abs_path, entry.resource if scope["framework"] != "dockerfile" else None))
    if len(records) != sum(numbers[1:4]):
        raise BoundaryFailure()
    compose_proof = []
    if scope["framework"] == "yaml":
        if not compose_services or len(records) != len(compose_services):
            raise BoundaryFailure()
        compose_proof = [len(compose_services), sum(record[6] == 0 for record in records), yaml_native_ranges]
    return [11, frameworks.index(scope["framework"]), *numbers,
            int(getattr(report.error_status, "name", None) == "SUCCESS"), sorted(parsed), records, len(checked_resources)]

def selftest():
    from types import SimpleNamespace
    fake = SimpleNamespace(
        check_id=RULE, resource=RESOURCE, file_abs_path="/fixture.tf",
        check_result={"result": SimpleNamespace(name="PASSED")},
        file_line_range=[1, 9],
        code_block=[(1, "CHECKOV_NONFUNCTIONAL_BOUNDARY_SENTINEL_000000")],
        check_name="CHECKOV_NONFUNCTIONAL_BOUNDARY_SENTINEL_000000",
        entity_tags={"probe": "CHECKOV_NONFUNCTIONAL_BOUNDARY_SENTINEL_000000"}
    )
    report = SimpleNamespace(
        check_type="terraform", passed_checks=[fake], failed_checks=[], skipped_checks=[],
        error_status=SimpleNamespace(name="SUCCESS"),
        get_summary=lambda: {"passed": 1, "failed": 0, "skipped": 0, "parsing_errors": 0,
                            "resource_count": 1, "checkov_version": EXPECTED_VERSION}
    )
    projected = project_reports([report], "/fixture.tf")
    if projected != [2, 1, 1, 1, 0, 0, 0, 1, 1, 1, 9, 1]:
        raise BoundaryFailure()
    fake.check_id = "CHECKOV_NONFUNCTIONAL_BOUNDARY_SENTINEL_000000"
    if project_reports([report], "/fixture.tf")[7] != 0:
        raise BoundaryFailure()
    discarded = Sink()
    discarded.write("CHECKOV_NONFUNCTIONAL_BOUNDARY_SENTINEL_000000")
    if discarded.getvalue() != "":
        raise BoundaryFailure()
    probe = (8, 3, 1, socket.SOCK_STREAM, ("::1", 0), True)
    if not expected_denied_probe(*probe):
        raise BoundaryFailure()
    mismatches = (
        (0, 1), (0, 2), (1, 1), (1, 2), (2, 0), (2, 2),
        (3, socket.SOCK_DGRAM), (4, ("::", 0)), (4, ("::1", 1)),
        (4, ("::1", False)), (4, ["::1", 0]), (4, ("::1", 0, 0, 0)), (5, False)
    )
    for index, replacement in mismatches:
        changed = list(probe)
        changed[index] = replacement
        if expected_denied_probe(*changed):
            raise BoundaryFailure()
    if (
        not exact_null_sink_write(null_sink, os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
        or not exact_null_sink_write(null_sink, os.O_RDWR)
    ):
        raise BoundaryFailure()
    for name, flags in (
        (null_sink + ".log", os.O_WRONLY),
        (os.path.join(ROOT, "null"), os.O_WRONLY),
        (os.fsencode(null_sink), os.O_WRONLY),
        (null_sink, os.O_RDONLY),
        (null_sink, os.O_WRONLY | os.O_APPEND),
    ):
        if exact_null_sink_write(name, flags):
            raise BoundaryFailure()
    # Synthetic audit events exercise guards WITHOUT opening a socket/file or
    # launching a process. Real scanner invocations start with fresh counters.
    for event, arguments, index in (
        ("socket.connect", (None, None), 0),
        ("subprocess.Popen", (None, None, None, None), 1),
        ("open", ("/not-opened", "w", os.O_WRONLY), 2)
    ):
        try:
            sys.audit(event, *arguments)
        except BoundaryFailure:
            pass
        else:
            raise BoundaryFailure()
        if attempts[index] != 1:
            raise BoundaryFailure()
    attempts[:] = [0, 0, 0]
    return [2, 1]

def network_guard_test():
    global network_diagnostic
    import urllib3.util.connection as connection
    if not reviewed_probe_source(connection) or connection.HAS_IPV6 is not False:
        raise BoundaryFailure()
    if denied_ipv6_probes != int(socket.has_ipv6):
        raise BoundaryFailure()
    # Audit-only probes: no DNS resolution, connection, bind or send is executed.
    with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as local_socket:
        probes = (
            ("socket.connect", (local_socket, ("::1", 1))),
            ("socket.getaddrinfo", ("CHECKOV_NONFUNCTIONAL_BOUNDARY_SENTINEL_000000", 1, 0, 0, 0)),
            ("socket.bind", (local_socket, ("::1", 0))),
            ("socket.sendto", (local_socket, ("::1", 1)))
        )
        for index, (event, arguments) in enumerate(probes, 1):
            try:
                sys.audit(event, *arguments)
            except BoundaryFailure:
                pass
            else:
                raise BoundaryFailure()
            if attempts[0] != index:
                raise BoundaryFailure()
    attempts[:] = [0, 0, 0]
    network_diagnostic = None
    return [2, 4, denied_ipv6_probes, 4]

def process_guard_test():
    global process_diagnostic
    import platform
    if platform._Processor.from_subprocess() is not None:
        raise BoundaryFailure()
    if platform._syscmd_file(sys.executable) != "":
        raise BoundaryFailure()
    import git
    if git.GIT_OK is not False or (
        denied_processor_probes, denied_architecture_probes, denied_git_import_probes
    ) != (1, 1, 1):
        raise BoundaryFailure()
    for index, arguments in enumerate((
        ("uname", ["uname", "-p"], None, None),
        ("file", ["file", "-b", sys.executable], None, dict(os.environ, LC_ALL="C")),
        ("git", ["git", "version"], ROOT, dict(os.environ)),
        ("git", ["git", "log"], ROOT, dict(os.environ))
    ), 1):
        try:
            sys.audit("subprocess.Popen", *arguments)
        except BoundaryFailure:
            pass
        else:
            raise BoundaryFailure()
        if attempts[1] != index:
            raise BoundaryFailure()
    attempts[:] = [0, 0, 0]
    process_diagnostic = 0
    return [2, 5, 1, 1, 1, 4]

def run():
    global closure_proof, bootstrap_graph, telemetry_graph
    if MODE == "selftest":
        return selftest(), 0
    import checkov.logging_init as checkov_logging
    # Discard the internal debug log before importing the scanner/reading input.
    old_log = checkov_logging.log_stream
    discard_log = Sink(1048576)
    checkov_logging.log_stream = discard_log
    for handler in logging.getLogger().handlers:
        if getattr(handler, "stream", None) is old_log:
            handler.setStream(discard_log)
    old_log.close()
    from checkov.version import version
    if version != EXPECTED_VERSION:
        return [0, 4], 2
    if MODE == "version":
        return [2, 3, 3, 10], 0
    if MODE == "network-guard":
        return network_guard_test(), 0
    if MODE == "process-guard":
        return process_guard_test(), 0
    if MODE not in ("secure", "insecure", "scope"):
        raise BoundaryFailure()
    from checkov.main import Checkov
    exact_file = os.path.join(ROOT, MODE + ".tf")
    scope = None
    if MODE == "scope":
        with open(os.path.join(ROOT, "scope.json"), "r") as source:
            scope = json.load(source)
        selection = ["--file", *[os.path.join(ROOT, "inputs", *entry["pathParts"]) for entry in scope["files"]],
                     "--framework", scope["framework"]]
        if scope.get("terraformContext"):
            closure_proof = prepare_local_closure(scope)
            context = scope["terraformContext"]
            selection = ["--directory", os.path.join(ROOT, "inputs", *context["rootDirectory"]),
                         "--framework", "terraform"]
            for entry in context["variableFiles"]:
                selection += ["--var-file", os.path.join(ROOT, "inputs", *entry["pathParts"])]
        if scope["framework"] == "yaml":
            from checkov.yaml_doc.base_yaml_check import BaseYamlCheck
            from checkov.yaml_doc.enums import BlockType
            from checkov.common.models.enums import CheckCategories, CheckResult
            class ComposeBaselineImage(BaseYamlCheck):
                def __init__(self):
                    super().__init__(name="Retain registered immutable Compose images", id="CKV2_LIFTOFF_6",
                                     categories=(CheckCategories.SUPPLY_CHAIN,), supported_entities=("services",),
                                     block_type=BlockType.ARRAY)
                def scan_entity_conf(self, conf, entity_type):
                    image = conf.get("image")
                    if image is not None:
                        return CheckResult.PASSED if isinstance(image, str) and image in scope["compose"]["images"] else CheckResult.FAILED
                    build = conf.get("build")
                    context = build if isinstance(build, str) else build.get("context") if isinstance(build, dict) else None
                    dockerfile = build.get("dockerfile", "Dockerfile") if isinstance(build, dict) else "Dockerfile"
                    if not isinstance(context, str) or not isinstance(dockerfile, str):
                        return CheckResult.FAILED
                    context = "." if context in (".", "./") else context.removeprefix("./")
                    return CheckResult.PASSED if [context, dockerfile] in scope["compose"]["localBuilds"] else CheckResult.FAILED
            ComposeBaselineImage()
        if bootstrap_scope(scope):
            import ipaddress
            from checkov.terraform.checks.resource.base_resource_check import BaseResourceCheck
            from checkov.common.models.enums import CheckCategories, CheckResult
            class StateOperatorCidrs(BaseResourceCheck):
                def __init__(self):
                    super().__init__(name="Retain explicit IPv4 host-only state perimeter admission", id="CKV2_LIFTOFF_8",
                                     categories=(CheckCategories.NETWORKING,),
                                     supported_resources=("azurerm_network_security_perimeter_access_rule",))
                def scan_resource_conf(self, conf):
                    self.evaluated_keys = ["address_prefixes", "direction", "subscription_ids", "service_tags"]
                    prefixes = operator_prefixes(conf)
                    if not prefixes or conf.get("direction") != ["Inbound"]:
                        return CheckResult.FAILED
                    if any(conf.get(field) not in (None, [], [[]]) for field in ("subscription_ids", "service_tags")):
                        return CheckResult.FAILED
                    for value in prefixes:
                        try:
                            network = ipaddress.ip_network(value, strict=True)
                        except ValueError:
                            return CheckResult.FAILED
                        if network.version != 4 or network.prefixlen != 32:
                            return CheckResult.FAILED
                    return CheckResult.PASSED
            StateOperatorCidrs()
            if bootstrap_graph_scope(scope):
                bootstrap_graph = bootstrap_graph_contract(scope)
                class StateRoleGraph(BaseResourceCheck):
                    def __init__(self):
                        super().__init__(name="Retain exact bootstrap identity and perimeter role connections", id="CKV2_LIFTOFF_9",
                                         categories=(CheckCategories.IAM, CheckCategories.NETWORKING),
                                         supported_resources=("azurerm_network_security_perimeter_association",))
                    def scan_resource_conf(self, conf):
                        self.evaluated_keys = ["resource_id", "network_security_perimeter_profile_id"]
                        return CheckResult.PASSED if all(bootstrap_graph) else CheckResult.FAILED
                StateRoleGraph()
        if telemetry_graph_scope(scope):
            from checkov.terraform.checks.resource.base_resource_check import BaseResourceCheck
            from checkov.common.models.enums import CheckCategories, CheckResult
            telemetry_graph = telemetry_graph_contract(scope)
            class TelemetryRoleGraph(BaseResourceCheck):
                def __init__(self):
                    super().__init__(name="Retain exact telemetry identity, privacy and immutable-source contracts", id="CKV2_LIFTOFF_10",
                                     categories=(CheckCategories.IAM, CheckCategories.NETWORKING),
                                     supported_resources=("azurerm_container_app",))
                def scan_resource_conf(self, conf):
                    self.evaluated_keys = ["identity", "registry", "ingress", "template"]
                    return CheckResult.PASSED if all(telemetry_graph) else CheckResult.FAILED
            TelemetryRoleGraph()
    else:
        selection = ["--file", exact_file, "--framework", "terraform", "--check", RULE, "--hard-fail-on", RULE]
    arguments = [*selection, "--skip-download", "--download-external-modules", "False",
        "--config-file", os.path.join(ROOT, "checkov.yaml"), "--output", "json", "--quiet", "--compact"
    ]
    if scope and (scope["customPolicies"] or scope["framework"] == "yaml"):
        arguments += ["--external-checks-dir", os.path.join(ROOT, "policy")]
    sys.argv = ["checkov", *arguments]
    class MetadataCheckov(Checkov):
        projected = None
        scope_failure = None
        def print_results(self, runner_registry, url=None, created_baseline_path=None, baseline=None):
            if url or created_baseline_path or baseline:
                raise BoundaryFailure()
            try:
                self.projected = project_scope(self.scan_reports, runner_registry.runners, scope) if scope else project_reports(self.scan_reports, exact_file)
            except ScopeFailure as failure:
                self.scope_failure = failure.code
                return 2
            codes = [report.get_exit_code(runner_registry.get_fail_thresholds(self.config, report.check_type))
                     for report in self.scan_reports]
            if any(type(code) is not int or code not in (0, 1) for code in codes):
                raise BoundaryFailure()
            return 1 if 1 in codes else 0
    instance = MetadataCheckov(argv=arguments)
    input_reads.clear()
    status = instance.run()
    if instance.scope_failure is not None:
        return [0, instance.scope_failure], 2
    if instance.projected is None or type(status) is not int or status not in (0, 1):
        raise BoundaryFailure()
    projected = [*instance.projected, status, denied_ipv6_probes, len(registered_grammar_caches), discarded_null_writes, denied_processor_probes, denied_architecture_probes, denied_git_import_probes]
    if scope:
        context = scope.get("terraformContext")
        variable_reads = [] if not context else [
            index for index, entry in enumerate(context["variableFiles"])
            if os.path.join(ROOT, "inputs", *entry["pathParts"]) in input_reads
        ]
        projected.append([*closure_proof, variable_reads] if context else [])
        projected.append([role_facts, registry_result_indexes, generated_role_facts, generated_registry_indexes,
                          generated_optional_facts, generated_optional_indexes, generated_default_facts, generated_default_indexes])
        projected.append(compose_proof)
    return projected, status

try:
    result, status = run()
except ScopeFailure as failure:
    result, status = [0, failure.code], 2
except BaseException:
    result, status = [0, 1], 2
if attempts[0]:
    result, status = [0, 2, *(network_diagnostic or [0, 0, 0])], 2
elif attempts[1]:
    result, status = [0, 5, process_diagnostic], 2
elif attempts[2]:
    result, status = [0, 6, *(filesystem_diagnostic or [0, 0, 0])], 2
elif stdout_sink.count or stderr_sink.count:
    result, status = [0, 3], 2
original_output.write(json.dumps(result, separators=(",", ":")) + "\n")
original_output.flush()
sys.exit(status)
`;

function numericPayload(bytes: Uint8Array): number[] {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > CHECKOV_FIXTURE_POLICY.reportBytes) fail('invalid-report');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail('invalid-report'); }
  if (!Array.isArray(value) || value.length > 19) fail('invalid-report');
  const result: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0 || item > 10_000) fail('invalid-report');
    result.push(item);
  }
  if (result[0] === 0) {
    if (result.length === 3 && result[1] === 5) {
      const caller = PROCESS_CALLERS[result[2] ?? -1];
      if (!caller) fail('invalid-report');
      fail('subprocess-attempt', undefined, undefined, caller);
    }
    if (result.length === 5 && result[1] === 6) {
      const operation = FILESYSTEM_OPERATIONS[result[2] ?? -1];
      const destination = FILESYSTEM_DESTINATIONS[result[3] ?? -1];
      const caller = FILESYSTEM_CALLERS[result[4] ?? -1];
      if (!operation || !destination || !caller) fail('invalid-report');
      fail('filesystem-attempt', undefined, Object.freeze({ operation, destination, caller }));
    }
    if (result.length === 5 && result[1] === 2) {
      const operation = NETWORK_OPERATIONS[result[2] ?? -1];
      const family = NETWORK_FAMILIES[result[3] ?? -1];
      const installedFrame = NETWORK_FRAMES[result[4] ?? -1];
      if (!operation || !family || !installedFrame) fail('invalid-report');
      fail('network-attempt', Object.freeze({ operation, family, installedFrame }));
    }
    if (result.length !== 2) fail('invalid-report');
    if (result[1] === 2) fail('network-attempt');
    if (result[1] === 3) fail('unsafe-output');
    if (result[1] === 4) fail('version-mismatch');
    if (result[1] === 5) fail('subprocess-attempt');
    if (result[1] === 6) fail('filesystem-attempt');
    if (result[1] === 7) fail('unresolved-variables');
    if (result[1] === 8) fail('unregistered-module');
    if (result[1] === 9) fail('invalid-local-closure');
    if (result[1] === 10) fail('unresolved-policy-binding');
    fail('process-error');
  }
  return result;
}

export interface CheckovFixtureResult {
  readonly framework: 'terraform';
  readonly rule: 'CKV_AZURE_3';
  readonly assessment: 'qualified';
  readonly gate: 'passed' | 'blocked';
  readonly resourceCount: 1;
  readonly passed: 0 | 1;
  readonly failed: 0 | 1;
  readonly skipped: 0;
  readonly parsingErrors: 0;
  readonly line: number;
  readonly endLine: number;
  readonly deniedIpv6CapabilityProbes: 0 | 1;
  readonly registeredGrammarCaches: 1;
  readonly discardedNullWrites: number;
  readonly deniedProcessorCapabilityProbes: number;
  readonly deniedArchitectureCapabilityProbes: number;
  readonly deniedGitImportCapabilityProbes: 0 | 1;
}

export function parseCheckovFixtureOutput(bytes: Uint8Array, exitCode: number): CheckovFixtureResult {
  const data = numericPayload(bytes);
  if (data.length !== 19 || data[0] !== 2 || data[1] !== 1) fail('invalid-report');
  const [, , resources, passed, failed, skipped, errors, identity, status, first, last, success, nativeExit, deniedProbes, caches, nullWrites, processorProbes, architectureProbes, gitProbes] = data;
  if (resources !== 1 || skipped !== 0 || errors !== 0 || success !== 1
    || !((passed === 1 && failed === 0) || (passed === 0 && failed === 1))) fail('incomplete-analysis');
  if (identity !== 1 || status !== 1) fail('identity-mismatch');
  if (first === undefined || last === undefined || first < 1 || last < first || last > 9) fail('invalid-report');
  if (exitCode !== failed || nativeExit !== exitCode) fail('process-error');
  if (deniedProbes !== 0 && deniedProbes !== 1) fail('invalid-report');
  if (caches !== 1) fail('incomplete-analysis');
  if (nullWrites === undefined || nullWrites > 100) fail('invalid-report');
  if (processorProbes === undefined || processorProbes > 4) fail('invalid-report');
  if (architectureProbes === undefined || architectureProbes > 4) fail('invalid-report');
  if (gitProbes !== 0 && gitProbes !== 1) fail('invalid-report');
  return Object.freeze({
    framework: 'terraform', rule: 'CKV_AZURE_3', assessment: 'qualified', gate: failed === 1 ? 'blocked' : 'passed',
    resourceCount: 1, passed, failed, skipped: 0, parsingErrors: 0, line: first, endLine: last,
    deniedIpv6CapabilityProbes: deniedProbes, registeredGrammarCaches: 1, discardedNullWrites: nullWrites,
    deniedProcessorCapabilityProbes: processorProbes, deniedArchitectureCapabilityProbes: architectureProbes,
    deniedGitImportCapabilityProbes: gitProbes
  });
}

export async function qualifyCheckovBoundaryProbe(
  worktree: string, kind: 'stdout' | 'stderr' | 'metadata' | 'oversize' | 'timeout' | 'failure'
): Promise<void> {
  return guarded(async () => {
    const owned = await createPrivateFixtureWorkspace(worktree, 'checkov');
    const probes = {
      stdout: `process.stdout.write("${MARKER}")`,
      stderr: `process.stderr.write("${MARKER}")`,
      metadata: `process.stdout.write(JSON.stringify({rule:"${MARKER}",code_block:"${MARKER}"}))`,
      oversize: 'process.stdout.write("x".repeat(5000))',
      timeout: 'setInterval(()=>{},1000)',
      failure: 'process.exit(2)'
    };
    try {
      const output = await capturePrivateFixtureProcess(process.execPath, ['-e', probes[kind]], owned, {
        environment: checkovFixtureEnvironment(owned.root),
        maxBytes: CHECKOV_FIXTURE_POLICY.reportBytes, timeoutMs: kind === 'timeout' ? 100 : 5_000
      });
      try { parseCheckovFixtureOutput(output.stdout, output.exitCode); } finally { output.stdout.fill(0); }
    } finally { await owned.register(); await owned.cleanup(); }
  });
}

export interface CheckovFixtureEvidence {
  readonly scope: 'new-private-nonfunctional-fixtures-only';
  readonly version: '3.3.10';
  readonly framework: 'terraform';
  readonly rule: 'CKV_AZURE_3';
  readonly launcherDigest: string;
  readonly interpreterDigest: string;
  readonly projectorDigest: string;
  readonly configurationDigest: string;
  readonly fixtureDigests: readonly string[];
  readonly toolchainClaim: 'installed-launcher-and-interpreter-only';
  readonly repositoryContentScanned: false;
  readonly cloudOperations: false;
  readonly networkPolicy: 'downloads-disabled-and-python-audit-denied';
  readonly osNetworkSandbox: false;
  readonly ipv6ProbeModuleDigest: string;
  readonly ipv6ProbePolicy: 'reviewed-capability-probe-remains-denied';
  readonly processProbePolicy: 'reviewed-metadata-and-import-probes-remain-denied';
  readonly guardedModuleDigests: Readonly<{
    platform: string; gitPython: string; lark: string; hclParser: string; hclGrammar: string;
  }>;
  readonly limits: Readonly<{ processTimeoutMs: 60000; reportBytes: 4096; internalDebugDiscardBytes: 1048576 }>;
  readonly observedAt: string;
  readonly completedAt: string;
  readonly platform: string;
  readonly architecture: string;
  readonly results: readonly CheckovFixtureResult[];
  readonly cleanup: 'completed';
}

type CheckovMode = 'selftest' | 'version' | 'network-guard' | 'process-guard' | 'secure' | 'insecure' | 'scope';
interface CheckovRuntime {
  launcherDigest: string;
  interpreterDigest: string;
  run(mode: CheckovMode): Promise<{ exitCode: number; stdout: Buffer }>;
}

async function withCheckovRuntime<T>(
  worktree: string, executable: string, action: (runtime: CheckovRuntime) => Promise<T>, scratchParent?: string,
  scope?: CheckovInputScope
): Promise<T> {
  return guarded(async () => {
    if (!path.isAbsolute(executable) || /[\u0000-\u001f\u007f]/u.test(executable)) fail('invalid-input');
    const launcher = await realpath(executable);
    const launcherStat = await lstat(launcher);
    if (!launcherStat.isFile() || launcherStat.size > CHECKOV_FIXTURE_POLICY.launcherBytes) fail('invalid-input');
    const launcherBytes = await readFile(launcher);
    const line = launcherBytes.toString('utf8').split('\n')[0];
    if (!line || !/^#!\/[^\u0000-\u0020\u007f]+\/python(?:[0-9.]+)?$/.test(line)) fail('invalid-input');
    // Execute the virtualenv spelling, not its resolved symlink: Python needs
    // that spelling to locate the installed Checkov environment.
    const interpreter = line.slice(2);
    const resolvedInterpreter = await realpath(interpreter);
    const interpreterStat = await lstat(resolvedInterpreter);
    if (!interpreterStat.isFile() || interpreterStat.size > CHECKOV_FIXTURE_POLICY.executableBytes) fail('invalid-input');
    const launcherDigest = sha256(launcherBytes);
    const interpreterDigest = sha256(await readFile(resolvedInterpreter));
    const owned = await createPrivateFixtureWorkspace(worktree, 'checkov', scratchParent);
    try {
      const projector = await owned.write('projector.py', PROJECTOR);
      const config = await owned.write('checkov.yaml', '{}\n');
      const secure = await owned.write('secure.tf', fixture(true));
      const insecure = await owned.write('insecure.tf', fixture(false));
      if (scope) {
        validateCheckovInputScope(scope);
        await owned.directory('inputs');
        for (const entry of [...scope.files, ...scope.terraformContext?.variableFiles ?? []]) {
          const target = path.join(owned.root, 'inputs', ...entry.pathParts);
          await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, entry.content, { flag: 'wx', mode: 0o600 });
        }
        await owned.register();
        if (scope.customPolicies?.length || scope.framework === 'yaml') {
          await owned.directory('policy');
          for (const policy of scope.customPolicies ?? []) {
            await writeFile(path.join(owned.root, 'policy', policy.filename), policy.content, { flag: 'wx', mode: 0o600 });
          }
          await owned.register();
        }
        await owned.write('scope.json', scopeConfiguration(scope));
      }
      const environment = checkovFixtureEnvironment(owned.root);
      const verify = async () => {
        await owned.check();
        if (!scope) return;
        for (const entry of [...scope.files, ...scope.terraformContext?.variableFiles ?? []]) {
          const target = path.join(owned.root, 'inputs', ...entry.pathParts), stat = await lstat(target);
          if (!stat.isFile() || stat.nlink !== 1 || await realpath(target) !== target ||
              await readFile(target, 'utf8') !== entry.content) fail('identity-mismatch');
        }
        if (await readFile(path.join(owned.root, 'scope.json'), 'utf8') !== scopeConfiguration(scope)) fail('identity-mismatch');
        for (const policy of scope.customPolicies ?? []) {
          if (await readFile(path.join(owned.root, 'policy', policy.filename), 'utf8') !== policy.content) fail('identity-mismatch');
        }
      };
      const run = async (mode: CheckovMode) => {
        if (mode === 'scope' && !scope) fail('invalid-input');
        await verify();
        if (sha256(await readFile(launcher)) !== launcherDigest || sha256(await readFile(resolvedInterpreter)) !== interpreterDigest
          || await readFile(projector, 'utf8') !== PROJECTOR || await readFile(config, 'utf8') !== '{}\n'
          || await readFile(secure, 'utf8') !== fixture(true) || await readFile(insecure, 'utf8') !== fixture(false)) fail('identity-mismatch');
        const output = await capturePrivateFixtureProcess(interpreter, [
          '-I', '-B', projector, owned.root, await realpath(worktree), await realpath(homedir()), mode
        ], owned, { environment, timeoutMs: CHECKOV_FIXTURE_POLICY.timeoutMs,
          maxBytes: mode === 'scope' ? 1_048_576 : CHECKOV_FIXTURE_POLICY.reportBytes });
        await owned.register();
        try { await verify(); } catch (error) { output.stdout.fill(0); throw error; }
        return output;
      };
      return await action({ launcherDigest, interpreterDigest, run });
    } finally { await owned.register(); await owned.cleanup(); }
  });
}

export interface CheckovInputScope {
  framework: 'terraform' | 'dockerfile' | 'yaml';
  files: { pathParts: string[]; content: string; supportingOnly?: true }[];
  customPolicies?: { id: number; filename: string; content: string }[];
  terraformContext?: {
    rootDirectory: string[];
    moduleDirectories: string[][];
    variableFiles: { pathParts: string[]; content: string }[];
  };
  compose?: { images: string[]; localBuilds: [string, string][] };
}

function scopeConfiguration(scope: CheckovInputScope): string {
  return JSON.stringify({
    framework: scope.framework, files: scope.files.map(({ pathParts }) => ({ pathParts })),
    customPolicies: (scope.customPolicies ?? []).map(policy => checkovCustomPolicyFiles.find(item => item.id === policy.id)),
    compose: scope.compose ?? null,
    terraformContext: scope.terraformContext ? {
      ...scope.terraformContext,
      variableFiles: scope.terraformContext.variableFiles.map(({ pathParts }) => ({ pathParts }))
    } : null
  });
}

interface CheckovCustomPolicy {
  id: number; filename: string; resourceType: string; apiType: string | null; role: string;
  bootstrapOnly: boolean; propertyTypes: Record<string, 'boolean' | 'string'>;
}
const customPolicyDefinitions: CheckovCustomPolicy[] = [
  {
    id: 1, filename: 'azapi-storage-https.yaml',
    resourceType: 'azapi_resource', apiType: 'Microsoft.Storage/storageAccounts@2023-05-01',
    role: 'storage-account-transport', bootstrapOnly: false,
    propertyTypes: { 'body.properties.supportsHttpsTrafficOnly': 'boolean' }
  },
  {
    id: 2, filename: 'azapi-state-storage-tls.yaml',
    resourceType: 'azapi_resource', apiType: 'Microsoft.Storage/storageAccounts@2023-05-01',
    role: 'bootstrap-state-storage-tls', bootstrapOnly: true,
    propertyTypes: { 'body.properties.minimumTlsVersion': 'string' }
  },
  {
    id: 3, filename: 'azapi-state-storage-identity.yaml',
    resourceType: 'azapi_resource', apiType: 'Microsoft.Storage/storageAccounts@2023-05-01',
    role: 'bootstrap-state-storage-identity', bootstrapOnly: true,
    propertyTypes: { 'body.properties.allowSharedKeyAccess': 'boolean', 'body.properties.defaultToOAuthAuthentication': 'boolean' }
  },
  {
    id: 4, filename: 'azapi-state-container-private.yaml',
    resourceType: 'azapi_resource', apiType: 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01',
    role: 'bootstrap-state-container-privacy', bootstrapOnly: true,
    propertyTypes: { 'body.properties.publicAccess': 'string' }
  },
  {
    id: 5, filename: 'state-perimeter-enforced.yaml',
    resourceType: 'azurerm_network_security_perimeter_association', apiType: null,
    role: 'bootstrap-state-perimeter', bootstrapOnly: true,
    propertyTypes: { access_mode: 'string' }
  },
  {
    id: 7, filename: 'azapi-state-perimeter-network.yaml',
    resourceType: 'azapi_resource', apiType: 'Microsoft.Storage/storageAccounts@2023-05-01',
    role: 'bootstrap-state-private-perimeter-network', bootstrapOnly: true,
    propertyTypes: { 'body.properties.publicNetworkAccess': 'string', 'body.properties.allowBlobPublicAccess': 'boolean' }
  }
];
export const checkovCustomPolicyFiles = Object.freeze(customPolicyDefinitions.map(item =>
  Object.freeze({ ...item, propertyTypes: Object.freeze({ ...item.propertyTypes }) })));

export function validateCheckovInputScope(scope: CheckovInputScope): void {
  if (!['terraform', 'dockerfile', 'yaml'].includes(scope.framework) || !Array.isArray(scope.files) ||
      scope.files.length === 0 || scope.files.length > 100) fail('invalid-input');
  const seen = new Set<string>();
  let bytes = 0;
  for (const entry of scope.files) {
    const parts = portableParts(entry.pathParts), key = parts.join('/').toLowerCase();
    if (seen.has(key) || typeof entry.content !== 'string' || entry.content.length === 0 ||
        (scope.framework === 'terraform' ? !parts.at(-1)!.endsWith('.tf')
          : parts.at(-1) !== (scope.framework === 'yaml' ? 'docker-compose.yml' : 'Dockerfile'))) fail('invalid-input');
    if (entry.supportingOnly !== undefined && (
      entry.supportingOnly !== true || scope.framework !== 'terraform' ||
      parts.length !== 6 || parts.slice(0, 4).join('/') !== 'infrastructure/opentofu/azure/environments' ||
      !['dev', 'staging', 'prod'].includes(parts[4]!) || parts[5] !== 'backend.remote.example.tf' ||
      !entry.content.split(/\r?\n/).every(line => line.trim() === '' || line.trim().startsWith('#'))
    )) fail('invalid-input');
    seen.add(key);
    bytes += Buffer.byteLength(entry.content);
    if (bytes > 8 * 1024 * 1024) fail('invalid-input');
  }
  if (scope.framework === 'yaml') {
    if (!scope.compose || scope.files.length !== 1 || scope.customPolicies?.length ||
        !Array.isArray(scope.compose.images) || !scope.compose.images.length || scope.compose.images.length > 100 ||
        new Set(scope.compose.images).size !== scope.compose.images.length ||
        scope.compose.images.some(image => !/^[a-z0-9][a-z0-9./_-]+:[A-Za-z0-9][A-Za-z0-9._-]*@sha256:[a-f0-9]{64}$/.test(image)) ||
        !Array.isArray(scope.compose.localBuilds) || scope.compose.localBuilds.length < 1 ||
        scope.compose.localBuilds.length > 10 ||
        scope.compose.localBuilds.some(parts => parts.length !== 2 || !['.', 'frontend'].includes(parts[0]) || parts[1] !== 'Dockerfile')) fail('invalid-input');
  } else if (scope.compose) fail('invalid-input');
  const context = scope.terraformContext;
  if (context) {
    if (scope.framework !== 'terraform' || !Array.isArray(context.moduleDirectories) ||
        context.moduleDirectories.length > 10 || !Array.isArray(context.variableFiles) ||
        context.variableFiles.length < 1 || context.variableFiles.length > 10) fail('invalid-input');
    const root = portableParts(context.rootDirectory).join('/');
    const directories = [root, ...context.moduleDirectories.map(parts => portableParts(parts).join('/'))];
    if (new Set(directories.map(value => value.toLowerCase())).size !== directories.length ||
        directories.some(directory => !scope.files.some(entry => entry.pathParts.slice(0, -1).join('/') === directory)) ||
        scope.files.some(entry => !directories.includes(entry.pathParts.slice(0, -1).join('/')))) fail('invalid-input');
    for (const entry of context.variableFiles) {
      const parts = portableParts(entry.pathParts), key = parts.join('/').toLowerCase();
      if (seen.has(key) || parts.slice(0, -1).join('/') !== root || !parts.at(-1)!.endsWith('.tfvars') ||
          typeof entry.content !== 'string' || !entry.content.trim() || Buffer.byteLength(entry.content) > 65_536) fail('invalid-input');
      seen.add(key);
    }
  }
  const policies = scope.customPolicies ?? [];
  if (!Array.isArray(policies) || policies.length > checkovCustomPolicyFiles.length ||
      new Set(policies.map(item => item.id)).size !== policies.length ||
      policies.length > 0 && scope.framework !== 'terraform') fail('invalid-input');
  for (const policy of policies) {
    const registration = checkovCustomPolicyFiles.find(item => item.id === policy.id && item.filename === policy.filename);
    if (!registration ||
        typeof policy.content !== 'string' || Buffer.byteLength(policy.content) > 16_384) fail('invalid-input');
    if (registration.bootstrapOnly && scope.files.some(file =>
      file.pathParts.slice(0, -1).join('/') !== 'infrastructure/opentofu/bootstrap')) fail('invalid-input');
    let document;
    try { document = parseYaml(policy.content); } catch { return fail('invalid-input'); }
    if (!document || typeof document !== 'object' || Array.isArray(document) ||
        Object.keys(document).some(key => !['metadata', 'definition'].includes(key)) ||
        document.metadata?.id !== `CKV2_LIFTOFF_${policy.id}` || document.metadata?.severity !== 'HIGH' ||
        !document.definition || typeof document.definition !== 'object') fail('invalid-input');
  }
}

export function parseCheckovScopeOutput(bytes: Uint8Array, exitCode: number, scope: CheckovInputScope) {
  validateCheckovInputScope(scope);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 1_048_576) fail('invalid-report');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail('invalid-report'); }
  if (!Array.isArray(value)) fail('invalid-report');
  if (value[0] === 0) numericPayload(bytes);
  if (value.length !== 21 || value[0] !== 11 ||
      value[1] !== ['terraform', 'dockerfile', 'yaml'].indexOf(scope.framework)) fail('invalid-report');
  const [,, resources, passed, failed, skipped, errors, success, files, records, checkedResources, nativeExit,
    deniedProbes, caches, nullWrites, processorProbes, architectureProbes, gitProbes, closure, roleEvidence, compose] = value;
  const numeric = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 10_000_000;
  if ([resources, passed, failed, skipped, errors, success, checkedResources, nativeExit, deniedProbes, caches,
    nullWrites, processorProbes, architectureProbes, gitProbes].some(n => !numeric(n))) fail('invalid-report');
  if (!Array.isArray(files) || new Set(files).size !== files.length ||
      files.some(n => !numeric(n) || !scope.files[n]) ||
      scope.files.some((entry, index) => !entry.supportingOnly && !files.includes(index)) ||
      skipped !== 0 || errors !== 0 || success !== 1) fail('incomplete-analysis');
  if (!Array.isArray(records) || records.length > 10_000 || records.length !== passed + failed ||
      resources > 0 && records.length === 0) fail('incomplete-analysis');
  if (!Array.isArray(compose) || (scope.framework === 'yaml'
    ? compose.length !== 3 || !numeric(compose[0]) || compose[0] < 1 || !numeric(compose[1]) || compose[1] > compose[0] ||
      records.length !== compose[0] || checkedResources + compose[1] !== compose[0] ||
      !Array.isArray(compose[2]) || compose[2].length !== records.length
    : compose.length !== 0)) fail('invalid-report');
  const resourceUnits = scope.framework === 'yaml' ? compose[0] : resources;
  if (checkedResources > resourceUnits || checkedResources > records.length) fail('invalid-report');
  if (![0, 1].includes(exitCode) || nativeExit !== exitCode || exitCode !== (failed > 0 ? 1 : 0)) fail('process-error');
  if (deniedProbes > 1 || caches !== 1 ||
      nullWrites > 100 || processorProbes > 4 || architectureProbes > 4 || gitProbes > 1) fail('invalid-report');
  const prefixes = ['CKV_AZURE_', 'CKV2_AZURE_', 'CKV_DOCKER_', 'CKV2_LIFTOFF_'];
  let actualPassed = 0;
  const results = records.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== 7 || row.some(n => !numeric(n))) fail('invalid-report');
    const [prefix, rule, file, line, endLine, status, applicability] = row;
    if (!prefixes[prefix] || rule < 1 || rule > 100_000 || !scope.files[file] || line < 1 || endLine < line ||
        endLine > scope.files[file]!.content.split(/\r?\n/).length || ![0, 1].includes(status) ||
        scope.files[file]!.supportingOnly ||
        (scope.framework === 'terraform' ? prefix === 2 : scope.framework === 'dockerfile' ? prefix !== 2 : prefix !== 3 || rule !== 6)) fail('identity-mismatch');
    if (prefix === 3 && scope.framework !== 'yaml' && !scope.customPolicies?.some(policy => policy.id === rule) &&
        !([8, 9].includes(rule) && scope.framework === 'terraform' &&
          scope.files.every(file => file.pathParts.slice(0, -1).join('/') === 'infrastructure/opentofu/bootstrap')) &&
        !(rule === 10 && scope.framework === 'terraform' &&
          scope.files.every(file => file.pathParts.slice(0, -1).join('/') === 'infrastructure/opentofu/telemetry'))) fail('identity-mismatch');
    if (prefix === 3 ? ![0, 1, 2].includes(applicability) || applicability === 0 && status !== 0 ||
        applicability === 2 && status !== 1 : applicability !== 3) fail('identity-mismatch');
    if (status === 0) actualPassed++;
    return {
      rule: `${prefixes[prefix]}${rule}`, fileIndex: file, line, endLine, status: status === 0 ? 'passed' : 'failed',
      applicability: ['outside-resource-role', 'applicable', 'unsupported-api-version', 'native-selected'][applicability]!
    };
  });
  if (actualPassed !== passed || results.length - actualPassed !== failed) fail('invalid-report');
  if (scope.framework === 'yaml' && compose[2].some((row: unknown, index: number) =>
    !Array.isArray(row) || row.length !== 3 || row.some(n => !numeric(n)) ||
    row[0] !== index || row[1] !== results[index]!.line || row[2] !== results[index]!.endLine + 2)) fail('identity-mismatch');
  if (checkedResources === 0 && results.some(item =>
    ['applicable', 'native-selected'].includes(item.applicability))) fail('invalid-report');
  if (!Array.isArray(closure)) fail('invalid-report');
  if (!Array.isArray(roleEvidence) || roleEvidence.length !== 8) fail('invalid-report');
  const [roleFacts, registryIndexes, generatedFacts, generatedIndexes, optionalFacts, optionalIndexes, defaultFacts, defaultIndexes] = roleEvidence;
  if (!Array.isArray(roleFacts) || roleFacts.length !== 14 || roleFacts.some(value => value !== 0 && value !== 1) ||
      !Array.isArray(registryIndexes) || new Set(registryIndexes).size !== registryIndexes.length ||
      registryIndexes.some(index => !numeric(index) || !results[index])) fail('invalid-report');
  if (!Array.isArray(generatedFacts) || generatedFacts.length !== 12 || generatedFacts.some(value => value !== 0 && value !== 1) ||
      !Array.isArray(generatedIndexes) || new Set(generatedIndexes).size !== generatedIndexes.length ||
      generatedIndexes.some(index => !numeric(index) || !results[index])) fail('invalid-report');
  if (!Array.isArray(optionalFacts) || optionalFacts.length !== 4 || optionalFacts.some(value => value !== 0 && value !== 1) ||
      !Array.isArray(optionalIndexes) || optionalIndexes.length !== 4 || optionalIndexes.some(indexes =>
        !Array.isArray(indexes) || new Set(indexes).size !== indexes.length ||
        indexes.some(index => !numeric(index) || !results[index]))) fail('invalid-report');
  const defaultRules = ['CKV_AZURE_44', 'CKV_AZURE_148', 'CKV_AZURE_190', 'CKV_AZURE_205'];
  if (!Array.isArray(defaultFacts) || defaultFacts.length !== 4 || defaultFacts.some(value => value !== 0 && value !== 1) ||
      !Array.isArray(defaultIndexes) || defaultIndexes.length !== 4 || defaultIndexes.some((indexes, control) =>
        !Array.isArray(indexes) || indexes.length > 1 ||
        indexes.some(index => !numeric(index) || results[index]?.rule !== defaultRules[control] ||
          scope.files[results[index]!.fileIndex]!.pathParts.join('/') !== 'infrastructure/opentofu/azure/modules/application/main.tf'))) fail('invalid-report');
  if (defaultFacts.some(Boolean) && (!scope.terraformContext || generatedFacts[0] !== 1)) fail('identity-mismatch');
  if (!scope.terraformContext) {
    if (closure.length !== 0) fail('identity-mismatch');
  } else {
    const context = scope.terraformContext;
    if (closure.length !== 3 || !numeric(closure[0]) || closure[0] < context.moduleDirectories.length ||
        !numeric(closure[1]) || !Array.isArray(closure[2]) ||
        closure[2].length !== context.variableFiles.length || closure[2].some((n, i) => n !== i)) fail('incomplete-analysis');
  }
  const bootstrapContract = scope.framework === 'terraform' &&
    scope.files.every(entry => entry.pathParts.slice(0, -1).join('/') === 'infrastructure/opentofu/bootstrap') &&
    scope.terraformContext !== undefined && scope.terraformContext.moduleDirectories.length === 0 &&
    [1, 2, 3, 4, 5, 7, 8, 9].every(rule => results.some(result =>
      result.rule === `CKV2_LIFTOFF_${rule}` && result.applicability === 'applicable')) &&
    results.every(result => result.applicability !== 'unsupported-api-version');
  const catalogueSupport = scope.framework === 'terraform' && scope.files.length === 1 &&
    scope.files[0]!.pathParts.join('/') === 'assets/locks/opentofu-azure/versions.tf' &&
    sha256(scope.files[0]!.content) === '7f1b60e1d88e6e8f0bc3981fafbb33b9d1471b3fe028b2eaa757d01d7f7001af' &&
    resources === 0 && records.length === 0;
  const dockerfileContract = scope.framework === 'dockerfile' &&
    scope.files.every((_, fileIndex) => [1, 2, 3, 5, 7, 8, 9, 10, 11].every(rule => results.some(result =>
      result.fileIndex === fileIndex && result.rule === `CKV_DOCKER_${rule}` && result.applicability === 'native-selected')));
  const composeContract = scope.framework === 'yaml' && compose[0] > 0 &&
    results.every(result => result.rule === 'CKV2_LIFTOFF_6') && results.length === compose[0];
  const telemetryContract = scope.framework === 'terraform' &&
    scope.files.every(entry => entry.pathParts.slice(0, -1).join('/') === 'infrastructure/opentofu/telemetry') &&
    results.some(result => result.rule === 'CKV2_LIFTOFF_10' && result.applicability === 'applicable');
  const resourceApplicabilityBasis = bootstrapContract ? 'exact-bootstrap-role-graph-and-registered-controls'
    : telemetryContract ? 'exact-telemetry-role-graph-and-registered-controls'
    : catalogueSupport ? 'inapplicable-catalogue-provider-support-only'
    : dockerfileContract ? 'pinned-native-dockerfile-rule-inventory'
    : composeContract ? 'exact-compose-service-image-or-build-inventory' : 'unqualified';
  return { framework: scope.framework, analysisComplete: true as const, resources, checkedResources,
    uncheckedResources: resourceUnits - checkedResources, allResourcesHaveNativeResult: resourceUnits === checkedResources,
    resourceApplicabilityQualified: resourceApplicabilityBasis !== 'unqualified',
    resourceApplicabilityBasis,
    passed, failed,
    files: scope.files.map(entry => ({
      pathParts: entry.pathParts, digest: sha256(entry.content), supportingOnly: entry.supportingOnly === true
    })), parsedFileIndexes: files, results,
    skipped: 0, parsingErrors: 0, nativeExit, deniedIpv6CapabilityProbes: deniedProbes,
    registeredGrammarCaches: caches, discardedNullWrites: nullWrites,
    deniedProcessorCapabilityProbes: processorProbes, deniedArchitectureCapabilityProbes: architectureProbes,
    deniedGitImportCapabilityProbes: gitProbes,
    roleFacts: roleFacts.map(value => value === 1),
    telemetryRegistryResultIndexes: registryIndexes,
    generatedRoleFacts: generatedFacts.map(value => value === 1),
    generatedRegistryResultIndexes: generatedIndexes,
    generatedOptionalRoleFacts: optionalFacts.map(value => value === 1),
    generatedOptionalRoleResultIndexes: optionalIndexes.map(indexes => indexes.map((index: number) => index)),
    generatedProviderDefaultFacts: defaultFacts.map(value => value === 1),
    generatedProviderDefaultResultIndexes: defaultIndexes.map(indexes => indexes.map((index: number) => index)),
    compose: scope.framework === 'yaml' ? {
      declaredServices: compose[0], localBuildServices: compose[1], nativeResourceCount: resources,
      nativeRanges: compose[2], locationEncoding: 'checkov-3.3.10-yaml-native-range-and-normalized-inclusive-range',
      approvedImageInventoryDigest: sha256(JSON.stringify(scope.compose!.images)),
      localBuildInventoryDigest: sha256(JSON.stringify(scope.compose!.localBuilds))
    } : null,
    terraformContext: scope.terraformContext ? {
      rootDirectory: scope.terraformContext.rootDirectory, moduleDirectories: scope.terraformContext.moduleDirectories,
      moduleEdges: closure[0], requiredRootVariables: closure[1],
      variableFiles: scope.terraformContext.variableFiles.map(entry => ({
        pathParts: entry.pathParts, digest: sha256(entry.content)
      })), variableFileReadIndexes: closure[2], productionValues: false
    } : null };
}

/** Assess frozen inventoried inputs; policy mapping and hosted admission remain separate. */
const issuedScopes = new WeakMap<object, { digest: string; scope: CheckovInputScope }>();

export function verifiedCheckovScope(value: object): CheckovInputScope {
  const issued = issuedScopes.get(value);
  if (!issued || sha256(JSON.stringify(value)) !== issued.digest) fail('identity-mismatch');
  return structuredClone(issued.scope);
}

export function assertIssuedCheckovObservation(value: unknown): asserts value is Awaited<ReturnType<typeof assessCheckovScope>> {
  if (!value || typeof value !== 'object') fail('identity-mismatch');
  verifiedCheckovScope(value);
}

export async function assessCheckovScope(
  worktree: string, executable: string, scope: CheckovInputScope, scratchParent: string
) {
  const frozen = structuredClone(scope);
  validateCheckovInputScope(frozen);
  const result = await withCheckovRuntime(worktree, executable, async runtime => {
    await verifyGuard(runtime);
    const observedAt = new Date().toISOString(), output = await runtime.run('scope');
    try {
      return {
        kind: 'local-checkov-scope', version: CHECKOV_FIXTURE_POLICY.version,
        launcherDigest: runtime.launcherDigest, interpreterDigest: runtime.interpreterDigest,
        projectorDigest: sha256(PROJECTOR), configurationDigest: sha256('{}\n'),
        observedAt, completedAt: new Date().toISOString(),
        ...parseCheckovScopeOutput(output.stdout, output.exitCode, frozen),
        customPolicies: (frozen.customPolicies ?? []).map(policy => ({
          rule: `CKV2_LIFTOFF_${policy.id}`, filename: policy.filename, digest: sha256(policy.content),
          applicability: checkovCustomPolicyFiles.find(entry => entry.id === policy.id)
        })),
        policyVerdict: 'not-evaluated', hostedQualification: false, publicationQualified: false,
        osNetworkSandbox: false, cleanup: 'completed'
      };
    } catch (error) {
      if (error instanceof CheckovFixtureError) {
        let value: unknown;
        try { value = JSON.parse(output.stdout.toString('utf8')); } catch { value = null; }
        if (Array.isArray(value) && value[0] === 10) {
          const numeric = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 10_000_000;
          error.scopeDiagnostic = {
            tupleLength: value.length,
            scalarFields: [0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 16, 17].map(i => numeric(value[i]) ? value[i] : null),
            parsedFileIndexes: Array.isArray(value[8]) ? value[8].filter((n: unknown) => numeric(n) && n < frozen.files.length) : [],
            recordCount: Array.isArray(value[9]) ? value[9].length : null,
            recordMetadata: Array.isArray(value[9]) ? value[9].slice(0, 20).filter((row: unknown) =>
              Array.isArray(row) && row.length === 7 && row.every(numeric)) : []
          };
        }
      }
      throw error;
    } finally { output.stdout.fill(0); }
  }, scratchParent, frozen);
  issuedScopes.set(result, { digest: sha256(JSON.stringify(result)), scope: frozen });
  return Object.freeze(result);
}

async function verifyGuard(runtime: CheckovRuntime): Promise<0 | 1> {
  let deniedProbes: 0 | 1 = 0;
  for (const mode of ['selftest', 'version', 'network-guard', 'process-guard'] as const) {
    const output = await runtime.run(mode);
    try {
      const data = numericPayload(output.stdout);
      if (mode === 'network-guard') {
        const count = data[2];
        if (output.exitCode !== 0 || data.length !== 4 || data[0] !== 2 || data[1] !== 4
          || data[3] !== 4 || (count !== 0 && count !== 1)) fail('process-error');
        deniedProbes = count;
      } else {
        const expected = mode === 'selftest' ? [2, 1] : mode === 'process-guard' ? [2, 5, 1, 1, 1, 4] : [2, 3, 3, 10];
        if (output.exitCode !== 0 || JSON.stringify(data) !== JSON.stringify(expected)) fail('process-error');
      }
    } finally { output.stdout.fill(0); }
  }
  return deniedProbes;
}

/** Executes predicate/denial tests and version verification, not scanner rules. */
export async function verifyCheckovGuardContract(worktree: string, executable: string) {
  return withCheckovRuntime(worktree, executable, async runtime => {
    const deniedProbes = await verifyGuard(runtime);
    return Object.freeze({
      scope: 'guard-contract-only', scannerRulesExecuted: false, outboundTrafficAllowed: false,
      predicateCases: 14, launcherDigest: runtime.launcherDigest,
      deniedIpv6CapabilityProbes: deniedProbes, blockedOutboundAuditCases: 4,
      blockedSubprocessAuditCases: 4, optionalSubprocessesStarted: 0,
      ipv6ProbeModuleDigest: CHECKOV_FIXTURE_POLICY.ipv6ProbeModuleDigest,
      projectorDigest: sha256(PROJECTOR), cleanup: 'completed'
    });
  });
}

/** No caller-supplied source, checks, config, suppressions or reports accepted. */
export async function qualifyCheckovFixtures(worktree: string, executable: string, scratchParent?: string): Promise<CheckovFixtureEvidence> {
  return withCheckovRuntime(worktree, executable, async runtime => {
      await verifyGuard(runtime);
      const observedAt = new Date().toISOString();
      const results: CheckovFixtureResult[] = [];
      for (const mode of ['secure', 'insecure'] as const) {
        const output = await runtime.run(mode);
        try {
          const result = parseCheckovFixtureOutput(output.stdout, output.exitCode);
          if (result.gate !== (mode === 'secure' ? 'passed' : 'blocked')) fail('unexpected-result');
          results.push(result);
        } finally { output.stdout.fill(0); }
      }
      return Object.freeze({
        scope: 'new-private-nonfunctional-fixtures-only', version: '3.3.10', framework: 'terraform', rule: 'CKV_AZURE_3',
        launcherDigest: runtime.launcherDigest, interpreterDigest: runtime.interpreterDigest,
        projectorDigest: sha256(PROJECTOR), configurationDigest: sha256('{}\n'),
        fixtureDigests: Object.freeze([sha256(fixture(true)), sha256(fixture(false))]),
        toolchainClaim: 'installed-launcher-and-interpreter-only', repositoryContentScanned: false, cloudOperations: false,
        networkPolicy: 'downloads-disabled-and-python-audit-denied', osNetworkSandbox: false,
        ipv6ProbeModuleDigest: CHECKOV_FIXTURE_POLICY.ipv6ProbeModuleDigest,
        ipv6ProbePolicy: 'reviewed-capability-probe-remains-denied',
        processProbePolicy: 'reviewed-metadata-and-import-probes-remain-denied',
        guardedModuleDigests: Object.freeze({
          platform: CHECKOV_FIXTURE_POLICY.platformModuleDigest,
          gitPython: CHECKOV_FIXTURE_POLICY.gitPythonModuleDigest,
          lark: CHECKOV_FIXTURE_POLICY.larkModuleDigest,
          hclParser: CHECKOV_FIXTURE_POLICY.hclParserModuleDigest,
          hclGrammar: CHECKOV_FIXTURE_POLICY.hclGrammarDigest
        }),
        limits: Object.freeze({ processTimeoutMs: 60000, reportBytes: 4096, internalDebugDiscardBytes: 1048576 }),
        observedAt, completedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
        results: Object.freeze(results), cleanup: 'completed'
      });
  }, scratchParent);
}
