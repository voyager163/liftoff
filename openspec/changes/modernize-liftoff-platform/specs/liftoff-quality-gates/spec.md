## Purpose

Require reproducible coverage and behavior qualification so Liftoff releases cannot claim completeness from stale reports, empty inputs, mocked provider success or untested platform bundles.

## ADDED Requirements

### Requirement: CLI and gateway independently exceed eighty percent coverage
CI and release qualification SHALL require statements, branches, functions and lines each to exceed 80% independently for the CLI and telemetry ingestion service. The gate SHALL include all executable source files, including unimported entrypoints and bundled plugin code, and SHALL use a declared pinned coverage tool. Missing/empty coverage, failed tests or any metric at or below the threshold SHALL fail. Packages SHALL not be aggregated to hide a failing service, nor shall low-covered production files be excluded to satisfy the gate.

#### Scenario: Branch coverage is below the floor
- **WHEN** CLI lines exceed 80% but branches measure 76.41%
- **THEN** qualification fails regardless of passing tests or another package's coverage

#### Scenario: Gateway coverage fails independently
- **WHEN** the CLI passes but any gateway metric is at or below 80%
- **THEN** the release remains blocked

#### Scenario: All metrics exceed the floor
- **WHEN** both source-complete reports pass tests and exceed the threshold for all four metrics
- **THEN** the coverage gate passes for that exact revision and invocation
- **AND** passing coverage does not claim live provider or native qualification

### Requirement: Coverage evidence identifies its source and limits
Reports SHALL identify revision, source inventory, tool versions and invocation. Historical reports from different inventories or revisions SHALL not count as current evidence. Native helpers, child-process execution, generated applications and live providers SHALL have separate qualification evidence where coverage instrumentation does not measure them.

#### Scenario: Saved report contains removed paths
- **WHEN** a saved report does not match the current source inventory
- **THEN** it cannot satisfy current qualification and a fresh run is required

#### Scenario: Native test is skipped
- **WHEN** a host-specific or live test did not execute
- **THEN** reporting labels it unrun/skipped rather than using portable test results as proof

### Requirement: Release qualification covers installed behavior and preserved history
Qualification SHALL cover native installation, owner-aware upgrade, Apple Silicon handover/recovery, Manual and framework workflows, supported agents/profiles/stacks, old-project migration, compatible layouts, negative authority cases and interrupted recovery. Windows path/shim/junction/Job Object cases and Linux/macOS path/case behavior SHALL run on their applicable native CI lanes. Customer projects and real workstation installations SHALL not be used as destructive fixtures.

#### Scenario: Windows packaging changes
- **WHEN** paths or packaged native helpers change
- **THEN** the installed Windows artifact is exercised outside the checkout with spaces, native launcher resolution and actual policy-respecting process settlement

#### Scenario: Historic project is upgraded
- **WHEN** a supported v2-v7 fixture completes a reviewed target migration
- **THEN** its original application and historical evidence bytes are preserved except exact independently approved changes

#### Scenario: Required production producer is absent
- **WHEN** an advertised new-environment activation phase has only a test-injected adapter or success placeholder
- **THEN** end-to-end release qualification fails
