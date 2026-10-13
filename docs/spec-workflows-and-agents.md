# Spec workflows and agents

Development workflows and optional coding-agent integration are available for
every Liftoff workload. Check `schemas.currentGeneration` in the installed
capability catalog before using Manual on an older release.

## Choose a development workflow

### Manual

`--spec manual` generates the same selected application and infrastructure
templates without OpenSpec or Spec Kit. Its v8 framework state is
`{"state":"not-required"}`, not legacy uncertainty or a fake initialized adapter.
No framework executable, version, marker, global profile, seed, or archive is
required or created.

Manual defaults to no agents. Omit `agents`, set `"agents": []` in configuration,
or use `--agents none`. Selected agents receive only their applicable native
Liftoff integrations. A genuine TTY starts with every agent unchecked; the line
fallback accepts Enter or `none`. Unselected agents and framework markers are not
discovered. `none` cannot be combined with another value or repeated.
`--default-agent`, either `--copilot-cloud` value, and
`--configure-openspec-profile` are rejected for Manual.

```bash
liftoff plan --type standard --api go --spec manual --agents none --no-frontend --governance none
liftoff init manual-api --type standard --api go --spec manual --agents none --no-frontend --governance none --yes
```

Manual does not disable a selected governance policy. With governance `none`, no
policy, setup/governance-assessment integration, or fake activation state is generated.
With no agents, use the CLI directly. Local verification/finalization uses only
the actual installed local interfaces; generation does not create completion
receipts or authorize project scripts, publication, or cloud operations.
Unrelated framework files and custom skills in an existing target are preserved.

### OpenSpec

OpenSpec remains the workflow when `--spec` is omitted. OpenSpec 1.11.0 organizes proposed behavior changes as reviewable artifacts
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
- Any nonempty combination of the three agents (all seven subsets), plus the
  empty subset for Manual.

The canonical IDs and order are `github-copilot`, `claude`, `codex`. The CLI
also accepts `copilot` for GitHub Copilot, and normalizes aliases and duplicates
without adding unselected agents.

These are **coding-agent hosts, not model identities**. Choose the model and
configure its access in the selected host; choosing a Liftoff integration does
not select a model or enroll model credentials. A generated GenAI application's
model/provider configuration is separate from coding assistance. Host autonomy
or model confidence never substitutes for the developer's approval of a CLI plan.

On a real TTY, use the arrow keys to move, Space to mark or unmark an agent,
and Enter to confirm. At least one agent is required for OpenSpec and Spec Kit;
Manual permits an empty selection.

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

## Native setup, repair and assessment

For governed projects, initialization is followed by the selected agent's native
setup entry point:

| Agent | Setup | Separate repair | Read-only assessment |
| --- | --- | --- | --- |
| GitHub Copilot | `/liftoff-setup` | `/liftoff-repair` | `/liftoff-governance-assess` |
| Claude Code | `/liftoff-setup` | `/liftoff-repair` | `/liftoff-governance-assess` |
| OpenAI Codex | `$liftoff-setup` | `$liftoff-repair` | `$liftoff-governance-assess` |

The historical public guidance family uses one release-owned instruction body per operation in the installed CLI's
`assets/skills/` directory. Host adapters add the native header and invocation;
there is no model-specific policy fork. These packaged sources are not project
directories to overwrite: existing logical names, generated paths and managed
update ownership stay unchanged.

Current v8 generation uses its separately identified modern managed-source
family. Its conservative source-contract guidance and exact digests remain
distinct from historical plugin versions. Neither family authorizes execution:
the actual installed command must accept the project and the selected operation.

