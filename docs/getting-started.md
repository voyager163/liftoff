# Getting started

Liftoff is an interactive project initializer for governed GenAI applications,
standard APIs, and Power Apps code apps.

## 1. Install the CLI

Liftoff and generated Node.js workloads require Node.js 24.20 or newer.
Python workloads use Python 3.14 with frozen `uv` dependency locks.

The canonical release registry is `https://registry.npmjs.org`:

```bash
npm view @msn-control/liftoff@latest version --registry=https://registry.npmjs.org
npm install -g @msn-control/liftoff@latest --registry=https://registry.npmjs.org
liftoff --version
```

Versions before 0.3.0 are unsupported and must not be used for new projects.
If your organization requires a managed npm registry, query
`@msn-control/liftoff@latest` through that registry and compare the version with
canonical npm. Stop if the mirror is older or rejects the explicit current
version; ask the mirror owner to synchronize or approve the release. Liftoff
does not modify `.npmrc` or bypass registry policy.

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

## 2. Start interactive initialization

From the directory that should contain the project, run:

```bash
liftoff init
```

The guided flow asks for:

1. Project identity and workload: GenAI, API, or Power Apps code app.
2. Only the architecture choices applicable to that workload.
3. Whether to generate the default single-maintainer GitFlow repository-
   governance handoff. Accepting it creates local files only.
4. OpenSpec or Spec Kit.
5. One or both coding agents. On a real TTY, Space toggles agents and Enter
   confirms the selection.
6. Whether to configure the default-off GitHub-hosted Copilot coding agent when
   OpenSpec and GitHub Copilot are selected.
7. A Spec Kit default agent when both agents are selected.
8. The optional Preview Code Apps plugin preference for Power Apps projects.
9. Plan confirmation, workstation readiness, and any separate install or
   overwrite permissions that are needed.

Liftoff renders into temporary staging, runs the official framework initializer
there, validates the complete result, and only then merges it into the target.
OpenSpec projects use all 12 OpenSpec 1.11 workflows as both skills and commands.
If the global OpenSpec profile differs, Liftoff displays the exact global change
and asks separately before staging.
Governance activation is a later selected-agent action after commit and push;
see [repository governance](repository-governance.md).

## 3. Understand the target

At the exact root of an existing Git worktree, `liftoff init` initializes that
root in place. A supplied project name changes project identity; it does not
create a child folder.

In a non-Git directory, or from a directory below but not equal to a Git root,
a project name creates a named child directory.

Read [existing repositories](existing-repositories.md) before initializing a
non-empty target.

## 4. Validate the result

Run maintenance commands from the generated project root:

```bash
liftoff validate
liftoff doctor
```

`validate` checks durable generated artifacts and framework markers. `doctor`
adds read-only workstation, runtime, authentication, dependency, and
workload-specific diagnostics.

Next steps depend on the selected workload:

- GenAI and API projects: copy `.env.example` to `.env`, install the generated
  stack dependencies, then use `liftoff dev` and `liftoff infra` to print local
  development and infrastructure commands.
- Power Apps projects: run `npm ci`, then `npm run dev`. Environment binding,
  connector addition, and `power-apps push` are deliberately deferred.

See [workloads](workloads.md) for exact generated outputs and deferred actions.

## Noninteractive automation

Use `liftoff plan` to resolve choices and preview requirements without writing
files or running installers:

```bash
liftoff plan --type power-apps-code-app --spec openspec --agents copilot
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

Power Apps migration from an arbitrary existing application is not part of the
current workload contract.
