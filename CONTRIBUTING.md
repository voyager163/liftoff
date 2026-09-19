# Contributing to Liftoff

Thank you for helping improve Mission Control Liftoff.

## Development setup

Install the toolchains exercised by the complete suite:

- Node.js 24 LTS at 24.20.0 or newer within that line, and npm 12.x at 12.0.2 or newer.
- Python 3.14.x (tested at 3.14.7) and `uv` 0.12.x at 0.12.7 or newer.
- Go 1.27.
- OpenTofu 1.12.6.

Clone the repository and install locked dependencies:

```bash
git clone https://github.com/voyager163/liftoff.git
cd liftoff
npm ci
```

## Validate a change

Run the smallest focused test while iterating, then the complete package check:

```bash
npx vitest run tests/<focused-file>.test.ts
npm run check
```

The root Vitest configuration limits Windows to two concurrent file workers.
Within the same test invocation, ordered projects run the other root files first,
then the intact `tests/migration-inspection.test.ts` file without competing
filesystem-heavy suites or native builds. Each file belongs to exactly one
group; targeted file selectors still run the selected file. Real revalidation
and fixture construction remain inside the original timed test bodies.
Other platforms retain their existing single-project configuration and Vitest's
worker default. Discovery remains complete, and isolation, assertions, and
timeouts are unchanged, including the migration inspection suite's 90-second
limit. Use these defaults for CI qualification rather than increasing timeouts
or excluding slow cases.

CI runs three full-inventory Vitest shards on **each** of Linux, macOS and
Windows, with at most three shard jobs running concurrently. Sharding happens
before Windows' ordered-project scheduling, so the migration-inspection file
still runs exactly once and after the other files in its shard. No file or
test-name filters narrow these full-suite jobs.

