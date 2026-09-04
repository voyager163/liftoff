## Context

See `proposal.md` for motivation. Current generation must expose one setup command, while older manifests may already record two generated `/liftoff-repository-governance` alias artifacts. The design must remove the alias from all current contracts without reviving broad legacy update authority or deleting user-owned files by pattern.

## Goals / Non-Goals

**Goals:**

- Keep current generated state, compatibility metadata, snapshots, and documentation alias-free except for explicit migration language.
- Preserve a narrow upgrade bridge for the two exact retired generated aliases that older Liftoff versions emitted.
- Make alias retirement safe, observable, force-gated when modified, and transactionally coupled to manifest rewrites.

**Non-Goals:**

- Do not keep `/liftoff-repository-governance` callable or generated for compatibility.
- Do not add pattern-based cleanup for arbitrary old launcher-looking files.
- Do not change user-owned activation state, live governance enforcement, project source, package metadata, or framework output.

## Decisions

### Split current and retired identity catalogs

Current managed-core catalogs contain only the canonical governance files and selected-agent `/liftoff-setup` integrations. A separate retired catalog lists exactly:

- `repository-governance-copilot-launcher` at `.github/prompts/liftoff-repository-governance.prompt.md`
- `repository-governance-claude-launcher` at `.claude/commands/liftoff-repository-governance.md`

This prevents new renders, manifests, compatibility metadata, and snapshots from accidentally reintroducing retired names. The retired catalog exists only so readers and update can identify migration debt.

Alternative considered: leave aliases in the current managed-core list but stop rendering files. That would keep the old logical names valid current identities and could preserve orphans indefinitely, so it was rejected.

### Exact allowlisted deletion only

Update deletion authority is keyed by retired logical name plus exact governance category and path. Unknown old launcher names, correct names at the wrong path, correct names in project provenance, and unrelated orphan files are rejected or reported without deletion. This follows the existing rule that generated artifacts are managed by explicit identity lookup, not path, category, or filename matching.

Alternative considered: delete any file named `liftoff-repository-governance.*`. That risks deleting user-created files and violates the managed-core authority boundary.

### Hash-based clean versus modified distinction

For an exact retired manifest entry, reconciliation reads the recorded path and compares disk bytes to the manifest `contentHash`. Missing files are `retired` with `fileDeleted: false`; matching files are `retired` with `fileDeleted: true`; changed files are `retired-conflict`. This preserves user modifications and avoids treating presence at the old path alone as proof of generated ownership.

Alternative considered: always delete exact retired aliases. That would destroy developer edits to generated alias files without review.

### `--force` remains the only modified-alias deletion path

Plain update removes clean or already absent retired alias ownership but protects modified retired aliases, retains the entry as migration debt, reports a protected conflict, and records governance as `handoff-partial`. `liftoff update --force` may delete only the exact modified retired alias after normal path, collision, dirty-worktree, and transaction guards pass. `--force` still cannot affect project-owned files, provisioning collisions, unknown aliases, or unrelated orphans.

Alternative considered: require manual deletion for every retired alias. That would avoid automation but would leave many clean generated aliases in manifests even though Liftoff can prove they are untouched.

### Transactional rollback covers alias deletion and manifest rewrite

Retired alias deletion is staged in the same mutation transaction as managed-core writes and the manifest replacement. If any later mutation fails, rollback restores both the alias file and the manifest bytes; the command reports rollback instead of claiming cleanup.

Alternative considered: rewrite the manifest after deleting aliases outside the transaction. That could strand projects with a deleted file but stale ownership, or a cleaned manifest while the old file remains.

### Current compatibility metadata stays current-only

Compatibility metadata validates against current managed-core logical names and paths. Retired aliases are excluded from the current inventory; when a manifest still has retired migration debt, validation avoids treating that retired entry as part of the current allowlist. This keeps fresh generated metadata free of `/liftoff-repository-governance` and old launcher logical names.

Alternative considered: include retired aliases in compatibility metadata until all projects migrate. That would make old names appear in fresh artifacts and contradict the single-command contract.

### Old readers remain solely for upgrade

Manifest v2 through v6 and early v7 readers continue to load exact retired alias identities so `liftoff update` can remove them. They reject unknown retired alias names and wrong placements before mutation. New writes always emit schema v7 with current setup identities only.

Alternative considered: fail every manifest containing a retired alias. That would block automated migration for previously generated projects.

## Risks / Trade-offs

- Clean generated aliases are deleted automatically by plain update → mitigated by requiring exact manifest ownership and a matching recorded hash.
- Modified aliases remain visible until force or manual cleanup → mitigated by `handoff-partial`, protected-conflict reporting, and explicit `--force` removal details.
- Older CLIs cannot read schema v7 after migration → existing unsupported-version failure remains the safe downgrade boundary.
- Documentation still mentions the retired alias for migration → wording limits mentions to removal debt and does not present it as an invocation option.

## Migration Plan

1. Ship current renders and docs with only `/liftoff-setup`.
2. On update, load exact retired aliases from supported old manifests as migration debt.
3. Plain update retires clean or absent exact aliases and rewrites the manifest to schema v7 with current identities.
4. Plain update protects modified exact aliases as `handoff-partial`; users review and run `liftoff update --force` to delete them if desired.
5. On any update failure, rollback restores alias and manifest state; rerunning update reclassifies from actual disk bytes.
