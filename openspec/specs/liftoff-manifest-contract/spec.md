## Purpose

Define the persistent contract between the Liftoff CLI and generated projects: the manifest schema, compatibility policy, contract stability rules, deterministic rendering, and reserved namespaces.

## Requirements

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
- **WHEN** a CLI command reads a valid legacy manifest
- **THEN** it preserves the existing workload normalization and framework uncertainty contracts
- **AND** defaults unknown or non-core durable entries to project provenance

#### Scenario: Reject an unsupported manifest version
- **WHEN** a CLI command reads a manifest whose `artifactVersion` is not 2, 3, 4, 5, or 6
- **THEN** it exits 1 before artifact access
- **AND** states the found and supported versions and corrective action

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

### Requirement: V5 and V6 manifests distinguish governance handoff from enforcement
A v5 or v6 manifest SHALL record an append-only governance profile identifier and
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
- **AND** omits the preserved destination from managed ownership while retaining exact hashes for every handoff artifact written or adopted
- **AND** a later update continues to classify that destination as an unrecorded conflict until the developer resolves it

#### Scenario: Record disabled governance
- **WHEN** the plan selects `none`
- **THEN** the manifest records disabled governance
- **AND** omits policy version and governance artifact entries

#### Scenario: Host GitHub state differs
- **WHEN** identical plans are rendered while live GitHub settings differ or cannot be observed
- **THEN** their manifest bytes remain identical

### Requirement: Governance identifiers and logical names are append-only
The governance profile identifiers, governance state identifiers, and logical names for the canonical policy, context, guide, and agent launchers SHALL follow the existing append-only contract. Generated artifact paths SHALL be represented as non-empty OS-neutral path-part arrays and validated inside the project root.

#### Scenario: Add a future governance profile
- **WHEN** a later release adds another repository-governance profile
- **THEN** existing `single-maintainer-gitflow` and `none` identifiers retain their meanings

#### Scenario: Validate governance paths on Windows
- **WHEN** a v5 or v6 manifest is loaded on Windows
- **THEN** governance path parts resolve under the project root using platform-native path handling
- **AND** embedded separators, traversal, drive-qualified parts, UNC paths, and symlink escapes are rejected before access

### Requirement: Artifact logical names and catalog identifiers are append-only
The system SHALL treat artifact `logicalName` values and catalog identifiers for project types, patterns, API stacks, providers, environments, spec workflows, and coding agents as a stable public contract: new identifiers may be added, but existing identifiers SHALL NOT be renamed or removed, and a CI contract test SHALL fail when a representative generated `logicalName` set changes relative to its checked-in snapshot.

#### Scenario: Contract test guards logical names by workload
- **WHEN** the test suite runs against representative GenAI, standard API, and Power Apps plans
- **THEN** each sorted list of generated `logicalName` values matches its checked-in snapshot
- **AND** a mismatch fails with a message stating the append-only policy

#### Scenario: New artifact added to templates
- **WHEN** a contributor adds a new generated artifact with a new `logicalName` and updates the applicable snapshot
- **THEN** the contract test passes without any existing `logicalName` changing

#### Scenario: New workload identifier is appended
- **WHEN** `power-apps-code-app` is added to the project-type catalog
- **THEN** existing `genai` and `standard` identifiers and their accepted aliases remain valid

### Requirement: Artifact rendering is deterministic
The system SHALL render identical Liftoff-owned artifact bytes for identical project plans within a single CLI version; rendered content SHALL NOT depend on time, randomness, host environment, filesystem state, observed workstation tool versions, or mutable upstream template state, and a CI test SHALL verify double-render byte equality. Exact tested framework and upstream starter identities recorded in v4 SHALL come from Liftoff's release catalogs.

#### Scenario: Double render is byte-identical
- **WHEN** the test suite renders the same project plan twice with different compatible mocked workstation versions
- **THEN** every Liftoff-owned artifact's content is byte-identical across the two renders, including the manifest

#### Scenario: Framework contract remains deterministic
- **WHEN** a project plan selects a spec workflow
- **THEN** the manifest records the exact framework contract pinned by that Liftoff version
- **AND** it does not substitute an arbitrary installed tool version into rendered content

