## ADDED Requirements

### Requirement: Interactive update discloses impact and obtains tiered consent
When an update invocation uses human output with interactive input and output, has no explicit apply flag, and detects actionable drift, the system SHALL show an impact summary before mutation and SHALL collect every required permission before preflight or filesystem writes. The impact summary SHALL identify the safe create, restore, replace, move, and recorded-state actions; the number of local or user-owned conflicts at risk; managed old paths removed by moves; orphans preserved; manifest refresh; affected dependency-definition artifacts; and that update neither installs dependencies nor retains a recovery copy after a successful overwrite. Safe reconciliation and conflict overwrite SHALL use separate default-No permissions, and displayed paths SHALL remain portable project-relative paths on Windows, macOS, and Linux.

#### Scenario: Safe template updates are explained and accepted
- **WHEN** an interactive developer runs `liftoff update` with two untouched generated dependency files whose templates changed
- **THEN** Liftoff reports two safe replacements, zero developer edits lost, the affected dependency-definition paths, manifest refresh, no dependency installation, and no orphan deletion
- **AND** it asks once, defaulting to No, whether to apply the safe updates in the same invocation
- **AND** answering Yes applies them through the normal transactional update path

#### Scenario: Safe update is declined
- **WHEN** an interactive developer declines the safe-update question or accepts its default No
- **THEN** Liftoff reports that no project files changed, performs no preflight or mutation, and exits 2 because drift remains

#### Scenario: Conflicts require separate overwrite consent
- **WHEN** actionable drift contains safe changes and one or more locally modified or user-owned conflicts
- **THEN** permission to apply safe changes does not authorize any conflict replacement
- **AND** Liftoff lists every at-risk conflict path in stable order, warns that successful replacement has no retained Liftoff backup, and separately asks whether to overwrite them with a default of No

#### Scenario: Conflict overwrite is declined after safe consent
- **WHEN** a developer accepts safe changes and declines conflict overwrite
- **THEN** Liftoff applies the safe subset in one transaction, preserves every conflict, and reports each conflict as skipped

#### Scenario: Conflict overwrite is accepted
- **WHEN** a developer explicitly accepts the separate conflict-overwrite question
- **THEN** Liftoff applies the safe and conflicted authorized actions in one transaction using the same guards as `--apply --force`

#### Scenario: Conflict-only drift is reviewed
- **WHEN** an interactive update has conflicts but no safe write or recorded-state action
- **THEN** Liftoff skips the safe-update question and presents the conflict impact and overwrite question directly
- **AND** declining performs no mutation and exits 2

#### Scenario: Orphan-only drift does not prompt
- **WHEN** the only drift consists of orphaned artifacts
- **THEN** Liftoff reports that the orphans remain untouched, does not request apply or overwrite consent, writes nothing, and exits 2

#### Scenario: Cancellation before authorization is mutation-free
- **WHEN** interactive input closes or is cancelled before all required update decisions are collected
- **THEN** Liftoff reports cancellation and leaves every project file byte-for-byte unchanged

#### Scenario: Reviewed state changes before execution
- **WHEN** a reviewed source, destination, configuration, or manifest path changes while update consent is pending
- **THEN** Liftoff aborts before overwriting or deleting any project path and requires the developer to review the current state again
- **AND** the guard applies to accepted actions that need no content write, including matching move destinations and recorded-state-only refreshes

#### Scenario: Dirty worktree warning precedes consent
- **WHEN** an interactive update can write and the project Git worktree has uncommitted changes
- **THEN** Liftoff advises committing local work before it displays the impact and requests permission

#### Scenario: Windows impact paths remain portable
- **WHEN** interactive update impact is displayed on Windows
- **THEN** every affected and at-risk file is identified by the same portable project-relative path semantics used on macOS and Linux
- **AND** filesystem preflight and mutation use platform-correct path resolution

## MODIFIED Requirements

