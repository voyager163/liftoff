## 1. Revise the policy lifecycle

- [x] 1.1 Advance the canonical governance policy to version 4 and add the fixed 30-day read-only local bootstrap-state retention default; verify frontmatter and generated metadata agree
- [x] 1.2 Define when a minimum encrypted local bootstrap is permitted and prohibit ordinary artifact, secret, or messaging transfer of state; verify existing private management paths remain preferred
- [x] 1.3 Define objective remote-import verification using private backend access, resource identity parity, locking, versioning, and a clean no-change plan; verify incomplete evidence starts no retention clock
- [x] 1.4 Define the post-verification read-only freeze, 30-day expiry, secure deletion outcome, and non-sensitive deletion record; verify retained state cannot authorize plan or apply

## 2. Enforce the managed contract

- [x] 2.1 Update policy-version constants, manifest expectations, and presentation snapshots to version 4; verify existing historical policy versions remain readable for managed-core reconciliation
- [x] 2.2 Add required validator fragments for local custody, remote-import evidence, 30-day retention, and secure deletion; verify omission of each guarantee fails policy validation
- [x] 2.3 Add forbidden fragments for indefinite retention, state transfer through GitHub, immediate deletion before verification, and use of retained state as an active backend; verify each unsafe mutation is rejected
- [x] 2.4 Update the canonical policy hash and managed-core snapshots; verify deterministic rendering remains stable

## 3. Update guidance and coverage

- [x] 3.1 Update repository-governance documentation with the private-backend bootstrap state machine and fixed retention rule; verify it distinguishes Liftoff generation from downstream state operations
- [x] 3.2 Update prerequisite, safety, troubleshooting, and existing-project guidance where needed; verify no guidance recommends enabling public state access or hand-transferring local state
- [x] 3.3 Add focused policy tests for preferred private access, bounded local bootstrap, remote verification, failed verification, read-only retention, expiry, and deletion evidence
- [x] 3.4 Update documentation and generated presentation tests for policy version 4 and the retention contract; verify cross-platform snapshots remain consistent

## 4. Validate the completed change

- [x] 4.1 Run strict OpenSpec validation and resolve every artifact or delta error
- [x] 4.2 Run focused governance, manifest, update, documentation, catalog, planner, and contract tests
- [x] 4.3 Run `npm run check`, package smoke, release identity, and package inspection; verify the complete version-4 handoff remains publishable
