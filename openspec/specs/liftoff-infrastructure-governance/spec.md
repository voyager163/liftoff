## Purpose

Define Liftoff infrastructure and governance output, including Azure OpenTofu artifacts, provider adapter handling, environment configuration, and spec-driven development assets.

## Requirements

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
The system SHALL tailor generated governance content to the selected project type, GenAI pattern when applicable, API stack, cloud provider, frontend choice, environments, and approved stack.

#### Scenario: Governance for GenAI project mentions approved stack
- **WHEN** governance files are generated for a GenAI project
- **THEN** they identify FastAPI, PydanticAI, Scalar, OpenTofu, Docker Compose, PostgreSQL, Redis, Langfuse, Alembic, and the selected spec workflow as project standards

#### Scenario: Governance for standard project mentions approved API stack
- **WHEN** governance files are generated for a standard project
- **THEN** they identify the selected Python/FastAPI, Node.js/Fastify, or Go/Huma API stack, its database tooling, Scalar, OpenTofu, Docker Compose, PostgreSQL, Redis, and the selected spec workflow
- **AND** they do not require PydanticAI, Langfuse, agents, prompts, models, or GenAI orchestration

#### Scenario: Governance mentions frontend only when selected
- **WHEN** governance files are generated for a backend-only project
- **THEN** frontend folder rules are not presented as required generated output

#### Scenario: Governance includes path rules
- **WHEN** generated governance references project structure
- **THEN** it describes frontend, backend, database, infrastructure, and environment locations by explicit folder names appropriate to the selected API stack

### Requirement: Generated infrastructure is API-runtime aware without changing cloud boundaries
The system SHALL keep Azure Container Apps and shared Azure service output applicable to every API stack while tailoring container build and runtime configuration to the selected stack and omitting pattern-driven Azure Functions from standard projects.

#### Scenario: Generate standard Azure infrastructure
- **WHEN** a developer creates a standard Python, Node.js, or Go project for Azure
- **THEN** the generated OpenTofu deploys the selected backend container through the common Container Apps boundary
- **AND** it does not include a pattern-driven Azure Function app

#### Scenario: Generate infrastructure paths across platforms
- **WHEN** infrastructure is generated for any API stack on Windows, macOS, or Linux
- **THEN** every artifact is tracked by logical name and OS-neutral path parts and written with platform-correct filesystem handling

### Requirement: Generated project includes infrastructure helper documentation
The system SHALL document how developers can initialize, plan, apply, and inspect generated OpenTofu infrastructure through Liftoff helper commands or direct OpenTofu commands.

#### Scenario: Infrastructure command documentation
- **WHEN** Azure infrastructure is generated
- **THEN** the generated README or infrastructure documentation includes commands for init, plan, apply, and output operations for each selected environment

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

### Requirement: Generated Azure resource names are deployable by construction
The system SHALL generate each Azure resource name from a centralized service-specific naming policy that enforces the service's allowed characters and maximum length. Names for globally scoped resources MUST include a deterministic collision-resistant suffix, and generated documentation MUST explain how to override that suffix if Azure reports a collision.

#### Scenario: Common project name fits Key Vault limits
- **WHEN** a developer generates infrastructure for a project named `claims-copilot`
- **THEN** the rendered Key Vault name is at most 24 characters and satisfies Azure Key Vault character rules

#### Scenario: Long project name keeps every bounded resource valid
- **WHEN** a project name is longer than an Azure service permits
- **THEN** the generated Key Vault, storage account, container registry, Container App, Function app, PostgreSQL, Redis, Service Bus, and communication resource names use explicit service-specific truncation or suffix rules

#### Scenario: Environment names produce distinct suffixes
- **WHEN** infrastructure is generated for more than one selected environment
- **THEN** each environment receives a deterministic lowercase alphanumeric collision-resistant suffix distinct from the other generated environments

#### Scenario: Invalid suffix override fails during OpenTofu validation
- **WHEN** a developer overrides the resource suffix with disallowed characters or an unsupported length
- **THEN** OpenTofu reports the variable validation error before attempting resource creation

### Requirement: Function workers use one explicit identity and queue contract
The system SHALL configure each generated Function Service Bus trigger with the fully qualified namespace and client ID of the same user-assigned identity that receives the Service Bus Data Receiver role. Function host storage MUST use one complete authentication mode, and the provisioned queue name, Function app setting, environment template, and output MUST derive from the same environment-specific input.

#### Scenario: User-assigned identity is selected explicitly
- **WHEN** worker-enabled Azure infrastructure is generated
- **THEN** Function app settings include `ServiceBusConnection__fullyQualifiedNamespace` and `ServiceBusConnection__clientId` for the attached user-assigned identity

#### Scenario: Service Bus receiver role targets the selected identity
- **WHEN** the Service Bus trigger identity is configured
- **THEN** the generated receiver role assignment uses that identity's principal ID and the generated Service Bus namespace scope

#### Scenario: Function host storage configuration is coherent
- **WHEN** Function host storage uses an access key
- **THEN** the generated Function resource configures the key-backed storage connection and does not also emit incomplete identity-based `AzureWebJobsStorage` settings

#### Scenario: Queue override provisions the queue that the Function consumes
- **WHEN** `function_worker_queue_name` is changed for an environment
- **THEN** OpenTofu provisions that exact queue name, configures the Function trigger with it, and returns it from the worker queue output

### Requirement: Generated OpenTofu passes static checks unchanged
The system SHALL render OpenTofu files that pass the repository's supported `tofu fmt -check`, `tofu init -backend=false`, and `tofu validate` commands without first rewriting generated files.

#### Scenario: Formatter check on a worker project
- **WHEN** a worker-enabled project with a frontend is freshly generated
- **THEN** recursive `tofu fmt -check` exits 0 without producing a diff

#### Scenario: Validate every representative infrastructure shape
- **WHEN** CI renders backend-only, frontend, worker, and non-worker representative plans
- **THEN** each generated OpenTofu directory initializes without a backend and validates successfully without Azure credentials