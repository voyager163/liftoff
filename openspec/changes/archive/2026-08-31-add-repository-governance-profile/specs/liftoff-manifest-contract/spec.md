## REMOVED Requirements

### Requirement: Manifests record the generating CLI version and per-artifact content hashes
**Reason**: The writer contract moves from schema v4 to v5 and adds repository-governance profile identity and handoff state.

**Migration**: Preserve the existing generating-version and per-artifact hash semantics while writing their schema-v5 equivalent.

### Requirement: Manifest readers accept supported schema versions and reject others with guidance
**Reason**: The supported reader set expands to include schema v5 and the current writer changes from v4 to v5.

**Migration**: Continue reading v2-v4 through backward normalization, add strict v5 validation, and reject versions outside 2 through 5.

## ADDED Requirements

### Requirement: V5 manifests record generating identity and durable artifact hashes
The system SHALL write `liftoff.manifest.json` with `artifactVersion` 5, a `liftoffVersion` field containing the exact semver of the CLI that wrote the manifest, deterministic workload, framework, selected-agent, and repository-governance identity, and a `contentHash` for every durable Liftoff artifact entry computed over the exact bytes written to disk and formatted as `sha256:<hex>`.

#### Scenario: Generate a v5 manifest
- **WHEN** a developer initializes a project with `liftoff init`
- **THEN** the generated manifest declares `artifactVersion` 5
- **AND** records deterministic workload, framework, agent, governance, and durable artifact identity

#### Scenario: Hashes match the written files
- **WHEN** a durable Liftoff artifact, including a governance handoff file, is hashed with SHA-256
- **THEN** the result equals the hex portion of that artifact's manifest `contentHash`

#### Scenario: External framework and seed output have no durable hash entry
- **WHEN** an official framework initializer or one-time Liftoff seed creates a file
- **THEN** the manifest does not present that file as a hash-managed durable artifact

### Requirement: Manifest readers accept schemas 2 through 5
The system SHALL read manifest schema versions 2, 3, 4, and 5, SHALL write only schema version 5, and SHALL reject any other `artifactVersion` with an error that names the found version, supported versions, and remedy.

#### Scenario: Read a current manifest
- **WHEN** a CLI command reads a valid manifest whose `artifactVersion` is 5
- **THEN** it validates workload, framework, agent, governance, and artifact identity and proceeds normally

#### Scenario: Read a supported v4 manifest
- **WHEN** a CLI command reads a valid v4 manifest
- **THEN** it preserves the v4 workload, framework, and agent declarations
- **AND** normalizes governance as unspecified until plan defaults are applied by an appropriate command

#### Scenario: Read a supported v2 or v3 manifest
- **WHEN** a CLI command reads a valid legacy manifest
- **THEN** it preserves the existing workload normalization and framework uncertainty contracts
- **AND** does not fabricate live governance

#### Scenario: Reject an unsupported manifest version
- **WHEN** a CLI command reads a manifest whose `artifactVersion` is not 2, 3, 4, or 5
- **THEN** it exits 1 before artifact access
- **AND** states the found and supported versions and corrective action

### Requirement: V5 manifests distinguish governance handoff from enforcement
A v5 manifest SHALL record an append-only governance profile identifier and
state. An enabled profile SHALL include the exact packaged policy version and
use `handoff-generated` when every applicable handoff artifact is owned, or
update-only `handoff-partial` when one or more unrecorded conflicting
destinations remain user-owned. A partial manifest SHALL include hashes only
for handoff artifacts Liftoff wrote or adopted with identical bytes and SHALL
omit every preserved unrecorded conflict. A disabled profile SHALL record
`none` and disabled state without a policy version. No manifest field SHALL
claim that branches, checks, rulesets, security features, deployments,
monitoring, or release controls are live.

#### Scenario: Record enabled governance
- **WHEN** the plan selects `single-maintainer-gitflow`
- **THEN** a complete initialization or adoption records that profile, the current policy version, and `handoff-generated`
- **AND** includes hashes for each applicable exact handoff artifact

#### Scenario: Record partial governance adoption
- **WHEN** update preserves different bytes at an unrecorded applicable handoff destination
- **THEN** the manifest records the selected profile, current policy version, and `handoff-partial`
- **AND** omits the preserved destination from durable ownership while retaining exact hashes for every handoff artifact written or adopted
- **AND** a later update continues to classify that destination as an unrecorded conflict until the developer resolves it

#### Scenario: Record disabled governance
- **WHEN** the plan selects `none`
- **THEN** the manifest records disabled governance
- **AND** omits policy version and governance artifact entries

#### Scenario: Host GitHub state differs
- **WHEN** identical plans are rendered while live GitHub settings differ or cannot be observed
- **THEN** their v5 manifest bytes remain identical

### Requirement: Governance identifiers and logical names are append-only
The governance profile identifiers, governance state identifiers, and logical names for the canonical policy, context, guide, and agent launchers SHALL follow the existing append-only contract. Generated artifact paths SHALL be represented as non-empty OS-neutral path-part arrays and validated inside the project root.

#### Scenario: Add a future governance profile
- **WHEN** a later release adds another repository-governance profile
- **THEN** existing `single-maintainer-gitflow` and `none` identifiers retain their meanings

#### Scenario: Validate governance paths on Windows
- **WHEN** a v5 manifest is loaded on Windows
- **THEN** governance path parts resolve under the project root using platform-native path handling
- **AND** embedded separators, traversal, drive-qualified parts, UNC paths, and symlink escapes are rejected before access
