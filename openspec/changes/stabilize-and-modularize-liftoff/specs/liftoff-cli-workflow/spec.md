## MODIFIED Requirements

### Requirement: Liftoff exposes a Node-based CLI
The system SHALL provide a Node.js command-line interface named `liftoff` using the release-owned supported Node.js baseline, which requires Node.js 24.20 or newer for this release. It SHALL be installable from `@msn-control/liftoff` without requiring Python to start the generator. The initialization command SHALL be `liftoff init`, and `liftoff create` SHALL NOT remain an alias.

#### Scenario: Run init command
- **WHEN** a developer runs `liftoff init`
- **THEN** the initialization flow starts without requiring Python merely to start Liftoff

#### Scenario: Run non-interactive init command
- **WHEN** a developer runs `liftoff init my-app --pattern rag --cloud azure --region eastus --spec openspec --agents copilot --no-frontend --yes`
- **THEN** the system resolves the provided options without prompting for framework, API framework, infrastructure tool, database, cache, observability, or developer portal choices

#### Scenario: Obsolete create command is rejected
- **WHEN** a developer runs `liftoff create`
- **THEN** Liftoff exits 1 without project or machine side effects and identifies `liftoff init` as its replacement

#### Scenario: Run CLI after global npm install
- **WHEN** a developer installs Liftoff with `npm install -g @msn-control/liftoff@latest`
- **THEN** `liftoff` is available from the shell and `liftoff help` displays command help

### Requirement: CLI captures required project decisions
The system SHALL capture project name, supported project type, spec workflow, and one or more coding agents before generation. GenAI SHALL capture pattern, provider, region, frontend, and environments using the approved Python/FastAPI/PydanticAI stack, with the explicit generic pattern as default. Standard API SHALL capture one approved API stack and applicable cloud/frontend/environment decisions without a GenAI pattern. Supplied options SHALL retain the same meaning in interactive and noninteractive flows. Spec Kit with multiple agents SHALL require exactly one selected default agent. Power Apps SHALL NOT be offered as a supported workload.

#### Scenario: Interactive GenAI project decisions
- **WHEN** a developer selects GenAI with missing options
- **THEN** the system prompts for missing common decisions, offers `I'm not sure yet - Generic GenAI starter` before specializations, and captures applicable cloud decisions and agents
- **AND** accepting the pattern and workflow defaults selects generic and OpenSpec

#### Scenario: Interactive standard project decisions
- **WHEN** a developer selects a standard project with missing options
- **THEN** the system prompts for missing common decisions, API stack, cloud decisions, and agents without requesting a GenAI pattern

#### Scenario: Interactive Power Apps project decisions
- **WHEN** a developer supplies the retired Power Apps workload to an interactive flow
- **THEN** Liftoff reports that the workload is unsupported instead of offering its former decisions or generating files

#### Scenario: Approved GenAI stack is not prompted
- **WHEN** the CLI prompts for a GenAI project's decisions
- **THEN** PydanticAI with FastAPI remains the derived stack rather than another framework question

#### Scenario: Approved standard framework is derived from API stack
- **WHEN** a developer selects an approved API stack
- **THEN** its language and framework are identified without a separate framework-selection question

#### Scenario: Both agents are selected for Spec Kit
- **WHEN** GitHub Copilot and Claude Code are selected with Spec Kit for a supported workload
- **THEN** exactly one selected agent is chosen as default before generation

#### Scenario: Explicit standard flag is honored while prompting
- **WHEN** a developer supplies `--no-genai` without an API stack and answers the remaining prompts
- **THEN** the workload remains standard and the CLI asks for the API stack rather than offering a conflicting GenAI default

### Requirement: CLI supports all approved GenAI patterns
The system SHALL retain the nine stable pattern identities for generic, RAG, chatbot, agent, prompt, multi-agent, fine-tuned, streaming, and workflow starters. Interactive and noninteractive uncertainty SHALL resolve to `generic`. Pattern listings and previews SHALL describe actual starter maturity and missing specialization rather than implying that selecting a named pattern implements its complete product behavior.

#### Scenario: Select generic pattern
- **WHEN** a developer chooses the generic option or supplies `--pattern generic`
- **THEN** the system records the explicit generic identity and a neutral project plan

#### Scenario: Select RAG pattern
- **WHEN** a developer selects RAG
- **THEN** the plan identifies its retrieval and ingestion scaffold boundaries and distinguishes implemented publishing from deferred retrieval behavior

