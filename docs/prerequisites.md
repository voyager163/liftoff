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
- Selected agents: GitHub Copilot, Claude Code, OpenAI Codex, or any nonempty
  combination of the three.

Minimum versions do not authorize a different, untested release line. Release
candidates and other prereleases do not satisfy stable runtime/package-manager
floors or exact framework pins. Coding agents have a separate policy: compatible
official stable and preview releases are ready, with previews reported as
notices. An available newer release is advisory, not evidence that a compatible
installed version is outdated. A working Node.js executable does not establish npm readiness: when npm is
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

During initialization, advisory checks describe useful but deferrable capabilities:

- Docker CLI and daemon health for API workloads.
- OpenTofu for generated Azure infrastructure.
- Azure CLI and observable authentication health.

Local setup has a stronger baseline than file generation: Docker's CLI for
`docker compose config` and compatible OpenTofu for backend-disabled validation
are required when those checks apply. A missing executable does not make its
check optional. Docker daemon availability is a separate notice; configuration
validation does not require starting containers.

Local scope does not require Azure or GitHub authentication. Activation and
stateful operations select their own required tools and authentication checks;
private access, protected state storage, backend locking, and provider
permissions must still be verified by the operation that needs them. A failed
activation prerequisite does not erase completed local work.

Workstation authentication checks are read-only. Tool installation never grants
authentication or credential-enrollment authority; agent sign-in stays
agent-owned.

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

Liftoff prints allowlisted executable/argument commands before running them.
Machine-level remediation requires `--install-tools` or separate per-tool
interactive approval. Project repair approval, `--yes`, and dependency/profile
permissions do not substitute for tool consent.

- macOS recipes use Homebrew, npm, or `uv`.
- Windows recipes use WinGet, npm, or `uv`.
- Linux system packages are never installed with automatic elevation. Liftoff
  prints distribution-appropriate official guidance; npm and `uv` framework
  recipes remain separately consented, as does Codex's official npm recipe.
  Required package managers must already be compatible and usable; Liftoff does
  not bootstrap them through a missing or incompatible executable.

Remedies are selected by the observed cause and installation origin. A missing
tool can use its registered installer; an older known package-manager
installation can use a registered upgrade. Unknown origins and unsupported
release-line/channel changes produce a concrete limitation rather than a
guessed reinstall. Replacing a newer pinned framework version or changing its
channel needs review of the exact corrective recipe; generic installation
consent does not authorize an automatic downgrade or uninstall.

Every successful installer exit is followed by a version probe. Exit zero does
not prove files were written, a version changed, or the tool became compatible.
The same executable/version and unsatisfied constraint is reported as **no
progress**, and an identical unchanged remedy is not automatically repeated.
Review changed observations or a different supported recipe instead.

A private immutable no-progress receipt can preserve that guard across CLI
processes for the same existing invocation root. Receipts contain only the
registered recipe and hashed before/after observations, never raw paths,
environment values, credentials, or probe output. An incidental staging working
directory does not reset the guard; actual executable, constraint, and relevant
tool-location environment changes do. Corrupt or inaccessible history is an
explicit remediation error, including a failed receipt write after a verified
no-op; it is never silently ignored or replaced.

Terminal/PATH guidance requires an actual executable-discovery failure and an
observed executable candidate at a documented install location. Merely completing
a search without finding an executable leaves the requirement unchanged or
unresolved, not restart-required. A resolved incompatible executable, a failed
version probe, or an unreadable location is not a generic restart problem.
Finding an existing executable at an install location is not proof the installer
wrote it. Windows shim paths and paths containing spaces are observed using
native paths, not shell interpolation.

## OpenSpec global profile consent

OpenSpec 1.11 stores workflow selection and delivery globally rather than in a
project. Liftoff requires all workflows with delivery `both` so a fresh project
does not immediately drift when OpenSpec is rerun. Copilot and Claude receive
their supported skills and commands; Codex receives all 12 native project-local
skills without unsupported command files or global prompts.

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

Copilot can be detected through `copilot --version` or the supported VS Code
extensions `GitHub.copilot` and `GitHub.copilot-chat`. Claude Code is checked with
`claude --version`; `claude doctor` findings remain separate health/authentication
notices. Codex is checked with `codex --version`. Every selected agent must be
compatible; Codex-only projects do not require Copilot or Claude.

Version observations preserve preview/build identifiers and exclude
presentation punctuation: `GitHub Copilot CLI 1.0.83.` is stable `1.0.83`,
while `GitHub Copilot CLI 1.0.84-5.` remains preview `1.0.84-5`. Compatible
previews satisfy agent readiness. Numeric framework prereleases such as
`1.11.0-1` and Python release candidates remain subject to their strict stable
constraints. Reports distinguish actual executable observations, observed
versions, required constraints, and the reason a requirement is unresolved.

Codex's [official installation instructions](https://github.com/openai/codex#installing-and-running-codex-cli)
support `brew install --cask codex` on macOS and
`npm install -g @openai/codex` on supported platforms. Liftoff uses the Homebrew
recipe by default on macOS and the separately consented npm recipe on Windows
and Linux. A reviewed npm alternative is available on macOS. No downloaded
shell/PowerShell installer, elevation, account changes, or unselected agent
installation is implied.

Codex invokes project-local OpenSpec, Spec Kit, and Liftoff skills through its
native skill picker or `$<skill-name>` (for example, `$liftoff-setup`).
Adding Codex to an existing project uses reviewed additive integration repair,
not application reinitialization; the tool, existing integrations, and optional
Spec Kit default retain their independent approval boundaries.

Power Apps and Code Apps plugin preparation are retired. Their inputs are
rejected before selecting or installing a former workload-specific tool set.
