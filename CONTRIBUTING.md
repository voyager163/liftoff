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
then `tests/repair-cancellation.test.ts`, then `tests/repair-preparation-execution.test.ts`, then
`tests/installed-tool-distribution.test.ts`, then the intact
`tests/migration-inspection.test.ts` file, then the intact
`tests/adoption-verification-execution.test.ts` file, then the intact
`tests/governance-workflow-source5-matrix.test.ts` file, then the intact
`tests/governance-workflow-source5-finalization.test.ts` file, then the intact
`tests/activation-successor-update.test.ts` file without competing filesystem-heavy
suites or native builds. The full distribution-limit fixtures retain their
30-second production scan deadline rather than competing with other file workers.
Cancellation and exact receipt reuse retain their original 30-second test deadline
without concurrent native stack builds competing for the same filesystem.
On macOS and Linux, the same final three files run in ordered groups after the
other root files. The retained successor's actual SSR-loader preparation remains
in its original 10-second hook, and Source5 cases retain their 30-second limits;
neither fixtures nor assertions are moved out of their original timed bodies.
Interpreter-copy preparation retains its original test timeout and reports
phase timings; its actual fixture creation and verification are not moved into hooks.
Each file belongs to exactly one group; targeted file selectors still run the
selected file. Real revalidation
and fixture construction remain inside the original timed test bodies.
Windows adoption verification also runs as an intact ordered file, so its
original fixture preparation, actual child commands and receipt checks do not
compete with other files inside the original 30-second cases.
macOS and Linux retain Vitest's worker default. Discovery remains complete;
isolation, assertions, and timeouts are unchanged, including the migration
inspection suite's 90-second limit. Use these defaults for CI qualification
rather than increasing timeouts or excluding slow cases.

Hosted CI partitions the complete root suite into four shards per platform.
Every shard runs the package's supported-stack check and build; native integration
and packaging checks run on shard 1, except the intact Windows project/packaging
boundary suite runs on shard 2. That named boundary suite includes repair and
adoption path-with-spaces, junction, mode/readback, and interrupted-transaction
cases. Windows shard 1 separately runs real repair and adoption child commands
through the packaged Job Object controller so a mock settlement result cannot
qualify either lane. This precheck uses one worker with file parallelism disabled
to avoid file-level contention between cold controller compilations. It retains
the existing 15-second startup budget and uploads its own
`qualification/windows-process-tests.json` report on success or failure; this is
not a main-shard result. Serialization alone is not Windows host qualification.
All jobs retain the 45-minute limit except Windows shard 2,
which has a 75-minute limit because it must complete both the named boundary
suite and its source-complete package shard without dropping or filtering either
set of tests.
Each shard uploads its complete test report, including failures. The existing
required `Test (...)` checks are fail-closed aggregators: all twelve platform shards
must succeed, so a failed, cancelled or skipped shard cannot produce a green
required check. The independent source-complete coverage jobs remain unsharded.
CI runs the complete CLI coverage gate with four file workers; the local default
remains two. Neither change raises deadlines, filters tests, or merges partial
coverage reports.

