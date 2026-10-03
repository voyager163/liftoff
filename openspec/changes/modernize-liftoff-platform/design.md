# Design

## Context

See `proposal.md` for motivation and capability scope. The exploration compared published npm `0.12.3` with the current checkout rather than treating planned capabilities as shipped.

The implementation already has `cli/`, `application/`, `domain/`, `adapters/`, generators, reviewed filesystem transactions, explicit artifact lifecycles, historical activation readers, and native repair integrations. Preserve these investments. The largest remaining mixed-responsibility areas include governance commands/policy rendering, self-upgrade, and activation validation; moving files alone does not establish an engine boundary.

Current coupling that this design removes:

- Self-upgrade resolves npm `latest`, checks npm global roots, and installs through npm. Its Homebrew handling repairs npm prefixes for Homebrew-managed Node; it is not a cask migration.
- A project plan requires a framework executable/version, initialization always invokes it, and some non-OpenSpec branches assume Spec Kit. Agent lists are required to be nonempty. Local baseline completion and active governance work assume framework artifacts.
- Application repair already supports external staged per-file patches and separately approved checks/writes. Ordinary update intentionally cannot overwrite project-owned files or change framework identity.
- Governance assessment has 30 catalog controls, of which 20 are evaluated and 10 are explicitly unsupported. Several production activation phases still lack usable producers.
- Fresh V8 coverage on the exploration checkout was CLI statements 82.23%, branches 76.41%, functions 87.96%, lines 84.50%; ingestion service statements 72.84%, branches 79.72%, functions 73.17%, lines 73.82%. These are observations, not a future release baseline. Saved reports covered a different source inventory and must not be reused as proof.
- Read-only Azure inspection on 2026-09-24 found the existing Container Apps/ACR/DCR/Log Analytics deployment in Korea Central under subscription `4158373b-2ebe-4b5f-9176-187d49e0ba84`, `rg-liftoff-prod`. The command table has six application columns and 180-day retention. No Grafana resource was present there; `Microsoft.Dashboard` was unregistered and advertised Korea Central. Re-observe before any future plan.

Existing specifications contain historical writer-version references and deferred execution requirements. The deltas distinguish historical contracts from the modernization target and explicitly narrow public existing-deployment state execution. This change does not rewrite archived change records.

## Goals / Non-Goals

**Goals**

- Make the CLI the single authority for plans, compatibility, explicit effects, approval, verification, and recovery, regardless of agent, workflow, installation channel, or plugin.
- Preserve compatible applications, Git history, artifact identities, historical proof, and independent scope approvals.
- Support a framework-free lifecycle without a hidden dependency on an agent or a replacement specification framework.
- Make installation ownership, partial completion, unsupported coverage, and observed adoption auditable.
- Qualify incremental implementation stages independently while retaining this comprehensive change as the planning source.

**Non-Goals**

- A language/runtime rewrite, microservice decomposition of the CLI, public plugin marketplace, runtime loading of project-supplied code, or built-in model orchestration.
- General framework/language conversion, additional API stacks, implementation of currently deferred GenAI specializations, or reinstating Power Apps.
- Intel macOS native artifacts/migration, Rosetta-based claims of native qualification, or legacy npm migration automation on Windows/Linux.
- Public import, relocation, partition, or address migration of pre-existing Azure deployment state. Private internal APIs remain preserved but are not advertised as enabled public capabilities.
- Publication, credentials, external account/repository changes, resource registration, or production deployment merely because planning artifacts or implementation are approved.

## Decisions

### D1. Keep the layers; make plugin composition explicit

Use application services to orchestrate use cases, domain modules for deterministic rules/plans, and adapters for concrete effects. Do not introduce a second overlapping `core/engines` tree or use a global service locator.

