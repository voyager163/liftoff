# Updating a project

`liftoff update` brings the files Liftoff manages in a project to the
Liftoff release you have installed. Run it after upgrading Liftoff, from
the project's root.

```bash
liftoff update --check                 # is there an update? exits 3 if so
liftoff update                         # show the plan, ask, then update
liftoff update --yes                   # update without asking, in scripts
liftoff update --out update.plan.json  # save the plan for review
liftoff update --plan update.plan.json --yes   # apply exactly that plan
```

## What it changes

`.liftoff/manifest.json` lists every file Liftoff wrote and who owns it.
Update changes only the files it lists as **managed**, such as the
coding-agent skills, the `.github/liftoff/` scripts and the workflows that
run them. For each one this release changes:

- if it is still as Liftoff wrote it, it takes this release's version, or
  is removed if this release no longer makes it;
- if you changed it, removed it, or something else stands in its place, it
  is left as it is and named, with why. To take this release's version,
  restore it from version control and run update again.

Files the project owns are never changed, even when this release's template
for them changed: your source code, lock files, `.env.example`,
infrastructure, rulesets, workflows Liftoff seeded for you to change, and
`README.md`. Neither are files a specification framework owns, nor
`liftoff.yaml`. No file changes owner in an update. A managed file this
release names in other letter case is held back for you to rename, since
macOS and Windows treat the two names as one file.

The manifest changes last, with the new hashes, this release's plugin
versions and an `update` entry in its history.

## What it never does

Update applies this release to the configuration the project was made with.
It never switches the workflow, governance profile, stack, GenAI pattern,
agents or any other plugin. It refuses, changing nothing, when:

- `liftoff.yaml` was changed since Liftoff wrote it;
- this release would make the project from other plugins;
- another change to the project has not finished;
- the project was made by a Liftoff release before the rebuild, or has parts
  in other directories. This release cannot update these yet (exit 6).

## New files

When this release makes a file the project does not have, such as a new
skill, update offers it and adds it only if you choose it at the question,
where none is chosen by default, or name it with `--add`:

```bash
liftoff update --add .claude/skills/liftoff-assess/SKILL.md --yes
```

A new file is never added where something already is.

## Approving and recovering

Update shows the plan and asks before changing anything; the default answer
is no. Without a terminal it needs `--yes`. A saved plan is checked again
when applied with `--plan`, and refused if the project or Liftoff changed
since it was made.

Each file is changed only if it is still exactly as planned, so an edit made
while the update runs is never overwritten. If an update stops part way, it
exits 5, `liftoff validate` reports it, and you can finish or undo it:

```bash
liftoff update --recover finish
liftoff update --recover undo
```

Recovery asks first, and leaves alone any file something else changed
meanwhile until you put it back. Ctrl+C stops an update or a recovery
between files: before the first, nothing changes (exit 4); after it, the
update stops part way and you can recover it.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Updated, or there was nothing to update |
| 1 | Refused or failed; nothing was changed |
| 2 | The command line was wrong, or `--yes` was needed |
| 3 | `--check` found an update; files were held back or could not be added; or something could not be removed after the update, which it names |
| 4 | You answered no, or pressed Ctrl+C before anything changed |
| 5 | The update, or its recovery, stopped part way |
| 6 | This release cannot update this project yet |
