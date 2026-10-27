---
name: liftoff-governance-assess
description: Check, read-only, how far this project's governance is really enforced on GitHub. Runs liftoff governance assess with the person's consent, then explains each checkpoint from the committed rulesets to the rules GitHub enforces, and what to do next. Use before activating governance, after changing rulesets or workflows, or when asked whether the branch rules really hold.
---

# Assess the project's governance on GitHub

Show how far the committed governance (rulesets, required checks, review
policy) is enforced on GitHub today, without changing anything.

<!-- include: negotiate -->

## Steps

1. **Check the files first** with `liftoff validate --json`: governance is
   only assessed against files Liftoff can trust.
2. **Ask before reading GitHub.** `liftoff governance assess --json` reads
   the repository with the person's GitHub CLI login. Run it so they can
   answer its question, or pass `--use-gh` only if they already agreed. Use
   `--repo owner/name` when the origin remote is not the repository.
3. **Explain each checkpoint in order**, as the report gives it: done, next
   or later, with what was observed. The first one that is not done is the
   one to work on; later ones wait for it.
4. **Say what comes next.** When the next checkpoint has an action,
   `liftoff governance apply-next` does it, one step at a time and only
   after the person approves it in the command itself. Do not run it on
   their behalf. When it needs a person (an admin, a pull request, a
   workflow run), say exactly what they need to do.
5. **Report what could not be read**, such as a repository the login cannot
   see, as not checked, never as passing or failing.

`liftoff governance status` shows what Liftoff has recorded locally without
contacting GitHub.

<!-- include: evidence -->
