## ADDED Requirements

### Requirement: Generic is an explicit stable GenAI pattern identity
The system SHALL define `generic` as an append-only GenAI pattern identifier and SHALL record it consistently in `liftoff.config.json`, schema-v6 manifest workload identity, generated project guidance, bootstrap specifications, and governance context. Uncertainty SHALL NOT be represented by a missing pattern or by substituting another pattern identifier.

#### Scenario: Generate a generic project manifest
- **WHEN** a developer initializes a project with the generic GenAI pattern
- **THEN** configuration and manifest workload identity both record `pattern: generic`
- **AND** generated project artifacts retain normal project-owned lifecycle and provenance semantics

#### Scenario: Read a generic project manifest
- **WHEN** validation, doctor, or update reads a schema-v6 manifest containing the `generic` pattern
- **THEN** the pattern resolves through the same strict catalog validation as every specialized pattern

#### Scenario: Reject missing GenAI pattern identity
- **WHEN** a GenAI configuration or manifest omits its pattern instead of selecting `generic`
- **THEN** the system reports the existing required-field validation error

#### Scenario: Preserve append-only pattern identifiers
- **WHEN** `generic` is added to the pattern catalog
- **THEN** all eight existing pattern identifiers and meanings remain unchanged