#### Scenario: Select each supported pattern
- **WHEN** a developer selects any of the nine patterns
- **THEN** it maps to its explicit scaffold definition and accurate capability limitations

### Requirement: CLI resolves human-friendly deployment regions
The system SHALL resolve exact region slugs and human-friendly aliases for supported providers. An exact `regions --region` filter SHALL restrict output to its resolved region rather than only changing the heading. Unsupported exact values SHALL produce corrective guidance instead of an unrelated complete region list.

#### Scenario: Ambiguous interactive region
- **WHEN** a developer enters `korea` during interactive Azure initialization
- **THEN** the system presents the matching Korean regions and requires a selection

#### Scenario: Ambiguous non-interactive region
- **WHEN** a noninteractive initialization supplies `--region korea`
- **THEN** it stops before generation and lists the matching explicit region slugs

#### Scenario: Default Azure region
- **WHEN** the default Azure region is accepted
- **THEN** the system uses East US with slug `eastus`

#### Scenario: Filter a known region
- **WHEN** a developer runs `liftoff regions --region westus2`
- **THEN** output identifies West US 2 without listing unrelated regions

### Requirement: CLI previews generation before writing files
The system SHALL provide workload-aware interactive and standalone plan previews for API/GenAI projects. Previews SHALL include selected agents, applicable Spec Kit default, generated boundaries, starter limitations, and workstation requirements without installing tools or writing project files. Retired workload requests SHALL fail rather than render a former Power Apps plan.

#### Scenario: Interactive GenAI plan confirmation
- **WHEN** a developer completes GenAI decisions
- **THEN** the preview identifies workload, stack, pattern, provider, region, environments, frontend, local stack, infrastructure, workflow, agents, and tools before confirmation

#### Scenario: Interactive standard plan confirmation
- **WHEN** a developer completes standard API decisions
- **THEN** the preview identifies applicable API, cloud, environment, frontend, local stack, infrastructure, workflow, agent, and tool decisions without a GenAI pattern

#### Scenario: Interactive Power Apps plan confirmation
- **WHEN** an interactive request identifies the retired Power Apps workload
- **THEN** the CLI reports unsupported workload and never presents a Power Apps generation confirmation

#### Scenario: Standalone GenAI plan command
- **WHEN** a developer runs `liftoff plan --pattern rag --cloud azure --frontend --agents copilot,claude`
- **THEN** files, components, agents, requirements, and actual starter limitations are shown without creating a project or installing tools

#### Scenario: Standalone standard plan command
- **WHEN** a developer runs `liftoff plan --no-genai --api node --cloud azure`
- **THEN** it previews Node.js/Fastify output, default Copilot integration, and applicable requirements without writes

#### Scenario: Standalone Power Apps plan command
- **WHEN** a developer runs `liftoff plan --type power-apps-code-app`
- **THEN** it exits 1 with explicit retirement guidance without loading or rendering a Power Apps starter

### Requirement: CLI supports compatible non-interactive project-type inputs
The system SHALL accept `--type genai|standard`, retain `--genai`, `--no-genai`, pattern and API-stack inference, and support selected-agent lists and applicable defaults. Contradictory or inapplicable options SHALL fail before preparation or generation. Power Apps type requests and the removed Code Apps plugin flags SHALL be rejected rather than ignored or mapped to another workload.

#### Scenario: Existing GenAI options remain valid under init
- **WHEN** initialization supplies a GenAI pattern and valid common options without an explicit type
- **THEN** it infers GenAI with the approved Python API stack and default Copilot integration

#### Scenario: Initialize a standard Node.js project non-interactively
- **WHEN** initialization supplies `--no-genai --api node --cloud azure --region eastus --spec openspec --agents copilot,claude --no-frontend --yes`
- **THEN** it resolves Node.js/Fastify and both agents without project-decision prompts

#### Scenario: Initialize a Power Apps project noninteractively
- **WHEN** initialization supplies `--type power-apps-code-app`
- **THEN** it exits 1 with an unsupported-workload explanation before tool installation or generation

#### Scenario: Select a Spec Kit default agent non-interactively
- **WHEN** Spec Kit receives both agents and `--default-agent claude`
- **THEN** both integrations are selected and Claude Code is the default

#### Scenario: Missing Spec Kit default agent is rejected
- **WHEN** a noninteractive Spec Kit request selects multiple agents but no default
- **THEN** it exits 1 before preparation and identifies the missing default choice

