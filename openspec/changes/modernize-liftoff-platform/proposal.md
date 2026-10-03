# Proposal

## Why

Liftoff's npm-specific distribution, framework-dependent lifecycle, partially implemented activation, and fragmented project inspection prevent a consistent journey from an existing application to a safely maintained governed project. Its expanding implementation needs explicit extension boundaries, reproducible coverage gates, and adoption measurements that count participating projects rather than command invocations.

## What Changes

- Deliver verified runtime-inclusive distributions through a Homebrew cask for Apple Silicon macOS, WinGet for Windows, and verified native archives for Linux. Retain npm as a documented transition/compatibility channel; legacy installer migration targets Apple Silicon macOS only.
- Provide a standalone, preview-first npm-to-Homebrew migration utility that prepares recovery before uninstalling the exact verified old package, cleans only attributable launcher remnants, and verifies Homebrew ownership and command resolution.
- Separate core application services, deterministic engines, I/O adapters, and bundled first-party plugins. Keep TypeScript/Node.js and one CLI package; package plugin-specific templates/locks separately from shared content.
- Add whole-project assessment and equivalent agent guidance. Prefer existing compatible application layouts and use reviewed, verified patches only where the selected standard requires changes.
- Add reviewed in-place adoption of non-Liftoff projects while retaining the existing source-preserving sibling migration command. Reuse managed update, repair, compatibility, and recovery machinery for existing Liftoff projects.
- Add `Manual` beside OpenSpec and Spec Kit, with optional Liftoff agent integrations and a CLI-only path. Preserve governance, verification, and approval guarantees without requiring a substitute specification framework.
- Add a distinct team GitFlow profile requiring one independent human PR approval, while preserving the single-maintainer profile's meanings and defaults.
- Complete production Azure/GitHub execution and live verification for approved new environments. Assess and plan pre-existing deployments, but do not publicly execute their resource adoption or state migration in this release.
- Add explicitly opted-in pseudonymous project reporting and separately enabled monthly CI heartbeats. Count a Liftoff project root/manifest, share identity across its clones/worktrees, and preserve telemetry-free assessment.
- Extend the existing telemetry deployment in subscription `4158373b-2ebe-4b5f-9176-187d49e0ba84`, resource group `rg-liftoff-prod`, with Azure Managed Grafana and version-controlled dashboards. Preserve the existing backend, state protections, event history, and region unless separately approved.
- Enforce coverage strictly greater than 80% for statements, branches, functions, and lines independently for CLI and ingestion service, with honest native/platform and generated-project qualification.
- Refresh all maintained repository READMEs, generated README sources, and directly related guides without rewriting historical archives or automatically replacing customer documentation.
- **BREAKING:** Introduce an explicitly versioned manifest/compatibility successor for plugin and preserved-layout bindings, Manual mode, and profile-aware activation. Older readers must reject unsupported targets; existing projects change only through reviewed migration.
- **BREAKING:** Version changed upgrade reports, activation identities where their meaning changes, and telemetry outcome semantics. Do not silently reinterpret historical records or use one version number for independent contracts.

## Capabilities

### New Capabilities

- `liftoff-native-distribution`: Runtime-inclusive releases, channel ownership, platform qualification, and bounded Apple Silicon npm-to-Homebrew migration.
- `liftoff-bundled-plugins`: Release-owned plugin contracts, registries, canonical skill delivery, and deterministic template composition.
- `liftoff-project-assessment`: Read-only whole-project conformance analysis and agent explanations across supported layouts and workflows.
- `liftoff-quality-gates`: Reproducible source-complete coverage and platform/package/behavior acceptance gates.
- `liftoff-telemetry-dashboard`: OpenTofu-managed Grafana, explicit adoption metric definitions, and privacy-preserving operational dashboards.

### Modified Capabilities

- `liftoff-cli-workflow`: Manual/optional-agent selection, team governance, assessment/adoption/workflow-switch/reporting surfaces, and truthful scoped completion.
- `liftoff-cli-self-upgrade`: Verified installation-owner delegation, channel availability, and replacement verification without project mutation.
- `liftoff-npm-distribution`: Native-first onboarding with a supported non-destructive npm transition channel and preserved release protections.
- `liftoff-workstation-bootstrap`: Distinguish the embedded CLI runtime from project prerequisites and make external frameworks/agents conditional.
- `liftoff-supported-stack-baselines`: Include native-runtime/platform and bundled-plugin identities in the release-owned compatibility baseline.
- `liftoff-project-scaffold`: Framework-free generation, canonical shared/plugin templates, optional integrations, and the current manifest successor.
- `liftoff-manifest-contract`: Historical readers, current versioned plugin/layout/workflow identity, and separated ownership/provenance.
- `liftoff-template-ownership`: Explicit plugin output ownership, preserved-layout bindings, and separately authorized adoption/workflow changes.
- `liftoff-project-migration`: Reviewed in-place adoption and workflow changes alongside unchanged sibling-migration safety.
- `liftoff-project-update`: Safe successor migration, plugin/layout-aware managed comparisons, and routing to separate adoption/repair/workflow operations.
- `liftoff-project-repair`: Capability-negotiated semantic patch assistance, compatible layouts, Manual integrations, and deferred existing-deployment state writes.
- `liftoff-project-doctor`: Owner-aware installation diagnosis, conditional prerequisites, and shared layout/plugin/workflow interpretation.
- `liftoff-repository-governance-profile`: Independent team profile, Manual-compatible governance, and new-environment activation scope.
- `liftoff-governance-activation-engine`: Framework-independent local completion, real production producers, profile-bound proof, and bounded recovery.
- `liftoff-activation-migration`: Exact history-preserving successors from supported released identities without cloud/state migration authority.
- `liftoff-governance-assessment`: Profile-specific targets and shared coverage interpretation without weakening read-only guarantees.
- `liftoff-infrastructure-governance`: Approved new-environment provisioning, preserved compatible layouts, and planning-only treatment of existing deployments.
- `liftoff-cli-telemetry`: Versioned semantic outcomes, independent project enrollment/heartbeat consent, strict payloads, and bounded retention.
- `liftoff-user-documentation`: Native installation/migration, plugin maintenance, Manual mode, project adoption, profile/Azure scope, coverage, and telemetry guidance.

## Impact

- CLI parsing/presentation, application coordinators, domain contracts, packaged registries/assets, framework adapters, update/repair/history stores, and cross-platform process/filesystem boundaries.
- Installer/release pipelines, npm compatibility publishing, Homebrew/WinGet manifests, signed platform bundles, dependency notices, smoke tests, and release identity verification.
- Existing v2-v7 project manifests and historical activation/repair records require explicit readable/executable/migratable contracts; no blanket conversion, history rewrite, or new authority from matching template bytes.
- The telemetry client, strict gateway, Azure collection rules/tables, consent records, generated repository-scoped heartbeat workflow, and OpenTofu/Grafana configuration.
- All work remains in this one planning change but is delivered through dependency-ordered implementation stages and separate release/deployment gates. Planning approval does not publish packages, create external repositories, enroll credentials, provision resources, or approve customer-project mutations.
- Out of scope: Intel macOS native distribution/migration, third-party plugin loading, AWS/GCP execution, new API language stacks, a built-in LLM runtime, arbitrary application conversion, new GenAI specializations, and public mutation/import of pre-existing Azure deployment state.
