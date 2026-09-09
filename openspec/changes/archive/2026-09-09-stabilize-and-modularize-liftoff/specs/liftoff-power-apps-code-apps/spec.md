## REMOVED Requirements

### Requirement: Power Apps code apps are a first-class Liftoff workload
**Reason**: Power Apps support is fully retired for this change. Liftoff no longer offers Power Apps as an active workload or a compatibility lane.

**Migration**: Existing Power Apps repositories remain outside Liftoff generation, update, and governance setup flows unless a developer manually recreates them as a supported standard API or GenAI project. Liftoff MUST reject Power Apps inputs explicitly instead of silently selecting or converting another workload.

### Requirement: Power Apps projects use a pinned official starter
**Reason**: The packaged Microsoft starter snapshot, archive hashes, explicit copied-file inventory, and commit-addressed source-commit coupling are retired together with the workload.

**Migration**: Remove active Power Apps starter, archive, and source-commit compatibility inventory from supported generation paths. Historical Power Apps metadata, if retained for diagnostics, is no longer a runnable or upgradable scaffold source.

### Requirement: Generated Power Apps projects expose the tested Code Apps stack
**Reason**: Liftoff no longer generates new Power Apps application scaffolds.

**Migration**: Developers who need a supported Liftoff scaffold must create a GenAI or standard API project. Existing Power Apps application files are not converted in place.

### Requirement: Power Apps dependency setup is project-local and separately authorized
**Reason**: Retired workloads no longer participate in Liftoff dependency planning or installation flows.

**Migration**: Liftoff stops emitting Power Apps dependency commands and stops treating Power Apps root package metadata as a supported generated install surface.

### Requirement: Power Platform environment binding remains developer-controlled
**Reason**: Liftoff no longer provisions or guides Power Apps environment setup because the workload is retired rather than maintained.

**Migration**: Existing Power Platform environment binding remains entirely external to Liftoff. Retired projects are rejected instead of receiving updated Power Platform setup guidance.

### Requirement: Power Apps projects retain spec-driven multi-agent integration
**Reason**: Power Apps projects are no longer initialized as Liftoff-managed projects, so Liftoff no longer bootstraps OpenSpec or Spec Kit into them.

**Migration**: Supported spec-driven integrations continue only for GenAI and standard API projects. Existing Power Apps repositories keep any preexisting framework files as developer-owned history outside new Liftoff initialization.

### Requirement: The Microsoft Code Apps agent plugin is an optional preview enhancement
**Reason**: The Power Apps-only preview plugin has no supported workload remaining in Liftoff.

**Migration**: Liftoff removes plugin preference capture, probing, and guidance from supported flows. Developers who keep historical Power Apps repositories manage plugin usage outside Liftoff.

### Requirement: Power Apps baseline upgrades preserve upstream ownership
**Reason**: There is no longer an active Power Apps baseline to refresh or preserve.

**Migration**: Supported baseline maintenance removes Power Apps starter refresh work instead of carrying an active or historical source-commit upgrade lane forward.

### Requirement: Power Apps projects receive only applicable repository governance
**Reason**: Liftoff no longer initializes or governs Power Apps projects as supported workloads.

**Migration**: Repository-governance setup applies only to supported GenAI and standard API projects. A retired Power Apps repository may still be inspected as historical source, but Liftoff does not generate workload-specific governance assets for it.

## ADDED Requirements

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
