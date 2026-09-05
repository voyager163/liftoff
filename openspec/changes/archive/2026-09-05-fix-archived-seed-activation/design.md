## Context

See `proposal.md` for the reported lifecycle failure. Seed discovery already
distinguishes active and archived seeds, but baseline command selection uses
only the change name. All persisted blockers currently prevent phase selection,
including a local baseline failure that is safe to retry.

## Goals / Non-Goals

**Goals:**
- Verify the complete local baseline after an external OpenSpec archive.
- Recover existing `seed-verified` blockers without editing user state during
  inspection or fabricating evidence.
- Make failures actionable and phase-selection fields explicit.

**Non-Goals:**
- A general retry engine, approval bypass, graph/schema migration, or release.
- Reopening, rewriting, or duplicating the original archived seed.
- Automatically repairing user-authored specs or changing another repository.

## Decisions

### Select validation by discovered lifecycle

Pass the discovered active/archived state into the existing baseline selector.
Active seeds keep change-scoped strict validation; archived seeds use
`openspec validate --all --strict` after the existing expected-capability
integrity check. All backend, worker, frontend, Compose, and backend-disabled
OpenTofu checks remain unchanged. Recreating the active seed or skipping
OpenSpec validation would hide the failure and is rejected.

### Retry only the archived local baseline

Read-only inspection may make a persisted `seed-verified` blocker eligible for
retry only after discovery identifies an unambiguous archived seed with valid
main-capability integrity. Readiness still requires fresh predecessor evidence
and the canonical approval gate. The stored failure remains visible and
unchanged until an explicit `apply-next --execute` reruns the full baseline and
writes its result. Other blocked phases and failed or stale evidence retain
their existing behavior.

### Preserve JSON compatibility while naming the attempted phase

Add `selectedPhase` to apply-next results and `executedPhase` to execution
results. Preserve the legacy `nextReadyPhase` field in apply-next rather than
silently changing schema-v1 semantics. Generated guidance and docs explain that
the subsequent status/verify response supplies post-transition readiness.
An intact active seed is an expected pre-governance state, not an integrity
failure by itself. Skip the governance-source check only when there are no
competing candidates, no active governance change, and no archive-or-later
completion state/evidence. Missing or overlapping seeds and contradictory
archive claims still fail verification; readiness and publication gates do not
change.

### Bound and sanitize OpenSpec diagnostics

Only OpenSpec failures gain command-output detail. Strip terminal control
sequences, scan before truncation using the shared credential-leak detector,
withhold credential-shaped diagnostics, and bound the retained text. Do not
start logging arbitrary backend or infrastructure output as part of this fix.

## Risks / Trade-offs

- Retrying could be mistaken for completion: expose prior blockers separately
  and require all checks to pass before writing verified evidence.
- A repaired spec can become invalid again: recheck archive integrity and
  strict validation on execution, not only during preview.
- Readers may still use the legacy apply-next field: document its meaning and
  use explicit selected/executed fields in new generated guidance.
- Host-specific paths could break reproduction: use existing project path
  helpers and portable temporary projects with spaces; run these tests in the
  existing Linux/macOS/Windows test matrix.

## Migration Plan

No on-disk migration is needed. An upgraded engine can re-evaluate the existing
archived baseline blocker through status/resume and retry through the already
allowed executable command. Publication, commits, and changes to rsaf-orbit are
explicitly outside this request.
