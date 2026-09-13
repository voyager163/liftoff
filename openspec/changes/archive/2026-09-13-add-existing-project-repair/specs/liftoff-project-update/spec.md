## ADDED Requirements

### Requirement: Infrastructure revalidation blockers offer the real repair handoff
Update SHALL explain that `seed-verified` means local baseline verification, not an unfinished feature change. When recorded infrastructure requires reorganization, human and machine-readable output SHALL identify the repair command targeted to the same project, explain the ownership/approval boundary, and provide the subsequent update check. Ordinary update approval SHALL NOT authorize infrastructure repair.

#### Scenario: Legacy infrastructure blocks migrated activation
- **WHEN** activation history migration commits but local verification encounters a legacy layout
- **THEN** output states that migration committed while local baseline verification remains blocked
- **AND** it presents `liftoff repair` check for the selected project instead of manual manifest edits or an internal phase-mismatch message

#### Scenario: Explicit project outside current directory
- **WHEN** update targets another project
- **THEN** all repair and resume commands preserve that project selection with platform-correct quoting
