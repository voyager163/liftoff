## MODIFIED Requirements

### Requirement: Generated projects include environment-specific configuration
The system SHALL generate selected dev, staging, and prod configuration templates for GenAI and standard API application runtime, applicable Azure Functions workers, local development, and infrastructure. Power Apps code apps SHALL not generate those API environment templates or invent Power Platform environment configuration.

#### Scenario: Generate selected environments
- **WHEN** a developer selects dev, staging, and prod environments for an API workload
- **THEN** the generated project includes environment-specific configuration files for all selected environments

#### Scenario: Generate Function worker settings templates
- **WHEN** the generated project includes Azure Functions workers
- **THEN** each selected environment includes Function worker settings templates separate from backend API settings

#### Scenario: Protect secrets
- **WHEN** environment configuration templates are generated
- **THEN** the generated files avoid committed secret values and provide placeholders or secret references instead

#### Scenario: Power Apps environment remains unbound
- **WHEN** a Power Apps code app is generated
- **THEN** Liftoff emits no API environment folders and no fabricated Power Platform environment identifier
