## MODIFIED Requirements

### Requirement: Public telemetry documentation is complete and precise
Packaged guidance SHALL distinguish default anonymous command aggregates from explicitly opted-in pseudonymous project observations and separately enabled monthly CI heartbeats. It SHALL enumerate exact fields/exclusions, semantic versus legacy outcomes, disclosure/consent, ordinary CI disablement and narrow heartbeat exception, global opt-outs, bounded delivery, Azure processing, 180-day retention and deletion/disablement differences. No persistent user/device/installation/session identity is created; project IDs are explicitly linkable and not described as anonymous.

#### Scenario: User evaluates telemetry before running Liftoff
- **WHEN** privacy guidance is read
- **THEN** it explains each channel, its consent and opt-out behavior, retained fields and measurement limitations

#### Scenario: Documentation describes source IP handling
- **WHEN** network privacy is described
- **THEN** unavoidable routing is distinguished from prohibited product IP/geolocation storage

#### Scenario: User inspects the npm package
- **WHEN** native or npm package documentation is inspected
- **THEN** current privacy guidance and its local links resolve

### Requirement: Documentation explains self-upgrade safety and registry policy
Guidance SHALL identify verified installation ownership, native channel versus upstream availability, preserved npm mirror policy, exact replacement verification, no automatic elevation and owner-specific recovery. It SHALL distinguish ordinary same-owner upgrade from the standalone Apple Silicon npm-to-Homebrew handover and its separately approved bounded recovery.

#### Scenario: Managed registry is stale
- **WHEN** an npm user is blocked by mirror parity
- **THEN** guidance preserves approved registry policy rather than silently switching channels

#### Scenario: Installation needs elevated permission
- **WHEN** the owner cannot write its destination
- **THEN** the actual ownership/permission remedy is described without automatic sudo or broad cleanup

#### Scenario: Post-install verification fails
- **WHEN** the replacement cannot be verified
- **THEN** owner-specific exact recovery is provided without claiming ordinary upgrade automatically restored the old package

### Requirement: Documentation describes existing-project adoption
Guidance SHALL distinguish native installer migration, reviewed existing-Liftoff update/repair, new in-place adopt, preserved sibling migrate and explicit workflow switching. It SHALL explain v2-v7 readers/current v8 writers, preserved application/Git/history, compatible noncanonical layouts, exact approvals/collisions, unknowns and deferred existing-deployment state changes. Retired Power Apps SHALL remain outside supported adoption.

#### Scenario: Existing user previews adoption
- **WHEN** a supported old Liftoff project follows guidance
- **THEN** it starts with update check/capability-aware repair rather than reinitialization or fresh-template replacement

#### Scenario: Existing governance file conflicts
- **WHEN** an unowned destination differs
- **THEN** guidance preserves it and explains the actual reviewed resolution rather than force takeover

### Requirement: Documentation provides one post-init kickstart
Selected-agent projects SHALL use the actual native Liftoff setup journey; no-agent Manual projects SHALL receive actual registered CLI local/activation actions. Both SHALL distinguish local readiness, separately approved repair/adoption, new-environment activation and future lifecycle work. Manual SHALL require no spec documents or archive, and no shell liftoff setup alias SHALL be invented. Existing-deployment state mutation remains deferred and cannot be included in an unqualified completion claim.

#### Scenario: Developer finishes initialization
- **WHEN** completion guidance is read
- **THEN** it names the actual selected-host setup or CLI-only next actions

#### Scenario: Developer asks about model selection
- **WHEN** agent guidance explains setup
- **THEN** no model selection is required and safety is attributed to CLI contracts, not model confidence

#### Scenario: Developer inspects setup identity
- **WHEN** identities are documented
- **THEN** release/profile/activation/report/repair/graph versions and historical proof are distinct

#### Scenario: Setup needs developer input
- **WHEN** an effect needs permission
- **THEN** exact action scope is explained without asking users to fabricate approval files

#### Scenario: Developer resumes setup
- **WHEN** prior work stopped
- **THEN** real supported recovery/repair actions and actual prior effects are described without blind retries

#### Scenario: Developer reads setup command guidance
- **WHEN** setup integrations are described
- **THEN** existing native invocation forms remain accurate and retired aliases remain historical debt only

#### Scenario: Developer enters a credential
- **WHEN** approved activation needs enrollment
- **THEN** guidance uses private owner-controlled channels rather than chat, argv or source files

