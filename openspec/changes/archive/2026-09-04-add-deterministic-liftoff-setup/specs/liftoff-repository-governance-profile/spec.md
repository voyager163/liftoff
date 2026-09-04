## ADDED Requirements

### Requirement: Governance policy phases are capabilities, not inferred task order
The canonical policy SHALL identify its numbered security, delivery, GitFlow,
governance, and documentation sections as capability chapters. The managed
phase graph SHALL define execution order, including provider readiness before
local bootstrap and private runner readiness before private backend proof and
remote import.

#### Scenario: Policy prose and graph disagree
- **WHEN** policy text, generated tasks, or an agent response orders a transition differently from the phase graph
- **THEN** activation follows the phase graph and reports the inconsistent source

#### Scenario: Private backend requires a runner
- **WHEN** a bounded local bootstrap is required
- **THEN** the graph orders provider readiness, access-establishing network, restricted runner, backend proof, declarative remote import, no-change verification, and remote-ready state

### Requirement: Active governance work reconciles activation-identity changes
When managed policy, activation-contract semantics, schemas, or phase-graph
bytes change, the engine SHALL compare the active governance change and verified
phase state with the new compatibility version vector. It SHALL invalidate only
affected downstream phases, produce an approval-ready reconciliation report,
and block execution until the active change acknowledges the current compatible
identity and exact graph hash.

#### Scenario: Policy update changes an unstarted phase
- **WHEN** an affected phase has not begun
- **THEN** its generated task and requirements are updated without invalidating unrelated verified predecessors

#### Scenario: Policy update changes a completed phase
- **WHEN** completed evidence no longer satisfies the current contract
- **THEN** the phase is blocked for renewed evidence or an explicit approved exception

#### Scenario: Policy update changes no relevant contract
- **WHEN** managed bytes change but the active phase requirements and evidence remain equivalent
- **THEN** reconciliation records the new compatible activation identity without repeating completed work

#### Scenario: Activation identity is unsupported
- **WHEN** the policy and activation-contract versions or serialized schemas are not a supported combination
- **THEN** reconciliation blocks without changing evidence, phase state, or the active change

### Requirement: Credential policy is consistent across repositories
The governance profile SHALL use one credential-policy schema for PAT and
existing GitHub App authentication. Repository-specific names and allowed
workflows SHALL be values in that schema rather than model-generated prose.

#### Scenario: Two repositories require PAT fallback
- **WHEN** setup enrolls runner-preflight credentials
- **THEN** both use the `<repo>-runner-preflight-read` display-name template and `RUNNER_CONFIGURATION_READ_TOKEN` secret
- **AND** each policy records only its own repository and explicit allowed jobs

#### Scenario: A workflow expands credential exposure
- **WHEN** a new job or workflow references the credential outside the recorded allowlist
- **THEN** verification fails before the workflow can satisfy qualification evidence
