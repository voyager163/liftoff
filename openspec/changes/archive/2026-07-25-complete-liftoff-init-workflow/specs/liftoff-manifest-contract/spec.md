## ADDED Requirements

### Requirement: Manifest v3 records deterministic framework and agent identity
The system SHALL record the selected spec workflow, a canonical ordered set of selected AI coding-agent identifiers, the default agent when required, the framework adapter identifier, and the exact tested framework contract version in every new v3 manifest. It SHALL NOT record host-specific runtime, package-manager, Docker daemon, infrastructure-tool, or agent versions.

#### Scenario: Record OpenSpec with both agents
- **WHEN** a new project is initialized with OpenSpec, GitHub Copilot, and Claude Code
- **THEN** the v3 manifest records the OpenSpec adapter and tested contract version plus both normalized agent identifiers in canonical order
- **AND** it does not require a default-agent field

#### Scenario: Record Spec Kit default agent
- **WHEN** a new project is initialized with Spec Kit, both agents, and Claude Code as the default
- **THEN** the v3 manifest records both normalized agent identifiers and Claude Code as the default

#### Scenario: Host versions do not affect manifest bytes
- **WHEN** identical project plans are initialized with different compatible patch versions of Python, Go, Docker, or a coding agent
- **THEN** those observed workstation versions do not change the rendered manifest bytes

### Requirement: Framework-owned and seed files remain outside durable artifact ownership
The system SHALL use manifest framework metadata and declared integration markers to validate official framework setup without adding framework-owned core output or write-once Liftoff seed content to the durable hashed artifact list. Reconciliation SHALL operate only on explicit durable logical names.

#### Scenario: Framework files are validated without hashes
- **WHEN** an official initializer creates framework-owned commands, skills, scripts, or templates
- **THEN** the manifest can identify the framework contract and integrations without creating durable Liftoff artifact entries for those paths

#### Scenario: Update uses explicit durable lookup
- **WHEN** `liftoff update` calculates changes for a v3 project
- **THEN** it looks up named durable artifacts from the manifest
- **AND** it does not select files for replacement or deletion by matching a framework-directory pattern

### Requirement: Legacy v2 manifests normalize framework state without false claims
The system SHALL continue to accept valid v2 manifests and SHALL normalize their missing framework and agent metadata as explicit legacy state. A v2 reader SHALL NOT infer that any agent integration was officially initialized. A later v3 rewrite SHALL preserve that uncertainty unless the project has gone through a supported framework-initialization flow.

#### Scenario: Read v2 project identity
- **WHEN** a valid v2 manifest contains a spec workflow but no framework contract or agent list
- **THEN** downstream validation, doctor, and update behavior treats the framework state as legacy with no declared agent integrations

#### Scenario: Rewrite v2 without fabricating agents
- **WHEN** `liftoff update --apply` rewrites a valid v2 project to v3 without running framework initialization
- **THEN** the v3 manifest records legacy framework state and no configured agents
- **AND** it does not claim that Copilot or Claude Code was installed or integrated

## MODIFIED Requirements

### Requirement: Manifests record the generating CLI version and per-artifact content hashes
The system SHALL write `liftoff.manifest.json` with `artifactVersion` 3, a `liftoffVersion` field containing the exact semver of the CLI that wrote the manifest, deterministic framework and selected-agent identity, and a `contentHash` for every durable Liftoff artifact entry computed over the exact bytes written to disk, formatted as `sha256:<hex>`.

#### Scenario: Generate a v3 manifest
- **WHEN** a developer initializes a project with `liftoff init`
- **THEN** the generated `liftoff.manifest.json` declares `artifactVersion` 3, records the CLI package version as `liftoffVersion`, records deterministic framework and agent identity, and includes a `contentHash` beginning with `sha256:` for every durable Liftoff artifact entry

#### Scenario: Hashes match the written files
- **WHEN** a project is generated and a durable Liftoff artifact file on disk is hashed with SHA-256
- **THEN** the result equals the hex portion of that artifact's `contentHash` in the manifest

#### Scenario: Hash format carries the algorithm prefix
- **WHEN** any content hash is written to a manifest
- **THEN** the value is prefixed with the algorithm identifier so the algorithm can change in a future schema version without ambiguity

#### Scenario: External framework output has no durable hash entry
- **WHEN** the official framework initializer creates a framework-owned file
- **THEN** the manifest does not present that file as a hash-managed Liftoff durable artifact

### Requirement: Manifest readers accept supported schema versions and reject others with guidance
The system SHALL read manifest schema versions 2 and 3, SHALL write only schema version 3, and SHALL reject manifests with any other `artifactVersion` with an error message that names the found version, supported versions, and remedy.

#### Scenario: Read a current manifest
- **WHEN** a CLI command reads a manifest whose `artifactVersion` is 3
- **THEN** the command validates framework and agent identity and proceeds normally

#### Scenario: Read a legacy supported manifest
- **WHEN** a CLI command reads a valid manifest whose `artifactVersion` is 2
- **THEN** the command proceeds with normalized legacy framework state and no fabricated integrations

#### Scenario: Reject an unsupported manifest version
- **WHEN** a CLI command reads a manifest whose `artifactVersion` is neither 2 nor 3
- **THEN** the command fails with a message stating the found and supported versions and advising the developer to regenerate the project or use a matching CLI version

### Requirement: Artifact rendering is deterministic
The system SHALL render identical Liftoff-owned artifact bytes for identical project plans within a single CLI version; rendered content SHALL NOT depend on time, randomness, host environment, filesystem state, or observed workstation tool versions, and a CI test SHALL verify double-render byte equality. The exact tested framework contract version recorded in v3 SHALL come from the Liftoff release registry rather than a variable host probe.

#### Scenario: Double render is byte-identical
- **WHEN** the test suite renders the same project plan twice with different compatible mocked workstation versions
- **THEN** every Liftoff-owned artifact's content is byte-identical across the two renders, including the manifest

#### Scenario: Framework contract remains deterministic
- **WHEN** a project plan selects a spec workflow
- **THEN** the manifest records the exact framework contract pinned by that Liftoff version
- **AND** it does not substitute an arbitrary installed tool version into rendered content

