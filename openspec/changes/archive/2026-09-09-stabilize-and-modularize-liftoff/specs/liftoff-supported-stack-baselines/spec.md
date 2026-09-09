## MODIFIED Requirements

### Requirement: Every Liftoff release owns one supported-stack baseline
The system SHALL package one schema-versioned supported-stack baseline that identifies the exact tested runtime releases, package-manager releases, spec-framework CLIs, direct dependency sets, OpenTofu providers, container image digests, and any release-owned packaged generator assets used by that Liftoff release. Every runtime consumer, generated template, workstation probe, dependency command, workflow, and user-facing version statement SHALL derive from or be validated against this baseline. Retired workload artifacts SHALL NOT remain active supported baseline entries, source-commit compatibility lanes, or installable generated surfaces.

#### Scenario: Render the same Liftoff release twice
- **WHEN** identical project plans are rendered on supported hosts with different network availability or newer upstream releases
- **THEN** both renders use the same committed baseline identities and produce byte-identical Liftoff-owned artifacts
- **AND** neither render resolves a mutable latest version

#### Scenario: Inspect a baseline entry
- **WHEN** a maintainer or automated check reads a named baseline entry
- **THEN** it can identify the ecosystem, exact version or immutable digest, supported release line, and canonical source
- **AND** generated paths referencing the entry are selected through explicit named mappings

#### Scenario: Retired workload baseline entries are absent
- **WHEN** a maintainer inspects the 0.11.0 supported-stack baseline for active generated surfaces
- **THEN** no Power Apps starter snapshot, source-commit mapping, or workload-specific asset entry appears as an active installable baseline surface
- **AND** the baseline does not claim historical Power Apps compatibility through active generation metadata

## ADDED Requirements

### Requirement: Retired workload fixtures are non-generative
The system SHALL classify any retained Power Apps artifact kept only for unsupported-workload detection or historical diagnostics as a negative non-generative fixture. Such fixtures MUST be explicit inventory entries and SHALL NOT participate in version selection, scaffold generation, freshness checks, dependency promotion, or compatibility claims.

#### Scenario: Retired manifest fixture stays out of generation
- **WHEN** baseline verification retains a Power Apps manifest fixture for unsupported-workload rejection
- **THEN** the fixture is identified as retired and non-generative
- **AND** it is not treated as a supported starter, dependency graph, or source-commit compatibility lane

#### Scenario: Retired fixture inventory resolves across operating systems
- **WHEN** the retired fixture inventory is resolved on Windows, macOS, or Linux
- **THEN** each retained fixture uses explicit logical naming and portable path parts
- **AND** no fixture path depends on a hardcoded operating-system separator
