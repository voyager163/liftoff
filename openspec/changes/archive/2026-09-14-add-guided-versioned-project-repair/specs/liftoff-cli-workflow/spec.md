## MODIFIED Requirements

### Requirement: Repair is reachable from the installed CLI and native setup
The installed CLI SHALL register repair capabilities, application-layout inspection and staged patch/preparation preview/verification, infrastructure check, exact-plan application, explicit live metadata discovery, and interrupted local transaction/private-workspace recovery. Human and schema-2 JSON results SHALL distinguish inventory, preparation, checks, commit, cleanup, blocked and partial outcomes with current identities and actual project-targeted next actions. Bare repair on genuine usable input/stderr TTYs SHALL display its immutable plan and offer action-specific Yes/No approval with default No; ordinary users SHALL NOT need to copy or type fingerprints. Check SHALL remain non-executing except for its explicitly documented metadata observations, including bounded trusted tool probes only when preparation is requested. JSON/non-TTY SHALL never prompt or execute without exact explicit execution permissions. Interactive approval and optional exact fingerprint flags SHALL bind identical plan/safety guarantees. Native setup SHALL use this command when infrastructure conformance blocks local verification, without inventing unsupported commands or manually changing provenance.

#### Scenario: Repair help and invalid authority
- **WHEN** a developer requests repair help or supplies conflicting check/apply/recovery flags
- **THEN** help describes the supported scopes or invalid flags fail before access and mutation
- **AND** force or a generic yes flag cannot bypass repair approval

#### Scenario: Native setup encounters legacy infrastructure
- **WHEN** local setup is blocked by recorded legacy OpenTofu layout
- **THEN** its integration directs the developer through repair preview, separate approval, and resumed local verification
- **AND** cloud mutation and stateful migration remain separately authorized rather than assumed

#### Scenario: Plan-only is not success
- **WHEN** an unsupported or stateful project cannot be transformed by the public local lane
- **THEN** repair returns exit 2 with concrete limitations and leaves source and state untouched

#### Scenario: The agent checks CLI compatibility
- **WHEN** `liftoff repair --capabilities --json` runs outside a project
- **THEN** it reports the packaged repair contracts, recipes, schemas and real command modes without project writes, external receipts or tool execution

#### Scenario: Bare repair is invoked
- **WHEN** a developer runs `liftoff repair` in a genuine usable terminal without an approval fingerprint
- **THEN** it displays exact operations, validation and external effects before a default-No approval prompt
- **AND** only explicit Yes authorizes that displayed internally fingerprinted plan without asking the developer to enter a hash

#### Scenario: Preview approval is declined or cancelled
- **WHEN** the developer answers No, cancels or reaches EOF before consenting to any effects
- **THEN** no project command or file transaction runs and the project remains unchanged

#### Scenario: Repair runs without a usable terminal
- **WHEN** check, bare JSON or bare non-TTY repair runs without an exact execution flag
- **THEN** it reports a non-executing preview without prompting or hanging
- **AND** piped yes, generic yes, missing streams and ended streams cannot supply consent

#### Scenario: The project changes while a prompt is open
- **WHEN** an approved input, stage, destination, mode, directory inventory or verification binding changed after the displayed review
- **THEN** repair rejects that stale plan before further effects
- **AND** it does not silently recompute a new plan from the developer's Yes

## ADDED Requirements

### Requirement: Dependency preparation has a distinct executable permission
Exact automation SHALL require `--allow-dependency-preparation` alongside `--verify-plan` before any explicitly declared preparation can run. Ordinary interactive repair SHALL use a separate readable default-No preparation prompt. Neither interface SHALL imply network, lifecycle, project-check or file-transaction consent. Missing tools/locks/environments and unsupported preparation policies SHALL produce causal sanitized blockers with actual same-project remedies.

#### Scenario: Automation requests dependency preparation
- **WHEN** exact verification also supplies its preparation permission
- **THEN** only the same plan's explicitly declared registered preparation can run after all other required permissions are present
- **AND** that flag cannot authorize ordinary/check/piped/agent requests or undeclared dependencies

#### Scenario: A preparation prerequisite is missing
- **WHEN** a compatible tool, lock, package, private cache or supported lifecycle policy is unavailable
- **THEN** human and machine results identify the actual limitation and supported remedy
- **AND** arbitrary installer output, secret values and generic command-failed text do not replace an actionable diagnosis

#### Scenario: Windows host policy blocks preparation or verification
- **WHEN** verification or preparation is attempted on Windows where host execution policy or language mode denies script execution
- **THEN** human and machine results report the causal policy blocker and supported host remedies before requested target process or verification-workspace creation starts, without modifying host policy or attempting bypass
- **AND** trusted controller probe activity is distinguished from requested project execution

### Requirement: Repair follow-up actions are native-shell safe and scope-specific
Repair guidance SHALL provide exact same-project executable/argument/working-directory actions and readable native POSIX or PowerShell commands. Actions SHALL distinguish checking, limited tool probes, private preparation, live metadata, staged verification, file approval, registered cleanup/recovery, managed update, assessment and local setup. Human guidance SHALL prioritize the prompt-driven command without mandatory fingerprint entry and label exact flags as automation alternatives. Human explanations SHALL identify causal blockers and local baseline verification without relying on raw phase IDs or offering nonexistent migration or installer commands.

#### Scenario: A Windows project has spaces and shell metacharacters
- **WHEN** a repair check, approval, verification, recovery or resume action is emitted
- **THEN** its separate arguments target that exact project and its PowerShell text quotes each value safely
- **AND** the equivalent POSIX rendering preserves the same authority and paths

#### Scenario: A repair commits only part of the requested journey
- **WHEN** repair has committed but cleanup, local setup or activation is not complete
- **THEN** human and machine output keep the committed outcome separate from remaining work
- **AND** next actions offer only commands implemented by the installed CLI
