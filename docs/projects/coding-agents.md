# Coding agents

A Liftoff project gets skills and instructions for each coding agent chosen
with `--agents`: GitHub Copilot, Codex and Claude Code. Each skill is
written once, in a directory every chosen agent reads: `.claude/skills` for
Claude Code, `.agents/skills` for Codex, and `.github/skills` only when
Copilot is the only agent, since Copilot reads the other two as well.

## Adding a coding agent

`liftoff agents add` adds one or more agents to an existing Liftoff
project, as a reviewed change of its own; `liftoff update` never does.

```bash
liftoff agents add codex --check       # what adding would do; changes and runs nothing
liftoff agents add copilot,claude      # see the change, then approve
liftoff agents add --recover undo      # undo an addition that stopped part way
```

Adding keeps what the project has:

- The agents it has stay, in their order, and the new ones follow, so the
  first, which Spec Kit takes as its default, stays first.
- Liftoff's files for the new agents are added only where nothing is. A
  file Liftoff writes differently with them, such as the AI review
  workflow, changes only while it is as Liftoff wrote it; one you changed is
  left as it is and named.
- Nothing Liftoff did not write is touched, such as another tool's
  integration or your own skills.
- Nothing is removed, except a Copilot-only project's skills in
  `.github/skills`, which move to the new agent's directory because Copilot
  reads that one too. A skill you changed there stays as your own.

In an OpenSpec or Spec Kit project, the framework sets the new agent up
itself. Once you approve, it runs its own command at the pinned version, on
a copy of its files in an empty directory beside the project, with a
temporary home, so your machine's own configuration is untouched:

- OpenSpec runs its initializer again with every agent the project then
  has. That adds the new agent's files and writes the others' again, so if
  you changed one of OpenSpec's skills or commands, adding is refused until
  it is back as OpenSpec wrote it.
- Spec Kit runs `specify integration install` for each new agent. That
  keeps its default agent.

What the command adds goes into the project only where nothing is. A file
of the framework's that it rewrites, such as Spec Kit's list of
integrations, changes only while it is as the framework wrote it. Otherwise
nothing changes, and the file is named.

It asks before changing anything; the default answer is no, and without a
terminal it needs `--yes`.
