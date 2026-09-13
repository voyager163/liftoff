# Liftoff

**Initialize governed GenAI applications and APIs from one
interactive CLI.** Liftoff combines reviewable starter projects with OpenSpec or
Spec Kit and integrates GitHub Copilot, Claude Code, and Codex in any selected
combination.

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
default as a deterministic setup handoff. For OpenSpec, `/liftoff-setup` completes,
syncs, and archives the generated bootstrap seed. Spec Kit finalizes its one-time
bootstrap bundle locally, without an OpenSpec archive or new Git branch.
No model selection is required for setup; the CLI phase graph, evidence, and
approvals are authoritative. Setup coordinates reviewed repairs and local readiness,
then separately approved publication, Azure activation, deployment, and governance.
Local-only use remains supported. Codex invokes `$liftoff-setup` or selects the native skill.

After global npm install, later releases use `liftoff upgrade --check` then `liftoff upgrade`.
This replaces the CLI only; generated projects use `liftoff update` separately
for reviewed project maintenance. Useful project-read-only checks:

```bash
liftoff validate
liftoff doctor
liftoff upgrade --check
liftoff update --check
```

Start with `liftoff update --check`, then run `liftoff update` and approve the
matching plan. Check leaves project bytes unchanged and discloses a preview
receipt saved outside the repository. Missing or stale previews block apply.
Automation uses `--approve-plan <fingerprint>`; `--json` only selects formatting.

Supported activation-v1/v2 migration preserves original records inside the project
and creates a linked v3 activation. Failed revalidation leaves v3 blocked and
resumable, not reset to an older contract. Application source, dependencies, schemas,
containers, environments, documentation, and infrastructure remain project-owned
and outside template replacement, including `--force`. Topology, additive agent repairs,
and stateful migration require their own exact preview, backups, and write authority.

Older projects may display the retired `/liftoff-repository-governance` alias.
Review `liftoff update --check`; `liftoff update --force` removes only exact recorded aliases.

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
**Claude Code**, **Codex**, or any combination. Official stable and preview releases
are accepted; runtime and framework pins remain enforced.

Power Apps is retired. Existing Power Apps projects receive an unsupported-workload
error without changing files; `--force` does not provide a conversion path.

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