Source5 journal event reads use fixed batches of four authenticated, physically
checked records. Every started read settles before chain validation proceeds
in the original stage order. The first original refusal wins, and a failed batch
never submits a later batch; no authority or currentness read is cached.
Original publication dependency readback also drains fixed-four batches before
checking each retained digest, encoded size and revision in the original order.
Every inventory assertion rereads all dependencies; an earlier semantic refusal
wins over a later physical failure only after all started siblings settle.
Event reads reuse only the journal's already-captured immutable current-plan
inventory and context. Physical stage bytes, authority, ownership and currentness
are still read and checked afresh; another original plan is analyzed separately.
Restored workflow authority similarly retains only digests and operation
multiplicities computed from its privately captured immutable plan and approval.
Every assertion still hashes the caller's current values, rereads installed scope,
ownership and sealed issuance, and checks the original lease and current time.
Preview-storage directory readback drains fixed-four metadata batches before
checking identities and private permissions in the original ancestor order.
An earlier semantic refusal wins over a later physical failure after settlement;
no later batch or file open follows a failed guard. Directory discovery,
per-file brackets and every fresh observation remain unchanged.
Whole-matrix retained-component checks also drain fixed-four member batches,
then validate in the original member order. Each member retains its own physical
stage checks; an earlier semantic refusal still wins over a later physical
failure. Both matrix inventory passes and the subsequent authority check remain
fresh, and these local reads do not submit provider effects.
Original native assembly output captures also use fixed-four physical-entry
batches, preserving both complete inventories, both physical passes, manifest
readback and fresh parent brackets. An original-order error returns only after
all started siblings settle; no later batch follows a refusal.
Installed packed-source byte/length verification likewise uses fixed-four
batches in the original manifest order, preserving earlier semantic refusals
over later physical failures and retaining every source member check.
Installed OpenSpec distribution scans overlap at most four admitted regular-file
reads. File/count/byte reservations happen before opening, and every started
handle closes before ordered metadata, entry and parent checks or refusal.
Directory/link boundaries, both complete scans and the original 30-second
scan deadline remain unchanged; neither inventory nor currentness is cached.
Windows interop capture also rereads every assembly byte through the same open
physical file using one buffer capped at 64 KiB. In-place changes must refuse
even when Windows has not advanced the open handle's timestamps. The original
size, identity, single-link, overflow, close, abort, and startup-deadline guards
still apply before bytes can be published to the process-local cache.
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
The platform shards prepare checksum-pinned Docker CLI and Compose executables
in a private runner prefix on all three hosts. Windows uses native x64 PE files
named `docker.exe` and `docker-compose.exe`; it does not assume the runner's
Docker CLI includes a compatible, independently identifiable Compose plugin.
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
within the existing execution deadline. The controller binds built-in cmdlets
by the exact Utility assembly identity, without ambient module discovery or
bypassing execution policy.

For timed invocations, the Windows supervisor bounds controller startup and
authenticated admission separately at 15 seconds. After the single valid admission acknowledgement, it
uses the unchanged requested target timeout plus the existing five-second
settlement grace. Cold PowerShell/C# startup cannot consume a short target's
settlement window. Missing readiness, acknowledgement or terminal proof still
fails closed; the supervisor never treats its own timeout as kernel settlement.
This does not increase test or CI job deadlines.

Only packaged/default PowerShell invocations can reuse process-local compiled
Win32 bytes, captured after authenticated readiness. Each invocation gets a fresh
private copy and retains its own admission and settlement checks; custom
overrides use inline compilation. Cache waiting and file preparation consume the
existing startup budget. After preparation fails, waiting for cleanup respects
that same deadline and cancellation: the original failure returns with pending
cleanup, late work is drained before disposal, and cleanup failure is reported.
The first cold compile and genuine Windows qualification remain separate gates.

Local Compose observation binds the plugin executable separately from Docker.
The finite prefix-relative candidates use `docker-compose.exe` on Windows and
the extensionless name on POSIX hosts; Linux system precedence and private-bundle
precedence remain unchanged. There is no user-configured plugin search fallback.
Path-model tests do not qualify a Windows host: actual file identity, supported
plugin version, process settlement and current reobservation are still required.

Before a change is release-ready, also verify the packed artifact:

```bash
npm run smoke:package
npm run verify:standard-node-templates
npm run verify:generated-containers
npm run check:supported-stack
```

The container verifier allows the selected port to remain unpublished while
Docker starts the named container, within the existing 60-second startup limit.
That observation is not readiness: process exits and other Docker errors still
fail, and the operational endpoints and build-context exclusions must pass.
Inspection and cleanup use only the full ID from Docker's private creation
receipt, never the requested name. Missing or malformed ownership evidence,
unsettled clients and cleanup failures retain verification material for diagnosis;
a name collision must not remove an unrelated container.

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
check without selecting the host global prefix. Local builds retain source maps
for debugging; npm and native package payloads include every emitted JavaScript
module and TypeScript declaration, but exclude development source maps. Required
assets remain explicit and the 13 MiB unpacked package budget is unchanged.
The standard template verifier generates a Node.js
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