```text
src/
  cli/                         parsing, presentation, command composition
  application/                 init, assess, adopt, update, repair, workflow, upgrade
  domain/                      project, policy, assessment, compatibility, repair
  plugins/
    contracts.ts               typed contribution contracts
    registry.ts                deterministic validation/composition
    builtin/
      stacks/                  python-fastapi, node-fastify, go-huma
      clouds/                  azure
      workflows/               openspec, spec-kit, manual
      agents/                  copilot, claude, codex
  adapters/                    filesystem, process, git, github, azure, distribution
  generators/                  shared typed composition
assets/
  plugins/<plugin-id>/          plugin-specific templates and immutable locks
  templates/common/            genuinely shared template content
  skills/                      canonical Liftoff workflow instructions
  governance/                  policy, catalogs, compatibility and historical assets
  repair/                      packaged native helpers, not generated project files
distribution/
  homebrew/
  winget/
  linux/
services/telemetry-ingest/      independently deployed backend, not CLI core services
infrastructure/opentofu/
  bootstrap/
  telemetry/
    dashboards/
```

Extract by responsibility behind existing interfaces before changing behavior. Preserve temporary compatibility re-exports until imports and package smoke tests prove they are unnecessary. Domain/plugin planning contributions cannot depend on CLI presentation or perform direct I/O; effectful provider implementations stay in adapters bound by the application composition root. Extend the existing import/cycle tests.

Alternative rejected: a fresh monorepo/package-per-engine rewrite would combine packaging, API, and behavior risk without a demonstrated independent-release need.

### D2. Bundle trusted first-party plugins and one copy of each asset

Use a statically assembled release-owned registry, not filesystem discovery or an executable plugin installer. A descriptor identifies category, stable ID, plugin API version, release-owned version/digest, supported workload/platform combinations, exact artifact declarations, checks, and available recipes. Validate duplicate IDs, logical artifacts, case-colliding paths, incompatible combinations, and missing assets before rendering or mutation.

Descriptors contribute plans and bounded operations; they do not grant approval or expand the transaction's allowed write set. First-party executable plugins are trusted code, not sandboxed extensions. A capability declaration or import test is not an OS security boundary.

Move stack-specific content to its plugin asset area without copying it into a second canonical template directory. Shared content and policy stay shared. Continue explicit logical-name/path-part/lifecycle lookups; never select ownership or deletion by plugin directory, prefix, glob, or current file contents.

Preserve the existing supported stacks, optional Vue frontend, nine GenAI pattern identities, and their honest maturity limits. Package all built-ins with the CLI so Homebrew users do not need npm to fetch plugins. All baseline/lock/audit inventories include their installable dependency sets.

Alternative rejected: independently versioned third-party plugins would require trust, dependency resolution, distribution, and recovery policies outside the agreed first release.

### D3. Separate native packaging from project toolchains

Keep the Node.js/TypeScript implementation. First ship a runtime-inclusive directory bundle with an executable launcher, compiled application, dependency closure, package/release identity, assets, documentation, and required licenses. A single-file executable is not required. Prove asset lookup, ESM loading, HCL dependencies, and native helper paths from an installed bundle before choosing any additional bundling tool.

Initial native matrix:

| Host | Distribution | Qualification boundary |
| --- | --- | --- |
| Apple Silicon macOS | Upstream signed/notarized bundle through Homebrew cask | Native arm64; minimum macOS established by runtime and migration qualification |
| Windows x64 | Signed runtime-inclusive installer through WinGet | Supported Windows/PowerShell policy, native paths and Job Object behavior |
| Linux x64/arm64 | Versioned verified archives and a user-local installer | Declared glibc/runtime floor; no implicit musl or privileged distro-manager support |

Intel macOS and unqualified architectures/libc combinations fail before changes with honest support guidance. Existing npm artifacts are retained; an unsupported native target is not permission to remove an existing working installation.

Homebrew formulae remain appropriate for source-built tools; Liftoff's proposed cask is specifically for its upstream-built bundle. Preserve npm/uv where required by selected project frameworks or dependency preparation. The embedded runtime does not satisfy a Node project's external toolchain prerequisite by accident.

Bind all artifacts to one immutable source revision and CLI version. Assemble GitHub release assets, signatures/checksums, provenance, SBOM/notices, and release metadata before immutable publication. Preserve existing qualified-ref, maintainer approval, OIDC, and exact-artifact handoff protections. Use an explicitly verified tap/package ID; actual namespace ownership and signing access are release prerequisites, not assumptions or reasons to publish unsigned.

Alternative rejected: switching to Bun or rewriting in Go solely to obtain an executable multiplies behavioral and platform changes.

