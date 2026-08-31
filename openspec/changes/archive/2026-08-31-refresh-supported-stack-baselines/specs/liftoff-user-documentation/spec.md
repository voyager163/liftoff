## ADDED Requirements

### Requirement: Documentation identifies the tested supported-stack baseline
The system SHALL publish the current runtime and framework release lines, frozen dependency commands, immutable-source rules, and baseline refresh policy in packaged user and contributor documentation. Version statements in getting-started, prerequisites, workloads, CLI, generated-project, maintenance, and contributor guidance SHALL agree with the release-owned baseline.

#### Scenario: Developer checks prerequisites
- **WHEN** a developer reads the prerequisites for a selected workload
- **THEN** the guide identifies only the applicable Node.js, Python, Go, `uv`, OpenTofu, OpenSpec, or Spec Kit constraints
- **AND** the values match the current baseline

#### Scenario: Developer installs Python dependencies
- **WHEN** generated or packaged documentation describes Python setup
- **THEN** it uses the platform-appropriate frozen `uv` synchronization flow
- **AND** it does not instruct the developer to regenerate a lock or install from open-ended ranges

#### Scenario: Existing project reviews a major baseline
- **WHEN** release notes or update guidance describe the new major Liftoff release
- **THEN** they identify raised runtime floors and major generated-stack migrations as breaking
- **AND** direct the developer to inspect `liftoff update --check` before applying

### Requirement: Contributor guidance documents reproducible baseline refresh
Contributor documentation SHALL identify the canonical version sources, stable and LTS selection policy, temporary materialization process, explicit inventory updates, immutable Power Apps refresh boundary, and complete verification commands required before promoting a baseline.

#### Scenario: Maintainer refreshes dependencies
- **WHEN** a maintainer follows the documented refresh process
- **THEN** no user project or mutable upstream state is used as the source of truth
- **AND** the resulting diff includes the baseline, manifests, locks, digests, checksums, tests, and documentation that changed
