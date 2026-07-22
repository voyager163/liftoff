## ADDED Requirements

### Requirement: Generated projects use the approved backend stack
The system SHALL generate backend projects using FastAPI, PydanticAI, Pydantic runtime configuration models, Scalar for the developer portal, Alembic migrations, PostgreSQL, Redis, Langfuse tracing hooks, and Docker-compatible runtime configuration.

#### Scenario: Generate backend scaffold
- **WHEN** a developer creates a Liftoff project
- **THEN** the generated backend includes API entrypoints, PydanticAI orchestration structure, model configuration, prompt templates, runtime settings, tests, and Scalar developer portal wiring

#### Scenario: Framework choices are standardized
- **WHEN** the backend scaffold is generated
- **THEN** the generated project uses PydanticAI for GenAI orchestration and does not include alternate GenAI framework scaffolds

### Requirement: Generated projects use the standard folder layout
The system SHALL place frontend code under `frontend`, backend API code under `backend/apis`, and database-related artifacts under `database` when those areas are generated.

#### Scenario: Backend-only project layout
- **WHEN** a developer creates a project without a frontend
- **THEN** the generated project includes `backend/apis` and `database` folders and does not include a `frontend` folder

#### Scenario: Frontend project layout
- **WHEN** a developer creates a project with a frontend
- **THEN** the generated project includes a Vue 3/Tailwind frontend under `frontend` in addition to backend and database folders

#### Scenario: Cross-platform layout creation
- **WHEN** the CLI creates the standard folders on Windows, macOS, or Linux
- **THEN** the same logical folders are generated using platform-correct path handling

### Requirement: Generated projects support all GenAI patterns
The system SHALL generate pattern-aware backend scaffolds for RAG, chatbot/conversational AI, agent-based, prompt-based app, multi-agent system, fine-tuned model app, real-time/streaming AI, and AI workflow/pipeline applications.

#### Scenario: Generate RAG scaffold
- **WHEN** a developer selects the RAG pattern
- **THEN** the generated project includes retrieval orchestration, prompt templates, ingestion worker structure, embedding pipeline structure, PostgreSQL pgvector integration points, and document storage configuration

#### Scenario: Generate chatbot scaffold
- **WHEN** a developer selects the chatbot/conversational AI pattern
- **THEN** the generated project includes conversation routes, message persistence structure, prompt templates, and PydanticAI orchestration for conversational turns

#### Scenario: Generate agent-based scaffold
- **WHEN** a developer selects the agent-based pattern
- **THEN** the generated project includes agent orchestration, tool boundary structure, task execution routes, and worker structure when background execution is part of the scaffold

#### Scenario: Generate prompt-based scaffold
- **WHEN** a developer selects the prompt-based app pattern
- **THEN** the generated project includes named prompt template structure, invocation routes, and structured output validation examples

#### Scenario: Generate multi-agent scaffold
- **WHEN** a developer selects the multi-agent system pattern
- **THEN** the generated project includes coordination structure, agent role folders, shared state boundaries, and run orchestration routes

#### Scenario: Generate fine-tuned model scaffold
- **WHEN** a developer selects the fine-tuned model app pattern
- **THEN** the generated project includes deployed model endpoint configuration, invocation routes, and evaluation dataset structure

#### Scenario: Generate streaming scaffold
- **WHEN** a developer selects the real-time/streaming AI pattern
- **THEN** the generated project includes streaming response routes and frontend-compatible streaming configuration

#### Scenario: Generate workflow scaffold
- **WHEN** a developer selects the AI workflow/pipeline pattern
- **THEN** the generated project includes pipeline stage structure, run persistence structure, trigger configuration, and worker structure

### Requirement: Generated projects include optional pattern-aware frontend
The system SHALL ask whether to generate a frontend and, when selected, generate a Vue 3/Tailwind frontend suited to the chosen GenAI pattern.

#### Scenario: Frontend selected for RAG
- **WHEN** a developer selects the RAG pattern and chooses to include a frontend
- **THEN** the generated frontend provides a retrieval/search starter experience that can call the generated backend API

#### Scenario: Frontend omitted
- **WHEN** a developer chooses not to include a frontend
- **THEN** the generated project remains API-first and still includes Scalar for backend API exploration

### Requirement: Generated projects include local Docker Compose development
The system SHALL generate Docker Compose local development configuration for backend services, PostgreSQL with pgvector, Redis, Azurite, Mailpit, and optional Langfuse observability profile.

#### Scenario: Start default local stack
- **WHEN** a developer runs the generated local Docker Compose command
- **THEN** the backend, PostgreSQL/pgvector, Redis, Azurite, and Mailpit services are available for local development

#### Scenario: Start observability profile
- **WHEN** a developer runs the generated Docker Compose command with the observability profile
- **THEN** Langfuse services are included in the local stack

### Requirement: Generated projects use local service substitutes behind stable interfaces
The system SHALL configure cloud services and local substitutes behind stable application interfaces so local development can run without Azure dependencies.

#### Scenario: Local messaging substitute
- **WHEN** the generated project runs in local development mode
- **THEN** the application uses Redis Streams through the messaging interface instead of requiring Azure Service Bus

#### Scenario: Cloud messaging configuration
- **WHEN** the generated project runs with Azure cloud configuration
- **THEN** the application uses Azure Service Bus through the same messaging interface

### Requirement: Generated projects include environment-specific configuration
The system SHALL generate dev, test, and prod environment configuration templates for application runtime, local development, and infrastructure.

#### Scenario: Generate selected environments
- **WHEN** a developer selects dev, test, and prod environments
- **THEN** the generated project includes environment-specific configuration files for all selected environments

#### Scenario: Protect secrets
- **WHEN** environment configuration templates are generated
- **THEN** the generated files avoid committed secret values and provide placeholders or secret references instead