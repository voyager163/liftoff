## ADDED Requirements

### Requirement: Repository governance is distinct from spec-workflow governance
The system SHALL keep the durable repository-governance policy and activation handoff separate from OpenSpec configuration, Spec Kit constitution content, official framework output, and one-time workload seed changes. Selecting OpenSpec or Spec Kit determines how the post-Phase-0 governance change is created; it SHALL NOT change the canonical repository-governance profile's fixed invariants.

#### Scenario: Generate OpenSpec with repository governance
- **WHEN** a project selects OpenSpec and `single-maintainer-gitflow`
- **THEN** it receives official OpenSpec output, its one-time workload seed, and the separate durable repository-governance handoff
- **AND** archiving either active change does not remove or recreate the policy

#### Scenario: Generate Spec Kit with repository governance
- **WHEN** a project selects Spec Kit and `single-maintainer-gitflow`
- **THEN** it receives official Spec Kit output and the same canonical repository-governance profile
- **AND** the selected default agent is used only through the framework's normal integration contract

### Requirement: Repository governance context reflects actual infrastructure
The generated governance context SHALL enumerate only infrastructure, environments, deployment boundaries, health endpoints, and operations artifacts present in the resolved plan. It SHALL mark runner access, live deployments, monitoring, alerts, traffic volume, and platform rollout capabilities as discovery inputs rather than generated facts.

#### Scenario: Generate Azure API governance context
- **WHEN** a GenAI or standard API plan includes Azure OpenTofu and selected environments
- **THEN** context identifies those generated files and environment names
- **AND** does not claim that Azure resources are deployed or monitored

#### Scenario: Generate no optional frontend
- **WHEN** an API plan excludes the frontend
- **THEN** governance context and policy adaptation do not require frontend source, image, deployment, synthetic availability, or CDN controls

#### Scenario: Missing deployment capability
- **WHEN** Phase 0 cannot prove a staging environment, production deployment path, parallel-version mechanism, or monitoring signal
- **THEN** the proposed governance plan records the exact gap or inapplicability
- **AND** does not create a success-shaped placeholder workflow
