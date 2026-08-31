## 1. Governance Profile Model And CLI Inputs

- [x] 1.1 Confirm `refresh-supported-stack-baselines` is implemented or otherwise supply its final baseline identifiers before governance context rendering is wired.
- [x] 1.2 Add append-only `single-maintainer-gitflow` and `none` governance profile definitions, types, resolvers, and default selection to the project planning model.
- [x] 1.3 Add `governanceProfile` configuration validation and `--governance` parsing, help, aliases if approved, deterministic option merging, and unknown-value errors.
- [x] 1.4 Add the interactive governance question after workload-specific architecture choices, default it to enabled, and ensure `--yes` selects the default without authorizing remote actions.
- [x] 1.5 Add governance profile, policy version, local handoff state, selected launchers, and deferred activation to human plan and completion presentation.
- [x] 1.6 Add planner, argument, configuration, interactive, help, lifecycle, cancellation, redirected-input, and presentation tests for enabled, disabled, defaulted, and invalid profile inputs.

## 2. Canonical Policy And Workload Context

- [x] 2.1 Package the supplied repository bootstrap standard as the complete canonical `single-maintainer-gitflow` policy with an explicit policy schema and version.
- [x] 2.2 Add fail-closed policy validation covering GitFlow branch roles, zero human approvals, repository scope, `GITHUB_TOKEN`, designated security tools, excluded duplicate tools, release evidence, deployment and rollback, monitoring, health, DORA, ruleset sequencing, negative tests, and documentation.
- [x] 2.3 Add a deterministic schema-versioned governance context renderer for common project identity, supported-stack baseline, framework, agents, artifact form, real build/test commands, generated environments, deployment boundaries, and health endpoints.
- [x] 2.4 Add explicit GenAI, standard Python, standard Node.js, standard Go, optional frontend, worker, and Power Apps context adapters that mark absent boundaries as inapplicable and live facts as undiscovered.
- [x] 2.5 Validate that generated policy and context contain no token, credential, webhook, tenant secret, fabricated runner, live deployment, monitoring route, or GitHub enforcement claim.
- [x] 2.6 Add deterministic and workload-matrix tests proving identical policy/context bytes and logical identities across Windows, macOS, and Linux.

## 3. Durable Agent Handoff Artifacts

- [x] 3.1 Add explicit durable artifact definitions for `.liftoff/governance/policy.md`, `.liftoff/governance/context.json`, and `.liftoff/governance/README.md`.
- [x] 3.2 Confirm the current pinned OpenSpec and Spec Kit integration layouts, then reserve one exact Copilot prompt path and one exact Claude command path that do not collide with official framework output.
- [x] 3.3 Render thin selected-agent launchers that reference the canonical policy and context, require commit and push, and never duplicate the full policy.
- [x] 3.4 Omit all governance handoff artifacts for `none` and omit each unselected agent launcher without relying on directory-pattern matching.
- [x] 3.5 Extend append-only logical-name snapshots and packaged asset lists for the canonical policy, context, guide, and launcher artifacts.
- [x] 3.6 Add framework-staging tests proving Liftoff owns only the exact launcher names while neighboring official `.github` and `.claude` output remains framework-owned.

## 4. Phase 0 And Post-Approval Policy Contract

- [x] 4.1 Encode the post-push read-only Phase 0 checklist for repository identity, artifacts, languages, package managers, working commands, refs, workflows and exact checks, rulesets, releases, environments, security, runners, deployments, monitoring, alerts, health depth, and provider capabilities.
- [x] 4.2 Require Phase 0 to report every gap, inapplicable control, GitFlow-versus-continuous-delivery conflict, proposed activation baseline SHA, and ordered plan before stopping for explicit user approval.
- [x] 4.3 Encode the fixed single-maintainer requirements: zero approving reviews, no CODEOWNERS, no environment reviewers, no manual workflow approval, repository-scoped controls only, and no org-level substitute.
- [x] 4.4 Encode workload-aware security mapping using Secret Protection, Dependabot, Dependency Review, CodeQL/Autofix, Checkov, blocking Trivy, non-gating Grype, ZAP, attestations/SLSA, and Scorecard while excluding duplicate tools.
- [x] 4.5 Encode build-once promotion, immutable semantic releases, evidence bundles, signer pinning, trusted roots, blue-green replacement, statistically valid automated canary analysis, immediate ungated rollback, and truthful platform fallbacks.
- [x] 4.6 Encode infrastructure-as-code alerting, Slack severity routing, heartbeat and alert tests, component shallow/deep health, dependency-aware recovery order, provider status, and DORA derivation without fabricating unavailable coverage.
- [x] 4.7 Require the selected agent to create a new project-framework change only after approval, observe each required context green and deliberately red, apply idempotent rulesets last, and read live enforcement back.
- [x] 4.8 Require a user-owned activation record for the approved current `main` SHA, stale-baseline detection, post-baseline release anomaly enforcement, and no synthetic release, moved tag, history rewrite, or Liftoff ownership.
- [x] 4.9 Add policy snapshot and focused contract tests that fail when any fixed invariant, fail-closed rule, approval pause, workload adaptation, or activation-baseline instruction is omitted.

