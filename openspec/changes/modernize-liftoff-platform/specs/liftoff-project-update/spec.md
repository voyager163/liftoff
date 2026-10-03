## MODIFIED Requirements

### Requirement: Update applies the activation compatibility matrix
Update SHALL use an exact release-owned matrix separating historically readable, currently executable and approved migratable identities. Current modernization targets SHALL match the v8/profile/workflow-aware identity and real graph digest; historical v7/contract-2/contract-3 families SHALL remain exact source contracts. No tuple or permission SHALL be inferred from numeric version ordering. Historical compatibility metadata remains diagnostic input, not user-editable authority to create a lane.

#### Scenario: Historical activation state is supported
- **WHEN** a complete source matches a declared current-target lane
- **THEN** check reports the exact history-preserving plan and apply requires current approval/preconditions

#### Scenario: Historical v1 activation history is diagnostic-only
- **WHEN** a v1 successor lane exists
- **THEN** original records remain historical and target execution requires fresh proof

#### Scenario: Activation identity is from the future
- **WHEN** any required tuple/hash is unsupported
- **THEN** update/setup block without downgrade, rewrite or force bypass

#### Scenario: Policy and activation contract are incompatible
- **WHEN** their complete profile/workflow combination is absent
- **THEN** no phase advances

### Requirement: Existing projects adopt managed-core governance artifacts automatically
Absent governance configuration SHALL retain the existing single-maintainer desired-state default, but writing its handoff or v8 successor SHALL require matching preview and exact approval. Existing configuration SHALL not be rewritten merely to materialize a default. Team/Manual/plugin selections SHALL not be inferred from contributor count, missing tools or new CLI installation.

#### Scenario: Adopt into an untouched v4 project
- **WHEN** its exact approved metadata/core plan has safe destinations
- **THEN** current handoff and v8 metadata commit without application writes, agents or provider requests

#### Scenario: Preview automatic adoption
- **WHEN** a legacy project is checked
- **THEN** new named core entries and compatibility work appear without project writes

#### Scenario: Existing setup destination has different bytes
- **WHEN** an unowned destination conflicts
- **THEN** it is preserved and partial handoff is recorded without taking ownership

#### Scenario: Resolve a partial handoff
- **WHEN** a later approved plan finds safe absent/identical destinations
- **THEN** only those exact entries are written/adopted

#### Scenario: Existing setup destination already matches
- **WHEN** approved adoption finds identical content
- **THEN** it records ownership without rewriting bytes

### Requirement: Governance opt-out preserves user-owned files
When an eligible explicitly selected none profile is reconciled, prior managed handoff artifacts SHALL remain undeleted orphans unless an independent exact retirement applies. Active/archived framework work remains outside reconciliation. Existing activation-state deactivation guards remain mandatory. Successful metadata publication uses the current v8 contract without claiming remote settings changed.

#### Scenario: Disable the generated profile
- **WHEN** an eligible not-activated project changes to none and approves update
- **THEN** handoff files remain preserved and current metadata records disabled local governance only

#### Scenario: Archive the agent-created change
- **WHEN** framework work is archived or removed by its owner
- **THEN** update neither recreates it nor reports template drift for it

### Requirement: Update routes repairable identity changes to the supported repair flow
Ordinary update SHALL retain managed-core and explicitly declared identity-migration scope. Additive agents and application/layout changes SHALL route to actual separate repair; workflow changes SHALL route to the reviewed workflow-set operation; non-Liftoff adoption SHALL route to adopt. Unsupported removals, retired workloads, incompatible identities and existing-deployment state changes remain explicit limitations. Force SHALL not expand any lane.

#### Scenario: Desired state adds Codex
- **WHEN** initialized desired state adds Codex
- **THEN** update identifies a same-project additive repair without claiming it installed the agent

#### Scenario: Core is current but infrastructure is legacy
- **WHEN** core matches but infrastructure is incompatible
- **THEN** the separate repair/planning boundary remains visible without pretending core currency means readiness

#### Scenario: Repair would require stateful migration
- **WHEN** existing deployed state or resource ownership would change
- **THEN** first-release guidance remains planning-only and update approval cannot authorize it

## ADDED Requirements

### Requirement: Profile changes have a distinct reviewed local policy plan
An explicitly requested supported profile change SHALL appear as a separately labeled policy/successor plan under update check, binding source/target profiles, current controls, historical preservation and exact local effects. Its approval SHALL not apply live rulesets or reuse incompatible proof. Unknown source mappings or proposed control weakening SHALL remain explicit blockers/review requirements.

#### Scenario: Single-maintainer changes to team
- **WHEN** the requested transition has a declared compatible source
- **THEN** preview explains the new independent-review requirement and affected proof before local identity changes
- **AND** live enforcement still requires a separate approved governance operation

### Requirement: Managed update preserves workflow profile and layout selections
An ordinary CLI/core upgrade SHALL not implicitly switch framework, enable team policy, regenerate application templates, reset compatible layout bindings or enroll telemetry. Current installed-target comparisons SHALL share the same validated plugin/layout interpretation with assess, repair and doctor. New metadata requirements SHALL use an exact reviewed successor rather than filling history from guesses.

#### Scenario: CLI receives a new template layout
- **WHEN** an existing project's compatible bindings still satisfy its selected standard
- **THEN** update offers no application relocation solely because templates moved or plugins were extracted

#### Scenario: Manual is requested through configuration
- **WHEN** recorded external workflow and desired Manual identity disagree
- **THEN** update reports the separately approved workflow transition without changing either identity

#### Scenario: Nested project is updated on Windows
- **WHEN** an explicit or nearest project boundary resolves on Windows, macOS or Linux
- **THEN** receipts, plugin/binding comparisons and writes remain bound to that exact project and preserve sibling project metadata
