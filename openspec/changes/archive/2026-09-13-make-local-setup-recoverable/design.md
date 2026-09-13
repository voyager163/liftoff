## Context

See `proposal.md` for the expanded scope. The user explicitly replaced the former stateful plan-only limit: this change now implements the approved cloud/governance activation journey and supported stateful migrations as well as local repair.

The current implementation already has useful safety primitives: a canonical activation graph, source-bound evidence, project mutation locks, isolated framework staging, reviewed update receipts, and recoverable filesystem transactions. It lacks production producers and public approval/credential paths for much of the graph. Completing those paths also requires correcting dependency and mutation declarations: workflow publication, credential verification, immutable image production, and deployment cannot be left in circular or read-only-only phases.

Relevant seams are:

- `src/domain/governance/activation/` and `src/governance-activation/commands.ts`: readiness, phase capabilities, verification, and execution.
- `src/domain/project/infrastructure-layout.ts`: an active retired flat-root record currently wins over independent-root records, without a repair mechanism to supersede it.
- `src/application/update/planning.ts` and `src/governance-assessment/project.ts`: different builders currently produce different expectations for the same managed governance context.
- `src/workstation.ts`: generic prerelease rejection, punctuation-sensitive version extraction, and a post-install branch that converts every unresolved result into `restart-required`.
- Agent catalogs, `src/framework-adapters.ts`, `src/openspec-profile.ts`, and governance artifact inventories: closed two-agent assumptions.
- `src/adapters/filesystem/reviewed-update-transaction.ts`: exact-plan approval, preconditions, journaling, and rollback infrastructure to reuse rather than bypass.

All implementation and fixtures belong to this repository. A downstream application used to discover the failures is not an implementation or test target.

## Goals / Non-Goals

**Goals:**

- Make the single native setup entry point a finishable end-to-end journey with separately observable local-ready, migration, activation, and lifecycle milestones.
- Implement production execution and verification for the supported Azure/GitHub governance profile, not just new status labels or an empty activation entry point.
- Execute approved local repairs and supported stateful migrations rather than prescribe manual folder, state, or machine-metadata edits.
- Require complete scope, supported transformation, independent observations, and the appropriate local, state-read, state-write, publication, credential, or infrastructure authority.
- Preserve project customizations, ownership, original provenance, and immutable activation history.
- Give Copilot, Claude, and Codex equivalent capabilities through their actual native integration surfaces.
- Make diagnosis and remediation agree across setup, doctor, update, and assessment.

**Non-Goals:**

- Performing live operations while editing these planning artifacts; deployment and migration need later implementation and their own runtime approvals.
- Executing arbitrary provider/backend combinations or ambiguous mappings merely because the user selected a broad setup goal. Azure remains the implemented cloud provider; AWS/GCP remain planned.
- Treating stateful migration as permission to replace or destroy live resources, bypass backend locking, force-push state, or overwrite concurrent changes.
- Treating a missing local state file, a generated context label, a checked task, or a developer assertion alone as proof of no deployment.
- Replacing a customized application or infrastructure tree with the newest starter, upgrading provider majors as a side effect, or making `update --force` a repair shortcut.
- Removing agents, changing the selected spec workflow, converting retired workloads, or performing unrelated workload/runtime migrations.
- Changing Copilot's updater, automatically downgrading an agent, or weakening tested runtime/framework constraints.

## Decisions

### 1. One journey with explicit effect scopes and completion milestones

Register one explicit local phase set: `seed-valid`, `seed-verified`, and `seed-archived`. The last ID retains its existing Spec Kit finalization meaning; Spec Kit does not acquire an OpenSpec archive operation.

Add explicit `local`, `activation`, and `lifecycle` scopes to governance operations. Direct invocations continue to default to activation. The generated setup integration starts with local inspection, offers supported repairs, and then presents the activation plan instead of stopping permanently at local readiness. It proceeds through actual activation only after the relevant approvals. An explicit local-only request or declined activation approval leaves local completion intact without claiming deployment.

Local completion requires valid current project/framework integrations, compatible selected agents and required local tools, and fresh successful proof for the local phase set. Scope is enforced before planning and before execution: a local-scoped command cannot commit, push, or mutate providers even if another approval exists. If a stateful repair is required before local conformance can be reached, the journey offers a distinct approved migration branch; it never disguises that branch as local-only work.

Activation completion means the approved application is deployed and the required governance controls have current successful qualification and matching live readback. A generated workflow, submitted deployment, repository setting write acknowledgement, or simulated check is insufficient. Delayed retained-state disposal is a separately tracked lifecycle obligation, not a mandatory 30-day wait before reporting successful activation.

Schema-2 governance results contain:

