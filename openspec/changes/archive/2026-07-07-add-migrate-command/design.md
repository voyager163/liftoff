# Design: add-migrate-command

## Context

"Liftoff compliance" is defined by the manifest contract and measured by `validate` (structure), `doctor` (readiness), and the scaffold's own tests. Full compliance for an existing project means its code actually lives in the Liftoff layout (routes under `backend/apis`, orchestration under `backend/orchestration`, config through `settings.py`) — a transformation no deterministic tool can perform on arbitrary code. Migrate therefore splits the work: everything deterministic happens in the CLI; everything requiring judgment ships as an executable plan consumed by the team's normal agent workflow. The compliance ladder frames it: the CLI produces and certifies L0 (structure) and enables L1 (mechanical: tests, docker, doctor); L2 (semantic placement) is certified by completing and archiving the emitted change.

## Goals / Non-Goals

**Goals:**

- Non-destructive by construction: the legacy project is read, never written.
- Start from 100% compliance (fresh scaffold) and move code in, rather than patching toward compliance.
- Maximum reuse of `create`: prompts, planning, rendering, writing, validation — unchanged.
- A migration plan that is complete (nothing silently unmapped), self-contained, and resumable.

**Non-Goals:**

- No automatic code transformation (no moving/rewriting legacy source by the CLI).
- No in-place adoption mode (a future variant if a real monorepo need appears).
- No smart pattern inference beyond conservative evidence rules — a blank prompt beats a wrong guess.
- No writes of any kind into the legacy directory, including no `.git` manipulation (history preservation is a printed instruction, not code).

## Decisions

### D1: Scaffold-first, sibling directory

`liftoff migrate ../legacy-app` creates the new project as a sibling (target name from the project-name prompt; `create`'s new-or-empty-directory rule applies unchanged). Rejected alternative: in-place adoption — conflict resolution against live code, destructive failure modes, and it forfeits `create` reuse. Rollback of a migration is `rm -rf <new-dir>`.

### D2: Scan runs first and feeds two consumers

The scan produces one inventory consumed twice: prompt defaults (step 2) and task seeding (step 5). Detection is grep-level and evidence-based:

| Signal | Evidence | Prompt effect | Task seeded |
|---|---|---|---|
| Project name | legacy directory name | default projectName | — |
| Python deps | `requirements.txt` / `pyproject.toml` | — | port dependencies into `backend/pyproject.toml` |
| FastAPI present | `fastapi` in dependencies | — | move route modules into `backend/apis/routes/` |
| Other framework | `flask` / `django` / `express` in dependencies | — | rewrite entrypoints as FastAPI routes (flagged large) |
| Env config | `.env*` files | — | map variables into `environments/*/backend.env` and `settings.py` |
| Docker | `Dockerfile`, compose files | — | reconcile with scaffold compose (legacy kept as reference) |
| DB migrations | `alembic/`, `migrations/` | — | graft history into `database/migrations/` |
| Tests | `tests/`, `pytest.ini` | — | relocate under `backend/tests/` |
| CI | `.github/workflows/` | — | port jobs into the scaffold workflow |
| Frontend | `frontend/` dir or React/Vue/Next dependency | default includeFrontend=true | move app under `frontend/` |
| Spec workflow | existing `openspec/` or `.specify/` | default specWorkflow | carry existing specs forward |
| Cloud markers | azure-* deps, bicep/tf files | default cloud (medium confidence) | — |
| Anything unrecognized | top-level entries not matched above | — | explicit placement-decision task |

Pre-fill rule: only strong evidence sets a default, every default prints its provenance ("detected X in Y"), and the developer confirms or overrides in the normal prompt flow. Pattern is deliberately left blank unless evidence is strong — wrong pattern is the costliest wrong default. `--yes` works when scan plus flags fill everything (inherits `create` semantics).

### D3: Staging copy at `migration/legacy/`

The legacy source is copied (filtered: no `.git`, `node_modules`, virtualenvs, `__pycache__`, build outputs) into `migration/legacy/` inside the scaffold, and the generated `.gitignore` covers it. Rationale: the emitted tasks reference material *inside* the workspace the agent operates in — self-contained, immune to the legacy directory moving, no cross-root agent work. Rejected alternative: referencing the sibling path from tasks (fragile paths, two-root workspace). The final emitted task deletes the staging directory, so it never outlives the migration. Trade-off accepted: temporary disk duplication.

### D4: The plan is an OpenSpec change, produced by templates

When the selected spec workflow is OpenSpec, migrate writes `openspec/changes/migrate-to-liftoff/` (proposal.md + tasks.md) into the scaffold via the normal artifact pipeline — the emitted change is itself part of the render, not a side effect. Tasks are seeded one-per-scan-finding with source paths in `migration/legacy/...` and destinations in the Liftoff layout, ordered: dependencies → config → code → tests → CI → cleanup. Completion gate stated in the proposal text: all tasks checked, `liftoff validate` and `liftoff doctor` green, scaffold tests pass, change archived (the L2 certificate). When the workflow is spec-kit, the same plan is emitted as `MIGRATION.md` (v1 fallback; a spec-kit-native emission is future work). Resumability costs nothing: a half-done migration is an open change with unchecked tasks.

### D5: History preservation is an instruction, not a feature

Migrate prints the optional recipe (copy the legacy `.git` directory into the scaffold, commit the migration on top; git rename detection preserves file history) instead of manipulating repositories itself. Rationale: zero risk of corrupting the user's repo, zero code, and the step is genuinely optional. Never assumes legacy root == git root.

### D6: Non-destructiveness is tested, not promised

The end-to-end test hashes the legacy fixture tree before and after a full migrate run and asserts byte-for-byte equality. This is the property the whole design leans on, so it gets a test, not a comment.

## Risks / Trade-offs

- [Scan misses something in an unusual repo layout] → The catch-all rule (every unrecognized top-level entry becomes a placement task) bounds the failure to "developer decides," never "silently dropped."
- [Staging copy of a huge legacy repo] → Filters exclude the heavy directories (deps, VCS, build outputs); if real repos still hurt, a size warning is a cheap follow-up.
- [Emitted change collides with an existing `migrate-to-liftoff` name] → Cannot happen inside one scaffold (fresh directory); re-running migrate creates a new scaffold.
- [Legacy project keeps evolving during a long migration] → The staging copy is a snapshot; the printed next-steps note says to freeze or re-sync manually. Accepted v1 ceiling.
- [Pattern pre-fill guesses wrong] → Mitigated by the blank-over-wrong rule and prompt confirmation; the developer always sees and approves the plan before generation.

## Migration Plan

Ships in the 0.2.x line after `add-manifest-v2` (migrated projects are born with v2 manifests). Archive `add-update-command` first — both changes modify the same CLI command-surface requirement. No rollback concerns: the command only creates new directories.

## Open Questions

None — scaffold-first vs in-place, staging vs sibling reference, scan-pre-fill in v1, command name, and emission format were all resolved during exploration.
