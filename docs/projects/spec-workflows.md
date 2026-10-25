# Specification workflows

`--workflow` decides how changes are specified before they are built:

| Workflow | What it sets up | Initializer |
| --- | --- | --- |
| `openspec` (default) | [OpenSpec](https://github.com/Fission-AI/OpenSpec): changes are proposed as specification deltas, built, then archived into the living specifications | OpenSpec 1.14.3, through `npx` |
| `spec-kit` | [Spec Kit](https://github.com/github/spec-kit): a constitution, then for each feature a specification, a plan, tasks and their implementation | Spec Kit 1.2.1, through `uvx` from the commit its tag points to |
| `manual` | Nothing: no framework files, markers or archive steps | none |

## How the framework is set up

Liftoff keeps no copy of either framework. It runs the framework's own
initializer at a pinned version, so the files are exactly what that version
writes:

- `liftoff plan` lists the `run-initializer` effect and the exact commands,
  with each selected coding agent passed to the framework.
- `liftoff init` runs them first, alone in an empty staging directory beside
  the target, then adds Liftoff's files and publishes everything with one
  rename. If anything fails, nothing is created.
- The initializer runs with telemetry off (`DO_NOT_TRACK=1`,
  `OPENSPEC_TELEMETRY=0`) and with a temporary home, configuration, data and
  Codex directory, so nothing on your machine outside the project changes:
  not your global configuration, and not other tools' files, such as Codex's
  global prompts that OpenSpec would otherwise clean up. It still reads your
  npm and Git settings, so private registries, proxies and credentials work,
  and uses your package caches. It downloads the framework the first time;
  nothing else is installed. All its steps together have ten minutes.
- Before publishing, Liftoff checks what the initializer wrote. It refuses a
  Git repository at any depth, anything other than regular files and
  directories, a file or directory where Liftoff writes one of its own, and
  any file containing a path from this machine, such as your home or
  temporary directory, since a project's files must work on any machine.

Running the OpenSpec initializer needs Node.js with npm. Running Spec Kit's
needs [uv](https://docs.astral.sh/uv/) and Git.

## Who owns the files

Every file the initializer writes is recorded in `.liftoff/manifest.json`
with the `framework` ownership. The framework owns those files: Liftoff never
changes them, and `liftoff validate` does not report your changes to them or
their removal. The framework's skills and commands sit beside Liftoff's
review skills in each coding agent's folder:

| Host | OpenSpec | Spec Kit |
| --- | --- | --- |
| Claude Code | `.claude/skills/openspec-*`, `.claude/commands/opsx/` | `.claude/skills/speckit-*` |
| Codex | `.agents/skills/openspec-*` | `.agents/skills/speckit-*` |
| GitHub Copilot | `.github/skills/openspec-*`, `.github/prompts/opsx-*` | `.github/skills/speckit-*` |

OpenSpec keeps its specifications in `openspec/`. Spec Kit keeps its
templates, scripts and the project's constitution in `.specify/`, and each
feature's documents in `specs/`.

## Working with it

The project's README and AGENTS.md say how to use the workflow.

- **OpenSpec:** propose a change with the `openspec-propose` skill
  (`/opsx:propose` in Claude Code), build it with `openspec-apply-change`, and
  archive it into the specifications with `openspec-archive-change` once it
  is merged. The skills run the `openspec` CLI, which `liftoff doctor` checks
  for: install it with `npm install --global @fission-ai/openspec@1.14.3`.
- **Spec Kit:** set the principles once with `speckit-constitution`, then for
  each feature run `speckit-specify`, `speckit-plan`, `speckit-tasks` and
  `speckit-implement`. Its scripts are Python, so they run the same on macOS
  and Windows; `liftoff doctor` checks for Python 3.11 or later.

Spec Kit needs at least one coding agent (`--agents`). Its first agent
becomes its default. Spec Kit only combines integrations it declares safe to
combine, and it does not declare Copilot's, so with Copilot and another agent
Liftoff passes `--force` to add them side by side in the new directory.

## Limits

- Liftoff sets the framework up once, at `init`. Upgrading it later is the
  framework's job: `openspec update`, or `specify integration upgrade`.
- Adding an agent to an existing project, and switching workflows, come with
  the existing-project commands in a later release.
- Liftoff's CI runs both initializers for real, with every coding agent, on
  macOS arm64, Windows x64 and Linux.
