## Context

`liftoff update` already computes a complete reconciliation set before writing and distinguishes safe managed changes from local or user-owned conflicts. In human output it currently stops after the drift report and prints `liftoff update --apply`; explicit apply then re-renders and reconciles in a second process. The existing apply path preflights every mutation and executes one rollback-capable transaction, but successful updates do not retain a recovery copy.

The interactive subsystem already provides defaulted yes/no prompts and TTY-aware agent selection. Update must reuse those input and presentation conventions without making JSON, redirected output, CI, or other non-interactive callers wait for input. Paths remain structured as path-part arrays for filesystem work and use the existing portable manifest display form in terminal output.

## Goals / Non-Goals

**Goals:**

- Let a developer review drift, understand its concrete impact, and authorize the update in one interactive invocation.
- Distinguish safe managed updates from destructive replacement of local or user-owned content.
- Collect every required decision before the first filesystem mutation.
- Preserve the existing explicit flag, transaction, JSON, non-interactive, orphan, and exit-code contracts.
- Keep impact computation deterministic, content-safe, cross-platform, and independently testable.

**Non-Goals:**

- Automatically accept updates, delete orphans, install dependencies, or create persistent backups.
- Display full file or lockfile diffs, infer application-level behavior, or execute package-manager commands.
- Change reconciliation classification, manifest schema, JSON schema, generated-project format, or the meanings of `--apply` and `--force`.
- Add another general-purpose interactive framework or new package dependency.

## Decisions

### 1. Prompt only when both input and output are interactive

Refactor the existing TTY checks into a shared predicate. Human update prompting is eligible only when stdin and stdout are TTYs, human output is active, and neither explicit `--apply` nor check-only `--json` behavior selected the mode. Checkbox prompts may additionally require raw-mode support, but the update yes/no prompt does not.

The CLI entry point will pass stdin explicitly through the existing `CommandContext`; tests can therefore provide controlled streams. Redirected input, redirected output, JSON checks, and ordinary test capture streams retain the current read-only report, command hint, and drift exit code without attempting to read input.

**Alternative considered:** Prompt whenever stdin is available. This can block pipelines or emit an invisible prompt when stdout is redirected, so both streams must identify as interactive.

### 2. Build one immutable impact model from the reconciliation entries

Add a pure update-impact model derived from the same `ReconcileEntry[]` used for the report and eventual transaction. It will separate:

- safe creates, restores, replacements, clean moves, and recorded-state refreshes;
- every physical source or destination path whose bytes are at risk only with overwrite consent, including both paths when an unsafe move would replace one and remove the other;
- managed old paths removed by accepted moves;
- orphans that remain untouched;
- whether the manifest will be refreshed;
- affected dependency-definition artifacts; and
- the invariant that Liftoff does not install dependencies during update.

Dependency impact will use an explicit logical-name set rather than filename pattern matching. The set covers the generated Python project and worker dependency definitions, Node package and lock artifacts, Go module and checksum artifacts, frontend package and lock artifacts, and Power Apps package and lock artifacts. Because generated artifacts are tracked by logical name, additions to that inventory must be deliberate and test-covered.

Impact output reports classifications, counts, and portable relative paths only. It does not print current file contents, template contents, or a full diff.

**Alternative considered:** Compute a generic textual diff. Lockfiles can dominate the terminal, local files may contain sensitive values, and line counts do not reliably communicate runtime impact. A compact deterministic model is safer and easier to act on.

### 3. Use tiered, default-No consent

After rendering the existing drift report, an eligible interactive invocation renders an `Update impact` section. If safe actions or a recorded-state refresh exist, Liftoff asks whether to apply those changes now, defaulting to No.

If safe consent is granted and conflicts exist, Liftoff then lists every conflicted portable path in stable order, explains that successful replacement discards those bytes without a retained Liftoff backup, and asks a separate default-No overwrite question. Declining this second question applies only the safe subset and preserves the conflicts. If conflicts are the only actionable entries, Liftoff proceeds directly to the overwrite disclosure and question.

