## Context

Liftoff currently resolves every project to `<cwd>/<project-name>`, rejects every non-empty target, renders a partial OpenSpec or Spec Kit approximation itself, and performs only a small fixed set of environment checks. A developer can therefore finish `liftoff create` with an unnecessary nested repository, no usable spec-framework integration, no selected coding-agent setup, and no installed runtime for the generated backend.

The change crosses command parsing, prompting, filesystem safety, external process execution, manifest compatibility, diagnostics, templates, documentation, and release packaging. It must remain deterministic where Liftoff owns content, preserve the read-only contract of `doctor` and migration source scanning, and behave consistently on macOS, Windows, and Linux.

## Goals / Non-Goals

**Goals:**

- Make `liftoff init` the single project-initialization command.
- Initialize in place at the exact root of an existing Git worktree.
- Merge safely into other explicitly selected existing directories after complete conflict disclosure and separate overwrite consent.
- Detect the exact tools implied by the resolved project plan, install supported missing tools only with explicit authorization, and verify every attempted installation.
- Produce complete OpenSpec or Spec Kit infrastructure through a tested official CLI version.
- Configure GitHub Copilot, Claude Code, or both, including Spec Kit's single-default constraint.
- Keep external framework output and Liftoff-owned artifacts distinguishable during update and validation.
- Share readiness logic between mutating initialization and read-only diagnostics.
- Improve terminal output without weakening strict parsing, machine-readable output, or non-TTY behavior.

**Non-Goals:**

- Automating login, license acceptance, subscription setup, cloud credentials, or AI-agent authentication.
- Automatically installing Homebrew, WinGet, Linux system package managers, or running elevated Linux package-manager commands.
- Adopting an existing Liftoff project through `init`; `liftoff update` remains the only path for a target containing `liftoff.manifest.json`.
- Making arbitrary existing files Liftoff-managed.
- Adding a compatibility alias for `liftoff create`.
- Making project dependency installation transactional with scaffold generation.
- Updating archived OpenSpec changes or managing future files created by framework upgrades.

## Decisions

### 1. Replace `create` at the command-definition level

`init` will replace `create` in the parser's command registry, dispatcher, help metadata, examples, tests, and package smoke test. The exact obsolete command will fail as an unknown command with the focused remedy `Use liftoff init`; it will not dispatch to initialization.

Command definitions will become the source of truth for parsing and rendering. Each command and flag will carry its summary, metavariable, default description, repeatability, and usage grouping so general help, command help, and parser errors cannot drift.

Initialization consent flags remain intentionally independent:

| Flag | Contract |
| --- | --- |
| `--yes` | Accept defaults for unresolved project questions and skip the project-plan confirmation. |
| `--force` | Authorize replacement of the regular-file conflicts listed by destination preflight. |
| `--install-tools` | Authorize allowlisted machine-tool installation recipes. |
| `--install-dependencies` | Authorize stack-specific project dependency commands after the scaffold is committed. |
| `--agents copilot,claude` | Select one or more coding-agent integrations; values are normalized, deduplicated, and order-stable. |
| `--default-agent <agent>` | Select Spec Kit's primary integration when multiple agents are selected. |

No consent flag implies another. In particular, `--yes` does not authorize overwrites or installations, and none of these safety flags can be persisted in `liftoff.config.json`.

The interactive agent prompt is a multi-select with GitHub Copilot selected by default. Non-interactive initialization also defaults to Copilot when `--agents` is omitted. A single selected agent is its own default. Spec Kit plus multiple agents requires `--default-agent`; interactive mode asks for it and non-interactive mode fails with the exact missing flag. OpenSpec accepts all selected agents without a default, so `--default-agent` is rejected there as an inapplicable input.

### 2. Resolve an exact Git root before choosing the target

Git discovery will use an argument-array process invocation equivalent to `git -C <cwd> rev-parse --show-toplevel`. Liftoff will compare `fs.realpath` results through `path.relative`, rather than comparing unnormalized strings, so worktrees, symlinked working directories, drive-letter casing, and platform separators are handled safely.

| Context | Target | Project name |
| --- | --- | --- |
| Current directory is the exact Git/worktree root | Current directory | Supplied name, otherwise `path.basename(realRoot)` |
| Current directory is inside but below a Git root | Child directory named for the project | Supplied or prompted name |
| Current directory is not in a Git worktree | Child directory named for the project | Supplied or prompted name |
| Supplied child target already exists | That child directory | Supplied name |

An exact Git root is selected in place even when a project name is supplied; the name changes project identity, not destination. A Git repository discovered above the current directory never causes an ancestor or nested working directory to be adopted implicitly.

Before any machine installation or staging work, Liftoff performs an early target guard:

- An existing `liftoff.manifest.json` is a hard stop with a `liftoff update` remedy.
- A target that is not a directory is a hard stop.
- An existing symlink at the target, any symlinked destination ancestor below the target, and any path that resolves outside the target are non-overridable blockers.

### 3. Stage the complete result and preflight one immutable merge plan

The initialization pipeline is:

```text
resolve project decisions
        |
        v
resolve target + early safety guard
        |
        v
detect/install/verify workstation requirements
        |
        v
render Liftoff artifacts in temporary staging root
        |
        v
run official framework initializer in staging root
        |
        v
apply Liftoff seed content and supported overlays
        |
        v
validate staged tree and build destination merge plan
        |
        v
show all conflicts -> confirm or require --force
        |
        v
commit merge with per-file atomic replacement
        |
        v
optionally install project dependencies
```

The staging root is created with `fs.mkdtemp` under the host temporary directory and is removed on success or handled failure. All framework commands run with that staging root as their working directory. Nothing in the destination is written until the complete staged tree has passed validation and overwrite consent has been obtained.

The preflight walks the concrete staged inventory and classifies each destination:

- `create`: no destination entry exists.
- `identical`: a regular destination file has identical bytes and needs no write.
- `replace`: a regular destination file has different bytes and requires consent.
- `merge-directory`: an existing real directory can contain staged descendants.
- `blocked`: a type collision, symlink, unsafe resolution, unreadable entry, or existing Liftoff manifest prevents initialization.

Conflict paths are sorted by their portable relative path and displayed once. Interactive initialization requests one confirmation for the full immutable set. `--force` skips only that confirmation. If filesystem state changes between preflight and commit, the commit aborts rather than applying a stale merge plan.

Every replacement uses a temporary file in the destination file's directory followed by rename, preserving atomicity on that filesystem. The merge engine records newly created paths and backups of replaced file bytes and modes. A handled commit failure restores replaced files, removes newly created files, and removes newly created empty directories in reverse order. A process or machine crash can still leave a partially merged tree; this limitation is reported in the risk section rather than hidden behind a false whole-tree atomicity claim.

### 4. Separate Liftoff, framework, and seed ownership

Staging records file origin explicitly:

| Origin | Examples | Manifest treatment |
| --- | --- | --- |
| Liftoff durable artifact | Backend source, infrastructure, generated README | Named artifact with deterministic hash |
| Framework-owned output | Official OpenSpec skills/commands, Spec Kit scripts and integration files | Excluded from Liftoff artifact hashes; represented by framework contract metadata |
| Liftoff seed/overlay | Initial OpenSpec change, project constitution, initial framework configuration values | Written once and excluded from normal update reconciliation |

The renderer supplies an explicit list of Liftoff durable and seed paths. Framework adapters snapshot the staged tree before and after the official command to produce a concrete external inventory, reject symlinks and paths outside approved framework roots, and fail if the pinned CLI writes outside those roots. Liftoff customizes only documented framework configuration or extension points after initialization; it does not replace framework core templates with hand-written approximations.

`validate` proves all Liftoff durable artifacts and the declared framework integration markers exist. `update` reconciles only Liftoff durable artifacts. It never deletes or overwrites a path merely because it appears under a framework directory.

### 5. Build readiness from a declarative requirement registry

The resolved project plan is mapped to a requirement graph. Each registry entry contains:

- a stable requirement identifier;
- the project predicates that select it;
- blocking or advisory severity;
- one or more allowlisted probes expressed as executable plus argument array;
- a tested version constraint and parser;
- platform installation recipes;
- a post-install probe;
- an exact human-readable remedy.

The first release uses these selection rules:

| Requirement | Selected when | Readiness severity |
| --- | --- | --- |
| Node.js 20.19+ | Always; Liftoff and OpenSpec require it | Blocking |
| Python 3.12+ | Python/FastAPI project or Spec Kit workflow | Blocking |
| Go 1.23+ | Go/Huma project | Blocking |
| `uv` | Spec Kit workflow | Blocking |
| Pinned OpenSpec CLI | OpenSpec workflow | Blocking |
| Pinned Spec Kit CLI | Spec Kit workflow | Blocking |
| GitHub Copilot presence | Copilot selected | Blocking for installation; authentication warning |
| Claude Code presence | Claude selected | Blocking for installation; authentication/doctor warning |
| Docker CLI and daemon | Every generated local-development stack | Advisory |
| OpenTofu | Azure infrastructure output | Advisory |
| Azure CLI | Azure provider selected | Advisory |

A blocking missing, outdated, or unexecutable tool must be installed or corrected before destination writes. Declining an advisory tool continues initialization and prints the deferred remedy. Runtimes for unselected stacks are omitted.

Version policy differs by tool type:

- Framework CLIs use an exact version pinned and tested by the Liftoff release. This keeps official initializer output and the framework contract reproducible.
- Language runtimes and infrastructure tools use minimum supported versions and accept newer compatible releases.
- AI coding agents require a recognized installed distribution; their rapidly changing versions are reported but not persisted as project identity.

Detection completes before prompting so Liftoff can distinguish missing, outdated, unhealthy, and ready states. Interactive installation is presented one requirement at a time with the reason, required version, and exact command before confirmation. `--install-tools` runs the same selected allowlisted recipes without individual prompts. A failed or still-unhealthy blocking tool stops initialization before destination writes.

### 6. Use platform and ecosystem installer adapters without shell interpolation

Installer recipes are stored as executable plus fixed argument arrays. Project names, paths, or other user input are never inserted into shell command strings. Output is streamed through the terminal status renderer, exit codes are checked, and the tool is re-probed after every installation.

System-tool automation is:

| Platform | Adapter | Policy |
| --- | --- | --- |
| macOS | Homebrew | Use `brew install` or `brew install --cask` with registry-owned formula/cask names. |
| Windows | WinGet | Use `winget install --id <exact-id> --exact` with registry-owned package IDs. |
| Linux | Detection and guidance | Do not run elevated distro package managers automatically in this release; print distro-appropriate official commands and stop only when a blocking tool remains missing. |

Cross-platform ecosystem installers remain available on Linux when their host exists: npm installs the pinned OpenSpec package and `uv tool install` installs the pinned Spec Kit package. Liftoff never bootstraps Homebrew, WinGet, npm, or `uv` through an unaudited downloaded shell script.

Known system recipes are centralized rather than embedded in prompts. Initial identifiers include:

- Homebrew: `python@3.12`, `node`, `go`, Docker Desktop, `opentofu`, `azure-cli`, `uv`, GitHub Copilot CLI, and Claude Code.
- WinGet: `Python.Python.3.12`, `OpenJS.NodeJS.LTS`, `GoLang.Go`, `Docker.DockerDesktop`, `OpenTofu.OpenTofu`, `Microsoft.AzureCLI`, `astral-sh.uv`, `GitHub.Copilot`, and `Anthropic.ClaudeCode`.
- Ecosystem: `npm install -g @fission-ai/openspec@<tested-version>` and `uv tool install specify-cli==<tested-version>`.

When a successful installer does not make a command visible to the current process, Liftoff probes documented install locations without mutating the user's shell configuration. If the tool still requires terminal restart or PATH refresh, initialization stops with a resumable `liftoff init` command; rerunning is safe because no destination write has occurred.

### 7. Initialize frameworks through dedicated adapters

Each framework adapter owns tool probing, the pinned initializer command, agent identifier mapping, allowed output roots, expected integration markers, and post-initialization validation.

OpenSpec initialization runs conceptually as:

```text
openspec init --tools <github-copilot,claude> --profile core
```

The adapter maps user-facing `copilot` to OpenSpec's `github-copilot` identifier, passes every selected agent in stable order, and validates the resulting core profile and each integration.

Spec Kit initialization runs conceptually as:

```text
specify init --here --force --integration <default>
specify integration install <secondary> --force
```

GitHub Copilot integration receives the pinned CLI's `--skills` integration option whether it is primary or secondary, avoiding deprecated agent-file output. Additional integrations do not change the chosen default. The adapter validates the `.specify` installation and every selected agent marker.

Agent readiness is separate from framework configuration:

- Copilot is present when `copilot --version` succeeds or, when the `code` command exists, `code --list-extensions` contains `GitHub.copilot` or `GitHub.copilot-chat` case-insensitively. If `code` is unavailable, Liftoff reports that extension state is not observable and offers the Copilot CLI recipe.
- Claude Code is present when `claude --version` succeeds. `claude doctor` contributes a health warning and remedy but Liftoff does not attempt login.
- Authentication failures are never converted into successful checks and never trigger credential prompts controlled by Liftoff.

### 8. Introduce manifest schema v3 without persisting host-specific versions

New projects write manifest schema v3. In addition to existing project identity and artifact hashes, v3 records:

- the selected spec workflow;
- an ordered, deduplicated list of selected agent identifiers;
- the default agent when the framework requires one;
- the framework adapter identifier;
- the exact tested framework contract version used for initialization.

Host-specific runtime, package-manager, Docker daemon, and agent versions are displayed during initialization and diagnostics but are not written to the manifest. This preserves byte-identical rendering for the same plan and Liftoff version.

Readers continue to accept v2. A v2 project normalizes to a legacy framework state with no claimed agent integration; `doctor` warns that official framework readiness cannot be proven. The next successful `update --apply` writes v3 without fabricating configured agents. Existing users must explicitly select agents when upgrading legacy framework state through a future supported reinitialization path; this change does not silently rewrite framework files during update.

### 9. Install project dependencies only after a successful merge

