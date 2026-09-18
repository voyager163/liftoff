---
name: liftoff-setup
description: "Guide capability-negotiated project readiness and post-init governance; workstation preparation remains a separate scope."
---

# Liftoff Setup Workflow

## Capability Negotiation

Before project access: `liftoff capabilities --json`. Require public schema 1,
Repository Governance's `repository-governance`, output 3, profile/platform,
planner/executor/verifier/recovery support. Unavailable/unqualified execution
blocks; supported read-only inspection only. Never emulate the Liftoff governance
engine, fabricate proof or retag history.

Personal delivery selects no project. Workstation-only: `liftoff doctor --json`
and its own report. Project setup stays post-init. Init, tool and dependency
consents are separate.

## Context

Select real project/cwd, not example `./my-app`; read its
`.liftoff/governance/README.md`, `policy.md`, `context.json`.

`liftoff governance status --project ./my-app --scope local --json`

Use returned `nextActions.continuation`: `executable`, `args`, `cwd`, `project`,
`scope`, `configPath`, `configDigest`, `compatibilityIdentity`, `requiredAuthority`.
Resolve `--inputs` before cwd changes; changed bytes need fresh review.
`nextReadyPhase`: post-operation readiness; `selectedPhase`: attempt;
`executedPhase`: successful execution.

## Continue

Local baseline verification is not an OpenSpec feature change. Preview:
`liftoff repair ./my-app --check --json`. Ordinary check makes no cloud calls.
Live absence needs exact `--subscription` and `--live` consent, not file inference.
`liftoff repair ./my-app`: exact immutable plan, then Yes/No, default No; no hash copying.
Decline/Ctrl-C/EOF blocks writes; report prior verification effects.
JSON/nonTTY bare previews only. Checks, preparation, network, files and update
have independent consent. `liftoff repair ./my-app --recover` handles only
recorded interruption, never arbitrary cleanup.

Preview `liftoff update --project ./my-app --check --json`, then
`liftoff governance plan --project ./my-app --scope local --json`.
Plan saves a disclosed external preview, not approval. Apply-next without
`--execute` is read-only. Even approval-free local actions need exact execution
consent. Never automatically approve a plan: use returned
`approve`/`--plan`, then separately authorized `apply-next`.
Autopilot, generic Yes and piped input grant no consent.

## Completion

Honor local-only requests and declined authority. Unscoped means activation;
repository success cannot replace it. Retain inputs for activation/lifecycle.
Enrollment: private operator channel or explicit `--protected-stdin`, never
secrets in chat/argv/reports. `verify`: 0 consistent-complete, 2 consistent-incomplete,
1 inconsistent. Full activation needs real deployment/live readback; retention is
lifecycle work. Unavailable producers stay plan-only. Stop unchanged failures;
recover only original plans and authority.