### D4. Upgrade delegates to the verified installation owner

Introduce distribution adapters for npm, Homebrew, WinGet, and the Liftoff-owned Linux/native installer. Each provides inspect, target/availability resolution, preview, apply or supported manual handoff, and verification. Inspection uses executable identity, authoritative package receipts/metadata, and containment, not a path substring or an untrusted project file.

Native release identity comes from verified release metadata; channel installability comes from the actual selected package channel. Existing npm installations retain canonical npm target resolution plus configured scoped-registry parity. Do not silently switch channels or bypass a managed mirror.

`liftoff upgrade` remains project-independent and preserves its `--check`, `--json`, and help surface. A separate installer migration utility performs npm-to-Homebrew transfer; do not overload ordinary upgrade with cross-owner cleanup. New upgrade JSON uses schema 2 with an enumerated owner and separate upstream/channel availability. Preserve 0=current/upgraded, 2=installable update found by check, 1=blocked/error. Unavailable channel metadata is unknown/blocked, never current.

Use literal executable/argument arrays and bounded subprocesses. No automatic `sudo`, broad `brew upgrade`, persistent registry/PATH modification, package-manager bootstrap, or lifecycle hooks. Where a package manager cannot safely install an exact reviewed target, report that limitation or an explicit manual handoff rather than replacing its files directly. If channel metadata changes before application, require fresh review. Handle Windows executable locking with a supported handoff/restart result, not in-place overwrite of a running locked image.

Success verifies the target version, package ownership/receipt, confined assets, direct executable, and resolvable launcher. Verification subprocesses remain telemetry/disclosure-free. Doctor uses the same owner/availability interpretation.

### D5. One-time Apple Silicon migration has a recoverable ownership handover

Provide a standalone macOS utility outside the old npm installation. Its default is a dry-run; explicit apply requires approval of the exact inspected old package and new cask. A bridge npm release makes the utility and guidance discoverable, but old users can download and verify the utility independently when their CLI lacks upgrade.

```text
discover -> preflight -> recovery-ready -> uninstall exact npm package
         -> verified residual-link cleanup -> cask install -> verify -> complete
                                                      |
                                                      +-> bounded recovery / partial
```

Before uninstalling, confirm native arm64, supported OS, approved Homebrew, exact cask availability, destination collisions, permissions, and a verified offline recovery copy of the old version. Record the owning npm executable/prefix and exact package/launcher identity. Distinguish Homebrew Node, nvm, Volta, and custom prefixes through verified manager data. Ambiguous or multiple copies require an explicit selection; do not search/delete all Node versions.

Uninstall only the selected `@msn-control/liftoff` using its actual manager. Remove a residual launcher only if its identity still proves it belongs to that package. Never use forced cask overwrite or broad prefix/cache/config cleanup. Homebrew and npm can compete for the same `bin/liftoff`; treat transfer as a journaled handover, not naive install-then-uninstall.

Retain user configuration, telemetry preferences, projects, `.liftoff` records, Node/npm, and unrelated packages. Recovery restores only verified attributable old installation material when the destination has not changed or become Homebrew-owned. Never undo a later user edit or uninstall an unrelated/new successful installation. Report old/new ownership and any remaining PATH/shell-cache issue explicitly; a script cannot mutate its parent shell's aliases/hash state.

Keep the bridge supported until a separately approved retirement decision. Never unpublish historical npm versions or silently migrate on ordinary startup.

### D6. Use an explicit current manifest successor

Target manifest artifact 8; continue strict historical readers for supported v2-v7 API/GenAI projects. Preserve retirement and unsafe-inner-boundary rejection. New writers use v8 only after a reviewed transaction or fresh generation; read-only inspection never upgrades metadata.

Retain existing workload, desired-state, managed-core, and project-provenance semantics. Add strict independently versioned plugin selection and active layout bindings:

