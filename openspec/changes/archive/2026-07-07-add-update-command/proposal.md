# Proposal: add-update-command

## Why

Generated projects drift from two directions — the CLI's templates evolve across releases, and developers edit `liftoff.config.json` (adding environments, enabling the frontend) — and nothing today can reconcile either. Manifest v2 (see `add-manifest-v2`) records the generating version and per-artifact content hashes precisely so a reconcile command can exist; this change builds it.

## What Changes

- New `liftoff update` command that reconciles a generated project against a fresh render of its plan. Check mode is the default and prints a drift report without writing; `--apply` writes safe changes; `--force` (only meaningful with `--apply`) additionally overwrites conflicted files.
- Every manifest artifact is classified into exactly one state by joining the fresh render against the manifest on `logicalName` and comparing content hashes: `unchanged`, `new` (write), `missing` (restore), `upgrade` (disk matches last-written hash, template changed — safe overwrite), `conflict` (user modified — report and skip by default), `moved` (same logical name, new path), `orphan` (no longer generated — report only, never auto-delete).
- Both drift axes flow through one engine: template evolution (new CLI version) and configuration edits (`liftoff.config.json` is the desired state; adding an environment or toggling the frontend yields new/orphaned artifacts).
- Guards: a `pattern` change in config is refused with guidance to use `migrate`; a manifest whose `liftoffVersion` is newer than the running CLI is refused with guidance to upgrade the CLI (semver-aware comparison, prerelease-safe).
- On apply, the manifest is rewritten at the latest schema with fresh hashes and the current CLI version — update is also the manifest migrator.
- Check mode exits 2 when drift exists (0 when clean), making `liftoff update` a CI drift gate with no extra tooling. `--json` output with `schemaVersion` per the contract conventions.
- Project-root discovery: commands that operate on an existing project resolve the project root by walking up from the current directory to the nearest `liftoff.manifest.json` (explicit path arguments still win). `validate` gains the same behavior.
- `liftoff.config.json` is never machine-written after `create`; update reads it as desired state only.
- Before applying with `--force`, update prints a hint to commit when the project's git worktree is dirty (git is the backup mechanism; no `.bak` files).

## Capabilities

### New Capabilities

- `liftoff-project-update`: The reconcile engine and `update` command — state classification, drift axes, guards, apply/force semantics, manifest rewrite, exit codes, JSON output, and project-root discovery for project-scoped commands.

### Modified Capabilities

- `liftoff-cli-workflow`: The command-surface requirement now includes project update alongside creation, planning, discovery, validation, helpers, and diagnostics.

## Impact

- `src/commands.ts`: new `updateCommand`; help text gains `update`.
- New `src/reconcile.ts` (state classification over manifest × fresh render × disk).
- `src/file-system.ts`: project-root walk-up helper; hash-on-read utility; `validate` routes through root discovery.
- `src/planner.ts`: plan construction from an on-disk `liftoff.config.json` (reuse `loadConfigOptions`).
- Depends on `add-manifest-v2` (hashes, `liftoffVersion`, loader, exit-code and JSON conventions).
- Tests: state-machine unit tests per classification, end-to-end update scenarios (config drift, template drift simulation, conflict skip, force overwrite, orphan report, moved artifact, guard refusals).
