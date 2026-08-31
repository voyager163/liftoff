## Context

Canonical npm's immutable `0.3.3` package predates `liftoff --version`. The completed `prevent-stale-liftoff-installs` change added the command to the repository, but root `package.json` and `package-lock.json` still identify the unreleased source as `0.3.3`. Consequently, a local pack can currently contain behavior that differs from the already-published package with the same version.

Liftoff uses dedicated release commits. The release workflow runs checks and packed-install smoke coverage before publishing, selects an npm dist-tag from root package metadata, and verifies the selected package from canonical npm afterward. Tag-triggered runs accept any `v*` tag, but no current precondition proves that the Git tag, package metadata, and lockfile identify the same version. Managed-registry synchronization remains externally owned.

## Goals / Non-Goals

**Goals:**

- Make `0.3.4` the first published Liftoff package that supports `liftoff --version`.
- Keep root package metadata, lockfile metadata, release tag, packed metadata, installed command output, canonical npm, and approved-mirror observations aligned.
- Fail before npm publication when a tag-triggered release has inconsistent source version identity.
- Preserve the existing strict post-publish verification and require managed-registry parity before onboarding through that registry.

**Non-Goals:**

- Modifying, replacing, or unpublishing immutable `0.3.3` or older packages.
- Making `--version` work in packages that were published before `0.3.4`.
- Changing npm configuration, automatically bypassing an approved mirror, or publishing to an external mirror from the public workflow.
- Adding startup network access to `liftoff --version` or any ordinary CLI command.

## Decisions

### D1: Prepare 0.3.4 in a dedicated release commit

Update root `package.json` and both root version fields in `package-lock.json` together as release preparation. The release commit is the source commit tagged `v0.3.4`; no feature implementation is added during the version bump. Existing package smoke coverage must install the resulting pack and observe exactly `Liftoff 0.3.4`.

This keeps the repository's established dedicated-release-commit pattern while ending the temporary state where unreleased behavior shares the published `0.3.3` identity. Bumping only `package.json` was rejected because `npm ci` and package provenance must use coherent lockfile metadata.

### D2: Enforce release identity before publication

Add a small Node.js release-identity verifier that parses root `package.json` and `package-lock.json` as structured JSON. It asserts that the package names and root versions agree. When given a release tag, it constructs the expected tag as `v${packageVersion}` and requires exact equality.

The release workflow runs the verifier before `npm publish`. Tag-triggered runs pass the Git ref name and fail on any mismatch. Manual dry runs validate package and lockfile identity without inventing a release tag. Tests exercise matching versions, package-lock mismatch, and tag mismatch without changing repository files.

A workflow-only shell comparison was rejected because a Node verifier is independently testable and uses the same cross-platform runtime as the project. Inferring a version from commit text was rejected because root package metadata remains the release authority.

### D3: Keep installed output as the package-identity proof

The existing package smoke test remains the pre-publish proof that an isolated installation reports `Liftoff <packed-version>`. The existing strict published-package verifier remains the post-publish proof that canonical npm's selected dist-tag installs the expected package and that its `--version` output matches.

No registry lookup is added to `liftoff --version`: it continues reading package metadata relative to the executable actually selected by the developer's `PATH`. A machine with multiple Liftoff installations therefore observes the version of the invoked installation, not an unrelated npm prefix or remote `latest` value.

### D4: Separate canonical publication from managed-mirror promotion

After canonical `0.3.4` publication succeeds, canonical `@latest`, explicit `@0.3.4`, and a clean canonical installation must all identify `0.3.4`. An approved managed registry is ready for onboarding only after its `@latest` and explicit `@0.3.4` metadata resolve to `0.3.4` and a clean installation through that registry reports `Liftoff 0.3.4`.

Mirror lag does not retroactively fail canonical publication. Internal onboarding remains withheld until mirror parity is proven, and Liftoff neither edits `.npmrc` nor performs automatic fallback.

## Risks / Trade-offs

- [The version bump lands without a release] -> Keep `0.3.4` preparation in a dedicated release commit and tag that exact commit only after CI passes.
- [A mismatched tag reaches the workflow] -> Run the identity verifier before `npm publish` and report both expected and observed values.
- [npm accepts immutable bytes before a later verification fails] -> Preserve strict post-publish failure and recover with a corrected dist-tag or a new patch; do not unpublish routinely.
- [The managed mirror remains stale] -> Treat synchronization as an external promotion gate and keep onboarding blocked without changing developer registry policy.
- [Multiple global installations confuse diagnosis] -> Define `liftoff --version` as the version of the executable selected by `PATH` and use shell path inspection separately when needed.

## Migration Plan

1. Add and test the release-identity verifier and its pre-publish workflow step.
2. Prepare the dedicated `0.3.4` release commit by updating package and lockfile versions together.
3. Run focused release tests, the full package check, packed-install smoke verification, and the cross-platform CI matrix.
4. Tag the exact release commit `v0.3.4`; let the workflow publish and strictly verify canonical npm.
5. Confirm canonical `latest`, explicit metadata, clean installation, and `liftoff --version` all identify `0.3.4`.
6. Have the managed-mirror owner synchronize or approve `0.3.4`, then repeat metadata and clean-install verification through that registry before onboarding resumes.

Before publication, rollback is to remove the release tag and revert the release-preparation commit. After publication, immutable `0.3.4` remains available; recovery uses a corrected dist-tag when possible or a subsequent patch release.

## Open Questions

None. npm publication authorization and managed-mirror synchronization remain explicit release-owner and mirror-owner operations.