# Repository governance and deterministic setup

Repository governance is enabled by default through the
`single-maintainer-gitflow` profile; `--governance none` opts out. Initialization
writes local managed-core artifacts only. It does not run an agent, mutate Git,
contact GitHub or Azure, configure rulesets, provision runners, deploy, or start
monitoring.

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

Historical policy-only handoffs remain readable without an activation identity.
Released manifest 5/policy 1 and manifest 6/policy 5 inventories contain policy,
context, guide and their exact retired setup aliases, not an activation graph or
current execution proof. Assessment preserves their original bytes and points to
`liftoff update --check`; it does not invent a v1/v2/v3 identity, read unversioned
records as current authority, or create a successor history without actual
registered activation records. Current activation requires the separately
reviewed managed-handoff update.

**Independent milestones:** local readiness does not imply publication or
deployment. Explicit local-only use and declining a later approval remain
supported. Activation requires real source-matching provider evidence;
unsupported account capabilities, unverified private access, and incomplete
observations remain explicit blockers. Retained-state disposal is separate
lifecycle work, not a 30-day delay before initial activation can complete.

Repository-scope discovery reads only the exact published GitHub repository; it
does not request Azure configuration or organization-level access. Its bounded
inventory includes GitFlow refs, classic branch protections, repository and
inherited rulesets (including observed actor bypass capability), workflow bytes
at the observed default-branch commit, exact check/App identities, and
Actions/token settings. Two matching observations are
required. Denied reads, masked protection 404s, malformed enforcement and changing
inventories block discovery rather than becoming empty lists or disabled controls.
Missing optional metadata stays explicitly unobserved. Discovery grants no
control ownership, mutation approval, check qualification or production proof;
unqualified producer and release gates remain separate.

Workflow publication and owned-control changes use separate exact approvals.
All three source-workflow phases publish through reviewed GitFlow pull requests,
not direct protected-branch updates. Repository settings and rulesets remain
distinct effect classes; neither a publication approval nor repository-only
check proof authorizes full production enforcement. Published commits, pull
requests and protections are retained after partial failures.

Preview, approval issuance, replanning, execution and provider recovery share
one project-bound private storage namespace. Conflicting storage boundaries are
rejected rather than silently reading approval from one location and writing
recovery records elsewhere. Pending provider work retains its actual recorded
identity; another explicitly authorized execution can observe that operation
without blind redispatch. `governance resume` only recalculates readiness and
never dispatches or polls provider work.
The same namespace also covers current approvals inside migrated projects,
doctor and governance assessment, and local update revalidation. Preserved historical approval
bytes remain non-executable; a different private home cannot substitute for
the authority originally issued for the current plan.

A fully settled preparation or credential stage can return
`phase-review-required` without completing its phase. The command exits 0 for
this non-error pending result, with `phaseComplete: false` and the bounded public
`review` payload in JSON. Status, plan and resume read the same project-bound
private review record. Repeating the settled stage performs no operation and
does not reuse its approval. Inspect the public result with `--json`, supply the
next-stage inputs, then request and approve a fresh exact plan. A continuation
does not authorize the next stage or turn a completed stage into verified
evidence. `governance verify` still exits 2 for consistent but incomplete setup
(0 only for consistent completion, 1 for inconsistency).
Verification includes selected-scope execution blockers in the skipped readiness
check. Missing local engines, inputs or authority remain visible without being
misreported as inconsistent history or successful execution.

Azure metadata readback likewise requires the returned namespace, subscription
and resource identities and actual provider state. Missing provisioning or
runtime state is not `Succeeded` or `Running`. Artifact inspection requires an
explicit registry, repository and immutable digest; neither generated names nor
the first/latest image establish authority. Registration configuration flags do
not grant approval, and an observed `Registering` value without a bound
provider-issued operation ID does not create a synthetic resumable operation.
Complete source-bound registration/provisioning, durable recovery and live
qualification remain separate implementation and authorization requirements.
Phase-specific Azure bindings inherit global values only when their fields are
absent. Explicit null, non-string, empty, nil or malformed values block planning
and discovery rather than silently selecting the global subscription or tenant.

