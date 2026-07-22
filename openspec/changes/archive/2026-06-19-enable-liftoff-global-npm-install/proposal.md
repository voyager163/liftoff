## Why

Developers should be able to install Liftoff as a real CLI tool with one npm command instead of cloning the source repository or building the package locally. The current specs and package metadata make Liftoff suitable for future npm packaging, but the package is not yet published or verified as a globally installable distribution.

## What Changes

- Make `npm install -g @msn-control/liftoff@latest` the supported install path for the latest stable Liftoff CLI.
- Add release and package verification requirements so the published npm package contains compiled CLI assets and exposes the `liftoff` binary without requiring repository source files.
- Update user-facing documentation to present the global npm install flow before repository-local development commands.
- Add CI/release checks that build, test, inspect, and smoke-test the package before publishing.

## Capabilities

### New Capabilities

- `liftoff-npm-distribution`: Covers npm package publication, global installation, published package contents, release verification, and post-install CLI availability.

### Modified Capabilities

- `liftoff-cli-workflow`: The CLI is no longer only suitable for future npm packaging; it must be installable as the `liftoff` command from the published `@msn-control/liftoff` npm package.

## Impact

- Affects Liftoff package metadata in root `package.json`.
- Affects release automation under `.github/workflows`.
- Affects root and package README installation guidance.
- Adds package smoke-test coverage for npm-packed or globally installed CLI behavior.
- Requires npm registry ownership or trusted publishing configuration for the `@msn-control/liftoff` package.