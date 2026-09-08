## 1. Establish contracts and scope

- [x] 1.1 Map the 19 delta capabilities to implementation areas and regression cases, including all explicit non-goals; confirm the delivered acceptance matrix distinguishes retirement, mechanical extraction, correctness repair, and deferred production work.
- [x] 1.2 Capture representative supported CLI help/JSON and generated API/GenAI output with the existing fixtures before extraction; confirm the baseline is persisted and reproducible, with post-refactor parity enforced by the refactoring and integration tasks.
- [x] 1.3 Inventory exact Power Apps workload/options/modules/assets/source-commit entries, package/audit/CI references, and shared fixtures; confirm every removal target and every fixture to port is listed explicitly rather than selected through a deletion glob.

## 2. Retire Power Apps coherently

- [x] 2.1 Remove Power Apps and Code Apps plugin choices from input/configuration catalogs while retaining explicit retired-input errors; confirm CLI and interactive cases reject retired types and plugin flags, including false/negated forms, before preparation or generation.
- [x] 2.2 Reject the retired manifest discriminator in every manifest/diagnostic path before deeper metadata or live access; confirm v2-v7 API/GenAI fixtures still load and retired fixtures remain byte-identical under validate, doctor, update, force, and assessment.
- [x] 2.3 Remove the renderer, eager asset imports, vendored starter, plugin handling, and active/historical source-commit compatibility lane together; confirm supported plan rendering and the TypeScript build work without any retired starter directory.
- [x] 2.4 Port shared governance, seed, ownership, and rollback cases to supported workloads, retain explicit negative retired-manifest fixtures, and remove active Power Apps packaging/refresh/audit/CI entries; confirm remaining inventories are complete and no positive Power Apps execution case survives.

## 3. Extract actual implementation responsibilities

- [x] 3.1 Move normalized project plans, manifest/lifecycle contracts, and explicit workload/artifact definitions into the project domain with narrow public interfaces; confirm existing planner and contract cases pass without filesystem or process imports in those pure rules.
- [x] 3.2 Separate manifest parsing and compatibility from safe filesystem reads and transactional mutation adapters; confirm v2-v7 normalization, exact ownership, and unsafe-path cases preserve their behavior.
- [x] 3.3 Extract argument/help and per-command transport handlers while retaining the public executable and temporary import facades; confirm help snapshots, strict syntax, JSON output, and telemetry dispatch remain behaviorally equivalent.
- [x] 3.4 Extract initialization/framework orchestration into a focused application use case; confirm staging, target selection, overwrite consent, framework-profile consent, and dependency consent retain their independent boundaries.
- [x] 3.5 Extract update planning, component provisioning, transaction application, and reporting into focused units; confirm managed-core reconciliation and project-owned-file protection cases retain their behavior.
- [x] 3.6 Extract migration, self-upgrade, and diagnostic use cases from the command dispatcher; confirm their existing command-context and result contracts remain usable through the original public entry point.
- [x] 3.7 Move actual common, standard, GenAI, container, and infrastructure renderer implementations out of the template monolith; confirm deterministic double rendering and unchanged-case output parity rather than accepting callback-only facades.
- [x] 3.8 Separate shared governance policy/identity contracts, activation rules, assessment rules, and read/write adapters; confirm assessment cannot acquire activation execution or mutation capabilities through its public interfaces.
- [x] 3.9 Centralize installed-package asset lookup, remove internal imports through compatibility facades, and enforce import boundaries with the existing test infrastructure; confirm no runtime cycles/domain-to-I/O dependencies and successful asset lookup from a packed installation outside the repository.

## 4. Correct CLI input and readiness

- [x] 4.1 Share input normalization between prompts and noninteractive planning without discarding invalid values; confirm `--no-genai` without `--api` stays standard, invalid mixed agent lists fail, aliases remain accepted, and explicit flags override valid configuration consistently.
- [x] 4.2 Repair exact region filtering and invalid-region guidance; confirm `regions --region westus2` excludes unrelated regions and existing region search/default behavior remains intact.
- [x] 4.3 Add required npm/package-manager prerequisites separately from runtimes and preserve prerelease identity during stable/exact comparisons; confirm missing npm blocks before destination writes and framework/Python release candidates cannot masquerade as stable releases.
- [x] 4.4 Make Git-root discovery locale-independent without treating unrelated failures as nonrepository success; confirm localized nonrepository cases, unsafe ownership, permission errors, and exact/nested Git-root behavior through the existing initialization cases.

## 5. Preserve files during discovery and recovery

