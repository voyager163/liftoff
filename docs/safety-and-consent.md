# Safety and consent

Liftoff separates project decisions, file replacement, workstation tools, and
project dependencies. No one permission implies another.

## Consent flags

| Flag | Authorizes | Does not authorize |
| --- | --- | --- |
| `--yes` | Project defaults and plan confirmation | File replacement, machine installs, or project dependencies |
| `--force` | Only listed and validated regular-file replacements | Manifest guards, symlinks, structural collisions, tools, dependencies, or non-empty migration targets |
| `--install-tools` | Allowlisted workstation installation commands | Project decisions, overwrites, or project dependencies |
| `--install-dependencies` | Locked project-local dependency commands after a successful merge | Machine tools, project decisions, or overwrites |

Interactive sessions ask separately at the point each permission is needed.

## Staged initialization

Initialization does not write generated files directly into the destination.
Liftoff:

1. Resolves and validates a project plan.
2. Renders Liftoff-owned artifacts into a temporary staging directory.
3. Runs the official OpenSpec or Spec Kit initializer in staging.
4. Rejects nested Git metadata, unexpected framework roots, symlinks, and
   malformed output.
5. Validates the full staged project.
6. Computes one immutable destination preflight.
7. Shows every different regular file that would be replaced.
8. Applies only an authorized preflight.

Unrelated destination files are preserved.

## Overwrite boundaries

A different regular file can be replaced only after explicit permission.
Structural collisions are not overridable:

- A generated file collides with a directory or another non-file entry.
- An ancestor is not a directory.
- A path is a symlink or escapes the project root through one.
- The destination already contains `liftoff.manifest.json`.
- A migration target is non-empty.

`--force` cannot weaken these guards.

## Atomic writes and rollback

Individual project files use temporary-file replacement. Initialization keeps
backups for replaced files and records created files and directories. A handled
merge failure restores or removes those entries in reverse order.

An accepted interactive update or `liftoff update --apply` preflights all
affected paths and applies generated file, move, delete, and manifest mutations
as one rollback-capable transaction. Schema upgrades are committed only after
the other mutations succeed. A corrected retry converges from the restored
state.

If automatic rollback itself cannot safely restore a path because another
process changed it, Liftoff reports the incomplete rollback rather than
overwriting unknown bytes.

Update snapshots exist only for rollback after a failed transaction. Liftoff
does not retain them as backups after success.

## Update ownership

Plain `liftoff update` always reports drift before any write:

- Clean generated files remain unchanged.
- In an interactive terminal, new, missing, untouched-upgrade, clean-move, and
  recorded-state changes are summarized and offered through a default-No
  confirmation.
- With redirected input or output, or with `--json`, update remains a
  prompt-free read-only check unless `--apply` is explicitly supplied.
- Developer edits that also differ from the current template are conflicts.
- Safe-update consent does not authorize conflicts. Interactive conflicts are
  listed by portable relative path and require a separate default-No overwrite
  confirmation; automation uses `--apply --force`.
- Orphans are reported and left on disk for manual review.
- Dependency definitions may be updated, but update never installs
  dependencies.

All interactive decisions are collected before preflight or mutation.
Declining the safe update changes nothing and leaves drift exit code 2.

Power Apps reconciliation reads only the packaged immutable starter. It does
not fetch the upstream repository. Workload kind and user-edited starter
repository, template path, or commit changes are rejected before artifact
access.

## Framework and seed ownership

OpenSpec and Spec Kit core/integration output is owned by their official
initializers. Liftoff validates the selected contract and agent markers but
does not claim framework-owned files in durable artifact hashes.

One-time seed content is also omitted from durable hashes so it can follow its
own lifecycle after generation.

## Credentials and external actions

Generated files contain configuration boundaries, not real credentials.
Liftoff does not:

- Modify `.npmrc` to bypass a managed registry.
- Store cloud or agent credentials.
- Perform cloud sign-in.
- Apply OpenTofu.
- Bind or push a Power Apps code app.
- Run Microsoft's broad Code Apps marketplace installer.

Those actions require their own review, authentication, and consent.
