## 1. Versioned Models and Catalogs

- [x] 1.1 Verify the current published OpenSpec and Spec Kit CLI versions and commands, then add exact tested framework pins, integration identifiers, allowed output roots, and expected markers to centralized catalogs.
- [x] 1.2 Add canonical GitHub Copilot and Claude Code catalog entries, stable agent ordering, alias normalization, multi-selection validation, and Spec Kit default-agent validation.
- [x] 1.3 Extend project options, resolved plans, configuration validation, and plan serialization with selected agents and an applicable default agent while excluding all consent flags from persistent configuration.
- [x] 1.4 Add centralized runtime minimums and verified Homebrew, WinGet, npm, and `uv` recipe metadata for every selected workstation requirement.
- [x] 1.5 Implement manifest schema v3 types and runtime validation for framework contract, selected agents, default agent, and existing durable artifact data.
- [x] 1.6 Update manifest writers to emit v3 deterministically and update readers to accept v2 and v3, normalizing v2 framework state as legacy without fabricated agents.
- [x] 1.7 Update update-plan and configuration compatibility logic so a v2-to-v3 rewrite preserves legacy uncertainty and new v3 plans round-trip selected framework and agent identity.
- [x] 1.8 Extend manifest contract fixtures, invalid-shape tests, deterministic double-render tests, and logical-name snapshots for schema v3.

## 2. Shared Process and Workstation Readiness

- [x] 2.1 Add a typed external-command runner that uses executable and argument arrays without shell interpolation and supports captured probes, streamed installers, timeouts, exit status, and redacted display formatting.
- [x] 2.2 Implement reusable command/version probes and result classification for ready, missing, outdated, unhealthy, and not-observable states.
- [x] 2.3 Implement the declarative requirement registry and deterministic plan-to-requirement graph for Node.js, Python, Go, `uv`, Docker, OpenTofu, Azure CLI, OpenSpec, Spec Kit, Copilot, and Claude Code.
- [x] 2.4 Mark selected runtimes, framework prerequisites, framework CLI, and agent presence as blocking while preserving Docker, OpenTofu, Azure CLI, and authentication health as advisory.
- [x] 2.5 Implement Copilot detection through its CLI or the supported VS Code extension identifiers, including an honest not-observable state when `code` is unavailable.
- [x] 2.6 Implement Claude Code version and doctor probes without automating login or credentials.
- [x] 2.7 Implement host platform and package-manager detection with Homebrew and WinGet automation, Linux distro-specific manual remedies, and no automatic package-manager bootstrap or elevated Linux command.
- [x] 2.8 Implement allowlisted Homebrew, WinGet, npm, and `uv` installers with explicit authorization, streamed results, post-install re-probes, and documented install-location checks.
- [x] 2.9 Add resumable PATH/terminal-restart failures and exact manual remedies when an installer exits successfully but the command remains unavailable.
- [x] 2.10 Add unit tests for requirement selection, version boundaries, probe classification, package identifiers, command argument safety, installer failure, post-install verification, and Linux non-automation.

## 3. Terminal Rendering and Command Metadata

- [x] 3.1 Add the selected small color dependency and a semantic terminal renderer for banners, headings, panels, tables, statuses, commands, warnings, errors, and confirmations.
- [x] 3.2 Add the checked-in Liftoff wordmark and responsive full, compact, and plain layouts based on visible terminal width.
- [x] 3.3 Honor TTY capability, `NO_COLOR`, unsupported color, deterministic snapshot mode, and JSON bypass without emitting ANSI sequences in plain output.
- [x] 3.4 Enrich command and flag definitions with descriptions, metavariables, defaults, grouping, and usage data so parsing and help share one source of truth.
- [x] 3.5 Replace duplicated general and command help rendering while keeping parser errors focused and `--version` one line.
- [x] 3.6 Add terminal snapshots for wide TTY, narrow TTY, no-color, redirected output, command help, errors, version, and JSON cleanliness.

## 4. Git-Aware Targeting and Transactional Merge

- [x] 4.1 Implement exact Git/worktree-root discovery through the safe process runner and real-path comparison that handles worktrees, symlinked working directories, Windows drive casing, and platform separators.
- [x] 4.2 Replace unconditional child resolution with init target rules for exact Git roots, nested Git directories, non-Git directories, supplied project names, and existing named targets.
- [x] 4.3 Add early non-overridable guards for existing Liftoff manifests, non-directory targets, target symlinks, unsafe ancestors, and project-confined real paths.
- [x] 4.4 Add temporary staging-root lifecycle management and explicit staged origin tracking for durable Liftoff artifacts, framework-owned output, and Liftoff seed or overlay content.
- [x] 4.5 Implement staged-tree validation that rejects symlinks, unsafe paths, unreadable entries, and framework writes outside the adapter's approved roots.
- [x] 4.6 Implement immutable destination preflight classifications for create, identical, replace, merge-directory, and blocked entries with stable portable conflict ordering.
- [x] 4.7 Implement one interactive confirmation for the complete conflict set and `--force` authorization limited to validated regular-file replacements.
- [x] 4.8 Implement per-file atomic writes, stale-plan detection, replacement backups, reverse-order rollback, and explicit rollback reporting for handled merge failures.
- [x] 4.9 Add filesystem tests for in-place Git roots, nested repositories, unrelated-file preservation, identical files, conflict decline and force, manifest guards, type collisions, symlink escapes, rollback, and Windows-style path cases.

## 5. Official Framework Initialization and Ownership

