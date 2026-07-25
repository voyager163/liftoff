## 1. Workload Model and CLI Inputs

- [x] 1.1 Add the `power-apps-code-app` catalog identifier, starter metadata, optional Code Apps plugin preference, and discriminated GenAI, standard API, and Power Apps workload plan types.
- [x] 1.2 Refactor common project-plan consumers to use shared identity and workload narrowing instead of unconditional API stack, provider, region, frontend, and environment fields.
- [x] 1.3 Add `--type genai|standard|power-apps-code-app` and Power Apps plugin preference flags to command definitions, help metadata, and option mapping.
- [x] 1.4 Preserve `--genai`, `--no-genai`, `--pattern`, and `--api` inference while rejecting contradictory `--type` combinations and Power Apps-inapplicable flags before probes.
- [x] 1.5 Reject Power Apps migration before source copying or destination creation with fresh-initialization guidance.
- [x] 1.6 Extend JSON configuration loading and merge precedence with strict workload-specific field validation and no ignored Power Apps API fields.
- [x] 1.7 Make planning and plan-summary entries workload-aware, including starter identity, deferred environment binding, selected agents, applicable default agent, and optional plugin preference.
- [x] 1.8 Add focused parser, help, configuration, planner, and invalid-combination tests for all three workload types and legacy commands.

## 2. Manifest V4 and Compatibility

- [x] 2.1 Define schema-v4 manifest types with common framework/agent identity and a discriminated workload object.
- [x] 2.2 Implement strict v4 parsing for GenAI, standard API, and Power Apps fields, immutable starter source identity, canonical agents, plugin preference, and inapplicable-field rejection.
- [x] 2.3 Preserve existing v2 and v3 validators and normalize valid legacy flat identity into the internal GenAI or standard workload union without fabricating integrations.
- [x] 2.4 Update manifest serialization to write only v4 while preserving path-part, content-hash, framework ownership, seed exclusion, and deterministic-order contracts.
- [x] 2.5 Update configuration/manifest identity comparison and validation helpers to compare normalized workload identity explicitly.
- [x] 2.6 Add valid and malformed v2, v3, and v4 fixtures covering all workloads, unknown versions, mutable starter refs, missing fields, extra fields, and canonical agent order.
- [x] 2.7 Expand append-only identifier and logical-artifact contract snapshots with representative Power Apps output without renaming existing identifiers.

## 3. Official Starter Asset Supply Chain

- [x] 3.1 Select and record a tested immutable `microsoft/PowerAppsCodeApps` commit for `templates/starter`, including upstream repository, path, license, and attribution.
- [x] 3.2 Vendor only the explicit starter source file set under package assets, excluding Git metadata, caches, dependencies, build output, environment bindings, credentials, and mutable generated state.
- [x] 3.3 Produce a deterministic root `package-lock.json` for the pinned package metadata on the supported Node.js baseline and verify package/lock root identity.
- [x] 3.4 Add a checked-in source catalog containing portable path parts, stable logical names, upstream hashes, and the selected commit for every vendored file.
- [x] 3.5 Implement a package-safe asset loader using `import.meta.url`, explicit catalog lookup, and Node path utilities rather than directory pattern inference.
- [x] 3.6 Add a maintainer refresh command that downloads a requested immutable commit, verifies license/provenance, shows the source diff, regenerates the lock/catalog, and never runs during user initialization.
- [x] 3.7 Extend package contents and smoke checks so the starter assets, source catalog, lockfile, and attribution ship in the npm tarball.
- [x] 3.8 Verify the pinned snapshot installs, lints, and builds unchanged before accepting its recorded commit and checksums.

## 4. Power Apps Rendering and Generated Project Contract

