## MODIFIED Requirements

### Requirement: Migration eligibility is an explicit contract distinct from execution compatibility
The system SHALL recognize activation-record migration only through exact source and target identities declared by the installed release. It SHALL provide reviewed successor lanes from the supported historical v1, v2 and v3 families and the exact pre-amendment policy-7/credential-policy-schema-1 candidate to the coordinated activation family with manifest artifact 8, policy 8, activation contract 4, graph schema 3, state/evidence/approval schemas 4, compatibility metadata 5 and credential-policy schema 2. Unchanged supersession representation SHALL remain schema 1. Source tuples and graph hashes SHALL match actual published contracts or the explicitly retained pre-amendment candidate identity; the target activation package identity SHALL be declared explicitly and its graph hash computed from the implemented graph. Eligibility SHALL NOT make historical state, evidence or approval executable.

Unknown, mixed-active, future, malformed, unversioned or unsupported sources SHALL remain blocked without conversion. Project-edited compatibility metadata SHALL NOT add migration lanes. A valid retained ancestor history SHALL NOT be mistaken for a mixed active identity.

#### Scenario: The prior policy-7 candidate requests the amended target
- **WHEN** a project matches the exact registered pre-amendment candidate tuple and schema-1 credential policy
- **THEN** preview identifies a separate history-preserving identity/policy transition with its exact writes and broader-read disclosure
- **AND** matching activation-contract number 4, original approval or ordinary core maintenance cannot authorize the broader provider grant

#### Scenario: Credential policy transitions without inherited authority
- **WHEN** the identity transition is separately approved
- **THEN** original policy, approval and ownership records remain byte-preserved and new credential use still requires independently observed grants and fresh exact credential approval
- **AND** publication is not repeated, retention obligations are not reset and a schema-1 receipt is not relabeled as schema-2 proof

#### Scenario: Known v1 has a supported successor
- **WHEN** a supported project's historical records satisfy the exact packaged v1 source contract
- **THEN** update check identifies the source and declared v4 successor
- **AND** no executable intermediate or retagged historical proof is required to reach that target

#### Scenario: Version numbers do not prove compatibility
- **WHEN** individual fields are known but the complete tuple or graph hash is not declared
- **THEN** preview reports the unsupported combination without an apply-eligible migration receipt
- **AND** original bytes remain unchanged

#### Scenario: Historical records are incomplete or ad hoc
- **WHEN** a required record is missing, malformed or unsupported by its historical reader
- **THEN** preview identifies the limitation without filling fields from tasks, filenames or prose
- **AND** force cannot bypass the boundary

#### Scenario: Current v2 does not need historical migration
- **WHEN** a supported v2 project requests explicitly registered same-contract managed-core maintenance rather than a new execution contract
- **THEN** maintenance does not create a successor solely because CLI SemVer changed
- **AND** execution under v4 still requires its declared approved successor

#### Scenario: Known v2 upgrades to the revised execution contract
- **WHEN** the source matches the supported published v2 family and complete records
- **THEN** preview offers its exact declared v2-to-v4 lane
- **AND** old active graph, receipts, approvals and ancestor history remain non-executable source data

#### Scenario: Known v3 upgrades to the revised execution contract
- **WHEN** the source matches the published 0.12.0 activation package family used by CLI 0.12.x, contract/state/evidence/approval 3 and graph 2
- **THEN** preview offers the explicit v3-to-v4 lane after validating its exact tuple and records
- **AND** an unrelated native CLI installation does not itself authorize the migration

#### Scenario: Current v3 needs only core maintenance
- **WHEN** the active v3 project requests maintenance that is explicitly registered as compatible with its existing identity rather than a v4 execution upgrade
- **THEN** check distinguishes that maintenance from successor creation without duplicating activation history
- **AND** a current write that requires v4 remains blocked until its separate declared migration is approved

#### Scenario: Current v4 needs only core maintenance
- **WHEN** the active project already uses the exact supported v4 identity and has ordinary managed-core drift
- **THEN** the reviewed core-update lane applies without a duplicate successor or history snapshot

#### Scenario: No activation has started
- **WHEN** a supported project has no activation state, evidence, approvals or other active execution records
- **THEN** it is not presented as a historical activation requiring invented source state
- **AND** managed metadata follows its supported update path while execution state is created only by an explicit current-contract operation

#### Scenario: Activation state is absent but active receipts remain
- **WHEN** execution records exist without required source state
- **THEN** preview reports an incomplete source rather than a clean not-started activation
- **AND** no missing history or state is manufactured

### Requirement: The normal update preview describes the complete migration
Activation-record migration SHALL remain exposed through update check and explicitly approved update, not an implicit installer action or a destructive alias for project adoption. Preview SHALL show source/target identities, required managed changes, the exact historical preservation/retirement inventory, successor writes, finite local revalidation, publication revalidation eligibility, known gaps and subsequent separately authorized scopes. It SHALL preserve project bytes and disclose external preview storage.

