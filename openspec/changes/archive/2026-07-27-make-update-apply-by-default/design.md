## Context

The update engine already separates drift classification from mutation and has
a mature transactional apply path. Its command surface is the confusing part:

```text
interactive `liftoff update`       check, explain, prompt, maybe apply
redirected `liftoff update`        check only
`liftoff update --json`            check only
`liftoff update --apply`           prompt-free safe apply
`liftoff update --apply --force`   prompt-free conflict overwrite
```

This makes the same command depend on TTY detection and forces automation to
know an implementation-oriented `--apply` flag. OpenSpec establishes the desired
mental model: `update` performs an update. Liftoff needs an explicit check mode
because its project reconciliation also detects conflicts, orphans, moves, and
configuration drift.

The existing engine must retain its safety boundary: only named durable
artifacts participate; safe states are guarded; conflicts are skipped unless
forced; orphans are never deleted; updates are transactional; and framework
output, configuration, dependencies, and external paths remain protected.

## Goals / Non-Goals

**Goals:**

- Make `liftoff update` apply safe managed changes in every terminal context.
- Make `--check` the only read-only update mode.
- Let `--force` directly authorize the exact reported conflict set.
- Make JSON output available for both default apply and explicit check.
- Remove `--apply` immediately with actionable migration guidance.
- Preserve existing classification, preflight, transaction, manifest, recovery,
  and cross-platform path behavior.
- Give interactive and redirected execution identical mutation semantics.

**Non-Goals:**

- Automatically overwrite conflicts without `--force`.
- Automatically delete orphans.
- Install or update project dependencies.
- Retain backups after successful overwrites.
- Support workload, API-stack, pattern, framework, agent, or immutable starter
  migrations through update.
- Change the artifact state taxonomy or manifest schema.
- Add a second preview command; `--check` is sufficient.

## Decisions

### Resolve update mode explicitly rather than from TTY state

The command has two modes:

| Invocation | Mode | Safe changes | Conflicts | Prompts |
|------------|------|--------------|-----------|---------|
| `liftoff update` | apply | write | skip | none |
| `liftoff update --force` | apply | write | overwrite | none |
| `liftoff update --json` | apply | write | skip | none |
| `liftoff update --force --json` | apply | write | overwrite | none |
| `liftoff update --check` | check | none | none | none |
| `liftoff update --check --json` | check | none | none | none |

Input/output redirection changes rendering only; it never changes mode.
`--check --force` is invalid because a read-only command cannot authorize
overwrites.

Alternative considered: retain confirmation in a TTY but apply automatically
when redirected. This preserves the current interactive experience but keeps
the command context-dependent and makes scripted behavior more dangerous than
human behavior. It is rejected.

### Remove `--apply` at parsing time

`apply` is removed from the update command definition rather than retained as an
alias. The strict parser rejects it before project discovery or filesystem
access and points users to plain `liftoff update` or `liftoff update --check`.

This intentionally breaks existing scripts. Liftoff is pre-1.0, but the release
must still use the `0.7.0` minor boundary and document both migrations:

```text
liftoff update                  -> liftoff update --check
liftoff update --apply          -> liftoff update
liftoff update --apply --force  -> liftoff update --force
```

### Reuse the current explicit-apply engine

Default update enters the existing apply path after classification. It:

1. validates project and immutable workload identity;
2. renders and classifies the complete named artifact set;
3. warns when the Git worktree is dirty;
4. preflights all authorized paths and destinations;
5. writes new, missing, upgrade, clean-move, and recorded-state actions;
6. skips conflicts unless `--force`;
7. preserves orphans;
8. rewrites the manifest only after a successful transaction; and
9. reports written, skipped, and orphaned entries.

Prompt-only impact collection, `InteractivePrompter` update confirmations, and
prompt-wait snapshots are removed from update. Transaction and filesystem
preconditions remain responsible for race and boundary safety.

### Make check mode the inspection surface

`--check` uses the existing drift table/section and never calls preflight or the
transaction writer. It exits `0` when clean and `2` when any drift remains,
including conflict-only and orphan-only drift.

Human check guidance names plain `liftoff update` for safe reconciliation and
`liftoff update --force` only when conflicts require replacement. It never
prints the removed `--apply` syntax.

### Couple JSON shape to the selected mode

`liftoff update --check --json` retains the current versioned check object with
per-artifact states and summary counts.

`liftoff update --json` performs safe reconciliation and emits the existing
versioned apply object with written and skipped entries. JSON mode remains
prompt-free and byte-pure on stdout in both modes.

### Preserve apply exit semantics

Default update exits:

- `0` after a successful transaction, even when conflicts or orphans remain
  reported;
- `1` on validation, preflight, write, cleanup, or manifest failure.

Explicit check exits:

- `0` when clean;
- `2` when drift exists;
- `1` on validation or inspection failure.

This maps the current `--apply` and check behavior without introducing a new
automation contract.

## Risks / Trade-offs

- **Existing plain-update checks now mutate projects** -> Make `--check`
  prominent in help, release notes, errors, generated guidance, and
  documentation; release as `0.7.0`.
- **Removing confirmation can surprise interactive users** -> Default update
  changes only safe managed states; conflicts still require explicit `--force`,
  orphans remain untouched, and dirty worktrees still warn.
- **Existing `--apply` automation fails immediately** -> Reject before side
  effects with exact replacement commands.
- **Apply can finish with unresolved conflicts** -> Keep stable skipped-conflict
  output and recommend `liftoff update --check` or reviewed `--force`.
- **JSON users may accidentally mutate** -> Document that JSON controls format,
  not mode; require `--check --json` for read-only automation.
- **Removing prompt snapshots weakens race detection** -> Retain current apply
  preflight and transaction guards and add mutation-race tests for the
  prompt-free default path.
- **Cross-platform guidance can drift** -> Update Windows, macOS, and Linux CI
  coverage and assert portable displayed paths.

## Migration Plan

1. Add `--check`, remove `--apply`, and reject `--check --force`.
2. Route plain update and `--json` to the existing safe apply path without TTY
   branching or update prompts.
3. Route `--check` and `--check --json` to the existing read-only report.
4. Replace `--apply --force` guidance with direct `--force`.
5. Update all update, manifest, seed, help, documentation, generated guidance,
   and snapshot tests.
6. Verify redirected, TTY, JSON, Windows-path, failure, retry, conflict, orphan,
   and legacy-manifest behavior.
7. Release as `0.7.0` with explicit command migration notes.

Rollback is a code release rollback. Projects updated by the new command remain
valid because the underlying transaction and manifest formats are unchanged.

## Open Questions

None.
