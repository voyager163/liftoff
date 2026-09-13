## MODIFIED Requirements

### Requirement: Migration eligibility is an explicit contract distinct from execution compatibility
The system SHALL recognize activation-record migration only through exact source and target identities declared by the installed release. It SHALL provide reviewed successor lanes from the supported historical v1 family and v2 family to activation package `0.12.0`, manifest artifact 7, policy 6, activation contract 3, graph schema 2, state/evidence/approval schemas 3, and compatibility metadata 4. Unchanged supersession and credential-policy representations SHALL remain schema 1. Source tuples and graph hashes SHALL match their actual published contracts; target graph hashes SHALL be computed from the implemented graph, not invented or inferred from CLI SemVer. Eligibility SHALL not make historical state, evidence, or approval executable.

Unknown, mixed-active, future, malformed, unversioned, or unsupported sources SHALL remain blocked without conversion. Project-edited compatibility metadata SHALL not add migration lanes. A valid retained history from an earlier migration SHALL not be mistaken for a mixed active identity.

#### Scenario: Known v1 has a supported successor
- **WHEN** a supported project's historical records satisfy the exact packaged v1 source contract
- **THEN** `liftoff update --check` identifies the source and declared v3 successor
- **AND** v1 execution remains blocked until an approved successor is established
- **AND** no executable v2 intermediate or retagged v1 proof is required to reach the declared target

#### Scenario: Version numbers do not prove compatibility
- **WHEN** individual fields are known but the complete source tuple or graph hash is not declared
- **THEN** preview reports the unsupported combination and issues no apply-eligible migration receipt
- **AND** original bytes remain unchanged

#### Scenario: Historical records are incomplete or ad hoc
- **WHEN** a required source record is missing, malformed, or unsupported by its historical reader
- **THEN** preview identifies the record and limitation without filling fields from tasks, filenames, or prose
- **AND** force cannot bypass that boundary

#### Scenario: Current v2 does not need historical migration
- **WHEN** a v2 project receives same-contract managed-core maintenance rather than a requested v3 execution upgrade
- **THEN** maintenance does not create a successor solely because the CLI patch version changed
- **AND** execution under the new v3 contract still requires its declared approved successor

#### Scenario: Known v2 upgrades to the revised execution contract
- **WHEN** the source matches the supported `0.11.0` activation family, contract 2, graph schema 1, and state/evidence/approval schemas 2
- **THEN** preview offers the exact declared v2-to-v3 lane after validating the complete source identity and records
- **AND** the old active graph, receipts, approvals, and history remain non-executable source data for that migration

#### Scenario: Current v3 needs only core maintenance
- **WHEN** the active project already uses the exact supported v3 identity and has only ordinary managed-core drift
- **THEN** the existing reviewed core-update lane applies without a duplicate activation successor or history snapshot

#### Scenario: No activation has started
- **WHEN** a supported project has no activation state, evidence, approvals, or other active execution records
- **THEN** it is not presented as an existing v1/v2 activation requiring invented historical state
- **AND** managed metadata can follow its supported update path while new execution state is created only by an explicit current-contract operation

#### Scenario: Activation state is absent but active receipts remain
- **WHEN** evidence, approval, or execution records exist without their required source activation state
- **THEN** preview reports the incomplete source instead of treating the project as a clean not-started activation
- **AND** no missing history or state is manufactured

### Requirement: The normal update preview describes the complete migration
Activation-record migration SHALL remain exposed through `liftoff update --check` and explicitly approved `liftoff update`, not a new activation-migration command. Preview SHALL show exact source/target identities, required managed changes, historical records to preserve and retire from active collections, local successor writes, finite revalidation, known gaps, and the next separately authorized stage. It SHALL preserve project bytes and disclose any external preview receipt. Missing tools or incomplete current proof SHALL remain distinct from invalid source format.

The approved fingerprint SHALL bind the resolved project, source record digests, target graph/contract, exact write inventory, and local verification scope. A configuration request to add an agent, change its default, or provision another component SHALL not silently become part of the identity migration.

#### Scenario: User reviews the human-first path
- **WHEN** an eligible v1 or v2 project is checked
- **THEN** a readable preview identifies the declared v3 successor, preserved history, fresh-proof work, and exact approval/apply sequence
- **AND** JSON is not required to review or proceed

#### Scenario: A known revalidation gap exists
- **WHEN** source metadata can be migrated but a required local prerequisite or proof cannot currently be established
- **THEN** preview identifies the expected incomplete phase and post-commit consequence
- **AND** approval does not count missing proof as verified

