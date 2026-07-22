## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Generated infrastructure is API-runtime aware without changing cloud boundaries
The system SHALL keep Azure Container Apps and shared Azure service output applicable to every API stack while tailoring container build and runtime configuration to the selected stack and omitting pattern-driven Azure Functions from standard projects.

#### Scenario: Generate standard Azure infrastructure
- **WHEN** a developer creates a standard Python, Node.js, or Go project for Azure
- **THEN** the generated OpenTofu deploys the selected backend container through the common Container Apps boundary
- **AND** it does not include a pattern-driven Azure Function app

#### Scenario: Generate infrastructure paths across platforms
- **WHEN** infrastructure is generated for any API stack on Windows, macOS, or Linux
- **THEN** every artifact is tracked by logical name and OS-neutral path parts and written with platform-correct filesystem handling
