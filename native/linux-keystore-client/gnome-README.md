# Actual pinned GNOME persistence fixture — generated test data only

This opt-in uses the separately authorized **actual GNOME daemon** against fresh
disposable runner-owned test keyrings. It is not the in-memory mock fixture.
There is no production enrollment registration, existing-keyring adoption,
operator credential access, cloud activity, disk-encryption setup, host-policy
change, publication or encrypted-host custody/release-readiness claim.

## Audited source boundary

Daemon source is exactly
[`da00f9621eaf263d5ed4236df9c22798ea8021d2`](https://gitlab.gnome.org/GNOME/gnome-keyring/-/tree/da00f9621eaf263d5ed4236df9c22798ea8021d2)
(post-51.0, **not** a tag equivalence).

- `daemon/gkd-main.c`: `--foreground` avoids its fork/setsid path; `--unlock`
  consumes stdin, may create a missing login collection, and failed unlock can
  leave the daemon running. No `--start`, `--replace`, `--daemonize` or `--login`.
- `daemon/login/gkd-login.c`: `unlock_or_create_login` creates a missing login
  collection and successful unlock may initialize other native slots.
- `daemon/gkd-pkcs11.c`: secrets startup initializes the built-in Secret Store,
  SSH, legacy GNOME2 and XDG modules, even without their public remoting
  components. HOME/XDG locations must therefore all remain fixture-owned.
- `pkcs11/gkm/gkm-util.c`, `pkcs11/xdg-store/gkm-xdg-module.c`: the keyrings and
  XDG keystore locations derive from the selected HOME/XDG directories.
- `pkcs11/secret-store/gkm-secret-collection.c::gkm_secret_collection_real_unlock`
  loads/decrypts the existing collection without an unconditional save.
  However, `pkcs11/gnome2-store/gkm-gnome2-storage.c::lock_and_open_file`
  uses `O_CREAT` and sibling dotlocks even on its auxiliary legacy-store read
  path. Landlock intentionally denies those store-entry writes. The fixture
  neither grants an exception nor claims every auxiliary slot initialized:
  actual guarded primary-key readback must still succeed, otherwise the native
  lane remains blocked. Do not suppress that failure to manufacture readiness.
- `daemon/gkd-main.c` still uses native syslog and ordinary OS facilities.
  Landlock is **not** IPC/network isolation or protection against external
  writers, metadata changes, passed FDs or every future filesystem operation.
  Debug mode is disabled; private process diagnostics are bounded and discarded.

## Exact build interface (Linux x64 and arm64)

Reuse the already pinned libsecret native client build and
`build/build-identity.json`. Additional daemon dependencies are declared in
`gnome-dependencies.json`: GNOME requires **GLib/GIO >=2.80**,
`gck-1 >=3.3.4`, `gcr-base-3 >=3.27.90`, libgcrypt and p11-kit.
Ubuntu 24.04 additional development packages are `libgcr-3-dev` and
`libp11-kit-dev`, on top of the existing compiler, Meson/Ninja, gettext,
GLib/GIO, libgcrypt and pkg-config build prerequisites. Runtime needs the
already installed `dbus-daemon`, `/usr/bin/gdbus` (libglib2.0-bin), Node and
registered native **CPython 3.14** for the existing Landlock guard.

CI prepares a clean exact source checkout, a job-owned build directory and a
job-owned prefix, all outside ordinary desktop state:

```sh
meson setup "$GNOME_BUILD_DIR" "$GNOME_SOURCE_DIR" \
  --prefix="$GNOME_PREFIX" --libdir=lib \
  -Dssh-agent=false -Dpam=false -Dsystemd=disabled \
  -Dlibcap-ng=disabled -Dselinux=disabled -Ddebug-mode=false -Dmanpage=false \
  -Dpkcs11-config="$GNOME_PREFIX/etc/pkcs11" \
  -Dpkcs11-modules="$GNOME_PREFIX/lib/pkcs11"
meson compile -C "$GNOME_BUILD_DIR" gnome-keyring-daemon
install -D -m 0755 "$GNOME_BUILD_DIR/daemon/gnome-keyring-daemon" \
  "$GNOME_PREFIX/bin/gnome-keyring-daemon"
node native/linux-keystore-client/gnome-build-identity.mjs
```

The last command requires `GNOME_SOURCE_DIR`, `GNOME_BUILD_DIR`, and
`GNOME_PREFIX` in its environment. It validates exact Git HEAD/clean tracked
source and Meson options, matches the private daemon copy against the actual
built target, and records primary library and observer/bus tool paths/hashes.
Both PKCS#11 directory options must resolve to the declared private prefix
locations; default system p11-kit paths are rejected.
It writes `build/gnome-build-identity.json` without executing the daemon.
No upstream install phase, PAM modules, desktop autostart entries, service
files or systemd units are installed on the runner.

## Opt-in command and budgets

Only the expressly authorized source job enables:

```sh
LIFTOFF_GNOME_PERSISTENCE_TEST=1 \
LIFTOFF_STATE_PYTHON=/absolute/registered/python3.14 \
npx vitest run tests/state-gnome-persistence.test.ts --maxWorkers=1
```

The job remains **20 minutes**. Each coordinator has a 12-second overall
budget, its outer owned-group runner 15 seconds, native startup/client work
5 seconds, and bounded direct-child termination attempts. Tests retain the
existing 30-second per-test limit. Inputs are at most 4096 private password
bytes; private coordinator output is at most 16384 bytes. Runtime loader
diagnostics are separately bounded, observed for exact recorded primary
library paths/hashes, then cleared. Missing tools, APIs, encrypted sessions,
loader matches or kernel restrictions block rather than choosing fallbacks.
Before consuming the private password channel, the owned coordinator verifies
actual `LD_TRACE_LOADED_OBJECTS` resolution for the daemon (`--version`) and
client (`--contract`) under their explicit recorded library paths. It then
requires matching loader initialization observations from the actual operations.

Normal runs register only portable source/refusal checks. The opt-in adds:
actual enrollment plus verified restart; missing store; substituted inode;
wrong password; changed cryptographic binding; cancellation; and a deliberately
withheld settlement-report fault. The latter is a **lost observation test**, not
a claim that an unkillable kernel task was manufactured.

## Execution and evidence

Every test creates an absence-bound `.cache/gkr-*` scope. The generated
48-byte printable master password is carried only through private stdin.
The enrollment launcher disables core files and execs the owned coordinator
without reading that channel. No password appears in argv, environment,
ordinary files, test assertions or logs.

The coordinator creates its private bus **inside its own process tree**,
without service directories/autostart. It sets the daemon's HOME, XDG
data/config, runtime, control, cache and scratch explicitly; the system-bus
address points at a nonexistent owned socket. `GNOME_KEYRING_PARANOID=1` is
mandatory. Foreground daemon and all client/observer/bus descendants stay in
the coordinator's inherited process group; none uses nested detached mode.
UID, unique owner, actual PID/session/start ticks and the control socket/
announced directory are checked. Only public bus/Secret Service APIs are used.

Enrollment creates exactly one 32-byte application key through the existing
non-replacing client. After **all owned processes settle**, the fixture reads
the actual `login.keyring`, structurally inspects it through
`inspectControlledGnomeBinary`, binds its creation identity/digest and
independently fsyncs the file and parent directory. It retains only an
AES-GCM key-binding probe from `createManagedKeystoreKeyBinding`, consumes and
clears the application-key snapshot, and never writes raw key bytes.

Restart always invokes `LinuxReadonlyProcessGuard` around the coordinator.
Its three writable roots are new and empty when rules are installed. Only
then does the coordinator create bus/control IPC inside those roots and set
the daemon's real store HOME/XDG environment. Existing store identity/digest
is checked before launch. The explicit missing-store source probe intentionally
exercises actual `--unlock` creation behavior under enforced write denial;
it cannot recreate the missing file. A substituted inode is rejected before
daemon launch. All cases independently recheck the whole store tree's bytes,
identities, modes, ownership and modification metadata (access time excluded).

A successful fresh process must return the original cryptographically bound
key and leave the persisted generation unchanged. Labels/Modified timestamps,
an old key cache, version strings or daemon startup alone never pass.
The source report printed **only after those checks pass** identifies
generated-data GNOME persistence, explicitly `encryptedHostCustody:
"not-performed"` and `readiness:false`. No native results are fabricated on
macOS.

Cleanup stops/reaps the exact direct children and uses the existing outer
owned-group settlement proof for the whole tree. Only settled owned scopes
are removed. Unproven process settlement or a deliberately lost settlement
report preserves the exact scope; no broad sweep, PID-name kill or
credential-bearing artifact upload is permitted. Preserved scopes contain
only the generated disposable test material and encrypted probe.

Filesystem encryption, durability across power loss, complete installed
runtime closure and real enrollment authority remain separate qualification
gates. Ordinary runner storage is never presented as encrypted custody.
