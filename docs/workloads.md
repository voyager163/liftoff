# Workloads

Liftoff asks for one workload first, then routes only the questions,
prerequisites, generated artifacts, and maintenance checks that apply to it.

## At a glance

| Workload | Primary choices | Required runtime | Liftoff-generated platform areas |
| --- | --- | --- | --- |
| GenAI application | Pattern, Azure region, environments, optional frontend | Python 3.14, `uv` 0.12.7+, and Node.js 24.20+ | API, orchestration, data, messaging, Docker, Azure OpenTofu |
| API application | Python 3.14, Node.js 24, or Go 1.27 API stack; Azure region; environments; optional frontend | Selected API runtime and Node.js 24.20+ | API, data, Docker, Azure OpenTofu |
| Power Apps code app | Spec workflow, agents, optional Code Apps plugin | Node.js 24.20+ | Official React/Vite starter and project-local Power Apps tooling |

All three workloads continue into the common OpenSpec or Spec Kit and coding
agent flow and the default local repository-governance handoff.

## GenAI application

### Questions

- Project name.
- GenAI pattern. **I'm not sure yet - Generic GenAI starter** is the default;
  specialized choices include prompt, chatbot, RAG, agent, multi-agent,
  fine-tuned, streaming, and workflow.
- Azure region and generated environments.
- Whether to generate a frontend.
- Spec workflow and coding agents.

The selected pattern fixes the API stack to Python, FastAPI, and PydanticAI.
Automation can select the neutral starting point explicitly with
`--type genai --pattern generic`.

### Generated output

- FastAPI backend and Scalar/OpenAPI integration.
- A committed `uv.lock` consumed through `uv sync --frozen`.
- PydanticAI orchestration, prompts, and model configuration boundaries.
- PostgreSQL and pattern-specific Redis or Azure Service Bus boundaries.
- Offline-testable tracing and integration adapters.
- Docker Compose and Azure OpenTofu.
- Optional Vue frontend and pattern-specific Azure Functions workers.
- Versioned repository-governance policy, workload context, guide, and
  selected-agent launcher unless `none` is selected.

### Deferred actions

Liftoff does not insert model credentials, sign in to cloud services, or deploy
resources. Configure `.env`, authenticate separately, and review generated
infrastructure before applying it.

The generic pattern provides a neutral `/api/ai/run` boundary, PydanticAI
runner, prompt, tracing, offline test, and optional prompt playground. It does
not generate retrieval or pgvector, workers, chat persistence, specialized
tools, streaming adapters, fine-tuning datasets, or workflow structures.
Specializing it later is reviewed project migration work; `liftoff update` and
`--force` cannot convert project-owned application files.

## API application

### Questions

- Project name.
- API stack: Python/FastAPI, Node.js/Fastify with TypeScript, or Go/Huma v2
  with Chi.
- Azure region and generated environments.
- Whether to generate a frontend.
- Spec workflow and coding agents.

### Generated output

- Stack-native API, OpenAPI, tests, and database migrations.
- Ecosystem-native locked metadata: `uv.lock`, `package-lock.json`, or
  `go.mod` plus `go.sum`.
- PostgreSQL, Redis, Azurite, and Mailpit local services where applicable.
- Docker Compose and Azure OpenTofu.
- Optional Vue frontend.
- Versioned local repository-governance handoff unless explicitly disabled.

### Deferred actions

Service secrets, cloud authentication, external integrations, and deployment
remain explicit developer or delivery-pipeline actions.

## Power Apps code app

Power Apps uses an immutable, packaged snapshot of Microsoft's official
[`PowerAppsCodeApps/templates/starter`](https://github.com/microsoft/PowerAppsCodeApps/tree/main/templates/starter).
Initialization and update do not fetch the mutable upstream branch.

### Questions

- Project name.
- OpenSpec or Spec Kit.
- GitHub Copilot, Claude Code, or both.
- Spec Kit default agent when both are selected.
- Whether to request the optional Microsoft Code Apps agent plugin
  (Preview).

Power Apps does not ask for an API stack, GenAI pattern, cloud, region, API
environment, API frontend, Docker, or OpenTofu selection.

### Generated output

- React, Vite, TypeScript, Tailwind, and the Power Apps SDK and Vite plugin.
- Locked root `package.json` and `package-lock.json`.
- Project-local `power-apps` CLI supplied by the generated dependency graph.
- `liftoff.config.json`, manifest-v7 `liftoff.manifest.json`, starter provenance,
  and third-party attribution.
- Official OpenSpec or Spec Kit output and every selected agent marker.
- The common local governance policy and selected-agent launcher, with backend,
  container, OpenTofu, custom deployment, and API DAST controls marked
  inapplicable.

Liftoff does not create an API backend, `docker-compose.yml`,
`infrastructure/`, API environments, or an environment-bound
`power.config.json` for this workload.

### Deferred actions

After initialization:

```bash
npm ci
npm run dev
npx --no-install power-apps --version
```

Environment binding, connector creation, authentication, and deployment remain
outside initialization. Follow Microsoft's current Code Apps documentation
before running `power-apps init` or `power-apps push`.

If the optional Code Apps plugin was requested, install only the targeted
plugin from an agent session:

```text
/plugin marketplace add microsoft/power-platform-skills
/plugin install code-apps-preview@power-platform-skills
```

Do not run `/create-code-app` inside the generated project; Liftoff already
created the application.

## Change workload later

`liftoff update` maintains explicit Liftoff core files and can provision a
previously absent frontend or environment once after a corresponding desired
state edit. It does not convert workloads, change API stacks or GenAI patterns,
transition a Power Apps starter, or modernize production project templates.

Plain update applies safe core changes immediately. Use `liftoff update
--check` for read-only inspection. `--force` applies only to listed
managed-core conflicts; project-owned source, dependencies, schemas,
containers, environments, documentation, and infrastructure remain untouched.
