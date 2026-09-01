## 1. Define the OpenSpec template contract

- [x] 1.1 Add explicit OpenSpec 1.11 constants for profile `custom`, delivery `both`, all 12 ordered workflow identifiers, selected-agent skill and command paths, and the two Copilot cloud-agent paths; verify unit tests assert every exact identifier and platform-safe path part
- [x] 1.2 Extend transient CLI options and resolved plans with the independent global-profile authorization and Copilot cloud-agent choice without adding either consent to generated `liftoff.config.json` or the manifest; verify planner and configuration-loader tests cover defaults, overrides, rejection, and backward compatibility

## 2. Add global OpenSpec profile readiness

- [x] 2.1 Implement read-only inspection of `openspec config list --json` through the pinned command runner and compare profile, delivery, and workflow membership independent of order; verify tests cover matching, core, partial, extra, malformed, failed, and timed-out results
- [x] 2.2 Implement the allowlisted profile update sequence for workflows, delivery, and profile followed by a mandatory re-read; verify command-runner tests prove exact arguments, profile-last ordering, unknown-setting preservation, and failure before project writes
- [x] 2.3 Add separate interactive profile-change presentation and confirmation plus noninteractive `--configure-openspec-profile` authorization for `init` and `migrate`; verify tests prove decline, missing authorization, cancellation, and unrelated consent flags leave global configuration and destination trees unchanged
- [x] 2.4 Report an authorized global profile change separately from project staging and later failures without automatic rollback; verify lifecycle tests cover successful configuration followed by an initializer or merge failure

## 3. Add Copilot cloud-agent selection

- [x] 3.1 Add `--copilot-cloud` and `--no-copilot-cloud`, prompt only for OpenSpec plans containing GitHub Copilot, default interactive and `--yes` flows to disabled, and show the resolved choice in plan output; verify argument, planner, interactive, help, and snapshot tests
- [x] 3.2 Reject cloud-agent flags for Spec Kit or plans without GitHub Copilot before probes or writes; verify both positive and negated invalid combinations return concise corrective errors
- [x] 3.3 Pass explicit profile and cloud-agent arguments to the pinned OpenSpec initializer and preserve `githubCopilot.cloudAgent` in API and Power Apps OpenSpec config overlays; verify generated-template tests cover enabled, disabled, Claude-only, and Spec Kit outputs

## 4. Validate complete official framework output

- [x] 4.1 Add initialization-only validation for every expected skill and command file for GitHub Copilot, Claude Code, and their combined selection while retaining minimal persistent markers for existing core-profile projects; verify missing or non-regular output aborts before destination mutation
- [x] 4.2 Validate that enabled cloud setup contains both exact cloud-agent files and disabled setup contains neither, without claiming framework hashes; verify framework ownership and staged-tree tests
- [x] 4.3 Expand the fake framework runner and real OpenSpec smoke coverage to generate all 12 workflows with both delivery modes and both cloud choices using an isolated test config; verify tests never read or modify the developer's real global OpenSpec configuration
- [x] 4.4 Verify a fresh generated project is stable when the pinned OpenSpec initializer is rerun with the same global profile, tools, and cloud choice, and that framework-owned output remains excluded from plain `liftoff update`

## 5. Preserve migration and cross-platform behavior

- [x] 5.1 Route fresh migration targets through the shared profile preparation, cloud-agent choice, initializer, and staged contract validation while keeping the source read-only; verify migration tests cover both agents, opt-in, opt-out, decline, and command failure
- [x] 5.2 Use path-part arrays and `path.join` or `path.resolve` for every generated or validated path and isolate config through environment-aware command execution; verify the targeted test set passes on Windows CI as well as macOS/Linux without separator-specific expectations

## 6. Update public guidance

- [x] 6.1 Update getting-started, CLI reference, prerequisites, spec-workflow, safety and consent, project-structure, existing-repository, and troubleshooting guidance for the all-workflow contract, global scope, dedicated authorization, and default-off cloud files; verify documentation link and content tests
- [x] 6.2 Document that existing projects use `openspec config profile` followed by `openspec update`, while `liftoff update` continues to exclude framework-owned output; verify README and packaged documentation present the distinction consistently

## 7. Complete release verification

- [x] 7.1 Run the targeted planner, interactive, framework adapter, staging, migration, update, help snapshot, lifecycle snapshot, and documentation tests and resolve any contract regressions
- [x] 7.2 Run `npm run build`, the full test suite, package smoke verification, and the supported Windows CI matrix; verify all release gates pass without changing the pinned OpenSpec 1.11.0 baseline
