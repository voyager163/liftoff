## 1. Generated Function Worker Scaffold

- [x] 1.1 Add Azure Functions worker artifact generation to `src/templates.ts` using the existing path-parts artifact helper.
- [x] 1.2 Generate `functions/<pattern>-worker` only for catalog patterns with worker support and omit it for non-worker patterns.
- [x] 1.3 Include Function app runtime files, local settings examples, trigger adapter code, tests, and functions documentation in the generated artifacts.
- [x] 1.4 Ensure generated Function adapters remain thin and reference shared backend orchestration or messaging boundaries without duplicating GenAI logic.

## 2. Environment, Infrastructure, and Governance Output

- [x] 2.1 Generate Function-specific environment templates for each selected environment without committed secrets.
- [x] 2.2 Extend Azure OpenTofu generation to include Function app hosting, required storage, managed identity wiring, app settings, and worker outputs.
- [x] 2.3 Update generated OpenTofu variables, tfvars, outputs, and README content for Function worker configuration.
- [x] 2.4 Update generated OpenSpec and Spec Kit governance content so worker-enabled projects describe the `functions/<worker-name>` boundary.
- [x] 2.5 Update generated project documentation to distinguish `backend/workers` from Azure Functions workers and explain shared orchestration placement.

## 3. Manifest, Tests, and Validation

- [x] 3.1 Update manifest expectations so every generated Function artifact is tracked with path parts rather than platform-specific path strings.
- [x] 3.2 Add tests for worker-enabled patterns, non-worker patterns, frontend-enabled generation, and frontend-disabled generation.
- [x] 3.3 Add cross-platform path coverage for generated Function paths, including Windows path handling or Windows CI verification where the project supports it.
- [x] 3.4 Update generated project validation to accept the new Function artifacts and reject missing manifest-tracked Function files.
- [x] 3.5 Run `npm run check` and confirm the Liftoff package build and tests pass.