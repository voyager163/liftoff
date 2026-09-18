# Liftoff

**Initialize governed GenAI applications and APIs from one interactive CLI.**
Liftoff combines reviewable starter projects with OpenSpec or Spec Kit and integrates
GitHub Copilot, Claude Code, and Codex in any selected combination.

[![CI](https://github.com/voyager163/liftoff/actions/workflows/ci.yml/badge.svg)](https://github.com/voyager163/liftoff/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/voyager163/liftoff)](LICENSE)

## Start here

Liftoff 0.13.0 is an unpublished native-only candidate targeting macOS (Homebrew cask),
Windows (WinGet portable), and Linux (direct archive). Qualified bundles will include a
private runtime and launcher, separate from project toolchains. Signed artifacts and verified
channels remain release blockers; see [native installation](docs/native-installation.md).
For explicit historical recovery of pre-native releases from canonical npm:

```bash
npm install -g @msn-control/liftoff@0.12.3
```

After independently verifying an executable with the required capabilities, the primary path is:

```text
liftoff init my-project
cd my-project
/liftoff-setup
```

`liftoff init` asks for workload, spec workflow, agents, readiness, and plan confirmation before
writing local files. Repository governance is enabled by default as a deterministic setup handoff.
For existing applications, do not reinitialize: use `liftoff assess` ([assessment](docs/assessment.md))
for read-only evaluation or `liftoff adopt` for reviewed in-place adoption in the 0.13.0 candidate. Canonical agent skills
(`/liftoff-setup`, `/liftoff-assess`, `/liftoff-adopt`, `/liftoff-update`, `/liftoff-repair`)
integrate Copilot, Claude, and Codex; see [agent skills](docs/skills.md). Codex invokes `$liftoff-setup`
or the native skill. These are agent invocations, not a `liftoff setup` shell command. `liftoff init` creates a scaffold;
do not reinitialize an existing Liftoff project to resolve a verification blocker.
For OpenSpec, `/liftoff-setup` completes, syncs, and archives the generated bootstrap seed.
Spec Kit finalizes its one-time bundle locally, without an OpenSpec archive or new Git branch.
No model selection is required for setup; the CLI phase graph, evidence, and approvals are authoritative.

Qualified native releases use `liftoff upgrade --check` then `liftoff upgrade`
through the proven installation owner; historical npm cannot discover native releases. This
replaces the CLI only; generated projects use `liftoff update` separately
for reviewed project maintenance. Run `liftoff update --check` first; automation approves with
`--approve-plan <fingerprint>`. Current candidate writers use manifest artifact version 8.
Application source, dependencies, schemas, containers, and infrastructure remain project-owned
outside template replacement, including `--force`.

For legacy OpenTofu layout blockers, `seed-verified` means **Local baseline
verification**, not an OpenSpec feature change. Start with:

```bash
liftoff repair "path/to/existing project" --check
```

Ordinary check makes no cloud calls. Bare interactive `liftoff repair` shows the
plan and asks Yes/No (default No). Supported local recipe preserves legacy flat roots
while creating independent environment roots. Eligibility requires bounded
`--check --live --subscription <UUID>` metadata discovery with existing authentication,
authoritatively absent resource groups in that subscription, and no local
state/backend metadata. Missing state files alone never establish safety.
Interrupted writes use `liftoff repair [project-path] --recover`.
Repair accepts neither `--force`, `--yes`, nor `--add-agents`.
Repair does not install agent hosts or provide the public stateful migration coordinator;
deployed, unknown, or unsupported cases remain plan-only. Use native `/liftoff-repair`
(Codex: `$liftoff-repair`) for reviewed [application patches](docs/application-repair.md); see [repair modes](docs/cli-reference.md#repair-modes).
Repair contract 1 is available in 0.12.3; negotiate capabilities directly with
`liftoff repair --capabilities --json`. Older projects review `liftoff update --check`;
`liftoff update --force` removes only exact recorded aliases.

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
Both workloads support **OpenSpec** or **Spec Kit** with **GitHub Copilot**,
**Claude Code**, **Codex**, or any combination.
Power Apps is retired. Existing Power Apps projects receive an unsupported-workload
error without changing files; `--force` does not provide a conversion path.

[Compare workload questions and outputs](docs/workloads.md) |
[Choose a spec workflow and agents](docs/spec-workflows-and-agents.md)

## Existing repository friendly

Run `liftoff init` at the exact current Git root to initialize that repository in
place; Liftoff does not create an unnecessary child folder. All output is rendered
and validated in temporary staging first. To assess any Git repository without
initializing it, run `liftoff governance assess --json`. The default is local-only and read-only.

[Initialize an existing repository](docs/existing-repositories.md) |
[Understand target and consent safety](docs/safety-and-consent.md)

## Documentation

| Guide | Use it to |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install safely and complete the first interactive project |
| [Native installation](docs/native-installation.md) | Review native distribution channels, handover, and candidate status |
| [Workloads](docs/workloads.md) | Compare GenAI/API choices and understand retired-workload handling |
| [Spec workflows and agents](docs/spec-workflows-and-agents.md) | Configure OpenSpec, Spec Kit, Copilot, Claude, and Codex |
| [Project assessment](docs/assessment.md) | Read-only whole-project standards assessment across supported profiles |
| [Agent skills](docs/skills.md) | Review canonical skills and Copilot/Claude/Codex projections |
| [Repository governance](docs/repository-governance.md) | Review `/liftoff-setup`, read-only assessment, authority gates, evidence, and compatibility |
| [Existing repositories](docs/existing-repositories.md) | Understand in-place, child-directory, and migration behavior |
| [Prerequisites](docs/prerequisites.md) | Review plan-derived runtimes, tools, authentication, and dependency setup |
| [Supported stack baseline](docs/supported-stack.md) | Review pinned runtimes, frameworks, dependency locks, and refresh policy |
| [Safety and consent](docs/safety-and-consent.md) | Review staging, overwrite, setup authority, and rollback guarantees |
| [Telemetry and privacy](docs/telemetry.md) | Review collected fields, opt-outs, Azure processing, and retention |
| [CLI reference](docs/cli-reference.md) | Find commands, flags, terminal modes, JSON, and exit-code contracts |
| [Generated project structure](docs/project-structure.md) | Locate workload-specific and conditional generated areas |
| [Configuration and manifests](docs/configuration-and-manifests.md) | Edit desired state, manifest v8, activation identity, and managed artifacts |
| [Application repair](docs/application-repair.md) | Review staged application-layout patch and repair modes |
| [Azure deployment](docs/azure-deployment.md) | Review generated Azure and OpenTofu contracts for API workloads |
| [Troubleshooting](docs/troubleshooting.md) | Recover from registry, readiness, validation, update, and retired-workload issues |
| [Developer guide](DEVELOPER.md) | Maintain version vectors, compatibility maps, release checks, and publishing |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [DEVELOPER.md](DEVELOPER.md) for build,
test, packaging, baseline-refresh, compatibility, and release procedures. Report
vulnerabilities through the private process in [SECURITY.md](SECURITY.md).

Liftoff is licensed under [GPL-3.0-only](LICENSE).
