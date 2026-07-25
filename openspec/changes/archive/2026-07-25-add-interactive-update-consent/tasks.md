## 1. Impact Model

- [x] 1.1 Add a pure update-impact model that classifies safe creates, restores, replacements, clean moves, recorded-state refreshes, conflicts, managed old-path removals, and preserved orphans from one reconciliation result.
- [x] 1.2 Add an explicit logical-name inventory for generated dependency-definition artifacts across Python, Node.js, Go, frontend, and Power Apps workloads.
- [x] 1.3 Unit-test every impact category, stable portable path ordering, dependency-artifact detection, local-edit risk counts, manifest refresh, and the no-install/no-orphan-deletion invariants.

## 2. Interactive and Presentation Plumbing

- [x] 2.1 Refactor shared interactive-terminal detection so line prompts require TTY input and output while checkbox prompts retain their raw-mode requirement.
- [x] 2.2 Pass stdin explicitly from the CLI entry point through the existing command context and add fake-TTY test streams without changing ordinary capture-stream behavior.
- [x] 2.3 Add update-specific impact and safe-apply confirmation presentation with a default-No answer.
- [x] 2.4 Add stable exact-path conflict disclosure, the no-post-success-backup warning, commit-first guidance, and a separate default-No overwrite confirmation.
- [x] 2.5 Update plain, rich, color, no-color, and narrow-terminal presentation snapshots for the new impact and consent surfaces.

## 3. Update Orchestration

- [x] 3.1 Preserve non-interactive and redirected `liftoff update` as read-only drift checks with exit code 2 and existing apply-command guidance.
- [x] 3.2 Preserve prompt-free `--json`, `--apply`, and `--apply --force` behavior and reject `--force` without `--apply`.
- [x] 3.3 Render the drift report and impact, show any dirty-worktree warning before consent, and collect all interactive decisions before preflight or mutation.
- [x] 3.4 Translate accepted safe and conflict permissions into one existing rollback-capable update transaction without broadening path, ownership, or manifest guards.
- [x] 3.5 Handle safe decline, conflict-only decline, prompt cancellation, recorded-state-only drift, and orphan-only drift with the specified exit codes and mutation-free outcomes.
- [x] 3.6 Cover safe acceptance, safe decline, mixed safe/conflict consent, accepted overwrite, declined overwrite, conflict-only drift, orphan-only drift, cancellation, and dirty Git state in command tests.
- [x] 3.7 Cover API, GenAI, and Power Apps update fixtures so interactive consent does not change workload identity, offline starter, conflict, or manifest-normalization contracts.

## 4. Documentation

- [x] 4.1 Update the CLI reference, safety and consent guide, troubleshooting guide, and existing-repository guide with interactive, redirected, JSON, explicit apply, exit-code, backup, dependency-installation, and orphan behavior.
- [x] 4.2 Update generated project update guidance to describe same-invocation consent and the separate local-conflict overwrite decision.
- [x] 4.3 Update documentation and template assertions so packaged guidance no longer claims that every plain `liftoff update` invocation is unconditionally read-only.

## 5. Validation

- [x] 5.1 Run the targeted impact, update, interactive, terminal presentation, generated-template, and documentation tests together.
- [x] 5.2 Run the repository type-check, lint, full test suite, package smoke, and generated-project verification commands already defined by the project.
- [x] 5.3 Run the existing Windows CI coverage and confirm TTY gating, portable displayed paths, and platform-correct filesystem resolution match macOS and Linux.
- [x] 5.4 Validate `add-interactive-update-consent` and all main OpenSpec specifications in strict mode.
