# Design: add-update-command

## Context

A generated project carries `liftoff.config.json` (desired state, user-owned) and `liftoff.manifest.json` (recorded state: what liftoff last wrote, with content hashes as of manifest v2). The disk is the actual state, and the current CLI's templates are the new truth. Update reconciles all four. The mental model deliberately mirrors OpenTofu, which the target audience already uses: config = desired state, manifest = state file, `update` = plan, `update --apply` = apply.

## Goals / Non-Goals

**Goals:**

- Deterministic, explainable reconciliation: every artifact lands in exactly one state with a one-line reason.
- Safe by default: nothing user-modified is ever overwritten without `--force`; nothing is ever deleted automatically.
- Both drift axes (template evolution, config edits) through one engine.
- Usable as a CI drift gate with zero extra tooling.

**Non-Goals:**

- No three-way merge. Conflicted files are reported and skipped (or wholesale overwritten under `--force`). The named upgrade path is a rendered-content cache under the reserved `.liftoff/` directory, built only if conflict pain materializes.
- No pattern changes (refused; that is `migrate` territory).
- No orphan deletion, no per-file force flag, no npm "newer CLI available" lookup (doctor's job, later change), no `.bak` backups (git is the backup).
- No v1-manifest support (v2 is the first supported contract per `add-manifest-v2`).

## Decisions

### D1: Classification joins on `logicalName`, decides with hashes

For each union of (manifest artifacts × fresh render), joined on `logicalName`:

| State | Condition | Check output | `--apply` | `--apply --force` |
|---|---|---|---|---|
| unchanged | render == disk | counted | — | — |
| new | in render only | `+` | write | write |
| missing | in manifest + render, absent on disk | `+ (restore)` | write | write |
| upgrade | disk hash == manifest hash, render differs | `~` | overwrite | overwrite |
| conflict | disk hash != manifest hash, render differs from disk | `!` | skip | overwrite |
| moved | same `logicalName`, different `pathParts` | `→` | move (clean) / report (modified) | move + overwrite |
| orphan | in manifest only | `-` | report only | report only |

Rationale: `logicalName` is the append-only stable key (locked by the manifest-contract test), which is what makes cross-version moves detectable at all. Hash equality against the manifest proves "untouched since liftoff last wrote it" — the only justification for a silent overwrite. A moved artifact whose content also changed applies the move first, then the content rules.

Edge case: disk content already equals the new render (user manually applied the template change) → classified `unchanged`; apply still refreshes the manifest entry so the recorded hash catches up.

### D2: The manifest-hash invariant

The manifest's `contentHash` always records what liftoff last wrote — never what the user has. When a conflict is skipped, the old hash stays; drift remains visible on every subsequent run until resolved. Update never "blesses" user content by recording its hash.

### D3: Check is pure, apply rewrites the manifest

Check mode reads only. `--apply` writes files and then rewrites the manifest wholesale at the latest schema (fresh artifact list, fresh hashes for everything it wrote, `liftoffVersion` = current CLI). Consequence: update is also the manifest migrator — any future schema bump propagates through normal update usage. Skipped conflicts keep their prior hash per D2. Orphan entries stay in the manifest until the underlying file is removed by the user (keeping the report visible), preventing silent forgetting.

### D4: `--force` is a blanket boolean, not per-file

`--force` requires `--apply` (rejected otherwise) and overwrites the conflict lane too. Per-file granularity already exists without a flag: delete the file, re-run update, and the `missing` state restores the template version. The check-mode report lists exactly which files `--force` would hit, so the blast radius is visible before the trigger is pulled. When the project is a git repo with a dirty worktree, apply (with or without force) prints a commit-first hint; it does not block.

### D5: Guards run before classification

1. Manifest `artifactVersion` unsupported → fail with remedy (from `add-manifest-v2` loader).
2. Manifest `liftoffVersion` newer than the running CLI (semver compare, prerelease-aware — the `next` channel exists) → fail: "project was written by a newer Liftoff; upgrade the CLI."
3. Config `pattern` differs from `manifest.project.pattern` → fail: "pattern changes are a migration; run `liftoff migrate`."

Rationale: each guard prevents a class of silent damage (misparse, downgrade-as-upgrade, half-rendered hybrid project).

### D6: Project-root discovery walks up

A shared helper resolves the project root: explicit path argument wins; otherwise walk parent directories from cwd to the nearest `liftoff.manifest.json` (stop at filesystem root; never assume project root == git root). `update` and `validate` use it now; doctor adopts it in its own change. Uses `path` APIs only — no separator assumptions.

### D7: Exit codes and JSON

Check: 0 clean, 2 drift found, 1 error. Apply: 0 success (including "nothing to do"), 1 error. `--json` emits `{ schemaVersion: 1, states: [...], summary: {...} }` per the contract conventions. Rationale: 0-vs-2 in check mode is what makes `liftoff update` a one-line CI drift gate.

### D8: Rendering reuses the existing pipeline verbatim

`loadConfigOptions` → `buildProjectPlan` → `buildArtifacts` — the same pure pipeline `create` uses, no update-specific rendering. Determinism is already CI-enforced by the contract test, which is what makes hash comparison meaningful.

## Risks / Trade-offs

- [High-churn generated files users must edit (`backend/apis/main.py`, `pyproject.toml`) will conflict on nearly every template change] → Accepted v1 ceiling; the safe lane still covers the periphery (infra, docker, governance, env scaffolding) where structural drift actually lives. Upgrade path: `.liftoff/` rendered-content cache enabling three-way merge, only if real pain appears.
- [Line-ending translation (git `autocrlf`) could make untouched files hash as modified on Windows] → Fails safe (conflict = report, not overwrite). Document LF normalization in the generated project; revisit only if reports show noise.
- [Blanket `--force` overwrites all conflicts at once] → Check-first workflow shows the exact list; per-file need is served by delete-and-rerun; git hint nudges a restore point.
- [Users may hand-edit the manifest] → Treated as unsupported; the loader validates shape, and apply rewrites it wholesale, self-correcting drift in the state file itself.

## Migration Plan

Ships after `add-manifest-v2` in the same 0.2.x line. No stored-data migration: update refuses pre-v2 manifests with the standard remedy message. Rollback = remove the command; no persistent format changes beyond what manifest v2 already defines.

## Open Questions

None — force semantics, orphan policy, root discovery, and exit codes were all resolved during exploration.