The approved fingerprint SHALL bind the canonical project, source record digests, target graph/contract, exact writes and local verification scope. Agent changes, component expansion, installation migration and provider work SHALL NOT silently join that authority.

#### Scenario: User reviews the human-first path
- **WHEN** an eligible historical project is checked
- **THEN** a readable preview identifies the declared successor, preserved history, fresh-proof work and exact approval sequence
- **AND** JSON or manual fingerprint entry is not required for normal interactive review

#### Scenario: A known revalidation gap exists
- **WHEN** metadata can migrate but a required current prerequisite or proof cannot be established
- **THEN** preview identifies the incomplete phase and post-commit consequence
- **AND** approval does not count missing proof as verified

#### Scenario: Component expansion accompanies migration
- **WHEN** desired state requests an added frontend, environment, agent or changed default
- **THEN** preview identifies that separate scope and preserves the request
- **AND** identity migration does not perform unrelated expansion or require fabricated metadata

#### Scenario: Approval does not match the preview
- **WHEN** approval is missing, expired, for another project or bound to different operations
- **THEN** application refuses before project writes
- **AND** output formatting or force does not provide missing authorization

### Requirement: Historical snapshots preserve exact bytes through a portable explicit inventory
Before replacing active historical records, an approved migration SHALL create and verify a durable activation-history snapshot inside the project's registered history namespace. Its index SHALL identify original identity, original and stored-copy portable paths, raw-byte digests and modes for the exact reviewed manifests, state, evidence, plans, approvals and source/migration metadata. Reads, copies, replacements and retirements SHALL use explicit inventories, never broad directory ownership or deletion patterns.

Referenced ancestor histories SHALL be validated and retained byte-for-byte. Public activation history SHALL NOT store OpenTofu state, credentials, encryption keys or sensitive provider plans. Unsafe payloads SHALL produce a sanitized preservation blocker, not a rewritten copy called original history.

#### Scenario: State and receipts retain original formatting
- **WHEN** source JSON has different indentation or line endings
- **THEN** its snapshot preserves exactly those bytes and digest
- **AND** historical content is not canonicalized or retagged

#### Scenario: An active historical record is retired
- **WHEN** a plan retires an exact old evidence, plan or approval path
- **THEN** its historical copy is verified first
- **AND** unknown neighboring files remain unchanged

#### Scenario: A historical destination conflicts
- **WHEN** a snapshot destination contains different bytes or an unsafe path type
- **THEN** migration blocks before replacing active state
- **AND** force cannot overwrite the conflicting history

#### Scenario: A completed snapshot already exists
- **WHEN** a retry finds an index and copies matching its reviewed source inventory
- **THEN** that verified snapshot is reused without rewriting completed history

#### Scenario: The project moves between operating systems
- **WHEN** the project and history are opened on Windows, macOS or Linux
- **THEN** recorded path parts resolve natively within their declared boundaries
- **AND** traversal, embedded separators, drive/UNC escapes, links, junctions and case collisions are rejected

#### Scenario: History is retained with the project
- **WHEN** migration completes or an external preview is removed
- **THEN** in-project history remains available
- **AND** no automatic history cleanup, Git commit, push or upload occurs

#### Scenario: A v2 source already retains v1 history
- **WHEN** a supported v2 source references verified v1 ancestor history
- **THEN** its v4 successor retains the relationships without rewriting ancestors or merging them into active proof
- **AND** damaged links are reported rather than replaced with invented lineage

#### Scenario: A v3 source retains earlier migration history
- **WHEN** a supported v3 source references verified v1 or v2 ancestor history
- **THEN** its v4 successor preserves the complete validated ancestry without rewriting or merging historical proof
- **AND** a damaged ancestor remains an explicit blocker

#### Scenario: A source record contains an unsafe payload
- **WHEN** a purported activation record contains credentials, state or prohibited sensitive content
- **THEN** preview reports a sanitized blocker and preserves the original
- **AND** it does not sanitize and relabel the result as byte-preserving migration

### Requirement: A successor is created by a narrow recoverable local transaction
The system SHALL require matching preview and explicit approval before creating the v4 successor. The local transaction SHALL preflight exact managed-core, history, active-state, manifest and migration-record inventories, preserve history before retiring originals, and commit a strict target identity linked to its source. Links SHALL identify contracts, plan, snapshot and execution identity without relabeling original records.

New or changed phases SHALL NOT inherit verified/approved state from old flags or receipts. Unknown applicability SHALL remain unknown. A valid source-local anchor SHALL be preserved by its declared mapping or re-established without trusting historical remote identifiers. Concurrent changes SHALL invalidate protected preconditions.

