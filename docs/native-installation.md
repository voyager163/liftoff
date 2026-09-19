# Native Distribution and Installation Handover

The unpublished Liftoff 0.13.0 candidate is being prepared for native-only distribution. Direct npm publication is retired for new releases; historical npm versions remain frozen and reproducible for explicit recovery. Contributor assembly and actual development-bundle closure checks are documented in [Native bundle builds](native-builds.md); they are not published installation availability.

> **Qualification & Release Status Notice**: Native package channels and artifacts are candidate/unqualified until signed release binaries, approved tap/publisher identities, and full native runner qualification are completed. The channel identifiers (`voyager163/liftoff/liftoff` for Homebrew and `voyager163.liftoff` for WinGet) are planned candidate identities and remain release blockers pending maintainer approval; they are not advertised as currently published or broadly available. Historical npm releases (such as `@msn-control/liftoff@0.12.3`) remain available for explicit recovery and are not an ongoing distribution bridge.
>
> On Windows, bundle construction selects the native PE `bin/liftoff.exe` launcher with private `runtime/node.exe`; it does not generate or select a current `.cmd` launcher. The default WinGet observer is blocked by required read-only interfaces absent from the reviewed public contract (`implementation_missing`): `PackageCatalogReference.Connect` can initialize missing sources even with background updates disabled, version/installer getters can populate caches, and complete installed-portable ownership/launcher and cached-manifest evidence is not exposed. Receipt-owned direct PE handover has a source implementation described below, independently of that WinGet limitation; Windows execution and minimum-host qualification remain outstanding. Historical Windows npm launcher ownership inventory still requires independent qualification. Migration guidance uses the admitted candidate executable, exact target arguments, and recorded working directory, never the legacy PATH launcher. PE construction and format checks do not establish Windows process, execution-policy, or host qualification, and no release publication is claimed.

