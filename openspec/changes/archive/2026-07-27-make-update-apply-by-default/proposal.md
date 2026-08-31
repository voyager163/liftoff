## Why

`liftoff update` currently means different things depending on terminal
interactivity and requires `--apply` for prompt-free execution. Making the
command itself perform safe reconciliation aligns it with `openspec update`,
removes unnecessary ceremony, and gives checks an explicit `--check` mode.

## What Changes

- **BREAKING:** Make `liftoff update` immediately apply safe managed changes in
  interactive, redirected, and non-interactive environments.
- Add `liftoff update --check` as the explicit read-only drift command, retaining
  exit code `0` for clean projects and `2` for drift.
- Make `--json` describe the selected mode: default update emits apply results,
  while `--check --json` emits the existing machine-readable drift report.
- Allow `liftoff update --force` to overwrite reported conflicts after the
  existing preflight guards; reject `--check --force`.
- Remove `--apply` immediately and return a usage error that points users to
  plain `liftoff update`.
- Remove interactive safe-update and conflict-overwrite prompts. Safe changes
  apply automatically, conflicts remain untouched unless `--force` is explicit,
  and orphans remain report-only.
- Preserve transactional writes, reviewed-path preconditions, project-boundary
  enforcement, dirty-worktree warnings, manifest migration, no dependency
  installation, and failure recovery.
- Update public guidance, generated project guidance, tests, snapshots, and
  migration messages for the new command matrix.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `liftoff-project-update`: Change update from consent/check-by-default to
  safe-apply-by-default with explicit `--check` and direct `--force`.
- `liftoff-cli-workflow`: Change lifecycle and machine-output guidance for the
  imperative update command.
- `liftoff-user-documentation`: Document the new update, check, JSON, and force
  command matrix.
- `liftoff-manifest-contract`: Replace `--apply`-specific manifest rewrite
  scenarios with default update behavior.
- `liftoff-project-scaffold`: Preserve seeded and user-managed files under the
  new default update syntax.

## Impact

- CLI parsing and help definitions in `src/args.ts`.
- Update orchestration, presentation, exit codes, and conflict guidance in
  `src/commands.ts` and interactive presentation helpers.
- Update, manifest, seed-lifecycle, maintenance-presentation, help, and
  cross-platform tests and snapshots.
- Packaged CLI, safety, troubleshooting, existing-repository, configuration,
  workload, and generated-template documentation.
- Existing automation must replace read-only `liftoff update` with
  `liftoff update --check` and remove `--apply` from write commands.
- This behavior break should ship as Liftoff `0.7.0`.
