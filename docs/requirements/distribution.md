# Distribution

How Liftoff itself is packaged, released and installed. Building the bundle
that runs without a global Node is PKG-001 in [repository.md](repository.md).

## DIST-001 One npm package carries every file Liftoff ships

Liftoff is packaged once, as the npm package `@voyager163/liftoff`, and the
native bundles unpack that same package. npm leaves some files out of every
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
  npm package or the bundle and generates a project, then the project has that
  `.gitignore`.
- Given an asset that npm would leave out, when the package is packed, then
  packing fails and names the file.
- Given an untracked, ignored or uncommitted file, such as a `.env` under
  `assets/` or a local `.ts` file under `src/`, when the package is packed,
  then neither it nor anything compiled from it is in the package.
- Given the package installed into an npm prefix, when Liftoff runs from
  outside its checkout, then `--version`, `init` and `validate` work.

npm 12 ships no lockfile in a package, so an npm install gets Liftoff's exact
direct dependencies but resolves theirs afresh. The bundle installs from
Liftoff's lockfile.

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

- the version is `X.Y.Z` or `X.Y.Z-<prerelease>` and is what `package.json`
  says at that commit;
- `ci-gate` succeeded on that exact commit;
- no tag or release of that version exists;
- the `release` environment exists, with a required reviewer, and only `main`
  may use it. GitHub would otherwise create it unprotected.

It packs the npm package once, builds the macOS and Windows bundles from that
tarball, and describes what the bundles install from the lockfile in a
CycloneDX SBOM. (An npm install resolves its own dependencies, so the SBOM is
attested for the bundles only.) It lists every asset's SHA-256 in
`SHA256SUMS`, attests how each was built, and, once it has checked with a
token that can see drafts that no draft of the version exists, makes a draft
prerelease of them at that commit. The draft has no tag and is public only
once promoted. A separate job then downloads the draft's own assets on macOS
and Windows and checks:

- the checksums;
- each attestation, which must come from the Release workflow run on `main`
  at that commit;
- the commit and version in each bundle's `release.json`.

Then it runs Liftoff from the bundle with no Node on the PATH, and from the
npm package, outside any checkout.

- Given a commit whose `ci-gate` failed, or a version `package.json` does not
  have, when a release is started, then nothing is built.
- Given a release environment without a required reviewer, when a release is
  started, then nothing is built.
- Given a built release, when its assets are downloaded, then every asset has
  a checksum and a build attestation from the Release workflow.

Verification: test

## DIST-004 Promotion publishes the verified assets without rebuilding

The Promote workflow publishes a release the Release workflow made, in the
`release` environment. It downloads the release's assets, checks their
checksums and attestations again (from the Release workflow, on `main`, at
the release's commit), and checks that the release may be published as
asked:

- the Release run the release names succeeded, so its verification passed,
  and built `main` at the release's commit, which `main` still contains;
- every bundle was built from that commit;
- a stable release must have every bundle signed for its operating system,
  and its version must not be a prerelease;
- a stable release is never made a prerelease again.

It then publishes the GitHub release, which creates its tag. A stable release
also goes to npm under `latest`, as the very tarball in the release, through
npm trusted publishing with provenance; prereleases stay on GitHub. Running it
again finishes a promotion that stopped part way: npm is left alone when it
already has the same tarball, and refused when it has different bytes.
Nothing is built or packed during promotion.

- Given a release whose bundles are unsigned, when it is promoted as stable,
  then nothing is published.
- Given a draft whose Release run failed its verification, when it is
  promoted, then nothing is published.
- Given a prerelease already published, when it is promoted as stable, then
  it becomes the latest release and its tarball is published to npm.

Verification: test
