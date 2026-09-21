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

Use the published npm release for normal use; `develop` is the integration
branch, not a release. [Release notes](https://github.com/voyager163/liftoff/releases)
and [security support](SECURITY.md#supported-versions) describe the supported scope.
Generated policy is a local handoff, not evidence of active repository protection.

Install with Node.js **24 LTS, 24.20.0 or newer within that line**.
Selected tools require npm **12.x, 12.0.2 or newer**; other prerequisites depend
on your [workload](docs/prerequisites.md). Canonical npm is the release authority;
[managed registries must expose the same version](docs/getting-started.md#1-install-the-cli).

**Telemetry is enabled by default for eligible commands**, disabled when `CI=true`.
Set `LIFTOFF_TELEMETRY=0` or `DO_NOT_TRACK=1` in your terminal environment before
first use to opt out. See [collected fields, exclusions, and retention](docs/telemetry.md).

**In your terminal**, install and start the interactive flow:

```bash
npm install -g @msn-control/liftoff@latest
liftoff --version
liftoff init my-project
cd my-project
```

`liftoff init` asks for workload, spec workflow, agents, readiness, and plan
confirmation before writing local files. Success produces a validated scaffold
and next steps, not a deployed application. Run `liftoff help` for syntax or
`liftoff plan` for a no-write preview.

**In your selected coding agent**, open the project and invoke `/liftoff-setup`
(Copilot/Claude), or `$liftoff-setup`/the native skill picker (Codex).
These are agent instructions, not terminal commands or a `liftoff setup` CLI.
Repository governance is enabled by default as a deterministic local handoff.
No model selection is required for setup; evidence and separate approvals govern
later publication, deployment, and activation. [Follow the setup steps](docs/getting-started.md#2-start-the-primary-path).

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
of the supported agents are accepted; runtime and framework pins remain enforced.

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

## Maintenance and repair

Use `liftoff upgrade --check` then `liftoff upgrade` for the global CLI only.
For an existing project, use `liftoff update --check`, then separately approve
`liftoff update`. Do not reinitialize to clear a blocker: project-owned source,
dependencies, containers, and infrastructure are not template-update targets.

[Update receipts, migration, repair eligibility, and recovery](docs/getting-started.md#maintain-or-repair-an-existing-project) |
[Repair modes](docs/cli-reference.md#repair-modes) |
[Reviewed application patches](docs/application-repair.md)

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
| [Contributor guide](CONTRIBUTING.md) | Make a first contribution or find maintainer/release procedures |

## Contributing and security

Use the [support and reporting map](CONTRIBUTING.md#support-and-reporting) for
help, bugs, and features through existing [Issues](https://github.com/voyager163/liftoff/issues).
Support is best effort from a single maintainer, without a response guarantee.
See [contributions](CONTRIBUTING.md), [maintainer guidance](DEVELOPER.md),
[private conduct reporting](CODE_OF_CONDUCT.md#report-a-conduct-concern), and
[security reporting](SECURITY.md#report-a-vulnerability); these are separate routes.

Liftoff is licensed under [GPL-3.0-only](LICENSE).
