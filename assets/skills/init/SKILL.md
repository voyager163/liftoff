---
name: liftoff-init
description: "Scaffold a new Liftoff project with selected stack, pattern, cloud provider, and agent integrations."
---

# Liftoff Project Initialization Workflow

## Capability Negotiation

```bash
liftoff capabilities --json
```

Require `project-generation`, owned by Project Generation, under public envelope
schema 1. The `init` and `plan` commands produce HUMAN output; they have no
command-result JSON schema and accept no JSON flag. Do not parse human output as
a schema-1 receipt or invent a plan-only option on initialization.

## Plan a Real New Target

Collect the requested workload, stack, cloud/region, environments, frontend,
framework, selected agents and any existing configuration reference. Use actual
catalog identifiers, not guessed frameworks or a retired Power Apps workload.
Preserve literal arguments and the target/cwd binding. For example:

```bash
liftoff plan --project my-app --no-genai --api node-fastify --cloud azure --agents github-copilot
```

This separate command previews generated artifacts. It is not creation authority.
Use `--genai` only for a requested supported GenAI workload and its actual pattern.
Use the registered `openspec` or `spec-kit` framework identity; never install or
configure a framework implicitly because a skill describes it.

## Initialization Consent

```bash
liftoff init my-app --no-genai --api node-fastify --cloud azure --agents github-copilot
```

Read and explain the actual CLI plan, conflict inventory and prompts. `--yes`
confirms default choices and plan confirmation only. It does NOT authorize file
overwrites, tool installation, global OpenSpec profile changes or dependency
preparation. Those retain their separately documented `--force`,
`--install-tools`, `--configure-openspec-profile`, and `--install-dependencies`
authorizations and admission checks. Never add these flags automatically.

Autopilot, piped answers and model-generated consent are not user approval.
The initializer does not use the update/repair fingerprint mechanism. A generic
plan flag or an approval for another command cannot grant initialization rights.
No model client, model selection, hand-written scaffold, or fabricated manifest
may replace the deterministic generation engine.

## Verify Only the Actual Scope

After successful human-reported creation, independently inspect the new target:

```bash
liftoff validate --project ./my-app --json
liftoff assess --project ./my-app --json
```

Interpret each command's own contract. Generation provenance does not give
ordinary update authority over project-owned code. Tool installation, framework
initialization, local readiness, Git publication, governance and cloud deployment
are separate outcomes; do not claim them from file presence or a successful exit.
