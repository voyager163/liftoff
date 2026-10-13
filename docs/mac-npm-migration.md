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
npm lifecycle scripts, audit/funding/update
notifications, inherited loaders, Homebrew auto-update/analytics/install cleanup
and environment hints are suppressed. Independent Homebrew approval does not
authorize bootstrapping, tapping a new source, changing permissions or elevating.

One JSON report distinguishes selected npm ownership, exact target/assets,
blockers and effects. Only a ready preview from a separately qualified provider
can yield a review SHA-256. Apply additionally requires:

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

## Partial outcomes and selected recovery

Each external operation has a durable intent and settlement checkpoint. The
mode-0700 independent journal holds verified offline material, a mode-0600
authority key, an authenticated bounded journal and an exclusive owner lock.
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
npx vitest run tests/mac-migration.test.ts tests/mac-migration-package.test.ts
```

Private fixtures exercise manager layouts, space paths, cryptographically bound
synthetic cask assets, preservation, interruptions and selected recovery.
They do not qualify real Homebrew/nvm/Volta hosts, publication, signing,
notarization or minimum-host behavior. The optional installed-package suite
requires `LIFTOFF_MAC_MIGRATION_BUNDLE_ROOT` naming a current verified native
development bundle; an unset variable skips it and establishes no artifact
qualification.
