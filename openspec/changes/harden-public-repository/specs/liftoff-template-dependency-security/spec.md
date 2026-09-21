## MODIFIED Requirements

### Requirement: Live advisory retrieval is isolated and actionable
The system SHALL run live dependency advisory retrieval for every explicit npm inventory entry in dedicated security validation, including weekly and manually dispatchable auditing, applicable pull-request checks and release-time qualification using canonical npm. These live lanes SHALL remain separate from deterministic ordinary tests and SHALL reuse the same inventory and exact exception policy. The audit SHALL accept npm's documented finding exit code, distinguish retrieval or parse failures, avoid dependency installation and metadata mutation during the audit operation, and emit an actionable result for every finding.

#### Scenario: Scheduled audit finds only valid exceptions
- **WHEN** the weekly workflow detects no fixable findings and every unresolved finding has a valid exception
- **THEN** it succeeds with counts for clean, fixed, and reviewed template findings

#### Scenario: Scheduled audit finds a new advisory
- **WHEN** canonical npm reports an advisory not represented by a valid exception
- **THEN** the workflow fails and reports the affected template and dependency chain
- **AND** it does not rewrite the package manifest or lockfile

#### Scenario: Canonical advisory retrieval fails
- **WHEN** npm returns an infrastructure exit code, malformed JSON, or an unavailable registry response
- **THEN** the workflow fails as an audit infrastructure error
- **AND** it does not report the templates as secure or silently reuse stale output

#### Scenario: Pull request changes any inventoried npm graph
- **WHEN** dedicated PR security validation audits the candidate
- **THEN** it covers root Liftoff, telemetry ingest, standard Node backend and standard frontend graphs under their stable identities
- **AND** ordinary inventory, parser and exception tests remain fixture-based and deterministic

#### Scenario: Release requires a current npm verdict
- **WHEN** publication qualification evaluates the selected source and packed template inputs
- **THEN** it obtains current audit results using the same exact graph/exception policy
- **AND** a historical scheduled success or clean dependency diff does not replace the release-time verdict

## ADDED Requirements

### Requirement: Expanded audit events preserve existing exception strictness
Using the npm audit on additional events SHALL retain all existing exact matching, stale-entry, dependency-chain and inventory checks. Every unresolved npm finding SHALL require an exact valid adopted exception for a passing audit verdict; high/critical review windows SHALL NOT exceed 30 days and moderate/low/info windows SHALL NOT exceed 90 days. Portable manifest path parts and platform-native resolution SHALL remain equivalent across Windows, macOS and Linux. Reuse of the policy discipline for another ecosystem SHALL NOT reuse an exception as permission for an unrelated graph. Separate qualified policy-only maintenance admission SHALL NOT alter the standalone audit result, adopt candidate grants before merge or satisfy release qualification.

#### Scenario: Existing lower-severity exception does not match
- **WHEN** a moderate or low npm finding is unreviewed, expired, stale or differs from the reviewed dependency-chain set
- **THEN** the new PR/release audit lane fails just as the scheduled audit does
- **AND** the high/critical minimum for other scanners does not weaken this npm contract

#### Scenario: Resolve the same exception on Windows
- **WHEN** the four-graph audit and exception evaluation execute on Windows, macOS or Linux
- **THEN** portable path-part lookup selects the same logical graph
- **AND** separators or case aliases cannot turn another graph into an exception match

#### Scenario: Advisory also affects an image or Python lock
- **WHEN** another scanner reports the same advisory for a different graph or artifact
- **THEN** the npm manifest exception is not transplanted
- **AND** that surface requires its own exact reviewed evidence and policy entry

#### Scenario: Policy-only PR proposes an exact base-finding exception
- **WHEN** an observed current-base npm finding has a valid scoped proposal in a qualified data-only maintenance PR
- **THEN** the current adopted-policy audit still reports its actual blocking result before adoption
- **AND** only a distinct maintenance-admission result may permit merge, without weakening chain, stale-entry, expiry or infrastructure-error checks

#### Scenario: Code fix removes an obsolete npm exception
- **WHEN** complete candidate graph assessment proves the old finding resolved and the code fix withdraws only its exact now-inapplicable waiver
- **THEN** evaluation can constrain the trusted-base permission set without adding authority
- **AND** remaining stale entries or new unadopted grants still fail the strict audit contract
