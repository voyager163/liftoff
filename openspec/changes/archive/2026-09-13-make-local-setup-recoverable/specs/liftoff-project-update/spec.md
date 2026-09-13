## MODIFIED Requirements

### Requirement: Configuration edits are a reconciled desired-state axis
The system SHALL treat desired state as developer-owned and ordinary update SHALL not rewrite it after generation. A separate approved agent repair can change only its reviewed agent/default fields; an explicit activation preparation plan can change only its named target/environment fields. Other values SHALL remain unchanged. Existing compatible create-only frontend/environment provisioning SHALL retain its safety rules, while legacy/unknown layouts require supported repair. No desired-state edit SHALL grant ordinary update or force authority over existing project-owned files or live state/resources.

#### Scenario: API environment added to config
- **WHEN** a developer adds an environment not previously selected by a supported workload with a compatible independent-environment layout
- **THEN** update preflights and creates only that environment's absent project artifacts
- **AND** records them as project-owned

#### Scenario: API environment removed from config
- **WHEN** a developer removes an environment from a supported workload configuration
- **THEN** its files remain project-owned and untouched
- **AND** they are not reported as managed-core orphans

#### Scenario: Frontend is enabled
- **WHEN** a developer enables a frontend that the recorded workload did not include
- **THEN** update provisions the frontend only when every destination satisfies the existing create/adopt safety rules
- **AND** all created frontend files become project-owned

#### Scenario: Power Apps plugin preference changes
- **WHEN** update encounters a former Power Apps workload or plugin-preference change
- **THEN** it reports the retired workload or option instead of reconciling the preference
- **AND** it does not rewrite the manifest or application files

#### Scenario: Power Apps rejects API configuration drift
- **WHEN** a retired Power Apps project contains added API configuration
- **THEN** update rejects the retired boundary before attempting workload-specific reconciliation

#### Scenario: Retired workload configuration is rejected
- **WHEN** desired state selects workload kind `power-apps-code-app`
- **THEN** update exits 1 before rendering or writing
- **AND** it does not reinterpret the configuration as a supported API or GenAI workload

#### Scenario: Approved agent repair changes desired state
- **WHEN** a separate supported repair adds an agent or explicitly changes a Spec Kit default
- **THEN** only the approved selection fields are updated with the corresponding framework and manifest state
- **AND** ordinary update still cannot perform that framework mutation

## ADDED Requirements

### Requirement: Update routes repairable identity changes to the supported repair flow
Ordinary update SHALL retain its managed-core and already-declared migration boundaries. When a supported additive agent/default change or incompatible infrastructure layout requires project repair, it SHALL identify the actual repair preview and project context rather than only requesting restored configuration, manual metadata edits, or reinitialization. Unsupported workflow switches, removals, retired workloads, and unrelated migrations SHALL remain explicit limitations.

#### Scenario: Desired state adds Codex
- **WHEN** an initialized project adds Codex and ordinary update encounters that agent change
- **THEN** update performs no framework mutation and directs the developer to a project-bound repair preview
- **AND** it does not claim that restoring the old agent list is the only supported route

#### Scenario: Core is current but infrastructure is legacy
- **WHEN** managed-core bytes match while local baseline is blocked by legacy infrastructure
- **THEN** update accurately reports its clean core scope and distinguishes the separate repair requirement
- **AND** it does not claim that core currency establishes local setup completion

#### Scenario: Repair would require stateful migration
- **WHEN** an infrastructure candidate is stateful or unverified
- **THEN** follow-up guidance distinguishes supported stateful planning/execution prerequisites from unresolved or unsupported scope
- **AND** ordinary update approval or force cannot authorize backend or resource mutation

### Requirement: Managed-context expectations use active recorded layout
Update, repair preview, doctor, and assessment SHALL use the same installed-release expectation for a given active manifest and recorded infrastructure layout. Expected managed context SHALL not assume a fresh independent layout when the project remains legacy or unknown. Historical repair snapshots SHALL not replace the active manifest as the comparison target.

#### Scenario: Legacy context matches the installed contract
- **WHEN** a context correctly describes the active legacy layout for the installed CLI
- **THEN** all managed-core comparisons agree that the file matches that expectation
- **AND** the infrastructure migration requirement remains a separate finding

#### Scenario: Repaired context matches independent roots
- **WHEN** an approved repair commits an independent active inventory and corresponding context
- **THEN** update compares against that current inventory and preserves retained legacy history

#### Scenario: Context bytes are actually modified
- **WHEN** context differs from the common expected render
- **THEN** the existing managed-core conflict/hash rules remain enforced rather than normalizing away genuine changes

### Requirement: Activation-contract upgrade is separate from infrastructure execution
The reviewed update path SHALL identify the exact declared historical source and target activation successor and preserve original records before changing active identity. Its approval SHALL authorize only that inventoried local migration and finite revalidation, not live state movement, publication, enrollment, or deployment. Current activation and stateful execution SHALL require their separate current plans and authority.

#### Scenario: A v2 project needs the revised execution contract
- **WHEN** the exact source is supported by a declared successor lane
- **THEN** update preview identifies the target contract, preserved history, and fresh-proof work
- **AND** no version field is manually retagged to bypass compatibility

#### Scenario: A successor has been created
- **WHEN** the local identity migration commits
- **THEN** the new activation can be inspected and planned under its declared contract
- **AND** the migration result alone does not execute its cloud or stateful stages
