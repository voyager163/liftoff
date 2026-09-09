## MODIFIED Requirements

### Requirement: Standard API stacks share an operational contract
The system SHALL generate every standard API stack with port `8000`, health and readiness endpoints, an OpenAPI document, a Scalar API reference, PostgreSQL integration, a stack-native health test, and one documented runtime configuration contract. Supplied process environment MUST override the selected project configuration file, and that file MUST override nonsecret defaults. Native startup and Docker Compose recipes SHALL resolve the same applicable application, database, service, and readiness settings. Omitted messaging or tracing boundaries SHALL NOT create configuration prerequisites, and standard stacks SHALL NOT require pgvector or pattern-specific worker behavior.

#### Scenario: Inspect a generated standard API
- **WHEN** a developer generates any supported standard API stack
- **THEN** the backend exposes `GET /health` and `GET /ready`
- **AND** the backend exposes OpenAPI-backed Scalar API documentation
- **AND** the generated runtime listens on port `8000`

#### Scenario: Process environment overrides the selected standard configuration
- **WHEN** a supported standard runtime value is set in both process environment and the selected project configuration file
- **THEN** the generated application uses the process-environment value
- **AND** the documented precedence matches the running application behavior

#### Scenario: Native and Compose recipes agree for standard projects
- **WHEN** a developer starts the same generated standard project natively and through Docker Compose
- **THEN** both startup paths resolve the same selected configuration values
- **AND** Docker Compose changes only the service addresses needed for container networking

### Requirement: Standard projects exclude GenAI components
The system SHALL omit PydanticAI, model configuration, agents, prompts, retrieval, evaluation, AI orchestration, GenAI pattern settings, Langfuse integration, pattern workers, pattern-driven Azure Functions, pgvector-only storage, and specialized publisher wiring from standard projects.

#### Scenario: Generate a standard project
- **WHEN** a developer generates a standard project with any approved API stack
- **THEN** no generated path is under `backend/orchestration` or `functions`
- **AND** generated dependencies, configuration, documentation, and governance contain no required GenAI runtime components

#### Scenario: Standard local and container output stays non-GenAI
- **WHEN** a generated standard project uses its native or Docker Compose local workflow
- **THEN** no pgvector image, GenAI worker, Langfuse dependency, or pattern-specific publisher configuration is required
