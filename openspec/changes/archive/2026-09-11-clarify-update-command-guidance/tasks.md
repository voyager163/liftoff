## 1. Guidance Context and Pure Formatting

- [x] 1.1 Implement invocation-scoped guidance resolution at the update application boundary using existing project discovery and canonical filesystem paths. Distinguish the same implicit project, the exact project-root directory, and unestablished context without changing the selected target. Verify root, subdirectory, redundant explicit target, different project, inner/outer project, and optional-discovery failure cases in the existing update/discovery suites; construct fixture paths with the native path module.
- [x] 1.2 Extend `formatUpdateCommand` with optional trusted presentation context while retaining explicit targets for default callers and JSON. Verify normal, check, and force formatting in `tests/update-output.test.ts`, including POSIX, Windows drive and UNC paths, spaces, apostrophes, shell metacharacters, and the unchanged caller-free default.
- [x] 1.3 Reuse the shell adapter's command sequencing so `formatUpdateValidationCommands` can omit the directory wrapper only at the canonical project root. Verify root versus subdirectory/external output, literal path quoting, failed-directory-change gating, and validate-before-doctor success gating with focused cases in `tests/update-output.test.ts`; preserve existing wrapper output for unrelated callers.

## 2. Consistent Follow-ups and Preview Diagnostics

- [x] 2.1 Thread the resolved human guidance context through `use-case.ts` and `output.ts` for preview, normal/force suggestions, approval reminders, direct retry/recovery instructions, and completion. Identify the selected project separately when commands are shortened. Verify human output contains no redundant target at the project root while external-target output retains the correct absolute path.
- [x] 2.2 Separate factual details from command follow-up intent in affected update errors and migration/revalidation results, including `inspection.ts`, `migration-runtime.ts`, `revalidation-plan.ts`, and `revalidation.ts`. Preserve explicitly targeted standalone and JSON guidance without adding presentation state to receipts or plans. Verify the audited call sites through existing inspection, migration/revalidation, and recovery cases, and confirm diagnosis consumers still receive usable standalone remedies.
- [x] 2.3 Replace the generic preview-storage remedy with reason-specific handling of all six existing preview error codes. Update eager command fragments in `preview.ts` and filesystem preview errors without parsing or replacing formatted strings. Verify error body and remedy for missing, mismatched, invalid, unsupported, busy, and storage-failure previews in the existing preview/update suites, including unchanged reason codes, preserved fault details, and accurate committed-state wording.

## 3. End-to-End Regression Coverage

- [x] 3.1 Add raw command integration coverage for the reported sequence: plain update with no saved preview, implicit check, unapproved apply, then explicitly approved apply. Run it from the project root and a subdirectory with a shared isolated receipt store; do not use helpers that insert preview or approval automatically. Verify suggested commands, separate check/apply steps, exit codes 1/2/1/0 for the actionable fixture, unchanged project bytes before approval, and completion guidance after apply.
- [x] 3.2 Cover implicit/explicit check-and-apply permutations, positional and flag targets from another project, nested project boundaries, accepted canonical path aliases, and unestablished caller context. Verify identical receipt keys and effective-plan fingerprints for the same target and inputs, no writes to the caller's unrelated project, and unchanged JSON schema-3 fields and explicitly targeted remedies.

## 4. Documentation and Integrated Verification

- [x] 4.1 Update the update-mode and preview-storage sections of `docs/cli-reference.md` and the relevant update guidance in `docs/troubleshooting.md`. Explain current-project discovery, context-aware human suggestions, explicit external/JSON targets, missing preview versus actual storage failure, and check's actionable exit code 2. Verify the examples match the implemented output and do not chain check and apply with `&&`.
- [x] 4.2 Run the combined affected suites with `npm test -- tests/update-output.test.ts tests/update.test.ts tests/reviewed-update.test.ts tests/update-preview.test.ts tests/update-inspection.test.ts tests/migration-revalidation.test.ts tests/reviewed-update-transaction.test.ts tests/project-discovery.test.ts tests/doctor.test.ts`, followed by `npm run build`. Verify the delta scenarios and existing preview, approval, wrong-target, recovery, and diagnosis behavior without adding dependencies or broadening into unrelated fixes.
- [x] 4.3 Verify the path and shell regressions in the existing `windows-latest` CI job in `.github/workflows/ci.yml`, alongside the existing macOS/Linux matrix. Ensure the new scenarios are included in that job's executed suites and record the native Windows result before completing this task; local PowerShell string assertions alone do not satisfy native Windows verification.

### Native CI evidence

Completed on 2026-09-11 against commit `fc535f08c120a94fbb4cc940d9f93aa1b942f717`:
[CI run 34547872851](https://github.com/voyager163/liftoff/actions/runs/34547872851)
passed all six jobs. The native
[Windows job](https://github.com/voyager163/liftoff/actions/runs/34547872851/job/103104290273)
passed the dedicated project/packaging boundary coverage, full package check,
and package smoke test. Its existing suites include the new project-discovery,
command-output, receipt/approval, nested-target, and symlink/junction scenarios.
The macOS and Linux matrix jobs also passed.

The initial [run 34546540005](https://github.com/voyager163/liftoff/actions/runs/34546540005)
passed Windows boundary coverage but hit the 30-second limit in the historical
handoff migration scenario during the full suite. That single case now uses
the existing 90-second Windows migration-test allowance; its assertions,
non-Windows timeout, and application behavior are unchanged.