The WinGet limitation is an API/operation constraint, not evidence of native Windows execution: the [public deployment contract](https://github.com/microsoft/winget-cli/blob/master/src/Microsoft.Management.Deployment/PackageManager.idl), [missing-source update path](https://github.com/microsoft/winget-cli/blob/master/src/AppInstallerRepositoryCore/Microsoft/PreIndexedPackageSourceFactory.cpp#L435-L460), and [manifest/version file-cache behavior](https://github.com/microsoft/winget-cli/blob/master/src/AppInstallerCommonCore/FileCache.cpp#L159-L213) do not provide the required fail-closed cached-only snapshot. Source enumeration alone does not establish installed ownership or exact target delivery.

The current source package is marked `private` to prevent accidental future npm
publication. Local package smoke tooling still inventories the complete
runtime-resource closure, including skills, profiles, and templates; that is
contributor packaging evidence, not a published npm release or native-host
qualification. Operational qualification inventories are not runtime resources.

## 1. Native Distribution Architecture

Every native Liftoff package bundles:
- A private pinned Node LTS runtime (isolated from system PATH).
- Compiled ESM application code and runtime dependencies.
- Packaged runtime resources (templates, policies, licenses, and Windows process controller).
- Relocatable launchers (`bin/liftoff` on macOS/Linux, a real PE `bin/liftoff.exe` on Windows).

Installed Liftoff runs without ambient Node or npm on the host. However, Liftoff's private runtime does **not** satisfy selected project requirements: external Node, npm, Python, or Go are still required when selected by project templates.

## 2. Supported Targets and Platforms

The required matrix has six targets; none is qualified merely by constructing an archive. Node 24.20 upstream requirements and actual host-floor qualification must be distinguished:

| Operating System | Architecture | Target Identifier | Minimum Host / Runtime Floor | Delivery Channel |
| --- | --- | --- | --- | --- |
| macOS | arm64 (Apple Silicon) | `darwin-arm64` | Liftoff macOS 13.5.0 / Darwin 22.6.0; native qualification pending | Homebrew Cask (`voyager163/liftoff/liftoff`) |
| macOS | x64 (Intel) | `darwin-x64` | Liftoff macOS 13.5.0 / Darwin 22.6.0; native qualification pending | Homebrew Cask (`voyager163/liftoff/liftoff`) |
| Windows | x64 | `win32-x64` | Liftoff build 17763 policy; upstream Windows 10/Server 2016; native qualification pending | WinGet Portable (`voyager163.liftoff`) |
| Windows | arm64 | `win32-arm64` | Liftoff build 17763 policy; upstream Windows 10 Tier 2; native qualification pending | WinGet Portable (`voyager163.liftoff`) |
| Linux | x64 | `linux-x64` | Liftoff kernel 4.18.0 / glibc 2.31; native qualification pending | Direct Archive |
| Linux | arm64 | `linux-arm64` | Liftoff kernel 4.18.0 / glibc 2.31; native qualification pending | Direct Archive |

Node's Linux binaries also require libstdc++ 6.0.25+ (`GLIBCXX_3.4.25`);
their upstream glibc 2.28 floor does not lower Liftoff's 2.31 policy. Node excludes
vendor-end-of-life platforms regardless of numeric floors. The verified upstream
sources and the distinction between requirements and observed native support are
recorded in [Native bundle builds](native-builds.md#runtime-and-target-facts).

Release manifests (schema 1) bind final signed SHA-256 checksums, immutable archive URLs, source commit, and resource inventory counts. Post-signing byte changes or mismatched targets block admission.

### Public runtime release trust

The CLI reads only the packaged `assets/distribution/native-trust.json` public
trust root for default native release authority. The unpublished checkout uses
schema 1 with canonical product/repository and explicit `state: "unconfigured"`;
it contains no signer, endpoint, channel, or publication approval. A missing root
reports `trust_missing`, an unconfigured root reports `trust_unconfigured`, and
malformed or unsafe root data is rejected before network access. Operational
`assets/qualification` data and public Node build pins cannot substitute for it.

A configured root contains reviewed Ed25519 public signers, exact public owner
channels, and the signed publication-index URL/signature URL, signer ID, and
minimum sequence. The authenticated index binds that root, stable version,
per-version source commit and immutable manifest URLs/digests, sequence, and UTC
validity of at most 24 hours. It can advance stable without rebuilding the
installed CLI. Manifest and artifact provenance signatures are verified
separately. Index data cannot add channels or grant authority through local
approval booleans. Explicit injected registrations remain non-production test
and adapter seams.

Checks do not persist a discovery cache. Expiry and the packaged sequence floor
apply on every invocation; sequence rollback, equivocation, stable rollback, and
changed immutable publications observed by one client are rejected in memory.
This is not a claim of persistent cross-process rollback state. Default HTTP
delivery uses one bounded deadline and at most three explicitly checked GitHub
release-asset redirects to known asset CDN hosts. It forwards no caller tokens,
cookies, or referrer; other origins do not gain redirect authority. These
protocol checks do not establish approved production signers or host qualification.

## 3. Routine Owner-Preserving Upgrade

Use `liftoff upgrade` to keep the native CLI up to date:

```bash
# Read-only check: exits 0 if current, 2 if update available, 1 if blocked
liftoff upgrade --check

# Execute owner-preserving upgrade
liftoff upgrade
```

### Key Upgrade Guarantees:
- **Dedicated Invocation Authorization**: Invoking `liftoff upgrade` authorizes only the exact internally bound target through the proven current owner; no second confirmation flag is required for routine upgrades.
- **Owner-Preserving**: Homebrew upgrades Homebrew; WinGet upgrades WinGet; Direct-install upgrades Direct. It never switches owners or elevates permissions.
- **Read-Only Check**: `upgrade --check` does not refresh package manager sources automatically, modify persistent configuration, or write project files.
- **Staged Replacement**: Direct installation stages into `<destinationDirectory>/versions/<version>-<provenanceDigest>` under exclusive lock, verifying candidate integrity before activating the relocatable launcher.
- **Windows Locked Handover**: If a running executable is locked on Windows, the system reports an explicit handover state and defers active cleanup without terminating unrelated processes.

An unexpected native apply failure leaves the operation outcome and record
persistence explicitly unconfirmed. Missing observations never mean that nothing
happened. Human and JSON output both distinguish completed and uncertain effects,
recovery requirements, record persistence, and upstream versus owner-channel
availability. Inspect the exact installation and original owner-operation records
before further work. The failure itself authorizes no speculative rollback,
cleanup or replacement.

### Windows receipt-owned stable PE handover

The direct-owner source path uses an explicit local `<installation>\bin\liftoff.exe`
and `<installation>\liftoff-receipt.json`. An arbitrary external launcher
directory or guessed receipt location cannot acquire this ownership. Selecting
this owner remains a distinct reviewed installation migration; it is not a
workaround for blocked WinGet ownership or delivery.
Once private direct ownership is proved, its inspection and upgrade do not
consult the unavailable default WinGet catalog observer. Explicitly supplied
owner observations still reject contradictory ownership records.

The staged signed PE must implement the receipt-bin launcher ABI. Its bytes are
copied unchanged: no script shim, binary overlay, runtime download, or helper
detachment is involved. The launcher selects only the receipt's confined
`versions\<version>-<provenance>` payload, checks the selected build identities,
and requires every stable PE byte to equal that payload's launcher.

When the new release contains the **identical** PE, the sealed installation
transaction verifies and retains that image rather than rewriting a running
executable. The receipt activates the separately staged payload; success still
requires private receipt authority, complete signed payload/resource admission,
exact-path execution and ordinary command-resolution readback. An earlier
process continues using its retained old payload until it settles. No version
directory is automatically cleaned.

When the PE differs, those new bytes must actually replace the stable executable.
If Windows file sharing or permissions prevent replacement, the operation stays
failed/pending and retains its attributable journal, operation record and
payloads. Close the affected stable-launcher instances, then use
`installation migrate --recover` for read-only inspection. Where the exact
receipt-owned payload is still independently observable, inspection supplies a
literal **versioned** `bin\liftoff.exe upgrade` continuation with its working
directory, also exposed through JSON `nextActions`. Use that exact executable
and `cwd`, not the locked stable launcher or a replacement from `PATH`.
That command does not hold the stable PE open and performs the
normal bounded replacement or guarded original-transaction recovery. It needs
no new approval flag, never overwrites manually, and cannot bypass another
remaining file lock or host policy.

Lost authority, unconfirmed process settlement, changed owner bytes, or failed
readback remain non-successful; original evidence is preserved. A committed
receipt/launcher transaction with incomplete readback is not reported as a
rolled-back or untouched installation. Receipt and PE writes are not a
cross-process atomic transaction: concurrent launches can observe an incomplete
handover and fail closed rather than execute a mismatched selection.

Portable filesystem/ABI tests and x64/arm64 PE cross-compilation are source
evidence only. Actual Windows image-lock behavior, enterprise policy, concurrent
launches, cancellation/settlement and minimum-host readback still require native
qualification. The Go launcher is outside V8 coverage.

## 4. One-Time Legacy npm-to-Native Handover

If your workstation currently runs Liftoff installed via npm (`@msn-control/liftoff`), `liftoff upgrade` will explain that historical npm versions cannot discover or install native releases. Use the dedicated installation migration journey:

Run this journey with an independently verified native CLI, not the historical
`liftoff` found through `PATH`. The absolute paths below are placeholders for an
already verified native candidate; a path or a downloaded archive alone does not
establish trust. The unpublished development bundle does not acquire migration
authority from these examples.

### Step 1: Inspect Current Installation (Non-Mutating)

```bash
"/absolute/path/to/verified-native/bin/liftoff" installation inspect
```

The corresponding PowerShell invocation uses the actual verified PE:

```powershell
& 'C:\absolute\verified-native\bin\liftoff.exe' installation inspect
```

This inspects the running executable, package owner (npm, Homebrew cask, WinGet, or direct), prefix, and any conflicting launchers in `PATH`. It makes no file writes or network changes.

When run with `--json`, output conforms to the schema-1 public inspection envelope:
```json
{
  "schemaVersion": 1,
  "command": "installation",
  "mode": "inspect",
  "status": "migration-required",
  "inspection": { ... }
}
```

### Step 2: Plan the Migration

Preview the migration plan before authorizing any effects:

```bash
# On macOS (Homebrew Cask)
"/absolute/path/to/verified-native/bin/liftoff" installation migrate --to homebrew-cask --check

# On Linux (Direct Install)
"/absolute/path/to/verified-native/bin/liftoff" installation migrate \
  --to direct --candidate "/absolute/path/to/verified-native" \
  --destination "/absolute/reviewed/native-install" \
  --launcher "/absolute/reviewed/bin/liftoff" --check
```

```powershell
# On Windows (WinGet)
& 'C:\absolute\verified-native\bin\liftoff.exe' installation migrate --to winget --check
```

Manager-owned destinations must come from actual owner observations; these
examples do not supply a guessed Homebrew or WinGet installation root.

The output displays an immutable schema-1 migration plan (`mode: "migration-preview"`), including:
- Legacy npm package, version, and prefix.
- Target owner, package, candidate, destination, and launcher paths.
- Ordered effects:
  1. `verify-unlinked-candidate`: Verify registered final bytes, host, resources, runtime, and candidate startup while unlinked.
  2. `stage-target`: Checkpoint and stage the exact native payload at the plan-bound location without changing the active launcher; direct and manager-owned layouts retain their distinct path meanings.
  3. `retire-legacy-package`: Explicit one-time retirement of the exact verified legacy Liftoff npm package and its observed launchers.
  4. `install-target-owner`: Install or activate the target native package through the selected owner.
  5. `verify-target-installation`: Independently verify the final owner, explicit launcher, resources, and normal command resolution.
- Plan SHA-256 fingerprint.
- Exact legacy recovery command.
- The required working directory and typed installation `nextActions`.

### Read the Scoped Continuation

Preview and read-only recovery output can include schema-1 structured
continuations in `nextActions`.
The migration continuation names the admitted candidate's absolute `executable`,
literal `args`, and required `cwd`. Its `scope` and `targetScope` are
`installation`; `userInstallTarget` is the selected destination, not a project.
`compatibilityIdentity` is the exact plan fingerprint, and `requiredAuthority`
contains `exact-installation-plan`.

Use the provided `displayCommand` in the reported working directory, or preserve
the exact `executable`, argument vector, and `cwd` in an authorized automation
runner. Do not replace it with bare `liftoff`, change the candidate/destination/
launcher paths, or carry a fingerprint into a different plan. A continuation
describes the required authority; merely receiving it does not grant approval.

### Step 3: Apply the Migration

In an interactive terminal, normal migration with the same verified executable
and target paths, without `--json`, `--check`, or `--approve-plan`, prompts via
`stderr` with a strict default of **No**. For explicitly authorized
non-interactive execution, use the emitted
continuation: it includes the exact `--to`, `--candidate`, `--destination`,
`--launcher`, and `--approve-plan` fingerprint values. Human output labels its
required working directory; JSON retains the same bindings in `nextActions`.

Without `--approve-plan <fingerprint>`, `--json` emits a `migration-preview`
envelope. Approved execution emits the schema-1 `migration-apply` envelope with
its durable `record` and `nextActions`.

After verified completion, the next action is inspection through the explicit
installed launcher, with its required `cwd`. It does not invent a project update
or authorize changes to project state.

### Step 4: Interruption and Recovery

If migration is interrupted or fails at any step, inspect the read-only recovery state:

```bash
"/absolute/path/to/verified-native/bin/liftoff" installation migrate --recover --json
```

Recovery re-observes machine facts, inspects the durable schema-1 migration record, reports honest partial outcomes, and can propose a fresh exact normal-migration retry plan with its approval fingerprint. It never blindly rolls back across package managers.

For manager-owned handovers, an independently verified unlinked candidate remains
distinct from a cask already installed at the recorded destination. If retirement
and installation happened before interruption, recovery re-admits that exact
installed payload and manager record. The newly approved plan verifies the
existing replacement instead of repeating npm removal or manager installation,
including when a settled manager process returned failure after installing.
Changed payloads, sources, destinations, launchers, or unconfirmed process
settlement remain blockers; the original record is preserved.

Before any legacy removal, manager destinations and both manager/direct launcher
conflicts are checked even outside `PATH`, then bound to the reviewed operation
and checked again before retirement. Replacement readback executes the actual confined owner
launcher and the normally resolved launcher, not just the payload entrypoint.
A zero manager exit, working payload, or another installation printing the
target version cannot manufacture successful cutover. These paths have isolated
filesystem/subprocess regression coverage, not actual Homebrew/WinGet or signed
release qualification; the WinGet observation blocker above still applies.

Failed apply output contains no executable retry. Read-only recovery must first
perform fresh admission before it can offer a separately approved normal
migration through `nextActions`; use that new plan's fingerprint and exact paths.
Do not append targeting or approval flags to `--recover`. Recovery in the original
private user/home context can remain nonexecuting guidance when authority or
observations are unavailable. Empty `nextActions` is not permission to synthesize
a retry, restore a legacy launcher, or bypass a retained lock.

### Project Safety Guarantee

Installation migration changes only the identified legacy CLI installation, the
approved native payload and launcher, and their private installation records.
Existing projects retain their exact manifests, lockfiles, application
dependencies, framework files, Git history, activation history, state, and
unfinished update or repair records. Neither handover nor installation recovery
migrates project metadata or resolves a project's outstanding transactions.

Project assessment and managed update remain separate operations. Follow the
[existing-project guide](existing-repositories.md) without reinitializing the
project or treating installation approval as permission to change its files.