- [x] 4.1 Refactor top-level artifact construction into explicit GenAI, standard API, and Power Apps workload renderers plus shared manifest/framework phases.
- [x] 4.2 Implement the Power Apps renderer from the explicit asset catalog, including allowlisted project-name substitutions and stable logical artifacts for every file.
- [x] 4.3 Generate Power Apps `liftoff.config.json`, v4 manifest, root application guidance, `.gitignore`, and Microsoft attribution without API, cloud, Docker, environment, or infrastructure fields.
- [x] 4.4 Ensure Power Apps output never fabricates `power.config.json`, tenant/environment identifiers, connections, solutions, credentials, or tokens.
- [x] 4.5 Generate exact root `npm ci`, local development, and `npx --no-install power-apps init` next steps with a clear authentication and environment-binding boundary.
- [x] 4.6 Make OpenSpec seed and Spec Kit constitution content describe React, Vite, TypeScript, Power Apps SDK/Vite integration, connector-first data access, generated services, and root folder rules.
- [x] 4.7 Add deterministic double-render, portable path, expected tree, license attribution, source identity, and no-forbidden-API-output tests for Power Apps.
- [x] 4.8 Add new-child and exact-Git-root staging tests covering conflicts, overwrite consent, structural blockers, rollback, and no same-named child directory.
- [x] 4.9 Confirm existing GenAI and standard API artifact sets change only for the intentional v4/common-model evolution.

## 5. Interactive Workload and Agent Selection

- [x] 5.1 Add `@inquirer/prompts` to package and lock metadata and dynamically load it only for the real-TTY agent selector.
- [x] 5.2 Refactor line input ownership so the line reader can release the input before a raw TTY prompt and resume safely for later questions.
- [x] 5.3 Replace the binary GenAI question with a workload choice and route GenAI, standard API, and Power Apps questions into a shared spec/agent tail.
- [x] 5.4 Add read-only pre-prompt agent discovery and configured-marker discovery through existing injected runner and framework definitions.
- [x] 5.5 Implement the TTY checkbox with Up/Down navigation, Space toggle, Enter validation, configured/detected labels, at-least-one validation, and canonical result ordering.
- [x] 5.6 Preserve the comma-separated line fallback for redirected or injected non-TTY input and bypass all selectors when options or configuration already provide agents.
- [x] 5.7 Keep Spec Kit default-agent selection after multi-selection and add the Power Apps-only preview-plugin preference with a disabled default.
- [x] 5.8 Handle Ctrl+C, EOF, prompt validation, terminal cleanup, and cancellation before destination writes without weakening existing successful decline behavior.
- [x] 5.9 Add mocked real-TTY interaction tests, redirected-input regression tests, rich/compact/plain/no-color snapshots, and Windows Terminal key/stream coverage.

## 6. Workstation Readiness, Dependencies, and Preview Plugin

- [x] 6.1 Extend requirement selection for Power Apps with the tested Node.js LTS minimum, selected framework, and selected agents while omitting Python, Go, Docker, OpenTofu, Azure CLI, and backend-only tools.
- [x] 6.2 Add the Power Apps root `npm ci` dependency plan with Windows `npm.cmd`, project-root working directory, protected package/lock files, and exact resume command.
- [x] 6.3 Validate Power Apps SDK, Vite plugin, and npm CLI declarations from package metadata before dependencies and probe the installed CLI only with `npx --no-install`.
- [x] 6.4 Add pinned Code Apps marketplace/plugin metadata and Power Apps-only preference handling without treating host plugin state as proof stored in the manifest.
- [x] 6.5 Add allowlisted read-only plugin-list probes per selected agent where supported, with ready, missing, and not-observable advisory states.
- [x] 6.6 Provide targeted manual marketplace guidance when requested plugin setup is unresolved and ensure `--install-tools` cannot run Microsoft's broad installer or slash commands.
- [x] 6.7 Update readiness, consent, completion, and plan presentation for Power Apps requirements, root dependencies, deferred environment binding, and optional plugin state.
- [x] 6.8 Add tests for missing/outdated Node.js, declined blocking installs, declined dependencies, protected-file mutation, missing global PAC/Power Apps commands, and non-blocking plugin outcomes.

## 7. Official Framework and Agent Integration

- [x] 7.1 Remove API-plan assumptions from common framework selection, staging, validation, and completion code while retaining allowed-root and nested-Git protections.
- [x] 7.2 Verify Power Apps OpenSpec initialization passes one or both selected tools in stable order and validates all expected markers.
- [x] 7.3 Verify Power Apps Spec Kit initialization uses the selected default, installs every secondary integration, and preserves the recorded default.
- [x] 7.4 Add framework-failure and missing-marker tests proving the staging directory is removed and the Power Apps destination remains unchanged.
- [x] 7.5 Verify configured framework markers feed agent preselection without confusing a general `.github` or `.claude` directory for a configured integration.

