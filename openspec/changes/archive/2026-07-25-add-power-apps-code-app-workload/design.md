## Context

Liftoff currently represents every project with one `ProjectPlan` that requires an API stack, cloud provider, region, frontend flag, environments, Docker output, and Azure OpenTofu output. `buildArtifacts()` consequently renders API-oriented base files and then adds either GenAI or standard-stack files. Manifest schema v3 persists the same mandatory fields. This model cannot represent a Power Apps code app without inventing API, cloud, region, or infrastructure values that do not belong to the workload.

The framework layer is already more general. OpenSpec accepts all selected agents in one `--tools` invocation, while Spec Kit initializes one selected default integration and installs the other selected integrations. Framework validation is based on workflow and agent markers rather than API structure, so that layer can operate at a Power Apps project root after its governance content becomes workload-aware.

Interactive prompts currently use one line-oriented `readline/promises` iterator with `terminal: false`. Agent selection displays a numbered list and parses comma-separated entries. OpenSpec's current experience instead uses a keypress multi-select where arrows navigate, Space toggles, and Enter confirms. A raw TTY prompt cannot safely share an actively consuming readline iterator.

Microsoft's official `PowerAppsCodeApps/templates/starter` is a React, Vite, TypeScript, Tailwind, and Power Apps SDK starter. Its package ranges and source are mutable on `main`, and it does not currently ship a lockfile or an environment-bound `power.config.json`. Microsoft documents that `@microsoft/power-apps` includes the newer npm-based `power-apps` CLI, while environment initialization, authentication, connection selection, and deployment remain developer- and tenant-specific operations. The official `code-apps-preview` agent plugin is also mutable and preview; its supported installation documentation currently relies on agent-session slash commands or a broad installer that installs all marketplace plugins.

The repository root README is approximately 2,500 words and carries installation policy, CLI reference, terminal contracts, safety semantics, generated-project details, Azure contracts, manifest rules, contributor commands, and release internals. There is no `/docs` hierarchy or README visual asset.

## Goals / Non-Goals

**Goals:**

- Add `power-apps-code-app` as a first-class workload for `plan` and `init`, including exact-Git-root in-place initialization and the existing transactional merge guarantees.
- Keep spec workflow and one-or-more agent selection common to GenAI, standard API, and Power Apps workloads.
- Provide OpenSpec-style Space/Enter multi-selection on real TTYs without changing flags, redirected input, JSON, or test determinism.
- Package a deterministic, attributed snapshot of the official starter and a tested lockfile so initialization does not fetch mutable source.
- Derive only relevant Power Apps workstation, dependency, doctor, and update behavior.
- Evolve persistent project identity without losing v2 or v3 compatibility.
- Present Liftoff through a concise root landing page and move detailed guidance into packaged, linked documentation.

**Non-Goals:**

- Authenticating to Power Platform, choosing or enabling a tenant environment, generating credentials, creating connections, or deploying an app during `liftoff init`.
- Running `npx power-apps init`, `run`, `push`, or connector commands without a separate future consent and authentication design.
- Running Microsoft's broad `curl | node` marketplace installer or the plugin's `/create-code-app` skill.
- Vendoring or rewriting Microsoft agent-plugin skills.
- Adding Power Apps migration from an arbitrary existing application in this change.
- Changing generated GenAI or standard API application behavior except where common plan, manifest, prompt, or documentation contracts must evolve.
- Adding GitHub Pages or a new documentation build system.

## Decisions

### 1. Model common project identity separately from a discriminated workload plan

`ProjectPlan` will retain common identity, spec workflow, selected agents, applicable Spec Kit default agent, framework definition, and target metadata. Workload-specific values will move behind a discriminated union:

```text
WorkloadPlan
├── GenAiWorkload
│   └── pattern, python-fastapi, cloud, region, frontend, environments
├── StandardApiWorkload
│   └── apiStack, cloud, region, frontend, environments
└── PowerAppsCodeAppWorkload
    └── starter source identity and Code Apps plugin preference
```

The public configuration field remains `projectType` for compatibility and gains the canonical value `power-apps-code-app`. Existing GenAI and standard fields remain flat in `liftoff.config.json`; fields that do not apply to the selected type are rejected rather than ignored. Internally, parsing produces the discriminated union before rendering or readiness selection.

This is preferred over making every existing `ProjectPlan` field optional because the union lets TypeScript prove which values exist in every renderer, requirement selector, doctor check, and reconciliation path. It is preferred over sentinel API/cloud values because those values would leak false architecture into manifests, governance, and diagnostics.

### 2. Add `--type` while retaining the existing project-type aliases

Interactive initialization will replace the binary GenAI question with a single choice among:

- GenAI application
- API application
- Power Apps code app

Noninteractive `plan` and `init` will accept `--type genai|standard|power-apps-code-app`. Existing `--genai`, `--no-genai`, `--pattern`, and `--api` inference remain supported. Contradictory combinations fail before probes or writes. Power Apps rejects API stack, GenAI pattern, cloud, region, frontend, and API environment flags because silently accepting them would produce a misleading plan.