- `scope`, `journey`, `localSetup`, `migration`, `activation`, and `lifecycle`, with explicit requested scope, status/completion, pending approvals, external waits, and relevant blockers.
- `consistent` separately from completion, where applicable.
- `nextPlannablePhase`, approval status, and selected-scope `nextReadyPhase`; `selectedPhase` and `executedPhase` keep their attempted/successful meanings.
- The running CLI identity and actual project boundary, distinct from recorded generator and activation-package versions.
- Structured supported next actions, including executable, argument array, working directory, effect scope, and approval requirement.

Legacy summary fields remain aliases of the explicitly selected scope: verification `ok` means `consistent`, `complete` means selected-scope completion, and `setupStatus` describes that scope's progress. A full setup request is complete only when its requested immediate work, including activation and any required migration, is verified. Local-only completion is not presented as completion of a full journey. Declined approval, insufficient platform permissions, unsupported inputs, and unavailable execution hosts remain honest resumable boundaries.

Successful status, plan, and resume inspection returns exit 0 even when it reports incomplete work. Schema-2 verify returns 0 for a consistent completed selected scope, 2 for consistent but incomplete scope, and 1 for inconsistency or inspection failure. Setup integrations interpret exit 2 as incomplete progress, not automatic failure or permission to mutate; they select only a separately reported supported ready action. Scope-specific consistency excludes unmet future activation requirements but never hides malformed shared identity, graph, or state.

After an execution attempt, inspect current state before reporting next readiness. If an operation committed but that inspection fails, report the committed outcome and indeterminate readiness; do not echo the executed phase or turn the result into success-shaped readiness. Return a documented partial outcome for this case.

**Alternative rejected:** declaring the full journey complete at local readiness, retaining unimplemented producers behind a new activation label, or waiting 30 days to call a successfully deployed and enforced system active.

### 2. Add a separate repair command rather than expanding update authority

The new public surface is:

| Intent | New command form |
| --- | --- |
| Preview registered project repairs | `liftoff repair [project-path] --check [--json]` |
| Permit bounded state/resource metadata discovery | `liftoff repair [project-path] --check --live [--json]` |
| Inspect named sensitive state for a migration plan | `liftoff repair [project-path] --check --inspect-state --approve-state-read <fingerprint> [--live] [--json]` |
| Preview additive agents and an optional Spec Kit default | `liftoff repair [project-path] --check --add-agents <list> [--default-agent <id>] [--json]` |
| Apply one saved reviewed plan noninteractively | `liftoff repair [project-path] --approve-plan <fingerprint> [--json]` |
| Review and approve the saved plan interactively | `liftoff repair [project-path]` |
| Execute an explicitly reviewed recovery plan | `liftoff repair [project-path] --recover --approve-plan <fingerprint> [--json]` |

`--project <path>` remains the alternative to the positional project path; conflicting forms fail before inspection. Preview options cannot expand approved apply scope. `--default-agent` remains Spec Kit-only and must select an existing or newly added agent. `--inspect-state` requests sensitive inspection of a previously displayed exact state-read scope; `--approve-state-read` binds that scope and is not write authority. Remote state inspection also requires the explicit live scope. `--force` and `--yes` never bypass preconditions, backend concurrency, or approval.

The existing independent `--install-tools`, `--install-dependencies`, and `--configure-openspec-profile` permissions can be supplied during apply for prerequisites explicitly disclosed by that plan. Project-repair approval alone authorizes none of them. Interactive operation obtains the corresponding independent confirmations.

Ordinary check is project-read-only and metadata-only. It may write a disclosed user-local preview receipt and isolated rendering workspace, but not project files, activation records, or real user tool configuration. It performs no provider reads without live permission and no sensitive state access without the separate state-read scope. Authorized stateful planning can run registered OpenTofu planning/inspection primitives in a protected workspace; it cannot apply, migrate, or stream raw state/plan payloads. Untrusted data sources, provisioners, providers, modules, or scripts outside the supported inspected contract prevent such execution. Tool installation and arbitrary project scripts are never implied by preview.

The repair catalog has `infrastructure-layout`, `agent-integration`, and `stateful-migration` lanes, with explicit recovery subplans. A known stateful project is no longer automatically plan-only. Eligibility requires a supported recipe, complete source/target mapping, approved sensitive inspection, valid backups, execution-path access, concurrency controls, and exact write authorization. Unknown or unsupported candidates remain plan-only. Independent agent work does not silently inherit a stateful lane.

The receipt records requested lanes and their finite verification commands. Explicit `--add-agents` or `--default-agent` requests the agent lane; other discovered blockers are advisory rather than silently added to that write scope. A plain check can propose the supported outstanding repair lanes, but approval still binds only the displayed executable set. Completing an agent-only repair does not require repairing an unrelated infrastructure lane or completing all local setup: `repairScopeComplete` and `localSetup.complete` are separate results. Local setup integrations subsequently resume the normal local phases when appropriate.

