## Purpose

Define Liftoff infrastructure and governance output, including Azure OpenTofu artifacts, provider adapter handling, environment configuration, and spec-driven development assets.

## Requirements

### Requirement: Generated projects include Azure-complete OpenTofu infrastructure
The system SHALL generate Azure OpenTofu resource configuration for supported GenAI and standard API workloads, covering applicable Container Apps, Functions hosting, PostgreSQL, Redis, Blob Storage, Service Bus, Communication Services, Container Registry, Key Vault, and selected environments. Generated configuration SHALL NOT imply that all application behavior or production governance has been implemented or deployed. Retired Power Apps requests SHALL be rejected rather than receive an alternative hosting scaffold.

#### Scenario: Generate Azure infrastructure
- **WHEN** a supported GenAI or standard API project selects Azure
- **THEN** it receives applicable OpenTofu files, environment inputs, provider configuration, outputs, and documented commands

#### Scenario: Generate Azure Functions infrastructure
- **WHEN** a supported Azure GenAI project includes worker scaffolding
- **THEN** the configuration includes applicable Function hosting, storage, selected identity, settings, and outputs without claiming the deferred worker specialization is implemented

#### Scenario: Use default Azure region
- **WHEN** a supported API workload accepts the Azure region default
- **THEN** the generated environment configuration uses East US with slug eastus

#### Scenario: Power Apps omits Azure infrastructure
- **WHEN** a retired Power Apps workload is requested
- **THEN** it is rejected without creating Azure infrastructure or presenting a supported Power Platform hosting alternative

### Requirement: Generated infrastructure uses OpenTofu environment configuration
The system SHALL generate one Azure OpenTofu root per selected environment at `infrastructure/opentofu/azure/environments/<environment>/`, backed by a shared application module at `infrastructure/opentofu/azure/modules/application/`, using explicit inventory entries rather than implicit pattern matching. Shared module declarations SHALL be `opentofu-application-versions`, `opentofu-application-variables`, `opentofu-application-main`, and `opentofu-application-outputs`, with lifecycle `project` and provisioning group `base`. Each selected environment SHALL have explicitly enumerated `opentofu-<environment>-{versions,provider-lock,providers,variables,main,outputs,local-state,remote-state-example,tfvars}` declarations with lifecycle `project` and provisioning group `environment:<environment>`, expanded only for `dev`, `staging`, and `prod`. This SHALL replace the exact eight retired flat-root identities declared by the manifest contract, not reuse them for unrelated paths or remove historical project provenance. `opentofu-readme` and the environment-tfvars logical names SHALL remain stable.

#### Scenario: Generate environment tfvars
- **WHEN** a developer selects dev, staging, and prod environments
- **THEN** the generated infrastructure includes explicit roots under `infrastructure/opentofu/azure/environments/dev/`, `infrastructure/opentofu/azure/environments/staging/`, and `infrastructure/opentofu/azure/environments/prod/`
- **AND** each root references the shared application module through explicitly tracked files

#### Scenario: Cross-platform infrastructure paths
- **WHEN** infrastructure files are generated on Windows, macOS, or Linux
- **THEN** the same logical OpenTofu structure is created using platform-correct path handling

#### Scenario: Flat-root retirement is limited to new generator output
- **WHEN** a new project receives the shared application module and independent environment roots
- **THEN** the current inventory contains the exact replacement declarations and no retired flat-root declaration
- **AND** the CLI does not interpret that generator retirement as permission to remove or relocate an existing project's infrastructure files, state, or provenance

### Requirement: Generated infrastructure includes state guidance
The system SHALL generate isolated local OpenTofu state guidance for each selected environment root by default and SHALL include documented remote-state guidance or example configuration that uses distinct project-and-environment backend keys per root. Local baseline validation MUST use backend-disabled initialization; printed operational initialization recipes SHALL initialize the selected root's configured backend only when separately executed by the developer. Generated guidance MUST NOT relocate or silently adopt existing project-owned shared-state layouts.

#### Scenario: Local state default
- **WHEN** Azure OpenTofu infrastructure is generated
- **THEN** each selected environment root can be initialized with local state by default
- **AND** its local state path is isolated from the other generated environment roots

#### Scenario: Remote state example
- **WHEN** a developer reviews the generated infrastructure documentation
- **THEN** the documentation explains how to configure remote OpenTofu state for team environments
- **AND** each example backend key is distinct for the project and selected environment

