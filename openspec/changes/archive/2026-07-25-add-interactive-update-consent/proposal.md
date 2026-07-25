## Why

`liftoff update` currently reports actionable drift and then makes an interactive developer rerun the command with `--apply`. The same invocation should disclose the concrete overwrite impact and request consent, while retaining the existing fail-safe behavior for local edits, automation, and machine-readable checks.

## What Changes

- When `liftoff update` detects actionable drift in a real interactive terminal, show a deterministic impact summary before requesting permission.
- Explain which managed files will be created, replaced, or moved; whether local edits are at risk; whether the manifest changes; and that dependency installation and orphan deletion do not occur.
- Ask once, defaulting to No, before applying safe managed changes in the same command invocation.
- Require a separate, default-No confirmation that lists exact conflicted paths before overwriting locally modified or otherwise user-owned files.
- Warn that successful conflict replacement has no retained Liftoff backup and recommend committing local work before consent.
- Preserve `--apply` and `--apply --force` as explicit non-interactive consent, and preserve read-only drift behavior for `--json` and non-interactive execution.
- Keep reconciliation transactional, never auto-delete orphans, and report cancellation without mutating project files.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `liftoff-project-update`: Add interactive impact disclosure and tiered update/overwrite consent while preserving check, force, transaction, and automation contracts.
- `liftoff-cli-workflow`: Update the documented command behavior, consent model, and terminal presentation contract.

## Impact

The change affects update orchestration and presentation in `src/commands.ts`, `src/interactive.ts`, and potentially shared terminal models in `src/terminal.ts`. It requires update, interactive, presentation, snapshot, documentation, and cross-platform regression coverage. No package dependency, manifest schema, generated-project format, or JSON schema change is expected.