Reuse project discovery, native path handling, command arrays, preview fingerprints, and shared terminal output. Never implement a repair by invoking `liftoff init` in the user's project or by interpreting a path-shaped project name as a destination.

**Alternative rejected:** extending ordinary update/force into live infrastructure authority. Core update and activation-contract migration remain separate from cloud activation and OpenTofu-state migration.

### 3. Separate observed statefulness from executable eligibility

Each infrastructure candidate has one of three classifications:

| Classification | Execution boundary |
| --- | --- |
| `verified-undeployed` | Eligible only if the source transformation is also supported and the exact plan is approved |
| `stateful` | Supported stateful migration can execute only after complete mapping, protected planning, backup/concurrency checks, and specific approval |
| `unknown` | Discovery and migration plan only; approval does not override missing facts |

A `verified-undeployed` result requires a complete, explicitly identified scope and current independent negative observations for the relevant configured state locations and cloud resources. It is not a claim that an entire subscription is empty. A backend, provider, environment, dynamic resource binding, or customization that cannot be included in that complete scope leaves the result unknown.

Default preview reads safe metadata and identifies missing discovery. `--live` permits only the named provider/resource and backend metadata. Sensitive state reads require a separately approved state-read fingerprint and are confined to a protected execution workspace. Neither preview mode authorizes logins, grants, provider registration, state initialization, state writes, or resource changes. Denied reads, incomplete pagination, timeouts, stale observations, and ambiguous identities never become negative proof.

Eligibility binds the project, configuration and plan digests, exact backend/resource scope, execution identity/host, adapter/recipe version, state lineage/serial/version or ETag where applicable, capture time, and expiry. Apply rechecks these under the supported concurrency boundary. Changed state, lost locks, a new resource binding, or an incomplete recheck blocks mutation and requires reconciliation. A refreshed observation must preserve approved semantic scope; a new timestamp is not itself expanded authority. Repair observations are not activation or enforcement proof.

Where complete authoritative scope or safe semantics cannot be established, the CLI produces a concrete non-executable plan identifying unresolved mappings and capabilities. It never replaces missing proof with a boolean confirmation, force flag, or hand-authored receipt.

**Alternative rejected:** assuming undeployed because `.tfstate` is absent, the context says `generated-not-deployed`, or the user chose an undeployed label.

### 4. Transform known infrastructure semantics, not whole starter trees

Use explicit catalog entries for the eight retired flat-root identities, shared application module identities, retained identities, and selected environment-root identities. Resolve every destination with `path.join`/`path.resolve`; displayed slash-separated examples are not filesystem resolution rules.

Introduce a semantic HCL adapter for source inspection and source-preserving transformation. It must preserve resource/data definitions, variable semantics, provider aliases, compatible existing pins/locks, environment values, and customizations. It cannot use regex replacement to infer resource ownership or silently substitute current generator resource bodies. Parser implementation stays behind this adapter and must not introduce an unmanaged global executable prerequisite.

The supported transformation creates the complete independent-root inventory, moves or composes the shared application module, emits actual module calls with the correct relative source, and distributes explicit environment/provider/backend/output inputs. It can recognize partially migrated forms such as an identical resource body copied into the shared module and two roots. Deduplication is allowed only when semantic equivalence and exact affected paths are established.

Unknown constructs, ambiguous duplicate definitions, missing source information, unsupported provider semantics, or an unverifiable preservation invariant produce a detailed plan-only result. No automatic provider-major, application, database, or image upgrade is folded into a directory repair.

The reviewed diff includes exact creations, modifications, moves, and retirements. Source files outside it remain unchanged. The undeployed local-layout lane retains isolated validation and backend-disabled initialization only. Stateful migration uses the separate protected planning/execution protocol below; a local file-repair approval does not authorize a plan against a live backend or a state write.

**Alternative rejected:** generating a new project and copying its infrastructure over the old one. That loses project semantics, may target the wrong directory, and cannot safely reconcile provenance.

### 5. Preserve provenance while versioning the execution contract

Keep manifest artifact version 7 and the managed-core/project-provenance distinction. The activation identity does change because ordering, permitted operations, approval planning, and proof semantics change. It must be migrated through the explicit successor contract described below; never edit an old identity or proof header in place.

An approved repair snapshots original manifest/provenance. An undeployed repair publishes the new active inventory with its guarded local commit. A stateful migration does so only at the coordinated verified cutover checkpoint, after state and configuration ownership agree. The retained tfvars logical names remain stable; previous paths and hashes remain historical. Unrelated provenance is not retagged.

