## Context

See `proposal.md` for motivation and the agreed user journey. The current update use case in `src/application/update/use-case.ts` combines reconciliation, reporting, and imperative apply. `--check` currently writes nothing anywhere, ordinary apply is prompt-free, and JSON reports use schema 2. The existing project transaction and cooperating lock protect a bounded write set but are not a durable historical backup.

Known activation v1 is an exact identity in `src/domain/governance/policy/identity.ts`, not a range of older version numbers. Its contract/state/evidence/approval versions are 1 and its graph hash is `b84bcde6cd614637f2486b0f3a202860e6e9a6142ac60c773daa11786dbeb7f7`. Current execution uses v2. `src/governance-activation/migration.ts` rejects v1 before consulting injected mappings, and the packaged compatibility document has no historical migration lanes. The existing mapping path assumes the current state schema; it is not a v1 converter.

The v2 evidence reader consumes the active evidence directory and rejects v1 receipts. V2 additionally binds evidence bodies, current inputs, stable local identity, verified remote identity where applicable, and approval timing. A new hash over an old payload cannot establish historical freshness or authorization.

## Goals / Non-Goals

**Goals:**

- One project-scoped update planner supplies human preview, JSON, approval, apply, and diagnostic classification.
- All update writes require a matching prior preview and exact-plan approval, not just activation migrations.
- Separate planning, local transactional migration, and post-commit revalidation so recovery is unambiguous.
- Preserve original historical bytes while establishing new v2 proof only through supported current validators and producers.
- Make receipts, history, locks, and failure recovery work on Windows, macOS, and Linux.

**Non-Goals:**

- Replacing existing application templates, dependencies, environment files, framework/seed files, or infrastructure topology.
- Changing workstation version policy, repairing the reported Node/Copilot findings, or creating `.env`.
- Activating remote governance, committing, pushing, enrolling credentials, or adding deferred production executors.
- Treating a local preview receipt as evidence, a signature, provider permission, or proof that a human read the preview.
- Importing arbitrary historical JSON, accepting unknown activation tuples, or weakening current v2 validators.

## Decisions

### D1. Keep the reviewed flow on `update`

The primary sequence is:

```text
liftoff update --check
  compatibility -> project-read-only preview -> external preview receipt

liftoff update
  matching receipt -> recomputed plan -> explicit approval
  -> guarded local transaction -> fresh local revalidation -> next incomplete phase
```

Add `liftoff update --approve-plan <fingerprint>` for noninteractive exact-plan approval. The argument is the complete lowercase SHA-256 fingerprint printed by check, not a prefix or a generic yes. Interactive apply displays the matching effective plan and asks one negative-default approval question. JSON changes formatting only; any interactive presentation uses stderr so stdout remains one JSON result. Without usable interactive input, missing `--approve-plan` blocks rather than approving implicitly.

Keep `--apply` removed and `--check --force` invalid. Check displays the normal plan and, only when relevant, a separately fingerprinted forced variant listing its additional exact managed-core overwrites/retired-alias deletions. `update --force` selects only that variant and still needs its matching receipt and approval. A normal-plan approval never authorizes the forced variant. No variant includes unowned collisions or project-template replacement.

No-op invocations return without approval because they perform no update mutation. A write-capable invocation with no matching receipt stops, even if its changes look safe, and names `liftoff update --check` as the remedy.

**Alternative rejected:** a separate governance migration command fragments the agreed workflow. Automatically previewing and applying in one invocation would not enforce the user's explicit check-first decision.

### D2. Extract a pure plan and keep receipts outside the project

Extract a shared plan builder from the existing update planning/reconciliation helpers. It returns compatibility, exact mutation lanes, skips/conflicts, expected inputs, migration eligibility, validation operations, and the next required actions without taking a project mutation lock, running project scripts, or writing anything.

Only the public `update --check` orchestration persists preview receipts. Doctor, assessment, validation, and governance inspection call the pure planner/inspectors and cannot create or refresh receipts.

Use a dedicated user-state adapter, borrowing the injected platform/path/filesystem pattern from `src/telemetry/config.ts` without sharing its configuration or telemetry consent:

| Platform | User-local state base |
| --- | --- |
| Linux | Absolute `XDG_STATE_HOME`, otherwise the user's `.local/state` directory |
| macOS | The user's `Library/Application Support` directory |
| Windows | Absolute `LOCALAPPDATA`, otherwise the user's `AppData/Local` directory |