Declining the first question or declining a conflict-only question leaves every project file unchanged and returns the existing drift exit code. End-of-input or prompt cancellation before all decisions are collected aborts without mutation. Orphan-only drift has no automatic action and therefore produces no consent prompt.

**Alternative considered:** A single confirmation for all changes. That would allow permission for safe managed updates to imply permission to destroy local edits, violating Liftoff's existing separation of consent.

### 4. Warn before consent and execute once

The dirty-worktree warning moves before impact disclosure so it can inform the decision. Liftoff captures the manifest, configuration, and every potentially authorized source or destination before prompting, confirms reconciliation still describes that captured state, and carries the snapshots for accepted actions into the transaction as preconditions. Paths supporting accepted actions remain guarded even when they need no content write, such as a matching move destination or recorded-state-only refresh. A changed reviewed path aborts without mutation and requires a fresh review.

All prompt answers are collected before update preflight or mutation. Accepted choices are translated into the existing apply/force execution policy, and the authorized safe and conflict mutations plus manifest rewrite execute through the existing single transaction.

Rollback snapshots remain in-memory transaction state used only after a failed apply. The conflict disclosure must not describe them as a post-success backup. Explicit `--apply` and `--apply --force` remain prompt-free authorization paths and continue using the same transaction.

**Alternative considered:** Apply safe files before asking about conflicts. This creates a partially updated project when the second prompt is cancelled and prevents one atomic transaction, so all decisions must precede execution.

### 5. Preserve machine and compatibility contracts

`liftoff update --json` without apply remains a read-only schema-versioned check and exits 2 on drift. Non-interactive `liftoff update` remains a read-only check with the current command hint and exit code. Explicit apply modes retain their output and exit behavior. No impact object is added to JSON in this change.

A successful interactive apply exits 0 under the existing apply contract, even when unforced conflicts or orphans remain. An explicit first-prompt decline exits 2 because drift remains unresolved.

### 6. Keep presentation portable and testable

Prompt and impact rendering will use `PresentationSession` and `InteractivePrompter`, not direct writes. Filesystem operations continue using path-part arrays and the existing safe resolvers; displayed paths use the existing portable project-relative formatter on Windows, macOS, and Linux.

Unit coverage will exercise the pure impact model. Command coverage will use explicit fake TTY streams for acceptance, decline, cancellation, mixed safe/conflict decisions, conflict-only drift, orphan-only drift, dependency impact, and redirected/non-interactive behavior. Existing non-TTY tests continue proving that update remains read-only by default in automation.

## Risks / Trade-offs

- **TTY detection differs across shells or test harnesses** -> Require both input and output TTY signals, pass stdin explicitly, and cover redirected and fake-TTY cases.
- **Impact wording overstates recovery** -> State that rollback protects failed transactions only and that no Liftoff backup remains after success.
- **Dependency-impact inventory becomes stale** -> Centralize an explicit logical-name set and add a test that covers every currently generated dependency artifact.
- **Files change between review and execution** -> Capture review snapshots before prompting and enforce accepted-path, configuration, and manifest snapshots as transaction preconditions in addition to rollback assertions.
- **Additional output becomes noisy** -> Render a compact summary and exact at-risk paths, never full lockfile or content diffs.
- **Interactive behavior surprises existing scripts attached to a pseudo-terminal** -> Preserve prompt-free `--json`, `--apply`, and `--apply --force` modes and document the TTY distinction.

## Migration Plan

1. Add the pure impact model and presentation coverage without changing apply behavior.
2. Add shared interactive-terminal detection and update-specific consent methods.
3. Wire the interactive branch before the existing apply transaction, preserving explicit and non-interactive branches.
4. Update public and generated documentation, then run targeted update, interactive, presentation, and template tests followed by the repository check.

Rollback consists of reverting the interactive branch and documentation; no project or manifest migration is required.

## Open Questions

None. The agreed defaults are No for both permission levels, no persistent backup, no automatic dependency installation, and no orphan deletion.
