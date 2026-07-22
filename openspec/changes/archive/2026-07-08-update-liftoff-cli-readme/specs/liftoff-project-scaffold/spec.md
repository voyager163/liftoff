## ADDED Requirements

### Requirement: Packaged README documents generated project structure
The system SHALL document the generated Liftoff project structure in the packaged root `README.md`, including stable top-level folders, conditional folders, and the ownership model for the generated configuration and manifest files.

#### Scenario: Review core project layout
- **WHEN** a developer reads the generated structure documentation
- **THEN** the README identifies the core generated areas for backend APIs and orchestration, database migrations and schema, environment configuration, Docker Compose local development, OpenTofu Azure infrastructure, and spec-driven governance assets

#### Scenario: Review conditional project layout
- **WHEN** a developer reads the generated structure documentation
- **THEN** the README explains that `frontend` is generated only when frontend support is selected, `functions/<worker-name>` is generated only for worker-enabled Azure patterns, and `migration/legacy` appears only in projects created by `liftoff migrate`

#### Scenario: Understand generated file ownership
- **WHEN** a developer reads the generated structure documentation
- **THEN** the README distinguishes `liftoff.config.json` as user-owned desired state from `liftoff.manifest.json` as the CLI-owned manifest v2 record of generated artifacts, logical names, path parts, and content hashes

#### Scenario: Understand path examples as logical structure
- **WHEN** the README displays generated paths such as `backend/apis` or `infrastructure/opentofu/azure`
- **THEN** the documentation presents them as logical project structure while the CLI continues to generate paths using platform-correct filesystem handling on Windows, macOS, and Linux