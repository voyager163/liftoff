## Purpose

Define the user-facing Liftoff CLI workflow for creating, previewing, validating, and inspecting Mission Control GenAI application scaffolds.

## Requirements

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

### Requirement: CLI reports the running Liftoff version
The system SHALL expose the running package version through `liftoff --version` and general help without requiring a project, Python, registry access, or any other network operation.

#### Scenario: Developer requests the installed version
- **WHEN** a developer runs `liftoff --version`
- **THEN** the CLI exits successfully after printing the Liftoff version read from its installed package metadata

#### Scenario: General help identifies the running version
- **WHEN** a developer runs `liftoff help` or invokes the CLI without a command
- **THEN** the general help output identifies the running Liftoff version

#### Scenario: Version output works from the packed installation
- **WHEN** package smoke verification invokes `--version` through an isolated globally installed CLI entrypoint
- **THEN** the reported version exactly matches the packed package version

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

### Requirement: CLI handles planned cloud providers explicitly
The system SHALL fully support Azure in V1 and identify AWS and GCP as planned provider adapters.

#### Scenario: Interactive planned provider visibility
- **WHEN** a developer is prompted for a target cloud provider
- **THEN** the system shows Azure as available and AWS/GCP as planned options

#### Scenario: Non-interactive unsupported provider
- **WHEN** a developer runs `liftoff init my-app --cloud aws --yes`
- **THEN** the system stops before generation and explains that AWS is a planned provider adapter, not a V1-supported provider

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

### Requirement: CLI deployment environments use canonical stage names
For GenAI and standard API workloads, the CLI SHALL default environment
selection to `dev`, `staging`, and `prod` in that order. Interactive prompts,
non-interactive help, configuration parsing, and infrastructure helpers MUST
accept only those identifiers. The retired `test` identifier MUST fail before
generation or helper output and identify the supported values.

#### Scenario: Accept interactive environment default
- **WHEN** a developer accepts the environment prompt default
- **THEN** the project plan contains `dev`, `staging`, and `prod` in that order

#### Scenario: Show non-interactive environment default
- **WHEN** a developer inspects `liftoff init --help`
- **THEN** `--environments` displays `dev,staging,prod` as its default

#### Scenario: Reject retired environment
- **WHEN** a CLI option, configuration file, or infrastructure helper supplies `test`
- **THEN** Liftoff exits with an unsupported-environment error naming `dev`, `staging`, and `prod`
- **AND** performs no project write

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

### Requirement: CLI creates files safely across platforms
The system SHALL initialize at the current directory only when that directory is the exact real root of a Git worktree; otherwise it SHALL resolve the project to a named child directory. It SHALL stage and validate the complete Liftoff and official framework output before writing, SHALL preflight every staged path against the destination, and SHALL require one explicit authorization before replacing any conflicting regular file.

#### Scenario: Initialize at an exact Git root
- **WHEN** a developer runs `liftoff init` from the exact root of an existing Git worktree
- **THEN** Liftoff initializes that directory in place and infers the project name from the root folder
- **AND** it does not create a same-named child directory

#### Scenario: Supplied name at an exact Git root
- **WHEN** a developer runs `liftoff init service-name` from the exact root of a Git worktree
- **THEN** Liftoff uses `service-name` as project identity while keeping the current Git root as the target

#### Scenario: Nested Git directory does not adopt the repository root
- **WHEN** a developer runs `liftoff init my-app` from a directory below a Git worktree root
- **THEN** Liftoff targets the `my-app` child of the current directory
- **AND** it does not write to the ancestor Git root

#### Scenario: Existing named target can be merged
- **WHEN** a developer selects an existing non-Liftoff directory whose existing entries do not structurally block staged output
- **THEN** Liftoff preserves unrelated files and merges the staged project after any required conflict authorization

#### Scenario: Interactive conflicts are disclosed together
- **WHEN** destination preflight finds one or more different regular files at staged paths
- **THEN** Liftoff lists every portable relative conflict in stable order and requests one confirmation for the complete set
- **AND** declining leaves the destination unchanged