### Requirement: Update reconciles a generated project against a fresh render
The system SHALL provide a `liftoff update` command that loads `liftoff.config.json` as desired state, renders all artifacts with the current CLI templates, joins the render against `liftoff.manifest.json` on `logicalName`, and classifies every artifact into exactly one of: unchanged, new, missing, upgrade, conflict, moved, or orphan. An invocation that is not applying and uses JSON output or lacks interactive input or output SHALL run as a read-only check, SHALL print each non-unchanged artifact with its state and a one-line reason, and SHALL exit 0 when no drift exists and 2 when drift exists. A human interactive invocation without `--apply` SHALL remain read-only until the developer grants the applicable interactive permissions and SHALL enter the existing apply path only after consent.

#### Scenario: Clean project reports no drift
- **WHEN** a developer runs `liftoff update` in a freshly generated project with the generating CLI version
- **THEN** the command reports no drift, requests no consent, and exits 0 without writing any file

#### Scenario: Drift report classifies artifacts
- **WHEN** update checks a project where the templates have evolved and one generated file was edited by the developer
- **THEN** the report lists template-changed untouched files as upgrades and the edited file as a conflict
- **AND** a non-interactive check or declined interactive update exits 2 without writing any file

#### Scenario: User modification is detected by hash
- **WHEN** a generated file's content hash differs from the `contentHash` recorded in the manifest
- **THEN** update treats the file as user-modified and never classifies it as a safe upgrade

#### Scenario: Moved artifact is detected by logical name
- **WHEN** the current templates emit an artifact whose `logicalName` exists in the manifest under different path parts
- **THEN** update classifies it as moved and reports the old and new locations

#### Scenario: Redirected update remains a check
- **WHEN** `liftoff update` has redirected input or output and no explicit apply flag
- **THEN** it never requests input, writes nothing, emits the existing apply command guidance for actionable drift, and exits 2

### Requirement: Force extends apply to conflicted files
The system SHALL accept the `--force` flag only together with `--apply` and SHALL overwrite conflicted files with the template version when explicitly forced. A separate interactive conflict-overwrite permission MAY authorize the same validated conflict replacements without requiring a second command. Both authorization forms SHALL identify exactly which files can be overwritten, SHALL preserve every unlisted or unapproved conflict, and SHALL print a commit-first hint when the project is a Git repository with uncommitted changes.

#### Scenario: Force overwrites conflicts
- **WHEN** a developer runs `liftoff update --apply --force` in a project with a conflicted file
- **THEN** the conflicted file is overwritten with the current template rendering without an interactive prompt

#### Scenario: Interactive consent overwrites conflicts
- **WHEN** a developer accepts the separate interactive overwrite question for the reported conflict set
- **THEN** those validated conflicted files are overwritten with the current template rendering

#### Scenario: Force without apply is rejected
- **WHEN** a developer runs `liftoff update --force` without `--apply`
- **THEN** the command fails with a message explaining that the flag requires `--apply`

#### Scenario: Dirty worktree hint
- **WHEN** a developer is asked to authorize or explicitly applies updates in a Git repository with uncommitted changes
- **THEN** the command prints a hint to commit before applying and proceeds only according to the selected consent

### Requirement: Update reconciles packaged Power Apps starter artifacts
The system SHALL re-render Power Apps projects from the immutable starter snapshot packaged with the running Liftoff version and join those files to manifest entries by explicit logical name. Newer Liftoff releases MAY offer an upstream starter refresh as ordinary new, upgrade, moved, conflict, or orphan states, and SHALL apply the existing content-hash, explicit apply, interactive consent, and force rules without fetching upstream source at update time.

#### Scenario: Current starter is clean
- **WHEN** a Power Apps project matches the running Liftoff release's packaged starter and generated guidance
- **THEN** `liftoff update` reports no drift and exits 0

#### Scenario: Untouched starter file has an available upgrade
- **WHEN** the running Liftoff release contains a changed pinned starter file and the project's recorded file remains unmodified
- **THEN** update classifies the named artifact as an upgrade

#### Scenario: Developer-edited starter file conflicts
- **WHEN** both the packaged starter artifact and the developer's recorded file changed
- **THEN** update classifies the artifact as a conflict and leaves it untouched without `--apply --force` or separate interactive conflict-overwrite consent

#### Scenario: Update is offline from upstream
- **WHEN** a developer checks or applies Power Apps updates without access to GitHub
- **THEN** reconciliation uses only the packaged source catalog and completes without contacting the upstream repository