The CLI inventory includes every `.ts` file matched by the root `tsconfig.json`
include, `src/**/*.ts`, and every raw JavaScript runtime module explicitly
published in `package.json`:

- `distribution/native/cask-stage-worker.mjs`
- `distribution/native/native-bundle-contract.mjs`
- `distribution/native/native-cask-definition.mjs`
- `distribution/native/native-program-assembly.mjs`
- `distribution/native/native-release-admission.mjs`
- `distribution/native/native-release-catalog.mjs`

Unimported shipped modules remain in the denominator with zero coverage.
Compiled `dist/` output is not counted again. The gateway inventory
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
`LIFTOFF_TELEMETRY=0`, `DO_NOT_TRACK=1`, two workers by default (four in hosted
CLI coverage), and `--allowOnly=false`,
and it accepts no test filters. `verify` re-judges a saved report against the
current checkout; a different revision, change set, or inventory makes it stale,
so rerun the gate instead of reusing an older or copied report.
Saved verification also requires the V8 provider, a well-formed recorded Node
version, and each tool's declared, locked, and installed versions to match the
currently validated exact pins. Installed tool drift fails even if source and
configuration files are unchanged. Reordering valid descriptors is harmless;
the observed npm version may be null. Recorded versions are consistency data,
not authentication of a process or qualification of its host, and the recorded
Node patch version need not equal the verifier's current patch version.

The test summary's `files` and `failedFiles` count Vitest file records.
`numFailedTestSuites` also includes nested suites, so the gate checks that
aggregate separately and labels it as suites, not files. Fully skipped files
can have a raw `passed` file status; their skipped bodies remain in `unrun`
and are not qualification evidence. This does not revise historical reports
or turn a failed run into a pass.

Test totals must be nonnegative safe integers and agree with the actual
assertion records for passed, failed, skipped/pending, and todo tests. Missing
assertion arrays or unknown file/assertion statuses fail closed, including when
verifying saved evidence. Aggregate totals alone cannot establish that tests ran.
The corpus must contain at least one executed assertion body. An entirely
skipped, pending, or todo run fails even if module collection covers every source
metric; registering tests or importing code is not test execution.
Each inventoried test path must appear exactly once after path normalization,
including across Windows project shards. Duplicate file records fail rather
than silently deduplicating their counters, failures, or unrun evidence.
Threshold comparisons use exact integer arithmetic after safe-integer count
validation; large counts cannot pass through floating-point product rounding.
Each source path must also occur exactly once after normalization in both
coverage reports. Aliases cannot hide uncovered records behind a later member;
ambiguous reports fail even when their retained totals and inventories match.
Each final-report entry must also be an object with a nonempty string `path`
that identifies the same source as its report key after normalization. Missing,
malformed, escaping or contradictory payload identities fail; equivalent
relative and absolute paths remain valid, and verification does not rewrite
the reports. Fresh and saved gates also validate safe-integer hit counters and
their map membership. Statement and function hits must be nonnegative; signed
synthetic V8 else-branch hits remain unchanged and are treated as uncovered by
the pinned provider. The gates use that provider's own summarizer to require
each source's statement, branch, function and line counts
to agree with its summary. Contradictory reports fail even when their aggregate
percentages and saved evidence still agree. This is report consistency, not
authentication of the coverage producer or proof that every reported hit ran.

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

Standard Node template CI retains the existing required Linux checks and runs
the same npm 10.9.4/12.0.2 compatibility pairs natively on macOS and Windows.
Each lane records actual installation, build, tests and Drizzle metadata
generation/check commands, immutable template hashes and unchanged generated
package metadata. Node 22/npm 10 remains a compatibility control, not a change
to the supported CLI runtime floor: each lane captures its exact project Node/npm
paths before selecting Node 24.20 for Liftoff generation. Schema-2 reports retain
the generator and actual project runtime versions separately, together with the
original executable/argv and all nine command results. These controls never run
database migrations.

