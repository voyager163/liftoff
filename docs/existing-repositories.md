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
liftoff update
liftoff update --apply
```

In an interactive terminal, plain update reports drift and impact, then asks
with a default of No before applying safe managed changes. Local or user-owned
conflicts require a separate default-No overwrite decision. Redirected and
JSON checks remain read-only and prompt-free; use `--apply` for explicit
automation consent.

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
