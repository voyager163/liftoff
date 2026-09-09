## 1. Establish contract fixtures and shared types

- [x] 1.1 Add complete, credential-free historical v1 fixtures derived from the actual pre-v2 contracts, covering state, evidence, plans, approvals, source manifest, and already archived local work; verify they preserve original bytes and are distinguishable from current-v2 fixtures and ad hoc JSON.
- [x] 1.2 Define update report schema 3, compatibility metadata schema 3, and schema-1 preview/approval/history/journal contracts with explicit identifiers and path-part constants; verify strict valid/unknown/mixed-version cases and unchanged manifest-v7/current-v2 execution identities in contract tests.
- [x] 1.3 Extract pure effective-plan construction from `src/application/update/use-case.ts`, reusing existing reconciliation, provisioning, and migration inspectors; verify existing core classifications, provenance, legacy identity guards, and no-write behavior with the update suites.
- [x] 1.4 Add narrowly injected clock, user-state filesystem, and approval interaction dependencies at the existing application/CLI composition boundaries; verify TypeScript builds and import-boundary tests pass without environment-based consent bypasses or new dependencies.

## 2. Implement semantic fingerprints and external previews

- [x] 2.1 Implement canonical effective-plan fingerprints binding project boundary, target/renderer, mode, exact writes, expected absence/content/modes, historical inventory, and validation operations/inputs; verify deterministic ordering and receipt-time independence plus invalidation for each changed bound input.
- [x] 2.2 Implement user-local preview storage using the design's Linux/macOS/Windows locations and native path handling; verify absolute-path rules, spaces, case collisions, links/junctions, permissions, atomic replacement, and refusal to store within the project or repository.
- [x] 2.3 Wire only public `update --check` to persist/disclose eligible preview receipts after pure planning; verify human and JSON check leave project bytes unchanged, storage failures are explicit, and incompatible variants receive no apply-eligible receipt.
- [x] 2.4 Implement receipt loading and fresh-plan matching without executing cached operations; verify wrong project/worktree, copied/moved roots, stale target, edited inputs, tampered receipt data, and obsolete post-commit receipts cannot authorize writes.
- [x] 2.5 Produce separately fingerprinted normal/forced variants while preserving invalid `--check --force` syntax, no-op behavior, and deferred provisioning during activation migration; verify normal approval cannot authorize forced core replacement or withheld component creation.

## 3. Enforce approval and versioned CLI outcomes

- [x] 3.1 Add strict update-only `--approve-plan <fingerprint>` parsing in `src/cli/args/` and routing in `src/cli/commands/update.ts`; verify missing/malformed/abbreviated/conflicting values, approval-plus-check, removed `--apply`, and unknown command flags fail before receipt or project writes.
- [x] 3.2 Implement matching-preview interactive approval with a negative default through injected command streams; verify accept, decline, cancellation, absent input, and JSON-with-stderr-prompt cases without polluting JSON stdout.
- [x] 3.3 Require matching preview plus exact fingerprint approval for noninteractive writes, then recheck all plan preconditions after acquiring the project lock; verify missing/stale receipts, input changes during prompting, force, JSON, and generic consent cannot bypass approval.
- [x] 3.4 Render the human-first check/apply lifecycle and schema-3 reports with distinct receipt, approval, core, provisioning, commit, and revalidation outcomes; verify byte-pure JSON, native-path remedies, and all documented 0/1/2 exit classifications in CLI/presentation cases.

## 4. Add exact historical readers and snapshot planning

- [x] 4.1 Implement strict source-v1 readers and the explicit packaged v1-to-v2 successor lane in the governance domain, retaining direct-v1 execution rejection; verify real historical fixtures are eligible while unknown, mixed, future, malformed, unversioned, and missing-required-record cases remain blocked.
- [x] 4.2 Build the exact historical inventory from registered layouts and validated references, including source metadata and explicitly inventoried recognized unreferenced records; verify unknown neighbors remain untouched and records that prevent safe active/history separation cause precise blockers rather than pattern-based deletion.
- [x] 4.3 Implement immutable history index/copy planning and deterministic snapshot identity under the registered in-project governance history paths; verify raw-byte/line-ending preservation, source modes recorded, identical snapshot reuse, and differing/escaping/case-colliding destinations rejected even under force.
- [x] 4.4 Implement the strict migration journal and linked initial-v2 successor construction without new required manifest-v7 fields; verify pending/unresolved phases, unknown applicability, stable local anchoring, and no inherited historical approval, verified remote binding, or terminal success.
- [x] 4.5 Integrate migration eligibility, required target-core prerequisites, active spec ownership, and known revalidation gaps into the shared preview; verify current-v2 core-only updates create no history and blocked target prerequisites cannot produce a falsely usable successor.

## 5. Commit and recover the bounded local migration

