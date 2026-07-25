# Troubleshooting

## The installed version is older than canonical npm

Check the canonical release:

```bash
npm view @msn-control/liftoff@latest version --registry=https://registry.npmjs.org
liftoff --version
```

Versions before 0.3.0 are unsupported.

If a managed registry exposes an older version, stop onboarding and ask the
mirror owner to synchronize or approve the release. Liftoff does not modify
`.npmrc`. A successful installation of an older mirrored package does not make
that version supported.

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

## Update reports conflicts or orphans

In an interactive terminal, `liftoff update` shows an impact summary and asks
before applying safe managed changes. The default answer is No.

- Local or user-owned conflicts are listed separately and require their own
  default-No overwrite confirmation.
- With redirected input or output, review the report and apply safe changes
  with `liftoff update --apply`.
- For prompt-free conflict replacement, use `liftoff update --apply --force`
  only after reviewing every listed path.
- Orphans are never deleted automatically.
- Update reports dependency-definition impact but does not install
  dependencies.

Commit or copy local work before overwriting. Transaction rollback protects a
failed update, but Liftoff keeps no backup after success.

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
