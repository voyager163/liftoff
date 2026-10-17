# Repository governance and deterministic setup

Repository governance is enabled by default through the
`single-maintainer-gitflow` profile. `--governance team-gitflow` selects the
local team handoff, while `--governance none` opts out. Single-maintainer uses
automated checks with zero additional human approvals; team requires one current
independent human pull request approval. Neither profile adds deployment
reviewers. Initialization writes local managed-core artifacts only. It does not
run an agent, mutate Git, contact GitHub or Azure, configure rulesets, provision
runners, deploy, or start monitoring.

Primary path after initialization:

```text
liftoff init my-project
cd my-project
/liftoff-setup
```

The native setup integration uses the deterministic Liftoff governance engine to
complete the workflow-specific local bootstrap and reviewed repairs, then
coordinates separately authorized publication, cloud deployment, qualification,
and enforcement. Codex invokes its native setup skill through the skill picker
or `$skill-name`; it does not receive a fabricated slash-command adapter.
The user-owned activation state records
execution, not an agent's claim of completion.

**Independent milestones:** local readiness does not imply publication or
deployment. Explicit local-only use and declining a later approval remain
supported. Activation requires real source-matching provider evidence;
unsupported account capabilities, unverified private access, and incomplete
observations remain explicit blockers. Retained-state disposal is separate
lifecycle work, not a 30-day delay before initial activation can complete.

### Private workflow publication and context-proof source

TASK14.3's private `workflow-publication.ts`, `workflow-execution-ref.ts`,
`workflow-runner-admission.ts`, `workflow-context-proof.ts` and
`workflow-requirements.ts` provide bounded literal Git/GitHub source interfaces.
They are not a public activation command or evidence that a repository is ready.
The legacy ungated local workflow write is not permission to commit, push,
create execution refs, admit workflows, or dispatch checks. Current v8 public
activation remains inspection-only; unsupported plans remain blocked.

The private `workflow-source5-prerequisites.ts` selector derives its dependency
alternatives, applicability, approval gate, invalidation inputs and provider
obligations from the exact constructed current5 graph. It retains the original
saved-plan, evidence-header/body and approval commitments and exact namespace
paths/raw digests from the validated installed record closure. Multiple original
saved records sharing one semantic plan authority remain separate references,
not an arbitrary first match. Its immutable output is explicitly `not-observed`
and `not-authorized`: it is a reference inventory, not a prerequisite session,
fresh producer observation or permission to execute.

The separate private `observeSource5WorkflowPrerequisites` reads the real installed
closure before and after selecting those references. It accepts no installed DTO,
reader callback, host/peer proof bag or caller currentness timestamps. Dependency
alternatives and provider obligations stay graph-selected; accepted stored
approval/outcome formats still require their own current producer reader.
Unavailable readers and Azure completion peers remain explicit blockers, and no
prerequisite session is issued. This private observation is not yet wired into
public review or approval/apply routing and does not qualify a native host.

The private `observeWorkflowContextProviderProof` can independently reread a
retained run's source, immutable execution admission, jobs, checks and actual
validator cause without requiring an already issued effect. It accepts only a
closed retained reference and an original first-party read-only observation
runtime. Runtime or transport substitution and expiry invalidate that runtime;
the reader neither creates a new time budget nor renews the original dispatch
window. The exact GitHub Actions application lookup is a bounded GET-only route,
not general application access.

These are provider facts, not proof of original plan ownership or release-owned
context semantics. The returned prerequisite session is always null and execution
is explicitly not authorized. Historical terminal metadata remains readable
without acquiring fresh qualification. The original authoritative reader still
requires its original plan and current source5 carrier before and after readback;
the new reader cannot dispatch, journal, issue approval or finalize a phase.
It retains the existing independently observed operator classic-OAuth admission;
automation `GITHUB_TOKEN` and other unsupported credential modes are not inferred
or substituted. Isolated HTTP fixture outcomes are not real hosted green/red,
native-host, Azure-peer or four-family qualification.

The packaged source entry `dist/workflow-context-validator.js` supplies finite
real validator bodies for source integrity, backend tests, worker tests, frontend
builds and framework source. It accepts only `--validator <subject> --source-sha
<full-commit>` and reuses the existing current5 source/input interpretation and
literal commands. Selected source membership, bytes and executable modes must
match the actual Git commit before execution and remain unchanged afterward;
deleted, untracked, excluded-but-committed or modified component inputs cannot
become a successful exact-source result. Omitted or uninterpretable validators
block instead of passing vacuously. Infrastructure, security-report,
artifact/release and deployment verification bodies are not supplied by this
entry yet and cannot be substituted with its test/build results.

Backend fixture controls execute both actual Node and Go test commands. Genuine
committed application regressions fail their unchanged behavioral tests, rather
than an injected exit or replacement test. These isolated controls do not
qualify a runtime/release subject or any protected-ref proof.

The separate private `executeWorkflowActionReferenceValidator` body checks actual
committed workflow source, local reusable workflows and recursively referenced
local-action metadata with the existing immutable-action policy. Declared local
Node main/pre/post entrypoint files are also bound to the exact committed regular
single-link bytes/modes, without executing or analyzing their code. Untracked,
missing, changed or unsafe entrypoints cannot qualify as committed action source.
Both actual `action.yml` and `action.yaml` candidate paths are safely observed
before interpretation and reobserved at completion. Their actual membership
must equal the single committed metadata file; an untracked higher-priority
shadow, alternate metadata, link or unsafe alias is not ignored. Declared Docker
image references use that same policy; local Dockerfile interpretation remains
blocked. It checks complete workflow membership and
regular single-link bytes/modes before and after observation, rejects cycles,
dynamic references and missing metadata, and performs no project or workflow
execution. An official SLSA tag remains blocked without an independently current
scoped exception reader; copied approvals cannot authorize it. This private body
has no public CLI selector or currentness/phase authority and does not attest
remote action authenticity or analyze arbitrary action code. Its local-action
negative controls are source tests, not approved four-family proof subjects.

Exact-commit source reads disable local Git replacement objects. A replacement
must not redefine the immutable commit whose selected inputs are being checked.

The private `executeWorkflowComposeConfigValidator` subcheck uses the actual
selected `compose-config` command and captured source closure. It reuses the
existing independent CLI/plugin observer, executes the exact supported Compose
plugin with the selected `config -q` arguments, and reobserves its program files.
Execution uses the same bounded runner, stripped
environment and identity-checked owned HOME as the five public validators.
Docker configuration is private and the daemon address names a nonexistent owned
socket. Dotenv input is disabled and only the selected Compose file is used;
no container build/start or backend initialization is authorized. This is a real
runner operation, not plan-time metadata or a sandbox. It is only configuration
validation: OpenTofu formatting, locked provider/module initialization and
validation, native-host qualification and infrastructure phase proof remain
separate and unavailable through this subcheck. There is no public
`compose-config` selector. Independent program observations are not qualified
native-host authority; unavailable or changed installed tools never fall back
to operator Docker configuration or a caller-supplied successful observation.
For system-installed Linux Docker, plugin observation uses Docker29.8.2's finite
system directory precedence: `/usr/local/lib`, `/usr/local/libexec`, `/usr/lib`,
then `/usr/libexec`, each under `docker/cli-plugins`. Existing independently
observed private installation prefixes remain separate from system discovery.
The first candidate found by Docker's follow-link existence stat must itself
pass native-file, version and settlement checks. An initially dangling link is
absent under that stat, but failures after a successful stat, including capture
disappearance, are never treated as absence or replaced by a lower-priority plugin.
Consumption rechecks both the program files and the selected plugin, including
the appearance of a new higher-priority candidate. No user Docker configuration,
caller plugin directory or host installation is admitted.

The private component formatter retains the isolated HCL parser's exact qualified
runtime tuple. Its five real execution/source-drift/program-drift controls must
run on qualified darwin/arm64 Node24.21.0; elsewhere they are explicitly named
unrun cases, not successful formatting. An always-run capability control observes
the actual refusal and verifies that no formatter command or phase proof was
substituted. Linux Docker configuration does not qualify Linux HCL interpretation.
The Terraform module-closure refusal control also requires that unchanged qualified
tuple: its original body must execute there and is explicitly unrun elsewhere.
A separate always-run control observes the actual input-capability refusal before
Checkov, with no scanner invocation, workload command or phase proof. It does not
claim that Checkov inspected or rejected a module on an unsupported runtime.

Settled immutable Git reads preserve the actual invocation environment, including
executable discovery, before clearing inherited Git overrides and applying the
same neutral configuration as metadata reads. Call-through inventory controls
retain complete NUL-delimited output and settlement checks; local observation
does not qualify Windows execution or a current5 native tool subject.

Private `observeSource5WorkflowRequirementSource` reads the complete immutable
ruleset source using the original current5 context and read-only observation
runtime. File/digest references are selectors: the actual commit/tree inventory
must match completely, including tag-rule files, without unsupported nested,
symlink or executable members. It reuses the matrix's same source reader and
retains actual full context names and integration IDs on all four families;
unknown names never disappear or become semantic mappings. The original runtime
and absolute deadline are rechecked across reads, without project execution or
new observation budgets. Its descriptive result explicitly does not validate
the original plan, current branch heads or required-context semantics and has no
prerequisite session or execution authority. Neither copied data nor the source
reader's namespace is a qualified native/Azure producer or executable recipe.
This private source-composition input is not wired into public review or effects.

Private `observeSource5WorkflowRecipeInputs` additionally reads one selected
family's actual immutable workflow, checks ordinary committed file membership
and byte identity, and reobserves its exact protected ref before returning.
Its complete real job/context names must equal that family's complete required
source inventory, retaining each integration ID. It reuses the existing proof
workflow structural checks; missing, extra, renamed, conditional or fail-open
jobs cannot become an executable recipe. Other families remain present in the
source inventory, not silently qualified by this one-family observation.

The finite syntax recognizer shares the unchanged five public validator
selectors. It accepts only their literal local CLI invocation with the exact
shell and cleared Node environment; arbitrary commands, echo/forced exits and
private selectors are not registered bodies. Syntax is not immutable executable
provenance: a project-owned `node_modules` path, pinned checkout reference,
workflow permissions or matching job name does not qualify the package, setup,
toolchain, native host or context semantics. Every literal context therefore
retains an explicit missing release-owned semantic/executable-subject blocker;
unrecognized bodies have an additional blocker. The descriptive result is
always blocked, with no qualified executable recipe, prerequisite session or
execution authority. It cannot be submitted back as authority, runs no project
commands and preserves the original read-only runtime/deadline. It is private
compiler-input plumbing, not the completed semantic compiler or installed
review/approval/apply composition, and changes no public help or JSON contract.

Private `declareSource5WorkflowSources` owns one finite intended semantic
declaration for future paired workflow/ruleset sources. Its fourteen proposed
full job/check identities are not the observed required inventory, an approved
integration mapping or completed executable recipes. It accepts only the
constructed current5 context and preserves that graph's exact single-maintainer
zero-human-review or team one-current-independent-human-review policy.
Every intended recipe has specific missing program, actual integration,
complete-job, runner/action/tool, genuine negative-source and semantic-evidence
obligations. Approved current5 release subjects and actual integration subjects
are unavailable: the result is explicitly blocked, with **no publication
sources or effects**, no complete jobs, no guessed integration IDs and no
prerequisite/session authority. There are no placeholder workflows or rulesets,
and an older published package or development build cannot fill the release
slot. Actual arbitrary names/integration IDs, including `__proto__`, remain in
the independent source reader; a CodeQL-named backend-test job stays blocked.
This private refusal boundary is not completion of rendering, independent
whole-body semantic compilation, the issuer, installed orchestration or14.3.
The existing publication paths, exact per-file approval/readback and public
review/effect, protected journal and joint-finalization boundaries are unchanged.

