# Getting started

Liftoff is an interactive project initializer for governed GenAI applications
and standard APIs.

## 1. Install the CLI

Workstation readiness requires stable Node.js 24 LTS at 24.20.0 or newer within
that line, plus npm 12.x at 12.0.2 or newer when selected tools need it.
Python workloads use Python 3.14.x with frozen `uv` dependency locks.

The canonical release registry is `https://registry.npmjs.org`:

```bash
npm view @msn-control/liftoff@latest version --registry=https://registry.npmjs.org --@msn-control:registry=https://registry.npmjs.org
npm install -g @msn-control/liftoff@latest
liftoff --version
```

Versions before 0.3.0 are unsupported and must not be used for new projects.
If your organization requires a managed npm registry, query
`@msn-control/liftoff@latest` through that registry and compare the version with
canonical npm. Stop if the mirror is older or rejects the explicit current
version; ask the mirror owner to synchronize or approve the release. Liftoff
does not modify `.npmrc` or bypass registry policy.
The read-only canonical query isolates both default and scoped registry
overrides. Installation intentionally honors the configured
`@msn-control:registry` before the default registry; do not force a canonical
download around an organization's delivery policy.

Versions predating the self-upgrade command require that manual global install
once. After a capable version is installed globally with npm, use:

```bash
liftoff upgrade --check
liftoff upgrade
```

`upgrade` replaces only the supported global CLI installation. It does not read
or update a generated project. Inspect Liftoff-managed core maintenance
separately with `liftoff update --check`; production template modernization is
a reviewed project change.

See [prerequisites](prerequisites.md) for the complete plan-derived tool model.

## 2. Start the primary path

From the directory that should contain the project, run:

```text
liftoff init my-project
cd my-project
/liftoff-setup
```

The guided flow asks for:

1. Project identity and workload: GenAI or API.
2. Only the architecture choices applicable to that workload.
   For GenAI, **I'm not sure yet - Generic GenAI starter** is the safe default
   when no specialization has been selected.
3. Whether to generate the default single-maintainer GitFlow repository-
   governance handoff. Accepting it creates local files only.
4. OpenSpec or Spec Kit.
5. One or more coding agents. On a real TTY, Space toggles agents and Enter
   confirms the selection.
6. Whether to configure the default-off GitHub-hosted Copilot coding agent when
   OpenSpec and GitHub Copilot are selected.
7. A Spec Kit default agent when multiple agents are selected.
8. Plan confirmation, workstation readiness, and any separate install or
   overwrite permissions that are needed.

Liftoff renders into temporary staging, runs the official framework initializer
there, validates the complete result, and only then merges it into the target.
OpenSpec projects use all 12 OpenSpec 1.11 workflows as both skills and commands.
If the global OpenSpec profile differs, Liftoff displays the exact global change
and asks separately before staging.

When governance is enabled, `/liftoff-setup` is the next selected-agent action.
It has no model-selection requirement: safety comes from the Liftoff CLI phase
graph, local evidence, approval envelopes, and readback. OpenSpec setup completes,
syncs, and archives `bootstrap-<project>`; Spec Kit validates and finalizes
`specs/000-liftoff-bootstrap/` locally. Neither workflow invents completed product
work. Missing approval-persistence, credential-enrollment, and production phase
executors remain specific blockers. Commit and push are never implicit in
`liftoff init`, `--yes`, or read-only checks.

`/liftoff-setup` is a Copilot/Claude agent invocation, not a `liftoff setup`
shell command. Codex uses `$liftoff-setup` or selects the native skill.

For deterministic generic generation, use `--type genai --pattern generic`.

## 3. Understand the target

At the exact root of an existing Git worktree, `liftoff init` initializes that
root in place. A supplied project name changes project identity; it does not
create a child folder.

In a non-Git directory, or from a directory below but not equal to a Git root,
a project name creates a named child directory.

Read [existing repositories](existing-repositories.md) before initializing a
non-empty target.

## 4. Local baseline setup verifies

`/liftoff-setup` runs only local, project-applicable baseline checks before
archiving the OpenSpec seed or finalizing the Spec Kit bundle. Commands run in
their declared component directories, not all from an arbitrary working directory:

```bash
liftoff validate
# backend tests from the generated README when a backend exists
# frontend build from the generated README when a frontend exists
docker compose config -q
# From infrastructure/opentofu/azure/:
tofu fmt -check -recursive
# Within each selected environments/<environment>/ infrastructure root:
tofu init -backend=false
tofu validate
# OpenSpec only, from the project root (replace the generated change name):
openspec validate bootstrap-my-project --strict
```

