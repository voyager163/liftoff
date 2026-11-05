---
name: liftoff-verify
description: Run this project's own checks and show their real output before saying a change works. Use after finishing a change, before opening or updating a pull request, or whenever asked whether something works.
---

# Verify a change with real evidence

Give the change something it can run, and show what happened. A claim of
success without output is not verification.

## Steps

1. **Find the checks.** Use the "Checks" section of `AGENTS.md` or
   `CLAUDE.md`. If there is none, read the project's own scripts
   (`package.json`, `pyproject.toml`, `Makefile`, `go.mod`) and say which
   commands you chose and why.
2. **Run them from the repository root**, in this order: format and lint,
   type check, tests with coverage, build. When one fails, fix the cause and
   run that check again before moving on.
3. **For user-interface changes**, also run the end-to-end or screenshot
   tests, and compare the result with the design when there is one.
4. **Report** each check as the exact command, passed or failed, and the
   last relevant lines of its output.

## Never

- Skip, filter or retry a failing test until it passes by luck.
- Add `|| true`, `continue-on-error`, `--passWithNoTests` or similar to make
  a check green.
- Lower a coverage threshold or exclude code to reach it.
- Count a test run that executed zero tests as a pass.

<!-- include: evidence -->
