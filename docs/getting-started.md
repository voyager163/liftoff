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
| `--stack` | `python-fastapi` | `python-fastapi`, `node-fastify`, `go-huma` |
| `--workflow` | `openspec` | `manual` (OpenSpec and Spec Kit come later) |
| `--agents` | none | any of `copilot`, `codex`, `claude` |
| `--governance` | `single-maintainer-gitflow` | `single-maintainer-gitflow`, `team-gitflow`, `risk-tiered-gitflow`, `none` |
| `--ai-review` | `auto` | `auto`, `on`, `off` |
| `--owners` | none | GitHub logins, for CODEOWNERS and the review policy |

Choosing something the product supports but this release cannot generate yet,
such as the OpenSpec workflow, stops with exit code 6 and says what to use
instead. See the [command reference](reference/cli.md) for every option.

### Governance profiles

The profile decides how many people must approve a change before it merges,
by the risk tier the review policy gives it:

| Profile | Low | Medium | High | Use it when |
| --- | --- | --- | --- | --- |
| `single-maintainer-gitflow` | 0 | 0 | 0 | one person maintains the project; the tier sets how deep the automated review goes |
| `team-gitflow` | 1 | 1 | 2 | every change needs someone other than its author |
| `risk-tiered-gitflow` | 0 | 1 | 2 | low-risk changes may merge without an approval |
| `none` | 0 | 0 | 0 | you want no governance files at all |

With `team-gitflow` and `risk-tiered-gitflow`, an approval counts only when
it comes from someone with write access who is not the author, on the pull
request's current head commit; bots never count. `--owners` makes GitHub
request those people as reviewers. With `team-gitflow`, at least two owners
also make a code owner's approval required (with one, nobody could approve
that owner's own changes). With `risk-tiered-gitflow`, low-risk changes need
no approval, so the branch rules never require a code owner's; any
collaborator with write access can give the approvals a change needs.

The branch rules enforce only each profile's minimum natively: one approval
for `team-gitflow`, none for `risk-tiered-gitflow`. The higher counts by tier
come from the `review-policy` check, a commit status that anyone with write
access could also publish from a workflow of their own, so they stop mistakes
rather than a collaborator set on getting around them. GOVERNANCE.md in the
project says how to enforce a higher count natively.

These two profiles are generated and tested, but their approval rules have
not yet been observed on GitHub with a real second reviewer, so they are not
yet qualified.

## Check the project

```bash
cd ../demo
git init --initial-branch=develop
node ../liftoff/src/cli/main.ts doctor
node ../liftoff/src/cli/main.ts validate
cd backend
uv sync
uv run pytest
```

`doctor` and `validate` check the directory you run them in, so run them
from the project with `node` rather than through `npm run`, which would run
them in the Liftoff checkout.

- `liftoff doctor` checks the tools the project needs (uv and Git; Docker is
  optional) and says how to install anything missing.
- `liftoff validate` checks the project's configuration and the files
  Liftoff manages, and reports anything changed by hand.

Both only read; neither installs nor changes anything.

## What you get

See [Python API projects](projects/python-fastapi.md),
[Node.js API projects](projects/node-fastify.md) or
[Go API projects](projects/go-huma.md) for the generated layout, what each
file is for and who owns it.
