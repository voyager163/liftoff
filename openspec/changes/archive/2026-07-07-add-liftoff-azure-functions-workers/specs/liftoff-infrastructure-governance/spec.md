## MODIFIED Requirements

### Requirement: Generated projects include Azure-complete OpenTofu infrastructure
The system SHALL generate OpenTofu infrastructure artifacts for Azure Container Apps, Azure Functions hosting, Azure Database for PostgreSQL, Azure Redis Cache, Azure Blob Storage, Azure Service Bus, Azure Communication Services, Azure Container Registry, Key Vault, and supporting configuration for selected environments.

#### Scenario: Generate Azure infrastructure
- **WHEN** a developer creates a project with Azure as the target cloud
- **THEN** the generated project includes Azure OpenTofu files, environment tfvars, provider configuration, outputs, and documented usage commands

#### Scenario: Generate Azure Functions infrastructure
- **WHEN** a developer creates an Azure project that includes Azure Functions workers
- **THEN** the generated Azure OpenTofu files include Function app hosting, required storage, managed identity wiring, app settings, and worker-related outputs

#### Scenario: Use default Azure region
- **WHEN** the developer does not choose a different Azure region
- **THEN** the generated OpenTofu environment configuration uses East US with the slug `eastus`

## ADDED Requirements

### Requirement: Generated infrastructure keeps Function worker configuration environment-specific
The system SHALL configure Azure Functions worker infrastructure through selected-environment OpenTofu inputs and generated environment templates instead of hardcoded values.

#### Scenario: Generate Function worker environment inputs
- **WHEN** Azure Functions worker infrastructure is generated for selected environments
- **THEN** each selected environment has explicit Function worker configuration inputs in the generated infrastructure or environment templates

#### Scenario: Protect Function worker secrets
- **WHEN** Function worker app settings or infrastructure variables are generated
- **THEN** secrets are represented as placeholders, variable references, managed identity access, or Key Vault references rather than committed secret values

### Requirement: Generated governance reflects Azure Functions worker layout
The system SHALL tailor generated OpenSpec or Spec Kit governance content to include the `functions` folder when Azure Functions workers are generated.

#### Scenario: Governance mentions generated Function workers
- **WHEN** governance files are generated for a worker-enabled Azure project
- **THEN** they describe the `functions/<worker-name>` layout, its relationship to backend orchestration, and the Azure Functions runtime boundary

#### Scenario: Governance omits Function worker requirement when not generated
- **WHEN** governance files are generated for a project without Azure Functions workers
- **THEN** they do not present `functions/<worker-name>` as required generated output