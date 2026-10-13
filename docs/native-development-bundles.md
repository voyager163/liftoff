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

## Installed qualification

On native Apple Silicon macOS, select an actual external Go executable and the newly
built bundle:

```sh
LIFTOFF_NATIVE_BUNDLE_ROOT=/absolute/path/outside-the-checkout/new-liftoff-bundle \
LIFTOFF_NATIVE_GO_EXECUTABLE="$(command -v go)" \
LIFTOFF_NATIVE_PACKAGE_ROOT=/absolute/path/outside-the-checkout/new-liftoff-bundle \
npx vitest run tests/native-bundle.test.ts tests/native-bundle-installed.test.ts \
  tests/native-distribution.test.ts tests/native-package-installed.test.ts \
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
`tests/native-bundle.test.ts tests/native-distribution.test.ts
tests/native-package-installed.test.ts` and the cross-platform report gate.
Windows cases run the real installed controller and running-image locking.
Linux cases exercise the actual bundle's isolated owned installation/recovery and
test-only Ed25519 bootstrap authentication. Every target also extracts its exact
native archive with the absolute native archive tool into a new private fixture,
reverifies the unchanged complete inventory (including native filesystem modes),
runs the extracted launcher outside the checkout with no global tools, and refuses
an altered extracted-file mode. CI creates the retained handoff before the suite
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
does not import a builder, inspect Git or execute a release operation.
The npm package also carries the inert module and adjacent JSON under
`distribution/native/`; installed runtime-only foreign-directory smoke checks
exercise signer/source/inventory binding without builder or checkout imports.

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

The real `release-policy.json` has no approved key, Developer ID team, cask
namespace or WinGet ID/publisher/AppId/certificate. No signing/notarization,
cask install/uninstall, signed Windows installer/WinGet submission, public Linux
signature, minimum-host qualification or publication has been performed.
These require exact source-bound operator authority and real evidence; broad
implementation consent does not authorize accounts, credentials, external taps,
settings changes, release uploads or unsigned fallbacks. Group 10 adds owner-aware
upgrade/doctor source, schema-2 availability/effects/verification and safe manager
handoff interfaces; it does **not** qualify these public channels or complete
real-manager/minimum-host tasks. Standalone npm-to-Homebrew migration remains
unimplemented, separate Group 11 work.

Reusable Group-10 contracts live in `src/domain/distribution/native-upgrade.ts`;
`NativeBundleInventory` contains unattributed local facts, while
`NativeInstallation` adds ownership only after receipt or manager validation.
`native.ts` exposes strict policy/manager ownership assertions and
`createNativeUpgradePort`, while `native-metadata.ts` admits independently signed
material without release-builder imports. Cask/WinGet observations and owning
channel reads are explicit abortable provider ports, bounded at the selected
probe deadline. No production provider or deployed native stable endpoint is
registered while the namespace/signing policy is null. A qualified provider must
observe real manager receipts and source/certificate facts; returning fixture
observations does not qualify it. WinGet source currently admits only observed
user-scope ownership; machine-scope installs are not migrated or elevated.
Linux recovery delegates unchanged to the installed receipt/journal API and
requires exact selected digests; it is not a macOS cask recovery authority.

The pinned HCL npm package omits standalone license notices. The builder supplies its
upstream MPL notice and the notices for the seven modules recorded in the original WASM,
including Go's license. Module zip checksums were checked against the embedded Go module
hashes; original notice bytes are separately pinned. The upstream WASM reports modified
source. Its source correspondence/reproducibility is not claimed, and the Go license
source tag is not an assertion about the binary's compiler version. Release provenance
and any required source-availability qualification remain explicit release gates.
