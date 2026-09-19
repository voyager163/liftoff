## ADDED Requirements

### Requirement: Azure templates emit explicit TLS and private blob defaults
Generated Azure infrastructure SHALL explicitly set Redis and Service Bus minimum TLS to `1.2`, storage minimum TLS to `TLS1_2`, and account-wide `allow_nested_items_to_be_public` to false. The private container setting SHALL remain distinct from the account-wide restriction. These defaults SHALL be emitted consistently for every supported profile using the affected resources without changing unrelated networking, identity or availability behavior.

#### Scenario: Generate an affected Azure profile
- **WHEN** the selected generated infrastructure includes Redis, storage or Service Bus
- **THEN** the corresponding explicit TLS/private-blob settings are present in its actual resource configuration
- **AND** private-container configuration alone does not stand in for the account-wide restriction

#### Scenario: Qualify the generated defaults
- **WHEN** generated output is evaluated against the declared Checkov baseline
- **THEN** controls CKV_AZURE_148, CKV_AZURE_44, CKV_AZURE_190, CKV2_AZURE_47 and CKV_AZURE_205 pass where applicable
- **AND** backend-disabled OpenTofu initialization/validation succeeds for the selected environment roots without hand edits

#### Scenario: A configuration finding is reported
- **WHEN** assessment identifies an omitted explicit default
- **THEN** it reports the configuration/compliance gap and its evidence
- **AND** it does not claim that a deployed resource currently accepts weak TLS or anonymous access without live proof

### Requirement: Existing Azure settings use reviewed configuration remediation
Liftoff SHALL offer the registered Azure baseline-setting repair for supported existing infrastructure without silently regenerating it. The plan SHALL identify exact resource/configuration locations, current observations, proposed attributes, customization conflicts and validation scope. Configuration repair SHALL remain separate from provider application, state movement and live compliance claims.

#### Scenario: Existing independent infrastructure lacks a default
- **WHEN** a supported project already has its independent-root layout but omits a required explicit setting
- **THEN** the repair plan can propose that specific configuration correction without repeating layout reorganization
- **AND** ordinary managed update or application-patch approval does not authorize it

#### Scenario: Custom or stronger configuration is present
- **WHEN** an existing supported value is compliant or a custom expression cannot be safely resolved
- **THEN** compliant stronger settings remain unchanged and unresolved customization is surfaced for review or blocked
- **AND** no broad template replacement or unreviewed downgrade occurs

#### Scenario: Configuration is approved without deployment
- **WHEN** the exact file correction and declared local validation are approved
- **THEN** only the registered configuration/history effects are applied
- **AND** resource application and live readback require their separate Azure plan and authority

#### Scenario: Configuration roots use Windows paths
- **WHEN** supported environment/module files are inspected from paths with spaces on Windows, macOS or Linux
- **THEN** native filesystem paths and explicit portable artifact identities select the same reviewed source
- **AND** traversal, linked roots and case-colliding aliases cannot expand the repair
