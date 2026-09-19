# Linux keystore client — source-only, unqualified

This is a bounded Secret Service client, **not** a daemon launcher, unlocker,
enrollment coordinator, authorization decision, persistence proof or readiness
receipt. No production registration is provided. Never test it against a real
daemon/store without separately authorized owned-process and custody admission.

## Source/API proof

All libsecret references below are pinned to
[`a5cd57f103038c06b64d5f6ebfd0e627bb40af4e`](https://gitlab.gnome.org/GNOME/libsecret/-/tree/a5cd57f103038c06b64d5f6ebfd0e627bb40af4e).
This commit is **not interchangeable with a 0.21.8.2 tag**.

- `libsecret/secret-service.c`: `secret_service_open_sync` ignores its
  `service_bus_name` argument. Its constructor installs session-bus/default-name
  properties. The subclass overrides that constructor's defaults *before*
  `GInitable` runs, setting the explicit `GDBusConnection`, unique name and
  `DO_NOT_AUTO_START` flags; binding is checked again before session creation.
  The private address/name are also set explicitly for the constructor's
  defaults, never discovered from the ordinary desktop environment.
- `secret-service.h` exposes all three prompt vfuncs. The subclass refuses
  synchronous, asynchronous and finish prompting. It never invokes Unlock.
- `secret-session.c` may fall back to `plain`; the client requires
  `secret_service_get_session_algorithms()` to equal
  `dh-ietf1024-sha256-aes128-cbc-pkcs7` before generating or reading a key.
  No custom cryptography or undocumented crypto ABI is used.
- `secret-paths.c` and `secret-item.h`: collection-scoped SearchItems,
  exact-path GetSecrets and `SECRET_ITEM_CREATE_NONE` avoid broad search,
  aliases, replacement and Store/upsert. The paths API is public but marked
  unstable; `SECRET_API_SUBJECT_TO_CHANGE` is explicit and source/build
  identity is a mandatory qualification gate.
- `secret-value.c`: `secret_value_new_full` takes ownership without copying
  and invokes the registered destroy function; decoded libsecret SecretValues
  release their library-owned secure allocation on unref.
- The provider wire profile is specifically GNOME
  [`da00f9621eaf263d5ed4236df9c22798ea8021d2`](https://github.com/GNOME/gnome-keyring/blob/da00f9621eaf263d5ed4236df9c22798ea8021d2/daemon/dbus/gkd-secret-secret.c#L83-L144).
  `gkd_secret_secret_parse()` reads but does not retain the incoming content
  type; `gkd_secret_secret_append()` unconditionally replies `text/plain`,
  including for binary values. Creation still sends `application/octet-stream`.
  Readback requires **only that exact pinned reply label**, never a list of
  fallback content types, and obtains **exactly 32 opaque bytes** through
  `secret_value_get`, not `secret_value_get_text`. NUL/non-UTF8 bytes remain
  intact. The encrypted session algorithm check is separate and unchanged;
  `text/plain` here does **not** permit the `plain` session algorithm.
  The contract query identifies this daemon source pin; other provider wire
  profiles are not admitted.
- [GIO explicit address connection](https://docs.gtk.org/gio/ctor.DBusConnection.new_for_address_sync.html)
  and [GDBusProxy binding/autostart](https://docs.gtk.org/gio/class.DBusProxy.html)
  provide the transport and proxy primitives.

## Invocation

`--contract` emits one framed, source-safe contract response without opening a
bus, generating a key or inspecting a store. It does not qualify the binary.

Exactly 14 **nonsecret** positional arguments follow the executable:

```
read|create unix:path=/absolute/private/socket BUS_GUID UNIQUE_OWNER \
CURRENT_UID DAEMON_PID DAEMON_SESSION_ID DAEMON_START_TICKS \
/org/freedesktop/secrets/collection/login ITEM_PATH_OR_DASH \
PROJECT WORKSPACE_UUID ENROLLMENT_UUID TIMEOUT_MS
```

Only one `unix:path=` filesystem UNIX socket address is allowed (no list,
extra keys, caller-supplied GUID key, abstract socket or discovery). Percent
escapes decode exactly once, accepting the launch contract's fully percent-encoded
paths, including literal spaces, quotes, brackets and UTF-8 characters. Decoded
paths must be absolute, valid UTF-8, contain no NUL/C0/C1 control characters,
and be at most 107 **bytes**, not characters. Invalid escapes, noncanonical
components and unescaped D-Bus separators are rejected. Encoded separators are
literal filename bytes, never another address. The original encoded value is
preserved when appending the selected GUID, with capacity for all 369 bytes
plus the terminator. Filesystem observation uses the decoded canonical path.
Its socket and private parent
must belong to the current UID. The bus GUID, current well-known service's
unique owner, owner credentials, daemon PID, `/proc/PID/stat` start ticks and
POSIX session ID must match before and after effects. These observations
correlate the parent's expected process; they do not independently establish
ownership/approval or authenticate a hostile same-UID bus provider.

`BUS_GUID` is the authentication/address GUID exposed by GIO, **not**
`org.freedesktop.DBus.GetId()`: the [D-Bus specification](https://dbus.freedesktop.org/doc/dbus-specification.html)
explicitly says the per-address and per-bus IDs are unrelated.

`PROJECT` uses the existing state-context grammar `[A-Za-z0-9_.:@/-]{1,256}`.
It is an attribute value, not a filesystem path to traverse or normalize.

`create` requires `-` for the item path and zero exact attribute matches.
Creation uses `getrandom(GRND_NONBLOCK)` for exactly 32 bytes, never input values.
`read` requires one exact matching existing item path. Both check exact
project/workspace/enrollment/schema attributes, unlocked status, the exact
pinned GNOME reply label, opaque 32-byte length, metadata stability and
independent readback.
Create readback must equal the generated key; read mode reads twice.
Non-replacing creation plus pre/post search does **not** eliminate concurrent
creator races; duplicates block and are never deleted or automatically retried.

No stdin input, password, model-supplied key, key file, collection creation,
deletion, reset, alias resolution, unlock or normal-session fallback exists.

## Private binary protocol

Stdout and stderr must be admitted **private bounded pipes**, never terminals/logs.
Only stdout carries protocol frames; callers discard stderr without public
decoding, including dependency diagnostics outside GLib's suppressed log handlers.
Each frame contains:

1. Four ASCII bytes `LKC1`.
2. Big-endian uint32 JSON metadata length (1..2048).
3. Big-endian uint32 binary key length (0 or 32).
4. UTF-8 JSON metadata, then exactly that many raw binary key bytes.

Operation metadata fields: `protocol`, `event`, `effect`, `code`, `item`,
`keyBytes`. `event` is `before-create`, `created-identity` or `result`.
`effect` is `no-dispatch`, `possible-mutation` or `returned-identity` and refers
only to **application-key creation**, not session/transport activity.
`item` is null or the exact bounded returned/selected object path. A returned
path outside the selected collection is retained as an observed identity but
rejected before any readback; it is never treated as an admitted application key.
Error codes are
the fixed table in `protocol.c`; provider messages are never serialized.

Read emits one result. Create emits a possible-mutation frame immediately
before calling CreateItem, then a returned-identity frame if an admissible
identity returns, then a result. Maximum operation output is three frames,
at most 6212 bytes; only a successful terminal result contains key bytes.
The parent must checkpoint creation intent **before launch**, independently
validate framing/sequence, consume and clear private output, and retain any
returned identity even when terminal validation fails. Missing/truncated output,
cancellation, pipe loss or process death is incomplete/uncertain, never
permission to infer no effect or retry. Helper exit zero is not persistence
or fresh-daemon recovery proof.

## Memory, limits and remaining limitations

Owned key pages are guard-paged, `mlock`ed, `MADV_DONTDUMP` and explicitly wiped;
failure blocks. Core dumps/dumpability are disabled for the helper. No claims
are made about library/daemon/kernel buffer copies, swap protection of every
dependency, authenticated encryption (the mandated protocol uses CBC), or
same-UID adversaries. Libsecret's secure allocator/dependencies need independent
qualification, including allocation-failure behavior.

Arguments are bounded to 4096 bytes total/512 each. Incoming D-Bus bodies above
64 KiB cancel processing, but GIO has already parsed/allocated the message:
this is **not a preallocation transport-memory bound**. Overall memory limits
and executable/library admission remain parent/platform gates. A deadline
thread cancels GIO operations on timeout or SIGINT/SIGTERM; it cannot prove
daemon effects settled. Output backpressure and uninterruptible library work
require the parent's existing private owned-group deadline/settlement runner.
No raw library diagnostics are forwarded through the framed protocol.

## Reproducible compile-only preparation

Required: native Linux x64/arm64 C11 compiler, `pkg-config`, GLib/GIO/GObject
development files (>=2.74), and a crypto-enabled libsecret build installed under
an **explicit prefix from the exact clean pinned source checkout**.
The build script installs/downloads nothing and never executes the helper.
Every build subprocess has a 30-second deadline and 64-KiB capture limit.
Compiler failures report a fixed classification plus at most 16 KiB of compiler
stderr (control sequences removed). Missing tools/pkg-config modules are named
explicitly. Command lines, error objects and environment values are not dumped.

```
LIBSECRET_SOURCE_DIR=/absolute/pinned/libsecret \
LIBSECRET_PREFIX=/absolute/admitted/libsecret-prefix \
node native/linux-keystore-client/build.mjs
```

An implicit system libsecret is rejected. Required APIs are compiled and linked,
not accepted from a version string. `build/build-identity.json` records helper
sources, executable, compiler, pkg-config versions and resolved primary library
hashes. This is evidence, **not** proof that an installed prefix came from the
supplied checkout or that runtime loaders will select those exact dependencies.
The separately authorized [GNOME persistence fixture](gnome-README.md#verified-bounded-native-source-result)
passed on Linux x64 and arm64 in run 35421959515 at
`440ac1fc2dc758c0a84921ab8c15a00b1fe3bd20`. That generated-data source result is
not production enrollment, encrypted-host custody, minimum-host coverage or
installed-artifact qualification. Transitive crypto/libc identity, reproducible
rebuilding and complete runtime dependency admission remain separate gates.

### Separately selected `--contract`-only native CI probe

Linking uses `-L`, **not** a relocatable RUNPATH or admitted runtime closure.
Never execute the resulting helper with ambient library discovery and call that
a successful pinned-libsecret probe. `build-identity.json` records the exact
`contractProbeLibraryPath`: canonical libsecret library directory first,
followed by the distinct recorded GIO/GLib/GObject directories. It contains
neither empty entries nor ambient `$LD_LIBRARY_PATH`, loader token expansion,
relative paths or the current directory. Build/probe library prefixes must use
unambiguous ASCII path characters.

After verifying the recorded helper and primary-library hashes and keeping
their build-owned directories unchanged, a separately authorized native CI
probe uses this **fresh sanitized environment** (do not enable shell tracing):

```sh
IDENTITY=./native/linux-keystore-client/build/build-identity.json
BINARY="$PWD/native/linux-keystore-client/build/liftoff-linux-keystore-client"
RUNTIME_LIBS="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1])).contractProbeLibraryPath)' "$IDENTITY")"
env -i PATH=/usr/bin:/bin LC_ALL=C LD_LIBRARY_PATH="$RUNTIME_LIBS" \
  LD_TRACE_LOADED_OBJECTS=1 "$BINARY" --contract \
  > ./native/linux-keystore-client/build/loader-map.txt
```

**Before the next command, CI must reject** a missing library or any loader-map
entry for libsecret, GIO, GLib or GObject whose canonical resolved file/hash
differs from that module in `build-identity.json`. In particular, a system
`libsecret-1.so.0` is not an acceptable fallback when the pinned prefix is
unavailable. Do not continue on a failed/unparseable loader trace. Then use
exactly the same non-ambient library path without the trace variable:

```sh
env -i PATH=/usr/bin:/bin LC_ALL=C LD_LIBRARY_PATH="$RUNTIME_LIBS" \
  "$BINARY" --contract > ./native/linux-keystore-client/build/contract.frame
```

This may validate only framed contract output and those primary native loader
bindings. It opens no bus/store and is not provider behavior, key custody,
transitive dependency qualification or a portable installed-artifact closure.
The build script does not run either probe.

Local source/protocol-only checks:

```
npx vitest run tests/linux-keystore-client-contract.test.ts
```

Those tests compile only dependency-free parser/framing code when a local C
compiler is present. They never compile a fake libsecret ABI, connect to a bus,
launch a daemon or claim native Secret Service behavior.

## Explicit synthetic compiled-client behavior lane

After the exact native build above, a **separately selected** source test may
launch a fresh private message bus and an in-memory synthetic Secret Service:

```sh
LIFTOFF_LINUX_KEYSTORE_SYNTHETIC=1 \
LIBSECRET_SOURCE_DIR=/absolute/pinned/libsecret \
npx vitest run tests/linux-keystore-client-contract.test.ts
```

Normal runs do not register or skip this opt-in behavior suite. Test prerequisites
are declared in `synthetic-dependencies.json`: Ubuntu 24.04 `dbus-daemon`,
`python3`, `python3-dbus`, `python3-gi`, and `gir1.2-glib-2.0`, in addition to
the build prerequisites. The lane expects `/usr/bin/python3` and
`/usr/bin/dbus-daemon`; it installs nothing and does not discover substitutes.

`synthetic-service.py` imports the five SHA256-bound **test-only** modules from
the exact upstream libsecret checkout (`libsecret/mock/`, LGPL as retained in
that checkout). The algorithms are used unchanged, not copied into a production
implementation. In particular upstream `mock/dh.py` explicitly says it is not
cryptographically secure/performance-qualified. No real GNOME process, keyring,
password, protected-store fixture or real credential is involved. All values
exist only for disposable protocol tests; creation RNG output is discarded, not
enrolled. This lane cannot establish encryption or native custody qualification.

The fixture uses an explicit private `BusConnection`, not upstream's ordinary
`SessionBus` constructor or standard desktop objects. A fresh owned socket
with spaces/quotes/brackets exercises encoded launch paths. The bus has no
service directories/autostart includes. UID, PID, session ID, process start ticks,
unique owner and address GUID come from the actual owned fixture processes.
Audit files contain bounded counters/booleans only, never key bytes or digests.

Before the source-safe `--contract` query, the lane verifies binary/source/library
hashes, uses a fresh environment with exactly the recorded library path, and
checks actual loader trace resolution. Every client invocation additionally
checks `LD_DEBUG=libs` initialization observations against those same canonical
primary library files and hashes. It rejects missing observations or a system
libsecret substitution. This is not complete transitive runtime closure
admission; that remains a separate gate.

The synthetic wrapper preserves upstream mock ciphertext but models the actual
pinned GNOME `text/plain` response metadata, rather than echoing the requested
content type. An explicit wrong-content-type case requires rejection of the
old echoed `application/octet-stream` response; there is no generic MIME
fallback.

The real compiled client is exercised for encrypted-session creation/readback,
plain-session rejection before key operations, owner/PID/GUID mismatch, denied
prompts, exact project/workspace/enrollment attributes and item paths,
non-replacement, duplicate/non-32-byte/wrong-content-type/misbound/changed results, and returned
identity retention after a post-write validation error. Assertions only expose
fixed issues, counters and booleans, never key buffers.

All child processes use the existing owned-group primitives. Teardown settles
client, fixture and bus handles before removing only that test's exact scratch
root. An uncertain settlement fails and preserves the root instead of reporting
cleanup success. No host policy, ordinary bus, external store, or provider
authorization is created by this lane.

## Independent managed-Linux record and recovery identities

The production source now declares a separate **metadata-only** record family
in `src/domain/repair/managed-linux-keystore-{contract,records}.ts`, with bounded
codecs/readers in `src/adapters/state/managed-linux-keystore-records.ts`:

| Identity | Meaning |
| --- | --- |
| `managed-linux-gnome/1` | Explicit provider namespace, never a macOS/external-key alias |
| `managed-linux-keystore-enrollment/1` | Immutable enrollment intent and original operation/binding identity |
| `managed-linux-keystore-recovery-checkpoint/1` | Ordered cumulative observations tied to that enrollment and prior checkpoint |
| `managed-linux-keystore-key-reference/1` / `managed-linux-key:<fingerprint>` | Reference to one exact recorded enrollment/checkpoint/item/generation/encrypted key binding |

Inspection, enrollment, unlock, protected key read, recovery and disposal also
have independent `managed-linux-keystore-…/1` operation identifiers. Merely
declaring them does not register a public writer, execute an operation or issue
approval. No global governance version, macOS schema, external-key ID, existing
reader, encrypted envelope or approval is changed.

Bindings include Linux architecture, project, host/principal, enrollment/store
IDs, selected scope/configuration, exact daemon/libsecret pins, executable/
dependency/client identities, and the explicit restart profile/helper. Persisted
generation observations bind the canonical file path, device/inode/birthtime,
owner/mode, complete byte digest and length. Checkpoints retain cumulative key
creation uncertainty and all returned paths, including inadmissible identities
needed for reconciliation. Missing chain entries, backwards observations,
identity loss, repeated creation dispatch, generation replacement and changed
restart-plan host/principal/helper/operation bindings reject rather than reset
or normalize the history.

All record versions/kinds/fields are exact. The UTF-8 codec uses the existing
strict JSON duplicate-field parser, canonical fingerprints, a 32-KiB per-record
limit and at most 64 checkpoint entries. Selected enrollment/checkpoint/key-ref
fingerprints must match independently supplied current expectations. Fingerprints
are **integrity/selection checks, not signatures, native provenance or approval**;
callers cannot establish freshness by supplying a stale record and its own stale
expectations.

There are no supported raw-key, master-password, password-verifier or
encrypted-storage-attestation fields. Operation/configuration/observation
digests must refer only to their declared nonsecret inputs; these APIs never
derive a digest from private key/password input. The encrypted AES-GCM probe stays separate and
is selected by its exact digest. The consuming verifier reuses
`verifyManagedKeystoreKeyBinding` with the original exact context; it clears the
supplied snapshot and still returns only `key-binding-only`,
`freshProcessVerified:false`, `readiness:false`. Likewise the generation adapter
reuses `inspectControlledGnomeBinary`, clears supplied file bytes, and does not
convert its structural inspection into custody or durable-save proof.

Even a fully populated, fingerprint-valid serialized chain containing
`restart-observed` remains `authority:"none"`,
`nativeAuthority:"not-established"` and `readiness:false`. Observation digests
and the serialized null-sink plan are references/data, not native capabilities.
The readers grant no creation retry, password reset, rekey, cross-host
conversion or disposal authority. A key reference is not a ready key provider.
Existing `keychain:` references and `state-read`/`state-write` approval records
are not accepted or converted by these new readers.

### Exact durability boundary and remaining production work

The immutable daemon source audit includes
[`pkcs11/gkm/gkm-transaction.c`](https://github.com/GNOME/gnome-keyring/blob/da00f9621eaf263d5ed4236df9c22798ea8021d2/pkcs11/gkm/gkm-transaction.c):
`write_sync_close()` checks write, conditional `HAVE_FSYNC` file-sync and close
results; `write_to_file()` writes a same-directory temporary, closes it and
renames it, but supplies **no parent-directory fsync**. Therefore CreateItem
success is not sufficient durable-generation evidence. The registered closure
requires independently successful exact-file and parent-directory fsync,
owned-process settlement/cache disposal, and fresh cryptographic readback.
The actual generated-data run documented above exercised those observations;
neither it nor a serialized checkpoint proves power-loss durability or encrypted
host storage.

The source/interface audit and independent record identities are registered.
Still separate and unavailable from these readers are:

- a native protected-parent storage contract and current filesystem/encryption/
  ownership evidence (no fscrypt, volume or keystore protection is invented);
- production default-No/exact-operation approval, protected operator-input
  admission and custody-authenticated checkpoint persistence;
- an owned daemon/bus coordinator that independently produces and rechecks the
  referenced native observations and handles lost responses without redispatch;
- later-use/recovery and separately approved disposal integration, including all
  dependent retained artifacts and cross-host/rekey transition readers;
- minimum-host, complete runtime closure and final installed-artifact evidence.

Those gates must close before any production enrollment/readiness/writer path is
enabled. Source checks for this new family are
`tests/managed-linux-keystore-records.test.ts`; they use synthetic in-memory
metadata and byte buffers only, never a daemon, store, real credential or
encrypted-volume operation.

## Linux encrypted-storage interface audit: directory observation only

The separate `linux-ext4-fscrypt-v2-directory-observation/1` source primitive is
implemented in `src/domain/repair/linux-storage-observation.ts` and
`src/adapters/state/linux-storage-{observer,program}.ts`. It observes **one
existing directory's policy and filesystem-keyring status**, not a protected
volume, usable encryption key, whole tree, future object or writer capability.
It is not plugged into existing protected artifact storage.

The public kernel audit is pinned to Linux v6.12 commit
[`adc218676eef25575469234709c2d87185ca223a`](https://github.com/torvalds/linux/tree/adc218676eef25575469234709c2d87185ca223a).
This is a source/ABI audit pin, not an asserted minimum-host qualification:

- [`include/uapi/linux/fscrypt.h`](https://github.com/torvalds/linux/blob/adc218676eef25575469234709c2d87185ca223a/include/uapi/linux/fscrypt.h)
  defines `FS_IOC_GET_ENCRYPTION_POLICY_EX` (`0xc0096616`; the command encodes
  size **9**, but the v2 argument buffer is **32** bytes with `policy_size=24`)
  and `FS_IOC_GET_ENCRYPTION_KEY_STATUS` (`0xc080661a`, **128** bytes).
  The observer issues only these two ioctls, with zeroed reserved input.
- [`fs/crypto/policy.c`](https://github.com/torvalds/linux/blob/adc218676eef25575469234709c2d87185ca223a/fs/crypto/policy.c)
  returns the selected inode's policy. `ENODATA` means unencrypted;
  unknown versions, insufficient layouts and unsupported kernels/filesystems
  fail. There is no legacy-policy/`GETFLAGS`/path-label fallback.
- [`fs/crypto/keyring.c`](https://github.com/torvalds/linux/blob/adc218676eef25575469234709c2d87185ca223a/fs/crypto/keyring.c)
  reports master-key `PRESENT`, `ABSENT` or `INCOMPLETELY_REMOVED`.
  The current-user claim refers to **fsuid**; user count counts claims, not
  exclusive knowledge of the key. The observer requires `PRESENT`, the exact
  known `ADDED_BY_SELF` flag and a nonzero user count, and checks real/effective/
  saved/filesystem UIDs agree. It neither provisions nor extracts key material.
- [`Documentation/filesystems/fscrypt.rst`](https://github.com/torvalds/linux/blob/adc218676eef25575469234709c2d87185ca223a/Documentation/filesystems/fscrypt.rst)
  specifies v2 HKDF/key verification and policy inheritance for regular files,
  directories and symlinks. Special files are not encrypted. Non-filename
  metadata and integrity are not protected; keys may be removed and cached
  per-inode keys can remain. A filesystem can mix encrypted and unencrypted
  objects. No whole-volume or ongoing protection follows from these queries.
- [`fs/ext4/dir.c`](https://github.com/torvalds/linux/blob/adc218676eef25575469234709c2d87185ca223a/fs/ext4/dir.c)
  makes directory open a private-state allocation, while
  [`fs/ext4/file.c`](https://github.com/torvalds/linux/blob/adc218676eef25575469234709c2d87185ca223a/fs/ext4/file.c)
  calls `ext4_sample_last_mounted()` on regular-file open, potentially
  journalling a superblock update even for `O_RDONLY`, then sets up fscrypt
  state. **Regular-file observation is deliberately not implemented** by this
  read-only primitive. Directory open does not establish inode-key usability;
  that remains explicitly unobserved.
- [`fs/ext4/crypto.c`](https://github.com/torvalds/linux/blob/adc218676eef25575469234709c2d87185ca223a/fs/ext4/crypto.c)
  shows that deprecated `GET_ENCRYPTION_PWSALT` can initialize persistent salt.
  It is not used. Neither are policy setters, key add/remove, nonce testing,
  mounts, namespace changes, permission changes or fscrypt command-line tools.

The deliberately narrow policy profile accepts only v2 AES-256-XTS contents
plus AES-256-CTS filenames, documented padding flags 0–3, default data-unit
size and zero reserved bytes. Other modes/flags are unregistered and fail
closed, not declared unsafe by inference. `test_dummy_encryption` is rejected:
the audited kernel's dummy key is per-boot and is not persisted-key custody.
The policy's key identifier is existing public kernel metadata, not key bytes
or an application-generated password verifier; key strength, derivation quality
and custody cannot be determined from it.

### Descriptor, filesystem and topology boundary

The registered CPython 3.14 helper runs only on genuine Linux little-endian
x64/arm64 LP64. It walks from `/` with retained `O_PATH`, `O_NOFOLLOW` component
descriptors, rejects a non-directory before reopening it, and requires current
ownership and private owner-only mode. Its sole selected-object read descriptor
is reopened from that retained directory anchor via authenticated procfs; this
fixed kernel fd link is not a caller-supplied symlink fallback. It reads no
directory entries or file contents from the selected object.

`fstatfs` uses the audited public LP64 layout/syscall numbers (x64 138, arm64 44).
`EXT4_SUPER_MAGIC` alone is insufficient because ext2/ext3 share it. The helper
also matches the retained fd's mount ID and device against kernel mountinfo,
requires `ext4`, rejects subtree/visible same-device mount aliases and rejects
dummy-encryption or incompatible DAX options. Procfs/namespace filesystem magic
and aligned `/proc/self` identity are checked before trusting kernel metadata.
Relevant definitions are
[`asm-generic/statfs.h`](https://github.com/torvalds/linux/blob/adc218676eef25575469234709c2d87185ca223a/include/uapi/asm-generic/statfs.h),
[`fs/proc/fd.c`](https://github.com/torvalds/linux/blob/adc218676eef25575469234709c2d87185ca223a/fs/proc/fd.c)
and [`fs/proc_namespace.c`](https://github.com/torvalds/linux/blob/adc218676eef25575469234709c2d87185ca223a/fs/proc_namespace.c).

Policy, matching key status, fd/path ancestry, VFS-visible owner/mode/inode and
mount snapshots are rechecked before reporting. Changes, unavailable
observations, missing keys and unencrypted/unsupported storage block. All setup
descriptors close at process exit; no inherited capability is exported.
Ordinary lookup may instantiate in-memory fscrypt caches. The result is
namespace-local metadata at observation time, not a retained lease, proof of
initial-namespace ownership, backing-block-device locality, or protection
against external/root writers. Key removal or topology changes can occur
immediately afterward.

### Explicit integration blocker

Existing `ProtectedVolumeAttestor`/`assertPrivateStatePath` require
`encryptedVolume:true`, `privateAccess:true` and volume-wide coverage. This
observer has no `verify()` method and returns none of those fields. Its
`volumeEncryption`, `backingDeviceLocality`, `keyCustody`, `inodeKeyUsability`
and `descendantCoverage` remain `not-observed`; authorization is `none`,
native qualification `required` and readiness `false`. Serialized decoding
does not mint native invocation provenance, and invocation provenance itself
does not qualify storage/software or grant current access.

**Writer integration remains blocked.** A separately reviewed artifact-storage
coverage contract is needed for per-object directory/file coverage, retained
identity across each operation, creation/inheritance and private scratch,
key-removal races, topology/idmapping/locality, and independently admitted
key protection. It must not reinterpret macOS volume authority or old
keys/receipts. The regular-file open side effect also needs an explicit
decision before adding a supposedly effect-free file observer.

Current checks are synthetic ioctl-byte decoding, claim/identity rejection,
helper syntax and wrong-platform refusal in
`tests/linux-storage-observation.test.ts`. No actual positive fscrypt probe,
encrypted volume/key provisioning, policy/key changes, daemon/store access,
Linux emulation or installed-artifact qualification was performed. Positive
native host qualification remains task 11.21; helper inventory/CI wiring is
not evidence of that qualification.

The shipped compiled source is independently inventoried as
`linux-storage-directory-observer`, exporting `linuxStorageDirectoryProgram`
from `dist/adapters/state/linux-storage-program.js`. Its program SHA256 is
`f2c82998f664c85d41ae370ac79e89f80f4b81edf2ed7f30764770a929fbb38e`.
V8 measurement of the TypeScript wrapper does not measure the Python program.
Applicable Linux artifact, native and minimum-host evidence must bind this
helper separately; unqualified status does not permit omission. Inventory
registration adds no CI probe, provisioning authorization or writer authority.