#### Scenario: Force authorizes listed regular-file replacement
- **WHEN** a developer supplies `--force` and preflight finds replaceable regular-file conflicts
- **THEN** Liftoff skips the overwrite prompt and replaces only the files in the validated merge plan

#### Scenario: Existing Liftoff project is never overwritten by init
- **WHEN** the target root contains `liftoff.manifest.json`
- **THEN** initialization exits before tool installation or destination writes and directs the developer to `liftoff update`
- **AND** `--force` does not override the guard

#### Scenario: Structural blocker is not forceable
- **WHEN** a staged file collides with a destination directory, symlink, unsafe ancestor, or path resolving outside the target
- **THEN** Liftoff exits before destination writes and identifies the blocked path
- **AND** `--force` does not override the blocker

#### Scenario: Framework initialization fails in staging
- **WHEN** the selected official framework initializer fails or staged validation fails
- **THEN** Liftoff removes the staging directory, leaves the destination unchanged, and reports the failed command

#### Scenario: Handled merge failure rolls back
- **WHEN** a destination write fails after the merge begins
- **THEN** Liftoff restores replaced files and removes files and empty directories created by that merge
- **AND** it exits with an explicit rollback result

#### Scenario: Windows path generation and conflict reporting
- **WHEN** the CLI initializes or merges a project on Windows
- **THEN** it uses platform-correct path resolution and atomic writes while displaying portable project-relative conflict paths
- **AND** manifest path semantics remain identical to macOS and Linux

### Requirement: CLI exposes discovery and validation commands
The system SHALL expose commands for project initialization, planning, managed-core project update, explicit managed-core update checks, project migration, pattern discovery, provider discovery, region discovery, validation, local development helpers, infrastructure helpers, and environment diagnostics.

#### Scenario: List supported patterns
- **WHEN** a developer runs `liftoff patterns`
- **THEN** the system lists all nine GenAI patterns, including the generic uncertainty option, with their scaffold status

#### Scenario: Search regions
- **WHEN** a developer runs `liftoff regions search korea --cloud azure`
- **THEN** the system lists matching Azure regions with display names and slugs

#### Scenario: Run diagnostics
- **WHEN** a developer runs `liftoff doctor`
- **THEN** the system reports local readiness for the context-selected runtimes, spec framework, coding agents, Docker, and OpenTofu without modifying the project or workstation

#### Scenario: Check a project for drift
- **WHEN** a developer or automation runs `liftoff update --check`
- **THEN** the system reports only managed-core drift and configuration-authorized component provisioning without requesting input or writing files
- **AND** it does not compare production project files with current starter templates

#### Scenario: Apply safe drift by default
- **WHEN** a developer or automation runs plain `liftoff update` and actionable managed-core drift exists
- **THEN** the system applies safe core changes without requesting input
- **AND** core conflicts remain untouched unless `--force` is supplied

#### Scenario: Force stays inside the core boundary
- **WHEN** a developer runs `liftoff update --force`
- **THEN** only listed managed-core conflicts are eligible for overwrite
- **AND** project-owned files and provisioning collisions remain untouched

#### Scenario: Migrate an existing project
- **WHEN** a developer runs `liftoff migrate ../legacy-app`
- **THEN** the system scans the source project, generates a fresh Liftoff scaffold beside it, and emits a migration plan without modifying the source project

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

### Requirement: Initialization consent flags are explicit and independent
The system SHALL keep project-default acceptance, destination overwrite authorization, machine-tool installation authorization, global OpenSpec profile authorization, and project dependency installation authorization as five independent decisions. No flag SHALL imply another, and installation, global-profile, or overwrite consent SHALL NOT be read from project configuration.

#### Scenario: Yes does not authorize overwrite
- **WHEN** a developer runs `liftoff init existing-project --yes` and destination preflight finds a conflicting generated file
- **THEN** Liftoff exits before writing unless the developer confirms interactively or supplies `--force`

