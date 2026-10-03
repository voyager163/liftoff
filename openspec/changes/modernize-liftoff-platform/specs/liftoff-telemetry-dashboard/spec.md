## Purpose

Provide a privately accessed Grafana view of observed Liftoff adoption and telemetry health without overstating project counts or weakening the existing Azure privacy and ownership boundaries.

## ADDED Requirements

### Requirement: Grafana extends the existing approved Azure telemetry deployment
The operator deployment SHALL add Azure Managed Grafana, its Azure Monitor Logs data source, scoped managed-identity access and version-controlled dashboards through reviewed OpenTofu-managed configuration. The target SHALL be subscription `4158373b-2ebe-4b5f-9176-187d49e0ba84`, resource group `rg-liftoff-prod`. Existing Korea Central placement, state/backend/perimeter protections, ingestion resources, accepted records and deletion protection SHALL be preserved unless a separate approved plan changes them. Provider registration, actual service availability and recurring cost SHALL be verified and approved before provisioning.

#### Scenario: Dashboard deployment is planned
- **WHEN** the operator requests Grafana installation
- **THEN** the plan identifies actual provider readiness, region, supported tier/size, recurring cost and least-privilege roles
- **AND** planning alone does not register a provider or create resources

#### Scenario: Existing telemetry is already deployed
- **WHEN** the plan refreshes existing resource ownership and state
- **THEN** it extends the owned stack without recreating the workspace, losing records or creating a duplicate resource group

#### Scenario: Contributor validates configuration on Windows
- **WHEN** static configuration/dashboard checks run on Windows, macOS or Linux without Azure credentials
- **THEN** explicit dashboard paths resolve natively and validation performs no production plan/apply

### Requirement: Adoption dashboards use truthful project and time-window definitions
Dashboard project counts SHALL deduplicate the enrolled random identity of one Liftoff project root/manifest, sharing identity across its clones/worktrees and distinguishing projects within a monorepo. Views SHALL show observed distinct projects over 30/90/180 days, first-observed projects within retained data, policy/template/CLI distribution, source of observation and last-observed time. Counts SHALL be labeled as opted-in observations, not a census of all projects, lifetime adoption or proof of deployment/compliance. Approximate counts SHALL be labeled.

#### Scenario: A monorepo reports two projects
- **WHEN** two explicitly enrolled project roots have distinct IDs and one appears from several clones
- **THEN** the dashboard counts two projects, not clones or command invocations

#### Scenario: Retention no longer contains first enrollment
- **WHEN** observations older than 180 days are unavailable
- **THEN** the dashboard does not present its retained distinct count as all-time adoption

#### Scenario: Heartbeat exists without development activity
- **WHEN** a monthly job reports an enrolled project
- **THEN** the dashboard identifies a heartbeat observation
- **AND** it does not describe that as a daily active developer or healthy deployment

### Requirement: Health views distinguish failures unknowns and expected attention
Dashboards SHALL separate schema-2 semantic success, attention-required, cancellation and failure from legacy zero/nonzero records. Query failure, unavailable data, reporting disabled, expired retention and zero observed events SHALL have distinct states. Alerts SHALL use verified ingestion faults or disclosed heartbeat freshness expectations, not low daily command volume. Synthetic qualification observations SHALL be explicitly excluded from adoption views.

#### Scenario: Update check finds maintenance
- **WHEN** a schema-2 event reports expected actionable drift
- **THEN** it appears as attention-required rather than an installation or application failure

#### Scenario: Data source is unavailable
- **WHEN** the Logs query fails or is unauthorized
- **THEN** the dashboard shows unavailable data rather than zero projects

#### Scenario: Monthly schedule is delayed
- **WHEN** a project's expected heartbeat has not arrived
- **THEN** freshness reporting shows stale/unknown reporting with its disclosed grace period
- **AND** it does not assert project abandonment

### Requirement: Dashboard access and rollback preserve privacy
Grafana SHALL use authenticated access and workspace-scoped query authority without embedded credentials, public data sharing, source-IP persistence or newly enabled request/console logging. Dashboard/datasource rollback and new-ingestion disablement SHALL preserve the existing protected resource group, state and telemetry records. Public unauthenticated event counts SHALL be documented as forgeable directional measurements.

#### Scenario: Viewer opens a dashboard
- **WHEN** an authorized viewer accesses adoption charts
- **THEN** access uses approved identity/RBAC and exposes only the allowlisted telemetry dimensions

#### Scenario: Operator disables the new feature
- **WHEN** a reviewed rollback removes dashboard functionality or disables new reporting
- **THEN** existing command ingestion/data and protected infrastructure are not destroyed as an incidental cleanup
