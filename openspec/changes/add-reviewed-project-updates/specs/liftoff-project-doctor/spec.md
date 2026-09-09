## MODIFIED Requirements

### Requirement: Doctor reports version freshness and managed-core drift
Doctor SHALL always report the running CLI and use the existing bounded authoritative stable-release lookup independently of project discovery. Inside a project it SHALL compare recorded and running CLI versions and report managed-core drift as one count-based warning directing the user to `liftoff update --check`, using the shared pure update classification. It SHALL report activation migration/revalidation separately, not count it as production-template drift. Doctor SHALL never issue a preview receipt, approve/apply an update, compare production files with current templates, or imply that upgrading the CLI replaces production files. Registry failure SHALL suppress only freshness, not local diagnosis.

#### Scenario: Freshness check runs outside a project
- **WHEN** doctor runs outside a generated project with registry access
- **THEN** it reports the running version and whether a newer stable CLI is published

#### Scenario: Authoritative registry is newer than the running CLI
- **WHEN** canonical stable release data is newer than the running CLI
- **THEN** doctor names both exact versions and recommends `liftoff upgrade --check` followed by `liftoff upgrade`
- **AND** it retains the exact manual npm fallback for unsupported origins or recovery

#### Scenario: Configured managed mirror is stale
- **WHEN** the configured mirror does not expose the authoritative target
- **THEN** doctor reports the synchronization blocker rather than declaring the CLI current
- **AND** it neither changes registry configuration nor performs an upgrade

#### Scenario: Drift warning line
- **WHEN** four managed-core differences are present
- **THEN** one warning identifies four core maintenance actions and `liftoff update --check`
- **AND** it neither counts project-template differences nor creates the external receipt itself

#### Scenario: Production files differ from templates
- **WHEN** only production templates differ
- **THEN** doctor reports no managed-core drift and retains independent runtime/structural diagnostics

#### Scenario: Offline doctor preserves local version diagnostics
- **WHEN** the registry is unavailable
- **THEN** local diagnostics and the running version remain available without a freshness error

## ADDED Requirements

### Requirement: Doctor distinguishes migration eligibility from current readiness
Doctor SHALL identify known active v1, supported migration eligibility, committed linked v2, incomplete revalidation, and invalid declared history as distinct diagnostic conditions. Eligible v1 SHALL still be non-executable, with `liftoff update --check` as the human-first remedy. A valid retained v1 snapshot SHALL not fail otherwise valid current v2 simply because it exists. Post-commit revalidation blockers SHALL identify the failed phase and actual repair/resume path without recommending a reset, manual version editing, or force bypass.

#### Scenario: A supported v1 migration is available
- **WHEN** active v1 satisfies the installed migration lane
- **THEN** doctor explains that migration can be previewed through `liftoff update --check`
- **AND** it does not claim current execution readiness or require JSON

#### Scenario: Migration has committed but validation failed
- **WHEN** the journal identifies a committed successor with blocked revalidation
- **THEN** doctor reports the retained v2 identity, exact blocker, and preview/retry remedy
- **AND** it does not label the project as unmigrated v1 or recommend restoring v1 automatically

#### Scenario: Retained history is valid
- **WHEN** linked v2 proof is valid alongside the exact preserved v1 inventory
- **THEN** historical presence alone does not cause an incompatible-identity failure

#### Scenario: Declared history is damaged
- **WHEN** a declared history/index link is missing, unsafe, or digest-mismatched
- **THEN** doctor reports that specific problem without silently repairing or reinterpreting it

#### Scenario: Diagnosis does not acknowledge a preview
- **WHEN** doctor diagnoses migration or revalidation
- **THEN** it writes no project/environment file or preview receipt
- **AND** the user still needs the actual update check before new update writes