Native framework/preparation and backend-disabled OpenTofu checks, the explicit
Windows boundary lane, per-host launcher Go coverage, telemetry checks, package
smoke and Linux generated containers run in separate source-integration jobs.
The two Node-template lanes and telemetry OpenTofu/container lane remain
separate. Two additional Linux x64/arm64 keystore-helper compile and synthetic
source-behavior checks bring
default source validation to 18 jobs, preserving all 16 existing jobs rather
than increasing timeouts or reducing test scope.
Linux full-suite shards also collect V8 coverage rather than repeating the
entire Linux suite in another job. The [coverage gate](DEVELOPER.md#focused-commands)
merges their actual measurements before checking the two packages independently.

For bounded Windows failure investigation, a manual CI dispatch can explicitly
set `diagnostic_windows_only` to `true`. It runs only the Windows job-runner,
protocol, execution-qualification, repair-workspaces and update-preview suites,
plus the actual Windows toolchain acceptance cases, with one worker and a
20-minute job limit. Verbose logs and separately named JSON artifacts retain
failures and observed Node/npm/Git identities.

For the complete Windows repair/process source boundary, also select
`windows_diagnostic_scope=complete-boundary`:

```bash
gh workflow run ci.yml --ref <source-branch> \
  -f diagnostic_windows_only=true -f windows_diagnostic_scope=complete-boundary
```

The selector defaults to `focused` and applies only when the Windows diagnostic
flag is enabled. Complete-boundary validation conserves every original Windows
boundary selector, including migration revalidation/inspection, and adds the
remaining repair source, workstation identity, preparation-input, continuation
and Windows invocation cases. Three disjoint built-in shards run on separate
Windows hosts, with one worker and the same 20-minute budget each. No file's
cases are filtered or retimed. Each job checks its discovered and completed
file inventory against the exact selected shard and retains source SHA/attempt
bindings. All three jobs and their reports are required for complete-lane source
evidence; one passing shard or the focused lane is not a substitute.

The native toolchain suite uses the actual supported Node/npm executables and
read-only Git, with real Windows process settlement and literal spaced/
metacharacter paths. It exercises mixed-case environment aliases, conflicting
alias refusal, incompatible **copied npm metadata** rejected before execution,
a project shim reached through a real junction, and changed copied Node bytes.
It does not pretend a copied metadata version is a qualified older npm release,
modify installed executables or manufacture Windows results on another OS.
Canonical environment selection rejects conflicting Windows aliases and
removes undefined aliases that could shadow valid variables in a child.
Windows command-environment merging also replaces or clears inherited aliases
case-insensitively, rather than resurrecting ambient values under another case.

Existing separately enabled native-preparation/provider lanes remain separate;
this boundary is not installed-artifact, minimum-host or complete Windows
private-state/custody qualification. Missing native prerequisites or uncertain
settlement remain failures/blockers, never mock success or cleanup permission.
The 18 default jobs and all other diagnostic selections remain unchanged.

For isolated native Go preparation investigation, set
`diagnostic_native_go_only` to `true`. Ubuntu and macOS each run the
`prepares actual Go module/checksum inputs` case with native preparation enabled,
Node 24.20.0, npm 12.0.2, Go 1.27.0, one worker and a 20-minute job limit.
The existing test deadline remains unchanged. Each host retains its diagnostic
JSON artifact under its OS, source SHA and run attempt, including on test failure.

For real cross-process POSIX locking against synthetic `terraform_data` local
state, set `diagnostic_native_posix_locks_only` to `true`. The two Linux lanes use
the [documented public GitHub-hosted runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories)
`ubuntu-24.04` (x64) and `ubuntu-24.04-arm` (arm64), with Node 24.20.0, npm 12.0.2,
Python 3.14.7 and OpenTofu 1.12.6 without its wrapper. Each lane resolves only
the selected Python and OpenTofu executables to canonical absolute paths, enables
`LIFTOFF_POSIX_NATIVE_LOCK_QUALIFICATION=1` and
`LIFTOFF_LINUX_READONLY_PROCESS_TEST=1`, and runs
`tests/state-posix-platform.test.ts` alongside
`tests/state-linux-readonly-process.test.ts` with one worker and a 20-minute job
budget. Existing test and production deadlines are unchanged. The read-only
guard exercises nonsecret fixtures with per-process Landlock restrictions;
its actual assertion outcomes remain in the same retained test JSON report.

Before testing, the lane records each selected regular executable's UID, GID,
mode, device/inode identity and SHA-256 digest. Only when the runner owns the
selected executable and can modify its mode does preparation remove that file's
group/other write bits through its open descriptor. It verifies unchanged
identity, ownership and bytes afterward, preserving all other mode bits.
Already admitted executables are left unchanged. Ownership or permission
denial, changed bytes/identity, links and non-executable inputs produce an
explicit fixture-preparation blocker with retained metadata. This correction
is limited to those ephemeral source-test tools: no sudo, recursive permission
changes, broad toolcache edits, copied Python binary or relaxed production
admission is permitted.

Host metadata records the actual Node and runner architectures and rejects a
platform/architecture mismatch before testing. The host record, tool-preparation
metadata and test JSON report are retained under the runner label, actual
runner architecture, source SHA and run attempt, including on test failure. These are synthetic
local-state lock source runs, not encryption, key-store custody or release
qualification. The native exercise uses no credentials, external providers,
provider downloads or privileged host changes. If the arm64 runner is
unavailable, its result remains pending or missing; an x64 success is not a
substitute and no emulation/fallback is selected.

The keystore-helper build/source checks run on the same documented Linux x64/arm64
labels by default, or separately with `diagnostic_linux_keystore_build_only`.
They use Node 24.20.0/npm 12.0.2 and prepare only declared C11, pkg-config,
GLib/GIO/GObject >=2.74, Meson, Ninja, gettext and libgcrypt development
prerequisites on the ephemeral runner. No keystore daemon package is needed.
Installed prerequisite versions are retained rather than invented pins.

The workflow fetches the exact clean libsecret commit
[`a5cd57f103038c06b64d5f6ebfd0e627bb40af4e`](https://gitlab.gnome.org/GNOME/libsecret/-/tree/a5cd57f103038c06b64d5f6ebfd0e627bb40af4e),
not a release tag, into a new runner-owned directory. Its
[pinned Meson options](https://gitlab.gnome.org/GNOME/libsecret/-/blob/a5cd57f103038c06b64d5f6ebfd0e627bb40af4e/meson_options.txt)
select `crypto=libgcrypt`; documentation, introspection, PAM, TPM2 and automatic
test-service setup are disabled. Libsecret installs into an explicit private
prefix with `--libdir=lib`, and `LIBSECRET_SOURCE_DIR`/`LIBSECRET_PREFIX` are
passed to `native/linux-keystore-client/build.mjs`. System libsecret fallback
and plain/disabled crypto are not alternatives.

The 20-minute jobs first run dependency-free framing/source-interface tests,
then compile the helper. Only after a successful build, they install the
declared synthetic-test dependencies: `dbus-daemon`, `python3`, `python3-dbus`,
`python3-gi` and `gir1.2-glib-2.0`. With
`LIFTOFF_LINUX_KEYSTORE_SYNTHETIC=1` and the same exact `LIBSECRET_SOURCE_DIR`,
the one-worker suite invokes the compiled client against a fresh private
no-autostart D-Bus and an in-memory synthetic service using nonsecret fixture
values. The fixture uses hash-bound unchanged upstream mock modules, fixed
`/usr/bin/python3` and `/usr/bin/dbus-daemon`, and mandatory actual loader/private
dependency checks; no system-libsecret fallback is enabled by CI.

No real GNOME daemon, ordinary desktop/system service, store or keys are
accessed; production enrollment remains disabled. These tests do not provision
encryption or ACLs and perform no cloud operations. Failed builds prevent the
synthetic run. Successful behavior reports must contain the actual opt-in
synthetic suite and no failed or skipped cases, without a fixed case count.

The initial protocol result and final behavior result have distinct JSON paths.
Only bounded allowlisted build/protocol/synthetic summaries and the original
`build-identity.json` are retained under source SHA, actual runner architecture
and run attempt. Raw helper output, protocol bytes, dependency diagnostics,
keys and binaries are not artifact inputs; binaries are not signed or
published. Compile evidence and native compiled-client synthetic behavior are
separate from real-provider, custody, enrollment, installed-artifact and
runtime-closure qualification. Missing prerequisites or either architecture
remain explicit blockers.

All five diagnostic inputs default to `false`. In the table, Windows, Go, POSIX and Build
mean `diagnostic_windows_only`, `diagnostic_native_go_only`,
`diagnostic_native_posix_locks_only` and `diagnostic_linux_keystore_build_only`.
For compatibility, the Build input retains its name but now selects the full
build plus synthetic-source behavior job described above. This table applies
when `diagnostic_linux_gnome_persistence_only` is `false`.

| Windows | Go | POSIX | Build | Jobs executed |
| --- | --- | --- | --- | --- |
| `false` | `false` | `false` | `false` | Complete 18-job source validation, including coverage and helper builds |
| `true` | `false` | `false` | `false` | Windows diagnostics |
| `false` | `true` | `false` | `false` | Ubuntu and macOS native Go diagnostics |
| `true` | `true` | `false` | `false` | Windows and native Go diagnostics |
| `false` | `false` | `true` | `false` | Linux x64 and arm64 POSIX lock diagnostics |
| `true` | `false` | `true` | `false` | Windows and POSIX lock diagnostics |
| `false` | `true` | `true` | `false` | Native Go and POSIX lock diagnostics |
| `true` | `true` | `true` | `false` | All three execution diagnostic lanes |
| `false` | `false` | `false` | `true` | Linux x64 and arm64 helper build/synthetic-source checks |
| `true` | `false` | `false` | `true` | Windows diagnostics and helper builds |
| `false` | `true` | `false` | `true` | Native Go diagnostics and helper builds |
| `true` | `true` | `false` | `true` | Windows/native Go diagnostics and helper builds |
| `false` | `false` | `true` | `true` | POSIX lock diagnostics and helper builds |
| `true` | `false` | `true` | `true` | Windows/POSIX lock diagnostics and helper builds |
| `false` | `true` | `true` | `true` | Native Go/POSIX lock diagnostics and helper builds |
| `true` | `true` | `true` | `true` | All selected diagnostics, including helper builds |

The separate `diagnostic_linux_gnome_persistence_only` option is **manual-only**.
It runs actual pinned GNOME persistence/restart source tests on Linux x64 and
arm64 with generated test passwords/keys, new private buses and disposable
runner-owned stores. It never selects an existing keyring, ordinary
desktop/system service, user credential or cloud resource, and does not change
host disk encryption, ACLs or policy. Normal push/PR/default runs remain at
18 jobs and never enable this native fixture.

| GNOME persistence flag | Other four diagnostic flags | Manual jobs executed |
| --- | --- | --- |
| `false` | Any combination | Exactly the preceding routing table |
| `true` | All `false` | Only the Linux x64/arm64 GNOME persistence jobs |
| `true` | Any selected | GNOME persistence plus exactly those selected diagnostics; no unrelated full jobs/gates |

The lane builds exact clean GNOME commit
[`da00f9621eaf263d5ed4236df9c22798ea8021d2`](https://gitlab.gnome.org/GNOME/gnome-keyring/-/tree/da00f9621eaf263d5ed4236df9c22798ea8021d2),
not an equivalent version/tag or system daemon. Its
[pinned Meson requirements](https://gitlab.gnome.org/GNOME/gnome-keyring/-/blob/da00f9621eaf263d5ed4236df9c22798ea8021d2/meson.build)
include GLib/GIO >=2.80, GCK >=3.3.4, GCR-base >=3.27.90, libgcrypt and p11-kit.
Ubuntu prerequisites add `libgcr-3-dev`, `libp11-kit-dev` and `libglib2.0-bin`
to the established build/private-fixture dependencies. PAM, systemd, SSH-agent,
capabilities, SELinux, debug mode and manpages are disabled. Only the
`gnome-keyring-daemon` target is built and its exact bytes copied into a private
prefix; upstream PAM/autostart/service files are **not installed**.
PKCS#11 configuration and module destinations must match that prefix's
`etc/pkcs11` and `lib/pkcs11` directories; the recorder rejects system defaults.

The same pinned private libsecret/client build, actual loader/dependency checks,
`tests/managed-keystore-key-binding.test.ts` contracts and null-profile source
tests must pass before real
GNOME fixture effects. The Landlock wrapper uses selected CPython 3.14.7, and the coordinator uses the
canonical executable obtained from Node's actual `process.execPath`. Only this
manual lane includes Node in the existing exact-FD preparation. The retained
`gnome-python-preparation.json` now records both runtimes' live pre/post
UID/GID, mode, device/inode, size, mtime and byte digest. Only observed
group/other write bits on a runner-owned file may be removed; inability to
modify safely remains a blocker. No historical Node mode/owner is inferred,
and no sudo, tree permission changes, executable copy/replacement or production
admission bypass is used. Only the native step sets both
`LIFTOFF_GNOME_PERSISTENCE_TEST=1` and `LIFTOFF_LINUX_READONLY_NULL_TEST=1`,
running `tests/state-gnome-persistence.test.ts` alongside
`tests/state-linux-null-process.test.ts`. Both architectures retain one worker,
the 20-minute job budget and unchanged operation/test deadlines.

Completion requires **both** actual opt-in suite titles: the pinned GNOME
persistence suite and `opt-in Linux null-sink profile nonsecret fixtures`.
Neither a missing suite nor failed/skipped applicable cases can pass; there is
no fixed case count. The distinct null-sink profile exercises actual fixed
`/dev/null` character device 1:3 read/write, original strict-profile refusal,
continued store/other-device denial, plan/identity mismatch and cancellation.
The original strict helper/default is not widened, and no device, host ACL or
encryption setting is changed to make tests pass.

Only bounded allowlisted JSON identities, case
outcomes and process/persistence summaries are uploaded. No daemon binary,
keyring, password, key, raw loader/protocol output or private fixture directory
is an artifact input. Uncertain settlement remains explicit and its fixture
scope is preserved rather than claimed cleaned. Reports explicitly state
`hostEncryptionQualification`, provider, cloud and release qualification are
`not-performed`; minimum-host and installed-artifact qualification are also
explicitly `not-performed`. Actual generated-data GNOME/null-profile behavior
is not encrypted-host custody or production enrollment qualification. Missing native hosts, build
dependencies or identity/permission admission remain blockers, not fallbacks.

A diagnostic-only dispatch **does not qualify the source or release**, even if
it is green. Any selected diagnostic flag excludes unrelated full-validation
jobs and gates; helper builds run during diagnostic dispatch only if their own
flag is selected. Multiple flags run all selected diagnostics rather than
skipping everything or enabling qualification gates. Push and pull-request events always
retain the complete source workflow regardless of diagnostic input values.

Before a change is release-ready, also verify the packed artifact:

```bash
npm run smoke:package
npm run verify:standard-node-templates
npm run verify:generated-containers
npm run check:supported-stack
```

Changes to the telemetry gateway, container, or Azure service also require:

```bash
npm ci --prefix services/telemetry-ingest
npm run check --prefix services/telemetry-ingest
npm run package --prefix services/telemetry-ingest
npm run smoke:container --prefix services/telemetry-ingest
tofu -chdir=infrastructure/opentofu/telemetry init -backend=false
tofu -chdir=infrastructure/opentofu/telemetry validate
```

The container smoke test requires a running Docker daemon. Standard hosted CI
performs these static and local checks but never plans or applies production.

Generated container verification uses public npm and PyPI defaults; a particular
device, employer, or Docker installation does not by itself require a proxy.
Only when an explicit organizational policy requires another approved registry,
pass its credential-free URL through command-local `npm_config_registry` or
`UV_DEFAULT_INDEX`. Review any registry-host rewriting or remote redirect
requirements for that specific feed instead of enabling broad overrides by
default. Do not persist verification overrides globally or commit workstation
registry preferences.

The package smoke test builds, runs `npm pack`, checks the explicit package
surface and the approved 20 MiB unpacked-size budget, installs the tarball into
an isolated prefix, and executes the installed CLI, native-owner upgrade help
and effect-free unsupported-ownership refusal without selecting the host global
prefix. This private archive is source-test transport, not an npm release or
migration bridge; the budget does not change native-release requirements.
Only the two explicitly packaged infrastructure READMEs are allowed, not
deployment files or state. The standard template verifier generates a Node.js
backend with its Vue frontend, runs both locked installs, builds both projects,
and runs the generated backend tests without permitting package metadata
changes.

Filesystem and manifest changes must remain portable across Windows, macOS,
and Linux. Use Node.js path utilities rather than hardcoded separators, and
preserve append-only manifest logical names and catalog identifiers unless a
reviewed specification change explicitly retires an identifier and its derived
artifacts. The approved 0.11.0 exception retires exactly eight flat-root OpenTofu
IDs from new output; [the explicit inventory](docs/azure-deployment.md#explicit-flat-root-identity-retirement)
retains old project provenance and never authorizes state moves or force conversion.
Keep other identifiers stable.

Terminal presentation changes must preserve the rich, compact, plain,
`NO_COLOR`, JSON, version, and stdout/stderr contracts. Update focused renderer
and complete-screen snapshots under `tests/__snapshots__/`, review every
changed screen intentionally, and keep raw installer or dependency output
outside Liftoff-owned borders.

## Documentation

Public user guides are plain Markdown under `docs/`; the root README remains a
short landing page. Static README assets live under `docs/assets/`. No
documentation generator is required.

Release-owned compatibility, deterministic setup version vectors, bump rules,
graph integrity, credential leak tests, cross-agent equivalence, native release
qualification, and historical npm recovery live in [DEVELOPER.md](DEVELOPER.md).

When editing documentation:

```bash
npx vitest run tests/documentation.test.ts
npm pack --dry-run --json
```

Keep root README links relative and package every linked local document and
asset. Move contributor-only build, packaging, release, and recovery detail
here rather than duplicating it in end-user onboarding.
The README must stay below 135 lines. Keep the acceptance headings and links in
the developer guide; update actual canonical implementation paths after an
extraction, not only compatibility-facade names. Documentation tests derive
activation identity and graph-hash expectations from current source.

## Audit packaged template dependencies

Liftoff ships npm lockfiles for the standard Node.js backend and standard frontend.
Run their live canonical-registry audit
separately from the root package audit:

```bash
npm run audit:template-dependencies
```

The command is read-only: it must not install dependencies, create
`node_modules`, or modify package metadata. The `Template dependency audit`
workflow runs the same command weekly and through manual dispatch. Ordinary
pull-request CI uses committed fixtures so new registry advisories or registry
outages do not make unrelated test runs nondeterministic.

The command defaults to canonical npm. If an explicit organizational policy
requires an approved mirror, select its credential-free URL with the command-local
`LIFTOFF_NPM_AUDIT_REGISTRY` override. Do not infer a registry restriction from the
workstation or persist a machine-specific preference in project documentation.

GitHub-hosted workflows leave this override unset and continue to audit against
`https://registry.npmjs.org`.

The explicit inventory and audit engine live under `scripts/`.
`security/template-dependency-exceptions.json` records findings that have been
reviewed but cannot yet be removed safely. Each exception is scoped to one
advisory, package, exact manifest path, and complete dependency-chain set. It requires
technical evidence, mitigation, an owner, and bounded review dates:

- high and critical findings expire within 30 days;
- moderate and lower findings expire within 90 days.

Do not renew an exception automatically. Reconfirm the vulnerable API remains
unreachable, update its evidence and upstream reference, then set a new review
window. Remove stale exceptions immediately after a dependency refresh.

Refresh Liftoff-owned standard lockfiles on Linux x64. Resolve with Node.js 24
and pinned npm 12.0.2, then verify the final lockfile with the supported
npm 10.9.4 and npm 12.0.2 compatibility lanes. Update the narrow
manifest range first, then run from the affected asset directory:

```bash
npm install --package-lock-only --ignore-scripts --no-audit --no-fund --omit-lockfile-registry-resolved
npm ci --ignore-scripts --no-audit --no-fund
```

The standard-template CI matrix repeats the locked install with npm 10.9.4 on
Node.js 22 and npm 12.0.2 on Node.js 24. The older lane checks template/lock
compatibility; it does not lower Liftoff's Node.js 24.20/npm 12 workstation
readiness floors. Prefer the smallest compatible patched
line between reviewed baseline refreshes. Do not use `npm audit fix`, downgrade a
dependency to hide an advisory, or add an unverified transitive override.
Afterward run the focused security tests, the standard template verifier,
package smoke, and the live audit.

## Refresh the supported stack

`assets/supported-stack.json` is the release-owned source of truth for tested
runtimes, framework CLIs, direct dependency sets, provider locks, immutable
container images, and packaged asset identity.

```bash
npm run check:supported-stack-freshness
# Update manifests, locks, source compatibility, and immutable digests.
npm run refresh:supported-stack
npm run check:supported-stack
```

Freshness checks are advisory inputs to a reviewed change; they never rewrite
the repository. Resolve candidates only from the canonical sources recorded in
the baseline, materialize candidate manifests and locks in temporary
directories, reject prereleases, and select Node's newest supported LTS rather
than Current. Promote a candidate only after every affected install, build,
lint, test, container, OpenTofu, security, and cross-platform check passes.
Python lock refreshes use `uv lock` and Function requirements are exported from
the same GenAI lock. Do not hand-edit generated lockfiles.

When the newest stable candidate is incompatible, record the selected version,
the exact reviewed candidate, and the technical reason in the baseline rather
than silently pinning an older release. Retired Power Apps fixtures are
non-generative and do not participate in dependency or starter refresh.

### Reconcile Dependabot updates

`develop` is the default integration branch, so Dependabot version and security
pull requests follow it without a separate `target-branch` override. The four
Liftoff-owned npm graphs group routine minor and patch version updates per
directory; majors remain individually reviewable.

The root, telemetry, and standard Node backend graphs ignore only
`@types/node` semantic-major version updates while Node 24 is the supported LTS.
Remove or revise that rule as part of the reviewed Node runtime-major migration,
not in an isolated dependency pull request. Patch and minor type updates,
security alerts, and majors for other dependencies remain enabled.

Do not add retired Power Apps fixtures to `.github/dependabot.yml` or restore
an operational source-commit compatibility lane for that retired workload.

Dependabot changes to a baseline-managed manifest or lock must be incorporated
into one coherent supported-stack refresh. Regenerate locks from their manifests
with the documented Node/npm lanes, update `assets/supported-stack.json`, and
validate every affected graph before closing the superseded bot pull requests.

## Maintain the repository-governance profile

The complete supplied standard is stored at
`assets/governance/single-maintainer-gitflow/policy.md`. Generated policy
metadata and the activation protocol are rendered by
`src/repository-governance.ts`; canonical identity and pure activation rules live
under `src/domain/governance/`. Current activation uses contract/state/header/
approval v2 and compatibility metadata v3, while policy remains 6 and manifest
remains 7. Keep policy schema/version, required invariant
fragments, workload context adapters, exact artifact paths, logical names,
manifest v7 activation identity, compatibility metadata, and Copilot/Claude
`/liftoff-setup` integrations synchronized. Retired generated setup aliases are
migration-only and may be removed by forced update; do not present them as usable
commands. See [DEVELOPER.md](DEVELOPER.md) before changing version axes.

Policy or activation changes require focused repository-governance, governance
activation, credential, manifest migration, update adoption/opt-out, framework
ownership, documentation-link, package-surface, graph/hash, seed strict
validation, and cross-agent setup equivalence tests. Never add a broad `.github`
or `.claude` ownership pattern, an active framework change, user-owned
activation state/evidence/approvals/credentials, or supersession records to
Liftoff-managed artifacts.

## Propose behavior changes

Liftoff uses OpenSpec for product behavior and compatibility contracts.
Observable behavior changes should include an OpenSpec change under
`openspec/changes/` and update every affected capability specification.

Before completing an OpenSpec implementation:

```bash
openspec validate <change-name> --strict
```

## Pull requests

- Keep changes focused and include tests for changed behavior.
- Only `main` and `develop` are permanent source branches; temporary feature,
  repair, release, and Dependabot PR branches remain valid while active.
  Branch preservation requires live ref inventory and owner release;
  `assets/qualification/source-preservation.json` records the preservation plan.
- Update user and contributor documentation when commands, generated output,
  or workflows change.
- Confirm generated projects contain no real credentials or unreviewed live
  resource bindings; nonsecret environment defaults must be explicit.
- Source-only qualification is not real native, provider, or dashboard qualification;
  missing credentials, signing, or live infrastructure remain explicit blockers.
- Do not change persisted manifest identity, activation version vectors, graph
  hashes, schema versions, compatibility maps, or stable identifiers without an
  explicit main-spec decision and migration or rejection-remedy tests.
- Include generated-project verification when templates or dependencies
  change.

## Release verification

Historical npm publications used `https://registry.npmjs.org` with npm trusted publishing.
Current candidate 0.13.0 and future distributions cut over to the coordinated native
release workflow (`.github/workflows/release.yml`), validating self-contained bundles,
candidate owner channels (Homebrew cask, WinGet portable, direct archive), and signed
evidence without publishing an npm package or bridge.
These are target channels, not claims of published artifacts, native qualification,
or package-manager availability.

Before tagging, update package and lockfile metadata together and run:

```bash
npm run verify:release-identity
npm run verify:release-identity -- v0.13.0
```

Replace the example tag with the intended release. The Git tag, root package
metadata, root lockfile metadata, native bundle version, and installed
`liftoff --version` output must all identify the same release.
This source check does not replace signed-artifact, native-host, owner-channel,
or separately authorized publication qualification.

When a release raises runtime floors or adopts generated-stack majors, label it
as breaking and direct existing projects to `liftoff update --check` before
managed-core maintenance, not automatic adoption of the new application stack.
Project-owned template/infrastructure changes need separate reviewed migration;
core update never applies them. The release rollback boundary is a source revert
before publication. Project owners recover separately applied template changes
through version control; Liftoff must not silently downgrade their dependencies.

### Historical npm verification

Before the native cutover, releases predating npm self-upgrade required a manual
npm upgrade to a then-published version. That historical bootstrap is not the
current setup path. Even an npm installation whose `upgrade` reports current
cannot discover native-only releases; use the separately approved
[native installation handover](docs/native-installation.md).

The retained verifier selects one exact stable historical version no newer than
`0.12.3`, independently of this checkout's native candidate version:

```bash
npm run verify:published -- 0.12.3
npm run verify:published -- 0.3.3 --allow-legacy-version-command
```

It installs only the selected version from canonical npm into a disposable
prefix, cache, and home, then checks its package identity and supported commands
outside the checkout. The second invocation retains only the immutable `0.3.3`
command exception; no native artifact may use it. Mutable `latest`/`next` tags,
newer versions, and mixed tag/version inputs are rejected.

This is an isolated historical command/identity smoke check, not proof of
original tarball/source provenance or current native qualification. Verify
retained immutable tarball, source, lockfile, and publication evidence separately.
Historical dist-tag claims refer to the tag at publication time; today's tag
need not equal an earlier release and must never represent native availability.

Managed installations retain their configured `@msn-control:registry` before
the default registry. Never bypass a scoped mirror to recover a historical
installation; the explicit canonical verification above is a separate comparison,
not installation authority. All upgrade apply tests use temporary prefixes,
homes, caches, and injected registry responses. Never apply against a developer
or release runner's actual global prefix.

## Release recovery

If native release qualification or publication fails, retain the exact artifact,
source, approval, and per-effect evidence and report the incomplete state. Do not
announce a partial stable release, publish an npm bridge, move npm tags, or use
an unsigned or unqualified rebuild as recovery. Reconcile any already-published
native effects through the separately reviewed release procedure.

Historical npm recovery likewise compares the explicit expected version with
the observed package and executable identity. Do not unpublish or replace a
released package as routine recovery. A successful canonical historical check
does not make an external managed mirror ready: withhold internal installation
guidance until that approved mirror exposes the exact historical version and
an isolated mirrored installation reports the expected identity.

Pre-0.3 releases remain available for reproducibility. Updating a registry warning
is separate authorized historical maintenance, not part of current publication:

```bash
npm deprecate '@msn-control/liftoff@<0.3.0' 'Liftoff versions before 0.3.0 are unsupported. Current releases are native-only; see https://github.com/voyager163/liftoff/blob/main/docs/native-installation.md.' --registry=https://registry.npmjs.org
```

Verify that an old explicit version retains both the warning and tarball:

```bash
npm view @msn-control/liftoff@0.2.1 deprecated --registry=https://registry.npmjs.org
npm view @msn-control/liftoff@0.2.1 dist.tarball --registry=https://registry.npmjs.org
```

## License and security

By contributing, you agree that your contribution is licensed under
GPL-3.0-only.

Report security vulnerabilities through the private process in
[SECURITY.md](SECURITY.md), not a public issue.
