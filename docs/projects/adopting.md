# Adopting a project

`liftoff adopt` brings an existing project under Liftoff without
restructuring or replacing it. It adds Liftoff's own files (its workflows,
review policy, governance handoff, coding-agent skills and instructions)
made for where the project's parts already live, and changes none of the
project's files.

```bash
liftoff adopt --check                                   # what would adopting do? changes nothing
liftoff adopt                                           # see the plan, then approve
liftoff adopt --dir ../service --layout backend=api,frontend=web --agents claude
liftoff adopt --out adopt.json && liftoff adopt --plan adopt.json --yes
```

Run it from the root of the repository, or name another directory with
`--dir`. It refuses a project Liftoff already has: [`liftoff update`](updating.md)
and [`liftoff repair`](repairing.md) change those.

## What it proposes

Adopting reads the project as [`liftoff assess`](assessing.md) does, running
nothing, and proposes what the project is. The proposal says where each
choice came from:

- **Each part and where it is.** The backend's stack (a FastAPI, PydanticAI,
  Fastify or Huma application), a Vue frontend and Azure infrastructure in
  OpenTofu, each in the directory it is in. A part outside Liftoff's
  standard directories (`backend/`, `frontend/`,
  `infrastructure/opentofu/azure/`) is bound to its own directory in
  `liftoff.yaml`; `.` is the repository root.
- **The coding-agent hosts** the project is set up for, such as Claude Code
  when it has a `CLAUDE.md`.
- **For a project from a Liftoff release before the rebuild**, the name,
  agents, governance profile, GenAI pattern and environments its old
  `liftoff.config.json` names, when this release has exactly that value.
- **Otherwise** a name made from the directory's name, and the
  `single-maintainer-gitflow` governance profile.

Options replace any of it: `--name`, `--stack`, `--pattern`, `--frontend`,
`--infrastructure`, `--environments`, `--agents`, `--governance`,
`--ai-review`, `--review-engine`, `--owners` and `--layout`. Use
`--frontend none` or `--infrastructure none` to leave a part Liftoff found
as the project's own, unchecked.

The workflow is always `manual`: adopting runs no framework's initializer,
and OpenSpec or Spec Kit files the project has stay its own.

## When it cannot adopt the project

Adopting never puts a starter application in place of one it cannot place.
It changes nothing, says why and exits 3 when:

- more than one directory holds a backend (or a frontend, or
  infrastructure): name the one to adopt with `--layout`;
- a part is not where an option names it;
- it could not tell what a directory holds, such as one whose
  `pyproject.toml` is not valid: fix it, or name every part with
  `--layout`;
- one part's directory is inside another's, or the infrastructure is the
  repository root: move the part first;
- the directory's name does not make a project name: give one with `--name`;
- a Liftoff release before the rebuild left a record it does not
  recognize, or an update or repair it did not finish.

A frontend or infrastructure the backend's stack cannot have, such as a
Vue frontend beside a PydanticAI backend, blocks adopting too: leave it out
with `--frontend none` or `--infrastructure none`. An option this release
cannot use, such as an unknown agent, is refused with exit 2.

When the project has no backend this release supports, such as an Express
or Rust application, it exits 6. Applications Liftoff has no stack for,
beside the parts it adopts, stay the project's and are named.

## What it adds, and what it keeps

The plan lists each of Liftoff's files it adds: `liftoff.yaml`,
`.liftoff/manifest.json`, and the files Liftoff makes for a project with
these parts, other than the application's own (no code, build files,
Compose file, `.env.example` or README). Each one that refers to a part
refers to it where it lives: CI jobs run in its directory, Dependabot looks
there, the review policy's rules name its files there, and images are built
from there.

Where one of Liftoff's files would go and the project already has
something, such as its own `AGENTS.md` or `.gitignore`, the project's file
stays and Liftoff's is not added, even when they are the same. The manifest
records that path as kept, so `liftoff update` never offers Liftoff's file
there.

The plan also lists the application changes Liftoff's standard expects of
the parts it adopts, which adopting does not make, such as a missing lock
file, tests, a coverage threshold or a Dockerfile, the `.liftoff/` lines
Liftoff's `.gitignore` has, and infrastructure roots outside the
`bootstrap` and `environments` directories Liftoff's CI validates. Once the
project is adopted, make each with a reviewed patch:

```bash
liftoff repair --patch ../coverage.diff --paths pyproject.toml
```

The generated `liftoff-adopt` skill explains the proposal and prepares
these patches outside the project for you to review.

## Projects from before the rebuild

The records an old Liftoff release left, such as `liftoff.manifest.json`,
`liftoff.config.json` and `governance/`, stay exactly as they are: they are
the project's history, never current configuration or proof. The new
manifest lists each one, with the sha256 of the old manifest, configuration
and activation state as they were kept. Records that can hold copies of
files, credentials or state are listed by name alone.

## Approving and recovering

Adopting shows the proposal and the plan, and asks before changing
anything; the default answer is no. Without a terminal it needs `--yes`.
`--out` saves the plan, and `--plan` applies exactly that plan, or refuses
it if the project changed since.

Each file is added only if nothing is there yet, and the declarations the
proposal was made from must still be as they were. If adopting stops part
way, even before `liftoff.yaml` is written, it exits 5,
`liftoff validate` reports it, and you can finish or undo it:

```bash
liftoff adopt --recover finish
liftoff adopt --recover undo
```

Undoing removes every file adopting added; the directories made for them
stay, empty.
