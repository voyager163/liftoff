## Purpose

Give developers one read-only view of project conformance, uncertainty and scoped remediation across layout, workflows, plugins, dependencies, governance, infrastructure and documentation.

## ADDED Requirements

### Requirement: Whole-project assessment is read-only and installed-target bound
Liftoff SHALL expose `liftoff assess [project] [--governance <profile>] [--json] [--live]` for supported Liftoff projects and safely identified non-Liftoff project roots. It SHALL compare against the installed release's explicitly selected profile, plugins and supported layout rules without resolving latest versions. An explicit comparison profile SHALL not change recorded project selection. Local assessment SHALL perform no network, project script, installation, enrollment, telemetry/disclosure, approval, receipt or project write. Live mode SHALL allow only explicitly scoped metadata reads with existing permissions.

#### Scenario: Assess before adoption
- **WHEN** an ordinary supported application is assessed without a Liftoff manifest
- **THEN** the report distinguishes observed application facts from missing Liftoff metadata
- **AND** it does not initialize the project or invent historical provenance

#### Scenario: Assess a Manual project offline
- **WHEN** a Manual project is assessed without a framework or agent installed
- **THEN** assessment evaluates applicable project standards without requiring either tool
- **AND** cloud proof not collected remains explicitly unobserved

#### Scenario: Unsafe inner project boundary
- **WHEN** a manifest or selected root is malformed, retired, linked unsafely or ambiguous
- **THEN** assessment reports that boundary rather than selecting an outer project as fallback

### Requirement: Findings preserve compatible layouts and explicit unknowns
Assessment SHALL compose layout, declared dependency/runtime, workflow/agent, managed-core/plugin, governance, infrastructure and documentation observations into deterministic findings with stable identity, expected/observed values, provenance, scope, availability and coverage. It SHALL preserve aligned, outdated, missing, conflicting, approved-exception, inapplicable and not-observed distinctions. Compatible customized layouts SHALL not fail solely because their paths differ from fresh templates.

#### Scenario: Existing backend satisfies the standard at another path
- **WHEN** an explicit supported binding and relevant references establish an equivalent application layout
- **THEN** assessment reports that compatibility without recommending an unnecessary canonical-folder move

#### Scenario: Reference coverage is incomplete
- **WHEN** dynamic imports, unknown build configuration or inventory limits prevent a trustworthy mapping
- **THEN** the report identifies the unresolved scope
- **AND** it neither claims full compliance nor recommends an unverified automatic move

#### Scenario: Windows project has spaces and case-sensitive references
- **WHEN** assessment inspects the selected project on Windows, macOS or Linux
- **THEN** native path resolution and portable logical bindings agree
- **AND** case aliases, traversal and link/junction escapes are rejected rather than normalized into conformance

### Requirement: Assessment recommendations identify separate executable authorities
Reports SHALL distinguish managed update, application repair, in-place adoption, workflow/profile migration, new-environment activation and deferred existing-deployment work. They SHALL identify only actual installed capabilities and their independent consent requirements. Assessment SHALL never execute its recommendations or treat a successful report as write approval, activation evidence or cloud ownership.

#### Scenario: Managed and application changes coexist
- **WHEN** a project needs updated integrations and a semantic source change
- **THEN** recommendations separate reviewed update from independently verified application repair
- **AND** force-update is not offered as application migration authority

#### Scenario: Existing Azure deployment needs import
- **WHEN** conformance would require changing pre-existing deployed state or resource ownership
- **THEN** assessment reports planning-only scope and the deferred capability
- **AND** it offers no public executable state-import/migration command for this release

### Requirement: Assessment has equivalent CLI and agent interpretation
Whole-project reports SHALL use schema 1 with an explicit read-only indicator, target identity, findings, coverage, diagnostics and outcome. Exit 0 SHALL require complete applicable alignment or explicitly inapplicable requested scope; exit 2 SHALL indicate differences or incomplete coverage; exit 1 SHALL indicate invalid input or inability to produce a trustworthy report. The `liftoff-assess` integration SHALL explain the same report without inventing findings or running repairs. Existing `governance assess` SHALL retain its narrower contract.

#### Scenario: All observed controls pass but some remain unknown
- **WHEN** applicable observations are incomplete
- **THEN** overall assessment returns partial with exit 2 rather than unqualified alignment

#### Scenario: User requests only an agent explanation
- **WHEN** the agent receives a valid assessment report
- **THEN** it explains evidence and limits and stops without mutating the project or providers
