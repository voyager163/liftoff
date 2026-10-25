---
name: liftoff-security-review
description: Review the current change for security defects with the same find-verify-report discipline as liftoff-code-review. Use for high-risk changes, anything touching authentication, secrets, input handling, dependencies, CI workflows or infrastructure, or when asked for a security review.
---

# Security review

A separate pass from the bug review, because security defects hide in code
that otherwise works. Open Important security findings block merging until
they are fixed or answered with a reason.

<!-- include: negotiate -->

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

<!-- include: evidence -->

Never paste a real secret into a finding. Name the file and line, and say
which kind of secret it appears to be.
