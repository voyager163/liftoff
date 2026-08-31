## Why

Liftoff currently mixes old runtime and framework baselines, open-ended Python dependency ranges, stale generated provider and container versions, and manually maintained lock snapshots. A Liftoff release therefore cannot prove that every generated workload uses one reproducible, fully tested set of current stable dependencies.

## What Changes

- Introduce one release-owned supported-stack baseline that records the exact tested runtimes, framework CLIs, direct dependencies, package-manager versions, OpenTofu providers, and container images used by generated projects.
- Upgrade Liftoff and its generated GenAI, standard API, frontend, telemetry, and Power Apps surfaces to the newest stable supported major versions, including Node.js 24 LTS, Python 3.14, Go 1.27, OpenTofu 1.12, OpenSpec 1.11, and Spec Kit 1.0 release lines.
- Add generated `uv.lock` files and frozen `uv` installation for Python projects; regenerate npm lockfiles and Go module checksums from the tested baseline.
- Replace mutable generated container references with tested immutable image identities and refresh generated OpenTofu provider constraints and locks.
- Refresh the Power Apps workload only from a verified immutable upstream starter commit and allow a Liftoff release to reconcile that recorded source upgrade safely.
- Expand dependency freshness, security, scaffold, installation, build, lint, test, and cross-platform verification across every maintained dependency surface.
- **BREAKING**: Raise supported runtime floors and adopt major framework, provider, frontend, and dependency versions; existing generated projects may report substantial managed upgrades or conflicts on `liftoff update`.

## Capabilities

### New Capabilities

- `liftoff-supported-stack-baselines`: Defines release-pinned version selection, reproducibility, refresh policy, immutable dependency metadata, and verification for all maintained stacks.

### Modified Capabilities

- `liftoff-npm-distribution`: Raise the published CLI's supported Node.js baseline and verify the upgraded package dependency graph.
- `liftoff-project-scaffold`: Generate current reproducible GenAI dependencies, Python locks, and immutable local-service and container metadata.
- `liftoff-standard-projects`: Upgrade the Python, Node.js, Go, and optional frontend stack contracts while preserving their workload boundaries.
- `liftoff-power-apps-code-apps`: Refresh the immutable official starter snapshot and its tested dependency graph.
- `liftoff-workstation-bootstrap`: Probe the new runtime floors and use frozen `uv` installation for generated Python projects.
- `liftoff-project-doctor`: Diagnose upgraded runtime and frozen dependency metadata consistently with initialization.
- `liftoff-template-dependency-security`: Permit reviewed major baseline refreshes and verify all refreshed packaged npm dependency graphs.
- `liftoff-infrastructure-governance`: Upgrade and pin generated OpenTofu, provider, runtime, and container dependencies.
- `liftoff-project-update`: Reconcile release-driven dependency and immutable Power Apps starter upgrades without fetching mutable upstream state.
- `liftoff-user-documentation`: Publish the exact supported baselines, upgrade implications, and frozen install commands.

## Impact

This affects package metadata and lockfiles, runtime and framework catalogs, workstation probes, project dependency commands, generated templates, Docker and Compose output, OpenTofu output, the packaged Power Apps snapshot, update and doctor behavior, CI workflows, verification scripts, tests, and user documentation. Maintainers will need a repeatable baseline-refresh process, and existing projects will retain normal hash-based conflict protection during adoption.
