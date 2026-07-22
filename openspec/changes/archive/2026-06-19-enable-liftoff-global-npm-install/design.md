## Context

Liftoff is implemented as the standalone `@msn-control/liftoff` package. It already compiles to `dist`, exposes a `liftoff` binary in package metadata, and passes the root package check. A local `npm pack --dry-run --json` includes the compiled CLI entrypoint and README, but the package is not currently available from the public npm registry.

Existing OpenSpec language intentionally stopped at future npm packaging. This change moves distribution from future intent to a supported release contract: developers can install the latest stable CLI with `npm install -g @msn-control/liftoff@latest` and then run `liftoff` from their shell.

## Goals / Non-Goals

**Goals:**

- Publish Liftoff as the public npm package `@msn-control/liftoff` with the `liftoff` binary.
- Verify publishable package contents before release, including compiled `dist` assets, package metadata, README content, and executable CLI entrypoint.
- Add release automation that runs checks before publishing and supports npm trusted publishing or token-based publishing.
- Add install smoke coverage that proves a packed or published package can provide the `liftoff` command outside the repository workspace.
- Update documentation so global npm installation is the first-run path for users, while workspace commands remain developer-oriented.

**Non-Goals:**

- Changing Liftoff scaffold behavior, supported patterns, provider behavior, or generated project output.
- Publishing any package other than Liftoff.
- Implementing an auto-updater inside the Liftoff CLI.
- Guaranteeing local prerequisites for generated projects beyond existing `liftoff doctor` diagnostics.

## Decisions

### Publish only the standalone Liftoff package

Release automation publishes only the Liftoff package at the repository root. This keeps the public distribution aligned to the implemented CLI surface.

Alternatives considered:
- Publish the root package: rejected because the root is a workspace orchestrator and not the CLI package.
- Use the `@mission-control` package scope: rejected because the npm scope is unavailable for this project.

### Build before packaging rather than tracking `dist`

The repository continues to treat `dist` as build output. Release automation must run the Liftoff build before package inspection and publish, then verify the packed file list explicitly.

Alternatives considered:
- Commit compiled `dist` assets: simpler publishing from a checkout, but creates noisy generated-file churn and risks source/output drift.
- Compile on the user's machine after install: rejected because global installation should not require TypeScript or repository development dependencies.

### Use an isolated install smoke test

Package verification should install the packed tarball into an isolated npm prefix or temporary project and execute the resolved `liftoff` binary from that location. This catches missing files, broken shebangs, workspace-only assumptions, and executable permission problems.

Alternatives considered:
- Only run `node dist/cli.js`: too close to the source tree and does not verify npm bin linking.
- Only inspect `npm pack --dry-run`: useful but insufficient because it does not prove the installed binary runs.

### Prefer trusted publishing with token fallback

The release workflow should support npm trusted publishing with provenance when repository and npm organization settings allow it. A documented `NPM_TOKEN` fallback is acceptable if trusted publishing is not configured yet.

Alternatives considered:
- Manual local `npm publish`: fast once, but weak auditability and easy to skip validation.
- CI token only with no provenance path: workable, but less aligned with modern npm supply-chain expectations.

### Keep docs split between users and contributors

Root and Liftoff README content should lead with `npm install -g @msn-control/liftoff@latest` for users. Repository-local `npm run build`, `npm test`, and `npm run check` stay documented as contributor workflows.

Alternatives considered:
- Present `npm run build` as the main setup path: accurate for contributors but wrong for users who just want the framework installed.
- Recommend `npx` as the only path: useful for one-off runs, but the requested supported path is a persistent global CLI install.

## Risks / Trade-offs

- Package scope ownership or npm permissions are not configured -> Mitigation: document required npm organization/package setup and make publish fail clearly before any partial release.
- `latest` can point to an unintended version if publishing is misconfigured -> Mitigation: publish stable releases from tags or manual release dispatch and reserve prerelease dist-tags for non-stable builds.
- Ignored `dist` output could be missing in CI -> Mitigation: release workflow runs the build and verifies packed contents before publish.
- Global install paths differ across macOS, Linux, and Windows -> Mitigation: smoke tests invoke the npm-linked binary from an isolated prefix using Node/npm path resolution rather than hardcoded separators.
- Token-based publishing can expose supply-chain risk -> Mitigation: prefer trusted publishing with provenance and use scoped, automation-only tokens if fallback is required.

## Migration Plan

1. Add npm distribution specs and update the CLI workflow spec to make global npm installation a supported behavior.
2. Add package metadata needed for public npm discovery and publishing.
3. Add package verification scripts or tests for packed contents and isolated CLI execution.
4. Add release automation that builds, tests, packs, smoke-tests, and publishes `@msn-control/liftoff` with public access and provenance where available.
5. Update README installation guidance for users and contributors.
6. Perform the first publish only after npm scope/package ownership is ready, then confirm `npm install -g @msn-control/liftoff@latest` works from a clean environment.

Rollback consists of unpublishing only if npm policy permits and the release is immediately faulty; otherwise publish a corrected patch version and move the `latest` dist-tag back to the last known good version.

## Open Questions

- Will the npm package be published from GitHub trusted publishing, or should the first version use an `NPM_TOKEN` secret?
- Should release publishing be tag-driven, manually dispatched, or both?
- What repository URL should package metadata use once the package is public?