Under that base, resolve the explicitly named `liftoff/update-previews` directory and a project-keyed receipt. Resolve all paths with the native Node path module; reject a selected store that resolves within the target project or its repository, rather than silently making check mutate project bytes. Relative overrides, unsafe path types, symlink/junction escapes, and write failures produce explicit errors. Use atomic user-local replacement and restrictive creation permissions where supported.

Receipt schema 1 records the canonical project identity/root, CLI/renderer and target contract identities, supported operation variants, semantic plan fingerprints, input fingerprints, and issuance metadata. It contains no source-file bodies, environment values, credential material, or historical receipt payloads. Output discloses the native receipt location and states both facts: project bytes are unchanged, local preview metadata was written.

Receipts are disposable, user/machine-local, and not portable approval artifacts. A renamed/copied project or another worktree needs its own check. CI check and apply use the same materialized checkout and user-local storage; a different runner/workspace must generate and approve its own preview. No cross-machine receipt import is introduced.

**Alternative rejected:** writing a marker into `.liftoff` violates project-read-only preview. Making check entirely write-free cannot enforce a matching prior check across separate processes.

### D3. Fingerprint the effective plan, then recheck under the project lock

Use the existing canonical JSON/hash primitives for a schema-versioned semantic fingerprint. Bind:

- Canonical project boundary and applicable existing execution/repository identity.
- Source manifest/configuration, target CLI and packaged renderer/compatibility identities, selected migration lane, and effective normal/force mode.
- Exact source/destination paths, expected absence or content hash, relevant path type/mode, rendered managed-core bytes, provisioning inventory, and every explicitly authorized historical copy/retirement.
- State, plan, approval, evidence, and migration metadata used to classify the migration.
- Existing activation-input snapshots and the exact commands, working directories, protected inputs, and permitted outputs of any proposed revalidation.

The existing activation-input allowlist is not sufficient for update approval:
project scripts can live under repository-root `scripts`, `tests`, or custom
directories. Capture a separate retained-source inventory during preview,
including those files and existing generated outputs, and bind it to the
fingerprint and locked recheck. Project source is not inferred from a folder
being named `build` or `dist`. During execution, compare that same projected
post-update inventory before each validation command and around the bounded
read-only Git-metadata inspection; accept changes in an explicitly
declared command-specific output path only after that approved command ran.
All other source changes remain blockers and are preserved.

Project permission postconditions use the same requested-to-native mode mapping
as the transaction writer. Windows writable attributes must not be compared
directly with requested POSIX `0600` bits.

Do not include incidental display ordering, receipt issuance time, or future execution timestamps in the semantic fingerprint. Runtime timestamps remain freshly validated event data, not permission to change operations. Derive snapshot identifiers from the canonical historical inventory and its raw-byte hashes, avoiding a circular dependency between the plan fingerprint and its history paths.

Never execute operations supplied by a cached receipt. Rebuild the effective plan from current project inputs and trusted packaged declarations, then compare its fingerprint to the receipt and explicit approval. After approval, acquire the existing cooperating project lock and recheck all input/destination preconditions before the first project write. Changes during prompting or between preflight and locking invalidate approval.

After explicit consent, persist a separate user-local transaction approval bound to the effective plan and the exact finalized before/target mutation digest. Check never writes this approval, and the preview receipt never becomes approval. Durable recovery must validate the external binding before trusting its project-local journal; a fabricated journal alone cannot authorize restoration of files.

A blocked effective variant cannot receive an apply-eligible receipt. A check can expose an eligible forced variant separately from a normal variant blocked by required owned-core conflicts, but neither variant can bypass incompatibility or unowned collisions. An older receipt never overrides current incompatibility. After commit, source/precondition changes make the old receipt unusable; mark or remove only its exact local entry when possible. Failure to clean an already-obsolete external receipt is reported without rolling back a committed project transaction.

**Alternative rejected:** a boolean "checked before" flag or matching only CLI versions admits different files, targets, and force operations under a stale review.

### D4. Keep migration eligibility separate from execution compatibility

Add an explicit packaged migration-lane declaration for the exact known v1 tuple to the installed v2 target. It names the historical schema reader, supported record inventories, target identity, history format, and revalidation strategy. Use existing identity constants and explicit lane lookup; neither numeric version ordering nor a project-edited compatibility file can authorize a lane.

The historical reader validates v1 according to its own contract and returns diagnostic data and an explicit file inventory. It does not call the current v2 validator with relabeled fields. Malformed/unversioned files, unknown/mixed/future tuples, escaping paths, incompatible active spec ownership, or missing required historical records block migration with specific reasons. Known current revalidation gaps, such as unavailable tools or unsupported producers, are separately disclosed; they never become a claim of successful validation.

