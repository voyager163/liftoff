# Native development bundles

The contributor-only native builder assembles the existing CLI, its locked production
dependencies, packaged assets and notices with an official standalone Node runtime.
It assembles **unsigned development artifacts**, not published installations:
native Apple Silicon macOS, Windows x64, and glibc Linux x64/arm64. npm remains
the published installation channel. No Homebrew namespace, WinGet ID, production
signing key, minimum-host result or public native installation is claimed.

## Declared runtime requirements

The pinned Node 24.21.0 upstream `BUILDING.md` is identified by URL and SHA-256
in `distribution/native/platforms.json`. Its macOS executable actually reports a
13.5 Mach-O deployment target. These declarations are **not results from running
Liftoff on each minimum host**:

| Development target | Declared runtime requirement | Remaining minimum-host qualification |
| --- | --- | --- |
| macOS arm64 | Native Apple Silicon, macOS 13.5 or newer | Actual minimum-host installation/CLI/asset execution |
| Windows x64 | Native x64, Windows 10/Server 2016; conservatively declared build 14393 or newer | Minimum-host PE/runtime/installer and stock-policy execution |
| Linux x64/arm64 | Kernel 4.18, glibc 2.28, libstdc++ providing GLIBCXX 3.4.25 or newer | Actual minimum-host loader/CLI/install/recovery execution on both architectures |

Host admission refuses Intel macOS, Rosetta/foreign architecture, older declared
hosts and unknown/musl libc before builder or installer destination changes.
The launcher also admits its current native host. Linux assembly inspects actual
system-library resolution and ELF version requirements; macOS rejects non-system
dylibs. A hosted modern-OS run cannot establish these minimum-host requirements.
`minimumHostQualified` and `publicDistributionQualified` remain false.

The build requires contributor Node/npm and network access for locked npm dependencies
and checksum-pinned original license notices. The resulting launcher does not require
global Node/npm. It invokes only `runtime/node`, clears `NODE_OPTIONS`/`NODE_PATH`, and
does not add the private runtime to `PATH`. Selected application/framework operations
still require their own external tools.

Download the exact archive for the **native invoking target** identified by
`distribution/native/inputs.json`, then run on macOS/Linux:

```sh
npm run build:native -- build \
  --runtime-archive /absolute/path/node-v24.21.0-darwin-arm64.tar.gz \
  --output /absolute/path/outside-the-checkout/new-liftoff-bundle
npm run build:native -- verify /absolute/path/outside-the-checkout/new-liftoff-bundle
/absolute/path/outside-the-checkout/new-liftoff-bundle/bin/liftoff capabilities --json
```

The output must not exist. The builder verifies the official archive checksum before
using it, rebuilds the CLI, checks the packed asset inventory, and installs production
dependencies using the committed lock with lifecycle scripts disabled. It refuses
Homebrew-linked runtime libraries rather than copying the contributor's Node executable.
Successful builds remove only their recorded scratch directory; failed outputs and
reported scratch are retained for diagnosis. No global installation is modified.
Builder inputs and every packed source file are rechecked before completion, including
files already dirty when the build began.

`bundle.json` records source identity, packed input, runtime, dependencies, original
license notices and a bounded file/link inventory. `verify` checks local consistency;
**an unsigned, editable manifest is not proof of authenticity or release approval**.
The development artifact always reports `releaseReady: false`. Its public capability
catalog deliberately retains the existing npm distribution advertisement.
The verifier checks the committed runtime/launcher pins, executable modes, packed
source correspondence, current builder inputs and the complete dependency/notice inventory.
Rebuild development bundles after changing the builder or its pinned policy. It does not
execute the bundle or authenticate the recorded Git revision.

Windows uses the same builder, official pinned `win-x64.zip` and private
`runtime/node.exe`. Compile `distribution/windows/launcher.c` in a native x64
MSVC developer shell with `/W4 /WX /O2 /MT`, placing object/executable outputs
outside the checkout. Supply `--windows-launcher <absolute-compiled-exe>` as well
as the runtime/output arguments. The C launcher uses `CreateProcessW`, not a shell,
preserves literal arguments, clears Node startup overrides and propagates child
status. Its exact executable hash is recorded alongside the source inputs.
The Inno Setup source requires independently approved publisher/AppId, certificate,
WinGet ID and qualification-key pins, plus an actual configured signing tool.
It must not be distributed unsigned. Its installer/PATH lifecycle is source
preparation, not a signed, compiled or executed installer qualification.
Its `x64os` architecture restriction rejects ARM64/x64 emulation before
installation; the former generic 64-bit check was insufficient. This source
restriction is not a compiled or minimum-host installer result.

### Windows installer producer contract

On a clean exact-source Windows bundle, the guarded preparation command is:

```sh
node scripts/native-release.mjs windows-installer-inputs \
  /absolute/verified-windows-bundle /absolute/new-private-installer-inputs
```