CI runs the `CLI coverage gate` and `Telemetry gateway coverage gate` jobs on
Linux and uploads each evidence directory. Release qualification runs both gates
before packing the release tarball; the gateway gate runs even when the CLI gate
fails, and either failure blocks packing and publication. The repository policy
rejects removing, conditioning, or reordering these gates.

#### Dispatch-only hosted native custody qualification

The existing `.github/workflows/repository.yml` workflow contains an opt-in
`qualify-native-custody` job for task 13.5 qualification on actual GitHub-hosted
macOS ARM64. The job is guarded by `workflow_dispatch`; pull requests and
long-lived branch pushes retain only their existing repository-policy check and
do not acquire another multi-hour required job. Manual dispatch also runs that
short policy check, not the broad CI workflow.

The single `macos-15` job pins Node 24.21.0, npm 12.0.2, OpenTofu 1.12.6,
OpenSpec 1.11.0, Go 1.27.0, Python 3.14.7, and uv 0.12.7. On exact clean
committed bytes it runs the supported-stack check, build, unfiltered one-worker
suite, source-complete one-worker CLI coverage, independent coverage-evidence
verification, focused custody/history checks, package smoke, repository policy,
strict OpenSpec validation, and a final clean-tree check. Its 240-minute job
timeout is a bounded allowance for the measured native full and coverage runs;
it does not change any test timeout, source inventory, threshold, baseline, or
test selection.

The job installs npm 12.0.2 into an isolated runner-temp prefix and prepends only
that package's `.bin` directory. Before tests it proves that the selected launcher
resolves to `npm-cli.js`, its owning package is exactly `npm@12.0.2`, and direct
Node execution of that launcher agrees with the ordinary npm probe. It also
downloads the official Apple Silicon Docker 29.8.2 archive and Compose 5.5.1
binary over HTTPS, verifies the reviewed archive/binary SHA-256 values, installs
only `liftoff-docker/bin/docker` and the separately bound
`liftoff-docker/cli-plugins/docker-compose`, and rechecks both installed binary
digests and versions. The Docker archive digest is
`5ffa2bafbabe073470f0333f4a129599230b73d1170bb61146b3d9b08e1d1325`,
the installed Docker binary digest is
`b95f15a2e7c6a13c17b8af361a2797981bc858a87a1537c38cfa117a0c5009e1`,
and the Compose binary digest is
`998735c9b6fe68a4f05895e6ea73d71ad06f9fc7046383ad89e47346781b6af5`.
No Docker daemon is started.

OpenSpec is installed with npm 12 in a global-style isolated prefix using the
historical registry cutoff `2026-09-26T23:59:59Z`. Before the launcher enters
`PATH`, the job scans the complete package tree twice and requires the qualified
2,590-file, 299-directory, two-link, 11,862,860-byte content profile with digest
`sha256:05d52efd0875c1ff0c1bd0aec13f7128a4baab787ea6b31f33fa7360cd53bde2`.
This binds the historically qualified dependency graph instead of accepting
current transitive resolution or refreshing the frozen expectation. The root
and telemetry-ingest packages are then installed independently with their
committed locks so source-complete coverage uses each package's own Vitest
launcher.

The job also enables the native OpenSpec execution and initialization lanes
with the reviewed finite identity budgets:
`LIFTOFF_OPENSPEC_B_TESTS=1 OB1_VERSION_REMAINING=2
OB1_SUPPORT_REMAINING=10 LIFTOFF_OI_TESTS=1`. The actual separately bound
Compose plugin must remain on release line 5 at version 5.5.1 or later; Docker
CLI identity alone is not Compose qualification.

Non-cancelled runs retain full-suite, coverage, focused, and
`coverage/cli/` evidence in one artifact. The final native evidence record
requires the dispatched SHA, clean source inventory, zero coverage-test
failures, and statements, branches, functions, and lines each strictly above
80%. It labels the result as hosted macOS ARM64 evidence only. It is not a
retroactive MacBook result, production custody/handover qualification, or
disposable Azure qualification.

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