Register exact machine-record roles under `.liftoff/repairs/`: the history index, per-repair public receipt, original-manifest snapshot, and progress record. Dynamic repair identifiers are validated and their concrete paths are recorded in the index; readers do not discover or own files through globs. These records are not managed-core templates and ordinary update cannot regenerate or delete them.

The project-visible and local-transaction roles resolve to `index.json`, `<repair-id>/receipt.json`, `<repair-id>/source-manifest.json`, `<repair-id>/progress.json`, and the private local `transaction.jsonl` beneath that namespace. Sensitive stateful journals and snapshots remain in protected external storage, referenced from public progress rather than copied into the local project journal. The commit receipt and source snapshot are immutable. Later verification updates only the exact progress record and references independently produced verification results; it does not rewrite the original commit receipt to change what was true at commit time.

Public receipts identify source/target inventories, plan fingerprint, recipe, eligibility and private-state-workspace references, exact paths/hashes, and checkpoint/verification outcomes. They contain no state, secret, private-key, or saved-plan payload. Sensitive snapshots and working journals live in the protected state workspace, not repository receipts. Receipts are historical facts, not permanent write permission; migration completion alone is not proof that the application's governance is active.

Do not retag existing evidence. Contract upgrades preserve source histories and obtain current proof through approved revalidation/readback. Activation-identity migration, infrastructure-state migration, and application deployment are separate operation kinds with separate authorities.

Repair backups/journals that contain project bytes are private, excluded from version control, bounded in size, and cleaned according to the transaction contract. Public previews and retained receipts contain no state payloads or secrets. A user deleting provenance does not become a supported repair path.

**Alternative rejected:** deleting history to satisfy the old layout predicate, adding fake activation evidence, or making the whole infrastructure directory managed core.

### 6. Reuse recoverable transactions and separate commit from verification

Extract or parameterize the existing reviewed filesystem transaction machinery so repair has an explicitly registered journal namespace while sharing the project mutation lock, path safety, snapshot preconditions, approval digest binding, bounded writes, and recovery behavior.

Apply rechecks the CLI/recipe identity, project boundary, source snapshots, desired-state fields, framework identities, current eligibility, and exact approval before committing. A plan is stale if concurrent local development changes a protected input. Files outside the plan are not overwritten to make a transaction succeed.

For local-only repairs, pre-commit failures roll back the project write set and leave original provenance active. After commit, failed checks leave committed files/history with incomplete verification. Stateful and cloud operations use checkpointed reconciliation: restoring local files is not represented as undoing remote effects. Recovery must inspect actual remote state before choosing compensation or forward completion.

Machine-tool installation and separately authorized global profile changes occur outside the project transaction. Their actual outcomes are reported independently; a project failure does not trigger an unapproved global uninstall or downgrade.

Repair JSON uses schema 1 with distinct local and stateful operation kinds. Exit 0 means requested scope is clean or verified complete; 1 means rejected/error execution before progress; 2 includes previewed differences, plan-only work, or persisted effects with incomplete recovery/verification. Reports expose actual partial effects even on failure. An empty or ineligible executable set cannot be approved into mutation.

**Alternative rejected:** claiming atomic rollback across package managers, remote systems, and project files, or labeling a committed repair as wholly failed without exposing its preserved state.

### 7. Treat compatibility, release channel, and installation outcome separately

Keep tested runtime/package-manager/framework exact pins, floors, and release lines. A newer release being available does not by itself make an installed compatible tool unusable. Compatible official stable or preview Copilot, Claude, and Codex installations satisfy their agent requirements; preview status is a notice. Authentication remains agent-owned and is not collected by Liftoff.

Use tool-aware version parsing with bounded accepted formats. Strip presentation punctuation only where the tool's output grammar permits it; preserve actual prerelease identifiers. A stable version ending a sentence must still be observed, and a prerelease token must not absorb that sentence's period.

Probe results carry a cause separate from severity: missing executable, unavailable observation, failed probe, below-floor version, wrong release line/exact pin, or incompatible channel for requirements that actually demand stable. They also identify the resolved executable and observed versus required constraints.

Choose a registered remedy from the actual failure and installation origin: install a missing tool, upgrade when a compatible target is available, or disclose a genuinely needed channel/version correction. Retain the existing platform restrictions, exact package identities, argument arrays, and independent consent.

Compare before/after executable identity, version, and readiness. Exit zero from a package manager is not proof it wrote or upgraded anything. An unchanged unresolved result remains a causal no-progress result; a successful version probe followed by a compatibility rejection is not a PATH failure. `restart-required` requires actual executable-discovery evidence. Do not run an identical no-progress remedy repeatedly without changed inputs or a newly reviewed alternative.

