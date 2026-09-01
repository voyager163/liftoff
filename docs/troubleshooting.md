# Troubleshooting

## The installed version is older than canonical npm

Check the canonical release:

```bash
npm view @msn-control/liftoff@latest version --registry=https://registry.npmjs.org
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
npm install -g @msn-control/liftoff@latest --registry=https://registry.npmjs.org
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

## Update reports managed-core conflicts or orphans

`liftoff update` applies safe managed-core changes immediately and skips core
conflicts.

- Use `liftoff update --check` for a read-only human report or
  `liftoff update --check --json` for an automation drift gate.
- Project-owned application files never enter the report or mutation set.
- Managed-core conflicts remain untouched by default.
- Use `liftoff update --force` only after reviewing every listed path and
  deciding that each core overwrite is intended. Force cannot cross into
  project files or component-provisioning collisions.
- Managed-core orphans are never deleted automatically.
- Update neither changes nor installs project dependencies.

Commit or copy local work before overwriting. Transaction rollback protects a
failed update, but Liftoff keeps no backup after success.

For a new governance policy or launcher conflict, review that exact local file
before considering `liftoff update --force`; do not delete it or activate remote
governance merely to make update pass. The schema-v6 manifest records
`handoff-partial` and no ownership entry for each preserved unrecorded conflict.
Run `liftoff update --check` to inspect the remaining paths. Once each path is
absent or matches the current artifact, plain update promotes the handoff to
`handoff-generated`. Setting `governanceProfile` to `none` turns previously
managed handoff files into preserved orphans rather than deleting them; an
unrecorded conflicting file remains user-owned and is not reported as an
orphan.

If a newer Liftoff release contains different source, dependencies, schemas,
containers, environment files, Power Apps starter files, or infrastructure,
ordinary update intentionally reports nothing for those project-owned
differences. Review and migrate them as production changes. The existing
`liftoff migrate` command does not perform an in-place Liftoff project upgrade.

## Governance handoff exists but nothing is enforced

That is the expected initial state. The manifest records `handoff-generated`,
not active enforcement. Commit and push the repository, run the selected-agent
launcher, review its read-only Phase 0 report, and explicitly approve the plan
before the agent creates a governance change.

Missing licenses, a private Staging runner, alert routes, parallel deployment,
or sufficient canary traffic must be reported as blockers or inapplicable
controls. Do not replace them with duplicate scanners or placeholder success.

Do not run an older Liftoff release to reverse a completed baseline migration.
Restore the affected generated files and `liftoff.manifest.json` through version
control, then reinstall from the restored locks.

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

## Power Apps dependencies or CLI are missing

From the project root:

```bash
npm ci
npx --no-install power-apps --version
npm run dev
```

The CLI is project-local. Do not replace the locked install with an unrelated
global package.

## The Code Apps plugin is missing or not observable

Plugin state is advisory. In each selected agent session, use:

```text
/plugin marketplace add microsoft/power-platform-skills
/plugin install code-apps-preview@power-platform-skills
```

Then rerun `liftoff doctor`. Do not run `/create-code-app` in a Liftoff project.
Liftoff does not run Microsoft's broad plugin installer.

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
liftoff update --help
```

Unknown or incompatible inputs fail instead of falling back to another action.