#### Scenario: Component expansion accompanies migration
- **WHEN** desired state also requests an added frontend, environment, agent, or changed default
- **THEN** preview identifies that separate preparation/repair scope and preserves the requested configuration
- **AND** the identity migration neither performs unrelated expansion nor requires manual metadata edits to pretend it occurred

#### Scenario: Approval does not match the preview
- **WHEN** approval is missing, stale, for another project, or bound to different source/target operations
- **THEN** application refuses the migration before project writes
- **AND** formatting or force flags do not supply missing authorization

### Requirement: Historical snapshots preserve exact bytes through a portable explicit inventory
Before replacing active v1/v2 records, an approved migration SHALL create and verify a durable activation-history snapshot inside the project's registered governance history namespace. The index SHALL identify original identity, original and stored-copy portable paths, raw-byte digests, and recorded modes for the exact reviewed manifests, activation state, evidence, plans, approvals, and source/migration metadata. Reads, copies, replacements, and retirements SHALL use explicit recorded inventories, never broad directory ownership or deletion patterns.

Existing referenced histories SHALL be validated and retained without rewriting their bytes. Activation-history storage SHALL not become a destination for OpenTofu state, credential values, encryption keys, or sensitive provider plans. Unsafe source payloads SHALL produce a sanitized preservation blocker rather than be silently rewritten or copied into public history.

#### Scenario: State and receipts retain original formatting
- **WHEN** source activation JSON has different indentation or line endings
- **THEN** its stored snapshot has exactly the original bytes and matching recorded digest
- **AND** historical content is not canonicalized or retagged

#### Scenario: An active historical record is retired
- **WHEN** the plan retires an exact old evidence, plan, or approval path from the active collection
- **THEN** its historical copy is verified before that active path is removed
- **AND** unknown neighboring files are unchanged

#### Scenario: A historical destination conflicts
- **WHEN** a snapshot destination contains differing bytes or an unsafe path type
- **THEN** migration blocks before replacing active state
- **AND** force cannot overwrite the conflicting history

#### Scenario: A completed snapshot already exists
- **WHEN** a retry finds an index and copies matching its exact reviewed source inventory
- **THEN** the verified snapshot is reused without rewriting completed history

#### Scenario: The project moves between operating systems
- **WHEN** the project and its history are opened on Windows, macOS, or Linux
- **THEN** stored path parts resolve natively within the declared project/history boundary
- **AND** traversal, embedded separators, drive/UNC escapes, unsafe links, junctions, and case collisions are rejected

#### Scenario: History is retained with the project
- **WHEN** migration completes or an external preview receipt is removed
- **THEN** in-project activation history remains available
- **AND** no automatic history cleanup, Git commit, push, or upload occurs

#### Scenario: A v2 source already retains v1 history
- **WHEN** a valid v2 source references an earlier preserved v1 snapshot
- **THEN** the v3 successor retains verifiable source-history relationships without rewriting or merging that earlier snapshot into active proof
- **AND** a damaged ancestor link is reported rather than replaced with a clean invented lineage

#### Scenario: A source record contains an unsafe payload
- **WHEN** a purported activation record includes a credential value, OpenTofu state payload, or other prohibited sensitive content
- **THEN** preview reports a sanitized blocker and preserves the original source
- **AND** it does not sanitize the bytes and call the result a byte-preserving migration

### Requirement: A successor is created by a narrow recoverable local transaction
The system SHALL require a matching preview and explicit approval before creating the v3 successor. The local transaction SHALL bind and preflight the exact managed-core, history, active-state, manifest, and migration-record inventory, preserve source history before retiring originals, and commit a strict target identity linked to that history. Links SHALL identify source/target contracts, approved plan, snapshot, and local execution identity without relabeling source records.

New or changed phases SHALL not inherit verified or approved status from old checkboxes or receipts. Unknown applicability SHALL remain unknown. A valid source-local anchor SHALL be preserved according to the declared mapping, or a new local anchor SHALL be established without trusting a historical remote identifier. Concurrent changes SHALL invalidate protected preconditions.

#### Scenario: Migration commits coherently
- **WHEN** an approved eligible transaction commits
- **THEN** active manifest, v3 state, managed graph, and migration record agree with the declared target
- **AND** preserved v1/v2 snapshots remain separate from current execution proof

#### Scenario: Required target managed files conflict
- **WHEN** required target metadata cannot be safely installed under the approved plan
- **THEN** no successor is committed while skipping that prerequisite
- **AND** only a separately reviewed eligible managed-core force variant can authorize a forceable core conflict