`modern-revalidation-coordination.test.ts` exercises private-store loading and
publication/refusal/recovery coordination on every platform. Its synthetic wire
records and explicitly mocked construction/transaction observations establish
unit behavior, not native execution, rollback, commit or current readback.
`modern-activation-runtime-records.test.ts` separately checks the shared local
evidence-plan constructor with format-only records. Keep the actual native
construction/publication cases in `modern-revalidation-records.test.ts` and
`modern-local-publication.test.ts`; portable coverage must not relabel their
host-gated cases as passed.

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

#### Archived OpenSpec revalidation qualification

`LIFTOFF_OPENSPEC_ARCHIVE_TESTS=1` separately enables nine native execution cases
in `tests/modern-openspec-archived.test.ts` and three native successor-publication
cases in `tests/modern-revalidation-records.test.ts`. Default and forced-portable
runs leave these cases explicitly unrun. Explicit native selection requires the
same darwin/arm64/Node24.21.0, OpenSpec 1.11.0 and supported Node/npm,
Docker/Compose and OpenTofu tools described above.

```bash
LIFTOFF_HCL_TEST_LANE=native LIFTOFF_OPENSPEC_ARCHIVE_TESTS=1 npx vitest run tests/modern-openspec-archived.test.ts tests/modern-revalidation-records.test.ts -t 'explicit actual archived|publishes fresh archived' --maxWorkers=1 --no-file-parallelism
LIFTOFF_HCL_TEST_LANE=portable npx vitest run tests/modern-openspec-archived.test.ts tests/modern-openspec-execution.test.ts tests/modern-openspec-initialization.test.ts tests/modern-revalidation-records.test.ts --maxWorkers=2
```

The native cases validate current main specs, all current subjects and all
archived task lists using actual CLI JSON. They cover all three governance
profiles, zero active changes, contextual/Copilot configuration, source drift,
an invalid unrelated current subject, and immutable original archive bytes.
One case first prepares a disposable fixture with Liftoff's actual seed renderers
and the official `archive <change> --yes --json` command. Its completed checkboxes
are fixture input, not historical execution proof. The subsequent product
revalidation is read-only and must preserve that actual archived/main output,
including OpenSpec's compact Purpose-heading formatting.
Successor cases exercise history families 1/2/3, including retained history,
separate exact-byte publication consent and independent committed readback.
They do not execute historical tasks, initialize or archive a user project, access
providers, dispose of retained history or enable public v8 routing. Portable
JSON/source specimens are not native provenance. Keep their results separate
and serialize the tool-intensive native selection.

#### Public modern local verification qualification

`tests/modern-local-request.test.ts` checks closed input/consent and command
grammar. `tests/modern-local-commands.test.ts` separates portable application
routing specimens from seven actual public plan/approve/apply-next cases.
Its explicit `LIFTOFF_PUBLIC_LOCAL_TESTS=1` group requires the qualified
macOS ARM64 Node 24.21.0 runtime, native HCL admission, and installed
Node/npm, OpenSpec 1.11.0, OpenTofu 1.12.6, and Docker/Compose. It needs no
Docker daemon, dependency network, or provider access.

```bash
LIFTOFF_HCL_TEST_LANE=portable npx vitest run tests/modern-local-request.test.ts tests/modern-local-commands.test.ts --maxWorkers=1 --no-file-parallelism
LIFTOFF_HCL_TEST_LANE=native LIFTOFF_PUBLIC_LOCAL_TESTS=1 npx vitest run tests/modern-local-commands.test.ts --maxWorkers=1 --no-file-parallelism
```

Run the entire native file: it checks all seven case identities, not just a
filtered success. Controlled Manual/Spec Kit, active/initialized/archived
OpenSpec, missing/stale consent and actual failed project tests preserve
original bytes. Framework markers are contract fixtures, not official
initializer provenance. Initialized scope is not domain verification.
Neither portable routing specimens nor this native group establish public
finalization, publication, recovery, successor revalidation, or broader host
support. Existing dependency-network execution has its separate qualification.

