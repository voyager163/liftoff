## MODIFIED Requirements

### Requirement: CLI exposes deterministic governance setup commands
The CLI SHALL retain governance inspection/execution commands and add usable approval, secure credential enrollment, and recovery operations with strict arguments and schema-2 results. It SHALL accept explicit local, activation, and lifecycle scopes, default direct governance invocations to activation, and report journey/local/migration/activation/lifecycle progress separately. Dependency-ready planning SHALL not require an already granted approval. Executed-phase identity SHALL remain distinct from current next readiness, and no scope or JSON flag SHALL imply authorization.

#### Scenario: Run governance status outside a project
- **WHEN** no supported Liftoff manifest is resolvable, including an ordinary Git-only repository
- **THEN** setup commands fail with a project-root remedy without initializing or mutating anything

#### Scenario: Inspect governance identity
- **WHEN** governance JSON is requested
- **THEN** it identifies running CLI/executable, policy, activation-contract, schema, and graph identities without a separate setup-skill version
- **AND** recorded generator versions remain distinct from the running CLI

#### Scenario: Preview next transitions
- **WHEN** governance plan is requested
- **THEN** it reports dependency-ready plans, required authority, evidence, actual operations, and cost scope without executing them
- **AND** any external preview receipt is explicitly disclosed rather than confused with approval

#### Scenario: Apply a ready transition
- **WHEN** `apply-next --json --execute` selects an executable evidence-ready phase with satisfied approval
- **THEN** only allowlisted operations in the selected scope execute and successful state is persisted transactionally after outcome validation

#### Scenario: Preview a ready transition
- **WHEN** apply-next is called without `--execute`
- **THEN** it reports exact operations and the required flag without local or remote mutation

#### Scenario: Adapter returns a phase-forbidden terminal result
- **WHEN** an adapter returns an undeclared terminal result or incomplete required evidence
- **THEN** execution reports a blocker without persisting successful invalid evidence or authorizing descendants

#### Scenario: Verification is consistent before setup starts
- **WHEN** a supported project has no activation state and no inconsistent required artifacts
- **THEN** verification reports consistency with incomplete not-started selected scope and exits 2
- **AND** it identifies the next local boundary without manufacturing persisted state

#### Scenario: A valid bootstrap seed is still active
- **WHEN** a supported workflow's seed is intact with no competing work or contradictory finalization record
- **THEN** local setup remains incomplete rather than inconsistent merely because local finalization is pending
- **AND** publication remains separately approval-gated

#### Scenario: Active seed contradicts stored archive completion
- **WHEN** current state claims OpenSpec archival while the same seed remains active
- **THEN** verification reports an inconsistency instead of ordinary pending progress

#### Scenario: Verification cannot inspect state
- **WHEN** a required shared governance artifact is malformed
- **THEN** verification exits 1 with inconsistent, incomplete, indeterminate selected scope
- **AND** local scope does not hide malformed shared identity or state

#### Scenario: Resume after a blocker
- **WHEN** a developer resumes after repairing a blocker
- **THEN** resume recalculates selected-scope readiness without executing operations
- **AND** repaired local failures can be retried by separate explicit execution while unchanged verified work is not repeated

#### Scenario: Unsupported governance syntax is supplied
- **WHEN** a subcommand, flag, scope value, or positional combination is unsupported
- **THEN** it fails before project discovery or mutation

#### Scenario: Distinguish selection from post-transition readiness
- **WHEN** seed-valid executes successfully
- **THEN** `selectedPhase` and `executedPhase` identify seed-valid while `nextReadyPhase` reflects a new inspection of the selected scope
- **AND** failed execution names no successfully executed phase

#### Scenario: Explain an OpenSpec validation failure
- **WHEN** OpenSpec returns a safe failure diagnostic
- **THEN** the command and exit condition are explained with bounded text stripped of terminal controls

#### Scenario: Diagnostic includes credential-shaped content
- **WHEN** framework output contains credential-shaped content
- **THEN** it is withheld before truncation and never copied into reports or activation state

#### Scenario: Historical state requires reconciliation
- **WHEN** state uses a recognized but non-executable historical activation identity
- **THEN** commands explain the exact reconciliation or unavailable-migration blocker without rewriting history or recommending fabricated receipts

#### Scenario: Production capability is not implemented
- **WHEN** a required producer is absent from the advertised supported activation path
- **THEN** that path fails release qualification rather than shipping a placeholder as implemented
- **AND** genuinely unsupported external capabilities remain explicit limitations without invalidating completed local work

## ADDED Requirements

### Requirement: CLI offers Codex consistently across both workflows
Liftoff SHALL accept canonical agent `codex` alongside `github-copilot` and `claude` through interactive selection, CLI agent options, configuration, and manifest interpretation. It SHALL support each nonempty combination for OpenSpec and Spec Kit in stable canonical order. A Spec Kit default SHALL be exactly one selected agent; OpenSpec SHALL not acquire a default-agent requirement.

