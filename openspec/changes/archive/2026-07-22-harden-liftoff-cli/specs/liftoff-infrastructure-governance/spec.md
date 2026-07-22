## ADDED Requirements

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