**Alternative rejected:** globally removing prerelease checks, demanding latest for all tools, accepting installer exit zero as readiness, or retrying installation until the user gives up.

### 8. Make Codex a cataloged native integration

Append canonical agent ID/input name `codex`, executable `codex`, label `OpenAI Codex`, and framework integration ID `codex` for both workflows. Existing IDs and ordering remain stable; support all seven nonempty subsets of the three agents. Spec Kit requires one selected default for multi-agent plans.

The pinned upstream contracts are already suitable:

- OpenSpec 1.11.0: Codex uses `.agents/skills/openspec-<workflow>/SKILL.md` and is skills-invocable, without a command adapter, even under global `delivery=both`.
- Spec Kit 1.0.1: `CodexIntegration` uses `.agents/skills/speckit-<name>/SKILL.md`, defaults to skills, and is multi-install safe.
- Codex invokes skills through its native skill picker or `$<skill-name>`, not invented Copilot/Claude slash-command files.

Declare Codex setup and assessment artifacts explicitly as `liftoff-setup-codex` and `liftoff-governance-assess-codex`, at `.agents/skills/liftoff-setup/SKILL.md` and `.agents/skills/liftoff-governance-assess/SKILL.md`. Include valid skill metadata and use `$liftoff-setup` / `$liftoff-governance-assess` in Codex-facing guidance. Other agents keep their current native invocation forms.

Replace two-way agent ternaries with catalog lookups for paths, logical names, framework markers, and delivery capabilities. Add `.agents` to the relevant framework staging boundaries, and permit project-local `.codex` configuration only when emitted by an explicitly recorded framework operation. Preserve neighboring custom skills and configuration.

Framework staging must isolate Codex/global prompt homes and preserve the real user's account settings and legacy prompts. Seed only the approved public framework profile into isolated tool configuration when needed; selecting Codex is not consent to global cleanup.

**Alternative rejected:** adding only a menu item, emitting Codex artifacts under Claude names, requiring unsupported command files, or installing global custom prompts.

### 9. Add agents through official framework operations

`--add-agents` forms an additive union with the existing recorded selection in canonical order. Existing integrations and the Spec Kit default stay unchanged unless `--default-agent` explicitly selects another member of the resulting set. Removing agents and switching frameworks are outside this first repair lane.

Requesting an already selected agent is idempotent only when its recorded native integration is healthy. Missing or stale explicitly owned integration output is still compared with official staged output; an unchanged agent list must not hide a missing integration. This does not authorize adoption of an unknown historical framework contract or creation of a missing project-owned bootstrap seed.

Preview stages the existing relevant framework files and invokes the pinned official adapter, rather than creating an empty replacement application. OpenSpec initializes/refreshes the resulting selected tool set under the approved complete profile. Spec Kit installs each new integration and, only for an explicit default change, uses its actual `specify integration use <id>` operation. Shared-template changes are part of the reviewed diff and cannot silently overwrite customizations.

Only the explicitly approved agent/default fields of `liftoff.config.json` can be updated by this repair. Other desired state remains developer-owned and unchanged. The manifest and framework state are committed only with validated real integration output; no metadata-only declaration of an installed Codex integration is sufficient.

Ordinary update continues rejecting this identity change but recommends a supported repair preview instead of only telling the developer to restore configuration.

**Alternative rejected:** manually adding an agent to JSON and suppressing missing markers, or rerunning project initialization over production source.

### 10. Share observations and rendered expectations across commands

Use one recorded-layout-aware managed-artifact builder for update, assessment, doctor, repair preview, and post-repair verification. A context that correctly describes a recorded legacy layout cannot simultaneously be current for update and outdated for assessment merely because assessment assumed a fresh independent layout.

Keep distinctions explicit: manifest last writer, per-artifact generator/repair provenance, actual filesystem observations, local verification, and live enforcement are different facts. Assessment remains read-only and its exit-2 partial coverage does not become an execution error or a repair authorization.

Generated actions come from the command/recipe catalog with explicit project and working-directory information. The same surface feeds help, diagnostics, and agent integrations. Unknown-command investigations should expose running executable/package identity; do not claim that the previously observed installation mismatch proves an absent command in the current source.

**Alternative rejected:** letting each reporting surface reconstruct readiness or managed context independently, or having an agent invent commands from prose.

### 11. Implement the production activation path and its real prerequisites

The target is the existing single-maintainer Azure/GitHub policy, with production adapters for every supported required phase. Fixed policy controls remain enforced; unsupported account capabilities, permissions, quota, or custom inputs are explicit external limitations, not fabricated success.