Project dependency setup is a separate final phase because it creates caches, virtual environments, and installed modules that cannot be rolled back reliably. Interactive initialization offers one final prompt; `--install-dependencies` authorizes it non-interactively. `--install-tools` does not.

Commands come from the selected stack definition:

- Python creates a project-local `.venv` and installs the generated package/dependency metadata with that environment's interpreter.
- Node.js uses the checked-in lockfiles and `npm ci` in each selected Node workspace.
- Go uses the generated module metadata to download modules without rewriting `go.mod` or `go.sum`.
- A selected frontend uses its checked-in lockfile and `npm ci`.

The generated manifests and lockfiles must remain unchanged by these commands. A dependency-install failure exits unsuccessfully but leaves the valid scaffold in place, names the failed command, and prints the exact resume command.

### 10. Share readiness with `doctor` and migration without sharing side effects

`doctor` evaluates the same selected requirement graph from manifest v3 but uses probe-only mode. It never invokes installers, modifies PATH, updates framework files, or writes observed versions. Framework markers, all selected agent installations, and stack-specific runtimes appear in its existing layered severity/remedy model and JSON schema.

`migrate` keeps its fresh-target-only rule and read-only source scan. After resolving the migration plan, it uses the same readiness, staging, official framework initialization, and optional dependency phases as `init`. Machine installations occur outside the source project, and no source path is ever used as a command working directory. `--force` does not make a non-empty migration target valid.

### 11. Render a responsive terminal experience from semantic output

A small terminal module will expose semantic primitives such as banner, section, table, status, command, warning, error, and confirmation. It will use a small color library such as `picocolors`; it will not add a full-screen UI framework or runtime ASCII-art generator.

Rendering modes are selected once:

- Full TTY mode uses a checked-in `LIFTOFF` wordmark, subtitle, bordered sections, and restrained blue/cyan/yellow status color.
- Narrow TTY mode uses a compact heading and unbordered aligned sections.
- Non-TTY, `NO_COLOR`, unsupported-color, and snapshot mode emits stable plain text with no ANSI control sequences.
- JSON output bypasses the renderer entirely.

General help receives the full brand treatment. Command help is compact. Parser errors and runtime failures remain concise and do not print the banner; `--version` remains one line. Width calculations use visible cell width rather than ANSI byte length, and borders are never emitted when they would wrap.

## Risks / Trade-offs

- **Official framework output changes across releases** -> Pin an exact tested framework CLI version, validate allowed roots and integration markers, and upgrade the pin only with fixture and smoke-test updates.
- **Global installation can change a developer workstation** -> Require distinct interactive consent or `--install-tools`, show the exact command, use only registry-owned argument arrays, and never bootstrap package managers or credentials.
- **Homebrew or WinGet package identifiers can change** -> Centralize recipes, probe after installation, and fail with the observed command output plus a manual remedy.
- **Linux users receive less automation** -> Preserve complete detection and exact remedies while deferring elevated distro automation until each recipe can be tested safely.
- **A merge is not power-loss atomic across many files** -> Do all expensive work in staging, preflight the complete immutable plan, use atomic per-file replacement, and roll back handled failures.
- **External framework files are not hash-managed by Liftoff** -> Validate declared integration markers and framework identity while leaving framework upgrades to the framework CLI.
- **Copilot extension state is invisible without `code`** -> Report unknown state rather than false failure or success and offer the Copilot CLI path.
- **Dependency installation can fail after generation** -> Keep it separate, preserve the valid scaffold, return failure, and print an exact resume command.
- **Schema v3 can expose legacy integration ambiguity** -> Continue reading v2, normalize it explicitly as legacy, and never claim integrations that were not recorded.

## Migration Plan

1. Add shared command metadata and terminal rendering while preserving existing command behavior internally.
2. Introduce normalized agent choices, requirement registry, probe runner, and platform installer adapters behind unit-tested interfaces.
3. Add framework adapters and staged-tree origin tracking using pinned OpenSpec and Spec Kit fixtures.
4. Add schema v3 writers and v2 compatibility readers before switching generation to the new metadata.
5. Add target resolution, immutable merge preflight, conflict confirmation, and rollback bookkeeping.
6. Wire the new `init` pipeline and migration target pipeline, then remove `create` from the command registry.
7. Extend `doctor`, validation, generated documentation, README, and package smoke tests.
8. Release as the next breaking minor version (`0.4.0`) with Node.js `>=20.19` in package and lockfile metadata.

Rollback before release is a source revert because no published command contract has changed. After release, restoring `create` would itself require a new compatibility decision; schema v3 readers and v2 compatibility must not be removed.

## Open Questions

None block implementation. Automated Linux system-package installation, crash-recovery journaling for multi-file merges, and reinitialization of legacy framework state are explicit follow-up opportunities rather than hidden requirements of this change.
