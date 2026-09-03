# Safety and consent

Liftoff separates project decisions, file replacement, workstation tools,
global OpenSpec profile configuration, Copilot cloud setup, and project
dependencies. No one permission implies another.

## Consent flags

| Flag | Authorizes | Does not authorize |
| --- | --- | --- |
| `--yes` | Project defaults and plan confirmation | File replacement, machine installs, global OpenSpec changes, Copilot cloud opt-in, or project dependencies |
| `--force` | During init, listed regular-file replacements; during update, exact reported conflicts | Manifest guards, symlinks, structural collisions, tools, global profile changes, dependencies, or non-empty migration targets |
| `--install-tools` | Allowlisted workstation installation commands | Project decisions, overwrites, global profile changes, or project dependencies |
| `--configure-openspec-profile` | The displayed global OpenSpec workflow, delivery, and profile changes | Tools, project files, dependencies, or Copilot cloud opt-in |
| `--copilot-cloud` / `--no-copilot-cloud` | Enable or disable OpenSpec's project-local hosted Copilot agent files | Global profile changes, tools, dependencies, or unrelated project writes |
| `--install-dependencies` | Locked project-local dependency commands after a successful merge | Machine tools, global profile changes, project decisions, or overwrites |

Interactive sessions ask separately at the point each permission is needed.

Selecting repository governance or passing `--yes` authorizes only deterministic
local handoff files. It never authorizes agent execution, Git mutation, GitHub
APIs, Azure or other cloud resources, rulesets, security configuration,
deployment, monitoring, file replacement, machine tools, or project
dependencies. Live activation begins only after commit, push, read-only Phase 0,
and explicit plan approval.

An approved downstream local-state bootstrap remains encrypted, gitignored, and
single-writer. It is never transferred through GitHub artifacts or secrets,
becomes read-only after verified remote import, and is securely deleted after
the fixed 30-day retention period with non-sensitive evidence.

Explicit Azure resource-provider registration is limited to namespaces used by
the approved plan. Registration must reach `Registered` before dependent
resources, and repository teardown must not unregister the retained
subscription capability.

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
2. Verifies the OpenSpec global profile when OpenSpec is selected and separately
   authorizes any required machine-wide change.
3. Renders Liftoff-owned artifacts into a temporary staging directory.
4. Runs the official OpenSpec or Spec Kit initializer in staging.
5. Rejects nested Git metadata, unexpected framework roots, symlinks, and
   malformed output.
6. Validates the full staged project.
7. Computes one immutable destination preflight.
8. Shows every different regular file that would be replaced.
9. Applies only an authorized preflight.

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

Plain `liftoff update` preflights every eligible managed-core or authorized
create-only provisioning path and applies those writes, managed-core moves or
deletes, and the manifest as one rollback-capable transaction. Schema upgrades
are committed only after the other mutations succeed.

If automatic rollback itself cannot safely restore a path because another
process changed it, Liftoff reports the incomplete rollback rather than
overwriting unknown bytes.

Update snapshots exist only for rollback after a failed transaction. Liftoff
does not retain them as backups after success.

## Update ownership

Update mode is selected explicitly rather than from terminal interactivity:

- Existing project artifacts are never compared with current template bytes.
- Plain `liftoff update` immediately applies safe new, missing,
  untouched-upgrade, clean-move, and recorded-state changes only for exact
  managed-core artifacts.
- `liftoff update --check` is read-only and performs no preflight or mutation.
- `liftoff update --json` applies safe changes and returns an apply result;
  `liftoff update --check --json` is the read-only machine drift gate.
- Managed-core developer edits are conflicts. Project edits are outside update.
- Default update skips core conflicts and lists them by portable relative path.
  `liftoff update --force` extends authority only to those guarded core
  conflicts.
- Project source, dependencies, schemas, containers, environments,
  documentation, and infrastructure cannot be restored or overwritten by any
  update mode.
- A newly selected frontend or environment is provisioned once only at absent
  or byte-identical destinations. A collision blocks the complete group and
  cannot be forced.
- Unrecorded governance conflicts remain outside manifest ownership and produce
  `handoff-partial` until a later update safely writes or adopts every artifact.
- Orphans are reported and left on disk for manual review.
- Dependency definitions and locks are project-owned; update neither changes
  nor installs them.

`--force` cannot be combined with `--check` and cannot weaken project-boundary,
symlink, collision, manifest, or transaction guards.

Power Apps starter source and metadata are project-owned after generation.
Update does not fetch upstream source or transition an existing project to a
newer packaged starter.

## Framework and seed ownership

OpenSpec and Spec Kit core/integration output is owned by their official
initializers. Liftoff validates the selected contract and agent markers but
does not claim framework-owned files in durable artifact hashes.

One-time seed content is also omitted from durable hashes so it can follow its
own lifecycle after generation.

OpenSpec workflow profile and delivery are global machine preferences. Liftoff
changes them only after dedicated consent and verifies the result before
staging. That global choice is not part of the project-file transaction and is
not automatically rolled back after a later failure. The Copilot cloud choice
is separate, defaults off, and is persisted by OpenSpec in the generated
project config.

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