The revised graph separates planning eligibility from execution readiness. Dependency-ready work can yield an unsigned plan even when approval is absent. The public `governance approve --plan <fingerprint>` operation persists only the exact reviewed approval; it does not execute the plan. Approval bundles name covered phase operations, destinations, permissions, bounded costs, expiry, and constrained output bindings. Final enforcement and credential/state-sensitive authorities remain separately gated.

The supported command registry also supplies `governance credential-enroll --plan <fingerprint>`, private TTY input or explicitly selected protected stdin, and `governance recover --plan <fingerprint> --execute`. Automation uses secure references/channels, never a credential in argv, chat, generated source, or a report. Authentication uses owner-controlled provider mechanisms, not invented tokens. Recovery inside an already approved compensation boundary is not gated by failed release checks; expanded authority still needs approval.

The graph must make the following sequence executable rather than rely on manual operations between phases:

| Stage | Production work and proof |
| --- | --- |
| Publication | Resolve/create the explicitly approved repository and branch destinations, preserve history, commit/push only reviewed files, and verify the actual remote binding |
| Phase 0 | Observe workload, real build/test commands, branches, workflows, required contexts, rulesets, environments, deployments, security capabilities, provider/identity permissions, state, private reachability, monitoring, and cost/ownership facts |
| Activation approval | Create or reconcile the selected workflow's governance change from those facts and persist exact scoped authority |
| Bootstrap workflow source | Publish the minimal registered verification workflows needed to prove credential and later bootstrap operations; do not depend on a not-yet-provisioned private runner for a metadata-only credential probe |
| Credentials | Prefer a verified scoped GitHub App; securely enroll an approved fallback when required and prove actual permitted use and configured workflow wiring, not just file/secret-name presence |
| Provider/state/runner foundation | Derive provider namespaces for all planned Azure resources, prove terminal readiness, choose the backend execution path, create only approved access-establishing resources, and verify the actual private runner/backend path when required |
| Application prerequisites | Provision or verify explicitly owned registry, identity/federation, and supporting prerequisites needed to publish and run the real application |
| Workflow source and artifact | Publish pinned workload-aware CI/CD and control sources through approved Git operations; build/publish an immutable application artifact and bind its digest to source and a successful run |
| Application foundation | Apply the reviewed application plan using the real artifact and verified state/identity path; read back resources and workload health |
| Qualification | Obtain actual development, staging, promotion/rollback, and required-context green/red evidence on the applicable ref/environment families |
| Enforcement/readback | Obtain separate final approval, apply exact ruleset payloads idempotently, and compare live enforcement with committed source |
| Lifecycle | Track retained state and due disposal separately, with scoped execution and receipts rather than a 30-day setup spinner |

Add explicit graph nodes for bootstrap workflow publication, application prerequisites, and artifact readiness; reorder existing workflow/application nodes to remove build-before-registry and deploy-before-image cycles. Declare Git publication, workflow dispatch, registry publication, provider/state, and recovery effects explicitly. Do not use an opaque adapter to hide effects outside its phase contract.

State/backend readiness is derived from actual cloud/state requirements, not incorrectly skipped because private DAST is inapplicable. Private-runner networking remains conditional and consumes a suitable existing assignment when independently verified. Public/private execution-path choices must satisfy the selected policy; no public endpoint, bootstrap state, or fallback identity is introduced just to bypass failed private access.

Identity bootstrapping and CI workload identity are distinct. The approved operator identity can create scoped federation/roles; subsequent workflows use short-lived workload identity where supported. Preflight verifies exact repository/environment/ref claims, tenant/subscription, permissions, and resource scope. Provider registrations are retained shared capabilities and are never unregistered during rollback.

Generate controls for the actual supported workload and preserve project customizations. Mandatory environment/control gaps require an explicit approved preparation plan or remain blockers; omitted environments do not silently make mandatory policy proof inapplicable. Placeholder images, echo-success workflows, skipped/neutral jobs, unproven status contexts, and source-only rulesets cannot satisfy activation.

Each external operation has bounded execution/polling, current readback, and a durable operation/run identity. Resume observes existing work before dispatching again. Partial provider effects, lost connectivity, and state-write failures become recoverable checkpoints, not a false clean rollback or a duplicate deployment.

The new proof contract records scoped before/after input bindings and authorized transition outputs. Planned workflow publication, image creation, or configuration cutover must not make the engine reject its own outcome as an unplanned edit or endlessly restart local setup. Unchanged proof is reusable only when its actual relevant inputs and contract remain valid; affected checks are refreshed. Unplanned changes still invalidate the affected plan and downstream proof. This is not a blanket exclusion of generated files from integrity checks.

**Alternative rejected:** marking the current capability table built-in without adding producers, assuming that a published workflow ran, or hiding deployment/resource mutations inside read-only proof phases.