#### Scenario: Source data changes after approval
- **WHEN** a protected source, destination, identity, or relevant input changes before writing
- **THEN** execution rejects the stale plan and requires a fresh check
- **AND** it does not overwrite concurrent development

#### Scenario: The process stops during local writes
- **WHEN** the transaction is interrupted before commit
- **THEN** durable recovery identifies the exact authorized write set and restores or reconciles it according to current preconditions
- **AND** no new update operation starts under the interrupted approval

#### Scenario: Historical remote identifiers are present
- **WHEN** source history names a repository, subscription, runner, backend, or resource
- **THEN** these remain historical hints until independently rebound under current scope
- **AND** the metadata migration does not contact or mutate that remote destination

#### Scenario: The target graph adds or reorders phases
- **WHEN** v3 introduces bootstrap workflow, artifact, approval, or lifecycle behavior absent from the source contract
- **THEN** target progress is initialized according to its declared mapping and current proof requirements
- **AND** a similarly named historical phase is not treated as proof of the new behavior

### Requirement: Revalidation establishes fresh proof without replaying old mutations
After the local successor commits, migration SHALL execute only the finite local revalidation operations explicitly named in its approved plan and permitted by the current contract. New proof SHALL bind current relevant inputs, target graph/identity, actual verification, and its body. Historical success or approval SHALL not become current authority. Existing source records that are stale against today's worktree SHALL remain historical rather than be made current by copying a header or hash.

Identity migration SHALL NOT implicitly install tools or application dependencies, replace project templates, recreate archives/resources, publish Git history, enroll credentials, access providers or sensitive OpenTofu state, migrate backends, or perform live mutations. If completion needs another effect scope, it SHALL name the separately authorized action and stop automatic migration revalidation at that boundary.

#### Scenario: Existing local work remains valid
- **WHEN** approved current checks validate existing seed, baseline, or archived artifacts
- **THEN** fresh v3 evidence records the actual result without regenerating the application or replaying completed archival work

#### Scenario: Historical success cannot be established now
- **WHEN** a v1/v2 phase was marked verified but current checks cannot establish its required proof
- **THEN** the target remains incomplete or blocked
- **AND** a translated flag, copied receipt, or new header hash is not accepted instead

#### Scenario: Old approval exists for a later action
- **WHEN** source history contains publication, credential, billed, destructive, stateful, or enforcement approval
- **THEN** it remains audit data
- **AND** v3 effects require the applicable current approval rather than expanded historical consent

#### Scenario: A live resource already exists
- **WHEN** further progress requires current provider observation, adoption, or mutation
- **THEN** automatic identity-migration revalidation stops and names the supported separate plan/readback action
- **AND** it does not recreate the resource to obtain a new-version receipt

#### Scenario: Project validation changes a protected input
- **WHEN** an approved local validation command unexpectedly changes a protected source file
- **THEN** the change is preserved, affected proof is blocked, and the path is reported
- **AND** migration does not claim script sandboxing or roll back a file outside its ownership

#### Scenario: Historical approval is expired
- **WHEN** an otherwise well-formed historical approval no longer has current validity
- **THEN** expiry alone does not require rewriting that history to preserve it
- **AND** the expired approval cannot authorize target execution

### Requirement: Committed migration and revalidation readiness have separate outcomes
The local commit outcome SHALL be persisted separately from revalidation. If post-commit checks fail, lack prerequisites, or are interrupted, the v3 successor SHALL remain active and resumable with its source history intact. Update SHALL return exit 2 for committed-but-incomplete revalidation rather than claim completed setup/activation or automatically restore v1/v2.

#### Scenario: A local check fails after migration
- **WHEN** history and the v3 successor commit but an approved local check fails
- **THEN** output identifies the committed migration, actual failed phase/operation, and supported remedy
- **AND** original history and valid target progress are retained

#### Scenario: Revalidation is interrupted
- **WHEN** execution stops during a post-commit verification operation
- **THEN** later inspection reports incomplete work rather than treating running state as success

#### Scenario: A retry follows repair
- **WHEN** the user obtains a fresh preview and approves the remaining local work
- **THEN** the same successor is resumed using current inputs and proof
- **AND** no duplicate migration or rewritten completed history is created

#### Scenario: A previously committed migration is inspected again
- **WHEN** the exact successor and history are intact
- **THEN** inspection reports the existing commit and current revalidation state
- **AND** it does not offer source retirement or successor creation as if they had not occurred