#### Scenario: Starter contract remains deterministic
- **WHEN** a Power Apps plan is rendered with or without network access
- **THEN** the manifest records the packaged upstream repository, path, and commit
- **AND** the rendered bytes do not depend on the upstream branch's current contents

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
The system SHALL record one discriminated workload identity in schema v4. GenAI workloads SHALL record their Python/FastAPI API stack, pattern, cloud, region, frontend selection, and environments. Standard workloads SHALL record their selected API stack, cloud, region, frontend selection, and environments without a GenAI pattern. Power Apps workloads SHALL record immutable starter source identity and the Code Apps plugin preference without an API stack, pattern, cloud, region, API frontend flag, or API environments. Every reader SHALL reject fields that are missing or inapplicable for the selected workload.

#### Scenario: Record a standard project
- **WHEN** Liftoff generates a standard Node.js project
- **THEN** the manifest records workload kind `standard` and API stack `node-fastify`
- **AND** the workload object does not require a GenAI pattern

#### Scenario: Record a GenAI project
- **WHEN** Liftoff generates a RAG project
- **THEN** the manifest records workload kind `genai`, API stack `python-fastapi`, and pattern `rag`

#### Scenario: Record a Power Apps project
- **WHEN** Liftoff generates a Power Apps code app
- **THEN** the manifest records workload kind `power-apps-code-app`, the pinned official starter identity, and the plugin preference
- **AND** it omits API, cloud, region, and API environment fields

#### Scenario: Reject an invalid project identity
- **WHEN** a manifest or desired-state configuration combines a workload kind with missing or inapplicable workload fields
- **THEN** the CLI fails with a message identifying the unsupported combination and a corrective action

### Requirement: Manifest readers normalize legacy GenAI identity
The system SHALL interpret supported v2 and v3 manifests and configuration files that contain a GenAI pattern but lack project type and API stack as GenAI projects using the Python/FastAPI stack. It SHALL normalize valid flat v3 standard identity into the schema-v4 internal workload model without fabricating Power Apps identity.

#### Scenario: Read an existing v2 GenAI manifest
- **WHEN** a current CLI reads a supported v2 manifest containing pattern `chatbot` without project type or API stack
- **THEN** downstream validation, update, and doctor behavior uses normalized workload kind `genai` and API stack `python-fastapi`
- **AND** the existing project remains usable without a manual manifest edit

#### Scenario: Read an existing v3 standard manifest
- **WHEN** a current CLI reads a supported v3 manifest containing project type `standard` and API stack `go-huma`
- **THEN** downstream behavior uses the equivalent standard workload union member and preserves its framework integrations

#### Scenario: Rewrite normalized identity
- **WHEN** plain `liftoff update` successfully rewrites a valid v2 or v3 manifest
- **THEN** the new schema-v4 manifest explicitly records the normalized discriminated workload identity

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

### Requirement: Manifest v4 separates common integration identity from workload identity
The system SHALL record project name and discriminated workload under `project`, and SHALL record spec workflow, canonical selected-agent order, applicable Spec Kit default agent, framework adapter, and exact tested framework contract independently from workload-specific fields. It SHALL NOT record observed host runtime, package-manager, Docker daemon, infrastructure-tool, plugin, or agent versions.

#### Scenario: Record Power Apps with OpenSpec and both agents
- **WHEN** a Power Apps project is initialized with OpenSpec, GitHub Copilot, and Claude Code
- **THEN** the v4 manifest records the Power Apps workload and both normalized agent identifiers in canonical order
- **AND** it does not require a default-agent field

#### Scenario: Record Power Apps with Spec Kit default agent
- **WHEN** a Power Apps project is initialized with Spec Kit, both agents, and Claude Code as the default
- **THEN** the v4 manifest records both agents, Claude Code as default, and the Spec Kit tested contract separately from starter identity

#### Scenario: Host versions do not affect v4 bytes
- **WHEN** identical project plans are initialized with different compatible patch versions of Node.js or a coding agent
- **THEN** those observed workstation versions do not change the rendered manifest bytes

### Requirement: V4 workload source identity is immutable during reconciliation
The system SHALL persist the repository, template path, and commit for an externally sourced workload snapshot and SHALL validate those fields as non-empty canonical strings. Update SHALL compare them through explicit fields and SHALL NOT infer source identity from generated file paths or mutable URLs.

#### Scenario: Validate a Power Apps source identity
- **WHEN** a v4 Power Apps manifest is read
- **THEN** its official starter repository, template path, and immutable commit are validated before artifact access

#### Scenario: Reject mutable source identity
- **WHEN** a Power Apps manifest identifies only `main`, `latest`, or another mutable ref instead of the recorded commit
- **THEN** the manifest is rejected with guidance to regenerate or use a matching Liftoff version

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