#### Scenario: Reject conflicting project decisions
- **WHEN** a developer combines `--no-genai` with a GenAI pattern
- **THEN** the CLI stops before generation and explains the contradiction

#### Scenario: Reject an inapplicable Power Apps option
- **WHEN** a retired Power Apps request also contains former API, cloud, region, frontend, or environment options
- **THEN** it fails as an unsupported workload rather than attempting a partially applicable Power Apps plan

#### Scenario: Reject Code Apps plugin for another workload
- **WHEN** any request supplies a removed Code Apps plugin flag, including a false or negated form
- **THEN** argument validation reports the retired option and performs no preparation or project write

#### Scenario: Reject Power Apps migration in this release
- **WHEN** migration requests the retired Power Apps workload
- **THEN** it exits 1 before source copying or destination writes
- **AND** does not recommend creating a fresh Power Apps project with this CLI

#### Scenario: Reject an inapplicable default agent
- **WHEN** OpenSpec receives `--default-agent` or a Spec Kit default is not selected
- **THEN** the CLI exits 1 with corrective guidance before preparation or generation

### Requirement: Packaged README documents the current CLI lifecycle
The system SHALL package a concise root README covering first use, the two supported workloads, workflow/agent integrations, exact-Git-root initialization, safety, diagnostics, and links to detailed lifecycle contracts. It SHALL distinguish any-Git assessment from project-required mutation commands and unfinished production activation.

#### Scenario: Review first-use workflow
- **WHEN** a developer reads the packaged or repository README
- **THEN** installation and interactive initialization lead the guide
- **AND** GenAI/API, OpenSpec/Spec Kit, and Copilot/Claude are presented without Power Apps as a supported workload

#### Scenario: Review command lifecycle
- **WHEN** a developer needs the roles of plan, initialization, migration, validation, doctor, update, development, or infrastructure helpers
- **THEN** linked packaged guidance explains those commands and the replacement of `create` by `init`

#### Scenario: Understand initialization safety
- **WHEN** a developer follows initialization safety guidance
- **THEN** transactional staging, target behavior, conflict disclosure, manifest guards, and independent consent flags remain discoverable

#### Scenario: Understand update safety
- **WHEN** a developer follows update guidance
- **THEN** it retains safe managed-core apply, read-only check, protected project files, create-only expansion, separate production migration, JSON/exit contracts, removed `--apply`, and accurate conflict/recovery guidance

#### Scenario: Understand machine-readable and exit-code behavior
- **WHEN** a developer reads the linked CLI contract
- **THEN** it distinguishes check-mode drift exit 2 from successful apply exit 0 and identifies numeric JSON schema versions

#### Scenario: Review contributor workflow
- **WHEN** a contributor follows the contribution link
- **THEN** root build, test, check, package-smoke, and release procedures remain documented without a workspace selector

### Requirement: CLI syntax is command-specific and strict
The system SHALL validate commands, subcommands, positionals, flags, and catalog inputs against explicit definitions. Invalid or removed inputs MUST exit 1 with their token/combination identified and without project, workstation, or provider mutations. Interactive prompting SHALL NOT discard invalid supplied values before validation.

#### Scenario: Reject a misspelled init flag
- **WHEN** an unknown flag such as `--cluod` or `--frontned` is supplied
- **THEN** the CLI exits 1 rather than generating from fallback defaults

#### Scenario: Reject the removed command
- **WHEN** `liftoff create` is supplied
- **THEN** it exits 1, recommends initialization, and does not prepare the workstation

#### Scenario: Reject removed update apply flag
- **WHEN** `liftoff update --apply` is supplied
- **THEN** it exits 1, recommends plain update, and performs no project access

#### Scenario: Reject force in check mode
- **WHEN** `liftoff update --check --force` is supplied
- **THEN** it exits 1 with separate check/apply guidance and no project write

#### Scenario: Reject an unsupported helper subcommand
- **WHEN** `liftoff dev destroy` is supplied
- **THEN** it reports supported subcommands instead of printing a default recipe

#### Scenario: Reject an unsupported region subcommand
- **WHEN** `liftoff regions typo` is supplied
- **THEN** it exits 1 rather than listing all regions

#### Scenario: Render a missing-value error without a stack trace
- **WHEN** a value flag such as `--agents` has no value
- **THEN** concise usage guidance replaces a JavaScript stack trace

