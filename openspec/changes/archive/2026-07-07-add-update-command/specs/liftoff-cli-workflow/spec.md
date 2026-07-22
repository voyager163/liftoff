# liftoff-cli-workflow (delta)

## MODIFIED Requirements

### Requirement: CLI exposes discovery and validation commands
The system SHALL expose commands for project creation, planning, project update, pattern discovery, provider discovery, region discovery, validation, local development helpers, infrastructure helpers, and environment diagnostics.

#### Scenario: List supported patterns
- **WHEN** a developer runs `liftoff patterns`
- **THEN** the system lists all eight GenAI patterns and their V1 scaffold status

#### Scenario: Search regions
- **WHEN** a developer runs `liftoff regions search korea --cloud azure`
- **THEN** the system lists matching Azure regions with display names and slugs

#### Scenario: Run diagnostics
- **WHEN** a developer runs `liftoff doctor`
- **THEN** the system reports local readiness for required tools such as Node.js, Docker, and OpenTofu without modifying the project

#### Scenario: Check a project for drift
- **WHEN** a developer runs `liftoff update` inside a generated project
- **THEN** the system reports scaffold drift between the project and the current CLI templates without writing files