The real unconfigured policy refuses this command before creating its output.
With independently approved policy inputs it writes `installer.iss`, explicit
`inventory.iss`, compile-time `hashes.iss`, `native-install.json` and `current.txt`.
The generated input contains only inventoried files, no recursive wildcard;
compile-time checks bind every input file, manifest, receipt and pointer to its
selected SHA-256. Generation neither invokes the compiler/signing tool nor
claims WinGet invocation, command ownership, publication or release readiness.
An operator must independently qualify the compiler, signing and complete
install/upgrade/uninstall lifecycle before promoting the result.

The proposed per-user root is `%LOCALAPPDATA%\Programs\Liftoff`.
Immutable bundles live at `versions/<package-version>-<bundle-manifest-sha256>`.
The same compiled launcher is copied to `bin/liftoff.exe`; its bounded, single-link
`current.txt` must contain exactly `<version-name>\r\n` (ASCII).
The launcher rejects malformed, missing, escaping, hard-linked or reparse-point
pointers and junction version directories, and selects the version's private
runtime without putting Node on PATH. Direct bundle launch remains supported.

The schema-1 receipt has kind `liftoff-windows-install-receipt`, scope `user`,
package, version, source commit, manifest/inventory digests, approved package ID,
AppId, publisher and certificate fingerprint, relative version directory,
inner launcher/runtime, and stable-launcher path/hash. The standard
`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<AppId>_is1`
registration retains the installation root, not the inner bundle root.
Additional `LiftoffReceiptSha256`, `LiftoffCurrentSha256`,
`LiftoffLauncherSha256`, `LiftoffCertificateSha256`, `LiftoffPathEntry`
and `LiftoffPathAdded` values bind local attribution. Consumers must independently
verify the real manager/source, signer and complete bundle, then derive the
inner root from the authenticated receipt; none of these editable local records
proves WinGet ownership or publisher authenticity on its own.

Installer source refuses foreign/occupied roots, immutable-version collisions,
reparse-point trees, changed receipt/pointer/launcher identities and running or
unopenable stable launchers. It never closes applications automatically.
Its user-only PATH addition preserves existing raw data and string type and
rechecks observed data before writing. Uninstall removes only the exact
attributable segment, retains unrelated segments/type, and refuses changed or
ambiguous ownership. These are source-level safeguards pending actual signed
Windows lifecycle execution, including failure/rollback and concurrent-edit
qualification; they are not a claim of transactional or ACL qualification.

## Installed qualification

On native Apple Silicon macOS, select an actual external Go executable and the newly
built bundle:

```sh
LIFTOFF_NATIVE_BUNDLE_ROOT=/absolute/path/outside-the-checkout/new-liftoff-bundle \
LIFTOFF_NATIVE_GO_EXECUTABLE="$(command -v go)" \
LIFTOFF_NATIVE_PACKAGE_ROOT=/absolute/path/outside-the-checkout/new-liftoff-bundle \
npx vitest run tests/native-bundle.test.ts tests/native-bundle-installed.test.ts \
tests/native-distribution.test.ts tests/native-release-set.test.ts tests/native-package-installed.test.ts \
  --maxWorkers=1 --no-file-parallelism --coverage.enabled=false --allowOnly=false \
  --reporter=default --reporter=json --outputFile.json=qualification/native-bundle.json
node scripts/native-bundle.mjs verify-report qualification/native-bundle.json
node scripts/native-package-report.mjs qualification/native-bundle.json \
  /absolute/path/outside-the-checkout/new-liftoff-bundle
```

