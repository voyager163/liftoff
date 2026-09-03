---
schemaVersion: 1
profile: single-maintainer-gitflow
policyVersion: "5"
state: handoff-generated
---

# Repository bootstrap standard — GitFlow, governance, and security

Set up GitFlow branching, repository governance, and the security pipeline in this repository.
This is my standard for every new repository, so implement it as a repeatable baseline rather than a
one-off.

## Fixed context — these are settled, do not re-litigate them

- **Single-maintainer repositories, by design.** Each developer owns their own repository and is its
  sole maintainer. There is no second reviewer, and none is wanted. **No change in this repository
  requires another person's approval — including changes to workflows, rulesets and governance files.**
  The repository owner merges their own pull requests. Automated checks are the entire gate, so they
  must be strict and must fail closed. Never design anything that depends on someone else reviewing it,
  and never treat the absence of peer review as a gap to be closed.
- **Do not require human approval anywhere.** Specifically: set
  `required_approving_review_count: 0`, `require_code_owner_review: false` and
  `require_last_push_approval: false`. Do not create a `CODEOWNERS` file. Do not add required
  reviewers to any GitHub Environment. Do not add a manual approval step to any workflow. If a
  best-practice default would introduce a human approver, override it and say so.
  To be precise: me approving *your plan* in this conversation is expected and required. What is
  forbidden is any *merge or deploy gate that waits on a person* once the automation is in place.
- **Repository-scoped only, with one bounded provisioning exception.** Org-level rulesets remain out
  of scope and will not be set up. Every governance control must be applied per-repository and work
  standalone in a single repository. Do not propose, recommend, or design around org-level rulesets,
  org-level required workflows, or org-wide GitHub App installations — not even as a "better
  alternative" or future phase. If a control genuinely cannot be enforced at repository scope, say so
  plainly and leave it out rather than proposing an org-level substitute.
  **One provisioning exception only:** when private Staging DAST genuinely applies and no suitable
  VNet-injected larger runner is assigned, an explicitly approved governance change may provision the
  Azure network setting, organisation hosted-compute network configuration, selected-access runner
  group, and bounded larger runner described below. Prove the required Azure and GitHub organisation
  write authority first; never generalise this exception to any unrelated org-level control.
- **Automation identity is the built-in `GITHUB_TOKEN`.** Set the **GitHub Actions app** as the bypass
  actor where automation must act on a protected ref — no custom GitHub App is available, since
  installing one requires org ownership. Note that pushes made with `GITHUB_TOKEN` do not trigger
  further workflows: never rely on a tag-push trigger. Create the tag, Release and durable evidence in
  the successful production workflow. Where a checked back-merge needs another run, dispatch it
  explicitly for the exact SHA and fail if that dispatch or its required checks do not succeed.
- **GitHub Advanced Security is licensed org-wide.** Use Secret Protection, CodeQL and Copilot Autofix.
  Do not add third-party equivalents such as Gitleaks or Semgrep — they would duplicate licensed
  capability.
- **Staging sits behind private networking, and DAST runs on a GitHub-hosted larger runner with
  Azure VNet injection.** Do not build a self-hosted runner VM. An ephemeral hosted runner has
  nothing to patch and leaves no long-lived compute inside the Staging network for a compromised
  workflow to pivot from.
  **This is a deliberate, approved deviation** from guidance that assumes self-hosted runners for
  private targets — implement it as written and do not re-argue it.
  Note the dependency: VNet injection requires an Azure **network configuration** and a **runner
  group**, both represented at organisation or enterprise level. Reuse a suitable existing
  repository assignment when one is verified. If none exists, keep release qualification blocked
  until the exact repository-dedicated stack is explicitly approved, provisioned, read back, and
  proven to reach Staging. Never silently skip DAST, and never substitute a self-hosted runner to
  work around it.
- **The GitHub Release plus attestations are the audit record.** There is no external GRC or
  change-management system to integrate with.

### Pre-answered platform defaults — use these, do not ask again

These were decided once and apply to every repository. Ask only if the repository has a specific,
stated reason to differ, and say what that reason is. Apply a default only when the classified
workload actually uses that component; a database default does not justify provisioning a database.

| Decision | Default |
| --- | --- |
| Storage redundancy | **Dev LRS · Staging ZRS · Production ZRS** |
| IaC state storage | **ZRS in every environment**, including bootstrap |
| Local bootstrap state retention | **30 days read-only after verified remote import, then securely delete.** |
| Azure provider registration | **Derive the minimal namespace set; when auto-registration is disabled, register every missing required provider explicitly before dependent resources.** |
| Database high availability | **Dev and Staging: no HA. Production: zone-redundant HA.** |
| Cloud identity for CI | **User-assigned managed identity with OIDC federation** per repository and environment. No app registrations, no client secrets, no long-lived credentials. |
| Workload scale | **Small — fewer than 1,000 users** |
| Budget profile | **Cost-optimised with production safeguards** |
| Slack webhook storage | **GitHub Actions secret at the environment level.** Not Key Vault — the alerting path must not depend on network access to a private vault, which is exactly how an alert path fails silently. |
| Dependency policy | **Active LTS only.** Pin runtime majors to Active LTS, add Dependabot ignore rules for non-LTS majors, and group updates per ecosystem. Do not re-litigate this every time a new major ships. |

**Provision nothing that no code uses.** Do not add a managed service to the infrastructure until the
application actually consumes it. Before adopting any managed service, state its cost and its
**known service limits** — per-subscription rate caps in particular, which have long lead times to
raise and are discovered far too late otherwise.

**When infrastructure as code does not match what already exists in the cloud**, report the
reconciliation plan before applying anything, refactor the IaC to match the live resources and import
them. Do not build a parallel stack and migrate, force replacement, or treat the estate as externally
managed.

## Basis

The branching model is Vincent Driessen's original GitFlow:
https://nvie.com/posts/a-successful-git-branching-model/
Follow its branch roles and merge directions faithfully. Note Driessen's own 2020 addendum — GitFlow
suits versioned releases rather than continuous delivery. If this repository genuinely ships
continuously, say so and tell me where you are deviating and why, rather than forcing the full model.

## Phase 0 — Classify the repository first

Report before you change anything.

1. What kind of artifact does this repo produce — container image, mobile app, library, static site,
   infrastructure only? This determines which parts of the standard apply.
2. Language(s), package managers, and the build and test commands that genuinely work today.
3. Anything already present: branches, workflows and their exact job names, rulesets, tags, releases,
   environments, deployment pipelines, security scanning.
4. Whether private Staging DAST applies and whether a **GitHub-hosted larger runner group with Azure
   VNet injection into Staging** already exists, is assigned to this repository, exposes the exact
   required labels, and can inspect and reach the real private target.
