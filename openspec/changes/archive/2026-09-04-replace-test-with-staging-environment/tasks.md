## 1. Replace the environment contract

- [x] 1.1 Replace `EnvironmentId` and the environment catalog with `dev`, `staging`, and `prod`; verify catalog lookup accepts those values and rejects `test`
- [x] 1.2 Centralize the ordered default environment list and use it in planner, interactive prompt, and CLI help; verify every default resolves to `dev,staging,prod`
- [x] 1.3 Validate infrastructure helper environment input through the catalog; verify `--env staging` renders `staging.tfvars` and `--env test` exits without helper output

## 2. Update generated artifacts

- [x] 2.1 Generate staging runtime and worker configuration paths and provisioning groups; verify default manifests and desired state contain `dev`, `staging`, and `prod`
- [x] 2.2 Generate `staging.tfvars` and staging-derived logical names instead of test-derived names; verify no current generated artifact uses a retired test environment identity
- [x] 2.3 Preserve platform-neutral path-part construction for environment artifacts; verify path and lifecycle tests pass on the supported CI matrix

## 3. Align contracts and guidance

- [x] 3.1 Update CLI, scaffold, infrastructure, and manifest delta specs with the canonical set and explicit `test` rejection; verify strict OpenSpec validation passes
- [x] 3.2 Update CLI, project-structure, configuration, troubleshooting, and contributor guidance with staging defaults and the manual migration remedy
- [x] 3.3 Update current manifest and logical-name fixtures to staging while preserving genuine software-test commands and identifiers

## 4. Validate the patch

- [x] 4.1 Add planner, configuration, manifest, and helper-command rejection tests for retired `test`; verify each fails before writes
- [x] 4.2 Refresh only affected help, lifecycle, and maintenance snapshots and rerun them without update mode
- [x] 4.3 Run `npm run check`, strict main and change spec validation, package smoke, and standard generated-template verification
