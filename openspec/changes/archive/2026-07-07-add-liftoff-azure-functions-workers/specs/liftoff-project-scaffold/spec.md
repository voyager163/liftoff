## MODIFIED Requirements

### Requirement: Generated projects use the standard folder layout
The system SHALL place frontend code under `frontend`, backend API code under `backend/apis`, Azure Functions worker code under `functions/<worker-name>`, and database-related artifacts under `database` when those areas are generated.

#### Scenario: Backend-only project layout
- **WHEN** a developer creates a project without a frontend
- **THEN** the generated project includes `backend/apis` and `database` folders and does not include a `frontend` folder

#### Scenario: Frontend project layout
- **WHEN** a developer creates a project with a frontend
- **THEN** the generated project includes a Vue 3/Tailwind frontend under `frontend` in addition to backend and database folders

#### Scenario: Azure Functions worker layout
- **WHEN** a developer creates an Azure project for a GenAI pattern that includes generated worker support
- **THEN** the generated project includes an Azure Functions worker scaffold under `functions/<worker-name>`
- **AND** the worker scaffold includes Function app runtime files, local settings examples, trigger adapter code, tests, and documentation

#### Scenario: Cross-platform layout creation
- **WHEN** the CLI creates the standard folders on Windows, macOS, or Linux
- **THEN** the same logical folders are generated using platform-correct path handling

### Requirement: Generated projects include environment-specific configuration
The system SHALL generate dev, test, and prod environment configuration templates for application runtime, Azure Functions workers, local development, and infrastructure.

#### Scenario: Generate selected environments
- **WHEN** a developer selects dev, test, and prod environments
- **THEN** the generated project includes environment-specific configuration files for all selected environments

#### Scenario: Generate Function worker settings templates
- **WHEN** the generated project includes Azure Functions workers
- **THEN** each selected environment includes Function worker settings templates separate from backend API settings

#### Scenario: Protect secrets
- **WHEN** environment configuration templates are generated
- **THEN** the generated files avoid committed secret values and provide placeholders or secret references instead

## ADDED Requirements

### Requirement: Generated worker-enabled Azure projects include Azure Functions trigger adapters
The system SHALL generate Azure Functions trigger adapter scaffolds for worker-enabled GenAI patterns while keeping reusable GenAI orchestration code under the backend orchestration layer.

#### Scenario: Generate Function worker for worker-enabled pattern
- **WHEN** a developer creates an Azure project for a pattern whose catalog definition includes worker support
- **THEN** the generated project includes a deterministic Azure Functions worker folder under `functions`
- **AND** the generated worker adapter references the selected pattern and its messaging boundary

#### Scenario: Omit Function worker for non-worker pattern
- **WHEN** a developer creates an Azure project for a pattern whose catalog definition does not include worker support
- **THEN** the generated project does not include an Azure Functions worker scaffold

#### Scenario: Track Function worker artifacts in manifest
- **WHEN** Azure Functions worker artifacts are generated
- **THEN** `liftoff.manifest.json` includes each Function artifact using path parts rather than platform-specific path strings

### Requirement: Generated documentation distinguishes backend workers from Azure Functions workers
The system SHALL document that `backend/workers` is for backend-adjacent or containerized worker code and `functions/<worker-name>` is for Azure Functions trigger adapters and Function app runtime files.

#### Scenario: Review generated project documentation
- **WHEN** a developer reads the generated project README or functions documentation
- **THEN** the documentation explains where to place Azure Functions workers and where to place reusable orchestration logic