## MODIFIED Requirements

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

## ADDED Requirements

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

## REMOVED Requirements

### Requirement: V4 workload source identity is immutable during reconciliation
**Reason**: No current Liftoff workload uses an external Power Apps starter snapshot as executable project identity after full retirement.

**Migration**: Existing Power Apps files remain unchanged, but the new CLI does not interpret or support their starter source identity. Negative fixtures establish rejection at the workload boundary; supported manifests retain only standard and GenAI workload handling.
