## ADDED Requirements

### Requirement: Standard project workstation readiness is stack-specific
The system SHALL select blocking runtime requirements and project dependency commands from the approved standard API stack. It SHALL NOT block a standard project on runtimes used only by unselected stacks.

#### Scenario: Python standard project readiness
- **WHEN** a developer initializes a standard Python/FastAPI project
- **THEN** Liftoff requires the supported Python runtime and offers the Python virtual-environment dependency flow
- **AND** it does not require Go

#### Scenario: Node.js standard project readiness
- **WHEN** a developer initializes a standard Node.js/Fastify project
- **THEN** Liftoff requires the supported Node.js runtime and offers the lockfile-preserving Node.js dependency flow
- **AND** it does not require the Python backend runtime or Go

#### Scenario: Go standard project readiness
- **WHEN** a developer initializes a standard Go/Huma project
- **THEN** Liftoff requires the supported Go toolchain and offers the generated-module download flow
- **AND** it does not require the Python backend runtime

#### Scenario: Spec Kit adds only its own prerequisite
- **WHEN** a Node.js or Go standard project selects Spec Kit
- **THEN** Python and `uv` requirements needed by the pinned Spec Kit CLI are identified as framework prerequisites
- **AND** they are not presented as backend runtime requirements

## MODIFIED Requirements

### Requirement: Developers can create standard projects
The system SHALL let developers identify a project as either GenAI or standard during `liftoff init` before collecting type-specific project decisions, SHALL require a GenAI pattern only for GenAI projects, and SHALL require an approved API stack only for standard projects.

#### Scenario: Select a standard project interactively
- **WHEN** a developer runs `liftoff init` interactively and answers no to the GenAI project question
- **THEN** the CLI skips the GenAI pattern prompt
- **AND** the CLI asks the developer to select an approved standard API stack

#### Scenario: Select a GenAI project interactively
- **WHEN** a developer answers yes to the GenAI project question
- **THEN** the CLI asks for one of the supported GenAI patterns
- **AND** the generated API stack remains Python/FastAPI with PydanticAI

