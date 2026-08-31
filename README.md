# Liftoff

**Initialize governed GenAI applications, APIs, and Power Apps code apps from one
interactive CLI.** Liftoff combines production-oriented scaffolds with OpenSpec or
Spec Kit and integrates GitHub Copilot, Claude Code, or both from the first commit.

[![npm version](https://img.shields.io/npm/v/%40msn-control%2Fliftoff?logo=npm)](https://www.npmjs.com/package/@msn-control/liftoff)
[![CI](https://github.com/voyager163/liftoff/actions/workflows/ci.yml/badge.svg)](https://github.com/voyager163/liftoff/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/voyager163/liftoff)](LICENSE)
[![Node.js](https://img.shields.io/node/v/%40msn-control%2Fliftoff)](package.json)

## Start here

Install the published CLI from canonical npm, then launch the guided experience:

```bash
npm install -g @msn-control/liftoff@latest --registry=https://registry.npmjs.org
liftoff init
```

After the first self-upgrade-capable release is installed globally through npm,
later CLI releases use `liftoff upgrade --check` followed by `liftoff upgrade`.
This replaces the CLI only; generated projects still use `liftoff update`.

Liftoff asks you to choose a workload and spec workflow, select one or more coding
agents with Space, review workstation readiness, and confirm the project plan before
it writes. Repository governance is enabled by default as a local handoff; live
activation remains deferred until commit, push, read-only Phase 0, and explicit
plan approval. After initialization:

```bash
liftoff validate
liftoff doctor
liftoff upgrade --check
liftoff update --check
```

Plain `liftoff update` applies safe managed changes immediately and skips
conflicts. Use `liftoff update --check --json` for a read-only CI drift gate,
and review every reported path before choosing `liftoff update --force`.

![Liftoff terminal showing interactive workload, workflow, multi-agent, readiness, and safe completion steps](docs/assets/liftoff-terminal.svg)

## One flow, three workloads

| Workload | Generated foundation | Deferred until you choose |
| --- | --- | --- |
| **GenAI application** | Python, FastAPI, PydanticAI, data and messaging boundaries, optional frontend, Docker, and Azure OpenTofu | Model credentials, cloud sign-in, deployment |
| **API application** | Python/FastAPI, Node.js/Fastify, or Go/Huma API, database assets, optional frontend, Docker, and Azure OpenTofu | Service configuration, cloud sign-in, deployment |
| **Power Apps code app** | Microsoft's pinned React, Vite, TypeScript, Power Apps SDK starter and project-local CLI | Environment binding, connectors, `power-apps push` |

Every workload can use **OpenSpec** or **Spec Kit** with **GitHub Copilot**,
**Claude Code**, or both. The optional Microsoft Code Apps agent plugin remains an
explicit, Preview-only choice.

[Compare workload questions and outputs](docs/workloads.md) |
[Choose a spec workflow and agents](docs/spec-workflows-and-agents.md)

## Existing repository friendly

Run `liftoff init` at the exact current Git root to initialize that repository in
place; Liftoff does not create an unnecessary child folder. In other locations, a
project name creates a named child directory.

All output is rendered and validated in temporary staging first. Liftoff discloses
regular-file replacements, asks before overwrite, rejects structural and symlink
conflicts, keeps tool/dependency permissions independent, and rolls back handled
write failures.

[Initialize an existing repository](docs/existing-repositories.md) |
[Understand target and consent safety](docs/safety-and-consent.md)

## Documentation

| Guide | Use it to |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install safely and complete the first interactive project |
| [Workloads](docs/workloads.md) | Compare GenAI, API, and Power Apps choices and outputs |
| [Spec workflows and agents](docs/spec-workflows-and-agents.md) | Configure OpenSpec, Spec Kit, Copilot, Claude, and the optional Code Apps plugin |
| [Repository governance](docs/repository-governance.md) | Review the default local policy handoff, Phase 0, approval, activation, and existing-project adoption |
| [Existing repositories](docs/existing-repositories.md) | Understand in-place, child-directory, and migration behavior |
| [Prerequisites](docs/prerequisites.md) | Review plan-derived runtimes, tools, authentication, and dependency setup |
| [Supported stack baseline](docs/supported-stack.md) | Review pinned runtimes, frameworks, dependency locks, images, and refresh policy |
| [Safety and consent](docs/safety-and-consent.md) | Review staging, overwrite, install, rollback, and ownership guarantees |
| [Telemetry and privacy](docs/telemetry.md) | Review collected fields, opt-outs, Azure processing, and retention |
| [CLI reference](docs/cli-reference.md) | Find commands, flags, terminal modes, JSON, and exit-code contracts |
| [Generated project structure](docs/project-structure.md) | Locate workload-specific and conditional generated areas |
| [Configuration and manifests](docs/configuration-and-manifests.md) | Edit desired state and understand manifest schema v4 |
| [Azure deployment](docs/azure-deployment.md) | Review generated Azure and OpenTofu contracts for API workloads |
| [Troubleshooting](docs/troubleshooting.md) | Recover from registry, readiness, validation, update, and plugin issues |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for build, test, packaging, starter-refresh,
and release procedures. Report vulnerabilities through the private process in
[SECURITY.md](SECURITY.md).

Liftoff is licensed under [GPL-3.0-only](LICENSE).