### 12. Supported stateful migration is a protected multi-step protocol

The initial supported backend family is local OpenTofu state and Azure Blob state for supported Azure projects. Required recipe families are same-backend address/module refactoring, backend relocation, and a shared state partitioned into explicitly mapped independent environment states. Each advertised combination needs a tested backend adapter and exact recipe contract. Unsupported encryption, backend features, ambiguous ownership, or unsafe provider constructs remain non-executable.

Stateful planning follows metadata discovery with separately approved sensitive inspection. It produces a complete source-address to destination-root/address map, unchanged resource identity expectations, source/target backend bindings, current lineage/serial/version/digest observations, a saved reviewed plan, and the required lock/backup/recovery strategy. Every managed instance must have one accounted-for destination or an explicitly preserved source disposition; naming guesses and silent omissions are not mappings.

Use supported OpenTofu primitives for state transformations and backend-aware operations for transport/concurrency. Never text-edit JSON state or assume legacy local-file flags operate directly on a remote backend. Native state push protections do not replace an exact current-state precondition check, and force options cannot defeat that check.

Protected planning must also prevent provider configuration side effects such as automatic registration and unregistered external data-source execution. Necessary provider preparation is a separately approved activation operation, not hidden work inside a supposedly read-only migration preview. If an adapter cannot enforce its planning boundary, that recipe remains non-executable.

The executable protocol is:

1. Verify the operator/execution host, exact backend scopes, approved read/write authority, configuration/artifact inputs, and the complete mapping.
2. Quiesce known writers and establish the supported native/backend concurrency controls. Record the limitation that no transaction locks an entire cloud or all administrator actions.
3. Create and verify recoverable encrypted/private source and destination backups. State payloads, state-encryption keys, and sensitive saved plans never enter repository history, ordinary Actions artifacts, repository secrets, chat, or public logs. Application/runner credentials can use their explicitly approved provider secret stores through the separate enrollment flow; those stores are not state-transfer channels.
4. Prepare target configuration and state through the declared recipe in the protected workspace. Verify that the resulting plan contains no unapproved resource create/update/delete/replace effects; a state-only migration is not a resource-change approval.
5. Execute the exact saved migration under the required locks/conditional version checks, with durable checkpoints after each external effect. Verify destination data and mapped identities before source retirement.
6. Verify source dispositions, destination ownership, backend locking/versioning, known-writer cutover, and the expected post-migration no-change result. Only then publish the coordinated current project inventory.
7. Retain protected recovery snapshots according to the approved policy, record payload-free completion, and resume the relevant local/activation work.

Multiple backends and local files do not form an atomic transaction. Recovery reads actual backend versions/checkpoints and chooses a validated compensating or forward-recovery plan. It must not restore an old snapshot over a newer concurrent state, break someone else's lock, or blindly retry a write. Lost authority, leases, backup access, lineage, or mapping verification stops the operation with explicit partial state.

Local-only repair approvals remain local-only. Stateful migration approval authorizes only its displayed backend/state/configuration effects. Any actual resource change discovered during planning needs a separate activation/resource-change approval and cannot be smuggled into a state-refactoring plan.

**Alternative rejected:** blanket plan-only handling of every existing state, blanket automatic migration of every backend, ordinary `state push --force` recovery, or claiming distributed atomic rollback.

### 13. Version the new graph and preserve the old execution history

The expanded ordering, operations, approval planning, and proof model require activation contract 3, not a silent implementation reinterpretation of contract 2. The target activation package family is `0.12.0`; the shipping CLI version remains a release-owned value. The graph schema advances to 2 and activation state, evidence, and approval schemas advance to 3. Compatibility metadata advances to 4 to declare strict source-reader and successor lanes. Manifest artifact 7, policy 6, and unchanged supersession/credential-policy representations remain independently versioned.

The new graph hash and contract digests must be computed from implemented definitions. No future hash is invented here. Old v1/v2 identities are read through their exact historical contracts and migrated only through a reviewed, history-preserving successor plan. Old approvals are not new authority. Local proof is obtained through supported revalidation; existing live resources are independently read back/adopted through approved operations, not recreated or declared current by changing version fields.

Activation-identity migration remains an explicit core/update transaction, not permission for live state migration or deployment. The `specs/liftoff-activation-migration/spec.md` delta defines reviewed direct successors from the supported v1/v2 source contracts, exact history preservation, conservative lifecycle carry-forward, finite local revalidation, and separate subsequent activation/stateful authority.

**Alternative rejected:** keeping the old graph hash while introducing new effects, changing only a capability flag, or translating old checked tasks/approval files into current production proof.

### 14. Qualification and lifecycle are real deliverables

