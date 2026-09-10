## Purpose

Define the persistent contract between the Liftoff CLI and generated projects: the manifest schema, compatibility policy, contract stability rules, deterministic rendering, and reserved namespaces.

## Requirements

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
The system SHALL read manifest schema versions 2, 3, 4, 5, 6, and 7 for supported `standard` and `genai` projects, SHALL write only schema version 7, and SHALL reject any other `artifactVersion` with an error that names the found version, supported versions, and remedy. Readers SHALL normalize v2 through v6 artifact entries through the current explicit lifecycle declarations without treating unknown entries as managed core. Exact retired generated setup-alias logical names at their retired category and path MAY load only as a forced-upgrade bridge so update can remove them; wrong retired alias identity, project-provenance placement, or unknown retired alias names SHALL fail. A recognized retired workload discriminator SHALL be rejected before deeper interpretation of artifact paths, starter metadata, activation state, or live settings.

#### Scenario: Read a current manifest
- **WHEN** a CLI command reads a valid manifest whose `artifactVersion` is 7
- **THEN** it validates workload, framework, agent, governance, managed-core, and project-provenance identity and proceeds normally
- **AND** current managed-core entries exclude retired setup-alias logical names and paths

#### Scenario: Read a supported v5 manifest
- **WHEN** a CLI command reads a valid v5 manifest
- **THEN** it preserves workload, framework, agent, governance, and recorded generation hashes
- **AND** normalizes only explicitly declared core logical names as managed core

#### Scenario: Read a supported v4 manifest
- **WHEN** a CLI command reads a valid v4 standard or GenAI manifest
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

#### Scenario: Retired workload manifest is rejected at the boundary
- **WHEN** a CLI command reads a manifest whose workload discriminator is `power-apps-code-app`
- **THEN** it exits 1 with an unsupported retired-workload error before deeper metadata, artifact-path, activation-state, or live-setting interpretation
- **AND** it does not reinterpret the project as generic Git or another supported workload

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
and selected-agent `/liftoff-setup` and `/liftoff-governance-assess`
integrations. Supported older manifests without the new assessment entries
SHALL remain readable and SHALL expose those additions as guarded managed-core
update drift, not inferred ownership. A partial manifest SHALL include hashes
only for handoff artifacts Liftoff wrote or adopted with identical bytes, plus
protected retired aliases only until forced migration removes them, and SHALL
omit every preserved unrecorded conflict. A disabled profile SHALL record `none`
and disabled state without a policy version. No manifest field SHALL claim that
branches, checks, rulesets, security features, deployments, monitoring, or
release controls are live. Assessment observations and reports SHALL NOT become
managed-core entries or activation evidence.

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

#### Scenario: Upgrade an older managed inventory
- **WHEN** a supported manifest predates the assessment integrations
- **THEN** update check identifies the applicable new integration paths without writes
- **AND** normal update may create or adopt safe destinations without running assessment or changing activation evidence

#### Scenario: Assessment destination is unowned and modified
- **WHEN** an applicable assessment path already contains differing unrecorded bytes
- **THEN** it remains an unowned conflict
- **AND** force does not acquire ownership or overwrite it

### Requirement: Governance identifiers and logical names are explicit
The governance profile identifiers, governance state identifiers, and current
logical names for the canonical policy, context, guide, phase graph,
compatibility metadata, credential-policy schema, `/liftoff-setup`, and
`/liftoff-governance-assess` integrations SHALL follow the reviewed contract.
The assessment integrations SHALL use logical names
`liftoff-governance-assess-copilot` and `liftoff-governance-assess-claude` at their
exact selected-agent prompt/command paths. Their lifecycle and compatibility
inventory entries SHALL use explicit lookups, not directory patterns. Retired
generated setup-alias logical names are excluded from current manifests and
compatibility metadata, and are accepted only when they exactly match the
retired migration identities. Generated artifact paths SHALL be represented as
non-empty OS-neutral path-part arrays and validated inside the project root.
No independent assessment-skill version SHALL be added.

#### Scenario: Add a future governance profile
- **WHEN** a later release adds another repository-governance profile
- **THEN** existing `single-maintainer-gitflow` and `none` identifiers retain their meanings