#### Scenario: Select Codex alone
- **WHEN** a supported workload selects Codex with either spec workflow
- **THEN** the resolved plan includes Codex and does not require Copilot or Claude integration files

#### Scenario: Select all three agents
- **WHEN** a developer selects Copilot, Claude, and Codex
- **THEN** interactive and noninteractive plans preserve all three without duplicates or two-agent assumptions

#### Scenario: Codex is the Spec Kit default
- **WHEN** a multi-agent Spec Kit request explicitly selects Codex as default
- **THEN** Codex is recorded as the default and the other selected integrations remain included

### Requirement: CLI exposes reviewed project repair without implicit authorization
The CLI SHALL expose `liftoff repair` for local and stateful plans with project selection, `--check`, scoped `--live`, additive-agent/default options, explicit sensitive-state inspection/read approval, exact apply approval, and reviewed recovery. JSON SHALL remain formatting only. Machine/dependency/global-profile permissions SHALL remain independent. Invalid combinations, conflicting paths, unselected defaults, force bypasses, state access without read authority, and expanded write scope SHALL fail before the affected operation.

#### Scenario: Preview without granting writes
- **WHEN** `liftoff repair --check --json` is invoked inside a supported project
- **THEN** it reports the actual project-bound plan and disclosed external receipt
- **AND** JSON formatting does not authorize any execution

#### Scenario: Noninteractive application lacks approval
- **WHEN** repair application has no current matching fingerprint in a noninteractive invocation
- **THEN** it exits 1 with the exact preview/approval remedy and performs no project write

#### Scenario: Add agents without replacing the current selection
- **WHEN** `--check --add-agents codex` is requested
- **THEN** the preview adds Codex to the existing set rather than removing other selected agents

#### Scenario: Commands remain portable and target-bound
- **WHEN** a repair action is printed for a Windows project whose path contains spaces
- **THEN** its executable, arguments, and working directory describe that exact project safely
- **AND** no `liftoff init` project-name argument is misrepresented as a temporary output directory

### Requirement: Governance verification reports selected-scope completion honestly
Schema-2 verification SHALL use exit 0 for a consistent complete selected scope, exit 2 for a consistent incomplete selected scope, and exit 1 for inconsistency or failed inspection. Successful status, plan, and resume inspection SHALL remain exit 0 even when they report incomplete work. A committed execution with failed post-operation inspection SHALL report committed progress and indeterminate readiness as a partial outcome.

#### Scenario: Local setup is complete while activation is pending
- **WHEN** local verification succeeds but publication or activation has not started
- **THEN** local-scoped verify exits 0 with local completion and separately reports pending activation

#### Scenario: Only one local phase is complete
- **WHEN** local state is consistent but further local work remains
- **THEN** local verify exits 2 without calling the project inconsistent or complete

#### Scenario: Readiness cannot be observed after commit
- **WHEN** an execution commits successfully but reinspection fails
- **THEN** the result retains the executed phase and failure detail
- **AND** it reports indeterminate next readiness rather than the executed phase as a future action

### Requirement: Setup drives the approved end-to-end journey
The single native setup integration SHALL guide supported projects through local readiness, required repair/migration, publication and activation planning, separately approved production execution, and live verification. It SHALL retain a local-only mode and allow the developer to decline later authority without losing local progress. An unqualified full-journey success SHALL require the requested immediate activation and migration work to be verified.

#### Scenario: Developer approves the full journey
- **WHEN** supported prerequisites are satisfied and the developer approves each required scope
- **THEN** setup continues beyond local preparation and implements the approved cloud/governance plan
- **AND** completion is based on real deployment and enforcement readback

#### Scenario: Developer declines activation
- **WHEN** local readiness is complete but later approval is declined
- **THEN** the result reports local completion and activation not performed
- **AND** it does not claim a deployed governed system

### Requirement: Approval credential and recovery commands are executable interfaces
Governance SHALL expose exact-plan approval persistence, protected credential enrollment, and recovery operations through its command registry. Approval SHALL not execute a plan. Credential input SHALL use private operator channels or approved secure references, never argv/chat values. Recovery SHALL use validated current conditions and the approved compensation boundary rather than force-unlocking or restoring arbitrary state.

#### Scenario: A dependency-ready phase awaits approval
- **WHEN** the phase has a complete plan but no valid approval
- **THEN** the CLI presents its fingerprint and the actual approval command
- **AND** the user is not asked to hand-create an approval file

#### Scenario: An automation caller enrolls a credential
- **WHEN** approved enrollment uses explicitly selected protected stdin or a supported secure reference
- **THEN** the value is excluded from command arguments, output, evidence, and source files

#### Scenario: A migration is partially executed
- **WHEN** recovery is requested for recorded partial effects
- **THEN** the CLI identifies the current checkpoint and exact permitted recovery plan
- **AND** it does not automatically re-run the original mutation