The original report gate requires all eleven Apple Silicon installed cases to pass;
the cross-platform report gate additionally requires every common/applicable case.
An unset bundle variable
skips the opt-in suite and cannot qualify a bundle. Startup and planning use an empty
PATH outside the checkout. Real Manual Go initialization uses the explicitly selected
Go toolchain. Failing executable sentinels record forbidden prerequisite probes; they
are not evidence that those tools are installed. The suite also exercises installed
HCL and controller resolution, missing assets, changed metadata and changed runtime
bytes. It isolates HOME, disables Go telemetry only in that owned test home, and
retains failed fixture roots. It does not change global installations or user settings.
These checks do not qualify Windows controller execution, OS minimums or public
distribution. Windows/Linux use `LIFTOFF_NATIVE_PACKAGE_ROOT` with
`tests/native-bundle.test.ts tests/native-distribution.test.ts tests/native-release-set.test.ts
tests/native-package-installed.test.ts` and the cross-platform report gate.
Windows cases run the real installed controller, running-image locking, and the
compiled stable launcher from a private versioned fixture with foreign cwd and
empty PATH. They exercise malformed/missing/hard-linked/junction pointers and
generate exact installer inputs only with explicitly synthetic policy.
This required case is not execution of a signed Inno installer.
Linux cases exercise the actual bundle's isolated owned installation/recovery and
test-only Ed25519 bootstrap authentication. Linux qualification additionally requires
Docker with a native same-architecture Linux daemon and the exact Rocky Linux 8.10
image pinned in `nativeLinuxUserspaceImages` in `scripts/native-package-report.mjs`.
CI pulls that immutable image before the tests; tests never pull, request emulation or
run a package manager. The daemon and image architectures must match the bundle.
The container has no network, a read-only root/bundle,
no capabilities and only disposable user-owned tmpfs writes. That private tmpfs
explicitly permits execution of the copied development install while retaining
`nosuid` and `nodev`; the case verifies its real mount options. It runs the exact
bundle's startup, all installed plans, controller lookup, the existing isolated-HCL
qualified-runtime refusal and interrupted
development install/recovery against actual glibc 2.28/libstdc++ 8.5 userspace.
It records the real shared host kernel and explicitly leaves minimum-kernel,
minimum-host and public-distribution qualification false. A containerized userspace
result is not a run on Linux kernel 4.18 or proof of real release signing.
The isolated parser remains restricted to its qualified Darwin/ARM64 Node 24.21.0
tuple; Linux execution is refused, not newly qualified by this case.
Every target also extracts its exact
native archive with the absolute native archive tool into a new private fixture,
reverifies the unchanged complete inventory (including native filesystem modes),
runs the extracted launcher outside the checkout with no global tools, and refuses
an altered extracted-file mode. GNU tar explicitly selects `/usr/bin/gzip`, so
extraction and CLI startup retain the isolated empty PATH. CI creates the retained handoff before the suite
and selects it with `LIFTOFF_NATIVE_ARCHIVE_ROOT`, so the tested archive is the
uploaded artifact; local runs without this variable create a fixture-only handoff.
Windows Node `lstat` modes and raw POSIX tar permission fields are not interchangeable.
This roundtrip proves the native filesystem inventory, not Windows ACL security,
installer behavior or minimum-host qualification. Only explicitly named foreign-host
cases are unrun; no failed applicable case can qualify by skipping.
Clean-source hosted reports and development archives are retained for 14 days by
the existing CI workflow. Native package and independent coverage jobs select the
exact PR owning head (or dispatch/push SHA), not its synthetic merge revision.
The full platform suites retain their existing integration checkout. The
repository-setup workflow is unchanged.

## Linux installation ownership and recovery interface

The bundled `installation/native-install.mjs` is Linux-only. Its public CLI
refuses all currently unqualified artifacts. Tests explicitly select development
mode only through the library API and only within new private fixture prefixes.
`distribution/linux/install.sh` accepts explicit local archive/signature/key,
independently approved archive and SPKI fingerprints, private prefix, bundle
manifest digest and reviewed current target. It authenticates bounded private
snapshots with Ed25519 before extraction, uses the private runtime, and still
refuses installation while public/minimum-host policy is false. It downloads
nothing, enrolls no key and changes no shell profile or global launcher.

The exported interfaces for later groups 10/11 are:

```js
installOwnedBundle({ source, prefix, expectedManifestSha256, expectedCurrent, admitHost })
inspectOwnedInstallation(prefix)
recoverOwnedInstallation({ prefix, expectedJournalSha256, expectedStaleLockSha256 })
```

`distribution/native/native-release-admission.mjs` supplies the pure
`assertNativePublicationEvidence` and `verifyNativeEvidenceSignature` functions,
re-exported by the release script. Its `verifyNativeBytesSignature` authenticates
original binary bytes against the caller's approved Ed25519 SPKI SHA-256 and
returns nothing; it does not parse JSON, select a signing principal or grant
installation authority. The existing JSON verifier delegates to the same checks
before parsing, preserving its results and failures. Native bundles carry this
inert module, its adjacent `.d.mts` declaration and release-policy/platforms JSON
in `installation/`; importing admission does not import a builder, inspect Git or
execute a release operation.
The npm package also carries the inert module, declaration and adjacent JSON under
`distribution/native/`; installed runtime-only foreign-directory smoke checks
exercise signer/source/inventory binding without builder or checkout imports.
CLI admission defers loading through one exact literal package-relative edge.
The architectural guard admits only that importer/target, checks the helper's
fixed pure builtin/data dependency closure and packaged presence, and continues
to reject computed, escaping, URL, evaluation and unrelated external edges.

The adjacent inert `native-release-catalog.mjs` validates flat immutable artifact
locators; it does not authenticate a publisher, inspect a channel or grant installation.
Its adjacent `.d.mts` declaration provides the typed locator contract; both are
bound to the builder inputs and copied into the native bundle's `installation/`.

