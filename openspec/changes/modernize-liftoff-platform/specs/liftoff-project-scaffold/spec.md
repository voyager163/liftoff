## REMOVED Requirements

### Requirement: Generated projects include a v7 Liftoff manifest
**Reason**: Current generation must emit schema 8 with explicit profile/component identity and truthful provenance rather than retain a v7 writer.
**Migration**: New scaffolds use v8. Supported v2-v7 projects remain readable and require a separately reviewed manifest or activation transition; generation does not rewrite them.

## ADDED Requirements

### Requirement: Generated projects include a v8 Liftoff manifest
The system SHALL include `liftoff.manifest.json` at the root of every generated GenAI or standard API project using schema 8. It SHALL record the exact manifest-writing CLI, selected release-owned profile/component identities, discriminated workload, spec workflow, canonical coding-agent selection, applicable default agent, tested framework contract, governance profile/handoff state, applicable activation identity, managed-core reconciliation hashes, and actual project generation provenance. GenAI SHALL retain one of the nine supported pattern identities and honest implemented capabilities. Desired-state, framework, and one-time seed content SHALL remain outside managed-core hashes. Existing adopted bytes SHALL not be described by this generation contract.

#### Scenario: Manifest accompanies every initialized workload
- **WHEN** a developer initializes a GenAI or standard API project
- **THEN** the root contains a schema-8 manifest with exactly the applicable workload, profile/component, governance, managed-core, and provenance fields

#### Scenario: Manifest validates against generated files
- **WHEN** `liftoff validate` runs against a freshly initialized project
- **THEN** it confirms every managed-core artifact and declared framework marker
- **AND** it structurally validates project provenance without requiring production bytes to remain unchanged

#### Scenario: Enabled governance records only handoff state
- **WHEN** a project enables `single-maintainer-gitflow`
- **THEN** its v8 manifest records the profile, policy version, activation identity, and `handoff-generated`
- **AND** it does not claim live GitHub enforcement

#### Scenario: Disabled governance omits handoff artifacts
- **WHEN** a project selects `none`
- **THEN** its v8 manifest records governance as disabled
- **AND** contains no managed governance policy, context, guide, or setup integration entry

#### Scenario: GenAI manifest records the selected pattern without fabricating specialization
- **WHEN** a GenAI project is initialized for any supported pattern
- **THEN** the manifest records that exact pattern and applicable workload preferences
- **AND** it does not claim retrieval, history, tools, coordination, fine-tuning, or incremental streaming absent from the generated application

#### Scenario: Power Apps manifest omits API identity
- **WHEN** a command encounters the retired Power Apps discriminator, with or without additional API fields
- **THEN** it rejects that boundary before interpreting deeper former-workload fields
- **AND** it leaves the original manifest unchanged and emits no supported Power Apps manifest

#### Scenario: Framework and seed ownership remains external
- **WHEN** an official initializer or Liftoff seed writes content
- **THEN** its declared contract is validated without managed-core hash ownership
- **AND** the separate governance handoff remains managed by exact logical name

### Requirement: Generation composes one explicit packaged template catalog
Liftoff SHALL compose supported project profiles from one versioned release-owned template catalog and reusable common, backend, GenAI, frontend, infrastructure, and workflow components, together with canonical governance, skills, pinned locks, and supported-stack resources. Conditional output SHALL reflect the selected supported workload, pattern, environments, agents, and framework contract. Catalog entries SHALL identify exact component revisions and complete artifact inventories. Generation SHALL NOT download mutable template branches, keep independent whole-starter copies for every combination, or substitute a partial template when a required component is missing.

#### Scenario: Compose two backend profiles with a common frontend
- **WHEN** supported FastAPI and Fastify plans both select Vue and equivalent common options
- **THEN** both use the same declared reusable frontend and common component contracts with their respective backend inventories
- **AND** component reuse does not introduce GenAI dependencies into standard projects

#### Scenario: Compose a GenAI pattern
- **WHEN** any of the nine supported GenAI patterns is selected
- **THEN** only its declared common and pattern-specific components are emitted
- **AND** existing maturity labels and exclusions remain accurate rather than treating a component name as completed specialization

#### Scenario: A required catalog component is unavailable
- **WHEN** a selected profile references a missing, invalid, incompatible, or digest-mismatched packaged resource
- **THEN** generation reports that exact resource failure before destination mutation
- **AND** it does not fetch an upstream replacement or silently omit required output

### Requirement: Composed artifacts retain exact immutable logical identities
Every emitted artifact SHALL have an exact registered logical name, portable destination, lifecycle, and component identity. Existing append-only logical names SHALL remain stable except for explicitly inventoried retirements or reviewed path migrations. Composition SHALL reject duplicate owners, incompatible revisions, duplicate destinations, and case or normalization collisions before merging staged output. Artifact modification or deletion SHALL select explicit registered identities, never prefixes, glob matches, category names, or complete starter-directory replacement.