- Plugin IDs/API compatibility/content identities identify the installed target, not user-granted executable authority.
- Layout bindings map finite logical component/artifact identities to validated portable project-relative paths. They establish active interpretation, not ownership or historical generation.
- Framework state distinguishes a real selected/initialized framework, preserved legacy uncertainty, and explicitly not-required Manual mode. Do not invent an executable, version, marker, or successful initialization for Manual.
- Imported project files have adoption observations, not fabricated generation hashes. Preserve old generation provenance separately from a later approved active path binding.
- Generate random telemetry identity only during explicit enrollment outside deterministic template/manifest rendering; no identifier is required for an opted-out project.

Keep machine metadata under existing reserved namespaces and external preview storage. No arbitrary new root-level machine files. Paths use native `path` APIs with portable path-part serialization; reject traversal, links/junction escapes, Windows drive/UNC parts in logical paths, and case aliases on all hosts.

Allocate the new activation contract and incompatible state/evidence/approval/compatibility schemas in one authoritative identity table before implementation; their concrete values must advance existing values and match actual changed representations. Bind profile and workflow applicability and compute real graph hashes. The activation package is the actual qualified release, not an invented version embedded in this plan. This allocation is an engineering task, not permission to relabel historical proof.

### D7. Manual is framework-free, with optional agents

Keep the compatible public `--spec` flag and add `manual`; label the prompt "Development workflow". OpenSpec remains the omission default for existing commands/configuration. For Manual, an explicitly empty configured agent list or `--agents none` selects CLI-only; `none` cannot be mixed with real agents. Manual's interactive selector permits zero agents and does not automatically preselect an agent. OpenSpec/Spec Kit retain their existing nonempty selections and applicable Spec Kit default rule.

Separate the workflow choice, external framework requirements, and agent delivery. `manual` is a built-in no-framework workflow descriptor, not an external framework with dummy executable/version fields. It creates no OpenSpec/Spec Kit directories, seed specifications, global profile changes, or framework commands. Existing unrelated documents remain untouched.

Local verification uses the same applicable project checks and ownership rules with a native Liftoff completion receipt; framework validation/archive steps are explicitly inapplicable. Do not mark fictional seed archive work verified. The activation graph and proof catalog must model this path explicitly. Manual governance uses a reviewed operational plan and evidence, not a mandatory substitute proposal/design/task framework.

Optional Liftoff skills work independently of framework delivery. Preserve current Copilot/Claude invocation paths and Codex native skill paths for compatibility; move canonical source text to shared assets rather than relocate installed user files merely for consistency. Add native files only through explicit named inventory and collision-safe approval.

CLI-only users use actual `governance ... --scope local` and approved activation commands where governance is enabled, plus validate/doctor/assess/repair. Do not invent a shell `liftoff setup`. With governance disabled, local validation/repair remains usable without constructing governance state.

### D8. Expose assessment, adoption, and workflow transition as distinct operations

Add `liftoff capabilities --json` for project-independent, no-network capability negotiation. Keep `repair --capabilities` compatible. The catalog lists implemented commands, report schemas, plugins, profiles, recipes, and supported host/scope boundaries; it cannot advertise missing producers as usable.

Add `liftoff assess [project] [--governance <profile>] [--json] [--live]` and the logical `liftoff-assess` agent integration. It composes layout, runtime/dependency declarations, workflow/agent integration, managed compatibility, governance, infrastructure, and documentation observations. Local mode does not run project code, access credentials, contact registries, enroll telemetry, or save receipts. Preserve the existing narrower `governance assess` API, adding the same explicit comparison-profile option without changing recorded selection or authority.

Results use schema 1 with explicit target/profile/plugin/layout identities, deterministic findings, evidence/provenance, coverage and unknowns, and separately categorized remediation. Reuse existing finding meanings; never turn missing evidence into compliance. Compare to the installed release, not registry latest. Ordinary Git repositories can be assessed without initialization; arbitrary non-Git adoption targets require an explicit safe project root.

Add `liftoff adopt [project]` with `--check`, `--json`, exact `--approve-plan`, and recorded recovery. It is the reviewed in-place path for supported non-Liftoff applications. Preserve `liftoff migrate <source>` as the sibling-copy flow. Existing Liftoff projects use `update` for control-plane/schema migration and `repair` for separately authorized application changes.