#### Scenario: Force does not authorize machine changes
- **WHEN** a developer runs `liftoff init existing-project --force` and a blocking workstation tool is missing
- **THEN** Liftoff does not install the tool without interactive confirmation or `--install-tools`

#### Scenario: Machine-tool consent does not install project dependencies
- **WHEN** a developer supplies `--install-tools` without `--install-dependencies`
- **THEN** Liftoff does not run stack package installation in the generated project without the separate interactive confirmation

#### Scenario: Other consent does not authorize global OpenSpec configuration
- **WHEN** the OpenSpec global profile is incompatible and the developer supplies `--yes`, `--force`, `--install-tools`, or `--install-dependencies` without the dedicated profile authorization
- **THEN** Liftoff does not change the global OpenSpec configuration
- **AND** it exits before destination writes with the exact remediation

### Requirement: CLI exposes an explicit Copilot cloud-agent choice
The system SHALL expose a default-off Copilot cloud-agent decision for OpenSpec projects that select GitHub Copilot. Interactive `init` and `migrate` flows SHALL prompt when the choice is unresolved, and noninteractive flows SHALL accept `--copilot-cloud` or `--no-copilot-cloud`.

#### Scenario: Prompt for the cloud coding agent
- **WHEN** an interactive OpenSpec plan selects GitHub Copilot and does not already specify a cloud-agent preference
- **THEN** Liftoff explains that the option writes a GitHub Actions workflow and an agent definition
- **AND** the confirmation defaults to No

#### Scenario: Preview the cloud-agent decision
- **WHEN** Liftoff presents an OpenSpec project plan
- **THEN** the plan identifies the complete 12-workflow, skills-and-commands contract
- **AND** it states whether the GitHub-hosted Copilot coding agent will be configured

#### Scenario: Enable the cloud coding agent noninteractively
- **WHEN** a fully specified OpenSpec command selects GitHub Copilot and supplies `--copilot-cloud`
- **THEN** Liftoff resolves the cloud-agent preference to enabled without an additional project-decision prompt

#### Scenario: Yes accepts the safe cloud-agent default
- **WHEN** a fully specified OpenSpec command selects GitHub Copilot, supplies `--yes`, and omits both cloud-agent flags
- **THEN** Liftoff resolves the cloud-agent preference to disabled
- **AND** `--yes` does not opt into the GitHub Actions integration

#### Scenario: Reject an inapplicable cloud-agent flag
- **WHEN** a developer supplies either cloud-agent flag with Spec Kit or without GitHub Copilot selected
- **THEN** Liftoff exits before probes or writes and explains the required OpenSpec and GitHub Copilot combination

### Requirement: Global OpenSpec profile authorization has a dedicated CLI surface
The system SHALL expose a dedicated noninteractive authorization flag for changing the global OpenSpec profile and SHALL show profile configuration as a separate interactive consent phase. The authorization SHALL apply only when OpenSpec is selected and the observed global profile does not already satisfy the Liftoff contract.

#### Scenario: Matching global profile needs no authorization
- **WHEN** the global OpenSpec configuration already selects `custom`, `both`, and all 12 required workflows
- **THEN** `liftoff init` and `liftoff migrate` proceed without a profile-change prompt or authorization flag

#### Scenario: Authorize a noninteractive profile change
- **WHEN** a fully specified OpenSpec command observes an incompatible global profile and supplies `--configure-openspec-profile`
- **THEN** Liftoff may apply and verify the required global profile before staging project files

#### Scenario: Standalone plan never changes global configuration
- **WHEN** a developer runs `liftoff plan` with any profile-authorization or cloud-agent selection
- **THEN** Liftoff previews the resolved project contract without running OpenSpec config commands or writing machine or project files

### Requirement: Interactive workflows use a consistent visual lifecycle
The system SHALL present interactive `init` and `migrate` workflows as ordered Liftoff-owned stages using the same responsive terminal presentation as help and status output. It SHALL preserve all common consent boundaries, cancellation behavior, and command execution semantics while allowing workload-specific questions and a TTY-native coding-agent multi-select.