## 5. Manifest Schema V5

- [x] 5.1 Add schema-v5 types and writer output for governance profile, policy version, and `handoff-generated` or disabled state without adding observed GitHub state.
- [x] 5.2 Add strict v5 reader validation for governance field applicability, identifiers, policy version, state, durable hashes, and project-confined path parts.
- [x] 5.3 Preserve v2, v3, and v4 readers with governance unspecified, existing workload normalization, and legacy framework uncertainty; reject versions outside 2 through 5 with guidance.
- [x] 5.4 Update initialization, migration, validation, doctor, update, fixture manifests, schema tests, malformed-input tests, deterministic rendering, and contract snapshots to write or understand v5.
- [x] 5.5 Add Windows coverage for governance path parts, drive-qualified and UNC rejection, embedded separators, traversal, case behavior, and symlink escape protection.

## 6. Transactional Initialization

- [x] 6.1 Render enabled governance files as durable Liftoff artifacts in temporary staging alongside the selected official framework and one-time workload seed.
- [x] 6.2 Extend staged ownership and validation so exact governance launchers can coexist with framework directories without broad ownership claims.
- [x] 6.3 Exercise initialization preflight for missing, identical, replacement, structural-collision, and symlink governance destinations under existing independent authorization rules.
- [x] 6.4 Add rollback and destination-lock tests proving partial governance writes are removed or restored when any later merge operation fails.
- [x] 6.5 Add workload and selected-agent initialization tests confirming the correct local handoff, schema-v5 state, deferred activation message, and zero GitHub or deployment calls.
- [x] 6.6 Add named-child tests proving default governance initialization works before Git exists and exact-Git-root tests proving Git discovery does not become remote mutation.

## 7. Existing Project Update And Diagnostics

- [x] 7.1 Normalize configurations without `governanceProfile` to the enabled default during planning and update without rewriting user-owned `liftoff.config.json`.
- [x] 7.2 Reconcile new governance artifacts through existing explicit logical-name states, safe apply, force, transaction, hash refresh, and JSON/human check output.
- [x] 7.3 Add update tests for absent safe adoption, identical destination adoption, different unrecorded conflicts, modified managed conflicts, partial safe apply, and transaction rollback.
- [x] 7.4 Implement explicit `none` behavior so previously managed handoff files become reported orphans and are never auto-deleted.
- [x] 7.5 Prove update never creates, restores, scans by pattern, or owns an OpenSpec/Spec Kit governance change or agent-created `governance/activation-baseline.json`.
- [x] 7.6 Prove update behavior is identical offline and with an authenticated writable `gh` installation, with no GitHub API or Git mutation.
- [x] 7.7 Extend validate and doctor to report local policy/context/launcher integrity and handoff state while never claiming live enforcement or requiring GitHub access.
- [x] 7.8 Add v2-v4 update migration tests for check-mode byte preservation, safe governance adoption, schema-v5 rewrite, skipped-conflict hashes, and legacy framework uncertainty.
- [x] 7.9 Record preserved unrecorded governance conflicts as `handoff-partial`, omit those files from Liftoff ownership, retain future conflict classification, promote resolved handoffs to `handoff-generated`, and cover validation, doctor, and documentation behavior.

## 8. Workload Adaptation And Safety Verification

- [x] 8.1 Add GenAI and standard API fixtures verifying only generated backend, frontend, worker, container, OpenTofu, environment, test, and health facts enter context.
- [x] 8.2 Add Power Apps fixtures verifying root npm and immutable starter facts are included while backend, Docker, OpenTofu, custom container promotion, and API DAST are explicitly absent.
- [x] 8.3 Add tests for missing private runners, unavailable licensed security features, absent monitoring routes, unsupported parallel deployment, and insufficient canary traffic to ensure the policy demands a blocker or truthful adaptation rather than success.
- [x] 8.4 Add tests proving `--yes`, `--install-tools`, `--install-dependencies`, and `--force` retain their existing scopes and never authorize agent execution or live governance.

## 9. Documentation, Packaging, And Final Validation

- [x] 9.1 Update README, getting started, workloads, CLI reference, spec workflows and agents, existing repositories, prerequisites, safety and consent, project structure, configuration and manifests, update, troubleshooting, and generated guides for governance selection and deferred activation.
- [x] 9.2 Document existing-project automatic adoption, schema-v5 migration, `liftoff update --check`, conflict handling, opt-out orphans, and the distinction between local handoff and live enforcement.
- [x] 9.3 Update contributor documentation for maintaining the canonical policy version, exact artifact inventory, launcher compatibility, workload adapters, and policy contract tests.
- [x] 9.4 Ensure canonical governance policy and all linked documentation are included in the packed npm artifact and every relative link resolves with platform-correct handling.
- [x] 9.5 Run targeted planner, CLI, interactive, template, manifest, init-filesystem, update, doctor, validation, documentation, package-smoke, framework, and cross-platform tests.
- [x] 9.6 Run the complete package and telemetry checks after the dependency-baseline change, verify generated artifacts and package bytes are deterministic, and confirm both OpenSpec changes remain strict-valid.
