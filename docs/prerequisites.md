# Prerequisites

Liftoff derives workstation and project requirements from the complete resolved
plan. A Power Apps project is not asked to install API or infrastructure tools,
and a Go API is not asked to install Python.

## Baseline

- Liftoff CLI and generated Node.js workloads: Node.js 24.20 or newer.
- Python projects: Python 3.14 and `uv` 0.12.7 or newer.
- Go projects: Go 1.27 or newer.
- Generated Azure infrastructure: OpenTofu 1.12.6 or newer.
- Selected framework: OpenSpec 1.11.0 or Spec Kit 1.0.1 exactly.
- Selected agents: GitHub Copilot, Claude Code, or both.

Automatic `liftoff upgrade` additionally requires that the running canonical
`@msn-control/liftoff` package is a normal global npm installation beneath
`npm root --global`. Local dependencies, `npx` cache copies, linked checkouts,
and other package-manager stores use the documented manual global npm command
instead. Liftoff never requests elevation.

API workloads additionally require their selected Python, Node.js, or Go
runtime. GenAI uses Python 3.14 and the Python/FastAPI/PydanticAI stack.

## Blocking and advisory checks

Blocking checks must be ready before initialization can safely complete:

- Required runtime and minimum version.
- Selected spec framework CLI.
- Every selected coding agent.
- For OpenSpec, global profile `custom`, delivery `both`, and all 12 workflows.

Advisory checks describe useful but deferrable capabilities:

- Docker CLI and daemon health for API workloads.
- OpenTofu for generated Azure infrastructure.
- Azure CLI and observable authentication health.
- Optional Code Apps plugin state for Power Apps.

Authentication checks are read-only. Liftoff never stores credentials or signs
in to a cloud or agent on your behalf.

The default repository-governance handoff has no additional initialization
prerequisite. `gh`, a remote, licensed GitHub security features, private runners,
Azure and GitHub provisioning authority, Slack, and deployment access are
discovered only during post-push Phase 0 and may be reported as gaps; they do
not block local generation or authorize cloud mutation.

When private backend access creates a runner bootstrap cycle, Phase 0 also
discovers an existing private management path or proposes the policy's bounded
encrypted local-state bootstrap. Liftoff itself neither creates nor transfers
state.

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

## OpenSpec global profile consent

OpenSpec 1.11 stores workflow selection and delivery globally rather than in a
project. Liftoff requires all workflows with both skills and commands so a fresh
project does not immediately drift when OpenSpec is rerun.

Profile inspection is read-only. When the profile differs, interactive runs
show the observed values, required values, and exact `openspec config set`
commands before asking. Noninteractive runs stop unless
`--configure-openspec-profile` is present. This authorization is independent of
`--yes`, `--force`, and tool or dependency installation.

The authorized change is verified before project staging. Because it is a
machine-wide user preference, Liftoff reports it separately and does not restore
an older profile if a later project phase fails.

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

Python projects use the generated lock without resolving new versions:

```bash
uv sync --frozen --project backend --extra test
```

Worker-enabled GenAI projects add `--extra functions`. Node.js projects use
`npm ci`, and Go projects use `go mod download`.

Liftoff's npm locks are generated with npm 12.0.2 and verified in the supported
compatibility lanes. Do not replace a committed lock with an install from
open-ended manifest ranges.

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
