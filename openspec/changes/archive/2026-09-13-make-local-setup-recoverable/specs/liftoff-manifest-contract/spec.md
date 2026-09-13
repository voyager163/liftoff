## MODIFIED Requirements

### Requirement: Governance identifiers and logical names are explicit
The governance profile identifiers, governance state identifiers, and current logical names for the canonical policy, context, guide, phase graph, compatibility metadata, credential-policy schema, setup, and assessment integrations SHALL follow the reviewed contract. Existing Copilot and Claude identities SHALL remain stable. Codex SHALL use `liftoff-setup-codex` at `.agents/skills/liftoff-setup/SKILL.md` and `liftoff-governance-assess-codex` at `.agents/skills/liftoff-governance-assess/SKILL.md`. Lifecycle and compatibility entries SHALL use explicit lookups, not directory patterns. Retired setup aliases SHALL remain excluded from current output and accepted only at their exact migration identities. Generated paths SHALL be non-empty OS-neutral path-part arrays confined to the project. No independent setup or assessment skill version SHALL be added.

The existing setup identities SHALL remain `liftoff-setup-copilot` at `.github/prompts/liftoff-setup.prompt.md` and `liftoff-setup-claude` at `.claude/commands/liftoff-setup.md`. The existing assessment identities SHALL remain `liftoff-governance-assess-copilot` at `.github/prompts/liftoff-governance-assess.prompt.md` and `liftoff-governance-assess-claude` at `.claude/commands/liftoff-governance-assess.md`.

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

#### Scenario: Record selected Codex integrations
- **WHEN** a governed project selects Codex
- **THEN** its native setup and assessment skills have their own exact Codex identities and managed hashes
- **AND** neither is recorded under a Claude logical name or used to claim neighboring `.agents` files

### Requirement: CLI outputs follow shared exit-code and JSON conventions
The system SHALL use exit 0 for successful completed scope or documented inspection, 1 for rejected/error execution before progress, and 2 for differences or explicitly reported incomplete persisted work. Update SHALL retain schema 3 for its local core/successor transaction. Governance commands SHALL use schema 2 with explicit journey/local/migration/activation/lifecycle progress and proof freshness. Repair output SHALL use schema 1 with distinct local/stateful kinds and checkpoints. Every JSON output SHALL be versioned and disclose actual partial effects rather than hide them under a generic failure.

#### Scenario: JSON output is versioned
- **WHEN** a command emits JSON
- **THEN** it includes the appropriate numeric top-level `schemaVersion`

#### Scenario: Exit codes are consistent across commands
- **WHEN** a command completes
- **THEN** its exit code follows the documented success, error, or difference/partial classification without labeling partial readiness as full success

#### Scenario: A committed update still needs revalidation
- **WHEN** migration commits but local revalidation remains incomplete
- **THEN** update exits 2 and separately reports committed metadata and incomplete readiness

#### Scenario: Governance output changes next-phase semantics
- **WHEN** schema-2 apply-next reports an executed phase
- **THEN** its next readiness comes from post-operation inspection
- **AND** consumers can distinguish this contract from schema-1 selection semantics

#### Scenario: Repair has committed but local verification is blocked
- **WHEN** an approved repair commits and subsequent local checks do not complete
- **THEN** schema-1 repair output returns exit 2 with separate commit and verification outcomes
- **AND** it does not claim complete setup or roll back historical identity implicitly

### Requirement: Current activation identities are explicit and historical v1 state is diagnostic-only
The target executable identity SHALL use activation package `0.12.0`, manifest artifact 7, policy 6, activation contract 3, graph schema 2, state/evidence/approval schemas 3, and compatibility metadata 4. Unchanged supersession, credential-policy, assessment-report, and assessment-catalog formats SHALL remain independently versioned at 1. Historical v1 and v2 identities SHALL remain readable only through strict declared source contracts and SHALL not execute or become current proof without an approved successor and fresh revalidation/readback.

#### Scenario: Generate the current identity set
- **WHEN** current managed governance metadata is generated
- **THEN** the manifest, graph, and compatibility metadata identify the exact target tuple and computed graph hash
- **AND** command, repair, and proof schema versions are not conflated

#### Scenario: Historical v1 activation remains readable but not executable
- **WHEN** a supported project contains known v1 records
- **THEN** their bytes remain historical and a declared migration or unsupported-source result is reported
- **AND** the records do not authorize current execution

#### Scenario: Managed-core maintenance does not silently rewrite historical state
- **WHEN** update or doctor encounters historical activation data
- **THEN** it stays within its declared authority and does not retag or rewrite historical records as current proof

#### Scenario: Historical v2 is upgraded
- **WHEN** an exact supported v2 source is approved for the target successor
- **THEN** source records and approvals are preserved and current proof is re-established through the declared migration contract
- **AND** existing cloud resources are not recreated merely to obtain new-version evidence

### Requirement: Activation identity changes are committed with their migration history
A supported activation-contract migration SHALL retain manifest artifact 7 and original project provenance, preserve source manifest/state/evidence/plans/approvals through its exact history inventory, and change active identity only with the linked committed successor and migration record. Historical records SHALL not become managed-core replacement authority or live proof. The local contract-migration approval SHALL not authorize cloud or OpenTofu-state migration.

