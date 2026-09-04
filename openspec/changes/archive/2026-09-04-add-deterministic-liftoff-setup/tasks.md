## 1. Define the activation engine contract

- [x] 1.1 Define shared constants for Liftoff `0.10.0`, manifest v7, policy v6, activation contract v1, and schema-v1 activation artifacts plus an explicit compatibility-tuple lookup; verify supported tuples resolve and individually known but unsupported combinations fail
- [x] 1.2 Add typed phase identifiers, states, dependency edges, applicability, approvals, mutations, invalidation inputs, evidence references, rollback, terminal outcomes, and activation identity; verify TypeScript rejects unknown states, phase IDs, and identity fields
- [x] 1.3 Add strict JSON schemas for the managed phase graph, user activation state, approval envelopes, evidence headers, supersession records, and credential policy with their version fields; verify valid v1 fixtures pass and malformed, extra, or future fields fail
- [x] 1.4 Commit the canonical phase graph from seed validation through day-30 disposal, including the existing-private-path and bounded-local-bootstrap branches; verify graph validation finds no unknown dependency or cycle
- [x] 1.5 Add canonical phase-graph SHA-256 and per-phase contract-digest generation plus release bump validation; verify byte drift, semantic drift, missing compatibility mappings, and missing contract/schema bumps fail while wrapper-only drift requires no skill version
- [x] 1.6 Advance the canonical policy to v6 so capability chapters are not execution order and `provider-ready` precedes `bootstrap-local`, runner readiness precedes private backend proof, and remote import precedes `remote-ready`; verify policy, graph, and compatibility assertions agree
- [x] 1.7 Add graph validation for dependency order, conditional inapplicability, approval gates, allowed mutation classes, rollback edges, and terminal state reachability; verify reversed remote-import/runner dependencies fail
- [x] 1.8 Add deterministic phase-readiness calculation from graph, activation state, approvals, evidence, and the compatibility tuple; verify ready, blocked, verified, failed, inapplicable, and identity-blocked fixture transitions

## 2. Make evidence authoritative

- [x] 2.1 Implement evidence identity and freshness validation for repository ID, complete activation version vector, graph hash, phase contract and input digests, activation baseline SHA, phase ID, timestamp, producer, and result; verify stale or mismatched evidence is rejected
- [x] 2.2 Implement schema-valid old-to-new graph reconciliation records for unchanged phase contract digests; verify compatible immutable evidence remains usable and changed phase digests invalidate only affected descendants
- [x] 2.3 Implement latest-valid phase evidence selection by identity and transition rather than filename or checkbox order; verify contradictory older inventory cannot override newer verified evidence
- [x] 2.4 Reconcile OpenSpec task checkboxes as a projection of phase state; verify checked tasks with absent, pending, or failed evidence become incomplete and cannot unlock descendants
- [x] 2.5 Add live-readback requirements to phases that mutate GitHub or Azure; verify source files or local state alone cannot mark live enforcement or infrastructure ready
- [x] 2.6 Add transactional activation-state writes with schema and compatibility checks plus rollback; verify interrupted, concurrent, or incompatible writes preserve the last valid state on Windows, macOS, and Linux

## 3. Generate a complete baseline seed

- [x] 3.1 Generate the workload capability delta spec declared by each OpenSpec seed proposal; verify fresh standard, GenAI, worker, frontend, and Power Apps seeds are planning-complete and strict-valid
- [x] 3.2 Replace the contradictory placeholder task with an explicit confirmation that domain-specific behavior is deferred; verify proposal, design, spec, and tasks have one consistent bootstrap scope
- [x] 3.3 Define deterministic seed tasks for `liftoff validate`, applicable backend tests, frontend build, `docker compose config -q`, OpenTofu formatting, backend-disabled initialization, OpenTofu validation, and strict OpenSpec validation
- [x] 3.4 Implement workload-aware baseline-check selection so absent frontend, Docker, or infrastructure checks are recorded inapplicable; verify no success-shaped placeholder command is emitted
- [x] 3.5 Implement seed completion, spec sync, and archive only after every applicable check succeeds; verify a failed check leaves the seed active and blocks initial commit/push
- [x] 3.6 Add generated-project tests that execute strict OpenSpec validation immediately after `liftoff init`; verify no agent-authored repair is necessary
- [x] 3.7 Preserve seed-category ownership and archive non-reconciliation behavior; verify `liftoff update`, `validate`, and `doctor` remain clean after setup archives the seed

## 4. Add deterministic governance commands

- [x] 4.1 Extend strict CLI parsing and help with `governance status`, `plan`, `apply-next`, `resume`, and `verify`; verify unknown subcommands, flags, and excess positionals fail before project discovery
- [x] 4.2 Implement project-root discovery for every governance subcommand; verify invocation from root, nested directories, explicit paths, and non-project directories
- [x] 4.3 Implement versioned JSON and responsive human output for governance status, including the complete activation version vector, graph hash, active change, phase states, next ready phase, blockers, approvals, and evidence freshness; verify no setup-skill version is emitted
- [x] 4.4 Implement read-only governance plan output with ready/blocked phases, required evidence, approval gates, exact permitted mutations, cost-envelope impact, and no writes
- [x] 4.5 Implement governance verify across graph, state, evidence, task projection, policy identity, active-change identity, and required live readback; verify it never invents completion
- [x] 4.6 Implement resume so only blocker preflights and readiness descendants are recalculated; verify verified operations do not rerun