#### Scenario: Reject an invalid agent list
- **WHEN** an agent list is empty or includes an unknown identifier, even while other decisions need prompts
- **THEN** the CLI exits 1 before preparation or generation and lists supported identifiers
- **AND** does not silently discard the unknown identifier

#### Scenario: Show command-specific help
- **WHEN** a supported command receives `--help`
- **THEN** it exits 0 with supported syntax without checking required project options or probing tools

### Requirement: Configuration files are runtime-validated
The system SHALL validate configuration field names, types, workload, and applicability before merging valid configuration with flags. Catalog-backed strings SHALL resolve explicitly, booleans SHALL be JSON booleans, and lists SHALL contain supported strings. Retired workload/plugin configuration SHALL fail before preparation or generation rather than be ignored.

#### Scenario: Reject a string boolean
- **WHEN** configuration contains `"includeFrontend": "false"`
- **THEN** it identifies the field's required Boolean type and does not generate a project

#### Scenario: Reject a non-string catalog value
- **WHEN** configuration supplies a non-string type, stack, pattern, provider, region, or workflow
- **THEN** it names the invalid field rather than exposing a JavaScript type error

#### Scenario: Reject an invalid environment list
- **WHEN** environments are not an array of supported strings
- **THEN** the invalid field is reported without a write

#### Scenario: Reject Power Apps API fields
- **WHEN** configuration identifies Power Apps, with or without former API-related fields
- **THEN** the CLI rejects the retired workload before preparation or generation

#### Scenario: Flags override a valid configuration
- **WHEN** a valid flag overrides compatible valid configuration
- **THEN** documented flag precedence is preserved

#### Scenario: Reject retired plugin configuration
- **WHEN** configuration includes the removed Code Apps plugin preference
- **THEN** the CLI reports the retired field instead of silently ignoring it

### Requirement: Project-scoped helpers are workload-aware
The system SHALL derive validation and printed-only helper behavior from supported workload identity and recorded generation context. API/GenAI projects SHALL receive applicable Docker Compose and environment-correct OpenTofu guidance. Recognized retired manifests SHALL be rejected without alternative Power Apps tooling or infrastructure guidance.

#### Scenario: Show Power Apps development command
- **WHEN** `liftoff dev` resolves a retired Power Apps manifest
- **THEN** it reports unsupported workload rather than printing its former development command

#### Scenario: Power Apps infrastructure is not applicable
- **WHEN** `liftoff infra` resolves a retired Power Apps manifest
- **THEN** it reports unsupported workload rather than a successful not-applicable result

#### Scenario: Validate a Power Apps project
- **WHEN** validation resolves a retired Power Apps manifest
- **THEN** it exits 1 without validating the former starter or modifying any application file

#### Scenario: Supported API helper remains printed-only
- **WHEN** a supported API/GenAI project requests a development recipe
- **THEN** the applicable Compose command is printed without execution

### Requirement: CLI exposes deterministic governance setup commands
The CLI SHALL retain governance `status`, `plan`, `apply-next`, `resume`, and `verify` with strict arguments, supported-project discovery, versioned output, and independent consent. Selected/executed phase fields and legacy `nextReadyPhase` selection semantics SHALL remain distinct from post-transition readiness. Commands SHALL distinguish current executable identity, historical diagnostic-only identity, incomplete progress, inconsistency, and unavailable capabilities. Safe bounded framework diagnostics SHALL remain available without credential leakage.

#### Scenario: Run governance status outside a project
- **WHEN** no supported Liftoff manifest is resolvable, including an ordinary Git-only repository
- **THEN** setup commands fail with a project-root remedy without initializing or mutating anything

#### Scenario: Inspect governance identity
- **WHEN** governance JSON is requested
- **THEN** it identifies CLI, policy, activation-contract, schema, and graph identities without a separate setup-skill version

#### Scenario: Preview next transitions
- **WHEN** governance plan is requested
- **THEN** it reports phase readiness, executor availability, evidence, approvals, allowed mutations, and cost scope without writes

#### Scenario: Apply a ready transition
- **WHEN** `apply-next --json --execute` selects an executable evidence-ready phase with satisfied approval
- **THEN** only allowlisted operations execute and successful state is persisted transactionally after outcome validation

#### Scenario: Preview a ready transition
- **WHEN** apply-next is called without `--execute`
- **THEN** it reports exact operations and the required flag without local or remote mutation