Activation is verified at successful live enforcement readback after all mandatory applicable deployment and qualification proof. Retention/disposal has its own due time, scope, executor, and progress. A due or overdue obligation is visible operational work, not an excuse to erase retained state early or to claim that all lifecycle work is complete.

Lifecycle operations are invocable through their scoped CLI path and can be run by an explicitly authorized supported scheduler/host. An unavailable cleanup host is reported honestly; read-only status never performs deletion. Retained state cannot be used for ordinary plan/apply, and disposal targets exact owned encrypted copies/keys only.

Tests include deterministic provider transports, failure injection, and sanitized contract fixtures, plus an explicitly opt-in live qualification lane in owner-approved disposable Azure/GitHub environments. Missing credentials or skipped live runs are not passing evidence. Planning and ordinary tests never use a downstream application workspace or subscription as an implicit test target.

**Alternative rejected:** declaring production readiness from mocks alone, using a user's active project for experimentation, or leaving lifecycle work without an executable and observable owner.

## Risks / Trade-offs

- [State/resource observations are incomplete or race another writer] -> Require complete bindings, protected current-state observations, native/backend concurrency checks, apply-time revalidation, and explicit recovery on mismatch.
- [Migration fails after only some backend writes] -> Retain encrypted recovery material and checkpoints, inspect actual versions before compensation/forward recovery, and never claim an atomic cross-backend rollback.
- [State or saved plans expose credentials] -> Use private encrypted workspaces, allowlisted public summaries, protected input channels, and no raw payload streaming or ordinary repository/Actions artifact storage.
- [Full activation has hidden dependency cycles] -> Version the graph, publish required bootstrap/workload workflows at the correct stage, and require a real immutable artifact before application deployment.
- [Approval gating prevents approval planning] -> Distinguish dependency-ready/plannable work from approved executable work and provide explicit approval persistence.
- [Credential metadata looks valid but cannot actually be used] -> Verify real scoped API/workflow use and secret/identity wiring before readiness; never accept file or name presence alone.
- [A custom HCL construct changes meaning when moved into a module] -> Use semantic inspection and supported transformations, retain source customizations and provider pins, and refuse execution when preservation cannot be established.
- [A manual partial migration looks superficially complete] -> Inspect the complete explicit inventory and actual module/provider/backend relationships; folder existence and copied resource bodies do not establish conformance.
- [A project changes while the developer continues local work] -> Bind exact preconditions and reject stale plans before writes. This repository's fixtures, not a live downstream project, exercise those races.
- [Repair broadens template ownership] -> Separate repair consent and inventories from update; preserve historical provenance and never infer authority from hashes, directory membership, or `--force`.
- [Framework initialization touches user-global Codex files] -> Isolate framework execution homes, inspect the complete staged change set, and keep global profile consent separate.
- [Version-policy relaxation leaks into runtime pins] -> Apply the preview-agent policy only to declared coding-agent requirements and keep runtime/framework rejection cases.
- [A package manager exits zero without improvement] -> Compare observations and retain the actual remaining cause; do not infer writes or a PATH problem.
- [Filesystem behavior differs on Windows] -> Use native path APIs and argument arrays; test spaces, drive/UNC inputs, junctions, case collisions, executable shims, interrupted transactions, and concurrent writes on Windows CI as well as macOS/Linux.
- [Consumers or old projects assume old execution semantics] -> Use schema-2 command output plus the explicit contract-3 successor, preserve historical bytes, and qualify migration before enabling production execution.
- [Permissions, quotas, private routing, or supported execution hosts are unavailable] -> Report exact resumable external prerequisites without bypassing policy or claiming completed activation.

## Migration Plan

1. Validate the complete planning set, including the activation-migration source/target and authority boundaries, before implementation.
2. Implement the versioned graph/proof/approval contracts and historical readers/successor transactions before accepting old projects for new execution.
3. Implement dependency-ready planning, approval persistence, protected credential/state channels, and accurate scope/reporting.
4. Implement and qualify the production bootstrap, provider/state/runner, artifact/deployment, qualification, enforcement, recovery, and lifecycle producers.
5. Implement supported local and stateful repair recipes with exact inventory, protected backups, backend concurrency, verified cutover, and recovery.
6. Preserve and integrate the tool-remediation, preview-agent, and native Codex work; update all setup integrations to drive the approved full journey.
7. Update packaged help, migration guidance, compatibility fixtures, and cross-platform/live qualification coverage together. No new graph or stateful recipe is advertised executable before its required evidence gates are implemented.

Local rollback restores only the owned local transaction when safe. Cloud/stateful recovery reconciles actual external effects under its approved recovery boundary. Never roll back by downgrading the CLI, discarding history, overwriting newer state, or reverting unrelated development.
