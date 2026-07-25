# Spec workflows and agents

Spec-driven governance and coding-agent integration are common to every
Liftoff workload.

## Choose a spec workflow

### OpenSpec

OpenSpec organizes proposed behavior changes as reviewable artifacts before
implementation. Liftoff runs the pinned official OpenSpec initializer in
temporary staging and passes every selected coding agent in stable order.

Generated projects contain `openspec/` plus the selected agent integration
markers.

### Spec Kit

Spec Kit provides a specification, planning, and implementation workflow.
Liftoff initializes the selected default coding agent first, adds every
secondary integration, and records the default separately from the full agent
set.

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
`liftoff update`; it updates generated guidance and manifest intent without
creating API or infrastructure artifacts.
