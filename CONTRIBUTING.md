# Contributing to Liftoff

Thank you for helping improve Mission Control Liftoff.

## Development setup

Install the toolchains exercised by the complete suite:

- Node.js 24.20 or newer for Liftoff and Power Apps starter verification.
- Python 3.14 and `uv` 0.12.7 or newer.
- Go 1.27.
- OpenTofu 1.12.6.

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
npm run verify:generated-containers
npm run check:supported-stack
```

Changes to the telemetry gateway, container, or Azure service also require:

```bash
npm ci --prefix services/telemetry-ingest
npm run check --prefix services/telemetry-ingest
npm run package --prefix services/telemetry-ingest
npm run smoke:container --prefix services/telemetry-ingest
tofu -chdir=infrastructure/opentofu/telemetry init -backend=false
tofu -chdir=infrastructure/opentofu/telemetry validate
```

The container smoke test requires a running Docker daemon. Standard hosted CI
performs these static and local checks but never plans or applies production.

On a Microsoft-managed device, pass the approved registries into generated
container verification:

```bash
npm_config_registry=https://packagefeedproxy.microsoft.io/npm/ \
npm_config_allow_remote=all \
UV_DEFAULT_INDEX=https://packagefeedproxy.microsoft.io/pypi/simple \
  npm --replace-registry-host=never run verify:generated-containers
```

The npm proxy returns approved backing-feed tarball URLs. Disabling registry-host
replacement prevents a user-level `replace-registry-host=always` setting from
rewriting those URLs into invalid proxy paths; npm 12 requires the command-local
remote opt-in for that redirect. Do not persist either override globally.

The package smoke test builds, runs `npm pack`, checks the explicit package
surface and size budget, installs the tarball into an isolated prefix, and
executes the installed CLI, upgrade help, and an injected read-only self-upgrade
check without selecting the host global prefix. The standard template verifier generates a Node.js
backend with its Vue frontend, runs both locked installs, builds both projects,
and runs the generated backend tests without permitting package metadata
changes.

Changes to the Power Apps renderer, dependencies, lockfile, or assets also
require Node.js 24:

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

Release-owned compatibility, deterministic setup version vectors, bump rules,
graph integrity, credential leak tests, cross-agent equivalence, and npm trusted
publishing requirements live in [DEVELOPER.md](DEVELOPER.md).

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
`PowerAppsCodeApps` repository. Use Node.js 24 on Linux x64 so npm emits the
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

The command defaults to canonical npm. On a Microsoft-managed device where
public registries are blocked, use the approved feed for local verification:

```bash
LIFTOFF_NPM_AUDIT_REGISTRY=https://packagefeedproxy.microsoft.io/npm/ \
  npm run audit:template-dependencies
```

GitHub-hosted workflows leave this override unset and continue to audit against
`https://registry.npmjs.org`.

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

Refresh Liftoff-owned standard lockfiles on Linux x64. Resolve with Node.js 24
and pinned npm 12.0.2, then verify the final lockfile with the supported
npm 10.9.4 and npm 12.0.2 compatibility lanes. Update the narrow
manifest range first, then run from the affected asset directory:

```bash
npm install --package-lock-only --ignore-scripts --no-audit --no-fund --omit-lockfile-registry-resolved
npm ci --ignore-scripts --no-audit --no-fund
```

The standard-template CI matrix repeats the locked install with npm 10.9.4 on
Node.js 22 and npm 12.0.2 on Node.js 24. Prefer the smallest compatible patched
line between reviewed baseline refreshes. Do not use `npm audit fix`, downgrade a
dependency to hide an advisory, or add an unverified transitive override.
Afterward run the focused security tests, the standard template verifier,
package smoke, and the live audit.

## Refresh the supported stack

`assets/supported-stack.json` is the release-owned source of truth for tested
runtimes, framework CLIs, direct dependency sets, provider locks, immutable
container images, and upstream starter identity.

```bash
npm run check:supported-stack-freshness
# Update manifests, locks, source compatibility, and immutable digests.
npm run refresh:supported-stack
npm run check:supported-stack
```