#### Public modern local completion qualification

`tests/modern-local-completion-request.test.ts` covers closed requests and
independent finalization/publication grammar. Portable cases in
`tests/modern-local-completion-commands.test.ts` cover producer routing,
nonexecution, attribution ordering, effect uncertainty and output withholding;
mocked outcomes are not native publication proof.

```bash
LIFTOFF_HCL_TEST_LANE=portable npx vitest run tests/modern-local-completion-request.test.ts tests/modern-local-completion-commands.test.ts --maxWorkers=1 --no-file-parallelism
LIFTOFF_HCL_TEST_LANE=native LIFTOFF_PUBLIC_COMPLETION_TESTS=1 npx vitest run tests/modern-local-completion-commands.test.ts --maxWorkers=1 --no-file-parallelism
```

The explicit native group requires actual macOS ARM64 Node 24.21.0, native HCL
admission, Node/npm, OpenTofu 1.12.6 and Docker/Compose. Run the whole file:
its eight case identities cover Manual/Spec Kit across all three profiles,
changed-source refusal, and real committed publication followed by attributed
recovery. Recovery injects a checkpoint-storage failure, not a process crash.
The journeys first execute genuine public verification, then independently
approve finalization and exact-file publication. They compare published bytes
and modes to reviewed targets and preserve non-target file identities. Saved
progress never replaces current inspection. Controlled framework markers are
not official initializer provenance. This group needs no Docker daemon,
dependency network or providers and does not qualify other hosts, OpenSpec
finalization, successor revalidation, generation or whole-directory rollback.

#### Generated native Manual qualification

The separate `LIFTOFF_MANUAL_ENGINE_TEST_LANE=native` opt-in runs real generated
workloads and permits their reviewed application dependency and locked provider
downloads. It requires macOS ARM64, Node24.21.0, OpenTofu1.12.6, Docker/Compose,
and the selected workload tools on PATH. No Docker daemon, remote credentials,
Azure resource operations or agent execution are needed.

```bash
LIFTOFF_MANUAL_ENGINE_TEST_LANE=native npx vitest run tests/modern-manual-public.test.ts --max-workers 1
LIFTOFF_MANUAL_ENGINE_TEST_LANE=native npx vitest run tests/modern-manual-execution.test.ts --max-workers 1
```

The public file covers no-agent/governance-none and all-agent/single-maintainer
projects with frontend and dev/staging/prod. It requires actual verification,
separate finalization/exact-publication consent and independent CLI inspection,
preserving original non-target files. The engine file additionally covers all
three standard stacks and nine GenAI patterns. Both network groups default to
off; run them serially and keep failed fixtures rather than claiming cleanup.
`tests/modern-completion-artifacts.test.ts` exercises actual full-selection
protected-index storage and portable codec bounds; it is not execution proof.
Historical uncompressed artifacts remain readable and neither compressed nor
expanded records may exceed64KiB.

#### Public successor revalidation qualification

`tests/modern-revalidation-request.test.ts` checks the closed schema-6 requests
and shared exact-text review. Portable cases in
`tests/modern-revalidation-commands.test.ts` exercise producer selection,
independent approval, selected inspection, attribution ordering and truthful
commit/incomplete/error reporting. Injected producer values are not native proof.

```bash
LIFTOFF_HCL_TEST_LANE=portable npx vitest run tests/modern-revalidation-request.test.ts tests/modern-revalidation-commands.test.ts --maxWorkers=1 --no-file-parallelism
LIFTOFF_HCL_TEST_LANE=native LIFTOFF_PUBLIC_REVALIDATION_TESTS=1 npx vitest run tests/modern-revalidation-commands.test.ts --maxWorkers=1 --no-file-parallelism
```

