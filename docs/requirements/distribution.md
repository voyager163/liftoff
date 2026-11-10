# Distribution

How Liftoff itself is packaged, released and installed. Building the bundle
that runs without a global Node is PKG-001 in [repository.md](repository.md).

## DIST-001 One package carries every file Liftoff ships

Liftoff is packaged once, as an npm-format package tarball,
`voyager163-liftoff-X.Y.Z.tgz`, and the native bundles and the Homebrew
formula unpack that same package. It is a release asset, never published to
the npm registry: npm is not one of Liftoff's channels, and `package.json`
is marked private so npm refuses to publish it. npm leaves some files out of every
package, `.gitignore` among them, so assets keep each `.gitignore` as
`_gitignore`, and Liftoff reads it under its real name. The package is made
from the commit, never the working tree: its sources, assets and build
configuration are taken from Git and compiled apart, and it records that
commit as `gitHead`. It checks
that the package holds exactly the files Git tracks under `assets/` and
`.github/liftoff/`, the built files, `package.json`, `LICENSE` and
`README.md`. A bundle is built only from a package of the same name, version
and commit as its checkout, and installs from that commit's lockfile.

- Given a template with a `.gitignore`, when Liftoff is installed from the
  package or the bundle and generates a project, then the project has that
  `.gitignore`.
- Given an asset that npm would leave out, when the package is packed, then
  packing fails and names the file.
- Given an untracked, ignored or uncommitted file, such as a `.env` under
  `assets/` or a local `.ts` file under `src/`, when the package is packed,
  then neither it nor anything compiled from it is in the package.
- Given the package installed into a scratch npm prefix, when Liftoff runs from
  outside its checkout, then `--version`, `init` and `validate` work.

npm 12 ships no lockfile in a package, so installing the package (as the
Homebrew formula does) gets Liftoff's exact direct dependencies but resolves
theirs afresh. The bundle installs from Liftoff's lockfile.

Verification: test

## DIST-002 Each bundle says what it is

Every bundle has a `release.json` (`liftoff.release/v1`) with the version,
the platform target, the Node.js version, the source commit and tree, and the
signing identity for each operating system, which is `null` while unsigned.
Nothing in it names a channel: the same artifact serves every channel, and
which channel installed a copy is read from that channel's own records.

- Given a bundle built from a commit, when its `release.json` is read, then
  its commit and tree are that commit's and its version is the package's.
- Given a bundle built without signing, when its `release.json` is read,
  then both signing identities are `null`.

Verification: test

## DIST-003 A release is built once, from a checked commit, into a draft

The Release workflow runs only when someone starts it on `main` with a
version. Before anything is built it refuses unless:

- the version is `X.Y.Z` or `X.Y.Z-<prerelease>`, as SemVer 2.0.0 allows
  (no leading zeros), and is what `package.json` says at that commit;
- `ci-gate` succeeded on that exact commit;
- no tag or release of that version exists;
- the `release` environment exists, with a required reviewer, and only `main`
  may use it. GitHub would otherwise create it unprotected.

It packs the package once, builds the macOS and Windows bundles from that
tarball, and describes what the bundles install from the lockfile in a
CycloneDX SBOM. (Installing the package resolves its own dependencies, so the SBOM is
attested for the bundles only.) It lists every asset's SHA-256 in
`SHA256SUMS`, attests how each was built, and, once it has checked with a
token that can see drafts that no draft of the version exists, makes a draft
prerelease of them at that commit. The draft has no tag and is public only
once promoted. A separate job then downloads the draft's own assets on macOS
and Windows and checks:

- the checksums;
- each attestation, which must come from the Release workflow run on `main`
  at that commit;
- that the draft holds exactly the six assets it made;
- the commit and version in each bundle's `release.json`.

Then it runs Liftoff from the bundle with no Node on the PATH, and from the
package, outside any checkout. Only the steps that call GitHub get the
workflow's token, so nothing installed or run there can reach it.

- Given a commit whose `ci-gate` failed, or a version `package.json` does not
  have, when a release is started, then nothing is built.
- Given a release environment without a required reviewer, when a release is
  started, then nothing is built.
- Given a built release, when its assets are downloaded, then every asset has
  a checksum and a build attestation from the Release workflow.

Verification: test

## DIST-004 Promotion publishes the verified assets without rebuilding

