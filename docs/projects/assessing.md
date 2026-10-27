# Assessing a project

`liftoff assess` checks a whole project, Liftoff's or not, against the
standard of the Liftoff release you have installed: the files and settings
that release generates for its supported stacks. It only reads. It runs no
script or tool, installs nothing, writes nothing into the project and, unless
you add `--live`, contacts no network service.

```bash
liftoff assess                     # run from the root of a Git repository
liftoff assess --dir ../service    # any directory, named explicitly
liftoff assess --json              # one liftoff.assessment/v1 report
liftoff assess --live --use-gh     # also read the repository on GitHub
```

It assesses the root of a Git repository, or another directory only when you
name it with `--dir`, and never your home directory or the root of the disk.

## What it looks at

It walks the project breadth first and never follows a link inside it; a
link that names the project directory itself is followed once, first. It skips
installed dependencies, caches and build output such as `node_modules`,
`.venv`, `dist`, `build`, `target` and `.git`, and stops at 50,000 entries,
10,000 in one directory, or 12 directories deep.

It reads only the declarations it interprets, up to 300 of them and 512 KiB
each:

- `pyproject.toml`, `package.json` and `go.mod`;
- Compose files and `.terraform.lock.hcl`;
- where a coverage threshold may be set: Vitest, Vite and Jest
  configuration, `pytest.toml`, `.coveragerc`, `setup.cfg`, `tox.ini` and
  `pytest.ini`, in the part's directory or at the root of a workspace it is
  in;
- the workflows in `.github/workflows`.

In a Liftoff project it also reads what `liftoff validate` reads. Every other
file is seen by name only. Files that may hold secrets or state, such as
`.env`, `.envrc`, `*.tfstate`, `*.tfvars`, private keys, `.npmrc`,
`credentials.json` and SQLite databases, are listed as not read.

## What it reports

- **The project:** whether it is a Git repository and a Liftoff project. Then
  its parts and stacks, such as a FastAPI backend in `api/` or a Vue frontend
  in `web/`, its development workflow and its coding-agent hosts.
- **Findings:** one per check, each with the paths it rests on. Each finding
  is one of:
  - *compliant*: seen, and as the standard asks.
  - *noncompliant*: seen, and different from the standard.
  - *unknown*: could not be told, for example because a declaration is not
    valid, or because the walk did not reach the place to look.
  - *unsupported*: something the release has no standard for, such as a Rust
    application or Bicep templates. It is not checked further.
  - *inaccessible*: closed to your user.
- **Gaps:** everything not walked or read, and why.
- **Next actions,** grouped by who acts:
  - *project*: you change the project.
  - *liftoff*: a Liftoff command does it, and is named.
  - *access*: someone grants access.
  - *unavailable*: this release cannot help yet. Adding a coding-agent
    host to a Liftoff project, for example, comes in a later release. A
    project that is not Liftoff's can be adopted with
    [`liftoff adopt`](adopting.md), or, when it has no backend this
    release supports, migrated with [`liftoff migrate`](migrating.md).

The checks cover:

- **Applications:** each part's stack, lock files and runtime versions.
- **Testing and builds:** tests and a coverage threshold, and a container
  build.
- **Databases:** migrations and a local database service.
- **Coding agents:** `AGENTS.md` and review skills for each coding-agent host.
- **CI:** a pull request workflow, `ci-gate`, CodeQL, dependency review and
  actions pinned to commit SHAs.
- **Governance:** the review policy, rulesets, pull request template,
  `REVIEW.md`, `GOVERNANCE.md` and Dependabot.
- **Infrastructure and docs:** locked OpenTofu providers, and `README.md`.

A member of an npm or uv workspace, by the workspace's globs, may have its
lock file at the workspace's root. A coverage threshold counts only when it
is configured, not when a description or comment mentions one. OpenTofu
root modules are grouped by the providers their lock files lock, so Azure
and another cloud are separate parts. When you assess a directory that is not the root of a Git
repository, such as one service in a monorepo, what GitHub and coding agents
look for at the root (workflows, governance files, `AGENTS.md` and review
skills) is unknown rather than missing when it is not there, since the root
may have it.

The command exits 0 when every finding is compliant and 3 otherwise.

## Live assessment

`--live` also reads the repository's governance on GitHub with your GitHub CLI
login, after you agree or with `--use-gh`. It uses the same read-only checks
as `liftoff governance assess`, described in
[Activating governance](governance-activation.md), and each checkpoint
becomes a finding. If GitHub will not show the repository, that finding is
inaccessible and the rest of the assessment is still reported.

## Coding-agent skills

Generated projects carry the `liftoff-assess` and `liftoff-governance-assess`
skills for each selected coding agent. They run these commands, explain the
results and leave every change to you.
