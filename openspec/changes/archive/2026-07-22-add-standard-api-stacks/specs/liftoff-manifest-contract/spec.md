## ADDED Requirements

### Requirement: Manifests record project type and API stack
The system SHALL record the resolved project type and API stack in `liftoff.manifest.json`, SHALL record a GenAI pattern only for GenAI projects, and SHALL validate that each project-type/API-stack/pattern combination is supported.

#### Scenario: Record a standard project
- **WHEN** Liftoff generates a standard Node.js project
- **THEN** the manifest records project type `standard` and API stack `node-fastify`
- **AND** the manifest project object does not require a GenAI pattern

#### Scenario: Record a GenAI project
- **WHEN** Liftoff generates a RAG project
- **THEN** the manifest records project type `genai`, API stack `python-fastapi`, and pattern `rag`

#### Scenario: Reject an invalid project identity
- **WHEN** a manifest or desired-state configuration combines standard project type with a GenAI pattern or combines GenAI project type with a non-Python API stack
- **THEN** the CLI fails with a message identifying the unsupported combination and a corrective action

### Requirement: Manifest readers normalize legacy GenAI identity
The system SHALL interpret supported legacy manifests and configuration files that contain a GenAI pattern but lack project type and API stack as GenAI projects using the Python/FastAPI stack.

#### Scenario: Read an existing v2 GenAI manifest
- **WHEN** a current CLI reads a supported v2 manifest containing pattern `chatbot` without project type or API stack
- **THEN** downstream validation, update, and doctor behavior uses normalized project type `genai` and API stack `python-fastapi`
- **AND** the existing project remains usable without a manual manifest edit

#### Scenario: Rewrite normalized identity
- **WHEN** `liftoff update --apply` successfully rewrites a legacy manifest
- **THEN** the new manifest explicitly records the normalized project type and API stack at the latest supported schema
