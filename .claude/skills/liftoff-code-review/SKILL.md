---
name: liftoff-code-review
description: "Review the current change for real bugs before or during a pull request. Finds candidate issues, verifies each one in a fresh context, and reports only confirmed findings with file:line evidence, tagged Important, Nit or Pre-existing. Use when asked to review code, before opening a pull request, or after pushing new commits."
---

<!-- Managed by Liftoff. Change it through Liftoff rather than by hand. -->

# Code review: find, verify, report

Machines do most of the reading so people can spend their attention where it
matters. Your job is to catch real defects with evidence, not to produce
comments. A review with no findings is a good result when nothing is wrong.

## Before you call Liftoff

If `liftoff` is on the PATH, run `liftoff capabilities --json` once and use
only the commands and options it lists. Never guess a command or flag. If
Liftoff is not installed, or the command you need is not listed, do the step
by hand as this skill describes and say that the result was not checked by
Liftoff.

## 1. Gather context

1. **The change**: the diff against the branch it will merge into, usually
   `develop` (`git diff <base>...HEAD`, plus uncommitted changes).
2. **The intent**: the pull request description, linked issue or request.
   If you cannot tell what the change is for, ask before reviewing.
3. **The rules**: `REVIEW.md` at the root and the nearest `REVIEW.md` above
   each changed file, and `AGENTS.md` or `CLAUDE.md`. They say what failure
   looks like here, what to skip and how many nits to allow.
4. **The risk tier**: `liftoff review classify --json` (or the
   `liftoff-risk` skill). Match depth to the tier:
   - quick (low): one careful pass;
   - standard (medium): two passes, the second focused on callers and error
     paths;
   - deep (high): three passes with different focus (correctness, failure
     and recovery, security), and run `liftoff-security-review` too.

## 2. Find candidates

Read the diff against the whole repository, not in isolation.

- Does it solve the stated problem? For a bug fix, does it fix the root
  cause and every other instance of the same bug class?
- What breaks? Callers, error and timeout paths, empty and very large input,
  concurrency and retries, partial failure and recovery, macOS and Windows
  paths, upgrades from the previous version.
- Does it fit the system: the boundaries and conventions in `AGENTS.md`, and
  any architecture others will copy?
- Do the tests prove it? Would they fail if the change were reverted? Are any
  tests skipped, vacuous or asserting on mocks only?

Write each candidate down as: `path:line`, what is wrong, and a concrete
failure scenario.

## 3. Verify each candidate independently

Check every candidate in a fresh context that sees only the finding and the
code, not your reasoning, so it cannot inherit your mistakes.

- **Claude Code**: hand each candidate to the `liftoff-verifier` subagent.
- **GitHub Copilot**: use the `liftoff-verifier` custom agent.
- **Codex**: use the `liftoff-verifier` agent; if it is unavailable, start a
  new pass that reads only the finding and the code at that line.

Keep a finding only when the verifier confirms it. Treat "uncertain" as not
confirmed. Then drop anything that is style preference, something a linter
or formatter already enforces, speculation ("might", "could potentially"), a
restatement of the diff, or cleanup with no behavior impact, unless
`REVIEW.md` asks for it.

## 4. Report

Start with the count, then the findings, most severe first:

> 3 findings: 1 Important, 1 Nit, 1 Pre-existing.

or, when there is nothing to fix:

> No findings. Nothing to fix.

For each finding:

```text
[Important] src/orders/refund.ts:88: refund can be issued twice
What happens: a retry after a timeout calls issueRefund again because the
idempotency key is generated per attempt (line 81).
Failure: payment provider times out once, the client retries, the customer
is refunded twice.
Fix: derive the key from the order and refund id. Test: a retry after a
simulated timeout issues one refund.
Same bug class: src/orders/cancel.ts:40.
```

Tags:

- **Important**: a real defect this change introduces or exposes. Fix
  before merging.
- **Nit**: correct but worth a small change. At most three per review, or
  the cap in `REVIEW.md`.
- **Pre-existing**: a real bug in code this change did not introduce. Say
  so plainly so it is not read as the author's mistake, and suggest a
  separate issue rather than growing this pull request.

## Evidence rules

- Quote real output. Never report a check, test or command you did not run,
  and never describe a result you did not see.
- A finding needs a file and line plus a concrete failure: this input, in
  this state, produces this wrong result. A guess from a name is not evidence.
- When you could not check something (a tool is missing, it needs network or
  credentials, the code is outside the repository), say so and name what a
  person should look at.
- Do not install dependencies, run project scripts that change state, use the
  network or write outside the repository without asking first.

## Re-reviews

- After the first review, look only at what changed since the last one.
- Do not repeat a finding that was already reported, answered or resolved.
- After three rounds on the same pull request, stop and recommend that the
  author reconsider the approach or split the change.
- Do not edit code during a review unless asked. The author decides.
