---
name: liftoff-governance
description: "Repository governance activation, GitHub controls application, rulesets, and phase transitions under schema 3."
---

# Liftoff Governance Workflow

## Capability Negotiation

```bash
liftoff capabilities --json
```

Require `repository-governance`, Repository Governance, public envelope schema 1
and governance command result schema 3. Inspect the actual planner, executor,
verifier, recovery and qualification state. Missing production implementation or
unqualified execution remains blocked; instructions or fixture success are not
implementation, host qualification, permissions, or provider evidence.

## Select the Real Scope and Inputs

An unscoped governance execution call defaults to **activation**. Never silently
substitute repository scope for an activation request. Actual scope values are
`local`, `repository`, `activation`, and `lifecycle`; repository completion is not
Azure, production or full-activation completion.

```bash
liftoff governance status --project ./my-app --json
liftoff governance plan --project ./my-app --scope repository --inputs ./activation-inputs.json --json
liftoff governance apply-next --project ./my-app --scope repository --inputs ./activation-inputs.json --json
```

Preserve exact executable, argument array, cwd, project, selected scope, public
configuration path/digest, compatibility identity and required authority. A change
of cwd cannot drop or substitute the original inputs. Credentials are protected
references, never values in chat, arguments, project files or reports.

## Separate Approval from Execution

Governance uses the returned `approve` action and its exact `--plan` binding,
followed by an independently requested executable action with the registered
execution permission. Approval does not itself execute. Without execution
permission, `apply-next` is read-only. Do not substitute another command's
approval mechanism, invent a generic check option, or call raw GitHub/cloud tools.

Autopilot, generic Yes, piped input, model-written approval, or an unrelated
request authorize no files, scripts, Git publication, repository controls, cloud
resources or state operations. Each permission stays separate. No branch bypass,
force push, synthetic check status or fabricated provider receipt is permitted.

## Independent Verification and Recovery

```bash
liftoff governance verify --project ./my-app --scope repository --inputs ./activation-inputs.json --json
liftoff governance resume --project ./my-app --scope repository --inputs ./activation-inputs.json --json
```

Exit 0 is consistent and complete for the selected scope; exit 2 is consistent but
incomplete; exit 1 is inconsistency. Preserve `selectedPhase`, `executedPhase`,
remaining blockers, actual readback and uncertain effects. A process exit or
generated workflow alone is not enforcement proof.

Repository scope cannot authorize Azure, remove a main-update hold, or produce
production proof. Hold replacement needs its own real qualification and separate
approval. Recover only the original returned scope and operation identity; do not
repeat completed publication, discard history, blindly roll back provider
changes, or retag stale evidence to obtain a green result.
