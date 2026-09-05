## Why

Live `/liftoff-setup` runs exposed two deterministic setup defects: generated
OpenSpec capability deltas could archive into strict-invalid main specs, and the
generated agent contract permitted only a preview command when a ready phase
needed explicit execution. Verification also described a structurally valid
not-started project as `ok` without clearly separating consistency from setup
completion.

## What Changes

- Generate every bootstrap capability delta with a concrete `## Purpose`.
- Run strict validation across all OpenSpec specs after seed archive, including
  retries after an archived seed is repaired.
- Permit both read-only and executable `apply-next` forms in generated setup
  integrations, and execute only ready transitions whose approval status is
  `not-required` or `reused`.
- Report governance consistency independently from setup status and completion.
- Add generated-project and archive regressions covering state/evidence writes,
  phase advancement, concrete capability purpose, and post-archive failure
  recovery.
- Document cleanup of the retired `/liftoff-repository-governance` alias for
  projects upgrading from an older release.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `liftoff-infrastructure-governance`: Bootstrap capability deltas include a
  concrete purpose and archived main specs must pass strict validation.
- `liftoff-governance-activation-engine`: Generated setup can execute an
  authorized transition, and verification distinguishes consistency from
  completion.
- `liftoff-project-scaffold`: Selected-agent setup integrations expose the
  preview and executable command forms without introducing an alias.
- `liftoff-cli-workflow`: `apply-next` preview and execution semantics and
  machine-readable verification completion fields are explicit.

## Impact

The change affects bootstrap seed templates and lifecycle handling, generated
Copilot and Claude setup integrations, governance verification JSON and human
output, public/developer documentation, main OpenSpec contracts, and regression
tests. It adds no dependency and retains JSON schema version 1 through additive
fields.
