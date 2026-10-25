# Projects

Creating a project and checking it afterwards: `plan`, `init`, `validate` and
`doctor`, the files they read and write, and what a generated project
contains.

## PROJ-001 The project configuration is strict and versioned

`liftoff.yaml` holds the project's desired state with
`schema: liftoff.config/v1`. Unknown keys, invalid names and duplicate agents
or owners are rejected with a message naming the field. The same
configuration always serializes to the same bytes.

Verification: test

## PROJ-002 The manifest inventories every generated file

`.liftoff/manifest.json` lists every file Liftoff generated with its
ownership, sha256 and the plugin that produced it, plus the plugin versions
and the Liftoff version. Ownership is declared, never inferred:

- **managed**: Liftoff keeps it current; a hand edit is reported as drift.
- **seeded**: written once, then owned by the project; Liftoff never
  overwrites it.

Paths are repository-relative POSIX paths. No absolute or private paths are
written into a project.

Verification: test

## PROJ-003 Selections are checked before anything is generated

The workload, stack, workflow, agents, governance profile and review engine
are checked against the plugins this release ships. An unknown value is a
usage error (exit 2). A value the product supports but this release cannot
generate yet, such as the OpenSpec workflow or the team profile, is reported
as unsupported (exit 6), never silently replaced. The review engine must be a
selected agent, and verified AI review needs at least one agent.

Verification: test

## PROJ-004 Generation is deterministic and collision-free

The same configuration and release always produce the same files and bytes,
on macOS and Windows. Two plugins writing the same path, or a plugin writing
an unsafe or reserved path, stops generation with an error.

Verification: test

## PROJ-005 The Python API project follows the API contract

A `python-fastapi` project has FastAPI, SQLAlchemy, Alembic and a committed
uv lock; listens on port 8000; separates `/health/live` (no dependencies) from
`/health/ready` (checks PostgreSQL, 503 when unavailable); serves OpenAPI and
Scalar docs; has an initial migration with a working downgrade; reads
configuration from the environment, then an explicitly named TOML file, then
non-secret defaults, failing on a named file that is missing, malformed or has
unknown settings; and ships tests with an 80% coverage gate, a Dockerfile that
runs as an unprivileged user and a Compose file with PostgreSQL. It contains no
GenAI dependencies.

Verification: test

## PROJ-006 A generated project passes its own checks on macOS and Windows

Liftoff's CI generates a project on macOS arm64 and Windows x64 and runs its
locked install, lint, format and tests there.

Verification: live

## PROJ-007 Coding-agent files only for the selected hosts

With no agents (Manual) a project gets no agent instructions, skills or
agents. With agents it gets AGENTS.md, CLAUDE.md when Claude Code is
selected, the review and setup skills in each host's native directory and the
read-only verifier agent. The verified AI review runs on one selected host:
the one named with `--review-engine`, otherwise Copilot, then Claude, then
Codex.

Verification: test

## PROJ-008 Governance is a handoff, not enforcement

GitFlow profiles generate GOVERNANCE.md, branch rulesets under
`.github/rulesets/` and a drift workflow, but apply nothing: the rulesets
take effect only when a person applies them after the checks they require
have run. CODEOWNERS is generated only when owners are given. The `none`
profile generates no governance files.

Verification: test

## INIT-001 Plans are read-only and tamper-evident

`liftoff plan` changes nothing except the plan file named with `--out`. A
plan lists the target, configuration, every file with its ownership, hash and
size, and the only permitted effect (writing files). Its hash covers every
field, so an edited plan is refused.

Verification: test

## INIT-002 Projects are created in one step or not at all

`liftoff init` creates projects only in a new or empty directory. All files
are written into a staging directory beside the target and published with one
rename; if anything fails, the staging directory is removed and nothing is
created. The new directory gets normal permissions.

Verification: test

## INIT-003 Init asks before writing

`liftoff init` shows what it will create and asks for confirmation, with no as
the default. Declining exits 4 (cancelled) and writes nothing. Without a
terminal it refuses to write unless `--yes` is given (exit 2).

Verification: test

## INIT-004 Stale plans are refused

A plan made by a different Liftoff version, or one this release would now
generate differently, is refused with a request to make a new plan.

Verification: test

## VALID-001 Validate reports what changed without repairing it

`liftoff validate` checks the configuration, the plugins it names and every
file in the manifest. Missing or hand-edited managed files and missing seeded
files are reported; unknown plugins and invalid files are errors; newer plugin
versions are information. It exits 3 when there is anything to act on and
changes nothing.

Verification: test

## VALID-002 Projects from before the rebuild are recognized

A directory with the old `liftoff.config.json` or `liftoff.manifest.json` is
reported as a project from a Liftoff release before the rebuild, which this
release cannot read or update. Nothing from the old format is executed or
migrated.

Verification: test

## DOCTOR-001 Doctor checks only the tools the project needs

`liftoff doctor` runs the version command of each tool the project's stack
needs (or, outside a project, the tools every project needs) and reports each
as ok, missing, too old or of unknown version, with how to install it. It
installs nothing and exits 3 when a required tool is not ready.

Verification: test
