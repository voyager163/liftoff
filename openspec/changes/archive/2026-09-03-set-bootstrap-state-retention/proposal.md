## Why

Policy v3 permits a transient local OpenTofu bootstrap when a private remote
backend cannot be reached until repository-owned networking exists, but it does
not define custody or disposal of that sensitive local state after verified
remote adoption. Leaving retention open causes repeated decisions and risks
either premature deletion or indefinite copies.

## What Changes

- Set one fixed default: retain encrypted local bootstrap state read-only for 30
  days after remote import is fully verified, then securely delete it.
- Define remote-import verification as private backend access, complete resource
  identity parity, remote state locking/versioning, and a no-change plan from a
  clean checkout.
- Require local bootstrap state to remain encrypted, gitignored, single-writer,
  non-transferable through ordinary artifacts or secrets, and unusable for
  further applies after remote verification.
- Require a dated deletion record and keep provisioning fail closed when remote
  import or eventual deletion evidence is incomplete.
- Advance the canonical governance policy version and update managed-core
  validation, documentation, tests, hashes, and snapshots without adding cloud
  mutation to the Liftoff CLI.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `liftoff-repository-governance-profile`: Define transient local bootstrap-state
  custody, verified remote adoption, 30-day read-only retention, and secure
  deletion.
- `liftoff-user-documentation`: Explain the fixed retention default, verification
  trigger, prohibited transfer paths, and deletion evidence.

## Impact

The canonical `single-maintainer-gitflow` policy, policy version and validator,
generated governance metadata, managed-core hashes and snapshots, repository
governance documentation, manifest expectations, and focused tests are
affected. Liftoff still generates local handoff files only; downstream approved
governance changes own bootstrap, import, retention, and deletion operations.
