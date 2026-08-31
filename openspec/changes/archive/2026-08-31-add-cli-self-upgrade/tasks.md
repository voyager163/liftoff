## 1. Shared Release And Result Model

- [x] 1.1 Reconcile this change after `refresh-supported-stack-baselines` so Node.js, npm, canonical package identity, and stable-channel constants have one source, and verify no stale duplicate version literal remains in upgrade planning.
- [x] 1.2 Add typed `check` and `apply` modes plus `current`, `update-available`, `upgraded`, `blocked`, and `failed` result states, and verify exhaustive TypeScript handling covers every state and exit code.
- [x] 1.3 Extract the bounded canonical stable-release lookup shared with doctor, validate package name and stable semver, and verify unit tests cover current, newer, older, prerelease, malformed, HTTP failure, and timeout responses.
- [x] 1.4 Add stable reason codes and a schema-v1 JSON result shape with optional fields only where applicable, and verify serialization contains no undefined values or unapproved fields.

## 2. Neutral Npm Context And Installation Discovery

- [x] 2.1 Add a temporary neutral working context for npm discovery and execution that preserves user/global/environment configuration but excludes repository-local `.npmrc`, and verify a fixture project `.npmrc` cannot change the observed registry.
- [x] 2.2 Query and validate the effective npm registry without writing configuration, reduce it to a non-sensitive canonical/configured classification, and verify credential-bearing URLs never appear in results or errors.
- [x] 2.3 Query npm's effective global package root and canonicalize it with platform-native path handling, and verify fixtures cover Unix, Windows, spaces, unreadable paths, and missing npm.
- [x] 2.4 Resolve the running Liftoff package root and require the exact scoped package location beneath npm's global root, and verify valid global installs are accepted.
- [x] 2.5 Refuse local `node_modules`, npm execution-cache or `npx`, linked checkout, unsupported package-manager, ambiguous-root, wrong-package, and symlink-escape origins, and verify each case exits before network or install calls.
- [x] 2.6 Produce an exact manual global npm remedy for unsupported origins without exposing paths or registry credentials, and verify human and JSON failures remain redacted.

## 3. Registry Parity And Read-Only Check Mode

- [x] 3.1 Verify the configured registry exposes the exact canonical target rather than trusting its `latest` tag, and verify canonical and parity-mirror fixtures proceed.
- [x] 3.2 Block stale, missing, malformed, credential-leaking, or unavailable configured registries without canonical bypass, and verify the result identifies mirror synchronization or infrastructure failure appropriately.
- [x] 3.3 Implement the no-op current-version path and verify `liftoff upgrade` and `liftoff upgrade --check` both exit 0 without invoking npm install.
- [x] 3.4 Implement `liftoff upgrade --check` for an installable newer target and verify it reports `update-available`, exits 2, and performs no filesystem or package mutation.
- [x] 3.5 Refuse automatic downgrade and prerelease targets and verify both exit 1 without invoking installation.
- [x] 3.6 Add read-only tests that snapshot the global prefix, npm configuration, cache fixture, current directory, and representative project tree before and after check mode and verify no bytes changed.

## 4. CLI Surface And Presentation

- [x] 4.1 Add the top-level `upgrade` maintenance command with only `--check`, `--json`, and help options, and verify command parsing rejects positional arguments and unrelated flags before discovery.
- [x] 4.2 Route upgrade through command execution without project discovery and verify it succeeds in a directory with no manifest and never calls project filesystem helpers.
- [x] 4.3 Add command-specific help and general help lifecycle entries that distinguish CLI upgrade from project update, and verify help snapshots contain both roles without an alias.
- [x] 4.4 Add responsive human stages for installation discovery, stable target, registry parity, npm execution, replacement verification, current status, completion, and remedies, and verify rich, compact, plain, redirected, and no-color snapshots.
- [x] 4.5 Add byte-pure JSON routing for check and apply results, and verify stdout contains exactly one parseable object while diagnostics and progress remain on stderr.
- [x] 4.6 Map exit codes to current/upgraded `0`, update-available check `2`, and invalid/blocked/failed `1`, and verify human and JSON modes return identical codes.

