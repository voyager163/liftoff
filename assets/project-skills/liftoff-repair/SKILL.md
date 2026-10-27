---
name: liftoff-repair
description: Repair this Liftoff project with the person's approval. Runs liftoff repair --check, explains which files Liftoff wrote need attention, offers the liftoff repair command that puts them back, and for any other fix prepares a unified diff outside the project for the person to review and apply with liftoff repair --patch. Use when liftoff validate or liftoff assess reports missing or changed Liftoff files, or when asked to fix something in the project.
---

# Repair the project

Fix what is wrong in the project through changes the person reviews and
approves, never by editing the project's files yourself.

<!-- include: negotiate -->

## Steps

1. **See what needs attention** with `liftoff repair --check --json` from
   the project's root. It lists each file Liftoff wrote that is missing or
   was changed by hand, and whether a recipe can put it back. It changes
   nothing.
2. **Explain each file**: what is wrong, and either that repair can put it
   back as this release makes it, or why it cannot. A file the project owns
   that was changed is the project's, and is not a problem.
3. **Offer the recipe** for the files that can be put back, as the command
   the person runs: `liftoff repair --restore <paths>`. Say that it shows
   the plan and asks before changing anything, and that putting back a
   managed file replaces any hand edit in it. Do not add `--yes` unless the
   person tells you to.
4. **For any other fix**, such as a change to the application's code:
   1. Prepare the change as a unified diff in a temporary directory outside
      the project, never in the project itself. Make it against the files
      as they are now, the way `git diff --no-renames` writes it.
   2. Show the person the whole diff and what it is for.
   3. Name the files and directories it changes, as narrowly as you can, for
      `--paths`.
   4. Give the person the command to apply it:
      `liftoff repair --patch <diff> --paths <paths>`. Liftoff checks that
      every hunk matches exactly, refuses any file outside those paths and
      any file Liftoff manages, shows the plan, and asks.
5. **If a repair stops part way**, run `liftoff validate --json` and tell the
   person to finish or undo it with `liftoff repair --recover finish` or
   `liftoff repair --recover undo`.

Never edit, create or delete a file in the project yourself, never apply a
diff any other way, and never answer Liftoff's question for the person. If
Liftoff is not installed, write the diff and say that it was not checked by
Liftoff.

<!-- include: evidence -->
