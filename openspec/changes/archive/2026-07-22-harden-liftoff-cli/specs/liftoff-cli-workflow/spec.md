## ADDED Requirements

### Requirement: CLI syntax is command-specific and strict
The system SHALL validate commands, subcommands, positional arguments, and flags against an explicit command definition before executing command behavior. Unknown flags, unsupported subcommands, missing values, invalid boolean forms, and unexpected positional arguments MUST exit 1, identify the invalid token, and produce no project or cloud side effects.

#### Scenario: Reject a misspelled create flag
- **WHEN** a developer supplies an unknown flag such as `--cluod` or `--frontned`
- **THEN** Liftoff exits 1, identifies the unknown flag, and does not generate a project using fallback defaults

#### Scenario: Reject an unsupported helper subcommand
- **WHEN** a developer runs a helper with an unsupported subcommand such as `liftoff dev destroy`
- **THEN** Liftoff exits 1 and lists the supported subcommands instead of printing a default command

#### Scenario: Reject an unsupported region subcommand
- **WHEN** a developer runs `liftoff regions typo`
- **THEN** Liftoff exits 1 rather than listing all regions

#### Scenario: Render a missing-value error without a stack trace
- **WHEN** a value-taking flag such as `--pattern` has no value
- **THEN** Liftoff exits 1 with concise usage guidance and does not print a JavaScript stack trace

#### Scenario: Show command-specific help
- **WHEN** a developer runs a supported command with `--help`
- **THEN** Liftoff exits 0 and prints that command's supported arguments, flags, and subcommands without validating required project options

### Requirement: Configuration files are runtime-validated
The system SHALL validate JSON configuration values by field name and runtime type before merging them with flags. Catalog-backed strings MUST resolve through existing catalog lookups, booleans MUST be JSON booleans, lists MUST contain strings, and invalid configuration MUST exit 1 before planning or generation.

#### Scenario: Reject a string boolean
- **WHEN** `liftoff.config.json` contains `"includeFrontend": "false"`
- **THEN** Liftoff reports that `includeFrontend` must be a boolean and does not generate a frontend

#### Scenario: Reject a non-string catalog value
- **WHEN** a configuration supplies a non-string project type, API stack, pattern, provider, region, or spec workflow
- **THEN** Liftoff exits 1 with the field name instead of exposing a JavaScript type error

#### Scenario: Reject an invalid environment list
- **WHEN** a configuration environment value is not an array of supported environment strings
- **THEN** Liftoff reports the invalid field and performs no write

#### Scenario: Flags override a valid configuration
- **WHEN** a valid command flag overrides a compatible value from a valid configuration file
- **THEN** the normal documented flag precedence remains unchanged