## 5. Imperative Upgrade And Replacement Verification

- [x] 5.1 Build the exact global npm installation as an executable plus argument array using the canonical package and exact target, and verify it uses no shell, floating tag, lifecycle scripts, audit, funding prompt, registry override, or elevation command.
- [x] 5.2 Run apply mode from the neutral directory with a bounded install timeout and inherited approved npm authentication, and verify human mode streams child output without masking status.
- [x] 5.3 Route child progress to stderr in JSON mode and verify successful and failed npm fixtures leave stdout byte-pure.
- [x] 5.4 Treat spawn errors, timeout, signal, and nonzero npm status as failures and verify no later diagnostic step can produce an upgraded completion.
- [x] 5.5 Re-resolve the npm global root after installation and verify the installed package name, exact version, and declared `liftoff` binary path are valid and confined.
- [x] 5.6 Execute the replacement binary through the current Node executable with telemetry disabled and verify it prints exactly `Liftoff <target-version>`.
- [x] 5.7 Report success only after metadata and binary verification, and verify completion identifies the target and labels `liftoff update --check` as unexecuted follow-up guidance.
- [x] 5.8 Handle npm-success/wrong-version, missing package, malformed bin, escaping bin, non-regular bin, and version-command mismatch as verification failures, and verify each prints an exact reinstall remedy without automatic rollback.
- [x] 5.9 Add isolated-prefix integration tests for a successful complete package replacement and verify the host's real npm prefix and installed Liftoff package remain unchanged.

## 6. Doctor And Telemetry Integration

- [x] 6.1 Update doctor to use the shared stable-release lookup and recommend `liftoff upgrade --check`, `liftoff upgrade`, and the manual fallback while remaining read-only, and verify current, newer, stale-mirror, and offline doctor tests.
- [x] 6.2 Preserve doctor project-drift guidance as `liftoff update` rather than `upgrade`, and verify a project with scaffold drift presents both CLI freshness and project update remedies distinctly.
- [x] 6.3 Add `upgrade` to client, gateway, storage, validation, and infrastructure telemetry allowlists, and verify contract tests accept only the canonical command value.
- [x] 6.4 Ensure telemetry emits at most one parent `upgrade` event with the invoked CLI version and existing zero/nonzero outcome mapping, and verify no mode, target, registry, origin, path, or error detail enters the payload.
- [x] 6.5 Disable telemetry and disclosure in the replacement-version verification subprocess, and verify successful apply does not emit a second event or mutate telemetry notice state.

## 7. Distribution, Documentation, And Cross-Platform Validation

- [x] 7.1 Extend packed-package and isolated global-install smoke tests so upgrade help and injected check behavior run outside the repository, and verify every required runtime module is included in `npm pack`.
- [x] 7.2 Add release verification coverage that uses only temporary prefixes, homes, caches, and mocked or injected registry targets, and verify no test can select the runner's actual global prefix for apply.
- [x] 7.3 Update README, getting started, CLI reference, prerequisites, maintenance, troubleshooting, telemetry, safety, and release migration guidance, and verify documentation clearly separates first install, CLI upgrade, and project update.
- [x] 7.4 Document canonical target selection, configured mirror parity, stale-mirror remediation, unsupported local or `npx` origins, no elevation, no automatic rollback, JSON fields, and exit codes, and verify documentation tests cover each contract.
- [x] 7.5 Document the one-time manual npm upgrade required for versions predating `liftoff upgrade`, and verify release guidance gives an exact canonical command.
- [x] 7.6 Add Windows tests for npm executable adaptation, global-root containment, case comparison, spaces, drive and UNC paths, symlinks, and replacement binary execution, and verify they run in the Windows CI lane.
- [x] 7.7 Run targeted argument, command, registry, semver, process-runner, terminal, telemetry, doctor, package-smoke, and documentation tests, and verify all affected suites pass without touching a real global installation.
- [x] 7.8 Run the full root and telemetry checks plus strict OpenSpec validation, and verify `add-cli-self-upgrade` remains apply-ready after all implementation-driven artifact updates.
