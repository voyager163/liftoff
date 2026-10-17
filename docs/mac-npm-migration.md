# Standalone Mac npm migration source

**Not a released migration path.** npm is still the only published Liftoff
channel. This contributor-only Group 11 implementation is independently packaged
and does not require an old `liftoff upgrade` command. Its default executable
dependencies deliberately have **no production cask provider**. Signing,
notarization, exact cask namespace/artifacts, minimum-host execution, deployed
manager readers and separately approved npm bridge publication remain blockers.
Passing isolated fixtures does not enable public migration or complete Group 11.

## Independent development package

Use the existing [native development builder](native-development-bundles.md) to
assemble the current compiled source, official pinned Apple Silicon Node,
locked dependencies, packaged assets and original licensed notices. Then:

```sh
npm run build:migration -- \
  --bundle /absolute/verified-darwin-arm64-development-bundle \
  --output /absolute/new-standalone-migration-directory
/absolute/new-standalone-migration-directory/bin/liftoff-migrate-npm --help
```

Both outputs must be outside the checkout, and the standalone output must not
exist. Packaging reuses the full verified bundle rather than a second CLI or
the old global npm installation. `migration.json` binds the copied runtime,
application, assets, original notices and launcher inventory. It records
`releaseReady: false` and `publicMigrationQualified: false`; it is an unsigned
local development consistency record, not publisher authentication. Do not
distribute it as an approved installer.

The standalone launcher clears Node startup overrides and invokes only its
private `core/runtime/node`. Removing the old npm installation cannot remove
the utility, its runtime or its journal. The old npm `liftoff` bin and public
capability advertisement are unchanged. `macMigrationBridge` is an inert,
unpublished source notice for a later independently approved bridge; it does
not register an executable migration command in old releases.

## Preview and exact approval contract

The following illustrates source syntax, **not a currently executable public
migration**:

```text
liftoff-migrate-npm
  --npm <absolute-selected-npm-cli-or-link>
  --node <absolute-selected-owning-node>
  --prefix <absolute-selected-old-npm-prefix>
  --manager <homebrew-node|nvm|volta|custom>
  [--manager-root <absolute-selected-manager-root>]
  [--manager-executable <absolute-selected-manager-executable>]
  --brew <absolute-independently-approved-existing-brew>
  --recovery <absolute-independent-complete-offline-old-package>
```

Without owner flags, discovery examines at most 64 absolute PATH directories,
not every installed nvm/Volta version. nvm/Volta roots come only from explicitly
selected manager information; custom prefixes can be selected directly.
Multiple or unproven copies require exact selection. Volta shims that cannot
establish an actual npm/Node/package image are not invented owners: select the
real paths and require manager readback, or remain blocked. An npm prefix under
Homebrew is not itself a cask.

Preview verifies native Apple Silicon (not Intel/Rosetta), macOS 13.5 or newer,
the selected old package/version/launcher, npm and Node executable identities,
manager/prefix attribution and independently approved existing Homebrew. Source
checkouts are rejected before manager probing. A qualified injected provider must
also admit the host and bind the exact authenticated native candidate, approved
signer/channel, available cask version and deployed assets through the existing
native admission API. It must prove permissions and collisions for the entire
cask write scope, allowing only the already attributed old launcher, and
revalidate that exact scope before dispatch. Its policy must equal the utility's
own packaged native policy; a provider cannot supply replacement approval.
No version-pinning `brew install` command is invented.

Old scope directories must be canonical, safely permissioned and writable
where effects are intended. Collisions, escaped/hard-linked material, unsafe
permissions and inventories exceeding 8,192 entries, depth 32, 8 MiB per file,
128 MiB total or the 30-second scan bound are blockers, not cleanup invitations.
These limits deliberately refuse unproven installations.

Old package entries and the old launcher must belong to the current user and
primary group. Package and write-scope directories must retain owner
read/write/search permissions; the utility never temporarily widens a read-only
directory to make recovery work. Mixed-group scopes are refused, not silently
reassigned. On macOS, bounded native observations also refuse ACLs, BSD file
flags and unpreservable extended attributes. The OS-added 11-byte
`com.apple.provenance` attribute is not ignored: its exact bytes are hashed into
the reviewed inventory and checked across the independent recovery copy,
journal backup and each restored entry. The launcher must pass an independent
private recreation probe before approval. Different or unobservable provenance
blocks transfer; recovery never strips it to force a match. An attribute observed
as absent must remain absent; neither recovery nor its native fixture assumes
macOS creates provenance on every entry or fabricates an attribute to test it.
File/directory modes,
ownership, metadata and confined links are verified, not inferred from content
hashes alone. New inodes and timestamps are not promised to reproduce the old
filesystem objects; physical identities instead detect concurrent edits.

