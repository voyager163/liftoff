## MODIFIED Requirements

### Requirement: V7 manifests separate managed-core authority and project provenance
The system SHALL write `liftoff.manifest.json` with `artifactVersion` 7 and a `liftoffVersion` containing the exact semver of the CLI that wrote the manifest. The manifest SHALL record deterministic workload, framework, selected-agent, and repository-governance activation identity; managed-core entries SHALL carry `contentHash` values over the exact current bytes Liftoff is authorized to reconcile, while project entries SHALL carry distinct generation provenance that cannot authorize update writes. Current manifests SHALL include only current managed-core logical names and paths; retired generated setup aliases SHALL NOT be emitted. Desired-state, framework-owned, and seed files SHALL remain outside managed-core hashes.

#### Scenario: Generate a v7 manifest
- **WHEN** a developer initializes a project with `liftoff init`
- **THEN** the generated manifest declares `artifactVersion` 7
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

### Requirement: Manifest readers accept schemas 2 through 7
The system SHALL read manifest schema versions 2, 3, 4, 5, 6, and 7, SHALL write only schema version 7, and SHALL reject any other `artifactVersion` with an error that names the found version, supported versions, and remedy. Readers SHALL normalize v2 through v6 artifact entries through the current explicit lifecycle declarations without treating unknown entries as managed core. Exact retired generated setup-alias logical names at their retired category and path MAY load only as a forced-upgrade bridge so update can remove them; wrong retired alias identity, project-provenance placement, or unknown retired alias names SHALL fail.

#### Scenario: Read a current manifest
- **WHEN** a CLI command reads a valid manifest whose `artifactVersion` is 7
- **THEN** it validates workload, framework, agent, governance, managed-core, and project-provenance identity and proceeds normally
- **AND** current managed-core entries exclude retired setup-alias logical names and paths

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
- **WHEN** a CLI command reads a manifest whose `artifactVersion` is not 2, 3, 4, 5, 6, or 7
- **THEN** it exits 1 before artifact access
- **AND** states the found and supported versions and corrective action

#### Scenario: Read exact retired setup aliases for migration
- **WHEN** a supported manifest records an exact retired setup-alias logical name with its retired governance category and path
- **THEN** the reader accepts it only as managed-core migration debt
- **AND** the next successful update removes the retired entry instead of preserving it as current state

#### Scenario: Reject non-exact retired alias identity
- **WHEN** a supported manifest records a retired setup-alias logical name under the wrong path, wrong category, project-artifact placement, or an unknown old launcher name
- **THEN** manifest loading fails before update can mutate files

### Requirement: Manifest migration releases broad legacy ownership atomically
When plain update rewrites a supported v2 through v6 manifest, the system SHALL atomically convert explicit current core entries to managed-core state, retire exact generated setup-alias entries according to the update migration rules, and convert all other durable entries to project provenance. It SHALL preserve each legacy generation hash and path as provenance even when the file is modified or absent, and SHALL perform no project-file mutation as a consequence of reclassification except deleting exact clean retired setup-alias files.

#### Scenario: Rewrite a v5 production project
- **WHEN** a v5 manifest records backend, frontend, database, container, environment, documentation, and infrastructure artifacts
- **THEN** the v7 rewrite records those entries as project provenance
- **AND** only exact current core entries retain content-hash update authority

#### Scenario: Manifest transaction fails
- **WHEN** ownership migration cannot atomically replace the manifest
- **THEN** update exits 1 without claiming migration success
- **AND** no project file is changed

#### Scenario: Older CLI reads v7
- **WHEN** a Liftoff version that supports only schemas through v6 reads the v7 manifest
- **THEN** it rejects the unsupported schema before artifact access
- **AND** cannot fall back to broad legacy write authority

### Requirement: V5 through V7 manifests distinguish governance handoff from enforcement
A v5, v6, or v7 manifest SHALL record an append-only governance profile identifier and
state. An enabled profile SHALL include the exact packaged policy version and
use `handoff-generated` when every applicable handoff artifact is owned, or
update-only `handoff-partial` when one or more unrecorded conflicting
destinations or protected retired setup aliases remain unresolved. A current
complete manifest SHALL include hashes only for the six common governance files
and selected-agent `/liftoff-setup` integrations. A partial manifest SHALL
include hashes only for handoff artifacts Liftoff wrote or adopted with
identical bytes, plus protected retired aliases only until forced migration
removes them, and SHALL omit every preserved unrecorded conflict. A disabled
profile SHALL record `none` and disabled state without a policy version. No
manifest field SHALL claim that branches, checks, rulesets, security features,
deployments, monitoring, or release controls are live.

#### Scenario: Record enabled governance
- **WHEN** the plan selects `single-maintainer-gitflow`
- **THEN** a complete initialization or adoption records that profile, the current policy version, and `handoff-generated`
- **AND** includes hashes for each applicable exact handoff artifact

#### Scenario: Record partial governance adoption
- **WHEN** update preserves different bytes at an unrecorded applicable handoff destination
- **THEN** the manifest records the selected profile, current policy version, and `handoff-partial`
- **AND** omits the preserved destination from managed ownership while retaining exact hashes for every handoff artifact written or adopted
- **AND** a later update continues to classify that destination as an unrecorded conflict until the developer resolves it

#### Scenario: Record protected retired alias
- **WHEN** plain update protects a modified exact retired generated setup alias
- **THEN** the manifest records `handoff-partial` and retains the retired alias entry only as migration debt
- **AND** `liftoff update --force` removes that exact file and entry

