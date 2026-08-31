## Context

The release workflow currently builds, tests, packs, and installs a local tarball before publishing `@msn-control/liftoff`. It selects `latest` for stable versions and publishes to `registry.npmjs.org`, but it does not verify the registry state or install the published dist-tag afterward. A clean canonical npm install currently resolves 0.3.3 correctly, while a managed Microsoft mirror exposes only versions through 0.2.1 and rejects explicit 0.3.3 requests.

The CLI reads its package version at runtime, but it has no global `--version` option. Doctor checks canonical npm freshness only inside a generated project and recommends an unqualified `@latest` installation, which can route back through a stale configured mirror. Package version 0.3.3 is immutable, so runtime safeguards added by this change will ship in a later patch; immediate protection for 0.3.3 requires mirror synchronization and release documentation.

The solution must remain cross-platform, keep ordinary CLI commands deterministic and offline, preserve historical package tarballs, and respect managed-registry policies rather than mutating developer npm configuration.

## Goals / Non-Goals

**Goals:**

- Prove after publication that canonical npm's selected dist-tag resolves and clean-installs the version declared by the release commit.
- Make a canonical publication mismatch fail the release workflow visibly before maintainers treat the release as complete.
- Make the running Liftoff version available offline through normal CLI and help surfaces.
- Detect a stale running CLI through doctor even before a project exists and provide a remedy that acknowledges managed mirrors.
- Document canonical npm, managed-mirror synchronization, post-install verification, and unsupported-version deprecation as distinct responsibilities.

**Non-Goals:**

- Publishing Liftoff to, refreshing, or monitoring a specific external mirror from the public repository.
- Rewriting `.npmrc`, bypassing enterprise policy automatically, or adding registry fallback behavior to npm.
- Self-updating Liftoff, performing network checks during ordinary commands, or unpublishing historical versions.
- Changing the already-published bytes of version 0.3.3.

## Decisions

### D1: Verify the published dist-tag from canonical npm

Add a dedicated Node.js post-publish verification script and invoke it after `npm publish` for non-dry-run releases. The script reads the package name and expected version from root `package.json`, receives the selected dist-tag, and uses the explicit canonical registry URL `https://registry.npmjs.org` for every metadata and installation operation.

The verifier waits for canonical registry propagation within a bounded deadline, then asserts that the selected dist-tag reports the expected version. It installs `<package>@<dist-tag>` into a fresh temporary global prefix with isolated home and cache directories, reads the installed package metadata through `path.join`, and verifies the installed version. It then runs the installed entrypoint for `help`, `--version`, and one representative standard-project plan. Temporary paths and executable resolution reuse the cross-platform approach from the existing package smoke test.

Release workflow invocation is always strict. An explicit non-publishing compatibility flag may skip only the `--version` command when manually verifying immutable 0.3.3, which predates that command; installed package metadata remains the authoritative version assertion and help plus the standard-project plan still execute. The compatibility flag is not used by release automation or accepted as evidence for future publications.

A mismatch cannot undo an immutable npm publication, so it fails the release workflow and blocks a successful release signal or announcement. Recovery is to correct the dist-tag when the expected package exists, or publish a corrected patch when the package itself is wrong. The existing local-tarball smoke test remains the pre-publish gate.

Alternatives considered:

- Rely only on `npm publish --tag latest`: this does not prove the observable registry postcondition.
- Install the exact version after publish: this proves availability but not that `@latest` selects it.
- Verify external mirrors in the public workflow: this couples the public release authority to services it does not control.

### D2: Keep managed-mirror readiness outside the public release authority

Canonical npm remains the source of truth. Public documentation will distinguish a canonical install from an install through a configured managed registry. A managed-registry path must first confirm that the registry exposes the current supported version; if it does not, developers are directed to the mirror operator rather than allowed to interpret an older successful install as current. The canonical-registry command may be used only where organizational policy permits.

Liftoff will not inspect or modify npm configuration and will not silently retry another registry. Internal release promotion may gate on an approved mirror separately, but that gate does not belong in this public repository.

### D3: Expose the running version without network access

Support `liftoff --version` as a global long option, consistent with Liftoff's long-option-only parser, and print `Liftoff <version>` using the existing `liftoffVersion` value. General help includes the same version. Version output performs no registry lookup and exits successfully outside a project.

The package smoke test exercises the installed `--version` path and asserts that it matches the packed package version. A short `-v` alias is not introduced because the CLI intentionally rejects short options.

### D4: Add an always-present CLI doctor layer

Doctor adds a read-only CLI layer in every context. It always reports the running version and uses the existing short-timeout canonical lookup to compare against the published stable version. `LIFTOFF_REGISTRY` remains an explicit test or operator override; doctor does not infer npm configuration from `.npmrc`.

When canonical npm is newer, doctor emits a warning containing the exact newer version. Its remedy tells the developer to use an approved registry that exposes that version and identifies the explicit canonical npm command for environments where direct public access is allowed. Network failure continues to suppress only the freshness result; the local version remains visible and doctor does not fail.

This check stays opt-in through `liftoff doctor`; create, plan, update, migrate, and helper commands do not gain startup network calls.

### D5: Deprecate unsupported releases without removing them

Declare the pre-0.3 release line unsupported and apply npm deprecation metadata with an upgrade message directing developers to the current `latest` release. Keep the tarballs published so lockfiles, provenance, and historical project reproduction continue to work. Deprecation is a one-time authenticated release-owner operation and is documented as part of release maintenance.

Deprecation warns explicit old-version installs after a registry synchronizes, but it cannot repair a mirror that still serves stale metadata. Mirror synchronization or version policy remains the immediate control for developers whose configured registry exposes only 0.2.1.

### D6: Make install verification part of the documented workflow

Installation documentation identifies canonical npm as the authoritative release registry, shows `liftoff --version` immediately after install, and describes the expected version check for managed registries. Security guidance points users to the current supported release line without claiming that every intermediary mirror is current.

The documentation does not pin 0.3.3 permanently. Release automation verifies the version from `package.json`, while user-facing instructions continue to follow the current stable dist-tag and make the resolved version observable.

## Risks / Trade-offs

- [Canonical registry propagation is not instantaneous] -> Use a bounded retry window before failing post-publish verification and report expected versus observed versions.
- [A post-publish failure occurs after npm has accepted immutable bytes] -> Keep the workflow failed, withhold release completion, and recover through a corrected dist-tag or patch release rather than unpublishing.
- [Direct canonical npm instructions can conflict with enterprise policy] -> Present them as the public source-of-truth path and require managed environments to use an approved synchronized registry.
- [Existing 0.2.1 clients cannot gain new version diagnostics] -> Synchronize managed mirrors, add npm deprecation metadata, and require post-install verification in documentation.
- [A mirror may never synchronize automatically] -> Treat mirror approval and readiness as an external operational gate, not a condition the public repository can satisfy.

## Migration Plan

1. Add the CLI version surface, doctor layer, tests, post-publish verifier, and documentation without changing published 0.3.3 bytes.
2. Validate the verifier against canonical npm in explicit 0.3.3 compatibility mode and retain the existing cross-platform local-package smoke gate; keep release workflow invocation strict.
3. Through an authenticated release owner, deprecate the unsupported pre-0.3 versions without unpublishing them.
4. Require the managed mirror used by developers to expose the current stable version before internal installation guidance is announced.
5. Ship the runtime and workflow safeguards in the next patch release; rollback consists of removing the new workflow step or diagnostics in a subsequent patch while leaving historical packages intact.

## Open Questions

None for repository implementation. Ownership and synchronization timing for `packagefeedproxy.microsoft.io` remain an external operational follow-up.