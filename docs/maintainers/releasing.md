# Releasing Liftoff

How a maintainer releases Liftoff itself. Requirements DIST-003 and DIST-004
in [distribution.md](../requirements/distribution.md) say what each step
guarantees.

## Before the first release

Set these up once in the repository's settings:

- **The `release` environment.** Under Settings → Environments, create
  `release`. Add yourself as a required reviewer. Under deployment branches,
  choose selected branches and add `main` only. The Release workflow refuses
  to run without these.
- **Immutable releases.** Turn them on, so a published release's assets and
  tag cannot be changed.
- **npm trusted publishing**, set up shortly before the first stable
  promotion: within the two days before it, since npm expires a trusted
  publisher that has not published within two days of being created. On
  npmjs.com, configure it for `@voyager163/liftoff` with this repository and
  the workflow file `promote.yml`. No npm token is stored. If it expires,
  delete and create it again, then run Promote again; it publishes only what
  npm is missing.

## Cutting a release

1. **Prepare the release branch.** Set the version in `package.json` on a
   `release/X.Y.Z` branch, merge it into `main` with a merge commit, and wait
   for `ci-gate` to pass on `main`.
2. **Build the draft.** Run the **Release** workflow on `main` with that
   version. It packs the npm package once and builds both bundles from it. It
   writes checksums and attestations, and makes a draft prerelease when you
   approve the `release` environment. It then downloads the draft's assets on
   macOS and Windows and checks them.
3. **Publish.** Run the **Promote** workflow with the same version:
   - With `stable` off, the draft is published as a prerelease, on GitHub
     only.
   - With `stable` on, it becomes the latest release, and its tarball is
     published to npm. This is refused unless both bundles are signed.

   Either way, Promote checks the assets again first and rebuilds nothing.
   Running it again finishes a promotion that stopped part way.
4. **Sync `develop`.** Merge `main` back into `develop` through a
   `sync/main-into-develop` pull request.

Promote publishes only a draft whose Release run succeeded, verification
included; it finds that run in the assets' signed provenance, so release notes
can be edited freely. If verification fails, the draft stays unpublished:

- if the failure was flaky, re-run the failed jobs of that run;
- if the commit needs fixing, delete the draft and release again from the
  fixed commit. Release refuses a version that already has a draft.

A mistake in a published release is corrected with a new version, never by
replacing assets or moving a tag. Start one Release at a time: GitHub keeps
only one waiting run per workflow, so a third start replaces the waiting one.

## Checking a release yourself

```bash
gh release download vX.Y.Z --repo voyager163/liftoff --dir liftoff-X.Y.Z
cd liftoff-X.Y.Z && shasum -a 256 -c SHA256SUMS
gh attestation verify liftoff-package-aarch64-apple-darwin.tar.gz --repo voyager163/liftoff \
  --signer-workflow voyager163/liftoff/.github/workflows/release.yml --source-ref refs/heads/main
```
