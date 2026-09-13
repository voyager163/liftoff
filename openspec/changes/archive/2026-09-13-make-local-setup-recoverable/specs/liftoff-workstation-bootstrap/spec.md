## MODIFIED Requirements

### Requirement: Liftoff automatically detects tool presence, version, and health
The system SHALL run allowlisted read-only probes for every selected requirement before destination writes and classify availability, compatibility, and health with a specific cause. It SHALL compare versioned runtimes, package managers, and framework tools with their registered tested constraints rather than registry latest. Stable exact pins and runtime floors SHALL continue rejecting prereleases unless explicitly allowed. Compatible official stable or preview Copilot, Claude, and Codex installations SHALL satisfy their agent requirements, with preview status reported as a notice rather than an outdated-tool blocker.

#### Scenario: Supported runtime is ready
- **WHEN** the selected Python runtime probe returns a version satisfying the registered minimum
- **THEN** Liftoff reports Python as ready and does not offer to reinstall it

#### Scenario: Outdated runtime is not accepted
- **WHEN** a selected runtime is installed below its registered minimum version
- **THEN** Liftoff reports the observed and required versions and treats the blocking requirement as unresolved

#### Scenario: Failed probe is not a successful check
- **WHEN** a tool executable exists but its version or required health probe exits unsuccessfully
- **THEN** Liftoff reports the actual probe failure
- **AND** does not classify the tool as satisfying a required constraint

#### Scenario: Unselected runtimes are omitted
- **WHEN** a standard Node.js project is selected
- **THEN** Python and Go backend runtime probes are not required for that project

#### Scenario: Stable exact pin rejects a prerelease build
- **WHEN** a selected framework CLI or package manager is required at an exact stable version and the probe returns its numeric version with a prerelease suffix
- **THEN** Liftoff reports the observed prerelease as incompatible with that requirement
- **AND** it does not classify the tool as satisfying the stable exact pin

#### Scenario: Stable runtime floor rejects a prerelease
- **WHEN** a stable Python floor is required and the observed interpreter is a release candidate
- **THEN** its prerelease identity is retained and the runtime is not silently accepted as stable

#### Scenario: Compatible preview coding agent is installed
- **WHEN** a selected Copilot, Claude, or Codex installation is usable and compatible but reports an official preview version
- **THEN** the agent requirement is ready with a preview notice
- **AND** setup does not demand a downgrade merely to remove the suffix

#### Scenario: A newer compatible release exists
- **WHEN** an installed tool satisfies its declared constraints but a newer release is available
- **THEN** update availability is advisory
- **AND** the existence of that release alone does not block the requested operation

### Requirement: Installation commands are allowlisted and verified
The system SHALL represent probes and remediation recipes as a registry-owned executable and argument array, SHALL NOT interpolate project input into shell command strings, SHALL fail on a non-zero installer exit, and SHALL re-probe before marking a tool ready. It SHALL select remedies according to the actual cause and installation origin, compare before/after observations, and distinguish improvement, unchanged incompatibility, failed execution, and genuine executable-discovery problems. An installer exit of zero SHALL not establish that files were written or that PATH is faulty.

#### Scenario: Installation succeeds and verifies
- **WHEN** an allowlisted installer exits successfully and the post-install probe satisfies the registered constraint
- **THEN** the requirement becomes ready and initialization continues

#### Scenario: Installer exits unsuccessfully
- **WHEN** an installation command exits non-zero
- **THEN** Liftoff stops the dependent operation and displays the failed command, exit result, and causal remedy

#### Scenario: Installer success does not hide failed verification
- **WHEN** an installer exits zero but the installed command remains missing or incompatible
- **THEN** Liftoff keeps the requirement unresolved and reports the actual post-install result
- **AND** incompatibility is not relabeled as an executable-discovery failure

#### Scenario: Terminal restart is required
- **WHEN** installation succeeds but the executable is not observable in the current process after documented locations are checked
- **THEN** Liftoff reports the discovery evidence and a terminal/PATH remedy
- **AND** it does not claim that project initialization completed

