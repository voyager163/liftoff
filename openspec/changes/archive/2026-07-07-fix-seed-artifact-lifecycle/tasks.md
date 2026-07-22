# Tasks: fix-seed-artifact-lifecycle

## 1. Seed category

- [x] 1.1 In `src/templates.ts`, change the four bootstrap-change artifacts (`openspec-seed-change-metadata`, `openspec-seed-proposal`, `openspec-seed-design`, `openspec-seed-tasks`) from category `governance` to category `seed`
- [x] 1.2 In `buildManifest`, exclude `category === 'seed'` artifacts from the manifest artifact list (they are still rendered and written at create)

## 2. Reconcile and loader exclusions

- [x] 2.1 In `src/reconcile.ts`, skip render artifacts with category `seed` (alongside the existing `manifest`/`liftoff-config` exclusions), deleting any matching manifest-side entry so nothing falls through to the orphan pass
- [x] 2.2 In `src/file-system.ts`, drop legacy seed entries (the four `openspec-seed-*` logical names) from `manifest.artifacts` in `loadManifest` after the version check, so `validate`, `update`, and `doctor` all heal on read

## 3. Fixtures and tests

- [x] 3.1 Regenerate `tests/fixtures/manifest-v2.json` so the frozen fixture no longer carries seed entries (logical-names snapshot is unchanged — seeds still render)
- [x] 3.2 Test: create a fixture project, archive the bootstrap change (move it under `openspec/changes/archive/`), then `update` reports no drift, `update --apply` does not re-create it, and `validate` passes
- [x] 3.3 Test: legacy healing — inject the four seed entries into a fixture manifest (category `governance`, hashes of the seed files), then `update` reports no drift and after `--apply` the rewritten manifest contains no seed entries
- [x] 3.4 Test: fresh `create` still writes the seed files to disk and the manifest contains no entry for them
- [x] 3.5 Regression test: in a migrated project, archiving `openspec/changes/migrate-to-liftoff/` causes no drift in `update`
- [x] 3.6 Run `npm run check` and the package smoke test

## 4. Release

- [x] 4.1 Bump `package.json` to 0.2.1
