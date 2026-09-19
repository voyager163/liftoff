## Purpose

Define the capability ownership, public protocol, and shared execution guarantees that make Liftoff's complete project lifecycle usable without duplicating mutation authority or model reasoning.

## Requirements

### Requirement: Capabilities have six explicit engine owners
Liftoff SHALL remain one TypeScript modular application with exactly six logical capability engines: Standards and Assessment, Project Generation, Project Evolution, Repository Governance, Azure Activation, and Distribution and CLI Upgrade. Every public capability SHALL identify one of those owners. A shared execution kernel SHALL enforce common admission, approval, execution, verification, and recovery guarantees; it SHALL NOT constitute a seventh capability engine or a separately deployed service. Command routing and host integrations SHALL NOT bypass these boundaries through a second execution implementation.

#### Scenario: Inspect lifecycle ownership
- **WHEN** a caller inspects the installed capability registry
- **THEN** assessment, generation, evolution, repository governance, Azure activation, and installation maintenance resolve to their declared engine owners
- **AND** shared execution is identified as common infrastructure rather than an additional product engine

#### Scenario: Two commands reach the same effect
- **WHEN** a direct command and an agent-assisted workflow request the same registered project operation
- **THEN** both use the same deterministic admission and execution guarantees
- **AND** changing the entry point does not expand the operation's authority

### Requirement: The public protocol exposes qualified capabilities truthfully
New public command and capability envelopes SHALL use schema 1 independently from each referenced command's result/report contract. The new envelope SHALL NOT require existing CLI JSON bodies to be relabeled or wrapped as schema 1; command-specific schema changes SHALL require an explicit declared contract change. Each capability SHALL declare its stable identity, owning engine, supported profiles and platforms, required inputs, command result/report schema, command-specific authorization mechanism and consent requirements, planner, executor, verifier, recovery behavior, effect classes, compatibility identities, and qualification state. Missing prerequisites, unsupported scope, missing implementation, and missing qualification SHALL be distinguishable. Read-only capabilities SHALL explicitly declare the absence of mutation and whether recovery is inapplicable. Registry presence, generated instructions, a planner, or a mock SHALL NOT establish an executable or qualified capability.

#### Scenario: A planner exists without a production executor
- **WHEN** a capability can inspect and plan but lacks its required executor
- **THEN** capability output identifies planning as available and execution as unavailable
- **AND** no executable continuation or completed-release claim is issued for the missing implementation

#### Scenario: A qualified executor lacks local prerequisites
- **WHEN** a registered executor is qualified but the selected project lacks an exact required tool or target binding
- **THEN** the result identifies the missing prerequisite separately from implementation availability
- **AND** it offers only a supported scoped remedy without silently installing tools or choosing a target

#### Scenario: A required platform remains unqualified
- **WHEN** an advertised required capability has not passed qualification for a supported host or provider combination
- **THEN** that combination remains explicitly unqualified and blocks coordinated release completion
- **AND** a passing fixture or another platform's result is not substituted for its evidence

#### Scenario: An unknown protocol is requested
- **WHEN** a caller supplies an unsupported envelope, capability, or schema identity
- **THEN** admission reports the found identity, supported identities, and remedy before effects
- **AND** numeric version ordering does not imply compatibility

#### Scenario: Shared capability discovery describes existing repair
- **WHEN** a schema-1 capability envelope describes the current repair command
- **THEN** it identifies repair contract 1 and report schema 2 as separate unchanged identities
- **AND** invoking that command retains its schema-2 report body rather than relabeling or wrapping it as schema 1

#### Scenario: Governance explicitly changes its output contract
- **WHEN** the coordinated release emits current governance setup or execution results
- **THEN** those command bodies use their explicitly declared output schema 3 and selected-scope semantics
- **AND** schema-1 capability discovery neither replaces that body contract nor changes stored historical results

### Requirement: One execution kernel preserves existing operation guarantees
New engine workflows SHALL reuse the released update and repair transaction, application-patch, private-workspace, verification, locked-preparation, process-settlement, backup, and readback contracts rather than introduce a parallel mutation framework. Each workflow SHALL follow its registered inspection, proposal validation, immutable review, command-specific authorization, execution, independent verification, and recovery requirements where applicable. The kernel SHALL preserve established authorization mechanisms rather than impose one approval flag, external preview receipt, or second Liftoff confirmation on every command. It SHALL bind exact inputs, scope, effects, applicable expiry, implementation identities, and current preconditions, and SHALL coordinate conflicting project writers.

