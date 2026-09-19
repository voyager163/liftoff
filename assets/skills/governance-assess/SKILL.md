---
name: liftoff-governance-assess
description: "Read-only assessment of Git repository configuration against single-maintainer-gitflow controls."
---

# Liftoff Governance Assessment Workflow

## Capability Negotiation

Before repository/project access: `liftoff capabilities --json`.
Require public schema 1, Repository Governance's `governance-assessment`, result
schema 1 and read-only authorization. Missing implementation, unsupported
contracts, prerequisites and unqualified execution remain distinct.
Not whole-project `assess`, setup, upgrade or host/provider qualification.

## Read-Only Scope

Select the real directory; `./my-app` is only an example.

`liftoff governance assess --project ./my-app --json`

The CLI resolves Git/Liftoff boundaries, even before the first commit. No init,
activation or enrollment is required. Invalid/retired inner manifests block
outer fallback; never install wrappers here. Local mode makes no network requests
or mutations. Packaged policy/identity/graph/controls are the target, never latest.
`.liftoff/governance/` policy/context/README files are recorded context;
missing context is unknown, not alignment.

Only after explicit consent for bounded live reads:

`liftoff governance assess --project ./my-app --live --json`

Existing permissions and exact bindings only: no login/enrollment, permission
expansion, provider registration, sensitive state, scripts or resource mutations.
No credentials in chat, argv or reports.

## Evidence and Exit Meaning

Preserve target/identity/policy, expected/observed facts, provenance,
applicability, coverage, findings, impact and recommendations.
Keep `aligned`, `outdated`, `missing`, `conflicting`, `approved-exception`,
`inapplicable`, and `not-observed` distinct. Partial/denied/unsupported
observations cannot prove absence or enforcement.

Exits: 0 aligned or explicitly disabled/not-applicable (not activation);
2 partial/differences including approved exceptions; 1 error.
No governance phase is completed.

Stop after explaining it: no follow-up execution, project/state/evidence writes
or patch staging. Retain `executable`, `args`, `cwd`, project, scope, configuration
binding and required authority in advisory actions; they are not permission.
Explain separate `/liftoff-repair` or `$liftoff-repair` for layout concerns,
never invoke it. `/liftoff-setup` or `$liftoff-setup` is separate post-init work.
