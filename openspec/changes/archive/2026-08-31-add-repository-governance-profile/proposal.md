## Why

Liftoff calls generated projects governed, but it currently creates only spec-workflow seed content and does not provide the GitFlow, repository ruleset, security pipeline, release evidence, deployment, monitoring, or runbook protocol needed to establish that governance. The attached single-maintainer standard also requires live repository discovery and an approval pause, which cannot safely occur during initialization because a new project may not yet have a GitHub remote.

## What Changes

- Add a selectable single-maintainer repository-governance profile to interactive and noninteractive planning, enabled by default but independently configurable.
- Generate a canonical, versioned, workload-aware governance policy plus machine-readable project context and thin launchers for every selected coding agent.
- Keep `liftoff init` and `liftoff update` deterministic and local: they write or reconcile governance handoff artifacts but never create branches, push commits, call GitHub APIs, install rulesets, or mutate deployment infrastructure.
- Direct the selected agent to run read-only Phase 0 only after the project has been committed and pushed, report gaps, and stop for explicit approval before creating an OpenSpec or Spec Kit governance change.
- Adapt the standard honestly by workload, omitting inapplicable container, DAST, OpenTofu, and deployment controls rather than generating checks that cannot pass.
- Grandfather an existing repository's current `main` tip as a recorded activation baseline and enforce release/tag invariants only for subsequent governed production changes.
- Add the durable governance handoff automatically to existing generated projects through normal `liftoff update` reconciliation without creating, restoring, or owning an active spec change.
- Record governance profile identity and policy version in desired state and the manifest while preserving the existing one-time seed and framework ownership boundaries.
- Document the post-push activation lifecycle, prerequisites, approval boundary, adoption behavior, and distinction between generated policy and live enforcement.

## Capabilities

### New Capabilities

- `liftoff-repository-governance-profile`: Defines profile selection, durable policy and context artifacts, agent handoff, workload adaptation, Phase 0 discovery, approval, activation baseline, and live-enforcement boundaries.

### Modified Capabilities

- `liftoff-cli-workflow`: Add governance profile selection and plan presentation without introducing remote side effects.
- `liftoff-project-scaffold`: Generate durable governance handoff artifacts and record their identity for every applicable workload.
- `liftoff-power-apps-code-apps`: Include the common governance profile while explicitly omitting API, container, OpenTofu, and custom deployment controls.
- `liftoff-infrastructure-governance`: Distinguish repository-governance policy from spec-framework seed governance and adapt controls to actual workload infrastructure.
- `liftoff-project-update`: Adopt and reconcile durable governance artifacts automatically while never recreating an active OpenSpec or Spec Kit change.
- `liftoff-manifest-contract`: Record governance profile and policy identity in a new compatible manifest schema without claiming live enforcement.
- `liftoff-user-documentation`: Explain governance selection, generated artifacts, deferred activation, approval, prerequisites, and existing-project adoption.

## Impact

This affects CLI options and prompts, configuration validation, project planning, templates, manifest readers and writers, reconciliation, contract snapshots, generated documentation, tests, and packaged assets. It does not make `gh`, a GitHub remote, GitHub Advanced Security, a self-hosted runner, Slack, or deployment credentials a prerequisite for `liftoff init`; those capabilities are discovered and handled by the post-push agent workflow.
