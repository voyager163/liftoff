# Contributing to Liftoff

Thank you for helping improve Mission Control Liftoff.

## Development setup

Install the toolchains exercised by the complete suite:

- Node.js 20.19 or newer for Liftoff; Node.js 22.12 or newer for Power Apps
  starter verification.
- Python 3.12.
- Go 1.23.
- OpenTofu 1.12.

Clone the repository and install locked dependencies:

```bash
git clone https://github.com/voyager163/liftoff.git
cd liftoff
npm ci
```

## Validate a change

Run the smallest focused test while iterating, then the complete package check:

```bash
npx vitest run tests/<focused-file>.test.ts
npm run check
```

Before a change is release-ready, also verify the packed artifact:

```bash
npm run smoke:package
npm run verify:standard-node-templates
```

The package smoke test builds, runs `npm pack`, checks the explicit package
surface and size budget, installs the tarball into an isolated prefix, and
executes the installed CLI. The standard template verifier generates a Node.js
backend with its Vue frontend, runs both locked installs, builds both projects,
and runs the generated backend tests without permitting package metadata
changes.

Changes to the Power Apps renderer, dependencies, lockfile, or assets also
require Node.js 22:

```bash
npm run verify:power-apps-starter
```

That verifier generates a fresh project, validates package metadata, runs the
root locked install, lint, and production build, and deletes the temporary
project.

Filesystem and manifest changes must remain portable across Windows, macOS,
and Linux. Use Node.js path utilities rather than hardcoded separators, and
preserve append-only manifest logical names and catalog identifiers.

Terminal presentation changes must preserve the rich, compact, plain,
`NO_COLOR`, JSON, version, and stdout/stderr contracts. Update focused renderer
and complete-screen snapshots under `tests/__snapshots__/`, review every
changed screen intentionally, and keep raw installer or dependency output
outside Liftoff-owned borders.

## Documentation

Public user guides are plain Markdown under `docs/`; the root README remains a
short landing page. Static README assets live under `docs/assets/`. No
documentation generator is required.

When editing documentation:

```bash
npx vitest run tests/documentation.test.ts
npm pack --dry-run --json
```

Keep root README links relative and package every linked local document and
asset. Move contributor-only build, packaging, release, and recovery detail
here rather than duplicating it in end-user onboarding.

## Refresh the Power Apps starter

Refresh only from a reviewed immutable commit in Microsoft's
`PowerAppsCodeApps` repository. Use Node.js 22 on Linux x64 so npm emits the
canonical optional-dependency metadata used by every supported host:

```bash
npm run refresh:power-apps-starter -- <40-character-commit-sha>
```

The maintainer script downloads the immutable archive, rejects symlinks and
excluded runtime output, preserves existing logical names by path, verifies
the MIT license, regenerates `package-lock.json` with the pinned npm version,
records hashes and provenance, displays the source diff, and updates the
catalog commit.

After the script completes:

1. Review every upstream source and dependency change.
2. Confirm new logical names are stable and removed names are handled as
   update orphans.
3. Review license and attribution changes.
4. Update commit-specific package smoke assertions.
5. Run `npm run verify:power-apps-starter`.
6. Run `npm run check` and `npm run smoke:package`.

Do not edit vendored starter bytes or catalog hashes by hand to bypass a failed
integrity check.

## Audit packaged template dependencies

Liftoff ships npm lockfiles for the standard Node.js backend, standard frontend,
and pinned Power Apps starter. Run their live canonical-registry audit
separately from the root package audit:

```bash
npm run audit:template-dependencies
```

The command is read-only: it must not install dependencies, create
`node_modules`, or modify package metadata. The `Template dependency audit`
workflow runs the same command weekly and through manual dispatch. Ordinary
pull-request CI uses committed fixtures so new registry advisories or registry
outages do not make unrelated test runs nondeterministic.

The explicit inventory and audit engine live under `scripts/`.
`security/template-dependency-exceptions.json` records findings that have been
reviewed but cannot yet be removed safely. Each exception is scoped to one
advisory, package, exact manifest path, and complete dependency-chain set. It requires
technical evidence, mitigation, an owner, and bounded review dates:

- high and critical findings expire within 30 days;
- moderate and lower findings expire within 90 days.

Do not renew an exception automatically. Reconfirm the vulnerable API remains
unreachable, update its evidence and upstream reference, then set a new review
window. Remove stale exceptions immediately after a dependency refresh.

Refresh Liftoff-owned standard lockfiles on Linux x64. Resolve with Node.js 22
and pinned npm 11.7.0, then normalize the final lockfile with the oldest
supported Node.js 20 package-manager baseline, npm 10.8.2. Update the narrow
manifest range first, then run from the affected asset directory:

```bash
npx --yes npm@11.7.0 install --package-lock-only --ignore-scripts --no-audit --no-fund
npx --yes npm@10.8.2 install --package-lock-only --ignore-scripts --no-audit --no-fund
npx --yes npm@10.8.2 ci --ignore-scripts --no-audit --no-fund
```

Prefer the smallest compatible patched line. Do not use `npm audit fix`, force
an unrelated major upgrade, downgrade a dependency to hide an advisory, or add
an unverified transitive override. The npm 10 pass is required because newer
npm releases can omit nested optional-peer records that the supported baseline
still requires. Afterward run the focused security tests, the standard template
verifier, package smoke, and the live audit.

For the Power Apps starter, use the immutable refresh procedure above rather
than editing package metadata or lockfile bytes. A new starter commit changes
the audit inventory path and requires every exception to be reviewed again.

## Propose behavior changes

Liftoff uses OpenSpec for product behavior and compatibility contracts.
Observable behavior changes should include an OpenSpec change under
`openspec/changes/` and update every affected capability specification.

Before completing an OpenSpec implementation:

```bash
openspec validate <change-name> --strict
```

## Pull requests

- Keep changes focused and include tests for changed behavior.
- Update user and contributor documentation when commands, generated output,
  or workflows change.
- Confirm generated projects contain no credentials or environment-specific
  values.
- Do not change persisted manifest identity or append-only identifiers without
  an explicit compatibility design.
- Include generated-project verification when templates or dependencies
  change.

## Release verification

The public release authority is `https://registry.npmjs.org`. The `Release
Liftoff` workflow runs package checks, package smoke, a pack inspection, and
release-identity validation before publishing. It uses npm trusted publishing
with provenance and verifies the published dist-tag from canonical npm
afterward.

Before tagging, update package and lockfile metadata together and run:

```bash
npm run verify:release-identity
npm run verify:release-identity -- v0.6.0
```

Replace the example tag with the intended release. The Git tag, root package
metadata, root lockfile metadata, packed package version, and installed
`liftoff --version` output must all identify the same release.

Stable versions publish with `latest`; prereleases publish with `next`. The
post-publish verifier must remain after `npm publish`, receive the selected
dist-tag, and must not use `continue-on-error` or legacy compatibility mode.

## Release recovery

If canonical post-publish verification fails, do not announce the release as
complete. Compare the expected and observed dist-tag versions.

- Correct the dist-tag when the expected immutable package already exists.
- Otherwise publish a corrected patch release.
- Do not unpublish a released package as routine recovery.

A successful canonical release does not make an external managed mirror ready.
Teams using a managed registry must withhold internal installation guidance
until the mirror exposes both the canonical stable dist-tag and explicit
version and a clean mirrored install reports the expected version.

Pre-0.3 releases remain available for reproducibility. An authorized npm
release owner applies the warning without unpublishing:

```bash
npm deprecate '@msn-control/liftoff@<0.3.0' 'Liftoff versions before 0.3.0 are unsupported. Upgrade to @msn-control/liftoff@latest.' --registry=https://registry.npmjs.org
```

Verify that an old explicit version retains both the warning and tarball:

```bash
npm view @msn-control/liftoff@0.2.1 deprecated --registry=https://registry.npmjs.org
npm view @msn-control/liftoff@0.2.1 dist.tarball --registry=https://registry.npmjs.org
```

## License and security

By contributing, you agree that your contribution is licensed under
GPL-3.0-only.

Report security vulnerabilities through the private process in
[SECURITY.md](SECURITY.md), not a public issue.