#### Scenario: Adapter returns a phase-forbidden terminal result
- **WHEN** an adapter returns an undeclared terminal result or incomplete required evidence
- **THEN** execution reports a blocker without persisting successful invalid evidence or authorizing descendants

#### Scenario: Verification is consistent before setup starts
- **WHEN** a supported project has no activation state or inconsistent artifacts
- **THEN** verification reports `ok: true`, `consistent: true`, `complete: false`, and `setupStatus: not-started`
- **AND** identifies the next local boundary without manufacturing persisted state

#### Scenario: A valid bootstrap seed is still active
- **WHEN** a supported workflow's seed is intact with no competing work or contradictory finalization record
- **THEN** setup remains incomplete rather than inconsistent merely because local finalization is pending
- **AND** publication remains approval-gated

#### Scenario: Active seed contradicts stored archive completion
- **WHEN** current state claims OpenSpec archival while the same seed remains active
- **THEN** verification reports an inconsistency instead of ordinary pending progress

#### Scenario: Verification cannot inspect state
- **WHEN** a required governance artifact is malformed
- **THEN** verification reports `ok: false`, `consistent: false`, `complete: false`, and indeterminate setup

#### Scenario: Resume after a blocker
- **WHEN** a developer resumes after repairing a blocker
- **THEN** resume recalculates preflight/readiness without executing operations
- **AND** repaired local failures can be retried by a separate explicit execution while unchanged verified work is not repeated

#### Scenario: Unsupported governance syntax is supplied
- **WHEN** a subcommand, flag, or positional combination is unsupported
- **THEN** it fails before project discovery or mutation

#### Scenario: Distinguish selection from post-transition readiness
- **WHEN** seed-valid executes successfully
- **THEN** selectedPhase and executedPhase identify that phase, while subsequent status/verify supplies post-transition readiness
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
- **WHEN** a selected phase requires an unavailable executor or public approval/credential workflow
- **THEN** the CLI identifies the missing capability and stops rather than pretending completion or requesting manual state fabrication

### Requirement: CLI exposes a strictly read-only governance assessment
The CLI SHALL expose `liftoff governance assess [path] [--json] [--live]` and the alternative `--project` target for supported Liftoff projects and ordinary Git repositories. It SHALL default to local-only assessment without requiring initialization or a generated slash command. Only assess SHALL accept `--live`; mutation, installation, automatic-upgrade, and output-file flags SHALL remain invalid. All assessment invocations SHALL remain excluded from telemetry and disclosure.

#### Scenario: Run a local assessment
- **WHEN** local assessment runs in a supported Liftoff project
- **THEN** it returns local observations without network requests or project writes and marks unavailable live proof explicitly

#### Scenario: Request live comparison
- **WHEN** `--live` is supplied
- **THEN** only supported bounded reads for validated scope are permitted, without enrollment or remediation

#### Scenario: Reject mutation flags
- **WHEN** execution, force, installation, upgrade, or output-file flags are supplied to assessment
- **THEN** they fail before project discovery, network requests, or writes

#### Scenario: Reject misplaced live flag
- **WHEN** another governance subcommand receives `--live`
- **THEN** parsing rejects it instead of broadening that command

#### Scenario: Show help without a project
- **WHEN** assessment help is requested outside a project
- **THEN** local/live behavior, ordinary-Git support, limitations, and exits are described without project, credential, or telemetry discovery

#### Scenario: Resolve a project on supported operating systems
- **WHEN** assessment starts in a nested directory or receives a path containing spaces on Windows, macOS, or Linux
- **THEN** it resolves the intended supported project or Git boundary using safe native paths
- **AND** rejects simultaneous positional and `--project` targets

#### Scenario: Assess Liftoff's own source repository
- **WHEN** assessment runs in an ordinary Git repository with no Liftoff manifest
- **THEN** it assesses available facts against the displayed installed policy and reports absent Liftoff-specific proof as not observed
- **AND** creates no manifest, integration, activation state, or evidence

#### Scenario: Invalid or retired manifest blocks fallback
- **WHEN** a discovered manifest is malformed, unsafe, unreadable, dangling, or identifies Power Apps
- **THEN** assessment returns an explicit error rather than choosing an outer project or generic Git fallback
- **AND** performs no live request or mutation

