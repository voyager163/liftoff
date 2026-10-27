# Coding-agent skills

Liftoff gives developers native skills for GitHub Copilot, Codex and Claude
Code that carry out the layered review model in
[How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/)
before and during a pull request.

## SKILL-001 One canonical source per skill

Each skill exists once, in `assets/skills/<name>/SKILL.md`, in the Agent
Skills format (`name` and `description` frontmatter) that every supported host
reads. Names are lowercase words joined by hyphens and match their directory;
descriptions are 1 to 1,024 characters; unknown frontmatter is rejected.
Shared text lives in `assets/skills/_partials/` and is included with
`<!-- include: name -->`.

Verification: test

## SKILL-002 Native placement with no duplication

Skills are written into the fewest directories that cover the selected hosts:
Claude Code reads `.claude/skills`, Codex reads `.agents/skills`, and Copilot
reads either (or `.github/skills` when it is the only host).

| Hosts | Skill directories |
| --- | --- |
| Copilot | `.github/skills` |
| Codex | `.agents/skills` |
| Claude | `.claude/skills` |
| Copilot + Codex | `.agents/skills` |
| Copilot + Claude | `.claude/skills` |
| Codex + Claude | `.agents/skills`, `.claude/skills` |
| all three | `.agents/skills`, `.claude/skills` |

Verification: test

## SKILL-003 A read-only verifier agent for every host

The `liftoff-verifier` agent checks one finding in a fresh context. It is
rendered as `.claude/agents/liftoff-verifier.md` (edit tools disallowed),
`.github/agents/liftoff-verifier.agent.md` (read, search and execute tools)
and `.codex/agents/liftoff-verifier.toml` (read-only sandbox).

Verification: test

## SKILL-004 Skills cover every layer of the review model

The shipped skills are `liftoff-verify` (pre-PR evidence),
`liftoff-code-review` (find, verify, report), `liftoff-security-review`,
`liftoff-simplify`, `liftoff-risk` (risk-scaled approval), `liftoff-pr`
(Testing, Risk and How to revert), `liftoff-address-review` (answer every
finding, cap rounds) and `liftoff-review-eval` (misses become eval cases).

Verification: test

## SKILL-005 Skills only use commands that exist

Every `liftoff <command>` a skill mentions exists in the command registry.
Skills check `liftoff capabilities --json` before calling Liftoff and fall
back to a manual, clearly unverified path when it is missing.

Verification: test

## SKILL-006 Liftoff uses its own skills

Liftoff's repository carries the rendered skills for Claude Code and Copilot.
`npm run check:generated` fails when they differ from a fresh render or a
managed file no longer has a source.

Verification: test

## SKILL-007 Skills to assess a project and its governance

Generated projects get the `liftoff-assess` skill, which runs
`liftoff assess` and explains its findings, gaps and next actions, and the
`liftoff-governance-assess` skill, which runs `liftoff governance assess`
and explains each checkpoint. Both only read: they change nothing in the
project or on GitHub, and they leave any change to the person, through the
commands the findings name.

Verification: test

## SKILL-008 A skill to repair a project with the person's approval

Generated projects get the `liftoff-repair` skill. It runs
`liftoff repair --check` and explains what needs attention. For a file a
recipe can put back, it offers the `liftoff repair --restore` command. For
anything else, it may prepare a unified diff outside the project, in a
temporary directory, and show it to the person, who reviews it and applies
it with `liftoff repair --patch` and the paths it may change. The skill
never edits the project's files itself, and never confirms a change for the
person.

Verification: test
