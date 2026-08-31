## Why

Liftoff currently generates project files without ensuring that the selected runtime, spec-driven framework, or AI coding agents are usable on the developer's workstation. Its `create` command also always creates a child directory, cannot safely adopt an existing Git root, and presents a minimal terminal experience that does not guide developers through missing prerequisites or destructive choices.

## What Changes

- **BREAKING** Replace `liftoff create` with `liftoff init` and remove the old command without an alias.
- Detect when `init` runs at the exact root of a Git worktree, infer the project name from that directory when omitted, and generate in place instead of creating a duplicate child folder.
- Allow both automatically selected Git roots and explicitly named existing directories to be merged after a complete collision preflight. Interactive runs list conflicting generated paths and request one confirmation; `--force` authorizes those overwrites non-interactively, while an existing Liftoff manifest always redirects the developer to `liftoff update`.
- Add plan-aware workstation readiness detection for the selected API stack, cloud tooling, spec-driven framework, and AI coding agents.
- Offer platform-native installation of missing machine tools with explicit consent through Homebrew on macOS and WinGet on Windows. On Linux, run cross-platform ecosystem installers when their host runtime exists and print exact manual commands for missing system tools. Add `--install-tools` for explicit non-interactive authorization.
- Offer project-local dependency installation as a separate post-generation step, with `--install-dependencies` for non-interactive use.
- Initialize the selected framework through its official CLI instead of emitting only a partial hand-written layout:
  - OpenSpec through `openspec init`.
  - Spec Kit through `specify init` and its integration-management commands.
- Let developers select GitHub Copilot, Claude Code, or both. Detect Copilot through either its CLI or VS Code extensions, require the Claude Code CLI when selected, and ask for a default agent when Spec Kit is configured with both.
- Keep framework-owned generated files outside Liftoff artifact ownership while recording the selected framework, configured agents, default agent, and tested framework contract version as deterministic project identity.
- Reuse one requirement registry for mutating `init` readiness checks and read-only `liftoff doctor` diagnostics.
- Upgrade general help, command help, readiness reports, confirmations, failures, and success output with a responsive branded terminal renderer, semantic color, `NO_COLOR` support, and deterministic plain-text fallback.
- Raise the supported Node.js floor to 20.19 so the default OpenSpec workflow can run on every supported Liftoff installation.
- Apply the same framework initialization and workstation-readiness contracts to generated migration targets without modifying migration source projects.

## Capabilities

### New Capabilities

- `liftoff-workstation-bootstrap`: Plan-aware detection, consent, platform installation, verification, and optional project dependency setup for runtimes, infrastructure tools, spec frameworks, and AI coding agents.

### Modified Capabilities

- `liftoff-cli-workflow`: Replace `create` with `init`, support Git-root and existing-directory initialization, add overwrite and installation flags, capture multiple AI agents, and render the upgraded terminal experience.
- `liftoff-project-scaffold`: Run official spec-framework initialization, configure all selected agents, preserve framework ownership boundaries, and document the ready-to-use workflow.
- `liftoff-project-doctor`: Diagnose the same plan-specific workstation requirements, framework health, and all selected agent integrations without writing.
- `liftoff-manifest-contract`: Record deterministic spec-framework and multi-agent identity while preserving Liftoff artifact ownership and keeping observed workstation versions out of rendered content.
- `liftoff-npm-distribution`: Publish and smoke-test the renamed command lifecycle and require Node.js 20.19 or newer.
- `liftoff-standard-projects`: Initialize standard Python, Node.js, and Go projects through the new command and enforce their selected workstation requirements without requiring unrelated runtimes.
- `liftoff-project-migration`: Use the complete target initialization pipeline, including framework and agent setup, while preserving the source project's read-only guarantee.

## Impact

- CLI parsing, command dispatch, prompts, plan modeling, destination resolution, filesystem preflight, artifact writing, generated documentation, diagnostics, and package smoke tests will change.
- Project configuration and manifest readers will gain selected-agent and framework-contract metadata with compatibility handling for existing v2 projects.
- New shared terminal UI, workstation requirement, installer-adapter, command-runner, and framework-integration boundaries will be introduced.
- Runtime integration will execute allowlisted external tools such as Homebrew, WinGet, npm, uv, OpenSpec, Spec Kit, GitHub Copilot, and Claude Code only after the required consent.
- Public README examples, active OpenSpec specifications, tests, and release verification must move from `liftoff create` to `liftoff init`; archived OpenSpec history remains unchanged.
