# Getting started

Liftoff is being rebuilt and has no release yet. Until the first release is
published through Homebrew and WinGet, run it from a clone of this
repository.

## Run Liftoff from source

You need Node.js 26 (see `.node-version`) on macOS (Apple Silicon) or
Windows (x64).

```bash
git clone https://github.com/voyager163/liftoff.git
cd liftoff
npm ci
npm run liftoff -- capabilities
```

`npm run liftoff -- <command>` runs the CLI from source.

## Create your first project

Preview the project first. This changes nothing:

```bash
npm run liftoff -- plan --name demo --workflow manual --agents claude
```

Then create it. Liftoff shows the plan again and asks before writing
anything; the default answer is no.

```bash
npm run liftoff -- init --name demo --workflow manual --agents claude --dir ../demo
```

To review a plan before creating it, or to create exactly the same project in
a script, save the plan and apply it:

```bash
npm run liftoff -- plan --name demo --workflow manual --agents claude --dir ../demo --out demo.plan.json
npm run liftoff -- init --plan demo.plan.json --yes
```

A plan is tied to the Liftoff version that made it and to every file it
lists. If either changes, `init` refuses the plan and asks you to make a new
one.

### Options

| Option | Default | Choices in this release |
| --- | --- | --- |
| `--workload` | `api` | `api` |
| `--stack` | `python-fastapi` | `python-fastapi` |
| `--workflow` | `openspec` | `manual` (OpenSpec and Spec Kit come later) |
| `--agents` | none | any of `copilot`, `codex`, `claude` |
| `--governance` | `single-maintainer-gitflow` | `single-maintainer-gitflow`, `none` |
| `--ai-review` | `auto` | `auto`, `on`, `off` |
| `--owners` | none | GitHub logins, for CODEOWNERS and the review policy |

Choosing something the product supports but this release cannot generate yet,
such as the OpenSpec workflow, stops with exit code 6 and says what to use
instead. See the [command reference](reference/cli.md) for every option.

## Check the project

```bash
cd ../demo
git init --initial-branch=develop
npm --prefix ../liftoff run liftoff -- doctor
npm --prefix ../liftoff run liftoff -- validate
cd backend
uv sync
uv run pytest
```

- `liftoff doctor` checks the tools the project needs (uv and Git; Docker is
  optional) and says how to install anything missing.
- `liftoff validate` checks the project's configuration and the files
  Liftoff manages, and reports anything changed by hand.

Both only read; neither installs nor changes anything.

## What you get

See [Python API projects](projects/python-fastapi.md) for the generated
layout, what each file is for and who owns it.
