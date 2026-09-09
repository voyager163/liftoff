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
| `liftoff governance apply-next --execute` | Execute at most one reviewed, graph-ready, evidence-ready governance transition | Earlier or later phases, broader resources, credentials outside the envelope, live plan/apply during baseline, force-push, reset, rebase, or unknown-file deletion |

Interactive sessions ask separately at the point each permission is needed.

Selecting repository governance or passing `--yes` authorizes only deterministic
local handoff files. It never authorizes agent execution, Git mutation, GitHub
APIs, Azure or other cloud resources, rulesets, security configuration,
deployment, monitoring, file replacement, machine tools, or project
dependencies. `/liftoff-setup` first verifies and archives the OpenSpec bootstrap
or finalizes the real Spec Kit bundle locally, then stops at authority gates.
Live activation requires explicit
commit/push approval, read-only Phase 0, and activation-plan approval.
Missing public approval persistence, secure credential enrollment, or production
executors remain blockers; this sequence does not promise a complete production
activation workflow.

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
Machine-level `@msn-control:registry` takes precedence over default `registry`;
canonical verification isolates both settings, but installation still honors
the effective delivery registry.

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

Project mutations share an exclusive cooperating-writer lock across initialization,
migration, dependency setup, managed update, and setup execution. The lock is a
sibling file named `.liftoff-mutation-<project-path-digest>.lock`, created with
0600 mode where POSIX permissions apply; the target's
parent directory must be writable. Reserving a new target does not create that
target or project state. Nested steps in one operation retain the same lock.
Reservation identities are NFC-normalized and lowercased on every platform; this
may serialize case-distinct sibling projects on case-sensitive volumes, but never
merges their ownership.
Read-only commands, including assessment and `update --check`, never acquire it.
An existing or changed lock blocks mutation and is never automatically stolen or
removed. After an interrupted process, verify its owner has stopped before
reviewing the exact reported lock. This coordinates Liftoff writers; it does not
replace path/content preconditions or isolate the project from other programs.

Individual project files use temporary-file replacement. Initialization keeps
backups for replaced files and records created files and directories. A handled
merge failure restores or removes attributable unchanged entries in reverse
order; concurrent or uncertain edits are preserved and reported.
Existing destination modes are preserved where supported, including POSIX 0600
files. Windows does not provide equivalent POSIX mode-bit guarantees; this is
not a promise to preserve all Windows ACLs or filesystem metadata.

`liftoff update --check` presents compatibility and the exact proposed changes,
then discloses its external preview receipt without changing project bytes.
Apply requires that matching preview and explicit exact-plan approval. It
rechecks protected inputs under the project lock before writing. Noninteractive
approval uses `--approve-plan <fingerprint>`, not a generic yes.

The approved transaction preflights exact managed-core and create-only
provisioning paths separately from any explicitly authorized activation migration.
Schema/successor changes commit consistently with their manifest and history link.

Managed update may install manifest v7, policy v6, activation-contract v2,
phase graph, compatibility metadata, credential-policy schema, setup
integrations, and forced removal of exact retired generated setup-alias entries
from older manifests. It preserves user-owned activation state, approvals,
immutable evidence, credential policies, active OpenSpec changes, and bootstrap
retention/disposal records. If the current activation identity is future,
unsupported, or graph-incompatible, update and setup block with a remedy instead
of downgrading or rewriting state.
Exact known historical v1 can use the reviewed successor lane, not in-place
retagging. Original records are copied byte-for-byte into immutable in-project
history before their exact active paths are retired or replaced. A linked v2
activation obtains fresh evidence; historical approvals never become current
permission. Unavailable revalidation remains an explicit blocker.

If automatic rollback itself cannot safely restore a path because another
process changed it, Liftoff reports the incomplete rollback rather than
overwriting unknown bytes.

Ordinary transaction backups are for failed-write recovery. Activation history
is different: it remains after success and is never removed with disposable
preview receipts. A durable recovery journal must match a separately persisted
external transaction approval; a project-local claim alone cannot authorize
recovery. Post-commit revalidation failure preserves v2 and its historical link.

Dependency execution has a different recovery boundary: installer scripts can
write arbitrary project files, and a concurrent developer edit cannot be
attributed safely from a content difference alone. Changed or deleted protected
metadata is therefore preserved and reported, not automatically restored.
Liftoff stops further dependency commands and identifies the recovery shell and
literal-path recipe. This does not claim the entire scaffold was unchanged.

## Update ownership

Update mode is selected explicitly rather than from terminal interactivity:

- Existing project artifacts are never compared with current template bytes.
- Plain `liftoff update` applies the matching explicitly approved plan, retaining
  safe managed-core classification and the separate migration/provisioning lanes.
- `liftoff update --check` changes no project bytes but saves and discloses a
  preview receipt outside the repository.
- `--json` changes output formatting only; machine apply still requires the
  matching preview and exact plan-fingerprint approval.
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
- A new environment additionally requires recorded independent-root provenance
  and safe existing shared-module files. Legacy or unknown layouts are blocked
  without moving state or rewriting project-owned infrastructure.
- Unrecorded governance conflicts remain outside manifest ownership and produce
  `handoff-partial` until a later update safely writes or adopts every artifact.
- Orphans are reported and left on disk for manual review.
- Dependency definitions and locks are project-owned; update neither changes
  nor installs them.

`--force` cannot be combined with `--check` and cannot weaken preview, approval,
compatibility, project-boundary, symlink, collision, manifest, or transaction guards.

Power Apps support is retired. Its manifests are rejected without fetching
starter source, changing application files, or treating force as conversion
authority.

The eight flat-root OpenTofu identities are retired from new 0.11.0 output only.
Their historical records, paths, generation hashes, files, and state remain
unchanged by update, force, helpers, or assessment. They are not aliases to new
roots or managed-core deletion targets; see the
[explicit inventory](azure-deployment.md#explicit-flat-root-identity-retirement).

## Framework and seed ownership

OpenSpec and Spec Kit core/integration output is owned by their official
initializers. Liftoff validates the selected contract and agent markers but
does not claim framework-owned files in durable artifact hashes.

One-time seed content is also omitted from durable hashes so it can follow its
own lifecycle after generation. Spec Kit's `000-liftoff-bootstrap` bundle is
project-owned, separate from official markers, and not an active governance
change. Missing older seeds require reviewed adoption. Failed local checks leave
B001–B006 unchecked; explicit successful execution commits the projection with
body/full-plan-bound evidence. Read-only verify, status, and resume never mark it.

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
- Restore or manage the retired Power Apps workload or Code Apps integration.

Those actions require their own review, authentication, and consent.

Governance runner-preflight credentials have a stricter contract. Setup first
uses an existing verified selected-repository GitHub App installation when it
has the required read permissions. The normative fallback specifies one
fine-grained PAT:
display name `<repo>-runner-preflight-read`, repository secret
`RUNNER_CONFIGURATION_READ_TOKEN`, 30-day lifetime, current repository only,
repository metadata read, organization hosted-runner read and
network-configuration read, no writes, and only the recorded workflow/job
allowlist. The CLI currently lacks public secure enrollment, independent
credential readback, and approval-persistence entry points; stop at the capability
blocker instead of creating JSON or inventing an input channel. Any future
supported enrollment must use masked input. Never paste or
show it in chat, argv, command arguments, logs, evidence, generated files, or
screenshots. If it appears there, treat it as compromised and manually revoke and
rotate it before continuing.
