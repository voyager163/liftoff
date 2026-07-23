## Why

Canonical npm publishes Liftoff 0.3.3 correctly, but a managed npm mirror can continue resolving `@latest` to 0.2.1, allowing a successful install to leave developers on a CLI that lacks current project flows. Liftoff needs an enforceable canonical-registry postcondition, obvious installed-version reporting, and guidance that distinguishes a stale mirror from a failed release.

## What Changes

- Verify every published stable release against `registry.npmjs.org`: the canonical `latest` dist-tag and a clean isolated `@latest` installation must resolve to the package version being released and execute representative CLI commands.
- Treat a failed post-publish verification as a failed release workflow so maintainers do not announce a release whose canonical package cannot be installed as expected.
- Add a conventional, offline `liftoff --version` surface and include the running version in general CLI help and package smoke coverage.
- Run CLI freshness diagnostics even outside generated projects and provide an exact-version, registry-aware remedy when canonical npm is newer than the running CLI.
- Document canonical npm as the release source of truth, require post-install version verification, explain that managed mirrors must synchronize independently, and avoid changing developer npm configuration automatically.
- Define a non-destructive deprecation policy for unsupported pre-0.3 releases while retaining their tarballs for reproducibility.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `liftoff-npm-distribution`: Require canonical-registry post-publish verification, documented managed-mirror behavior, post-install version verification, and non-destructive deprecation of unsupported release lines.
- `liftoff-cli-workflow`: Expose the running Liftoff version through a conventional global CLI option and general help.
- `liftoff-project-doctor`: Report CLI version freshness without requiring a generated project and provide actionable guidance when the authoritative release is newer than the running binary.

## Impact

- Affects release automation under `.github/workflows`, package smoke and release-verification scripts, CLI argument/help handling, doctor output, tests, and installation/security documentation.
- Adds network access only to explicit doctor freshness checks and post-publish release verification; ordinary create, plan, update, and migration commands remain offline and deterministic.
- Does not publish to external mirrors, mutate `.npmrc`, self-update the CLI, or unpublish historical package versions. Managed mirror synchronization and approval remain owned by the mirror operator.