### Requirement: Assessment output distinguishes alignment, differences, and incomplete coverage
Assessment SHALL preserve schema-v1 reports with read-only mode, pinned target, identity availability, findings, provenance, diagnostics, coverage, and outcome. Human/JSON output SHALL derive from the same report. Exit 0 SHALL mean fully observed alignment or explicitly disabled not-applicable governance; exit 2 SHALL mean differences or partial coverage; exit 1 SHALL mean invalid/unsafe input or catalog error. Known differences SHALL remain visible alongside independent missing proof, and evaluator presence SHALL NOT imply completed coverage.

#### Scenario: Fully observed controls match
- **WHEN** every applicable catalog control has valid complete proof without differences or exceptions
- **THEN** outcome is aligned with exit 0

#### Scenario: Known difference is observed
- **WHEN** required proof is complete and outdated, missing, conflicting, or approved-exception controls are found
- **THEN** outcome is differences with exit 2 and preserves the distinction between differences and accepted exceptions

#### Scenario: Some proof cannot be collected
- **WHEN** applicable proof or applicability is unknown
- **THEN** outcome is partial with exit 2 and retains independently established differences and coverage gaps

#### Scenario: A report cannot be trusted
- **WHEN** a valid JSON invocation encounters unsafe paths, malformed required input, or an invalid catalog
- **THEN** it emits a versioned safe error report and exit 1 instead of a successful-looking fallback

#### Scenario: Governance is explicitly disabled
- **WHEN** a supported Liftoff project explicitly selects profile none
- **THEN** outcome is not-applicable with exit 0, without an alignment or activation claim

#### Scenario: Ordinary Git repository has no recorded Liftoff baseline
- **WHEN** repository observations are available but no Liftoff baseline exists
- **THEN** nullable recorded-identity fields and explicit missing proof are retained rather than an invented initialized project

### Requirement: Infrastructure recipes use the selected project's actual context
For a supported API/GenAI project, helpers SHALL select its declared environment and recorded infrastructure layout, using the first selected environment by default. New per-environment layouts SHALL select that environment's independent root and inputs. Helpers SHALL remain printed-only and preserve literal paths on Windows, macOS, and Linux. Legacy shared-state layout SHALL be identified explicitly rather than silently migrated or treated as environment-isolated.

#### Scenario: Project selects only production
- **WHEN** a newly generated project selects only prod and requests a plan recipe
- **THEN** the recipe targets its independent production root and production inputs without nonexistent development files

#### Scenario: Requested environment is absent
- **WHEN** a helper requests an undeclared environment
- **THEN** it reports that mismatch rather than an unusable recipe

#### Scenario: Project path contains spaces
- **WHEN** an infrastructure path contains spaces or shell-significant characters on a supported host
- **THEN** the printed recipe preserves it as a literal argument in its identified shell and executes nothing

#### Scenario: Legacy project would switch shared state
- **WHEN** recorded legacy infrastructure cannot prove an independent state root for the requested environment
- **THEN** the helper explains the migration boundary and refuses a misleading environment-switch recipe without moving files or state

### Requirement: Dependency-failure output states the real preservation boundary
Dependency setup output SHALL distinguish unchanged metadata, attributable restored metadata, preserved concurrent/uncertain edits, and possible lifecycle-script changes elsewhere. It SHALL NOT claim complete scaffold preservation or blame all observed changes on the dependency command.

#### Scenario: Installation fails after running scripts
- **WHEN** a command fails and an attributable conflict-free metadata write is restored
- **THEN** output lists what was restored and warns that other script changes require review

#### Scenario: Another edit occurs during installation
- **WHEN** protected metadata changes with uncertain or concurrent provenance
- **THEN** the edit is preserved and reported as a conflict rather than overwritten or described as successfully restored

## ADDED Requirements

### Requirement: Repository discovery is independent of localized diagnostic wording
Initialization SHALL distinguish a valid nonrepository directory from a failed or unsafe Git discovery on Windows, macOS, and Linux without depending on the user's Git diagnostic language. A genuine discovery failure SHALL NOT silently become permission to initialize a different target.

#### Scenario: Nonrepository Git diagnostic is localized
- **WHEN** initialization starts outside a Git repository on a supported host using non-English Git messages
- **THEN** the normal named-child initialization path remains available subject to the existing target and consent guards

#### Scenario: Git discovery fails for an unrelated reason
- **WHEN** discovery fails because of unsafe ownership, permissions, or an uninterpretable result rather than a confirmed nonrepository directory
- **THEN** initialization reports that failure without choosing another target or writing files