### Requirement: Resume identifies the first genuinely incomplete supported phase
After migration, current proof and validated applicability SHALL determine the next incomplete or plannable operation under the requested scope. Status, resume, and verify SHALL remain read-only and distinguish identity migration, local completion, full activation, OpenTofu-state migration, and lifecycle work. Automatic update continuation SHALL end at its finite approved local boundary, changed inputs, or work requiring separate authority.

#### Scenario: Earlier phases have fresh evidence
- **WHEN** revalidation establishes valid current proof for earlier work
- **THEN** the next incomplete supported operation is reported without replaying verified mutations

#### Scenario: Resume is inspection only
- **WHEN** governance resume inspects the migrated project
- **THEN** it reports current blockers and supported actions
- **AND** it writes no state, evidence, history, receipt, or provider resource

#### Scenario: The next phase needs approval
- **WHEN** the successor has a dependency-ready phase without its required current approval
- **THEN** the CLI exposes the actual plan/approval path instead of requiring fabricated approval files
- **AND** migration completion is not itself that approval

#### Scenario: Local revalidation completes during the full setup journey
- **WHEN** the native setup integration finishes the identity-upgrade boundary and local requirements
- **THEN** it can present the next separately approved activation or stateful-repair stage
- **AND** the update operation does not execute that stage implicitly

### Requirement: Historical records remain separate from current proof across consumers
Update, doctor, governance status/readiness/verify, and assessment SHALL use the same validated relationship between source history, migration records, and the active v3 successor. Preserved v1/v2 history SHALL be informational, not executable proof and not a blanket reason to reject valid current progress. Invalid links, malformed active data, and contradictory equally authoritative proof SHALL remain explicit errors; no consumer SHALL reset the project or fall back to history as current state.

#### Scenario: Valid history coexists with current evidence
- **WHEN** a v3 project retains valid v1/v2 source history and current target evidence
- **THEN** consumers evaluate current readiness from target proof and report history separately

#### Scenario: A declared history link is corrupt
- **WHEN** a link is missing, unsafe, or digest-mismatched
- **THEN** consumers report the broken relationship without manufacturing replacement history or accessing an unsafe path

#### Scenario: Current evidence is malformed
- **WHEN** active v3 proof is malformed or contradicts equally authoritative current records
- **THEN** dependent readiness remains blocked even if source history reports success

#### Scenario: Manifest writer differs from activation identity
- **WHEN** the source manifest's last-writing CLI version differs from its activation package family
- **THEN** consumers use the exact activation contract and source records to select the lane
- **AND** a CLI version label alone does not establish the source or target execution identity

## ADDED Requirements

### Requirement: Identity migration preserves protective lifecycle obligations
Migration SHALL preserve validated source-local identity relationships and historical safety obligations without promoting them into current execution authority. Retained/frozen/disposed material, original retention start or due timestamps, and referenced ownership restrictions SHALL not be reset, relaxed, or recreated merely by changing activation versions. Current lifecycle execution SHALL require its own validated scope and approval; uncertainty SHALL retain the protective restriction.

#### Scenario: Bootstrap retention is already running
- **WHEN** the source records a valid retained-state obligation and original verification timestamp
- **THEN** the successor preserves that obligation and original timing for current verification
- **AND** it does not restart the retention clock or make the retained source usable for ordinary plan/apply

#### Scenario: Source material has been disposed
- **WHEN** source history records disposal under its valid contract
- **THEN** the metadata upgrade preserves that history and does not recreate the material or keys
- **AND** current lifecycle status distinguishes historical disposition from any new verification required

#### Scenario: Lifecycle ownership is uncertain
- **WHEN** a retained-state or key reference cannot be safely interpreted or bound
- **THEN** the limitation is visible and the material is not used or deleted under migration approval

### Requirement: Activation-record upgrade is not OpenTofu-state migration
The CLI SHALL state that the successor transaction changes Liftoff control records and managed metadata, not the application's deployed resource ownership or OpenTofu backend state. It SHALL not read, transport, transform, import, or publish OpenTofu state through this lane. The full setup journey SHALL use the separate protected stateful-repair and activation protocols when those operations are requested.

#### Scenario: Both kinds of migration are needed
- **WHEN** a project needs an activation-contract upgrade and a legacy infrastructure-state migration
- **THEN** their plans, histories, approvals, effect scopes, and completion results remain distinct
- **AND** the local identity upgrade can establish the current control plane without authorizing backend mutation

#### Scenario: Stateful inspection approval is absent
- **WHEN** a subsequent repair needs sensitive OpenTofu state to establish mappings
- **THEN** the existing identity-migration approval does not authorize the read
- **AND** the CLI presents the separate exact protected-inspection scope
