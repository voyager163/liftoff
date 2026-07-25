## 1. Shared Completion Presentation

- [x] 1.1 Add a shared `Next recommended command` renderer that wraps the existing copyable `$`-prefixed command without rewriting its value.
- [x] 1.2 Route the optional completion recommendation through the new semantic renderer and rename internal parameters to express recommendation rather than execution.
- [x] 1.3 Preserve completion behavior when no recommendation is supplied and suppress all decorative recommendation output in JSON mode.

## 2. Presentation and Workflow Coverage

- [x] 2.1 Unit-test full, compact, and plain recommendation rendering, including exact quoted Windows paths, arguments, and `&&` operators.
- [x] 2.2 Unit-test color/no-color visible text, exact long-command preservation, heading-width stability, JSON suppression, and omission when no recommendation exists.
- [x] 2.3 Refresh initialization and migration lifecycle snapshots so their validation commands appear under the explicit recommendation label.
- [x] 2.4 Refresh update completion snapshots and assertions for the labeled `liftoff validate && liftoff doctor` recommendation.
- [x] 2.5 Confirm command runners receive no additional execution when completion renders a recommendation.

## 3. Documentation

- [x] 3.1 Update the CLI terminal-presentation documentation to explain that completion recommendations are suggestions and are not executed automatically.
- [x] 3.2 Add documentation assertions for the recommendation label and developer-controlled execution.

## 4. Validation

- [x] 4.1 Run targeted terminal, lifecycle, update, maintenance-presentation, and documentation tests together.
- [x] 4.2 Run the repository build, full test suite, package smoke, and generated-project verification commands already defined by the project.
- [ ] 4.3 Run the existing Windows CI coverage and confirm recommendation labels, quoted paths, and terminal widths match macOS and Linux.
- [x] 4.4 Validate `clarify-next-command-guidance` and all main OpenSpec specifications in strict mode.
