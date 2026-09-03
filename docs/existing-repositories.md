# Existing repositories

Liftoff chooses its target from the current directory and Git worktree
discovery before it stages any output.

## Exact Git root: initialize in place

When the current directory is exactly the root reported by
`git rev-parse --show-toplevel`, `liftoff init` uses that directory as the
target:

```bash
cd existing-repository
liftoff init
```

With no project name, Liftoff derives project identity from the repository
directory. Supplying a name changes the generated project identity but still
does not create a child folder:

```bash
liftoff init customer-portal
```

## Other locations: create a named child

In a non-Git directory, or in a directory below but not equal to a Git root, a
project name produces a child:

```text
workspace/
`-- customer-portal/
    |-- liftoff.config.json
    `-- liftoff.manifest.json
```

This distinction prevents an invocation deep inside an existing repository
from unexpectedly treating that subdirectory as the repository root.

## Non-empty targets

Liftoff never blindly replaces a target tree. It:

1. Renders Liftoff-owned files in temporary staging.
2. Verifies or separately configures the required global OpenSpec profile.
3. Runs the official OpenSpec or Spec Kit initializer in staging.
4. Rejects unexpected roots, nested Git metadata, and unsafe paths.
5. Compares every destination before writing.
6. Lists different regular files as one replacement set.
7. Requires explicit overwrite permission before replacing that set.
8. Applies the authorized merge transactionally and rolls back handled
   failures.

Unrelated existing files are preserved. Structural collisions, symlinks,
unsafe ancestors, and an existing `liftoff.manifest.json` are blockers that
`--force` cannot bypass.

See [safety and consent](safety-and-consent.md) for the complete permission
model.

## Existing Liftoff project

If the target already contains `liftoff.manifest.json`, do not run init again.
Use:

```bash
liftoff validate
liftoff update --check
liftoff update
```

Use `--check` first when the invocation must be read-only. Plain update applies
safe managed-core changes immediately and preserves core conflicts and orphans.
`--force` can replace only listed core conflicts. Project-owned production
files are not compared and remain unreachable from every update mode. For CI
core-maintenance gates, use `liftoff update --check --json`.

OpenSpec skills and commands remain framework-owned. To give an existing
project all 12 workflows as both skills and commands, run:

```bash
openspec config profile
openspec update
```

Select both delivery modes and every workflow in the profile picker. Plain
`liftoff update` does not regenerate OpenSpec integrations. To change the
hosted Copilot agent later, update `githubCopilot.cloudAgent` through OpenSpec
and run `openspec update`.

Projects created before manifest schema v6 automatically preview the default
repository-governance handoff as new named drift. Plain update safely adopts
collision-free policy, context, guide, and selected-agent launchers without
rewriting a configuration that omitted `governanceProfile`. Existing different
files remain unowned conflicts and the v6 manifest records `handoff-partial`.
Resolving every conflict promotes a later update to `handoff-generated`.
Selecting `none` leaves previously managed handoff files as undeleted orphans
while unrecorded conflicts remain user-owned. No update mode runs an agent or
activates GitHub settings.

Projects carrying governance policy versions 2 through 4 preview policy version 5 as
managed-core drift. Review the private-runner and bootstrap-state retirement
contracts before replacement. Updating the handoff never provisions Azure or
GitHub resources; reconcile any active downstream runner change with version 5
before applying its infrastructure.

The schema-v6 transition releases every legacy non-core artifact into project
provenance without writing, restoring, moving, or deleting its path.
Intentionally removed infrastructure stays absent and production source stays
byte-for-byte unchanged.

Major supported-stack releases apply to new scaffolds. Existing projects adopt
runtime, lock, Docker, provider, framework, and application changes through a
normal reviewed project change. Ordinary update and force cannot perform that
migration, and the existing `liftoff migrate` command remains a fresh-target
workflow for non-Liftoff sources.

A project generated with `pattern: generic` follows the same ownership rule.
When its specialization becomes clear, migrate the project-owned routes,
orchestration, data, and infrastructure through a reviewed project change.
Changing the configuration to RAG, chatbot, or another pattern and running
`liftoff update` is intentionally rejected.

## Existing non-Liftoff application

Use migration when you want a fresh governed scaffold and a filtered source
copy:

```bash
liftoff migrate ../legacy-app --region eastus --agents copilot,claude --yes
```

Migration requires a new or empty sibling target, runs the same readiness and
framework pipeline, including separate global OpenSpec profile authorization,
and leaves the source byte-for-byte unchanged. `--force` does not permit a
non-empty migration target.

Arbitrary existing Power Apps application migration is not currently
supported.
