## MODIFIED Requirements

### Requirement: Migration eligibility is an explicit contract distinct from execution compatibility
Activation-record migration SHALL use only exact release-owned source-to-target lanes. Supported historical v1, v2 and released v3 families SHALL remain strict source contracts; modernization targets SHALL use v8 and actual advancing profile/workflow-aware activation identities with computed graph hashes. Eligibility SHALL not make historical approvals/evidence executable. Unknown, mixed-active, future, malformed or incomplete sources remain blocked; valid retained history is not mixed active state. Project-edited compatibility metadata cannot create a lane.

#### Scenario: Known v1 has a supported successor
- **WHEN** its complete source contract matches a declared lane
- **THEN** update check identifies the exact current successor without requiring a fabricated intermediate

#### Scenario: Version numbers do not prove compatibility
- **WHEN** individual versions are known but the full tuple/hash is not declared
- **THEN** no apply-eligible migration receipt is issued

#### Scenario: Historical records are incomplete or ad hoc
- **WHEN** required source history is missing or invalid
- **THEN** it remains unchanged and cannot be repaired by force or filling fields from prose

#### Scenario: Current v2 does not need historical migration
- **WHEN** only explicitly permitted same-contract maintenance is requested
- **THEN** CLI version alone does not create a successor or current proof

#### Scenario: Known v2 upgrades to the revised execution contract
- **WHEN** its complete source identity is declared
- **THEN** source records remain byte-preserved and target proof is independently established

#### Scenario: Current v3 needs only core maintenance
- **WHEN** a recorded family receives supported same-contract core maintenance
- **THEN** no duplicate history is created solely for a CLI patch
- **AND** modernization execution still requires an approved declared successor where identity changes

#### Scenario: No activation has started
- **WHEN** no active execution records exist
- **THEN** a supported metadata upgrade does not invent historical execution state

#### Scenario: Activation state is absent but active receipts remain
- **WHEN** evidence or approvals lack required source state
- **THEN** preview reports incomplete history rather than treating the project as clean/not-started

### Requirement: Activation-record upgrade is not OpenTofu-state migration
The successor transaction SHALL change only its exact approved local Liftoff control/history records and finite revalidation. It SHALL not read, move, import or publish application OpenTofu state, mutate providers, change project workflow/profile implicitly or replace application source. Public existing-deployment state migration SHALL remain planning-only; metadata upgrade approval SHALL not enable it.

#### Scenario: Both kinds of migration are needed
- **WHEN** a project needs a control-record successor and deployed-state changes
- **THEN** only the independently approved local successor can execute
- **AND** the deferred deployment/state work remains a separately reported limitation

#### Scenario: Stateful inspection approval is absent
- **WHEN** further mapping would need sensitive state
- **THEN** identity migration does not read it or invent public state-inspection authority

### Requirement: A successor is created by a narrow recoverable local transaction
The current declared successor SHALL require a matching preview and exact approval. Its managed/history/state/manifest/journal inventory SHALL be preflighted and current source protected before writes. Preserve source bytes before retiring exact active originals and link the current target to them. New or changed phases SHALL not inherit verified/approved status from old checkboxes or receipts; unknown applicability stays unknown. A supported local anchor is preserved only through its explicit mapping.

#### Scenario: Migration commits coherently
- **WHEN** the exact approved transaction commits
- **THEN** current target manifest/state/graph/journal agree and preserved historical sources remain separate

#### Scenario: Required target managed files conflict
- **WHEN** required metadata cannot be safely installed
- **THEN** no successor commits while skipping that prerequisite

#### Scenario: Source data changes after approval
- **WHEN** bound inputs or destinations change
- **THEN** the stale transaction is rejected before overwriting newer work

#### Scenario: The process stops during local writes
- **WHEN** the transaction is interrupted before commit
- **THEN** durable recovery handles only its authenticated exact inventory before new work

#### Scenario: Historical remote identifiers are present
- **WHEN** old records name a repository/subscription/resource
- **THEN** they remain historical hints until independently rebound and metadata migration contacts no provider

#### Scenario: The target graph adds or reorders phases
- **WHEN** the current graph changes phase meaning
- **THEN** fresh required proof is obtained rather than matching only an old phase name

### Requirement: Committed migration and revalidation readiness have separate outcomes
Commit SHALL be persisted separately from revalidation. A current successor SHALL remain active and resumable after failed, interrupted or unavailable post-commit checks, with source history intact. Committed-but-incomplete update SHALL return exit 2, not claim full setup/activation or automatically restore an older identity.

#### Scenario: A local check fails after migration
- **WHEN** successor/history commit but a check fails
- **THEN** the result identifies the actual failed work while retaining the committed successor

#### Scenario: Revalidation is interrupted
- **WHEN** execution stops during a check
- **THEN** later inspection reports incomplete work rather than success

#### Scenario: A retry follows repair
- **WHEN** fresh preview and approval authorize remaining work
- **THEN** the same current successor resumes without rewriting completed history

#### Scenario: A previously committed migration is inspected again
- **WHEN** target/history links remain valid
- **THEN** inspection does not offer duplicate successor creation or retirement

### Requirement: Historical records remain separate from current proof across consumers
All consumers SHALL share validated source-history/current-successor relationships for every supported family, including released v3 and modernization targets. Historical presence SHALL not poison valid current progress or become execution proof. Broken links, unsafe paths and contradictory current evidence remain errors; no consumer resets the project or substitutes old success for current proof.

#### Scenario: Valid history coexists with current evidence
- **WHEN** a current target retains valid older snapshots
- **THEN** consumers report history separately and use current proof for readiness

#### Scenario: A declared history link is corrupt
- **WHEN** a link is absent, unsafe or digest-mismatched
- **THEN** the exact failure is reported without fabricated history or unsafe access

#### Scenario: Current evidence is malformed
- **WHEN** active proof is invalid or contradictory
- **THEN** execution remains blocked even if historical records reported success

#### Scenario: Manifest writer differs from activation identity
- **WHEN** last-writing CLI and activation package differ
- **THEN** the exact contract/source records select compatibility, not the CLI label alone

## ADDED Requirements

### Requirement: Modernization successors preserve existing workflow profile and layout intent
Current successors SHALL preserve the selected workflow, agent set, profile and independently established compatible layout unless a separate reviewed transition explicitly changes them. Source snapshots and prior lifecycle obligations SHALL remain byte-preserved and retain original due times. New proof SHALL bind actual current plugin/profile/workflow identities; no old success or consent is translated into a different operation.

#### Scenario: OpenSpec single-maintainer project is upgraded
- **WHEN** its modernization successor is approved
- **THEN** it remains OpenSpec/single-maintainer with preserved application paths and history unless separate transitions were approved

#### Scenario: Retained history is opened on Windows
- **WHEN** original records and current links are read on Windows, macOS or Linux
- **THEN** explicit portable path inventories remain confined and unsafe aliases are rejected