#### Scenario: Spec Kit user completes the local baseline
- **WHEN** Spec Kit is used
- **THEN** its real bootstrap/finalization remains distinct from framework markers and no OpenSpec archive is invented

#### Scenario: Local setup is complete but activation is pending
- **WHEN** local completion is shown
- **THEN** deployment/enforcement remain separate and require their actual permissions/proof

#### Scenario: Developer completes the full journey
- **WHEN** supported new-environment completion is described
- **THEN** real deployment, qualification and live enforcement are required and future lifecycle work remains visible

### Requirement: Contributor guidance makes module responsibilities discoverable
Contributor documentation SHALL map actual core services, deterministic engines, adapters, generators, bundled plugin contracts/registries, canonical assets/skills, distribution and ingestion boundaries. It SHALL show dependency direction, exact artifact ownership, extension tests and version/compatibility consequences without claiming that forwarding facades establish a boundary. First-party executable plugins SHALL be described as trusted, not sandboxed.

#### Scenario: Contributor extends a supported workload
- **WHEN** the module/asset map is followed
- **THEN** one canonical plugin/template location and its prerequisite, render, audit and acceptance contracts are clear

#### Scenario: Contributor changes an activation contract
- **WHEN** proof, graph or authority changes
- **THEN** required version/hash and historical compatibility work is documented

#### Scenario: Contributor works on Windows
- **WHEN** path/build/release guidance is followed
- **THEN** native path construction and literal shell conventions remain correct across supported hosts

### Requirement: Activation guidance distinguishes implementation scope from runtime consent
Documentation SHALL describe implemented approved new-environment activation and explicitly defer public adoption/state changes for pre-existing Azure deployments. Internal state primitives SHALL not be advertised as qualified public commands. Planning approval, local repair, setup requests or yes flags SHALL not authorize live publication, credentials, provisioning or enforcement. Real operation and readback evidence SHALL distinguish local, deployed, enforced and lifecycle outcomes.

#### Scenario: A developer only wants local readiness
- **WHEN** later scope is declined
- **THEN** no live activation is implied and completed local work remains valid

#### Scenario: Existing activation metadata needs the successor
- **WHEN** a supported historical project upgrades control records
- **THEN** the exact local successor/fresh-proof path is distinguished from deferred OpenTofu-state migration

## ADDED Requirements

### Requirement: All maintained README sources reflect the qualified modernization
The update SHALL cover root README.md, infrastructure/opentofu/bootstrap/README.md, infrastructure/opentofu/telemetry/README.md, src/application/state-migration/README.md, every explicitly inventoried generated project/governance/infrastructure/worker/prompt README source, and directly related public/developer guides. Historical archives, dependencies and customer files SHALL not be rewritten by this documentation maintenance. Existing customer README changes require separately approved project repair.

#### Scenario: Maintainer audits README inventory
- **WHEN** documentation qualification runs
- **THEN** every maintained/generated README source is checked for current native installation, scope, ownership and relevant command/schema guidance
- **AND** archived change records and dependency copies are excluded explicitly

#### Scenario: Documentation describes an unqualified feature
- **WHEN** native or cloud qualification is incomplete
- **THEN** it is labeled unavailable/unverified rather than released

#### Scenario: Manual CLI-only quick start is followed
- **WHEN** Manual and no agents are selected
- **THEN** examples need neither framework nor a fabricated agent invocation and preserve the selected governance policy

#### Scenario: Package links are checked on Windows
- **WHEN** native/npm documentation is inspected from Windows, macOS or Linux paths with spaces
- **THEN** every intended packaged link/asset resolves without checkout-only assumptions

### Requirement: Coverage and adoption claims cite the measured scope
Documentation SHALL explain the independently enforced greater-than-80% four-metric gates and distinguish code coverage from generated/native/live qualification. Adoption charts SHALL be described as opted-in, retention-windowed project observations, not all-time census, developer activity or proven conformance. Team and single-maintainer review rules SHALL be documented separately.

#### Scenario: Saved coverage report is stale
- **WHEN** its revision/inventory differs
- **THEN** it is not used as evidence of the current release threshold

#### Scenario: User reads project-count claims
- **WHEN** Grafana or README guidance describes adoption
- **THEN** the project-root identity, clone deduplication, monorepo treatment, opt-in and heartbeat limitations are explicit