#### Scenario: Init opens with the Liftoff identity
- **WHEN** a developer runs interactive `liftoff init`
- **THEN** Liftoff renders the responsive branded identity before the first project question
- **AND** it does not wait until plan confirmation or workstation probing to introduce the interface

#### Scenario: Migrate opens with the Liftoff identity
- **WHEN** a developer runs interactive `liftoff migrate <source>`
- **THEN** Liftoff renders the responsive branded identity before scan provenance or migration questions

#### Scenario: Prompt choices use shared presentation
- **WHEN** Liftoff asks for a project type, pattern, API stack, provider, region, spec framework, default agent, frontend, environments, or optional plugin
- **THEN** the prompt, available choices, default, disabled state, and validation feedback use shared prompt and choice-list primitives

#### Scenario: Coding agents use the TTY multi-select
- **WHEN** Liftoff asks for coding agents with interactive TTY input and output
- **THEN** the prompt states that Up and Down navigate, Space toggles, and Enter confirms
- **AND** it displays selected, configured, detected, and not-observable states without disabling a missing agent

#### Scenario: Plan confirmation is visually distinct
- **WHEN** interactive initialization or migration reaches plan confirmation
- **THEN** Liftoff renders the resolved plan in a named section with aligned labels before the confirmation prompt

#### Scenario: Consent displays exact affected actions
- **WHEN** Liftoff requests file-replacement, per-tool installation, or project-dependency consent
- **THEN** it renders the exact files, allowlisted command, purpose, working directory, or remedy in a named section before asking for confirmation
- **AND** the visual treatment does not combine or weaken independent consent boundaries

#### Scenario: External command output remains unmodified
- **WHEN** an authorized installer, framework CLI, or dependency command streams output
- **THEN** Liftoff renders a stage heading before the command
- **AND** it forwards the child process output without adding borders, wrapping, or rewriting its bytes

#### Scenario: Interactive cancellation uses a terminal status
- **WHEN** a developer declines plan confirmation or file replacement
- **THEN** Liftoff renders a concise cancellation status that states no unauthorized destination change was made
- **AND** it preserves the existing successful cancellation exit behavior

#### Scenario: Successful onboarding ends with completion and next action
- **WHEN** `init` or `migrate` completes
- **THEN** Liftoff renders success, configured integrations, deferred work, target path, and the next validation command through shared completion primitives

### Requirement: Completion command guidance is explicitly labeled
The system SHALL present any command supplied by a successful completion flow under a named `Next recommended command` heading before rendering the existing copyable shell command. The label SHALL make clear that the command is guidance rather than output Liftoff already executed. Liftoff MUST NOT execute, confirm, rewrite, wrap, or otherwise act on the recommendation, and completion without a recommended command SHALL NOT render an empty recommendation section.

#### Scenario: Initialization recommends validation clearly
- **WHEN** project initialization completes with its validation recommendation
- **THEN** Liftoff renders `Next recommended command` before the exact `$`-prefixed validation command
- **AND** it returns control to the developer without running that command

#### Scenario: Migration recommends the validation gate clearly
- **WHEN** migration completes with `liftoff validate && liftoff doctor` as its recommendation
- **THEN** the command appears in the named recommendation section rather than as an unlabeled completion line

#### Scenario: Update recommends follow-up validation clearly
- **WHEN** an update completes with `liftoff validate && liftoff doctor` as its recommendation
- **THEN** the completion output identifies it as the next recommended command and does not imply it already ran

#### Scenario: Recommendation preserves exact command syntax
- **WHEN** a recommended command contains quoted paths, repeated whitespace, a Windows path, arguments, or shell operators such as `&&`
- **THEN** the displayed command content remains one line and is byte-for-byte identical to the supplied recommendation
- **AND** the `$` marker remains presentation rather than part of the command

