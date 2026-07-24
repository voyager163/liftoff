## Purpose

Define the persistent contract between the Liftoff CLI and generated projects: the manifest schema, compatibility policy, contract stability rules, deterministic rendering, and reserved namespaces.

## Requirements

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
The system SHALL render identical Liftoff-owned artifact bytes for identical project plans within a single CLI version; rendered content SHALL NOT depend on time, randomness, host environment, filesystem state, or observed workstation tool versions, and a CI test SHALL verify double-render byte equality. The exact tested framework contract version recorded in v3 SHALL come from the Liftoff release registry rather than a variable host probe.

#### Scenario: Double render is byte-identical
- **WHEN** the test suite renders the same project plan twice with different compatible mocked workstation versions
- **THEN** every Liftoff-owned artifact's content is byte-identical across the two renders, including the manifest

#### Scenario: Framework contract remains deterministic
- **WHEN** a project plan selects a spec workflow
- **THEN** the manifest records the exact framework contract pinned by that Liftoff version
- **AND** it does not substitute an arbitrary installed tool version into rendered content

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

### Requirement: Manifests record project type and API stack
The system SHALL record the resolved project type and API stack in `liftoff.manifest.json`, SHALL record a GenAI pattern only for GenAI projects, and SHALL validate that each project-type/API-stack/pattern combination is supported.

#### Scenario: Record a standard project
- **WHEN** Liftoff generates a standard Node.js project
- **THEN** the manifest records project type `standard` and API stack `node-fastify`
- **AND** the manifest project object does not require a GenAI pattern

#### Scenario: Record a GenAI project
- **WHEN** Liftoff generates a RAG project
- **THEN** the manifest records project type `genai`, API stack `python-fastapi`, and pattern `rag`

#### Scenario: Reject an invalid project identity
- **WHEN** a manifest or desired-state configuration combines standard project type with a GenAI pattern or combines GenAI project type with a non-Python API stack
- **THEN** the CLI fails with a message identifying the unsupported combination and a corrective action

### Requirement: Manifest readers normalize legacy GenAI identity
The system SHALL interpret supported legacy manifests and configuration files that contain a GenAI pattern but lack project type and API stack as GenAI projects using the Python/FastAPI stack.

#### Scenario: Read an existing v2 GenAI manifest
- **WHEN** a current CLI reads a supported v2 manifest containing pattern `chatbot` without project type or API stack
- **THEN** downstream validation, update, and doctor behavior uses normalized project type `genai` and API stack `python-fastapi`
- **AND** the existing project remains usable without a manual manifest edit

#### Scenario: Rewrite normalized identity
- **WHEN** `liftoff update --apply` successfully rewrites a legacy manifest
- **THEN** the new manifest explicitly records the normalized project type and API stack at the latest supported schema

### Requirement: Manifest artifact paths are structurally valid and project-confined
The system SHALL validate the complete shape of a supported manifest and SHALL prove that every artifact path resolves inside the discovered project root before reading, writing, moving, or deleting any artifact. Path validation MUST behave equivalently on Windows, macOS, and Linux and MUST reject traversal segments, absolute paths, drive-qualified paths, UNC paths, embedded platform separators, empty segments, and symlink resolutions outside the project.

#### Scenario: Read a valid portable manifest path
- **WHEN** a supported manifest records an artifact as non-empty platform-neutral path parts such as `["backend", "apis", "main.py"]`
- **THEN** the CLI resolves the path under the project root using the host platform and permits normal processing

#### Scenario: Reject parent traversal before filesystem access
- **WHEN** a manifest artifact includes `..` or another path representation that would resolve outside the project root
- **THEN** the command exits 1 before accessing the target and identifies the unsafe artifact path

#### Scenario: Reject Windows absolute and UNC paths cross-platform
- **WHEN** a manifest contains a drive-qualified or UNC artifact path, even when the CLI is running on macOS or Linux
- **THEN** the manifest is rejected as unsafe before any artifact access

#### Scenario: Reject embedded separators
- **WHEN** one manifest path part contains `/` or `\` instead of representing exactly one path segment
- **THEN** the CLI rejects the manifest with guidance to regenerate it or use a matching valid manifest

#### Scenario: Reject a symlink escape
- **WHEN** a validated-looking artifact path traverses an existing symlink whose resolved target is outside the project root
- **THEN** the CLI refuses the operation and leaves both the project and external target unchanged

#### Scenario: Reject malformed manifest fields with guidance
- **WHEN** a supported-version manifest has missing or incorrectly typed project metadata, artifact arrays, logical names, categories, path parts, hashes, or Liftoff version
- **THEN** the CLI exits 1 with a concise manifest-validation error rather than a JavaScript type error

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
