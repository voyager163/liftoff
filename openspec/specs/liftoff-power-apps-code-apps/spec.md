## Purpose

Define Liftoff's Power Apps workload lifecycle and compatibility boundaries, including explicit unsupported-workload behavior when that workload is retired.

## Requirements

### Requirement: Recognized Power Apps inputs are rejected as retired workloads
The system SHALL reject `power-apps-code-app` CLI selections, manifest workload discriminators, and other recognized Power Apps workload metadata as an unsupported retired workload before scaffold generation, baseline or source-commit lookup, dependency planning, governance handoff, or ordinary Git assessment fallback. The rejection MUST identify Power Apps retirement, MUST leave project files unchanged, and MUST NOT reinterpret the request as a GenAI project, standard API project, or ordinary Git assessment target.

#### Scenario: Reject a retired CLI workload request
- **WHEN** a developer selects Power Apps during interactive initialization or passes `--type power-apps-code-app` to a Liftoff command
- **THEN** Liftoff exits unsuccessfully with an explicit retired-workload message
- **AND** it writes no application, framework, dependency, or infrastructure files

#### Scenario: Reject a retired manifest before deeper interpretation
- **WHEN** a Liftoff command reads a project manifest whose workload discriminator is `power-apps-code-app`
- **THEN** it stops at the retired-workload boundary and reports the unsupported workload
- **AND** it does not continue into starter metadata, source-commit compatibility, provider setup, or project mutation

#### Scenario: Ordinary Git assessment does not bypass a retired manifest
- **WHEN** governance assessment is invoked at a Git root that contains a retired Power Apps Liftoff manifest
- **THEN** Liftoff reports the retired workload boundary for that repository root
- **AND** it does not ignore the manifest and fall back to ordinary Git assessment for the same path
