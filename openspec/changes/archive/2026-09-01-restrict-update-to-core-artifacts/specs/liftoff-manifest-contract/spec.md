## RENAMED Requirements

- FROM: `### Requirement: Manifest readers accept schemas 2 through 5`
- TO: `### Requirement: Manifest readers accept schemas 2 through 6`

- FROM: `### Requirement: Framework-owned and seed files remain outside durable artifact ownership`
- TO: `### Requirement: Only managed-core files carry durable update authority`

## MODIFIED Requirements

### Requirement: Manifest readers accept schemas 2 through 6
The system SHALL read manifest schema versions 2, 3, 4, 5, and 6, SHALL write only schema version 6, and SHALL reject any other `artifactVersion` with an error that names the found version, supported versions, and remedy. Readers SHALL normalize v2 through v5 artifact entries through the current explicit lifecycle declarations without treating unknown entries as managed core.

#### Scenario: Read a current manifest
- **WHEN** a CLI command reads a valid manifest whose `artifactVersion` is 6
- **THEN** it validates workload, framework, agent, governance, managed-core, and project-provenance identity and proceeds normally

#### Scenario: Read a supported v5 manifest
- **WHEN** a CLI command reads a valid v5 manifest
- **THEN** it preserves workload, framework, agent, governance, and recorded generation hashes
- **AND** normalizes only explicitly declared core logical names as managed core

#### Scenario: Read a supported v4 manifest
- **WHEN** a CLI command reads a valid v4 manifest
- **THEN** it preserves the v4 workload, framework, and agent declarations
- **AND** defaults unknown or non-core durable entries to project provenance

#### Scenario: Read a supported v2 or v3 manifest
- **WHEN** a CLI command reads a valid v2 or v3 manifest
- **THEN** it preserves the existing workload normalization and framework uncertainty contracts
- **AND** defaults unknown or non-core durable entries to project provenance

#### Scenario: Reject an unsupported manifest version
- **WHEN** a CLI command reads a manifest whose `artifactVersion` is not 2, 3, 4, 5, or 6
- **THEN** it exits 1 before artifact access
- **AND** states the found and supported versions and corrective action

### Requirement: Only managed-core files carry durable update authority
The system SHALL use explicit logical artifact declarations to distinguish managed core, project provenance, desired state, official framework output, and one-time seed content. Reconciliation SHALL operate only on managed-core logical names plus separately authorized create-only component provisioning. It SHALL NOT select authority by directory pattern, filename, category, current disk hash, or unknown legacy identity.

#### Scenario: Framework files are validated without hashes
- **WHEN** an official initializer creates framework-owned commands, skills, scripts, or templates
- **THEN** the manifest can identify framework integration without creating managed-core entries for those paths

#### Scenario: Project files retain provenance without authority
- **WHEN** Liftoff generates source, dependencies, containers, environments, documentation, database files, or infrastructure
- **THEN** the manifest records project provenance
- **AND** update cannot use those generation hashes to restore or replace the files

#### Scenario: Update uses explicit durable lookup
- **WHEN** `liftoff update` calculates changes for any supported manifest
- **THEN** it looks up exact managed-core logical names from current lifecycle declarations
- **AND** it does not select files for replacement or deletion by path or category matching

#### Scenario: Unknown legacy artifact fails safe
- **WHEN** a legacy manifest contains a logical name absent from the current lifecycle declarations
- **THEN** the reader treats it as project provenance rather than managed core

### Requirement: Legacy v2 manifests normalize framework state without false claims
The system SHALL continue to accept valid v2 manifests and SHALL normalize their missing framework and agent metadata as explicit legacy state. A v2 reader SHALL NOT infer that any agent integration was officially initialized. A later v6 rewrite SHALL preserve that uncertainty unless the project has gone through a supported framework-initialization flow.

#### Scenario: Read v2 project identity
- **WHEN** a valid v2 manifest contains a spec workflow but no framework contract or agent list
- **THEN** downstream validation, doctor, and update behavior treats the framework state as legacy with no declared agent integrations

#### Scenario: Rewrite v2 without fabricating agents
- **WHEN** plain `liftoff update` rewrites a valid v2 project without running framework initialization
- **THEN** the v6 manifest records legacy framework state and no configured agents
- **AND** it does not claim that Copilot or Claude Code was installed or integrated

## ADDED Requirements

### Requirement: V6 manifests separate managed-core authority and project provenance
The system SHALL write `liftoff.manifest.json` with `artifactVersion` 6 and a `liftoffVersion` containing the exact semver of the CLI that wrote the manifest. The manifest SHALL record deterministic workload, framework, selected-agent, and repository-governance identity; managed-core entries SHALL carry `contentHash` values over the exact bytes Liftoff is authorized to reconcile, while project entries SHALL carry distinct generation provenance that cannot authorize update writes. Desired-state, framework-owned, and seed files SHALL remain outside managed-core hashes.

#### Scenario: Generate a v6 manifest
- **WHEN** a developer initializes a project with `liftoff init`
- **THEN** the generated manifest declares `artifactVersion` 6
- **AND** separates managed-core entries from project generation provenance

#### Scenario: Managed-core hashes match written files
- **WHEN** a managed-core artifact is hashed with SHA-256
- **THEN** the result equals the hex portion of that artifact's manifest `contentHash`

#### Scenario: Project hash records provenance only
- **WHEN** a project artifact is generated
- **THEN** its manifest entry records the generating Liftoff version and generation hash
- **AND** changing, relocating, or deleting that file does not grant Liftoff reconciliation authority

#### Scenario: External framework and seed output have no core hash
- **WHEN** an official framework initializer or one-time Liftoff seed creates a file
- **THEN** the manifest does not present that file as a managed-core artifact

### Requirement: Manifest migration releases broad legacy ownership atomically
When plain update rewrites a supported v2 through v5 manifest, the system SHALL atomically convert explicit current core entries to managed-core state and all other durable entries to project provenance. It SHALL preserve each legacy generation hash and path as provenance even when the file is modified or absent, and SHALL perform no project-file mutation as a consequence of reclassification.

#### Scenario: Rewrite a v5 production project
- **WHEN** a v5 manifest records backend, frontend, database, container, environment, documentation, and infrastructure artifacts
- **THEN** the v6 rewrite records those entries as project provenance
- **AND** only exact current core entries retain content-hash update authority

#### Scenario: Manifest transaction fails
- **WHEN** ownership migration cannot atomically replace the manifest
- **THEN** update exits 1 without claiming migration success
- **AND** no project file is changed

#### Scenario: Older CLI reads v6
- **WHEN** a Liftoff version that supports only schemas through v5 reads the v6 manifest
- **THEN** it rejects the unsupported schema before artifact access
- **AND** cannot fall back to broad legacy write authority

## REMOVED Requirements

### Requirement: V5 manifests record generating identity and durable artifact hashes
**Reason**: Schema v5 gives project starter files the same durable hash authority as Liftoff control-plane files and cannot represent the production ownership boundary.

**Migration**: Schema-v6 writers preserve v5 recorded hashes as either managed-core content state or project generation provenance according to explicit lifecycle declarations.