Adoption performs deterministic discovery and selects compatible bindings before proposing changes. Preserve a compatible layout; do not require canonical folders solely because the new template uses them. Bind imports, build/test scripts, Docker/Compose contexts, CI, and documentation references when moves are necessary. Ambiguity stays unresolved. Inventory existing databases, secrets, locks and cloud/state boundaries without executing or exposing them.

The approved adoption plan separates core metadata/configuration creation from application patches and optional independent environment/tool/framework preparation. Use the existing preview/approval/transaction machinery, extended with a distinct adoption identity and recovery lane. No commit, branch switch, stash/reset, push, destructive database operation, deployed resource change, or implicit application replacement.

Add `liftoff workflow set <openspec|spec-kit|manual> [project]` with check, exact approval and recovery semantics. It preserves application/Git/specification/history bytes while separately updating explicitly approved desired-state and integration identity. External framework initialization uses official pinned commands in isolated staging with distinct machine/global-profile consent. Never delete framework trees or uninstall shared tools when selecting Manual. Unknown or active overlapping work requires reconciliation, not force.

New adoption/workflow JSON starts at schema 1; these are not aliases for update or application-patch authority. Bare interactive apply displays a complete current plan and default-No consent; bare JSON/non-TTY operation previews rather than assuming permission. Automation uses full current fingerprints and explicit applicable effect permissions.

Alternative rejected: making ordinary update copy new project templates or making `init --force` the adoption engine violates existing ownership and history guarantees.

### D9. Skills assist semantic work; deterministic engines retain authority

Canonical setup, assessment, repair, and adoption guidance is shared across Copilot, Claude, and Codex. Host adapters render native frontmatter/invocations. Do not fork policy by model name or ask users to select a model for setup. A selected host supplies its own model, authentication, and privacy controls.

Skills check actual capabilities, obtain a deterministic inventory, explain uncertainty, and author exact semantic patches in external staging. They never mint approvals, edit real files first and seek retrospective consent, fabricate state/provenance, or replace a custom application with a starter. Generic instructions, agent autonomy, or a checked task do not provide effect approval.

Verification retains separate dependency preparation, project-code execution, declared network, and file-write consent. Staging is not an OS/network sandbox. Failed checks block application; cancellation after checks reports prior effects. CLI-only users can apply supported deterministic recipes or supply reviewed patches themselves; ambiguous semantic rewrites remain blocked rather than guessed.

### D10. Add team policy without changing single-maintainer meanings

Append `team-gitflow`; preserve `single-maintainer-gitflow`, `none`, and existing omission defaults. Team policy uses one independent human PR approval on applicable protected ref families plus existing automated checks. Self-approval, bot-only approval, stale approvals after relevant changes, missing reviewers, or skipped checks cannot substitute. Do not invent a reviewer identity or automatically merge without the policy's real evidence.

Keep policy assets/versions/digests distinct by profile. Team does not inherit the single-maintainer prohibition on human PR review, but neither profile adds an unrequested mandatory deployment reviewer. Respect existing stronger controls; an adoption/reconciliation plan must surface a proposed weakening rather than silently apply it. Preserve user CODEOWNERS; adding code-owner rules requires separately resolved valid ownership, not a fabricated team.

Bind profile to every assessment, plan, approval, graph interpretation, and proof. A profile switch is reviewed policy migration, never an automatic consequence of detecting several contributors. Preserve the single-maintainer zero-reviewer invariants and token-safe automated back-merges; team automation waits for its independent approval on back-merge PRs too.

Represent an explicitly requested profile change as a separately labeled local policy/successor plan under `update --check`, not ordinary unacknowledged core drift. Its approval can change only the inventoried local policy/identity and invalidate affected proof; live enforcement changes still require their own governance plan and approval. Unsupported source mappings remain blocked.

### D11. Complete real new-environment Azure activation, not brownfield state migration

Implement production adapters for the existing declared journey: identity/tenant/subscription verification, minimal provider readiness, approved backend/execution path, registry/identity prerequisites, source-bound artifact build/publication, deployment, health/qualification, GitHub checks and ruleset-last enforcement. Preserve approval, cost, quota, region, private access, credential, asynchronous-operation, and recovery boundaries. An emitted command, accepted API request, source file, or synthetic check is not completion.

Distinguish three cases:

