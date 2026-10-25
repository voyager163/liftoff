# Liftoff's own repository

How Liftoff's own source is built, checked and protected. Projects Liftoff
generates have their own governance; this file is only about this repository.

## REPO-001 One aggregate gate that fails closed

`ci-gate` depends on every CI job and succeeds only when each of them
succeeded. A skipped, cancelled, timed-out or missing job fails the gate.
Branch rules require `ci-gate` rather than individual job names.

Verification: live

## REPO-002 Desired rulesets are committed and read back

`.github/rulesets/*.json` hold the intended branch rules. The governance drift
workflow reads the rules GitHub actually enforces on each targeted branch and
fails on any missing or changed rule. A committed ruleset is never treated as
proof of enforcement. Stricter extra rules are not drift.

Verification: test

## REPO-003 Actions are pinned to full commit SHAs

Every `uses:` in `.github/workflows/` names a full 40-character commit SHA,
followed by a comment with the release it corresponds to.

Verification: test

## REPO-004 Workflows default to read-only permissions

Every workflow sets top-level `permissions` to read-only. A job that needs
more declares only the specific write permission it uses. No workflow uses
`write-all`.

Verification: test

## REPO-005 Privileged triggers never run pull request code

Workflows triggered by `pull_request_target` or `workflow_run` never run
pull request code. The workspace is always the base branch's checkout. A job
that needs the pull request's files, such as the AI review, checks the head
out into a directory of its own without credentials, and no step runs
anything from that directory. Pull request text such as titles or branch
names is never passed into a `run:` script.

Verification: test

## REPO-006 Checks run on the supported developer platforms

Tests and coverage run on macOS arm64 and Windows x64 runners. Linux runners
are used only for platform-independent checks (lint, types, boundaries,
traceability, generated files, CodeQL) and for generated projects'
PostgreSQL and container checks, which qualify a deployment target. Linux is
never a supported CLI platform.

Verification: test

## PKG-001 The native bundle runs without a global Node

The bundle for each supported platform (`liftoff-package-aarch64-apple-darwin`
and `liftoff-package-x86_64-pc-windows-msvc`) contains a launcher built from
an official Node.js runtime and the same application files as the npm
package. CI builds it on macOS arm64 and Windows x64 and runs `--version`,
`capabilities`, `init` and `validate` from a copy with no Node on the PATH.
The launcher resolves its real location, so it also works through a symlink
such as Homebrew's.

Verification: live
