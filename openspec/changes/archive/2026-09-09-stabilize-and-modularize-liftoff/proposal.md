## Why

Liftoff's supported surface has outgrown its internal boundaries: large command, rendering, filesystem, and activation modules contain correctness gaps that generated files and successful isolated checks do not resolve. Retiring Power Apps and repairing the remaining CLI now provides a smaller, maintainable product with useful, honest governance assessment instead of implying that unfinished production automation is complete.

## What Changes

- **BREAKING**: Remove Power Apps code app creation and all existing-project support, including the preview plugin integration, vendored starter, source-commit compatibility inventory, workload options, prerequisites, positive fixtures, packaging, CI, and public guidance. Recognized Power Apps inputs and manifests must fail explicitly without modifying or converting user projects; generic repository assessment must not bypass that rejection.
- **BREAKING for activation history**: Introduce the versioned activation-v2 binding contract. Historical activation-v1 state and receipts remain byte-preserved and diagnosable, but cannot be treated as executable current proof; this change does not provide automatic historical-state reconciliation.
- **BREAKING for new generated infrastructure inventories**: Explicitly retire the eight flat-root OpenTofu artifact identities enumerated in design decision 10 in favor of shared-module and independent-environment declarations. This is a narrow exception to the append-only logical-name contract for new scaffolds only. Existing project files, state, and historical provenance remain unchanged; no update, force, or assessment path performs the layout migration.
- Make manageable source code a required delivery outcome. Keep one npm package, extract real command/use-case and generator responsibilities, separate manifest contracts from filesystem mutation, and give policy, activation, and assessment clear interfaces. Do not replace the current large modules with callback-only facades or introduce a general plugin framework.
- Extend read-only governance assessment to ordinary Git repositories, including Liftoff itself, without requiring initialization. Preserve the installed policy target, explicit coverage gaps, local-only default, live-read consent, telemetry exclusion, and separation from mutation authority.
- Correct assessment of effective branch enforcement, protected-ref check bindings, required-job dependencies, partial provider observations, runner restrictions, and evidence-backed resource scope. Unsupported evaluators and unavailable proof remain visible; this change does not promise an all-green assessment.
- Repair existing setup and activation-kernel correctness: workflow-aware local baselines, explicit local retries, actual input binding, stable repository identity, phase-operation consistency, authoritative evidence selection, dependency alternatives, approval validity, and reviewed Git destinations. Unavailable production capabilities remain explicit blockers.
- Generate an explicit, one-time, project-owned Spec Kit bootstrap spec/plan/tasks bundle for new projects so local setup validates real artifacts rather than framework templates. Existing projects without that bundle receive a seed-adoption blocker; update, force, and assessment do not create missing seed files or invent completion.
- Fix supported starter configuration and container behavior, isolate generated infrastructure state per environment, avoid resource-name collisions, and wire the existing RAG publisher's configuration and permissions. Keep all nine GenAI pattern identities but label their actual starter capabilities and missing specialization honestly.
- Repair CLI input handling, prerequisite/version detection, migration inventories and target-specific tasks, filesystem and dependency-recovery safety, and effective scoped-registry handling during CLI upgrade.
- Preserve API/GenAI manifest readers v2-v7, existing ownership boundaries, and public contracts except for the explicitly declared retirement and versioned correctness changes. Activation identity/schema changes require explicit compatibility treatment; no fabricated history or implicit trust of placeholder receipts is permitted.
- Update canonical specifications, contributor guidance, user documentation, packaged assets, and cross-platform regression coverage together.

Production activation completion is **out of scope**: this change does not implement the missing cloud-provisioning or ruleset-mutation adapters, introduce public credential-enrollment or approval-persistence workflows, or deploy resources. It also does not implement missing RAG retrieval, conversation memory, agent tools, multi-agent coordination, prompt specialization, workflow execution, fine-tuning, or incremental streaming. Existing failures and misleading capability claims are repaired without expanding those product commitments.

## Capabilities

### New Capabilities

None. General-repository assessment extends the existing assessment capability; internal modularization is a required design and delivery constraint, not a new end-user engine.

### Modified Capabilities

