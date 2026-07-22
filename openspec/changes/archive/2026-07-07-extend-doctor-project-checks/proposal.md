# Proposal: extend-doctor-project-checks

## Why

`liftoff doctor` today answers only "are four binaries on the PATH" — it is blind to the project it runs in. With manifest v2 and the update engine in place, doctor can answer the question its name promises: can this project actually fly, from here, right now — environment, project structure, runtime readiness, and cloud auth in one read-only preflight.

## What Changes

- `liftoff doctor` becomes layered and context-aware:
  - **Environment** (existing checks, unchanged): node, python3, docker, tofu.
  - **Project** (when run inside a generated project, located via root walk-up): manifest loads and validates (structure check), version freshness (manifest `liftoffVersion` vs running CLI; npm registry lookup for a newer CLI, soft-failing silently offline), and scaffold drift surfaced as a single warn line with a count, powered by the update engine's check classification.
  - **Runtime**: `.env` present when `.env.example` exists; `docker compose config` parses (skipped with a warn when docker is missing).
  - **Cloud**: provider read from the manifest (`--cloud` becomes an override; outside a project it behaves as today), checks keyed by a per-provider map — Azure checks `az` auth; AWS/GCP slot in when their adapters land. Worker-enabled Azure projects additionally warn when Azure Functions Core Tools are missing.
- Severity model: `ok` / `warn` / `fail` per check; every non-ok line prints its one-line remedy. Exit 0 when only warnings, 1 on any failure.
- Doctor remains strictly read-only — no `--fix`, no writes, safe to run reflexively. Network checks never block: short timeout, silent skip on failure.
- `--json` output with `schemaVersion`, per the contract conventions.
- Outside a generated project, behavior is today's: environment checks plus optional `--cloud` checks.

## Capabilities

### New Capabilities

- `liftoff-project-doctor`: Layered, manifest-aware, read-only diagnostics — check layers, severity and exit-code model, remedies, drift surfacing, provider-keyed cloud checks, and JSON output.

### Modified Capabilities

- `liftoff-project-update`: The project-root discovery requirement extends to `doctor` alongside `update` and `validate`. (Archive `add-update-command` first.)

## Impact

- `src/commands.ts`: `doctorCommand` restructured into a layered check runner; existing environment checks preserved as the first layer.
- Reuses: manifest loader (`add-manifest-v2`), root discovery and reconcile check classification (`add-update-command`).
- New provider-keyed cloud-check map (azure today; aws/gcp entries when providers land).
- Tests: layer selection by context (inside vs outside a project), severity/exit-code model, drift warn line, `.env`/compose runtime checks, offline soft-fail for the npm lookup, `--json` shape.
- Depends on `add-manifest-v2` and `add-update-command`.
