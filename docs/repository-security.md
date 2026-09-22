# Source-repository security

This page describes `voyager163/liftoff`, not a generated project's governance
activation or Azure production readiness. The repository remains public,
GPL-3.0-only and open to forks and contributions. npm remains the supported
distribution; native bundle modernization is a separate change.

## Current state and evidence

The dated baseline and authority record is
[`security/hardening-baseline.json`](https://github.com/voyager163/liftoff/blob/develop/security/hardening-baseline.json).
It records observations against commit
`70d10881b46d873118d825735696f39b6d35ebe0`, not a perpetual statement of live state.
Implementation evidence must identify the revision it actually tested.

At that baseline, GitHub secret scanning, push protection, Dependabot alerts and
security updates, and private vulnerability reporting were enabled.
`develop` was unprotected; `main` required three operating-system checks but had
no PR requirement and exempted administrators. Advanced CodeQL and repository
rulesets were not configured. The Windows repair boundary check failed; Linux,
macOS, telemetry and both npm template lanes passed. These are distinct results,
not a claim that all CI is broken.

Local typed evidence, inventory, materialization and private-workspace helpers
are being qualified with deterministic tests. Their presence does **not** mean
that CodeQL, image/IaC scanning, secrets history assessment, or hosted enforcement
has run successfully. Prepared workflows, readback, successful execution,
finding-based acceptance and enforcement are separate evidence states.
Missing evidence remains a blocker.

The initial authorized draft-PR run of checkpoint `b5b9a83` attempted ten jobs:
seven passed and three failed. Linux/macOS functional checks, telemetry OpenTofu,
both npm template lanes, canonical npm auditing and dependency review passed.
The non-npm scanner completed all four graphs but correctly blocked on 19 Go
findings, with four additional tracked findings. The Windows boundary suite
failed functional cases, and the Linux OSV fixture failed as a process/setup
error rather than a vulnerability finding. CodeQL remained skipped under its
disabled controls. These are execution observations, not hosted enforcement or
permission to merge, publish, bypass a failure or rerun jobs.

Follow-up preparation binds non-npm reports to the actual event/run/attempt,
workflow revision, base, PR head and tested merge parents; scheduled protected
checkouts retain their identity separately from the default-branch event SHA.
The first run's local-style embedded identity is not retroactively relabelled.
Bounded Linux guard phase/errno/exit diagnostics and an opt-in Windows controller
lifecycle trace retain no command contents, nonce, environment values or process
output. The Windows diagnostic uses the existing ten-second command bound only
after the original boundary step fails; it neither skips tests nor changes
settlement assertions. Hosted qualification of these follow-up changes remains
pending separate authorization.

The authorized diagnostic follow-up at `71e18a4` again completed seven passing
and three failing jobs. It verified the non-npm report's real PR/run/attempt and
base/head/tested-merge binding while preserving the Go finding block. The Linux
failure was specifically the stdio preflight, before seccomp installation:
Node's Unix child-process pipes use anonymous stream socketpairs. The pending
correction admits only existing anonymous AF_UNIX stream descriptors whose
kernel peer PID/UID match the explicitly supplied immediate producer, preserving
descriptor identity/flags. Network, named, datagram, foreign-peer and unbound
producer cases still reject, and non-stdio descriptors are still closed.
Thirteen native ARM64 cases reproduced the old failure and verified the narrow
correction, ordinary pipe/file behavior and continued socket/io_uring denial.
The changed guard also completed 52 pinned CodeQL query executions without
findings; earlier tool-restoration failures remain separate failed receipts.
No other source category was renewed by that targeted analysis. This is not yet
hosted AMD64 qualification.

The Windows diagnostic hit its actual 15-second test limit before returning;
that failed observation remains unchanged. A pending opaque per-invocation
recorder can be read during teardown even if the awaited result never returns.
It caps stage events and bytes, rejects forged/reused handles, and keeps abort,
timeout, truncation and unsettled-process results distinct from trace delivery.
No production logging is enabled by default and no existing command,
supervision, cleanup or test timeout is enlarged.
In particular, trace completion is not process-tree settlement. The existing
five-second supervision grace remains separate from the ten-second command
budget; teardown can report an incomplete live trace at the original
15-second diagnostic-test deadline.

The subsequent hosted AMD64 run verified the exact guard/tool digests, all
socket/io_uring denials, seccomp/no-new-privileges readback, offline extraction
and owned cleanup. The Windows live trace separately established controller
spawn at 5 ms but no pipe connection, authentication or target dispatch before
the existing test deadline. It does not identify interop compilation as the
cause merely because that precedes connection.

Opt-in bootstrap diagnostics add only invocation-bound static markers
around script entry, interop loading and pipe connection. They are decoded only
from the pinned default controller's own stderr before authentication; target
output, wrong bindings, out-of-order/replayed markers and oversized lines do not
become trusted stage observations. Marker delivery never advances readiness,
authentication or settlement. The asset pin is updated mechanically; removing
only diagnostic additions reproduces the prior controller bytes exactly.

The next actual Windows trace reached script entry and the `Add-Type` boundary
at 295 ms, but not interop completion before the unchanged deadline. That
locates the boundary; it does not establish whether command resolution,
compilation, environment or prior test load caused the delay. The probe ran
after the failed boundary suite, not on an otherwise unused runner.

The subsequent authorized comparison used three separate fresh Windows jobs: a trivial
non-writing compiler control, the exact pinned controller C# definition without
native-method execution, and the existing full-controller diagnostic. Both
compiler probes reached `Get-Command Add-Type` but not command-resolution
completion before their deadlines, before assigning or compiling either C#
definition. The three host-environment digests matched, and the two compiler
probes used the same PowerShell binary. Prior suite load is not needed to
reproduce the stall; its actual cause is not yet established.

The next prepared comparison uses that exact C# definition on two fresh runners,
one retaining original discovery and one selecting only the verified existing
builtin Modules root after startup, alongside the untouched full controller on
a third runner. Windows PowerShell can add user/all-user search paths at startup,
so an inherited `PSModulePath` value alone would not prove the effective scope.
The fixture verifies the OS home, local canonical root and reparse-free ancestors
with .NET primitives, not module-autoloading cmdlets. Both variants use the same
verification prelude and differ only in the intended process-local selection.
They bind original/effective child-environment digests and command/module identity
if reached. Unknown identities, foreign roots and drift remain unqualified;
production environment, asset, C# definition and timeouts remain unchanged.

These diagnostics do not warm, reorder or weaken the required suite. They retain only
bound static phases, timing, exit/cleanup state, tool/source digests and
allowlisted host-environment key names/digests, never raw compiler source,
errors or environment values. Compiler deadlines are ten seconds with a
five-second cleanup-only bound; timing out remains failure. Any tree termination
targets only the exact still-live spawned process, and uncertain descendant
settlement is not asserted. These jobs have five-minute bounds each and require
separate authorization for each additional hosted attempt. The new module-scope
contrast has not yet run; local PowerShell 7 syntax parsing is not Windows 5.1
runtime or causal qualification.
The compile-only probes distinguish observed compilation completion from full
resource qualification: without independent descendant-settlement proof their
job remains unsuccessful, even if compilation finishes. They are diagnostic
jobs, not proposed required green gates or proof of a production fix.

The authorized module-scope comparison subsequently established the isolated
cause: the original-discovery case stalled before command discovery, while the
same pinned C# compiled at 5.52 seconds after selecting the verified builtin
root. Binary, module root and original host/child-environment identities matched;
only the intended post-startup discovery scope changed. The untouched controller
still timed out, and compile-only descendant settlement remained unqualified.

A local production correction is now prepared, not yet hosted-qualified. The
runner binds each invocation to the actual canonical system PowerShell PE
and sibling builtin directory, rejects foreign/reparse roots and detects drift.
It does not impose the single hosted machine's binary hash or Node caller
architecture on user systems. The image's PE machine and pointer width are bound
independently, including an OS-resolved System32-to-SysWOW64 redirect rather than
a search fallback. The child verifies its actual image and native pointer width;
recognizing an image format is not qualification of an untested architecture.
The controller independently checks its OS Windows directory, actual executable
path/digest and local builtin root with .NET primitives before selecting its
process-local module scope. Every later cmdlet is inventoried: Core command/
pipeline primitives must come from the running PowerShell assembly; Utility
cmdlets must resolve from the builtin manifest/system binary with the expected
Microsoft assembly identity, including normal Framework GAC loading. Unknown
bindings fail explicitly before target dispatch; unrecognized image formats
remain unqualified instead of falling back to another runtime.

The C# definition and all controller bytes after this bootstrap remain unchanged.
Execution policy, privileges, authentication/ready/ACK, command deadlines and
kernel settlement requirements are preserved. The target still receives its
separately encoded environment block, never the controller's selected module
scope. The native diagnostic will exercise both absent and explicitly supplied
target module environments at the existing per-test limits. Runtime identities
are retained only as bounded hashes in the opt-in recorder; default calls do not
gain logging. Actual patched controller/target and required-suite results are
still needed before describing all Windows behavior as fixed.

The first authorized patched-controller round passed both absent/explicit
target-environment cases on fresh hosted x64 and again after the original
boundary suite failed. Authentication, ACK, target execution, kernel settlement
and owned log cleanup completed at unchanged limits. Linux and macOS functional
jobs also passed in that round; earlier failures remain retained. The original
Windows suite still had 34 failures, so this is a scoped bootstrap correction,
not full Windows acceptance or other-architecture qualification.

The remaining causes are kept separate. Protocol simulations used POSIX shell
launchers on Windows, including the newly added runtime-rejection case; local
test-only registration now starts the same real Node pipe peers portably, with
unregistered spawns and production asset validation untouched. The
missing-PowerShell admission fixture failed npm preparation inspection before
injecting its missing runtime; it now uses the existing no-preparation
application fixture, preserving all no-command/no-workspace assertions without
inventing a tool-version pass.

An additional opt-in comparison is prepared for the genuine registered-workspace
launch failure. It uses the same verified executable, clean target environment
and ten-second command budget with independent short controls and the exact
repair-workspace storage shape, distinguishing direct `execFile` from controller
launch. Only path length/type/existence/digests and finite error/Win32 codes are
reported. Direct root-process exit is not descendant-settlement proof; those
diagnostic cases remain incomplete with uncertain owned resources retained.
Production storage roots and deadlines are not shortened or weakened to pass
the comparison. Its execution remains subject to a new exact hosted-effects
approval.

The initial workspace comparison failed during fixture setup in all four cases,
before recording an executable, working directory or launch result. It supplies
no path-length or process-launch conclusion. A local reproduction found that the
diagnostic omitted the original fixture's nested repository marker; the normal
private-storage guard correctly rejected its home inside the containing worktree.
The prepared fixture correction restores the original nested repository,
project-with-spaces, staging and home layout without changing production path
policy. Ordinary tests now exercise actual registration/release/cleanup and
prove that omitting the marker still triggers the storage guard. Native metadata
separates root creation, fixture preparation, workspace registration, executable
inspection and cwd inspection, retaining only allowlisted outer/cause codes.
Until a newly authorized comparison reaches those stages, all four earlier
cases remain unqualified.

The corrected native comparison then reached all four launch cases with the same
verified Node executable, environment and command budget. The existing 49-unit
cwd launched through both paths, and the controller proved kernel settlement
and owned cleanup. The existing 283-unit repair cwd failed before target spawn:
direct launch reported `ENOENT`, while the authenticated controller reported
Win32 `ERROR_DIRECTORY` (267). This does not mean Node or the directory was
missing, and root exit in the direct control still does not prove descendants.

The owner selected preserving the existing workspace layout and adding early
Windows cwd admission, not compacting identities or relocating state. The local
guard counts UTF-16 code units against the documented native 260-unit limit,
including a trailing separator and NUL. It checks the planned project/home roles
and every declared/resolved check and preparation cwd before new workspace
registry/allocation effects, then rechecks the actual cwd before activity and
target launch. The error is an explicit `unsupported-native-cwd` blocker, not
an inferred missing executable. Traversal/unknown bindings retain their separate
validation; Linux and macOS are unchanged.

Schema 1, full project/workspace identities, authenticated registry paths,
ownership and legacy recovery are unchanged. Inspection and authorized cleanup
of previously retained long workspaces do not pass through new-allocation
admission. An operator may explicitly select an existing supported shorter
user-local storage location (on Windows, the documented `LOCALAPPDATA` selection)
before obtaining a fresh preview. This does not move or delete records at the old
location; recovery still needs their original storage context. No global
long-path setting, junction, `subst`, extended-prefix fallback or automatic
relocation is introduced.

Ordinary Windows success fixtures use separately owned representative storage
through test options, with spaces and full identities retained. The explicit
283-unit fixture remains a native negative: it must now block before allocation
and launch, with no registry/directory effects. Earlier failed launch and
uncertain-owner evidence is preserved, not retroactively cleared. The subsequent
native run confirmed both 283-unit/285-accounted-unit cases reject with zero
allocation operations, no returned workspace and no target dispatch. Both fresh
controller/environment cases also passed. These are separate from full Windows
qualification, independent npm admission, and the direct control's incomplete
descendant settlement.

That run exposed an introduced fixture self-test setup failure at the existing
ancestor realpath-equality guard, before its containment assertion. The local
fixture correction binds the same newly created directory's identity before and
after selecting its canonical spelling. Its expected storage boundary comes
from explicit fixture options, including Windows `LOCALAPPDATA` precedence, and
must independently belong to that owned root before workspace registration.
Native-relative containment, foreign/sibling-prefix/alias negatives and owned
cleanup replace the raw home-prefix assumption without changing production
allocation or alias guards. The same owned-root helper also corrects the new
raw temporary-root spelling in the application/workspace admission fixtures.
Storage-overlap negatives explicitly override Windows `LOCALAPPDATA`, rather
than changing only the lower-precedence home option.

The required Windows run had 112 failures, a new regression boundary rather than
a collection of pre-existing failures. Forty-four workspace failures bind to the
ancestor realpath guard; the remaining assertions are not automatically assigned
that cause. The framework fixture already canonicalizes its root and separately
reported the npm version/declared-identity compatibility gate. Its exact native
version predicate and full selected nested-cwd geometry are not established by
the short fixture prefix or by these local repairs. These fixture corrections
still need their own native qualification.

The Windows framework test records bounded metadata from its existing real
version probes, not replacement probes or synthetic version success. Canonical
binary/launcher/declaration digests, identity stability, recognized numeric
versions and finite predicate codes are recorded without raw output, paths or
environment values. The same configured storage selector supplies read-only
canonical-base and complete declared/preparation cwd measurements without
allocating a new workspace. Metadata failures are explicit, and the original
runner inputs, result, exception, deadlines and test assertions remain unchanged.
These observations diagnose a failure; they do not override it.

The same run's two compiler comparisons did not complete
discovery/compilation within their unchanged deadlines; earlier successful
comparisons do not substitute for those unsuccessful observations.

The next native fixture round reduced required Windows failures from 112 to
three: the workspace, CLI and cwd-admission suites passed, while a CRLF-only
documentation assertion and two npm preparation-admission cases remained.
The same real probe independently matched the setup-node distribution's bundled
npm 11.19.0 bytes and declaration, below the required npm 12 release line. The
canonical framework parent measured 52 units and the longest declared/preparation
cwd measured 259 accounted UTF-16 units, so those observed directories fit.
The prepared CI-only correction verifies the globally installed npm 12.0.2
declaration and actual CLI, then adds its Windows global prefix to subsequent
steps' PATH. The real filtered tool observer must resolve that exact CLI and
declaration; POSIX PATH selection and production admission are unchanged.
Documentation example parsing now covers both LF and CRLF without dropping
content assertions. These local corrections are not a new hosted pass.

`npm test` now starts Vitest with canonical temporary storage outside the source
checkout. An inherited temporary path inside the checkout fails explicitly;
`LIFTOFF_TEST_TEMP_PARENT` can select an existing external private parent.
On macOS, an overlong default temp path uses a separately owned mode-0700 short
directory so the existing mocked Windows controller's Unix socket stays below
the native 104-byte path limit. The launcher verifies that directory's identity
and removes only it after Vitest exits; explicit external parent choices are
preserved. This fixes a reproduced 110-byte bind failure without changing
Windows production behavior, timeouts or process-tree assertions.
This keeps transform caches out of source-capture inventories without ignoring
unknown files. Previously identified test caches were preserved outside the
checkout with exact byte/inode verification, not deleted or silently excluded.

The local admission foundation in `scripts/repository-security/admission.ts` and
`scripts/repository-security/policy-data.ts` now separates actual finding results
from normal and policy-only PR admission. Isolated real-Git fixture tests use
synthetic observation reports to exercise that boundary. Trusted production
workflow integration and hosted enforcement remain unqualified; those tests are
not evidence that live analysis or an actual protected-branch merge path ran.

The local secrets adapter now accepts only an issued, unchanged in-process
Gitleaks assessment. It binds the exact scanned Git tree, declared refs, history,
tool/profile, timestamps and cleanup to the independently loaded adopted base.
Finding comparison uses exact blob/rule/location identities; actual commit and
run identities stay separate, so a policy-only commit does not itself create a
new finding. Serialized/candidate-written receipts, absent introduced history,
stale scope and detector drift are rejected. Admission consumption additionally
requires the invocation identity captured before the scan; attaching another run
or attempt afterward does not relabel a valid receipt. Unbound local inventory
assessments remain observations only. The real inert-fixture path proves
pre-adoption findings stay blocked during distinct maintenance admission and
only fresh assessment under adopted data can pass. Other whole-PR checks in that
local integration test remain synthetic; no hosted admission or real repository
disposition is implied. Confirmed incident knowledge cannot be omitted to clear
a finding, and the component result never authorizes publication.

The bounded local reporter keeps complete analysis, actual findings and reported
admission separate. It emits owner-bound lower-severity triage, scheduled-failure
and capability/drift records without sending notifications or claiming hosted
enforcement. Exact expectation, freshness and coverage checks reject missing or
inconsistent inputs; the caller still must authenticate each producer and adopted
policy. A previously passing schedule is never a release receipt. The CodeQL
driver now includes these sanitized owner-action records for every expected
category, including skipped/error categories. Other producer/route integration
and hosted delivery remain incomplete.

## Local Actions boundaries

The prepared workflow policy keeps read-only default permissions and explicitly
disables checkout credential persistence and automatic dependency caches.
Validation remains on ephemeral hosted runners; `pull_request_target` and
`workflow_run` are rejected rather than used as privileged reporting fallbacks.
The existing first-time-contributor execution approval setting is unchanged.
Only the dormant, main-ref-bound npm publisher job requests OIDC; dry runs and
installed-package verification do not receive publisher environment authority.
The isolated protected-ref CodeQL reporting job requests only
`security-events: write` in addition to read-only contents, and runs only when
source execution and upload are explicitly enabled. Its PR/Dependabot counterpart
and the upload-disabled reporting path remain read-only. Candidate scripts may
execute in the read-only PR reporting job, just as in PR validation; that job is
not an independently trusted policy/admission evaluator. No downloaded report is
executed, and a reporting limitation never selects a privileged fallback.
Every job has a finite timeout. PR runs cancel superseded work; the release
coordinator serializes without cancelling an in-progress publication.

`node scripts/check-repository-actions.mjs` checks these local boundaries and
seven exact Node 24 action descriptors, including release artifact transport.
Downloads must use declared producer-job artifact IDs from the same run, not
names, arbitrary run IDs, or cross-repository credentials. Those routing checks
do not authenticate security receipts: exact source, attempt, policy, inventory
and digest validation is still required at consumption. The release readiness
adapter remains blocked without independent producer and publisher evidence.
No hosted allowlist, environment or protection has been activated by these files.

## Dependency and generated-output coverage

The existing `npm run audit:template-dependencies` command performs a live,
read-only canonical npm audit of four named graphs: root Liftoff, telemetry
ingest, the generated Node backend and the generated frontend. It does not
install dependencies or rewrite locks during the audit operation.
Its existing strict policy blocks every unresolved advisory without an exact
valid exception, including lower severities.

Dependency Graph recognition is an inventory signal. Dependency Review assesses
supported PR differences. Complete-graph scans assess dependencies already
present, including vulnerabilities disclosed later. Dependabot proposes updates;
it is neither a passing scan nor permission to change release-owned baseline
metadata. Ordinary parser/policy tests use fixtures and controlled dates; live
advisory jobs can fail on new disclosures or service outages.

Prepared Dependabot entries retain the four npm directories and Actions and add
the two `uv` manifest/lock directories on the default branch. The inspected
[updater source](https://github.com/dependabot/dependabot-core/tree/6a3570b5be207c5bd2ea497c046805d47f71bb1e/uv)
uses uv 0.12.7 and handles PEP 621 optional dependencies; the documentation table
still lists 0.11. This source evidence is not a hosted updater run. Exported
function requirements, supported-stack metadata and generated template versions
still need reviewed baseline refresh. No bot approval or automatic merge is added.

The Go entry remains blocked: this repository's lock-template directory has no
Go source, whereas the inspected updater runs `go mod tidy`, which can prune a
source-free graph. Do not add dummy imports to published templates or enable an
unsafe updater merely to claim coverage. Full Go scanning remains mandatory;
Goose, provider and image updates remain supported-stack maintenance. The exact
upstream identities and limits are recorded in
[`security/dependency-update-capabilities.json`](https://github.com/voyager163/liftoff/blob/develop/security/dependency-update-capabilities.json).
Omitting Go **version-update** proposals does not disable independently eligible
Dependabot **security-update** PRs. Existing alerts/security-update settings remain
intact; provider eligibility is unqualified. Any such PR must preserve the full
graph and locks and reconcile supported-stack metadata before acceptance.

The prepared PR job queries GitHub's native dependency-comparison API directly.
Snapshot warnings, absent vulnerability data, unknown severity, malformed
responses and unavailable service fail the job; they are not clean diffs.
All dependency scopes are evaluated. Public output contains counts and advisory
IDs, not dependency-controlled descriptions or credential-bearing strings.
This closes a concrete limitation in
[Dependency Review Action v5.0.0](https://github.com/actions/dependency-review-action/blob/a1d282b36b6f3519aa1f3fc636f609c47dddb294/src/main.ts),
which can proceed after snapshot-warning retries expire. It is still the same
native dependency data, not another scanning engine. Actual fork/Dependabot
execution and required-check enforcement remain to be qualified.

The prepared non-npm assessment covers standard and GenAI Python locks, selected
extras/worker dependencies and resolved Go modules. Manifest parsing alone is
not proof of complete transitive coverage. Provider locks and images remain
part of reviewed supported-stack maintenance. OSV-Scanner is assigned only to
the demonstrated non-npm full-graph gap, not duplicate npm or image assessment.
Copilot Autofix, when available, provides suggestions that require ordinary
review and verification; it does not approve or merge its own changes.

The source OSV driver captures bounded no-follow input snapshots, assesses private
frozen copies, and rejects original-input or implementation drift. Only exact
public package coordinates and returned advisory IDs reach `api.osv.dev`; the
pinned scanner runs offline under an independently tested network-denial boundary.
The prepared unprivileged macOS job retains the existing PR/integration/weekly
events, without publisher rights or cross-trust caches. Hosted execution remains
unqualified. The Linux wrapper additionally requires kernel seccomp and
no-new-privileges readback, closes inherited non-stdio descriptors and denies
socket operations, io_uring and descriptor-transfer/process-injection paths.
A tiny native Linux ARM64 container fixture verified IPv4/IPv6/Unix denial,
io_uring denial and pinned OSV offline extraction with complete owned cleanup.
AMD64 emulation returned `EINVAL` at filter installation and remains unqualified;
there is no fallback that executes OSV without the guard. This is not a filesystem
sandbox or hosted AMD64 proof. The bounded read-only qualification workflow
prepares that exact real-run check without executing it during local preparation.

The local repository run assessed 53 standard-Python and 82 GenAI-lock components
without findings. Worker assessment covers the same 82-component universal lock,
including extras and platform-marker alternatives; the 78-coordinate functions
requirements export is separately reconciled by exact name and version. Neither
count claims an installed runtime environment. The 263-coordinate Go application
and independent tool union reported applicable advisories without published
classification. The owner's explicit unscored-advisory decision is recorded in
`security/unscored-advisory-decision.json`: valid applicable records that genuinely
lack recognized published severity or a supported vector become **blocking policy
findings**, not invented CVSS scores. Upstream severity remains `unscored`;
HIGH is the policy review priority and limits any exact exception to 30 days.
A record's own published HIGH remains its own vulnerability classification and
is not borrowed by an unscored GO alias.

Supported vectors that need native scoring are evaluated by the same pinned,
offline OSV engine using exactly one advisory and one affected component.
The original record/vector, component/version, database and native result are
bound together; an alias group's maximum score cannot supply the classification.
Real isolated CVSS4 high and zero-impact controls produced critical and info
respectively, with no network query. Zero is a valid score, not missing severity.
Malformed vectors, missing component coverage or failed scoring remain errors.
The final local full-graph assessment completed all four graphs: Python findings
passed; Go remained blocked by 19 findings (15 unscored-policy and four
own-published HIGH), with four lower findings retained for owner triage.
Real clean, Python-transitive and Go-transitive controls independently exercised
passing and blocking results. These are local qualification results, not hosted
Dependabot execution, adopted exceptions or publication authority.

TypeScript generator strings are not executable Python, Go or OpenTofu inputs
for source scanning. The explicit local materialization inventory uses the real
generator, all nine GenAI patterns, the three standard API stacks, frontend
variants and all three environments. Materialization verifies unchanged
generated metadata; materialization alone does not run setup, activate governance,
deploy or exercise a generated application's behavior. Separate owned-image smoke
checks do exercise local operational endpoints without production dependencies.

CodeQL is the planned source/materialized-code analyzer; Checkov owns actual
IaC/build-configuration assessment, and Trivy owns actual built images.
An OS/platform and image digest must be recorded for image evidence. A Linux
image verdict is not evidence for unbuilt architectures, and an npm package or
future native executable is not a container. Missing language extraction,
reports, images or applicable cases cannot yield a clean result.

The local Checkov driver now captures exact inventoried Terraform, Dockerfile and Compose
inputs into registered private roots outside the checkout. Its guarded native
printer emits only numeric rule/location/status metadata, never resource values,
source excerpts or native error text. Inline skips, parsing errors, missing
required file parsing and unknown report identities fail closed. The existing
network/process denial boundary is unchanged; its narrowly registered grammar
cache is used by Dockerfile imports too. This is not an OS sandbox or a seal of
the complete installed Python dependency environment.

A local source run completed native execution for bootstrap, telemetry, the
catalogue-owned provider configuration and the telemetry Dockerfile. Telemetry
reported eight Terraform and one Dockerfile rule failures. A materialized
standard-Node run reported 27 application-module and two Dockerfile rule
failures. Native failure counts are not assigned CVSS scores or automatically
treated as confirmed vulnerabilities: exact blocking/diagnostic classifications
remain to be reconciled with the intended resource roles and public telemetry
behavior. No infrastructure configuration or exceptions were changed to pass.

Checkov 3.3.10's built-in `CKV_AZURE_3` targets `azurerm_storage_account`, not
the bootstrap's `azapi_resource` storage body. The registered
`CKV2_LIFTOFF_1` policy checks the existing HTTPS contract for the exact declared
storage API shape. Native secure, disabled/missing-HTTPS, unknown-API-version and
out-of-role container controls qualify that narrow rule. Out-of-role conditional
passes are labelled explicitly and do not count as covered resources. Rules
`CKV2_LIFTOFF_2` through `_5` additionally check existing bootstrap-only TLS,
identity-oriented/shared-key-disabled authentication, private state containers
and enforced perimeter associations. Actual-shaped secure/insecure, API-case and
malformed-type controls qualify these checks. Additional bootstrap-only rules
`_7` and `_8` preserve perimeter-secured/private-blob storage and explicit
nonempty IPv4 `/32` inbound admission without legacy subscription/service-tag
admission. Rule `_9` checks the exact ten-resource state/perimeter/profile/
container/Entra-role graph and existing deletion protections; unknown membership,
API shapes and unresolved bindings remain errors, not waived findings.
The four required variables use frozen nonsecret representatives, including an
RFC 5737 documentation address, never inferred operator values. Raw HCL/binding
reconciliation prevents a native-normalization omission from turning unresolved
CIDRs into a waivable finding. These are static contract checks, not production
network/RBAC or deployed-value qualification.
The declaration/validation files are bound to their reviewed source snapshots;
changing them requires requalification instead of assuming representative values
prove the production input contract.

The exact telemetry Basic registry's availability/network recommendations are
reported separately as owner-visible design diagnostics only when actual source
facts establish its approved role: admin/anonymous access disabled and matching
managed-identity `AcrPull`/image-pull relationships. Its missing Dockerfile
`HEALTHCHECK` is likewise distinct from the actual matching TCP startup,
readiness and liveness probes. Native failures remain failed. Changed facts,
another registry in the same file, candidate role labels and serialized/fabricated
observations cannot inherit this treatment. Production availability remains
unqualified; generated roles require their separate qualification below rather
than inheriting telemetry approval. There is no blanket rule-ID downgrade.
The owner's separate exact-role decision also retains SKU-tier, dedicated
endpoint, legacy Notary, quarantine and untagged-retention failures as feature
diagnostics (`163/237/164/166/167`). Their omission/default interpretation is
bound to the approved source bytes as well as actual native identity/auth facts.
Changed feature bindings require requalification. Digest pinning is not signing,
and no missing feature is claimed present or added to infrastructure.
Registered rule `_10` separately assesses the exact fourteen-resource telemetry
graph: managed identity and least-privilege roles, HTTPS and intentional public
ingress, source/digest reference wiring, exact six-column ingestion projection,
180-day retention and the absence of a platform-log destination. Source changes
that widen collection, enable local authentication, broaden roles or alter
unknown membership remain blocking/unqualified. The optional-feature diagnostic
decision cannot clear those mandatory controls.

The separate generated-baseline decision binds all 39 Terraform scope digests
to native provider/authentication/identity evidence. It permits only the exact
Basic ACR feature diagnostics, plus independently bound PostgreSQL geo-backup,
Redis replication, Storage GRS-family and Linux/Y1 worker-count/zone diagnostics
where no stronger baseline requirement exists. Storage LRS is not ZRS or GRS.
Service Bus optional key-management/namespace-identity treatment remains held
until independent encryption, authentication and application-identity evidence;
queue logging remains held until actual queue-service usage is established.
Core authentication, TLS, private-blob, recovery and non-root requirements are
not downgraded. Other resources' public-network findings remain unqualified or
blocking, not covered by the ACR decision. Native failures remain visible.

The separately approved [pinned provider-default controls](reference/provider-default-controls.md)
preserve TLS/private-blob requirements rather than treating them as optional.
Fresh native observations for all 39 generated Terraform scopes independently
bind `44/148/190/205` to omitted attributes, exact AzureRM 5.3.0 defaults and
verified create/update serialization. Their 156 native failures remain visible
alongside a distinct source-control equivalence; they are not rewritten as
native passes, adopted exceptions or deployed-state evidence. Changed provider,
resource, authentication, input, lifecycle or explicit-value facts do not inherit
this classification. Other security and resource-applicability blockers remain.

Actual secret-free health-only runs now cover all 13 generated cases and 23
backend/frontend targets. Exact whole-generated-artifact, Dockerfile, built-image
and owned-container identities are checked before/after bounded loopback probes.
Backends must return the declared health/readiness values and valid OpenAPI;
frontends must serve the index and a same-origin JavaScript module. Only an
issued current proof can support that exact missing-`HEALTHCHECK` diagnostic;
serialized receipts, changed inputs and candidate role labels cannot. These
runs do not assess vulnerabilities, external services or orchestrator probes.
An initial startup failure and a separate pre-evaluation parser failure remain
retained alongside the successful targeted retries, not overwritten.

Parsed files and resources with native results are reported separately from
security applicability. The exact generator-owned comment-only remote-backend
examples retain their bytes/digests without fabricated resource ASTs; executable
content or arbitrary empty `.tf` files cannot use that classification. The
catalogue provider-only input has its own exact-byte inapplicable-resource
classification, not a checked-resource count. Dockerfile applicability requires
the pinned nine-rule inventory per file; Compose uses explicit service/image/
build coverage, not its native zero-resource counter.
Frozen local-module closure and explicit generated `tfvars` are now assessed together.
Required missing values and remote/unregistered module sources fail before
execution; a plainly nonfunctional password binding is used only for scanner
representation, never as production input.

The generic native Checkov YAML runner executes registered policy
`CKV2_LIFTOFF_6` for every Compose service. External image references must match
the exact supported-stack tag/digest inventory, including case-sensitive tags;
local builds must match inventoried Dockerfile contexts. No Compose service is
started. The runner's native zero resource count is retained separately from the
explicit service inventory, and native location ranges are retained alongside
the qualified inclusive-range normalization.

Local execution evidence now covers all 13 generated cases and 75 named scopes,
including 120 Compose services. Targeted Compose retries retained the prior
successful Terraform/Dockerfile evidence with identical native projector identity;
this is not one atomic release run. The 1,146 native failure observations across
cases/environments are not distinct vulnerabilities or approved dispositions.
Resource applicability and the remaining finding-policy classifications are still
unqualified. The driver reports
`fullInventoryQualified: false`, `findingPolicyQualified: false` and
`publicationQualified: false` while these dependencies remain unresolved.
The full current driver composes four source scopes and all 75 generated scopes
with frozen-input reconciliation. Its actual 79-scope run completed analysis and
cleanup while retaining 1,155 native failure observations; the finding gate
correctly remains incomplete. The separate full group composer requires source
IaC, all 13 generated cases and all eight registered image cases. Missing builds,
reports, identities, platforms, cleanup or groups cannot yield a passing gate.
Retained receipts can illustrate that composition, but do not become an atomic
run, authenticated producer evidence or current release qualification.

The staged CodeQL producer explicitly selects SARIF 2.1.0 with flat driver-rule
descriptors. Query execution is verified separately: every resolved query needs
a fresh, digest-bound BQRS result and validated native metadata, including
zero-row, diagnostic and metric outputs. Named result sets are bound to the
pinned query definition or an exact hash-registered import, never selected merely
because a report contains one table. SARIF descriptor counts are not an
execution inventory. Empty dependency-component metadata cannot resolve findings
or count as analysis. The required producer rejects grouped rule layouts rather
than inferring their versions; its explicit format choice is part of the
configuration identity.

The two-file JS/TS fixture qualified all 105 selected queries (101 security and
four ancillary), including 100 zero-result queries and blocking problem/path
findings in the selected flat format. This is not completion of the full
source/generated matrix by itself or hosted qualification.

Generated analysis keeps executable extraction coverage distinct from its full
input/artifact inventory. Manifests and supporting configuration may legitimately
appear in SARIF or contain findings; they are accepted only when already
inventoried, materialized and digest-bound. They do not increase the executable
source count or excuse missing language extraction. Undeclared or escaping
locations remain errors, and findings are never discarded merely because they
point to a supporting file.

Source categories also produce reconstructed SARIF with static messages and
required rule descriptions/help, exact validated locations, security tags and
native severity identities, rather than copying native prose, snippets or code
flows. Supported native line fingerprints are preserved; missing fingerprints
leave native cross-run alert matching unqualified rather than inventing a line
hash. Generated categories never enter this source upload payload.

The staged source workflow retains its sanitized reporting artifact even when
actual findings block the producer. The separate reporter revalidates both
source categories, digest/size/path/schema bounds and exact source/workflow/run/
attempt before reconstructing upload bytes. Its fixed-repository REST protocol
requires accepted submission **and** completed processing, with finite polling
and no raw response diagnostics. A 403 remains explicitly unavailable and does
not clear a finding or obtain a broader token. Execution and upload controls
remain disabled; no hosted upload was performed during local qualification.
The read-only local-report path works without an upload credential. Prepared PR,
protected-push and default-branch weekly events are not proof of full recurring
producer coverage or hosted fork/Dependabot qualification.

The prepared native protection description is not an API payload or observed
required-check configuration. Native protection needs diff locations and excludes
default-setup Dependabot analysis and merge-queue groups; full local evaluation
remains necessary. No hosted setting or required reporting context has been activated.
The resumed native CodeQL fixture produced the expected zero-finding and
one-blocking-finding results; the latter carried a supported native line hash
that survived sanitized projection. This was a local JS format fixture with an
explicitly relabelled category, not real Actions-language analysis or a hosted upload.

On 2026-09-20, a separate local run completed all 24 declared source/generated
categories and 1,841 query executions. All 22 generated-code categories (300
executable files) passed their finding gates; an isolated generated-only negative
fixture independently blocked as expected. Actual source analysis completed but
reported 49 blocking high-severity detections and three moderate detections for
triage. These are not all confirmed vulnerabilities or approved exceptions.
No equivalent baseline-source assessment supports baseline-versus-introduced
finding attribution. This dated working-tree qualification is not a clean-source,
release, hosted/fork, or cross-platform enforcement claim.
The new Linux guard adds an explicit `source/python` category, making the current
inventory 25 categories and source reporting three categories. A targeted native
CodeQL run covered the actual guard file with 52 query executions and no findings.
The prior 24-category receipt remains historical; the new category does not
silently renew any other source or generated assessment.

Local nonfunctional fixtures now distinguish actual detector execution from these
remaining coverage gaps. Checkov 3.3.10's `CKV_AZURE_3` fixture completes both a
passing HTTPS-only case and a blocking insecure case. Its guarded adapter denies
network and subprocess execution, records the source-bound optional capability
fallbacks, and permits only its registered private grammar cache and verified OS
discard device. This is not an OS sandbox or complete repository IaC coverage.

The Gitleaks 8.30.1 fixture uses an explicitly **derived** configuration: it retains
222 upstream rules but removes 14 suppression groups, changing detector behavior.
Real lockfile, SVG, inline-directive and added-then-removed history fixtures retain
their detections. Candidate source/CWD `.gitleaksignore` files block invocation;
an empty ignore-path flag alone is not protection. Candidate config bytes and
inherited overrides cannot replace the explicit profile. Path-only detections
retain null coordinates and require exact dispositions, not a fabricated line.
These fixtures do not qualify all detector patterns, repository history, native
push rejection or hosted fork-merge enforcement.

Separately, the local declared-source adapter now assessed the exact committed
baseline tree and reachable file-diff history of 36 declared refs: 130 commits
and 3,964 reconciled Git objects. It re-encodes only selected objects into an owned
source-assessment workspace, never copies another checkout's Git configuration,
hooks or shared directory, and never writes source refs. Current-tree and
introduced-history controls reject suppression files, missing refs/objects and
shallow history. Public output contains numeric locations and bounded identities,
not matches or source excerpts. Detections remain unresolved and blocking;
private syntax/AST triage and exact fixture proposals do not adopt dispositions.
Detailed sanitized receipts stay outside the source tree.

That committed-baseline evidence does **not** assess uncommitted candidate bytes,
message bodies, opaque formats, archive decoding or every detector pattern.
Candidate capture needs its own stable inventory and identity; unowned scratch
or tool roots cannot be ignored or deleted merely to obtain a passing result.

Opt-in local Trivy execution requires both the actual local Unix daemon identity
and an explicit running `default` Docker-driver builder. A separately verified
buildx executable and SHA-256 are copied into private Docker plugin discovery;
generated Compose validation also pins its separate Compose executable and
allows only version/configuration operations, never `compose up`.
Global Docker configuration and credentials are not copied. The scratch-image
fixture has actual `linux/amd64` application-package detections, with OS coverage
explicitly inapplicable. It does not qualify the telemetry/generated image matrix.

All seven generated image cases and the telemetry image have been built and
smoked locally on actual `linux/amd64` image identities. Node and Go vulnerability
assessments completed with blocking findings. The other six initial assessments
failed on native `UNKNOWN`; fresh reassessments under the owner-approved separate
Trivy policy now complete and remain **blocked**. Their original failed receipts
are retained, not retroactively changed. Frontend reports 52 findings, standard
Python and each GenAI image 213, and telemetry 238. These are image-local finding
observations, not distinct vulnerability counts. Python/GenAI application-package
coverage includes both Rust-binary targets; repeated component observations are
not silently dropped. This evidence combines targeted runs, not one atomic
release qualification. All owned image/runtime cleanup completed.

The formerly opaque Debian record was identified as `DLA-4783-1` by a fresh,
base-only local image observation and corroborated by the
[Debian LTS advisory](https://lists.debian.org/debian-lts-announce/2026/09/msg00018.html).
The parser recognizes that advisory family only for Debian OS-package results.
Identity recognition does not assign severity: the native record still has
`UNKNOWN` and no same-record published label, vector or score. The approved
decision is recorded in `security/trivy-unscored-advisory-decision.json`.
Valid native `UNKNOWN` becomes a **blocking policy finding** with HIGH review
priority, not an invented CVSS score. Every potential exception still binds the
exact image digest, component/version, advisory and target; the existing
observed-base/maintainer-adoption route and maximum 30-day window apply.
No actual exception or image/dependency change was approved. Missing/malformed
severity, unsupported identities, present CVSS metadata (including a real zero)
or an unresolved same-record published label remain errors, never an unscored
waiver. The small native Debian image qualified the three applicable UNKNOWN
records as blocking while retaining all 238 findings and 234 installed packages.

A source-built Go main module may legitimately have no upstream version in
Trivy 0.69.3. It is retained with `version: null` only when bound to the exact
generated module manifest, binary target and image identity; dependency and
stdlib versions remain mandatory. No version is invented and no package is
dropped. Source-code assessment remains independently required. Python preparation
uses checksum-pinned uv 0.12.7 and an explicit verified Python 3.14.7 in private
caches, without global installation or interpreter downloads. Cleanup handles
read-only private module-cache directories through verified directory descriptors;
it never changes shared caches, linked file permissions or base images.

## Findings, exceptions and secrets

The local finding policy blocks high/critical vulnerabilities and defined policy
violations; lower findings retain an owner and triage record. This minimum
does not relax the stricter existing npm contract. Exact vulnerability
exceptions bind the graph, component/version, reviewed dependency chains,
tool/rule and applicable artifact/location. They require rationale, mitigation,
owner and review dates; high/critical windows cannot exceed 30 days and lower
windows cannot exceed 90 days. Expired, stale, broad or cross-graph exceptions
fail. A scanner outage is an error, not an excepted vulnerability.

The prepared `security/finding-policy.json` records these invariants and the
explicit non-comparable policy-rule registry. Its Checkov entries cover
`CKV_AZURE_3` and the ten exact `CKV2_LIFTOFF_*` contracts described above, with
high **review priority** and a maximum 30-day exception window, not invented CVSS
scores. Unknown rules, unknown severity and classification mismatches remain
errors; those registered contracts do not establish complete IaC applicability.

The OSV policy class `osv-valid-unscored-advisory` retains each actual advisory
ID, component, version, graph, chains and input digest in the finding identity.
The class name is not a wildcard exception. Only a valid exact proposal for an
already observed trusted-base finding may use the existing maintenance-admission
path; ordinary maintainer merge is adoption, not a candidate approval field.
This policy decision granted no actual exception, dependency update or credential
action. Malformed/unsupported present severity metadata, withdrawn/inapplicable
records, missing coverage, source drift and transport failures still fail as
errors rather than eligible unscored findings. npm and secrets retain their
separate stricter contracts.

`finding-policy.ts` loads both the rule policy and vulnerability exceptions from
independently read adopted Git content. Candidate JSON and caller-created handles
cannot grant authority. It checks stale exceptions across the complete declared
non-npm report set before evaluating each producer, so an exception is neither
transplanted to another graph nor discarded merely because a different producer
owns it. Lower-severity triage is assigned to `voyager163` and remains visible,
not marked fixed. npm and Gitleaks are rejected by this generic evaluator:
their stricter existing audit and independent secret-disposition contracts are
still required. Its result is not admission, publication or hosted qualification.

Potential secret detections have a **separate** disposition process. Untriaged
detections and confirmed unremediated exposures block actual finding
qualification, normal intake, and publication regardless of severity;
the vulnerability exception windows cannot waive them. A reviewed false
positive or nonfunctional fixture must be exact and justified. A candidate PR
cannot authorize its own detector exclusion or broad baseline suppression.
An exact policy-only proposal for an existing-base false positive/nonfunctional
fixture may qualify separately for maintainer merge, but its unresolved finding
stays blocked until adoption. Confirmed unremediated exposures never qualify.

Report suspected exposure through the [private security route](../SECURITY.md#report-a-vulnerability),
without the credential, private source, `.env` files or unredacted output.
The credential owner must separately authorize and perform revocation/rotation
when exposure is confirmed, and remove current-source occurrences as applicable.
Only sanitized invalidation and source-removal evidence can establish
remediation. Deleting a file, rewriting history or closing an alert does not
prove that a credential is unusable. Never test a discovered credential against
its issuer as part of repository assessment.

## Pull-request admission and policy adoption

**Finding assessment is not PR admission.** Actual finding reports retain the
verdict under independently loaded adopted trusted-base policy. A candidate
exception/disposition proposal cannot make that verdict clean.

| Path | Required result | Meaning |
| --- | --- | --- |
| Normal admission | Complete successful candidate analysis, integrity, functional checks, and actual finding-policy success | The candidate satisfies the applicable adopted policy; new candidate grants cannot authorize its own code findings |
| Policy-only maintenance admission | Exact base-registered data changes and complete compatible base/head evidence, with no new raw findings or unassessed surfaces | A proposal is eligible for ordinary maintainer merge; existing findings remain blocked before adoption |

The trusted-base validator derives the path from exact Git base/head trees and
the complete changed-file set, not a candidate label, owner string, or requested
mode. Maintenance may change only exact exception/disposition **data paths
already registered by the base**. Source, dependency manifests/locks, workflows,
scanners, detectors/rules/query packs, evaluators, inventories, thresholds,
permissions, and publisher definitions must remain unchanged. Unknown paths,
initial registrations, renames, symlinks, file-type/mode changes, and mixed
executable/control-plane changes do not qualify; they follow normal admission.

Complete compatible base/head observations must compare stable protected
source/graph inputs, detector/rule/configuration identity, and exact normalized
location or component/dependency-chain identity. A policy-only edit changes the
commit identity; base/head SHAs need not be equal. Actual commit, run/attempt, and
freshness provenance remain separately verified. Only the explicitly admitted
policy-data bytes are excluded from protected-input comparison.

Every new or expanded entry must match an actually observed trusted-base finding
and meet exact scope, rationale, evidence, owner, and validity-window rules.
Unused future grants, cross-graph grants, and stale grants are rejected. A renewal
needs fresh valid scoped evidence; expiration is never automatically extended.
Exact withdrawals or stale-entry cleanup may reduce permission, never add it.
Confirmed unremediated exposures always block maintenance. False-positive or
nonfunctional-fixture proposals cannot downgrade a known confirmed exposure or
erase/fabricate incident and remediation evidence.

Failures in required scanner/parser/provenance evidence, unavailable coverage,
incomplete dependency snapshots, unknown severity, or failed required
integrity/functional checks block both paths. Normal admission requires the
candidate's success; a failing base functional check does not by itself prevent
a verified normal fix. Maintenance additionally requires the complete successful
base comparison. Matching failures or empty results do not prove unchanged clean content.
Existing policy finding/expiry diagnostics stay visible; they are not an excuse
to suppress analysis failures or fabricate a passing finding result.

### Adoption and subsequent assessment

Admission evidence binds repository, current base/head, the complete change set,
proposal bytes/digest, trusted validator/policy identity, and compatible analysis
evidence. Drift, new commits, or changed evidence invalidate the decision.
Candidate owner, approval, and evidence-reference fields are **traceability, not
authority**; active permission comes from independently loaded adopted base
content and verified source context.

The sole maintainer's ordinary merge is the adoption decision. There is no
separate pre-merge authorization command, receipt, or second-reviewer gate, and
no blind auto-merge. Subsequent normal and release assessments independently
reload the actually adopted base policy and reassess their exact candidate.
Do not reuse a pre-merge eligibility report as a finding verdict.

A normal code fix may retire an exact obsolete waiver only with complete
resolution evidence and an effective permission set no broader than the trusted
base. New or expanded candidate grants and remaining stale entries still fail.
Incident/remediation history stays intact even when a waiver is withdrawn.

The existing standalone npm audit CLI continues to report its actual
selected-policy result. Evaluating candidate policy locally is not adopted
authority or trusted admission. Production wiring that independently loads and
binds trusted base policy remains pending; no local result proves it exists.

### Required checks and publication

The future required-check composition is **security admission plus successful
analysis-completion, integrity, and existing functional checks**. Normal
admission consumes actual finding-policy success. Eligible maintenance reports
only proposal eligibility alongside unchanged blocked finding reports; do not
simultaneously require an unconditional clean finding context for that path and
recreate the adoption cycle. Do not synthesize green statuses, use broad
`continue-on-error`, neutral/skipped checks, or bypass native hosted rules.
Actual event/ref/check composition must be qualified before hosted activation.

Publication never accepts admission evidence, whether normal or maintenance.
It requires fresh complete assessment of actual release source/artifacts against
independently reloaded adopted policy, plus the other release requirements.
Maintenance eligibility is not a clean scan, incident remediation, publication
authority, or permission to republish. See the
[maintainer lifecycle](maintainer-reference.md#review-source-security-policy-changes).

## Secrets coverage and detection limits

Initial/full assessment must bind the current committed tree and an explicit
list of published branch/tag revisions to complete reachable-history evidence.
Incoming PR assessment must include the candidate tree **and introduced
commits**: adding a credential and removing it before the final revision still
requires detection and disposition.

Enabled settings and an empty alert list do not prove scan completion.
Do not retrieve raw secret-bearing hosted findings for qualification. Use
supported safe metadata or an owner-supplied sanitized record; otherwise report
the evidence gap.

Pinned, local Gitleaks is permitted only for the demonstrated native history
coverage or unprivileged fork-intake enforcement gap. Its safe-output boundary
must first prove full redaction for stdout, stderr, reports and error paths.
It must inspect only explicitly inventoried repository content in a registered
isolated workspace, use trusted detector policy, and emit bounded metadata
rather than matches or source excerpts. It must not inspect developer homes,
unrelated worktrees or upload content/findings to another service. A missing
tool, shallow history, unavailable object or incomplete report blocks coverage.
This conditional role preserves native GitHub protection; it is not a redundant
general scanner stack.

Provider-supported patterns and the pinned detector's documented rule set define
the tested detection surface. Unsupported patterns/content, false negatives,
unreachable/deleted objects, other forks' complete histories and external copies
are not covered claims. Generic-secret, validity and AI features are not assumed
available to a personal repository or prerequisites requiring a paid service.
No scanner proves the absence of every secret.

Local Git commits are outside repository push enforcement. Native push
rejection, receiving-branch merge denial and remediation need independent
evidence. Target-repository protection does not necessarily reject a push to
someone else's fork. Secret-protection bypass permissions are also independent
of branch-rule bypasses. Qualification uses only separately authorized
nonfunctional fixtures on disposable refs, never live credentials, and reports
unrecognized fixtures or uncovered bypass paths as inconclusive/blocking.

## Release and activation boundaries

The target is a sole-maintainer PR merge model with zero required reviewers, no
CODEOWNERS/last-push/environment approval gate and no ordinary administrator
bypass. App-bound checks identify a producer App, not unchanged workflow code.
Workflow, scanner, exception and publisher changes remain explicit
maintainer-owned control-plane decisions rather than blind auto-merge.

Release hardening must extend the existing npm coordinator, qualify and publish
the same tarball bytes, and preserve canonical version/dist-tag/install checks.
An SBOM inventories components; assessment evaluates vulnerabilities; provenance
describes production; signing/notarization establishes separate platform trust.
None alone proves secure bytes or SLSA L3.

Release preparation can now assess the exact installed npm runtime with
`qualify-npm-candidate.mjs --runtime-assessment`. It installs the selected tarball
in a private source-external wrapper without lifecycle scripts, binary links or
inherited npm credentials/configuration. Native npm 12.0.2 CycloneDX output is
reconciled against the actual private installation lock and dependency edges,
and the installed Liftoff files/integrity must match the inspected archive.
Missing components, unknown platform exclusions, disconnected edges and changed
locks fail. Explicit foreign-platform optional entries remain separately visible;
this is not coverage of other operating systems or packaged template graphs.

The same private graph receives a canonical npm audit using the existing strict
normalizer/evaluator: every unreviewed finding blocks, including lower severity,
and source/template exceptions are not transplanted. A real retained local
tarball produced 40 installed components/instances, complete runtime dependency
edges and zero runtime audit findings on macOS ARM64. This does not clear the
separate source, generated, Go, secrets or image findings. The staged release job
retains runtime CycloneDX and vulnerability records alongside the packed-file
inventory. Exact archive lock extraction now retains the Node/frontend and
universal Python template components, including bundled npm children without
invented child hashes and legacy integrity metadata without silent upgrades.
The packed Go inputs are resolved read-only in private caches against the
separately identified tool/checksum contract: a native retained run reconciled
77 application modules, 205 tool modules and their 263-component union, including
the complete 205-component tool contract. No source-checkout lock substitutes
for an archive input. The separate contract is not falsely labelled a packed
file, and component extraction does not claim an advisory verdict.
Adding `--template-assessment`, with absolute `LIFTOFF_RELEASE_GO` and
`LIFTOFF_RELEASE_PYTHON`, emits the separate 826-component template CycloneDX
inventory and executes canonical npm plus native OSV assessment of all six exact
packed graphs. A real retained local archive produced one blocking Node-template
finding, no frontend/Python findings, and 19 blocking/four tracked Go findings.
The installed runtime remains a separate graph. Missing components and forged or
changed Go observations cannot be used to construct a complete template SBOM.
The full archive assessment was qualified on macOS; the separate small Linux
ARM64 network/extraction fixture is not full hosted AMD64 template qualification.
The staged Linux release job now requests both runtime and full-template
assessment with explicit paths to its selected Go and Python tools. It does not
equate installing or scanning the runtime graph with template coverage.
Packed-template observations use the actual runner event, source/workflow
revision, run and attempt when invoked by Actions; missing/mismatched metadata,
dirty hosted source and invalid release intent fail closed. Local observations
remain explicitly labelled local, and runner metadata is not independent
producer authentication or adopted-policy authority.
Validated OSV and CodeQL producer summaries now also feed the existing Actions
job-summary file, including scheduled owner actions, actual finding status and
fresh-release requirements. A failed producer without a complete report writes
an explicit incomplete summary instead of an empty clean result. The bounded
writer accepts only summaries issued by the local reporting evaluator, rejects
unsafe/oversized output files, and uses no issue, comment, notification or status
API. These human-readable results do not authenticate producers or complete the
remaining multi-producer admission/recurrence qualification.
Full hosted template execution, authenticated current-run receipts and
verifiable build provenance remain incomplete. A dirty local descriptor and an
unsigned build record still cannot authorize publication.

The coordinator's read-only `provenance` mode can consume an explicitly supplied
local signed bundle through `gh attestation verify`. It binds the exact tarball
and bundle before and after verification, the GitHub OIDC issuer, protected
`main` source, release workflow digest, GitHub-hosted runner, certificate-bound
run/attempt and fresh witnessed timestamp. Predicate claims cannot substitute for
certificate identity. `readiness` re-verifies a supplied bundle rather than trust
a serialized observation; only the live in-process verification can satisfy the
provenance dependency. No signing action, OIDC enrollment, attestation upload or
publication transport is enabled by this consumer. Its deterministic verifier
tests are not evidence of an actual signed release, and adopted-policy, scanner,
publisher and hosted-producer qualification remain required.

Package smoke failures retain only bounded stage, command index, operation and
failure category at the coordinator boundary; subprocess output is withheld.
Do not launch canonical dependency installation through `npm exec --offline`:
it propagates cache-only mode into a newly isolated empty cache. The coordinator
still forbids implicit repacking and publishing during smoke qualification.

The prepared secrets release producer now requires a fresh, complete issued scan
started after candidate creation, with its run/attempt bound before execution.
It reloads detector and disposition authority from the exact selected `main`
commit, requires both current-tree and complete declared-history assessment, and
rejects unresolved detections, confirmed exposures, missing verification evidence
or policy diagnostics. The release consumer rechecks source, candidate/artifact
digests, adopted policy, time and attempt; it cannot substitute PR maintenance
admission or relabel an earlier scan. Real nonfunctional fixture scans qualify
this local data path; protected-main/publisher authentication and whole-release
producer integration remain separate, unqualified dependencies.

Scoped publisher identity must be proven before tag restrictions are activated.
Tag creation authority must not permit tag movement/deletion. Future immutable
GitHub Releases need complete draft assets before publication; historic mutable
releases are not retroactively immutable. Partial publication must be reported
and repaired forward, not by unpublishing or moving tags.

The local tag design uses two independent `v*` rulesets: only the future verified
repository-scoped publisher may bypass **creation**, while update/deletion have
no bypass, including for that creator. The shared Actions App is not accepted as
a qualified publisher. The release workflow coordinates tag creation, draft
assembly and publication explicitly in one run; it does not rely on a
`GITHUB_TOKEN` tag push triggering another workflow. Repeated coordinator phases
must verify existing exact identities rather than create duplicate tags/releases
or republish npm bytes. These design and simulated-transport checks do not
establish live actor authority or activate any rule.

Draft assembly now requires a canonical `SHA256SUMS` asset covering every other
explicitly registered asset; omitted, substituted, case-aliased or additional
bytes invalidate it. The prepared native REST adapter keeps draft creation
separate from publication and accepts only exact binary asset uploads, never
overwrite/delete repair. Complete paginated asset metadata, server digests and
an independently resolved tag commit are required for readback. A release's
`target_commitish` branch label is not commit proof; title and notes remain
editable. The September 21 read-only observation of `v0.12.3` still reported
`immutable: false`, no assets and `target_commitish: develop`; it was not altered.
These parsers/request builders and fake-transport phase tests prepare the future
integration, not authenticate a publisher or install a live write transport.
Actual API permissions, immutable-state enforcement and the complete qualified
SBOM/provenance/security asset set remain separate release prerequisites.

Hosted settings, public test refs, CI/scanner dispatches, credential actions,
signing, publication and cloud operations require their separately scoped
authority. Local implementation and mock tests do not provide it. Preserve
existing protection during migration; drift or failed readback stops further
changes. Recovery needs narrow explicit authorization, not automatic rollback
or a permanent bypass.

The local migration foundation can compare exact registered before/after
snapshots and exercise ordered conditional writes/readback against an in-memory
transport only. Simulation consent binds the complete source, proposal, registry
and payload digests; drift invalidates it. Partial-failure records distinguish
acknowledged, verified, uncertain and unattempted effects, with no rollback or
control deletion. The endpoint-validated settings preview now feeds this existing
planner with exact before-state and validated Actions/bodyless immutable-release
payloads. Drift, missing observations, stale snapshots and changed payloads fail
before simulation; immutable enablement preserves owner-enforcement readback.
Switching Actions from `all` or `local_only` to `selected` remains blocked pending
an independently qualified transition and new allowlist readback, rather than
inventing the unavailable allowlist or an API ordering guarantee.
This does not prove GitHub supports an atomic conditional write. The production entry always
rejects; authenticated readback, endpoint-specific preservation/capability checks,
merged-source identities and separately authorized effects are still required.
Task 10.4 remains incomplete until those real adapter dependencies exist.

## Future native-distribution interface

The separately authorized native-modernization change owns bundle construction,
installers/updaters, platform support and signing/notarization. Source hardening
owns the common qualification and publisher boundary. Before integration, the
native owner must supply:

- Exact source/workflow/build identities and per-platform/architecture artifact
  digests, with an explicit expected asset list.
- A bundled-component inventory and SBOM identifying embedded runtimes and
  libraries, not just the CLI's source dependencies.
- Current component-vulnerability assessment, tool/database identities and
  exact applicable exception or secrets-remediation evidence.
- Verifiable build provenance and distinct signing/notarization results where
  required by each target platform.

Those inputs must qualify the actual bundle bytes. Do not manufacture a
container scan for an executable or treat an attestation as vulnerability
assessment. The npm publisher, install contract and canonical verification stay
in place until a separate approved distribution change replaces them. If native
work lands first, reconcile the merged contracts before modifying release code;
do not restore the former unmerged candidate.

Sensitive conduct reports use the separately owner-approved route in the
[Code of Conduct](../CODE_OF_CONDUCT.md), not vulnerability intake or ordinary
public support. Contact publication does not authorize hosted security changes.
