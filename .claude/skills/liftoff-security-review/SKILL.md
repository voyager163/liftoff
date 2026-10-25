---
name: liftoff-security-review
description: "Review the current change for security defects with the same find-verify-report discipline as liftoff-code-review. Use for high-risk changes, anything touching authentication, secrets, input handling, dependencies, CI workflows or infrastructure, or when asked for a security review."
---

<!-- Managed by Liftoff. Change it through Liftoff rather than by hand. -->

# Security review

A separate pass from the bug review, because security defects hide in code
that otherwise works. Open Important security findings block merging until
they are fixed or answered with a reason.

## Before you call Liftoff

If `liftoff` is on the PATH, run `liftoff capabilities --json` once and use
only the commands and options it lists. Never guess a command or flag. If
Liftoff is not installed, or the command you need is not listed, do the step
by hand as this skill describes and say that the result was not checked by
Liftoff.

## What to check in the diff

- **Access control**: every new route, command or job checks who is acting
  and what they may touch. Look for missing checks, checks after the effect,
  and identifiers taken from the request without an ownership check.
- **Input**: injection into SQL, shell commands, paths, templates, regular
  expressions, log lines and HTTP headers; path traversal; unsafe
  deserialization; server-side request forgery through user-supplied URLs.
- **Secrets**: credentials in code, config, logs, error messages, test
  fixtures or pull request text; tokens with more scope or lifetime than
  needed.
- **Dependencies**: new packages, version ranges instead of locked versions,
  install scripts, typosquatting, a lockfile that does not match the
  manifest.
- **CI and automation**: `pull_request_target` or `workflow_run` jobs that
  check out or run pull request code, write permissions a job does not need,
  actions not pinned to a full commit SHA, untrusted text (titles, branch
  names, comments) used inside `run:` scripts.
- **Infrastructure**: public network exposure, storage without encryption or
  with public access, identities with broad roles, long-lived secrets where a
  managed identity or OIDC would do.
- **Failure handling**: errors that fail open, retries that repeat a
  non-idempotent effect, timeouts that leave partial state.

## Method

Follow `liftoff-code-review` steps 2 to 4 with this list as the focus:
record candidates with a concrete exploit or failure path, verify each one
in a fresh context with the `liftoff-verifier` agent, and report only
confirmed findings, starting with the count.

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

Never paste a real secret into a finding. Name the file and line, and say
which kind of secret it appears to be.
