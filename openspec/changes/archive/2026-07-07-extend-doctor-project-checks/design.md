# Design: extend-doctor-project-checks

## Context

Doctor is the command developers should be able to run reflexively — before `dev up`, before `infra apply`, when anything feels off. Today it checks four binaries and optionally `az` auth behind a flag. Manifest v2 gives doctor a project identity to read (cloud, pattern, frontend, version), and the update engine gives it a drift signal for free. The division of labor across the command family: `validate` = is the structure intact (pure subset), `doctor` = can this project fly from here (superset, read-only), `update` = make it current (the only in-place writer).

## Goals / Non-Goals

**Goals:**

- One read-only preflight covering environment, project, runtime, and cloud, configured by the manifest instead of flags.
- Zero behavior change outside a generated project.
- Every non-ok finding ships its remedy as a printed one-liner.

**Non-Goals:**

- No `--fix` and no writes of any kind — the moment doctor mutates, it stops being safe to run reflexively.
- No code quality checks (linting, dependency audits, security scanning) — readiness only; other tools own quality.
- No blocking network dependence — doctor must be fully useful offline.
- No new drift UI — doctor surfaces a count and defers to `liftoff update` for the detail.

## Decisions

### D1: Four layers, selected by context

Environment → Project → Runtime → Cloud. Root discovery (shared helper from `add-update-command`) determines context: no project found → environment layer only, plus cloud when `--cloud` is passed (exactly today's behavior); project found → all layers run. Rationale: doctor never asks for what it can discover, and existing muscle memory outside projects is preserved.

### D2: The manifest configures the checks

Inside a project, the manifest drives what runs: `project.cloud` selects the cloud checks (`--cloud` demotes to an override), a worker-enabled Azure pattern adds an Azure Functions Core Tools presence check (warn), `frontend: true` leans on the existing node check. Alternative considered: keeping `--cloud` required (rejected — the project already knows its provider; flags for discoverable facts are friction).

### D3: Cloud checks live in a provider-keyed map

`{ azure: [azAuthCheck, ...] }` — a plain map from provider id to check list, not an adapter layer. AWS/GCP get entries when their provider adapters land. Rationale: same line count as inline code today, and the aws change becomes additive instead of surgical.

### D4: Severity model and exit codes

Each check yields `ok`/`warn`/`fail` plus an optional remedy line. Warn = degraded but usable (newer CLI available, drift exists, tofu missing when infra isn't in play); fail = the project cannot fly (manifest invalid, `.env` missing, required tool absent, cloud unauthenticated). Exit 0 when only warnings, 1 on any fail — CI can gate on doctor without warnings blocking merges. `--json` emits `{ schemaVersion: 1, layers: [...], summary }`.

### D5: Drift is one warn line, not a report

Doctor invokes the reconcile classification in check mode and prints `[warn] scaffold drift: N updates available — run 'liftoff update'`. Rationale: doctor is where developers discover update exists; the full diff belongs to update itself. No duplicated rendering logic — same engine, count only.

### D6: Network checks are best-effort with a short timeout

The npm registry lookup ("newer CLI available") uses a short timeout and degrades to silence on any failure — offline doctor output is indistinguishable from up-to-date doctor output except for the missing warn. Rationale: a preflight that hangs on airplane wifi trains people not to run it.

### D7: Runtime checks degrade honestly

`.env` presence is checked against `.env.example` existing; `docker compose config -q` runs only when a compose file exists and docker is present — otherwise the runtime layer emits a warn explaining what was skipped and why, rather than a false ok or a hard fail.

## Risks / Trade-offs

- [Doctor's scope creeps toward a linter over time] → The Non-Goals line is explicit: readiness, not quality; new checks must name what "cannot fly" means.
- [npm lookup adds latency] → Short timeout (~2s), async alongside local checks where possible, silent skip; measured against the reflexive-use bar.
- [`az account show` distinguishes poorly between CLI-absent and unauthenticated] → Two separate checks: binary presence (fail with install remedy) then auth (fail with `az login` remedy); absence short-circuits auth.
- [Drift check cost on large projects] → It is an in-memory render plus hash comparisons (no writes); if it ever measures slow, a `--fast` skip flag is the cheap follow-up.

## Migration Plan

Ships after `add-update-command` (consumes root discovery and the reconcile engine; also modifies the root-discovery requirement introduced there). No stored-format changes; rollback is reverting the command body — the prior doctor behavior remains a strict subset.

## Open Questions

None — layer model, read-only stance, drift line, and network soft-fail were resolved during exploration.