Freshness checks are advisory inputs to a reviewed change; they never rewrite
the repository. Resolve candidates only from the canonical sources recorded in
the baseline, materialize candidate manifests and locks in temporary
directories, reject prereleases, and select Node's newest supported LTS rather
than Current. Promote a candidate only after every affected install, build,
lint, test, container, OpenTofu, security, and cross-platform check passes.
Python lock refreshes use `uv lock` and Function requirements are exported from
the same GenAI lock. Do not hand-edit generated lockfiles.

When the newest stable candidate is incompatible, record the selected version,
the exact reviewed candidate, and the technical reason in the baseline rather
than silently pinning an older release. The current Power Apps SDK selection
stays on 1.2.7 because later releases remove the project-local `power-apps`
binary; adopting the global `pa` CLI requires a separate workload migration.

For the Power Apps starter, use the immutable refresh procedure above rather
than editing package metadata or lockfile bytes. A new starter commit changes
the audit inventory path and requires every exception to be reviewed again.

### Reconcile Dependabot updates

`develop` is the default integration branch, so Dependabot version and security
pull requests follow it without a separate `target-branch` override. The four
Liftoff-owned npm graphs group routine minor and patch version updates per
directory; majors remain individually reviewable.

The root, telemetry, and standard Node backend graphs ignore only
`@types/node` semantic-major version updates while Node 24 is the supported LTS.
Remove or revise that rule as part of the reviewed Node runtime-major migration,
not in an isolated dependency pull request. Patch and minor type updates,
security alerts, and majors for other dependencies remain enabled.

Do not add the commit-addressed Power Apps starter directory to
`.github/dependabot.yml`. Refresh it by selecting a newer immutable Microsoft
commit and running the complete starter provenance procedure.

Dependabot changes to a baseline-managed manifest or lock must be incorporated
into one coherent supported-stack refresh. Regenerate locks from their manifests
with the documented Node/npm lanes, update `assets/supported-stack.json`, and
validate every affected graph before closing the superseded bot pull requests.

## Maintain the repository-governance profile

The complete supplied standard is stored at
`assets/governance/single-maintainer-gitflow/policy.md`. Generated policy
metadata and the activation protocol are rendered by
`src/repository-governance.ts`. Keep policy schema/version, required invariant
fragments, workload context adapters, exact artifact paths, logical names,
manifest v7 activation identity, compatibility metadata, and Copilot/Claude
`/liftoff-setup` plus `/liftoff-repository-governance` alias compatibility
synchronized. See [DEVELOPER.md](DEVELOPER.md) before changing version axes.

Policy or activation changes require focused repository-governance, governance
activation, credential, manifest migration, update adoption/opt-out, framework
ownership, documentation-link, package-surface, graph/hash, seed strict
validation, and cross-agent setup equivalence tests. Never add a broad `.github`
or `.claude` ownership pattern, an active framework change, user-owned
activation state/evidence/approvals/credentials, or supersession records to
Liftoff-managed artifacts.

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
- Do not change persisted manifest identity, activation version vectors, graph
  hashes, schema versions, compatibility maps, or append-only identifiers without
  an explicit compatibility design and migration/remedy tests.
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
npm run verify:release-identity -- v0.6.1
```

Replace the example tag with the intended release. The Git tag, root package
metadata, root lockfile metadata, packed package version, and installed
`liftoff --version` output must all identify the same release.

When a release raises runtime floors or adopts generated-stack majors, label it
as breaking and direct existing projects to `liftoff update --check` before
apply. The release rollback boundary is a source revert before publication.
After publication, projects recover applied template changes through version
control; Liftoff must not silently downgrade their dependencies.

The first release containing `liftoff upgrade` must retain the one-time bootstrap
command for users on older versions:

```bash
npm install -g @msn-control/liftoff@latest --registry=https://registry.npmjs.org
```

All upgrade apply tests use temporary prefixes, homes, caches, and injected
registry responses. Never run self-upgrade apply against a developer or release
runner's actual global prefix.

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
