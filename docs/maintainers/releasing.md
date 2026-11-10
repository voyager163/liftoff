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
- **macOS signing secrets**, as secrets of the `release` environment, not of
  the repository. Without them every release is unsigned and can only be a
  prerelease. They come from an Apple Developer Program membership:
  - `MACOS_CERTIFICATE_P12`: a Developer ID Application certificate and its
    private key, exported from Keychain Access as a `.p12`, then
    base64-encoded (`base64 -i certificate.p12 | pbcopy`).
  - `MACOS_CERTIFICATE_PASSWORD`: the password the `.p12` was exported with.
  - `APPLE_NOTARY_KEY_P8`: the whole text of an App Store Connect API key
    (Users and Access → Integrations → Team Keys, Developer role).
  - `APPLE_NOTARY_KEY_ID` and `APPLE_NOTARY_ISSUER_ID`: that key's ID and its
    issuer ID.

  Set all five or none: Release fails with only some.
- **The Homebrew tap.** The public repository `voyager163/homebrew-tap`,
  with a `main` branch, and `HOMEBREW_TAP_TOKEN` as a secret of the `release`
  environment: a fine-grained token for that repository only, with contents
  and pull requests read and write. When it expires, replace the secret and
  run Promote again.

Liftoff is not published to npm: its package is private, and the package
tarball is only a release asset that the bundles and the Homebrew formula
are built from.

## Cutting a release

1. **Prepare the release branch.** Set the version in `package.json` on a
   `release/X.Y.Z` branch, merge it into `main` with a merge commit, and wait
   for `ci-gate` to pass on `main`.
2. **Build the draft.** Run the **Release** workflow on `main` with that
   version. It packs the package once, and when you approve the
   `release` environment it builds both bundles from it, signing and
   notarizing the macOS one, and the Windows installer from the Windows
   bundle. It writes checksums and attestations, and makes
   a draft prerelease, titled "(unsigned)" if a bundle is. It then downloads the draft's assets on
   macOS and Windows and checks them.
3. **Publish.** Run the **Promote** workflow with the same version:
   - With `stable` off, the draft is published as a prerelease, on GitHub
     only.
   - With `stable` on, it becomes the latest release. This is refused unless
     both bundles are signed. A second job, which the `release` environment
     asks you to approve, then opens a pull request on
     `voyager163/homebrew-tap` that changes the cask's version and checksum.
     Review and merge it there.

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

On a Mac, check the macOS bundle's signature and notarization:

```bash
tar -xzf liftoff-package-aarch64-apple-darwin.tar.gz
codesign --verify --strict --verbose=2 liftoff-package-aarch64-apple-darwin/bin/liftoff
codesign --verify --strict --check-notarization -R=notarized --verbose=2 \
  liftoff-package-aarch64-apple-darwin/bin/liftoff
```