- [x] 5.1 Treat malformed, unreadable, dangling, symlinked/junction, and retired inner manifests as discovery boundaries; confirm update/validate/doctor do not select an outer project and assessment does not fall back to ordinary Git.
- [x] 5.2 Add a cooperating project mutation lock while preserving optimistic path/content preconditions; confirm concurrent Liftoff writers cannot interleave and read-only commands never create lock or state files.
- [x] 5.3 Preserve existing destination modes where supported and clean owned temporary files after partial-write failures; confirm POSIX 0600 preservation, injected partial-write/ENOSPC cleanup, original-file preservation, and explicit Windows metadata behavior.
- [x] 5.4 Prevent rollback and dependency recovery from overwriting concurrent or uncertain edits; confirm a frontend metadata edit during backend installation and a destination edit before rollback survive with exact conflict diagnostics.
- [x] 5.5 Correct dependency-failure reporting and shell-specific recovery recipes; confirm output distinguishes unchanged/restored/preserved paths, does not claim a complete script sandbox, and preserves literal spaces, quotes, dollar signs, and other significant characters in the identified shell.

## 6. Make migration inventory and tasks complete

- [x] 6.1 Use one explicit migration inventory for detection, staging, and task seeding, including setup.py/setup.cfg/pytest.ini and non-workflow GitHub content; confirm every unplaced item receives a decision and an issue-template-only directory does not invent workflows.
- [x] 6.2 Interpret actual dependency declarations rather than comments/examples, without executing source configuration; confirm commented pgvector does not select RAG and weak/conflicting evidence remains unresolved with provenance.
- [x] 6.3 Generate target-specific porting and placement tasks after applying explicit stack/frontend overrides; confirm Go-to-Node/Python and detected-but-disabled frontend cases do not reference unsupported destinations.
- [x] 6.4 Put dependency prerequisites before porting and all completion checks before legacy staging deletion; confirm both OpenSpec and Spec Kit migration checklists preserve source bytes, fresh-target guards, resumability, and cleanup-last ordering.

## 7. Repair generated runtime and container behavior

- [x] 7.1 Route generated Python settings, model, messaging, tracing, and readiness consumers through one resolved configuration contract; confirm file-backed configuration works without exporting it into process environment and explicit process values take precedence.
- [x] 7.2 Align standard Node and Go native startup with their documented configuration source/precedence using supported runtime facilities or reviewed pinned dependencies; confirm each stack's native recipe and existing operational endpoints work without metadata rewrites or GenAI-only prerequisites.
- [x] 7.3 Align Compose configuration with the same applicable runtime settings while preserving container-reachable service addresses; confirm documented model/transport/tracing inputs reach their consumers and missing required values produce clear configuration failures.
- [x] 7.4 Add explicitly tracked build-context exclusions for every generated context; confirm builds made after local dependency installation exclude host virtual environments, node_modules, output trees, VCS metadata, state, and local secrets.
- [x] 7.5 Correct existing RAG publisher configuration and sender selection without implementing retrieval; confirm injected Redis/Service Bus clients receive the configured stream/entity and missing namespace/entity/identity inputs cannot yield ingestion success.
- [x] 7.6 Keep nine pattern IDs but derive honest maturity/capability labels and remove generic's accidental specialization; confirm generic has no pgvector/retrieval/worker requirement and buffered SSE, missing history/tools/prompt loading, and other deferred capabilities are not advertised as implemented.

## 8. Isolate generated infrastructure environments

- [x] 8.1 Generate a shared Azure application module and independently inventoried dev/staging/prod roots with their own named tfvars, provider/lock inputs, and state paths; explicitly retire only the eight flat-root identities listed in design decision 10, declare the exact replacement inventory, and update reviewed contract snapshots under that narrow exception; confirm selected-environment combinations render deterministically with no shared default state address and no unrelated logical-name changes.
- [x] 8.2 Update helpers, README/image/output recipes, governance context, and baseline selection to use those same roots; confirm prod-only projects never reference dev and only baseline initialization uses `-backend=false`.
- [x] 8.3 Add full-project-identity collision resistance to all relevant scoped resource names; confirm `customer-portal-api` and `customer-portal-web` differ in resource-group, identity, Container Apps environment/application, and global-service names while respecting service limits.
- [x] 8.4 Wire the existing RAG backend's namespace, queue, identity, and narrow sender role separately from the worker receiver role; confirm generated configuration/role fixtures match the actual publishing and receiving contracts without provisioning anything.
- [x] 8.5 Recognize infrastructure layout through explicit recorded provenance and gate new-environment provisioning accordingly; confirm legacy/unknown layout produces a component-level migration-required result without dangling roots, shared-module rewrites, state moves, or force bypass, and that retired flat-root logical names, paths, generation hashes, and existing files remain preserved rather than deleted or aliased to new roots.

## 9. Introduce explicit activation-v2 contracts

