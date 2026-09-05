## MODIFIED Requirements

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
