# Native bundle builds

The native builder produces real private-runtime bundles, not an npm distribution
or an installation. Nothing in this workflow registers a launcher in a user's
PATH, submits a cask/WinGet package, signs a Liftoff release, or publishes it.

## Contributor prerequisites

Use the repository's supported Node/npm toolchain and build its contributor
tools first. The assembler reuses the compiled `NodeCommandRunner` for bounded
process-tree settlement; it does not copy the checkout's `dist` or
`node_modules` into the application payload.

```sh
npm ci
npm run build
```

Python 3 is required for bounded archive inspection and creation. An existing
Go 1.27+ compiler is additionally required to cross-build the Windows PE
bootstrap. `GOTOOLCHAIN=local`, `GOPROXY=off`, and `CGO_ENABLED=0` prevent launcher
compilation from bootstrapping another toolchain or downloading Go modules.
The Go bootstrap is a small native launcher; the application remains TypeScript
and runs in its bundled Node runtime.

Set an approved package feed only in the invocation environment. Do not edit
source package/lock files to insert a machine-local feed:

```sh
export npm_config_registry="$APPROVED_NPM_REGISTRY"
```

If the approved feed cannot serve an exact locked version, a read-only existing
npm cache may be selected explicitly:

```sh
export LIFTOFF_NPM_CACHE_SOURCE="$EXISTING_NPM_CACHE"
```

Only content-addressed public package tarballs whose bytes match the source
lock's integrity are copied to the new private cache. Cache indexes, credentials,
user npm configuration, and ambient `node_modules` are not copied. A missing
tarball still fails the restore; versions and integrity values are never
fabricated or silently replaced.

## Honest development builds

The current working tree contains the unpublished `0.13.0` candidate over the
`0.12.3` baseline. A development build records the actual selected source-file
inventory and SHA-256 tree identity. The observed Git HEAD is recorded only as
an observation, with `releaseCommit: null`.

```sh
node scripts/distribution/assemble-native-bundle.mjs \
  --mode development \
  --target darwin-arm64 \
  --output "build/native development"
```

Choose the actual target explicitly; there is no default version, target, or
source commit. The source package and root lockfile provide the CLI version.
An existing output, output outside `build/`, linked input, native case collision,
missing selected asset, or package/lock mismatch blocks assembly.

The assembler:

1. Copies a checked, bounded source snapshot into its new owned work area.
2. Verifies the pinned official Node archive, checksum file, machine identity,
   and upstream `BUILDING.md` identity before executing that runtime.
3. Restores source-locked production dependencies with
   `npm ci --omit=dev --ignore-scripts` into private staging. Compiler tooling is
   restored from a minimal exact subset of the same source lock; unrelated
   Vitest/Vite dependencies are not needed for compilation.
4. Compiles the snapshot, restores the final production dependency tree
   independently, and copies all declared runtime assets, local docs and license
   material. Registered asset bytes and sizes are checked, not just descriptor
   hashes. The public-document inventory includes `CONTRIBUTING.md`, `SECURITY.md`,
   and exactly `infrastructure/opentofu/bootstrap/README.md` and
   `infrastructure/opentofu/telemetry/README.md`; provider configuration/state and
   operational qualification assets are not added to the payload.
5. Creates the relocatable launcher, makes payload files/directories read-only,
   and, on the matching current host, runs version/help/capability/skill,
   representative Node/Fastify and RAG `liftoff plan`, complete packaged-resource,
   and real packaged generation/staged-manifest-readback checks with an empty PATH.
6. Checks local Markdown file links from the actual payload and archive, then
   retains the complete file/mode/SHA-256 inventory and unsigned archive.

A development payload contains `development-build-manifest.json`, **not**
`build-info.json` or `liftoff-build-manifest.json`. The existing runtime reader
therefore reports development/unqualified identity, rather than accepting a
made-up native release SHA or date. `build-status.json` and
`payload-inventory.json` live beside the payload/archive.

`THIRD_PARTY_NOTICES.json` inventories actual runtime dependency license files.
The locked `@cdktf/hcl2json@0.21.0` tarball omits its root license text, so this
version has explicit checksum-pinned upstream MPL-2.0 and Go-runtime license
supplements, including its public source location. An unknown missing license
does not silently pass.

Failed builds retain their exact owned partial work with `state: failed`; they
never return assembled success. Successful builds remove only their verified,
settled, task-created work directory.

## Runtime and target facts

`scripts/distribution/node-runtime.json` pins Node `24.20.0`, all six official
archive checksums, the official checksum document, and the release-specific
upstream build document:

- <https://nodejs.org/dist/v24.20.0/SHASUMS256.txt>
- <https://github.com/nodejs/node/blob/v24.20.0/BUILDING.md>

