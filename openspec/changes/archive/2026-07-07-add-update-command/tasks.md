# Tasks: add-update-command

## 1. Shared plumbing

- [x] 1.1 Add a project-root discovery helper in `src/file-system.ts`: explicit path wins, otherwise walk parents from cwd to the nearest `liftoff.manifest.json` (use `path` APIs; stop at filesystem root; clear error when no project found)
- [x] 1.2 Add a disk-hash utility that hashes a file's bytes as `sha256:<hex>` for comparison with manifest hashes
- [x] 1.3 Route `validate` through root discovery when no path argument is given
- [x] 1.4 Add a semver comparison helper that orders prerelease versions correctly (e.g., `0.3.0-next.1 < 0.3.0`)

## 2. Reconcile engine

- [x] 2.1 Create `src/reconcile.ts`: given (manifest, fresh render, project root), classify every artifact by `logicalName` join and hash comparison into unchanged/new/missing/upgrade/conflict/moved/orphan with a one-line reason each
- [x] 2.2 Handle the moved state: same `logicalName`, changed `pathParts`; combine with content comparison (clean move vs modified move)
- [x] 2.3 Handle the already-current edge: disk equals new render → unchanged, but flag the manifest entry for hash refresh on apply
- [x] 2.4 Unit-test every classification state, including moved+changed content and the already-current edge

## 3. Update command

- [x] 3.1 Add `updateCommand` to `src/commands.ts`: guards first (unsupported manifest version via loader; manifest `liftoffVersion` newer than CLI; config pattern != manifest pattern), then classify, then report
- [x] 3.2 Check mode (default): print grouped report with `+ ~ ! → -` markers and reasons; exit 0 clean / 2 drift; write nothing
- [x] 3.3 `--apply`: write new/missing/upgrade, execute clean moves, skip conflicts with per-file notice, report orphans; never delete
- [x] 3.4 `--force` (requires `--apply`, reject otherwise): also overwrite conflicts; print commit-first hint when git worktree is dirty (detect via `git status --porcelain` only when a `.git` directory is found; skip silently otherwise)
- [x] 3.5 After apply, rewrite the manifest: latest schema, current `liftoffVersion`, fresh hashes for written files, retained hashes for skipped conflicts, orphan entries retained until files are removed
- [x] 3.6 `--json` output with `schemaVersion`, per-artifact states, and summary counts in both modes
- [x] 3.7 Add `update` to help text

## 4. End-to-end tests

- [x] 4.1 Config drift: add an environment to `liftoff.config.json` → check exits 2 listing new artifacts; apply writes them and updates the manifest
- [x] 4.2 Config removal: remove an environment → orphans reported, files untouched after apply
- [x] 4.3 Template drift simulation: mutate a manifest `contentHash` to simulate an untouched-file template change → upgrade lane overwrites on apply
- [x] 4.4 Conflict flow: edit a generated file → check reports conflict; apply skips it; `--apply --force` overwrites it; skipped conflict reappears on re-check
- [x] 4.5 Guard refusals: pattern change in config; manifest `liftoffVersion` ahead of CLI (including a prerelease ordering case)
- [x] 4.6 Root discovery: update from a project subdirectory finds the root; explicit path argument wins; helpful error outside any project
- [x] 4.7 Verify expected paths in tests use `path.join` (no hardcoded separators); run `npm run check`