#### Scenario: Recommendation is responsive and color-safe
- **WHEN** completion renders in rich, compact, plain, color, or no-color presentation
- **THEN** the recommendation heading and decoration remain within the selected terminal width and retain the same visible text
- **AND** a command longer than the terminal width remains an exact unwrapped line rather than being rewritten

#### Scenario: Completion has no recommendation
- **WHEN** a completion caller supplies no recommended command
- **THEN** Liftoff renders no empty `Next recommended command` section

#### Scenario: Machine output remains unaffected
- **WHEN** a machine-readable command path bypasses human completion presentation
- **THEN** no recommendation label or decorative command text contaminates its output

### Requirement: CLI help and status output use a responsive terminal renderer
The system SHALL render every human-readable CLI surface through one shared semantic terminal presentation system, including general help, command help, onboarding, plans, prompts, readiness, consent, conflicts, completion, validation, update, doctor, discovery, helper, warning, and error output. On a capable wide terminal it SHALL use the approved static Liftoff wordmark, Unicode box-drawing sections, aligned content, deliberate spacing, and restrained semantic color. It SHALL provide compact and plain fallbacks without changing command behavior, stream ownership, machine-readable values, or exit codes.

#### Scenario: General help on a capable terminal
- **WHEN** a developer runs `liftoff help` in a color-capable terminal with sufficient width
- **THEN** the output includes the static large Liftoff wordmark, subtitle, usage, grouped global options, grouped commands, Unicode section borders, aligned descriptions, and restrained semantic color

#### Scenario: Command help uses the same visual language
- **WHEN** a developer runs `liftoff init --help` in a capable wide terminal
- **THEN** the output uses a branded command identity and bordered sections for usage and grouped options
- **AND** it describes the positional project name and every supported init flag from the same command definition used by the parser
- **AND** it does not include unrelated command groups

#### Scenario: Plan output uses semantic sections
- **WHEN** a developer runs `liftoff plan`
- **THEN** the project decisions, generated artifacts, and workstation requirements are rendered as named aligned sections rather than command-local bullet formatting

#### Scenario: Maintenance commands share statuses and remedies
- **WHEN** a developer runs `liftoff validate`, `liftoff update`, or `liftoff doctor` without JSON output
- **THEN** success, drift, skipped work, warnings, failures, and remedies use the same status, table, panel, and command primitives

#### Scenario: Reference and helper commands share lists and commands
- **WHEN** a developer runs `liftoff patterns`, `liftoff providers`, `liftoff regions`, `liftoff dev`, or `liftoff infra`
- **THEN** Liftoff uses shared list, table, heading, and command primitives instead of surface-specific prefixes and spacing

#### Scenario: Rich layout is visually stable
- **WHEN** a TTY is at least the full-layout threshold
- **THEN** every border fits within the detected terminal width
- **AND** ANSI color does not change visible alignment
- **AND** multiline content wraps inside its section instead of crossing a border

#### Scenario: Narrow terminal does not wrap decorative borders
- **WHEN** the terminal width is below the full-layout threshold
- **THEN** Liftoff uses its compact or plain layout instead of emitting clipped or wrapped rich panels
- **AND** it preserves the same labels, values, commands, and remedies

#### Scenario: Redirected output is deterministic plain text
- **WHEN** stdout or stderr is not a TTY
- **THEN** Liftoff emits readable deterministic plain text with no ANSI escape sequences or decorative box borders
- **AND** semantic information remains in the same order as interactive output

#### Scenario: No-color mode preserves hierarchy without ANSI
- **WHEN** `NO_COLOR` is set or color is unsupported
- **THEN** Liftoff emits no ANSI escape sequences
- **AND** headings, labels, statuses, and section hierarchy remain understandable

#### Scenario: Machine-readable output bypasses decoration
- **WHEN** a command emits `--json` output
- **THEN** the output contains only the documented JSON value and no wordmark, border, color, spinner, prompt, or status decoration

#### Scenario: Version remains a one-line machine-friendly value
- **WHEN** a developer runs `liftoff --version`
- **THEN** Liftoff emits exactly `Liftoff <version>` followed by one newline without the branded interface

