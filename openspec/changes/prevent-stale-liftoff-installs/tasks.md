## 1. Offline CLI Version Reporting

- [x] 1.1 Add global `liftoff --version` parsing and output using the existing package-derived `liftoffVersion`, while preserving the CLI's long-option-only behavior.
- [x] 1.2 Include the running Liftoff version in general help without changing command-specific help or introducing network access.
- [x] 1.3 Add argument and command tests for `--version`, no-command help, normal help, unsupported short options, and execution outside a generated project.
- [x] 1.4 Extend the isolated package smoke test to invoke the installed `--version` path and assert that it matches the packed package version on portable installed paths.

## 2. Global Doctor Freshness Diagnostics

- [x] 2.1 Add an always-present CLI doctor layer that reports the local version outside and inside generated projects while retaining existing environment, project, runtime, and cloud layer selection.
- [x] 2.2 Move the bounded authoritative-registry freshness lookup into the CLI layer, preserve silent offline degradation, and keep `LIFTOFF_REGISTRY` as an explicit test or operator override.
- [x] 2.3 Emit an exact-version warning and approved-registry remedy when canonical npm is newer, including the explicit canonical command where direct public access is permitted, without reading or mutating `.npmrc`.
- [x] 2.4 Add text and JSON doctor tests for current, newer, stale-mirror, unreachable-registry, outside-project, and inside-project cases, including assertions that warnings do not change exit codes or write files.

## 3. Canonical Post-Publish Verification

- [x] 3.1 Add a Node.js published-package verifier that reads name and expected version from root `package.json`, accepts the selected dist-tag, and uses `https://registry.npmjs.org` explicitly.
- [x] 3.2 Implement bounded registry-propagation retries with expected-versus-observed failure output, then install the selected dist-tag into isolated temporary home, cache, and global-prefix directories.
- [x] 3.3 Resolve installed metadata and entrypoints with cross-platform path APIs, assert the installed version, and run installed `help`, `--version`, and a representative standard-project plan before cleanup.
- [x] 3.4 Add deterministic tests for successful verification, dist-tag mismatch, installed-version mismatch, command failure, timeout, and temporary-directory cleanup without depending on live npm.
- [x] 3.5 Add a package script for published verification and invoke it after `npm publish` only for non-dry-run release workflow executions, passing the workflow-selected `latest` or `next` tag.
- [x] 3.6 Confirm the release workflow remains failed after any post-publish mismatch and documents recovery through a corrected dist-tag or patch release rather than unpublishing.

## 4. Installation And Release Documentation

- [x] 4.1 Update the README installation flow to identify canonical npm, show the policy-qualified explicit registry command, require `liftoff --version` after installation, and explain managed-mirror preflight and escalation.
- [x] 4.2 Update security and contributor release guidance to distinguish canonical publication success from managed-mirror readiness and to withhold internal installation guidance while an approved mirror is stale.
- [x] 4.3 Document the non-destructive pre-0.3 npm deprecation policy, release-owner procedure, warning text, and verification that historical tarballs remain available.
- [x] 4.4 Add documentation or contract tests that keep install, version-verification, canonical-registry, and stale-mirror guidance aligned with the CLI and workflow behavior.

## 5. Release Operations And Final Verification

- [x] 5.1 Have an authorized npm release owner deprecate `@msn-control/liftoff@<0.3.0` with current-stable upgrade guidance, then confirm explicit historical versions remain downloadable.
- [ ] 5.2 Have the managed-mirror owner synchronize or approve Liftoff 0.3.3, then verify both `@latest` and explicit `@0.3.3` metadata plus a clean install resolve to 0.3.3 before internal onboarding resumes.
- [x] 5.3 Run the focused argument, command, doctor, release-verifier, and documentation tests, followed by `npm run check` and `npm run smoke:package`.
- [x] 5.4 Run the published verifier against canonical npm's immutable 0.3.3 release in explicit non-publishing compatibility mode, confirm installed metadata is 0.3.3 and help plus standard-project planning execute, and confirm release workflow invocation remains strict.
- [ ] 5.5 Confirm the existing Linux, macOS, and Windows CI matrix passes the cross-platform global-prefix, entrypoint, temporary-path, and cleanup coverage.
- [x] 5.6 Run OpenSpec validation for `prevent-stale-liftoff-installs` and resolve every artifact or delta-spec error before implementation is considered complete.