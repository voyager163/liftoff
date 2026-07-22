# Tasks: add-migrate-command

## 1. Legacy scan

- [x] 1.1 Create `src/scan.ts`: read-only inventory of a source directory — dependency files (`requirements.txt`, `pyproject.toml`, `package.json`), framework indicators in dependencies (fastapi/flask/django/express, react/vue/next), `.env*` files, Docker assets, CI workflows, test directories, database migration directories, `openspec/`/`.specify/` presence, cloud markers, and unrecognized top-level entries
- [x] 1.2 Represent the inventory as typed findings (kind, evidence string, source path) consumable by both prompt pre-fill and task seeding
- [x] 1.3 Unit-test scan detection against fixture trees (Python+FastAPI app, Express app, app with frontend, app with unrecognized directories), using `path.join` for expected paths

## 2. Prompt pre-fill

- [x] 2.1 Create the inventory → `ProjectOptions` mapping with the evidence rules: strong signals pre-fill (project name from directory, frontend, spec workflow; cloud at medium confidence), weak signals leave blank; pattern only on strong evidence
- [x] 2.2 Surface provenance in the prompt flow (each pre-filled default shows "detected X in Y") via `promptForCreateOptions(initial)`
- [x] 2.3 Verify `--yes` semantics match `create` (fails when required options remain unfilled)

## 3. Migrate command

- [x] 3.1 Add `migrateCommand` to `src/commands.ts`: resolve and validate the source path, scan, prompt with pre-fill, plan, confirm, scaffold via the existing `create` pipeline into a new sibling directory
- [x] 3.2 Implement the filtered staging copy into `migration/legacy/` (exclude `.git`, `node_modules`, virtualenvs, `__pycache__`, `dist`/`build` outputs)
- [x] 3.3 Add `migration/legacy/` to the generated `.gitignore` template
- [x] 3.4 Generate the emitted plan: seed tasks from the inventory (dependencies → config → code → tests → CI → placement decisions → staging cleanup), each referencing `migration/legacy/...` sources and Liftoff destinations
- [x] 3.5 Write the plan as OpenSpec change `migrate-to-liftoff` (proposal.md stating the completion gate + tasks.md) when the spec workflow is OpenSpec; write `MIGRATION.md` with the same content otherwise
- [x] 3.6 Print next steps: optional `.git` copy recipe for history preservation, plan location and how to run it, `liftoff validate && liftoff doctor` gate
- [x] 3.7 Add `migrate` to help text

## 4. End-to-end tests

- [x] 4.1 Full migrate run against a Python+FastAPI fixture: scaffold validates, staging copy filtered correctly, emitted tasks reference detected findings
- [x] 4.2 Non-destructiveness: hash the source fixture tree before and after a full run and assert byte-for-byte equality
- [x] 4.3 Unrecognized top-level directory produces a placement-decision task (nothing silently dropped)
- [x] 4.4 Spec-kit selection emits `MIGRATION.md` instead of an OpenSpec change
- [x] 4.5 Existing non-empty target directory fails with the `create` safety error
- [x] 4.6 Run `npm run check`