Keep the v1 execution guard intact. The new lane authorizes creation of a linked v2 successor, not direct execution of v1 or automatic preservation of v1 terminal phase states. Existing current v2 projects require no migration snapshot merely because their managed core changes.

**Alternative rejected:** adding a v1 tuple to the executable compatibility map or to the existing same-schema mapping list would erase the trust boundary.

### D5. Preserve history through an exact, durable in-project inventory

Register new artifact identities/path-part constants for:

- `governance/history/<snapshot-id>/index.json`: immutable source identity, original paths, raw-byte digests, recorded modes, and exact stored-copy locations.
- `governance/history/<snapshot-id>/files/<original-path-parts>`: original bytes of the reviewed source manifest/activation metadata and inventoried v1 state, evidence, plans, and approvals.
- `governance/migration-state.json`: schema-1 active migration journal linking the source snapshot/index digest, source and target identities, approved effective plan, new local activation identity, transaction outcome, and revalidation progress.

These are migration records, not a new template lifecycle or ordinary managed-core entries. The journal is mutable only through separately authorized migration/revalidation operations; completed history copies and their index are never rewritten or garbage-collected by update or force. The link belongs in the journal rather than a new required field in manifest v7 or v2 state/evidence.

Build the source inventory with the explicit v1 record-layout registry and validated references. Turn every selected dynamic record into an exact path entry in the reviewed plan. Preserve recognized unreferenced historical records only when explicitly inventoried. Unknown or unversioned records that prevent safe separation of active and historical collections are blockers, not candidates for blanket copying/deletion by filename pattern.

Original active v1 state is replaced only after its snapshot is complete and verified. Old active plan/approval/evidence paths are retired only by exact inventory lookup, after byte-equal snapshot copies are verified. This prevents the active v2 reader from encountering v1 receipts while preserving all original bytes under their original relative paths in history. Unknown neighboring files remain untouched.

Existing differing history destinations are conflicts even under force. A byte-identical completed snapshot can be reused after full index validation, making retries idempotent. History is portable with the project, but its native root and every path segment remain subject to the normal boundary checks. Do not change Git configuration, ignore rules, or commits automatically.

**Alternative rejected:** using the external receipt store for history loses the durable audit trail when a machine changes or disposable state is cleaned.

### D6. Commit the successor as one guarded local transaction

Reuse or narrowly extend `adapters/filesystem/project-transaction.ts` and the cooperating lock. Preflight the entire selected write set before mutation, including required target managed-core assets, history destinations, the active v2 state, manifest, and migration journal. Required target core conflicts cannot be skipped while claiming the target activation is usable.

Separate three mutation authorities in the plan and authorization checks:

1. Exact managed-core reconciliation and reviewed forced core changes.
2. Existing configuration-authorized create-only component provisioning.
3. The explicitly approved activation migration/history write set.

No authority inherits another's permissions. In particular, the migration lane does not authorize application, dependency, framework, seed, or infrastructure edits. Newly requested component provisioning is withheld during v1 migration and exposed as follow-up work requiring a fresh post-migration preview; this avoids turning history migration into unrelated project expansion.

Write and verify the immutable historical copies before retiring their active originals. Use a durable transaction journal containing the exact original/target hashes and recovery state so process interruption can be distinguished from an ordinary unmigrated project. Switch the active manifest identity, create strict v2 state, and commit `migration-state.json` consistently under the same transaction protocol.

The v2 state starts with unresolved/pending phases and explicit unknown applicability wherever current proof is absent. Establish a new stable local anchor through this explicitly approved local operation; historical remote/resource identifiers are hints, never verified bindings or provider-read authority. The journal records the source/successor relationship.

Transaction failure restores only attributable unchanged writes and reports unresolved recovery paths. No revalidation or provider operation runs before local commit. A crash-recovery journal authorizes only bounded recovery of that already approved transaction, not continuation of new update operations without review.

Check reports an interrupted transaction without repairing it or issuing a new apply-eligible receipt. Plain update may finish bounded recovery using the durable original approval, then stops and requests a new check before any fresh work. This is recovery of previously authorized writes, not a bypass that permits an unreviewed plan.

**Alternative rejected:** independent writes to the manifest, state, and history can strand the project with no trustworthy original or a falsely current manifest.

### D7. Revalidate after commit without laundering historical proof

Post-commit revalidation is an explicit operation set in the approved plan. Reuse current local input snapshots, reviewed transition plans, phase validators, and evidence producers. Re-observe existing local seed/baseline/archive artifacts and preserve an already completed archive instead of recreating it. New v2 receipts bind current inputs, the actual reviewed validation operation, its output, and the evidence body.