- [x] 9.1 Prepare package/lock and activation identity 0.11.0, contract/state/evidence-header/approval/compatibility-metadata v2, and the retained manifest/policy/other schemas from design decision 8; confirm one authoritative definition drives active metadata without inventing a graph hash or new required manifest/report fields.
- [x] 9.2 Build real baseline and phase-input snapshots from explicit relevant-input inventories, excluding credentials and self-generated execution output; confirm source/configuration changes invalidate affected proof while writing receipts does not invalidate itself.
- [x] 9.3 Separate the persisted local execution anchor from verified remote repository binding; confirm read-only initial inspection writes nothing and successful Phase 0 does not invalidate its own or prior applicable local evidence.
- [x] 9.4 Add evidence body commitments and phase-specific payload/readback validation before scope use or successful persistence; confirm payload-only mutation, mismatched plan destinations, and missing independent readback are rejected.
- [x] 9.5 Separate historically readable from executable compatibility identities without automatic v1 history conversion; confirm API/GenAI manifests remain readable/core-maintainable while historical state/evidence stays byte-identical and execution reports an exact blocker.
- [x] 9.6 Compute the revised canonical graph/hash, phase digests, generated schemas, and compatibility inventory together; confirm future/mixed tuples fail closed and release-integrity cases distinguish CLI-only patches from semantic identity changes.

## 10. Repair local setup and activation-kernel consistency

- [x] 10.1 Register explicit phase planner/executor availability and enforce operation/outcome contracts, including the activation-approved mutation mismatch; confirm unavailable production handlers stay blocked and no outcome can write evidence rejected by the next inspection.
- [x] 10.2 Share authoritative evidence selection across readiness, status, doctor, verification, and source-of-truth resolution; confirm fresh proof coexists with informational stale history while equally authoritative contradictions still block.
- [x] 10.3 Represent unknown applicability and enforce the selected alternative dependency path; confirm unselected inapplicable import cannot satisfy blocked existing-private proof and Phase 0 does not invent false private-DAST/credential facts.
- [x] 10.4 Make repaired local seed/baseline/archive failures explicitly retryable while resume/preview remain read-only; confirm active and already-archived OpenSpec recovery, unchanged-success reuse, and no blanket remote/destructive retry.
- [x] 10.5 Generate the explicit project-owned Spec Kit bootstrap spec/plan/tasks bundle and implement its local baseline/finalization adapter alongside official initialization-marker validation; confirm fresh/resumed cases use real seed files, missing older bundles receive an adoption blocker, and no Git branch, OpenSpec tree, or external archive operation is created.
- [x] 10.6 Validate approval timing and scope containment, actual Git push destinations, and ignored initial-staging paths; confirm future/reversed/expired approvals and changed or unresolved multiple push URLs block, while unchanged narrower authorized scopes remain reusable.
- [x] 10.7 Keep task projection as an explicitly planned local mutation and make missing credential readback/enrollment/approval-entry capabilities honest blockers; confirm verify never edits checkboxes and no guidance requests fabricated state, approval files, or credential input through an unsupported channel.

## 11. Support ordinary Git assessment safely

- [x] 11.1 Resolve supported Liftoff, ordinary Git, and invalid/retired descriptors through authoritative explicit or nearest boundaries; confirm nested paths, unborn repositories, linked worktrees, and Windows paths work without initialization.
- [x] 11.2 Preserve schema-v1 target/report semantics for ordinary Git repositories using nullable recorded identity and explicit missing proof; confirm the installed single-maintainer target is displayed without inventing a manifest, opt-out, workload, or baseline.
- [x] 11.3 Bind optional GitHub observations to verified repository metadata while withholding missing runner/Azure scopes; confirm no-origin/unsupported-remote cases report gaps rather than guessing hosts, subscriptions, or organization-wide resources.
- [x] 11.4 Preserve assessment's no-write/no-telemetry/no-project-execution boundary for local, live, help, and failure paths; confirm filesystem fingerprints and injected operation logs show no initialization, lock, disclosure, registry lookup, git-status filter, or implicit live access.
- [x] 11.5 Keep selected-agent assessment wrappers equivalent and command-only while updating their ordinary-Git guidance; confirm generated projects receive only selected integrations and assessment never installs wrappers into unrelated repositories.

## 12. Correct assessment evaluations and coverage