#### Scenario: Validate governance paths on Windows
- **WHEN** a v5, v6, or v7 manifest is loaded on Windows
- **THEN** governance path parts resolve under the project root using platform-native path handling
- **AND** embedded separators, traversal, drive-qualified parts, UNC paths, and symlink escapes are rejected before access

#### Scenario: Validate assessment identities
- **WHEN** a manifest records an assessment integration
- **THEN** its exact logical name, lifecycle, selected agent, and path are validated
- **AND** a wrong path or unselected-agent identity is not granted managed-core authority

#### Scenario: Assess project-owned governance configuration
- **WHEN** assessment reads workflows, ruleset source, or infrastructure declarations
- **THEN** those files retain their prior ownership
- **AND** the report cannot add, alter, or expand manifest write authority

### Requirement: Artifact logical names and catalog identifiers are stable
The system SHALL treat non-environment artifact `logicalName` values and catalog identifiers for project types, patterns, API stacks, providers, spec workflows, and coding agents as a reviewed, append-only public contract except for explicit retirements. Current workload identifiers SHALL remain exactly `genai` and `standard`; environment identifiers and their derived artifact logical names SHALL match the explicitly supported set `dev`, `staging`, and `prod`; and retired workload, environment, and generated setup-alias identifiers SHALL NOT remain accepted as current or generated. The independent-root layout introduced in 0.11.0 SHALL explicitly retire only `opentofu-versions`, `opentofu-provider-lock`, `opentofu-providers`, `opentofu-variables`, `opentofu-main`, `opentofu-outputs`, `opentofu-local-state`, and `opentofu-remote-state-example` from new generated output. These eight infrastructure identities SHALL remain readable as historical project provenance, SHALL NOT become aliases for new paths or managed-core deletion targets, and SHALL NOT grant permission to retire other logical names. A CI contract test SHALL fail when representative generated logical names differ from the reviewed current contract.

#### Scenario: Contract test guards logical names by workload
- **WHEN** the test suite runs against representative GenAI and standard plans
- **THEN** each sorted list of generated `logicalName` values matches its checked-in snapshot
- **AND** a mismatch fails with a message stating the stable logical-name policy and the explicit environment and flat-root infrastructure retirement exceptions
- **AND** current snapshots contain no retired generated setup-alias or flat-root infrastructure logical names

#### Scenario: New artifact added to templates
- **WHEN** a contributor adds a new generated artifact with a new `logicalName` and updates the applicable snapshot
- **THEN** the contract test passes without any existing `logicalName` changing outside an explicitly enumerated retirement

#### Scenario: Independent roots replace only the reviewed flat-root inventory
- **WHEN** a new 0.11.0 or later scaffold uses the independent-environment infrastructure layout
- **THEN** its current inventory omits exactly the eight retired flat-root infrastructure identities
- **AND** it declares the shared application module and selected environment-root identities explicitly
- **AND** `opentofu-readme` and the existing `opentofu-dev-tfvars`, `opentofu-staging-tfvars`, and `opentofu-prod-tfvars` identities remain stable when their environments are selected

#### Scenario: Historical flat-root provenance remains readable
- **WHEN** a supported API or GenAI manifest records retired flat-root infrastructure identities at their historical paths
- **THEN** the reader preserves their logical names, paths, and generation hashes as project provenance
- **AND** it does not reject that otherwise supported project, relabel those entries onto new roots, or claim that infrastructure was migrated

#### Scenario: Unreviewed logical-name retirement remains a contract failure
- **WHEN** generation removes or renames a previously declared non-environment logical name outside an explicitly enumerated retirement
- **THEN** the stable-contract regression fails rather than treating the infrastructure exception as a general rename permission

#### Scenario: New workload identifier is appended
- **WHEN** a future reviewed release adds another workload identifier
- **THEN** existing `genai` and `standard` identifiers and their accepted aliases retain their meanings
- **AND** retired identifiers are not silently reused or re-enabled

#### Scenario: Retired workload identifier is rejected
- **WHEN** a manifest, configuration file, or generated snapshot attempts to use `power-apps-code-app` as a current workload identifier
- **THEN** validation fails with an unsupported retired-workload error