#### Scenario: Adoption includes an application patch
- **WHEN** a supported adoption proposes project-file changes
- **THEN** its application effects use the existing explicit per-file patch and staged-verification guarantees
- **AND** adoption metadata is a separately declared producer, not an exemption from the application patch's protected-file exclusions

#### Scenario: Another project transaction is unfinished
- **WHEN** a requested operation overlaps an unfinished update, repair, or adoption transaction
- **THEN** admission reports the exact recovery or concurrency blocker before new writes
- **AND** choosing a different command cannot bypass the pending transaction

#### Scenario: A reviewed input changes
- **WHEN** a protected source, destination, mode, directory inventory, configuration binding, tool, or recipe differs from the immutable reviewed plan
- **THEN** the operation stops before further effects and requires renewed review
- **AND** it does not silently recompute a different plan under the existing approval

#### Scenario: Routine upgrade uses its established authorization
- **WHEN** the dedicated owner-preserving `liftoff upgrade` command is explicitly invoked through the shared kernel in terminal, redirected, or JSON mode
- **THEN** its invocation authorizes only the exact internally bound validated target through the proven current owner without a second Liftoff confirmation or fingerprint flag
- **AND** changed or unproven ownership and target facts block execution rather than authorize owner migration, elevation, or a substituted target

#### Scenario: Migration and reviewed workflows retain separate approval
- **WHEN** installation-owner migration or a reviewed project/provider workflow is requested
- **THEN** it still requires its own current exact plan and separate default-No interactive approval or registered exact machine authorization
- **AND** a routine upgrade invocation or shared capability envelope supplies none of that authority

### Requirement: Model hosts propose while deterministic commands control execution
Liftoff SHALL accept proposals from Copilot, Claude Code, Codex, or direct callers only as untrusted requested changes. The CLI SHALL independently validate identities, mappings, compatibility, supported effects, required authority, and actual outcomes. The CLI SHALL neither embed an LLM SDK/client nor require model selection or model credentials for deterministic operations. This restriction SHALL NOT remove the separately declared model runtime of generated GenAI applications. Host permissions and CLI admission SHALL remain distinct from skill instructions.

#### Scenario: A model asserts that a project is safe
- **WHEN** a proposal claims approval, conformance, or successful provider execution without the required independently validated evidence
- **THEN** the CLI rejects the unsupported claim
- **AND** model confidence or prose does not satisfy an approval or verification gate

#### Scenario: No coding agent is installed
- **WHEN** a developer invokes a supported deterministic command without an agent host or model credentials
- **THEN** the command remains usable subject only to its declared operation prerequisites
- **AND** Liftoff does not acquire or invoke a hidden model client

#### Scenario: A host can execute unrelated tools
- **WHEN** an agent host grants access to tools outside Liftoff
- **THEN** Liftoff describes its guarantees as applying to admitted Liftoff operations
- **AND** it does not claim that prompt metadata restricts the host's other tools

### Requirement: Approval is action-specific and bound without manual hash entry
Normal interactive reviewed execution SHALL show the immutable plan and request a genuine action-specific Yes/No approval with default No. The CLI SHALL bind that decision internally to the exact fingerprint without requiring the developer to copy or type it. Operations requiring a separate approved plan SHALL require their registered exact-plan flags and permissions for machine execution. Existing initialization decision and consent flags SHALL retain only their documented narrow authority. Explicit invocation of routine owner-preserving `liftoff upgrade` SHALL retain its command-specific authorization for the internally bound verified target without an additional Liftoff confirmation or fingerprint flag; it SHALL NOT authorize installation migration, elevation, or project work. JSON, non-TTY input, piped answers, autopilot, generic requests, and model-generated approval SHALL NOT independently imply authorization. File writes, project-code execution, dependency preparation, lifecycle hooks, network access, Git publication, repository controls, and cloud or state effects SHALL remain independently authorized.

#### Scenario: A developer approves an interactive plan
- **WHEN** a genuine terminal interaction explicitly approves the displayed current effects
- **THEN** only that internally fingerprint-bound plan can proceed after its locked precondition checks
- **AND** the developer is not required to enter a hash

#### Scenario: Automated execution lacks a permission
- **WHEN** JSON or noninteractive execution supplies a plan identity but omits a required action-specific permission
- **THEN** the missing authority is reported before that action starts
- **AND** another permission or a supplied Yes cannot fill the gap

#### Scenario: File approval is declined after verification
- **WHEN** separately authorized preparation or verification has already run and the developer declines the file transaction
- **THEN** the planned file transaction does not run
- **AND** the result reports earlier private or host effects rather than claiming that nothing happened

