# Proposal: add-migrate-command

## Why

Teams with existing GenAI applications have no path into Liftoff governance — `create` only works on empty directories, and full compliance (code actually living in the Liftoff layout) cannot be produced by patching a live codebase in place. A scaffold-first migration starts at 100% compliance and moves code in, is non-destructive by construction, and turns the judgment-heavy transformation work into an executable plan the team runs through its normal spec-driven workflow.

## What Changes

- New `liftoff migrate <path-to-existing-project>` command that orchestrates adoption:
  1. **Scan** the legacy project (deterministic, read-only inventory: dependency files, detected framework, env files, Docker assets, CI workflows, tests, database migrations, frontend, unrecognized top-level entries).
  2. **Prompt** using `create`'s existing flow, pre-filled from scan evidence with provenance shown (e.g., "frontend: yes — detected `frontend/` with a React dependency"); weak evidence leaves the prompt blank rather than guessing.
  3. **Scaffold** a fresh Liftoff project in a new directory beside the legacy project, reusing `create`'s generation pipeline verbatim (manifest v2 included).
  4. **Stage** a filtered copy of the legacy source at `migration/legacy/` inside the scaffold (gitignored; excludes dependency/build/VCS directories) so the migration is self-contained.
  5. **Emit the migration plan** as an OpenSpec change (`migrate-to-liftoff`) inside the scaffold — proposal plus tasks seeded from the scan, each task mapping legacy material to its Liftoff destination, ending with cleanup of the staging copy. When the selected spec workflow is not OpenSpec, the same plan is emitted as a standalone `MIGRATION.md` checklist.
  6. **Print next steps**: optional `.git` copy for history preservation, run the emitted change through the agent workflow, then `liftoff validate && liftoff doctor` as the completion gate.
- The source project is never written to — migrate's only outputs are the new scaffold directory and console output.
- Migration is resumable for free: a half-done migration is an OpenSpec change with unchecked tasks.

## Capabilities

### New Capabilities

- `liftoff-project-migration`: The `migrate` command — legacy scan, evidence-based prompt pre-fill, scaffold-first generation, staging copy, emitted migration plan, non-destructive guarantee, and completion gate.

### Modified Capabilities

- `liftoff-cli-workflow`: The command-surface requirement now includes project migration. (This delta builds on `add-update-command`'s modification of the same requirement; archive that change first.)

## Impact

- New `src/scan.ts` (legacy inventory) and `src/migrate-plan.ts` (inventory → prompt defaults + emitted task list).
- `src/commands.ts`: new `migrateCommand`; help text gains `migrate`.
- Reuses unchanged: `promptForCreateOptions(initial)` (already accepts pre-filled options), `buildProjectPlan`, `buildArtifacts`, `writeArtifacts`, `validateGeneratedProject`.
- Generated `.gitignore` template gains `migration/legacy/`.
- Depends on `add-manifest-v2` (migrated projects are born with v2 manifests); ordered after `add-update-command` only for the shared spec delta.
- Tests: scan detection fixtures, pre-fill provenance, staging copy filters, emitted change content, non-destructiveness (source tree untouched byte-for-byte).
