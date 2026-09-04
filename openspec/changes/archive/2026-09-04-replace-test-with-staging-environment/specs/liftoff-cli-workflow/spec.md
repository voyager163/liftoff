## ADDED Requirements

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
