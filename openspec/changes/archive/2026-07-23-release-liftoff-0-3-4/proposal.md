## Why

The merged `liftoff --version` implementation is not present in the immutable published `0.3.3` package, while the repository still declares version `0.3.3`. Liftoff needs a coherent `0.3.4` release so the first package that accepts `--version` identifies itself as `0.3.4` everywhere developers and release automation observe it.

## What Changes

- Prepare `0.3.4` as the first Liftoff release that supports `liftoff --version`, updating package and lockfile identity together.
- Add a pre-publish release identity gate that requires a tag-triggered release's `v<version>` Git tag to match root package metadata before npm publication.
- Require packed and installed verification to prove that `liftoff --version` reports the exact package version being released.
- Publish and verify `0.3.4` through canonical npm, then require the approved managed mirror to expose and install `0.3.4` before version-command-based onboarding resumes.
- Preserve immutable `0.3.3` and older packages without claiming that they support the new version option.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `liftoff-npm-distribution`: Require release tags, root package metadata, packed package metadata, installed CLI version output, canonical npm, and managed-mirror readiness to identify the same release version.

## Impact

- Affects root `package.json` and `package-lock.json`, release workflow preconditions, package and release workflow tests, release documentation, and authenticated release operations.
- Establishes `0.3.4` as the first published package with the offline `--version` surface delivered by the completed `prevent-stale-liftoff-installs` change.
- Does not change generated project artifacts, ordinary command behavior, npm registry configuration, or historical published package bytes.