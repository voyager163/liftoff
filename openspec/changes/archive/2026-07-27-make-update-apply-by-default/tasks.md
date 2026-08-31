## 1. Command Surface and Mode Selection

- [x] 1.1 Remove the update `--apply` flag from the explicit command definition, add the boolean `--check` flag, and update command help grouping and descriptions.
- [x] 1.2 Add actionable strict-parser guidance for removed `liftoff update --apply` and `--apply --force` invocations before any project discovery, probes, or filesystem access.
- [x] 1.3 Reject `liftoff update --check --force` as an incompatible mode combination while allowing direct `liftoff update --force`.
- [x] 1.4 Replace TTY-derived update mode selection with explicit `--check` mode; route plain, redirected, non-interactive, and JSON update invocations to safe apply by default.
- [x] 1.5 Remove update-specific safe-action and conflict-overwrite prompts, prompt-only snapshots, cancellation branches, and dead interactive impact code without affecting initialization consent flows.

## 2. Apply, Check, Force, and JSON Behavior

- [x] 2.1 Reuse the existing transactional apply path for plain `liftoff update`, preserving safe new/missing/upgrade/move/hash-refresh writes, manifest refresh, dirty-worktree warnings, and exit code 0 on successful reconciliation.
- [x] 2.2 Preserve conflict skipping and orphan reporting in default update, and make direct `--force` overwrite only the exact guarded conflicts while retaining project-boundary and collision checks.
- [x] 2.3 Route `liftoff update --check` to the existing human drift report with no preflight or mutation, exit 0 when clean, exit 2 on all drift classes, and guidance naming plain update or reviewed `--force`.
- [x] 2.4 Make `liftoff update --json` perform safe apply and emit the versioned apply object; make `liftoff update --check --json` emit the versioned read-only state/summary object with byte-pure stdout.
- [x] 2.5 Replace every runtime remedy, skipped-conflict hint, doctor message, completion recommendation, and generated guidance string that names `--apply` with the new update/check/force matrix.
- [x] 2.6 Verify configuration drift, Power Apps packaged updates, legacy v2/v3 normalization, seed exclusion, framework ownership, and manifest v4 rewrites use the new default apply and explicit check semantics.

## 3. Regression and Safety Coverage

- [x] 3.1 Refactor update tests so plain update applies safe changes in TTY, redirected-input, redirected-output, and ordinary non-interactive harnesses without prompting.
- [x] 3.2 Add parser and no-side-effect tests for removed `--apply`, removed `--apply --force`, valid direct `--force`, and invalid `--check --force`.
- [x] 3.3 Add check-mode tests for clean, safe-drift, conflict-only, orphan-only, redirected, subdirectory, and explicit-project-path cases with unchanged bytes and 0/2 exit codes.
- [x] 3.4 Add JSON tests proving default apply output and `--check --json` drift output have the correct mode, schema version, written/skipped/state fields, exit codes, and byte-pure stdout.
- [x] 3.5 Preserve and update failure tests for path preflight, symlink/project-boundary rejection, transaction rollback, write failure, move cleanup failure, manifest failure, retry convergence, and dirty-worktree warnings.
- [x] 3.6 Update configuration, manifest migration, Power Apps, seed lifecycle, framework ownership, and generated-project tests to use plain update or explicit check as appropriate.
- [x] 3.7 Update help, maintenance-presentation, complete-screen, plain, compact, rich, color, and no-color snapshots after reviewing every changed command and guidance line.
- [x] 3.8 Run update and path-sensitive coverage on Windows, macOS, and Linux CI, including portable relative paths and redirected stream behavior.

## 4. Documentation and Migration Guidance

- [x] 4.1 Update `docs/cli-reference.md` with the imperative command matrix, default apply behavior, direct force, explicit check, JSON mode selection, exit codes, and removed apply migration.
- [x] 4.2 Update safety, existing-repository, configuration/manifest, workload, troubleshooting, spec-workflow, and root/package-linked documentation without weakening conflict, orphan, dependency, backup, or transaction warnings.
- [x] 4.3 Update generated project README/template guidance so newly rendered projects recommend plain update, `--check --json` for automation, and reviewed `--force` for conflicts.
- [x] 4.4 Add documentation and package-smoke assertions that reject active `liftoff update --apply` instructions while allowing clearly labeled historical migration examples.

## 5. Breaking Release Gate

- [x] 5.1 Update package and lockfile versions plus version-bearing snapshots for the `0.7.0` breaking release.
- [x] 5.2 Run focused parser/update/manifest/seed/documentation tests, then the complete root check, package smoke, standard-template verifier, Power Apps verifier, and packed-artifact inspection.
- [x] 5.3 Run strict OpenSpec validation and review the final diff for unintended prompts, check-mode writes, conflict overwrites, orphan deletion, dependency installation, path regressions, stale `--apply` guidance, and inconsistent exit/JSON behavior.