Absent optional components are inapplicable: an API project without a frontend
skips frontend build evidence. The baseline does not run `tofu plan`, `tofu apply`,
start containers, deploy, mutate GitHub, or require cloud credentials. If a check
fails, the seed remains unfinished. After repair, explicit execution can retry
the local baseline; read-only `resume` does not run it. Current unchanged proof
can be reused, while changed inputs require new evidence.
Dependencies must already be usable, or separately installed with explicit
consent; passing a baseline does not prove that installation or consent happened.
Spec Kit's B001–B006 projection is finalized only after its checks pass.
Legacy/shared or unknown infrastructure layouts block baseline execution with a
migration-required result rather than omitting those checks.

You can run read-only maintenance at any time:

```bash
liftoff validate
liftoff doctor
liftoff governance status --json
liftoff governance plan --json
liftoff governance verify --json
```

`validate` checks durable generated artifacts and framework markers. `doctor`
adds read-only workstation, runtime, authentication, dependency,
workload-specific, and governance-state diagnostics.

After the local bootstrap handoff, normal development follows your selected
workflow. Repository publication and production activation remain separate:

- GenAI and API projects: copy `.env.example` to `.env`, install the generated
  stack dependencies, then use `liftoff dev` and `liftoff infra` to print local
  development and infrastructure commands. Native Go also copies
  `runtime.config.example.json` to `runtime.config.json`; see the
  [stack-specific configuration recipes](configuration-and-manifests.md#application-runtime-configuration).
- OpenSpec or Spec Kit changes drive normal feature work; release and hotfix
  flows follow the governed GitFlow plan after activation evidence is green.

See [workloads](workloads.md) for exact generated outputs and deferred actions.

## Maintain or repair an existing project

Start with `liftoff update --check`, then run `liftoff update` and approve the
matching plan. Check leaves project bytes unchanged and saves a disclosed
preview receipt outside the repository. Missing or stale previews block apply.
Automation uses `--approve-plan <fingerprint>`; `--json` only selects formatting.
Supported activation-v1/v2 migration preserves original in-project records and
creates a linked v3 activation. Failed revalidation remains blocked and resumable,
not reset to an older contract. Application source, dependencies, schemas,
containers, environments, documentation, and infrastructure remain project-owned,
including when `--force` is used.

For legacy OpenTofu layout blockers, `seed-verified` means **Local baseline
verification**, not an OpenSpec feature change. Start with:

```bash
liftoff repair "path/to/existing project" --check
```

Ordinary check makes no cloud calls. Bare interactive `liftoff repair` shows
the exact plan and asks Yes/No, default No. Eligibility for the local recipe
requires explicitly requested `--check --live --subscription <UUID>` discovery
with existing authentication, authoritatively absent resource groups, and no
local state/backend metadata. Missing state files alone do not establish safety.
Deployed, unknown, and unsupported cases remain plan-only, with source and state
untouched. Agent installation and the public stateful migration coordinator are
not implemented.

After an eligible, separately approved repair, run `liftoff update --check --project
"path/to/existing project"` and resume native setup. Interrupted repair writes
use `liftoff repair [project-path] --recover`, not update recovery. JSON/non-TTY
repair previews unless the exact automation flags authorize changes. The local
recipe preserves legacy flat-root semantics while creating a shared module and
independent environment roots. See [repair modes](cli-reference.md#repair-modes)
for flags and limits, and use native `/liftoff-repair` (Codex: `$liftoff-repair`)
for reviewed [application patches](application-repair.md).
Repair contract 1 is available in 0.12.3; inspect support with
`liftoff repair --capabilities --json`.

Older projects may show the retired `/liftoff-repository-governance` alias.
Review `liftoff update --check`; approved `liftoff update --force` removes only
exact recorded aliases. Do not reinitialize a project to resolve a blocker.
For read-only assessment of any Git repository, without initialization, use
`liftoff governance assess --json`. Missing proof is partial coverage, not success.

## Noninteractive automation

Use `liftoff plan` to resolve choices and preview requirements without writing
files or running installers:

```bash
liftoff plan --type standard --api node --spec openspec --agents copilot
```

Automation can pass the same options to `liftoff init`. Use `--yes` for project
defaults and confirmation only. It does not authorize file replacement,
machine-level tools, global OpenSpec profile changes, Copilot cloud opt-in, or
project dependency installation. Those permissions remain independent.

Use `--configure-openspec-profile` only after reviewing the machine-wide change.
Use `--copilot-cloud` to opt into the hosted agent or `--no-copilot-cloud` to
record the safe default explicitly.

See the [CLI reference](cli-reference.md) and
[safety and consent](safety-and-consent.md) before automating initialization.

## Existing application migration

`liftoff migrate <source>` scans a non-Liftoff application, creates a fresh
sibling scaffold, and stages a filtered source copy for guided migration. The
source remains byte-for-byte unchanged.

```bash
liftoff migrate ../legacy-app --region eastus --agents copilot,claude --yes
```

Power Apps support is retired, including existing-project maintenance. Retired
inputs are rejected without converting or deleting the original application.