Offline recovery is a separately supplied **complete package directory**,
including installed dependencies. It must match the old package's complete
content/mode/link inventory and execute the exact old `--version` successfully
with offline npm settings and startup/telemetry overrides disabled. A registry
version string, npm cache entry, future download or successful old upgrade
command is not recovery material. The utility copies and reverifies it in the
private journal before any uninstall. These trusted installed-code probes are
bounded and use neutral working directories, but are **not an OS/network
security sandbox**; untrusted arbitrary package code is not supported.

Preview does not change installations, projects, user configuration or shared
caches. Process working directories, HOME/XDG, temporary files, Homebrew
cache/log paths and npm observation cache/config paths are private temporary
scratch. Only the explicitly selected Volta root is passed to `volta which`.
The caller's default `HOME/.config/liftoff/config.json` and explicit
`XDG_CONFIG_HOME/liftoff/config.json` are outside that scratch scope. Preview,
handover and selected recovery do not record a notice or consent, repair invalid
JSON, normalize whitespace/unknown fields, or change read-only configuration
permissions. Child process environments and the synthetic cask-provider
dispatch context force both `DO_NOT_TRACK=1` and `LIFTOFF_TELEMETRY=0`
independently of caller preferences; the original caller environment is not
modified. These are environment/process guards, not a network sandbox or proof
that arbitrary old installed code cannot send traffic.
Migration subprocesses explicitly disable the shared runner's default parent
environment inheritance, including npm inspection/uninstall, host/manager
probes, metadata reads and native verification. Child-observed regression
cases verify neutral HOME/XDG and both opt-outs without ambient proxy, registry,
unselected Volta or fixture sentinel variables. Other commands retain the
runner's existing default environment merging.
npm lifecycle scripts, audit/funding/update
notifications, inherited loaders, Homebrew auto-update/analytics/install cleanup
and environment hints are suppressed. Independent Homebrew approval does not
authorize bootstrapping, tapping a new source, changing permissions or elevating.

One JSON report distinguishes selected npm ownership, exact target/assets,
blockers and effects. Only a ready preview from a separately qualified provider
can yield a review SHA-256.

When no qualified installer exists, the default dependencies attempt only bounded
canonical read-only cask preparation. Missing policy approvals refuse before
destination or release reads. Its optional `preparation` report keeps
authenticated target, observed destination and unverified local source bytes
separate from an unknown channel and `exact_cask_execution_unproven` with a null
command. Both preview and apply remain blocked, with no migration review digest,
journal or npm removal. A preparation identity is not an apply approval.
Recovery still requires its separately qualified provider; preparation or an
observed absent destination cannot authorize restoration.

Discovery examines at most 64 explicit PATH directories, never manager trees.
A visible npm or Liftoff launcher whose npm/Node pair cannot be proved is an
`unproven-path-owner`, not an absent installation. Select the complete old owner
explicitly rather than allowing another discovered copy to hide that ambiguity.

Apply additionally requires:

```text
<the identical reviewed owner, brew and recovery arguments>
--apply <exact-current-preview-sha256>
--journal <new-independent-private-directory>
```

No boolean `--apply`, implicit yes, stdin approval or mutable `latest` selector
is accepted. Inputs are re-observed, including immediately before uninstall and
cask dispatch. Uninstall invokes **only the selected Node and npm executable**
with the selected global prefix, `--ignore-scripts`, and the literal
`@msn-control/liftoff` package. Only an unchanged, attributable old residual
launcher may be removed. All cask dispatch goes through the exact candidate/
channel-bound, abortable provider port with a settlement result; there is no
unqualified fallback command.
Cask observations have a 10-second elapsed deadline and installation dispatch
has a 120-second deadline. A late response is refused even if the timeout
callback could not run first. A late installation result retains the partial
journal, lock and scratch rather than authorizing cleanup or restoration.
The utility package/runtime and selected Node, npm, manager and Homebrew
executables must remain outside the old uninstall scope. Overlapping tool
selections are refused rather than deleting the tools needed for handover or
recovery.