#### Scenario: Package manager makes no change
- **WHEN** an installer exits zero and the same executable, version, and unsatisfied constraint remain
- **THEN** the result identifies no progress and retains the original incompatibility reason
- **AND** it neither claims the installer wrote the existing executable nor recommends the identical ineffective command repeatedly

#### Scenario: Version probe succeeds but a channel requirement fails
- **WHEN** the command is found and exits successfully but a requirement that demands stable rejects its channel
- **THEN** the remedy describes the actual supported channel/version operation or its availability limitation
- **AND** it does not ask the developer to repair PATH merely because the requirement is unresolved

#### Scenario: Windows installer leaves a shim unresolved
- **WHEN** a registered Windows installation succeeds but the current process cannot resolve its executable shim
- **THEN** native path and shim observations determine whether restart guidance is appropriate
- **AND** an already resolved incompatible executable is not confused with this case

## ADDED Requirements

### Requirement: Version parsing preserves identity without presentation punctuation
Workstation probes SHALL parse the registered tools' supported output formats, preserving real prerelease/build identifiers while excluding surrounding prose and presentation punctuation. The observed version and executable SHALL be shown separately from the requirement and its cause. Unparseable output SHALL not be used to satisfy a versioned constraint.

#### Scenario: Stable Copilot output ends in a period
- **WHEN** the probe returns `GitHub Copilot CLI 1.0.83.`
- **THEN** the observed version is `1.0.83`, not an absent version

#### Scenario: Preview Copilot output ends in a period
- **WHEN** the probe returns `GitHub Copilot CLI 1.0.84-5.`
- **THEN** the observed version is `1.0.84-5` without the final period
- **AND** its preview identity is retained

#### Scenario: A framework uses a numeric prerelease identifier
- **WHEN** a stable-pinned framework returns a real version such as `1.11.0-1`
- **THEN** the numeric prerelease is preserved and rejected for that stable pin
- **AND** the coding-agent policy does not weaken the framework constraint

### Requirement: Workstation failures are scoped to dependent operations
Liftoff SHALL identify which requested operation depends on an unresolved tool. Required local runtimes, framework commands, selected agent installations, and applicable baseline tools SHALL remain prerequisites for that local work. Cloud authentication, provider operations, and unrelated optional tools SHALL not prevent otherwise completed local setup. Authentication notices SHALL remain user-controlled.

#### Scenario: Azure authentication is unavailable during local setup
- **WHEN** local project checks do not require provider access and Azure authentication is unavailable
- **THEN** local completion is not blocked solely by that activation prerequisite

#### Scenario: A required baseline executable is missing
- **WHEN** an applicable local check needs an unavailable executable
- **THEN** that check remains incomplete with a supported installation/remediation action
- **AND** the CLI does not silently skip it to declare completion

#### Scenario: Codex is the only selected agent
- **WHEN** Codex alone is selected for either supported framework
- **THEN** readiness probes Codex through its registered executable
- **AND** it does not require Copilot or Claude to satisfy agent readiness

### Requirement: Activation and stateful execution have their own prerequisites
When the requested journey enters activation or stateful migration, Liftoff SHALL verify the actual required provider, GitHub, OpenTofu, artifact, authentication, private-access, and protected-storage capabilities for that scope. Those requirements SHALL not retroactively make unrelated local readiness false. Installation, authentication assistance, secure enrollment, and state inspection SHALL retain distinct permissions and use registered bounded operations.

#### Scenario: Local work can complete without cloud access
- **WHEN** required local tools are ready but activation identity or private access is unavailable
- **THEN** local completion remains valid and activation identifies its exact pending prerequisite

#### Scenario: A stateful execution host cannot protect state
- **WHEN** private storage, required backend access, key access, or locking support is unavailable on that host
- **THEN** stateful execution is blocked before sensitive mutation
- **AND** it does not fall back to unprotected files or a different unapproved host

#### Scenario: Cloud authentication assistance is requested
- **WHEN** the developer explicitly authorizes a registered provider authentication flow
- **THEN** it uses the owner-controlled secure mechanism and reports resulting identity/scope
- **AND** no credential value is collected through chat or placed in source/arguments