1. **New environment:** eligible only after authoritative scoped observations, a complete plan, current permissions/cost approval, and absent or explicitly reusable non-mutated prerequisites.
2. **Resources created by this recorded activation:** resumable owned effects; bounded bootstrap state handover and recovery remain within the exact approved new-environment operation, with real locking, protected backups, readback and retention.
3. **Pre-existing deployment/state requiring adoption or rearrangement:** assessment/planning only in this release, even if internal migration primitives exist. No public state read/import/move/write capability is enabled to bypass this exclusion.

Missing local state is not absence. Do not provision duplicate resources when a name or binding is already occupied. An independent local application repair can proceed only if its exact effects do not change protected deployed configuration/state/writer bindings.

For private-backend bootstrap, reuse verified existing reachability where possible; otherwise qualify the bounded new-environment bootstrap and its controlled handover separately. If the available host cannot meet the protection/locking requirements, block with a supported execution-host prerequisite, not a plaintext fallback. Existing generic stateful APIs and historical journals are preserved, but their public qualification is not claimed.

Complete the advertised profile's evaluator coverage with actual observations; unsupported external licensing/platform facts remain explicit. Local-only completion stays independent. An end-to-end "complete" requires all applicable current deployment, qualification, required-context green/red, and live enforcement proof. Existing specification exit semantics for consistent-incomplete governance verification (exit 2) must agree with implementation and all skills.

### D12. Project adoption telemetry is an independent consented channel

Retain anonymous command aggregates, opt-outs, no queue, and failure isolation. Introduce command schema 2 with `success`, `attention-required`, `cancelled`, and `failure` derived from the command's semantic result. Do not infer outcome solely from its exit code: exit 2 can be expected drift or actual partially failed execution. Preserve v1 records and label their zero/nonzero semantics in dashboards.

Project reporting is explicitly opt-in and is not enabled by CLI installation, `--yes`, governance selection, or a pre-existing disclosure notice. Enrollment creates a random UUID in a separately inventoried `.liftoff` telemetry record, after permission, not during deterministic rendering. Local consent is also bound to that project in user-local consent storage; a copied/untrusted repository record alone cannot opt a developer in.

Count one project root/manifest. Clones/worktrees share its project ID, while independent projects in a monorepo have different IDs. An independent fork/template copy must be explicitly re-enrolled with a new identity; do not infer identity from URL/path hashes or silently rewrite copied IDs. Changing paths does not change the measurement identity, but still invalidates local write-plan receipts.

Expose explicit telemetry status/enrollment/disable/report operations. Pure status, capabilities, assessment (including live/help), repair inventory/capabilities, and dry-run migration do not collect project telemetry or create consent state. A local project observation requires current consent and a supported validated project; it never executes project code to collect attributes.

Project event schema 2 accepts only event name, project ID, invoked CLI version, selected policy profile/version (or explicit none), release-owned template/plugin-set digest, and source `cli` or `ci-heartbeat`. Add gateway ingestion time; no repo name/URL/path, code, file inventory, user/device ID, IP, free-form errors, or client timestamp. Keep the body under the existing 1 KiB bound. Store project events in a distinct `LiftoffProjectEvents_CL` table, leaving the command table and historical data intact.

`templateSetDigest` denotes the complete validated installed source registry (`registryDigest`), not the plugin-only digest or a project-selection resolution digest. This includes the shared core declarations/assets and remains constant across project choices supported by that bundle. Resolve it only after complete source-schema and release-owned declaration validation; reject unsupported source metadata rather than guess a historical bundle. It identifies the bundle that understands the source, not observed application-file contents, original generation history or update completion. Registry digests do not hash renderer code; the existing reviewed content-version discipline remains necessary. Measurement metadata does not establish root identity, consent, filesystem truth or execution authority.

At most one command aggregate and one project observation can follow an eligible command, with one request per applicable endpoint sharing the existing one-second overall telemetry budget. No retries, persistence queue, source-IP retention, or host telemetry daemon. Explicit reporting can return delivery/disabled/failure status without causing ordinary operations to fail.

