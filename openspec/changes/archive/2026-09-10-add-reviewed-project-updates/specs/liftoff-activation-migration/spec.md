## Purpose

Provide a reviewed, history-preserving path from explicitly supported historical governance activation to a current activation that can be revalidated and resumed without replacing production project files or inventing executable proof.

## ADDED Requirements

### Requirement: Migration eligibility is an explicit contract distinct from execution compatibility
The system SHALL recognize activation migration lanes only through exact source and target identities declared by the installed release. The first lane SHALL create a v2 successor for the exact known v1 identity, using a strict historical-format reader. Eligibility SHALL NOT make v1 state, evidence, or approval executable. Unknown, mixed, future, malformed, unversioned, or unsupported source representations SHALL remain blocked without conversion, and project-edited compatibility metadata SHALL NOT authorize additional lanes.

#### Scenario: Known v1 has a supported successor
- **WHEN** a supported project's historical records satisfy the exact packaged v1 migration lane
- **THEN** `liftoff update --check` reports the source and target identities and the supported migration
- **AND** direct v1 governance execution remains blocked until an approved migration establishes the successor

#### Scenario: Version numbers do not prove compatibility
- **WHEN** individual identity fields are known but their complete tuple is not a declared migration source
- **THEN** preview reports the unsupported combination and issues no apply-eligible migration receipt
- **AND** no original bytes are rewritten

#### Scenario: Historical records are incomplete or ad hoc
- **WHEN** a required v1 record is missing, malformed, or not supported by its historical format
- **THEN** preview names the record and limitation without filling fields from checkboxes, filenames, or prose
- **AND** force cannot bypass the blocker

#### Scenario: Current v2 does not need historical migration
- **WHEN** a valid current v2 project has only managed-core drift
- **THEN** the ordinary reviewed update lane is used without creating a historical snapshot or replacing activation identity

### Requirement: The normal update preview describes the complete migration
The system SHALL expose migration through `liftoff update --check` and `liftoff update`, not through a separate activation-migration command. Human preview SHALL identify compatibility, exact managed changes, historical files to preserve and retire from active collections, target activation, local validation operations, known gaps, and the boundary of automatic resumption. Preview SHALL keep all project bytes unchanged and SHALL separately disclose any external preview-receipt write. Missing tools or unavailable current proof producers SHALL be distinguished from an unsupported source format and SHALL never be reported as successful validation.

#### Scenario: User reviews the human-first path
- **WHEN** the user runs `liftoff update --check` for an eligible v1 project
- **THEN** a readable preview explains the proposed successor, preserved history, fresh-proof work, and next command
- **AND** JSON is not required to review or proceed

#### Scenario: A known revalidation gap exists
- **WHEN** the source can be migrated but a local validation prerequisite or required producer is unavailable
- **THEN** the preview identifies the expected blocked phase and partial-readiness consequence
- **AND** approval does not cause missing proof to be counted as verified

#### Scenario: Component expansion accompanies migration
- **WHEN** configuration also requests a new frontend or environment during v1 migration
- **THEN** preview defers that provisioning to a fresh post-migration update plan
- **AND** the activation migration does not silently include unrelated project expansion

### Requirement: Historical snapshots preserve exact bytes through a portable explicit inventory
Before replacing active v1 state or retiring active historical records, an approved migration SHALL create and verify a durable snapshot inside the project's dedicated governance history directory. Its index SHALL identify the original identity, original portable paths, stored-copy paths, raw-byte digests, and recorded modes for all reviewed source metadata, state, evidence, plans, and approvals. Reads, copies, replacements, and retirements SHALL use the exact reviewed inventory, never broad directory ownership or deletion patterns. History paths SHALL be project-confined and equivalent under native Windows, macOS, and Linux path handling.

#### Scenario: State and receipts retain original formatting
- **WHEN** historical JSON contains differing indentation or line endings
- **THEN** the stored history copies have exactly the original bytes and matching recorded digests
- **AND** the system does not canonicalize or retag those copies

#### Scenario: An active historical record is retired
- **WHEN** the reviewed plan retires an exact old evidence, plan, or approval path from the active collection
- **THEN** its byte-identical historical copy is verified before that original path is removed
- **AND** unknown neighboring files remain untouched

#### Scenario: A historical destination conflicts
- **WHEN** a planned snapshot destination already contains different bytes or an unsafe path type
- **THEN** migration blocks before replacing active state
- **AND** force does not replace the destination

#### Scenario: A completed snapshot already exists
- **WHEN** a retry finds an index and all copies identical to its reviewed source inventory
- **THEN** the verified snapshot can be reused without rewriting its completed history

#### Scenario: The project moves between operating systems
- **WHEN** a project containing its snapshot is opened on Windows, macOS, or Linux
- **THEN** stored path parts resolve relative to the project using native path handling
- **AND** traversal, embedded separators, drive/UNC escapes, unsafe links, and case-colliding destinations are rejected

#### Scenario: History is retained with the project
- **WHEN** migration completes or an external preview receipt is removed
- **THEN** the in-project historical snapshot remains available
- **AND** update performs no automatic history cleanup, Git commit, push, or upload

### Requirement: A successor is created by a narrow recoverable local transaction
The system SHALL require a matching preview and explicit approval before creating a successor. The transaction SHALL preflight and bind the entire named managed-core, history, active-state, manifest, and migration-record write set, preserve history before retiring originals, and establish a strict v2 successor linked to that history. The link SHALL include source/target identities, approved plan identity, source snapshot identity, and successor local identity without relabeling the old state. Concurrent edits SHALL invalidate preconditions. Unknown applicability and phases without fresh proof SHALL remain unresolved rather than successful.