## Partial outcomes and selected recovery

Each external operation has a durable intent and settlement checkpoint. The
mode-0700 independent journal holds verified offline material, a mode-0600
authority key, an authenticated bounded journal and an exclusive owner lock.
The 4 MiB limit covers the complete authenticated envelope. Before uninstall,
preflight also reserves full recovery-ledger growth; an insufficient journal
budget blocks migration without increasing the limit. Rejected saves preserve
the prior durable bytes, digest and unresolved-operation state.
It does not borrow Linux receipt recovery authority.

Unknown npm/cask settlement, concurrent edits, changed lock/key or failed final
verification retain the partial journal and block forward cleanup. Unknown
settlement also retains the lock and reported observation scratch; process
death alone does not prove subprocess settlement. Do not delete or rewrite a
journal/lock to force progress.

Recovery requires the report's exact journal digest:

```text
liftoff-migrate-npm --recover <exact-journal-sha256>
  --journal <exact-private-journal-directory>
  [--dead-lock <exact-lock-owner-json-sha256>]
```

Dead-lock selection requires positive process absence and does not authorize
an unsettled npm/cask operation. Recovery rechecks tool/policy/Homebrew and
parent identities, offline material and independently observed cask absence.
It exclusively recreates only absent old-package entries and the exact old
launcher, or retains an unchanged attributable dangling old launcher.
Every restored entry has a durable intent and physical-identity ledger.
Unchanged completed entries can resume; an interrupted unacknowledged entry
remains an explicit settlement blocker rather than being adopted from
target-looking bytes. New packages, cask installations, unexpected children
and user changes are never overwritten. Verified old content, launcher and
version are required before reporting `restored`.

To check a previously completed handover or restoration, select its current
authenticated journal explicitly:

```text
liftoff-migrate-npm --inspect <exact-journal-sha256>
  --journal <exact-private-journal-directory>
```

Inspection never acquires or releases a lock, changes journal bytes, uninstalls,
installs, removes residual links or replays restoration. `effects: none` describes
this invocation; `observedPhase` identifies the selected historical checkpoint.
An `installed` result requires fresh native ownership, exact version/assets and
PATH observations, plus continued absence of the selected old package. A settled
cask operation whose final verification was interrupted can be checked without
rewriting its `cask-settled` checkpoint. `restored` requires the complete unchanged
physical-entry ledger, old package/launcher/version and positive cask absence.
An uncertain operation, retained lock, changed manager or edited/replaced state
remains partial; a previous success never substitutes for current verification.
Inspection also requires a qualified provider, not the read-only preparation
API. It cannot clear an unknown settlement or grant new apply/recovery authority.

Liftoff configuration, telemetry preferences, projects, `.liftoff`, Node/npm and
unrelated packages are outside cleanup scope. There is no broad prefix,
nvm/Volta image, cache or configuration sweep. Identity checks detect observed
concurrent drift; they are not adversarial atomic filesystem confinement around
another package manager's own writes.

Final native ownership/version/assets are verified separately from PATH.
`path: unresolved` does not erase a verified cask result. Parent-shell aliases
and command hashes are `not-observable`: inspect `type -a liftoff` and the new
`liftoff --version` in a fresh shell. The utility cannot fix its parent's aliases
or cache. Exit 1 reports a blocker/partial result; exit 2 reports an installed
verified cask with unresolved PATH; help/ready/fully selected completion exits 0.

## Source validation

```sh
npm run build
npx vitest run tests/mac-migration.test.ts tests/mac-migration-safety.test.ts \
  tests/mac-migration-observation.test.ts tests/mac-migration-resume.test.ts \
  tests/mac-migration-preparation.test.ts \
  tests/mac-migration-environment.test.ts tests/process-runner.test.ts \
  tests/mac-migration-npm-installed.test.ts \
  tests/mac-migration-package.test.ts tests/mac-migration-package-report.test.ts \
  tests/mac-migration-journey-report.test.ts \
  tests/repository-policy.test.ts
```

