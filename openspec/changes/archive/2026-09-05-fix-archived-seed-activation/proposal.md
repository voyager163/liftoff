## Why

A bootstrap seed archived before Liftoff activation can pass `seed-valid` but
cannot pass `seed-verified`: the baseline still asks OpenSpec to validate an
inactive change name. The failed attempt persists a blocker that prevents
retrying the corrected local baseline.

## What Changes

- Select strict OpenSpec validation from the discovered seed lifecycle: validate
  an active change by name, or validate synchronized specs for an archived seed.
- Preserve every applicable local baseline command and archived-capability
  integrity check; never recreate an archive or treat its presence as baseline
  evidence.
- Allow the archived, approval-free baseline phase to retry a persisted blocker
  without editing activation state during status, plan, resume, or verification.
- Clarify the phase selected by `apply-next` separately from the next phase
  reported by subsequent status or verification, preserving legacy JSON fields.
- Include bounded, credential-safe OpenSpec failure details instead of only an
  exit status.
- Cover fresh setup and resumption after `seed-valid`, and report normal active
  seed progress as incomplete rather than a governance inconsistency.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `liftoff-governance-activation-engine`: Full baseline verification and safe
  recovery when bootstrap archival predates activation.
- `liftoff-cli-workflow`: Explicit phase selection and actionable, sanitized
  failure diagnostics for deterministic setup.

## Impact

Changes are limited to Liftoff seed lifecycle, readiness, CLI presentation,
regression tests, and related documentation. No phase graph, approval scope,
state schema, dependency, package version, or remote resource changes are
required. This work will remain uncommitted and unreleased.