- [x] 5.1 Extend update mutation authorization to distinguish exact managed-core, create-only provisioning, and approved migration/history lanes; verify application/configuration/framework/seed/infrastructure files, unknown legacy artifacts, and unowned collisions remain outside replacement authority.
- [x] 5.2 Add verified historical-copy staging before exact active-record retirement using the existing filesystem transaction/lock infrastructure; verify every retired source has a byte-equal indexed snapshot and failed copy/index verification leaves active v1 intact.
- [x] 5.3 Commit required target core, active manifest identity, strict successor state, and linked migration journal through one guarded local transaction; verify project generation provenance is unchanged and deferred frontend/environment intent is not falsely recorded as already provisioned.
- [x] 5.4 Add durable exact-write-set recovery metadata and failure handling for replacement, retirement, manifest/journal writes, locks, and cleanup; verify injected failures name the operation, preserve supported modes, clean only exact temporaries, and never overwrite concurrent edits during rollback.
- [x] 5.5 Exercise actual process interruption at snapshot, active-record, manifest, and commit boundaries with existing subprocess/test infrastructure; verify check remains read-only, apply performs only bounded previously approved recovery, and fresh work requires a new preview afterward.
- [x] 5.6 Consume or mark the exact external preview obsolete after commit without treating cleanup as transaction rollback; verify cleanup failure is visible, committed history/state survive, and stale source preconditions prevent replay or duplicate successors.

## 6. Revalidate and resume current local work

- [x] 6.1 Materialize fresh v2 input snapshots and reviewed transition plans after successor commit, constrained to the exact approved local operation set; verify pre-migration state hashes are not reused and journal timestamps/history preservation do not self-invalidate legitimate current proof.
- [x] 6.2 Reuse or narrowly adapt supported local seed/baseline/archive validators and evidence producers for existing OpenSpec and Spec Kit artifacts; verify realistic migrated fixtures receive fresh body/current-input-bound evidence without regenerating source, re-archiving completed work, or copying v1 verified flags.
- [x] 6.3 Disclose and execute only approved local validation commands with already available tools and protected-input checks; verify no implicit installs, project-template writes, provider calls, commits, pushes, or credential enrollment occur and unexpected script edits are preserved and reported.
- [x] 6.4 Persist separate local-commit and revalidation progress outcomes; verify failed/unavailable/interrupted post-commit operations retain linked blocked/resumable v2, preserve all v1 history, and return the documented partial result instead of restoring v1.
- [x] 6.5 Implement fresh-check/approval retry of remaining revalidation using the same successor and immutable snapshot; verify no duplicated migration, running-state false success, stale evidence reuse, or loss of genuinely verified v2 progress.
- [x] 6.6 Identify the first genuinely incomplete supported phase and stop at changed inputs, unsupported capabilities, remote access, or independent authority gates; verify future old approvals/resource IDs and assessment reports never authorize that continuation.

## 7. Align every read-only consumer

- [x] 7.1 Add a shared validated history/journal/current-proof inspection result in the governance readers; verify valid preserved v1 is informational while malformed current evidence, contradictory current records, unsafe paths, and broken declared history links remain blockers.
- [x] 7.2 Wire doctor to pure update classification and distinct migration/revalidation/history findings with `liftoff update --check` remedies; verify existing freshness/runtime behavior remains intact and doctor creates no receipt or other project/environment state.
- [x] 7.3 Wire setup/status, readiness, resume, and verify to the shared successor/progress view while keeping inspection read-only; verify consumers agree on completed local migration, incomplete governance, retryable blockers, and next actions without advancing phases.
- [x] 7.4 Wire assessment to the same validated active/history separation without granting mutation or provider scope; verify local/no-network behavior, live-mode boundaries, ordinary-Git fallback guards, telemetry exclusion, and current-versus-historical proof cases remain intact.

## 8. Update documentation and integration fixtures

- [x] 8.1 Update root/packaged/generated guidance, CLI help, and managed setup instructions to show check-first approval, external receipt disclosure, exact-plan CI usage, durable in-project history, and blocked/resumable v2 recovery; verify documentation and help snapshots contain no prompt-free apply promise or nonexistent migration command.
- [x] 8.2 Update compatibility/version examples, report contracts, authority-boundary explanations, and generated managed-asset fixtures without retagging unrelated current-v2 proof; verify contract/documentation tests and representative double-render checks agree with the installed identity and schema declarations.
- [x] 8.3 Adapt existing update/CLI integration helpers to explicitly obtain and approve previews in isolated user-state storage outside target repositories, retaining negative consent cases; verify helpers do not bypass production gates, leak metadata into user configuration/telemetry, or mutate the developer's actual home state.

## 9. Complete cross-surface acceptance

- [x] 9.1 Run the smallest combined existing Vitest selectors covering the modified update, command/presentation, governance migration/v2, manifest/ownership, doctor, assessment, and filesystem behavior, plus `npm run build`; verify the full preview-to-approved-migration-to-blocked-repair-to-resume journey and all negative guards pass.
- [x] 9.2 Use `.github/workflows/ci.yml` for macOS, Linux, and Windows acceptance, including the new preview/history/migration/recovery cases in explicit Windows boundary coverage where needed; verify native paths, case/link handling, process interruption, and the existing package-check/package-smoke lanes pass without adding a test framework or publishing. Completed on code commit `5600f8888acd54fc23a391bfd647da2e29193b85`: [CI run 34365630496](https://github.com/voyager163/liftoff/actions/runs/34365630496) passed all six jobs, including Ubuntu, macOS, Windows, both Node-template compatibility lanes, and telemetry. No release or deployment was performed.
- [x] 9.3 Reconcile implementation, proposal, design, and all nine delta capabilities; verify `openspec validate add-reviewed-project-updates --strict`, the exact six-step user journey, no changes to out-of-scope version policies or production templates, and documentation that distinguishes migration completion from governance readiness.