The first-party `distribution/native/native-program-assembly.mjs` private
`buildNativeProgram` API retains the actual
original npm archive bytes from its own build/pack/install invocation behind an
opaque process-local reference. `readNativeProgramAssembly` accepts only that
original reference and rechecks the original source, tool/runtime-archive
references and complete installed output, including physical identities, before
returning an independent copy of the archive and observed manifest, plus its
internally derived installed application root and CLI entrypoint. Copied or
serialized references and caller-supplied receipts cannot recreate the reader.
This is a local assembly relationship, not release authentication, atomic
filesystem custody, native qualification or workflow authority. Its installed
reader has no dependency on repository-only build scripts; only creation needs
the original first-party build checkout and tooling. An independently installed
copy does not share another module instance's private references. The existing
`buildNativeBundle` CLI/API is unchanged. The unpublished candidate uses actual
consistent `0.13.0-dev.0` package/lock identities; older `0.12.3` bytes cannot
authenticate it. This prerelease is not eligible for ordinary stable-channel
upgrade: its installed smoke checks refusal before manager observations, not
the stable release's current-version and foreign-registry cases. The Source
constructor, workflow runtime integration and TASK14.3 qualification remain
separate implementation requirements; this API does not enable them by itself.

The private Source program-content constructor accepts only constructed
context/runtime references and that original assembly reference. Construction
and consumption freshly revalidate the original archive, source/output relation,
actual package/lock version and complete installed membership, bytes, modes,
links and physical identities through the original first-party reader. Actual
installed assets must also pass the existing compiled current5 source-family
registry; a matching version string is insufficient. Its own process-local token cannot be copied,
serialized or replaced by a returned readback. Archive reads return independent
bytes and only producer-derived CLI, validator and bundled-runtime references.
This observes genuine candidate content, not release publication, semantic-job
qualification, prerequisite/session authority or approval to execute workloads.
Focused input-boundary controls do not replace the explicitly named real
build/pack/install cases: those require the actual pinned runtime archive and
first-party build tooling, plus the real launcher on Windows.

`declareSource5WorkflowProgramSources` consumes that original token through the
fresh first-party reader and binds its complete program/archive/source digests
into the intended source declaration. It resolves only the current5-program
obligation; unpublished genuine candidate content does not need a fabricated
public release. Delivery, complete jobs, integrations, tool/runner admission,
controlled-red subjects and current prerequisite/session authority remain
separate requirements. A copied declaration or returned program metadata cannot
replace the original token, and changed installed content refuses before any
declaration is issued.

Private `observeSource5WorkflowDependencyReview` reads the actual GitHub
dependency diff for exact repository/base/head commit/tree selectors through
the original read-only runtime. It verifies a bounded complete ancestor-to-head
comparison, joins all bounded diff pages and repeats the complete inventory.
Snapshot warnings, missing vulnerability metadata, duplicate changes/advisories,
unsupported severities, provider errors or observation drift refuse a verdict;
there is no warning retry, threshold override or status/check publication.
Known advisories on added dependencies are counted at every severity and scope;
removed dependencies are not treated as introduced vulnerabilities. Raw package
and advisory payloads are withheld. An empty or clear diff means only that the
provider diff reported no added known vulnerabilities: it is not full SCA,
license evaluation, a fresh scan, current protected-ref qualification, a
semantic context mapping or a prerequisite session. This private provider body
does not admit either operator OAuth or automation tokens, execute project code,
or change public review/effect routing, JSON/help, recipes or phase authority.

Private `observeSource5WorkflowCodeScanning` independently reads the exact
repository, protected-family ref and immutable commit/tree before and after
two complete bounded code-scanning analysis inventories. It does not filter
by a proposed CodeQL tool name/GUID or drop unknown tools, older commits or
zero-rule analyses. Every record remains represented by its ID, exact metadata
digest and actual counters; uploader keys, environment, category, tool metadata
and diagnostic contents are withheld behind digests/explicit flags. Documented
empty metadata strings and absent optional tool fields stay distinct and are
not replaced with invented subjects. Source
matches are descriptive, not currentness/session authority. Malformed, duplicate,
foreign, truncated, changed or inaccessible responses refuse rather than become
empty successful scans. The result is always blocked: empty/historical
inventories, source-analysis diagnostics and missing authenticated program,
query/language coverage and original-report subjects have explicit reasons.
The existing GitHub read transport fixes its JSON media type; this observer
does not silently widen it to SARIF. GitHub's custom SARIF response is itself
only a subset of uploaded data, not authenticated original publisher/program
provenance. Positive rule counts, zero results or a `CodeQL` label therefore
qualify neither CodeQL nor a required context. No scan/upload/Autofix operation,
public selector, declaration source, accepted integration mapping or phase
authority is issued by this private metadata reader.

Private `observeSource5WorkflowSecretProtectionHistory` reads the platform's
actual latest-scan metadata twice, with the same independent repository,
protected-ref and commit/tree readback. The shared reference guard preserves
the code-scanning reader's original admission and before/after ordering.
All five documented scan buckets, custom-pattern records and unknown fields
remain represented; absent buckets, actual empty arrays and explicit null
timestamps are distinct. Pattern details and unsupported fields are withheld
behind digests. Custom-pattern envelopes are opaque objects, not assumed to
share the ordinary scan-record fields. Malformed, oversized, inaccessible or
changed responses refuse.
This endpoint exposes latest scan types/statuses/timestamps, not a commit
selector, original source-bound report or complete detector inventory.
A completed label, recent timestamp, successful endpoint access, enabled flag
or empty bucket therefore yields no clean-scan or licensing verdict. The reader
always blocks pending authenticated exact-source scan/coverage subjects and a
platform-supported explicitly approved non-credential negative control.
It retrieves no alert secrets or locations, performs no scans/bypasses/writes,
admits no substitute scanner, and issues no declaration source, integration
mapping, currentness/session authority or phase proof.

Private `executeWorkflowTofuComponentFormatValidator(projectRoot, sourceSha,
component)` validates one actual selected OpenTofu component. It reuses the
captured-file formatter policy: only explicit present `.tf` paths are passed,
with `fmt -check -write=false`, never implicit recursion. The actual independently
observed executable is rechecked around the settled child; its configuration,
data directory and HOME are private, and inherited CLI flags cannot enable writes.
Every selected component still needs its own subcheck, and the existing selected
input checks must remain planned: a blocked recursive scope containing excluded
inputs is not silently converted into an approved closed formatting scope.
No module/provider initialization, backend, planning, apply, infrastructure
completion or native-host qualification is supplied. Tool admission retains the
existing 1.12 release line and minimum 1.12.6; that compatibility observation is
not separately pinned native-host qualification. The subcheck has no public
selector; its private report retains the existing shape and explicitly issues
no phase proof.

Private `executeWorkflowCheckovComponentValidator(projectRoot, sourceSha,
component)` runs the actual Checkov Terraform policies against the same finite,
explicit captured `.tf` scope. It rechecks committed inputs after both policy
success and policy failure. Module references and function expressions are
conservatively refused until their actual input/evaluation closure is qualified;
this lexical refusal also rejects comment/string lookalikes and is not a second
Terraform parser. Nonempty, ordinary in-scope findings must agree with the real
process exit and resource/check counts; skipped or suppressed checks,
parse failures, empty coverage, soft-fail disagreement and incomplete output
block qualification rather than becoming a green or controlled-red result.
The existing thirteen-key private report and five public selectors are unchanged.

Private `executeWorkflowCheckovDockerfileValidator(projectRoot, sourceSha,
component)` analyzes only the actual bound `backend`, `frontend` or
`function-worker` component's committed `Dockerfile`. An absent/unselected file,
uncommitted input or unsafe source membership refuses before scanning. The
finite `dockerfile` framework does not enable the separate `sca_image` image
referencer: this body never builds, pulls, publishes or vulnerability-scans an
image, and it does not execute Dockerfile instructions or infer image provenance.
The same bounded program inventory, original deadline, private HOME and final
source/Git readback apply. Dockerfile coverage counts actual checked files, not
instruction findings; repeated instructions have distinct source-span identities,
while duplicate findings, omitted files, suppression and empty coverage refuse.
This private body is not a public selector or a complete container qualification.

Private `executeWorkflowCheckovWorkflowValidator(projectRoot, sourceSha)`
analyzes the complete actual top-level committed `.github/workflows/*.yml` and
`*.yaml` inventory. Missing, untracked, nested, linked, executable or changed
workflow inputs refuse; exact regular-file bytes/modes/membership are read
before and after the settled scanner, within its original cutoff. This is
workflow-file analysis only: it never executes workflow steps, resolves/downloads
actions or reusable workflows, publishes a report, or qualifies their referenced
code. Action-reference closure and complete context semantics remain separate.
The supported Checkov Actions runner leaves `resource_count` at zero even with
real findings; no positive resource count is invented. Every selected workflow
must instead have actual nonempty findings, with consistent counts/exit status
and bounded framework-specific resource/span identities. The exact `[0,1]`
synthetic trigger span is accepted only for the runner's `CKV_GHA_7` trigger
record; zero source lines remain invalid for other findings and frameworks.
Changing a workflow file to demonstrate an actual finding is development
scanner evidence, not an admissible current5 controlled-red source. The public
five selectors, private thirteen-key report and blocked declaration are unchanged.

The implemented development compatibility profile is Checkov 3.3.20 in an
isolated POSIX Python 3.14 virtual environment, not a released/supported-stack
or native-host admission. A fixed `-I -S -B` bootstrap imports explicit observed
roots; no shell trampoline, executable `.pth` hook, user site, project Python
path or operator Checkov configuration is executed. The bounded selected import
roots, standard-library files, launcher, interpreter-bin membership, declared file-link targets
and virtual-environment configuration are observed before and after scanning.
Declared import roots under a traversal-skipped `site-packages` directory are
inventoried independently, including their package bytes and membership. Only
roots actually covered by an ancestor traversal are elided; an undeclared global
site directory remains excluded by the isolated bootstrap.
Unsupported path hooks, directory links or outside-prefix file links refuse;
there is no automatic installation or fallback to a different program.
This observed import inventory is not native linked-library closure, an approved
immutable release/tool subject or execution confinement. Downloads, external
module downloads and result uploads are disabled in the scanner invocation;
its HOME, cache, temporary files and configuration are private. One absolute
180-second preparation/execution cutoff is retained across observations.

The real local verification is separate from Vitest's unchanged 30-second cases
and skips: after a build, run `node scripts/verify-workflow-checkov.mjs` with the
isolated scanner prefix on invocation-only `PATH`. Its dependency declaration is
`tests/fixtures/workflow-checkov-requirements.txt`; restore it only into a
separately owned unseeded `python3.14 -m venv --without-pip` environment, with a
stripped environment, private HOME/XDG/cache and `uv pip install --no-config --no-cache --link-mode copy
--only-binary :all: --index-url https://pypi.org/simple --python <owned-python>
--requirement tests/fixtures/workflow-checkov-requirements.txt`.
The verifier installs nothing. It builds actual current5 fixtures and checks
restricted SSH ingress, genuine public-SSH failure, suppression/empty refusal,
post-child source drift and owned-HOME replacement, without changing policy or
inventing child results. It also analyzes genuine backend/frontend/selected-worker
Dockerfiles, root-user failure, repeated `RUN` instructions, suppression/empty
refusal, source drift and HOME replacement. `RUN` text is analyzed, never executed.
These are local component cases, not hosted protected-ref
green/red, full IaC/Dockerfile/Actions Checkov coverage, approved recipe,
prerequisite session, license/SCA, native-host or phase qualification.