#### Scenario: Legacy shared-state layout remains a migration boundary
- **WHEN** helper output or documentation encounters an existing project-owned shared-state infrastructure layout
- **THEN** it explains that the layout requires explicit migration work
- **AND** it does not present an automatic environment-switch or state-relocation recipe as if the layout were already compatible

#### Scenario: Environment expansion requires a compatible recorded layout
- **WHEN** configuration adds an environment to a project with a legacy shared-state or unknown infrastructure layout
- **THEN** that environment's provisioning is blocked with a migration-required explanation
- **AND** update does not create a root referencing an absent shared module or rewrite existing infrastructure to make it compatible

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
The system SHALL ask supported API/GenAI users to select OpenSpec or Spec Kit, default to OpenSpec, and initialize selected coding-agent integrations through the official framework CLI. Seed or constitution content SHALL describe the selected supported workload's actual stack and folders. Retired requests SHALL not initialize frameworks or governance assets.

#### Scenario: OpenSpec selected
- **WHEN** a supported project selects OpenSpec or accepts its default
- **THEN** it receives official core output, selected-agent integrations, and the generated local baseline seed

#### Scenario: Spec Kit selected
- **WHEN** a supported project selects Spec Kit
- **THEN** it receives official default/secondary integration output and workload-appropriate constitution/template content

#### Scenario: Power Apps retains governance
- **WHEN** a retired Power Apps request selects either framework
- **THEN** workload rejection occurs before framework initialization or governance asset generation

### Requirement: Generated governance reflects selected stack
The system SHALL tailor generated governance to a supported workload and its applicable pattern, stack, provider, frontend, environments, and approved technologies. It SHALL name actual folder boundaries, distinguish missing capabilities, and omit requirements belonging only to another workload. Retired Power Apps starter and plugin preferences SHALL not influence current generation.

#### Scenario: Governance for GenAI project mentions approved stack
- **WHEN** GenAI governance content is generated
- **THEN** it identifies applicable FastAPI, PydanticAI, Scalar, OpenTofu, Compose, PostgreSQL, Redis, Langfuse, Alembic, and selected-workflow boundaries without claiming deferred specialization is present

#### Scenario: Governance for standard project mentions approved API stack
- **WHEN** standard API governance is generated
- **THEN** it identifies the selected API stack, database tooling, Scalar, OpenTofu, Compose, PostgreSQL, Redis, and selected workflow
- **AND** does not require PydanticAI, Langfuse, model prompts, or GenAI orchestration

#### Scenario: Governance for Power Apps mentions Code Apps standards
- **WHEN** a retired Power Apps request would formerly select Code Apps standards
- **THEN** it is rejected without generating or substituting those standards

#### Scenario: Governance mentions frontend only when applicable
- **WHEN** an API backend-only project is generated
- **THEN** frontend folder rules are not presented as required output
- **AND** no retired root React workload is offered as an alternative

#### Scenario: Governance includes path rules
- **WHEN** generated governance describes structure on Windows, macOS, or Linux
- **THEN** it identifies explicit applicable logical folders with portable path semantics
- **AND** does not describe absent backend, database, infrastructure, environment, or frontend locations as present

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
The system SHALL document how developers can initialize, plan, apply, and inspect generated OpenTofu infrastructure through Liftoff helper commands or direct OpenTofu commands. Helper output, README recipes, governance context, baseline checks, container instructions, and outputs SHALL all select the same explicit environment root for a given command.

#### Scenario: Infrastructure command documentation
- **WHEN** Azure infrastructure is generated
- **THEN** the generated README or infrastructure documentation includes init, plan, apply, and output commands for each selected environment root
- **AND** those commands point to the same root that helper output and governance context describe

#### Scenario: Legacy helper boundary is explicit
- **WHEN** generated guidance references a project that still uses a legacy shared-state layout
- **THEN** the helper documentation identifies that layout as a migration-required compatibility boundary
- **AND** it does not imply that ordinary helper commands will relocate or normalize the existing state automatically

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
The system SHALL generate each Azure resource name from a centralized service-specific naming policy that enforces the service's allowed characters and maximum length. Names MUST include a deterministic collision-resistant component derived from the complete project identity and environment wherever truncation could merge distinct projects in the same resource scope. This includes resource groups, managed identities, Container Apps environments, and application names as well as globally scoped services. Generated documentation SHALL explain valid suffix overrides for globally scoped collisions; a user-supplied suffix SHALL NOT be the sole collision defense.

#### Scenario: Common project name fits Key Vault limits
- **WHEN** a developer generates infrastructure for a project named `claims-copilot`
- **THEN** the rendered Key Vault name is at most 24 characters and satisfies Azure Key Vault character rules

