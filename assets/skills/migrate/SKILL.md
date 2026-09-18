---
name: liftoff-migrate
description: "Create a fresh migration scaffold from supported source facts while preserving the source; semantic application conversion remains separate."
---

# Liftoff Fresh-Target Migration Workflow

## Capability Negotiation

```bash
liftoff capabilities --json
```

Require `project-migration`, owned by Project Evolution, under public envelope
schema 1. The fresh-target `migrate` command is HUMAN-output only: no JSON report
schema, JSON flag, plan-only flag, or exact-plan approval flag is available.
Do not invent source/target options: the source is positional and the requested
new target name uses the existing project option.

## Source Preservation and Supported Scope

This is fresh-target generation from supported source facts, not in-place
adoption, installation-owner migration, skill transport migration, or semantic
application conversion. Source files, configuration, history, dependencies and
state remain untouched. A newer scaffold does not port business behavior.

```bash
liftoff assess --project ./legacy-project --json
```

Explain unsupported or unknown source facts honestly. Retired Power Apps and
unsupported stack conversion remain blocked/assessment-only, not fallbacks to
a different workload. Infrastructure/state migration requires its own registered
recipe and authority; do not move state or delete historical infrastructure.

## Human Review and Fresh Target

The separate human `plan` command can preview chosen target templates, not source
conversion or transfer of business logic:

```bash
liftoff plan --project migrated-app --no-genai --api node-fastify --cloud azure --agents github-copilot
liftoff migrate ./legacy-project --project migrated-app --api node-fastify --cloud azure --agents github-copilot
```

Preserve the exact source, target, cwd and configuration reference. The target
must be fresh/empty under the migration guard; force never overrides this
boundary. The existing initializer-style `--yes` confirms choices/plan only,
not source changes, overwrites, tools, global configuration or dependencies.
Independent installation/preparation consents remain independent. Autopilot,
piped answers, generic approval and model-written consent grant no authority.

## Post-Migration Evidence

```bash
liftoff validate --project ./migrated-app --json
liftoff assess --project ./migrated-app --json
```

Report that a scaffold was created only when the CLI actually did so. Verify
source preservation and target facts independently. Business behavior, data
transfer, semantic conversion, publication and cloud readiness are not implied.
Offer only separately reviewed supported adoption/repair/application work;
never silently copy customized code over the new target or claim conversion.
