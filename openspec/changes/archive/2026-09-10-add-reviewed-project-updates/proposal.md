## Why

Liftoff 0.11.1 diagnoses historical activation v1 but provides no supported path to current v2 activation, leaving existing projects unable to resume governance after upgrading. Users need one reviewable update journey that preserves their history and production files, establishes fresh proof where possible, and explains remaining work instead of presenting an unsupported-migration dead end.

## What Changes

- Make `liftoff update --check` the human-first compatibility and migration preview. `--json` remains optional formatting for automation, not a safety or approval switch.
- **BREAKING**: Require a matching prior preview and explicit approval of the exact effective plan before any update mutation, including ordinary managed-core updates, manifest maintenance, component provisioning, and forced managed-core changes. Missing or stale previews stop with instructions to run `liftoff update --check`; no-op inspection remains non-mutating.
- Keep check mode read-only for the project, but disclose and persist a project-bound preview receipt in user-local storage outside the repository. Other diagnostics remain entirely read-only and do not issue receipts.
- Add interactive approval with a negative default and noninteractive approval bound to the exact plan fingerprint. Neither `--force`, redirected input, JSON output, nor a generic consent flag substitutes for this approval.
- Introduce an explicitly supported activation-v1-to-v2 migration lane inside `liftoff update`, not a separate migration command or a reinterpretation of the existing non-Liftoff adoption command.
- Preserve v1 state, evidence, plans, approvals, and the source metadata in a durable, byte-preserving history snapshot inside the project. Create a linked v2 activation and a resumable migration record through a guarded local transaction.
- Revalidate existing work under v2 using fresh, current-input-bound evidence. Never retag historical receipts, carry forward old approvals as current authorization, or recreate live resources to make migration succeed.
- Retain a blocked, resumable v2 activation if post-commit revalidation fails. Resume only supported, explicitly approved local work and report the first genuinely incomplete phase; new privileged or remote actions retain independent approval boundaries.
- **BREAKING**: Version the expanded update report and compatibility-metadata contracts explicitly. Keep the existing v2 execution proof semantics and manifest v7 ownership boundary; history and migration records do not become ordinary managed-core templates.
- Update doctor, setup/status, verification, assessment, help, and documentation to distinguish supported migration, preserved history, completed local migration, incomplete revalidation, and actual governance readiness.

## Capabilities

### New Capabilities

- `liftoff-activation-migration`: Exact supported historical migration lanes, durable v1 snapshots, linked v2 activation, fresh-proof revalidation, resumable recovery, and separation of historical records from current execution authority.

### Modified Capabilities

- `liftoff-project-update`: Compatibility-first previews, external preview receipts, mandatory exact-plan approval, guarded activation migration, mode-specific force plans, and versioned outcomes.
- `liftoff-template-ownership`: A narrowly authorized activation-migration write set separate from managed-core reconciliation and create-only provisioning, without expanding authority over production files.
- `liftoff-manifest-contract`: Transactional active-identity changes with historical provenance retained separately, explicit migration-record identities, and unchanged application generation provenance.
- `liftoff-governance-activation-engine`: Explicit migration eligibility distinct from execution compatibility, fresh v2 evidence requirements, and consistent blocked/resumable post-migration behavior.
- `liftoff-governance-assessment`: History-aware inspection that does not treat preserved v1 records as either current proof or a reason to reject an otherwise valid migrated v2 activation.
- `liftoff-project-doctor`: Human-first check remedies, supported migration diagnostics, and distinct migration-complete versus revalidation-blocked findings without creating preview receipts.
- `liftoff-cli-workflow`: Reviewed update command routing, interactive and plan-bound noninteractive approval, and clear missing-preview, stale-preview, decline, and partial outcomes.
- `liftoff-user-documentation`: The check/approve/migrate/revalidate/resume journey, external receipt disclosure, in-project history, automation approval, and recovery guidance.

## Impact

- Implementation areas: `src/application/update/`, `src/cli/args/`, `src/cli/commands/`, presentation/interaction composition, filesystem locks and transactions, and new narrowly scoped user-local receipt storage.
- Governance areas: historical identity and schema readers, compatibility metadata, migration planning, active-state/evidence selection, input snapshots, local transition producers, and diagnosis/assessment adapters.
- Public contracts: prompt-free updates and schema-v2 update reports change; scripts must obtain a preview and approve its exact fingerprint. `liftoff upgrade` still updates the CLI package, and `liftoff migrate` still adopts non-Liftoff sources.
- Persistent data: disposable receipts outside the repository; immutable history and resumable migration metadata inside the project. Nothing is automatically committed, pushed, published, or sent to a provider.
- Coverage: existing update, governance migration/v2, doctor, assessment, CLI, documentation, packaging, and cross-platform suites, including Windows path and interruption cases. No new dependency or testing framework is presumed.
- Out of scope: changing Node/Copilot version policies, repairing `.env`, upgrading application templates or dependencies, moving infrastructure/state, restoring retired workloads, implementing deferred production executors, and public provider-credential enrollment.