5. If DAST applies and no suitable assignment exists: the repository's Staging subscription and
   tenant; supported region; Azure and GitHub organisation write permissions; enterprise policy for
   organisation network configurations; billing owner; remote state owner; deterministic resource
   names; non-overlapping address space; Staging VNet, route, private DNS and security topology;
   required outbound policy; current costs and service limits; and dependency-ordered teardown
   owner. Determine whether an approved private management path can already reach the remote backend
   and, if not, whether the private-backend cycle requires the bounded local bootstrap below. Derive
   every Azure resource-provider namespace from the approved resource types, record the AzureRM
   registration mode and subscription registration permission, and read each live registration
   state. Any unresolved input is a blocker, not permission to begin a partial bootstrap.
6. What monitoring and alerting already exists — alert rules, action groups, where they route, and
   which components have no coverage at all. Name the gaps explicitly.
7. Which components expose a health endpoint, and whether it is shallow (process is alive) or deep
   (dependencies are reachable). A shallow check reported as health is a gap, not coverage.

Then state the gap and your proposed order of work, and **get my approval before making changes.**

**Adapt honestly.** Container scanning is meaningless for a mobile app; SBOM and image digests do not
apply to a library the same way. Implement what is real for this repo and tell me explicitly what you
skipped and why. Never ship a workflow that cannot pass.

### Private Staging runner provisioning contract

Provision this stack only when private Staging DAST applies and no suitable assignment already
exists. If DAST is inapplicable, provision no runner networking or hosted-compute resources. If a
suitable assignment exists, consume it without creating a duplicate.

**Keep repository ownership independent.** Every Azure runner-network resource, remote state,
explicit egress resource, cost, and teardown responsibility belongs in the target repository's
Staging subscription. Do not share or depend on another repository's or subscription's firewall,
hub, route, state, billing boundary, or lifecycle. GitHub resources necessarily exist at organisation
level, but the runner group must use selected access for only this repository and, where supported,
only the required workflows.

**Use one explicit outbound mode.** Disable implicit default outbound access on the runner subnet,
then select exactly one of these modes from Phase 0 evidence:

1. **Azure Firewall Basic** only when an applicable organisation or repository policy requires
   domain-restricted egress. Populate HTTPS application rules from the current GitHub meta endpoint
   domain set, record the selected set and capture time, refresh it at least weekly, use no retired
   static GitHub IP allowlist, and perform no TLS interception. Firewall Basic has no DNS proxy, so it
   does not replace the private DNS path to Staging.
2. **Azure NAT Gateway** when strict domain-restricted egress is not required. Limit required
   outbound protocols with an NSG, but state plainly that NAT Gateway and an NSG do not filter HTTPS
   traffic by domain.

Never attach NAT Gateway to a runner subnet whose default route uses Azure Firewall. NAT Gateway
takes precedence for new outbound connections and would bypass the firewall path. Never treat
implicit Azure outbound access as a durable design.

**Prove isolation and the private path.** The delegated subnet must contain no existing NICs, use
non-overlapping address space, and deny all unsolicited inbound connections; GitHub requires no
inbound connection to the runner. Model the actual same-subscription route or peering to Staging,
private DNS zone or resolver path, forwarding settings, NSGs, and target policy. A standalone runner
VNet or a successfully created network setting is not proof that DAST can reach Staging.

**Apply and verify idempotently.** Use reviewable infrastructure as code for the Azure resources and
supported GitHub APIs for the hosted-compute network configuration, group, repository and workflow
access, and runner. Use deterministic names and read before write. Default to the smallest
organisation-supported Ubuntu x64 runner proven sufficient for ZAP — normally 4 cores and 16 GiB —
with maximum concurrency of one unless Phase 0 justifies another bound.

Do not mark the prerequisite satisfied until readback proves the Azure network setting and returned
GitHub ID, organisation network configuration, selected-access group, exact repository and workflow
assignment, runner image, size, labels, status, concurrency, billing owner, explicit egress path,
private DNS resolution, and live Staging reachability. A standard hosted preflight checks assignment
and labels before scheduling DAST; the larger-runner job proves the private target path. Missing,
stale, denied, skipped, or partial evidence fails closed.

**Make Azure resource providers ready before dependent provisioning.** Derive and deduplicate the
minimal namespace inventory from every approved bootstrap, state, network, identity, monitoring, and
application resource type. A hosted-runner network always requires at least `Microsoft.Network` and
`GitHub.Network`; include other namespaces only when approved resources use them.

Record whether AzureRM automatic provider registration is enabled and whether the execution identity
has the required subscription registration permission. When automatic registration is enabled and
sufficient for every planned namespace, do not add duplicate explicit registrations. When
`resource_provider_registrations = "none"` or equivalent disables it, explicitly register every
missing required namespace and no unrelated provider.

Provider inventory and registration form a `provider-ready` transition before `bootstrap-local`,
remote state, runner networking, or application resources. An already `Registered` namespace is a
no-op. An absent, unauthorized, `NotRegistered`, `Registering`, `Unregistering`, or failed namespace
blocks every dependent and billable resource. Wait for terminal `Registered` readback and order every
resource directly or transitively after its namespace registration. For the runner stack, all VNet,
subnet, private DNS, private endpoint, firewall, public IP, NAT, NSG, route, and peering resources
depend on `Microsoft.Network`; `GitHub.Network/networkSettings` also depends on `GitHub.Network`.

Treat successful provider registrations as retained subscription capabilities. Prevent repository
teardown from unregistering them: remove only repository-owned resources and record that the
registration may have consumers outside this change. Never infer that an empty resource group or a
partial apply proves provider readiness.

**Register subscription features only for intended capabilities.** A
`SubscriptionNotRegisteredForFeature` response is not permission to register the named feature.
First prove that the approved resource design intentionally uses that capability. If it does not,
correct the resource properties, pinned provider behavior, or API shape and regenerate the no-apply
plan. Do not broaden subscription features merely to make a failed apply pass.

Ordinary Firewall or NAT Standard public IPs do not require BYOIP. If one unexpectedly requests
`Microsoft.Network/AllowBringYourOwnPublicIpAddress` without an approved custom IP prefix, remove
properties that accidentally trigger BYOIP or use a reviewed supported API shape that does not
request BYOIP. Do not register the BYOIP feature as a workaround.

**Validate every network service tag's direction and action before apply.** `AzurePlatformDNS` is a
special outbound tag used only in a Deny rule to disable Azure's default platform DNS; never create an
Allow rule for that tag. When default Azure DNS remains enabled, no explicit NSG allow is required.
When approved custom resolvers replace it, allow TCP and UDP port 53 to the exact resolver addresses
and prove DNS reachability before dependent provisioning.

**Break a private-state bootstrap cycle without transferring state.** Prefer an existing approved
private management path that can reach the remote backend. If none exists and the private backend
cannot be reached until repository networking and its restricted execution runner exist, an explicitly
approved minimum local-state bootstrap may create only those access-establishing resources. Its phase
is `bootstrap-local`, never `remote-ready`, and it cannot authorize application or unrelated
infrastructure provisioning.

Keep that local state encrypted at rest on the approved workstation, excluded from version control,
and under one writer. Record resource identities and a state checksum without state content. Never
copy local bootstrap state through GitHub artifacts, repository secrets, ordinary messaging, or
another unapproved transfer path. Public access to the private state backend remains disabled.

