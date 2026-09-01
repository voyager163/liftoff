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
policy and context rather than duplicating framework-owned content. After
read-only Phase 0 and explicit approval, the agent creates a new change using
the selected framework; Liftoff never pre-creates or restores that change.

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

## Optional Code Apps plugin

Power Apps projects can request Microsoft's
`code-apps-preview@power-platform-skills` plugin. The integration is optional,
Preview, and independent for each selected agent.

Liftoff runs only allowlisted read-only plugin-list probes. A missing or
unobservable plugin produces advisory guidance and never makes initialization
or doctor fail by itself.

Install the targeted plugin manually inside the selected agent:

```text
/plugin marketplace add microsoft/power-platform-skills
/plugin install code-apps-preview@power-platform-skills
```

Liftoff does not run Microsoft's broad marketplace installer and does not
invoke `/create-code-app`. The plugin's connector and deployment skills remain
available for post-creation work.

Changing the valid plugin preference in `liftoff.config.json` is reconciled by
plain `liftoff update`; it updates manifest intent and applicable managed-core
governance context without rewriting the project-owned Power Apps README or
starter. Use `liftoff update --check` to inspect that maintenance without
writing.
