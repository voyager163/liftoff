## MODIFIED Requirements

### Requirement: Migrate adopts existing projects through a fresh scaffold
`liftoff migrate <path>` SHALL retain source-preserving sibling-scaffold behavior for supported non-Liftoff sources. It SHALL use the selected workflow's complete staged pipeline, including an explicit no-framework Manual path, and write the current v8 manifest. In-place adoption SHALL use the separate reviewed adopt command and SHALL not weaken sibling migration's new/empty-target or unchanged-source guarantees.

#### Scenario: Migrate produces a compliant scaffold
- **WHEN** a developer completes sibling migration
- **THEN** the fresh target has a valid v8 manifest and selected framework or explicit Manual integration contract

#### Scenario: Source project is untouched
- **WHEN** sibling migration succeeds or fails
- **THEN** the source tree remains byte-identical

#### Scenario: Target directory must be new or empty
- **WHEN** the sibling target is nonempty
- **THEN** migrate refuses even with force

### Requirement: The migration plan is emitted as an executable change
Sibling migration SHALL retain planning-complete OpenSpec output for OpenSpec and an equivalent `MIGRATION.md` checklist for Spec Kit or Manual. Plans SHALL map every inventoried source to an exact target or explicit unresolved placement, order prerequisites and verification before cleanup, and describe actual workflow-specific completion without fictitious archives. These human plans SHALL not supply approval or proof for in-place adoption/repair.

#### Scenario: Emitted change reflects the scan
- **WHEN** Python dependencies, environment files and tests are detected
- **THEN** the plan identifies each actual staged source and its target or unresolved decision

#### Scenario: Emitted change inventories exact GitHub and setup paths
- **WHEN** CODEOWNERS, setup.py or pytest.ini are present
- **THEN** their exact placement decisions are recorded rather than silently dropped

#### Scenario: Non-OpenSpec workflow gets a checklist
- **WHEN** Spec Kit or Manual is selected
- **THEN** the same inventory appears in MIGRATION.md without requiring OpenSpec archive

#### Scenario: Migration is resumable
- **WHEN** application-porting work remains after scaffold creation
- **THEN** the emitted plan identifies remaining work without rerunning sibling generation
- **AND** checked items do not substitute for fresh verification or mutation approval

## ADDED Requirements

### Requirement: In-place adoption preserves compatible applications and Git history
`liftoff adopt` SHALL inspect an explicitly resolved supported non-Liftoff application, present its target standards and finite current plan, and preserve compatible layout/code/history. Necessary moves SHALL include source/destination and import/build/test/container/CI/documentation reference mappings. Unrecognized components or incomplete mappings SHALL remain explicit unresolved scope. Adoption SHALL not commit, switch branches, stash/reset, push, rewrite history, change database data or replace an application with a fresh starter.

#### Scenario: Existing layout is compatible
- **WHEN** supported checks and explicit bindings establish compatibility at current paths
- **THEN** adoption plans only needed metadata/integration changes without canonical-folder moves

#### Scenario: One source move is necessary
- **WHEN** a policy requirement needs a reviewed file relocation
- **THEN** the plan includes exact affected references and verification rather than a recursive folder move

#### Scenario: Existing Liftoff manifest is found
- **WHEN** adopt targets an already managed project
- **THEN** it routes to supported update/repair rather than reinitializing or fabricating provenance

### Requirement: Adoption is an independently verified recoverable transaction
Adoption SHALL bind root, source/destination bytes and modes, plugin/layout/profile/workflow identities, exact effects, checks and expiry. Separate preparation/script/network permissions SHALL precede verification; file approval SHALL follow a visible matching result. Current inputs SHALL be rechecked under the project lock. Recovery SHALL restore only attributable unchanged writes, preserve concurrent edits, report partial effects and block new transactions until recorded recovery is resolved.

#### Scenario: Developer edits during review
- **WHEN** a bound input or destination changes after preview
- **THEN** apply rejects the stale plan before further effects

#### Scenario: Interrupted first adoption has no complete manifest
- **WHEN** adoption stops before manifest publication
- **THEN** its authenticated external transaction record identifies recoverable exact writes
- **AND** absence of the final manifest is not permission to start a second adoption

#### Scenario: Windows project and stage have spaces
- **WHEN** adoption runs on Windows, macOS or Linux
- **THEN** native path handling, case/link/junction checks and literal arguments preserve the exact scoped inventory

### Requirement: Workflow switching preserves existing work and independent consent
The reviewed workflow-set operation SHALL support explicit transitions among OpenSpec, Spec Kit and Manual without rewriting application/Git history or deleting existing framework specifications, archives or unrelated integrations. It SHALL initialize a newly selected external framework through its pinned official staged operation, with separate tool/global-profile permissions, and record Manual as not-required without fake initialization. Active overlapping work or unsupported history SHALL block until explicitly reconciled.

#### Scenario: OpenSpec project selects Manual
- **WHEN** the exact transition is approved
- **THEN** current identity and approved Liftoff integration changes commit while existing OpenSpec documents/history remain preserved
- **AND** future Liftoff work no longer requires that framework

#### Scenario: Manual project selects Spec Kit
- **WHEN** its official framework requirements and separately approved initialization succeed
- **THEN** only validated staged integration/metadata changes commit and the selected default is recorded

#### Scenario: Workflow metadata is edited directly
- **WHEN** desired workflow differs from the recorded identity without a supported approved transition
- **THEN** ordinary update rejects the mismatch and identifies the real workflow preview

### Requirement: Existing deployed infrastructure remains outside first-release adoption writes
Adoption and workflow changes SHALL assess and plan pre-existing Azure resources/state without importing, moving, rewriting or replacing them. Missing local state SHALL not prove undeployed scope. Independent local work can proceed only when its exact effects do not alter protected deployment configuration, state or writer bindings.

#### Scenario: Application is already deployed
- **WHEN** adoption discovers existing deployed resources or unresolved state ownership
- **THEN** those operations remain planning-only with explicit limits
- **AND** no approval of local adoption enables state migration or duplicate cloud provisioning