- [x] 5.1 Define a framework adapter interface for pinned tool probes, initializer commands, agent mapping, approved output roots, expected markers, and staged validation.
- [x] 5.2 Implement the OpenSpec adapter using the pinned core-profile initializer and stable multi-tool mapping for Copilot and Claude Code.
- [x] 5.3 Implement the Spec Kit adapter using the selected default integration, official secondary integration installation, and skills-based Copilot options for either integration position.
- [x] 5.4 Snapshot staged files around official initializer execution, classify concrete framework-owned output, and reject unexpected roots or symlinks.
- [x] 5.5 Replace partial hand-written framework core output with official initialization plus explicit Liftoff seed content and supported configuration or constitution overlays.
- [x] 5.6 Update rendered manifest and validation markers so framework-owned files remain outside durable artifact hashes while selected integrations are still provable.
- [x] 5.7 Add adapter unit fixtures for every workflow and agent combination, failed commands, missing markers, unexpected output, and stable agent order.
- [x] 5.8 Add isolated integration smoke tests against the pinned OpenSpec and Spec Kit CLIs without modifying a developer project.

## 6. Init Command and Consent Flow

- [x] 6.1 Replace `create` with `init` in the command schema and dispatcher, remove every compatibility alias, and add focused `liftoff init` guidance for the obsolete command.
- [x] 6.2 Add strict parsing for `--agents`, `--default-agent`, `--force`, `--install-tools`, and `--install-dependencies`, including invalid and inapplicable combinations.
- [x] 6.3 Add interactive agent multi-selection and conditional Spec Kit default-agent prompts with Copilot as the retained default.
- [x] 6.4 Update project-plan previews and `liftoff plan` to show agents and the derived requirement summary without probing mutating installers or writing files.
- [x] 6.5 Implement the init orchestrator in the designed order: decisions, target guard, readiness and tool consent, staging render, official framework initialization, staged validation, conflict consent, merge, and optional dependencies.
- [x] 6.6 Keep `--yes`, `--force`, `--install-tools`, and `--install-dependencies` independent in both interactive and non-interactive execution.
- [x] 6.7 Add structured completion and failure output for initialized paths, configured integrations, deferred advisory tools, validation commands, and exact resume commands.
- [x] 6.8 Update command tests for inferred Git-root names, supplied names at Git roots, child targets elsewhere, both-agent workflows, missing defaults, all consent boundaries, staging failures, and removed `create`.

## 7. Project Dependency Setup

- [x] 7.1 Add stack-owned dependency command plans for Python virtual environments, backend and frontend `npm ci`, and Go module downloads using platform-correct working directories and executable paths.
- [x] 7.2 Add the separate interactive dependency confirmation and non-interactive `--install-dependencies` execution after a successful project merge.
- [x] 7.3 Verify dependency commands do not rewrite tracked dependency manifests or lockfiles and report any unexpected mutation as a failure.
- [x] 7.4 Add tests for declined installation, each selected stack, frontend inclusion, command failure with scaffold preservation, and exact resume output.

## 8. Doctor, Validate, and Update Integration

- [x] 8.1 Refactor `doctor` to consume the shared plan-derived requirement registry in probe-only mode while preserving layered output and read-only behavior.
- [x] 8.2 Add v3 framework-contract, integration-marker, selected-agent, blocking, advisory, and authentication-health doctor checks.
- [x] 8.3 Add explicit v2 legacy-framework warnings without inferring configured agents.
- [x] 8.4 Extend doctor JSON with stable requirement identifiers, observed states, severities, remedies, and unchanged top-level schema version conventions.
- [x] 8.5 Extend `validate` to check declared framework and agent markers without requiring durable hashes for framework-owned or seed files.
- [x] 8.6 Ensure `update` reconciles only explicit durable logical names and never selects framework-owned paths through directory or pattern matching.
- [x] 8.7 Add doctor, validate, and update tests for v2 and v3 projects, both frameworks, every agent combination, missing markers, missing runtimes, advisory tools, and JSON output.

## 9. Migration Pipeline

- [x] 9.1 Update migration prompts and non-interactive option handling to use init terminology, selected agents, default agent, and independent installation consent.
- [x] 9.2 Reuse workstation readiness, staging, official framework initialization, ownership validation, and optional dependency setup for the fresh migration target.
- [x] 9.3 Preserve migration's fresh-or-empty target rule and reject non-empty targets even when `--force` is supplied.
- [x] 9.4 Ensure every external command working directory and generated write is outside the migration source and preserve byte-for-byte source checks on success and failure.
- [x] 9.5 Add migration tests for official OpenSpec and Spec Kit targets, both agents, missing tools, dependency installation, non-empty target rejection, and source immutability.

## 10. Documentation, Packaging, and Release Verification

- [x] 10.1 Update generated project READMEs with selected workflow and agents, default integration, framework ownership, deferred tools, stack dependency commands, and validation next steps.
- [x] 10.2 Replace supported `liftoff create` examples with `liftoff init` across current root documentation, examples, help fixtures, and non-archived repository content while retaining explicit migration notes about the removed command.
- [x] 10.3 Document exact-Git-root behavior, existing-directory merge safety, manifest protection, all four independent consent flags, platform installation behavior, agent detection, and Linux limitations.
- [x] 10.4 Raise package and lockfile version identity to `0.4.0`, set Node.js engines to `>=20.19`, and ensure the terminal dependency is included in packed runtime assets.
- [x] 10.5 Update the package smoke test to verify `init --help`, side-effect-free planning, obsolete-command rejection, version output, and packed execution outside the repository.
- [x] 10.6 Add or update Windows CI coverage for target resolution, path confinement, atomic merge behavior, command discovery, plain terminal output, and package smoke execution.
- [x] 10.7 Run targeted parser, filesystem, framework, readiness, manifest, doctor, migration, and package tests, then run the existing full check, build, test, and package-smoke commands.