#### Scenario: Current manifests accept only supported environment identifiers
- **WHEN** a current manifest or desired-state configuration declares deployment environments
- **THEN** the accepted environment identifiers are exactly `dev`, `staging`, and `prod`
- **AND** a manifest or configuration containing `test` is rejected with an unsupported environment error

### Requirement: Artifact rendering is deterministic
The system SHALL render identical Liftoff-owned artifact bytes for identical project plans within a single CLI version; rendered content SHALL NOT depend on time, randomness, host environment, filesystem state, observed workstation tool versions, or mutable upstream template state, and a CI test SHALL verify double-render byte equality. Exact tested framework identities, packaged policy data, and workload catalogs recorded in schema v7 SHALL come from Liftoff's release catalogs.

#### Scenario: Double render is byte-identical
- **WHEN** the test suite renders the same project plan twice with different compatible mocked workstation versions
- **THEN** every Liftoff-owned artifact's content is byte-identical across the two renders, including the manifest

#### Scenario: Framework contract remains deterministic
- **WHEN** a project plan selects a spec workflow
- **THEN** the manifest records the exact framework contract pinned by that Liftoff version
- **AND** it does not substitute an arbitrary installed tool version into rendered content

#### Scenario: Packaged catalogs remain deterministic
- **WHEN** a standard or GenAI plan is rendered with or without network access
- **THEN** the manifest records the same packaged workload and governance catalog identities
- **AND** the rendered bytes do not depend on mutable upstream content

#### Scenario: Starter contract remains deterministic
- **WHEN** a retired Power Apps plan is requested with or without network access
- **THEN** it receives the same unsupported-workload result before loading an upstream starter
- **AND** network availability or upstream changes do not restore support

### Requirement: Machine-state namespaces in generated projects are reserved
Machine-readable project paths SHALL remain OS-neutral path-part arrays. `.liftoff/` SHALL remain reserved for ordinary CLI-managed state, and no new CLI-managed root-level file SHALL be introduced beyond `liftoff.config.json` and `liftoff.manifest.json`. Explicitly approved activation history and its migration journal SHALL use registered paths under the existing user-owned `governance` namespace rather than become general managed-core state. Preview receipts SHALL remain outside the project and repository.

#### Scenario: Manifest paths are portable
- **WHEN** a manifest or migration index is produced on any supported platform
- **THEN** project-relative locations are stored as validated path segments without embedded native separators

#### Scenario: Root namespace stays fixed
- **WHEN** new update metadata is persisted
- **THEN** no new file is added at the project root and each destination follows its explicit CLI-state, historical-record, or external-receipt contract

#### Scenario: Migration paths resolve on Windows
- **WHEN** a preserved index or journal is read on Windows, macOS, or Linux
- **THEN** native resolution keeps each location within its declared boundary
- **AND** traversal, drive/UNC escapes, unsafe links, and case-colliding locations are rejected

### Requirement: CLI outputs follow shared exit-code and JSON conventions
The system SHALL use exit 0 for successful completed scope or clean checks, 1 for errors and rejected authorization, and 2 for detected differences or an explicitly documented partial outcome. Update SHALL use exit 2 when local activation migration committed but its revalidation remains blocked. Every machine-readable output SHALL include a numeric top-level schema version; changed update semantics SHALL use schema 3 rather than silently changing schema 2.

#### Scenario: JSON output is versioned
- **WHEN** a command emits JSON
- **THEN** it includes the appropriate numeric top-level `schemaVersion`

#### Scenario: Exit codes are consistent across commands
- **WHEN** a command completes
- **THEN** its exit code follows the documented success, error, or difference/partial classification without labeling partial readiness as full success

#### Scenario: A committed update still needs revalidation
- **WHEN** migration commits but local revalidation remains incomplete
- **THEN** update exits 2 and separately reports committed metadata and incomplete readiness

### Requirement: Activation identity changes are committed with their migration history
A supported activation migration SHALL retain manifest artifact version 7 and original project generation provenance. It SHALL preserve the source manifest bytes in the historical snapshot and change active governance identity only in the same guarded transaction as the linked strict successor and migration journal. Migration/history records SHALL not become managed-core content hashes, replacement authority, or evidence of live enforcement. The journal SHALL link source identity, target identity, approved plan, snapshot digest, and successor identity without adding a new required v7 field or retagging source records.

