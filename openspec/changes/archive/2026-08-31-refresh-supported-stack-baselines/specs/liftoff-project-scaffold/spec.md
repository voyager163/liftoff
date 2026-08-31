## MODIFIED Requirements

### Requirement: Generated language stacks include complete dependency metadata
The system SHALL emit all deterministic dependency metadata required for every freshly generated workload to execute its documented install, build, lint, and test commands without a preparatory dependency-manifest rewrite. npm projects SHALL include tested lockfiles, Python projects SHALL include tracked `uv.lock` files and frozen synchronization commands, Go projects SHALL include complete module checksums, and Azure Functions dependency exports SHALL be reproducible from the corresponding locked Python graph.

#### Scenario: Fresh Go project tests without editing module metadata
- **WHEN** a standard Go project is generated and dependencies are downloaded
- **THEN** `go test ./...` succeeds without requiring `go mod tidy`, `go get`, or an unrecorded `go.sum` mutation

#### Scenario: Go checksums are tracked as a generated artifact
- **WHEN** the Go stack is rendered
- **THEN** its pinned `go.sum` content is recorded under an append-only logical name in `liftoff.manifest.json`

#### Scenario: Fresh Node and Python stacks retain their build contracts
- **WHEN** representative Node.js and Python projects are freshly generated
- **THEN** their documented dependency installation, build, and test commands continue to succeed

#### Scenario: Fresh Node stack retains its build contract
- **WHEN** a representative Node.js project is freshly generated
- **THEN** its documented `npm ci`, build, and test commands succeed
- **AND** package metadata remains byte-for-byte unchanged

#### Scenario: Fresh Python stack installs from a frozen lock
- **WHEN** a representative Python project is freshly generated
- **THEN** its documented `uv sync --frozen` command succeeds from the tracked lock
- **AND** build and test commands use the synchronized project environment without changing dependency metadata

#### Scenario: Fresh Power Apps project has a tested lockfile
- **WHEN** a Power Apps code app is freshly generated
- **THEN** its root package and lockfile identities match
- **AND** `npm ci`, lint, and production build succeed without rewriting package metadata

#### Scenario: Generate dependency paths across platforms
- **WHEN** the same project is rendered on Windows, macOS, and Linux
- **THEN** each lock or dependency artifact uses the same logical name and path-part array
- **AND** platform-specific execution commands resolve the project environment without hardcoded path separators

## ADDED Requirements

### Requirement: Generated local services and runtime images are immutable
The system SHALL render each Dockerfile base and Docker Compose service image from an explicit supported-stack baseline entry containing a stable release tag and immutable multi-architecture manifest digest. Generated output SHALL NOT use `latest`, an unqualified image name, or a mutable major-only reference.

#### Scenario: Inspect generated Compose images
- **WHEN** a GenAI or standard API project is generated
- **THEN** PostgreSQL or pgvector, Redis, Azurite, Mailpit, and applicable Langfuse image references are bound to tested immutable digests

#### Scenario: Inspect generated runtime stages
- **WHEN** a Python, Node.js, Go, or frontend container file is rendered
- **THEN** every base stage is bound to the runtime and operating-system image digest recorded by the baseline

#### Scenario: Baseline image lacks a host architecture
- **WHEN** an image refresh does not expose every architecture required by the supported generated-project matrix
- **THEN** baseline verification fails before the image reference can be packaged
