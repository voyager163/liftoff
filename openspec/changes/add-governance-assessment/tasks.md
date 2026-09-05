## 1. Report contract and packaged controls

- [x] 1.1 Define assessment report, observation, finding, scope, coverage, and outcome types with strict schema-v1 validation; verify all classifications and exit-code outcomes with table-driven tests.
- [x] 1.2 Add the release-owned assessment control catalog and reviewed policy-family coverage inventory, including explicit unsupported entries; verify unique stable IDs, expected values, phase references, evaluator references, and non-empty enabled coverage.
- [x] 1.3 Bind the catalog to the installed policy digest and target activation identity without changing policy or state schemas; verify target resolution is offline, deterministic, and unaffected by a different registry latest version.
- [x] 1.4 Add the parse-only YAML dependency through the package manager and update affected lock/baseline metadata; verify duplicate keys, unsafe tags, excessive aliases, and unresolved dynamic expressions cannot produce a trusted static result.

## 2. Safe assessment inspection

- [x] 2.1 Build assessment project discovery and bounded input readers using existing safe path utilities; verify nested roots, explicit paths, spaces, malformed JSON, traversal, drive-qualified/UNC paths, and symlink escapes.
- [x] 2.2 Separate input-shape/path validation from activation compatibility for assessment only; verify supported legacy manifests and unsupported tuples produce honest diagnostics while existing mutation loaders remain fail-closed and byte-preserving.
- [x] 2.3 Collect target, recorded identity, managed-file comparisons, workload applicability, and local Git facts through pure helpers without invoking update or registry lookup; verify fresh, partial, completed, disabled, and no-manifest cases, and prove Git hooks/fsmonitor/diff helpers cannot execute.
- [x] 2.4 Collect explicitly scoped project-owned workflow, ruleset, environment, and governance declarations with source locations and digests; verify reads never execute project code, inspect prohibited credential/state payloads, or add manifest ownership.

## 3. Deterministic control evaluation

- [x] 3.1 Implement the seven finding classifications with per-layer coverage and conservative applicability; verify unknown, denied, stale, empty, and incomplete observations cannot become aligned, missing, or inapplicable without sufficient proof.
- [x] 3.2 Implement local comparisons for the minimum catalog families, including GitFlow branch roles, single-maintainer review settings, ruleset/tag intent, workflow permissions/references, and security-stage inventory; verify canonical policy expectations rather than generic best-practice defaults.
- [x] 3.3 Reuse evidence identity/freshness and approval validators for current proof and exact catalog-permitted exceptions; verify wrong repository/environment/phase/identity, stale evidence, expired exceptions, unverified prose, and missing live proof remain visible.
- [x] 3.4 Generate ownership-aware advisory remediation and known phase impacts without inventing a migration plan; verify managed drift points to supported managed-update inspection while project/remote differences never recommend force-overwrite or unavailable commands.

## 4. Opt-in live observation

- [x] 4.1 Implement the live collector boundary with fixed action IDs, allowlisted read methods/endpoints, verified scope, pinned API versions, and release-owned request/page/size/deadline limits; verify mutation attempts and foreign-host continuation links are rejected before invocation.
- [x] 4.2 Collect GitHub repository, branch/effective protection, ruleset/tag, workflow/check, and security-feature metadata; verify exact repository/ref/SHA binding, complete pagination, declared-versus-live differences, and bounded cancellation with deterministic fixtures.
- [x] 4.3 Collect GitHub environment and applicable hosted-runner assignment metadata, restricting organization reads to already-bound runner/group/network IDs; verify missing permission or binding yields not-observed without organization-wide discovery or credential enrollment.
- [x] 4.4 Collect applicable Azure provider, bound storage/state, and private-network configuration metadata; verify exact subscription/environment/resource scope, no default-subscription guessing, and no registration, listKeys, SAS, state-blob access, or resource mutation.
- [x] 4.5 Normalize denied, unavailable-tool/auth, masked-404, timeout, truncated, and incomplete collection results; verify unknown observations remain distinct from authoritatively proven absence and partial failures preserve other valid findings.
- [x] 4.6 Sanitize and bound provider observations and error diagnostics before retention or rendering; verify tokens, webhook URLs, connection strings, private keys, raw sensitive bodies, and secrets beyond truncation boundaries do not leak.

## 5. Snapshot reporting and CLI surface

- [x] 5.1 Build deterministic report assembly and input/ref change detection with stable ordering, capture metadata, and result digests; verify reordered equivalent inputs match and changed inputs produce partial coverage rather than mixed-snapshot alignment.
- [x] 5.2 Render human and JSON views from the same report with target, coverage, prioritized findings, and exit codes 0/2/1; verify disabled governance is not an alignment claim and partial or excepted outcomes cannot appear fully aligned.
- [x] 5.3 Add strict `governance assess` parsing/help and dispatch before activation-only compatibility gates; verify `--live` is assessment-only, mutation/installation flags are rejected, conflicting project arguments fail, and existing subcommand behavior is unchanged.
- [x] 5.4 Enforce no network access in default mode and no project/Git/configuration/state/evidence/remote writes in either mode; verify filesystem fingerprints and injected operation logs, including failed requests and unsupported identities.

## 6. Selected-agent integrations and ownership

- [x] 6.1 Render Copilot and Claude `/liftoff-governance-assess` integrations with only the two canonical assessment commands and explicit live-read consent; verify both agents explain CLI output without changing classifications or executing recommendations.
- [x] 6.2 Append the exact assessment logical names and path parts to lifecycle declarations, renderer, manifest readers, compatibility inventory, and reviewed logical-name fixtures; verify no existing identifiers, activation schemas, or skill versions change.
- [x] 6.3 Make old supported inventories expose new assessment integrations as guarded update drift; verify clean adoption, managed conflict handling, unowned collision protection even under force, transactional rollback, disabled profiles, and unchanged user activation/evidence bytes.
- [x] 6.4 Cover every supported selected-agent/spec-framework combination and preserve the primary post-init `/liftoff-setup` recommendation; verify no auto-assessment, neighboring framework ownership, or retired setup alias is introduced.

## 7. Documentation and end-to-end readiness

- [x] 7.1 Update CLI, governance, generated-guide, and developer documentation for target pinning, classifications, coverage, local/live consent, exit codes, and future-upgrade boundaries; verify documentation contracts and packaged links.
- [x] 7.2 Add an assessment scenario matrix for fresh and seed-valid-completed setup, archived/blocked seeds, completed activation, supported historical manifests, unsupported state/graph identities, project customization, and approved exceptions across standard, GenAI, and Power Apps workloads; verify report truthfulness and no phase advancement.
- [x] 7.3 Extend installed-package smoke coverage for local assessment/help/report assets and opt-in live behavior with controlled read-only fixtures; verify installed CLI behavior matches generated integration commands without contacting production services.
- [ ] 7.4 Include the new path, parser, read-only, and integration suites in the existing Windows/macOS/Linux CI matrix and obtain platform results before release; verify CRLF, path separators, spaces, case handling, and supported symlink/junction safeguards.
- [x] 7.5 Run the focused assessment/ownership/governance suites, TypeScript build, repository checks, package smoke, and strict OpenSpec validation, including the separate bootstrap-recovery regressions when combined; confirm assessment never commits, publishes, provisions, or migrates a project.
