---
name: liftoff-assess
description: Assess this whole project against the standard of the installed Liftoff release, read-only. Runs liftoff assess, then explains what is compliant, what differs, what could not be checked and why, and who should act next. Use when joining a project, before planning changes to its structure, CI or governance, or when asked how far a project is from Liftoff's standard.
---

# Assess the project

Tell the person where the project stands against the installed Liftoff
release's standard, without changing anything.

<!-- include: negotiate -->

## Steps

1. **Assess** with `liftoff assess --json` from the repository root. Add
   `--dir <path>` only for a directory the person named. Do not add `--live`
   unless the person asks for GitHub to be read; then use
   `liftoff assess --live --json` and let them answer the question about
   their GitHub CLI login, or pass `--use-gh` only if they already agreed.
2. **Say what the project is**: its parts and their stacks, whether each is
   supported, its development workflow and its coding-agent hosts.
3. **Report the findings by status**, keeping them apart:
   - *noncompliant*: seen, and different from the standard;
   - *unknown*: could not be told, so it is not a defect yet;
   - *inaccessible*: closed to this user;
   - *unsupported*: outside what this release covers, so not checked.
   Quote each finding's check, subject and message. Never call an unknown,
   inaccessible or unsupported finding a failure, and never call one
   compliant.
4. **Name the gaps**: what was not walked or read, and why. If a gap could
   hide a finding (a limit, a link, a directory closed to this user), say
   which checks it affects.
5. **Give the next actions** in the report's groups: changes to the project,
   Liftoff commands it names, access to ask for, and what this release
   cannot do yet. Offer to make a project change only as a separate step,
   after the person agrees, and never run a command that changes the
   project or GitHub on your own.

If Liftoff is not installed, look for the same things by hand (lock files,
tests, CI workflows, governance files) and say the result was not checked by
Liftoff.

<!-- include: evidence -->
