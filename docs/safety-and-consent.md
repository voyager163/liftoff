# Safety and consent

Liftoff separates project decisions, file replacement, workstation tools, and
project dependencies. No one permission implies another.

## Consent flags

| Flag | Authorizes | Does not authorize |
| --- | --- | --- |
| `--yes` | Project defaults and plan confirmation | File replacement, machine installs, or project dependencies |
| `--force` | During init, listed regular-file replacements; during update, exact reported conflicts | Manifest guards, symlinks, structural collisions, tools, dependencies, or non-empty migration targets |
| `--install-tools` | Allowlisted workstation installation commands | Project decisions, overwrites, or project dependencies |
| `--install-dependencies` | Locked project-local dependency commands after a successful merge | Machine tools, project decisions, or overwrites |

Interactive sessions ask separately at the point each permission is needed.

Selecting repository governance or passing `--yes` authorizes only deterministic
local handoff files. It never authorizes agent execution, Git mutation, GitHub
APIs, rulesets, security configuration, deployment, monitoring, file
replacement, machine tools, or project dependencies. Live activation begins
only after commit, push, read-only Phase 0, and explicit plan approval.

## CLI self-upgrade boundary

`liftoff upgrade` is itself the narrow authorization to replace a supported
global npm installation with one exact stable version. It accepts no project
path, `--yes`, `--force`, tool-install, or dependency-install permission.
`liftoff upgrade --check` is read-only and invokes no npm installation.

Both modes operate from a temporary neutral directory so a project `.npmrc`
cannot redirect machine-level discovery. Canonical npm selects the target while
the configured registry must provide that exact release. Liftoff does not expose
registry credentials, rewrite npm configuration, bypass a stale mirror, invoke
`sudo` or another elevation mechanism, or touch project files.

npm replacement is not a Liftoff file transaction. If npm or post-install
verification fails, Liftoff reports an exact-version repair command and does not
claim automatic rollback.

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

Plain `liftoff update` preflights all affected paths and applies generated file,
move, delete, and manifest mutations as one rollback-capable transaction.
Schema upgrades are committed only after the other mutations succeed. A
corrected retry converges from the restored state.

If automatic rollback itself cannot safely restore a path because another
process changed it, Liftoff reports the incomplete rollback rather than
overwriting unknown bytes.

Update snapshots exist only for rollback after a failed transaction. Liftoff
does not retain them as backups after success.

## Update ownership

Update mode is selected explicitly rather than from terminal interactivity:

- Clean generated files remain unchanged.
- Plain `liftoff update` immediately applies safe new, missing,
  untouched-upgrade, clean-move, and recorded-state changes without prompting,
  including with redirected input or output.
- `liftoff update --check` is read-only and performs no preflight or mutation.
- `liftoff update --json` applies safe changes and returns an apply result;
  `liftoff update --check --json` is the read-only machine drift gate.
- Developer edits that also differ from the current template are conflicts.
- Default update skips conflicts and lists them by portable relative path.
  After reviewing every listed overwrite, `liftoff update --force` extends the
  transaction only to those guarded conflicts.
- Unrecorded governance conflicts remain outside manifest ownership and produce
  `handoff-partial` until a later update safely writes or adopts every artifact.
- Orphans are reported and left on disk for manual review.
- Dependency definitions may be updated, but update never installs
  dependencies.

`--force` cannot be combined with `--check` and cannot weaken project-boundary,
symlink, collision, manifest, or transaction guards.

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

## Telemetry boundary

Liftoff sends only a recognized command name, CLI version, and zero/nonzero
outcome after a command completes. It creates no persistent installation or
session identifier and sends no arguments, paths, project data, errors, timing,
or host details.

Telemetry is enabled by default after a one-time disclosure. Set
`LIFTOFF_TELEMETRY=0` or `DO_NOT_TRACK=1` to disable it; `CI=true` disables it
automatically. Delivery is one bounded HTTPS attempt and cannot change command
output or exit status.

Azure necessarily handles a source network address while routing HTTPS, but
Liftoff does not include it in the event, derive geolocation from it, or persist
it in the product telemetry table. See [telemetry and privacy](telemetry.md) for
the exact fields, Azure boundary, OpenTofu deployment, and 180-day retention.

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