Monthly CI reporting requires a second explicit enablement, not merely project enrollment. A repository-scoped, exactly inventoried workflow lists selected project roots explicitly; it does not scan and enroll every manifest. Adding/removing a nested project requires reviewed repository-level file authority and preserves other enrolled projects. Use pinned published CLI/action identities, minimal read permissions, no application scripts, and no package upgrade/repair/deployment effects.

`CI=true` continues disabling ordinary telemetry. Only the explicitly enabled heartbeat/report operation may use the narrowly declared CI reporting path; `DO_NOT_TRACK=1` or `LIFTOFF_TELEMETRY=0` always wins. Disabling one project stops its heartbeat without deleting unrelated workflow entries. No event is sent for opted-out, missing, or unsupported project metadata.

Disablement stops future delivery; it is not an assertion that accepted historical records were deleted. Both tables retain 180-day analytics/total retention. Document the operator-reviewed privacy deletion process without treating a public project ID as authentication. A heartbeat proves the configured repository still reports that project, not recent developer activity, deployment health, or compliance.

Alternative rejected: npm downloads, `init` counts, hashed Git origins, or automatic background polling cannot provide the requested project metric with the agreed privacy boundaries.

### D13. Extend the existing telemetry deployment with Grafana

Use Azure Managed Grafana with an Azure Monitor Logs data source and managed identity scoped to the telemetry workspace. Do not add Prometheus, Loki, Kubernetes, or another ingestion pipeline merely to draw charts. Provision dashboards, datasource configuration, roles, and alerts through reviewed OpenTofu/Grafana provider configuration with private operator credentials, never dashboard-embedded secrets.

Re-read the existing deployment/state ownership before planning. Preserve `rg-liftoff-prod`, Korea Central, the existing immutable image delivery, workspace/DCR, accepted records, separate protected state resource group/perimeter, and disabled persistent request/console/IP logging. Register `Microsoft.Dashboard` only through an explicitly approved prerequisite. Use a qualified available Managed Grafana Standard size and present actual recurring cost/region availability before approval; lack of signing/provider/account access is a blocker, not authority expansion.

Dashboards distinguish observed distinct projects over 30/90/180 days, newly first-observed projects within retained data, version/policy/template distribution, CLI versus heartbeat sources, expected-attention versus failures, and ingestion availability. Label distinct-count approximation where used. Do not label the retained window as lifetime adoption or extrapolate opted-in counts to all users. Qualification uses explicitly registered synthetic project IDs excluded from adoption queries, not an extra unapproved payload field.

No data, query failure, disabled reporting, expired retention, and zero observed events have distinct displays. Monthly schedule delays/inactivity and public forged events limit interpretation. Alert on verified service faults or missing expected reporting with a disclosed grace window, not low daily CLI usage. Retain a synthetic-event exclusion for dashboards and qualification.

### D14. Make quality and documentation reproducible release gates

Declare and pin the compatible coverage provider in each package, add source-complete coverage commands, and enforce strictly greater than 80% (80.01% configured floor) for statements, branches, functions, and lines separately for CLI and gateway. Include unimported executable source and built-in plugin code. Do not merge packages or exclude low-covered files to pass; report native helper/provider qualification separately. Aim for 85% margin without redefining the agreed acceptance floor.

Publish reports with revision, source inventory, tool versions and invocation. Missing/empty coverage or failed tests fail the gate. Run coverage once in a deterministic CI lane and run native functional/package tests on the declared platforms. Extend generated workload/workflow/agent/profile matrices with representative negative and recovery cases; preserve v2-v7 fixtures and historical proof bytes.

Refresh the four maintained README files identified in exploration plus every explicit generated README renderer/inventory and affected guides. Keep the landing page concise, preserve artwork/license/community links, and distinguish new supported behavior from historical/unqualified behavior. Do not edit `node_modules`, historical OpenSpec archives, or customer README files through ordinary update. Documentation tests cover actual registered syntax, schemas, profile differences, ownership, consent and supported platform paths.

## Risks / Trade-offs