- [x] 12.1 Evaluate effective/classic/inherited enforcement and exact check/application bindings across permanent and release/hotfix ref families; confirm contradictory classic protection and release-only drift cannot align, and bounded incomplete enumeration stays explicit.
- [x] 12.2 Traverse required jobs' resolvable transitive dependencies without executing YAML; confirm a passing aggregator cannot hide a continue-on-error scanner and unknown reusable/matrix/dynamic semantics stay unobserved.
- [x] 12.3 Separate source availability from actual input instability and retain independent observations; confirm GitHub 403/missing credentials do not erase known local conflicts and denied unrelated Azure reads do not hide proven storage violations.
- [x] 12.4 Require complete policy-relevant runner restrictions and authoritative resource roles, diagnosing conflicting bindings before deduplication; confirm all-repositories groups, missing assignment, inferred Dev storage roles, and conflicting ARM-ID bindings receive correct non-aligned outcomes.
- [x] 12.5 Bind every evidence-backed read scope to current inputs, body-committed receipts, and matching reviewed references; confirm modified payload IDs, historical placeholder receipts, and unknown state formats cannot authorize scoped provider requests.
- [x] 12.6 Preserve the complete policy/catalog inventory, exception diagnostics, redaction, and honest partial coverage; confirm unsupported controls remain visible, rejected exceptions are explained, secrets are screened before truncation, and human/JSON reports agree on exits and retained differences.

## 13. Correct scoped-registry upgrade behavior

- [x] 13.1 Resolve effective machine-level scoped npm registry configuration before the default registry, from neutral execution context; confirm mismatched default/scoped mirrors are classified correctly without project `.npmrc` influence or persistent config changes.
- [x] 13.2 Isolate canonical verification from scoped overrides while preserving configured-registry delivery policy; confirm canonical target selection cannot silently install from or bypass the wrong registry and sensitive registry values remain redacted.
- [x] 13.3 Distinguish response-body timeouts from invalid metadata and model historical verifier capabilities explicitly; confirm modern targets require current version checks while 0.3.3 is not required to expose init/upgrade/version commands it never supported.

## 14. Align guidance and release-owned inventories

- [x] 14.1 Update packaged/generated workload, prerequisite, configuration, assessment, safety, and troubleshooting guidance for two workloads and actual starter/setup limits; confirm documentation cases detect stale runtime/npm statements, retired positive guidance, and unsupported enrollment/migration commands.
- [x] 14.2 Replace the contributor architecture map with actual implementation locations, narrow interfaces, identity rules, and the eight responsibility groups; confirm no concentration-point file retains the original implementation behind callback-only facades.
- [x] 14.3 Align package contents, locks/baseline digests, dependency/freshness/audit inventories, non-Power-Apps CI jobs, and the explicit historical flat-root infrastructure identity inventory with reviewed declarations; confirm every remaining packaged runtime asset resolves, every active template package graph is covered, and retired infrastructure records do not acquire active generation or managed-core deletion authority.
- [x] 14.4 Reconcile the final implementation against all 19 deltas and preserve the retired capability's lifecycle-oriented Purpose for later normal spec synchronization; confirm every requirement/scenario has an implementation or explicit permitted deferred outcome without archiving this change automatically.

## 15. Demonstrate bounded end-to-end delivery

- [x] 15.1 Run focused corrected-case suites together with the broader existing integration checks once the components are wired; confirm init/local setup, update ownership, migration, self-upgrade isolation, and ordinary/initialized-repository assessment work through the public CLI rather than only injected helper calls.
- [ ] 15.2 Add explicit Windows CI coverage for discovery, path quoting, symlink/junction refusal, locks/recovery, asset loading, and environment roots, alongside macOS/Linux lanes; confirm those existing CI lanes pass when execution is authorized, otherwise report the external blocker without claiming completion.
- [x] 15.3 Run existing package, release-identity, standard-template, and generated-container checks in their supported environments, extending container checks to cover locally prepared source and actual startup; confirm no release is published and no live cloud resource or production state is accessed.
- [x] 15.4 Audit the final source/documentation diff and operation logs against the proposal's non-goals; confirm no new production phase adapters, public credential/approval workflow, GenAI specialization, global Power Platform cleanup, user-project conversion, Git push, or provider mutation was introduced by this work.

### Authorized cross-platform execution

Task 15.2 has its explicit Windows/macOS/Linux CI configuration and focused coverage in place. The final local run on macOS passed 1,389 tests, including both real pinned framework initializers; only the Windows command-shim case was skipped. Generated Linux containers were built from locally prepared source and exercised successfully. The user has now authorized committing and pushing this change to `develop` and running the manually dispatched CI workflow there. Task 15.2 remains unchecked until the hosted lanes succeed. This authorization does not include merging to `main`, publishing a release, or automatically archiving the change.

The operation-log review also records one earlier test-transport bug that attempted a failing GitHub read. It performed no remote mutation; the fixture was corrected to reject unexpected destinations and use only its local bare repository. Later local-only assessment and corrected fixture runs do not erase that historical caveat.
