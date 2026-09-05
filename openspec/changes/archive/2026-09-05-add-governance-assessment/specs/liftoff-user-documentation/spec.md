## ADDED Requirements

### Requirement: Documentation distinguishes assessment from update and activation
Public, generated governance, and developer documentation SHALL describe
`/liftoff-governance-assess` and `liftoff governance assess` as read-only
comparison, with local-only default and explicit live observation. Guidance
SHALL identify the installed CLI as the pinned target, describe classifications,
coverage, provenance and exit codes, and preserve `/liftoff-setup` as the primary
post-init path. Assessment SHALL not be presented as an upgrade, migration,
activation, or alternative setup alias.

#### Scenario: Developer wants to see differences
- **WHEN** a developer reads assessment guidance
- **THEN** it explains target versus recorded baseline versus declared configuration versus observed enforcement
- **AND** identifies expected value, observed value, evidence, impact, and advisory remediation in the report

#### Scenario: Developer does not want network access
- **WHEN** the developer follows the default assessment example
- **THEN** it uses the local-only form and requires no cloud or GitHub credentials
- **AND** explains why applicable live controls remain unobserved

#### Scenario: Developer requests live assessment
- **WHEN** documentation introduces `--live`
- **THEN** it states the bounded existing-permission read scope and no-mutation boundary
- **AND** explains that unavailable access means not observed rather than missing or aligned

#### Scenario: Assessment is partial or excepted
- **WHEN** a report has incomplete coverage or an approved exception
- **THEN** guidance does not describe exit 2 as proof that governance is broken or as permission to repair it
- **AND** does not describe partial coverage or an exception as exact full-policy alignment

#### Scenario: Upgrade is blocked by compatibility
- **WHEN** assessment identifies an unsupported policy or graph mapping
- **THEN** guidance names the unavailable migration capability without suggesting a nonexistent command
- **AND** states that force-update cannot overwrite user-owned configuration or bypass compatibility

#### Scenario: Developer installs a newer assessment integration
- **WHEN** an existing compatible project needs the new selected-agent command
- **THEN** documentation points to the normal managed-core update flow and its conflict safeguards
- **AND** states that neither installing the integration nor running it activates governance

#### Scenario: Maintainer extends policy assessment coverage
- **WHEN** the developer guide describes a new control or evaluator
- **THEN** it requires stable IDs, policy/catalog digest coherence, explicit unsupported coverage, deterministic fixtures, read-only operation tests, and cross-platform path coverage
- **AND** does not introduce a manually maintained assessment-skill version
