## Why

Liftoff 0.12.3 provides useful generation, reviewed repair, and agent integrations, but npm-dependent delivery, incomplete activation, and limited adoption leave the intended project lifecycle unfinished. One coordinated release must provide a maintainable, self-contained CLI and honest, host-assisted workflows without losing existing projects, customizations, approvals, or history.

## What Changes

- **BREAKING**: Make self-contained macOS, Windows, and Linux packages the only distribution for the coordinated release. Use a Homebrew cask in an upstream-maintained tap on macOS, WinGet on Windows, and verified direct packages on Linux. Do not publish a new npm edition or migration bridge; retain historical npm artifacts and document a one-time, explicitly approved installation handover.
- Organize one modular application into six capability engines: Standards and Assessment, Project Generation, Project Evolution, Repository Governance, Azure Activation, and Distribution and CLI Upgrade. Reuse one execution kernel and versioned public protocol rather than creating services, model runtimes, or independent approval systems.
- Reuse the working 0.12.3 repair contracts, explicit application patches, private verification workspaces, dependency preparation, process supervision, and historical recovery instead of implementing parallel substitutes.
- Provide one canonical, capability-negotiated skill library for Copilot, Claude Code, and Codex. Existing agent hosts supply LLM reasoning; Liftoff validates proposals and owns approved execution. Support assessment before initialization, collision-aware host delivery, and reviewed migration of existing integrations.
- Compose project templates from an explicit packaged catalog, shared components, pinned locks, governance assets, and selected host integrations. Keep complex rendering in typed generators and track artifact ownership by exact registered identities.
- Add whole-project assessment and reviewed in-place adoption for the existing supported stack profiles. Preserve business behavior and user-owned files; unsupported stacks receive read-only assessment and explicit blockers. Preserve the existing fresh-target-only `migrate` workflow as a distinct operation.
- Resolve #78 as one complete scope: phase-specific input hashing, history-preserving publication revalidation, valid Azure bindings, configuration-preserving continuation, correct verification exits, and actual missing production executors.
- Resolve #79 with an explicitly selected repository-only enforcement boundary, real positive/negative check evidence, exact approval, owned-control reconciliation, and an optional reviewed main-update hold. Repository enforcement must not manufacture cloud or production completion.
- Resolve #80 through explicit Azure TLS/private-blob defaults and supported reviewed remediation for existing infrastructure. Resolve #81 through prefix-safe Scalar/schema routing, including equivalent Node behavior and qualification of Python/GenAI variants.
- Resolve #82 by validating current GitHub pull-request ruleset fields and preserving their effective review/restriction meaning. Supported disabled/empty defaults must normalize successfully; genuinely unknown or malformed enforcement fields must still fail closed.
- Add a version-controlled Azure Monitor dashboard with Grafana over the existing Liftoff telemetry workspace and `LiftoffCommandEvents_CL` table. Show recorded command events, command/version breakdowns, nonzero exits and data freshness without claiming unique users, adding telemetry fields, or provisioning a separately billed Managed Grafana workspace. Operator-approved deployment and viewer data access remain independent of normal CLI use.
- **BREAKING**: Introduce explicit new contracts where adoption provenance, repository-only policy, activation semantics, or serialization change. Preserve supported historical readers and receipts; changes in hashing or graph identity require reviewed migration and fresh proof, never retagging old records.
- **BREAKING**: Introduce governance policy 8 and credential-policy schema 2 to represent GitHub's required `organization_administration:read` grant explicitly, including its broader organization, billing and Actions-settings read reach. Require fresh exact approval and independently verified grants; preserve schema-1 policies, the prior policy-7 candidate identity and their original approvals without granting new authority.
- Enforce lines, branches, functions, and statements strictly above 80% for the CLI and telemetry service separately. Require supported-platform and installed-artifact qualification before release, including resolution of the observed 0.12.3 Windows execution failures.
- Refresh every checked-in and generated README and directly inconsistent guides. Retain only `main` and `develop` as permanent branches, while preserving active temporary PR branches and any uncommitted or unmerged work during cleanup.
- Deliver the complete agreed capability matrix in one coordinated release. Internal implementation milestones are permitted; unavailable required executors, unqualified native artifacts, or missing recovery paths cannot be deferred while declaring the release complete.

## Capabilities

### New Capabilities

- `liftoff-engine-platform`: Six logical engines, a shared execution kernel, versioned command/capability contracts, and enforceable module boundaries.
- `liftoff-native-distribution`: Self-contained native packages, release identity, installation ownership, and direct npm-to-native cutover.
- `liftoff-project-assessment`: Evidence-backed whole-project inventory and standards-gap reporting before or after initialization.
- `liftoff-project-adoption`: Reviewed adoption of existing supported-stack repositories with truthful provenance and controlled application changes.
- `liftoff-agent-skills`: One canonical workflow library projected to selected agent hosts with capability negotiation and no embedded LLM client.
- `liftoff-release-qualification`: Strict per-package coverage, platform/runtime and telemetry-dashboard qualification, and one coordinated publication gate.

