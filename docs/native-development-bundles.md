# Native development bundles

The contributor-only native builder assembles the existing CLI, its locked production
dependencies, packaged assets and notices with an official standalone Node runtime.
It currently runs on native Apple Silicon macOS. It is **not a Homebrew cask or a
published installation channel**. Windows/Linux installers, signing, notarization,
and installation ownership remain separate qualification.

The qualified development-bundle host floor is **macOS 13.5 on native Apple
Silicon**. The floor comes from the pinned Node.js 24.21.0 executable's
`LC_BUILD_VERSION`, not from the contributor workstation or the current GitHub
runner image. Intel processes, Rosetta/translated execution, macOS releases below
13.5, and hosts whose version or translation state cannot be observed are refused
before an output directory or installation is changed.

The build requires contributor Node/npm and network access for locked npm dependencies
and checksum-pinned original license notices. The resulting launcher does not require
global Node/npm. It invokes only `runtime/node`, clears `NODE_OPTIONS`/`NODE_PATH`, and
does not add the private runtime to `PATH`. Selected application/framework operations
still require their own external tools.

Download the exact archive identified by `distribution/native/inputs.json`, then run:

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
The runtime must be a thin ARM64 Mach-O executable whose recorded minimum is macOS
13.5 and whose dynamic dependencies resolve only from `/usr/lib` or
`/System/Library/Frameworks`. The locked production npm closure must contain no
native `.node`, dynamic-library, DLL, or executable payload; the isolated HCL
implementation remains platform-neutral WASM.
Successful builds remove only their recorded scratch directory; failed outputs and
reported scratch are retained for diagnosis. No global installation is modified.
Builder inputs and every packed source file are rechecked before completion, including
files already dirty when the build began.

`bundle.json` records source identity, the qualified build host and macOS floor, the
runtime's Mach-O and system-library evidence, packed input, dependencies, original
license notices and a bounded file/link inventory. `verify` re-observes the current
host and executable before checking local consistency;
**an unsigned, editable manifest is not proof of authenticity or release approval**.
The development artifact always reports `releaseReady: false`. Its public capability
catalog deliberately retains the existing npm distribution advertisement.
The verifier checks the committed runtime/launcher pins, executable modes, packed
source correspondence, current builder inputs and the complete dependency/notice inventory.
Rebuild development bundles after changing the builder or its pinned policy. It does not
execute the bundle or authenticate the recorded Git revision.

## Installed qualification

On native Apple Silicon macOS, select an actual external Go executable and the newly
built bundle:

```sh
LIFTOFF_NATIVE_BUNDLE_ROOT=/absolute/path/outside-the-checkout/new-liftoff-bundle \
LIFTOFF_NATIVE_GO_EXECUTABLE="$(command -v go)" \
npx vitest run tests/native-bundle.test.ts tests/native-bundle-installed.test.ts \
  --maxWorkers=1 --no-file-parallelism --coverage.enabled=false --allowOnly=false \
  --reporter=default --reporter=json --outputFile.json=qualification/native-bundle.json
node scripts/native-bundle.mjs verify-report qualification/native-bundle.json
```

The report gate requires every listed installed case to pass; an unset bundle variable
skips the opt-in suite and cannot qualify a bundle. Startup and planning use an empty
PATH outside the checkout. Real Manual Go initialization uses the explicitly selected
Go toolchain. Failing executable sentinels record forbidden prerequisite probes; they
are not evidence that those tools are installed. The suite also exercises installed
HCL and controller resolution, missing assets, changed metadata and changed runtime
bytes. It isolates HOME, disables Go telemetry only in that owned test home, and
retains failed fixture roots. It does not change global installations or user settings.
These checks qualify only the native Apple Silicon/macOS 13.5 development-bundle
runtime boundary. They do not qualify Windows controller execution, signing,
notarization, Homebrew ownership, or public distribution.

The pinned HCL npm package omits standalone license notices. The builder supplies its
upstream MPL notice and the notices for the seven modules recorded in the original WASM,
including Go's license. Module zip checksums were checked against the embedded Go module
hashes; original notice bytes are separately pinned. The upstream WASM reports modified
source. Its source correspondence/reproducibility is not claimed, and the Go license
source tag is not an assertion about the binary's compiler version. Release provenance
and any required source-availability qualification remain explicit release gates.