The candidate implements a bounded source-backed provider registration adapter.
`phases.provider-ready` takes an exact manifest-declared Azure OpenTofu
`rootPathParts`, the Azure principal object ID as `principalId`, and a
`registration` intent of `read-only` or `register-missing`. The planner parses
actual selected-environment sources and local modules rather than guessing a
namespace list from the workload name. Each namespace has its own reviewed
operation and real private approval; the intent string is not permission.
Infrastructure inventory hashes are distinct from provider readback hashes.

The provider plan also requires `phases.state-path-selected.statePath` in the
input configuration before that later phase executes. With `bootstrap-local`,
it consumes the actual typed bootstrap and runner ARM plans, including
`GitHub.Network/networkSettings`; it does not infer namespaces from resource
names or accept an `additionalProviders` list. The SDK plans must target the
same subscription and tenant. Explicit provider-registration and later
bootstrap principals remain separate bindings.

The composite inventory commits actual HCL bytes/modes and SDK resource
IDs, types, API versions and body digests. Relevant SDK configuration changes
invalidate provider plans even when namespace names remain the same.
Unrelated later phase inputs do not change this identity. Configuration-only
SDK changes do not retag committed/pushed proof; actual publication payload,
repository and ref changes still invalidate it. The original HCL-only inventory
reader and its digest algorithm remain separate and unchanged. Planning does
not open private custody, select the active backend, or authorize future
bootstrap effects.

Before a registration POST, the released immutable private store records the
exact operation, project creation identity and client correlation ID. Provider
request IDs remain separate. Three bounded polling reads cannot trigger another
dispatch. A known rejected attempt needs a fresh, separately approved recovery;
unknown submission remains readback-only until its actual result is established.
Prior attempt records and subscription registrations are retained, never
silently removed or overwritten. A complete namespace inventory does not
qualify a provider, host or deployment path; producer acceptance and separately
authorized live qualification remain distinct gates.

`phases.state-path-selected.statePath` explicitly selects `existing-private` or
`bootstrap-local`. Its implemented producer verifies the exact approved account
and choice, not private backend readiness. Private reachability/state proof and
staging or production qualification cannot be inferred from versioning metadata
or a `Running` application.

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
Policy version 7 treats numbered policy sections as capability chapters, not
execution order. The managed phase graph is the sole execution-order authority.

## Read-only governance assessment

`/liftoff-governance-assess` is separate from `/liftoff-setup`, which remains the
primary post-init path. Both OpenSpec and Spec Kit receive only their selected
agents' assessment integrations when governance is enabled. Initialization never
runs assessment. It needs no commit, push, activation, or cloud credentials:

```bash
liftoff governance assess --json
```

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

## Separate native project repair

The selected repair integration first runs `liftoff repair --capabilities --json`
without project access. It checks repair contract 1, the required recipe/layout
identity, command modes and document schemas. The supported recipes are
`azure-local-layout` v1 and `application-layout-patch` v1; reports, previews,
new history and repair journals use schema 2. Missing capability support stops
the operation with `liftoff upgrade --check --json`, not direct project edits.
Upgrading the CLI is a separate decision. Require advertised `interactive-repair`
support before using the normal interactive journey. Repair identity does not change
package 0.12.3 or activation 0.12.0 / manifest 7 / policy 6 / activation contract 3 /
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

Missing verification tools or dependencies remain explicit blockers. Registered
`npm-ci`, `uv-locked-sync` and `go-mod-download` preparation uses exact candidate
locks and private environments under separate consent. Do not invent installer
commands, copy live dependency trees, inherit credentials or rewrite locks.
Project checks and declared network access still require their own authority.
Missing Node/Vue dependencies do not establish framework
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