#### Scenario: A historical project is migrated
- **WHEN** an approved supported local migration commits
- **THEN** the active manifest records the installed CLI and target activation identity while the historical snapshot retains the original manifest bytes
- **AND** all project artifact generation hashes and original generating versions remain unchanged

#### Scenario: Revalidation fails after commit
- **WHEN** successor state and manifest are committed but revalidation fails
- **THEN** the target manifest remains active and the migration journal reports blocked readiness
- **AND** it does not claim completed governance

#### Scenario: Existing current v2 metadata is maintained
- **WHEN** a current v2 project receives a reviewed managed-core-only update
- **THEN** no historical successor or new activation identity is fabricated solely from the CLI version change

#### Scenario: Historical source metadata is not an execution target
- **WHEN** an inspector reads a source manifest from the exact validated history index
- **THEN** it treats that manifest as historical data rather than selecting it as the active project boundary

### Requirement: Manifests record project type and API stack
The system SHALL preserve the discriminated workload identity introduced in schema v4 when reading supported v4-v7 manifests and SHALL write current manifests as v7. GenAI workloads SHALL record their Python/FastAPI API stack, pattern, cloud, region, frontend selection, and environments. Standard workloads SHALL record their selected API stack, cloud, region, frontend selection, and environments without a GenAI pattern. The only current workload kinds SHALL be `genai` and `standard`, and every reader SHALL reject fields that are missing or inapplicable for the selected workload or that attempt to use the retired `power-apps-code-app` discriminator.

#### Scenario: Record a standard project
- **WHEN** Liftoff generates a standard Node.js project
- **THEN** the manifest records workload kind `standard` and API stack `node-fastify`
- **AND** the workload object does not require a GenAI pattern

#### Scenario: Record a GenAI project
- **WHEN** Liftoff generates a RAG project
- **THEN** the manifest records workload kind `genai`, API stack `python-fastapi`, and pattern `rag`

#### Scenario: Record a Power Apps project
- **WHEN** a generation or manifest operation requests the retired Power Apps workload
- **THEN** it reports unsupported workload rather than writing or accepting a current Power Apps manifest

#### Scenario: Reject a retired project identity
- **WHEN** a manifest or desired-state configuration names workload kind `power-apps-code-app`
- **THEN** the CLI rejects the workload before interpreting starter metadata, activation metadata, or artifact ownership

#### Scenario: Reject an invalid project identity
- **WHEN** a manifest or desired-state configuration combines a workload kind with missing or inapplicable workload fields
- **THEN** the CLI fails with a message identifying the unsupported combination and a corrective action

### Requirement: Manifest readers normalize legacy GenAI identity
The system SHALL interpret supported v2/v3 manifests and configuration containing a GenAI pattern without project type or API stack as GenAI using Python/FastAPI. It SHALL normalize valid flat v3 standard identity into the discriminated workload model introduced in v4 and preserved in v7, without fabricating any retired workload. Successful current manifest writes SHALL use v7.

#### Scenario: Read an existing v2 GenAI manifest
- **WHEN** a current CLI reads a supported v2 manifest with chatbot pattern and no project type or API stack
- **THEN** validation, update, and doctor use GenAI with Python/FastAPI
- **AND** no manual manifest edit is required

#### Scenario: Read an existing v3 standard manifest
- **WHEN** a supported v3 manifest records standard with go-huma
- **THEN** downstream behavior preserves that normalized workload and its framework integrations

#### Scenario: Rewrite normalized identity
- **WHEN** current update successfully rewrites a supported v2/v3 manifest
- **THEN** it writes a v7 manifest with the normalized discriminated workload without modifying project-owned application files

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

### Requirement: Manifest v4 separates common integration identity from workload identity
The system SHALL record project name and discriminated workload under `project`, and SHALL record spec workflow, canonical selected-agent order, applicable Spec Kit default agent, framework adapter, and exact tested framework contract independently from workload-specific fields. It SHALL NOT record observed host runtime, package-manager, Docker daemon, infrastructure-tool, or agent versions.

#### Scenario: Record a standard project with OpenSpec and both agents
- **WHEN** a standard project is initialized with OpenSpec, GitHub Copilot, and Claude Code
- **THEN** the current v7 manifest retains the v4-introduced separation of standard workload and normalized agent identities
- **AND** it does not require a default-agent field

