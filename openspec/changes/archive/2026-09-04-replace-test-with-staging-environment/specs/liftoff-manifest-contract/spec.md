## MODIFIED Requirements

### Requirement: Artifact logical names and catalog identifiers are stable
The system SHALL treat non-environment artifact `logicalName` values and catalog identifiers for project types, patterns, API stacks, providers, spec workflows, and coding agents as an append-only public contract. Environment identifiers and their derived artifact logical names SHALL match the explicitly supported set `dev`, `staging`, and `prod`; retired identifiers such as `test` and their derived logical names SHALL NOT remain accepted or generated. A CI contract test SHALL fail when representative generated logical names differ from the reviewed current contract.

#### Scenario: Contract test guards logical names by workload
- **WHEN** the test suite runs against representative GenAI, standard API, and Power Apps plans
- **THEN** each sorted list of generated `logicalName` values matches its checked-in snapshot
- **AND** a mismatch fails with a message stating the stable logical-name policy and environment-retirement exception

#### Scenario: New artifact added to templates
- **WHEN** a contributor adds a new generated artifact with a new `logicalName` and updates the applicable snapshot
- **THEN** the contract test passes without any existing `logicalName` changing

#### Scenario: New workload identifier is appended
- **WHEN** `power-apps-code-app` is added to the project-type catalog
- **THEN** existing `genai` and `standard` identifiers and their accepted aliases remain valid

#### Scenario: Current manifests accept only supported environment identifiers
- **WHEN** a current manifest or desired-state configuration declares deployment environments
- **THEN** the accepted environment identifiers are exactly `dev`, `staging`, and `prod`
- **AND** a manifest or configuration containing `test` is rejected with an unsupported environment error