### Modified Capabilities

- `liftoff-cli-workflow`: Native runtime behavior, the expanded public lifecycle, complete context binding, and unambiguous scope outcomes.
- `liftoff-cli-self-upgrade`: Installation-owner-aware native upgrades and explicit legacy migration rather than global npm replacement.
- `liftoff-npm-distribution`: Historical-only npm availability; retire future npm publication and npm as release authority.
- `liftoff-project-scaffold`: Catalog-based component composition, native-packaged resources, and current manifest/profile identity.
- `liftoff-standard-projects`: Prefix-safe API documentation and generated-schema routing across supported backends.
- `liftoff-manifest-contract`: Truthful adoption provenance, explicit current writers, and preserved historical readers.
- `liftoff-template-ownership`: Exact ownership for templates, profiles, skills, adoption effects, and compatibility retirement.
- `liftoff-project-update`: Reviewed integration/profile migration without changing installation ownership or granting application/cloud authority.
- `liftoff-project-migration`: Preserve source-safe fresh-target migration while generating the current manifest and distinguishing it from in-place adoption and installer migration.
- `liftoff-project-repair`: Reused 0.12.3 guarantees, qualified process settlement, and bounded Azure baseline-setting remediation.
- `liftoff-governance-activation-engine`: Phase-scoped inputs, repository-only completion, correct continuation/exits, and real production execution.
- `liftoff-activation-migration`: Reviewed recovery of affected schema-3 publication and explicit migration to the new activation identity.
- `liftoff-repository-governance-profile`: Repository-first enforcement, deferred-production main holds, real GitHub capability admission, and effective current review-rule semantics.
- `liftoff-governance-assessment`: Safe interpretation of historical v1-v3/current v4 identities, strict current GitHub ruleset normalization, and separation of repository proof from full activation.
- `liftoff-infrastructure-governance`: Explicit Azure defaults, approved environment execution, and verification of actual effects.
- `liftoff-project-doctor`: Native installation diagnostics and separate project, repository, activation, and migration readiness.
- `liftoff-workstation-bootstrap`: Separate the bundled CLI runtime from selected project and specification-tool prerequisites.
- `liftoff-supported-stack-baselines`: Bind native runtimes, supported profiles, resource catalogs, and qualified dependency sets.
- `liftoff-cli-telemetry`: Preserve the minimal aggregate event/privacy contract and add operator-owned Grafana visualization of existing Azure Monitor telemetry.
- `liftoff-source-repository`: Native source/release ownership and safe permanent/temporary branch lifecycle.
- `liftoff-user-documentation`: Current cask/native installation, migration, capabilities, all READMEs, telemetry-dashboard access and interpretation, and executable workflow guidance.

## Impact

- Baseline: `v0.12.3`, commit `70d10881b46d873118d825735696f39b6d35ebe0`. Planning does not upgrade installations, change branches, mutate projects, or contact cloud resources.
- Main implementation areas: `src/cli`, `src/application`, `src/domain`, `src/adapters`, `src/generators`, `src/governance-activation`, `src/repository-governance.ts`, packaged assets, telemetry dashboard definitions and OpenTofu provisioning, release automation, tests, and documentation.
- External interfaces: existing command/JSON contracts, managed agent artifacts, manifest and activation identities, current GitHub ruleset response contracts, approved Azure execution, Azure Monitor Grafana dashboards and viewer RBAC, native package metadata, and legacy npm installation ownership.
- Existing projects move to the new executable first. Project assessment, managed update, adoption, repair, and activation migration remain separate reviewed operations; no project reinitialization or removal of project npm dependencies is part of installation.
- Publication requires release signing, package-manager identities, approved platform runners, and separately authorized disposable live qualification. Missing access blocks release qualification rather than permitting mock results or reduced scope to stand in for production evidence.
- Approval of the credential permission amendment changes the implementation contract only. It does not authorize credential use, provider access, secret replacement, qualification resources, deployment or publication, and does not resolve the separate PAT identity/lifetime or conditional secret-creation requirements.
- Dashboard provisioning reuses the existing telemetry store rather than creating a second ingestion pipeline. Subscription/workspace bindings are operator configuration, not hard-coded public source values; normal CLI commands and project activation do not acquire dashboard or telemetry-production administration rights.
- Linked reports: #78, #79, #80, #81, and #82. The 0.12.3 Windows CI failure is additional qualification work, not evidence that its root cause has already been established.