## 5. Generate one setup integration

- [x] 5.1 Add managed-core `/liftoff-setup` integrations for GitHub Copilot and Claude Code that call only the deterministic governance commands; verify both agents receive equivalent behavior
- [x] 5.2 Generate no model field or model-selection prompt in setup integrations; verify selected agent integration remains separate from model choice
- [x] 5.3 Convert `/liftoff-repository-governance` into a compatibility alias for the same governance engine; verify invoking both entry points cannot create separate activation state
- [x] 5.4 Add the managed phase graph and credential-policy schema to explicit artifact paths, logical-name allowlists, manifest hashes, package files, and update reconciliation; verify cross-platform path-part arrays
- [x] 5.5 Implement manifest v7 reading and writing while retaining v2-v6 readers; verify governed manifests carry the compatible activation vector and graph hash, governance-disabled manifests use the disabled variant, and all new writes use v7
- [x] 5.6 Update generated governance guide and completion output so `/liftoff-setup` is the next command after initialization; verify disabled governance omits the setup integrations and graph

## 6. Enforce one active source of truth

- [x] 6.1 Inspect active OpenSpec changes before governance creation; verify an unfinished generated seed blocks Phase 0
- [x] 6.2 Resume exactly one compatible active governance change and record its ID in activation state; verify repeated setup invocation does not create another change
- [x] 6.3 Require an explicit schema-valid supersession or archive record when multiple changes overlap governance scope; verify ambiguous changes remain blocked
- [x] 6.4 Create the canonical governance change from approved Phase 0 facts when none exists; verify requirements, phase mappings, and tasks reference the complete compatible activation identity
- [x] 6.5 Reconcile policy, contract, schema, or graph-hash updates against active work, invalidate only affected descendants, and emit an approval-ready report; verify compatible evidence and predecessors remain verified
- [x] 6.6 Block setup when the active change has not acknowledged the installed compatible activation identity; verify managed update alone performs no project or remote mutation

## 7. Consolidate approvals and questions

- [x] 7.1 Implement approval-envelope schema and hashing for resources, destinations, permissions, cost ceilings, policy exceptions, destructive scope, expiry, plan digest, and baseline SHA
- [x] 7.2 Limit setup prompts to repository/initial push, credentials, billed infrastructure or exceptions, final enforcement, destructive operations, and external blockers; verify settled defaults never become prompts
- [x] 7.3 Permit deterministic retries within an unchanged approval envelope; verify API-shape or implementation-only remediation does not ask again
- [x] 7.4 Invalidate approval when resource types, subscriptions, permissions, cost, exceptions, or destructive effects expand; verify apply-next blocks until renewed approval
- [x] 7.5 Keep `liftoff init`, `--yes`, managed update, status, plan, and verify outside Git, GitHub, Azure, credential, and enforcement authority; verify existing consent tests remain green

## 8. Standardize credential enrollment

- [x] 8.1 Add the shared credential-policy schema for existing GitHub App and fine-grained PAT authentication, including explicit allowed workflow/job lists and non-forwarding
- [x] 8.2 Prefer a verified selected-repository GitHub App installation and generate short-lived tokens when available; verify setup does not install or broaden an App
- [x] 8.3 Implement deterministic PAT fallback values: `<repo>-runner-preflight-read`, `RUNNER_CONFIGURATION_READ_TOKEN`, 30-day lifetime, current repository, metadata read, hosted-runner read, network-configuration read, and no writes
- [x] 8.4 Accept PAT input only through masked stdin and pass it to the repository-secret operation without command arguments, files, logs, chat, or evidence; verify credential-shaped fixture values never appear in captured output
- [x] 8.5 Record payload-free credential metadata, expiry, rotation lead, owner, permissions, and allowed jobs; verify out-of-policy workflow references, overbroad scopes, or expired credentials fail
- [x] 8.6 Detect credential-shaped content in generated artifacts, logs, and imported evidence and emit compromised/revoke/rotate status; verify setup performs no unauthorized revocation
- [x] 8.7 Add repository fixtures matching both observed preflight workflows and verify they produce the same display-name template, secret name, permissions, expiry, and validation depth

## 9. Implement controlled transitions