This keeps existing automation working while providing an extensible workload selector that does not require another negated boolean for each future workload.

### 3. Keep a common prompt tail for framework and agent integration

Workload-specific questions run first. Every workload then selects OpenSpec or Spec Kit and one or more supported AI coding agents. When Spec Kit has multiple agents, the existing default-agent question remains required.

On a real interactive TTY, the agent prompt dynamically imports `@inquirer/prompts` and uses its checkbox primitive:

- Up/Down changes the active row.
- Space toggles the active agent.
- Enter validates and confirms at least one agent.
- Ctrl+C cancels initialization before destination writes.
- The result is canonicalized back to catalog order, independent of toggle order.

The prompt uses configured integrations as defaults when recognizable markers already exist at an in-place target. Otherwise it preselects agents discovered through existing read-only agent probes; if none are observable, GitHub Copilot remains the compatibility default. Configured, detected, and not-observable labels remain selectable because a missing selected agent is handled later by readiness and consent.

The persistent line reader will become a prompt transport that can release its input before the raw checkbox starts and lazily resume for later questions. Injected streams that are not true TTYs continue using the current comma-separated line selector. `--agents` continues to bypass both interactive selectors.

A custom searchable prompt was rejected because Liftoff currently has two agents; search, selected chips, and pagination add complexity without user value. Hand-written raw key handling was rejected in favor of Inquirer's tested cancellation, cursor, and terminal cleanup.

### 4. Package an immutable official-starter snapshot

Implementation will select and record one tested commit from `microsoft/PowerAppsCodeApps` and copy the explicit `templates/starter` file set into a versioned Liftoff package asset. The asset catalog will include:

- upstream repository, path, and commit;
- an explicit portable path list and content hashes;
- the upstream MIT license and attribution;
- a generated, tested `package-lock.json` matching the snapshot's package metadata.

Runtime initialization reads only this packaged catalog. It does not clone, run `degit`, download a tarball, or consult mutable `main`. Each copied file receives a stable logical artifact name and participates in normal staging, conflict preflight, hashing, validation, and update reconciliation. Project-derived substitutions are limited to an allowlisted set such as package name and generated README content; arbitrary textual replacement is prohibited.

This approach preserves offline planning and deterministic rendering, avoids runtime supply-chain and availability failures, and makes a Liftoff release reproducible. Fetching a pinned archive at runtime was rejected because even immutable network content introduces availability, proxy, and checksum failure paths during initialization. Reimplementing the starter as TypeScript string templates was rejected because it would obscure provenance and make upstream refreshes difficult to review.

### 5. Keep Power Platform environment binding explicit and post-scaffold

The generated project includes the official SDK and Vite plugin, but Liftoff does not fabricate `power.config.json`. The generated README and completion output explain that, after dependency installation, the developer can run the packaged binary with:

```text
npx --no-install power-apps init
```

Using `--no-install` prevents `npx` from downloading an unplanned package. Authentication, environment selection, connection creation, and deployment stay under Microsoft's CLI and the developer's control. Liftoff records no tenant, environment, connection, token, or credential.

The project dependency phase adds one root `npm ci` command and protects both root package metadata files from mutation, matching existing dependency-consent semantics. Power Apps dependency installation is offered only after the scaffold commits successfully. The workload requires a tested Node.js LTS baseline independently from Liftoff's own minimum Node version.

### 6. Reuse framework adapters and make generated governance workload-aware

Framework initialization continues in temporary staging after Liftoff-owned artifacts are present:

- OpenSpec receives every selected agent.
- Spec Kit initializes the selected default agent and installs each additional selected integration.
- Existing framework ownership, allowed roots, no-nested-`.git`, and marker validation remain unchanged.

Only generated seed/governance descriptions become workload-aware. Power Apps governance identifies React, Vite, TypeScript, the Power Apps SDK and Vite plugin, generated connector services, connector-first runtime constraints, and the absence of Liftoff-owned API/Azure infrastructure. This avoids creating a second framework path that would drift from the tested adapters.

### 7. Treat Microsoft's preview Code Apps plugin as an opt-in advisory integration

Power Apps plans expose a `codeAppsPlugin` preference, defaulting to false while the plugin is preview. Interactive users see a short explanation after agent selection; noninteractive users can express the same choice with a Power Apps-only boolean flag. The preference is stored as desired project tooling, not as proof of host installation.

When selected, Liftoff attempts only allowlisted, read-only, agent-native plugin-list probes. Missing or unobservable plugin state is advisory and produces targeted marketplace guidance for each selected agent. The canonical plugin identity comes from a pinned copy of Microsoft's marketplace metadata, currently `code-apps-preview`; display text clearly states Preview.

This change will not automate installation because the currently documented targeted operations are slash commands inside an agent session, while Microsoft's shell installer installs all plugins, installs additional tools, and enables auto-update. If a later stable agent CLI exposes a noninteractive, target-specific, verifiable command, it can be added to the workstation recipe registry under the existing per-tool consent model.

The guidance explicitly says not to run `/create-code-app` inside the generated project because Liftoff already created it. Domain skills such as deployment and connector addition remain available after the developer installs the plugin.

