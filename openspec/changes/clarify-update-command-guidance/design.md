## Context

See `proposal.md` for the motivation and `specs/liftoff-project-update/spec.md` for the observable contract.

Project discovery already works: `updateProject` uses `findProjectRoot(context.cwd)` for an implicit target, and inspection resolves the selected project to its canonical filesystem path. Receipt keys and reviewed plans bind that canonical target, not the spelling of a suggested command.

Presentation currently loses the distinction between the invocation directory and the selected target:

- `formatUpdateCommand` always adds `--project` and receives no invocation context.
- `renderUpdatePreview` uses that formatter for normal and force follow-ups.
- `formatUpdateValidationCommands` always wraps validation in a directory change.
- Update orchestration, inspection, preview errors, and migration/revalidation diagnostics embed formatted commands at different layers.
- The update catch block gives every `UpdatePreviewError` the same storage-repair remedy.

The existing shell adapter handles POSIX and PowerShell literal quoting and conditional command execution. Existing tests already cover explicitly selected projects, native paths, preview gating, and transaction recovery.

## Goals / Non-Goals

**Goals:**

- Keep invocation-aware presentation separate from target selection and durable update identity.
- Use one targeting policy across update's human follow-up surfaces.
- Keep caller-free helpers and JSON guidance explicitly targeted.
- Improve preview diagnostics by using typed reasons rather than rewriting strings.

**Non-Goals:**

- No changes to project discovery, receipt schemas or storage, fingerprints, approval, recovery authority, or update eligibility.
- No automatic check, apply, validation, directory change, or receipt repair.
- No changes to doctor prerequisites, supported versions, or generated project contents.
- No redesign of unrelated CLI commands, shell support, or the terminal presentation framework.

## Decisions

### 1. Resolve a short-lived guidance context at the application boundary

Keep the invocation directory from `ExecutionContext` and the authoritative project root obtained by existing discovery and inspection. Establish whether ordinary discovery from that directory selects the same canonical root, and separately whether the invocation directory itself is that root.

Reuse the discovery result for implicit invocations. For explicit invocations, use the existing discovery and filesystem canonicalization mechanisms to establish the caller's implicit project when needed. Do not infer equivalence from a common path prefix, repository membership, an identical basename, or unconditional case folding.

Represent an unestablished optional guidance context explicitly and retain targeted commands in that case. Expected typed failures while examining only the caller's optional shortening context must not redirect a valid explicit operation or erase its primary result. Errors resolving the selected project remain real command errors; unexpected failures must not be swallowed by a broad catch.

The resolved presentation context lasts only for this invocation. It is not added to the plan, receipt, manifest, approval fingerprint, or recovery journal. Do not call `process.chdir`.

**Alternative considered:** Compare only `cwd` with the requested path. Rejected because relative paths, accepted native aliases, subdirectories, and nested projects make textual equality insufficient.

### 2. Keep command formatting pure and explicitly targeted by default

Extend the update guidance helpers with optional presentation context while preserving the current explicit-target default for existing caller-free consumers. The application determines context; formatters perform no filesystem work.

| Consumer and context | Update command | Validation sequence |
| --- | --- | --- |
| Human output at the selected project root | Omit `--project` | Omit the directory change |
| Human output in a subdirectory discovering the same project | Omit `--project` | Keep the change to the project root |
| Human output targeting a different project | Retain absolute `--project` | Keep the change to the project root |
| Unknown caller context or JSON remedy | Retain absolute `--project` | Retain an explicit execution directory when applicable |

Omission applies even if the caller supplied a redundant explicit target. It does not apply when an inner project's directory is used to explicitly target its outer project.

Continue using `formatShellCommand` and `commandShellForPlatform` for literal arguments. Show the selected project as a separate human report field or diagnostic fact whenever the command is shortened. JSON retains its existing canonical `projectRoot` field without additional schema fields.

**Alternative considered:** Always omit the target. Rejected because commands emitted while operating on another project would silently select the caller's project.

**Alternative considered:** Keep all output absolute and add explanatory text. Safe but retains the unnecessary command complexity that prompted this change.

### 3. Render follow-up intent at the output boundary

Thread the guidance context through preview output, approval reminders, direct retry/recovery messages, and completion in `use-case.ts` and `output.ts`.

Update-specific errors and nested migration/revalidation results that currently embed commands must participate in the same policy. Separate factual diagnostic details from follow-up intent rather than attempting to remove `--project` from an already formatted string.

Use existing typed reason codes and small internal follow-up metadata where a lower layer cannot know the caller's context. Non-command remediation details remain intact. Retain explicit standalone guidance for caller-free consumers, including diagnosis code that reuses update inspection. At the CLI output boundary, render the follow-up with human context or the explicit JSON default.

The affected producers include `preview.ts`, filesystem preview storage, `inspection.ts`, `migration-runtime.ts`, `revalidation-plan.ts`, and `revalidation.ts`, in addition to orchestration. Audit their existing update-command call sites as a bounded set; do not generalize this into a repository-wide error framework.