- [Large change surface] -> Land stages behind explicit capability gates; keep mechanical extraction separate from behavior commits and qualify the combined release before promotion.
- [Native dependency or asset assumptions] -> Qualify runtime-inclusive bundles from paths outside the checkout on every advertised host before removing npm as primary onboarding.
- [Installer handover leaves no executable] -> Preflight cask access and verified offline recovery before uninstall; journal exact ownership and refuse concurrent-change rollback.
- [Arbitrary scripts or plugins escape declared effects] -> First-party trusted plugins only; separate script/network approval; state clearly that staging is not a sandbox and reject mandatory isolation that cannot be provided.
- [Custom layouts are misclassified] -> Explicit finite bindings and reference coverage; unresolved mappings block dependent operations rather than trigger canonical replacement.
- [Historical proof is mistaken for current authority] -> Separate readable/executable/migratable tables, exact source contracts, preserved raw bytes, fresh proof and no implicit profile/workflow switching.
- [New-environment scope drifts into brownfield import] -> Check current ownership before every write; exclude pre-existing deployment/state migration from public capabilities and recovery expansion.
- [Profiles silently weaken controls] -> Distinct profile identity, explicit profile-change plan, independent approval proof for team, and preservation of stronger existing controls until separately reviewed.
- [Telemetry adoption is overstated or identifying] -> Explicit dual consent, random project IDs, allowlisted fields, fixed retention, no identity derivation from repository metadata, directional/windowed labels.
- [Monthly CI is delayed or disabled by hosting policy] -> Display last observed time and unknown/stale reporting separately; never equate silence with abandonment.
- [Production dashboards introduce cost or logging] -> Re-observe existing state, review actual plan/cost/RBAC, preserve private state and logging exclusions, and qualify synthetic data without storing request details.

## Migration Plan

1. Freeze current public/help/JSON/rendering and historical fixtures; make coverage and package qualification reproducible. Record incompatible identities before changing them.
2. Extract boundaries and assemble built-in registries/assets with parity checks. No user project moves or installer changes in this mechanical stage.
3. Implement v8 readers/writers and exact historical successors; add Manual, optional agents, shared skills, whole-project assessment, compatible layout bindings and the team profile.
4. Complete reviewed adoption, workflow switching, agent additions and repair/update routing. Test old-project upgrade plus ongoing work, collisions, cancellation and restart recovery.
5. Qualify native bundles, manager-owned upgrade, and isolated Apple Silicon migration/recovery. Publish immutable native assets/cask availability before exposing the npm transition guidance. Retain the approved npm bridge and historical artifacts.
6. Complete and qualify fresh-environment Azure/GitHub production execution with explicit operator approval in disposable scopes. Existing deployment state changes remain unexecutable and labeled deferred.
7. Deploy backward-compatible ingestion/schema additions first through the approved operator path; qualify retention/privacy and preserve old data. Add Grafana/dashboards after datasource/roles are verified.
8. Release opt-in client enrollment and optional pinned monthly workflows only after their ingestion/dashboard contract is ready. Existing users remain unenrolled; migration preserves prior opt-outs.
9. Refresh all applicable README sources/guides and qualify the complete distribution/project/host matrix. Publish only after each advertised capability has real evidence; do not mark remaining mandatory tasks complete because a framework artifact exists.

Rollback is scope-specific: installer handover uses guarded exact old-installation recovery; pre-commit project transactions restore only attributable unchanged writes; post-commit identity/application changes retain history and require reviewed forward repair rather than blind downgrade; Azure retains operation checkpoints and approved compensation without cross-backend atomicity claims; telemetry can disable new ingestion/client reporting and roll back dashboards while preserving existing workspace/tables/state. Immutable releases are corrected by a newly qualified version, not replaced assets or moved tags.

## Open Questions

No product-scope decision blocks implementation planning. The following are qualification inputs, not permission to change scope:

- Exact minimum macOS/Windows/Linux runtime floors are determined by the selected runtime and native qualification matrix; unsupported hosts receive preflight refusal.
- Actual tap/WinGet namespace availability, signing credentials and approved publication principals are verified before publication. No tool may create an external repository or change an account without separate authorization.
- Actual release SemVer, computed graph hashes, advancing schema constants and compatibility digests are allocated through the existing release process after contract inventory; never use placeholder values in shipped artifacts.
- Live Azure principal, cost approval, Grafana availability and operator state-network access must be re-observed privately immediately before deployment. They are execution gates, not artifacts to fabricate.