### 8. Write manifest schema v4 and normalize older schemas into the union

New projects and successful `update --apply` operations write manifest schema v4. Common framework fields stay outside a new discriminated `project.workload` object. The workload object carries only fields valid for its kind, including immutable starter source identity and the optional plugin preference for Power Apps.

Readers continue accepting v2 and v3. They validate the old flat shape first and normalize it to GenAI or standard workload identity using the current compatibility rules. They do not fabricate Power Apps identity. V4 readers reject unknown workload kinds and inapplicable fields before artifact access. Existing path, hash, framework-state, agent-order, exit-code, and JSON conventions remain unchanged.

Schema v4 is preferred over silently making v3 fields optional because a downstream reader must be able to distinguish a deliberate workload-specific shape from malformed legacy data. Existing older CLIs already reject unsupported schemas with upgrade guidance.

### 9. Dispatch rendering, readiness, doctor, and update by workload

The top-level artifact builder will dispatch to a workload renderer:

- GenAI and standard renderers retain their current output.
- Power Apps renders the packaged starter, root config/manifest, attribution, and workload-specific documentation.
- Common framework initialization remains a later staging phase.

The Power Apps requirement set includes the selected framework and agents plus the tested Node.js LTS requirement. Docker, OpenTofu, Azure CLI, Python, Go, backend runtimes, and API infrastructure checks are omitted. The project-local Power Apps CLI is verified through package metadata and, when dependencies exist, an allowlisted `npx --no-install power-apps --version` probe.

Doctor derives the same workload-specific requirement set from schema v4, validates starter and framework markers, and reports the optional Code Apps plugin only when requested. Update re-renders the exact workload and source identity, applies existing hash-based reconciliation, and refuses any configured workload-kind or immutable starter-source change with migration guidance.

### 10. Turn the root README into a landing page backed by packaged Markdown docs

The root README will lead with a Liftoff visual identity, concise value proposition, npm/CI/license/runtime badges, one terminal screenshot or lightweight static terminal asset, a two-command interactive quick start, supported workload summary, spec/agent integrations, existing-Git behavior, and a short safety summary.

Detailed content moves into plain Markdown under `/docs`, including getting started, workloads, spec workflows and agents, existing repositories, prerequisites, safety and consent, CLI reference, project structure, configuration and manifests, Azure deployment, and troubleshooting. Contributor and release internals remain in `CONTRIBUTING.md`.

`docs` and README assets are added to the npm package so relative links work from the npm package page and an installed package. Tests verify local README/doc links and required first-use commands without introducing a documentation build system. A generated GIF and GitHub Pages were rejected for this change because they add maintenance and release tooling; a static, accessible terminal image plus text alternative is deterministic and sufficient.

## Risks / Trade-offs

- **[Upstream starter becomes stale]** → Record the exact commit and provide an explicit refresh task with source diff, dependency lock regeneration, package smoke, and attribution review.
- **[Vendored starter increases package size]** → Include only the explicit starter file catalog, exclude caches/build output, and verify packed contents and size in the existing package smoke workflow.
- **[Microsoft preview CLI or plugin changes names]** → Pin source metadata, isolate Power Apps definitions in catalogs, label preview surfaces, and do not execute undocumented plugin installation commands.
- **[Hybrid line/raw prompting corrupts terminal state]** → Make input ownership explicit, dynamically load Inquirer only for true TTYs, and test completion, validation, cancellation, redirected input, Windows Terminal, and no-color output.
- **[Manifest v4 broadens update risk]** → Keep v2/v3 parsers intact, normalize before planning, test fixtures for every supported schema, and write v4 only after a successful transaction.
- **[Power Apps users expect deployment during init]** → State the environment-binding boundary in plan, completion, generated README, and docs, with exact `npx --no-install` next steps.
- **[README loses important operational detail]** → Move rather than delete the material, package the docs, and test every root README link.

## Migration Plan

1. Add workload types, v4 normalization, and compatibility fixtures without changing current render output.
2. Add the pinned starter asset catalog, Power Apps renderer, lockfile, attribution, and representative generated-project tests.
3. Add workload-specific readiness, dependency, doctor, validation, and update behavior.
4. Add `--type`, Power Apps flags, interactive workload routing, and the TTY checkbox with line fallback.
5. Add workload-aware governance and exercise both framework adapters with one and two agents.
6. Rewrite the root README, add packaged docs/assets, and update package smoke coverage.
7. Run cross-platform CLI, generated-project, package, and strict OpenSpec validation before release.

Rollback before release removes the new catalog entry, dependency, assets, v4 writer, and docs while retaining the v2/v3 reader behavior. After a release writes v4 projects, rollback requires using that release or newer; older Liftoff versions will reject v4 safely with their existing upgrade remedy rather than misreading it.

## Open Questions

- The exact upstream starter commit and generated lockfile checksum must be recorded only after implementation validates install, lint, build, and package smoke on the supported Node.js baseline.
- The canonical static README visual should be derived from Liftoff's existing terminal wordmark; final dimensions and light/dark rendering can be selected while creating the asset without changing product behavior.
