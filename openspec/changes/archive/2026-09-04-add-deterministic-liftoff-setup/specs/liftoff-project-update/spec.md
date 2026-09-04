## ADDED Requirements

### Requirement: Update reconciles managed phase definitions without owning execution state
Normal managed-core update SHALL reconcile the canonical phase graph and setup
integrations. It SHALL preserve user-owned activation state and evidence, mark
policy-incompatible active work as reconciliation-required, and never silently
advance, reset, or delete a phase.

#### Scenario: Phase graph has managed drift
- **WHEN** `liftoff update --check` detects a newer managed graph
- **THEN** it reports the graph and setup integration changes without modifying user-owned state

#### Scenario: Updated graph affects active work
- **WHEN** plain update installs the reviewed graph
- **THEN** the next governance status reports the affected phases and required reconciliation
- **AND** performs no remote mutation

#### Scenario: Historical phase state remains compatible
- **WHEN** existing evidence satisfies the new graph
- **THEN** update preserves it and governance verification records compatibility

### Requirement: Update applies the activation compatibility matrix
The system SHALL maintain an explicit compatibility matrix among supported
manifest, policy, activation-contract, phase-graph, activation-state, evidence,
approval-envelope, and credential-policy versions. It SHALL migrate supported
historical representations transactionally and SHALL leave future or
incompatible identities untouched and blocked.

#### Scenario: Historical activation state is supported
- **WHEN** update reads a supported older manifest, contract, or schema
- **THEN** check mode reports the complete migration without writing
- **AND** apply writes the new representation only after every managed-artifact and user-state migration preflight succeeds

#### Scenario: Activation identity is from the future
- **WHEN** a project records a newer unsupported contract or schema version
- **THEN** update and setup block without downgrading or rewriting it
- **AND** report the exact unsupported field and required Liftoff upgrade

#### Scenario: Policy and activation contract are incompatible
- **WHEN** their versions are individually known but their combination is absent from the compatibility matrix
- **THEN** verification reports the incompatible pair
- **AND** no phase advances
