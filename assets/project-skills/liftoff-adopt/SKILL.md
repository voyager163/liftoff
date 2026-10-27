---
name: liftoff-adopt
description: Bring an existing repository under Liftoff with the person's approval, or finish adopting this one. Runs liftoff adopt --check to show what Liftoff would add and what keeps it from adopting the project, explains the proposal, and prepares the application changes the standard expects as unified diffs outside the project for the person to review and apply. Use when asked to bring a repository under Liftoff, or after liftoff adopt to make the application meet the standard.
---

# Adopt a project

Bring an existing repository under Liftoff without restructuring or
replacing its application, through changes the person reviews and
approves, never by editing the project's files yourself.

<!-- include: negotiate -->

## Steps

1. **See what adopting would do** with `liftoff adopt --check --json` from
   the repository's root, or with `--dir <path>` for a directory the person
   named. It changes nothing. It shows what Liftoff found (each part's stack
   and directory, the coding-agent hosts, and anything a Liftoff release
   before the rebuild left), the files it would add, the files already there
   that it keeps as the project's, and the application changes the standard
   expects, which adopting does not make.
2. **Explain the proposal**: where each choice came from, and that adopting
   adds only Liftoff's own files and never changes or replaces one the
   project has.
3. **If adopting is blocked**, explain each reason. When Liftoff could not
   tell which directory is which part, the person names them with
   `--layout`, for example `--layout backend=services/api,frontend=web`.
   When a part has to move first, prepare the move as a unified diff in a
   temporary directory outside the project, with every reference to the old
   path updated (imports, builds, tests, containers, CI and documentation),
   and show it to the person, who reviews and applies it before adopting.
4. **Give the person the command** to adopt, with the options the proposal
   needs: `liftoff adopt` with, for example, `--name`, `--agents` or
   `--layout`. Say that it shows the plan and asks before changing
   anything. Do not add `--yes` unless the person tells you to.
5. **After adopting**, run `liftoff assess --json` and explain what the
   application still needs. For each change:
   1. Prepare it as a unified diff in a temporary directory outside the
      project, the way `git diff --no-renames` writes it.
   2. Show the person the whole diff and what it is for.
   3. Name the files and directories it changes, as narrowly as you can.
   4. Give the person the command to apply it:
      `liftoff repair --patch <diff> --paths <paths>`.
6. **If an adoption stops part way**, run `liftoff validate --json` and tell
   the person to finish or undo it with `liftoff adopt --recover finish` or
   `liftoff adopt --recover undo`.

Never edit, create or delete a file in the project yourself, and
never answer Liftoff's question for the person. If Liftoff is not
installed, say so, and that nothing it would do was checked.

<!-- include: evidence -->
