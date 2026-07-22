## ADDED Requirements

### Requirement: Generated projects include Azure-complete OpenTofu infrastructure
The system SHALL generate OpenTofu infrastructure artifacts for Azure Container Apps, Azure Database for PostgreSQL, Azure Redis Cache, Azure Blob Storage, Azure Service Bus, Azure Communication Services, Azure Container Registry, Key Vault, and supporting configuration for selected environments.

#### Scenario: Generate Azure infrastructure
- **WHEN** a developer creates a project with Azure as the target cloud
- **THEN** the generated project includes Azure OpenTofu files, environment tfvars, provider configuration, outputs, and documented usage commands

#### Scenario: Use default Azure region
- **WHEN** the developer does not choose a different Azure region
- **THEN** the generated OpenTofu environment configuration uses East US with the slug `eastus`

### Requirement: Generated infrastructure uses OpenTofu environment configuration
The system SHALL generate dev, test, and prod OpenTofu environment configuration using explicit files rather than implicit pattern matching.

#### Scenario: Generate environment tfvars
- **WHEN** a developer selects dev, test, and prod environments
- **THEN** the generated infrastructure includes explicit `dev.tfvars`, `test.tfvars`, and `prod.tfvars` files or equivalent explicitly tracked environment files

#### Scenario: Cross-platform infrastructure paths
- **WHEN** infrastructure files are generated on Windows, macOS, or Linux
- **THEN** the same logical OpenTofu structure is created using platform-correct path handling

### Requirement: Generated infrastructure includes state guidance
The system SHALL generate local OpenTofu state configuration by default and include documented remote-state guidance or example configuration.

#### Scenario: Local state default
- **WHEN** Azure OpenTofu infrastructure is generated
- **THEN** the generated infrastructure can be initialized with local state by default

#### Scenario: Remote state example
- **WHEN** a developer reviews the generated infrastructure documentation
- **THEN** the documentation explains how to configure remote OpenTofu state for team environments

### Requirement: Generated infrastructure protects secrets
The system SHALL provision or configure Azure Key Vault references for cloud secrets and SHALL avoid writing secret values into generated configuration files.

#### Scenario: Key Vault generated
- **WHEN** Azure infrastructure is generated
- **THEN** the generated OpenTofu includes Key Vault configuration or module output suitable for application secret references

#### Scenario: No committed cloud secrets
- **WHEN** Liftoff writes environment and infrastructure files
- **THEN** generated files contain placeholders, variable references, or secret references instead of concrete secret values

### Requirement: Generated infrastructure models planned providers
The system SHALL include provider adapter metadata for AWS and GCP without generating deployable AWS or GCP infrastructure in V1.

#### Scenario: Planned provider catalog
- **WHEN** a developer runs `liftoff providers`
- **THEN** the system lists Azure as available and AWS/GCP as planned provider adapters

#### Scenario: No fake planned-provider IaC
- **WHEN** a developer creates an Azure V1 project
- **THEN** the generated infrastructure does not include deployable AWS or GCP OpenTofu files

### Requirement: Generated projects include spec-driven governance assets
The system SHALL ask the developer to choose OpenSpec or Spec Kit as the spec-driven development workflow and SHALL default the selection to OpenSpec.

#### Scenario: OpenSpec selected
- **WHEN** a developer selects OpenSpec or accepts the default spec workflow
- **THEN** the generated project includes `openspec/config.yaml`, OpenSpec directory structure, and an initial seed change describing the generated application baseline

#### Scenario: Spec Kit selected
- **WHEN** a developer selects Spec Kit
- **THEN** the generated project includes a Spec Kit constitution and supporting template structure based on the generated stack and folder layout

### Requirement: Generated governance reflects selected stack
The system SHALL tailor generated governance content to the selected pattern, cloud provider, frontend choice, environments, and approved stack.

#### Scenario: Governance mentions approved stack
- **WHEN** governance files are generated
- **THEN** they identify FastAPI, PydanticAI, Scalar, OpenTofu, Docker Compose, PostgreSQL, Redis, Langfuse, Alembic, and the selected spec workflow as project standards

#### Scenario: Governance mentions frontend only when selected
- **WHEN** governance files are generated for a backend-only project
- **THEN** frontend folder rules are not presented as required generated output

#### Scenario: Governance includes path rules
- **WHEN** generated governance references project structure
- **THEN** it describes frontend, backend, database, infrastructure, and environment locations by explicit folder names

### Requirement: Generated project includes infrastructure helper documentation
The system SHALL document how developers can initialize, plan, apply, and inspect generated OpenTofu infrastructure through Liftoff helper commands or direct OpenTofu commands.

#### Scenario: Infrastructure command documentation
- **WHEN** Azure infrastructure is generated
- **THEN** the generated README or infrastructure documentation includes commands for init, plan, apply, and output operations for each selected environment