From the exact private execution runner, prove private Blob DNS and authenticated backend access,
initialize the empty repository-owned ZRS backend, and use reviewed declarative imports to adopt every
bootstrap resource without transferring the local state file. Remote import is verified only when
each expected live resource identity appears exactly once in remote state, state locking and Blob
versioning are active, and a clean checkout produces a no-change plan with no create, update, or
destroy action. If any evidence is missing, the retention clock does not start, local state is not
deleted, and normal provisioning remains blocked.

After verified remote import, freeze the encrypted local bootstrap state as read-only evidence for
exactly **30 days**. Retained local state must never run plan or apply. At expiry, securely delete the
encrypted state and every approved temporary copy by destroying the encryption key and removing the
encrypted files with platform-management evidence where available; do not claim unverifiable sector
overwrites on copy-on-write filesystems or SSDs. Record the state identity or checksum, remote-import
evidence, verification and scheduled deletion timestamps, actual deletion timestamp, operator,
method, and outcome. The deletion record must contain no state payload, credential, or secret output.

**Remove in dependency order.** Stop new scheduling and repository access first; delete the larger
runner; remove repository and workflow access; detach and delete the runner group and hosted-compute
network configuration; delete the Azure network setting and wait for its service association to be
removed; only then delete the repository-owned subnet, egress, network, and state resources. Never
report rollback success while a billed or service-associated resource remains.

## Phase 1 — Branching model

- `develop` is the integration branch and the **default branch**. Feature branches (`feat/`, `fix/`,
  `chore/`, `ci/`, `docs/`) branch from `develop` and merge back into `develop` by pull request only.
- `main` is production truth. Every commit on it is a released version. It only ever receives merges
  from `release/**` or `hotfix/**`.
- `release/X.Y.Z` branches from `develop` — cut only by `workflow_dispatch` from an exact named healthy
  SHA, never from a local checkout. Only stabilisation fixes land on it. On completion it merges to
  `main` and back into `develop` so fixes are never lost.
- `hotfix/X.Y.Z` branches from `main`, requires an incident reference, and merges to both `main` and
  `develop` — or into the open release branch if one exists.
- Nobody pushes directly to any protected branch, including me.

### Automated completion without protected-branch bypass

Release and hotfix back-merges use pull requests and the same required checks as every other protected
branch change. Protected branch rulesets keep `bypass_actors: []`; the GitHub Actions bypass applies
only to restricted release-tag creation.

When `GITHUB_TOKEN` creates the back-merge pull request, the coordinating workflow must explicitly
dispatch validation for the sync branch's exact head SHA, wait until every required context is
`success`, verify the head did not move, and merge through the pull-request API. A hotfix targets the
single open release branch when one exists, otherwise `develop`; multiple open release branches are
an ambiguity and must fail. If the token-generated merge suppresses the normal `develop` push
workflow, explicitly dispatch the required deployment or follow-on work for the resulting merge SHA.
Missing, skipped, cancelled or failed checks, a failed dispatch, or an unexpected SHA all fail closed.

## Phase 2 — Release versioning on `main`

Every production merge must produce a real, visible version.

- Semantic versioning. The `release/X.Y.Z` or `hotfix/X.Y.Z` branch name is the single source of truth
  for the version. If an artifact format requires embedded version metadata, derive it from or verify
  it against the branch version during candidate stabilisation; conflicting metadata blocks
  qualification and never becomes a second source of truth.
- Merges into `main` are true merge commits, never squashed, so both parents stay traceable.
- After a successful production deploy — and only then — automation creates an annotated `vX.Y.Z` tag
  on that exact `main` merge commit and a matching **GitHub Release** targeting `main`.
- The Release body must contain: the changelog between the previous tag and this one, the deployed
  artifact digest, the qualified release or hotfix candidate SHA, the production `main` merge SHA,
  the source `develop` SHA the release was cut from, a link to the staging
  qualification run, the **evidence bundle digest** and links to the SBOM and scan reports, the
  **expected signer identity and OIDC issuer** an auditor should pin when verifying, and an AI
  Acceptable Use Policy attestation record. For a hotfix, include the incident reference. Attach the
  **SBOM, the full evidence bundle, the attestation bundle and `trusted_root.jsonl`** as Release
  assets — these are the durable audit record and must not live only in expiring workflow artifacts.
  Publishing the trusted root alongside the bundle is what makes offline, air-gapped verification
  possible; without it an auditor with no network access to Sigstore cannot verify anything.
- Before tagging, validate: the version is valid semver, is strictly greater than the latest tag, does
  not already exist as a tag or Release, and the commit is on `main` and actually deployed. Fail rather
  than tag speculatively.
- Only automation creates `v*` tags. Tags are immutable — never deleted, moved or force-updated. A
  mistaken release is corrected by publishing the next patch version.
- A failed production deploy creates no tag and no Release. That version is burnt; the repair path uses
  the next patch version. Never reuse a burnt version.
- Any commit on `main` without a corresponding `vX.Y.Z` tag is an anomaly — add a check that reports it.

## Phase 3 — Promotion: build once, promote the identical artifact

The artifact is built once per candidate and recorded in a release manifest with its release version,
release branch, candidate SHA, digest, SBOM digest, provenance attestation and scan results. Dev,
Staging and Production all deploy that same digest. Never rebuild per environment; never resolve a
floating tag like `latest`. Configuration differs per environment; the artifact does not.

- **Dev** — every push to `develop` deploys automatically. No gate.
- **Staging** — a push to `release/**` or `hotfix/**` builds the candidate, scans it, generates its
  SBOM, deploys to Staging, then runs the qualification suite and DAST. It records a qualification
  record bound to that exact version, branch, candidate SHA, artifact digest and evidence-bundle
  digest.
- **Production** — merging into `main` promotes. The workflow resolves the already-qualified digest,
  verifies the commit is a true merge that incorporates the exact qualified candidate SHA, and
  verifies the attestation and qualification record bind that candidate to the version, artifact
  digest and evidence digest being promoted. It records the distinct production merge SHA and refuses
  to proceed on any mismatch. Deployment is recorded through a GitHub Environment for the deployment
  history and audit trail only — configure it with **no required reviewers**, so promotion is never
  blocked waiting on a person.
- Promotion is strictly forward. Rollback redeploys a previous release manifest **by digest**, never a
  rebuild, and records which version it rolled back to. Rollback is never gated — see "Roll back
  first, debug later" below.

### Deployment strategy — blue-green mechanism, canary exposure

Two separate decisions, often conflated. Be explicit about both.

**1. Mechanism — how a version replaces another within one deployment unit. Always blue-green.**

- Run the platform in a mode that supports parallel versions (for Azure Container Apps, `Multiple`
  revision mode; for App Service, deployment slots; for Kubernetes, a parallel deployment behind a
  switchable service).
