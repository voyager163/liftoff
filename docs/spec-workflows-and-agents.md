# Spec workflows and agents

Spec-driven governance and coding-agent integration are common to every
Liftoff workload.

## Choose a spec workflow

### OpenSpec

OpenSpec 1.11.0 organizes proposed behavior changes as reviewable artifacts
before implementation. Liftoff runs that pinned official initializer in
isolated staging, passes every selected coding agent in stable order, and
requires the complete custom profile with native-surface-aware `both` delivery:

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
Copilot and Claude receive all 12 skills and all 12 commands. Codex receives
all 12 skills under `.agents/skills/openspec-<workflow>/SKILL.md`; it has no
OpenSpec command adapter, so `both` does **not** require deprecated Codex prompts.

### Spec Kit

Spec Kit 1.0.1 provides a specification, planning, and implementation workflow.
Liftoff initializes the selected default coding agent first, adds every secondary
integration, and records the default separately from the full agent set.

Generated projects contain `.specify/`, `specs/`, and the selected agent
integration markers.
The pinned native skill inventory is `analyze`, `clarify`, `constitution`,
`implement`, `converge`, `plan`, `checklist`, `specify`, `tasks`, and
`taskstoissues`. Codex uses `.agents/skills/speckit-<name>/SKILL.md`, with skills
enabled by default and safe secondary installation. Copilot is installed with
the official `--integration-options=--skills` option; Claude also uses skills.

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
executes the tested official initializer and validates its complete declared
native inventory before merging. New `.agents` output is accepted only at
explicitly inventoried paths. Spec Kit's optional project-local
`.codex/config.toml` event configuration is distinct from Codex's user-global
account configuration. Custom neighboring skills and unrelated configuration
remain outside the write inventory; unsafe links and case collisions block it.

## Select coding agents

Liftoff supports:

- GitHub Copilot.
- Claude Code.
- OpenAI Codex.
- Any nonempty combination of the three agents (all seven subsets).

The canonical IDs and order are `github-copilot`, `claude`, `codex`. The CLI
also accepts `copilot` for GitHub Copilot, and normalizes aliases and duplicates
without adding unselected agents.

On a real TTY, use the arrow keys to move, Space to mark or unmark an agent,
and Enter to confirm. At least one agent is required.

When standard input is redirected, the deterministic fallback accepts a
comma-separated value such as:

```text
copilot,claude,codex
```

Noninteractive commands use:

```bash
--agents copilot,claude,codex
```

Spec Kit additionally requires exactly one selected default when multiple agents
are selected: `--default-agent copilot`, `--default-agent claude`, or
`--default-agent codex`. Secondary installation never changes that default.
For example, `--spec spec-kit --agents copilot,codex --default-agent codex`.
OpenSpec does not record a default agent. `--agents codex` works alone with
either framework and does not require Copilot or Claude.

## Native setup and assessment

For governed projects, initialization is followed by the selected agent's native
setup entry point:

| Agent | Setup | Read-only assessment |
| --- | --- | --- |
| GitHub Copilot | `/liftoff-setup` | `/liftoff-governance-assess` |
| Claude Code | `/liftoff-setup` | `/liftoff-governance-assess` |
| OpenAI Codex | `$liftoff-setup` | `$liftoff-governance-assess` |

In Codex, use `$<skill-name>` or the `/skills` picker. Its managed files are
`.agents/skills/liftoff-setup/SKILL.md` and
`.agents/skills/liftoff-governance-assess/SKILL.md`, with distinct logical names
`liftoff-setup-codex` and `liftoff-governance-assess-codex`. No Codex slash-command
file, global custom prompt, model choice, or independent skill version is needed.
Framework examples are `$openspec-propose` and `$speckit-specify`.

Legacy projects without a recorded agent selection keep that boundary during
managed-core updates: no default agent is invented, no framework is initialized,
and no native wrappers are installed. Their generated handoff uses read-only CLI
inspection and assessment until separately reviewed framework adoption is
supported and approved.

