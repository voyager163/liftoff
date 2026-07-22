# liftoff-manifest-contract

## ADDED Requirements

### Requirement: Manifests record the generating CLI version and per-artifact content hashes
The system SHALL write `liftoff.manifest.json` with `artifactVersion` 2, a `liftoffVersion` field containing the exact semver of the CLI that wrote the manifest, and a `contentHash` for every artifact entry computed over the exact bytes written to disk, formatted as `sha256:<hex>`.

#### Scenario: Generate a v2 manifest
- **WHEN** a developer creates a project with `liftoff create`
- **THEN** the generated `liftoff.manifest.json` declares `artifactVersion` 2, records the CLI package version as `liftoffVersion`, and includes a `contentHash` beginning with `sha256:` for every artifact entry

#### Scenario: Hashes match the written files
- **WHEN** a project is generated and an artifact file on disk is hashed with SHA-256
- **THEN** the result equals the hex portion of that artifact's `contentHash` in the manifest

#### Scenario: Hash format carries the algorithm prefix
- **WHEN** any content hash is written to a manifest
- **THEN** the value is prefixed with the algorithm identifier so the algorithm can change in a future schema version without ambiguity

### Requirement: Manifest readers accept supported schema versions and reject others with guidance
The system SHALL read every supported manifest schema version, SHALL write only the latest schema version, and SHALL reject manifests with an unsupported `artifactVersion` with an error message that names the remedy. Manifest schema v2 is the first supported version.

#### Scenario: Read a current manifest
- **WHEN** a CLI command reads a manifest whose `artifactVersion` is 2
- **THEN** the command proceeds normally

#### Scenario: Reject an unsupported manifest version
- **WHEN** a CLI command reads a manifest whose `artifactVersion` is not a supported version
- **THEN** the command fails with a message stating the found and supported versions and advising the developer to regenerate the project or use a matching CLI version

### Requirement: Artifact logical names and catalog identifiers are append-only
The system SHALL treat artifact `logicalName` values and catalog identifiers (patterns, providers, environments, spec workflows) as a stable public contract: new identifiers may be added, but existing identifiers SHALL NOT be renamed or removed, and a CI contract test SHALL fail when the generated `logicalName` set changes relative to its checked-in snapshot.

#### Scenario: Contract test guards logical names
- **WHEN** the test suite runs against a representative set of project plans
- **THEN** the sorted list of generated `logicalName` values matches the checked-in snapshot
- **AND** a mismatch fails with a message stating the append-only policy

#### Scenario: New artifact added to templates
- **WHEN** a contributor adds a new generated artifact with a new `logicalName` and updates the snapshot
- **THEN** the contract test passes without any existing `logicalName` changing

### Requirement: Artifact rendering is deterministic
The system SHALL render identical artifact bytes for identical project plans within a single CLI version; rendered content SHALL NOT depend on time, randomness, host environment, or filesystem state, and a CI test SHALL verify double-render byte equality.

#### Scenario: Double render is byte-identical
- **WHEN** the test suite renders the same project plan twice
- **THEN** every artifact's content is byte-identical across the two renders, including the manifest

### Requirement: Machine-state namespaces in generated projects are reserved
The system SHALL store machine-readable paths as OS-neutral path-part arrays rather than joined path strings, SHALL reserve the `.liftoff/` directory name in generated projects for future CLI-managed state, and SHALL NOT introduce new CLI-managed files at the project root beyond `liftoff.config.json` and `liftoff.manifest.json`.

#### Scenario: Manifest paths are portable
- **WHEN** a manifest is generated on any supported operating system
- **THEN** every artifact location is stored as an array of path segments with no platform-specific separators

#### Scenario: Root namespace stays fixed
- **WHEN** future CLI features need to persist machine state in a generated project
- **THEN** that state is placed under `.liftoff/` rather than as new root-level files

### Requirement: CLI outputs follow shared exit-code and JSON conventions
The system SHALL use exit code 0 for success or a clean check, 1 for failures, and 2 for a check that found drift; and every machine-readable `--json` output SHALL include a top-level numeric `schemaVersion` field.

#### Scenario: JSON output is versioned
- **WHEN** a CLI command that offers `--json` emits machine-readable output
- **THEN** the output object contains a top-level `schemaVersion` number

#### Scenario: Exit codes are consistent across commands
- **WHEN** any CLI command completes
- **THEN** it exits 0 on success or clean status, 1 on failure, and 2 when a check mode found drift
