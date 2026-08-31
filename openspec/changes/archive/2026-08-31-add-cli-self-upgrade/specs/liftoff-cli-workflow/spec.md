## ADDED Requirements

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