- Deploy the new version alongside the current one at **zero traffic**.
- Qualify it on a **version-specific origin** — its own revision URL or slot hostname — while it still
  serves no users. This is the step that makes the model work: verification happens before any user is
  exposed, not after.
- Only then switch traffic **atomically** to 100% of the new version, setting all prior versions to 0.
- Run post-switch smoke checks. On failure, **restore the previous traffic weights** and set the
  failed version to 0. Rollback is a traffic change measured in seconds, not a redeploy.
- Never leave a deployment unit in a mixed-version state. Two versions may exist simultaneously, but
  only one serves traffic. That guarantee is what lets an auditor ask "what was running at 14:32" and
  get exactly one answer — the attestation and evidence chain depends on it.
- Do **not** use rolling in-place updates. They create a mixed-version window, make rollback slow, and
  break that guarantee.

**2. Exposure — how much traffic sees the new version, and when. Canary before full traffic.**

The Dev → Staging → Production path is already progressive exposure. Canary extends it *inside*
production so that a defect which survived Staging is caught by a small fraction of real users rather
than all of them.

Canary runs **on top of** the blue-green mechanism above — they are complementary, not alternatives.
Blue-green is how a version gets deployed and rolled back; canary is how traffic reaches it.

**The canary sequence:**

1. Deploy the new version at **zero traffic** and qualify it on its version-specific origin, exactly
   as above. Nothing reaches a user until this passes.
2. Deploy a **fresh baseline revision of the current version** alongside it. Compare the canary
   against this baseline, **never against the existing production fleet** — the running fleet has
   warmed caches, longer uptime and settled runtime state, which makes it an invalid control and
   produces false signals in both directions. This is the detail that makes canary analysis
   trustworthy, and the one most often got wrong.
3. **Experiment phase.** Shift a small slice of traffic to the canary and an **equal slice to the
   fresh baseline** — for example 10% canary, 10% baseline, with the remaining 80% still served by the
   current fleet. Equal slices are what make the comparison fair.
4. Hold for a defined **bake window** and run automated analysis over it.
5. **Promotion phase.** On a passing analysis, switch **atomically to 100% canary** and retire both
   the baseline and the old revision.

**Do not ramp the canary and baseline through intermediate steps such as 50/50.** Two reasons. First,
traffic weights sum to 100, so canary 50 plus baseline 50 leaves the original revision at zero — that
moves every user onto two freshly deployed, cold revisions and abandons the warm, proven fleet you
would otherwise fall back to. Second, the baseline is a *control*, not a rollout vehicle; its only job
is to match the canary's slice size. The comparison is either statistically valid at the experiment
slice or it is not, and a larger slice does not rescue an invalid one — it only exposes more users.
Go from the experiment slice straight to the atomic switch.

**Analysis and gating:**

- Compare error rate, latency (p50, p95, p99) and saturation between canary and baseline over the
  bake window, against explicit, committed thresholds.
- **Advancement must be fully automated.** There is no reviewer on these repositories, so a canary
  that waits for a human to click "promote" is not a control — it is a pause. Encode the decision.
- **Fail closed.** If metrics are missing, the analysis cannot reach a conclusion, or the bake window
  times out, **roll back** — never advance on absent evidence. A canary that proceeds when it cannot
  measure anything is the fail-open pattern in a different costume.
- Any threshold breach triggers an **immediate rollback to 100% previous version** — restore the
  original revision's weight and set canary and baseline to 0.
- Record the canary analysis result — thresholds, observed values, decision — in the evidence bundle
  for that release.

**Size the canary to the traffic that actually exists.** The bake window must be long enough for the
slice to produce a meaningful sample; a five-minute window on a service with a handful of requests
proves nothing and merely delays the release. State the assumed traffic volume and the resulting bake
window explicitly, and if the service is too quiet for a canary slice to be meaningful, say so and use
a single atomic switch with instant rollback instead — but say it, rather than shipping a canary that
is statistically empty.

Where more than one region or deployment unit exists, prefer making the **first unit** the canary
(Microsoft's Azure Safe Deployment Practices model — Canary → Pilot → Broad, each a region with its
own bake time) over splitting traffic within a single unit. A failure is then contained to one unit,
and rollback is a traffic switch you have already tested.

### Roll back first, debug later

This is the single most valuable deployment practice at any scale, and it is policy here, not advice.

- When canary analysis fails or post-switch checks fail, **restore traffic to the previous version
  immediately.** Do not investigate first. Do not "just check one thing." The rollback is a
  traffic-weight change measured in seconds — it costs almost nothing, and the exposure window while
  you diagnose costs users.
- **Retain the failed revision at zero traffic** for forensics. It serves nobody but remains available
  for inspection, along with logs and telemetry captured during the exposure.
- **Never forward-fix under pressure.** The next patch version, through the normal gated path, is the
  only route back. A hotfix that skips the gates to resolve an incident faster is how an incident
  becomes two incidents.
- **Rollback must never be gated.** It requires no approval, no qualification record, and no ruleset
  bypass — it redeploys an artifact that already passed every gate. Verify that the rollback path
  genuinely works, and rehearse it, before requiring anything that depends on it.
- Automated rollback is the default path; a manual rollback workflow exists as a backstop and takes an
  incident reference.

If the target platform cannot support parallel versions, say so plainly and describe what you
implemented instead — do not silently fall back to an in-place update and call it a deployment.

### Runtime monitoring and alerting

The security pipeline proves the artifact was sound when it shipped. Monitoring is what tells you the
running system is sound now. Both are required; neither substitutes for the other.

**Alerting is infrastructure as code.** Define every alert rule, action group and routing target in
the same IaC as the resources they watch, reviewed and versioned alongside them. Never configure an
alert by hand in a portal — a hand-made alert is invisible to review, absent from a rebuilt
environment, and lost when a resource is recreated.

**Route everything to Slack, and route by severity.** Use a single action group per environment with
a Slack webhook receiver, and separate channels by severity so that noise and urgency do not share a
destination:

- **Sev 1 — service down or failing.** Sustained 5xx rate, container restart loop, health probe
  failing, database unreachable. Goes to an alerting channel that is expected to interrupt someone.
- **Sev 2 — degraded or trending toward failure.** Saturation (CPU, memory, storage, connection
  pool), elevated latency, queue depth growing, certificate or secret expiring within a defined
  window. Goes to a lower-urgency channel.
- **Sev 3 — informational.** Deployment started and finished, canary promoted or rolled back,
  scheduled re-scan found a new CVE in a released artifact. Goes to a log channel — useful context,
  never an interruption.

Include environment, resource, severity, the firing condition with its observed value, and a direct
link to the resource and to the relevant dashboard in every message. An alert that says only
"something is wrong" costs more time than it saves.

**Cover every component that can fail independently**, not just the application:

- **Web / frontend** — availability from outside the network, 5xx rate, and a synthetic check of the
  real user-facing hostname rather than an internal origin.
- **API / backend** — 5xx rate, p95 latency, restart count, health and readiness endpoint failures.
- **Database** — availability, storage percentage, CPU, connection saturation, replication lag,
  and **backup success**. A failed backup is silent until the day it matters.
