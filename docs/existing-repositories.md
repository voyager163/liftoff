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
2. Runs the official OpenSpec or Spec Kit initializer in staging.
3. Rejects unexpected roots, nested Git metadata, and unsafe paths.
4. Compares every destination before writing.
5. Lists different regular files as one replacement set.
6. Requires explicit overwrite permission before replacing that set.
7. Applies the authorized merge transactionally and rolls back handled
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
safe managed changes immediately and without prompting in terminals and
automation, while preserving conflicts and orphans. Review every reported
conflict and commit or copy local work before choosing `liftoff update --force`.
For CI drift gates, use `liftoff update --check --json`.

Projects created before manifest schema v5 automatically preview the default
repository-governance handoff as new named drift. Plain update safely adopts
collision-free policy, context, guide, and selected-agent launchers without
rewriting a configuration that omitted `governanceProfile`. Existing different
files remain unowned conflicts and the v5 manifest records `handoff-partial`.
Resolving every conflict promotes a later update to `handoff-generated`.
Selecting `none` leaves previously managed handoff files as undeleted orphans
while unrecorded conflicts remain user-owned. No update mode runs an agent or
activates GitHub settings.

Major supported-stack releases can report many runtime, lock, Docker, provider,
and framework artifact changes at once. Treat those releases as breaking:
commit or copy local work, inspect `liftoff update --check`, and apply only after
reviewing all upgrades and conflicts. Plain update preserves conflicting local
bytes and never requires `--force` as the default migration path.

If an applied baseline migration must be reversed, restore the project and
manifest through version control and reinstall from the restored locks. Liftoff
does not automatically downgrade generated dependencies and retains no backup
after a successful update.

## Existing non-Liftoff application

Use migration when you want a fresh governed scaffold and a filtered source
copy:

```bash
liftoff migrate ../legacy-app --region eastus --agents copilot,claude --yes
```

Migration requires a new or empty sibling target, runs the same readiness and
framework pipeline, and leaves the source byte-for-byte unchanged. `--force`
does not permit a non-empty migration target.

Arbitrary existing Power Apps application migration is not currently
supported.
