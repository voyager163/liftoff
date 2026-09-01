## MODIFIED Requirements

### Requirement: Update guidance uses the imperative command matrix
The system SHALL document `liftoff update` as an imperative managed-core reconciliation command, `liftoff update --force` as explicit managed-core conflict overwrite, `liftoff update --check` as the read-only core check, and `liftoff update --check --json` as the read-only machine check. Public, packaged, generated-project, troubleshooting, safety, and existing-repository guidance SHALL state that project-owned production files remain outside every update mode and SHALL NOT instruct users to run the removed `--apply` flag.

#### Scenario: Developer wants to update a project
- **WHEN** a developer reads update guidance
- **THEN** the primary command is plain `liftoff update`
- **AND** the guidance explains that only safe managed-core changes apply immediately

#### Scenario: Automation wants a drift gate
- **WHEN** automation needs a read-only result
- **THEN** guidance uses `liftoff update --check --json`
- **AND** it documents exit code 0 for clean core state and 2 for actionable core or provisioning drift

#### Scenario: Developer reviews conflict overwrite
- **WHEN** a developer needs to replace a locally modified managed-core file
- **THEN** guidance requires reviewing `liftoff update --check` output before running `liftoff update --force`
- **AND** states that force cannot overwrite project-owned files or provisioning collisions

#### Scenario: Existing apply syntax is encountered
- **WHEN** a user follows old guidance or a script containing `liftoff update --apply`
- **THEN** current migration guidance states that `--apply` was removed and maps it to plain `liftoff update`

### Requirement: Documentation identifies the tested supported-stack baseline
The system SHALL publish the current runtime and framework release lines, frozen dependency commands, immutable-source rules, and baseline refresh policy in packaged user and contributor documentation. Version statements in getting-started, prerequisites, workloads, CLI, generated-project, maintenance, and contributor guidance SHALL agree with the release-owned baseline. Documentation SHALL distinguish the baseline used for newly generated projects from separately reviewed adoption into an existing production project.

#### Scenario: Developer checks prerequisites
- **WHEN** a developer reads the prerequisites for a selected workload
- **THEN** the guide identifies only the applicable Node.js, Python, Go, `uv`, OpenTofu, OpenSpec, or Spec Kit constraints
- **AND** the values match the current baseline

#### Scenario: Developer installs Python dependencies
- **WHEN** generated or packaged documentation describes Python setup
- **THEN** it uses the platform-appropriate frozen `uv` synchronization flow
- **AND** it does not instruct the developer to regenerate a lock or install from open-ended ranges

#### Scenario: Existing project reviews a major baseline
- **WHEN** release notes describe a new major generated-stack baseline
- **THEN** they identify raised runtime floors and application compatibility changes as project migrations
- **AND** do not direct the developer to ordinary update or force to replace production dependencies, containers, or infrastructure

### Requirement: Documentation distinguishes CLI upgrade from core update
Packaged README, getting-started, CLI-reference, maintenance, troubleshooting, and generated-project guidance SHALL describe `liftoff upgrade` as replacement of the supported global CLI installation and `liftoff update` as managed-core maintenance for one generated project. No guide SHALL imply that either command upgrades production application templates.

#### Scenario: Developer wants the newest CLI
- **WHEN** a developer reads installation or maintenance guidance
- **THEN** it presents `liftoff upgrade --check` followed by `liftoff upgrade`
- **AND** retains the exact manual global npm command for first installation and unsupported origins

#### Scenario: Developer wants core template updates
- **WHEN** a developer wants an existing project to adopt current Liftoff control-plane files
- **THEN** documentation directs them to inspect `liftoff update --check` and then run `liftoff update`
- **AND** states that CLI self-upgrade did not modify the project

#### Scenario: Developer wants project template changes
- **WHEN** a developer wants newer starter source, dependencies, containers, database assets, environments, or infrastructure
- **THEN** documentation states that ordinary update and force cannot perform that adoption
- **AND** requires a separately reviewed project migration

## ADDED Requirements

### Requirement: Documentation explains template ownership
The system SHALL document the `managed-core`, `project`, `desired-state`, `framework`, and `seed` lifecycle classes with representative files and exact update authority. It SHALL explain that categories and filenames do not determine ownership, that project files become production assets after generation, and that legacy manifests are migrated without rewriting those assets.

#### Scenario: Existing project upgrades to the ownership-aware manifest
- **WHEN** a developer reads migration guidance for a pre-v6 project
- **THEN** the guidance states that non-core artifacts are released to project ownership
- **AND** intentionally deleted or modified project files remain untouched

#### Scenario: Developer sees a file named config
- **WHEN** documentation gives configuration examples
- **THEN** it distinguishes developer-owned desired state, project runtime configuration, and Liftoff managed core
- **AND** does not imply that a filename or category grants overwrite authority

#### Scenario: Developer considers force
- **WHEN** documentation explains `liftoff update --force`
- **THEN** it identifies the exact managed-core boundary
- **AND** states that force can never replace project source, dependencies, schemas, containers, environments, documentation, or infrastructure
