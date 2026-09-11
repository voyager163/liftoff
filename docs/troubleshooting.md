# Troubleshooting

## The installed version is older than canonical npm

Check the canonical release:

```bash
npm view @msn-control/liftoff@latest version --registry=https://registry.npmjs.org --@msn-control:registry=https://registry.npmjs.org
liftoff --version
liftoff upgrade --check
liftoff upgrade
```

Versions before 0.3.0 are unsupported.

If a managed registry exposes an older version, stop onboarding and ask the
mirror owner to synchronize or approve the release. Liftoff does not modify
`.npmrc`. A successful installation of an older mirrored package does not make
that version supported.

Versions that predate `liftoff upgrade` require one manual global installation:

```bash
npm install -g @msn-control/liftoff@latest
```

## CLI upgrade is blocked by installation origin

Automatic replacement supports only the canonical package at npm's effective
global package root. A local dependency, `npx` cache copy, linked checkout, or
another package-manager installation is intentionally refused. Use the manual
global npm command shown by Liftoff; do not try to make upgrade replace a
different installation.

## CLI upgrade is blocked by a stale managed registry

Canonical npm defines the exact stable target, but Liftoff installs through the
configured registry. Ask the mirror owner to synchronize or approve that exact
version, then rerun `liftoff upgrade --check`. Liftoff does not edit `.npmrc` or
bypass the managed registry.
The package's machine-level `@msn-control:registry` takes precedence over npm's
default `registry`. A canonical default does not cancel a scoped mirror.
Liftoff reads this configuration from a neutral directory, not a project's
`.npmrc`, and never prints credential-bearing registry values.

A response-body timeout is a transport failure, not invalid release metadata.
Retry after connectivity is restored; do not change registry policy or regenerate
project locks to work around it.

## npm cannot write the global prefix

Liftoff does not run `sudo`, request administrator credentials, or retry with
elevation. Resolve Node/npm global-prefix ownership through the approved
workstation process, then rerun the command.

## CLI replacement verification fails

Liftoff reports `failed` even when npm exited zero unless installed metadata and
`liftoff --version` both match the exact target. Run the exact-version global npm
repair command printed in the result. Liftoff does not claim an automatic
rollback after npm may have partially changed global state.

## An installed tool is still reported missing

Installers that change `PATH` may require a new terminal. Open one, rerun:

```bash
liftoff doctor
```

Do not assume installer exit code 0 proves readiness; the requirement probe
must pass.

## Initialization wants to create a child folder

In-place initialization occurs only when the current directory exactly matches
the Git worktree root:

```bash
git rev-parse --show-toplevel
pwd
```

Change to that root and rerun `liftoff init`. See
[existing repositories](existing-repositories.md).

## Initialization reports replacement conflicts

Review the complete replacement list. Approve interactively or rerun with
`--force` only when every listed regular file may be replaced.

`--force` cannot bypass directories, symlinks, unsafe ancestors, an existing
manifest, or a non-empty migration target. Move or rename the structural
conflict and retry.

## OpenSpec global profile is incompatible

Liftoff OpenSpec projects require profile `custom`, delivery `both`, and all 12
OpenSpec 1.11 workflows. Review the observed and required values printed by
Liftoff. Approve the separate interactive prompt or rerun the same command with
`--configure-openspec-profile` only when the machine-wide change is intended.

`--yes`, `--force`, `--install-tools`, and `--install-dependencies` do not
authorize this change. If configuration or verification fails, run
`openspec config list --json`, correct the reported OpenSpec issue, and retry
before any project files are written.

## OpenSpec wants to replace workflow files immediately

A fresh Liftoff project should already contain all 12 workflows as skills and
commands. Confirm that the same OpenSpec 1.11.0 binary, selected tools, global
profile, delivery, and `githubCopilot.cloudAgent` choice are still in effect.

For an older project, use:

```bash
openspec config profile
openspec update
```

Select both delivery modes and every workflow. Do not use `liftoff update
--force` to manage OpenSpec-owned skills or commands.

## Copilot cloud-agent files are missing

The GitHub-hosted coding agent is default-off and separate from Copilot in an
editor or terminal. Opt in during new initialization with `--copilot-cloud`.
For an existing project, set `githubCopilot.cloudAgent: true` in
`openspec/config.yaml` and run `openspec update`. The expected files are
`.github/workflows/copilot-setup-steps.yml` and
`.github/agents/openspec.agent.md`.

## A handled write failed

Liftoff reports whether rollback completed. Correct the filesystem problem and
retry. If rollback was incomplete, stop and inspect every reported path before
running another write command.

