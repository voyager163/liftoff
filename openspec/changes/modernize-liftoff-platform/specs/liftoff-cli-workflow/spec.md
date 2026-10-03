## MODIFIED Requirements

### Requirement: Liftoff exposes a Node-based CLI
Liftoff SHALL remain a Node.js-based CLI named `liftoff`, using its release-owned runtime baseline. Qualified native distributions SHALL include that runtime and require no global Node/npm or Python merely to start; the npm compatibility package SHALL retain its declared external Node requirement. Initialization SHALL remain `liftoff init`; `liftoff create` SHALL not become an alias.

#### Scenario: Run init command
- **WHEN** a developer invokes init from a supported installation
- **THEN** initialization starts without requiring Python merely to start Liftoff

#### Scenario: Run non-interactive init command
- **WHEN** a fully specified supported initialization is supplied
- **THEN** declared choices resolve without unrelated stack/tool selection prompts

#### Scenario: Obsolete create command is rejected
- **WHEN** create is invoked
- **THEN** Liftoff exits 1 with init guidance and no project or machine changes

#### Scenario: Run CLI after global npm install
- **WHEN** the compatibility package is installed under supported Node/npm
- **THEN** its liftoff entrypoint and help remain usable

### Requirement: CLI captures required project decisions
The CLI SHALL capture project name, supported workload, development workflow and coding-agent selection before generation. Workflow values SHALL be OpenSpec, Spec Kit and Manual; omission retains OpenSpec. Manual SHALL allow zero or more selected agents, while OpenSpec/Spec Kit retain nonempty selections. GenAI SHALL retain the approved Python/FastAPI/PydanticAI stack and generic pattern default; standard API SHALL retain its three approved stacks without GenAI-only questions. Interactive/noninteractive inputs SHALL agree, Spec Kit SHALL require a selected default when applicable, and retired Power Apps SHALL remain unsupported.

#### Scenario: Interactive GenAI project decisions
- **WHEN** GenAI decisions are incomplete
- **THEN** the CLI offers the generic uncertainty option first and applicable cloud/frontend/environment/workflow/agent choices
- **AND** unchanged defaults remain generic and OpenSpec

#### Scenario: Interactive standard project decisions
- **WHEN** a standard project has missing decisions
- **THEN** the CLI asks for its API stack and common choices without a GenAI pattern

#### Scenario: Interactive Power Apps project decisions
- **WHEN** a retired workload is supplied
- **THEN** rejection occurs before generation or former workload prompts

#### Scenario: Approved GenAI stack is not prompted
- **WHEN** GenAI is selected
- **THEN** its approved application framework remains derived rather than another question

#### Scenario: Approved standard framework is derived from API stack
- **WHEN** a supported API stack is selected
- **THEN** its framework/database tooling follow that registered stack

#### Scenario: Both agents are selected for Spec Kit
- **WHEN** multiple agents are selected for Spec Kit
- **THEN** exactly one selected agent is the default

#### Scenario: Explicit standard flag is honored while prompting
- **WHEN** `--no-genai` is supplied without all remaining choices
- **THEN** prompting preserves standard identity rather than replacing it with a GenAI default

#### Scenario: Manual is selected
- **WHEN** `--spec manual` or the Manual picker choice is selected
- **THEN** no external spec framework is required
- **AND** agents can be omitted or selected independently

### Requirement: Interactive agent selection supports keyboard multi-selection
The CLI SHALL retain the native checkbox selector on genuine TTYs and deterministic line fallback elsewhere, preserving configured selections and canonical order. OpenSpec/Spec Kit SHALL retain detected-agent/Copilot fallback and require at least one agent. Manual SHALL allow no agents and SHALL not automatically select one merely because it is installed. Explicit valid configuration or flags SHALL bypass prompting.

#### Scenario: Select both agents with Space
- **WHEN** Copilot and Claude are selected and confirmed
- **THEN** both appear once in canonical order

#### Scenario: Empty selection is rejected
- **WHEN** an OpenSpec or Spec Kit user deselects all agents
- **THEN** the selector explains its nonempty requirement and remains active

#### Scenario: Redirected input uses the line fallback
- **WHEN** injected or redirected streams are used
- **THEN** deterministic input behavior remains supported without pretending the stream is a TTY

#### Scenario: Agent flag bypasses the selector
- **WHEN** valid configured agents or `--agents` specify the selection
- **THEN** the CLI does not start another selector

#### Scenario: Ctrl+C cancels before writes
- **WHEN** the selector is cancelled
- **THEN** terminal state is restored and destination files remain unchanged

#### Scenario: Manual selects no agent
- **WHEN** a Manual user confirms no agents or supplies `--agents none`
- **THEN** the plan records an empty agent list and generates no agent integration

### Requirement: CLI syntax is command-specific and strict
Commands, subcommands, positionals, flags and catalog values SHALL use explicit definitions. Invalid/removed/contradictory values SHALL exit 1 before relevant effects, and prompting SHALL not discard invalid inputs. `manual` SHALL be an accepted workflow; `--agents none` SHALL be an explicit Manual-only empty selection and SHALL not mix with real agent IDs. Empty strings and unknown agents remain errors.

#### Scenario: Reject a misspelled init flag
- **WHEN** an unknown flag is supplied
- **THEN** parsing rejects it rather than generating from defaults

#### Scenario: Reject the removed command
- **WHEN** create is supplied
- **THEN** init is recommended without preparation

