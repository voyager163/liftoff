# Contributing to Liftoff

Thank you for helping improve Mission Control Liftoff.

## Development setup

Install the toolchains exercised by the complete suite:

- Node.js 24 LTS at 24.20.0 or newer within that line, and npm 12.x at 12.0.2 or newer.
- Python 3.14.x (tested at 3.14.7) and `uv` 0.12.x at 0.12.7 or newer.
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

Filesystem and manifest changes must remain portable across Windows, macOS,
and Linux. Use Node.js path utilities rather than hardcoded separators, and
preserve append-only manifest logical names and catalog identifiers unless a
reviewed specification change explicitly retires an identifier and its derived
artifacts. The approved 0.11.0 exception retires exactly eight flat-root OpenTofu
IDs from new output; [the explicit inventory](docs/azure-deployment.md#explicit-flat-root-identity-retirement)
retains old project provenance and never authorizes state moves or force conversion.
Keep other identifiers stable.

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
The README must stay below 135 lines. Keep the acceptance headings and links in
the developer guide; update actual canonical implementation paths after an
extraction, not only compatibility-facade names. Documentation tests derive
activation identity and graph-hash expectations from current source.

## Audit packaged template dependencies

Liftoff ships npm lockfiles for the standard Node.js backend and standard frontend.
Run their live canonical-registry audit
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
Node.js 22 and npm 12.0.2 on Node.js 24. The older lane checks template/lock
compatibility; it does not lower Liftoff's Node.js 24.20/npm 12 workstation
readiness floors. Prefer the smallest compatible patched
line between reviewed baseline refreshes. Do not use `npm audit fix`, downgrade a
dependency to hide an advisory, or add an unverified transitive override.
Afterward run the focused security tests, the standard template verifier,
package smoke, and the live audit.

## Refresh the supported stack

`assets/supported-stack.json` is the release-owned source of truth for tested
runtimes, framework CLIs, direct dependency sets, provider locks, immutable
container images, and packaged asset identity.

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
than silently pinning an older release. Retired Power Apps fixtures are
non-generative and do not participate in dependency or starter refresh.

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

Do not add retired Power Apps fixtures to `.github/dependabot.yml` or restore
an operational source-commit compatibility lane for that retired workload.

Dependabot changes to a baseline-managed manifest or lock must be incorporated
into one coherent supported-stack refresh. Regenerate locks from their manifests
with the documented Node/npm lanes, update `assets/supported-stack.json`, and
validate every affected graph before closing the superseded bot pull requests.

## Maintain the repository-governance profile

The complete supplied standard is stored at
`assets/governance/single-maintainer-gitflow/policy.md`. Generated policy
metadata and the activation protocol are rendered by
`src/repository-governance.ts`; canonical identity and pure activation rules live
under `src/domain/governance/`. Current activation uses contract/state/header/
approval v2 and compatibility metadata v3, while policy remains 6 and manifest
remains 7. Keep policy schema/version, required invariant
fragments, workload context adapters, exact artifact paths, logical names,
manifest v7 activation identity, compatibility metadata, and Copilot/Claude
`/liftoff-setup` integrations synchronized. Retired generated setup aliases are
migration-only and may be removed by forced update; do not present them as usable
commands. See [DEVELOPER.md](DEVELOPER.md) before changing version axes.

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
- Confirm generated projects contain no real credentials or unreviewed live
  resource bindings; nonsecret environment defaults must be explicit.
- Do not change persisted manifest identity, activation version vectors, graph
  hashes, schema versions, compatibility maps, or stable identifiers without an
  explicit main-spec decision and migration or rejection-remedy tests.
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
npm run verify:release-identity -- v0.11.3
```

Replace the example tag with the intended release. The Git tag, root package
metadata, root lockfile metadata, packed package version, and installed
`liftoff --version` output must all identify the same release.

When a release raises runtime floors or adopts generated-stack majors, label it
as breaking and direct existing projects to `liftoff update --check` before
managed-core maintenance, not automatic adoption of the new application stack.
Project-owned template/infrastructure changes need separate reviewed migration;
core update never applies them. The release rollback boundary is a source revert
before publication. Project owners recover separately applied template changes
through version control; Liftoff must not silently downgrade their dependencies.

The first release containing `liftoff upgrade` must retain the one-time bootstrap
command for users on older versions:

```bash
npm install -g @msn-control/liftoff@latest --registry=https://registry.npmjs.org
```

That explicit canonical default is reference material for approved canonical
delivery. Managed installations retain their configured
`@msn-control:registry` before the default registry; do not override a scoped
mirror to bypass policy. Canonical verification isolates the scope only for its
read-only comparison.

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
