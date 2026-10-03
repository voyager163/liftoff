## Purpose

Make Liftoff's supported stacks, clouds, workflows and agent delivery extensible through deterministic release-owned plugins without adding third-party execution or weakening core authority.

## ADDED Requirements

### Requirement: Supported plugins are bundled and release-owned
Liftoff SHALL expose a validated inventory of built-in first-party plugin identities, categories, API compatibility, content versions/digests and supported combinations. All enabled built-ins and their assets SHALL ship with the qualified CLI. The release SHALL NOT discover or execute third-party plugins from project directories, environment paths or package registries, or require npm to install a bundled capability.

#### Scenario: Native user selects a built-in stack
- **WHEN** a supported stack is selected from a native installation
- **THEN** its plugin and template assets are available without downloading plugin code

#### Scenario: Project supplies executable plugin content
- **WHEN** a repository contains a plugin-looking directory or configuration pointing to external code
- **THEN** Liftoff does not load or execute it
- **AND** an unsupported plugin request produces a precise error before generation

#### Scenario: Plugin inventory is invalid
- **WHEN** plugin IDs, compatible APIs, asset digests or explicit artifact declarations conflict or are missing
- **THEN** affected planning/generation fails rather than silently choosing a plugin or default template

### Requirement: Plugin composition preserves deterministic artifact identity
For a fixed release and project plan, plugin composition SHALL produce identical artifact bytes, logical identities, lifecycles and portable path parts independent of registration order, host OS or network availability. Plugin-specific templates/locks SHALL have one canonical source, and shared content SHALL not be independently duplicated per plugin. Modifications and deletions SHALL use exact registered artifact lookup, never plugin-directory ownership.

#### Scenario: Compare composition before and after extraction
- **WHEN** existing stacks are moved behind bundled plugin contracts without intentional behavior changes
- **THEN** their qualified generated output remains identical except separately versioned metadata changes
- **AND** existing logical artifact names retain their meanings

#### Scenario: Windows paths alias another contribution
- **WHEN** two contributions collide by case, embedded separators, drive/UNC escape or link/junction resolution
- **THEN** the composition or destination preflight rejects the conflict before any writes on every supported OS

### Requirement: Plugin contributions cannot grant mutation authority
Plugins SHALL contribute only capabilities allowed by the selected core operation. Project/provider effects SHALL require the same exact plan, approved scope, current inputs, ownership, verification and recovery rules as built-in core behavior. A declared capability, matching template hash or plugin upgrade SHALL not authorize mutation. Bundled executable plugins SHALL be documented as trusted code, not a security sandbox.

#### Scenario: Repair plugin requests an unapproved effect
- **WHEN** a plugin contribution adds an unapproved file, provider operation or network effect
- **THEN** validation rejects the plan or requires a new explicit approval before execution

#### Scenario: Plugin changes after preview
- **WHEN** a bound plugin or recipe identity differs from the reviewed plan
- **THEN** the old plan cannot execute and requires fresh review

### Requirement: Canonical Liftoff skills are delivered independently of models and frameworks
Setup, assessment, adoption and repair integrations SHALL share canonical behavior across selected Copilot, Claude and Codex hosts. They SHALL use supported native invocation forms, preserve existing managed integration identities, and negotiate actual CLI capabilities before acting. Manual workflow SHALL permit these integrations without OpenSpec/Spec Kit and SHALL permit no agent selection. No model-specific policy fork, model credential or separate skill SemVer SHALL be required.

#### Scenario: Manual project selects Codex
- **WHEN** Codex is selected without a spec framework
- **THEN** Liftoff's applicable native skills are delivered without framework workflow files or another agent requirement

#### Scenario: Installed CLI lacks a required operation
- **WHEN** a skill's capability check finds an unsupported command, schema or recipe
- **THEN** it stops and explains the supported CLI upgrade path
- **AND** it does not emulate the missing operation with direct project writes or fabricated receipts

#### Scenario: Agent proposes a semantic repair
- **WHEN** the selected host proposes application changes
- **THEN** it stages an exact patch outside the project for independent CLI verification and write approval
- **AND** host autonomy or model confidence cannot supply that approval
