## MODIFIED Requirements

### Requirement: Configuration edits are a reconciled drift axis
The system SHALL treat `liftoff.config.json` as user-owned desired state that the CLI never rewrites after generation and SHALL reconcile only configuration fields applicable to the recorded workload. For API workloads, newly listed environments or an enabled frontend yield new artifacts and removed selections yield orphans. For Power Apps workloads, a changed optional Code Apps plugin preference updates workload guidance and diagnostics intent without creating API artifacts.

#### Scenario: API environment added to config
- **WHEN** a developer adds an environment to an API workload's `liftoff.config.json` and runs `liftoff update --apply`
- **THEN** the environment's configuration artifacts are generated and recorded in the manifest

#### Scenario: API environment removed from config
- **WHEN** a developer removes an environment from an API workload's `liftoff.config.json` and runs `liftoff update`
- **THEN** that environment's artifacts are reported as orphans and left on disk

#### Scenario: Power Apps plugin preference changes
- **WHEN** a developer changes the valid Code Apps plugin preference in a Power Apps configuration and runs update
- **THEN** update reconciles named generated guidance and records the new preference after a successful apply
- **AND** it does not add backend, cloud, Docker, or infrastructure artifacts

#### Scenario: Power Apps rejects API configuration drift
- **WHEN** a Power Apps configuration adds an API stack, pattern, cloud, region, frontend, or API environment field
- **THEN** update exits 1 before rendering or writing and identifies the inapplicable field

### Requirement: Update refuses unsafe reconciliations
The system SHALL refuse to run when configured workload kind or immutable workload identity differs from the corresponding normalized identity recorded by the manifest, directing the developer to a supported migration or fresh initialization. For API workloads it SHALL continue refusing API-stack or GenAI-pattern changes. For Power Apps it SHALL refuse starter repository, template path, or commit changes outside a Liftoff release-driven template upgrade. The system SHALL also refuse when the manifest's `liftoffVersion` is newer than the running CLI, using semver-aware comparison that orders prerelease versions correctly and directing the developer to upgrade the CLI.

#### Scenario: Workload-kind change is refused
- **WHEN** a developer changes a generated project's configured type among GenAI, standard, and Power Apps and runs `liftoff update`
- **THEN** the command fails with a message that workload changes require migration or fresh initialization

#### Scenario: API-stack change is refused
- **WHEN** a developer changes a standard project's configured API stack and runs `liftoff update`
- **THEN** the command fails with a message that API-stack changes require a migration

#### Scenario: Pattern change is refused
- **WHEN** a developer changes a GenAI project's configured pattern and runs `liftoff update`
- **THEN** the command fails with a message that pattern changes require a migration

#### Scenario: User-supplied starter source change is refused
- **WHEN** a Power Apps configuration or manifest is manually changed to a different repository, path, or commit
- **THEN** update fails before artifact access with guidance to restore the manifest or use a matching Liftoff version

#### Scenario: Legacy identity is compared after normalization
- **WHEN** a legacy manifest omits project type and API stack but records a GenAI pattern matching the configuration
- **THEN** update treats the identity as GenAI with Python/FastAPI and continues normal reconciliation

#### Scenario: Newer-generated project is refused
- **WHEN** the manifest records a `liftoffVersion` greater than the running CLI version
- **THEN** the command fails with a message to upgrade the CLI first

## ADDED Requirements

### Requirement: Update reconciles packaged Power Apps starter artifacts
The system SHALL re-render Power Apps projects from the immutable starter snapshot packaged with the running Liftoff version and join those files to manifest entries by explicit logical name. Newer Liftoff releases MAY offer an upstream starter refresh as ordinary new, upgrade, moved, conflict, or orphan states, and SHALL apply the existing content-hash and force rules without fetching upstream source at update time.

#### Scenario: Current starter is clean
- **WHEN** a Power Apps project matches the running Liftoff release's packaged starter and generated guidance
- **THEN** `liftoff update` reports no drift and exits 0

#### Scenario: Untouched starter file has an available upgrade
- **WHEN** the running Liftoff release contains a changed pinned starter file and the project's recorded file remains unmodified
- **THEN** update classifies the named artifact as an upgrade

#### Scenario: Developer-edited starter file conflicts
- **WHEN** both the packaged starter artifact and the developer's recorded file changed
- **THEN** update classifies the artifact as a conflict and leaves it untouched without `--apply --force`

#### Scenario: Update is offline from upstream
- **WHEN** a developer checks or applies Power Apps updates without access to GitHub
- **THEN** reconciliation uses only the packaged source catalog and completes without contacting the upstream repository

### Requirement: Update normalizes old manifests before writing schema v4
The system SHALL normalize supported v2 and v3 manifests into the internal GenAI or standard workload union before reconciliation. A successful apply SHALL write schema v4 with fresh hashes for written artifacts while preserving skipped-conflict hashes and legacy framework uncertainty.

#### Scenario: Check a v3 project without rewriting
- **WHEN** a developer runs `liftoff update` without `--apply` in a valid v3 project
- **THEN** update performs normalized reconciliation and leaves the v3 manifest byte-for-byte unchanged

#### Scenario: Apply upgrades a v3 project manifest
- **WHEN** a developer runs `liftoff update --apply` in a valid v3 project and apply completes successfully
- **THEN** update writes schema v4 with equivalent normalized workload, framework, and agent identity

#### Scenario: Legacy framework state remains uncertain
- **WHEN** a v2 manifest without official framework metadata is rewritten to v4
- **THEN** the new manifest records legacy framework state without fabricating selected-agent integrations
