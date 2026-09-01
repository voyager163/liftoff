## Purpose

Define the permanent ownership boundary between Liftoff's maintained control plane and starter files that become production project assets after generation.

## ADDED Requirements

### Requirement: Every generated artifact has an explicit lifecycle
The system SHALL assign every generated artifact an explicit lifecycle of `managed-core`, `project`, `desired-state`, `framework`, or `seed` through its exact logical artifact declaration. Domain categories, path prefixes, filenames, and content inspection MUST NOT infer lifecycle or update authority.

#### Scenario: Generate an API project
- **WHEN** Liftoff renders an API project
- **THEN** application source, tests, database assets, dependency files, containers, environment files, documentation, and infrastructure topology are declared `project`
- **AND** exact Liftoff control-plane files are declared `managed-core`

#### Scenario: Generate a Power Apps project
- **WHEN** Liftoff renders a packaged Power Apps starter
- **THEN** copied and transformed starter files are declared `project`
- **AND** their immutable upstream provenance does not grant Liftoff post-generation write authority

#### Scenario: Classify configuration files
- **WHEN** generated output contains `liftoff.config.json`, environment examples, runtime configuration source, or infrastructure variables
- **THEN** `liftoff.config.json` is declared `desired-state`
- **AND** every other file receives its explicit lifecycle without inferring authority from the word `config`, its category, or its path

#### Scenario: Render on supported operating systems
- **WHEN** the same plan is rendered on Windows, macOS, and Linux
- **THEN** logical names and lifecycle declarations are identical
- **AND** path parts remain portable while filesystem access uses platform-correct resolution

### Requirement: Managed core is the only post-generation update authority
After initial generation, the system SHALL permit `liftoff update` to create, restore, upgrade, move, or overwrite only artifacts declared `managed-core`. Neither ordinary update nor any force option SHALL mutate an existing `project`, `desired-state`, `framework`, or `seed` file.

#### Scenario: Project source differs from the current starter
- **WHEN** a production source file differs from the template packaged by the running CLI
- **THEN** update does not classify, report, restore, replace, move, or delete that file

#### Scenario: Untouched project file has a newer template
- **WHEN** a project-owned file still matches its generation bytes but the running CLI renders newer bytes
- **THEN** update leaves the file unchanged
- **AND** it does not treat the matching generation hash as overwrite authorization

#### Scenario: Project file was intentionally deleted
- **WHEN** a developer removes or relocates a project-owned artifact
- **THEN** update preserves the absence
- **AND** it does not recreate the old template path

#### Scenario: Force is supplied
- **WHEN** `liftoff update --force` runs in a production project
- **THEN** force extends replacement authority only to conflicted `managed-core` artifacts
- **AND** every project-owned file remains outside the mutation set

#### Scenario: Managed core has safe drift
- **WHEN** an explicitly declared managed-core artifact is new, missing, or untouched since its recorded version
- **THEN** ordinary update reconciles it through the existing guarded transaction

### Requirement: Configuration expansion can provision new project components once
The system SHALL treat an applicable developer edit to `liftoff.config.json` that selects a previously absent frontend or environment as explicit authorization to provision that component's project artifacts once. Provisioning MUST be limited to the newly selected component, MUST preflight every destination, MUST write only absent destinations or adopt byte-identical destinations, and MUST NOT allow `--force` to replace a differing destination. After successful provisioning, those artifacts SHALL be project-owned.

#### Scenario: Enable a previously absent frontend
- **WHEN** configuration changes from no frontend to a frontend and every frontend destination is absent
- **THEN** update transactionally creates the current frontend starter
- **AND** records its files as project-owned provenance rather than managed-core state

#### Scenario: Add an environment
- **WHEN** configuration adds a supported environment not recorded by the manifest
- **THEN** update creates only that environment's absent project artifacts
- **AND** does not reconcile existing environment files

#### Scenario: Provisioning destination contains production bytes
- **WHEN** any destination for a newly selected component contains different bytes
- **THEN** update refuses the component provisioning before writing any of its files
- **AND** `--force` does not authorize replacement

#### Scenario: Remove a configured component
- **WHEN** configuration stops selecting a frontend or environment that was previously provisioned
- **THEN** all component files remain project-owned and untouched
- **AND** update does not classify them as managed-core orphans

### Requirement: Project template evolution requires separate authorization
The system SHALL keep release-driven project template evolution outside `liftoff update`, including application changes, dependency and lock refreshes, container changes, database changes, Power Apps starter transitions, and infrastructure topology changes. Adopting those changes into an existing project MUST use a separately reviewed migration process that is not implied by installing or updating the CLI.

#### Scenario: Supported stack baseline changes
- **WHEN** a newer Liftoff release packages different dependencies, lockfiles, images, or provider constraints
- **THEN** ordinary update and update check do not write or report those project-owned template differences

#### Scenario: Power Apps starter advances
- **WHEN** a newer Liftoff release packages a newer verified Microsoft starter
- **THEN** an existing Power Apps project remains on its recorded project-owned source
- **AND** ordinary update does not transition its application files or source identity

### Requirement: Legacy production ownership is released safely
When a supported legacy manifest records broad durable artifact ownership, the system SHALL map each known logical artifact through the current explicit lifecycle declaration, retain only managed-core write authority, and preserve all other entries as project provenance. Unknown legacy logical names SHALL default to project-owned provenance. This ownership migration MUST NOT write, restore, move, or delete project files.

#### Scenario: Legacy manifest records deleted infrastructure
- **WHEN** a legacy manifest owns an infrastructure file that the production project intentionally removed
- **THEN** migration records project provenance without recreating the file

#### Scenario: Legacy manifest records modified source
- **WHEN** a legacy manifest owns an application file that now contains production code
- **THEN** migration releases the file from update authority without changing its bytes

#### Scenario: Legacy manifest contains an unknown logical name
- **WHEN** the current CLI cannot match a legacy artifact to an explicit managed-core declaration
- **THEN** it preserves the artifact as project-owned provenance
- **AND** no update mode may mutate its path
