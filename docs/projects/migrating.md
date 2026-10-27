# Migrating a project

`liftoff migrate` makes a new Liftoff project beside an existing one: the
project [`liftoff init`](../getting-started.md) would make, starter
application included, with a copy of the old project's files in `legacy/`
and a checklist, `MIGRATION.md`, of what to move. It never changes the old
project.

Use it when you would rather start from Liftoff's standard layout than keep
your own, or when [adopting the project in place](adopting.md) is blocked:
when its parts are nested, or its application is on a stack this release has
no standard for and you want to move it to one that it has.

```bash
liftoff migrate --check                                 # what would migrating do? creates nothing
liftoff migrate                                         # see the plan, then approve
liftoff migrate --dir ../service --to ../service-next --stack node-fastify
liftoff migrate --out ../migrate.json && liftoff migrate --plan ../migrate.json --yes
```

Run it from the root of the repository, or name another directory with
`--dir`. The new project goes in a new or empty directory named with `--to`,
by default the old project's directory name followed by `-liftoff`, beside
it. The directory it goes in must exist, and it may not be inside the old
project or hold it, even through a link. Migrating refuses a project
Liftoff already has, and one with a change that has not finished.

## What it proposes

Migrating reads the project as [`liftoff assess`](assessing.md) does,
running nothing, and proposes the new project as `liftoff adopt` does: the
backend's stack, a Vue frontend and Azure infrastructure wherever in the
project they are, the coding-agent hosts it is set up for, and, for a
project from a Liftoff release before the rebuild, the choices its old
`liftoff.config.json` names. The same options replace any of it, other than
`--layout`: the new project keeps each part in its standard directory
(`backend/`, `frontend/`, `infrastructure/opentofu/azure/`). Its workflow is
`manual`.

`--stack` can name a stack the project has no backend on, such as
`node-fastify` for an Express application. The checklist then says to
rewrite the application on that stack.

## When it cannot migrate the project

It creates nothing, says why and exits 3 when:

- no backend this release supports is found: name the new project's stack
  with `--stack`;
- backends on more than one stack are found: pick one with `--stack`;
- it could not tell what a directory holds, such as one whose
  `package.json` is not valid: fix it, or name every part with `--stack`,
  `--frontend` and `--infrastructure`;
- part of the project could not be walked or read, because it is closed
  to you, changed while it was being listed or is past a limit, so the copy
  would miss it;
- the stack cannot have a frontend or infrastructure found in the project:
  leave it out with `--frontend none` or `--infrastructure none`;
- the directory's name does not make a project name: give one with `--name`;
- a Liftoff release before the rebuild left a record it does not
  recognize, or an update or repair it did not finish;
- the copy would be over 1 GiB.

An option this release cannot use, such as an unknown agent, is refused
with exit 2.

## What the copy holds

`legacy/` holds every regular file of the old project, at the same path and
with its permissions. Only you can open `legacy/` itself, since the old
project's folders may have been closed to others. It holds every file
except:

- Git's data, installed dependencies, caches and build output, such as
  `.git`, `node_modules`, `.venv` and `dist`;
- files that may hold secrets or state, such as `.env`, `.envrc`,
  `*.tfstate`, `*.tfvars`, private keys, `.npmrc`, `credentials.json`,
  `secrets.toml` and SQLite databases with their journals and write-ahead
  logs (`.env.example` is copied);
- the records a Liftoff release before the rebuild left, which stay with the
  old project as its history;
- links, which are never followed;
- files over 64 MiB;
- paths not every system can hold, and a path that macOS and Windows take
  for another the copy holds, such as `Data` and `data/app.txt`.

The plan names each one left out, and so does `MIGRATION.md`. The plan
lists each copied file with its sha256: a file changed since the plan was
made makes the plan stale, and one that changes while it is copied stops
the migration before anything is created.

## The checklist

`MIGRATION.md` is the new project's own: Liftoff does not manage it. It
lists, as steps to tick off:

- making the new project a Git repository that leaves `legacy/` out;
- each part found, where it is in `legacy/`, where the new project keeps
  that part and what each of its directories is for;
- parts the new project has no place for, such as a second backend or a
  React frontend, to keep apart or leave out;
- the old project's workflows and coding-agent instructions, to compare
  with Liftoff's;
- what the copy left out, and what to do about it, such as recreating
  secrets outside Git and installing dependencies again;
- checking the result with `liftoff validate` and the project's tests, then
  deleting `legacy/` and `MIGRATION.md`.

The old project, and its Git history, stay where they are.

## Approving and checking

Migrating shows the proposal and the plan, and asks before creating
anything; the default answer is no. Without a terminal it needs `--yes`.
`--out` saves the plan, outside both projects, and `--plan` applies exactly
that plan, or refuses it if the project or Liftoff changed since.

The new project is written beside its directory and moved into place in
one step, so it is there whole or not at all. Just before that, the old
project is planned again: a file that changed after it was copied, or one
that appeared, means nothing is created. Ctrl+C before then leaves nothing. Once it is in place, each file is read back and compared with the
plan, and the project is validated as `liftoff validate` does. Anything
different is named, and the command exits 3.