- **Cache / session store** — memory saturation and error rate. Where sessions or sign-in depend on
  it, treat its failure as Sev 1: cache availability *is* authentication availability.
- **Messaging and communication services** (managed email/SMS/push services such as Azure
  Communication Services, and message brokers such as Service Bus, Event Hubs, SQS or Kafka) —
  delivery failure rate, queue depth, dead-letter count, and throttling. These fail quietly and are
  usually discovered by a user reporting a message that never arrived, which is far too late.
- **Ingress / CDN / gateway** — origin health, TLS certificate expiry, and 4xx/5xx at the edge, which
  catches failures that never reach the application at all.
- **Identity and secrets** — secret, certificate and credential expiry, with enough lead time to act.
- **Cost** — a budget threshold alert. A runaway cost is an incident, and it is often the first
  visible symptom of a runaway process.

**Alert on symptoms, not causes.** Alert on what a user would notice — requests failing, requests
slow, messages not delivered. Resource-level signals belong to dashboards and to Sev 2 at most. A page
per underlying cause produces a flood during a single incident.

**Every alert must be actionable.** If nobody would do anything when it fires, it is a dashboard
metric, not an alert. Thresholds should be deliberately loose enough that a normal day is quiet: an
alert that fires routinely gets muted, and a muted alert is worse than no alert because it looks like
coverage while providing none.

**Alerting must not fail open** — the same defect class as a fail-open CI check, and considerably
harder to notice, because an environment with no alerts looks exactly like an environment with no
problems:

- Never make alert creation conditional on an optional variable being set. A pattern such as
  `count = var.alert_webhook != "" ? 1 : 0` means a missing value silently produces an environment
  with no alerts at all. Make the routing target **required**, and fail the deployment if it is
  absent.
- Verify after deploy that the expected alert rules exist and are enabled, and fail the deployment if
  any are missing. Treat a missing alert rule as a failed deployment.
- **Add a heartbeat.** Emit a scheduled signal that proves the whole path — metric to rule to action
  group to Slack — is alive, and alert on its *absence*. Without one, a broken webhook is
  indistinguishable from a healthy system.
- **Test that each alert fires**, exactly as required checks must be proven to go red. An alert that
  has only ever been seen quiet has never been shown to work. Record the test.

**Wire alerting into the deployment path.** The canary analysis in the previous section reads the same
signals: use one definition of healthy so that the thresholds gating a canary and the thresholds
paging a human cannot drift apart. Announce deployment start, canary decision and rollback to Slack —
correlating "it broke" with "we shipped" is the single most useful piece of incident context.
Alert noise should be suppressed for the deploying resource during an expected restart, but never
suppressed globally.

Feed Defender for Cloud and Microsoft Sentinel where configured, and route their high-severity
findings to the same Slack destinations, so security and availability alerts reach one place rather
than two.

#### Service health model — know the state of everything, to recover quickly

Alerting tells you something broke. A health model tells you **what state every component is in right
now**, which is what recovery actually requires. Build both.

- Give **every component a machine-readable health state** — the web frontend, each API, the
  database, the cache, messaging and communication services, storage, ingress, and every managed
  cloud dependency. Not just "the app is up".
- Distinguish **shallow from deep checks**. A liveness endpoint that returns 200 from the process
  proves the process is running. A readiness or deep check must exercise the real dependency path —
  a database round trip, a cache read, a token acquisition — because "the API is up but cannot reach
  the database" is the state you most need to see, and the one a shallow check hides.
- **Aggregate into one view** showing, per environment, every component and its state, the deployed
  version and artifact digest, and when it was last checked. During an incident the first question is
  always "what is broken and what is fine", and answering it by opening six consoles costs the
  minutes that matter.
- **Record dependencies** so the view shows blast radius and recovery order. If the database is down,
  the APIs depending on it are *consequences*, not separate incidents. Without this, one failure
  presents as ten alerts and the actual cause is guesswork.
- Report each component's **currently deployed version and digest** alongside its health. Recovery
  decisions turn on whether a component is running what you think it is running, and this is also
  what makes "roll back first" actionable.
- The health view must be **queryable when things are broken**. Do not host it inside the system it
  monitors, and do not let it depend on that system's database or identity provider. A status page
  that goes down with the service is worse than none, because its silence is ambiguous.
- Expose it as **structured data, not only a dashboard**, so the deployment pipeline, the canary
  analysis and the alert rules can all consume the same health definition rather than each
  maintaining a private one.
- Also surface **cloud provider platform status** for the regions and services you depend on. A
  provider-side incident needs a different response from a defect you shipped, and telling them apart
  early prevents a pointless rollback.

#### Delivery performance — the DORA four keys

Measure delivery performance using Google's DORA metrics, and derive them from the events this
pipeline already emits rather than from a separate system:

| Metric | Derive from |
| --- | --- |
| **Deployment frequency** | Successful production deployments recorded through the GitHub Environment |
| **Lead time for changes** | Commit timestamp on `develop` → production deployment of the release containing it |
| **Change failure rate** | Releases that triggered a rollback, a canary failure, or a hotfix, over total releases |
| **Failed deployment recovery time** | Failure detected → traffic restored to the previous version |

Every input already exists: GitHub deployments and Releases, the tag and its timestamp, canary
analysis decisions, rollback records with their incident references, and alert firing and resolution
times. Nothing new needs instrumenting — the work is to make those events queryable and to publish the
trend. Compute the metrics on a schedule and post the trend to the Slack log channel.

Note the current definitions: **Failed Deployment Recovery Time** is DORA's renaming of what was
called MTTR, and it deliberately scopes to recovery from a failed deployment rather than to all
incidents. Track recovery from non-deployment incidents too, but do not conflate the two.

**Change failure rate and failed deployment recovery time are the pair that matters most here.**
They are DORA's stability measures, and they are exactly what the blue-green, canary and instant
rollback design exists to improve. A rising change failure rate means the Staging gate is not
catching what it should; a rising recovery time means the rollback path has decayed. Both are early
warnings that a control has stopped working, visible long before an incident proves it.

**Use these as trend indicators for this repository, not as targets or as comparisons between teams
or people.** DORA's own 2025 guidance dropped the Elite/High/Medium/Low ranking in favour of context —
and a metric that becomes a target gets gamed. Deployment frequency in particular is trivially
inflated and means nothing on its own; it is only informative alongside the stability pair.

## Phase 4 — Security pipeline

Pipeline stages: Secret Scanning → SCA → SAST → IaC → Container → DAST → Continuous → Compliance.
Implement every stage that applies, mapped to the trigger where it can actually run.

**Use exactly these tools. Do not add alternatives that duplicate them.**

