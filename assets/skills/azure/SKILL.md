---
name: liftoff-azure
description: "Azure cloud resource activation, provider registration, remote state bootstrapping, and deployment readiness."
---

# Liftoff Azure Activation Workflow

## Capability Negotiation

```bash
liftoff capabilities --json
```

Require `azure-activation`, Azure Activation, public envelope schema 1 and the
governance command's actual schema-3 report. Missing executors, injected-only
providers, unavailable recovery, unsupported recipes and unqualified combinations
remain explicit blockers. No metadata Boolean, fixture, model assertion, or
successful subprocess qualifies a provider or native host.

## Bind Inputs Before Provider Effects

```bash
liftoff governance status --project ./my-app --scope activation --inputs ./activation-inputs.json --json
liftoff governance plan --project ./my-app --scope activation --inputs ./activation-inputs.json --json
```

Retain the exact canonical project, executable/args/cwd, selected scope, original
configuration path/digest and compatibility identity. Verify explicit non-placeholder
subscription, tenant, environment and region bindings through the CLI; ambient
account defaults or missing files are not proof of identity, absence or readiness.

State, backend metadata and credentials remain protected. Do not read state,
enroll credentials, install tools, register providers, create resources or run
raw cloud/OpenTofu scripts because planning identified a gap. Existing auth,
least-privilege actor permissions and supported private execution/state routes
must be established by their registered operations.

## Command-Specific Approval and Actual Readback

Use actual returned governance `approve`/`apply-next` actions, their complete
`--plan` binding and execution permission. Do not invent an Azure command or
borrow an update/repair approval flag. Autopilot, generic Yes, piped input and
model-generated text grant no cloud, state, dependency, script or file authority.
Default-No action-specific consent and independent host tool permissions remain
necessary. Private staging is not an OS/network sandbox.

```bash
liftoff governance verify --project ./my-app --scope activation --inputs ./activation-inputs.json --json
liftoff governance resume --project ./my-app --scope activation --inputs ./activation-inputs.json --json
```

Report actual dispatched operations, checkpoints, independently observed resource
identities, private-backend/import proof, application artifact/health evidence,
environment qualification and live enforcement separately. Missing production
or spending/target authorization cannot be replaced by synthetic proof or a
narrower repository result. Preserve retention/disposal obligations and original
history. Recovery handles only the exact recorded effects; never promise
cross-provider atomic rollback or cleanup of an unsettled process/workspace.