These are explicit runner operations, never operations performed by plan or
`--live` review. Tests, builds and framework tools may execute project code and
write outputs; provider-read-only workflow permissions do not make them a host
or network sandbox. Their child environment omits inherited credentials and
uses an owned temporary tool home, which is removed only after original process
settlement. Unsettled execution or failed cleanup retains its directory and
refuses success. Reports withhold raw project output and issue no phase,
provider, native-host, release or green/red matrix qualification. The source
entry being present in a development npm pack is not a qualified published
current5 recipe/tool subject or an automation `GITHUB_TOKEN` admission.

Required proof jobs are independent. Each has exactly one named executable
validator as its final ordinary step; trailing steps, duplicated validator names
and required-job dependencies are refused before dispatch.
Required context names and integration IDs remain literal own data, including
names that match inherited JavaScript properties. Ref scopes recognize only the
four declared GitFlow patterns; inherited object properties are not ref families.

Cleanup captures the allocated HOME's directory and ancestor creation identities
before project execution and rechecks them after settlement. A missing, renamed,
linked or replaced boundary blocks cleanup without deleting its replacement.
The retained original pathname is diagnostic, not a claim that the moved
allocation can still be located there or that cleanup succeeded.

Publication binds one existing `ci/liftoff-workflows-*` review branch, one actual
parent commit and exact regular per-file before/after byte digests. It commits
only that inventory, never consumes unrelated developer-staged changes, never
directly pushes protected branches, and independently reads the resulting
commit/tree, ref and immutable file bytes. A source-review publication is not a
protected-branch merge. Artifact production still requires its own immutable
recipe readback after the separately authorized merge.

GitHub documents workflow dispatch refs as branches or tags, not an immutable
SHA fallback. A mutable branch precheck and an original workflow's SHA guard
cannot prevent a replacement recipe from executing earlier effects. Dispatch
therefore requires a separately approved `liftoff-execution-<full-commit-SHA>`
tag and independently read active repository tag update/deletion protection
with no bypass. Blocking all updates also blocks non-fast-forward changes; no
unsupported extra tag rule is invented. A commit-named tag without that barrier is insufficient.
The producer never installs or weakens protection. Exact private runner-group
workflow admission preserves the repository-only assignment and existing
workflow entries; it does not provision or broaden access.

The neutral `workflow-runner-admission-observation.ts` module exposes that same
binding validator and existing assignment/grant readback without importing the
writer runtime. Its GET-only reader returns the actual selected workflows,
including an unchanged before-set; callers must still compare the approved
after-set. It issues no host qualification, prerequisite session or permission
to patch runner access. The writer reuses this reader and retains its original
intent, authority, no-repeat and after-set checks.

Current provider permission admission is deliberately narrow: independently
observed classic OAuth `repo`/`workflow` grants and actual repository push access.
Fine-grained, installation and workflow-token grants are not inferred from a
repository role or caller annotation; unsupported credentials block before
dispatch. Current barrier/provider admission is bound separately from the source
tag and protected context. Administrator or policy changes are a separate trust
boundary: repeated observations do not promise absolute immutability or atomic
execution. Missing an independently qualified existing barrier/group during the
early bootstrap phase is a prerequisite blocker, not permission to create one
early, add a dependency cycle, or undermine rulesets-last sequencing.
Inherited/organization rule admission remains unsupported by this narrow
repository producer and blocks rather than silently omitting inherited policy.
Runner-group PATCH additionally requires observed classic `admin:org` scope,
active administrator membership and a non-inherited writable selected group.
Group/network identity readback is not runner or private-network qualification.
The future current5 engine bridge must independently admit the existing qualified
group/host; this source interface cannot manufacture TASK14.2 evidence.

The engine must durably record original dispatch intent before POST and the
actual accepted workflow/run ID before further observation. Uncertain acceptance,
invisible runs, ambiguous runs and missing original authority never cause an
automatic repeat dispatch. Explicit dispatch handles `GITHUB_TOKEN`-suppressed
push triggers; inferred push-triggered success does not qualify.
The pinned REST API2026-03-10 returns HTTP200 with `workflow_run_id`, `run_url`
and `html_url`; all three must identify the exact approved repository. The accepted
handle is checkpointed before metadata polling. Legacy empty HTTP204 is
read-only discovery of the original intent, never permission to POST again.
Actual terminal provider conclusions are durably retained before fallible job
inventory or final freshness reads. Unknown outcomes and missing later proof
stay blocked; source drift cannot relabel actual terminal provider truth.

Proof binds real workflow jobs to their own GitHub Actions check-run URLs,
application and check suite, complete SHA, immutable recipe, first attempt and
actual protected ref family. Green requires success, not skipped/neutral/
cancelled. Controlled red requires the unchanged recipe, one exact reviewed
nonsensitive source violation and failure of the real required validator, with
successful setup rather than an unrelated infrastructure failure.
Every proof job starts with a pinned checkout of `inputs.source_sha`, a clean
worktree and disabled credential persistence; extra unbound jobs cannot qualify.
The complete matrix shares one three-minute observation deadline, and restored
checkpoints preserve the original plan, dispatch time and actual accepted handle.
Provider and literal Git results received at or after their existing 30-second
operation limit or the shared deadline are refused even if a delayed timer has
not fired. Receipt-time refusal does not establish cancellation or drainage of
an underlying transport or undo an uncertain accepted effect.
Authority and intent preparation consume that same operation budget. An expired
operation cannot start its provider request or literal Git process, and Git
receives only the remaining budget rather than a restarted timeout. Actual
acceptance is retained before a later deadline refusal; the original attempt
cannot be repeated.
Waiting for asynchronous authority or intent preparation is itself bounded by
that original cutoff. A timed-out preparation cannot later start provider or
Git work. This does not cancel or settle a stalled authority read. Once a Git
runner has started, its original promise remains awaited rather than being
detached by the preparation timer; its native timeout and settlement contract
remain unchanged.
Red runs use their own protected execution tag derived from the exact healthy
protected commit; they do not move the protected branch to a failing commit.
Each red parent/ref must match its corresponding independently current green.
Every required context needs its own red proof on every applicable `develop`, `main`, `release/**`
and `hotfix/**` family. Independent current readback checks the complete committed
ruleset inventory; caller-selected contexts or old success annotations are not
enforcement permission. No status or check is written to fabricate proof.

These source interfaces do not qualify deployment, protected handover/custody,
an authorized native host, release promotion, ruleset enforcement or package
publication. Single-maintainer still means zero human PR reviews; team still
means one current independent human PR approval, not self/bot/stale approval.
No mandatory deployment reviewer is introduced. TASK14.3 remains incomplete
without separately authorized live source and green/red qualification.
The approved source5 allocation changes activation contract4 to5 and the six
source graphs only; state/evidence-header/approval4 and all other listed wire
versions are unchanged. Frozen releases, pre-custody source4 and custody source4
remain readable diagnostic/planning families. Source5 does not enable public
execution or automatic migration. The public/legacy executor now reports this
explicit workflow prerequisite blocker instead of silently returning no producer.

Content-only dependency updates keep retained factories on the current verified
Node/frontend template bytes. Exact original custody4 plugin and resolution
metadata is matched separately against frozen declarations and release metadata,
with the complete selected semantics checked before recognition. It is not a
registry containing old executable bytes, nor a new registry pretending to have
an old digest. Original custody4 identities remain custody4, not source5; their
readability grants no current telemetry, execution or phase authority.
Pre-assessment managed handoffs retain their captured bodies instead of gaining
new workflow guidance from a newer source family.

Dependency-induced governance fingerprints and plan digests have exact
before/after checks that recover the previous outputs by reverting only the
reviewed leaves. Earlier HCL/application histories and the frozen extraction
capture and harness remain unchanged.

Current v8 projects can inspect an exact workflow review through
`liftoff governance plan --scope activation --inputs <workflow-review.json> --json`.
The public JSON file must be a singly linked regular file no larger than 64 KiB.
Its closed fields are `schemaVersion: 1`, `kind: "review-workflow-source5"`,
`phaseId`, `executionId` (a new UUIDv4), `createdAt`, `expiresAt`, the explicit
activation `configuration`, `origin`, `remainingFrom` and the complete `effects`
array of `{ action, binding }` entries. Publication uses a null origin and
remainingFrom; later source-bound review retains the exact original publication
plan/proof/commit/tree references. No future SHA slots or implicit budget are
created. The review keeps the original graph dependencies and exact per-file
before/after bytes, repository, source, workflow and operation bindings.

This route is **read-only and blocked**, exits 2, and saves no preview, consent,
approval, ledger or project file. It reobserves the installed source and physical
file identities, preserves both actual observation times, and rejects drift.
It does not call tools or providers. A fingerprint identifies review values only,
not a stored approved plan. Modern workflow approve/apply-next remain unavailable
until independently current prerequisite producers are composed. Azure
staging/promotion/rollback peers cannot be replaced by GitHub job success;
applicable protected handover, custody and current qualified native-host proof
remain mandatory. Group/network/workflow assignment alone does not qualify a
host. Capability discovery and command help advertise this same restricted scope.

The deterministic review builder and whole-plan component runner are distinct
source interfaces. The runner uses the original sealed journal's complete ordered
inventory, accepts no caller subset/checkpoints/observation mode, validates all
bindings before the first component, and stops at a pending entry while reporting
the untouched remaining operation digests. A failed entry throws without starting
later entries or erasing earlier receipts. Individual current observations never
become whole-matrix or phase completion; the runner cannot issue approval,
finalize metadata or discharge independent prerequisite/peer obligations.