#### Scenario: A historical project is migrated
- **WHEN** an approved supported source-to-current successor transaction commits
- **THEN** active manifest, state, and migration records agree with the target identity while the source snapshot retains its exact bytes
- **AND** project generation provenance is preserved unless separately changed by an approved project repair

#### Scenario: Revalidation fails after commit
- **WHEN** the successor commits but current proof remains incomplete
- **THEN** it remains active and resumable with preserved source history
- **AND** neither complete governance nor automatic rollback to the historical identity is claimed

#### Scenario: Existing current v2 metadata is maintained
- **WHEN** a v2 project receives same-contract managed-core maintenance rather than an approved successor migration
- **THEN** no historical successor or new proof identity is fabricated solely from the CLI version change
- **AND** execution under the new v3 contract still requires its separately approved declared successor

#### Scenario: Historical source metadata is not an execution target
- **WHEN** an inspector follows a validated history reference
- **THEN** it treats the source as historical data rather than selecting it as the active project boundary

## ADDED Requirements

### Requirement: Reviewed repair records honest current provenance without a new manifest shape
An approved repair SHALL retain manifest artifact 7, record the exact writer, and preserve original manifest/provenance before superseding approved active entries. Local repair SHALL publish with its local commit; stateful repair SHALL publish only at the verified coordinated state/configuration cutover. Unrelated provenance SHALL remain unchanged. Neither ordinary update nor a manually changed path/hash SHALL authorize this transition.

#### Scenario: Infrastructure active inventory changes through repair
- **WHEN** a supported approved repair replaces retired flat-root files with independent module/environment artifacts
- **THEN** the active inventory describes the repaired files and their actual producer
- **AND** original logical names, paths, generating versions, and hashes remain available in the preserved source history

#### Scenario: Stable tfvars identity moves to an environment root
- **WHEN** repair moves a selected environment's tfvars to its canonical independent-root path
- **THEN** its reviewed logical name remains stable and the old path/hash are retained historically
- **AND** the active entry is not silently relabeled without the repair record

#### Scenario: Project code outside the repair changes
- **WHEN** a repair affects only infrastructure or agent integrations
- **THEN** unrelated application provenance is not retagged to the current CLI
- **AND** unrelated files remain outside the repair write set

### Requirement: Repair history has explicit portable identities
Project-visible repair index, receipt, source-manifest, and progress roles SHALL be explicitly registered under `.liftoff/repairs`. Sensitive state snapshots, keys, working plans, and stateful journals SHALL remain in approved protected storage outside repository history, referenced only by opaque safe bindings. Every generated path/backend reference SHALL be inventoried and validated rather than discovered or deleted by pattern. Public history SHALL exclude payloads and SHALL not become template ownership or automatic activation proof.

#### Scenario: Read a recorded repair history
- **WHEN** a diagnostic follows a repair index entry
- **THEN** it verifies the exact recorded path, schema, identity, and digest relationships
- **AND** it does not infer current execution proof from the historical record

#### Scenario: A referenced receipt is damaged
- **WHEN** a recorded history link is missing, unsafe, or digest-mismatched
- **THEN** the diagnostic reports that integrity error without inventing replacement history

#### Scenario: Repair history is maintained on Windows
- **WHEN** repair records are written or read on Windows, macOS, or Linux
- **THEN** their logical identities and portable path segments remain equivalent
- **AND** native confinement rejects traversal, case collisions, junction escapes, and unlisted paths

### Requirement: Codex extends agent identity without changing existing selections
The supported canonical agent inventory SHALL append `codex` without changing the meanings or canonical relative order of `github-copilot` and `claude`. Manifest and configuration readers SHALL validate nonempty unique selections and the applicable Spec Kit default against the same inventory. Native framework markers SHALL be required before recording an integration as initialized.

#### Scenario: Read an existing two-agent manifest
- **WHEN** a supported manifest selects only Copilot and Claude
- **THEN** its selection remains unchanged and Codex is not added implicitly

#### Scenario: Record all three integrations
- **WHEN** a new initialization or approved additive repair installs all three agents
- **THEN** the manifest records all three once in canonical order
- **AND** a Spec Kit default is one of those selected agents

### Requirement: Live activation and stateful receipts bind real execution
Current proof SHALL bind approved plans, source/artifact identity, actual operation/run identifiers, principals and destinations, and required independent readback. Stateful receipts SHALL additionally bind approved mappings, source/destination state versions and protected recovery references without containing payloads. A local manifest or historical receipt alone SHALL not claim a deployed, migrated, or enforced result.

#### Scenario: State migration is partially complete
- **WHEN** some backend effects occurred but final cutover is unverified
- **THEN** records preserve the exact checkpoint and pending ownership/verification work
- **AND** the current manifest is not silently presented as proof of complete migration

#### Scenario: Activation readback is stale or inaccessible
- **WHEN** the recorded resource/control observation no longer satisfies freshness or cannot be confirmed
- **THEN** current verification is incomplete even if a historical activation succeeded
- **AND** local source files are not used as substitute live proof
