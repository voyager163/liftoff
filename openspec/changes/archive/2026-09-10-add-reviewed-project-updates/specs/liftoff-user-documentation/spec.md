## MODIFIED Requirements

### Requirement: Update guidance uses the imperative command matrix
Public, packaged, generated-project, troubleshooting, safety, and existing-repository documentation SHALL present `liftoff update --check` as the primary human compatibility/migration preview, followed by `liftoff update` with explicit approval. It SHALL explain that project bytes remain unchanged during check while a disclosed user-local preview receipt is saved outside the repository. JSON SHALL be optional output formatting, and noninteractive apply SHALL require the exact plan fingerprint. Force SHALL remain limited, separately previewed, and unable to bypass receipt, approval, compatibility, or ownership guards. Removed `--apply` SHALL not be recommended.

#### Scenario: Developer wants to update a project
- **WHEN** update guidance is read
- **THEN** it starts with `liftoff update --check` and explains the matching-preview and explicit-approval requirement before apply

#### Scenario: Automation wants a drift gate
- **WHEN** automation needs a structured preview
- **THEN** guidance uses `liftoff update --check --json` and documents external receipt persistence, schema 3, and exit 0/1/2 meanings

#### Scenario: Developer reviews conflict overwrite
- **WHEN** an owned core conflict needs replacement
- **THEN** guidance requires reviewing the check's exact force variant and approving that fingerprint for `update --force`
- **AND** it states that project files and unowned/provisioning collisions remain protected

#### Scenario: Existing apply syntax is encountered
- **WHEN** old instructions use `liftoff update --apply`
- **THEN** migration guidance explains the removed flag and the current check-then-approved-update sequence

#### Scenario: A check is absent or stale
- **WHEN** a user encounters a missing/stale preview message
- **THEN** documentation directs them to rerun check rather than force, edit a receipt, or suppress compatibility

### Requirement: Documentation distinguishes CLI upgrade from core update
Maintenance guidance SHALL describe `liftoff upgrade` as replacement of the supported global CLI installation and `liftoff update` as reviewed maintenance for one generated project, including only explicitly supported activation migrations. Neither command SHALL be presented as upgrading production application templates. The existing `liftoff migrate` command SHALL retain its distinct source-preserving non-Liftoff adoption role.

#### Scenario: Developer wants the newest CLI
- **WHEN** installation or maintenance guidance is read
- **THEN** it retains upgrade check/apply and exact manual installation fallbacks

#### Scenario: Developer wants core template updates
- **WHEN** a project needs newer Liftoff control-plane files
- **THEN** guidance uses update check followed by exact approval and apply
- **AND** it explains that CLI installation itself did not migrate the project

#### Scenario: Developer wants project template changes
- **WHEN** a user needs new starter source, dependencies, containers, database assets, or infrastructure
- **THEN** guidance requires separately reviewed project migration rather than ordinary update or force

### Requirement: Documentation explains template ownership
Documentation SHALL retain the managed-core, project, desired-state, framework, and seed lifecycles and explain that filenames/categories do not grant ownership. It SHALL describe the narrow separately approved activation-history/successor write set without making history, existing production files, or an entire governance directory managed core. Project generation provenance and intentionally modified/deleted production files SHALL remain protected.

#### Scenario: Existing project upgrades to the ownership-aware manifest
- **WHEN** legacy ownership migration is documented
- **THEN** non-core assets are released to project ownership without restoring or replacing them

#### Scenario: Developer sees a file named config
- **WHEN** configuration examples are read
- **THEN** desired state, runtime files, and maintained core are distinguished by explicit contract

#### Scenario: Developer considers force
- **WHEN** force is documented
- **THEN** its exact eligible core boundary is explained and production/history replacement is excluded

#### Scenario: Developer preserves activation history
- **WHEN** v1 migration is documented
- **THEN** the exact history inventory and successor/journal authority are distinguished from normal template reconciliation