#### Scenario: Migration commits coherently
- **WHEN** an approved eligible transaction commits
- **THEN** active manifest, v4 state, graph and migration record agree
- **AND** preserved v1/v2/v3 records remain separate from current proof

#### Scenario: Required target managed files conflict
- **WHEN** required target metadata cannot be safely installed under the plan
- **THEN** no successor commits while skipping the prerequisite
- **AND** only a separately reviewed eligible managed-core conflict variant can authorize a forceable core replacement

#### Scenario: Source data changes after approval
- **WHEN** a protected source, destination, identity or relevant input changes
- **THEN** execution rejects the old plan before overwriting concurrent development

#### Scenario: The process stops during local writes
- **WHEN** the approved transaction is interrupted
- **THEN** recovery handles only its durable authorized inventory under current preconditions
- **AND** no new update starts under that interrupted approval

#### Scenario: Historical remote identifiers are present
- **WHEN** history names repositories, subscriptions, runners, backends or resources
- **THEN** they remain hints until independently rebound
- **AND** the local metadata transaction does not contact or mutate those destinations

#### Scenario: The target graph adds or reorders phases
- **WHEN** v4 introduces repository-only scope or changes phase-input/proof semantics
- **THEN** progress follows the declared compatibility mapping and current evidence requirements
- **AND** similarly named historical phases do not prove the new behavior

### Requirement: Revalidation establishes fresh proof without replaying old mutations
After successor commit, automatic migration revalidation SHALL execute only finite local operations named in its approved plan. New proof SHALL bind relevant current inputs, target graph/identity, actual verification and body. Historical success/approval SHALL NOT become current authority, and stale records SHALL remain historical rather than become current through copied headers or hashes.

Identity migration SHALL NOT implicitly install tools/dependencies, replace application templates, recreate archives/resources, publish Git history, enroll credentials, access providers or sensitive state, or migrate backends. Publication readback for an affected v3 project SHALL use the separate reviewed revalidation scope. Required further effects SHALL be named and automatic local continuation SHALL stop at that boundary.

#### Scenario: Existing local work remains valid
- **WHEN** approved checks validate existing seed, baseline or archived artifacts
- **THEN** fresh v4 evidence records the actual result without regenerating the application or replaying completed archival mutations

#### Scenario: Historical success cannot be established now
- **WHEN** a historical phase was marked verified but current checks cannot establish its proof
- **THEN** the successor remains incomplete or blocked
- **AND** translated flags, copied receipts or a new header hash are insufficient

#### Scenario: Old approval exists for a later action
- **WHEN** history contains publication, credential, billed, destructive, stateful or enforcement approval
- **THEN** it remains audit data
- **AND** new effects need applicable current authority

#### Scenario: A live resource already exists
- **WHEN** progress requires provider observation, adoption or mutation
- **THEN** automatic local revalidation stops with the actual separately authorized action
- **AND** the resource is not recreated to obtain a new-version receipt

#### Scenario: Project validation changes a protected input
- **WHEN** an approved validation command unexpectedly changes protected source
- **THEN** the change is preserved and affected proof is blocked with the path identified safely
- **AND** migration does not claim sandboxing or restore a file outside its authority

#### Scenario: Historical approval is expired
- **WHEN** an otherwise valid historical approval has expired
- **THEN** its bytes remain preserved
- **AND** it cannot authorize current execution

### Requirement: Committed migration and revalidation readiness have separate outcomes
The local commit outcome SHALL be persisted separately from revalidation. If later checks fail, lack prerequisites or are interrupted, the v4 successor SHALL remain active and resumable with intact source history. Update SHALL return exit 2 for committed-but-incomplete revalidation instead of claiming setup/enforcement completion or automatically restoring historical active records.

#### Scenario: A local check fails after migration
- **WHEN** history and successor commit but an approved check fails
- **THEN** output identifies the committed migration, failed operation and supported remedy
- **AND** history and valid current progress are retained

#### Scenario: Revalidation is interrupted
- **WHEN** a post-commit verification is interrupted
- **THEN** later inspection reports incomplete work rather than treating running state as success

#### Scenario: A retry follows repair
- **WHEN** a fresh preview and approval cover remaining local work
- **THEN** the same successor resumes from current inputs
- **AND** completed history is not duplicated or rewritten

#### Scenario: A previously committed migration is inspected again
- **WHEN** its successor and history remain intact
- **THEN** inspection reports the existing commit and revalidation state
- **AND** it does not offer successor creation or source retirement as if absent

### Requirement: Resume identifies the first genuinely incomplete supported phase
Current proof and applicability SHALL determine the next operation under the selected scope. Status, resume and verify SHALL remain non-mutating and distinguish identity migration, local completion, repository enforcement, full activation, state migration and lifecycle work. Automatic update continuation SHALL end at its finite approved local boundary, changed inputs or new authority needs.

