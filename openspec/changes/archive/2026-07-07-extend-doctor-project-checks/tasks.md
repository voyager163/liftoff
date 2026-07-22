# Tasks: extend-doctor-project-checks

## 1. Check runner

- [x] 1.1 Restructure `doctorCommand` in `src/commands.ts` into a layered check runner: checks yield `ok`/`warn`/`fail`/`skipped` with label, detail, and optional remedy; layers render grouped with `[ok]`/`[warn]`/`[fail]` markers and a summary line
- [x] 1.2 Preserve the existing environment checks (node, python3, docker, tofu) as the environment layer, unchanged in behavior
- [x] 1.3 Implement exit-code model: 0 when at most warnings, 1 on any failure
- [x] 1.4 Add `--json` output: `schemaVersion`, per-layer results with severities and remedies, summary counts

## 2. Project layer

- [x] 2.1 Adopt the shared project-root discovery helper; no project found → environment layer only (plus `--cloud` behavior as today)
- [x] 2.2 Manifest check: load via the v2 loader (unsupported version → fail with remedy) and run the presence validation, reporting missing artifacts as failures
- [x] 2.3 Version freshness: compare manifest `liftoffVersion` with the running CLI (semver-aware); npm registry lookup for a newer published version with a ~2s timeout, silent skip on any failure
- [x] 2.4 Drift line: run the reconcile check classification and emit a single warn with the count and `run liftoff update` when drift exists

## 3. Runtime and cloud layers

- [x] 3.1 Runtime checks: `.env` present when `.env.example` exists (fail with copy remedy); `docker compose config -q` when a compose file exists and docker is available; report skipped-with-reason when prerequisites are missing
- [x] 3.2 Cloud checks as a provider-keyed map: azure → `az` binary presence (fail with install remedy) then `az account show` auth (fail with `az login` remedy); provider read from the manifest, `--cloud` as override
- [x] 3.3 Worker-enabled Azure projects: Azure Functions Core Tools presence check at warn severity with install remedy

## 4. Tests

- [x] 4.1 Context selection: outside a project only the environment layer runs; inside a generated fixture project all layers run; root discovery works from a subdirectory
- [x] 4.2 Severity and exit codes: warn-only run exits 0; a failure (e.g., missing `.env` with `.env.example` present) exits 1 with the remedy printed
- [x] 4.3 Drift warn line appears with the correct count against a drifted fixture and is absent when clean
- [x] 4.4 Freshness lookup soft-fails: simulate network failure and assert clean output with no freshness line
- [x] 4.5 `--json` shape: `schemaVersion` present, layers and summary populated; expected paths built with `path.join`
- [x] 4.6 Run `npm run check`