- `liftoff-cli-workflow`: Remove retired inputs, make interactive and noninteractive decisions consistent, correct helper/discovery behavior, and expose general-repository assessment without weakening consent.
- `liftoff-power-apps-code-apps`: Remove all positive Power Apps workload requirements; direct retired projects to explicit unsupported-workload handling rather than a compatibility lane.
- `liftoff-project-scaffold`: Restrict generation to API/GenAI, add the explicit Spec Kit bootstrap seed, repair existing runtime/configuration/container boundaries, describe actual GenAI capabilities, and preserve selected-agent setup/assessment integration.
- `liftoff-standard-projects`: Keep the three API stacks while making documented configuration and container startup consistent.
- `liftoff-supported-stack-baselines`: Remove the Power Apps baseline and keep remaining runtime, package-manager, framework, and asset identities coherent.
- `liftoff-template-dependency-security`: Retire the Power Apps audit/refresh inventory while retaining deterministic dependency coverage for every remaining packaged template.
- `liftoff-infrastructure-governance`: Isolate newly generated environment state, make generated naming collision-resistant, and bind existing publisher configuration to least-privilege permissions without authorizing deployment.
- `liftoff-workstation-bootstrap`: Remove Power Apps prerequisites, include required package managers, and reject prereleases that do not satisfy stable release constraints.
- `liftoff-project-migration`: Preserve a complete evidence-based inventory, honor target overrides, and keep verification before legacy staging cleanup.
- `liftoff-template-ownership`: Preserve exact managed-core authority and API/GenAI provenance while retiring Power Apps support.
- `liftoff-manifest-contract`: Reject retired workload discriminators before deeper interpretation, preserve other v2-v7 readers, and make historical activation handling explicit.
- `liftoff-project-update`: Preserve discovery boundaries, concurrent edits and file modes, provide recoverable transactions, and never use force to bypass retirement or project ownership.
- `liftoff-project-doctor`: Report only supported workloads and trustworthy prerequisite/setup states without inventing readiness.
- `liftoff-cli-self-upgrade`: Resolve the effective scoped npm registry, preserve its policy, and accurately report metadata/installation failures.
- `liftoff-npm-distribution`: Remove retired package assets, preserve runtime asset resolution after modularization, and verify canonical/scoped delivery and historical release capabilities correctly.
- `liftoff-repository-governance-profile`: Keep the canonical policy and authority boundaries while removing retired workload context and making execution availability explicit.
- `liftoff-governance-activation-engine`: Correct existing baseline, evidence, readiness, approval, and execution contracts while retaining fail-closed production limitations.
- `liftoff-governance-assessment`: Support ordinary Git roots and correct classifications, effective enforcement coverage, observation independence, and trusted live scope.
- `liftoff-user-documentation`: Present two workloads, accurate starter/setup limits, any-Git assessment, explicit retirement guidance, and a maintainable contributor architecture.

## Impact

- The primary source changes concern `src/commands.ts`, `src/templates.ts`, `src/file-system.ts`, planning/catalog/workstation/migration/upgrade helpers, and the governance activation and assessment directories. The design will assign their actual implementations to focused modules while preserving the `dist/cli.js` package entry point.
- Power Apps source modules, vendored assets, package metadata, refresh/audit scripts, and CI jobs are removed through explicit inventories. Shared regression scenarios currently using Power Apps fixtures must move to supported workloads; retired manifests remain useful negative fixtures.
- Newly generated API/GenAI runtime, container, and infrastructure files may change. Existing project-owned files, dependency locks, deployment state, approvals, and immutable evidence are not adopted or rewritten by ordinary update or force.
- Consumers of newly generated artifact inventories must recognize the explicit flat-root OpenTofu retirement and new module/environment identities. Old identities remain readable as project provenance, not aliases for new paths or managed-core deletion targets; all other logical-name stability rules remain in force.
- General Git repositories gain local assessment, not project initialization, managed-file ownership, activation state, credential access, or broader live authority.
- Compatibility and release identity work is required because retirement is breaking and activation binding/transition semantics change. Publishing, Git operations, provider mutations, and live infrastructure migration are not part of artifact creation or implicitly authorized by this proposal.