Whole-matrix observation reconstructs every observation-only carrier and original
proof from that same journal, not a caller-supplied carrier or proof list. It
requires every component to be complete before provider reads and independently
rechecks the complete four-family green/per-context-red matrix and immutable
ruleset source. Carrier preparation and provider reads share the original bounded
observation window. Independent original ledger and observation-carrier reads
settle together before returning; a refusal drains its siblings and preserves the
first observed error without starting provider readback. Every entry still
performs its original lease, installed-scope, issuance and ownership checks.
It performs no dispatch, replaces no original observation
timestamp or receipt, and cannot finalize a phase.
Cross-platform matrix fixtures run genuine syntax/JSON validators against owned
source files. File-backed validation does not certify native stdin transport.
Their refusals retain only the finite fixture selector, actual Node/platform/arch
and the original bounded result fields/stdout/stderr, not commands, ambient
environment or unrelated configuration. Diagnostics do not change the invocation,
input readback, settlement guards, five-second/4-KiB limits or expected outcomes;
a numeric Windows status is not an observed POSIX signal.
The owned validators retain only their isolated `HOME` and empty `NODE_OPTIONS`
on POSIX. On Windows they additionally copy the actual host `SystemRoot`, using
case-insensitive defined-key lookup; missing, empty or conflicting values refuse
before invocation. They do not forward ambient search paths, Node configuration
or unrelated environment values. Controlled-red syntax/JSON outcomes require
status1 and an actual `SyntaxError`, so a runtime initialization failure cannot
count as the reviewed source violation. Portable allowlist controls are not
native Windows qualification.
Missing-scanner fixtures preserve Git in their reduced search path: Windows uses
the directory of the actual resolved Git executable, not POSIX system directories.
They verify Git remains visible and the scanner launcher is absent before invoking
the validator, so a Git lookup failure cannot substitute for a scanner refusal.
The workload environment allowlist copies only actually enumerated keys, retaining
a defined `PATH` or `Path` without manufacturing duplicate aliases on case-insensitive
hosts. Missing-scanner fixtures likewise use only one defined Windows search-path key.
Portable worker/host models check actual workload options, native resolution and the
unchanged native environment encoder against real Go invocation. They do not establish
native Windows qualification.
A Windows-only native regression runs owned valid/invalid syntax and JSON files
with that same supported validator allowlist. Missing, empty or conflicting
`SystemRoot` refuses before the first runner call. Every actual command retains
literal file-backed arguments, its owned working directory, five-second/4-KiB
bounds, settlement checks and exact input readback. Green requires status0; red
requires status1 and `SyntaxError`. Only finite fixture/runtime/result fields are
logged, never environment values. Non-Windows hosts leave this case explicitly
unrun; portable controls do not qualify its native execution.
The former unsupported-minimal-environment comparison remains historical evidence,
including its CSPRNG assertion, timeout and separate `EBUSY` cleanup refusal.
Later supported-input success neither reclassifies those outcomes nor establishes
the original cleanup cause, original-matrix success or full native qualification.
Local-tool metadata workspaces use the actual Windows temporary directory rather
than a drive-relative POSIX `/tmp` assumption; macOS and Linux retain their existing
neutral parents. Physical identity, process settlement and owned cleanup checks
still apply before returning tool observations.
The three real Compose regression cases retain bounded failure diagnostics before
an unfinished suite can lose its final report: a finite case selector, actual
runtime, call-through counts, parsed metadata versions, and original process
status/settlement flags and output byte counts. They do not log executable paths,
arguments, environments, configuration or raw output. Unobserved flags remain
null; diagnostics issue no additional commands or native qualification.

The private source5 effect bridge uses a separate private control schema1 and the
closed `workflow-source5-{plan,approval,journal,operation,proof}` namespaces
outside the project and repository. Controls are canonical, project-bound,
HMAC-sealed objects; restart validates the exact original issuance, not imported
project approvals or structurally similar runtime objects. The private local
issuer and operating-system user remain a trust boundary, not an attestation of
a qualified host. A live engine-issued lease/capability is also required.
Issuance, restart and each capability assertion independently read the existing
installed current5 state under that lease. Its local repository anchor and state
digest, the canonical root and resolved project key must exactly match the
reviewed plan, checkpoint inventory and authority. Missing or changed state
blocks; callers cannot create an anchor or substitute a scope assertion.
Index, approval and operation objects are limited to64KiB; original plan/proof
objects to16MiB, counting the **complete encoded sealed disk object**. Existing
preview/consent stores keep their64KiB limit. Failed saves throw and preserve
unresolved progress; CAS refuses stale/concurrent replacement. These interfaces
do not register a producer, qualify a host, or open public execution.

The private ownership primitive seals the complete reviewed original plan before
issuance. Each workflow entry keeps a stable key derived from that original
plan, operation, current5 identity, phase, actual root, project key and existing
anchor. Remaining-only reviews retain that original entry rather than
renaming attempted work. A reservation is discoverable from the stable entry
and next generation: once durable, it immediately retires the previous owner,
including when the pointer CAS or its confirmation fails. The new owner needs
exact CAS readback and an immutable confirmation under the live native lease.
Missing, conflicting, malformed or outstanding ownership history blocks both
owners; no automatic takeover or compensation is implemented.

Only entries with no durable intent, progress, acceptance, terminal or component
record anywhere in their reviewed ancestry can transfer. Issuance, restoration
and first-intent checks validate ownership independently. First intent also
checks the actual raw installed snapshot, separately from the canonical modern
state digest. Later ownership-bound checkpoint persistence does not depend on
a new installed-state read, so a subsequent failure cannot erase original
acceptance or terminal truth.

Ownership has a fixed 64-transfer bound. Its sealed manifest lists all 131
concrete owner/confirmation/reservation/manifest keys, including itself, and
measures the complete encoded worst-case objects, revision and previous-digest
growth before ownership is established. This is a bounded ownership
**subinventory**, not qualification of the complete engine. The private journal
now separately seals a closed full metadata manifest: original plans, issuer
and authority, index, owner histories, every allowed progress/event key,
original publication read dependencies, recovery baseline and finalization.
It measures actual complete sealed worst-case bytes and revision/digest growth
before effects; its total encoded footprint is not a disk-space or qualified-host
attestation. Its concrete key cardinality is independently bounded to 21,994
(including itself), within the unchanged safe-record node budget and namespace
caps. Oversized or unrepresentable inventories block rather than widening
existing stores or hiding keys behind suffix/directory permissions.

Opening or initializing a journal requires its exact separately sealed original
review. Initialization never creates that plan or recreates missing history,
even when old authority and ownership records remain.
Observation rejects a missing control index before writing any ledger; it cannot
create partial metadata that blocks a later explicitly initialized fresh review.
The journal requires exact independently sealed publication A provenance before
a source-bound B review. Immutable intent/accepted/terminal/component receipts
survive failed cursor CAS or lost confirmation. Missing or changed index,
manifest, reservation or original read dependencies block; retained intent
cannot recreate a lost ledger. Completion requires canonical exact inventoried
plan/approval bytes, the original individual component receipts, modern evidence
validation and precisely the state derived from the original modern outcome.
Publication A alone cannot finalize. Finalized status also requires independent
exact-byte observation of every reserved project destination; there is no
cross-filesystem atomicity claim. These are source metadata/protocol guards,
not independently qualified live evidence producers or an execution engine.
Same-lease exact-byte completion is not restart reconciliation after partial
project writes. That narrow recovery remains an engine obligation; original
authority and ownership state checks are not relaxed.

Separately, the reviewed logical
mutation inventory counts every operation plus its nested effects, including
checkpoint and exact project-metadata writes, and cannot exceed 272. A
132-dispatch plan has 271 logical entries; that count is not evidence that its
sealed storage fits. Private effect carriers now share the held native lease's
stable ORIGINAL-entry gate with ownership preparation and first-intent writes.
An active branded gate can claim that entry only once; structural, expired or
foreign gates do not mint carriers. The runtime consumes each exact inventoried
file/Git/provider effect once after its durable original intent. Provider and
push acceptance are retained before fallible readback, and original commit
handles precede parent/inventory checks. Observation carriers cannot introduce
intent or perform writes; their reads still require current held-lease authority.
Intent consumption rechecks current issued, unexpired authority after asynchronous
inventory and ownership validation. Actual provider/Git submission rechecks it
again after intent consumption; each source-file mutation checks it before writing.
Expiry is re-evaluated after authority's asynchronous reads. These pre-effect
checks do not add fallible installed-state or time checks when retaining already
accepted/terminal truth.
These isolated source/process/HTTP guards are not complete engine or live
qualification. A private component driver now derives observation-only versus
first-effect mode from the original sealed entry, mints its own carrier, invokes
the exact indexed producer and retains its component internally. It captures
closed original runtime fields before asynchronous reads and rejects caller
checkpoint callbacks, accessors, prototype/symbol fields and observation modes.
Workflow
components require a separate current run/jobs/checks/source reread after terminal
observation. Restart preserves original proof bytes, IDs, dispatch time and plan;
a fresh observation is reported separately, never written over the original.
Read-only publication observation requires the already recorded commit handle
and rechecks its parent, exact inventory and immutable bytes. It never adopts a
target-shaped HEAD or repeats commit/push work. These isolated component guards
do not compose phase prerequisites or finalize a phase.
A private complete-matrix reader requires the exact original ordered green/red
component inventory and internally branded observation-only carriers from one
original journal and held native lease. The first entry's carrier cannot stand
in for another entry. It independently rereads every entry's actual
run/jobs/checks/source and verifies complete immutable ruleset files, all four
protected families, individual validator-caused reds and pinned integration
identities on both green and red members. Original issuance, ownership and
component chains are checked around readback; current observations cannot
overwrite original IDs, dispatch/observation times, plans or proof bytes.
Independent families may read concurrently, with separate per-entry authority
checks and one unchanged three-minute budget. Every started ruleset read promise
is awaited before its family refuses, preserving the exact first temporal
rejection and successful input ordering. Family read promises settle before
returning or refusing. This does not establish cancellation or drainage of
underlying transports after a bounded timeout race. There are no Git/provider/file writes, status
substitutions, new intent or terminal-bookkeeping capabilities in this path.
Isolated matrix tests seed original publication/dispatch ledger formats and use
bounded real Node validators to drive loopback responses. They are not actual
publisher-created commits, GitHub dispatches or live green/red qualification.
Full planner/prerequisite composition, final outcome persistence and engine
admission remain separate obligations.

Identity readers consume fresh frozen scalar identity projections rather than
unused full graph copies; full-contract readers retain their original deep
copies. After complete identity validation, record and metadata constructors
deep-copy and freeze only the selected registered full source row, using the
same readable-family ordering without a scope or authority cache. These static
copies contain no project or approval authority and do not replace any
independent current scope, ownership, or proof validation.

A separate private branded terminal-bookkeeping reader can inspect an already
sealed original finalization without any saves. It is not a journal, issued
authority, ownership object or effect carrier. Its descriptive ownership
inventory has no prepare/transfer/write methods; ordinary acquisition still
requires the actual original canonical and raw installed scope. Terminal
reconciliation requires retained original issuance, full original plan,
manifest/reservation, publication dependencies, ownership confirmations and
individual component chains. It independently reads exact target bytes and
installed source/history/custody relations. Expiry does not refresh approval or
authorize effects; a missing original issuance still refuses bookkeeping.
Reconciliation is a metadata mutation, not read-only inspection: only the
existing original revision-one active index may CAS to its reserved revision-two
canonical finalized projection. It rechecks retained inputs and target bytes
around CAS/readback, never creates a missing issuer/index, never rewrites project
files and never undoes accepted-but-unconfirmed ledger truth. An already
canonical finalized index is no-save readback. This isolated boundary is not
admission of the complete engine, public execution or native/live qualification.
Final-index reconciliation repeats held-native-lease, exact original-chain,
target-byte and active-index validation after staging and reading temporary
metadata, immediately before the atomic replacement. Loss before replacement
preserves the revision-one index; failures after accepted replacement still
retain the revision-two truth without compensation.
The private planner/engine remains unregistered and incomplete.
Staging/production workflow components cannot
finalize independent Azure peer obligations, and source5 controls cannot
authorize activation6.

## Managed files and user-owned state

Enabled governance adds managed-core files:

```text
.liftoff/governance/policy.md
.liftoff/governance/context.json
.liftoff/governance/README.md
.liftoff/governance/phase-graph.json
.liftoff/governance/compatibility.json
.liftoff/governance/credential-policy.schema.json
.github/prompts/liftoff-setup.prompt.md                # Copilot selected
.claude/commands/liftoff-setup.md                      # Claude selected
.agents/skills/liftoff-setup/SKILL.md                  # Codex selected
.github/prompts/liftoff-governance-assess.prompt.md    # Copilot selected
.claude/commands/liftoff-governance-assess.md           # Claude selected
.agents/skills/liftoff-governance-assess/SKILL.md       # Codex selected
```

