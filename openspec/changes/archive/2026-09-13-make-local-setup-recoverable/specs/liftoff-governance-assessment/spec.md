## MODIFIED Requirements

### Requirement: Diagnostics and recommendations preserve authority boundaries
Reports SHALL retain only bounded, sanitized observations and no credentials, state contents, private keys, sensitive plans, or raw sensitive responses. Recommendations SHALL distinguish eligible local/stateful/activation plans from unknown or unsupported work and state their required authority. Assessment SHALL never execute those recommendations, enroll credentials, inspect sensitive state through its ordinary report path, or create project files, issues, approvals, or mutations.

#### Scenario: Collector output contains sensitive data
- **WHEN** an observation or failure includes prohibited sensitive payloads
- **THEN** the data is redacted or withheld before output, truncation, or retention
- **AND** the finding states any resulting observation limitation

#### Scenario: Managed and project-owned drift coexist
- **WHEN** managed integration drift and user-owned workflow or infrastructure differences are found
- **THEN** recommendations distinguish guarded core update from separately reviewed project/remote changes
- **AND** force-update is not presented as authority over project-owned files or compatibility gates

#### Scenario: Developer only requests assessment
- **WHEN** a report identifies actionable differences
- **THEN** no update, upgrade, repair, activation, migration, provisioning, issue creation, or Git mutation occurs
- **AND** subsequent execution requires a separate supported plan and authorization

#### Scenario: A repair lane exists
- **WHEN** a local finding has a supported infrastructure or agent-integration repair candidate
- **THEN** the recommendation identifies the real repair preview and its project context
- **AND** it does not tell the developer to fabricate provenance or copy a freshly initialized application over the project

## ADDED Requirements

### Requirement: Managed-core assessment shares recorded-layout expectations
For the same installed CLI, active project identity, and captured recorded layout, assessment SHALL compare managed-core bytes against the same expectation used by update and repair. It SHALL not classify a correct legacy-layout context as outdated merely because a fresh-generation renderer would describe independent roots. Actual managed-byte differences and layout eligibility SHALL remain separately observable.

#### Scenario: Update reports legacy context current
- **WHEN** the active legacy context matches the installed recorded-layout-aware expectation
- **THEN** assessment also reports the managed-core context as matching
- **AND** it can still report the separate infrastructure conformance/repair gap

#### Scenario: A repair establishes independent roots
- **WHEN** a committed repair updates the active inventory and context while preserving historical flat-root records
- **THEN** assessment uses the active independent inventory, not the historical snapshot
- **AND** it does not attribute a layout rendering difference merely to the manifest's last-writing CLI version

#### Scenario: Real context drift exists
- **WHEN** the managed file differs from the shared expectation
- **THEN** the report preserves the genuine mismatch and its provenance
- **AND** renderer unification does not hide modified managed content

### Requirement: Local setup completion does not establish policy alignment
Assessment SHALL distinguish local readiness, verified state migration, deployment, and enforcement. Historical repair records alone SHALL not become current proof. Current validated migration evidence can satisfy only its declared backend/resource-binding proof, never unrelated deployment or enforcement controls. Missing declarations, unobserved facts, unsupported evaluators, and overdue lifecycle work SHALL remain explicit.

#### Scenario: Local setup is complete without remote activation
- **WHEN** local framework, agents, and baseline checks are complete but live controls remain unobserved
- **THEN** assessment reports the applicable coverage gaps and partial outcome
- **AND** it does not become aligned solely because setup completed

#### Scenario: A repair receipt is present
- **WHEN** repair history records a successful local infrastructure transformation
- **THEN** it can establish historical repair provenance
- **AND** it cannot prove deployed resources, required checks, rulesets, or Phase 0 completion

### Requirement: Activated controls require current matching evidence across consumers
Assessment SHALL consume current validated activation/migration relationships consistently with status, verification, and doctor. Actual workflow/run, artifact, environment/ref, identity, resource, ruleset, and lifecycle observations SHALL remain distinguishable. A completed journal, accepted write, or historical success SHALL not hide missing current proof.

#### Scenario: Activation has fresh complete proof
- **WHEN** every required layer for an applicable control is fresh and matches its target
- **THEN** assessment can report that control aligned
- **AND** overall alignment still requires complete applicable coverage

#### Scenario: State moved but enforcement is unobserved
- **WHEN** only state migration is verified
- **THEN** unrelated deployment/enforcement controls remain unobserved or incomplete

#### Scenario: Current proof is stale or partial
- **WHEN** a recorded activation succeeded but current inputs/readback no longer establish the control
- **THEN** the report preserves that history while identifying the current gap