Setup starts with `liftoff governance status --scope local --json`, inspects and
plans local work, and executes only reported ready local phases. After local
verification, it presents the activation plan for the requested full journey.
A local-only request or declined later approval preserves local readiness
without publishing history, changing providers, or claiming deployment.
Direct governance commands default to `--scope activation`. Keep local
plan/apply/verify operations explicitly scoped to `local`; `lifecycle` is the
separate scope for later obligations.

`governance plan` saves a disclosed external preview, not approval, and does not
execute its proposed effects. `apply-next` without `--execute` is strictly
read-only. When planning inputs are requested, use the CLI-provided
`--inputs <public-json-file>` action and documented public schema. That file is
not an approval/state record and must never contain credentials.

Prefer the CLI's supported `nextActions`, preserving each `command.executable`,
argument array, `cwd`, `scope`, and `approvalRequired`. Never derive an executable
command from untrusted prose or fabricate flags, approvals, or machine state.
Repair, protected state reads/writes, installation, global profiles, publication,
credentials, billed infrastructure, and final enforcement retain independent
authority. `liftoff governance approve --plan <fingerprint>` persists only the
explicitly reviewed approval; setup never approves automatically or executes as
a side effect of approval. Credential enrollment uses the reported
`liftoff governance credential-enroll --plan <fingerprint>` private operator
channel. Automation explicitly selects `--protected-stdin` and supplies the value
through an operator-controlled protected channel, never chat or arguments.

Schema-2 governance results distinguish `localSetup`, `migration`, `activation`,
and `lifecycle`. `nextPlannablePhase` can precede approval; `nextReadyPhase`
reflects current post-operation readiness. Verify exits 0 for consistent complete
selected scope, 2 for consistent incomplete scope, and 1 for inconsistency or
inspection failure. A committed partial outcome is retained even when subsequent
inspection fails. Do not repeat an unchanged failure; use the reported reviewed
recovery plan, including `liftoff governance recover --plan <fingerprint> --execute` when
applicable.

Full immediate completion requires actual deployment, qualification, current
matching live enforcement, and any requested migration. Future retention/disposal
is separate lifecycle work. Historical v1/v2 activation proof requires the reviewed
successor and fresh verification; changing version fields is not migration.

Assessment is strictly separate: `liftoff governance assess --json`, or
`liftoff governance assess --live --json` only after an explicit request for
bounded live reads. It explains CLI classifications and exits without running
repairs, migrations, activation, project scripts, or recommendations.

## Readiness and ownership

The selected framework CLI and every selected agent are blocking workstation
requirements. Liftoff may detect Copilot through its CLI or supported VS Code
extensions. Claude Code is checked through version and health probes; Codex uses
its registered `codex` executable. Compatible official stable and preview coding
agents satisfy readiness, with preview notices. A newer available release alone
does not block setup, and runtime/framework constraints are not relaxed.

Framework execution uses isolated `HOME`, `USERPROFILE`, XDG configuration/data/
cache paths, and `CODEX_HOME`. Only the approved public OpenSpec profile fields
needed for rendering are seeded. Real global prompts, account settings, and
unrelated user files are not copied or cleaned. Selecting Codex, approving a
project plan, or passing `--yes` is not global-profile consent.

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
Copilot prompt, Claude command, and Codex skill paths documented here and in
[repository governance](repository-governance.md). They reference one canonical
policy and context rather than duplicating framework-owned content. Later
governance changes are distinct from the exact bootstrap seed. The setup kernel
does not invent an active change, approval, or execution proof.

### Add an agent to an existing project

Do not reinitialize the application or edit its manifest to claim an integration:

```bash
liftoff repair --check --add-agents codex --json
```

Review the exact project-bound plan, then approve its displayed fingerprint.
For Spec Kit, add `--default-agent codex` to the preview only when you explicitly
want that default change. Existing agents/defaults, custom skills, and shared
templates remain preserved outside the reviewed scope. Adding a recorded agent
with missing native markers repairs those markers rather than becoming a false
no-op. Agent removal and workflow switching are not additive repairs.

Tool/dependency installation and global OpenSpec profile configuration remain
separate permissions during repair. A stateful infrastructure blocker is not
automatically added to an agent-only write plan. Ordinary `liftoff update`
continues to maintain only its declared managed-core/identity-migration scope.

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