### Requirement: Documentation distinguishes assessment from update and activation
Guidance SHALL retain local-only and explicitly scoped live assessment for supported and ordinary Git repositories, installed targets, comparison layers, coverage/classifications, provenance, and exit codes. Assessment SHALL remain distinct from migration, activation, and remediation authority. Supported historical migration SHALL be described accurately through update check; unsupported lanes SHALL remain named limitations rather than invented commands or receipt edits.

#### Scenario: Developer wants to see differences
- **WHEN** assessment guidance is read
- **THEN** target, baseline, declarations, and observed enforcement remain separately explained

#### Scenario: Developer does not want network access
- **WHEN** the default assessment example is followed
- **THEN** it is local-only, credential-free, and telemetry/disclosure-excluded, including help

#### Scenario: Developer requests live assessment
- **WHEN** live mode is described
- **THEN** bounded existing-permission reads and the no-mutation boundary remain explicit
- **AND** unavailable reads are not called absence or alignment

#### Scenario: Assessment is partial or excepted
- **WHEN** coverage is incomplete or an exception is accepted
- **THEN** exit 2 is explained without claiming full alignment or permission to repair

#### Scenario: Upgrade is blocked by compatibility
- **WHEN** historical activation appears in an assessment
- **THEN** guidance distinguishes a supported migration preview from an actually unavailable lane
- **AND** neither force nor edited receipts are offered as compatibility bypasses

#### Scenario: Developer installs a newer assessment integration
- **WHEN** a supported project needs an assessment integration
- **THEN** guidance uses the reviewed core update flow without implying that installation activates governance
- **AND** ordinary Git repositories can continue using the CLI directly

#### Scenario: Maintainer extends policy assessment coverage
- **WHEN** contributor guidance describes new evaluators
- **THEN** stable IDs, explicit proof/support limits, deterministic no-write cases, and cross-platform safety remain required without a new assessment-skill version

#### Scenario: Developer assesses Liftoff's source repository
- **WHEN** a repository has no Liftoff manifest
- **THEN** guidance uses ordinary read-only assessment with the installed policy target and honest missing-proof findings

#### Scenario: Manifest is retired or damaged
- **WHEN** a manifest is retired, malformed, or unsafe
- **THEN** guidance preserves the error boundary rather than hiding it to force fallback

## ADDED Requirements

### Requirement: Migration guidance explains preservation and resumable partial outcomes
Documentation SHALL describe the compatibility/preview/approval/history/successor/revalidation/resume sequence, exact source support, in-project historical storage, and the separate external preview receipt. It SHALL distinguish pre-commit transaction recovery from post-commit revalidation failure, explain that committed v2 remains blocked/resumable after failure, and prohibit manual version retagging, historical approval reuse, automatic v1 restoration, or live-resource recreation. It SHALL identify unavailable producers and separate provider authority honestly.

#### Scenario: A user migrates known v1
- **WHEN** the migration walkthrough is followed
- **THEN** it explains the readable preview, explicit approval, preserved bytes, linked v2, and fresh-proof requirements
- **AND** it does not require a separate activation-migration command

#### Scenario: A check fails after local commit
- **WHEN** troubleshooting describes committed migration with failed revalidation
- **THEN** it directs the user to repair the named blocker, obtain a fresh preview, and approve remaining work
- **AND** it explains exit 2 and retained v2 progress without suggesting a reset

#### Scenario: CI applies an update
- **WHEN** automation guidance is read
- **THEN** it shows a matching preview and `--approve-plan <fingerprint>` in the same materialized checkout/user-local storage context
- **AND** it states that a changed workspace or plan requires a fresh check and approval, not a portable blanket authorization

#### Scenario: A project moves to another machine
- **WHEN** history/receipt portability is explained
- **THEN** history travels inside the project but local preview receipts do not
- **AND** Windows, macOS, and Linux storage and path behavior are documented without assuming a shared home-directory layout

#### Scenario: Local validation runs project-controlled commands
- **WHEN** validation safety is described
- **THEN** the exact approved commands and known effects are disclosed
- **AND** documentation does not claim a sandbox or authorize rollback of unexpected user-owned edits
