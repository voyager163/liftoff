## ADDED Requirements

### Requirement: Repair is reachable from the installed CLI and native setup
The installed CLI SHALL register repair check, exact-plan application, explicit live metadata discovery, and interrupted local transaction recovery. Human and schema-1 JSON results SHALL distinguish clean, available, blocked, applied, failed and recovery outcomes with actual next actions. Native setup SHALL use this command when infrastructure conformance blocks local verification, without inventing unsupported commands or manually changing provenance.

#### Scenario: Repair help and invalid authority
- **WHEN** a developer requests repair help or supplies conflicting check/apply/recovery flags
- **THEN** help describes the supported scopes or invalid flags fail before access and mutation
- **AND** force or a generic yes flag cannot bypass repair approval

#### Scenario: Native setup encounters legacy infrastructure
- **WHEN** local setup is blocked by recorded legacy OpenTofu layout
- **THEN** its integration directs the developer through repair preview, separate approval, and resumed local verification
- **AND** cloud mutation and stateful migration remain separately authorized rather than assumed

#### Scenario: Plan-only is not success
- **WHEN** an unsupported or stateful project cannot be transformed by the public local lane
- **THEN** repair returns exit 2 with concrete limitations and leaves source and state untouched