| Job | Tool |
| --- | --- |
| Secrets | GitHub Secret Protection — push protection, Copilot secret scanning, custom patterns |
| SCA | Dependabot + Dependency Review |
| SAST | CodeQL + Copilot Autofix |
| IaC | Checkov — covers Terraform, Kubernetes, Dockerfiles, Actions, ARM/Bicep |
| Container + SBOM | Trivy — image scanning and CycloneDX SBOM. **This is the blocking gate.** |
| Risk prioritisation | Grype (pin >= v0.88.0) — consumes the SBOM, ranks by CVSS + EPSS + CISA KEV. **Never gates.** |
| DAST | OWASP ZAP |
| Provenance | GitHub artifact attestations (L2) and `slsa-github-generator` (L3) |
| Posture | OSSF Scorecard |

Explicitly excluded as duplicates — do not reintroduce: tfsec (deprecated, merged into Trivy),
Terrascan, Kics, Template Analyzer, IaCFileScanner, Kubesec, Syft, Microsoft sbom-tool, Gitleaks,
Semgrep, Burp Suite (no CLI, cannot be automated), and the MSDO wrapper (it re-runs Checkov and Trivy
a second time). **Keep `trivy config` disabled** — Checkov owns IaC, Trivy owns images.

**Trivy and Grype are not duplicates and must not be run as two gates.** Trivy core has no EPSS or
CISA KEV support and its maintainers consider it out of scope, so exploitability-based ranking is a
genuine capability gap rather than overlap. Give them strictly separate roles: Trivy is the blocking
gate; Grype is a non-gating prioritiser that consumes the SBOM Trivy produced and reports what is
actually being exploited in the wild. Maintain exactly one allowlist, owned by Trivy. If Grype ever
starts failing builds, the design has been broken — two gates means double triage, and with no
reviewer that is how a gate gets disabled.

Stage mapping:

- **PR into `develop`** — secret scanning, dependency review, CodeQL, Checkov, and an action
  SHA-pinning check. Source-level only. Keep it fast; a slow PR gate gets worked around.
- **Push to `develop`** — the above, plus build the artifact, generate its SBOM from the built image
  rather than the source tree, scan the image with Trivy, and attest provenance at **SLSA Build L2**
  using `actions/attest-build-provenance`.
- **`release/**` and `hotfix/**`** — the full gate, all bound to the promoted digest: Trivy scan of
  that exact digest, SBOM, **SLSA Build L3** provenance via `slsa-github-generator`, OSSF Scorecard,
  deploy to Staging, then OWASP ZAP against the deployed instance on the VNet-injected GitHub-hosted
  larger runner. DAST needs a running application and belongs here and nowhere else. Also run Grype
  against the candidate SBOM to produce an exploitability-ranked risk report for the Release body —
  report only, never blocking. The qualification record must not be issuable if any of the gating
  checks fail.
- **`main`** — verification only. Verify the L3 attestation, SBOM digest and qualification record all
  bind to the digest being promoted. No new scans; re-scanning would describe a rebuilt artifact.
- **Scheduled** — re-scan released artifacts by running Grype against their **stored SBOMs**, which
  needs no rebuild and no image pull, and re-scan the live production digest with Trivy. A CVE
  published after release makes the deployed artifact vulnerable with no code change. Raise an issue on
  new CISA KEV entries, high-EPSS findings, or new HIGH/CRITICAL severities. Feed Defender for Cloud and
  Sentinel if configured.

Gating and evidence:

- Fail on **fixable** HIGH and CRITICAL findings. Upload SARIF from every scanner so results appear in
  the Security tab rather than buried in logs.
- Suppressions are explicit and expiring: a committed allowlist with a reason and expiry per entry, and
  the pipeline fails when an entry expires. Never suppress by lowering the global severity threshold.
  With no reviewer, an unbounded allowlist is how a gate quietly becomes decorative.
- Commit an **AI Acceptable Use Policy** document. It is a documented policy and an attestation
  recorded in the Release, not an automated check.
- Every scan emits a stable, named status check suitable for requiring by ruleset.

**The SLSA L3 generator is the one approved exception to SHA-pinning.** The official
`slsa-github-generator` reusable workflow invokes mutable `@main` references internally, so pinning
the outer workflow by SHA cannot make the whole call graph immutable. Resolve the conflict narrowly:

- Keep **SLSA Build L3** for release candidates. Do not downgrade to L2 to satisfy the pinning rule.
- Pin the outer reusable workflow as tightly as the generator supports.
- Record an **explicit, narrow, expiring action-reference exception** naming that exact workflow,
  reason, expiry and introducing commit. This is distinct from vulnerability acceptance; Trivy
  remains the sole owner of vulnerability allowlisting and Grype remains non-gating.
- The SHA-pinning check must allow this single exception by exact name, fail when it expires, and keep
  failing on every other unpinned reference. A wildcard, blanket exemption, differently named
  workflow or disabled check is invalid.
- Re-evaluate at each expiry; remove the exception if the generator gains pinned internals.

### Audit evidence — every stage must produce a durable, reviewable report

An auditor must be able to answer, years after the fact: what was scanned, when, with which tool and
which vulnerability database, what was found, what was accepted and on whose authority, and proof that
the report describes the artifact that actually shipped. Design for that, not for a dashboard.

Three tiers, because retention and mutability differ:

1. **Live triage — code scanning.** Every scanner uploads SARIF to GitHub code scanning. This is the
   working view for fixing things. It is mutable live state — alerts get dismissed and resolved — so
   it is never sufficient as the audit record on its own.
2. **Run evidence — job summaries and workflow artifacts.** Every security job writes a rendered
   human-readable summary to `$GITHUB_STEP_SUMMARY` and uploads its raw output as a workflow artifact.
   Useful for debugging. Actions artifacts expire, so never treat them as the audit record.
3. **Release evidence — the durable record.** For every release candidate, assemble one **evidence
   bundle** and attach it to the GitHub Release. Release assets do not expire. This is the audit record.

The evidence bundle contains, for each pipeline stage:

- The raw machine-readable output exactly as the tool produced it (SARIF, CycloneDX, JSON).
- A rendered human-readable summary an auditor can read without tooling.
- A metadata record: tool name, **tool version, vulnerability database version and its timestamp**,
  the exact command line, start and end time, exit status, and the workflow run URL. A finding count
  is meaningless without the database version behind it — always record it.

And at bundle level:

- The artifact digest, qualified candidate SHA, production `main` merge SHA, source `develop` SHA,
  release version and branch.
- A `manifest.json` listing every file with its SHA-256.
- The suppression allowlist exactly as it stood at that moment, with each entry's reason, expiry and
  the commit that introduced it.
- The DAST result, the Grype exploitability report, and the staging qualification record.
- The **attestation bundle** and **`trusted_root.jsonl`**, so the bundle carries everything needed to
  verify itself without network access to GitHub or Sigstore.
- A `VERIFY.md` giving the expected OIDC issuer and certificate identity pattern, plus the exact
  commands for both verification paths. The bundle must be self-describing: an auditor who receives
  it on a USB stick, with no other context, should be able to verify it.