The Promote workflow publishes a release the Release workflow made, in the
`release` environment, which a job of its own first checks still has a
required reviewer and allows only `main`. It downloads the release's assets, checks their
checksums and attestations again (from the Release workflow, on `main`, at
the release's commit), and checks that the release may be published as
asked:

- the Release run that built the assets, as their signed provenance says,
  succeeded, so its verification passed,
  and built `main` at the release's commit, which `main` still contains;
- every bundle was built from that commit, and a tag of the version, if one
  exists, points at it;
- the release holds exactly the assets Release made, and `SHA256SUMS` lists
  exactly the others, so nothing added to the draft is published;
- a stable release must have every bundle signed for its operating system,
  and its version must not be a prerelease;
- a stable release is never made a prerelease again, and a version never
  becomes the latest stable release while a newer one is published.

It then publishes the GitHub release, which creates its tag. Nothing is
built, packed or published anywhere else during promotion; npm in
particular never receives the package. Running it again finishes a
promotion that stopped part way. A stable release then updates the Homebrew
tap (CHAN-003).

- Given a release whose bundles are unsigned, when it is promoted as stable,
  then nothing is published.
- Given a draft whose Release run failed its verification, when it is
  promoted, then nothing is published.
- Given a prerelease already published, when it is promoted as stable, then
  it becomes the latest release, and nothing is published to npm.

Verification: test

## DIST-005 The macOS bundle is signed and notarized

When the `release` environment has the signing secrets, the Release workflow
signs every Mach-O file in the macOS bundle with its Developer ID
Application identity, the hardened runtime and a secure timestamp, and has
Apple's notary service accept a ZIP of the bundle with no issue, warnings
included, and a ticket for every signed file. Only then does `release.json`
name the signer. The certificate is held in a keychain made for that run and
deleted after it, and only the signing step gets the secrets. The executable
is signed with `com.apple.security.cs.allow-jit` and nothing else, the one
entitlement Node needs under the hardened runtime. With none of the secrets
set, the bundle stays unsigned and can be released only as a prerelease,
which the draft's title says; with some but not all, the release fails.

The draft's macOS bundle is checked as a user would download it: every
Mach-O file is signed by the signer `release.json` names, with the hardened
runtime and a timestamp, the executable's entitlements are exactly that one,
Apple has a notarization ticket for it, and Liftoff runs with the quarantine
attribute set. An unsigned prerelease is run without it. A bare executable
cannot be stapled, so Gatekeeper looks the ticket up online.

- Given the five signing secrets, when a release is built, then the macOS
  bundle's `release.json` names the Developer ID identity and Apple has a
  notarization ticket for its executable.
- Given none of the secrets, when a release is built, then the bundle is
  unsigned, the draft's title says so, and it cannot be promoted as stable.
- Given only some of the secrets, when a release is built, then nothing is
  released.
- Given the executable signed with the hardened runtime and without any one
  of its entitlements, on a Mac with System Integrity Protection on, when
  Liftoff starts, then it fails. `scripts/package/check-entitlements.ts`
  shows this; where System Integrity Protection is off, as on some CI
  runners, it checks only that Liftoff starts with them all.

Verification: test

## DIST-006 Windows users install Liftoff with an MSI, for themselves

The Release workflow builds `liftoff-x86_64-pc-windows-msvc.msi` from the
Windows bundle, with the WiX version that `.config/dotnet-tools.json` pins.
It installs the bundle for the current user only, without elevation, in
`%LOCALAPPDATA%\Programs\Liftoff`, and adds its `bin` folder to that user's
`PATH`. Windows records where it is installed, and Add or Remove Programs
offers to remove it but not to change it. Every MSI shares one UpgradeCode,
so installing any newer build, or another build of the same version (as
prereleases of one version are), replaces the installed one; an older
version is refused. Uninstalling removes the files, the `PATH` entry and
everything else it added. A per-machine install is refused.

The MSI's version is the release's `X.Y.Z`, without any prerelease, which
Windows Installer cannot hold, and must be at most 255.255.65535. The draft's
attestations, SBOM and checksums cover the MSI as they cover the bundles, and
the verify job installs it from the draft, runs Liftoff, and uninstalls it.

- Given the MSI, when the runner's own user installs it, then Liftoff is in
  `%LOCALAPPDATA%\Programs\Liftoff`, Windows records it there for that
  user, and a new terminal finds `liftoff` on the user's `PATH`.
- Given an installed Liftoff, when another build of the same version or a
  newer one is installed, then one Liftoff is installed, at the new version,
  in the same place.
- Given an installed Liftoff, when an older version is installed, then it is
  refused and the installed one stays.
- Given an installed Liftoff, when it is uninstalled, then nothing it added
  is left: no files, no `PATH` entry, no registry key.
- Given the MSI, when it is installed with `ALLUSERS=1`, then nothing is
  installed.

`scripts/package/check-msi.ts` shows this on Windows CI.

Verification: test

## CHAN-001 Mac users install the signed bundle with a Homebrew cask

Until Liftoff is accepted into Homebrew itself, the cask `liftoff` in the
tap `voyager163/homebrew-tap` installs the macOS bundle from the GitHub
release, `liftoff-package-aarch64-apple-darwin.tar.gz`, at the checksum the
release's attested `SHA256SUMS` lists, and links its `bin/liftoff`. It needs
Apple Silicon and macOS 15 (Sequoia) or later, finds new versions from the
latest GitHub release, and has no preflight or postflight steps. This tap is
Liftoff's own distribution, not inclusion in Homebrew. Liftoff keeps nothing
of its own outside the Caskroom, so the cask has nothing to zap.
`distribution/homebrew/liftoff.rb` is its source; `scripts/release/homebrew.ts`
fills in the version and checksum.

- Given the cask rendered for a release, when `brew style` and
  `brew audit --strict` check it in a tap, then they find nothing.
- Given the cask and this commit's bundle, when it is installed from a local
  tap, then `liftoff` on Homebrew's `PATH` is this version, generates and
  validates a project, and `liftoff upgrade --verify` verifies the cask's
  record and `PATH`, whether or not GitHub has a newer release; when it is
  uninstalled, nothing of it is left on that `PATH`.

The `homebrew` job in CI shows this on macOS.

Verification: test

## CHAN-002 A formula for homebrew/core is ready to submit

Homebrew's policy is that an open-source command-line tool belongs in
homebrew/core as a formula built from source, so the official submission is a
formula: `distribution/homebrew/core/liftoff.rb` installs the package
tarball attached to the GitHub release, at the checksum the release's
attested `SHA256SUMS` lists, with Homebrew's Node. Its test runs `--version`, `init` and
`validate`. A person submits it, and answers Homebrew's maintainers, once the
repository meets Homebrew's eligibility rules, disclosing the AI assistance
and adding no AI trailers. After it is accepted, Homebrew's own tools may
change it; nothing in Liftoff depends on its exact text.

- Given the formula rendered for a release, when `brew style` and
  `brew audit --strict` check it in a tap, then they find nothing.
- Given the formula and this commit's package, when it is built from
  source in a local tap, then `brew test` passes, `liftoff upgrade --verify`
  reports the formula, and uninstalling it leaves nothing on `PATH`.

Verification: test

## CHAN-003 A stable release updates the tap through a reviewed pull request

After a stable release is published, the Promote workflow opens a pull
request on `voyager163/homebrew-tap` that changes only the cask's `version`
and `sha256` lines, to the release's version and the macOS bundle's checksum
it has just verified. Whatever else the tap's maintainers or Homebrew's tools
changed in the cask stays. It runs as a job of its own in the `release`
environment, so it is approved apart from the release, and only that job has
the tap's token, `HOMEBREW_TAP_TOKEN`. Without the token it fails and says so,
after the release itself is published; running Promote again finishes it.
Prereleases never reach the tap.

- Given a cask at an older version, when the tap is updated, then only its
  version and checksum lines change.
- Given a tap that already has the version with the same checksum, when it is
  updated again, then nothing changes; with another checksum, or a newer
  version, the update fails.
- Given a tap without the cask, when it is updated, then the pull request
  adds the cask rendered from Liftoff's source.

Verification: test

## UPGRADE-001 Liftoff knows which channel installed it from that channel's own records

`liftoff upgrade` finds the running copy, with every link followed, and asks
the channel that would own it, never guessing from a path alone:

- a bundle in Homebrew's Caskroom is the cask that `brew info --installed`
  lists at that version, with its tap;
- a package in Homebrew's Cellar is the formula `brew info --installed`
  lists at that version;
- a Windows bundle is the MSI Windows Installer records with Liftoff's
  UpgradeCode at that location, and it is WinGet's when
  `winget list --id voyager163.liftoff --exact --source winget` lists it.
  WinGet matches what Windows has installed to its packages, so once the
  package is published it lists an MSI installed by hand too. Only WinGet's
  own "no installed package found" means it does not list Liftoff; any
  other failure leaves the channel's offer unknown.

npm is not one of Liftoff's channels, so a copy npm installed is no
channel's, and Liftoff asks npm nothing.

A bundle no channel records was unpacked by hand. A Git checkout, or a copy
no channel records, such as a global npm install or one in a project's own
`node_modules`, is
reported with its location and is never changed.

- Given a copy in the Caskroom that brew lists, when `liftoff upgrade
  --check` runs, then it reports the cask, its tap and its location.
- Given a copy in the Caskroom that brew does not list, when it runs, then
  the channel is unknown.
- Given a Windows bundle Windows Installer records and WinGet does not list,
  when it runs, then the channel is the MSI; when WinGet lists it, WinGet.
- Given a global npm install, when it runs, then the channel is unknown and
  npm is not asked.

`scripts/package/check-msi.ts` shows the MSI case on Windows CI.

Verification: test

## UPGRADE-002 What is released is reported apart from what the channel offers

The latest published release is read from GitHub without credentials, and
what the owning channel would install is read from that channel (`brew
info`, `winget show`), since a channel can lag behind a release.
Only a newer version the channel offers is an upgrade. `--check` changes
nothing and exits 3 when there is one. A channel that cannot say what it
offers is a failure, with what it printed, never "up to date". A release
GitHub cannot be asked about, or none published yet, is reported as such.
WinGet's version is read from the `--versions` table, whose values do not
depend on the language Windows uses.

- Given a release newer than the channel offers, when `--check` runs, then
  it reports both versions and exits 0.
- Given a channel that offers a newer version, when `--check` runs, then it
  exits 3 and names the command that would upgrade.
- Given GitHub cannot be reached, when it runs, then it says so and still
  reports the channel.
- Given `winget show` fails or times out, when `--check`
  runs, then it fails and says why.

Verification: test

## UPGRADE-003 Only the owning channel upgrades Liftoff, and only when asked

The upgrade is that channel's own command for Liftoff alone:
`brew upgrade --cask <tap>/liftoff`, `brew upgrade <formula>`,
or `winget upgrade --id voyager163.liftoff --exact`. Liftoff shows the command and asks before running it;
the default answer is no, and without a terminal it needs `--yes`. It never
switches channel, installs a package manager, upgrades anything else, asks
for administrator rights or changes a project. Homebrew upgrades the
formula with what it depends on, such as Node, when those are out of date,
but not the other formulae that depend on them. Every program it runs, the
channels' and Windows PowerShell, is named by its absolute path and runs in
the home directory, so nothing in the project, such as its own
`powershell.exe`, stands in for it. Stopping Liftoff before the
upgrade starts runs nothing, and stopping it during one stops that too and
is reported as cancelled, since the channel may have changed something.

- Given an upgrade, when the person answers no, then nothing runs.
- Given no terminal and no `--yes`, when `liftoff upgrade` runs, then it
  refuses and runs nothing.
- Given a copy unpacked by hand, a checkout or one no channel records, when
  `liftoff upgrade --yes` runs, then nothing runs.
- Given a channel's upgrade that fails, when it runs, then Liftoff reports
  its exit code.
- Given Liftoff is stopped while it finds the channel, when the channel is
  found, then nothing runs.

Verification: test

## UPGRADE-004 An upgrade is verified, and WinGet's is handed over

After a Homebrew upgrade, the upgraded copy (the `liftoff` Homebrew links)
verifies itself with `liftoff upgrade --verify`: the channel records the
version that is running, which for a formula is the version Homebrew links,
and `liftoff` on `PATH` is that copy. The upgrade succeeds only when that copy
verified itself, through the same channel, at a newer version. WinGet must
replace the running `liftoff.exe`, so Liftoff starts it in a window of its
own and exits, and the person runs `liftoff upgrade --verify` once it
finishes. An MSI records only `X.Y.Z`, so that is what is compared for it.

- Given an upgrade that lands, when the new copy verifies itself, then the
  upgrade succeeds.
- Given a channel that records another version, or a `liftoff` on `PATH`
  that is another copy, when `--verify` runs, then it fails and says which.
- Given the copy that answers after an upgrade cannot verify itself, or is
  another channel's, when the upgrade finishes, then it is not reported as
  done.
- Given a WinGet install, when `liftoff upgrade --yes` runs, then WinGet is
  started on its own and Liftoff asks for `--verify` afterwards.

Verification: test
