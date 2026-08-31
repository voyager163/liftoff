## Context

Liftoff owns several different dependency surfaces:

- the published CLI and telemetry service npm graphs;
- packaged npm manifests and lockfiles for generated Node.js and frontend projects;
- an immutable upstream Power Apps starter snapshot and generated lockfile;
- rendered Python project metadata and Azure Functions requirements;
- rendered Go modules and checksums;
- generated Dockerfiles, Compose services, OpenTofu constraints, and provider metadata;
- pinned OpenSpec and Spec Kit installers plus workstation runtime probes;
- GitHub Actions and maintenance scripts used to validate and publish the package.

These surfaces currently select versions independently. npm projects have lockfiles, Go has a checked-in `go.sum`, and Power Apps has source provenance, but generated Python projects use open-ended lower bounds, generated container references remain mutable, generated OpenTofu has no multi-platform provider lock, and the dependency-security workflow inventories only npm lockfiles.

The baseline selected during discovery is:

| Surface | Target release line |
| --- | --- |
| Liftoff and generated Node.js runtime | Node.js 24 LTS |
| Python runtime | Python 3.14 |
| Go runtime | Go 1.27 |
| OpenTofu CLI | OpenTofu 1.12 |
| OpenSpec CLI | OpenSpec 1.11 |
| Spec Kit CLI | Spec Kit 1.0 |
| Python resolver | `uv` 0.12 |
| AzureRM provider | 5.x |
| PostgreSQL | 18 |
| Redis | 8 |
| nginx stable | 1.30 |
| Alpine Linux | 3.24 |

Exact patches, package versions, image digests, provider checksums, and the Power Apps source commit are release inputs resolved and committed during implementation. Prereleases are excluded. Where an ecosystem distinguishes production LTS from a newer Current release, Liftoff selects the newest supported LTS.

## Goals / Non-Goals

**Goals:**

- Give every Liftoff release one machine-readable, deterministic supported-stack baseline.
- Make a generated project's documented install and verification commands consume only committed lock or digest state.
- Upgrade across stable major versions and complete the required compatibility migrations.
- Preserve offline generation: version resolution occurs during maintenance, never during user `init` or `update`.
- Make baseline refreshes repeatable, reviewable, security-audited, and verifiable on macOS, Linux, and Windows.
- Preserve the normal manifest hash, conflict, move, and orphan protections when existing projects adopt refreshed templates.

**Non-Goals:**

- Automatically upgrade dependencies from the network when a user runs Liftoff.
- Promise that every ecosystem's numerically newest release is suitable; supported LTS and platform compatibility take precedence.
- Rewrite locally modified files or silently migrate application code around a conflict.
- Modify Microsoft-owned Power Apps starter source independently of an immutable upstream refresh.
- Replace ecosystem-native lock formats with a Liftoff-specific package resolver.

## Decisions

### 1. Store one checked-in release baseline

A packaged JSON baseline under an explicit `assets` path will contain a schema version and named entries for runtimes, package managers, framework CLIs, direct dependency sets, OpenTofu providers, container images, and upstream snapshots. A typed TypeScript loader will validate the file and expose it to catalogs, workstation requirements, templates, maintenance scripts, and tests.

Each generated artifact remains named explicitly in template code and in manifest snapshots. The baseline does not discover files by glob or regex. Paths are represented as path-part arrays and resolved with Node's path APIs on every platform.

**Alternative considered:** keep constants in `catalogs.ts`, templates, workflows, and scripts. Rejected because it preserves the current drift-prone duplication and gives maintenance scripts no single machine-readable source.

### 2. Resolve versions only in a maintainer refresh

A refresh command will query canonical ecosystem sources, reject prereleases, apply the supported-LTS policy, materialize candidate files in temporary directories, and print a reviewable diff. It will not modify a user's generated project or run as part of `init`.

The committed baseline records exact resolved versions and immutable identities. CI verifies that manifests, locks, templates, workflows, and docs agree with it. Network-dependent freshness reporting runs separately on a schedule and fails closed on retrieval errors without rewriting the repository.

**Alternative considered:** resolve `latest` during every initialization. Rejected because output would vary by time, offline initialization would fail, and a Liftoff release could not identify the dependency set it tested.

### 3. Use ecosystem locks for every installable project

- npm surfaces retain coherent `package.json` and `package-lock.json` pairs regenerated with the baseline npm release.
- Each independently installable Python project receives a `uv.lock`. Documented setup uses `uv sync --frozen`; tests and runtime commands use the project-local environment created by `uv`.
- Azure Functions deployment requirements are exported deterministically from the corresponding lock when a platform-compatible `requirements.txt` remains necessary.
- Go templates retain complete `go.mod` and `go.sum` files generated by the baseline Go toolchain.
- Generated OpenTofu includes a checked-in `.terraform.lock.hcl` populated for the supported Windows, macOS, and Linux architectures.

