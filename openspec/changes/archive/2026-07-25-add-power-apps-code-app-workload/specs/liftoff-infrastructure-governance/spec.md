## MODIFIED Requirements

### Requirement: Generated projects include Azure-complete OpenTofu infrastructure
The system SHALL generate OpenTofu infrastructure artifacts for GenAI and standard API workloads that select Azure, covering applicable Azure Container Apps, Azure Functions hosting, Azure Database for PostgreSQL, Azure Redis Cache, Azure Blob Storage, Azure Service Bus, Azure Communication Services, Azure Container Registry, Key Vault, and selected-environment configuration. A Power Apps code app SHALL rely on Power Platform hosting and SHALL NOT receive Liftoff Azure OpenTofu infrastructure.

#### Scenario: Generate Azure infrastructure
- **WHEN** a developer creates a GenAI or standard API project with Azure as the target cloud
- **THEN** the generated project includes Azure OpenTofu files, environment tfvars, provider configuration, outputs, and documented usage commands

#### Scenario: Generate Azure Functions infrastructure
- **WHEN** a developer creates an Azure GenAI project that includes Azure Functions workers
- **THEN** the generated Azure OpenTofu files include Function app hosting, required storage, managed identity wiring, app settings, and worker-related outputs

#### Scenario: Use default Azure region
- **WHEN** an API workload developer does not choose a different Azure region
- **THEN** the generated OpenTofu environment configuration uses East US with the slug `eastus`

#### Scenario: Power Apps omits Azure infrastructure
- **WHEN** a developer creates a Power Apps code app
- **THEN** the project contains no Liftoff OpenTofu, Azure resource, tfvars, or infrastructure helper output
- **AND** its documentation identifies Power Platform environment initialization as a separate external action

### Requirement: Generated projects include spec-driven governance assets
The system SHALL ask every workload developer to choose OpenSpec or Spec Kit as the spec-driven development workflow, SHALL default the selection to OpenSpec, and SHALL initialize every selected coding-agent integration through the official framework CLI. Governance seed or constitution content SHALL describe the selected workload's actual stack and folders.

#### Scenario: OpenSpec selected
- **WHEN** a developer selects OpenSpec or accepts the default spec workflow
- **THEN** the generated project includes official OpenSpec core output, every selected agent integration, and an initial seed change describing the generated workload baseline

#### Scenario: Spec Kit selected
- **WHEN** a developer selects Spec Kit
- **THEN** the generated project includes official Spec Kit output for the selected default and secondary integrations
- **AND** its constitution and supporting template structure describe the generated workload

#### Scenario: Power Apps retains governance
- **WHEN** a developer selects either framework for a Power Apps code app
- **THEN** the framework is initialized at the Power Apps project root with the selected Copilot, Claude Code, or both integrations
- **AND** no API backend is required for spec-driven governance

### Requirement: Generated governance reflects selected stack
The system SHALL tailor generated governance content to the selected workload and only its applicable pattern, API stack, cloud provider, frontend choice, environments, starter source, optional plugin preference, and approved technologies. It SHALL describe explicit workload folder boundaries and SHALL NOT include standards belonging only to another workload.

#### Scenario: Governance for GenAI project mentions approved stack
- **WHEN** governance files are generated for a GenAI project
- **THEN** they identify FastAPI, PydanticAI, Scalar, OpenTofu, Docker Compose, PostgreSQL, Redis, Langfuse, Alembic, and the selected spec workflow as project standards

#### Scenario: Governance for standard project mentions approved API stack
- **WHEN** governance files are generated for a standard project
- **THEN** they identify the selected Python/FastAPI, Node.js/Fastify, or Go/Huma API stack, its database tooling, Scalar, OpenTofu, Docker Compose, PostgreSQL, Redis, and the selected spec workflow
- **AND** they do not require PydanticAI, Langfuse, agents, prompts, models, or GenAI orchestration

#### Scenario: Governance for Power Apps mentions Code Apps standards
- **WHEN** governance files are generated for a Power Apps code app
- **THEN** they identify React, Vite, TypeScript, the Power Apps SDK and Vite plugin, connector-first data access, generated connector services, the pinned official starter, and the selected spec workflow
- **AND** they do not require a Liftoff backend, database, Docker Compose, OpenTofu, Azure API infrastructure, PydanticAI, or Langfuse

#### Scenario: Governance mentions frontend only when applicable
- **WHEN** governance files are generated for an API backend-only project
- **THEN** frontend folder rules are not presented as required generated output
- **AND** a Power Apps project describes its root React application rather than a nested optional frontend

#### Scenario: Governance includes path rules
- **WHEN** generated governance references project structure
- **THEN** it names explicit folders valid for the selected workload
- **AND** it does not describe absent backend, database, infrastructure, environment, or frontend locations
