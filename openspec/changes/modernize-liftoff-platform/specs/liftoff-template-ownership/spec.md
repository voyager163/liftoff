## ADDED Requirements

### Requirement: Plugin and layout bindings do not confer file ownership
Plugin membership and active layout bindings SHALL identify only exact registered logical artifacts and their interpretation. They SHALL not make directories, compatible custom source, historical files or adopted application bytes managed core. Generation hashes remain provenance only. A layout change SHALL require its own explicit approved binding/file inventory with preserved original provenance.

#### Scenario: Adopt a compatible existing folder
- **WHEN** adoption binds a supported application component at its existing path
- **THEN** the component remains project-owned and its adoption observation is not fabricated generation provenance

#### Scenario: Plugin stops emitting an artifact
- **WHEN** an existing artifact is absent from a newer plugin
- **THEN** only an exact declared retirement and its existing authority can authorize removal
- **AND** a missing plugin entry does not authorize recursive cleanup

#### Scenario: Windows alias would expand ownership
- **WHEN** a binding or plugin artifact resolves through a case alias, unsafe junction or traversal
- **THEN** ownership validation rejects it before mutation on all supported hosts

### Requirement: Adoption and workflow transitions have independent exact write inventories
Approved adoption and workflow transitions SHALL name every permitted metadata, integration, configuration, application-patch and history effect separately. They SHALL preserve unlisted files, framework documents, original Git history, secrets and deployed state. Ordinary update/force, a generic agent request or an existing template hash SHALL not grant this authority. Repository-scoped heartbeat files outside a nested project SHALL require their own reviewed repository boundary and inventory.

#### Scenario: Framework is switched to Manual
- **WHEN** a workflow transition commits its exact approved identity/integration changes
- **THEN** old framework specifications/history and unrelated skills remain unchanged
- **AND** no framework-directory deletion or global uninstall is inferred

#### Scenario: A nested project enables a heartbeat
- **WHEN** the shared repository workflow needs a new explicit project entry
- **THEN** repository-level write scope is reviewed separately and other projects' entries remain protected