Every selected agent also receives a separate managed repair integration,
including when governance is `none`:

```text
.github/prompts/liftoff-repair.prompt.md               # liftoff-repair-copilot
.claude/commands/liftoff-repair.md                     # liftoff-repair-claude
.agents/skills/liftoff-repair/SKILL.md                  # liftoff-repair-codex
```

Use `/liftoff-repair` in Copilot/Claude or `$liftoff-repair` in Codex. These are
equivalent native integrations, not shell aliases or setup/assessment replacements.
Repair-only generation does not create policy, setup, assessment, state or
evidence, and does not activate governance.

Older generated setup aliases are retired. Use `liftoff update --force` after
review to remove exact modified retired alias entries from older manifests; do
not invoke them as commands.

User-owned execution state is separate and is never advanced by
`liftoff update`:

```text
governance/activation-state.json
governance/approvals/
governance/evidence/
governance/credentials/preflight-policy.json
```

The complete policy is packaged at
[`assets/governance/single-maintainer-gitflow/policy.md`](../assets/governance/single-maintainer-gitflow/policy.md).
Current manifest-v8 single-maintainer generation uses policy version 7. Historical
activation-v7 projects retain policy version 6 until their separately reviewed
successor is published. Numbered policy sections are capability chapters, not
execution order. The managed phase graph is the sole execution-order authority.
Current team generation uses
[`assets/governance/team-gitflow/policy-v1.md`](../assets/governance/team-gitflow/policy-v1.md)
and remains a local handoff until separately authorized live activation exists.

## Read-only governance assessment

Current v8 manifests use the exact packaged assessment catalog for their recorded
profile and workflow. Single-maintainer policy 7 and team policy 1 remain
separate targets. Team review assessment accepts stronger controls such as two
approvals, code-owner review, or last-push approval; it never recommends weakening
them to the minimum. A current approval rule must cover each protected main,
develop, release and hotfix family; a rule for an unrelated branch cannot supply
that coverage. Uninterpretable scope or wildcard-family exclusions remain
not-observed rather than aligned. Historical activation proof remains
diagnostic-only and
cannot satisfy a different profile or current target identity.

Single-maintainer assessment requires pull request rule coverage for those same
protected families while retaining policy 7's zero-review requirement across
observed active branch rules. An unrelated zero-review rule cannot supply missing
coverage. Unknown family scope remains not-observed, and a required human review
remains a conflict, not permission to weaken an existing protection.

Live classic branch protection uses the selected assessment profile: required
approvals, code-owner review, and last-push approval remain conflicts for the
single-maintainer target but are not conflicts for the team target. Team minimum
review coverage is still evaluated across the scoped active rulesets; a classic
zero-review setting does not weaken an independently proven ruleset minimum.
Force-push, deletion, required-check, stale-review, and incomplete-metadata
checks remain unchanged. Assessment never rewrites the observed protection.

Declared and observed review counts must be nonnegative safe integers. Fractional,
negative, unsafe, or nonnumeric counts remain not-observed rather than satisfying
a review requirement or being treated as an interpretable policy conflict.
Malformed provider counts also produce a scoped invalid-response diagnostic.
Valid zero and stronger integer settings retain their selected-profile meaning.

`/liftoff-governance-assess` is separate from `/liftoff-setup`, which remains the
primary post-init path. Both OpenSpec and Spec Kit receive only their selected
agents' assessment integrations when governance is enabled. Initialization never
runs assessment. It needs no commit, push, activation, or cloud credentials:

```bash
liftoff governance assess --json
liftoff governance assess --governance team-gitflow --json
```

The optional `--governance` comparison is read-only. It does not change the
manifest, configuration, live rules, evidence, or recorded profile. Without the
flag, a supported Liftoff project uses its recorded profile; an ordinary Git
repository uses the installed single-maintainer target.

The whole-project assessment producer captures its requested comparison before
filesystem observation. Its scoped live reader retains the original root,
profile, declared environment inventory and clock across asynchronous reads, and
the coordinator snapshots its initial local report before collecting metadata.
Later caller mutations do not redirect reads or relabel the resulting report;
they are not reverted. Existing local, manifest and Git reobservations still
detect observed drift, not atomic confinement. This source-level input binding
does not add current-profile evaluators, activation proof, provider permissions
or mutation authority; unsupported mandatory observations remain partial.

The same CLI command works in an ordinary Git repository without initialization,
a manifest, or generated slash commands. An explicit path is authoritative;
otherwise the nearest applicable Git or Liftoff boundary is used, including
linked worktrees and unborn repositories. A malformed, unreadable, symlinked,
dangling, or retired inner manifest blocks fallback to an outer project or Git
repository. Assessment never installs agent wrappers into unrelated repositories.

For ordinary Git repositories the installed single-maintainer policy is the
displayed target, not a policy inferred from existing branches. Recorded Liftoff
identity stays nullable, and missing baseline, ownership, or evidence stays
`not-observed`. It is not the same as a valid Liftoff governance opt-out.

The pinned target is the **installed CLI** and its packaged policy, activation
identity, phase graph, and assessment control catalog, never registry latest.
The report compares four distinct layers: target, recorded project baseline,
declared project configuration, and observed enforcement. Each finding includes
expected and observed values, scope, provenance and capture metadata, impact,
and ownership-aware advisory remediation. Matching CLI versions or generated
hashes alone do not prove alignment.
The project policy version is shown when available. JSON observations may also
retain optional normalized `facts` alongside evaluator predicate values so a
predicate result does not hide observed configuration. Raw provider payloads are
not retained.

The default is **local-only with no network access** or registry lookup.
All assessment invocations, including `--live` and `--help`, skip telemetry and
disclosure entirely. Local Git reads inspect only repository root, HEAD, and
origin metadata, never `git status`, which can execute clean filters.
Applicable live proof stays unobserved. Only an explicit live-read request
allows the agent wrapper to substitute:

```bash
liftoff governance assess --live --json
```

Live mode performs bounded read-only GitHub/Azure metadata access with existing
permissions and verified repository/environment/resource bindings. Runner
organization metadata is limited to already-bound assignment IDs. Azure reads
do not guess a default subscription or search unrelated resources. Neither mode
enrolls credentials, expands permissions, registers providers, reads state blobs,
executes project code, runs scanners or infrastructure tools, or changes local
or remote configuration.
Azure scope and evidence-backed applicability require a current active-baseline
and referenced, validated saved-plan/evidence receipts. Current receipts bind
their canonical payload and live readback through `bodyDigest`; a header hash
alone cannot authorize changed runner IDs or Azure resources. Placeholder digests,
historical v1 receipts, future-dated approvals, and inferred bindings cannot establish proof. Missing
bindings remain `not-observed`. Do not fabricate or hand-edit activation state,
baselines, receipts, or evidence to manufacture alignment; use separately
approved setup or governance work to obtain trustworthy proof.

| Finding | Meaning |
| --- | --- |
| `aligned` | All required proof layers are available, fresh, and match the target |
| `outdated` | A recognized older baseline or recorded managed artifact differs from the target |
| `missing` | Complete authoritative observation proves an applicable requirement absent |
| `conflicting` | Known settings contradict the target, or declared and observed layers disagree |
| `approved-exception` | An exact, catalog-permitted, valid, unexpired approval covers the difference |
| `inapplicable` | Validated workload facts establish that the control does not apply |
| `not-observed` | Applicability or required proof is unknown, stale, denied, unsupported, or incomplete |

Coverage counts unknown applicability, unobserved live proof, and unsupported
evaluators explicitly. A local workflow declaration is not proof that its check
is enforced. Denied access, masked 404s, incomplete pagination, and timeouts are
not proof of absence. Single-maintainer expectations follow the canonical
zero-required-reviewer policy rather than generic peer-review advice.
Approved exceptions remain differences; free-form or expired claims cannot
waive controls or hide coverage gaps.

Collection failures do not erase independent facts. For example, denied GitHub
access cannot invalidate an unchanged local workflow, and a denied Azure resource
cannot hide a proven violation on another resource. Effective/classic/inherited
branch protection, release/hotfix check bindings, transitive required-job
dependencies, and complete runner restrictions are evaluated separately.
Rejected exception claims retain diagnostics instead of disappearing.
Required checks bind both their names and application identities. A passing
aggregator cannot hide a required scanner with `continue-on-error`; unresolved
reusable-workflow, matrix, or dynamic semantics stay unobserved. Runner checks
include repository/group restrictions, not only matching IDs or labels.

The catalog retains 30 controls across 17 families, including 10 unsupported
evaluators. Available evaluators are not completed proof; always-applicable
unsupported controls keep enabled assessments partial even with live access.

Human and schema-v1 JSON reports share `readOnly: true`, target and project
identities, findings, diagnostics, provenance, and coverage. Exit **0** means
fully observed `aligned` or explicitly disabled `not-applicable` governance
(not an alignment claim). Exit **2** means `partial` coverage or `differences`,
including approved exceptions. Exit **1** means `error`: invalid/unsafe input
or an invalid packaged catalog prevents a trustworthy report. Local-only runs
normally return partial coverage. Exit 2 is advisory, not proof that governance
is broken or permission to remediate.

Reports go to stdout only, never activation state or evidence. Assessment cannot
complete read-only Phase 0, satisfy an approval gate, or advance any phase. The wrapper
explains the CLI's classifications without inventing findings or executing
recommendations. Neither installing the integration nor running it activates,
updates, upgrades, or migrates the project.
For layout findings it may explain the separate native repair journey, but it
never invokes repair, inventories application source or authors a patch itself.

Older supported inventories without assessment entries remain readable. Use
`liftoff update --check`, then normal guarded `liftoff update` to install the
selected integrations. Unowned conflicting destinations remain unowned even with
`--force`; only already-managed modifications follow reviewed force rules.
Unsupported activation tuples can still receive safe identity and coverage
diagnostics, but no migration is available without an explicit supported mapping.
Force cannot bypass compatibility or overwrite project-owned configuration.
A future governance upgrade must reobserve facts and obtain its own reviewed
plan and approvals; an assessment report supplies no mutation authority.

## Reviewed governance-profile transitions

For a current manifest-v8 project, edit only the developer-owned
`governanceProfile` selection, then create the exact local transition plan:

```bash
liftoff update --check --json
liftoff update --approve-plan <fingerprint> --json
```

The check stores an expiring plan outside the repository and reports source and
target policy/activation identities, exact managed-core bytes, preserved
CODEOWNERS and local ruleset summaries, stronger controls, and the explicit
statement that old proof is not reusable for the target. Apply revalidates the
same configuration, bytes, modes, directory conditions, and plan before using
the dedicated profile-transition journal.

The transaction can change only inventoried local managed policy/integration
identity and the manifest. It preserves application files, Git history, workflow,
configuration, CODEOWNERS, existing stronger review controls, deployment
safeguards, activation state, evidence, approvals, and immutable history. Moving
to `none` removes source-only governance files from manifest ownership but leaves
their bytes on disk as preserved orphans. An existing
`governance/activation-state.json` blocks this transition until governance is
deactivated through its separately approved workflow. The profile transition
does not deactivate live GitHub or Azure enforcement.

`--force` cannot select, alter, or bypass this lane. Workflow changes route to
`liftoff workflow set`; same-workflow agent/plugin changes use an advertised
additive repair where applicable or remain explicitly unsupported. Recover only
the exact selected plan:

