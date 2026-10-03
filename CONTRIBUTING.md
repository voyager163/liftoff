# Contributing to Liftoff

Thank you for helping improve Mission Control Liftoff.

Documentation, bug reproductions, design discussions, and answers to other
users are as welcome as code. See [SUPPORT.md](SUPPORT.md) for the right channel,
[GOVERNANCE.md](GOVERNANCE.md) for project decisions, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.

Discuss substantial changes in an issue before starting an implementation.
For normal contributions, create a feature branch from `develop`, in a fork
if needed, and open a pull request targeting **`develop`**, not `main`.
There is no guaranteed review or response time.

Issues and PRs are public. Use synthetic examples and manually inspect any
logs or attachments before sharing them. Never post credentials, personal
data, private source, `.env` contents, or sensitive findings. Report
vulnerabilities privately through [SECURITY.md](SECURITY.md) and conduct
concerns through the [separate conduct contact](CODE_OF_CONDUCT.md#reporting-and-enforcement).

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

For plugin or module-loading changes, run `tests/import-boundaries.test.ts` and
`tests/plugin-execution-isolation.test.ts`. New runtime consumers of plugin
modules need an explicitly reviewed entry in the boundary test's
`pluginRuntimeConsumers` map, not a directory-wide exception. Keep data leaves
inert, packaged reads exact, and plugin code independent of host state and I/O.
These checks cover authored source and selected source-command behavior; they
do not qualify dependency internals, Node preloading or external toolchains.

The root Vitest configuration limits Windows to two concurrent file workers.
Within the same test invocation, ordered projects run the other root files first,
then `tests/repair-preparation-execution.test.ts`, then
`tests/installed-tool-distribution.test.ts`, then the intact
`tests/migration-inspection.test.ts` file without competing filesystem-heavy
suites or native builds. The full distribution-limit fixtures retain their
30-second production scan deadline rather than competing with other file workers.
Interpreter-copy preparation retains its original test timeout and reports
phase timings; its actual fixture creation and verification are not moved into hooks.
Each file belongs to exactly one
group; targeted file selectors still run the selected file. Real revalidation
and fixture construction remain inside the original timed test bodies.
Other platforms retain their existing single-project configuration and Vitest's
worker default. Discovery remains complete, and isolation, assertions, and
timeouts are unchanged, including the migration inspection suite's 90-second
limit. Use these defaults for CI qualification rather than increasing timeouts
or excluding slow cases.

Hosted CI partitions the complete root suite into two shards per platform while
retaining the 45-minute job limit. Both shards run the package's supported-stack
check and build; native integration and packaging checks run on shard 1.
Each shard uploads its complete test report, including failures. The existing
required `Test (...)` checks are fail-closed aggregators: all six platform shards
must succeed, so a failed, cancelled or skipped shard cannot produce a green
required check. The independent source-complete coverage jobs remain unsharded.
Repository text checks out with LF endings on every host; explicitly frozen CRLF
evidence keeps its original bytes through `.gitattributes`.

Every root Vitest run, whether `npm test`, a targeted `npx vitest run`, or the
coverage gate, uses a fresh temporary user profile. The main process creates it
while the configuration is evaluated, before Vitest writes its own user-data token,
and the global setup removes it afterward; a failed cleanup fails the run. `HOME`,
`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, the XDG directories (POSIX),
`AZURE_CONFIG_DIR`, `GH_CONFIG_DIR`, the npm user config, global config, and cache,
and `GOPATH`, `GOMODCACHE`, `GOCACHE`, and `GOENV` all point inside it. Azure CLI
telemetry and npm update checks are off, and ambient gh, az, and npm credential
variables are cleared whatever their letter case. A test that needs such a value
injects its own fixture. Go telemetry is disabled through a mode file in this
run-owned profile before any Go command starts; `GOTELEMETRY` is not an environment
override. This prevents counter processes from retaining Windows profile locks
after their parent command exits without changing the developer's Go settings.
Tool caches start empty, so tests that build generated
projects download their dependencies. This keeps test-generated Liftoff and client
state out of your real profile; it is not a sandbox or network boundary, and `PATH`
and native host settings are unchanged.

Windows CI explicitly places its selected npm installation ahead of the Node
distribution's bundled npm on PATH and uses the runner-owned temporary directory
for short fixture roots. Windows process creation still limits the working
directory to `MAX_PATH`, even when filesystem operations accept longer paths;
native fixtures leave room for both full workspace identities without changing
the application's storage layout or truncating identifiers.
Each CI platform also runs the complete plugin composition, native-path and
packaged-lookup suites and uploads `qualification/plugin-paths.json`. The
repository-policy report check requires every applicable case to pass; unavailable
links or junctions cannot silently qualify a host. Only the explicitly named
Windows case is skipped on macOS/Linux. A report from one host never qualifies
another, and this source-level run does not replace installed-native-artifact
qualification.
Controller protocol fixtures use native
PowerShell launchers on Windows and POSIX launchers on macOS/Linux; passing a
mock protocol case is not evidence of native Job Object settlement. The separate
Windows-only smoke case runs the packaged controller against a real Node process
within the existing execution deadline. The controller explicitly loads the
built-in compiler module from `PSHOME`, without inheriting an ambient module
search path or bypassing execution policy.

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

### Coverage gates

The CLI and the telemetry gateway each have an independent, source-complete
coverage gate. Statements, branches, functions, and lines must each be strictly
greater than 80% (configured floor 80.01%) for each package separately. The
packages are never aggregated, files are never excluded to raise a result, and
thresholds are not lowered to pass. Both packages pin the Vitest-compatible V8
provider, `@vitest/coverage-v8` `5.0.0`, to the exact Vitest version.

```bash
npm ci
npm ci --prefix services/telemetry-ingest
npm run coverage:cli
npm run coverage:gateway
node scripts/coverage-gate.mjs verify cli
node scripts/coverage-gate.mjs verify gateway
```

The CLI inventory is every `.ts` file matched by the root `tsconfig.json`
include, `src/**/*.ts`, whether or not a test imports it. The gateway inventory
is its build input: `services/telemetry-ingest/src/**/*.ts` plus the whole
shared `src/telemetry/contract.ts` module compiled into the gateway image. The
gate fails if a report omits any inventoried file, lists a path outside it, is
missing or empty, if any test fails or is filtered out, or if any metric is at
or below 80%.

Each run writes `coverage/cli/` or `coverage/gateway/`: `coverage-summary.json`,
`coverage-final.json`, `coverage.txt`, `test-results.json`, and
`coverage-evidence.json`. The evidence records the commit and uncommitted change
set, SHA-256 digests of the source, test, and configuration inventories, the
pinned tool versions, the portable invocation and exit status, and every
skipped or host-gated test as unrun. The gate runs Vitest with `CI=true`,
`LIFTOFF_TELEMETRY=0`, `DO_NOT_TRACK=1`, two workers, and `--allowOnly=false`,
and it accepts no test filters. `verify` re-judges a saved report against the
current checkout; a different revision, change set, or inventory makes it stale,
so rerun the gate instead of reusing an older or copied report.

On macOS ARM64 with Node 24, the root Vitest configuration passes
`--no-sparkplug` directly to test workers for ordinary and coverage runs. A
native coverage worker crashed in V8 garbage collection with the signature
reported in [nodejs/node#62393](https://github.com/nodejs/node/issues/62393).
This is a test-worker mitigation, not a fix to the installed Node runtime or
Liftoff CLI; it does not change source inventories, thresholds, test selection,
or timeouts. Do not put this flag in `NODE_OPTIONS`. Other platforms,
architectures, and Node majors keep their existing worker flags. Remove the
mitigation only after qualifying a corrected runtime without it.

For a quick local measurement while writing tests, the diagnostic `inspect`
mode runs selected tests against selected sources with thresholds disabled and
writes only `coverage/targeted/`; it is never qualifying evidence:

```bash
node scripts/coverage-gate.mjs inspect cli --source src/package-identity.ts -- tests/package-identity.test.ts
```

Coverage measures in-process execution only. Child processes, the packaged
`assets/repair/windows-job-controller.ps1` helper, the installed package,
generated applications and containers, pinned framework smoke tests, native
OpenTofu, and live Azure or GitHub providers need their own evidence: the
Windows native CI lanes, `npm run smoke:package`,
`npm run verify:generated-containers`, `npm run verify:standard-node-templates`,
the host-gated CI steps, and separately approved live qualification. A passing
coverage gate does not claim any of them.

CI runs the `CLI coverage gate` and `Telemetry gateway coverage gate` jobs on
Linux and uploads each evidence directory. Release qualification runs both gates
before packing the release tarball; the gateway gate runs even when the CLI gate
fails, and either failure blocks packing and publication. The repository policy
rejects removing, conditioning, or reordering these gates.

#### Isolated HCL qualification

The private modern local verifier currently admits parser computation only on
darwin/arm64/Node24.21.0. This does not change the public Node engine floor or
advertise modern migration support. Both workflows have a separate
`Isolated HCL parser (macOS ARM64)` job, `qualify-isolated-hcl`, on `macos-15`
with Node `24.21.0` and `architecture: arm64`. The existing Node24.20.0 matrix
and Ubuntu coverage gates are unchanged. Release `qualify` waits for
`qualify-isolated-hcl`; `publish` still waits for `qualify`.

Only tests read `LIFTOFF_HCL_TEST_LANE`: absent/`auto` runs native parser cases on the
qualified tuple, `portable` explicitly leaves parser-dependent cases unrun,
and `native` fails on a runtime mismatch instead of skipping everything.
Independent observation, TypeScript, Compose, framework and value checks still
run; unavailable HCL cannot stand in for their assertions. The required native
job checks the actual tuple, complete nonempty three-suite JSON report and
critical real parser/resource/shutdown cases, rejects skipped cases, and uploads
`qualification/isolated-hcl.json` even after failure unless cancelled.

For local Unix shells:

```bash
LIFTOFF_HCL_TEST_LANE=native npx vitest run tests/modern-local-inputs.test.ts tests/modern-local-check-plans.test.ts tests/isolated-hcl-parser.test.ts --maxWorkers=1 --no-file-parallelism
LIFTOFF_HCL_TEST_LANE=portable npm run coverage:cli
```

On an already qualified host, forced-portable tests use a scoped, rejection-only
runtime value and assert no parser spawn. This is synthetic rejection/routing
evidence, not Linux, Windows or Node24.20 qualification. Actual unsupported
hosts retain their real runtime. Recorded helper specimens are pure validator
unit data only; native cases freshly reproduce them, never inject successful
ASTs into a planner. Keep native and portable reports and their command
environments separately: each coverage invocation replaces `coverage/cli/`.
Both must retain the same source-complete inventory and independent thresholds;
native coverage cannot mask a failing portable gate. Hosted CI and compiled/
installed helper behavior still require their own actual runs.

#### OpenSpec identity qualification

The OpenSpec distribution/authority tests share the test-only lane selector but
require an additional explicit metadata allowance. Ordinary `npm test`,
absent/`auto` mode and forced `portable` mode run the format and filesystem
contracts while leaving exactly two installed-metadata cases unrun. Supplying
budgets alone never enables them.

On darwin/arm64 with exact Node 24.21.0, use an independently installed OpenSpec
1.11.0 distribution and the supported Node/npm, OpenTofu and Docker/Compose
executables on `PATH`. The current native fixture pins the qualified package tree
(2590 files, 299 directories, two internal links and 11862860 bytes); a different
installation must be qualified, not silently blessed by changing that expectation.
The Docker daemon is not used. In a Unix shell:

```bash
LIFTOFF_HCL_TEST_LANE=native OB1_VERSION_REMAINING=2 OB1_SUPPORT_REMAINING=10 npx vitest run tests/installed-tool-distribution.test.ts tests/modern-openspec-tool-identity.test.ts --maxWorkers=1 --no-file-parallelism
```

Both budgets are explicit safe integers: OpenSpec 2..16 and support 10..112.
Missing, malformed or insufficient native budgets fail during collection before
native fixtures or tool lookup. The two cases together perform two OpenSpec
`--version` calls and ten supporting metadata probes, not project checks,
initialization, synchronization or archive. Keep the same explicit allowance
when including this file in a full native suite or native coverage run.
These limits apply per invocation; a retry is a new set of actual observations.
Do not count the two skipped cases as qualified, infer hosted qualification from
the separate three-file HCL job, or modify a real global installation for tests.

#### OpenSpec execution qualification

`tests/modern-openspec-execution.test.ts` adds a separate explicit
`LIFTOFF_OPENSPEC_B_TESTS=1` opt-in. Default runs leave its six native cases unrun;
forced `portable` also leaves them unrun even when this flag is set. Its format
contracts still run, including primitive-string rejection. Explicit opt-in
rejects a runtime other than darwin/arm64/Node24.21.0 rather than silently skipping.

Use the independently qualified OpenSpec 1.11.0 distribution and supported
Node/npm, Docker/Compose and OpenTofu executables from the identity lane.
OpenTofu must be on the supported 1.12 line, at least 1.12.6; a newer unsupported
line is not equivalent. Use an isolated supported installation on `PATH` rather
than replacing a real global tool. In a Unix shell:

```bash
LIFTOFF_HCL_TEST_LANE=native LIFTOFF_OPENSPEC_B_TESTS=1 npx vitest run tests/modern-openspec-execution.test.ts --maxWorkers=1 --no-file-parallelism
LIFTOFF_HCL_TEST_LANE=portable npx vitest run tests/modern-openspec-execution.test.ts --maxWorkers=1 --no-file-parallelism
```

These native cases execute actual OpenSpec JSON observations and the applicable
project checks inside owned preinitialized fixtures, not metadata alone. They
cover all three governance profiles and an invalid unrelated validation subject.
They do not initialize, check off tasks, synchronize, archive or publish.
Portable specimens are format/routing evidence, not native execution.

When including both OpenSpec test files in native coverage, set
`LIFTOFF_OPENSPEC_B_TESTS=1` and the separate
`OB1_VERSION_REMAINING=2 OB1_SUPPORT_REMAINING=10` identity allowance. That
allowance bounds the two identity cases, not the execution suite's additional
observations. Keep native and portable reports separate and do not count skipped
cases as qualified. Serialize tool-intensive runs; preserve interrupted-run
output and owned roots when settlement is unknown rather than inferring cleanup.

#### OpenSpec initialization qualification

`tests/modern-openspec-initialization.test.ts` requires the separate explicit
`LIFTOFF_OI_TESTS=1` opt-in. Default runs leave six native cases unrun; forced
`portable` leaves them unrun even if that flag is set. Portable obligation,
receipt-boundary and owned-cache rejection contracts still run. Synthetic
receipt controls are not initializer or native-output provenance.

Use the same qualified darwin/arm64/Node24.21.0 runtime, installed OpenSpec 1.11.0,
supported OpenTofu 1.12.6 or later on the 1.12 line, Node/npm and Docker/Compose
tools described above. Explicit opt-in on a different runtime fails rather than
silently skipping. No Docker daemon, provider download or Azure access is used.

```bash
LIFTOFF_HCL_TEST_LANE=native LIFTOFF_OI_TESTS=1 npx vitest run tests/modern-openspec-obligations.test.ts tests/modern-openspec-initialization.test.ts --maxWorkers=1 --no-file-parallelism
LIFTOFF_HCL_TEST_LANE=portable npx vitest run tests/modern-openspec-obligations.test.ts tests/modern-openspec-initialization.test.ts --maxWorkers=1 --no-file-parallelism
```

Native cases exercise the official
`init --tools github-copilot --profile custom --no-copilot-cloud` command in owned
staging and actual provider-free OpenTofu init before application/environment
validate across all three governance profiles. They also check consent/source
rejection, changed output and a labeled unknown-settlement control. The latter
uses an actually settled command; it is not proof of a real interrupted native
process. Original tasks stay unchanged and `3.1` remains pending. These fixtures
do not qualify full generated Azure infrastructure or historical user
initialization, and they do not authorize archive or public migration.

For full native coverage, retain `LIFTOFF_OPENSPEC_B_TESTS=1` and
`OB1_VERSION_REMAINING=2 OB1_SUPPORT_REMAINING=10`, and additionally set
`LIFTOFF_OI_TESTS=1`. The identity allowance does not include initialization
fixture observations. Serialize these tool-intensive runs; keep each native and
portable result tied to its exact source bytes, and retain failed or interrupted
evidence. A prior native run is not fresh qualification of a later correction.

## Documentation

Public user guides are plain Markdown under `docs/`; the root README remains a
short landing page. Static README assets live under `docs/assets/`. No
documentation generator is required.

Release-owned compatibility, deterministic setup version vectors, bump rules,
graph integrity, credential leak tests, cross-agent equivalence, and npm trusted
publishing requirements live in [DEVELOPER.md](DEVELOPER.md).

When editing documentation:

```bash
npm run check:repository
npx vitest run tests/documentation.test.ts tests/quality-gate-documentation.test.ts
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

Liftoff packages six template dependency sets: the Node.js backend, shared
frontend, standard Python backend, GenAI Python backend and Function export,
Go backend, and OpenTofu Azure providers. Before any npm request, the audit
validates all six sets against `src/plugins/builtin/assets.ts`: every declared
member must exist as a regular file and have an exact `package.json` `files`
entry. Structural failures are policy failures and send no audit requests.

The advisory scan covers the two npm template sets, plus the root CLI and
telemetry-ingest npm graphs. The four non-npm sets are reported as **not audited**
with a reason; structural validation is not a security claim. Run the live
canonical-registry audit explicitly:

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

Template dependency sets have one canonical declaration in
`src/plugins/builtin/assets.ts`. Keep each manifest, lock and optional export
together under `assets/plugins/<plugin-id>/<set>/`, or
`assets/templates/common/frontend/` for the shared frontend set. Identify files
by explicit owner/id pairs, never directory ownership or runtime discovery.
Update the explicit template entries in `package.json` and the relevant
baseline, audit and Dependabot path mirrors in the same reviewed change.
The `templateDependencySets` metadata in `scripts/template-dependency-security.mjs`
maps C1 sets to their ecosystems, audit coverage and baseline views without
duplicating member paths or release hashes. Keep the baseline/content checks in
`tests/dependency-set-inventory.test.ts` aligned, including the exported Python
requirements, Go tool pin and provider subset.
Asset entries in `files` must be exact files, not directory or glob entries.
`scripts/package-smoke-contract.mjs` independently requires all 13 template
assets and nine core ancillary assets, rejects omitted or aliased entries, and
checks installed bytes without decoding the PowerShell helper. The repository-only
egg-info files under `assets/locks/` remain unchanged and are not packaged.
The ancillary inventory includes the two modern profile policies and their
canonical source-contract table. They support private source interpretation,
not public Manual/team generation or a current manifest/activation version switch.
Path-only relocations must preserve file bytes and generated project output;
the asset-inventory test also checks LF checkout attributes on the new paths.

Bundled contributions are statically registered in
`src/plugins/builtin/index.ts`; core-owned identities live in
`src/plugins/builtin/core.ts`. Keep renderer bindings in
`src/application/project/plugin-renderers.ts`, not in the descriptors or registry.
The application composition root selects and verifies contributions before
generated artifacts may be returned. These are trusted first-party modules, not
an extension-discovery API or sandbox.

`src/plugins/builtin/release.ts` holds independently reviewed literal descriptor
digests and owned-asset hashes. When changing a declared contribution or asset,
review its bytes, identities, support conditions and `contentVersion`, then
update the affected release expectations in the same change. Content digests do
not hash renderer implementation: a renderer behavior change also requires a
reviewed `contentVersion` advance. Existing refresh commands do not update or
approve these literals; do not add a startup or test helper that automatically
blesses current bytes.

Run the registry, built-ins, composition, lazy-asset and generation-parity suites,
plus import-boundary and execution-isolation tests, for contribution changes.
Preserve generated bytes and logical-name/lifecycle identities for a structural
refactor; review any intentional snapshot change against the prior output.
The byte reader belongs in `src/adapters/packaged-assets/plugin-assets.ts`:
validate bounds before reading, preserve structured read/close failures, and
keep template reads out of CLI startup/help/version. Native filesystem and
installed-package qualification remain separate from these source tests.

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
metadata and the activation protocol are assembled in
`src/generators/governance/`, with policy and workload-context rules under
`src/domain/governance/policy/`. `src/repository-governance.ts` remains a
compatibility facade. Canonical identity and pure activation rules live under
`src/domain/governance/`; read the independently versioned constants from
`src/domain/governance/policy/identity.ts`. Keep policy schema/version, required invariant
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

All changes, including maintainer-authored changes, go through a PR. The
single-maintainer policy requires zero approving reviews, but still requires
deliberate review, resolved conversations, and successful up-to-date checks.
CODEOWNERS routes review; it is not a requirement for a second person.

Squash ordinary PRs into `develop`. Release promotion from canonical `develop`
into `main` and back-synchronization use merge commits. When both branches have
advanced, create a temporary sync branch from current `develop`, merge `main`
into it, and PR it into `develop` with a merge commit before promotion.
See [branch policy](GOVERNANCE.md#branches-and-pull-requests).

Outside contributors' fork workflows require maintainer approval before
running. That approval grants no secrets or publishing authority. Workflow,
policy, validation, and release changes need deliberate maintainer review;
do not blindly auto-merge a green check or an automated suggestion.

- Keep changes focused and include tests for changed behavior.
- Keep both coverage gates passing with new tests; do not lower thresholds,
  exclude sources, or skip failing tests to pass them.
- Record any intentional change to a frozen public contract in
  `tests/fixtures/contract-baseline-changes.json`; never regenerate the baseline.
  See [the contract baseline](DEVELOPER.md#contract-baseline-and-coverage-gates).
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
Liftoff` workflow runs package checks, both source-complete coverage gates,
package smoke, a pack inspection, and release-identity validation before
publishing. It stores the coverage evidence as a separate workflow artifact; the
release tarball and its recorded digest are unchanged by it. It uses npm trusted
publishing with provenance and verifies the published dist-tag from canonical npm
afterward.

Manual dispatch is verification-only and has no publish switch. For an actual
release, promote the reviewed revision from `develop` into `main` with a merge
commit, then create the matching version tag with explicit release authority.
Qualification checks canonical tag ancestry and package identity, then records
the packed tarball's SHA-256 digest, source commit, and workflow run. The
workflow smoke-tests that exact file before uploading it. For a previously
packed candidate, use `npm run smoke:package -- --tarball <path-to-package.tgz>`;
the candidate is inspected and installed in isolation, not repacked or replaced.
The separate publishing job rechecks those identities and waits for your approval
in the GitHub `npm-release` environment before publishing that exact tarball.
The sole maintainer can approve their own release; this is not two-person review.

Before publishing an immutable GitHub release, add all intended assets to its
draft. Do not move tags or replace immutable assets afterward; issue a corrected
version. Historical releases are not retroactively made immutable.

GitHub environment approval does not establish npm account policy. npm
trusted-publisher, token, and account settings are not inspected or changed by
the repository-setup work. Migration away from npm is a separate change; the
current publishing integration remains supported in the meantime.

Before tagging, update package and lockfile metadata together and run:

```bash
npm run verify:release-identity
npm run verify:release-identity -- v0.12.3
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

Submit only work you created or have permission to contribute under that
license, identify third-party material and its license, and preserve required
notices. There is no mandatory CLA, DCO sign-off, or signed-commit requirement.

AI-assisted contributions are welcome on the same terms. You are responsible
for reviewing the result, verifying your right to contribute it, and reporting
what you actually checked. Explain material AI assistance when it affects
provenance or review; do not submit private prompts or transcripts as proof.
Never send someone else's confidential material to an AI service without
permission.

Report security vulnerabilities through the private process in
[SECURITY.md](SECURITY.md), not a public issue.
