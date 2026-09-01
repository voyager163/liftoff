## MODIFIED Requirements

### Requirement: Generated projects support all GenAI patterns
The system SHALL generate pattern-aware backend scaffolds for a generic/undecided GenAI application, RAG, chatbot/conversational AI, agent-based, prompt-based app, multi-agent system, fine-tuned model app, real-time/streaming AI, and AI workflow/pipeline applications. The generic scaffold SHALL contain the common GenAI runtime and a neutral invocation boundary without asserting any specialized architecture.

#### Scenario: Generate generic GenAI scaffold
- **WHEN** a developer selects the generic pattern
- **THEN** the generated project includes a neutral FastAPI invocation route, PydanticAI runner, generic system prompt, tracing boundary, and offline test
- **AND** it excludes retrieval and pgvector, ingestion or task workers, chat persistence, specialized agent tools, streaming transport, fine-tuning datasets, and workflow-specific output

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
The system SHALL ask GenAI and standard API projects whether to generate a Vue 3/Tailwind frontend suited to the project type. Generic GenAI frontends SHALL provide a neutral prompt playground; specialized GenAI frontends SHALL remain suited to their selected pattern. Standard frontends SHALL provide a generic API starter that uses the selected stack's common API contract. Power Apps code apps SHALL use their root React application as the workload and SHALL NOT ask the optional API-frontend question or generate a nested `frontend` project.

#### Scenario: Frontend selected for generic GenAI
- **WHEN** a developer selects the generic GenAI pattern and chooses to include a frontend
- **THEN** the generated frontend provides a neutral text-input playground that calls the generic invocation route
- **AND** it contains no RAG, chatbot, agent, streaming, fine-tuning, or workflow claims

#### Scenario: Frontend selected for RAG
- **WHEN** a developer selects the RAG pattern and chooses to include a frontend
- **THEN** the generated frontend provides a retrieval/search starter experience that can call the generated backend API

#### Scenario: Frontend selected for standard API
- **WHEN** a developer creates a standard project and chooses to include a frontend
- **THEN** the generated frontend provides a generic API starter without GenAI pattern language or AI-specific controls

#### Scenario: Frontend omitted
- **WHEN** a developer chooses not to include a frontend for an API workload
- **THEN** the generated project remains API-first and still includes Scalar for backend API exploration

#### Scenario: Power Apps does not create a nested frontend
- **WHEN** a Power Apps code app is generated
- **THEN** its React application is generated at the project root
- **AND** no optional frontend decision or nested Liftoff Vue frontend is present