Repair does not accept `--force`, `--yes`, or `--add-agents`. Agent installation
and the public stateful migration coordinator are not implemented; an internal
stateful engine does not make the public command executable. Deployed, unknown,
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

After reviewing and approving the credential-ready plan, use
`liftoff governance credential-enroll --plan <fingerprint>`. The default input
channel is a private TTY; `--protected-stdin` explicitly selects a protected
automation channel. The published allowlisted workflow must prove actual
credential use; the secret name or a policy file alone cannot establish readiness.
Never paste or show the value in chat, argv, command arguments,
logs, evidence, files, or screenshots. A disclosed value is
compromised and must be revoked and rotated through its owner-controlled system.

See [credential provider permissions and policy admission](credential-permissions.md)
for documented GitHub permission requirements and policy admission boundaries.
The actual endpoint `GET /orgs/{org}/actions/hosted-runners` requires
`organization_administration:read`, including broader organization, billing and
Actions-settings read reach. Policy 8 and credential-policy schema 2 represent
that grant explicitly. Human previews and approval output disclose the scope and
exact operations; fresh plan-bound approval and original usage/run/artifact
custody are still required. Schema-1 policies and policy-7 approvals are not new
authority. PAT bearer binding, lifetime proof and create-only secret operations
remain separate unresolved boundaries.

The recorded credential policy is payload-free: it stores auth kind, display
name, secret name, owner, repository, expiry, rotation lead, actual provider
permissions and broader-read disclosure,
allowed workflows/jobs, non-forwarding rules, and readback evidence, never the
secret value.

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
activation-v1/v2/v3 state and evidence remain byte-preserved and non-executable.
`liftoff update --check` can preview an exact supported successor migration;
explicitly approved apply preserves original history and creates linked v4 state.
Fresh local revalidation stops at unsupported or independently authorized work.
Failure after commit leaves v4 blocked/resumable, not reset to older authority. Never
acknowledge an identity by editing JSON or treat old approvals as current consent.

For affected v3 publications, the successor supports separately reviewed
readback of the original commit and GitHub repository/ref. Later Azure-only
inputs do not require another commit or push. Fresh current approval is still
required; retained historical approval files do not grant it. New local
manifest, policy or workflow content is not thereby published:
`publicationRevalidation.newLocalMetadataPublished` distinguishes the original
publication from pending local metadata. Changed publication facts and new
workflow source require their own review and publication, not rewritten old
receipts.

## Independent repository-only execution and source checks

The public governance CLI supports independent `--scope repository` execution
alongside `local`, `activation`, and `lifecycle`. Direct governance commands
default to `--scope activation`; selecting repository-only scope must be explicit
and does not create Azure dependencies or satisfy production qualification.

Source publication phases accept `{ sourceSha, paths, publication?: { featureBranch, repositoryId, actorId, commitTime, commitMessage } }`
with commit times formatted as whole-second UTC ISO timestamps. Mutations publish
only through GitHub REST immutable trees/commits, new feature or automation branches,
and pull requests. Protected branches (`main`, `develop`) are never updated directly.
Pull requests must be merged externally through passing checks by a reviewed actor,
with pending PR IDs retained.
The full `workflow-source-ready` phase also requires exact file-backed ruleset
source paths; workflow files alone cannot establish its completion. Each returned
workflow resource has matching independent registration/source readback so its
outputs remain usable by later engine inspection. Application build source can
use either the compatible singular `applicationBuild` or a bounded
`applicationBuilds` array for the explicit backend/frontend recipes, never both.
All generated paths, source bytes, actors and refs remain in the exact approval;
adding another recipe does not authorize local file replacement.