#### Scenario: Record disabled governance
- **WHEN** the plan selects `none`
- **THEN** the manifest records disabled governance
- **AND** omits policy version and governance artifact entries

#### Scenario: Host GitHub state differs
- **WHEN** identical plans are rendered while live GitHub settings differ or cannot be observed
- **THEN** their manifest bytes remain identical

### Requirement: Governance identifiers and logical names are explicit
The governance profile identifiers, governance state identifiers, and current logical names for the canonical policy, context, guide, phase graph, compatibility metadata, credential-policy schema, and `/liftoff-setup` integrations SHALL follow the reviewed contract. Retired generated setup-alias logical names are excluded from current manifests and compatibility metadata, and are accepted only when they exactly match the retired migration identities. Generated artifact paths SHALL be represented as non-empty OS-neutral path-part arrays and validated inside the project root.

#### Scenario: Add a future governance profile
- **WHEN** a later release adds another repository-governance profile
- **THEN** existing `single-maintainer-gitflow` and `none` identifiers retain their meanings

#### Scenario: Validate governance paths on Windows
- **WHEN** a v5, v6, or v7 manifest is loaded on Windows
- **THEN** governance path parts resolve under the project root using platform-native path handling
- **AND** embedded separators, traversal, drive-qualified parts, UNC paths, and symlink escapes are rejected before access

### Requirement: Artifact logical names and catalog identifiers are stable
The system SHALL treat non-environment artifact `logicalName` values and catalog identifiers for project types, patterns, API stacks, providers, spec workflows, and coding agents as a reviewed public contract. Environment identifiers and their derived artifact logical names SHALL match the explicitly supported set `dev`, `staging`, and `prod`; retired identifiers such as `test` and retired generated setup-alias logical names SHALL NOT remain accepted as current or generated. A CI contract test SHALL fail when representative generated logical names differ from the reviewed current contract.

#### Scenario: Contract test guards logical names by workload
- **WHEN** the test suite runs against representative GenAI, standard API, and Power Apps plans
- **THEN** each sorted list of generated `logicalName` values matches its checked-in snapshot
- **AND** a mismatch fails with a message stating the stable logical-name policy and environment-retirement exception
- **AND** current snapshots contain no retired generated setup-alias logical names

#### Scenario: New artifact added to templates
- **WHEN** a contributor adds a new generated artifact with a new `logicalName` and updates the applicable snapshot
- **THEN** the contract test passes without any existing `logicalName` changing

#### Scenario: New workload identifier is appended
- **WHEN** `power-apps-code-app` is added to the project-type catalog
- **THEN** existing `genai` and `standard` identifiers and their accepted aliases remain valid

#### Scenario: Current manifests accept only supported environment identifiers
- **WHEN** a current manifest or desired-state configuration declares deployment environments
- **THEN** the accepted environment identifiers are exactly `dev`, `staging`, and `prod`
- **AND** a manifest or configuration containing `test` is rejected with an unsupported environment error

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
- **AND** it deletes only exact retired setup aliases recorded in the manifest bridge
- **AND** it does not select other files for replacement or deletion by path or category matching

#### Scenario: Unknown legacy artifact fails safe
- **WHEN** a legacy manifest contains a logical name absent from the current lifecycle declarations
- **THEN** the reader treats ordinary durable entries as project provenance rather than managed core
- **AND** rejects unknown old setup-launcher names instead of guessing at migration authority

### Requirement: Legacy v2 manifests normalize framework state without false claims
The system SHALL continue to accept valid v2 manifests and SHALL normalize their missing framework and agent metadata as explicit legacy state. A v2 reader SHALL NOT infer that any agent integration was officially initialized. A later v7 rewrite SHALL preserve that uncertainty unless the project has gone through a supported framework-initialization flow.

#### Scenario: Read v2 project identity
- **WHEN** a valid v2 manifest contains a spec workflow but no framework contract or agent list
- **THEN** downstream validation, doctor, and update behavior treats the framework state as legacy with no declared agent integrations

#### Scenario: Rewrite v2 without fabricating agents
- **WHEN** plain `liftoff update` rewrites a valid v2 project without running framework initialization
- **THEN** the v7 manifest records legacy framework state and no configured agents
- **AND** it does not claim that Copilot or Claude Code was installed or integrated

### Requirement: Generic is an explicit stable GenAI pattern identity
The system SHALL define `generic` as an append-only GenAI pattern identifier and SHALL record it consistently in `liftoff.config.json`, schema-v7 manifest workload identity, generated project guidance, bootstrap specifications, and governance context. Uncertainty SHALL NOT be represented by a missing pattern or by substituting another pattern identifier.

#### Scenario: Generate a generic project manifest
- **WHEN** a developer initializes a project with the generic GenAI pattern
- **THEN** configuration and manifest workload identity both record `pattern: generic`
- **AND** generated project artifacts retain normal project-owned lifecycle and provenance semantics

#### Scenario: Read a generic project manifest
- **WHEN** validation, doctor, or update reads a schema-v7 manifest containing the `generic` pattern
- **THEN** the pattern resolves through the same strict catalog validation as every specialized pattern

#### Scenario: Reject missing GenAI pattern identity
- **WHEN** a GenAI configuration or manifest omits its pattern instead of selecting `generic`
- **THEN** the system reports the existing required-field validation error

#### Scenario: Preserve append-only pattern identifiers
- **WHEN** `generic` is added to the pattern catalog
- **THEN** all eight existing pattern identifiers and meanings remain unchanged
