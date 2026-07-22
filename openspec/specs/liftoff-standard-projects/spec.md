## Purpose

Define standard Liftoff projects, their approved API stacks, shared operational contract, GenAI exclusions, stable layout, and language-specific database tooling.

## Requirements

### Requirement: Developers can create standard projects
The system SHALL let developers identify a project as either GenAI or standard before collecting type-specific project decisions, SHALL require a GenAI pattern only for GenAI projects, and SHALL require an approved API stack only for standard projects.

#### Scenario: Select a standard project interactively
- **WHEN** a developer runs `liftoff create` interactively and answers no to the GenAI project question
- **THEN** the CLI skips the GenAI pattern prompt
- **AND** the CLI asks the developer to select an approved standard API stack

#### Scenario: Select a GenAI project interactively
- **WHEN** a developer answers yes to the GenAI project question
- **THEN** the CLI asks for one of the supported GenAI patterns
- **AND** the generated API stack remains Python/FastAPI with PydanticAI

### Requirement: Standard projects support three approved API stacks
The system SHALL support exactly one approved standard API stack for each offered language: Python with FastAPI, Node.js with Fastify and TypeScript, and Go with Huma v2 and Chi.

#### Scenario: Select Python API
- **WHEN** a developer selects the Python standard API stack
- **THEN** the generated backend uses FastAPI and Python-native project, configuration, test, and packaging conventions

#### Scenario: Select Node.js API
- **WHEN** a developer selects the Node.js standard API stack
- **THEN** the generated backend uses Fastify with TypeScript and Node.js-native project, configuration, test, and packaging conventions

#### Scenario: Select Go API
- **WHEN** a developer selects the Go standard API stack
- **THEN** the generated backend uses Huma v2 with Chi and Go-native module, package, configuration, and test conventions

### Requirement: Standard API stacks share an operational contract
The system SHALL generate every standard API stack with port `8000`, health and readiness endpoints, an OpenAPI document, a Scalar API reference, environment-based configuration, PostgreSQL integration, and a stack-native health test.

#### Scenario: Inspect a generated standard API
- **WHEN** a developer generates any supported standard API stack
- **THEN** the backend exposes `GET /health` and `GET /ready`
- **AND** the backend exposes OpenAPI-backed Scalar API documentation
- **AND** the generated runtime listens on port `8000`

### Requirement: Standard projects exclude GenAI components
The system SHALL omit PydanticAI, model configuration, agents, prompts, retrieval, evaluation, AI orchestration, GenAI pattern settings, Langfuse integration, pattern workers, and pattern-driven Azure Functions from standard projects.

#### Scenario: Generate a standard project
- **WHEN** a developer generates a standard project with any approved API stack
- **THEN** no generated path is under `backend/orchestration` or `functions`
- **AND** generated dependencies, configuration, documentation, and governance contain no required GenAI runtime components

### Requirement: Standard projects retain stable top-level boundaries
The system SHALL keep backend, database, environment, infrastructure, governance, and optional frontend output under stable top-level boundaries while allowing each API stack to use idiomatic backend internals.

#### Scenario: Compare standard API stack layouts
- **WHEN** Python, Node.js, and Go standard projects are generated with equivalent project decisions
- **THEN** each project contains `backend`, `database`, `environments`, and `infrastructure` top-level folders
- **AND** each backend uses the approved internal layout for its selected language

#### Scenario: Generate paths across operating systems
- **WHEN** a standard project is generated on Windows, macOS, or Linux
- **THEN** the same logical top-level folders and manifest path parts are produced using platform-correct filesystem paths

### Requirement: Standard projects use approved language-specific database tooling
The system SHALL keep database artifacts under the common `database` boundary while generating SQLAlchemy and Alembic for Python, Drizzle for Node.js, and pgx with Goose migrations for Go.

#### Scenario: Generate database integration
- **WHEN** a developer creates a standard project
- **THEN** the backend dependencies and database artifacts use the approved tooling for the selected API stack
- **AND** an initial PostgreSQL migration is generated