```bash
liftoff update --recover --approve-plan <saved-fingerprint> --json
```

In PowerShell, pass the fingerprint as one literal argument; do not wrap the
whole command in `Invoke-Expression` or reconstruct it from report prose.

## Separate native project repair

The selected repair integration first runs `liftoff repair --capabilities --json`
without project access. It checks repair contract 1, the required recipe/layout
identity, command modes and document schemas. The supported recipes are
`azure-local-layout` v1 and `application-layout-patch` v1; reports, previews,
new history and repair journals use schema 2. Missing capability support stops
the operation with `liftoff upgrade --check --json`, not direct project edits.
Upgrading the CLI is a separate decision. Require advertised `interactive-repair`
support before using the normal interactive journey. Repair identity does not change
the CLI package identity or activation 0.12.0 / manifest 7 / policy 6 / activation contract 3 /
graph 2 / state, evidence and approval 3 / compatibility 4.

The normal human entry point is `liftoff repair` in an interactive terminal.
Prompts require genuine input and stderr TTYs.
It displays the exact immutable plan before asking action-specific Yes/No,
default No. Explicit Yes authorizes only the displayed plan's internal fingerprint;
humans do not copy or enter approval or verification hashes. No/Ctrl-C/EOF
declines the current action without unapproved project writes. Generic `--yes`
and piped answers never grant authority. `--check` remains read-only;
JSON/nonTTY bare repair previews only, never prompts or hangs awaiting input.
Execution in JSON/nonTTY requires exact explicit execution flags and their
independent consent. Inputs changed during a prompt still refuse stale approval
after Yes and require fresh review, not an automatic retry.
When infrastructure repair needs authorized metadata discovery, retain
`--live --subscription <UUID>` in the interactive invocation; add `--check --json`
for a read-only metadata preview instead.

Application repair inventories the actual customized project and current target
artifact IDs with `liftoff repair --inspect-layout --json`. Review explicit
source mappings and affected imports/module paths, build/tests, Docker/Compose
contexts, scripts, CI and documentation. Unknown mappings or reference coverage
remain plan-only; a generated target is not permission to replace source with
a starter.

Author exact replacement bytes and a strict schema-1 patch document in external
staging, never in the real project. Run
`liftoff repair --application-patch <external-patch.json>` in an interactive
terminal for the normal human journey. The CLI shows the exact diff and
limitations; `--check --application-patch <external-patch.json> --json` is the
optional read-only preview. The expiring fingerprint binds all
reviewed source/destination/staging bytes, modes, directory inventory and checks.
The CLI asks independently about exact staged project-code verification and
separately about declared network effects, each with Yes/No, default No.
Isolated staging is **not an OS or network sandbox**: trusted project commands
can affect the host and access the network. Declaring `network: false` is not
proof scripts cannot access the network. Review those effects before consenting
to run project code. Mandatory isolation unsupported by this executor blocks
verification; trust cannot replace required OS or network isolation.
After fresh matching successful verification, the CLI asks
separately about exact local file writes. Explicit Yes applies only those
displayed effects through the confined transaction, with no hash entry.
File approval executes no scripts. No/Ctrl-C/EOF does not apply the patch, but
cannot undo previously approved verification host/network effects.
If verification ran before cancellation at the file prompt, report those
executed checks and observed effects separately from **no file transaction
committed**. Do not claim “nothing happened.”

Optional agent automation still supports `liftoff repair --verify-plan <fingerprint> --json`
and `liftoff repair --approve-plan <fingerprint> --json`. Agents must show the exact
JSON preview and obtain independent user approval for each scope before using
the returned fingerprints internally. Declared network effects additionally need
explicit consent and `--allow-network` on verification. File approval still needs
fresh matching successful verification. These APIs are not the primary human
path; never ask humans to copy hashes or supply generic/piped approval.
Only the actual user's action-specific approval for the same immutable plan and
effect scopes authorizes those flags. A generic repair request, unrelated
approval, autopilot mode or agent-generated Yes cannot substitute.

Missing verification tools or dependencies remain explicit blockers. Repair
currently supplies no `npm ci`/`npm install` or Python environment preparation.
Do not invent installer commands, copy live dependency trees, inherit credentials
or rewrite locks. `go test`/`go vet` may download modules under separately approved
declared network scope. Missing Node/Vue dependencies do not establish framework
qualification, and a frontend build without a test script is build-only evidence.

Submitted application patches must preserve manifest/provenance, desired state,
managed/framework files, activation proof, immutable history, infrastructure state
and secrets. This does not prohibit the deterministic Azure recipe's separately
registered, reviewed manifest/history writes. Distinguish inventory,
proposed, verified and committed scope. Report only declared checks actually
executed and their results, not full application/cloud conformance or completed
setup. Retain private rollback
material; `liftoff repair --recover --json` handles only the CLI's reported
interrupted repair scope. It is not generic staging/cache deletion, source
restoration or verifier execution. Follow the actual registered recovery action;
PID, age and directory prefixes do not prove cleanup authority.
Post-commit behavior changes need a new reviewed patch or user-controlled history
recovery, not automatic rollback. Use returned schema-2 `nextActions` exactly,
including executable, argument array, working directory, scope and approval.
Repair paths are positional; preserve the same target on every follow-up.

