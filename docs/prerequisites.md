# Prerequisites

Liftoff derives workstation and project requirements from the complete resolved
plan. A Go API does not inherit Python backend dependencies, although a selected
framework such as Spec Kit can require Python for its own tooling.

## Baseline

- Workstation Node.js: stable Node.js 24 LTS, version 24.20.0 or newer within 24.x.
- npm-dependent stacks or OpenSpec: stable npm 12.x, version 12.0.2 or newer.
- Python projects: stable Python 3.14.x and `uv` 0.12.x at version 0.12.7 or newer.
- Go projects: stable Go 1.27.x.
- Generated Azure infrastructure: stable OpenTofu 1.12.x at version 1.12.6 or newer.
- Selected framework: OpenSpec 1.11.0 or Spec Kit 1.0.1 exactly.
- Selected agents: GitHub Copilot, Claude Code, or both.

Minimum versions do not authorize a different, untested release line. Release
candidates and other prereleases do not satisfy stable floors or exact framework
pins. A working Node.js executable does not establish npm readiness: when npm is
required, it is probed separately before destination writes. A missing npm
executable requires a separately reviewed machine-level repair; Liftoff does not
try to run the missing executable or reinstall Node.js on its behalf.

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
- Required package managers, including npm for Node.js dependencies, a frontend,
  or OpenSpec.
- Selected spec framework CLI.
- Every selected coding agent.
- For OpenSpec, global profile `custom`, delivery `both`, and all 12 workflows.

Advisory checks describe useful but deferrable capabilities:

- Docker CLI and daemon health for API workloads.
- OpenTofu for generated Azure infrastructure.
- Azure CLI and observable authentication health.

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

Azure governance plans also inspect the AzureRM provider-registration mode,
derive the minimal required namespace set, and verify subscription registration
permission. Disabled auto-registration is not a blocker when the approved plan
can register each missing namespace explicitly before dependent resources.

## Preview requirements without writes

`liftoff plan` shows both generated artifacts and workstation requirements
without writing files or running installers:

```bash
liftoff plan --type standard --api node --spec openspec --agents copilot,claude
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

GenAI and API projects use their generated stack-native locked dependency
commands. If dependency setup is skipped or fails, Liftoff prints the exact
resume command rather than claiming the project is ready.

Recovery output identifies its shell: POSIX shell on macOS/Linux and PowerShell
on Windows. Copy the command into that shell; directory names and arguments are
quoted literally rather than expanded as environment variables.

If protected metadata changes during dependency setup, Liftoff stops and lists
the changed paths. It preserves those edits instead of assuming the installer
caused them and restoring older bytes over concurrent work. Review and repair
the metadata before retrying. Dependency scripts can also change other project
files; this check is not a script sandbox.
Dependencies that are already installed and usable do not need a new install
merely to satisfy a bootstrap checkbox. Local checks prove usability, not that
an installation or its consent occurred.

Python projects use the generated lock without resolving new versions:

```bash
uv sync --frozen --project backend --extra test
```

Worker-enabled GenAI projects add `--extra functions`. Node.js projects use
`npm ci`, and Go projects use `go mod download`.

Liftoff's npm locks are generated with npm 12.0.2 and verified in the supported
compatibility lanes. Do not replace a committed lock with an install from
open-ended manifest ranges.

## Agent detection

Copilot can be detected through its CLI or supported VS Code extensions.
Claude Code is checked with its version and doctor commands. When both are
selected, both must be ready.

Power Apps and Code Apps plugin preparation are retired. Their inputs are
rejected before selecting or installing a former workload-specific tool set.