#### Scenario: Earlier phases have fresh evidence
- **WHEN** revalidation establishes current proof for earlier work
- **THEN** the next incomplete supported operation is reported without replaying verified mutations

#### Scenario: Resume is inspection only
- **WHEN** governance resume inspects the successor
- **THEN** it reports blockers and supported actions without writing state, evidence, history, receipts or provider resources

#### Scenario: The next phase needs approval
- **WHEN** a dependency-ready phase lacks required current approval
- **THEN** its real plan/approval action is exposed
- **AND** migration completion is not that approval

#### Scenario: Local revalidation completes during the full setup journey
- **WHEN** identity upgrade and local requirements finish
- **THEN** setup can present the next separately approved repository, activation or stateful scope
- **AND** update does not execute it implicitly

### Requirement: Historical records remain separate from current proof across consumers
Update, doctor, governance status/readiness/verify and assessment SHALL share the validated relationship between source history, migration records and the active v4 successor. Preserved history SHALL be informational, not execution proof or a blanket rejection of valid progress. Corrupt links, malformed active data and contradictory current proof SHALL remain explicit errors without resetting the project or falling back to historical success.

#### Scenario: Valid history coexists with current evidence
- **WHEN** a v4 project retains valid v1/v2/v3 history and current evidence
- **THEN** consumers evaluate readiness from current proof and report history separately

#### Scenario: A declared history link is corrupt
- **WHEN** a link is missing, unsafe or digest-mismatched
- **THEN** consumers report it without manufacturing history or accessing an unsafe path

#### Scenario: Current evidence is malformed
- **WHEN** active proof is malformed or contradicts equally authoritative records
- **THEN** dependent readiness remains blocked even when source history reports success

#### Scenario: Manifest writer differs from activation identity
- **WHEN** the manifest's last-writing CLI differs from its activation package family
- **THEN** the exact activation tuple and records select compatibility
- **AND** CLI version or installation channel alone does not establish execution identity

## ADDED Requirements

### Requirement: Affected v3 publication has an explicit reviewed revalidation path
An affected schema-3 project whose completed publication was invalidated by later Azure-only inputs SHALL have a supported plan that preserves historical records, declares the new input-binding semantics and identifies finite publication readback. After explicit approval of required read scopes, the engine SHALL verify the actual recorded local commit, repository and remote ref, then append current linked evidence only for established facts. It SHALL NOT recommit, repush, fabricate receipts or silently accept old hashes under the new algorithm.

#### Scenario: Published facts are unchanged after Azure inputs are added
- **WHEN** a valid historical v3 project has completed local setup and matching actual local/remote publication but Azure configuration made its old evidence stale
- **THEN** the public preview exposes an executable reviewed migration/revalidation path with its exact effects and configuration binding
- **AND** successful revalidation permits Phase 0 planning with the real Azure inputs without another commit or push solely to repair that mismatch

#### Scenario: The real remote ref changed
- **WHEN** readback no longer matches the reviewed publication
- **THEN** revalidation refuses to certify that publication
- **AND** it neither force-pushes nor edits old receipts to hide the change

#### Scenario: Local migration bookkeeping is not published
- **WHEN** the compatibility transaction writes new local control metadata while the recorded Git commit remains unchanged
- **THEN** the report distinguishes verified historical publication facts from unpushed new local changes
- **AND** later publication of actual new content requires its own plan and approval

#### Scenario: Readback permission is unavailable
- **WHEN** the required repository/ref cannot be observed within authorized scope
- **THEN** migration reports the revalidation blocker and preserves all history
- **AND** a stored verified flag or inferred repository name does not substitute for readback

#### Scenario: Revalidation is repeated after success
- **WHEN** the same successor and current publication evidence remain valid
- **THEN** the engine reports the established result without duplicate writes or publication

#### Scenario: Input path or project context changes
- **WHEN** an approved revalidation was bound to an input file or project with spaces on Windows, macOS or Linux
- **THEN** its structured continuation resolves the same canonical target and configuration
- **AND** changed input bytes or ambiguous path aliases require new review

### Requirement: Repository-only migration preserves full-activation obligations
Selecting repository scope during or after migration SHALL NOT erase historical activation, state-retention or disposal obligations, grant cloud authority, or transform incomplete production phases into success. Repository enforcement and its main hold SHALL be recorded independently from full-activation progress.

#### Scenario: Historical retained state exists
- **WHEN** a migrated project completes only repository enforcement while historical state-retention obligations remain
- **THEN** the original ownership and due-time restrictions remain visible and unchanged
- **AND** no state is used, disposed or declared unnecessary merely because repository scope was selected

#### Scenario: Full activation is requested later
- **WHEN** repository-only enforcement is already verified
- **THEN** full activation requires its own current inputs, qualification and approvals
- **AND** lifting the main hold requires real qualifying evidence and a separately reviewed reconciliation