#### Scenario: Errors remain concise and actionable
- **WHEN** Liftoff reports a parser, validation, readiness, conflict, or command failure in a human-readable context
- **THEN** it uses the shared compact error and remedy presentation on stderr
- **AND** it does not repeat the large wordmark or emit a stack trace for expected user errors

#### Scenario: Windows Terminal receives the rich layout
- **WHEN** Liftoff runs in a capable wide Windows Terminal
- **THEN** it renders the same static wordmark, Unicode sections, alignment, and semantic statuses as macOS and Linux
- **AND** Windows paths and command names remain intact without separator or width corruption

#### Scenario: Deterministic snapshots can select every layout
- **WHEN** terminal tests request rich, compact, plain, no-color, or JSON snapshot mode
- **THEN** rendering depends only on the supplied stream capabilities and options rather than the host terminal

### Requirement: Interactive agent selection supports keyboard multi-selection
The system SHALL use a checkbox-style selector when both input and output are real interactive TTYs. Configured integrations SHALL be preselected when present; otherwise observable installed agents SHALL be preselected, falling back to GitHub Copilot when none is observable. At least one agent SHALL be required, and the resolved result SHALL use canonical catalog order.

#### Scenario: Select both agents with Space
- **WHEN** a developer toggles GitHub Copilot and Claude Code with Space and presses Enter
- **THEN** the project plan contains both agents in canonical catalog order

#### Scenario: Empty selection is rejected
- **WHEN** a developer deselects every agent and presses Enter
- **THEN** the prompt remains active and states that at least one agent is required

#### Scenario: Redirected input uses the line fallback
- **WHEN** interactive answers come from redirected input or an injected non-TTY stream
- **THEN** Liftoff uses the deterministic comma-separated selector
- **AND** existing scripted input and snapshot behavior remain supported

#### Scenario: Agent flag bypasses the selector
- **WHEN** `--agents` or valid configured agents already provide the selection
- **THEN** Liftoff does not start either interactive agent selector

#### Scenario: Ctrl+C cancels before writes
- **WHEN** the developer presses Ctrl+C in the TTY multi-select
- **THEN** Liftoff restores terminal state, cancels initialization, and makes no destination change

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

### Requirement: CLI exposes self-upgrade as a maintenance command
The system SHALL expose `liftoff upgrade` as an explicit top-level maintenance command that is distinct from project-scoped `liftoff update`. Its command definition SHALL accept only `--check`, `--json`, and command help, require no positional project argument, and reject unsupported flags or arguments before registry lookup or installation.

#### Scenario: Show upgrade help
- **WHEN** a developer runs `liftoff upgrade --help`
- **THEN** Liftoff exits 0 and describes CLI replacement, read-only check mode, JSON output, supported global npm installations, and the distinction from project update
- **AND** performs no installation or registry lookup

#### Scenario: Reject a project argument
- **WHEN** a developer runs `liftoff upgrade ./project`
- **THEN** argument parsing exits 1 before filesystem or network side effects

#### Scenario: Reject unrelated consent flags
- **WHEN** a developer supplies `--force`, `--yes`, `--install-tools`, or `--install-dependencies` to upgrade
- **THEN** Liftoff rejects the unsupported flag
- **AND** no flag from another command can authorize self-upgrade

### Requirement: Upgrade follows shared output and exit conventions
Human upgrade output SHALL use the shared responsive terminal renderer. JSON output SHALL contain a top-level numeric `schemaVersion` and no decorative text. Exit code 0 SHALL mean current or upgraded, exit code 2 SHALL mean read-only check found an installable update, and exit code 1 SHALL mean invalid, blocked, or failed.

#### Scenario: Run in a redirected terminal
- **WHEN** upgrade output is redirected without `--json`
- **THEN** Liftoff uses deterministic plain presentation without prompting
- **AND** apply semantics remain imperative