**Bind the bundle to the artifact.** Attest it with GitHub artifact attestations so
`gh attestation verify` proves the bundle belongs to that exact digest. An unbound report proves
nothing — an auditor cannot otherwise tell whether it describes what shipped. Record the bundle's own
digest in the release manifest and in the Release body.

**Point the gate at the evidence.** The staging qualification record must reference the evidence
bundle digest, so the single check that permits production is traceable to the complete evidence set.

**Do not archive every pull request scan.** That is noise and it is not what auditors ask for. That the
gate was continuously enforced is evidenced by the rulesets in git, the committed observed-contexts
file, and GitHub's own check-run history. Permanent evidence is required for what shipped.

**Scheduled re-scans produce dated reports too.** When Grype re-scans a stored SBOM and finds a new
CVE, file that report against the release it affects, so the record distinguishes what was known at
release time from what emerged later. An auditor reads that as diligence, not as a failure.

**External auditors have no GitHub access.** Evidence must therefore be independently verifiable by
someone outside the organisation, and by someone who cannot be given a GitHub account:

- Publish the **attestation bundle itself** as a downloadable Release asset, not only through the
  GitHub attestation API, which requires authentication. GitHub attestations are recorded in
  Sigstore's public transparency log, so an auditor holding the bundle and the artifact digest can
  verify the whole chain against public infrastructure with no access to this repository and no
  account here. Preserve that property deliberately — it means the auditor never has to trust any
  system of ours, including any portal we build.
- Also publish **`trusted_root.jsonl`** (from `gh attestation trusted-root`) as a Release asset.
  Without it, offline and air-gapped verification is impossible, which is exactly the environment a
  defence-sector auditor is likely to be working in.
- **Document the expected signer identity** in `docs/security/audit-evidence.md`: the OIDC issuer
  (`https://token.actions.githubusercontent.com`) and the exact certificate identity pattern for the
  workflow that signs. A verification that does not pin the expected identity proves only that
  *somebody* signed something — an auditor could accept a perfectly valid signature from an unrelated
  repository. Pinning the identity is what makes the check meaningful.
- Give auditors **both** verification paths, since they will not all have the same tooling:
    - `gh attestation verify <artifact> --bundle <bundle> --custom-trusted-root trusted_root.jsonl`
    - `cosign verify-blob-attestation --bundle <bundle> --new-bundle-format --certificate-oidc-issuer <issuer> --certificate-identity-regexp <pattern> <artifact>`
  The cosign path needs no GitHub tooling or account at all and is the vendor-neutral option. Note
  that cosign is **not** used in the pipeline itself — signing is handled by the GitHub attestation
  actions, and cosign is purely an auditor-side verification tool. Do not add a cosign installer to CI.
- Give the evidence bundle a **stable, versioned schema** — include `schema_version` in
  `manifest.json` — so a downstream reader can parse releases from different points in time without
  special-casing each one.
- Assume the bundle will be mirrored into a read-only auditor portal. That portal is a **projection**;
  this repository's Releases and attestations remain the system of record, and the portal must be
  fully rebuildable from them at any time. Never make the pipeline push findings into an external
  database as their primary home, and never make a green portal a precondition for release.

## Phase 5 — Governance as code

Commit each ruleset as JSON under `governance/rulesets/`, each the exact payload accepted by
`POST /repos/{owner}/{repo}/rulesets`. These files are the reviewable source of truth.

1. **Protected branches** — `develop`, `main`, `release/**`, `hotfix/**`: `bypass_actors: []`, deletion
   and non-fast-forward blocked, required status checks with `strict_required_status_checks_policy: true`
   and `do_not_enforce_on_create: true`, and a pull request rule configured for a single maintainer —
   `required_approving_review_count: 0`, `require_code_owner_review: false`,
   `require_last_push_approval: false`, `dismiss_stale_reviews_on_push: true`. The pull request
   requirement exists to force the checks to run, **not** to obtain anyone's approval. Do not raise the
   approval count.
2. **Main release gate** — a `main`-only ruleset requiring the staging qualification check, kept
   separate so it is not demanded of `develop` or the release branches.
3. **Release tag creation** — `refs/tags/v*`, creation restricted, with the **GitHub Actions app** as
   the only bypass actor.
4. **Release tag immutability** — `refs/tags/v*`, deletion and non-fast-forward blocked, no bypass
   actors.

Add an idempotent script that applies these via `gh api`, resolving actor IDs at run time rather than
hard-coding them. Running it twice must be a no-op.

**Fail-closed sequencing.** Required status checks must be real job names you have already observed run
green. Author the workflows, merge them, confirm the exact context strings from
`gh api repos/{owner}/{repo}/commits/{sha}/check-runs --jq '.check_runs[].name'`, and only then install
the rulesets. Requiring a context that has never appeared blocks every merge including the fix — and
with no reviewer and no bypass actors, there is no manual escape. Commit the observed contexts as
evidence.

A required check that is skipped stays pending forever and deadlocks the ruleset. Every required job
must reach a terminal conclusion on every triggering event, including a deliberate successful
"nothing to do" path. Before scheduling DAST, run a preflight on a standard hosted runner that verifies
the exact VNet-injected larger runner assignment and labels are visible to the repository. If the API
cannot be read, the assignment is absent or the labels differ, fail loudly without scheduling DAST.
The aggregate qualification check must then treat the skipped DAST dependency as not successful
rather than hang pending or report success.

**No required check may fail open.** A check that reports success when it could not actually do its
job is worse than no check at all, because it manufactures false assurance and nothing ever looks
wrong. Audit every required check against these patterns and fix any you find:

- `continue-on-error: true` on a job or step that a required check depends on.
- `|| true`, `|| echo`, or a trailing `exit 0` on a command whose failure is the thing being detected.
  These are legitimate for diagnostics and cleanup; they are never acceptable on a validating command.
- Missing `set -euo pipefail` in a validation script, or a pipeline whose real exit status is masked
  by a later command in the pipe.
- **Vacuous passes** — the most common and least visible case. A validation that iterates over files
  and finds none, a `grep` that matches nothing, or a check guarded by `if [ -f ... ]` that silently
  skips when the input is absent, all report success while having verified nothing. Every such check
  must assert that it actually found something to inspect, and fail if its input set is unexpectedly
  empty.
- An aggregator job using `if: always()` that tests only for `failure`. A dependency that is
  `skipped` or `cancelled` is not `success` — compare explicitly against `success` for every needed
  job, never against `failure`.

**Prove each check fails.** Observing a check run green establishes only that it can pass; it does not
establish that it can fail. Before requiring a check, run it once against a deliberate violation and
confirm it goes red — a malformed branch name, an unpinned action, a known-vulnerable dependency, a
planted dummy secret. Record that negative result alongside the observed contexts. A check that has
only ever been seen passing has never been shown to work at all.

Treat a discovered fail-open as a real defect even when nothing is currently broken, because by
definition it produces no symptom until the moment it matters. If changing `.github/workflows/` is
itself gated and you cannot land the fix in this session, **file a GitHub issue describing the exact
defect, the affected checks, and the reproduction — do not silently leave it undocumented.**