Private fixtures exercise manager layouts, space paths, cryptographically bound
synthetic cask assets, preservation, interruptions and selected recovery.
Config regression cases separately exercise each global opt-out, both actual
config locations, unknown fields/whitespace, invalid JSON, read-only files and
directories, and absent notice/consent state through preview, synthetic handover
and settled-failure recovery. They compare exact private user-state bytes,
modes and file identities, runner argv/cwd/environment and synthetic dispatch
context. Version-printing fixture CLIs do not establish real client
no-transport behavior.
Actual private macOS safety cases add ACLs, extended attributes and file flags
and verify refusal without stripping them; settled recovery checks supported
directory/file modes and exact observed OS provenance. These cases do not
qualify arbitrary metadata, mixed groups or a real Homebrew cask.
Clock-controlled observation cases check the exact elapsed deadline, timely
success and preservation after a late installation result. They use private
process/filesystem fixtures, not real elapsed-wall-time or live-cask proof.
When `npm_execpath` explicitly selects an npm CLI, four additional disposable
prefix cases copy the complete selected npm package and actual Node executable
into fixture-owned private tool directories before uninstalling only the fixture
package. The selected executable bytes are compared with their originals; host
tool-cache directory permissions are neither trusted nor modified. Separate/shared
launcher paths and handover/settled recovery verify
unrelated package bytes and read-only preferences survive. The old client and
cask remain synthetic in those cases; actual npm filesystem settlement is not
real Homebrew, historical-client, minimum-host or no-transport qualification.
They do not qualify real Homebrew/nvm/Volta hosts, publication, signing,
notarization or minimum-host behavior. The optional installed-package suite
requires `LIFTOFF_MAC_MIGRATION_BUNDLE_ROOT` naming a current verified native
development bundle; an unset variable skips it and establishes no artifact
qualification.

The optional `tests/mac-migration-journey.test.ts` suite requires both that bundle
and `LIFTOFF_MAC_MIGRATION_HISTORICAL_TARBALL`. CI downloads the canonical registry
archive for `@msn-control/liftoff@0.3.4` and verifies SHA-256
`05793480c44632b3fc01ac98a4f76a73313d8b273afcb30bde5c22de989d69c0`
before its offline, `--ignore-scripts` installation into a disposable prefix.
This dependency-free historical client actually runs help, rejects its unsupported
`upgrade` command, and creates a legacy project; current native code and its
private runtime are copied unchanged from the development bundle.

For an actual stable-version development bundle, sixteen positive journeys
combine the four manager layouts, each independent global
opt-out, and handover or settled-failure recovery. Fixture construction and the
migration/verification body each have a separate 30-second test bound; production
observation/dispatch deadlines are unchanged. Exact caller tree bytes, modes,
physical identities, Git history, unknown `.liftoff` state, enrolled/copied/
unenrolled records, invalid/read-only config and unrelated tools/packages must
survive. Compiled reporting runs with one global opt-out and a fetch tripwire;
it must neither transport nor create consent for a copied or unenrolled project.
`scripts/mac-migration-journey-report.mjs` requires all sixteen cases to run and
pass against the exact clean-source development bundle; omission/skipping is not
qualification. These use actual npm, historical and compiled clients, but
**synthetic manager, cask admission and settlement evidence**. They do not qualify
digest-bound Homebrew execution, a published channel, signing or minimum hosts,
and the native manifest remains `releaseReady: false`.

CI selects the lane only after verifying the built bundle and its actual package
version, not the checkout's version or a caller-supplied label. A genuine
prerelease such as `0.13.0-dev.0` runs the separately named
`tests/mac-migration-prerelease.test.ts` lane instead: four manager layouts,
each independent global opt-out, and preview or explicit apply. These cases
require the unchanged production stable-release guard to refuse before a review,
journal, npm removal, cask channel/destination checks or installation. The old client, recovery
material, caller state and tools must remain unchanged; compiled prerelease
version/reporting probes do not establish a successful handover.

The stable-positive gate is retained, not skipped or relabelled as a successful
prerelease migration. Reports are distinct:
`mac-migration-stable-handover.json` versus
`mac-migration-prerelease-refusal.json`, each with its own verified outcome
summary. The refusal summary explicitly records `positiveMigrationQualified: false`.
The report verifier rejects a mismatched version, outcome, suite or incomplete
case matrix. An unrun genuine prerelease lane establishes no refusal
qualification, and neither lane establishes public migration readiness.
