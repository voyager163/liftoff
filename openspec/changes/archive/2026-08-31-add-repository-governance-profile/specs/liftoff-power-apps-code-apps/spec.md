## ADDED Requirements

### Requirement: Power Apps projects receive only applicable repository governance
The system SHALL offer the common repository-governance profile to Power Apps code apps and SHALL generate policy context that reflects the root React, Vite, TypeScript, Tailwind, Power Apps SDK, immutable starter, npm, spec-framework, and selected-agent boundaries. It SHALL explicitly identify Liftoff API, database, Docker, OpenTofu, API environment, custom container promotion, and backend health controls as absent or inapplicable unless Phase 0 discovers separately owned infrastructure.

#### Scenario: Enable governance for Power Apps
- **WHEN** a developer accepts the default repository-governance profile for a Power Apps project
- **THEN** Liftoff generates the canonical handoff and selected-agent launchers
- **AND** context identifies the actual root application install, lint, and build commands

#### Scenario: Classify container controls
- **WHEN** the post-push agent runs Phase 0 against an unchanged Liftoff Power Apps scaffold
- **THEN** it does not propose a Liftoff container scan, image SBOM, OpenTofu deployment, blue-green container rollout, or API DAST lane
- **AND** it reports any repository, source, dependency, release, and Power Platform controls that genuinely apply

#### Scenario: External Power Platform deployment exists
- **WHEN** Phase 0 discovers a real Power Platform deployment and environment lifecycle outside Liftoff-owned files
- **THEN** the agent captures those facts in the approved governance change
- **AND** does not fabricate credentials, connections, or platform capabilities from the local scaffold
