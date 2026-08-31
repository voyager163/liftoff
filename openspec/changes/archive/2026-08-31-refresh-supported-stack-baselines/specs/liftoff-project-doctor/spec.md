## ADDED Requirements

### Requirement: Doctor validates locked dependency readiness
The system SHALL use the supported-stack baseline and explicit workload identity to check that every expected dependency manifest and lock pair exists, agrees on project identity, and can be consumed without mutation. Doctor SHALL remain read-only and SHALL report missing, stale, malformed, or mismatched metadata with the exact frozen install or repair command.

#### Scenario: Check a locked Python project
- **WHEN** doctor runs inside a Python project with `pyproject.toml` and `uv.lock`
- **THEN** it verifies the expected lock is present and reports `uv sync --frozen` as the dependency command
- **AND** it does not run `uv lock` or change either file

#### Scenario: Check npm and Go metadata
- **WHEN** doctor runs inside a Node.js, frontend, Power Apps, or Go project
- **THEN** it validates the explicit package-lock or module-checksum pair applicable to that workload
- **AND** it omits unrelated ecosystem checks

#### Scenario: Lock metadata is missing
- **WHEN** an expected lockfile or checksum file is absent
- **THEN** doctor reports a failure naming the missing path and baseline-owned dependency set
- **AND** it does not report dependency readiness as successful

#### Scenario: Check paths on Windows
- **WHEN** doctor resolves dependency files in a project on Windows
- **THEN** it uses the same explicit path-part definitions as generation
- **AND** produces the same logical check identifiers as macOS and Linux

### Requirement: Doctor reports baseline identity without resolving it
Doctor SHALL report the current Liftoff supported-stack baseline identity and applicable runtime constraints from packaged state. It MAY perform the existing bounded Liftoff CLI freshness lookup, but SHALL NOT contact dependency registries to replace or rewrite the project's baseline.

#### Scenario: Run doctor offline
- **WHEN** dependency registries are unavailable
- **THEN** doctor still reports the packaged baseline and completes every local check
- **AND** it does not classify the project as upgraded from cached or speculative registry data