The official macOS x64/arm64 binaries target **macOS 13.5**. Liftoff records
**macOS 13.5.0 / Darwin 22.6.0** for both targets. Apple's
[`macos-135` release](https://github.com/apple-oss-distributions/distribution-macOS/blob/macos-135/release.json)
identifies macOS 13.5; its
[`xnu` submodule](https://github.com/apple-oss-distributions/distribution-macOS/tree/macos-135/xnu)
points to commit `1b191cb58250d0705d8a51287127505aa4bc0789`, whose
[`config/MasterVersion`](https://github.com/apple-oss-distributions/xnu/blob/1b191cb58250d0705d8a51287127505aa4bc0789/config/MasterVersion)
is `22.6.0`. This establishes the source mapping, not minimum-host execution.

For GNU/Linux x64/arm64, Node declares kernel 4.18+, glibc 2.28+, and
**libstdc++ 6.0.25+ (`GLIBCXX_3.4.25`)**. Liftoff retains its separate
**kernel 4.18.0 / glibc 2.31** policy; the lower upstream glibc floor does not
authorize lowering it. The Windows table declares Windows 10/Server 2016 for
x64 and Windows 10 for arm64. **Build 17763 is Liftoff policy**, not an exact
Node minimum established by that table.

Upstream excludes vendor-end-of-life platforms even when their numeric versions
satisfy these floors. Runtime-verification reports carry
`upstream.vendorSupportPolicy: "vendor-supported-platforms-only"` and, for Linux,
the distinct `minimumLibstdcxx` and `minimumGlibcxx` requirements. These are
declared requirements from the pinned source, not observations of installed
libraries, vendor support, or native qualification. Final supported-host and
owner-channel qualification remains required.

The runtime archive contains npm, but the Liftoff payload intentionally copies
only the verified private Node executable and its license. The builder's Node
version (for example 24.21) is recorded separately and never relabeled as the
pinned private 24.20 runtime.

| Target | Payload launcher | Archive | Standard hosted runner |
| --- | --- | --- | --- |
| `darwin-x64` | `bin/liftoff`, `/bin/sh`, private `runtime/node` | `.tar.gz` | `macos-15-intel` |
| `darwin-arm64` | `bin/liftoff`, `/bin/sh`, private `runtime/node` | `.tar.gz` | `macos-14` |
| `linux-x64` | `bin/liftoff`, `/bin/sh`, private `runtime/node` | `.tar.gz` | `ubuntu-22.04` |
| `linux-arm64` | `bin/liftoff`, `/bin/sh`, private `runtime/node` | `.tar.gz` | `ubuntu-24.04-arm` |
| `win32-x64` | Real PE `bin/liftoff.exe`, private `runtime/node.exe` | `.zip` | `windows-2022` |
| `win32-arm64` | Real PE `bin/liftoff.exe`, private `runtime/node.exe` | `.zip` | `windows-11-arm` |

These labels identify the native architectures documented in
[GitHub's standard hosted-runner table](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
The retired `macos-13` label is not an available Intel qualification host, and
Windows ARM64 and Ubuntu ARM64 have documented standard runners. Availability
does not establish an authorized execution, an observed runner/job identity, or
qualification of this candidate. These newer images also do not prove the older
minimum OS, kernel, glibc or libstdc++ floors. Separate actual minimum-host
qualification remains required; a container cannot substitute its host kernel,
and cross-compilation cannot substitute execution on the target architecture.

The release gate requires both `native-<target>` and
`native-minimum-<target>` authenticated reports for every target. Both bind the
same immutable source and final signed artifact, runtime, resources and helpers;
both require the complete native checks, helper settlement and applicable
Windows regression evidence. The standard runner report cannot stand in for
the minimum-host report, even when every source test passes.

Each report carries `jobId`, `observedAt` and the measured `host` values from
the installed payload's `observeNativeHost()` adapter: `os`, `arch`,
`kernelRelease`, plus `glibcVersion` on Linux, `hostVersion` and
`darwinRelease` on macOS, or `windowsBuild` on Windows. Retain observations
from the actual execution, not values copied from `nativeTargetFloors`.
The gate checks the exact job, its observed runner identity and labels, the
job/run/witness time interval, and the signed release binding. Native runner
qualification must still establish non-emulated target execution; an
architecture string alone is not that qualification.

Minimum-host report producers additionally require an approved
`verification.minimumNativeHosts` registration in
`assets/qualification/release-scope.json`. Each of the six target entries names
the exact `workflow`, `job` and `runnerLabels`; its trusted workflow policy must
admit `native-minimum-<target>` and the same `nativeTarget`. This registry is
currently unconfigured, so the gate remains blocked. Registering a workflow
does not manufacture execution evidence or authorize provisioning a runner.
Measured minimum-host OS/kernel/glibc versions must equal the declared floors
(numeric-equivalent trailing zeros and native Linux kernel package suffixes are
accepted). Newer measured hosts establish compatibility only, not support at
the older floor. Vendor-support and Linux libstdc++/GLIBCXX qualification remain
separate required runtime evidence; these OS/glibc comparisons do not establish
those facts.

Launchers pass literal argument arrays and remove Node preload/module-search and
loader-injection environment settings. They never fall back to ambient Node or
npm, and do not put the private runtime on project-tool PATH. Windows compilation
checks PE architecture, not just a filename; cross-compilation is still not
native Windows execution or host-floor qualification.

## Real outside-checkout closure proof

Use the exact emitted build status. The verifier independently checks the
official runtime, creates one owned sibling workspace outside the checkout,
copies the payload into quote/space/metacharacter paths, and uses an empty PATH.
It exercises public commands and all registered resources with read-only payload
files. It also invokes the packaged generator for Node/Fastify and RAG profiles,
writes its actual artifacts through the existing private staging writer, and
reads back generated manifests. This is bounded generation, not completed
`init`: no workstation prerequisites, framework installation, dependency setup,
Git publication, or provider execution are bypassed or claimed.

It then checks missing runtime/dependency/asset/template/profile failures and detects corrupt
runtime bytes **without executing the corruption**. It cleans only its own
settled proof workspace and preserves a JSON result beside the original bundle.

Public documentation closure starts at shipped root Markdown, `docs/`, and the
two operator READMEs, following reachable local Markdown links against the actual
payload inventory. Missing linked documents or images fail; checkout files and
rewritten web URLs cannot satisfy the check. The relocated proof also removes
each of the four additional public documents in its own copy and requires
explicit failure before restoring the unchanged payload. The archive receives
the same link check without extracting or executing its contents. These results
are packaging integrity evidence, not native installation or release authority.

```sh
node scripts/distribution/verify-native-build.mjs \
  --build-status "build/native development/build-status.json" \
  --outside-parent "$(dirname "$PWD")"
```

An optional `--node-archive <verified-local-archive>` avoids downloading the
official runtime again. The successful result is
`DEVELOPMENT_RUNTIME_CLOSURE_OBSERVED`, never production qualification.

Focused build tests, including real Windows PE cross-compilation and the actual
current-host development bundle proof:

```sh
LIFTOFF_NATIVE_BUILDER_INTEGRATION=1 \
LIFTOFF_NATIVE_BUILD_STATUS="build/native development/build-status.json" \
npx vitest run tests/native-bundle-build.test.ts --maxWorkers=2
```

Without that explicit integration selection, unit tests do not claim real bundle
or native-host qualification.

## Release preparation remains separately gated

Release mode additionally requires an exact clean immutable source commit and
registered native signing/provenance trust. It refuses a canonical floor that is
weaker than the pinned runtime. It cannot label the dirty candidate tree as the
baseline commit:

```sh
node scripts/distribution/assemble-native-bundle.mjs \
  --mode release \
  --target darwin-arm64 \
  --source-commit "$REVIEWED_SOURCE_COMMIT" \
  --output "build/release-evidence/native-darwin-arm64"
```

These are unsigned build outputs. Signing may change bytes; regenerate final
checksums and exact provenance afterward, then qualify the final artifacts.
Required signing identities, native runners, publisher/tap/package identities,
and live/operator approvals remain separate prerequisites.

Release archives use the assembler's single `liftoff-v<V>-<target>/` root. The
gate records that root from the actual archive entries and rejects rootless,
renamed, differently nested, or foreign-root entries before using canonical
Homebrew/WinGet paths. A manager's path claim cannot supply the archive root.

The evidence collector loads expected contracts only from the trusted source
build, after `loadReleaseContracts(projectRoot, sourceCommit)` admits the exact
reviewed checkout; it never executes a submitted native payload to define its
own scope. Its `registryBindings` document has schema 1 and kind
`liftoff-release-registry-bindings`. The shared LF-terminated activation
`canonicalSha256` binds the validated public envelope, complete graph and producer
declarations, skill definitions and user/project host projections, and independent
repair schemas/recipes. Standards catalog digests keep their own semantic
algorithms; governance profiles remain a separate registry, not standards-profile
aliases. This snapshot defines required evidence, not qualified execution,
and unsupported recovery is not advertised as an implemented recipe.

Channel preparation consumes authenticated final artifacts for all six targets:

```sh
node scripts/distribution/generate-channel-manifests.mjs \
  --evidence build/release-evidence/release-evidence.json \
  --output build/release-evidence/channel-definitions
```

The canonical build-only renderers are in
`scripts/distribution/channel-definitions.mjs`. WinGet metadata declares a ZIP
with nested portable `bin/liftoff.exe`; Homebrew exposes the relocatable binary
without Node or user-state removal. Linux output is an artifact descriptor,
**not** an installation receipt. No `installedAt`, guessed install root, all-zero
checksum, approval boolean, or source default can manufacture installation or
publication authority.
