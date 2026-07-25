## Why

Liftoff currently models only GenAI and standard API projects, so developers building Power Apps code apps cannot use the same guided scaffold, prerequisite checks, spec-driven workflow, and multi-agent integration. The public README also carries most operational detail inline, making the product value and first-use path harder to discover as Liftoff adds another workload.

## What Changes

- Add Power Apps code apps as a third workload that can initialize in a new directory or the exact current Git worktree root.
- Scaffold the workload from a tested, immutable revision of Microsoft's official Power Apps Code Apps starter without adding Liftoff's API backend, Azure OpenTofu, Docker Compose, or API environment questions.
- Keep OpenSpec or Spec Kit, GitHub Copilot and/or Claude Code, framework validation, and selected-agent markers as common capabilities for every workload.
- Replace the interactive comma-separated agent question on real TTYs with an arrow-key multi-select where Space toggles agents and Enter confirms; retain deterministic flag and redirected-input contracts.
- Derive Power Apps-specific readiness and dependency work from the plan, including the required Node.js runtime and project-local Power Apps CLI.
- Treat Microsoft's preview Code Apps agent plugin as a detected, clearly labeled, optional enhancement with independent consent or manual guidance; do not run its broad installer or invoke its project-creation skill.
- Make project plans, configuration, manifests, validation, doctor, and update understand workload-specific fields instead of requiring API, cloud, region, infrastructure, and environment fields for every project.
- Replace the text-heavy root README with a visual, task-oriented landing page and move lifecycle, safety, readiness, generated-structure, manifest, Azure, and troubleshooting detail into linked documentation.

## Capabilities

### New Capabilities
- `liftoff-power-apps-code-apps`: Power Apps code app planning, official starter scaffolding, project-local tooling, spec-framework setup, agent integration, and workload-specific completion behavior.
- `liftoff-user-documentation`: Product-oriented root README, visual quick start, workload and integration overview, and progressively disclosed user documentation.

### Modified Capabilities
- `liftoff-cli-workflow`: Add explicit workload selection, Power Apps-specific prompt routing, TTY agent multi-selection, noninteractive type inputs, and workload-aware plan summaries.
- `liftoff-project-scaffold`: Make generated structure and dependency phases conditional by workload instead of requiring an API backend and Azure-oriented layout.
- `liftoff-workstation-bootstrap`: Derive Power Apps runtime and project-tool requirements while keeping optional agent plugins separate from blocking tools.
- `liftoff-manifest-contract`: Persist and validate workload-specific identity without fabricating API, cloud, region, or infrastructure values for Power Apps projects.
- `liftoff-project-doctor`: Run Power Apps-specific project and runtime diagnostics from manifest context.
- `liftoff-project-update`: Re-render and reconcile Power Apps projects while refusing unsupported workload changes.
- `liftoff-infrastructure-governance`: Keep spec-driven governance common to all workloads while limiting Azure infrastructure requirements to workloads that select Azure infrastructure.

## Impact

The change affects CLI arguments and interactive prompting, catalog and plan types, configuration validation, template acquisition and rendering, framework orchestration, readiness probes, dependency installation, manifest compatibility, validation, doctor, update reconciliation, terminal tests, package contents, the root README, and new documentation pages. It adds an interactive prompt dependency and an immutable external-template source contract, while preserving existing GenAI and standard API commands, target safety, consent boundaries, framework ownership, JSON conventions, and cross-platform behavior.
