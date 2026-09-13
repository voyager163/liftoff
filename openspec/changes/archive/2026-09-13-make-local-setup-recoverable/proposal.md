## Why

Liftoff 0.11.3 can diagnose setup blockers without providing a supported way to resolve them or complete cloud and governance activation. Developers need one end-to-end setup journey that repairs project conformance, prepares the local workspace, implements approved Azure/GitHub activation, and can execute supported migrations of existing infrastructure state without manual metadata fabrication.

## What Changes

- Make the native `liftoff-setup` integration an end-to-end orchestrator: local preparation, separately reviewed publication/activation, cloud and governance implementation, and live verification. Local-ready remains a meaningful milestone and explicit local-only operation remains available.
- Keep local and activation command scopes distinct. A local-scoped operation cannot mutate cloud resources or publish Git history; the setup journey enters activation only through the required explicit approvals.
- Implement supported production activation phases rather than leaving executor placeholders: repository binding/publication, complete Phase 0 discovery, approval persistence, secure credential enrollment/readback, provider readiness, state/runner bootstrap, real application deployment, workflow and release proof, ruleset application, and live enforcement readback.
- Plan dependency-ready work before approval and expose a usable approval path, so an approval gate cannot prevent the very preview needed to obtain that approval.
- Add a project-aware `liftoff repair` flow for local infrastructure conformance, additive agent integrations, and separately authorized supported stateful migrations. Plans disclose exact file, backend, resource-address, permission, cost, and recovery scope.
- Execute supported existing-state migrations when source/target bindings, complete resource mappings, backups, locking/concurrency controls, plan approval, and post-migration verification are satisfied. Unknown state, unsupported transformations, ambiguous mappings, and missing authority remain explicit blockers, not inferred safety.
- Preserve project customizations and historical provenance. Publish repaired current inventory only after the corresponding local or stateful operation reaches its verified commit boundary; never fabricate evidence or ask developers to edit machine metadata.
- Distinguish verified activation from delayed lifecycle work such as retained-state disposal. A required retention period does not make a successfully activated project appear stuck, and cleanup remains tracked and safely executable when due.
- Accept compatible official stable or preview coding agents, with preview notices. Preserve tested runtime, package-manager, and framework constraints; availability of a newer release alone is not a blocker.
- Correct version-output parsing and machine-tool remediation. Distinguish missing executables, incompatible versions/channels, no-op installers, genuine PATH problems, and failed operations; do not recommend an unchanged ineffective installation repeatedly.
- Add Codex to interactive and noninteractive selection for OpenSpec and Spec Kit, alone or in any combination with Copilot and Claude. Support Codex as a Spec Kit default and use native project-local skills for framework, setup, and assessment integrations.
- Use one recorded-layout-aware expectation for assessment and managed-core update, and provide actionable, project-bound diagnostics rather than contradictory comparisons or invented recovery commands.
- **BREAKING (governance and execution contracts):** publish schema-2 results with local, activation, migration, and lifecycle progress; return post-operation readiness and honest partial outcomes. Version the changed phase ordering, permitted mutations, approval, and proof semantics through an explicit activation-contract successor instead of silently changing the current contract or retagging existing receipts.

## Capabilities

### New Capabilities

- `liftoff-project-repair`: Reviewed project-bound local and stateful repair plans, sensitive-state inspection consent, supported migration execution, additive integrations, provenance history, recovery checkpoints, and resumable verification.

### Modified Capabilities

- `liftoff-cli-workflow`: End-to-end setup, usable plan/approval/execution and recovery commands, strict scope boundaries, Codex selection, and truthful completion output.
- `liftoff-governance-activation-engine`: Production activation executors, dependency/approval planning, live proof, complete discovery, scoped recovery, lifecycle separation, and a versioned successor contract.
- `liftoff-infrastructure-governance`: Approved Azure provisioning, private execution/state readiness, real deployment artifacts, supported stateful conformance migrations, and verified current layout provenance.
- `liftoff-workstation-bootstrap`: Compatible preview agents, operation-relevant requirements, reliable version parsing, and outcome-aware installation/remediation.
- `liftoff-project-scaffold`: Three-agent official integrations and native setup/assessment handoffs that drive the approved full journey without confusing local readiness with deployed governance.
- `liftoff-manifest-contract`: Codex identities, successor activation identity, protected migration records, verified current provenance, and distinct local/deployed/lifecycle results.
- `liftoff-template-ownership`: Separate exact-plan local, stateful, and activation authorities without expanding ordinary update, force, or generation-hash ownership.
- `liftoff-project-update`: Preserve the core-update boundary, share current-layout expectations, and expose reviewed activation-contract migration separately from live infrastructure execution.
- `liftoff-governance-assessment`: Consistent managed-core comparison and current activation/state-migration readback without treating a plan or local completion as live proof.
- `liftoff-project-doctor`: Distinct local, activation, stateful-migration, recovery, lifecycle, and tool diagnoses with actual executable identity and supported actions.
- `liftoff-repository-governance-profile`: Executable supported policy controls, secure approval/credential handling, real qualification/enforcement proof, and the full native setup journey.
- `liftoff-user-documentation`: End-to-end setup, approval and sensitive-state boundaries, supported migration recipes, recovery, native Codex invocation, and truthful tool remediation.
- `liftoff-activation-migration`: Explicit history-preserving migration from existing activation identities to the revised execution contract; old approvals and proof are not silently reused as new authority.

## Impact

- CLI planning, approval, execution, credential-input, recovery, and lifecycle surfaces; native setup/assessment integrations; and installed-package command smoke coverage.
- The activation graph and operation/proof contracts, including the ordering needed to publish workflows and immutable application artifacts before their deployment/qualification depends on them.
- Production Azure and GitHub adapters, workload identity, runner/private-backend handling, source/image/workflow provenance, and current live readback.
- Infrastructure transformation, backend migration adapters, encrypted/private state workspaces, recoverable multi-step journals, current provenance, and immutable history. Cross-backend migration is not represented as an atomic filesystem transaction.
- Shared workstation probes/installers, agent catalogs and types, official framework adapters, configuration/manifest readers, framework path inventories, and project diagnostics.
- README and operator/developer documentation, compatibility fixtures, generated-artifact inventories, and macOS/Linux/Windows coverage.
- Supported cloud activation and stateful migration execution are implementation scope, but revising these artifacts does not authorize deployment, credential enrollment, state access, or changes to v365 or another downstream project.
- Arbitrary business-code replacement, arbitrary backend/provider combinations, unreviewed destructive resource changes, AWS/GCP activation, and blanket dependency/template upgrades remain outside the supported scope.
- The activation-migration delta defines the exact reviewed v1/v2-to-v3 control-record upgrade, preservation, revalidation, and resumption contract separately from OpenTofu-state migration.