Lockfiles are durable named artifacts. User initialization never needs to run a metadata-normalizing command such as `npm install`, `uv lock`, `go mod tidy`, or `tofu providers lock`.

**Alternative considered:** exact direct Python pins without a lock. Rejected because transitive resolution would remain time-dependent and would not reproduce the tested graph.

### 4. Pin containers and Actions by immutable identity

Generated Docker and Compose references use a readable release tag plus the tested multi-architecture manifest digest. GitHub Actions use full commit SHAs with version comments. The baseline and verification scripts reject `latest`, unqualified images, mutable major-only image references, and unpinned generated action uses.

Image refreshes verify supported architectures and run representative local-stack or container smoke tests. A digest update is a normal managed template upgrade and remains protected by manifest hashes.

**Alternative considered:** retain major tags such as `redis:7-alpine` and `langfuse:2`. Rejected because the bytes can change without a Liftoff release.

### 5. Treat major upgrades as compatibility migrations

The change upgrades source adapters and generated application code where APIs changed, rather than merely editing version strings. Representative matrices cover:

- the published CLI on Node.js 24 LTS;
- Python 3.14 GenAI and standard projects with frozen locks;
- Node.js/Fastify and Vue/Tailwind projects from regenerated npm locks;
- Go 1.27/Huma projects from regenerated modules;
- Power Apps install, lint, and build from a new immutable starter;
- OpenTofu formatting, offline-backend initialization, and validation with the new provider major;
- Docker build and local-service configuration for each generated runtime.

**Alternative considered:** stay within existing majors. Rejected by the selected requirement to move to the newest stable supported majors.

### 6. Preserve upstream Power Apps ownership

The existing immutable refresh process remains the only way to change Microsoft starter source. The refresh selects a reviewed upstream commit, verifies archive and license provenance, copies an explicit file catalog, regenerates the lockfile in a controlled environment, and re-runs cross-platform verification.

`liftoff update` may move from the recorded old starter identity to the newer snapshot only when both identities are known release catalogs. It reconciles each explicitly named artifact with normal hashes; arbitrary user edits to repository, path, or commit remain invalid.

The refreshed lock selects Power Apps SDK 1.2.7 as the newest compatible stable release. SDK 1.2.12 and newer remove the project-local `power-apps` binary required by the existing workload contract and move users toward a global `pa` CLI. The baseline records 1.3.0 as the reviewed incompatible candidate; adopting that CLI architecture is a separate workload migration rather than an unreviewed source rewrite in this change.

### 7. Separate freshness, vulnerability, and compatibility gates

- Freshness reports whether a newer supported stable baseline exists.
- Security audits block unresolved findings according to the existing exact exception policy.
- Compatibility verification proves generated projects install, build, lint, test, and validate.

No one signal substitutes for another. A version is promoted into the baseline only after all applicable gates pass.

## Risks / Trade-offs

- **[Large major-version blast radius]** -> Split implementation by dependency surface, regenerate artifacts through maintained scripts, and require the representative matrix before changing the canonical baseline.
- **[Newest stable package is incompatible with a platform runtime]** -> Record the newest compatible stable release with an explicit reason instead of forcing the numerically newest version.
- **[Python or provider locks differ by platform]** -> Generate locks with all supported platforms declared and verify unchanged metadata on Windows, macOS, and Linux.
- **[Immutable image digest lacks a supported architecture]** -> Inspect the manifest list and fail the refresh before committing it.
- **[Power Apps upstream changes generated architecture]** -> Review the explicit source diff and treat incompatible starter changes as a separate workload migration.
- **[Existing projects receive many update conflicts]** -> Keep hash-based safe adoption, document the breaking baseline, and never require `--force` as the default path.
- **[Version catalog becomes stale]** -> Add scheduled read-only freshness checks and Dependabot coverage, while keeping promotion into the baseline reviewed and tested.

## Migration Plan

1. Add and validate the baseline schema without changing generated output.
2. Upgrade the Liftoff CLI, telemetry service, framework installers, and CI runtime.
3. Refresh npm template graphs and verification.
4. Add Python locks and frozen install behavior, then upgrade the Python stack.
5. Regenerate and upgrade the Go stack.
6. Upgrade and lock OpenTofu providers and immutable container images.
7. Refresh the immutable Power Apps starter and enable release-catalog source reconciliation.
8. Update docs and snapshots, then run the complete cross-platform and generated-stack matrix.
9. Publish as a breaking Liftoff release so existing projects can inspect with `liftoff update --check` before applying.

Rollback is a source revert before publication. After publication, projects that have not applied remain on their recorded templates; projects that applied should restore through version control rather than having Liftoff silently downgrade dependencies.

## Open Questions

- The exact patch and digest inventory remains to be captured by the implementation-time refresh and committed baseline.
- Provider and package compatibility may require an explicitly documented exception from the newest stable patch; any exception must be surfaced in the baseline metadata and design review.