#### Scenario: Migration commits coherently
- **WHEN** an approved eligible migration completes its local transaction
- **THEN** the active manifest and v2 state agree with the migration record and installed target
- **AND** the preserved v1 snapshot remains distinct from current proof

#### Scenario: Required target managed files conflict
- **WHEN** a managed artifact required for the target activation cannot be safely installed under the selected plan
- **THEN** the system does not commit a successor while skipping that prerequisite
- **AND** only an independently reviewed eligible force variant can authorize a forceable core overwrite

#### Scenario: Source data changes after approval
- **WHEN** a protected source, destination, identity, or relevant input changes before the transaction writes
- **THEN** the system stops without applying the stale plan and requires a fresh check

#### Scenario: The process stops during local writes
- **WHEN** execution is interrupted before the successor transaction commits
- **THEN** durable recovery metadata identifies the exact already-approved write set and recovery outcome
- **AND** recovery preserves concurrent edits and does not start fresh update operations under old approval

#### Scenario: Historical remote identifiers are present
- **WHEN** v1 history names a repository, subscription, runner, or other remote resource
- **THEN** those values remain historical hints rather than verified current bindings or permission to access a provider

### Requirement: Revalidation establishes fresh proof without replaying old mutations
After the local migration commits, the system SHALL run only the finite local revalidation operations named in the approved plan and supported by the current phase/evidence contracts. Successful v2 evidence SHALL bind current inputs, the actual reviewed operation, and its body. Historical success and approval SHALL not become current authorization. Migration SHALL NOT install dependencies, modify production templates, recreate archives or live resources, commit, push, enroll credentials, read providers, or perform remote mutations automatically.

#### Scenario: Existing local work remains valid
- **WHEN** supported local checks confirm existing seed, baseline, or archived artifacts under current contracts
- **THEN** fresh v2 evidence records the observed result without regenerating the project or replaying completed archival work

#### Scenario: Historical success cannot be established now
- **WHEN** a v1 phase was marked verified but current validation cannot establish its required proof
- **THEN** the v2 phase remains blocked or incomplete
- **AND** no new hash or translated flag is accepted as a substitute

#### Scenario: Old approval exists for a later action
- **WHEN** preserved v1 history contains an approval for a billed, destructive, publication, or enforcement action
- **THEN** it remains historical audit data
- **AND** later v2 execution requires its independently applicable current approval

#### Scenario: A live resource already exists
- **WHEN** completing a phase would require observing or changing live infrastructure
- **THEN** automatic update revalidation stops and names the separately reviewed transition or unavailable capability
- **AND** it does not recreate the resource or derive access authority from a v1 receipt

#### Scenario: Project validation changes a protected input
- **WHEN** an explicitly disclosed local validation command unexpectedly modifies a protected input
- **THEN** the system preserves the edit, blocks affected proof, and reports the changed path
- **AND** it does not claim script sandboxing or roll back the edit as if it owned the file

### Requirement: Committed migration and revalidation readiness have separate outcomes
The system SHALL persist the local commit outcome separately from revalidation progress. If post-commit revalidation fails, is unavailable, or is interrupted, v2 SHALL remain active, blocked, and resumable with its v1 history intact. The command SHALL report local commit separately from readiness and SHALL exit 2 for committed-but-incomplete revalidation rather than claim full success or automatically restore v1.

#### Scenario: A local check fails after migration
- **WHEN** the history and v2 successor have committed but an approved local check fails
- **THEN** output identifies the committed migration, blocked phase, failed operation, and corrective action
- **AND** the original snapshot and valid completed v2 progress are retained

#### Scenario: Revalidation is interrupted
- **WHEN** the process exits while a post-commit operation is running
- **THEN** a later inspection identifies incomplete work and does not interpret running state as success

#### Scenario: A retry follows repair
- **WHEN** the user obtains a fresh matching preview and approves the remaining work
- **THEN** the system resumes the same successor, revalidates changed inputs, and reuses only fresh v2 proof
- **AND** it does not create a duplicate migration or rewrite completed history

### Requirement: Resume identifies the first genuinely incomplete supported phase
The system SHALL use current evidence and validated applicability to determine the next incomplete phase after migration/revalidation. Status, resume, and verify SHALL remain read-only and SHALL distinguish migration progress from complete governance. Automatic continuation SHALL end at the approved local boundary, an unsupported capability, changed input, or a phase requiring independent authorization.

#### Scenario: Earlier phases have fresh evidence
- **WHEN** revalidation establishes valid proof for earlier phases but a later phase is incomplete
- **THEN** the system identifies that later phase without replaying the verified work

#### Scenario: Resume is inspection only
- **WHEN** `liftoff governance resume` inspects a blocked migrated project
- **THEN** it reports current blockers and the next supported action
- **AND** it writes no evidence, state, history, receipt, or provider resource

### Requirement: Historical records remain separate from current proof across consumers
Update, doctor, governance status/readiness/verify, and assessment SHALL use a consistent validated relationship between the historical snapshot, migration record, and active successor. Preserved v1 SHALL be informational, not executable proof and not a blanket reason to reject valid current v2. Invalid declared history links and malformed or contradictory current records SHALL remain visible blockers. No consumer SHALL silently reset the project or fall back to historical proof.

#### Scenario: Valid history coexists with current evidence
- **WHEN** a migrated project retains v1 history and has valid current v2 evidence
- **THEN** all consumers evaluate readiness from current proof and report history separately

#### Scenario: A declared history link is corrupt
- **WHEN** the migration record points to an invalid, missing, escaping, or digest-mismatched snapshot
- **THEN** consumers identify the broken link without manufacturing a clean migration or accessing unsafe paths

#### Scenario: Current evidence is malformed
- **WHEN** an active v2 record is malformed or contradicts equally authoritative current proof
- **THEN** readiness remains blocked even when historical records report success