#### Scenario: Run JSON mode
- **WHEN** upgrade uses `--json`
- **THEN** stdout contains only the documented JSON result
- **AND** diagnostics or child progress use stderr

### Requirement: Upgrade completion keeps project migration separate
After a successful CLI replacement, human completion SHALL identify the installed target and MAY recommend `liftoff update --check` as the next separately reviewed command. It SHALL NOT execute, confirm, or imply that any generated project was upgraded.

#### Scenario: Upgrade completes inside a project
- **WHEN** the CLI is upgraded successfully while the current directory is a generated project
- **THEN** completion labels `liftoff update --check` as a recommendation only
- **AND** no project discovery or reconciliation occurred

### Requirement: CLI captures the repository-governance profile
The system SHALL include repository governance among common project decisions for every workload. Interactive initialization SHALL offer the single-maintainer GitFlow profile after workload-specific architecture choices and default it to enabled. Configuration and noninteractive commands SHALL accept the append-only governance profile identifier through `governanceProfile` and `--governance`.

#### Scenario: Configure governance interactively
- **WHEN** a developer initializes any workload with missing governance input
- **THEN** Liftoff asks whether to generate the single-maintainer GitFlow governance handoff
- **AND** the default answer enables it

#### Scenario: Use noninteractive default
- **WHEN** a fully specified noninteractive `plan` or `init --yes` omits governance input
- **THEN** the project plan selects `single-maintainer-gitflow`
- **AND** no remote action is implied

#### Scenario: Load governance from configuration
- **WHEN** a valid configuration contains `governanceProfile`
- **THEN** Liftoff resolves it through the governance profile catalog
- **AND** flags override configuration through the normal defined-value merge

### Requirement: Plan preview distinguishes handoff from enforcement
The project plan preview SHALL identify the selected governance profile, policy version, managed-core handoff artifacts, selected-agent `/liftoff-setup` integrations, and deferred post-push activation. `liftoff plan` SHALL remain side-effect free and SHALL not require a Git repository, remote, GitHub authentication, or governance platform capability.

#### Scenario: Preview enabled governance
- **WHEN** a developer runs `liftoff plan` with the profile enabled
- **THEN** the preview says the local handoff will be generated
- **AND** says live Phase 0 and enforcement are deferred until after commit and push

#### Scenario: Preview disabled governance
- **WHEN** the project selects `none`
- **THEN** the preview reports repository governance as disabled
- **AND** does not list governance launchers or remote prerequisites

#### Scenario: Plan without GitHub access
- **WHEN** `liftoff plan` runs with no GitHub remote or credentials
- **THEN** it completes without attempting a GitHub API call

### Requirement: Governance options preserve independent consent
Selecting a repository-governance profile or passing `--yes` SHALL authorize only deterministic local planning and generated files. It SHALL NOT authorize agent execution, Git mutation, remote mutation, destination conflict overwrite, machine-tool installation, or project dependency installation.

#### Scenario: Initialize with yes and governance
- **WHEN** a developer runs a fully specified `liftoff init --yes` with the profile enabled
- **THEN** Liftoff may write the authorized collision-free local artifacts
- **AND** every existing independent overwrite and installation consent boundary remains unchanged
- **AND** no remote governance operation runs

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

### Requirement: Repository discovery is independent of localized diagnostic wording
Initialization SHALL distinguish a valid nonrepository directory from a failed or unsafe Git discovery on Windows, macOS, and Linux without depending on the user's Git diagnostic language. A genuine discovery failure SHALL NOT silently become permission to initialize a different target.

#### Scenario: Nonrepository Git diagnostic is localized
- **WHEN** initialization starts outside a Git repository on a supported host using non-English Git messages
- **THEN** the normal named-child initialization path remains available subject to the existing target and consent guards

#### Scenario: Git discovery fails for an unrelated reason
- **WHEN** discovery fails because of unsafe ownership, permissions, or an uninterpretable result rather than a confirmed nonrepository directory
- **THEN** initialization reports that failure without choosing another target or writing files
