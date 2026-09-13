## MODIFIED Requirements

### Requirement: Generated infrastructure includes state guidance
The system SHALL retain isolated per-environment state configuration and distinct project/environment backend keys. Local baseline validation SHALL remain backend-disabled. Actual backend initialization, migration, and deployment SHALL occur only through their approved scopes and supported recipes. Existing shared state SHALL not be silently relocated or adopted; supported stateful migration can execute after protected planning and required safeguards, while unknown or unsupported cases remain blocked.

#### Scenario: Local state default
- **WHEN** Azure OpenTofu infrastructure is generated
- **THEN** each selected environment root can be initialized with local state by default
- **AND** its local state path is isolated from the other generated environment roots

#### Scenario: Remote state example
- **WHEN** a developer reviews the generated infrastructure documentation
- **THEN** the documentation explains how to configure remote OpenTofu state for team environments
- **AND** each example backend key is distinct for the project and selected environment

#### Scenario: Legacy shared-state layout remains a migration boundary
- **WHEN** helper output or documentation encounters an existing project-owned shared-state infrastructure layout
- **THEN** it identifies the appropriate local or stateful repair preview and its eligibility/authority boundary
- **AND** it does not present an automatic environment-switch or state-relocation recipe as if the layout were already compatible

#### Scenario: Environment expansion requires a compatible recorded layout
- **WHEN** configuration adds an environment to a project with a legacy shared-state or unknown infrastructure layout
- **THEN** that environment's provisioning is blocked with a migration-required explanation
- **AND** update does not create a root referencing an absent shared module or rewrite existing infrastructure to make it compatible

## ADDED Requirements

### Requirement: Reviewed repair creates a verified independent-root contract
An eligible approved repair SHALL produce the complete explicit shared-module/environment inventory while preserving supported project semantics and compatible pins. An undeployed repair SHALL verify local structure; a stateful repair SHALL additionally coordinate actual state/address/backend ownership before publishing current conformance. Native filesystem paths and portable OpenTofu references SHALL behave consistently on Windows, macOS, and Linux.

#### Scenario: Legacy flat-root project is repaired
- **WHEN** the source transformation is supported, the complete scope is verified undeployed, and the exact repair is approved
- **THEN** each selected environment references the shared application module through a valid relative source
- **AND** the result includes all required environment artifacts rather than only the directory skeleton

#### Scenario: A partially migrated project duplicates resources
- **WHEN** identical supported resource bodies have been copied into module and environment files
- **THEN** the reviewed transformation identifies the actual module/consumer changes needed
- **AND** it does not count duplicate files or folder names as finished conformance

#### Scenario: State already exists
- **WHEN** existing state or deployed resources are observed
- **THEN** a supported stateful plan includes exact mappings, backups, locking, and verification requirements
- **AND** state changes occur only after those requirements and specific approval are satisfied

#### Scenario: Environment paths contain spaces on Windows
- **WHEN** repair and local verification run under a Windows path containing spaces
- **THEN** native filesystem resolution and explicit working directories select the intended roots
- **AND** rendered OpenTofu module references retain valid portable syntax

### Requirement: Current layout is distinct from retained historical provenance
Infrastructure layout interpretation SHALL use the active recorded inventory and independently report current filesystem observations. Exact historical entries retained by a committed approved repair SHALL not override the repaired active inventory. Unrepaired legacy records, missing active provenance, and unverified manual metadata edits SHALL not be treated as successful conversion.

#### Scenario: Approved repair retained a legacy snapshot
- **WHEN** the active inventory contains a complete supported independent layout and the repair history retains the prior flat-root entries
- **THEN** helpers and local baseline selection identify the active independent roots
- **AND** historical presence alone does not recreate the legacy-layout blocker

#### Scenario: Only the filesystem was rearranged
- **WHEN** module/environment directories exist but the active manifest still records the legacy layout
- **THEN** Liftoff reports the recorded/current distinction and a repair preview
- **AND** it does not instruct the developer to erase provenance or edit context to bypass the gate

#### Scenario: Update and assessment inspect the same active layout
- **WHEN** the same project and installed CLI render expected managed context
- **THEN** repair, update, assessment, doctor, and infrastructure guidance use the same layout interpretation
- **AND** no surface silently substitutes a fresh independent layout for a recorded legacy one

### Requirement: Supported Azure activation provisions real application infrastructure
After exact scope approval, Liftoff SHALL implement the selected supported Azure infrastructure using verified provider readiness, execution identity, backend access, and a real source-bound immutable application artifact. It SHALL preserve project customizations and bind permissions, environments, resource ownership, and cost constraints explicitly. Local validation or a placeholder image SHALL not establish deployed application readiness.

#### Scenario: Deploy an approved supported application
- **WHEN** the actual artifact, backend, provider, identity, and approval prerequisites are valid
- **THEN** the declared infrastructure is applied and independently read back
- **AND** actual application health and deployment identity are verified before completion

#### Scenario: Registry and image do not yet exist
- **WHEN** deployment depends on a new application artifact
- **THEN** the graph first establishes approved registry/identity prerequisites and publishes a verified artifact
- **AND** it does not break the cycle with an unqualified placeholder deployment

#### Scenario: An existing resource has unverified ownership
- **WHEN** a discovered resource merely matches a planned name
- **THEN** it is not silently adopted, replaced, or deleted
- **AND** current ownership/state mapping must be established through the supported plan

### Requirement: Private execution and provider readiness are verified before dependent writes
Activation SHALL derive provider namespaces from every approved resource type and verify terminal readiness before dependent work. It SHALL use a verified existing backend path or an explicitly approved bounded access-establishing bootstrap. Private runner applicability, assignment, network routing, DNS, egress, backend locking/versioning, and target reachability SHALL be proven independently. Provider registrations SHALL remain retained shared capabilities during rollback.

#### Scenario: Private access needs bootstrap
- **WHEN** no approved execution path can reach the required private backend
- **THEN** only the approved minimum bootstrap resources are created first
- **AND** ordinary application provisioning waits for verified private execution and remote readiness

#### Scenario: An existing private assignment is suitable
- **WHEN** current readback proves the required runner/backend/target path
- **THEN** activation consumes it without creating a duplicate

#### Scenario: Registration or quota is unresolved
- **WHEN** a required namespace, permission, quota, or region capability is not ready
- **THEN** dependent writes stop with a bounded, actionable external prerequisite
- **AND** partial resource creation is not called provider readiness

### Requirement: State-only migration cannot conceal resource replacement
Supported migration SHALL verify configuration/state equivalence, exact resource mappings, source dispositions, backend protection, and the expected post-migration no-change result. Any resource create/update/delete/replace effect outside the migration's approved purpose SHALL require a separate resource-change plan. Failure after external effects SHALL preserve checkpoints and recovery material, not claim an atomic local rollback.

#### Scenario: Backend migration changes only state location
- **WHEN** an approved supported backend relocation completes
- **THEN** live resource identities remain the same and the target backend is verified
- **AND** known writers and project configuration point to the verified destination

#### Scenario: Post-migration plan is not clean
- **WHEN** verification detects an unapproved resource action or unaccounted source instance
- **THEN** migration remains incomplete and recovery/reconciliation is explicit
- **AND** current provenance is not falsely marked fully migrated