#### Scenario: Record a GenAI project with Spec Kit default agent
- **WHEN** a GenAI project is initialized with Spec Kit, both agents, and Claude Code as the default
- **THEN** the current v7 manifest records both agents, Claude Code as default, and the Spec Kit tested contract independently from workload identity

#### Scenario: Record Power Apps with OpenSpec and both agents
- **WHEN** a retired Power Apps request selects OpenSpec and both agents
- **THEN** workload rejection occurs before recording a new manifest or initializing integrations

#### Scenario: Record Power Apps with Spec Kit default agent
- **WHEN** a retired Power Apps request selects Spec Kit and a default agent
- **THEN** workload rejection occurs before recording a new manifest or initializing integrations

#### Scenario: Host versions do not affect v4 bytes
- **WHEN** identical project plans are initialized with different compatible patch versions of Node.js or a coding agent
- **THEN** those observed workstation versions do not change the rendered manifest bytes

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

### Requirement: Retired workload discriminators are rejected before deeper interpretation
The system SHALL reject recognized retired `power-apps-code-app` desired-state and manifest inputs before interpreting starter metadata, artifact paths, activation or governance state, deeper manifest metadata, or live-consent settings. This boundary SHALL apply even when governance is disabled, `--force` is later supplied to another command, or the surrounding directory is inside an ordinary Git repository. Retirement SHALL NOT convert, delete, or reinterpret the project as generic Git or another supported workload.

#### Scenario: Disabled governance does not bypass retirement
- **WHEN** a manifest records governance profile `none` and workload kind `power-apps-code-app`
- **THEN** Liftoff rejects the retired workload before reading activation-state or managed-artifact fields

#### Scenario: Generic Git fallback is not used
- **WHEN** a retired Liftoff manifest exists inside an otherwise valid Git repository
- **THEN** commands that inspect the manifest boundary report the retired workload as an error
- **AND** they do not fall back to ordinary Git handling for that same path

#### Scenario: Retired application files are preserved
- **WHEN** the retired workload discriminator is rejected
- **THEN** Liftoff leaves the project's application files, manifests, and historical state bytes unchanged
- **AND** it does not attempt conversion or cleanup as part of retirement handling

#### Scenario: Retired manifest path is handled on Windows
- **WHEN** a retired manifest is encountered under a path containing spaces on Windows, macOS, or Linux
- **THEN** the same explicit workload rejection and unchanged-file guarantees apply using native path resolution

### Requirement: Current activation identities are explicit and historical v1 state is diagnostic-only
The system SHALL treat manifest artifact version 7, policy version 6, activation contract version 2, activation state schema version 2, evidence header schema version 2, approval envelope schema version 2, and compatibility metadata schema version 2 as the current executable identity set for this release line. Phase graph, supersession, credential-policy, assessment report, and assessment catalog schemas SHALL remain version 1. Compatibility metadata SHALL distinguish historically readable identities from current executable identities, and known activation v1 state or evidence SHALL remain readable only for diagnosis, preserve its original bytes, and SHALL NOT be automatically migrated, executed, reset, or rewritten as current proof.

#### Scenario: Generate the current identity set
- **WHEN** Liftoff writes current managed governance metadata for a supported project
- **THEN** the generated manifest and compatibility metadata identify manifest version 7, policy version 6, activation contract version 2, activation state schema version 2, evidence header schema version 2, approval envelope schema version 2, and compatibility metadata schema version 2
- **AND** phase graph, supersession, credential-policy, assessment report, and assessment catalog identities remain version 1

#### Scenario: Historical v1 activation remains readable but not executable
- **WHEN** a supported API or GenAI project contains activation state or evidence using the historical v1 identity
- **THEN** Liftoff may report that history for diagnostics
- **AND** it preserves the recorded bytes while reporting a reconciliation-required or unsupported-migration blocker instead of treating the history as current executable proof

#### Scenario: Managed-core maintenance does not silently rewrite historical state
- **WHEN** update or doctor reads a supported project whose current manifest is readable but whose activation history is historical v1 data
- **THEN** managed-core maintenance may continue within its supported authority boundary
- **AND** it does not silently mutate the user-owned historical activation state
