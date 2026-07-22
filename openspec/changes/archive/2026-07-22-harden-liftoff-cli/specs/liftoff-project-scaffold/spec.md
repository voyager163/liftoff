## ADDED Requirements

### Requirement: Generated GenAI orchestration is executable and explicit about configuration
The system SHALL generate a minimal PydanticAI-backed orchestration path for each GenAI scaffold rather than returning a successful placeholder result. The generated path MUST support offline tests through model injection or PydanticAI test models, and missing production model configuration MUST produce an explicit configuration error.

#### Scenario: Generated agent uses PydanticAI
- **WHEN** a GenAI project is generated
- **THEN** its orchestration module imports and constructs the approved PydanticAI agent boundary used by its API route

#### Scenario: Generated orchestration test stays offline
- **WHEN** the generated backend test suite runs without cloud model credentials
- **THEN** it exercises the agent contract through an injected or test model and performs no network model request

#### Scenario: Missing model configuration is not a fake success
- **WHEN** a generated application invokes production orchestration without required model configuration
- **THEN** it returns or raises a clear configuration failure instead of a placeholder answer presented as successful output

### Requirement: Generated messaging adapters perform the selected transport operation
The system SHALL generate Redis Streams and Azure Service Bus implementations behind the shared messaging interface. Redis publishing MUST append the payload to the configured stream, Azure publishing MUST send the payload to the configured queue or topic, and both implementations MUST be testable with injected clients.

#### Scenario: Local publisher appends to Redis Streams
- **WHEN** local configuration selects `redis-streams` and orchestration publishes a message
- **THEN** the generated adapter issues an `XADD`-equivalent operation with the configured stream and serialized payload

#### Scenario: Cloud publisher sends to Azure Service Bus
- **WHEN** cloud configuration selects `azure-service-bus` and orchestration publishes a message
- **THEN** the generated adapter sends the serialized payload through the configured asynchronous Service Bus sender

#### Scenario: Messaging tests require no external service
- **WHEN** the generated messaging unit tests run
- **THEN** injected fake clients verify the Redis and Azure operations without requiring Redis or Azure credentials

### Requirement: Generated observability reflects actual tracing state
The system SHALL generate a tracing boundary that initializes Langfuse when valid configuration is present and otherwise reports tracing as disabled. It MUST NOT emit a successful-looking remote trace identifier when no trace was sent.

#### Scenario: Configured tracing creates a Langfuse operation
- **WHEN** valid Langfuse configuration is present and a GenAI operation runs
- **THEN** the generated tracing boundary records the operation through the Langfuse client

#### Scenario: Unconfigured tracing is explicitly disabled
- **WHEN** Langfuse configuration is absent
- **THEN** the operation proceeds through an explicit disabled tracer without claiming that a remote trace exists

### Requirement: Generated frontends call the generated backend contract
The system SHALL generate a frontend starter that invokes the selected backend route through a configurable API base URL and exposes observable loading, success, and failure states. Generated source MUST safely encode project-derived text and MUST remain buildable without a running backend.

#### Scenario: Starter submits input to the backend
- **WHEN** a developer enters starter input and activates the generated action
- **THEN** the frontend calls the selected generated API route and displays the response

#### Scenario: Starter reports backend failure
- **WHEN** the generated backend request fails or returns a non-success status
- **THEN** the frontend clears its loading state and displays an actionable error

#### Scenario: Frontend build remains offline
- **WHEN** the generated frontend dependency install and production build run
- **THEN** the build succeeds without contacting a generated backend

### Requirement: Generated language stacks include complete dependency metadata
The system SHALL emit all deterministic dependency metadata required for a freshly generated stack to execute its documented build and test commands without a preparatory dependency-manifest rewrite.

#### Scenario: Fresh Go project tests without editing module metadata
- **WHEN** a standard Go project is generated and dependencies are downloaded
- **THEN** `go test ./...` succeeds without requiring `go mod tidy`, `go get`, or an unrecorded `go.sum` mutation

#### Scenario: Go checksums are tracked as a generated artifact
- **WHEN** the Go stack is rendered
- **THEN** its pinned `go.sum` content is recorded under an append-only logical name in `liftoff.manifest.json`

#### Scenario: Fresh Node and Python stacks retain their build contracts
- **WHEN** representative Node.js and Python projects are freshly generated
- **THEN** their documented dependency installation, build, and test commands continue to succeed