**Alternative considered:** Add the working directory to receipt validation and storage APIs solely to format messages. Rejected because presentation context would leak into project-bound safety layers.

**Alternative considered:** Replace path fragments or formatted command strings in the catch block. Rejected because shell quoting and similar path names make text rewriting brittle and unsafe.

### 4. Select preview remedies by their existing error codes

Use an explicit mapping or exhaustive switch over `UpdatePreviewErrorCode` at the presentation boundary. Preserve the original factual details and cause; do not infer the error kind from message text.

| Reason | Guidance |
| --- | --- |
| `preview-missing` | No saved preview was found for this project. Run check, review it, then apply with explicit approval. Do not suggest storage repair or claim the user never ran check. |
| `preview-mismatch` | The saved preview no longer matches the current plan. Run a fresh check and approve the matching plan. |
| `preview-storage` | Preserve the failed operation and path; repair that specific storage problem before retrying check. |
| `preview-invalid` | Preserve the validation or parsing failure and give condition-specific repair guidance before a new check. |
| `preview-unsupported` | Preserve the unsupported schema or format explanation and its compatibility remedy. |
| `preview-busy` | Preserve the concurrent-access explanation and safe retry guidance; do not suggest deleting a lock or receipt. |

Remove duplicated eager command fragments from the user-facing preview diagnostic path so a short remedy is not contradicted by a longer command in the error body. Preserve receipt-location details where relevant without implying that a missing file proves a storage malfunction.

Keep the existing committed-state qualification when reporting that no new project update occurred. These wording changes must never conceal a committed transaction or alter recovery behavior.

**Alternative considered:** Only change the generic catch message. Rejected because lower-level messages would still embed redundant targets and different preview failures would remain conflated.

### 5. Reuse shell sequencing without forcing a directory change

Extract the existing command-sequence formatting from `formatShellDirectoryCommands` into a shared pure helper, or an equivalent narrow reusable interface, so the same validation commands can be rendered with or without the wrapper.

Preserve `&&` behavior on POSIX and the existing `$?`-guarded PowerShell sequence. A failed directory change must prevent validation; a failed validation must prevent doctor. The original directory-wrapper helper's default output remains unchanged for unrelated callers.

Only the completion wrapper is removed when already at the project root. From a subdirectory, retain the wrapper to preserve the existing explicit execution directory rather than expanding this change into a validation-launch policy change.

Check and apply are separate instructions, not a success-only chain: actionable check intentionally exits 2. Printing guidance does not execute any command.

### 6. Cover the reported sequence without hiding the preview gate

Use the existing Vitest suites and isolated fixture homes. Add raw command integration cases that do not automatically inject preview or approval, since positive update helpers currently do that.

Cover the sequence of missing preview, implicit check, unapproved apply, and approved apply while asserting the exact suggested commands and unchanged target. Include explicit/implicit permutations and nested invocation directories with the same receipt store to prove that presentation does not change fingerprints.

Retain explicit-target regression cases when the caller is in another project. Cover completion at the root and from another directory, each preview error code, and recovery/revalidation follow-up text. Keep existing JSON schema and exact-plan checks.

Construct fixture paths through the native path module. Extend the existing POSIX, Windows drive-path, and UNC formatting cases rather than adding a test framework. Use the existing Windows CI job for native filesystem behavior; POSIX-hosted PowerShell string assertions are not a substitute for Windows execution.

## Risks / Trade-offs

- [A short command copied after changing directories can select another project] -> Display the resolved target separately, retain self-contained JSON guidance, and keep the public explicit-target form available.
- [An inner project or uncertain path alias could make omission unsafe] -> Require the same canonical discovered boundary; retain explicit guidance when equivalence is not established.
- [Optional discovery could introduce failures unrelated to an explicit target] -> Reuse resolved context, distinguish optional-context diagnostics from target failures, and avoid broad error swallowing.
- [Changing only some message producers could leave contradictory instructions] -> Audit the bounded update follow-up call sites and assert both error body and remedy in integration cases.
- [Shell-sequence extraction could change unrelated command output] -> Preserve the existing wrapper's defaults and extend its focused platform cases.
- [Text assertions could be relaxed until safety regressions disappear] -> Keep machine identity, wrong-target protection, preview/approval, and no-write assertions alongside new text expectations.

## Migration Plan

This is a CLI presentation change with no persisted-data migration. Implement the delta behind explicit-default formatting helpers, integrate the human context, and update the directly related CLI reference and troubleshooting sections.

Use the existing targeted update and shell tests, TypeScript build, and macOS/Linux/Windows CI coverage before release. Existing previews remain usable when their original CLI, target, inputs, and plan still match; no new cross-version compatibility is introduced.

Rollback restores the previous guidance implementation without rewriting projects, receipts, or approvals. No new flag, environment variable, or dependency is required.