#### Scenario: Shared components would emit the same destination
- **WHEN** two selected components claim one destination with incompatible ownership or bytes
- **THEN** staging fails with both exact identities identified
- **AND** enumeration order does not select a winning file

#### Scenario: A component is revised
- **WHEN** a release changes an existing component's generated content
- **THEN** its existing logical artifact identities retain their meanings and the new resource identity is recorded
- **AND** the change grants no write authority over files already owned by an existing application

#### Scenario: Compose paths on Windows
- **WHEN** equivalent plans are composed on Windows, macOS, or Linux
- **THEN** logical names, lifecycle declarations, and portable path parts agree
- **AND** native resolution rejects drive/UNC escapes, embedded separators, unsafe links or junctions, and case/normalization collisions before writes

### Requirement: Packaged generation resources are independent of the checkout and cwd
Installed generation SHALL resolve its declared catalogs, templates, locks, governance assets, and skill sources from the verified release resources rather than the caller's directory, a build checkout, or a mutable external source. Resource access SHALL work after supported relocation and from read-only installation directories on Windows, macOS, and Linux. Staging SHALL use the existing private generation transaction and SHALL NOT make the installation directory or project source a writable resource cache.

#### Scenario: Generate from an unrelated directory
- **WHEN** the installed CLI is invoked outside its installation or source checkout
- **THEN** it resolves the same packaged component identities and generated bytes
- **AND** a similarly named local template directory cannot replace release-owned resources

#### Scenario: The installation path is read-only and contains spaces
- **WHEN** a qualified installation is relocated to a supported native path with spaces and no write permission
- **THEN** generation reads the packaged resources and stages output through its declared writable workspace
- **AND** no Windows, macOS, or Linux resource path depends on POSIX-only separators

#### Scenario: A packaged asset is damaged
- **WHEN** required resource integrity or identity validation fails
- **THEN** generation stops with the causal asset diagnostic before committing target files
- **AND** it does not fall back to the build checkout or a runtime download

### Requirement: Generated backend documentation satisfies one prefix-safe contract
Generated Go/Huma and Node.js/Fastify handlers SHALL remove hard-coded origin-root schema references, and standard Python/FastAPI and all supported GenAI variants SHALL satisfy the same Scalar/OpenAPI routing contract. Canonical and trailing-slash documentation and schema routes SHALL work directly and behind a prefix-stripping proxy, preserve query strings through relative canonicalization redirects, and return the actual JSON schema rather than frontend HTML. Qualification SHALL compare application schema `paths` and `components` across the route variants without requiring production model credentials.

#### Scenario: Generate Go and Node backends
- **WHEN** either affected backend profile is generated
- **THEN** its Scalar schema reference resolves under the browser-visible prefix for canonical and trailing-slash entry points
- **AND** the equivalent defect is not left in one language after fixing the other

#### Scenario: Qualify Python and GenAI variants
- **WHEN** standard FastAPI and supported GenAI documentation routes are exercised
- **THEN** the same direct/proxied, redirect, query, content-type, and schema-equality checks pass
- **AND** absence of model credentials does not require a fabricated schema response

#### Scenario: Existing handlers remain project-owned
- **WHEN** a new release changes generated documentation handlers
- **THEN** existing project handlers remain unchanged until a separately approved per-file evolution plan is applied
- **AND** ordinary managed update does not copy the new backend template over them

## MODIFIED Requirements

### Requirement: Generated manifests identify the activation contract
Governed generated projects SHALL use manifest 8 and distinguish the writing CLI from the exact release-owned activation package identity. The current tuple SHALL identify policy 8, activation contract 4, graph schema 3 with its computed canonical hash and phase-contract digests, state/evidence-header/approval-envelope schemas 4, compatibility metadata 5, credential-policy schema 2, and unchanged supersession schema 1. Governance output 3, public protocol 1, and repair contract 1 with unchanged schema-2 records SHALL remain independent identities. Exact source and target tuples SHALL be registered before current output is enabled. Historical v1/v2/v3 proof and the exact pre-amendment policy-7/credential-policy-schema-1 candidate SHALL require their declared transitions and fresh proof, not retagging. Generated credential schemas and guidance SHALL disclose the actual provider grant without creating credentials, policy success records or execution approval. Skills SHALL use managed hashes and capability/schema requirements without independent per-skill SemVer or invented graph digests.

#### Scenario: Generate a governed project
- **WHEN** initialization writes the v8 manifest and governance artifacts
- **THEN** every activation identity matches the actual registered packaged policy, graph, phase digests, and schemas
- **AND** CLI, command-output, public-protocol, and repair identities remain distinct

#### Scenario: Setup integration wording changes
- **WHEN** thin setup integration bytes change
- **THEN** their managed content hashes change without retagging activation proof or introducing a setup-skill version