## 8. Validation, Doctor, and Operational Helpers

- [x] 8.1 Extend `liftoff validate` for v4 Power Apps identity, source metadata, named starter artifacts, package/lock pairing, and selected framework markers.
- [x] 8.2 Make doctor derive Power Apps checks from the shared workload-aware registry and omit undeclared cloud, Docker, OpenTofu, API runtime, database, and environment checks.
- [x] 8.3 Add read-only doctor checks for starter provenance, SDK/Vite declarations, Node.js baseline, dependency presence, and `npx --no-install power-apps --version`.
- [x] 8.4 Add requested Code Apps plugin doctor advisories per selected host with no configuration writes and no failure exit caused solely by plugin state.
- [x] 8.5 Make `liftoff dev` print the Power Apps root development command and dependency prerequisite instead of Docker Compose.
- [x] 8.6 Make `liftoff infra` report Power Platform hosting as not applicable without printing or executing OpenTofu commands.
- [x] 8.7 Add human and JSON doctor/validate snapshots for ready, missing, skipped, advisory, malformed, and no-network Power Apps states.

## 9. Power Apps Update Reconciliation

- [x] 9.1 Make update load Power Apps desired state, compare immutable workload/source identity, and reject workload-kind or user-edited source changes before artifact access.
- [x] 9.2 Re-render the packaged starter by explicit logical name and classify clean, new, missing, upgrade, moved, conflict, and orphan states without upstream network access.
- [x] 9.3 Reconcile valid Code Apps plugin preference changes only through named generated guidance and manifest intent, without generating API artifacts.
- [x] 9.4 Normalize v2/v3 projects for check mode and write v4 only after successful apply while preserving legacy framework uncertainty and skipped-conflict hashes.
- [x] 9.5 Add Power Apps update tests for clean state, upstream refresh, developer conflict, force, move, orphan, offline operation, retry after failure, and v3-to-v4 apply.

## 10. README and Progressive Documentation

- [x] 10.1 Create an accessible static Liftoff terminal visual derived from the existing wordmark and verify readable light/dark rendering and alternative text.
- [x] 10.2 Rewrite the root README as a concise landing page with value proposition, factual badges, interactive install/init quick start, three workloads, two frameworks, two agents, exact-Git-root behavior, and safety summary.
- [x] 10.3 Add getting-started and workload documentation for GenAI, standard API, and Power Apps question flows, outputs, prerequisites, and deferred actions.
- [x] 10.4 Add spec-workflow/agent, existing-repository, workstation prerequisite, and target/consent safety guides.
- [x] 10.5 Add CLI lifecycle/reference, generated structure, configuration/manifest, Azure deployment, and troubleshooting guides by moving and reconciling current README detail.
- [x] 10.6 Move contributor build, test, packaging, release, and recovery detail to `CONTRIBUTING.md` without duplicating end-user onboarding.
- [x] 10.7 Include `/docs` and README assets in the npm package and add tests for every root README relative link, required first-use command, and packed target.

## 11. End-to-End and Cross-Platform Verification

- [x] 11.1 Run targeted parser, planner, manifest, renderer, prompt, readiness, framework, doctor, helper, update, and documentation tests and resolve regressions.
- [x] 11.2 Generate a fresh Power Apps project, run root `npm ci`, lint, and production build, and confirm package metadata remains unchanged.
- [x] 11.3 Exercise OpenSpec and Spec Kit Power Apps initialization with Copilot only, Claude only, and both agents including each Spec Kit default.
- [x] 11.4 Run the full existing `npm run check` and package smoke suite with the new dependency, assets, docs, and manifest fixtures.
- [x] 11.5 Verify Linux, macOS, and Windows CI, including platform path handling, `npm.cmd`, TTY fallback tests, packaged assets, and Power Apps generated-project checks.
- [x] 11.6 Run strict OpenSpec validation for this change and every affected main specification before implementation is declared complete.