The inert `native-cask-definition.mjs` exports
`nativeCaskDefinition(record, evidence, approvedPolicy?)`, returning exactly
`{ filename, content }` for the existing canonical Ruby cask definition.
The release renderer delegates to it without changing cask bytes. Its adjacent
`.d.mts` declaration accepts unknown records at the typed admission boundary.
It uses the existing publication-evidence and exact archive URL/hash checks;
callers must first independently authenticate the original qualification bytes
and approved principal. It neither authenticates unsigned catalog locators nor
evaluates Ruby, reads Homebrew state, proves a tap commit/path or makes a
Homebrew command digest-bound. Comparing independently selected published cask
bytes to this canonical result is separate from proving manager execution.
Default unconfigured production policy continues to refuse rendering.
Packaging and native-builder inventory integration for this helper must be
composed before installed consumers can use it.

Strict TypeScript consumers distinguish `bundleFile` identities from
`readBundleFile` identities plus captured bytes. Builder and recovery interfaces
retain their optional Windows launcher and selected stale-lock inputs; these
compiler contracts do not grant signing, installation or release authority.

The existing canonical prefix must belong to the invoking user and be private.
Version directories are `versions/<package-version>-<bundle-manifest-sha256>`;
`current` is an atomic relative link and `bin/liftoff` points through it.
`receipts/<version-name>.json` records schema 1, owner `liftoff-native`, canonical
prefix digest, package version, source commit, target, manifest/inventory digests
and private runtime/launcher paths. The **package version** remains distinct
from source development identity. Receipts establish local attribution, not
independent publisher authenticity or permission to modify another manager.

Recovery requires the exact selected `.native-install-transaction.json` digest,
checks previous/current/retained inventory, restores only attributable pointers,
and retains verified version material. Reinstallation can reuse only an identical
verified version and receipt. A dead-process lock additionally requires the
selected `.native-install-lock/owner.json` digest and positive process absence;
active, reused-PID, unknown, changed or ownerless locks are retained. Partial-copy
damage or missing receipts remain explicit incomplete recovery, not a success.
No broad prefix sweep, version deletion or manager migration is provided.
Owner-aware upgrade source reuses these contracts for Linux replacement and
digest-selected recovery, but refuses public apply while policy remains unqualified.

## Exact artifact handoff and public release blockers

On a clean committed source, reuse the existing builder output:

```sh
node scripts/native-release.mjs archive /absolute/verified-bundle /absolute/new-handoff
node scripts/native-release.mjs verify /absolute/new-handoff \
  <independently-reviewed-native-release-json-sha256> <exact-source-commit>
```

The tar.gz, CycloneDX 1.6 SBOM, original-notice index and unsigned
in-toto/SLSA-shaped provenance are bound together in `native-release.json`:
existing package version, target, source commit, run ID, bundle manifest/inventory
and every sidecar's bytes/hash/mode. Unexpected files or changed source/version,
subjects, notices or digests fail verification. These are unsigned inventory
materials, **not signed attestations, reproducible-build claims or release approval**.

`release-artifact.mjs verify-native` reuses the existing qualified tag/main
ancestry gate and requires `EXPECTED_NATIVE_MANIFEST_SHA256` plus
`LIFTOFF_NATIVE_EVIDENCE_DIRECTORY`. The separately authenticated qualification
record binds exact artifacts, approved signing principal/channel and referenced
minimum-host, signing, installation, namespace and HCL-source evidence. macOS
also requires notarization. The gated `native-release.mjs definitions` renderer
emits a cask or WinGet definition only after those same gates; Windows additionally
requires exact signed installer and verified command metadata. It does not submit
definitions or publish artifacts.

Linux publication admission also verifies the actual archive's detached Ed25519
signature, not just a `signing: true` assertion. The evidence directory must contain
`<exact-archive-filename>.sig` (64 raw bytes) and `<exact-archive-filename>.pub`
(PEM SPKI public key). Their approved SPKI SHA-256 comes from
`release-policy.json`; a missing key, foreign key, other algorithm, changed archive
or invalid signature blocks the handoff. Private keys are never part of it.

### Complete native and npm assembly

`release-artifact.mjs assemble-native` and `verify-native-set` reuse the existing
tag/main ancestry, exact run/version/source, npm tarball and authenticated native
qualification gates. They are non-publishing maintainer tools, not an additional
release workflow or a way to approve currently unsigned artifacts. The existing
npm compatibility workflow is unchanged; integrated native/bridge publication
must use the complete set and separately qualify channel availability before
exposing migration guidance. Telemetry readiness is independently required before
project-reporting publication.

Prepare an existing handoff **outside the source checkout** with this layout:

```text
handoff/
  native-inputs.json
  npm/                         # unchanged release.json and exact qualified .tgz
  native/<target>/             # unchanged native-release.json, archive and 3 sidecars
  evidence/<target>/           # qualification.json/.sig/.pub and referenced JSON proofs
                               # Linux: exact archive filename + .sig and .pub
                               # Windows: exact signed setup.exe
```