Repository-check configuration binds `{ sourceSha, repositoryId, actorId, workflowPaths, fixtures }`
across registered fixture pairs (`develop`, `main`, `release/*`, `hotfix/*`,
`release/**`, `hotfix/**`) with
`targetBranch`, `baseSha`, `positiveBranch`, `negativeBranch`, and `commitTime`.
Supported immutable source validation commands are `node --test`, exact `package.json`
`npm test` -> `vitest run`, `uv run --frozen pytest`, and `go test ./...`. Matrix, conditional,
reusable, privileged, or unknown recipes are rejected rather than guessing contexts.
Negative qualification also reads the exact already-bound Actions job's bounded
native test log. It requires the registered test, source path, assertion and
single-failure summary, not just a failed step, check summary or archived fixture
source. Dependency/collection failures, missing or truncated logs and mixed
failures remain blocked. Raw logs are withheld rather than copied into public
evidence; the receipt binds the assertion identity to the observed job.

Shared workflow dispatch requires string input `liftoff_operation_id` and run-name
`liftoff-${{ inputs.liftoff_operation_id }}` for lost-response recovery.
All three source-workflow phases require exact `repository-publish` approval and
independent GitHub readback. Candidate `0.13.0` provider qualification remains
explicitly **UNQUALIFIED**: source implementation and fixture-based execution do
not establish successful live repository or cloud qualification.

### Owned ruleset enforcement and settings reconciliation

Phase configuration for `repository-rulesets-applied` and full-activation `rulesets-applied`
binds an explicit repository `settings` subset (`default_branch: 'develop'`, `allow_merge_commit: true`,
`allow_squash_merge: false`, `allow_rebase_merge: false`, `delete_branch_on_merge: true`)
and `mainHold: 'hold' | 'replace' | 'qualified'`. Exact published `.github/rulesets` JSON bytes
and file inventory digests remain distinct from the normalized enforcement digest. Actual provider
IDs originate strictly from private issuance and response receipts, never from matching names.

Reconciliation uses zero-write matching when live controls already agree. Owned
PUT/PATCH enforcement implements authoritative pre-reads, cooperating repository
locks, stale-state refusal, per-write private checkpoints, documented GitHub REST
APIs, and independent readback, without claiming cross-writer API serialization or
sending undocumented `If-Match` headers. New plans explicitly use the
`authoritative-pre-read-and-independent-readback` contract; older create-only plans
cannot gain replacement authority.

Operations make no cross-system atomicity promises. Lost versus mismatched outcomes
are handled explicitly through attributable checkpoints, and any divergence requires
a fresh exact reviewed recovery before any further effect. Foreign and newer observed
controls remain preserved on disk and in remotes, with no automatic rollback or
protection removal. Full hold release remains blocked on complete source, artifact,
and native qualification, not on a blanket serialization impossibility.
Repository-only completion never satisfies full activation, production qualification,
or bootstrap state disposal.

## Private staging and bootstrap retention

Private Staging DAST uses an ephemeral GitHub-hosted larger runner with Azure
VNet injection only when genuinely applicable. Phase 0 discovers repository,
subscription, authority, billing, network, DNS, cost, teardown, and capability
facts read-only. DAST inapplicability does not bypass provider registration or
the private execution path required for state operations. Existing suitable
private paths are reused rather than replaced with public access.

When a private ZRS backend cannot be reached and no existing private management
path is approved, the bounded `bootstrap-local` branch may create only the
access-establishing resources needed to reach the backend. Local bootstrap state
is encrypted, gitignored, single-writer, never uploaded or copied through GitHub
artifacts or secrets, and cannot authorize application provisioning.
See [private-state and runner activation](private-state-activation.md) for access-only
ARM network plans, dedicated runner observations, encrypted custody, and explicit
frozen graph boundaries (including exclusive-lease execution blockers for
`private-backend-proof` under graph 3).

After verified declarative import, backend identity parity, state locking, Blob
versioning, and a clean-checkout no-change plan, local state becomes read-only
evidence for exactly 30 days. Disposal deletes the encryption key and approved
temporary copies and records a dated non-secret outcome. Provider registrations
remain retained subscription capabilities and are not unregistered during
teardown.

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
completed evidence. For failed or interrupted work, obtain a fresh
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
