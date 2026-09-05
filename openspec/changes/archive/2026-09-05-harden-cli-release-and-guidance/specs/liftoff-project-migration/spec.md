## ADDED Requirements

### Requirement: Generated OpenSpec migration work is planning-complete and strict-valid
When migration uses OpenSpec, the generated adoption change SHALL include
schema metadata, a coherent proposal, design, tasks, and proposal-declared
delta specifications. New capability deltas SHALL contain a concrete Purpose.
The staged change SHALL pass strict validation before the target merge.
Generated requirements SHALL describe controlled source adoption and behavior
preservation without inventing domain-specific implementation or marking
adoption tasks complete.

#### Scenario: Migrate with the default OpenSpec workflow
- **WHEN** Liftoff adopts an existing source tree into a fresh generated target
- **THEN** the migration change has all required planning artifacts and passes `openspec validate <change> --strict`
- **AND** the source tree is unchanged

#### Scenario: Bootstrap archive validates all changes
- **WHEN** the generated bootstrap is archived and the complete OpenSpec set is validated
- **THEN** the pending migration change does not fail because metadata, declared deltas, or design are absent
- **AND** its adoption tasks remain pending for their actual implementation

#### Scenario: Validate on supported operating systems
- **WHEN** migration runs from source and target paths containing spaces on Windows, macOS, or Linux
- **THEN** strict validation receives the correct staged project directory
- **AND** artifacts use the same stable logical names and portable path parts
