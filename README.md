# Liftoff

**Initialize governed GenAI applications and APIs from one
interactive CLI.** Liftoff combines reviewable starter projects with OpenSpec or
Spec Kit and integrates GitHub Copilot, Claude Code, or both from the first commit.

[![npm version](https://img.shields.io/npm/v/%40msn-control%2Fliftoff?logo=npm)](https://www.npmjs.com/package/@msn-control/liftoff)
[![CI](https://github.com/voyager163/liftoff/actions/workflows/ci.yml/badge.svg)](https://github.com/voyager163/liftoff/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/voyager163/liftoff)](LICENSE)
[![Node.js](https://img.shields.io/node/v/%40msn-control%2Fliftoff)](package.json)

## Start here

Install the published CLI from canonical npm:

```bash
npm install -g @msn-control/liftoff@latest
```

Primary path:

```text
liftoff init my-project
cd my-project
/liftoff-setup
```

`liftoff init` asks for workload, spec workflow, agents, readiness, and plan
confirmation before writing local files. Repository governance is enabled by
default as a local deterministic handoff. For OpenSpec, `/liftoff-setup` completes,
syncs, and archives the generated bootstrap seed. Spec Kit finalizes its one-time
bootstrap bundle locally, without an OpenSpec archive or new Git branch.
No model selection is required for setup; the CLI phase graph, evidence, and
approvals are authoritative. Missing production executors, credential enrollment,
and approval-persistence capabilities remain explicit blockers, not completed
automation.

After the first self-upgrade-capable release is installed globally through npm,
later CLI releases use `liftoff upgrade --check` followed by `liftoff upgrade`.
This replaces the CLI only; generated projects use `liftoff update` separately
for Liftoff-managed core files. Useful read-only checks:

```bash
liftoff validate
liftoff doctor
liftoff upgrade --check
liftoff update --check
```

Plain `liftoff update` applies safe managed-core changes immediately and skips
core conflicts. Application source, dependencies, schemas, containers,
environments, documentation, and infrastructure are project-owned after
generation and remain outside every update mode, including `--force`. Use
`liftoff update --check --json` for a read-only core-maintenance gate.

Older projects may display the retired `/liftoff-repository-governance` alias.
After upgrading the CLI, review `liftoff update --check`; `liftoff update --force`
can remove only its exact recorded aliases. Reload the coding-agent session.

![Liftoff terminal showing interactive workload, workflow, multi-agent, readiness, and safe completion steps](docs/assets/liftoff-terminal.svg)

## One flow, two workloads

| Workload | Generated foundation | Deferred until you choose |
| --- | --- | --- |
| **GenAI application** | Python, FastAPI, PydanticAI, data and messaging boundaries, optional frontend, Docker, and Azure OpenTofu | Model credentials, specialized behavior, cloud sign-in, deployment |
| **API application** | Python/FastAPI, Node.js/Fastify, or Go/Huma API, database assets, optional frontend, Docker, and Azure OpenTofu | Service configuration, cloud sign-in, deployment |

If the GenAI specialization is not yet known, choose **I'm not sure yet -
Generic GenAI starter** or use `--pattern generic`. It creates a neutral
PydanticAI invocation foundation without assuming RAG, chat, agents, streaming,
fine-tuning, or workflows.

Both workloads can use **OpenSpec** or **Spec Kit** with **GitHub Copilot**,
**Claude Code**, or both.

Power Apps and its Code Apps plugin integration are retired. Existing Power Apps
projects receive an unsupported-workload error without changing their files;
`--force` does not provide a compatibility or conversion path.

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

To assess any Git repository without initializing it, run
`liftoff governance assess --json`. The default is local-only and read-only.
Missing or unsupported proof is reported as partial coverage, not success.

[Initialize an existing repository](docs/existing-repositories.md) |
[Understand target and consent safety](docs/safety-and-consent.md)

## Documentation

| Guide | Use it to |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install safely and complete the first interactive project |
| [Workloads](docs/workloads.md) | Compare GenAI/API choices and understand retired-workload handling |
| [Spec workflows and agents](docs/spec-workflows-and-agents.md) | Configure OpenSpec, Spec Kit, Copilot, and Claude |
| [Repository governance](docs/repository-governance.md) | Review `/liftoff-setup`, read-only `/liftoff-governance-assess`, authority gates, evidence, and compatibility |
| [Existing repositories](docs/existing-repositories.md) | Understand in-place, child-directory, and migration behavior |
| [Prerequisites](docs/prerequisites.md) | Review plan-derived runtimes, tools, authentication, and dependency setup |
| [Supported stack baseline](docs/supported-stack.md) | Review pinned runtimes, frameworks, dependency locks, images, and refresh policy |
| [Safety and consent](docs/safety-and-consent.md) | Review staging, overwrite, setup authority, credential, rollback, and ownership guarantees |
| [Telemetry and privacy](docs/telemetry.md) | Review collected fields, opt-outs, Azure processing, and retention |
| [CLI reference](docs/cli-reference.md) | Find commands, flags, terminal modes, JSON, and exit-code contracts |
| [Generated project structure](docs/project-structure.md) | Locate workload-specific and conditional generated areas |
| [Configuration and manifests](docs/configuration-and-manifests.md) | Edit desired state, manifest v7, activation identity, and managed artifacts |
| [Azure deployment](docs/azure-deployment.md) | Review generated Azure and OpenTofu contracts for API workloads |
| [Troubleshooting](docs/troubleshooting.md) | Recover from registry, readiness, validation, update, and retired-workload issues |
| [Developer guide](DEVELOPER.md) | Maintain version vectors, compatibility maps, release checks, and publishing |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [DEVELOPER.md](DEVELOPER.md) for build,
test, packaging, baseline-refresh, compatibility, and release procedures. Report
vulnerabilities through the private process in [SECURITY.md](SECURITY.md).

Liftoff is licensed under [GPL-3.0-only](LICENSE).