## Phase 6 — Documentation

- `docs/operations/github-governance.md` — the exact required contexts, which ruleset requires what,
  and why. Keep it in step with the JSON.
- `CONTRIBUTING.md` — branching model, branch naming, commit and PR conventions, how to cut a release.
- `docs/security/scanning.md` — the tool set, the stage mapping, and the suppression policy.
- `docs/operations/alerting.md` — every alert rule, its severity, its threshold and the reasoning
  behind it, the Slack routing per severity, and how to verify the alert path end to end.
- `docs/operations/service-health.md` — every component, its health endpoint, what its deep check
  actually exercises, its dependencies, and the recovery order implied by them. This is read during
  an incident, so write it to be scanned under pressure, not studied.
- `docs/security/audit-evidence.md` — where evidence lives, what the evidence bundle contains, the
  **expected OIDC issuer and certificate identity pattern**, and the exact commands an auditor runs to
  retrieve a release's bundle and verify its attestation independently, without needing me. Give both
  the `gh attestation verify` and the `cosign verify-blob-attestation` paths, and state explicitly
  that verification which does not pin the expected identity proves only that *somebody* signed
  *something* — a valid signature from an unrelated repository would otherwise pass.
- `docs/ai-acceptable-use.md` — the AI acceptable use policy.
- `docs/runbooks/` — break-glass, production rollback, failed-release repair, and canary failure. The
  rollback runbook must state that rollback is ungated and requires no approval, and must have been
  rehearsed rather than merely written. The break-glass runbook matters most: with no reviewer and no
  bypass actors, I need a written, logged way back in.

## Deliverables

1. Phase 0 classification and proposed plan — **stop and get my approval.**
2. A PR adding workflows, `governance/rulesets/*.json`, the apply script, docs and runbooks.
3. Evidence every required context ran green, with the exact context strings quoted, **and evidence
   that each one goes red against a deliberate violation.**
4. Rulesets installed only after (3), then re-verified by reading the live rulesets back.
5. A summary of what is enforced, what is advisory, and what was skipped for this repo and why.

## Constraints

- Never weaken or delete an existing protection to make something pass. Raise it with me instead.
- Never force-push, delete or rewrite a protected branch or an existing tag.
- Never enable a ruleset whose required contexts have not been observed green.
- Never propose org-level rulesets, org-level required workflows, or org-wide App installations.
  Everything is repository-scoped by design.
- Prefer fewer genuinely enforced controls over a large set that gets bypassed. Tell me honestly which
  controls would be theatre in this repository.

## Liftoff activation protocol

This policy is a generated local handoff. Its presence does not mean that any
branch, check, ruleset, security feature, environment, deployment, monitor, or
alert is active.

### Prerequisites

Do not begin activation until the repository is committed, pushed, and
resolvable as a GitHub repository. If any prerequisite is missing, report it and
stop without mutation.

### Read-only Phase 0

Inspect and report all of the following with evidence before changing anything:

1. Repository owner/name, remote identity, visibility, default branch, current
   local branch, working-tree state, and current `main` tip.
2. Artifact forms, languages, package managers, manifests, locks, build
   commands, test commands, lint commands, generated environments, health
   endpoints, and operations or infrastructure files.
3. Existing local and remote refs, GitFlow compatibility, workflows, exact job
   and check-run names, rulesets, tags, releases, GitHub Environments, deployment
   history, and rollback paths.
4. Secret Protection, Dependabot, Dependency Review, CodeQL, Copilot Autofix,
   Checkov, Trivy, Grype, ZAP, attestations, SLSA, Scorecard, licenses, and every
   required input or suppression policy.
5. Whether private Staging DAST applies; the exact GitHub-hosted larger runner
   group and labels when present; its repository and workflow assignment; whether
   its Azure VNet injection can resolve and reach Staging; and whether a standard
   hosted preflight can verify the assignment before DAST is scheduled.
6. When DAST applies but no suitable assignment exists: Staging subscription,
   tenant, region, organisation and Azure write authority, enterprise network
   policy, billing, state, deterministic names, address space, route or peering,
   private DNS, inbound denial, strict-domain-egress requirement, explicit
   Firewall Basic or NAT Gateway mode, costs, limits, teardown ownership, remote
   backend reachability, any bounded local-bootstrap need, state custody, remote
   import evidence, the fixed 30-day deletion schedule, minimal Azure namespace
   inventory, AzureRM registration mode, registration permission, and terminal
   provider readiness.
7. Live deployment mechanisms, parallel-version support, version-specific
   origins, traffic volume, statistically valid canary capacity, and provider
   status sources.
8. Monitoring signals, alert rules, severity routing, Slack delivery,
   heartbeat coverage, alert-fire tests, dashboards, shallow/deep component
   health, dependency graph, recovery order, deployed versions/digests, and DORA
   event sources.
9. Which settled platform defaults apply to components the workload actually
   uses, the cost and known service limits of every required managed service, and
   any live-resource drift that requires a refactor-and-import reconciliation
   plan.

Report every gap, blocker, inapplicable control, and GitFlow-versus-continuous-
delivery conflict. Propose the current `main` SHA as the activation baseline for
an existing repository and provide an ordered implementation plan.

**STOP FOR EXPLICIT USER APPROVAL.** Phase 0 is read-only. Before approval, do
not write files, create a framework change, branch, commit, tag, release,
workflow, environment, ruleset, issue, deployment, cloud resource, monitor,
alert, or Slack route.

### Post-approval implementation

After approval, create a new governance change using the project's selected
OpenSpec or Spec Kit workflow. The generated Liftoff policy remains an input;
Liftoff does not own, name, restore, or recreate that active change.

When the approved plan includes the runner provisioning exception, treat it as
a fail-closed state machine. Use an existing private state path when available;
otherwise progress through approved minimum `bootstrap-local`; delegated private
namespace inventory and `provider-ready`; subnet and exactly one explicit egress
mode; Azure network setting and GitHub ID;
organisation network configuration; selected-access group; bounded larger
runner; private backend proof; declarative remote import; identity, locking,
versioning and clean no-change verification; remote-ready state; private DNS and
live Staging reachability; then DAST eligibility. Freeze verified local state
read-only for 30 days and delete it with evidence at expiry. Stop at the first
failed transition and reconcile or remove partial resources in reverse
dependency order.

Author workflows, exact ruleset payloads, runbooks, and documentation first.
Observe every proposed required context green on all applicable paths, then
prove that exact context deliberately red with a controlled violation. Treat
skipped or cancelled dependencies as not successful. Apply repository-scoped
rulesets idempotently last, then read the live rulesets and required contexts
back from GitHub.

Record the explicitly approved pre-governance `main` SHA in the user-owned
`governance/activation-baseline.json`. If `main` advanced since Phase 0, stop
and obtain a newly discovered and approved baseline. Apply release/tag anomaly
checks only to governed production commits after that SHA. Never invent a
historical release, move a tag, rewrite history, or treat the activation record
as Liftoff-owned.
