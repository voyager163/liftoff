## MODIFIED Requirements

### Requirement: Manifest readers normalize legacy GenAI identity
The system SHALL interpret supported v2 and v3 manifests and configuration files that contain a GenAI pattern but lack project type and API stack as GenAI projects using the Python/FastAPI stack. It SHALL normalize valid flat v3 standard identity into the schema-v4 internal workload model without fabricating Power Apps identity.

#### Scenario: Read an existing v2 GenAI manifest
- **WHEN** a current CLI reads a supported v2 manifest containing pattern `chatbot` without project type or API stack
- **THEN** downstream validation, update, and doctor behavior uses normalized workload kind `genai` and API stack `python-fastapi`
- **AND** the existing project remains usable without a manual manifest edit

#### Scenario: Read an existing v3 standard manifest
- **WHEN** a current CLI reads a supported v3 manifest containing project type `standard` and API stack `go-huma`
- **THEN** downstream behavior uses the equivalent standard workload union member and preserves its framework integrations

#### Scenario: Rewrite normalized identity
- **WHEN** plain `liftoff update` successfully rewrites a valid v2 or v3 manifest
- **THEN** the new schema-v4 manifest explicitly records the normalized discriminated workload identity

### Requirement: Legacy v2 manifests normalize framework state without false claims
The system SHALL continue to accept valid v2 manifests and SHALL normalize their missing framework and agent metadata as explicit legacy state. A v2 reader SHALL NOT infer that any agent integration was officially initialized. A later v3 or v4 rewrite SHALL preserve that uncertainty unless the project has gone through a supported framework-initialization flow.

#### Scenario: Read v2 project identity
- **WHEN** a valid v2 manifest contains a spec workflow but no framework contract or agent list
- **THEN** downstream validation, doctor, and update behavior treats the framework state as legacy with no declared agent integrations

#### Scenario: Rewrite v2 without fabricating agents
- **WHEN** plain `liftoff update` rewrites a valid v2 project without running framework initialization
- **THEN** the current manifest schema records legacy framework state and no configured agents
- **AND** it does not claim that Copilot or Claude Code was installed or integrated
