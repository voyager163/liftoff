# Repairing a project

`liftoff repair` fixes a Liftoff project through changes you review and
approve. It has two ways in:

- **Recipes** put back files Liftoff wrote that are missing or were changed
  by hand.
- **A reviewed patch**, such as one a coding agent prepared, changes the
  project's own files, and only within the paths you name.

```bash
liftoff repair --check                                  # what needs attention? exits 3 if anything
liftoff repair                                          # choose what to put back, then approve
liftoff repair --restore .github/liftoff/review-policy.mjs --yes
liftoff repair --patch fix.diff --paths backend/app     # apply a reviewed diff
```

## What it puts back

`liftoff repair --check` lists each file Liftoff wrote that is not as it
should be, and changes nothing:

- **A file Liftoff manages** (listed as managed in `.liftoff/manifest.json`)
  that is missing or was changed by hand. Repair puts it back as this
  release makes it, replacing any hand edit.
- **A file Liftoff wrote for the project** that is missing. Repair puts it
  back only when this release would write it exactly as Liftoff first did;
  otherwise restore it from version control.

A file the project owns that you changed is yours, and is not listed.
Neither are files a specification framework owns.

Nothing is put back unless you choose it, at the question where nothing is
chosen by default, or name it with `--restore`. Repair never replaces a
directory or a link, never changes `liftoff.yaml`, and, like
[`liftoff update`](updating.md), refuses a `liftoff.yaml` changed since
Liftoff wrote it. The manifest records each file put back, and the repair.

## Applying a reviewed patch

For anything else, prepare the change as a unified diff, review it, and
apply it with the files and directories it may change:

```bash
git diff --no-renames > ../fix.diff     # or a diff a coding agent wrote outside the project
liftoff repair --patch ../fix.diff --paths backend/app
```

Repair applies it exactly as written, or not at all:

- each hunk must match the file at the line it names;
- it refuses any file outside `--paths`;
- it never changes a file Liftoff manages or a framework owns, `liftoff.yaml`,
  `.liftoff` or `.git`;
- renames, copies, mode changes and binary files are refused, so make the
  diff with `--no-renames`;
- each file it changes must be UTF-8 text of at most 4 MiB, and so must the
  patch.

The generated `liftoff-repair` skill works this way: it explains what needs
attention and prepares diffs outside the project, and you apply them.

## Approving and recovering

Repair shows the plan and asks before changing anything; the default answer
is no. Without a terminal it needs `--yes`. `--out` saves the plan, and
`--plan` applies exactly that plan, given the same `--patch` and `--paths`
for a patch, or refuses it if anything changed since.

Each file is changed only if it is still exactly as planned. If a repair
stops part way, it exits 5 and you can finish or undo it:

```bash
liftoff repair --recover finish
liftoff repair --recover undo
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Repaired, or nothing needed attention |
| 1 | Refused or failed; nothing was changed |
| 2 | The command line was wrong, or `--yes` was needed |
| 3 | Files still need attention, or something could not be removed afterwards |
| 4 | You answered no, or pressed Ctrl+C before anything changed |
| 5 | The repair, or its recovery, stopped part way |
| 6 | This release cannot repair this project yet |