All four target directories are mandatory: `darwin-arm64`, `linux-arm64`,
`linux-x64`, `win32-x64`. `native-inputs.json` has schema 1, `npmSha256` from
the qualification job, and a `nativeManifests` object mapping **each** of those
targets to its independently reviewed `native-release.json` SHA-256. Supply the
independently reviewed input JSON digest as `EXPECTED_NATIVE_INPUTS_SHA256`:

```sh
node scripts/release-artifact.mjs assemble-native /absolute/qualified-handoff
# Reverify the returned catalog digest through EXPECTED_NATIVE_CATALOG_SHA256:
node scripts/release-artifact.mjs verify-native-set /absolute/qualified-handoff/publication
```

These commands require the real canonical tag-push qualification environment,
not a PR SHA or manual dispatch. Every artifact must identify that same run,
source and package version. No output directory is created before all input
gates pass. An existing `publication/` is never overwritten; a later I/O failure
retains its exact partial output and reports it as failure.
The adjacent `scripts/native-release-set.d.mts` types the assembly library's
inputs/results; the CLI still uses only the committed signing policy.

The output is a flat immutable upload set plus `liftoff-native-release.json`
(schema 1, kind `liftoff-native-release-catalog`). Archives and the signed Windows
installer retain their existing names. Every other native subject is prefixed
with `liftoff-<version>-<target>.`: `native-release.json`,
`qualification.json/.sig/.pub`, `sbom.cdx.json`, `provenance.json`, `NOTICE`,
`evidence-<kind>.json` and the rendered cask/WinGet definitions. The catalog maps
original sidecar filenames to the exact output names/bytes/SHA-256; neither signed
JSON nor original sidecar content is rewritten. npm's record is named
`msn-control-liftoff-<version>.release.json`; its tarball retains its original name.

The catalog is **untrusted locators**, not a replacement signature, source of
package-channel availability or publication receipt. Consumers must verify the
existing approved qualification key/signature, exact native manifest and all
selected subjects/source/version. Its validator is shared as the inert
`distribution/native/native-release-catalog.mjs`; it imports no builder.
No deployed catalog URL or successful native release is asserted by this source.

Cross-host assembly uses explicitly named `verifyNativeArchiveSubjects` to
preserve producer-recorded modes and verify exact subject bytes without interpreting the
collector's local filesystem modes as Windows permissions. The existing
`verifyNativeArchive` and `verifyNativeBundle` retain their exact native mode
checks. Native extraction/mode, minimum-host and installation evidence must still
be independently authenticated; no file normalization supplies that evidence.

The real `release-policy.json` has no approved key, Developer ID team, cask
namespace or WinGet ID/publisher/AppId/certificate. No signing/notarization,
cask install/uninstall, signed Windows installer/WinGet submission, public Linux
signature, minimum-host qualification or publication has been performed.
These require exact source-bound operator authority and real evidence; broad
implementation consent does not authorize accounts, credentials, external taps,
settings changes, release uploads or unsigned fallbacks. Group 10 adds owner-aware
upgrade/doctor source, schema-2 availability/effects/verification and safe manager
handoff interfaces; it does **not** qualify these public channels or complete
real-manager/minimum-host tasks. Group 11 now supplies
[standalone npm-to-Homebrew migration source](mac-npm-migration.md), including
an independent development package, exact selected-owner preflight, private
journal/recovery and injected exact-cask handover. Its production cask provider
is deliberately unregistered. Source fixtures and development packaging do not
enable actual/public migration or complete Group 11 qualification.