Old complete inventories remain readable without repair files. Reviewed update
adds only selected exact logical names and paths; it never claims ownership from
a prefix or replaces neighboring skills. Differing unowned collisions remain
protected even under force, while existing managed conflicts retain reviewed
force behavior. Native content changes use managed hashes, not independent skill
SemVer. See [agent workflows](spec-workflows-and-agents.md#repair-through-the-installed-cli)
and [repair modes](cli-reference.md#repair-modes).

## Canonical phase graph

The activation graph is packaged as `.liftoff/governance/phase-graph.json` and
records phase IDs, dependencies, applicability, allowed mutations, evidence,
approvals, rollback boundaries, and terminal states:

```text
seed-valid
  -> seed-verified
  -> seed-archived
  -> committed
  -> pushed
  -> phase-0-complete
  -> activation-approved
  -> bootstrap-workflow-source-ready
  -> credential-ready
  -> provider-ready
  -> state-path-selected
       |-> existing-private-path ----------------------|
       `-> bootstrap-local -> runner-ready             |
                            -> private-backend-proof    |
                            -> remote-import-verified --|
  -> remote-ready
  -> application-prerequisites-ready
  -> workflow-source-ready
  -> application-artifact-ready
  -> application-foundation
  -> dev-proof
  -> staging-qualified
  -> production-rehearsed
  -> green-red-proof
  -> enforcement-approved
  -> rulesets-applied
  -> live-readback
  ... separate lifecycle: bootstrap-state-disposed when due
```

If policy prose, generated tasks, or an agent response orders a transition
differently, the graph wins. Provider readiness precedes `bootstrap-local`;
restricted runner readiness precedes private backend proof; private backend proof
precedes declarative remote import; and only an existing private path or verified
remote import can satisfy `remote-ready`.

## Bootstrap seed and local baseline

`seed-verified` means **Local baseline verification**, not an OpenSpec feature
change to complete manually. `/liftoff-setup` (Copilot/Claude) or `$liftoff-setup`
(Codex) is a native coding-agent integration, not a `liftoff setup` command.
`liftoff init` creates a scaffold; it is not an existing-project repair operation.

Before commit/push or Phase 0, OpenSpec setup completes, syncs, and archives the
generated `bootstrap-<project>` seed. Spec Kit setup instead validates the real
`specs/000-liftoff-bootstrap/{spec.md,plan.md,tasks.md}` bundle and official
framework markers, then finalizes the local bootstrap handoff. It never creates
an OpenSpec tree, invents an archive, or creates a Git branch. Older Spec Kit
projects without the bundle need separately reviewed seed adoption.

The bundle's exact identity is `000-liftoff-bootstrap`, with B001–B006 each
appearing once. It is not an active governance change. Dependencies may already
be installed; installing them requires separate consent, which passing tests
alone cannot prove. Successful explicit execution commits the checked projection
with body/full-plan-bound baseline evidence; failed checks leave tasks unchanged.

Both adapters run only local, applicable checks in the declared component roots:

- `liftoff validate`
- backend tests from the generated README
- frontend build when a frontend exists
- `docker compose config -q` when Compose exists
- `tofu fmt -check -recursive` at `infrastructure/opentofu/azure`, covering modules and roots
- `tofu init -backend=false` in each selected independent environment root
- `tofu validate` in each selected independent environment root
- strict OpenSpec validation, or validation of the real Spec Kit bootstrap bundle

Absent components are recorded as inapplicable. The baseline never starts
containers, runs a live `tofu plan` or `tofu apply`, deploys, mutates GitHub, or
requires cloud credentials. A failed local check remains unfinished; only
explicit execution retries it after repair. Read-only status, resume, and
verification do not advance tasks or rerun checks. Unchanged current proof can
be reused; changed relevant inputs require fresh evidence.
Recorded legacy-shared or unknown infrastructure layouts require a repair check
even if new-looking directories exist. Before retrying blocked verification,
native setup runs `liftoff repair --check --json` only after negotiating
`liftoff repair --capabilities --json`. This check is always read-only;
ordinary check makes no cloud calls. Only explicit authority permits
`liftoff repair --check --live --subscription <UUID> --json` for bounded metadata
discovery using existing authentication. The supported local recipe preserves
legacy flat-root OpenTofu semantics in a shared application module and the
selected independent environment roots. It requires authoritatively absent
resource groups in that subscription and absent local state/backend metadata.
Missing state files alone are not proof of undeployed infrastructure.
Discovery is limited to 120 seconds overall, 30 seconds per command, and at most
24 resource groups. See [repair modes](cli-reference.md#repair-modes) for the
compatible stable OpenTofu check and exact staged validation sequence.

For normal human execution, setup uses interactive `liftoff repair`: the exact
immutable plan is displayed before action-specific Yes/No, default No.
Only explicit Yes executes the displayed internal fingerprint; humans do not
copy hashes. Application patches have distinct verification, declared network,
and local file prompts. JSON/nonTTY bare repair stays preview-only.
Then setup runs
`liftoff update --check --json`, reviews any separate update plan, and resumes
with `liftoff governance status --scope local --json`,
`liftoff governance verify --scope local --json`, and
`liftoff governance resume --scope local --json` before the reported local plan
and ready apply action. These reads do not rerun scripts or advance evidence.
Keep the selected project in every command; repair takes a
positional project path. Recover interrupted repair through
`liftoff repair [project-path] --recover`, not update authority.

Repair does not accept `--force`, `--yes`, or `--add-agents`. Additive agent
integration uses a separate exact `liftoff repair --agents` plan and cannot
remove existing selections. The public stateful migration coordinator is not
implemented; an internal stateful engine does not make the public command executable. Deployed, unknown,
ambiguous, and unsupported cases stay plan-only with their source and state
untouched. Do not edit manifest provenance, copy a fresh init scaffold over the
project, or recommend manual state moves. A repaired infrastructure layout does
not establish completed local governance, deployment, or live enforcement.

If the seed was already archived before setup began, it stays archived.
Setup still runs the entire applicable local baseline, but strict OpenSpec
validation targets the synchronized spec set with `openspec validate --all
--strict`, not the inactive bootstrap change name. The expected main capability
must exist with a concrete Purpose. A failed archived baseline can be retried
after repair: `resume` reports readiness without rewriting stored state, and
`apply-next --json --execute` reruns the checks before saving verified evidence.

## Questions and approval envelopes

Deterministic defaults and discovered facts do not become conversational
questions. Setup may ask only at these authority gates:

1. repository creation, initial commit, remote, or push;
2. credential enrollment;
3. billed infrastructure, policy exceptions, and cost ceiling;
4. final ruleset enforcement;
5. destructive cleanup, including day-30 bootstrap-state disposal;
6. external platform blockers that require changed authority or design.

Repair has independent gates for exact local file changes, staged project-code
verification, and any declared network access. None is implied by an assessment
report, update approval or activation envelope.

Every approval envelope records the reviewed plan digest, allowed resource
types, destinations, permissions, cost ceiling, destructive scope, policy
exceptions, expiry, and baseline SHA. Retries inside the same envelope do not
ask again; expanded resources, destinations, permissions, cost, exceptions, or
destructive effects require a new approval.
Its time window must satisfy `approvedAt <= now < expiresAt` and have a valid
start/end interval. A future, reversed, or expired envelope cannot authorize
execution. `governance plan` can preview dependency-ready work before approval.
`governance approve --plan <fingerprint>` persists only the exact reviewed
authority, with a separate project-bound user-local issue record. Imported
project JSON is not permission. Final enforcement can bind both its approval
and subsequent exact ruleset operations without granting other phase authority.
`governance approve` and `governance apply-next --execute` refuse a phase whose
production capability is blocked or unavailable in the installed release, before
writing a plan, approval, authority record, or activation state. A previously
issued approval does not override that refusal.

## Credentials for runner preflight

When `GITHUB_TOKEN` cannot read required hosted-runner metadata, setup first
prefers an existing verified selected-repository GitHub App installation with the
required read permissions. Liftoff does not install or broaden an App.

If no approved App is available, the narrowly scoped fallback is:

| Field | Value |
| --- | --- |
| Display name | `<repo>-runner-preflight-read` |
| Repository secret | `RUNNER_CONFIGURATION_READ_TOKEN` |
| Lifetime | 30 days |
| Repository scope | current repository only |
| Repository permission | metadata read |
| Organization permissions | hosted-runner read and network-configuration read |
| Writes | none |
| Workflow/job allowlist | `.github/workflows/bootstrap-import-preflight.yml` job `bootstrap-import-preflight`; `.github/workflows/private-dast-preflight.yml` job `private-dast-preflight` |

Public activation inputs contain only either
`{"kind":"github-app","appId":12,"installationId":77}` or the justified fallback
`{"kind":"fine-grained-pat","tokenId":4242,"owner":"octo-owner","appUnavailableReason":"..."}`.
The secret value never belongs in that file.

Credential readiness uses an exact reviewed `credential-ready` plan and separate
approval. Run `liftoff governance credential-enroll --plan <fingerprint>` for a
private non-echoing TTY, or add `--protected-stdin` only for an explicitly
selected owner-controlled non-TTY secret channel. The value is never accepted in
chat, argv, `--inputs`, plans, evidence, policy, source, logs, or screenshots.
The producer rechecks approval immediately before protected input and provider
mutation, verifies exact repository/permission/expiry/use scope, writes only the
fixed Actions secret, independently reads current secret metadata, and persists
only the payload-free policy and matching proof. A secret name or a policy file
alone cannot establish readiness.
Never paste or show the value in chat, argv, command arguments,
logs, evidence, files, or screenshots. A disclosed value is
compromised and must be revoked and rotated through its owner-controlled system.

The recorded credential policy is payload-free: it stores auth kind, display
name, secret name, owner, repository, expiry, rotation lead, permissions,
allowed workflows/jobs, non-forwarding rules, and readback evidence, never the
secret value.

## Phase 0 provider discovery

Post-publication Phase 0 uses bounded read-only GitHub REST and Azure CLI reads;
it does not rely on the old minimal `gh repo view` path or an injected success
adapter. GitHub discovery re-reads the local Git push destination at execution
time and requires it, the verified publication binding, and the provider
repository ID to identify the same repository. It inventories source and branch
contexts, workflows, rulesets, releases, environments, deployments, Actions
permissions, security signals, authenticated identity, and optional
runner/network controls. A denied mandatory inventory remains `unknown` and
blocks completion; it is never treated as absent.

Azure discovery is planned only when activation inputs contain an exact
subscription UUID, tenant UUID, and region. Every subscription-scoped command
passes `--subscription`; no CLI default account is trusted. Phase 0 compares
`az account show` with a live Resource Manager subscription readback, resolves
the actual user or service-principal object, and uses the selected cloud's
Resource Manager endpoint, including sovereign clouds. Each manifest-selected
environment is mapped to its deterministic resource-group and resource-name
bindings and inventoried by full provider resource ID. Existing matching names
are recorded as `occupied-unverified-ownership`, even when their tags mention
Liftoff; names and tags do not grant ownership or write authority.

Provider reads have fixed time and response-size bounds. Evidence retains only
sanitized identity, endpoint, status, environment, and resource bindings. Raw
CLI output, credentials, account email addresses, and provider diagnostics are
not persisted. Phase 0 performs no GitHub or Azure mutation.

Before any later reviewed plan can read deployment state, import state, publish
an image, or provision Azure resources, it includes
`azure.deployment.classify-ownership`. Execution repeats the bounded account,
subscription, cloud, principal, resource-group, and resource metadata reads
without reading backend state. An absent expected resource group is
`new-environment`. An occupied group is `same-operation-owned` only when the
current phase has the exact non-failed operation and plan digest and its recorded
outputs cover the group plus every observed resource ID. Missing local state,
matching names/tags, an older phase output, or broad approval is not proof.
Anything else is `pre-existing-or-unknown`: the reviewed plan is retained for
planning, but the phase adapter, backend-state access, import, publish, and
resource writes do not run. Provider registration is a retained subscription
prerequisite and is not deployment ownership.

## Azure provider readiness

`provider-ready` requires reviewed activation inputs containing the exact Azure
resource types used by the approved design and the AzureRM registration mode:
`automatic` or `none`. Liftoff validates and deduplicates those types, derives
only their provider namespaces, and derives a subscription feature only for a
supported resource type that intentionally requires it. Ordinary public IP,
Firewall, or NAT resources do not authorize the BYOIP feature; an approved
`Microsoft.Network/customIPPrefixes` resource is required.

```json
{
  "phases": {
    "provider-ready": {
      "azureRmRegistrationMode": "none",
      "resourceTypes": [
        "Microsoft.Storage/storageAccounts",
        "Microsoft.Network/virtualNetworks",
        "GitHub.Network/networkSettings"
      ]
    }
  }
}
```

Planning revalidates the configured subscription, tenant, principal, cloud, and
sovereign-cloud Resource Manager endpoint. It reads every derived provider and
feature plus the current identity's effective subscription permissions. With
automatic AzureRM registration, every provider must already be terminal
`Registered`; Liftoff does not add duplicate explicit registrations. With
registration mode `none`, only approved missing namespaces are registered and
only when live permission includes
`Microsoft.Resources/subscriptions/providers/register/action`. Feature writes
independently require
`Microsoft.Features/providers/features/register/action`.

Execution reobserves identity, permission, and registration state before each
effect. A namespace already `Registering` is polled without redispatch. Missing,
unauthorized, stale, `Unregistering`, malformed, or timed-out prerequisites block
the phase and every dependent resource write. Completion requires independent
terminal `Registered` readback for every planned provider and feature. Partial
success is reported without raw provider diagnostics, and successful
registrations remain retained shared subscription capabilities; rollback never
unregisters them.

Registration polling is bounded to 60 observations at intervals of at most five
seconds. If Azure is still `Registering`, Liftoff saves the exact credential-free
Resource Manager handle, current sanitized readback, and partial resource
bindings as a running checkpoint instead of redispatching registration. Resume
accepts only the same reviewed provider, action, operation, resource, start time,
and poll URL; the operation must be no older than 24 hours and its matching
provider readback must be strictly newer and no more than ten minutes old.

A terminal provider operation is not an ordinary retry. If a remote write
completed before a later blocker, the phase remains `blocked` and records
`partial-failure.v1` evidence containing only digests, exact sanitized operation
identity, live readback, and owned output bindings. Blocker text, provider
payloads, credentials, and cleanup text are not copied into evidence. Continue
only through an explicitly reviewed recovery plan after current deployment
ownership is reverified; local rollback never claims retained cloud effects were
undone.

## Existing private backend readiness

Task 13.1 supports one narrow reusable backend path without adopting deployed
state. The reviewed activation inputs must select `existing-private` and name
the exact resource group, storage account, container, blob key, and Azure
principal object ID:

```json
{
  "phases": {
    "state-path-selected": {
      "statePath": "existing-private",
      "resourceGroup": "rg-opentofu-state",
      "storageAccount": "stliftoffstate",
      "container": "tfstate",
      "key": "project-id/dev/terraform.tfstate",
      "principalId": "00000000-0000-4000-8000-000000000000"
    }
  }
}
```

The approved selection plan binds those values plus the current opaque
execution-host identity. Execution independently revalidates the configured
subscription, tenant, and principal, requires the packaged OpenTofu
version/platform, and verifies the exact storage account is HTTPS-only,
OAuth-default, private-network-only, and has shared-key and blob-public access
disabled.

The `existing-private-path` phase then reobserves blob versioning and soft-delete
retention, proves the named container is privately reachable and available for
Azure blob-lease locking, and runs only an exact target-blob existence read.
The target key must be absent. If it exists, Liftoff refuses to download, read,
import, relocate, or adopt that state and leaves the scope planning-only.
The alternate bounded bootstrap is described below; hosted-runner establishment
and any same-operation state handover remain separate later phases.

## Bounded backend network bootstrap

Task 13.2 supports `bootstrap-local` only when the reviewed
`state-path-selected` input names `bootstrap-local` and the existing protected
backend cannot yet be reached from an approved private execution path. The
separate `bootstrap-local` configuration must select one declared environment,
one virtual-network CIDR, distinct non-overlapping runner and private-endpoint
subnet CIDRs, the exact private Blob DNS zone for the selected Azure cloud, and
`nat-gateway` as the only qualified egress mode. The activation budget must
include explicit nonzero fixed and usage monthly ceilings.

Before any billable deployment, Liftoff rechecks the exact subscription,
tenant, principal, backend protection, qualified host, effective Azure
deployment/network/private-endpoint permissions, deterministic resource names,
deployment ownership, and absence of the deterministic subscription deployment
name. It then dispatches one bounded subscription-scoped ARM deployment for the
environment resource group, virtual network, delegated runner subnet, separate
private-endpoint subnet, Standard NAT gateway/public IP, private Blob endpoint,
private DNS zone/link, and DNS zone group.

An asynchronous deployment persists one immutable provider handle and the exact
planned resource IDs. Resume polls that deployment without redispatch. Success
requires terminal deployment state and exact resource readback. An occupied
name, unapproved cost, missing permission, overlapping address range,
pre-existing scope, or terminal deployment failure blocks without adoption.
This phase does not create a GitHub runner, initialize/read/import backend state,
or provision application resources; those remain separate reviewed phases.

## Evidence authority and active changes

Task checkboxes are a projection of phase state, not authority. Evidence
documents carry repository identity, activation version vector, graph hash, phase
contract digest, scope, real input/baseline digests, reviewed before/after
file and Git bindings, body commitment, phase ID, timestamp,
producer, and result. The local execution anchor is separate from a verified
remote repository binding; Phase 0 does not replace the anchor beneath earlier
local receipts. Digests prove consistency, not an independent signature or
permission grant. Current valid proof may coexist with informational stale
history, but equally authoritative contradictory records block execution.
The current context includes reviewed immutable plans and state evidence
references. Payload `planDigest` binds semantic plan inputs; `savedPlanDigest`
binds the full saved plan, including clocks. `bodyDigest` covers the payload and
normalized readbacks. Consumers use the validated selected payload, not another
raw record that happens to reuse an ID. Repository publication binds the actual
reviewed push destination; Phase 0 cannot invalidate earlier local/publication
receipts by replacing the local anchor. Scoped projections keep later approved
workflow publication from invalidating unrelated local application checks,
while unplanned source, destination, and output changes still invalidate the
affected proof. External operation handles and pre-write checkpoints prevent
an interrupted workflow from being dispatched twice.

There may be only one active governance source of truth. An unfinished bootstrap
seed blocks Phase 0. Exactly one compatible active governance change is resumed.
Multiple overlapping changes require a schema-valid supersession or archive
record before any phase advances.

Reviewed managed updates install new policy, graph, schema, compatibility metadata,
and setup/assessment/repair integrations without acquiring general state ownership.
Forced update can remove
exact retired generated setup-alias entries from older manifests. When a policy,
activation-contract, schema, or graph-hash change affects active work, status
reports `reconciliation-required` and identifies affected descendants. Historical
activation-v1/v2 state and evidence remain byte-preserved and non-executable.
`liftoff update --check` can preview an exact supported successor migration;
explicitly approved apply preserves original history and creates linked v3 state.
Fresh local revalidation stops at unsupported or independently authorized work.
Failure after commit leaves v3 blocked/resumable, not reset to older authority. Never
acknowledge an identity by editing JSON or treat old approvals as current consent.

## Private staging and bootstrap retention

Private Staging DAST uses an ephemeral GitHub-hosted larger runner with Azure
VNet injection only when genuinely applicable. Phase 0 discovers repository,
subscription, authority, billing, network, DNS, cost, teardown, and capability
facts read-only. DAST inapplicability does not bypass provider registration or
the private execution path required for state operations. Existing suitable
private paths are reused rather than replaced with public access.

After the bounded `bootstrap-local` network foundation is verified,
`runner-ready` can create exactly one repository-dedicated hosted-runner path:
an Azure `GitHub.Network/networkSettings` resource on the verified delegated
subnet, one GitHub Actions network configuration, one selected-repository and
selected-workflow runner group, and one GitHub-owned `ubuntu-latest` `4-core`
larger runner with maximum concurrency one and static public IP disabled. The
reviewed organization and repository database IDs, deterministic resource
names, NAT route, private DNS bindings, packaged preflight workflow paths, and
nonzero cost ceilings are immutable plan inputs. Occupied names, missing
licenses or permissions, unsupported status, identity drift, or contradictory
resume outputs block rather than being adopted or treated as ready.

The phase independently reads Azure and GitHub resources back and requires the
runner group to be authoritatively visible to the exact private repository.
While GitHub reports `Provisioning`, Liftoff stores one immutable hosted-runner
operation handle and resumes by GET without repeating provider writes. The
runner's deterministic name is its workflow label when the larger-runner API
does not expose a separate labels array. `runner-ready` does not dispatch the
runner or prove backend access; that remains the later
`private-backend-proof` boundary.

The next two phases expose a private injected capability rather than a public
brownfield migration command. `private-backend-proof` dispatches only the
reviewed preflight on that exact runner and requires the same repository,
workflow run/job, full source SHA, runner/group/network IDs, backend binding,
absent target key, and Azure blob-lease support. `remote-import-verified` then
admits only the resources created by the same verified `bootstrap-local`
operation: nine direct imports, the private-endpoint DNS-zone group as one
embedded child, and the two ARM deployment records retained outside state.
Every resource must have exactly one reviewed disposition and fixed address.

The handover persists one immutable GitHub Actions operation handle while
pending. Before dispatch, a separate custody capability must attest the exact
runner and host, opaque protected workspace/storage references, one
non-exporting external key reference, Azure blob-lease locking, writer
quiescence, due-time disposal support, and no plaintext fallback. Completion
requires exact mapping, concurrency, backend, and no-change digests; a
zero-add/change/destroy plan; at least one encrypted artifact reference under
that workspace; independent GitHub workflow and Azure backend readback; and
explicit proof that the target did not previously exist. The handover custody
identity must equal the identity established by `private-backend-proof`. A
changed operation ID, runner, host, workspace, storage, key, lock, bootstrap
inventory, resource mapping, occupied target, extra or missing resource,
nonzero plan, or missing backup blocks. The default CLI supplies neither private
capability, so both phases remain fail-closed. Existing-state adoption,
partition, relocation, and address migration remain unavailable through the
public governance API.

When a private ZRS backend cannot be reached and no existing private management
path is approved, the bounded `bootstrap-local` branch may create only the
access-establishing resources needed to reach the backend. Local bootstrap state
is encrypted, gitignored, single-writer, never uploaded or copied through GitHub
artifacts or secrets, and cannot authorize application provisioning.

The bootstrap/private-path branch still passes the deployment-ownership gate.
An occupied deterministic resource group cannot be treated as a bootstrap
resume unless the current phase's exact operation and output IDs cover every
resource observed during the fresh bounded read. Otherwise it remains
planning-only; Liftoff does not inspect the backend to try to infer ownership.

After verified declarative import, backend identity parity, state locking, Blob
versioning, and a clean-checkout no-change plan, protected bootstrap artifacts
become read-only evidence for exactly 30 days. Retention stores only digests of
opaque protected artifact and key references; they are not project-relative
files. Disposal cannot run early or through the built-in filesystem mutation
path. The same injected custody capability must requalify the retained host,
workspace/storage, key provider, lock, runner, and writer-quiescence identity,
then return payload-free proof that every artifact and unique key reference was
deleted at or after the due time. Missing material before verified disposal,
unsupported hosts, changed/expired custody, unavailable keys or storage, lost
locking, and active writers remain explicit blockers. Provider registrations
remain retained subscription capabilities and are not unregistered during
teardown.

## Approved application readiness

`application-prerequisites-ready` and `application-artifact-ready` now have
concrete bounded source producers, conditional on both private protected-state
capabilities and the same independently qualified execution host. Public modern
activation remains separately gated; neither source presence nor unit fixtures
qualify production task13/task14 execution.

Prerequisite plans bind exact registry/identity resources, tenant service
principal, registry-only AcrPull/AcrPush assignments and cost. Unknown or
pre-existing resources stay planning-only. Continuity from prior bootstrap/runner
phases requires authoritative, fresh evidence/output bindings and exact recorded
operation inventories, not names, local files or tags. A confirmed pending
prerequisite deployment can be observed read-only even while newly appearing
resources lack final ownership proof; completion still requires deployed-recipe
and full resource/role/ownership readback before publishing authoritative outputs.

Artifact plans separately bind source transmission, dependency/network and build
consent. The existing GitHub artifact route verifies committed recipe bytes,
exact source and runner admission before dispatch, checkpoints the real run,
and combines actual ACR run/digest/immutability with cryptographically verified
GitHub source/signer/run provenance. No artifact readiness is recorded from a
placeholder, candidate tag or caller-supplied source annotation. Partial handles
survive a later source/authority change; failed or uncertain effects are observed,
not automatically repeated or undone.

The artifact route dispatches only the existing protected lightweight
`liftoff-execution-<full-source-SHA>` tag bound to its own reviewed complete
source/tree/recipe. A shared read-only observer rechecks effective no-bypass
tag update/deletion protection, provider grants, source tree and tag before
dispatch and accepted/resumed observation. Runner admission must select that
tag. Missing, unsupported or changed admission blocks; no tag creation,
policy mutation, mutable branch fallback or task14.3 authority is borrowed.
Old plans require review instead of retagging. Public-v8 activation, actual
protected execution ports/host and disposable qualification remain unavailable.

See [Azure application readiness](azure-deployment.md#application-readiness-source-boundary)
for declarative recipe inputs, operator boundaries and remaining real
qualification blockers. The original exact 30-day protected retention/disposal
obligation remains unchanged; TASK14.1 is not checked by source tests.

## Maintainer boundary: injected ruleset observation

Ruleset enforcement and its final `live-readback` phase still require an
explicitly injected GitHub ruleset adapter; there is no default production
ruleset writer or reader. The observation path retains the original repository,
saved source digest, evidence header, read-operation inventory, plan expiry,
clock, lease assertion and reader method before its first await. Changing
caller-owned phase, repository, identity, context, plan or adapter objects during
lease validation or provider observation cannot turn that read into enforcement
or relabel its proof. Caller changes are not restored. Expiry, lease failure and
source/readback digest mismatch still refuse completion; ordinary enforcement
retains its separately required approval checks.

This source boundary does not qualify live GitHub ruleset behavior, add a
production adapter, grant provider writes or complete TASK14.4. Full production
execution and its independent evidence remain separate requirements.

## Commands

The generated setup integrations call only strict, project-aware CLI commands:

```bash
liftoff governance status --scope local --json
liftoff governance plan --scope local --json
liftoff governance apply-next --scope local --json --execute
liftoff governance verify --scope local --json
liftoff governance plan --scope activation --inputs public-inputs.json --json
liftoff governance approve --scope activation --plan <fingerprint> --json
liftoff governance apply-next --scope activation --plan <fingerprint> --execute --json
liftoff governance resume --scope activation --json
liftoff governance status --scope lifecycle --json
```

Direct commands default to activation scope. `status`, `resume`, and `verify`
are read-only; `plan` saves a disclosed preview outside the repository without
changing project/provider data. `apply-next` previews mutations
unless `--execute` is supplied, and even then executes at most one graph-ready,
evidence-ready, approved phase. Here, approved means its approval status is
`not-required` or `reused`. Unknown subcommands, flags, or extra positionals
fail before project discovery or mutation. Verification reports consistency
separately from selected-scope completion: a valid not-started or in-progress state may
have `ok: true` and `verificationStatus: "consistent"` while `complete` remains
false. An intact bootstrap seed awaiting baseline verification or archive is
also incomplete rather than inconsistent. Missing or overlapping seeds, or an
active seed contradicting recorded archive completion, still fail verification.

Apply-next reports `selectedPhase` for the attempted transition and
`executedPhase` separately from recomputed post-transition `nextReadyPhase`.
Schema-2 results also identify `nextPlannablePhase`, separate milestone progress,
and structured registered `nextActions`. A pending external operation is not
completed evidence. Its exact running handle and partial output bindings are
retained for fresh provider observation; ordinary apply refuses a changed,
stale, missing-readback, over-age, or terminal handle. For failed or interrupted
work, obtain a fresh
`governance plan --recover-phase <phase>` and explicitly execute its reviewed
`governance recover --plan <fingerprint> --execute` action. OpenSpec failures include bounded
diagnostics with terminal controls removed; credential-shaped output is
withheld rather than copied into state or command output.

## Existing projects

Projects without `governanceProfile` normalize to the enabled default during
read, then `liftoff update --check` previews manifest v7 and managed-core drift.
Plain `liftoff update` writes v7 only after preflights pass. It never provisions
Azure or GitHub resources and never advances activation state. Setting
`"governanceProfile": "none"` stops policy/setup/assessment rendering but retains
selected repair integrations. Previously managed governance handoff files
become reported orphans and remain on disk for manual review.
