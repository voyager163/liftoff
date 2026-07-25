# Prerequisites

Liftoff derives workstation and project requirements from the complete resolved
plan. A Power Apps project is not asked to install API or infrastructure tools,
and a Go API is not asked to install Python.

## Baseline

- Liftoff CLI: Node.js 20.19 or newer.
- Power Apps code app: Node.js 22.12 or newer.
- Selected framework: the Liftoff-tested OpenSpec or Spec Kit contract.
- Selected agents: GitHub Copilot, Claude Code, or both.

API workloads additionally require their selected Python, Node.js, or Go
runtime. GenAI uses Python 3.12 and the Python/FastAPI/PydanticAI stack.

## Blocking and advisory checks

Blocking checks must be ready before initialization can safely complete:

- Required runtime and minimum version.
- Selected spec framework CLI.
- Every selected coding agent.

Advisory checks describe useful but deferrable capabilities:

- Docker CLI and daemon health for API workloads.
- OpenTofu for generated Azure infrastructure.
- Azure CLI and observable authentication health.
- Optional Code Apps plugin state for Power Apps.

Authentication checks are read-only. Liftoff never stores credentials or signs
in to a cloud or agent on your behalf.

## Preview requirements without writes

`liftoff plan` shows both generated artifacts and workstation requirements
without writing files or running installers:

```bash
liftoff plan --type power-apps-code-app --spec openspec --agents copilot,claude
```

## Tool installation consent

Liftoff prints allowlisted commands before running them. Machine-level
installation requires `--install-tools` or separate interactive approval.

- macOS recipes use Homebrew, npm, or `uv`.
- Windows recipes use WinGet, npm, or `uv`.
- Linux system packages are never installed with automatic elevation. Liftoff
  prints distribution-appropriate official guidance; npm and `uv` framework
  recipes remain separately consented.

An install that changes `PATH` is re-probed when possible and may require a new
terminal. Do not treat installer success as readiness until the corresponding
probe passes.

## Project dependency consent

Project-local dependency setup is separate from workstation tools and requires
`--install-dependencies` or interactive approval after a successful project
merge.

For Power Apps, Liftoff runs only the root locked install:

```bash
npm ci
```

The generated `package.json` and `package-lock.json` are validated before
installation and protected from installer mutation. If dependency setup is
skipped or fails, Liftoff prints the exact resume command rather than claiming
the project is ready.

GenAI and API projects use their generated stack-native locked dependency
commands.

## Power Apps local CLI

The Power Apps CLI is supplied by the generated project dependency graph.
Liftoff checks it without downloading another package:

```bash
npx --no-install power-apps --version
```

If `node_modules` is absent, run `npm ci` first. Environment binding and cloud
authentication remain separate later actions.

## Agent detection

Copilot can be detected through its CLI or supported VS Code extensions.
Claude Code is checked with its version and doctor commands. When both are
selected, both must be ready.

The optional Code Apps plugin uses independent, read-only probes for each
selected agent. A missing executable, timeout, or unsupported plugin-list
result is reported as not observable rather than silently treated as missing.