## Validation reports a malformed or unsafe manifest

Manifest paths must be portable path-part arrays confined to the project.
Traversal, absolute, drive-qualified, UNC, embedded-separator, empty, and
symlink-escaping paths are rejected before artifact access.

Restore `liftoff.manifest.json` from version control or regenerate the project
with the matching Liftoff version. Do not weaken path validation or retain a
hand-edited unsafe path.

## Update reports a missing preview

`preview-missing` means Liftoff found the project but has no saved update preview
for it in the current user-local store. It is not a requirement to repeat the
project folder or evidence of a storage fault. From inside the project, run
these commands separately:

```bash
liftoff update --check
liftoff update
```

Review the preview before approving apply. Check exits 2 when it finds actionable
work, so joining check and apply with `&&` would skip the second command.
A previously saved preview may have been consumed; run a fresh check rather than
assuming the earlier check is still available.

Human follow-ups omit a redundant `--project` when the current directory resolves
to the selected project. They retain an explicit target when operating on another
project or when the caller's context cannot be established. JSON remedies keep
explicit targets. Completion omits a redundant directory change only when
already at the project root.

A stale preview (`preview-mismatch`) also needs a fresh check and approval.
Storage, invalid-receipt, unsupported-format, and busy-operation failures have
their own remedies; repair the named condition instead of changing the project
argument or deleting an active lock.

## Update reports managed-core conflicts or orphans

Run `liftoff update --check` before apply. `liftoff update` requires the matching
preview and explicit approval, then applies its safe scope and skips core
conflicts. A missing or stale receipt requires a fresh check, not force.

- Use `liftoff update --check` for a project-read-only human report or add
  `--json` for automation. Both disclose an external preview receipt.
- Project-owned application files never enter the report or mutation set.
- Managed-core conflicts remain untouched by default.
- Use `liftoff update --force` only after reviewing every listed path and
  deciding that each core overwrite is intended. Force cannot cross into
  project files or component-provisioning collisions.
- Managed-core orphans are never deleted automatically.
- Update neither changes nor installs project dependencies.

Commit or copy local work before overwriting. Transaction rollback protects a
failed ordinary update. Activation migration additionally retains original
history after success; failed revalidation retains blocked/resumable v2.

For a new governance policy or launcher conflict, review that exact local file
before considering `liftoff update --force`; do not delete it or activate remote
governance merely to make update pass. The manifest-v7 record stores
`handoff-partial` and no ownership entry for each preserved unrecorded conflict.
Run `liftoff update --check` to inspect the remaining paths. Once each path is
absent or matches the current artifact, plain update promotes the handoff to
`handoff-generated`. Setting `governanceProfile` to `none` turns previously
managed handoff files into preserved orphans rather than deleting them; an
unrecorded conflicting file remains user-owned and is not reported as an
orphan.

If a newer Liftoff release contains different source, dependencies, schemas,
containers, environment files, or infrastructure,
ordinary update intentionally reports nothing for those project-owned
differences. Review and migrate them as production changes. The existing
`liftoff migrate` command does not perform an in-place Liftoff project upgrade.

If validation reports an unsupported `test` deployment environment, change the
desired-state and manifest environment selection to `staging` and review any
project-owned `environments/test` or `test.tfvars` content before renaming it.

## Generic GenAI project now needs a specialization

`pattern: generic` records that no specialized architecture was selected at
generation time. Do not change it to RAG, chatbot, agent, streaming,
fine-tuned, multi-agent, or workflow and expect `liftoff update` to rewrite the
application. Design and apply that transition as a reviewed project migration;
the existing project files and infrastructure are project-owned.

## Governance handoff exists but nothing is enforced

That is the expected initial state. The manifest records `handoff-generated`,
not active enforcement. Run `/liftoff-setup` from a selected agent. It first
completes, syncs, and archives the OpenSpec bootstrap, or finalizes Spec Kit's
real `000-liftoff-bootstrap` bundle locally after baseline checks. It then stops
at explicit authority gates for commit/push, credentials,
billed infrastructure or exceptions, final enforcement, destructive cleanup, or
external blockers. Rerun `/liftoff-setup` to resume; verified phases are not
repeated. Older generated setup aliases are retired; after review,
`liftoff update --force` removes exact modified retired alias entries from older
manifests.