#### Scenario: Long project name keeps every bounded resource valid
- **WHEN** a project name is longer than an Azure service permits
- **THEN** the generated Key Vault, storage account, container registry, Container App, Function app, PostgreSQL, Redis, Service Bus, and communication resource names use explicit service-specific truncation or suffix rules

#### Scenario: Environment names produce distinct suffixes
- **WHEN** infrastructure is generated for more than one selected environment
- **THEN** each environment receives a deterministic lowercase alphanumeric collision-resistant suffix distinct from the other generated environments

#### Scenario: Similar display prefixes remain distinct across projects
- **WHEN** two generated projects share the same visible name prefix or truncation boundary but differ in their complete project identity
- **THEN** their resource groups, identities, Container Apps environments, applications, and globally scoped services retain distinct generated names within their relevant scopes
- **AND** supplying different suffix overrides is not required to prevent the truncated-prefix collision

#### Scenario: Invalid suffix override fails during OpenTofu validation
- **WHEN** a developer overrides the resource suffix with disallowed characters or an unsupported length
- **THEN** OpenTofu reports the variable validation error before attempting resource creation

### Requirement: Function workers use one explicit identity and queue contract
The system SHALL configure each generated Function Service Bus trigger with the fully qualified namespace and client ID of the same user-assigned identity that receives the Service Bus Data Receiver role. Generated RAG publication paths SHALL use explicit environment-selected namespace and queue inputs plus a distinct sender identity that receives only the Service Bus Data Sender role at the narrowest generated entity scope. Function host storage MUST use one complete authentication mode, and the provisioned queue name, Function app setting, publisher setting, environment template, and output MUST derive from the same environment-specific input.

#### Scenario: User-assigned identity is selected explicitly
- **WHEN** worker-enabled Azure infrastructure is generated
- **THEN** Function app settings include `ServiceBusConnection__fullyQualifiedNamespace` and `ServiceBusConnection__clientId` for the attached user-assigned identity

#### Scenario: Service Bus receiver role targets the selected identity
- **WHEN** the Service Bus trigger identity is configured
- **THEN** the generated receiver role assignment uses that identity's principal ID and the generated Service Bus namespace scope

#### Scenario: RAG publisher uses a narrow sender identity
- **WHEN** generated infrastructure includes the RAG publication path
- **THEN** the generated publisher configuration receives the selected namespace, queue, and sender identity values
- **AND** the corresponding role assignment grants only the Service Bus Data Sender role at the narrowest generated queue or namespace scope required by the selected provider capability

#### Scenario: Function host storage configuration is coherent
- **WHEN** Function host storage uses an access key
- **THEN** the generated Function resource configures the key-backed storage connection and does not also emit incomplete identity-based `AzureWebJobsStorage` settings

#### Scenario: Queue override provisions the queue that the Function consumes
- **WHEN** `function_worker_queue_name` is changed for an environment
- **THEN** OpenTofu provisions that exact queue name, configures the Function trigger with it, configures any generated publisher with the same selected entity, and returns it from the generated output

### Requirement: Generated OpenTofu passes static checks unchanged
The system SHALL render OpenTofu files that pass the repository's supported `tofu fmt -check`, `tofu init -backend=false`, and `tofu validate` commands for each generated environment root without first rewriting generated files.

#### Scenario: Formatter check on a worker project
- **WHEN** a worker-enabled project with a frontend is freshly generated
- **THEN** recursive `tofu fmt -check` exits 0 without producing a diff

#### Scenario: Validate every representative infrastructure shape
- **WHEN** CI renders backend-only, frontend, worker, and non-worker representative plans
- **THEN** each generated environment root initializes without a backend and validates successfully without Azure credentials

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
The generated governance context SHALL enumerate only infrastructure, environments, deployment boundaries, health endpoints, and operations artifacts present in the resolved plan. When Azure infrastructure is generated, it SHALL identify the explicit environment roots and shared application module path. It SHALL mark runner access, live deployments, monitoring, alerts, traffic volume, and platform rollout capabilities as discovery inputs rather than generated facts, and it SHALL treat legacy shared-state infrastructure as a compatibility boundary rather than an implicitly migrated layout.

#### Scenario: Generate Azure API governance context
- **WHEN** a GenAI or standard API plan includes Azure OpenTofu and selected environments
- **THEN** context identifies the generated environment root directories, the shared application module, and the selected environment names
- **AND** it does not claim that Azure resources are deployed, monitored, or automatically migrated from a legacy state layout

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