Human check and approval output must expose every known per-phase prerequisite
blocker, not hide it inside optional JSON. A supported source can still be
migrated with explicitly disclosed revalidation gaps; explain before approval
that committing v2 will not clear those gaps.

Materialize fresh v2 transition plans against the committed successor, not pre-migration state hashes. Before each operation, confirm that it is one of the exact approved local operations and that its protected inputs and target contract still match. New operations or changed inputs require a new preview/approval. Keep operational journal timestamps and retained history outside semantic phase-input digests where they are not actual validation inputs, so recording progress does not invalidate its own receipt; history integrity remains independently validated through the declared index.

Do not copy old `verified`, `approved`, `inapplicable`, or disposal claims into current success. Old approvals remain history; approval of the update plan authorizes only its named local writes and validation operations, not a future governance gate. Missing evidence or unsupported producers leave the dependent phase blocked. Observing a resource today cannot retroactively prove that an earlier approval or process step occurred.

Automatic update revalidation is local-only. Stop before operations that require framework/seed changes, dependency installation, commits/pushes, live provider reads, credential enrollment, or remote mutation. Report the applicable separately reviewed governance transition. Existing resources are not reprovisioned; any future independently approved provider observation must establish its scope without trusting v1 resource IDs as authority.

Local project validation commands can execute project-controlled code and are not a sandbox. Disclose exact commands and known output effects in the preview. Fingerprint relevant scripts/inputs; use already available tools without implicit installs. If validation unexpectedly changes protected inputs, preserve those edits, stop, and do not publish successful stale evidence or roll them back as if Liftoff owned them.

**Alternative rejected:** accepting old checkboxes, hashing old payloads into new headers, rerunning initial provisioning, or using assessment reports as execution receipts creates false proof.

### D8. Keep committed v2 resumable when validation fails

The local commit and readiness have distinct outcomes. The journal records `pending`, `running`, `blocked`, or `complete` revalidation with exact phase results, evidence references, and next actions. On post-commit failure or interruption, retain v2 and its history link; do not reactivate v1.

`update --check` recognizes a committed incomplete migration and previews only the remaining allowed work against current inputs. An approved retry does not create a second successor or rewrite the completed snapshot. It rechecks interrupted/running operations rather than counting them as complete and reuses only fresh valid v2 proof.

Existing `governance status`, `resume`, and `verify` stay read-only. They expose the same journal-backed blocker and next incomplete phase. The approved update coordinator can execute its finite local revalidation set using the shared guarded transition kernel; inspection commands do not inherit that capability. Resume never means an unbounded loop through future live or authority-gated phases.

Exit behavior:

| Outcome | Exit |
| --- | --- |
| Check finds no update/revalidation work, or approved apply completes its scope | 0 |
| Check finds actionable drift/migration/revalidation, or local migration committed but revalidation remains blocked | 2 |
| Invalid usage, missing/stale preview, approval required/declined, unsupported identity, storage/transaction/recovery failure | 1 |

Existing managed-core conflicts skipped by a normal plan remain explicitly reported; completed approved scope is not a claim that all conflicts or governance phases are complete.

**Alternative rejected:** rolling back a committed v2 activation after a failed check loses valid progress and can misleadingly reactivate old authorization.

### D9. Make history-aware interpretation shared, not permissive

Use one validated migration/history inspection result across update, manifest/activation validation, doctor, status/readiness, verify, and assessment. A committed journal must agree with its snapshot index, target identity, and active successor anchor. Do not require current mutable v2 bytes to equal their initial creation hash after legitimate progress.

Historical records are read only from the exact validated inventory/namespace and never selected as current proof or read scope. A valid retained snapshot must not make a migrated current activation fail just because its records say v1. A malformed current record, contradictory current evidence, unsafe history path, or broken declared history link remains an error/blocker; do not fall back to a historical record or a fresh not-started view.

Doctor directs managed drift and migration eligibility to `liftoff update --check`, never requires JSON, and never issues a receipt itself. Assessment remains read-only even when it can recommend this workflow. Distinguish "local migration committed", "revalidation blocked", "next phase available", and "governance complete" in both human and machine output.

**Alternative rejected:** teaching only update to ignore v1 leaves doctor/verify blocked forever or encourages overly permissive readers.

### D10. Version the new contracts without retagging unrelated proof

Use schema 1 for preview receipts, history indexes, migration journals, and exact-plan update approvals. Update JSON advances from 2 to 3, with `scope: "project-update"` and separately named managed-core, provisioning, activation-migration, and revalidation sections; include `status`, `reasonCode`, selected/available plan fingerprints, receipt disposition, source/target identities, and distinct commit/readiness outcomes.