Reusable Group-10 contracts live in `src/domain/distribution/native-upgrade.ts`;
`NativeBundleInventory` contains unattributed local facts, while
`NativeInstallation` adds ownership only after receipt or manager validation.
`native.ts` exposes strict policy/manager ownership assertions and
`createNativeUpgradePort`, while `native-metadata.ts` admits independently signed
material without release-builder imports. Cask/WinGet observations and owning
channel reads are explicit abortable provider ports, bounded at the selected
probe deadline. A default Homebrew reader is wired behind the namespace policy:
it reads the exact standard Caskroom receipt/staged version, canonical tap
definition and approved local Git origin, with byte/directory/commit rechecks.
It never executes Homebrew or Ruby or refreshes a source. The receipt format is
derived from [Homebrew's pinned cask Tab implementation](https://github.com/Homebrew/brew/blob/f8d1b25f33e032707f151123aca0eac3a239c676/Library/Homebrew/cask/tab.rb)
and [metadata paths](https://github.com/Homebrew/brew/blob/f8d1b25f33e032707f151123aca0eac3a239c676/Library/Homebrew/cask/metadata.rb).
This is local attribution, not publisher authentication. The current null policy
does not invoke that reader. No production WinGet reader is registered, and no
qualified deployed native stable release is established; real manager/source/certificate facts and
independent qualification remain required. Returning fixture observations does
not qualify a provider. WinGet source currently admits only observed
user-scope ownership; machine-scope installs are not migrated or elevated.
The Windows consumer binds the schema-1 `native-install.json` receipt to the
canonical `%LOCALAPPDATA%\Programs\Liftoff` root, exact CRLF `current.txt`,
immutable version directory and byte-identical stable/inner launchers. Its
`WindowsInstallerLayout` is local attribution only: independent user-scope
manager/source/signer observations must also match the app-root uninstall
registration's receipt/current/launcher hashes. Selecting an inner version
launcher, a junction, a link, a changed pointer or a foreign receipt blocks.
`readWindowsInstallerRegistration` additionally observes the exact HKCU uninstall
key read-only and verifies the stable launcher's embedded Authenticode signature
and signer-certificate SHA-256 through bounded system Windows PowerShell 5.1.
It holds a read-only, non-write-shared launcher handle while hashing and checking
the signature, reobserves registration values, then rechecks the local layout.
It uses no profile, user modules, WinGet invocation, machine-scope lookup or
execution-policy bypass. Missing/restricted PowerShell or an unverified signature
blocks; these OS-observation source tests are not signed-host qualification.
This independent observation is required even when an injected manager provider
asserts a valid signer. It establishes neither the invoking manager nor a source.
An installer receipt alone never supplies a WinGet source or owning channel.
No WinGet CLI/COM observation is silently substituted: the reviewed
[tracking-catalog implementation](https://github.com/microsoft/winget-cli/blob/3d9083c062c1e7a7086e05becb414d4e005e4ab6/src/AppInstallerRepositoryCore/PackageTrackingCatalog.cpp)
opens its database read-write, creates absent state and can rename a corrupt
database even when remote source updates are suppressed. That does not satisfy
this reader's no-refresh/no-registration/no-persistent-change contract.
Linux recovery delegates unchanged to the installed receipt/journal API and
requires exact selected digests; it is not a macOS cask recovery authority.

Cask Git probes and native verification subprocesses explicitly opt out of
ambient environment inheritance. Omitted parent variables are not restored over
their supplied environment; explicitly selected settings remain preserved.
Real harmless child controls contrast the unchanged default merge with these
opt-ins, including filtered Git variables and telemetry-disabled verification.
Their filesystem/signing fixtures still do not qualify a real manager or host.

`createNativeStableSource` in `native-transport.ts` is a bounded read-only material
reader, not an installer or package-manager availability reader. It uses the
canonical GitHub stable release and flat catalog, verifies the selected signed
envelope before large subject downloads, and independently checks tag/main/run
identity with final ref/release readbacks. It downloads only the selected target,
rejects unsafe redirects and oversized streams, and preserves the two-second
metadata deadline. Returned bytes still require `lookupNativeStableCandidate` /
`admitNativeStableMaterial`; no staging root or manager execution permission is
created. The upgrade port uses this default only behind approved policy;
an explicit `stable: undefined` still disables it. The current null policy
refuses before HTTP. Linux candidate admission independently verifies original
archive bytes with the shared raw-byte primitive and the separately approved
archive key, in addition to the qualification-envelope key and subject hashes.
The npm package includes both inert catalog files; no builder is imported.

For a receipt-owned Linux installation, the default upgrade channel independently
repeats authenticated stable/asset observation and binds the same exact archive.
It does not reuse an upstream version string as availability proof; a changed
policy, release or digest blocks. Check does not extract or retain a stage.
`native-archive.ts` supplies the subsequent inert staging boundary: it snapshots
and verifies the approved archive signature, parses a bounded TAR without a shell,
rejects traversal, aliases, special entries, hard links, unsafe/dangling/cyclic
links and unsupported metadata, and matches the exact signed manifest/inventory
before writing. It reuses the installed, verified bundle path/limits/inventory
contract, then rechecks the extracted inventory without running extracted code.
The existing installed runtime/installer performs the same-owner immutable
replacement only after another owner/lock/journal check. Successful stages are
removed through identity-checked private-scratch cleanup; failed stages are
retained separately from the ordinary observation directory. Pre-install
validation failures report no installation effects. This source composition does
not create a signing principal, qualify an archive or enable the current null
release policy, and supplies no Homebrew or WinGet availability authority.

`verifyAuthenticatedMacCandidateArchive` in `native-mac-archive.ts` supplies an
inert Mac candidate check without pretending that the candidate is the current
installation. It privately snapshots and independently re-admits the original
signed release, approved publisher/team/channel/URL bindings, deployed asset
bytes, provenance and referenced qualification evidence. It then reuses the
same bounded TAR/path/link/manifest/full-inventory comparison as Linux staging,
including cancellation during inflation. It does not use Linux archive signing
keys, extract files, import candidate helpers or run the candidate runtime.
Its immutable result contains candidate and inventory facts, not installed
ownership, current channel freshness or permission to execute. Consumers must
still bind the exact archive bytes at later consumption and independently
verify any installed destination. No cask provider is registered by this helper;
actual Homebrew dispatch and host/channel qualification remain separate.

`native-cask-content.ts` adds a source-only content-consumption component, not a
cask installation provider. `prepareAuthenticatedCaskContent` privately re-admits
the signed candidate/material and canonical renderer, then binds its stdin bytes
and expected child observation to that exact candidate, approved tap repository,
source path and commit. The inert child program uses a local `FromContentLoader`
subclass to evaluate the private canonical string while retaining genuine tap
and source-file attribution, following the audited API in
`Homebrew/brew@f8d1b25f33e032707f151123aca0eac3a239c676`.
It retains read-only trust refusal, checks the
source checksum and subject, and repeats protected source/config/path observations
plus uncached `GitRepository` origin/head reads; cached `Tap` getters are not a
freshness check. `readCaskContentObservation` requires the exact bounded protocol
and a positively spawned, settled successful process, with no extra output.
The required environment controls are additive: callers must separately admit
the actual Homebrew host and preserve its effective account/enterprise restrictions.
No invocation, installer, migration, receipt or provider registration is supplied.
Inert Ruby interface-double controls do not qualify actual Homebrew execution.
Those controls in `tests/self-upgrade-cask-content.test.ts` opt in through
`LIFTOFF_TEST_CASK_CONTENT_RUBY`, naming an existing absolute Ruby executable;
they load only the repository's inert host double, not Homebrew libraries.
Atomic no-clobber Caskroom/staging/metadata/prefix publication and independently
attributed installed-destination inventory remain required before any provider
can replace the default pre-removal refusal.

**Missing cask publication primitive**

The read-only audit of
`Homebrew/brew@f8d1b25f33e032707f151123aca0eac3a239c676` does not supply a
supported no-clobber installation transaction. The blocking paths are concrete:

| Write path | Why ordinary installation is insufficient |
| --- | --- |
| Archive staging | `UnpackStrategy::Directory#move_to_dir` merges existing directories and explicitly removes existing destination files before moving replacements. |
| Cask metadata | `Metadata#metadata_timestamped_path` / `metadata_subdir` use recursive directory creation; `Installer#save_caskfile` performs ordinary writes and removes the previous saved directory. |
| Config and install receipt | `Pathname#atomic_write` explicitly always overwrites; `File.atomic_write` publishes through replacement `File.rename`. Atomic replacement is not exclusive creation. |
| Launcher | The macOS `Symlinked#create_filesystem_link` invokes `/bin/ln -h -f -s`; `force: false` does not make that syscall no-clobber. |
| Failure cleanup | `Installer#purge_versioned_files` removes staged/metadata paths without a transaction-created inode/byte attribution check. |

`CaskLock` exists, but at this pin its only non-definition Ruby reference is
cleanup, not installation acquisition. Even an acquired cooperative lock would
not make the writes above exclusive. The sandbox's path/subpath write grants
constrain location, not ownership of newly competing entries. Recursive directory
creation, existence checks and post-write observations do not close those races.
An isolated standard-Ruby control with competing entries introduced after the
absence check confirms that ordinary writes and temporary-file rename overwrite,
directory rename replaces an existing empty directory, and recursive creation
accepts a competing directory. Exclusive symlink creation refuses an existing
dangling entry, but cannot protect the other destinations. These are filesystem
controls, not execution or qualification of Homebrew itself.

The missing supported contract is transaction-private staging, metadata and
rollback destination plumbing, followed by parent-identity-bound exclusive
directory/file publication and cleanup restricted to entries created by that
transaction. It must preserve genuine manager metadata and effective restrictions.
The audited Homebrew interfaces expose neither that complete contract nor an
exclusive directory publication primitive. No wrapper around `Installer`, lock,
availability flag or asserted no-clobber boolean is substituted for it. The
default provider therefore remains absent; installed-directory inventory facts
and canonical content observation cannot authorize npm removal or installation.

**Darwin exclusive-publication boundary**

The primary Darwin ABI in
`apple-oss-distributions/xnu@f6217f891ac0bb64f3d375211650a4c1ff8ca1ea`
provides genuine destination exclusion:
[`renameatx_np`](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/man/man2/rename.2)
with `RENAME_EXCL` returns `EEXIST` for an occupied destination.
`bsd/sys/stdio.h` defines that flag as `0x00000004`; `0x00000002` is
`RENAME_SWAP`, not exclusion. ABI availability does not lower Liftoff's platform
policy or qualify a minimum host.

Parent descriptors bind directory objects, not the current canonical names of
those directories. The rename ABI also selects its source by parent descriptor
and basename, not by the already-open source object or an expected inode.
Deterministic private-filesystem controls, using the existing pinned
Ruby/Fiddle/libSystem, preserve competing destination files, directories and
dangling symlinks, but move a source substituted after identity validation.
Holding the expected source descriptor does not prevent that move; a same-byte
replacement also defeats digest-only readback. Replacing a parent's canonical
name leaves its descriptor bound to the old directory, not the newly selected
prefix path.

[`fclonefileat`](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/man/man2/clonefile.2)
does select the source by descriptor. Zero flags are not namespace-entry
exclusion: the private control follows a dangling destination symlink and creates
its target. The primary header defines `CLONE_NOFOLLOW_ANY` as `0x0008`; with that
flag the corresponding private control refuses the symlink with `ELOOP`, leaves
its target absent, and refuses competing files/directories with `EEXIST`.
The private host control actually clones the held original file and directory
after source-name substitution; directory cloning is not claimed unavailable,
although Apple's manual strongly discourages it. The ABI returns success or an
error, not a created-destination descriptor or identity. A deterministic
post-clone, pre-open replacement makes the subsequent open observe a foreign
same-byte entry. That observation cannot be promoted to transaction ownership.
Likewise, checking an owned inode before name-based `unlinkat` does not prevent
removing a replacement introduced between the check and the unlink.

These audited calls therefore do not supply the combined identified-source,
exclusive-publication and exact-owned-entry cleanup contract under competing
substitution. Source-descriptor cloning closes the source-selection gap, not
creation-bound destination ownership or safe cleanup. A separately protected
transaction namespace or stronger object-bound publication/cleanup plumbing
requires review before implementation. No replacing fallback, check-then-remove
cleanup or success-shaped production primitive is exported. The controls include
abort, deadline, invalid-descriptor/flag and descriptor/process settlement cases;
they are private ABI evidence, not Homebrew, installed, release, minimum-host or
unsupported-filesystem qualification.

For an attributed Homebrew cask, the default channel separately repeats signed
release/asset admission and the read-only receipt/tap-origin/commit observation.
It compares the exact selected definition SHA-256 with the unchanged canonical
`nativeCaskDefinition` output derived from that authenticated release. A match
reports available with `exactApply: false`, never a digest-bound Homebrew command.
Missing/different local Ruby or incomplete provider facts remain unknown rather
than fabricated package absence or authenticated lag. No Ruby is parsed or
evaluated, no source is refreshed, and explicit channel disabling still wins.

Absent-cask preparation is distinct from upgrading an installed owner.
`createHomebrewCaskPreparation` in `native-cask-plan.ts` exposes
`observeDestination(prefix, signal)` and `preview(prefix, signal)`. Stable lookup
accepts a target-only request, so a migration caller need not forge a
`NativeInstallation`. The preview authenticates target material, rechecks canonical
destination/presence facts, and optionally observes bounded local cask bytes in
the flat or first-letter tap layout. Those bytes are explicitly
`unverified-local-bytes`; neither a matching filename nor their hash proves tap
origin, safe Ruby, channel availability, writable destinations, signing or host
qualification. An occupied path is not installed ownership. Callers must use fresh
policy and observations; preview identities are not later effect authority.
The additive `releaseDefinition` comparison authenticates the expected canonical
filename/content digest against the already admitted candidate and reports
`selectedSource: exact`, `different` or `absent`. It does not upgrade the local
source's attribution or prove tap registration, channel freshness or execution.
An exact byte match still leaves the absent-cask preview's channel unknown and
its command null. The installed consumer imports only the shared inert renderer,
not the release builder, and retains private snapshots of admitted material.

Every preview retains `channel.status: unknown`,
`preflight.exactExecutionProven: false`, and
`execution: { status: blocked, reason: exact_cask_execution_unproven, command: null }`.
There is no install/uninstall method. A migration must stop before removing npm.
The inspected [Homebrew install parser](https://github.com/Homebrew/brew/blob/f8d1b25f33e032707f151123aca0eac3a239c676/Library/Homebrew/cmd/install.rb)
has no cask version selector; [`version-install`](https://github.com/Homebrew/brew/blob/f8d1b25f33e032707f151123aca0eac3a239c676/Library/Homebrew/cmd/version-install.rb)
is formula-only and may create a personal tap. The
[cask path loader](https://github.com/Homebrew/brew/blob/f8d1b25f33e032707f151123aca0eac3a239c676/Library/Homebrew/cask/cask_loader.rb)
applies loadability/trust policy, then reopens and evaluates Ruby. A prehashed
temporary `.rb`, an unpinned token, `--dry-run` or a no-auto-update setting is
therefore not established exact-source execution authority. Preparation never
executes Homebrew/Ruby/Git, creates a tap, changes trust/settings, writes a cask,
or supplies an unbound fallback command.

The pinned HCL npm package omits standalone license notices. The builder supplies its
upstream MPL notice and the notices for the seven modules recorded in the original WASM,
including Go's license. Module zip checksums were checked against the embedded Go module
hashes; original notice bytes are separately pinned. The upstream WASM reports modified
source. Its source correspondence/reproducibility is not claimed, and the Go license
source tag is not an assertion about the binary's compiler version. Release provenance
and any required source-availability qualification remain explicit release gates.
