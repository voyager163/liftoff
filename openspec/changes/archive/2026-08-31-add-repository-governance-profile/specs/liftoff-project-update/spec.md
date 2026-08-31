## REMOVED Requirements

### Requirement: Update normalizes old manifests before writing schema v4
**Reason**: Current updates now write schema v5 so governance profile identity and local handoff state can be represented without claiming live enforcement.

**Migration**: Check mode leaves v2-v4 manifests unchanged; a successful plain update normalizes their existing workload and framework state, safely reconciles applicable governance artifacts, and writes v5.

## ADDED Requirements

### Requirement: Update normalizes old manifests before writing schema v5
The system SHALL normalize supported v2, v3, and v4 manifests into the
internal workload and framework model before reconciliation. `liftoff update
--check` SHALL leave the source manifest byte-for-byte unchanged. A successful
plain update SHALL write schema v5 with fresh hashes for written or
byte-identical adopted artifacts, preserve hashes for previously recorded
skipped conflicts and legacy framework uncertainty, omit unrecorded conflicts
from Liftoff ownership, and record only the selected governance profile's local
handoff state.

#### Scenario: Check a v4 project without rewriting
- **WHEN** a developer runs `liftoff update --check` in a valid v4 project
- **THEN** update performs normalized reconciliation, reports applicable governance adoption as drift, and leaves the v4 manifest byte-for-byte unchanged

#### Scenario: Update upgrades a v4 project manifest
- **WHEN** a developer runs plain `liftoff update` in a valid v4 project and reconciliation completes successfully
- **THEN** update writes schema v5 with equivalent workload, framework, and agent identity plus the normalized governance profile

#### Scenario: Legacy framework state remains uncertain
- **WHEN** a v2 manifest without official framework metadata is rewritten to v5
- **THEN** the new manifest records legacy framework state without fabricating selected-agent integrations
- **AND** may record the local governance handoff without claiming that an agent or GitHub enforcement is active

### Requirement: Existing projects adopt durable governance artifacts automatically
When an existing configuration omits `governanceProfile`, the current CLI SHALL normalize it to `single-maintainer-gitflow` and render the profile's durable policy, context, guide, and selected-agent launchers during normal update reconciliation. The CLI SHALL apply only safe named artifact states and SHALL NOT rewrite the user-owned configuration merely to materialize its default.

#### Scenario: Adopt into an untouched v4 project
- **WHEN** a developer runs plain `liftoff update` in a valid existing project whose configuration has no governance field and whose new paths are absent
- **THEN** update writes the explicitly named governance handoff artifacts and schema-v5 manifest transactionally
- **AND** does not run an agent or contact GitHub

#### Scenario: Preview automatic adoption
- **WHEN** a developer runs `liftoff update --check` before adoption
- **THEN** each applicable governance artifact appears as a new named artifact
- **AND** the command exits 2 without writing any file

#### Scenario: Existing launcher has different bytes
- **WHEN** an unrecorded governance destination already contains different content
- **THEN** update classifies that exact destination as a conflict
- **AND** plain update preserves it while applying other collision-free artifacts
- **AND** the v5 manifest records `handoff-partial` without recording an artifact entry or hash for the preserved destination

#### Scenario: Resolve a partial handoff
- **WHEN** a later update finds that every previously unrecorded governance conflict is absent or byte-identical to the current artifact
- **THEN** it writes or adopts those artifacts through normal safe reconciliation
- **AND** the v5 manifest records `handoff-generated` with every applicable exact handoff artifact

#### Scenario: Existing launcher already matches
- **WHEN** an unrecorded destination contains bytes identical to the current launcher
- **THEN** update adopts it without rewriting the file

### Requirement: Governance opt-out preserves user-owned files
When configuration explicitly selects `none`, update SHALL stop rendering the profile's durable artifacts. Previously recorded governance artifacts SHALL follow the existing orphan contract and SHALL never be deleted automatically; active or archived spec changes and agent-created governance implementation files SHALL remain outside reconciliation.

#### Scenario: Disable the generated profile
- **WHEN** a developer changes `governanceProfile` from `single-maintainer-gitflow` to `none` and runs update
- **THEN** recorded handoff artifacts are reported as orphans and left on disk
- **AND** the v5 manifest records governance as disabled after successful reconciliation

#### Scenario: Archive the agent-created change
- **WHEN** a developer archives or removes the post-Phase-0 governance change
- **THEN** update reports no drift for that change
- **AND** does not recreate it from the durable policy

### Requirement: Update never activates remote governance
Repository-governance reconciliation SHALL be limited to local durable artifacts and manifest state. Update SHALL NOT invoke a selected agent, inspect a remote, write an activation baseline, apply a ruleset, create a branch, or alter any GitHub or deployment setting.

#### Scenario: Update with an authenticated GitHub CLI
- **WHEN** `gh` and a writable remote are available during governance adoption
- **THEN** update performs the same local filesystem operations as it would offline
- **AND** sends no GitHub mutation