Missing licenses, runner-provisioning authority, a private Staging assignment or
reachable network path, alert routes, parallel deployment, or sufficient canary
traffic must be reported as blockers or inapplicable controls. When private
Staging DAST applies and no suitable runner exists, Phase 0 may propose the
policy's repository-dedicated provisioning exception, but it must stop for
explicit approval before creating any Azure or GitHub resource. Do not replace
missing capability with duplicate scanners, partial provisioning, or
placeholder success.
These are target-policy requirements; 14 production phases lack executors and
two ruleset phases require an injected adapter absent from the public CLI.
Public approval persistence and credential enrollment also remain unavailable.
An unavailable executor or authority entry point is a blocker, not an instruction
to run its provider commands directly.

If a private ZRS state backend cannot be reached because public network access
is disabled and no approved private management path exists, do not enable
public access or upload local state to GitHub. The target policy requires an
explicitly approved minimum `bootstrap-local` phase, adoption through declarative
imports from the private runner, verify identity parity, locking, versioning,
and a clean no-change plan, then retain the frozen local state read-only for 30
days before secure deletion. That production adapter is not implemented by this
release; stop at the capability blocker and plan separately reviewed platform work.

If an Azure bootstrap fails with a namespace-not-registered error while
`resource_provider_registrations = "none"` is configured, do not retry the same
plan or enable broad auto-registration without review. Derive the provider set
from the planned resource types, add explicit missing registrations, confirm
subscription permission and terminal `Registered` readback, then regenerate a
no-apply plan. VNet-injected runner networking requires both
`Microsoft.Network` and `GitHub.Network`. Preserve successful registrations
during teardown.

If an ordinary Standard public IP requests
`Microsoft.Network/AllowBringYourOwnPublicIpAddress`, do not register BYOIP
unless the approved design actually imports a custom IP prefix. Remove
accidental feature-triggering properties or use a reviewed supported API shape,
then regenerate the no-apply plan.

Do not use `AzurePlatformDNS` in an Allow NSG rule. The special tag is deny-only
for disabling default platform DNS. Omit the rule when platform DNS is enabled,
or allow TCP and UDP 53 to exact custom resolver addresses.

## Governance doctor reports a blocked state

`liftoff doctor` and `liftoff governance status --json` use precise states:

| State | Remedy |
| --- | --- |
| `seed-incomplete` | Repair local checks, then explicitly retry the supported seed phase. OpenSpec archives; Spec Kit finalizes its real bundle locally. |
| `phase-blocked` | Read the phase, proof, and authority blocker; unavailable production or enrollment capabilities remain blocked. |
| `evidence-stale` | Obtain fresh proof through supported, authorized execution from current inputs; never edit receipts or reuse stale headers as current inputs. |
| `credential-expiring` | Rotate before the recorded lead time using the same App or PAT policy. |
| `reconciliation-required` | Review `liftoff update --check`. An exact supported v1 source can use the approved history-preserving successor lane; unknown formats remain blocked. Never edit JSON to acknowledge identity. |
| `identity-incompatible` | Upgrade when the supported tuple requires a newer CLI. A historical receipt never becomes executable through force, retagging, or an invented mapping. |
| `enforcement-incomplete` | Prove exact required contexts green and deliberately red, then approve final enforcement before ruleset mutation. |
| `disposal-pending` | Review retention, exact imported paths, destructive scope, and proof. Execution requires valid authority; there is no public approval-entry shortcut. |

Do not hand-edit task checkboxes to clear these states. Tasks are projections of
validated phase evidence.

## Runner-preflight credential setup is blocked

The policy prefers an existing verified selected-repository GitHub App with the
required read permissions. Its fallback contract describes a fine-grained PAT
with these fields: display name `<repo>-runner-preflight-read`, secret
`RUNNER_CONFIGURATION_READ_TOKEN`, 30-day lifetime, current repository only,
repository metadata read, organization hosted-runner read and
network-configuration read, no writes, and the recorded workflow/job allowlist
(`.github/workflows/bootstrap-import-preflight.yml` job
`bootstrap-import-preflight`; `.github/workflows/private-dast-preflight.yml` job
`private-dast-preflight` unless the generated policy records a narrower
applicable set).

This release does not expose public credential enrollment or masked input.
Do not create or submit a credential through an invented setup channel, and do
not hand-write state or receipts to bypass the capability blocker. Never paste
or show the value in chat, argv, command arguments, logs, evidence, files, or
screenshots. Revoke and rotate leaked credentials through their owner-controlled
system. A payload-free policy file alone is not independent readback evidence.

## Governance identity or manifest migration is blocked

