## 1. Baseline Catalog And Refresh Tooling

- [x] 1.1 Add the packaged schema-versioned supported-stack baseline with explicit named entries for runtimes, package managers, framework CLIs, npm/Python/Go dependencies, OpenTofu providers, container images, and upstream starter sources.
- [x] 1.2 Add a typed baseline loader and fail-closed validation for exact versions, stable release lines, immutable digests, canonical sources, supported platforms, and explicit path-part inventories.
- [x] 1.3 Refactor catalogs, workstation requirements, templates, scripts, and workflow assertions to consume or validate against the baseline instead of duplicating version literals.
- [x] 1.4 Add a maintainer refresh command that resolves stable candidates from canonical sources in temporary directories, applies the Node LTS policy, rejects prereleases, and prints a reviewable diff without changing user projects.
- [x] 1.5 Add a scheduled read-only freshness check that reports stale entries and fails on retrieval or parse errors without rewriting the baseline.
- [x] 1.6 Add deterministic fixtures and tests for baseline parsing, unsupported schema versions, prerelease exclusion, LTS selection, incompatible stable exceptions, missing inventory entries, and cross-platform path resolution.

## 2. Liftoff Runtime And Framework Toolchain

- [x] 2.1 Upgrade the root CLI and telemetry service to the Node.js 24 LTS engine floor, align `@types/node`, update direct npm dependencies to tested stable majors, and regenerate both lockfiles.
- [x] 2.2 Upgrade the pinned OpenSpec 1.11 and Spec Kit 1.0 framework definitions, installers, marker expectations, command adapters, and compatibility tests.
- [x] 2.3 Upgrade the registered Python 3.14, Go 1.27, OpenTofu 1.12, Node.js 24, and `uv` 0.12 workstation constraints and platform remedies from the baseline.
- [x] 2.4 Update CI and release runtime lanes, pin every GitHub Action to a full commit SHA with a version comment, and add assertions that workflow runtime and action identities match the baseline.
- [x] 2.5 Update startup, workstation, framework, package-smoke, telemetry, help, terminal, and snapshot tests for the raised runtime and framework contracts.

## 3. Packaged Npm Project Templates

- [x] 3.1 Upgrade the standard Node.js backend manifest to the tested Node.js 24, Fastify, TypeScript, Drizzle, PostgreSQL, and Vitest graph, migrate incompatible source or configuration APIs, and regenerate its deterministic lockfile.
- [x] 3.2 Upgrade the optional Vue frontend to the tested Vue, Vite 8, plugin-vue 6, Tailwind 4, PostCSS, and Autoprefixer graph, migrate build and styling configuration, and regenerate its deterministic lockfile.
- [x] 3.3 Expand explicit npm freshness and security inventories to cover the root CLI, telemetry service, backend template, frontend template, and current Power Apps snapshot without recursive discovery.
- [x] 3.4 Extend standard npm template verification to install with every supported npm compatibility lane, run backend build/tests and frontend production build, and fail when package metadata changes.
- [x] 3.5 Update dependency-security fixtures, compatible-patch behavior, reviewed major-refresh behavior, and exception validation for the refreshed npm graphs.

## 4. Locked Python Project Templates

- [x] 4.1 Upgrade GenAI and standard Python templates to Python 3.14 and the tested stable FastAPI, Pydantic, PydanticAI, Scalar, SQLAlchemy, database, Azure, test, packaging, and observability dependency graph.
- [x] 4.2 Migrate generated Python source and configuration for PydanticAI 2, Langfuse 4, Redis 8, pytest 9, and any other changed major APIs while preserving each workload's public routes and boundaries.
- [x] 4.3 Generate an explicitly named `uv.lock` for every independently installable Python backend and add deterministic locked Azure Functions dependency metadata or exports.
- [x] 4.4 Replace Python dependency setup and generated guidance with platform-correct `uv sync --frozen` commands and protect every Python manifest and lock from installer mutation.
- [x] 4.5 Extend doctor and project validation to check Python lock presence, identity, frozen readiness, runtime compatibility, and exact repair commands without writing metadata.
- [x] 4.6 Add representative frozen install and test verification for standard Python, every GenAI pattern shape, and applicable Azure Functions workers.

## 5. Go Project Template

- [x] 5.1 Upgrade the generated Go module to Go 1.27 and the tested stable Huma, Chi, pgx, Goose, and indirect dependency graph.
- [x] 5.2 Apply required Go source migrations and regenerate `go.mod` and `go.sum` with the baseline toolchain.
- [x] 5.3 Verify module download, build, tests, migration command metadata, and unchanged module files on supported hosts.

## 6. Containers And OpenTofu

- [x] 6.1 Replace every generated Dockerfile and Compose base or service image with a baseline-owned stable tag plus immutable multi-architecture digest, including Python, Node.js, Go, Alpine, nginx, PostgreSQL/pgvector, Redis, Azurite, Mailpit, Langfuse, and bootstrap images.
- [x] 6.2 Add validation that rejects missing digests, `latest`, unqualified images, unsupported architectures, and mutable major-only image references in generated output.
- [x] 6.3 Upgrade generated Azure infrastructure to OpenTofu 1.12 and AzureRM 5 with required source migrations while preserving naming, identity, secrets, roles, queues, health, environments, and outputs.
- [x] 6.4 Generate and explicitly track a multi-platform `.terraform.lock.hcl` for generated Azure infrastructure and verify `tofu init -backend=false` does not rewrite it.
- [x] 6.5 Upgrade the repository's bootstrap and telemetry OpenTofu provider pins and locks to the same supported provider baseline where their contracts are compatible.
- [x] 6.6 Run formatting, initialization, validation, container build, and local-stack smoke coverage for backend-only, frontend, worker, and non-worker representative plans.

## 7. Immutable Power Apps Starter Refresh

- [x] 7.1 Select the newest verified compatible upstream Power Apps starter commit and run the controlled archive, license, explicit-file, source-diff, catalog, and npm lock refresh.
- [x] 7.2 Update the packaged starter baseline, provenance README, explicit audit inventory, commit-specific fixtures, and any non-reachability exceptions without modifying Microsoft-owned source independently.
- [x] 7.3 Change update identity validation to permit only the recorded-to-current Liftoff release-catalog starter transition while continuing to reject arbitrary repository, path, and commit edits.
- [x] 7.4 Verify fresh and upgraded Power Apps projects install, lint, build, preserve package metadata, render identically across platforms, and reconcile untouched, conflicting, moved, and orphaned starter files safely.

## 8. Documentation, Cross-Platform Verification, And Release

- [x] 8.1 Update packaged prerequisites, workloads, CLI, generated-project, update, troubleshooting, contributor, framework, and release documentation from the supported-stack baseline, including breaking runtime floors and frozen install commands.
- [x] 8.2 Update append-only logical-name snapshots, manifest fixtures, generated-stack fixtures, help/lifecycle snapshots, and dependency-policy fixtures for every new lock or baseline artifact.
- [x] 8.3 Add Windows, macOS, and Linux verification for all changed path, command, lock, framework, and generated artifact behavior using platform-native path handling.
- [x] 8.4 Run the root and telemetry checks, package smoke test, npm template security audit, all generated stack install/build/lint/test checks, Power Apps verification, container checks, and OpenTofu validation without metadata drift.
- [x] 8.5 Document the breaking release and rollback boundary so existing projects inspect `liftoff update --check`, retain conflicts without force, and recover applied changes through version control rather than an automatic downgrade.
