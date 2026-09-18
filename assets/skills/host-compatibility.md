# Host discovery and qualification boundary

This is a source-maintenance reference, not a registered skill or proof that an
agent host loaded or completed a workflow. The eleven catalogued `SKILL.md`
files remain the only canonical workflow implementations.

## Documented transports

| Host | Personal delivery | Project delivery | Invocation |
| --- | --- | --- | --- |
| Copilot | `.agents/skills/liftoff-<id>/SKILL.md` | `.github/skills/liftoff-<id>/SKILL.md` | `/liftoff-<id>` |
| Claude Code | `.claude/commands/liftoff-<id>.md` | `.claude/commands/liftoff-<id>.md` | `/liftoff-<id>` |
| Codex | `.agents/skills/liftoff-<id>/SKILL.md` | `.agents/skills/liftoff-<id>/SKILL.md` | `$liftoff-<id>` |

Copilot and Codex personal delivery shares identical physical bytes and records
selected consumers. Claude's retained commands transport remains documented and
does not silently migrate to its newer skills directory. Existing registered
setup, governance-assessment and repair project identities retain their separate
reviewed migration boundary.

Discovery is broader than delivery ownership. Copilot also reads personal
`.copilot/skills` and project `.claude/skills` and `.agents/skills`; Claude Code
also reads `.claude/skills`. Planning observes each exact corresponding workflow
path in those roots, including absence, without writing to it or reading host
settings. Shared visibility includes unselected hosts: a Codex projection can
also compete with a Copilot workflow without adding Copilot as an installed
consumer. Differing existing or simultaneously planned copies block delivery.
For example, distinct Copilot and Codex project copies can compete in Copilot;
selecting both is not permission to emit conflicting workflows. Identical
unowned alternate bytes are disclosed but never become owned through discovery.
Removal remains limited to unchanged, recorded entries and remaining consumers.

The current-directory/personal checks are bounded observations, not a complete
host inventory. Ancestor repositories, nested directories, administrator/plugin
skills, differently named folders declaring the same invocation, custom discovery
locations and disabled skills require actual host inspection. Do not claim a
host is qualified or alter its settings based on source checks.

## Remaining actual-host evidence

In a separately authorized isolated host environment, record the host version,
platform, resolved skill path and invocation, canonical content identity, and
the real CLI capability/result contracts. Exercise assessment, adoption, update
and repair against staged business behavior, including declined consent,
changed-input refusal and recovery. Record requested local/repository/activation
scope separately; no fixture or narrower completion qualifies production work.
Use genuine user decisions, not generated approvals or manual hash-copy demands.

Official contracts reviewed on 2026-09-17:

- [Copilot discovery and invocation](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)
- [Claude Code commands and skills](https://code.claude.com/docs/en/skills)
- [Codex local discovery and invocation](https://developers.openai.com/codex/skills)

These documentation observations and offline regressions are not native-host or
model-interaction qualification.
