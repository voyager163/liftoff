## MODIFIED Requirements

### Requirement: The legacy scan is deterministic and feeds prompts and plan
The system SHALL scan the source project read-only for Python, Node.js, and Go dependency files; framework indicators; GenAI and retrieval indicators; environment files; Docker assets; CI workflows; tests; database migrations; frontend indicators; and spec-workflow directories. The scan SHALL run before prompting, its inventory SHALL drive both prompt pre-fill and migration task seeding, and every top-level entry not matched by an explicit detection rule SHALL surface as a placement-decision task.

#### Scenario: Scan detects common Python assets
- **WHEN** the source project contains `requirements.txt`, `.env`, a `Dockerfile`, and a `tests/` directory
- **THEN** the inventory records each finding with its source path

#### Scenario: Scan detects Node.js API evidence
- **WHEN** the source project contains `package.json` with Fastify and TypeScript dependencies
- **THEN** the inventory records strong evidence for the approved standard Node.js API stack

#### Scenario: Scan detects Go API evidence
- **WHEN** the source project contains `go.mod` and Go source using Huma or Chi
- **THEN** the inventory records strong evidence for the approved standard Go API stack

#### Scenario: Nothing is silently dropped
- **WHEN** the source project contains a top-level directory no explicit detection rule recognizes
- **THEN** the emitted plan includes a task to decide that directory's placement

#### Scenario: Scan paths are cross-platform
- **WHEN** migration scans a project on Windows, macOS, or Linux
- **THEN** evidence source paths and staged destinations are resolved with platform-correct path handling while emitted logical paths remain portable

### Requirement: Prompt pre-fill is evidence-based with visible provenance
The system SHALL pre-fill project type, API stack, GenAI pattern, and common creation decisions only from strong scan evidence, SHALL display the evidence alongside each pre-filled default, and SHALL leave a decision unresolved when evidence is weak or conflicting. The developer SHALL be able to override every pre-filled value, and non-interactive runs with `--yes` SHALL follow the same semantics as `create`.

#### Scenario: Strong standard Node.js evidence pre-fills with provenance
- **WHEN** the scan finds Fastify and TypeScript dependencies without GenAI dependencies
- **THEN** the standard project type and Node.js/Fastify API stack are pre-filled
- **AND** the CLI displays the dependency file that supplied the evidence

#### Scenario: Strong GenAI evidence pre-fills with provenance
- **WHEN** the scan finds PydanticAI and retrieval dependencies
- **THEN** GenAI project type, Python/FastAPI API stack, and RAG pattern may be pre-filled
- **AND** the CLI displays the evidence for each decision

#### Scenario: Weak evidence leaves type-specific decisions blank
- **WHEN** the scan finds no strong project-type or API-stack indicator
- **THEN** the project-type question is presented without a pre-filled default derived from the scan

#### Scenario: Conflicting evidence requires developer choice
- **WHEN** the scan finds strong evidence for more than one API stack or both standard and GenAI application behavior
- **THEN** the CLI reports the conflicting evidence and requires the developer to choose before generation

## ADDED Requirements

### Requirement: Migration output reflects the target project type and API stack
The system SHALL generate the fresh target scaffold and migration plan using the resolved project type and API stack, and SHALL map detected source material to destinations valid for that stack.

#### Scenario: Migrate a standard Go project
- **WHEN** a developer confirms a standard Go/Huma migration plan
- **THEN** the fresh scaffold uses the Go backend layout and database tooling
- **AND** migration tasks map source handlers, configuration, tests, and migrations to Go-specific target locations without introducing GenAI tasks

#### Scenario: Migrate a GenAI project
- **WHEN** a developer confirms a GenAI migration plan
- **THEN** the emitted proposal identifies the GenAI pattern and Python/FastAPI/PydanticAI stack
