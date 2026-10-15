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
The Inno Setup source requires an independently approved publisher/AppId and an
actual configured signing tool. It is not a qualified install/uninstall or
stable-command/PATH integration; it must not be distributed unsigned.
Its `x64os` architecture restriction rejects ARM64/x64 emulation before
installation; the former generic 64-bit check was insufficient. This source
restriction is not a compiled or minimum-host installer result.

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
Windows cases run the real installed controller and running-image locking.
Linux cases exercise the actual bundle's isolated owned installation/recovery and
test-only Ed25519 bootstrap authentication. Every target also extracts its exact
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

`distribution/native/native-release-admission.mjs` supplies the unchanged pure
`assertNativePublicationEvidence` and `verifyNativeEvidenceSignature` functions,
re-exported by the release script. Native bundles carry this inert module and
adjacent release-policy/platforms JSON in `installation/`; importing admission
does not import a builder, inspect Git or execute a release operation. CLI-specific
npm packaging/import integration remains separate owner-aware upgrade work.
The adjacent inert `native-release-catalog.mjs` validates flat immutable artifact
locators; it does not authenticate a publisher, inspect a channel or grant installation.
Its adjacent `.d.mts` declaration provides the typed locator contract; both are
bound to the builder inputs and copied into the native bundle's `installation/`.

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
No broad prefix sweep, version deletion, manager migration or upgrade is provided.

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
settings changes, release uploads or unsigned fallbacks. Current `liftoff upgrade`
and npm-to-Homebrew migration are unchanged and remain separate groups 10/11.

The pinned HCL npm package omits standalone license notices. The builder supplies its
upstream MPL notice and the notices for the seven modules recorded in the original WASM,
including Go's license. Module zip checksums were checked against the embedded Go module
hashes; original notice bytes are separately pinned. The upstream WASM reports modified
source. Its source correspondence/reproducibility is not claimed, and the Go license
source tag is not an assertion about the binary's compiler version. Release provenance
and any required source-availability qualification remain explicit release gates.
