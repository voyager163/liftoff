## 1. Release Identity Verification

- [x] 1.1 Add a Node.js release-identity verifier that reads root `package.json` and `package-lock.json` as structured JSON, requires matching package names and root versions, and optionally requires an exact `v<package-version>` release tag.
- [x] 1.2 Emit actionable expected-versus-observed errors for package-name, package-version, lockfile-version, and release-tag mismatches while leaving repository files unchanged.
- [x] 1.3 Add deterministic tests for matching metadata, package-name mismatch, lockfile-version mismatch, matching tag, mismatched tag, and tag-optional dry runs using cross-platform temporary paths.
- [x] 1.4 Expose the verifier through a root package script and document its local dry-run and tag-validation invocations.

## 2. Pre-Publish Workflow Gate

- [x] 2.1 Run release-identity verification before `npm publish`, passing the Git ref name for tag-triggered releases and omitting tag validation for manual dry runs.
- [x] 2.2 Extend release-workflow tests to prove identity verification runs before publication, tag-triggered mismatches block publication, and strict canonical post-publish verification remains after publication.
- [x] 2.3 Update contributor release guidance to require package, lockfile, Git tag, packed metadata, and installed `liftoff --version` output to identify the same release.

## 3. Liftoff 0.3.4 Release Preparation

- [x] 3.1 Update root `package.json` and the root package entries in `package-lock.json` from `0.3.3` to `0.3.4` in a dedicated release-preparation change.
- [x] 3.2 Run focused CLI and package-smoke coverage and confirm an isolated packed installation prints exactly `Liftoff 0.3.4` without registry or project access.
- [x] 3.3 Confirm immutable canonical `0.3.3` remains available and is not represented as supporting `liftoff --version`.

## 4. Repository And Cross-Platform Validation

- [x] 4.1 Run focused release-identity, release-workflow, command, documentation, and published-verifier tests and resolve all failures attributable to this change.
- [x] 4.2 Run `npm run check`, `npm run smoke:package`, and strict OpenSpec validation for `release-liftoff-0-3-4`.
- [x] 4.3 Confirm the Linux, macOS, and Windows CI matrix passes release-identity path handling, package checks, and isolated packed-install smoke verification.

## 5. Canonical Release And Managed-Mirror Promotion

- [x] 5.1 After release-owner authorization and successful CI, tag the exact `0.3.4` release commit as `v0.3.4` and confirm the release workflow publishes and strictly verifies canonical npm.
- [x] 5.2 Confirm canonical npm resolves both `@latest` and explicit `@0.3.4` metadata to `0.3.4`, retains the historical `0.3.3` tarball, and clean-installs a CLI that reports `Liftoff 0.3.4`.
- [ ] 5.3 Have the managed-mirror owner synchronize or approve `0.3.4`, then confirm mirrored `@latest`, explicit `@0.3.4`, and a clean mirrored installation all identify `0.3.4`.
- [x] 5.4 Resume version-command-based onboarding through the managed registry only after task 5.3 passes; otherwise keep onboarding blocked without modifying developer npm configuration.