## Context

See `proposal.md` for motivation. Bootstrap generation, seed lifecycle
execution, generated agent instructions, and governance verification are
separate modules but jointly define one deterministic `/liftoff-setup`
experience. The repair must preserve activation contract v1, JSON schema v1,
cross-platform path handling, user-owned state, and the existing authority
boundaries.

## Goals / Non-Goals

**Goals:**

- Make a generated new-capability seed archive into a strict-valid main spec.
- Make the generated setup contract capable of executing exactly one authorized
  transition without broadening its command allowlist.
- Make verification output unambiguous about consistency versus completion.
- Cover the reported failures with real generated-project and OpenSpec archive
  regressions.

**Non-Goals:**

- Change the phase graph, activation identity, or approval model.
- Automatically repair arbitrary user-authored OpenSpec main specs.
- Treat setup incompleteness as a verification-integrity failure.
- Restore or preserve the retired repository-governance setup alias.

## Decisions

### Generate purpose at the seed capability source

`renderSeedSpec` derives a concrete workload-specific purpose before emitting
`## ADDED Requirements`. This fixes the input that OpenSpec archives instead of
post-processing an OpenSpec-owned main spec. A generic post-archive replacement
was rejected because it would hide malformed generated deltas and couple
Liftoff to fallback text.

### Validate the complete spec set after archive

The seed lifecycle runs `openspec validate --all --strict` after a successful
archive and when retrying a seed that is already archived. Archive success is
not sufficient evidence of phase completion because synchronization can create
a main spec that change-local validation never examined. Revalidation on retry
allows a developer to repair the main spec without recreating or duplicating
the archived change. A post-archive validation failure is returned as blocked
for the current execution but does not persist a blocked phase state, so the
public `apply-next --execute` path remains retryable after repair.

### Keep preview and execution as separate explicit commands

Generated Copilot and Claude integrations allow both
`apply-next --json` and `apply-next --json --execute`. Preview remains the
read-only explanation path. Execution occurs only when the engine reports a
ready transition with approval status `not-required` or `reused`. Expanding the
allowlist to arbitrary governance flags or inferring approval from prose was
rejected.

### Add completion fields without redefining verification success

Verification retains `ok` as the compatibility field for integrity and adds
`consistent`, `verificationStatus`, `setupStatus`, `complete`, `stateSource`,
and a summary. A valid not-started or partial state may be consistent but is not
complete. Completion requires every phase to be in a successful terminal state
allowed by that phase and the disposal phase to be `disposed` or
`inapplicable`; observing that final phase as inapplicable by itself is
insufficient. Readiness and transition execution reject phase-forbidden
terminal results before they can authorize descendants or write evidence.
Inspection failures report setup status as `indeterminate`.

### Recheck archived capability integrity independently of old evidence

Governance inspection derives the expected generated capability from the
manifest whenever the matching seed archive exists. A missing main spec or
OpenSpec fallback Purpose blocks `seed-archived` even when an older release
already recorded fresh-looking archive evidence. This narrowly repairs the
known pre-0.10.3 defect without invalidating unrelated activation evidence or
changing the phase graph identity.

### Test through public generated artifacts and CLI argv

The regression generates both selected-agent setup integrations, runs the exact
preview and executable argv, and checks authoritative state, evidence, and next
phase. A real OpenSpec archive test checks the synchronized main spec and strict
validation. Unit-level fixture assertions alone were rejected because they
would not detect integration drift between generated instructions and CLI
behavior.

## Risks / Trade-offs

- **Additive JSON fields may be ignored by older consumers** → Preserve `ok` and
  schema version 1 while documenting the new completion fields.
- **Post-archive validation can block after OpenSpec has moved the change** →
  Report the exact failure and revalidate the already archived seed on retry.
- **A final inapplicable disposal phase can appear before predecessors finish**
  → Require every phase to be successfully terminal before reporting complete.
- **Generated command wording can diverge across agents** → Render both
  integrations from the same managed template and test both outputs.

## Migration Plan

Release as a patch. Existing projects run `liftoff upgrade` and
`liftoff update --force` to refresh managed setup integrations and remove any
modified retired alias after review. User-owned activation state and immutable
evidence are preserved. Rollback is the previous npm release; no state schema
migration is required.
