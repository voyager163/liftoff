## Purpose

Define Liftoff infrastructure and governance output, including Azure OpenTofu artifacts, provider adapter handling, environment configuration, and spec-driven development assets.

## Requirements

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

### Requirement: Generated infrastructure uses OpenTofu environment configuration
The system SHALL generate dev, staging, and prod OpenTofu environment configuration using explicit files rather than implicit pattern matching.

#### Scenario: Generate environment tfvars
- **WHEN** a developer selects dev, staging, and prod environments
- **THEN** the generated infrastructure includes explicit `dev.tfvars`, `staging.tfvars`, and `prod.tfvars` files or equivalent explicitly tracked environment files

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

### Requirement: Generated infrastructure dependencies are release-pinned
The system SHALL render OpenTofu CLI constraints, provider constraints, provider checksums, cloud runtime versions, database major versions, and bootstrap container identities from the supported-stack baseline. Generated infrastructure SHALL include an explicit multi-platform provider lock and SHALL NOT resolve a newer provider or mutable bootstrap image than the Liftoff release tested.

#### Scenario: Generate current Azure OpenTofu
- **WHEN** an API workload generates Azure infrastructure
- **THEN** its OpenTofu and AzureRM release lines match the named baseline entries
- **AND** its provider lock contains checksums for every supported execution platform

#### Scenario: Validate on a supported platform
- **WHEN** `tofu init -backend=false` runs on Windows, macOS, or Linux
- **THEN** it accepts the generated provider lock without rewriting it
- **AND** `tofu validate` succeeds without Azure credentials

#### Scenario: Bootstrap image is generated
- **WHEN** infrastructure contains a default application or frontend bootstrap image
- **THEN** the image is bound to an immutable digest recorded by the baseline
- **AND** it is not represented by `latest`

### Requirement: Provider major upgrades preserve generated infrastructure intent
A stable provider major upgrade SHALL include the source migrations needed for every representative generated infrastructure shape. It SHALL preserve environment selection, secret boundaries, resource naming, identities, roles, queues, health settings, and outputs unless a separate approved capability change explicitly alters them.

#### Scenario: Upgrade AzureRM
- **WHEN** the supported baseline moves generated projects from AzureRM 3.x to 5.x
- **THEN** backend-only, frontend, worker, and non-worker plans format, initialize, and validate unchanged
- **AND** compatibility edits are reviewed with the provider version change

#### Scenario: Provider migration is incomplete
- **WHEN** any representative configuration uses a removed argument, invalid default, or rewritten lock after the upgrade
- **THEN** baseline verification fails before release

### Requirement: Repository governance is distinct from spec-workflow governance
The system SHALL keep the managed-core repository-governance policy and activation handoff separate from OpenSpec configuration, Spec Kit constitution content, official framework output, and one-time workload seed changes. Selecting OpenSpec or Spec Kit determines how the post-Phase-0 governance change is created; it SHALL NOT change the canonical repository-governance profile's fixed invariants.

#### Scenario: Generate OpenSpec with repository governance
- **WHEN** a project selects OpenSpec and `single-maintainer-gitflow`
- **THEN** it receives official OpenSpec output, its one-time workload seed, and the separate managed-core repository-governance handoff
- **AND** archiving either active change does not remove or recreate the policy

#### Scenario: Generate Spec Kit with repository governance
- **WHEN** a project selects Spec Kit and `single-maintainer-gitflow`
- **THEN** it receives official Spec Kit output and the same canonical repository-governance profile
- **AND** the selected default agent is used only through the framework's normal integration contract

### Requirement: Repository governance context reflects actual infrastructure
The generated governance context SHALL enumerate only infrastructure, environments, deployment boundaries, health endpoints, and operations artifacts present in the resolved plan. It SHALL mark runner access, live deployments, monitoring, alerts, traffic volume, and platform rollout capabilities as discovery inputs rather than generated facts.

#### Scenario: Generate Azure API governance context
- **WHEN** a GenAI or standard API plan includes Azure OpenTofu and selected environments
- **THEN** context identifies those generated files and environment names
- **AND** does not claim that Azure resources are deployed or monitored

#### Scenario: Generate no optional frontend
- **WHEN** an API plan excludes the frontend
- **THEN** governance context and policy adaptation do not require frontend source, image, deployment, synthetic availability, or CDN controls

#### Scenario: Missing deployment capability
- **WHEN** Phase 0 cannot prove a staging environment, production deployment path, parallel-version mechanism, or monitoring signal
- **THEN** the proposed governance plan records the exact gap or inapplicability
- **AND** does not create a success-shaped placeholder workflow

### Requirement: Generated OpenSpec bootstrap changes are complete and strict-valid
Every generated OpenSpec bootstrap change SHALL include its metadata, proposal,
design, tasks, and the capability spec declared by its proposal. The generated
new-capability spec SHALL include a concrete `## Purpose` before its delta
requirements so archive never creates a placeholder main-spec purpose. The
generated tasks SHALL verify the local baseline and defer domain-specific
product behavior without contradicting the design non-goals.

#### Scenario: Generate an API project
- **WHEN** Liftoff creates `bootstrap-<project>`
- **THEN** the change includes `specs/<generated-capability>/spec.md`
- **AND** strict OpenSpec validation succeeds immediately after generation

#### Scenario: Developer reviews seed tasks
- **WHEN** the generated design excludes domain-specific product behavior
- **THEN** its tasks confirm placeholders are deferred to follow-up changes
- **AND** do not instruct the developer to replace them inside the bootstrap change

#### Scenario: Seed baseline is verified
- **WHEN** setup completes every applicable local baseline command
- **THEN** the seed can be synced and archived without deploying infrastructure or contacting GitHub

#### Scenario: Archive creates a strict-valid main spec
- **WHEN** setup archives a generated bootstrap change that introduces a capability
- **THEN** the synchronized main spec receives the generated concrete Purpose
- **AND** `openspec validate --all --strict` succeeds without a fallback `TBD` purpose