### Requirement: Governed projects include one deterministic setup entry point
When governance is enabled, Liftoff SHALL compose one canonical `liftoff-setup` journey into each selected agent's registered native projection. Copilot and Claude SHALL retain `/liftoff-setup`; Codex SHALL retain its native `$liftoff-setup` skill until reviewed migration. Delivery SHALL check the qualified host matrix, ownership, and overlapping discovery roots rather than blindly install copies. Setup SHALL negotiate CLI capabilities and guide local readiness plus the requested reviewed migration, repository-only, or activation journey through exact CLI scopes. It SHALL obtain independent authority before effects, support local-only operation, and verify actual selected-scope outcomes rather than stop unconditionally after local preparation or invent model/command aliases.

#### Scenario: Generate Copilot setup
- **WHEN** GitHub Copilot is selected
- **THEN** its native `/liftoff-setup` integration begins with local scope and continues through the requested approved journey

#### Scenario: Generate Claude setup
- **WHEN** Claude Code is selected
- **THEN** its equivalent native command has the same end-to-end scope and approval contract

#### Scenario: Generate both agents
- **WHEN** Copilot and Claude are selected
- **THEN** their setup projections reference the same canonical workflow, graph, and user-owned state
- **AND** neither declares or asks for a model

#### Scenario: Execute a ready approval-free phase
- **WHEN** setup observes a ready local phase whose declared effects require no additional approval
- **THEN** it uses explicit local-scoped apply-next execution and verifies the actual outcome
- **AND** consistent incomplete local verification is not described as inconsistency or permission for automatic activation

#### Scenario: Generate Codex setup
- **WHEN** Codex is selected without a reviewed transport migration
- **THEN** `.agents/skills/liftoff-setup/SKILL.md` has valid native metadata and the same repair/activation/resume approval contract
- **AND** guidance invents neither a Codex slash-command file nor a global custom prompt

#### Scenario: Local setup finishes
- **WHEN** the selected-scope CLI reports local completion
- **THEN** the integration reports that milestone and presents the next plan for the requested repository-only or full-activation journey
- **AND** it performs no publication or provider effect without required explicit authority

#### Scenario: Full activation finishes
- **WHEN** required current deployment, qualification, and enforcement readback are verified
- **THEN** the setup integration reports the requested immediate journey complete
- **AND** future lifecycle work is shown separately

#### Scenario: Repository-only setup finishes
- **WHEN** the selected repository scope has actual positive/negative check evidence, approved controls, and current readback
- **THEN** setup reports repository enforcement complete and separately reports pending or blocked Azure/production work
- **AND** repository proof does not satisfy full-activation qualification

### Requirement: Governed projects include a distinct read-only assessment integration
When governance is enabled, Liftoff SHALL compose the canonical distinct `liftoff-governance-assess` integration for every selected supported agent using exact registered ownership and collision-aware host projections. Copilot and Claude SHALL retain their native slash entry points; Codex SHALL retain `$liftoff-governance-assess` or its skill picker until reviewed migration. Governance assessment SHALL remain distinct from setup and the new whole-project `assess` workflow, negotiate supported CLI contracts, require no model selection or independent skill version, and delegate findings to the CLI. It SHALL not run automatically during initialization or replace the primary local setup recommendation.

#### Scenario: Generate both supported agents
- **WHEN** GitHub Copilot and Claude Code are selected with governance enabled and no transport migration
- **THEN** the project contains `.github/prompts/liftoff-governance-assess.prompt.md` and `.claude/commands/liftoff-governance-assess.md`
- **AND** both reference the same canonical assessment contract and governance context

#### Scenario: Generate one selected agent
- **WHEN** only one supported coding agent is selected
- **THEN** only its declared assessment projection is generated and tracked
- **AND** neighboring framework-owned files and overlapping personal discovery are not silently claimed

#### Scenario: Governance is disabled
- **WHEN** the plan selects `none`
- **THEN** no project governance-assessment integration is generated
- **AND** initialization performs no assessment or live collection, while separately installed personal assessment assistance remains independent

#### Scenario: Invoke assessment through an agent
- **WHEN** a developer invokes the selected agent's governance-assessment integration
- **THEN** it calls supported `liftoff governance assess --json` and explains the actual report
- **AND** it does not invent findings or execute update, upgrade, repair, adoption, activation, or project scripts

#### Scenario: Developer explicitly requests live reads
- **WHEN** the developer requests live comparison through that integration
- **THEN** it can use the supported explicit live governance-assessment command
- **AND** otherwise collection remains local-only

#### Scenario: Generate across frameworks and operating systems
- **WHEN** selected-agent plans use OpenSpec or Spec Kit on Windows, macOS, or Linux
- **THEN** behavioral contracts remain equivalent with deterministic content and portable paths
- **AND** unsafe, escaping, or ambiguous discovery destinations block writes

#### Scenario: Generate Codex assessment
- **WHEN** Codex is selected with governance enabled and no transport migration
- **THEN** `.agents/skills/liftoff-governance-assess/SKILL.md` has valid skill metadata and its own managed identity
- **AND** it is not generated under a Claude logical name
