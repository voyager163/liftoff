## ADDED Requirements

### Requirement: Interactive workflows use a consistent visual lifecycle
The system SHALL present interactive `init` and `migrate` workflows as ordered Liftoff-owned stages using the same responsive terminal presentation as help and status output. It SHALL preserve all existing questions, defaults, disabled choices, consent boundaries, cancellation behavior, and command execution semantics.

#### Scenario: Init opens with the Liftoff identity
- **WHEN** a developer runs interactive `liftoff init`
- **THEN** Liftoff renders the responsive branded identity before the first project question
- **AND** it does not wait until plan confirmation or workstation probing to introduce the interface

#### Scenario: Migrate opens with the Liftoff identity
- **WHEN** a developer runs interactive `liftoff migrate <source>`
- **THEN** Liftoff renders the responsive branded identity before scan provenance or migration questions

#### Scenario: Prompt choices use shared presentation
- **WHEN** Liftoff asks for a project type, pattern, API stack, provider, region, spec framework, coding agents, default agent, frontend, or environments
- **THEN** the prompt, available choices, default, disabled state, and validation feedback use shared prompt and choice-list primitives
- **AND** the accepted values and defaults remain unchanged

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

## MODIFIED Requirements

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
