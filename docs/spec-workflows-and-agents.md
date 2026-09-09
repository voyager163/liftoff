# Spec workflows and agents

Spec-driven governance and coding-agent integration are common to every
Liftoff workload.

## Choose a spec workflow

### OpenSpec

OpenSpec 1.11.0 organizes proposed behavior changes as reviewable artifacts
before implementation. Liftoff runs that pinned official initializer in
temporary staging, passes every selected coding agent in stable order, and
requires the complete custom profile with both skills and commands:

```text
propose, explore, new, continue, apply, update,
ff, sync, archive, bulk-archive, verify, onboard
```

OpenSpec stores profile and delivery preferences globally. Before creating an
OpenSpec project, Liftoff reads that configuration through the pinned CLI. A
matching custom/both profile proceeds without a prompt. A different profile is
blocking until you separately approve the displayed global changes or pass
`--configure-openspec-profile`. `--yes` and other consent flags do not authorize
the machine-wide change.

Generated projects contain `openspec/` plus all 12 official workflow skills and
commands for each selected agent surface that supports them.

### Spec Kit

Spec Kit 1.0.1 provides a specification, planning, and implementation workflow.
Liftoff initializes the selected default coding agent first, adds every secondary
integration, and records the default separately from the full agent set.

Generated projects contain `.specify/`, `specs/`, and the selected agent
integration markers.

New projects also receive `specs/000-liftoff-bootstrap/spec.md`, `plan.md`, and
`tasks.md`. These are explicit one-time, project-owned `seed` artifacts, separate
from official framework templates. Local setup validates the real bundle and
official markers, performs the applicable baseline, and then finalizes its task
projection and receipt. It creates neither a Git branch nor an OpenSpec archive.

All three files identify `000-liftoff-bootstrap`. The tasks contain exactly one
initial unchecked entry each for **B001–B006**: review the real bundle and markers;
use already-installed locked dependencies or install with explicit consent;
run Liftoff/backend/applicable-worker checks; build the frontend or record
inapplicability; validate Compose and all infrastructure roots; then finalize.
The non-checkbox command reference list is not execution evidence.
Only after every applicable check passes does explicit setup execution commit
the checked projection with body/full-plan-bound baseline evidence. Failed checks
leave tasks untouched; status, verify, and resume do not edit checkboxes.
`seed-archived` means a local handoff for Spec Kit, not an archive operation.
This exact bootstrap is not an active governance change and has no
`liftoff-governance.json`.

An existing Spec Kit project without this bundle receives a seed-adoption
blocker. Adopting it requires separate reviewed project work; ordinary update,
force, and assessment do not create seeds or infer earlier completion.

Liftoff does not hand-write framework-owned core or integration output. It
executes the tested official initializer, confines its writes to allowed roots,
and validates the declared markers before merging.

## Select coding agents

Liftoff supports:

- GitHub Copilot.
- Claude Code.
- Both agents together.

On a real TTY, use the arrow keys to move, Space to mark or unmark an agent,
and Enter to confirm. At least one agent is required.

When standard input is redirected, the deterministic fallback accepts a
comma-separated value such as:

```text
copilot,claude
```

Noninteractive commands use:

```bash
--agents copilot,claude
```

Spec Kit additionally requires `--default-agent copilot` or
`--default-agent claude` when both are selected. OpenSpec does not record a
default agent.

## Readiness and ownership

The selected framework CLI and every selected agent are blocking workstation
requirements. Liftoff may detect Copilot through its CLI or supported VS Code
extensions. Claude Code is checked through version and health probes.

Framework files remain owned by the official initializer. Liftoff validates
them but excludes framework-owned output from durable artifact hashes so a
framework can manage its own lifecycle.

To align an existing OpenSpec project, configure both delivery and all workflows:

```bash
openspec config profile
openspec update
```

Select **Both (skills + commands)** and every workflow in the profile picker.
Plain `liftoff update` intentionally does not regenerate these framework-owned
files.

Repository-governance launchers are separate managed-core Liftoff files at the exact
Copilot prompt and Claude command paths documented in
[repository governance](repository-governance.md). They reference one canonical
policy and context rather than duplicating framework-owned content. Later
governance changes are distinct from the exact bootstrap seed. The setup kernel
does not invent an active change, approval, or missing production executor.

Install the exact selected framework release with its supported package manager:

```bash
npm install -g @fission-ai/openspec@1.11.0
uv tool install specify-cli==1.0.1
```

## Optional GitHub Copilot cloud coding agent

When OpenSpec and GitHub Copilot are selected, Liftoff asks whether to configure
GitHub's hosted coding agent. This is separate from Copilot in an editor or
terminal and defaults to No.

Opting in writes official OpenSpec-owned files:

- `.github/workflows/copilot-setup-steps.yml`
- `.github/agents/openspec.agent.md`

Use `--copilot-cloud` or `--no-copilot-cloud` in automation. The choice is
recorded as `githubCopilot.cloudAgent` in `openspec/config.yaml`; it is not stored
as Liftoff overwrite or machine-configuration consent.

## Retired Code Apps integration

The Power Apps workload and Code Apps plugin options are retired. Liftoff no
longer installs, probes, or manages that integration. This does not uninstall
machine-wide tools or plugins; existing installations remain outside Liftoff's
maintenance authority.