Compatibility metadata advances from 2 to 3 because its v1 migration meaning changes. Read supported schema-2 metadata for diagnosis/update input, but only the packaged schema-3 declaration can select an explicit migration lane. Historical v1 remains diagnostic-only for execution; the new declaration separately permits an approved history-preserving successor.

Retain manifest artifact 7, policy 6, activation contract/state/evidence/approval schema 2, and the current execution graph semantics. Link migration history through the sidecar journal rather than altering these strict serialized shapes. Use the installed identity and existing constants, not a copied or invented future graph hash. Cover compatibility-only managed asset changes and already-current v2 projects explicitly. If implementation requires a phase/proof semantic change, revise the affected contract and artifacts before implementing it rather than hiding a change under the existing vector.

This is a breaking update-CLI/report contract, not a patch-only promise. Publishing and choosing the release SemVer remain outside this implementation change. Downgrading the CLI is not a migration rollback procedure.

**Alternative rejected:** extending schema-2 reports or retagging all existing activation history makes compatibility ambiguous.

### D11. Keep integration boundaries narrow

- `application/update/`: pure effective-plan construction, receipt/approval orchestration, shared reports, and bounded apply/revalidation coordination.
- `cli/args/` and `cli/commands/`: explicit `approve-plan` definitions, combinations, help, and injected interaction/output behavior.
- `adapters/filesystem/`: platform-correct user-state storage, durable exact-path transaction recovery, and immutable snapshot operations.
- `domain/governance/` and `governance-activation/`: exact historical schemas/lane definitions, successor construction, journal/history validation, and shared proof selection.
- Diagnosis/assessment consumers: consume the shared read-only result without acquiring mutation ports.

Keep serialization/version constants and artifact path identities in explicit shared declarations. Use dependency injection already present in execution contexts and filesystem adapters; do not add test-only environment bypasses or new package dependencies merely to implement consent.

## Risks / Trade-offs

- **External writes during check** -> Disclose the receipt path and distinguish project-read-only from entirely write-free; refuse unsafe storage and keep all other diagnostics write-free.
- **Automation behavior changes** -> Document schema 3, exact-plan approval, exit 2 after committed partial migration, and same-workspace receipt requirements; never interpret JSON as consent.
- **Stale approval or concurrent edits** -> Recompute from authoritative inputs and recheck under the existing project lock; do not execute cached operations.
- **Incomplete historical data or missing current producers** -> Strict historical readers, explicit eligibility blockers, fresh proof, and honest blocked v2 status rather than a success-shaped fallback.
- **History contains sensitive operational metadata** -> Preserve only the exact reviewed inventory, use restrictive permissions where supported, keep receipts payload-free, and never auto-commit/upload history.
- **History can be edited by the project owner** -> Immutability is a tool-enforced convention with digest validation, not an adversarial filesystem or signature claim; corruption is surfaced.
- **Process death between filesystem operations** -> Durable bounded recovery journal, verified copies before retirement, and no revalidation until a consistent local commit.
- **Windows paths, case behavior, and replacement semantics** -> Native path APIs, exact path-part validation, case-collision checks, real project boundaries, same-volume atomic replacement where supported, and Windows CI.
- **Validation commands execute project code** -> Preview and approve commands, protect input freshness, avoid installs, preserve unexpected edits, and do not claim sandbox isolation.
- **Readiness differs from migration completion** -> Separate persistent outcomes and summaries; preserve completed migration when revalidation or later governance work is blocked.

## Migration Plan

1. Introduce pure planning, versioned receipt/report contracts, and exact-plan consent first, retaining the current ownership and current-v2 behavior as regression fixtures.
2. Add strict v1 readers and the packaged explicit migration lane, plus immutable history and durable local transaction recovery.
3. Wire post-commit local revalidation and the shared history-aware inspection result through every consumer before advertising migration as available.
4. Replace current diagnostic-only dead-end guidance with the human-first preview path; document the breaking update/report behavior and the independent provider-action boundary.
5. Exercise the existing test/build/package lanes and macOS/Linux/Windows CI with real historical-shaped fixtures, current v2 projects, force variants, stale receipts, process interruption, partial revalidation, and unsupported identities.
6. Ship only after artifact and implementation coherence is demonstrated. No commit, push, deployment, registry publication, or user-project migration is part of artifact creation.

Before local commit, transaction recovery restores only attributable unchanged writes. After commit, repair and resume the linked v2 activation; do not automatically roll back to v1 or delete history. A later deliberate historical restoration would be a separate reviewed recovery operation, not `--force`.