#### Scenario: Reject removed update apply flag
- **WHEN** update receives `--apply`
- **THEN** it fails before project access and explains the supported sequence

#### Scenario: Reject force in check mode
- **WHEN** update check receives force
- **THEN** it fails before project or receipt writes

#### Scenario: Reject an unsupported helper subcommand
- **WHEN** an undeclared dev subcommand is supplied
- **THEN** supported values are reported instead of a default recipe

#### Scenario: Reject an unsupported region subcommand
- **WHEN** an undeclared regions subcommand is supplied
- **THEN** it fails rather than listing unrelated regions

#### Scenario: Render a missing-value error without a stack trace
- **WHEN** a value flag has no value
- **THEN** concise usage guidance identifies it

#### Scenario: Reject an invalid agent list
- **WHEN** agents contain an unknown ID, empty string, mixed none/real IDs, or an empty selection for an external framework
- **THEN** parsing/planning rejects it without dropping invalid entries

#### Scenario: Show command-specific help
- **WHEN** a supported command requests help
- **THEN** it describes actual syntax without project/tool/credential discovery

### Requirement: CLI captures the repository-governance profile
The CLI SHALL expose `single-maintainer-gitflow`, `team-gitflow` and `none` in interactive selection, configuration and `--governance`. Existing omission defaults SHALL remain single-maintainer. Team selection SHALL explain one independent human PR approval without changing single-maintainer semantics. Selection SHALL not authorize live enforcement or silently replace a project's recorded profile.

#### Scenario: Configure governance interactively
- **WHEN** governance input is missing
- **THEN** the picker presents both profiles and none, with single-maintainer as the unchanged default

#### Scenario: Use noninteractive default
- **WHEN** valid noninteractive input omits governance
- **THEN** single-maintainer is selected without remote effects

#### Scenario: Load governance from configuration
- **WHEN** configuration specifies a supported profile
- **THEN** normal explicit-flag precedence applies without changing recorded live enforcement

### Requirement: CLI exposes reviewed project repair without implicit authorization
Repair SHALL expose local infrastructure/application and additive-agent operations with project selection, check, scoped live metadata, exact approval and recorded recovery. Pre-existing Azure state/resource adoption and migration SHALL remain publicly planning-only in this release, regardless of internal primitives or broad approval. Manual agent additions SHALL need no external framework; external-framework additions SHALL retain pinned official integration operations. JSON is formatting, and machine/dependency/global-profile/network/file permissions remain independent.

#### Scenario: Preview without granting writes
- **WHEN** repair check runs
- **THEN** it reports exact supported scope and any external receipt without executing mutations

#### Scenario: Noninteractive application lacks approval
- **WHEN** a requested apply lacks the current exact approval
- **THEN** it fails without project writes and identifies the preview/approval path

#### Scenario: Add agents without replacing the current selection
- **WHEN** an additive agent request is previewed
- **THEN** it preserves existing agents and includes only independently eligible changes

#### Scenario: Commands remain portable and target-bound
- **WHEN** repair guidance names a Windows project with spaces
- **THEN** literal arguments and native working directories preserve the exact target and authority

## ADDED Requirements

### Requirement: Capability discovery describes actual installed behavior
`liftoff capabilities --json` SHALL return a versioned project-independent inventory of actual supported commands, schemas, plugins, profiles, recipes and platform/scope limitations without network, scripts, telemetry, disclosure or state writes. Existing repair capability discovery SHALL remain supported.

#### Scenario: An old skill inspects the new CLI
- **WHEN** capability discovery is invoked outside a project
- **THEN** it identifies usable interfaces and does not advertise deferred stateful execution or missing production adapters

### Requirement: Adoption and workflow changes have separate reviewed command surfaces
The CLI SHALL expose `liftoff adopt [project]` for in-place non-Liftoff adoption and `liftoff workflow set <openspec|spec-kit|manual> [project]` for explicit workflow transitions, with check, JSON, exact-plan approval and bounded recovery. Bare interactive execution SHALL show the current exact plan and default-No consent; bare JSON/non-TTY execution SHALL preview without prompting. Invalid targets/options SHALL fail before effects. Neither command SHALL repurpose ordinary update or sibling migrate as unrestricted application conversion.

#### Scenario: Manual workflow transition is requested
- **WHEN** an existing project requests a change to Manual
- **THEN** the CLI previews retained framework history and exact integration/metadata changes before independent approval

#### Scenario: Adoption is invoked noninteractively without approval
- **WHEN** adopt is run with JSON and no exact execution authority
- **THEN** it emits a preview with no project writes or implicit acceptance of piped answers

#### Scenario: Project path is explicit on Windows
- **WHEN** either command targets a Windows path containing spaces or shell metacharacters
- **THEN** parsing, receipts and emitted actions preserve the same canonical project using native path semantics

### Requirement: Manual completion uses real CLI actions without a framework
Manual SHALL support local validation, assessment, repair, managed update and the selected governance journey without OpenSpec/Spec Kit. Optional selected-agent integrations SHALL use the same core contracts; no-agent completion SHALL provide actual registered CLI actions instead of a fabricated shell setup or archive command. Governance none SHALL not be enabled merely to complete local work.

#### Scenario: Manual CLI-only initialization completes
- **WHEN** applicable local checks pass without agents or a framework
- **THEN** completion identifies the actual local milestone and next CLI actions
- **AND** no missing agent, synthetic seed archive or mandatory spec document blocks it
