## ADDED Requirements

### Requirement: CLI exposes a strictly read-only governance assessment
The CLI SHALL expose `liftoff governance assess [project] [--json] [--live]`
with existing safe project discovery, command-specific help, and the optional
`--project` alternative. The command SHALL default to local-only assessment.
Only `assess` SHALL accept `--live`; assessment SHALL reject execution, force,
installation, automatic-upgrade, and output-file flags before project access.
Existing governance subcommand meanings SHALL remain unchanged.

#### Scenario: Run a local assessment
- **WHEN** the developer invokes `liftoff governance assess --json` inside a Liftoff project
- **THEN** the CLI returns the local assessment without network requests or project writes
- **AND** live-only comparisons are explicitly unobserved

#### Scenario: Request live comparison
- **WHEN** the developer invokes `liftoff governance assess --live --json`
- **THEN** only supported scoped read operations are authorized
- **AND** the command does not enroll credentials or execute remediation

#### Scenario: Reject mutation flags
- **WHEN** assessment receives `--execute`, `--force`, or an installation or upgrade flag
- **THEN** argument validation fails before project discovery, network calls, or writes

#### Scenario: Reject misplaced live flag
- **WHEN** another governance subcommand receives `--live`
- **THEN** parsing fails rather than broadening that subcommand's behavior

#### Scenario: Show help without a project
- **WHEN** `liftoff governance assess --help` runs outside a project
- **THEN** it describes local/live behavior, output, limitations, and exit codes
- **AND** performs no project or credential discovery

#### Scenario: Resolve a project on supported operating systems
- **WHEN** assessment is invoked from a nested directory or with an explicit project path containing spaces on Windows, macOS, or Linux
- **THEN** it resolves the intended Liftoff project through the existing safe path rules
- **AND** conflicting positional and `--project` targets are rejected

### Requirement: Assessment output distinguishes alignment, differences, and incomplete coverage
Valid assessment invocations SHALL produce a schema-v1 report with
`readOnly: true`, mode, pinned target, recorded identity availability, findings,
provenance, diagnostics, coverage, and outcome. Human and JSON output SHALL
derive from the same report. Exit 0 SHALL mean fully observed alignment or
explicit `not-applicable` disabled governance; exit 2 SHALL mean `differences`
or `partial`; exit 1 SHALL mean an invalid or unsafe request/input or catalog
error. Accepted exceptions SHALL remain visible differences, not exact
alignment.

#### Scenario: Fully observed controls match
- **WHEN** every applicable catalog control has valid required proof and no difference or exception
- **THEN** outcome is `aligned` and exit code is 0

#### Scenario: Known difference is observed
- **WHEN** complete observation finds outdated, missing, conflicting, or approved-exception controls
- **THEN** outcome is `differences` and exit code is 2
- **AND** the report distinguishes actionable differences from accepted exceptions

#### Scenario: Some proof cannot be collected
- **WHEN** applicable proof or applicability remains unknown
- **THEN** outcome is `partial` and exit code is 2
- **AND** known differences and coverage limitations are both retained

#### Scenario: A report cannot be trusted
- **WHEN** a syntactically valid JSON invocation encounters an unsafe path, malformed required input, or invalid packaged catalog
- **THEN** it returns a versioned error report with safe diagnostics and exit code 1
- **AND** does not emit a success-shaped fallback

#### Scenario: Governance is explicitly disabled
- **WHEN** the resolved project profile is `none`
- **THEN** outcome is `not-applicable` and exit code is 0
- **AND** neither human nor JSON output describes governance as aligned or activated