- [x] 9.1 Implement transactional local apply-next for seed/state preparation phases and report exact mutations before execution; verify no unlisted operation runs
- [x] 9.2 Add explicit initial Git initialization, commit, remote, and push approval handling without force, reset, rebase, or unknown-file deletion; verify dirty/divergent repositories block safely
- [x] 9.3 Implement Phase 0 read-only discovery and activation-plan generation from the canonical graph; verify no active change, baseline, GitHub setting, or Azure resource is written before approval
- [x] 9.4 Implement allowlisted post-approval transition adapters for selected spec workflow, GitHub APIs, Azure/OpenTofu, and local evidence; verify each adapter is constrained by phase and approval envelope
- [x] 9.5 Require fresh saved-plan and prerequisite evidence before retrying a failed transition; verify external blockers produce one stable blocker rather than automatic retry loops
- [x] 9.6 Implement reverse-dependency rollback calculation and incomplete-cleanup reporting; verify provider registrations and other retained subscription capabilities are not removed
- [x] 9.7 Implement final ruleset activation only after exact green and deliberate-red evidence, baseline reread, enforcement approval, and source/live readback; verify skipped or cancelled checks never satisfy the gate
- [x] 9.8 Implement retained bootstrap-state scheduling and disposal-state verification; verify day-30 deletion remains pending rather than falsely completing activation work

## 10. Reconcile managed updates

- [x] 10.1 Extend managed-core update preview and apply for manifest v7 identity, phase graph, schemas, compatibility metadata, setup skills, and compatibility alias without claiming live activation
- [x] 10.2 Implement transactional manifest v2-v6 to v7 preview and migration across the complete managed write set; verify check mode changes no byte and a failed preflight or write restores the prior manifest and artifacts
- [x] 10.3 Preserve user activation state, immutable evidence, approvals, and active OpenSpec changes during update; verify no update mode advances or deletes phases
- [x] 10.4 Report `reconciliation-required` when managed policy, activation contract, schema, or graph hash changes affect active work; verify check mode leaves every project byte unchanged
- [x] 10.5 Migrate supported historical versioned activation state transactionally and require explicit mapping for unversioned or ad hoc task structures; verify no checkbox, filename, or prose alone becomes imported evidence
- [x] 10.6 Block future versions, unsupported compatibility tuples, and unrecognized graph hashes without downgrade or write; verify diagnostics name the exact field, found identity, supported identity, and minimum CLI remedy
- [x] 10.7 Update doctor to distinguish seed-incomplete, phase-blocked, evidence-stale, credential-expiring, reconciliation-required, identity-incompatible, enforcement-incomplete, and disposal-pending states with exact remedies

## 11. Update documentation

- [x] 11.1 Rewrite root README Start Here with `liftoff init my-project`, `cd my-project`, and `/liftoff-setup`; verify links lead to detailed bootstrap and governance guidance
- [x] 11.2 Update getting-started and generated project README with baseline commands, automatic seed archive, commit/push gate, setup resumption, and normal feature/release flows
- [x] 11.3 Update repository-governance documentation with the canonical phase graph, phase versus policy-chapter distinction, question budget, approval envelopes, active-change reconciliation, and evidence authority
- [x] 11.4 Document deterministic PAT/App enrollment and warn against token values in chat, command arguments, logs, evidence, or screenshots
- [x] 11.5 Update CLI reference, project structure, configuration/manifest, safety, existing-project, and troubleshooting guides for new commands, manifest v7, activation identity, compatibility remedies, and managed/user-owned artifacts
- [x] 11.6 Update contributor documentation with the version vector and bump rules, absence of a skill version, compatibility-map maintenance, graph/schema integrity, seed strict-validation, cross-agent setup equivalence, credential leak tests, and release validation requirements

## 12. Validate end-to-end behavior

- [x] 12.1 Add unit tests for graph parsing, canonical hashes, phase contract digests, compatibility tuples, cycles, readiness, invalidation, state transitions, approval envelopes, evidence freshness, task projection, and credential policy
- [x] 12.2 Add command tests for all governance subcommands, JSON schemas, strict syntax, project discovery, read-only behavior, apply consent, blocker resumption, and transactional rollback
- [x] 12.3 Add fresh-project lifecycle tests for OpenSpec and Spec Kit across standard, GenAI, worker, frontend, and Power Apps workloads; verify `/liftoff-setup` reaches the correct first authority gate
- [x] 12.4 Add Windows, macOS, and Linux path, permissions, masked-input, process, and state-transaction coverage without assuming POSIX-only behavior
- [x] 12.5 Add regression fixtures for incomplete seed, multiple active changes, reversed bootstrap order, stale activation identity, checked task with failed evidence, inconsistent inventory, overbroad token, secret exposure, future schemas, unsupported tuples, and unknown graph hashes
- [x] 12.6 Add manifest v2-v7 and supported activation-state migration matrices, failure-injection rollback tests, future-version rejection, and compatible-evidence preservation tests; verify every blocked path leaves managed and user-owned bytes unchanged
- [x] 12.7 Run strict OpenSpec validation and the focused scaffold, governance, update, CLI, documentation, manifest, command, process, and security tests
- [x] 12.8 Run `npm run check`, package smoke, generated-stack checks, package inspection, and release identity verification; verify `0.10.0`, policy 6, contract 1, schema 1, manifest 7, graph hash, compatibility metadata, and all setup artifacts ship without a skill-version field
