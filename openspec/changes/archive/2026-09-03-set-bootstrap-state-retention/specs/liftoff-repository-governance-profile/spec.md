## ADDED Requirements

### Requirement: Transient local bootstrap state has a fixed retirement lifecycle
When a private remote backend cannot be reached until repository-owned
networking exists, the canonical profile SHALL permit an explicitly approved,
minimum local-state bootstrap. The local state MUST remain encrypted,
gitignored, single-writer, and unavailable through ordinary GitHub artifacts or
secrets. After remote import is verified, it SHALL become read-only for exactly
30 days and then be securely deleted with dated evidence.

#### Scenario: Existing private management path is available
- **WHEN** an approved execution environment can already reach the private remote backend
- **THEN** the implementation uses that path and does not create a local-state bootstrap

#### Scenario: Private backend creates a bootstrap cycle
- **WHEN** remote state is private and unreachable until repository-owned networking and its execution runner exist
- **THEN** the approved plan may use local state only for the minimum resources needed to establish private backend access
- **AND** it does not identify the bootstrap as remote-ready or authorize unrelated provisioning

#### Scenario: Local bootstrap state is held
- **WHEN** the minimum bootstrap uses local state
- **THEN** the state remains encrypted on the approved workstation, excluded from version control, and limited to one operator
- **AND** it is not uploaded through workflow artifacts, repository secrets, or another ordinary transfer channel

#### Scenario: Remote import is verified
- **WHEN** the exact private execution runner can access the backend, every live resource is represented in remote state with matching identity, locking and versioning are active, and a clean checkout produces a no-change plan
- **THEN** the implementation records the verification timestamp and makes the local bootstrap state read-only
- **AND** the 30-day retention period begins

#### Scenario: Remote import is incomplete
- **WHEN** private access, resource parity, locking, versioning, or the no-change plan cannot be verified
- **THEN** the retention period does not begin, the local state is not deleted, and normal infrastructure provisioning remains blocked

#### Scenario: Retention period expires
- **WHEN** 30 days have elapsed since the recorded remote-import verification timestamp
- **THEN** the encrypted local bootstrap state and approved temporary copies are securely deleted
- **AND** a dated deletion record identifies the disposed state, verification evidence, operator, and outcome without containing state data

#### Scenario: Local state is used during retention
- **WHEN** any operation attempts to plan or apply from retained local bootstrap state after remote verification
- **THEN** the operation fails because the retained copy is evidence-only and read-only