Run the entire native file on actual macOS ARM64 Node 24.21.0 with the admitted
native HCL parser, Node/npm, OpenTofu 1.12.6, OpenSpec 1.11.0 and Docker/Compose.
Its nine case identities include Spec Kit and archived OpenSpec for each
supported historical family, actual committed incomplete revalidation,
changed-source refusal and committed publication recovery. All begin with real
public verification and separately approve exact publication bytes. Recovery
injects checkpoint-storage failure, not a process crash. Controlled source
markers do not establish official initializer provenance. Original history,
transition/preparation identities, project source and non-target file identities
remain preserved. No Docker daemon, dependency network or provider is required.
The group does not qualify successor creation, fresh OpenSpec finalization,
general update writers, other hosts or whole-directory rollback.

Successor revalidation stores protected indexes in schema-2 `deflate-raw`
artifacts, using the same bounded decoder as local completion. Both the encoded
record and expanded index remain limited to64KiB; base64 overhead must not
exclude an otherwise admissible index. Historical schema-1 target/index
artifacts remain readable, and target records retain their original encoding.
Compression does not change protected paths, exact-byte commitments or consent.

The shared project fixture in `tests/fixtures/modern-revalidation-project.ts`
also serves `tests/modern-revalidation-records.test.ts`; its private native and
archived opt-in groups remain separate qualification obligations.

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
Node.js 22 and npm 12.0.2 on Node.js 24. Liftoff itself generates both fixtures on
supported Node.js 24.20; the captured absolute Node/npm paths run the generated
project commands on the exact compatibility pair. The older lane checks template/lock
compatibility; it does not lower Liftoff's Node.js 24.20/npm 12 workstation
readiness floors. Prefer the smallest compatible patched
line between reviewed baseline refreshes. Do not use `npm audit fix`, downgrade a
dependency to hide an advisory, or add an unverified transitive override.
Afterward run the focused security tests, the standard template verifier,
package smoke, and the live audit.

## Refresh the supported stack

Current onboarding uses the explicit v8 generator; historical application
entrypoints and v7 fixtures must keep their original behavior. For workflow,
prompt, or template changes, exercise `current-project-planning`,
`current-project-generation`, and `current-project-onboarding` alongside the
historical planner/composition tests. Manual must not acquire an external
framework or unselected agent through a fallback. Running-process Node evidence
is separate from external tool readiness. Keep sensitive/state exclusions
unchanged, and do not treat successful generation or doctor source inspection as
native verification/finalization.

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

The separate [native development bundle builder](docs/native-development-bundles.md)
uses pinned official runtime bytes, the production dependency lock and original
license notices. Run its portable contracts with
`npx vitest run tests/native-bundle.test.ts tests/native-distribution.test.ts tests/native-release-set.test.ts --maxWorkers=1 --no-file-parallelism`.
An unsigned development inventory is not signature, installer ownership, OS-floor
or publication evidence. It does not replace the npm release gates below.
CI adds isolated native package lanes on Linux x64/arm64 and Windows x64 to the
existing Apple Silicon lane. Their complete opt-in report gates reject omitted
or skipped applicable cases. Windows compiles the real launcher and exercises
running-image locks and the installed controller without changing execution
policy. Linux uses an explicitly test-only signing key for authentication
negatives; that is not production signature or package namespace qualification.
The release-set contracts also use ephemeral, explicitly synthetic keys and
artifacts. They exercise all-target/npm immutable assembly, signature/subject/ref
refusal and cross-host byte verification without signing or publishing a release.
Only an independently authenticated complete handoff may supply the flat catalog
described in the native guide; no fixture namespace or generated key is approved.

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

Current public update uses schema-4 reports and reviewed v8 writers. Keep the
historical schema-3 application contract and frozen manifest captures distinct;
do not regenerate historical evidence to hide a public routing change. Exercise
configuration presence, bytes and modes across preview/approval, all four
successor/maintenance lanes, explicit fingerprint-selected recovery, and
committed-but-incomplete outcomes. Public recovery must work before manifest or
configuration parsing, without borrowing repair/local-verification authority.
`npm run smoke:package` also exercises the installed v7-to-v8 preview, missing
approval refusal, exact approved publication, original manifest preservation
and read-only current maintenance outside the checkout. This does not qualify
framework execution or native runtime-inclusive distribution.

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