Current Liftoff reads manifest v2-v7 and writes v7. It resumes only explicit
compatible tuples: policy version 6, activation contract 2, state/evidence-header/
approval/compatibility metadata versions 2, and a recognized phase-graph hash.
Phase graph, supersession, and credential-policy schemas stay at 1.
Future versions, individually
known but unsupported combinations, unknown graph hashes, or unversioned ad hoc
state block without rewriting files. Use the exact upgrade, import-mapping, or
reconciliation diagnostic printed by status or update; do not downgrade the
manifest or copy evidence between identities. Historical v1 state and evidence
remain diagnostic-only and byte-preserved. This release has no automatic or
public historical-state reconciliation workflow; managed-core update does not
make that history executable.

Do not run an older Liftoff release to reverse a completed baseline migration.
Restore separately reviewed project changes through version control and reinstall
from the restored locks; do not alter immutable activation evidence to claim
compatibility.

## Spec Kit setup reports seed adoption required

The real bundle must contain `specs/000-liftoff-bootstrap/spec.md`, `plan.md`,
and `tasks.md`, its identity markers, and B001–B006 exactly once. Framework
templates are not a substitute for project artifacts. Existing projects missing
the bundle need separate reviewed adoption; update, force, assessment, or
read-only resume will not create it. Never invent an OpenSpec archive or Git
branch to make Spec Kit setup pass.

## Infrastructure helpers or baseline report migration required

Independent roots require exact recorded shared-module/root provenance and safe
existing module files. Creating folders alone, changing tfvars paths, or updating
managed governance context does not establish eligibility. Existing flat-root
provenance remains unchanged after the explicit new-output-only retirement.
Do not move state or force new roots into place to clear the result; plan a
separate reviewed migration.

## Native startup rejects configuration or appears to ignore the file

Python and Node read root `.env`; Python backend-CWD startup still resolves that
same file. Go's backend-CWD recipe reads `../runtime.config.json`. Use
`LIFTOFF_ENV_FILE` for an explicit selection, relative to the startup directory
unless absolute. Process values override the file, and settings are resolved
once, so restart after edits.

An explicit missing, unreadable, malformed, invalid-UTF-8, or NUL-containing
dotenv file fails rather than falling back. Fix `KEY=value` syntax and balanced
quotes; Node rejects escaped quote delimiters, so use the other quote style.
Go requires valid JSON with string values, not null or numeric values.
Do not source configuration as shell code. An absent default file is allowed
only when the required settings come from process configuration.

For offline `/health`, `/ready`, and `/openapi.json` probes, provide
`DATABASE_URL` and `REDIS_URL` but leave `PYDANTIC_AI_MODEL`,
`LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_SECRET_KEY` blank. These probes do not
contact a model or prove external-service health. `PYDANTIC_AI_MODEL=test` is
not a supported model provider; no special test-model flag is needed.

See [runtime recipes](configuration-and-manifests.md#application-runtime-configuration).

## A locally prepared container build includes host files

Keep the generated root and frontend `.dockerignore` files in their respective
build contexts. They exclude host `.venv`, `node_modules`, caches, build output,
VCS metadata, state, and local secrets. Function publication uses its own
`.funcignore`. If those project-owned files were changed or removed, repair them
through reviewed project work; update or force cannot restore them.

## A frozen Python install cannot reach the package index

Keep the committed `pyproject.toml` and `uv.lock` unchanged and retry the
generated `uv sync --frozen` command when registry connectivity is restored.
Do not regenerate the lock as a connectivity workaround.

Python Dockerfiles also accept a credential-free PEP 503 mirror while retaining
the lock's exact versions and hashes:

```bash
docker build --build-arg UV_DEFAULT_INDEX=https://packages.example.test/simple/ .
```

Do not place credentials in build arguments. Configure authenticated registries
through an approved secret-aware build mechanism.

## Power Apps workload or Code Apps options are rejected

Power Apps creation and existing-project support are retired. The workload and
plugin options now fail explicitly; this is not a missing dependency or an
installation problem.

The rejection leaves application files, dependencies, framework files, and
historical state unchanged. Do not change the manifest's workload identity, hide
it to trigger another discovery path, or use force to bypass retirement. This
CLI provides no automatic conversion or continued Power Apps maintenance lane.

## Terminal output is hard to read or being captured

Rich output requires a wide TTY. Redirected output automatically uses
deterministic plain text. To disable color while retaining layout:

```bash
NO_COLOR=1 liftoff doctor
```

Use `--json` with validate, doctor, or update for machine consumption.

## `liftoff create` is rejected

Use:

```bash
liftoff init
```

The old command has no compatibility alias.

## Get command syntax

```bash
liftoff help
liftoff init --help
liftoff governance --help
liftoff update --help
```

Unknown or incompatible inputs fail instead of falling back to another action.