### Requirement: Continuations preserve exact execution context
Every executable continuation in help-derived remedies, human output, JSON, and `nextActions` SHALL preserve `executable`, separate `args`, `cwd`, selected `scope`, canonical `project` when applicable, an exact installation or user-scope target when applicable, configuration reference and digest binding, required approval, and compatibility identity. Human commands SHALL be native-shell-safe projections of that context. A relative configuration reference SHALL remain bound to the original resolved input when a continuation changes directories. Credentials SHALL appear only as opaque protected references, never values in arguments or reports.

Protocol admission SHALL resolve omitted governance setup/execution scope to the existing `activation` default and preserve that resolved scope in results and continuations. Repository-only scope SHALL require explicit selection; a protocol adapter, host projection, or completed repository path SHALL NOT silently narrow an existing caller's activation request.

#### Scenario: A continuation changes working directory
- **WHEN** an invocation uses a relative inputs file and its next action executes from the selected project root
- **THEN** the action still selects the same canonical input file and reviewed digest
- **AND** a changed file requires renewed planning instead of losing the configuration flag

#### Scenario: Native paths contain spaces or metacharacters
- **WHEN** a continuation targets Windows drive or UNC paths, or macOS or Linux paths containing spaces or shell metacharacters
- **THEN** separate arguments preserve literal path identity and the human display uses the supported native shell's quoting
- **AND** textual prefixes, case similarity, or ambiguous aliases cannot substitute for canonical boundary equality

#### Scenario: A user-scope operation has no project
- **WHEN** skills or installation management emits a continuation before project initialization
- **THEN** the action explicitly identifies its user or installation scope and target without inventing a project
- **AND** running it from a different repository cannot redirect its effects into that repository

#### Scenario: A governance caller omits scope
- **WHEN** an existing caller requests governance setup, planning, inspection, execution, or verification without selecting a scope
- **THEN** protocol routing retains activation as the effective scope and carries it into applicable next actions
- **AND** available repository-only completion does not change the requested success boundary

### Requirement: Results distinguish actual effects from verified completion
Results SHALL distinguish inspection, planning, preparation, checks, committed effects, verification, cleanup, and remaining work. Success SHALL cover only the selected scope for which required current evidence exists. Failed or uncertain process settlement SHALL block success receipts and unsafe workspace cleanup on Windows, macOS, and Linux. Private staging and sanitized environments SHALL NOT be described as an OS or network sandbox, and a required unavailable isolation guarantee SHALL block execution.

#### Scenario: A command exits zero without independent proof
- **WHEN** a project check or provider command exits zero but required outcome validation is absent
- **THEN** the result records only the observed command outcome
- **AND** it does not claim complete application safety, repository enforcement, deployment, or release qualification

#### Scenario: Windows descendants remain active
- **WHEN** the registered Windows controller cannot establish settlement of the exact owned process tree
- **THEN** completion and cleanup remain blocked with the causal host or settlement issue
- **AND** the workspace and recovery identity remain available without weakening host execution policy

#### Scenario: A provider operation partially completes
- **WHEN** approved external effects occur before a later failure
- **THEN** the result names verified effects, uncertain effects, and the registered remaining recovery scope
- **AND** it does not promise cross-provider atomic rollback or remove unrelated protections

### Requirement: Execution history retains operation-specific formats
The shared protocol SHALL adapt rather than globally convert command reports or persisted operation records. Repair contract 1, current report schema 2, and unchanged current schema-2 repair records SHALL retain their meanings; registered historical update and repair journals SHALL retain their original serializers, identities, and external approval requirements. New adoption and installation-migration records SHALL have independent schema-1 identities. Recovery compatibility SHALL authorize only the original recorded effects under current confinement and concurrency checks, never a new plan or retagged proof.

#### Scenario: Recover a registered historical repair
- **WHEN** an old sealed journal matches an explicit recovery registration and its current preconditions hold
- **THEN** recovery handles only that journal's attributable operations using its original semantics
- **AND** history is not rewritten into a new universal envelope

#### Scenario: A future or unregistered journal is present
- **WHEN** recovery finds an unknown schema, recipe, or operation identity
- **THEN** it reports the exact unsupported combination and preserves the record
- **AND** a new preview, force option, or newer CLI version cannot authorize guessed recovery

#### Scenario: A recorded disposable path changes identity
- **WHEN** an exact registered temporary path becomes a symlink, junction, case-colliding alias, or another directory on a supported platform
- **THEN** recovery refuses modification or deletion and preserves the evidence needed for review
- **AND** no prefix, glob, expiry, or bare PID grants cleanup authority