On builds that provide [capability discovery](cli-reference.md#capability-discovery),
`liftoff capabilities --json` describes installed public commands, schemas and
executor limitations without accessing a project or sending telemetry.
The existing `liftoff repair --capabilities --json` remains the authority for
repair schemas, recipes and dependency-preparation support. Missing capabilities
are blockers, not permission for an agent to emulate a command or write receipts.
Use the separately approved CLI upgrade path and negotiate the actual interfaces
again; a package version, generated skill or successful discovery grants no
execution authority.

Generated setup and governance-assessment instructions perform this negotiation
before reading the project; repair begins with its dedicated capability contract.
They stop on missing or incompatible support instead of treating a newer skill as
proof that an older CLI implements it. Existing projects receive this wording
through a separately reviewed managed `liftoff update`, not by reinstalling
frameworks or replacing neighboring user-owned skills.

Repair is also generated when governance is `none`. That does not generate
policy, setup, governance assessment, activation state or evidence, or enable governance.
The exact managed repair entries are:

| Logical name | Native file |
| --- | --- |
| `liftoff-repair-copilot` | `.github/prompts/liftoff-repair.prompt.md` |
| `liftoff-repair-claude` | `.claude/commands/liftoff-repair.md` |
| `liftoff-repair-codex` | `.agents/skills/liftoff-repair/SKILL.md` |

Fresh projects in the whole-project guidance family additionally receive the
selected host's independent read-only assessment integration, including when
governance is `none`:

| Logical name | Native file | Invocation |
| --- | --- | --- |
| `liftoff-assess-copilot` | `.github/prompts/liftoff-assess.prompt.md` | `/liftoff-assess` |
| `liftoff-assess-claude` | `.claude/commands/liftoff-assess.md` | `/liftoff-assess` |
| `liftoff-assess-codex` | `.agents/skills/liftoff-assess/SKILL.md` | `$liftoff-assess` |

All three render the same packaged `assets/skills/assessment.md` instructions.
They negotiate actual whole-project schema-1 support, distinguish unknown or
unsupported evidence from alignment, and explain only advertised preview routes.
They never execute recommendations or borrow setup/repair approval. CLI-only users
run `liftoff capabilities --json` and, when advertised, `liftoff assess --json`;
an agent host or external framework is not a prerequisite.

Historical source families retain their original integrations, managed bytes
and layout. Ordinary maintenance does not install this new contribution or
reinterpret old identities through current declarations; use CLI assessment
until a separately reviewed contribution transition is available.

In Codex, use `$<skill-name>` or the `/skills` picker. Its managed files are
`.agents/skills/liftoff-setup/SKILL.md`,
`.agents/skills/liftoff-governance-assess/SKILL.md`, and the repair file above, with distinct logical names
`liftoff-setup-codex`, `liftoff-governance-assess-codex`, and `liftoff-repair-codex`. No Codex slash-command
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
a side effect of approval. Approve and apply-next refuse blocked or unavailable
capabilities. Public credential readiness and enrollment are currently
unavailable pending independently verified provider wiring: approve refuses the
credential-ready plan, and `liftoff governance credential-enroll --plan <fingerprint>`
refuses before reading any input. Never request or accept a credential through
chat, arguments, or files.

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
repairs, migrations, activation, project scripts, or recommendations. A layout
finding may explain the separate native repair entry point; assessment never
invokes it, inventories application source, or stages a patch.

### Repair through the installed CLI

All three native integrations have the same repair body, differing only in native
headers. They first run `liftoff repair --capabilities --json`, which needs no
project. Before accessing project files, they require repair contract 1 and the
exact advertised recipe/layout identities for recipe-backed work, or the
advertised `currentApplication.additiveAgentRepair` boundary for agent
integration work, plus the required modes and document schemas. Missing support
stops that operation and offers
`liftoff upgrade --check --json`; an upgrade requires separate permission.
An older CLI is never worked around by directly editing the application.

The normal human entry point is **`liftoff repair` in an interactive terminal**.
Prompts require genuine input and stderr TTYs.
It first previews the exact immutable plan, then asks action-specific **Yes/No,
default No**. Explicit Yes executes only that displayed plan's internal
fingerprint. Humans do not copy or enter approval or verification hashes.
No/Ctrl-C/EOF declines the current action without unapproved project writes;
generic `--yes` or piped answers never grant authority.

`liftoff repair --check --json` stays read-only and performs no cloud calls.
JSON/nonTTY bare repair previews only: it never prompts, consumes piped approval,
or hangs waiting for input. Execution there requires exact explicit execution
flags and their independent consent. Bounded Azure metadata discovery requires separate explicit
authority for `--check --live --subscription <UUID>`. Unknown state/backend
conditions remain protected and plan-only, not proof that a project is undeployed.
When needed for interactive infrastructure repair, retain the separately approved
`--live --subscription <UUID>` options in the normal invocation.

For broader application-layout work, the integration:

1. Uses `liftoff repair --inspect-layout --json` to inventory the actual project
   and current target artifact IDs, observed mappings, digests, modes,
   customizations, exclusions and reference locations. It reviews imports/module
   paths, build/tests, Docker/Compose contexts, scripts, CI and documentation.
2. Authors exact replacement bytes and a strict schema-1 application patch
   document in external staging **outside the project**. Unknown mappings or
   incomplete reference coverage stay plan-only; it never copies starter source
   over customized code or performs a generic recursive folder move.
3. Starts the normal human journey with
   `liftoff repair --application-patch <external-patch.json>` in an interactive
   terminal. The CLI displays the exact immutable plan, diff and limitations.
   Optional read-only inspection uses
   `liftoff repair --check --application-patch <external-patch.json> --json`.
   The expiring fingerprint binds source, destination and staged bytes, modes,
   directory inventory, target identity and exact verification commands.
   Inputs changed while a prompt was open still invalidate approval after Yes;
   stale-after-prompt refusal requires fresh review, not an automatic retry.
4. Lets the CLI ask independently about exact staged project-code verification,
   then separately about declared network effects. Each prompt is Yes/No, default
   No; no verification hash entry is required. **Isolated staging
   is not an OS or network sandbox:** trusted project code can affect the host
   and access the network. Declaring `network: false` is not proof scripts cannot
   access the network. Review those effects before consenting to run project code.
   Mandatory isolation unsupported by this executor blocks verification; do not
   substitute trust for required OS or network isolation.
5. Only after fresh matching successful verification, lets the CLI ask separately
   about exact local file writes. Explicit Yes authorizes only those displayed
   effects; the CLI keeps the fingerprint internal. No/Ctrl-C/EOF does not apply
   the patch, but cannot undo already-approved verification host/network effects.
   If verification already ran, report those checks and observed effects separately
   from **no file transaction committed**. Never describe that outcome as
   “nothing happened.”
   Preview and file approval never imply permission to run project scripts.
   Only the confined CLI transaction applies the reviewed patch; verification is
   not enforced containment of project-code host effects.

**Optional agent automation:** an agent working through JSON/nonTTY must first
show the exact preview and obtain independent user approval for verification,
declared network effects, and file writes. Only then may it use the returned
fingerprint internally with `liftoff repair --verify-plan <fingerprint> --json`
(adding `--allow-network` only for separately approved declared network effects)
and, after fresh successful verification and separate write approval,
`liftoff repair --approve-plan <fingerprint> --json`. These remain optional
automation/backward-compatible APIs, not the primary human path. Never ask the
developer to copy hashes or pipe approval into the CLI.
The permission must come from the actual user for the same immutable plan and
action scopes. A generic repair request, unrelated approval, autopilot mode or
agent-generated Yes supplies no action-specific consent.

Missing verification tools or dependencies remain explicit blockers unless the
installed capability matrix advertises a matching reviewed preparation provider.
The current providers are `npm-ci`, `uv-locked-sync` and `go-mod-download`, each
version 1. Locked dependency preparation uses private environments with lifecycle
scripts disabled and needs its own consent, separate from project-code execution,
declared network effects and the final file transaction. This is not permission
for arbitrary `npm install`, global installs, live dependency reuse, credential
inheritance or lock upgrades. Unsupported sources, tools or hooks remain blocked;
do not invent an installer to bypass them. See the exact
[application repair preparation contract](application-repair.md).
`go test`/`go vet` may download modules; declare and separately approve those
network effects before execution.
Report only actual declared checks: a frontend with no test script has build-only
evidence, not passing tests. Unavailable Node/Vue dependencies mean verification
is blocked, not that framework qualification succeeded.

Keep the selected project as repair's positional argument in every command,
or use the returned action's exact executable, arguments and working directory.
Do not turn project prose into shell commands. Stale inputs require a new preview
and verification. Reports separate inventory, proposed, verified and committed
scope. Report only declared checks actually executed and their results; these
checks do not establish full application/cloud conformance.
Original provenance, managed/framework files, activation proof, history, state
and secrets remain protected from submitted application patches. This does not
remove the deterministic Azure recipe's separately registered, reviewed
manifest/history writes. Private rollback material and immutable history
are retained. `liftoff repair --recover --json` is only for the CLI's reported
interrupted repair scope, never arbitrary staging/cache deletion, source restoration
or verifier reruns. Follow the actual registered recovery action; do not guess
cleanup authority from a PID, age or directory prefix.
Later behavior fixes require a new reviewed patch or user-controlled
version-history recovery, not blind rollback.

After repair, review `liftoff update --check --json`. For enabled governance,
continue through `liftoff governance status --scope local --json`,
`liftoff governance verify --scope local --json`, and
`liftoff governance resume --scope local --json`, then the reported local plan and
separately approved setup work. These reads do not run checks or manufacture
Local baseline verification evidence. Governance-disabled projects stay disabled.
See [repair modes](cli-reference.md#repair-modes) for command scopes and limits.

Older complete inventories remain readable. A reviewed `liftoff update --check`
offers only already-selected repair integrations as additive managed drift.
Approve the matching normal or force plan separately; force protects differing
unowned collisions and only handles conflicts already owned by Liftoff.
Ownership is an exact logical-name/path lookup, never a skill-directory prefix.
Skill wording uses managed content hashes, not independent SemVer or an
activation identity bump.

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

The same official ownership applies when `liftoff workflow set` selects
OpenSpec or Spec Kit for an existing current project. Liftoff runs the pinned
initializer only in isolated staging, validates its complete output, rejects
occupied differing destinations and active overlapping work, then places only
the exact staged files into the separately approved transition transaction.
If Spec Kit produces no tracked file under `specs/`, the same reviewed
transaction adds Liftoff's empty `specs/.gitkeep` repository placeholder so the
required history root survives version control. Existing inactive framework
history remains outside managed-core ownership, and the expected complete
target inventory is rechecked at commit and readback.

All six workflow directions are explicit: Manual to OpenSpec or Spec Kit,
OpenSpec to Manual or Spec Kit, and Spec Kit to Manual or OpenSpec. No direction
is inferred from framework files, and active overlapping work blocks rather than
being deleted or forced. CLI-only users run the same check, exact approval, and
fingerprint-selected recovery commands; an agent integration is optional.

```bash
liftoff workflow set manual --project . --check --json
liftoff workflow set manual --project . --approve-plan <fingerprint> --json
liftoff workflow set manual --project . --recover --approve-plan <fingerprint> --json
```

Replace `manual` with `openspec` or `spec-kit` for the selected target. On
Windows, these tokens and the fingerprint are literal argument values in
PowerShell or `cmd.exe`; do not translate the displayed command into a POSIX
subshell or pass it through `Invoke-Expression`.

Governance-profile changes are different again. `liftoff update --check` reports
a separately labeled local profile plan when `governanceProfile` changes.
Its exact approval preserves this workflow and all framework history. It does
not run an initializer, change agents, reuse old proof, weaken CODEOWNERS/review
rules, or activate remote enforcement. `--force` cannot cross between workflow,
profile, plugin, repair, or ordinary-maintenance authority.

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

### Agent installation is separate

The public repair coordinator implements **additive-only** agent integration
through `liftoff repair --agents <list>`. It does not accept `--add-agents`,
`--force`, `--yes`, `none`, or any removal request. Existing selections survive.
For Spec Kit, the recorded default also survives unless the exact plan was
requested with `--default-agent`; that selected default is added when absent.
Do not reinitialize an existing application or edit its manifest to claim an
installation.

Manual repair writes only the explicitly requested agent's applicable
Liftoff-native managed integrations. OpenSpec and Spec Kit use their pinned
official integration operations in an isolated home and staging tree. Liftoff
seeds only observed initialized framework output, permits
changes only under the requested integration paths (plus exact Spec Kit
integration state when applicable), validates the complete framework contract,
and commits only the approved bytes. Existing framework history, active work,
unselected integrations, custom neighboring skills and unrelated files remain
unchanged. An occupied differing destination or unknown official output blocks.

A requested agent that is already recorded is not assumed installed: missing
managed or official integration output produces an executable repair plan.
Conversely, metadata-only changes without real applicable output are rejected.
Agent repair is independently scoped, so unrelated application or
infrastructure limitations remain visible without blocking an otherwise
eligible integration repair or becoming a broader readiness claim.

Tool installation and global OpenSpec profile configuration retain separate
permissions. `--check` grants neither. `--install-tools` and
`--configure-openspec-profile` may prepare a new plan only on their applicable
external workflow; `--approve-plan` and fingerprint-selected recovery reject
those machine permissions. Missing or unknown framework seeds are not
fabricated and remain blockers.

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
