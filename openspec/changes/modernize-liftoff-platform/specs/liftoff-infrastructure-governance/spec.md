## MODIFIED Requirements

### Requirement: Generated projects include spec-driven governance assets
Supported users SHALL select OpenSpec, Spec Kit or Manual, retaining OpenSpec as omission default. External frameworks retain pinned official initialization and workload-specific seed/constitution behavior. Manual SHALL generate no external framework artifacts, while independently selected repository policy and optional Liftoff integrations remain available. Retired workloads SHALL fail before framework or governance generation.

#### Scenario: OpenSpec selected
- **WHEN** OpenSpec is selected
- **THEN** official integrations and the actual local baseline seed are produced

#### Scenario: Spec Kit selected
- **WHEN** Spec Kit is selected
- **THEN** its official default/secondary integrations and workload-specific bootstrap content are produced

#### Scenario: Power Apps retains governance
- **WHEN** a retired Power Apps request is encountered
- **THEN** rejection occurs before framework or governance generation

#### Scenario: Manual selected
- **WHEN** Manual is selected with either governance profile or none
- **THEN** external framework files are omitted without changing the selected policy's meaning

### Requirement: Generated infrastructure includes state guidance
New output SHALL retain isolated per-environment roots/state and distinct project/environment keys; local baseline validation remains backend-disabled. Actual backend/deployment work requires its approved qualified scope. Public pre-existing deployment state import, relocation, partition and address migration SHALL remain planning-only in this release. Existing shared or unknown layouts SHALL not be silently adopted or expanded.

#### Scenario: Local state default
- **WHEN** infrastructure is generated
- **THEN** selected environment roots have distinct local-state paths

#### Scenario: Remote state example
- **WHEN** team-state guidance is read
- **THEN** explicit remote backend examples have distinct project/environment keys and approved access requirements

#### Scenario: Legacy shared-state layout remains a migration boundary
- **WHEN** an existing deployed/shared layout is observed
- **THEN** guidance explains deferred stateful planning rather than an executable state-switch recipe

#### Scenario: Environment expansion requires a compatible recorded layout
- **WHEN** expansion depends on an incompatible shared layout or missing module
- **THEN** it is blocked without rewriting existing files or state

### Requirement: Repository governance is distinct from spec-workflow governance
Repository profile/policy and activation authority SHALL remain separate from OpenSpec/Spec Kit artifacts or Manual development. External workflows control their own source-of-truth documents; Manual uses native reviewed operational plans. None of these choices SHALL alter single-maintainer versus team review invariants, grant remote authority or make old framework files managed core.

#### Scenario: Generate OpenSpec with repository governance
- **WHEN** both are selected
- **THEN** framework/seed and managed handoff retain separate ownership

#### Scenario: Generate Spec Kit with repository governance
- **WHEN** both are selected
- **THEN** its default-agent contract does not change the selected policy

#### Scenario: Generate Manual with team governance
- **WHEN** Manual and team GitFlow are selected without agents
- **THEN** actual CLI plans preserve independent PR review and explicit deployment approval boundaries

### Requirement: Supported Azure activation provisions real application infrastructure
Approved new-environment activation SHALL use actual provider readiness, verified tenant/subscription/principal, protected backend access and a source-bound immutable artifact before deployment. Effects SHALL bind exact resources/environments, permissions and cost. Current owned effects from the same recorded activation can be resumed. Pre-existing resource/state adoption remains planning-only; local validation, placeholder images or matching names cannot prove ownership or readiness.

#### Scenario: Deploy an approved supported application
- **WHEN** real prerequisites and scope approval are satisfied
- **THEN** actual configuration is applied and independent deployment/health/readback establishes completion

#### Scenario: Registry and image do not yet exist
- **WHEN** a new application artifact is required
- **THEN** approved registry/identity and immutable artifact publication precede deployment

#### Scenario: An existing resource has unverified ownership
- **WHEN** a discovered resource matches a planned name without current owned-operation proof
- **THEN** dependent writes stop instead of importing, replacing or duplicating it

## ADDED Requirements

### Requirement: Infrastructure consumers share active compatible layout bindings
Helpers, baseline checks, deployment plans, doctor and assessment SHALL use the same validated active layout/inventory rather than assume canonical fresh paths for an adopted project. Existing layout compatibility does not prove undeployed scope or authorize state mutation. Native paths and portable OpenTofu references SHALL remain correct across Windows, macOS and Linux.

#### Scenario: Existing compatible module lives at another path
- **WHEN** approved bindings and references establish compatibility
- **THEN** consumers use that exact path without requiring a cosmetic move

#### Scenario: Windows module path contains spaces
- **WHEN** qualified checks or guidance resolve the bound root
- **THEN** literal native arguments and portable module references preserve its meaning
