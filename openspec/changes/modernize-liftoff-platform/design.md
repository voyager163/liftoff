## Context

See `proposal.md` for motivation and the agreed scope. The implementation baseline is `v0.12.3`, commit `70d10881b46d873118d825735696f39b6d35ebe0`, not an older checkout or an unqualified development branch.

The baseline already has layered CLI/application/domain/adapters, import-boundary tests, reviewed update transactions, repair contract 1, schema-2 repair records, explicit application patches, private verification workspaces, three locked-preparation providers, and generated setup/assessment/repair integrations. These are starting implementations, not capabilities to replace with parallel systems.

The source of truth for activation identity is `src/domain/governance/policy/identity.ts`. In 0.12.3 it declares activation package 0.12.0, manifest 7, policy 6, activation contract/state/evidence/approval 3, phase graph 2, and compatibility metadata 4. Some developer prose contradicts these values or describes released repair functionality as unreleased; implementation and documentation must converge on the tested identity authority.

The observed Windows job for this exact release failed in run `34842047858`, job `103969047717`. Symptoms included verification/controller timeouts, npm identity rejection, and uncertain workspace settlement. This observation is not a root-cause diagnosis. Qualification must reproduce and resolve these failures rather than simply increasing limits or excluding tests.

The user settled two additional scope decisions:

- Executable adoption targets the existing supported FastAPI, Fastify, Go/Huma, Vue, and supported GenAI profiles. Unsupported stacks receive assessment and blockers, not inferred framework conversion.
- Native distribution replaces npm directly. There is no new npm compatibility edition or final bridge release. Few installations are affected, so a documented, explicitly approved one-time handover is acceptable.

Subsequent confirmed refinements make macOS delivery a Homebrew cask, include ruleset-response compatibility issue #82, and add Azure Monitor dashboards with Grafana for the existing product telemetry store. The dashboard is operator-facing observability, not a seventh CLI engine or a generated-application feature.

## Goals / Non-Goals

**Goals:**

- Keep one TypeScript application with six capability engines and one shared execution kernel.
- Separate the CLI runtime, project toolchains, model-host instructions, and provider authority.
- Make runtime support and completion observable through qualified capability contracts rather than generated-file presence.
- Preserve real source, installation, policy, publication, repair, and activation provenance through every transition.
- Ship the entire agreed capability matrix in one coordinated release, with internal implementation milestones but no partial public completion claim.

**Non-Goals:**

- A new programming language, microservices, a resident general-purpose LLM agent, or an embedded model client.
- Arbitrary-stack conversion, replacing customized applications with starters, or treating model confidence as semantic proof.
- Unrestricted state adoption, silent cloud provisioning, bypassing repository protections, or automatic elevation.
- Treating private staging, environment filtering, or process-tree supervision as an OS/network security sandbox.
- Publishing another npm release, deleting historical npm packages, removing Node/npm used by projects, or reinitializing projects during CLI installation.
- Copying unlicensed third-party implementation code as an architecture shortcut.
- Provisioning a dedicated Azure Managed Grafana instance, adding telemetry tracking identifiers, or introducing dashboard alerts, scheduled reports, or another ingestion pipeline.

## Decisions

### 1. Preserve the layered modular monolith and identify six capability owners

| Engine | Application ownership | Principal responsibility |
| --- | --- | --- |
| Standards and Assessment | `application/standards-assessment` | Profile selection, bounded inventory, standards findings and evidence coverage |
| Project Generation | `application/project-generation` | Compose and stage approved new-project artifacts |
| Project Evolution | `application/project-evolution` | Adoption, existing fresh-target migration, managed update and reviewed repair |
| Repository Governance | `application/repository-governance` | GitFlow, source workflows, checks, approved settings/rulesets and repository readback |
| Azure Activation | `application/azure-activation` | Explicit environment discovery, approved provisioning/deployment and qualification |
| Distribution and CLI Upgrade | `application/distribution` | Installation ownership, release discovery, native upgrades and installation handover |

The shared kernel belongs in `application/execution`; it is not a seventh capability engine. Pure rules, identities, schemas and compatibility maps remain in `domain`. `cli` parses/routes/presents. `protocol` owns versioned external request/result schemas. I/O stays in explicit adapters.

Move behavior incrementally behind these boundaries. Retain compatibility facades until imports and installed-command tests establish their safe retirement. Split mixed inspection/planning/execution/rendering responsibilities in `governance-activation/commands.ts`, contract families in `validators.ts`, and policy/skill rendering in `repository-governance.ts`. Do not fragment correctly bounded feature orchestrators merely to reduce line counts.

**Alternative rejected:** six executables/services or one engine per command. Those duplicate state, approval and compatibility boundaries without a deployment need.

### 2. One public protocol and capability registry; not one new format for all history

New command/capability envelopes start at schema 1. Each registered capability names its owning engine, supported profiles/platforms, required inputs, planner, executor, verifier, recovery behavior, external effects and qualification state. Missing prerequisites and missing implementation are separate blockers.

The public surface retains `init`, fresh-target `migrate`, `update`, `repair`, `doctor`, `governance` and `upgrade`. It adds `assess`, `adopt`, `skills` management, and `installation` inspection/migration. These are different operations even when they reuse engine components. No command becomes a destructive alias for another.

Every executable continuation carries executable plus argument array, native-safe display form, exact project or installation target, working directory, selected scope, configuration binding, required approval and compatibility identity. A change in working directory must not silently change a relative input-file binding. Private credentials are opaque references, not copied into commands or reports.

The kernel adapts existing update and repair journals rather than rewriting them into a universal new format. New adoption and installation-migration records have independent schema-1 identities. Existing recovery formats remain readable only through explicit compatibility registrations.

**Alternative rejected:** every engine invents its own next-action, approval or failure vocabulary, or a global format conversion silently rewrites old receipts.

### 3. Model reasoning proposes; deterministic admission controls execution

Skills collect intent and explain candidate changes. The CLI obtains current observations and rejects incomplete mappings, unsupported effects, changed input identities, expired plans and missing capabilities.

The common sequence is inspect, propose, validate, review, approve, execute, independently verify, and recover where supported. Workflows requiring a separate plan review display the immutable plan and ask action-specific Yes/No with default No; their machine execution retains exact-plan flags. Preserve established command-specific authorization: routine owner-preserving `liftoff upgrade` is itself explicit authorization for its exact validated target, without adding mandatory fingerprint entry or a second Liftoff confirmation. This does not authorize installation-owner migration, elevation or another operation. Project-code, dependency preparation, declared network, file writes, Git publication, repository controls and cloud/state actions never imply one another's approval.

Reuse 0.12.3 repair consent, workspace, verification, backup and readback mechanisms. A late cancellation must report earlier approved effects accurately. A zero exit from a project command proves only that declared check, not complete application safety.

Skills must not treat autopilot, a generic request, piped answers or model-generated approval as user authorization. Host tool permissions and CLI admission remain necessary: prompt metadata is not an OS security boundary, and Liftoff does not claim to control unrelated tools an agent host can execute.

**Alternative rejected:** embedding an LLM client or letting model-written metadata certify approvals, conformance or provider success.

### 4. Self-contained application bundles preserve the existing runtime semantics

Use a private, pinned Node runtime plus compiled ESM, runtime dependencies, assets and a relocatable launcher as the initial packaging design. This removes the end-user Node/npm prerequisite for Liftoff without changing the JavaScript runtime. A single executable is not a requirement.

The packaging spike must demonstrate closure: no dependency on the build checkout, ambient Node/npm, writable installation files or undeclared runtime assets. Introduce build-info and packaged-resource adapters rather than deriving every resource from the existing `dist` tree. Separate invoking Liftoff itself from invoking a selected project's Node/Python/Go or specification tools.

The coordinated build matrix covers macOS and Windows x64/arm64 and Linux x64/arm64 with an explicit glibc/minimum-system baseline. Additional architectures or libc variants require separate qualification; no untested artifact is labeled supported. Declare the exact host floors from the chosen runtime's supported matrix and test them before publication.

Bundle the Windows process-controller asset as well as templates, locks, policy, skill sources and licenses. The controller still requires its documented supported Windows host conditions; bundling Liftoff does not bypass enterprise execution policy.

**Alternatives:** Bun compilation remains a possible packaging backend only after equivalent runtime, asset and subprocess qualification and a reviewed design amendment. Node 24 SEA is not the initial choice because its entrypoint/asset constraints are not transparent packaging of the existing ESM application.

### 5. Native installation has one authoritative update owner

| Channel | Initial delivery and ownership |
| --- | --- |
| macOS | A Homebrew cask in an upstream-maintained tap distributing the qualified standalone archive |
| Windows | A WinGet portable ZIP containing the qualified launcher/runtime/assets, with exact package identity and architecture manifests |
| Linux | Versioned standalone archives installed under an explicit direct-install receipt and stable launcher |

Homebrew casks can contain CLI software. The macOS package is explicitly a cask, not a Node-dependent formula; its qualified definition exposes the verified launcher and bundled resources. Owner detection and commands bind the full tap/cask identity and use explicit cask selection where needed to avoid formula/token ambiguity. Official repository acceptance is not assumed. WinGet submission/catalog availability is distinct from publishing a GitHub release artifact.

Native release manifest schema 1 binds product/version, source commit, supported target, immutable artifact URL, final checksum, signature/provenance, runtime identity and packaged-resource identity. Calculate checksums after signing. Native channels use this authority, not npm `latest`.

`upgrade --check` is non-installing and does not silently refresh or rewrite package-manager configuration. Distinguish upstream availability, manager availability, unsupported targets, source staleness and required manual action. The dedicated `upgrade` invocation authorizes one internally bound exact target through the existing owner and displays its operation; it does not introduce a mandatory second Liftoff approval prompt or plan flag for ordinary owner-preserving upgrades. It delegates only the identified Liftoff package to its manager. Changing owner uses the separately reviewed installation-migration journey. Direct installations use a verified staged replacement protocol with installation ownership and failure recovery, not a generic download-and-overwrite operation.

Windows locked executables require an explicit close/handover path. Do not terminate unrelated processes or force replacement. Retain the current usable version until the approved replacement can be verified, and do not clean an active version directory merely because a launcher changed.

**Alternative rejected:** a native updater overwrites Homebrew/WinGet-owned files or silently switches delivery channels to bypass publication lag or enterprise policy.

### 6. Direct npm-to-native cutover is installation migration, not project migration

New releases do not publish npm packages or a bridge. Historical npm packages, tarballs and provenance remain available. The old npm updater cannot discover native-only releases; release notes and the installation guide must explicitly explain the one-time handover.

The new native binary exposes `installation inspect` and an explicitly selected `installation migrate --to <owner>` journey. It can be run from a verified, unlinked native bundle before the final installation is registered. Normal migration is interactive and plan-first; non-interactive execution needs the exact approved plan.

The migration protocol:

1. Observe the actual legacy executable, npm package identity, prefix, PATH entries and manager ownership without changing them. Homebrew Node plus an npm-installed Liftoff remains npm-owned; a path prefix alone is not ownership proof.
2. Verify the new immutable artifact, runtime and assets at an explicit unlinked location. Resolve the final package identity and destination, including existing launcher conflicts, before asking for mutation approval.
3. Show the exact legacy-package removal or conflict resolution, manager installation and launcher effects. Retain the legacy version/artifact identity and recovery instructions. If ownership or required tooling cannot be established, stop without guessed deletion.
4. Only after explicit approval, retire the verified legacy Liftoff package where necessary to release a conflicting launcher and install through the selected native owner. Do not pass a generic force flag over another owner's files.
5. Verify the native executable by explicit path and then by normal command resolution. Handle partial installation/removal truthfully; restoration is owner-specific and separately approved when it changes scope.
6. Inspect existing projects read-only with the new CLI. Offer separate managed update, adoption, repair or activation migration when required; do not run `init`.

Project source, manifests, node_modules, lockfiles, framework selection, Git history, cloud resources and state are not installation-migration targets. Neither Node nor npm is removed as part of retiring the Liftoff package.

**Alternative rejected:** a final npm bridge or indefinite npm compatibility channel. The user explicitly selected direct native cutover.

### 7. One canonical skill library with qualified host projections

Store canonical instructions, references and examples under `assets/skills`, with an explicit catalog declaring capability/schema requirements and owned artifact identities. The initial workflows are setup, assess, init, adopt, update, repair, migrate, governance-assess, governance, Azure and CLI-upgrade assistance. The CLI does not require a skill or LLM for deterministic commands.

Keep model choice outside the library. Host adapters handle discovery locations, metadata, invocation and supported tooling. Reuse the 0.12.3 capability negotiation pattern; managed content hashes plus declared protocol/profile contracts identify skills, not a new independent skill SemVer added to project activation state.

Support user-level installation before any project is initialized. Copilot/Codex can share one qualified personal `.agents/skills` projection; Claude has its native personal projection. Project exports require explicit ownership and reviewed update/install authority. Account for overlapping host discovery roots rather than emitting three conflicting copies of the same skill.

Existing `.github/prompts`, `.claude/commands` and `.agents/skills` integrations retain exact registered identities until an approved migration handles them. Select native transports through a tested host compatibility matrix. Missing support or ambiguous discovery is a blocker, not a reason to change host settings silently. Preserve unrelated OpenSpec/Spec Kit and user skills.

**Alternative rejected:** maintaining separate business workflows per host/model, or introducing a second imperative implementation in skill scripts.

### 8. Templates are composable release-owned resources, not replacement authority

Add `assets/templates/catalog.json` and reusable common/backend/GenAI/frontend/infrastructure/workflow components. Keep complex conditional rendering in `src/generators`. The generation engine composes selected profiles using the catalog plus the existing canonical governance, skill, lock and supported-stack resources.

Every emitted artifact has an exact registered logical name, destination, lifecycle and component identity. Preserve append-only identities unless an explicit retirement/migration inventory authorizes the change. Native resource lookup is independent of cwd and handles native Windows paths, spaces, case/normalization collisions and read-only installation directories.

The evolution engine consumes target identities and explicit template versions to build a reviewed difference plan. It does not regenerate over project-owned application, documentation, infrastructure or state.

**Alternative rejected:** a full copied template repository for every combination, runtime downloads of mutable template branches, or filename-pattern ownership.

### 9. Assessment and adoption are different from initialization and migration

`assess` works on an explicitly selected repository or existing project directory without creating a Liftoff manifest, initializing Git, or running project code. It combines bounded observations with a selected versioned standards/profile target, records evidence completeness, and identifies unsupported/unknown areas. Missing VCS metadata is an observation, not a reason to initialize a throwaway project. Models may interpret the report and inspect authorized additional context; they cannot turn unknown observations into proof.

`adopt` is the new reviewed in-place operation for supported stack profiles. It preserves current business behavior, uses explicit per-file mappings and declared additions, and can introduce the minimal approved Liftoff metadata/framework/skill artifacts without creating another starter application. Source edits and new files require concrete target identities, absence/existing-byte preconditions and independently authorized staged validation. Unsupported frameworks are assessment-only; no automatic Express-to-Fastify or other unregistered conversion is inferred.

An existing supported Vue component can be adopted without inventing a backend. Manifest 8 and every consumer must distinguish full generated workloads from truthful adopted component-only profiles; unavailable backend/cloud capabilities remain explicit. A previously uninitialized source supplies an explicit reviewed adoption context to reusable inspection/verification components, not a fabricated on-disk manifest. Adoption-only declared additions use the guarded creation primitives and staged checks without broadening the old `application-layout-patch` recipe's input contract. Existing Git history is preserved, and absent Git metadata is not created implicitly by local adoption.

Preserve the existing `migrate` fresh-target-only rule and source preservation. `init` remains new-project initialization, `update` remains managed-core reconciliation, and `repair` remains registered recipe execution. A user cannot gain wider mutation authority by choosing another command name.

**Alternative rejected:** calling in-place scaffold copying adoption, or making arbitrary semantic edits executable solely because an LLM supplied them.

### 10. Identity evolution is explicit and historical records are immutable

The target design uses the following identity boundaries. The final CLI SemVer and computed graph hash are release-preparation outputs, not fabricated values in this plan.

| Contract | Target treatment |
| --- | --- |
| Native release/build info, platform capability protocol, standards profiles, adoption records | New independent schema 1 contracts |
| Project manifest | Writer 8 for explicit profile/adoption provenance; preserve supported v2-v7 readers and exact migration eligibility |
| Governance policy | Version 8, retaining version-7 repository-only enforcement and hold semantics while explicitly admitting the reviewed provider credential grant |
| Credential policy | Writer schema 2 for actual provider grants and broader-read disclosure; preserve schema-1 records and approvals under their original meaning |
| Activation contract/state/evidence header/approval envelope | Version 4 for scoped input binding and the new repository execution path |
| Phase graph | Schema 3, with a computed canonical hash and explicit phase-contract digests |
| Activation compatibility metadata | Schema 5, with exact historical and target tuples |
| Governance command output | Schema 3 for explicit repository completion and unambiguous verification status |
| Repair | Retain contract 1 and unchanged 0.12.3 recipe/record formats where guarantees are unchanged; register new recipes explicitly |
| Existing update/repair recovery | Preserve registered historical serializers and original identities; do not globally normalize journals |

Manifest 8 distinguishes generated, adopted and subsequently repaired provenance. Never label existing custom bytes as generated output, invent historical generation versions, or use a hash as ownership permission. Old manifests are upgraded only through a reviewed project transaction.

The new activation tuple is registered explicitly before any new writer is enabled. Historical v1/v2/v3 readers remain isolated from current execution readers. A native CLI upgrade alone does not rewrite any project or activation record.

The permission amendment also preserves the pre-amendment candidate tuple with policy 7 and credential-policy schema 1. Register that exact tuple and its original policy/approval readers before enabling the policy-8/schema-2 writer; it is not an alias for the new execution identity. Existing project transition must be separately reviewed, preserve original bytes and ancestry, and obtain fresh proof and approval for the actual provider grant. Other serialization axes remain at their declared versions unless a further reviewed contract change requires a bump; graph and phase digests are computed from the resulting definitions, never fabricated or retagged.

**Alternative rejected:** changing digests while retaining their old contract meaning, accepting all lower SemVers as compatible, or advancing the CLI version instead of the affected policy/schema axis.

### 11. Fix #78 with phase-owned inputs and reviewed publication revalidation

Replace the global non-local configuration projection with an explicit per-phase consumed-input registry. Git publication consumes its actual repository, source and destination facts, not Azure subscription/tenant/region added for later phases. Normalize absent irrelevant input consistently; changing the outer configuration from absent to an object must not invalidate unrelated phases.

Retain the old schema-3 digest algorithm only for interpreting historical evidence. Recovery does not reinterpret old receipts under the new algorithm. A reviewed compatibility transition preserves plans, approvals and receipts, independently observes the recorded local commit and remote ref, and appends new linked revalidation evidence. It neither recommits nor pushes solely to repair the Azure-input mismatch.

Distinguish the fact that a commit was published from publication of newly changed workflow or project files. Revalidation must not falsely claim that local migration bookkeeping or later edits are already on the remote. Genuinely changed relevant inputs still invalidate dependent proof and may require a separately approved publication operation.

Phase 0 requires explicit non-placeholder subscription/tenant bindings for Azure discovery and verifies the requested account rather than the ambient default. Repository-only discovery makes no Azure call. Continuations retain the same normalized configuration reference and digest; edits require renewed planning.

Governance verification returns 0 for consistent and complete selected scope, 2 for consistent but incomplete, and 1 for inconsistency/inspection failure. In the new output schema, `ok` means selected-scope success; `consistent` and `complete` remain separate. Historical schema semantics are not silently changed in stored records.

**Alternative rejected:** ignoring freshness errors, deleting state, dropping `--inputs`, repeating publication, or rewriting receipt hashes.

### 12. Add an independent repository-only execution path for #79

Add public governance scope `repository` alongside local, activation and lifecycle. Preserve the existing unscoped governance default of activation; repository-only enforcement must be explicitly selected, not silently substituted for an existing caller's full-activation request. Use dedicated registered repository phases: repository discovery, source-workflow publication, source-check qualification, enforcement approval, ruleset reconciliation and readback. Local/publication prerequisites are shared explicitly; they do not create an Azure dependency.

Keep full-activation `green-red-proof` and production qualification distinct. Repository completion cannot satisfy their evidence contracts. Selected-scope status reports repository enforcement independently while activation stays incomplete or blocked.

The repository path observes repository identity, refs, controls, capabilities and emitted checks; publishes source changes through permitted GitFlow operations; and proves exact positive and controlled-negative results on reviewed unmerged fixtures. Evidence binds the actual repository, workflow source, commit, actor, job/check context and result. Infrastructure errors are not intentional negative-check proof.

Real GitHub adapters plan and reconcile only registered owned controls, resolve actors, reject concurrent changes, and read back every write. Matching reconciliation is zero-write. Preserve foreign controls and protection after partial failure; no automatic protection removal, branch bypass or force push is a recovery strategy.

Preserve PR-only protected branches, zero required reviewers, no branch bypasses, and restricted immutable version tags. When production qualification is deferred, an explicitly approved main-update hold prevents unqualified main updates without faking a staging result. Only real later qualification and a separately reviewed plan can replace that hold. Repository-only execution creates no production release/tag.

**Alternative rejected:** marking cloud phases complete/inapplicable merely to reach enforcement, or reusing one phase's repository proof as full production proof.

### 13. Implement and qualify all required production executors

The following baseline gaps remain part of this one change; removing capability blockers is not implementation:

| Capability group | Required producer and proof |
| --- | --- |
| `bootstrap-workflow-source-ready`, `workflow-source-ready` | Real GitHub source publication, exact workflow/artifact identity and readback |
| `credential-ready` | Supported private enrollment plus independent identity/permission readback; PAT/App policy equivalence and rotation guidance |
| `provider-ready`, `state-path-selected` | Explicit subscription capabilities, approved registrations where needed, and an actually observed supported state path |
| `existing-private-path`, `bootstrap-local`, `runner-ready`, `private-backend-proof`, `remote-import-verified` | Qualified private execution/network/backend operations, locks, state protection, actual runner proof and import/no-change verification |
| `application-prerequisites-ready`, `application-artifact-ready`, `application-foundation` | Approved infrastructure operations, real registry/image identity, immutable artifact delivery and resource readback |
| `dev-proof`, `staging-qualified`, `production-rehearsed`, `green-red-proof` | Actual applicable environment/workflow/check evidence, not static success payloads or fabricated provider observations |
| `rulesets-applied`, `live-readback` | Production GitHub reconciliation/readback shared with the repository-only adapter but bound to full-activation authority |

Preserve and qualify existing built-in producers and retained-state disposal. Derive applicability from the selected profile/environment configuration. A legitimately missing required environment is a configuration blocker, not permission to invent it; missing implementation is separately reported.

Each executor has bounded inputs/time/output, explicit effect classes, least-privilege credential handling, a durable pre-effect checkpoint, independently checked results and supported partial recovery. Sensitive state and credentials stay in private adapters, not model context or public evidence. Cloud transactions do not claim cross-provider atomic rollback.

Synthetic fixtures and mocked providers are the normal regression lane. Production registration additionally requires separately authorized disposable qualification for the exact provider/host/recipe combination. Missing access, signing or qualification is a release blocker, not a reason to advertise unavailable execution as complete.

**Alternative rejected:** closing #78 after the input bug while leaving required executors injected-only or unavailable.

### 13a. Represent the actual GitHub credential grant without inheriting old approval

The reviewed hosted-runner API requires `organization_administration:read`, not a provider-enforced hosted-runners-only permission. The user has approved representing that coarser grant explicitly in governance policy 8 and credential-policy schema 2. Preserve the actual provider names and auth-kind-specific permission structure: repository `metadata:read`, organization `organization_administration:read`, and organization `organization_network_configurations:read`, without extra or missing grants. Never relabel Administration as Hosted runners.

Plans, capability guidance and policy records must disclose that Administration read also reaches other organization, billing and Actions-settings metadata. Examples of that reach are explanatory, not an exhaustive provider endpoint allowlist. Grant scope and execution authority remain separate: Liftoff may invoke only the exact reviewed operation endpoints and resource identities. Recording a broader provider grant does not authorize incidental billing queries, organization-wide enumeration, writes or administration.

Credential use and local policy creation or transition require fresh exact plan-bound approval under the new identity. The approval binds the observed grant, disclosure, principal, repository/organization, workflow restrictions, intended operations and applicable expiry. Changed observations require renewed review. Existing schema-1 policies, private ownership receipts and approvals remain unchanged; none can satisfy the new permission admission by normalization, numeric version comparison or rewriting old proof.

The amendment changes only the permission-policy boundary. It does not establish exact PAT bearer identity or lifetime, turn GitHub's create-or-update secret endpoint into conditional creation, authorize replacement of a foreign secret, or relax payload-free evidence, protected input, non-forwarding, rotation or recovery requirements. Those unresolved paths remain blocked independently until their own supported contracts and acceptance evidence exist. WinGet inspection restrictions, qualification resources, signing, deployment and publication authority are unchanged.

**Alternative rejected:** deleting the current guard, hiding the provider's broader read scope, accepting arbitrary additional grants, or treating approval of this design as permission to use credentials or contact providers.

### 14. Resolve template defects and provide honest existing-project remediation

For #80, emit Redis and Service Bus `minimum_tls_version = "1.2"`, storage `min_tls_version = "TLS1_2"`, and storage `allow_nested_items_to_be_public = false`. A private container is not the account-wide rule. Qualify the cited Checkov controls and backend-disabled OpenTofu output for affected profiles; do not infer a live exposure or change unrelated networking/identity settings.

Add registered repair recipe `azure-baseline-settings` version 1. It plans exact supported HCL configuration edits and validation without reorganizing application code or granting cloud/state execution. Already customized or ambiguous expressions require explicit mapping/review or block. Applying configuration does not claim deployed compliance; live plan/apply/readback remains separately approved Azure work. Do not route infrastructure through `application-layout-patch`, whose exclusions remain intact.

For #81, make Go and Node Scalar/schema references prefix-safe and qualify the Python/GenAI variants under the same public routing contract. Canonical and trailing-slash routes, relative redirects, query preservation, direct and prefix-stripping proxies, JSON content type and schema paths/components must agree. Do not trust forwarded-host headers or create a frontend-root schema workaround.

Existing handler remediation uses supported explicit application mappings and staged checks. Changing generator output does not silently rewrite existing project-owned code.

**Alternative rejected:** testing only HTTP 200, fixing only the reported Go string while shipping the same Node defect, or claiming generic update applies infrastructure defaults.

### 15. Qualification measures outcomes rather than declarations

Pin coverage tooling to each package's selected Vitest version. Include unimported production TypeScript/JavaScript and require lines, branches, functions and statements strictly above 80% for the CLI and telemetry service independently. Evaluate actual covered/total counts so exactly 80% fails. Do not combine packages to hide a weaker one or introduce exclusions to inflate results.

Declare coverage scope explicitly. Native helper code is not V8-covered; require its own appropriate instrumentation/qualification and report the distinction. Unmeasured production code cannot silently disappear from a claimed whole-package result. Asset/template correctness additionally needs generated-output and installed-artifact qualification.

Preserve cross-platform boundary tests and add native runtime closure, package-manager ownership, legacy handover, relocatable resources, host-skill equivalence, stale plans, partial failures and history replay. Reproduce the observed Windows failures using the actual controller/protocol/host configuration; keep uncertain settlement fail-closed.

All required checks must be green for the same immutable source/artifact identities before the stable release channel is advanced. Artifact staging and manager submission can precede the coordinated announcement; publication lag must be observable. No feature is marked complete merely because its source, template or capability name exists.

**Alternative rejected:** publishing from a Linux-only success, using skipped/native-mocked cases as platform qualification, or making percentage coverage a substitute for behavioral evidence.

### 16. Documentation and branch hygiene remain explicit release work

Inventory all tracked project-owned READMEs and active README-producing renderers, including root, telemetry/bootstrap infrastructure, state migration, generated application/infrastructure/functions/prompts and governance guidance. Update directly inconsistent guides, CLI examples, ownership explanations and release claims. Keep one canonical source for each generated document and check packaged local links.

Only `main` and `develop` are permanent branches. Temporary feature, repair, release and Dependabot branches remain valid while their work/PRs are active. Cleanup requires live ref/PR inventory, preservation of unmerged commits and dirty worktrees, release by the owning session/user, and explicit approval for destructive actions. Prune verified stale tracking refs and delete only an explicit reviewed branch list. Do not disable Dependabot to maintain a literal two-ref count.

**Alternative rejected:** bulk branch/worktree deletion, rewriting user history, or documenting the proposed capability set before it is qualified.

### 17. Recognize current GitHub ruleset fields without weakening assessment

Issue #82 is a response-compatibility defect in `src/domain/governance/assessment/live-normalize.ts`, with effective-policy interpretation also needed in `predicates.ts` and the repository readback path. Add explicit supported decoding for pull-request parameters `dismissal_restriction`, `require_extra_approval_for_unattributed_changes`, and `required_reviewers`, including validated nested actor/reviewer structures, counts and applicable path conditions.

Keep the supported observation values. Disabled/empty defaults and each field individually must normalize successfully. The extra-approval flag has no effect when the ruleset requires zero approvals; a true default must not be reported as a new mandatory approval or provoke an unnecessary ruleset write. Conversely, nonempty reviewer rules can carry meaningful conditional requirements even when the top-level count is zero. Evaluate the complete applicable constraint rather than relying only on that top-level count or the presence of a collection.

Preserve observed configuration separately from its effective policy comparison. Known neutral defaults can compare equivalently under the pinned provider contract, but genuinely unknown fields, malformed nested values and unsupported rule/parameter combinations still block complete normalization. Do not discard arbitrary review restrictions, disable strict decoding, fabricate missing values, or rewrite historical observations/receipts to obtain alignment. Any incompatible persisted-normalization or digest change requires explicit identity/compatibility treatment.

Qualify older responses omitting the optional additions, all defaults together, each field independently, reviewer visibility versus required approvals, enabled dismissal restrictions, malformed types, nested unknowns and an actually unknown parameter. Reuse the same normalized meaning across assessment, planning, approved control reconciliation and readback before #79 can qualify.

**Alternative rejected:** stripping the new fields, treating every extra-approval flag as active under zero-review policy, or mutating repository controls merely to make old normalization pass.

### 18. Visualize existing telemetry through Azure Monitor's built-in Grafana

The audience is Liftoff maintainers checking recorded usage, command/version distribution, nonzero exits and event recency. Use the Azure portal's existing Grafana experience in Operate mode: familiar native panels, restrained status styling, clear units, accessible labels and a scannable layout rather than a custom frontend or new visual theme.

The data path remains CLI -> existing ingestion gateway -> existing data collection rule -> existing Log Analytics table -> dashboard queries. Reuse `LiftoffCommandEvents_CL` and its six Liftoff-defined columns: `TimeGenerated`, `EventName`, `SchemaVersion`, `Command`, `CliVersion`, and `Outcome`. Retain the five-field client event, opt-outs, exclusions, one-second best-effort delivery and 180-day storage policy unchanged.

Use the Azure-native `Microsoft.Dashboard/dashboards` resource, not a `Microsoft.Dashboard/grafana` Managed Grafana workspace. Manage the dashboard through the existing telemetry OpenTofu/AzAPI boundary with a pinned supported API, initially the documented stable 2025-08-01 contract, and qualify the actual Azure Monitor export/import payload. Dashboard JSON/KQL belongs in operator infrastructure source, not CLI runtime assets or generated project templates. Keep one canonical query definition per panel and deterministic rendering/provisioning.

Resolve subscription, workspace/resource bindings and deployment location from approved operator configuration and existing OpenTofu outputs such as `log_analytics_workspace_id`. Do not hard-code the observed subscription or workspace customer GUID in public dashboard source or copy operational credentials into configuration. Record stable dashboard/definition identities and expose its resource/portal location as an operator output.

Azure Monitor's built-in Grafana queries as the current signed-in user. Viewers need appropriate dashboard access and independent Log Analytics/table-query access; dashboard sharing must not grant data access implicitly. Use least-privilege, explicitly approved Azure RBAC. There is no dashboard data-source client secret, shared ingestion identity or new managed-identity reader to deploy for this hosting choice. Normal Liftoff CLI use, installer execution and generated-project Azure approval do not authorize telemetry dashboard provisioning or role assignment.

The initial dashboard uses a seven-day time range with manual refresh by default. A time picker and safely interpolated command/version filters apply consistently across panels. Queries use bounded time ranges and aggregation/row limits, with explicit handling of the workspace retention horizon and platform query errors.

| Panel | Interpretation |
| --- | --- |
| Recorded command events | Accepted records matching the selected time range and filters, not people or installations |
| Event volume over time | Time-bucketed command-event counts using server-generated timestamps |
| Events by command | Ranked counts for actual recorded command values |
| Events by CLI version | Observed version distribution, not an installation inventory or native-channel attribution |
| Nonzero exit outcomes | Counts/share labeled as nonzero exits; `Outcome = failure` also includes expected exit-2 states and is not a crash/error rate |
| Latest matching event | Timestamp and age within the selected scope, with refresh/timezone context; absence of events alone is not proof of service outage |

Loading, successful empty results, filtered no-data, missing table, denied data access, query/throttling failure and stale displayed observations must be distinguishable. Never convert an unavailable query into zero usage or a healthy status. Use readable tables/labels and redundant text rather than color alone; validate the layout in the actual supported Azure portal host, including narrower viewports.

Show the data-quality boundary: events are anonymous and best-effort; opted-out/CI/excluded/offline executions are not a complete census, and the public unauthenticated endpoint can receive forged events. No unique-user, DAU, device, geography, session or individual-developer panel can be derived from this contract. Do not introduce identifiers, IP collection, retention changes or synthetic production events to populate the dashboard.

Provision only the exact reviewed dashboard and any separately approved minimal access changes. Matching reconciliation should be a no-op; portal edits become visible drift requiring review. Rollback/removal affects only the owned dashboard scope and never destroys the protected resource group, workspace, table, DCR, gateway, retained telemetry or state perimeter.

The built-in dashboard has no separate Grafana hosting charge, but existing Azure Monitor storage/query costs still apply. Grafana alerting, scheduled reports, library panels and other unsupported built-in-host features are out of scope. If the selected platform/API cannot satisfy the dashboard contract, report a qualification blocker rather than silently provisioning paid Managed Grafana or substituting another dashboard product.

**Alternatives rejected:** a dedicated paid Grafana service for this Azure Monitor-only use case, an anonymous public dashboard, a new telemetry schema for user tracking, and Workbook substitution for the requested Grafana surface.

Reference contracts: Microsoft Learn's Azure Monitor Grafana overview and `Microsoft.Dashboard/dashboards` resource reference; Grafana's Azure Monitor Logs integration; GitHub's documented pull-request ruleset fields and effective-approval semantics.

## Risks / Trade-offs

- **Large coordinated scope** -> Work through dependency-ordered internal milestones and trace every promised capability to source, tests, qualification and docs; do not reduce the agreed release scope silently.
- **Native runtime or assets behave differently after relocation** -> Start with private Node semantics, qualify the full bundle on every declared target, and separate own-runtime invocation from project tools.
- **Direct npm cutover strands old users or collides with a launcher** -> Publish one-time instructions and an unlinked native migration entrypoint, verify ownership, preserve historical packages, and never remove unrelated runtimes or project dependencies.
- **Identity changes invalidate or accidentally bless history** -> Freeze exact old/new tuples and algorithms, use approved append-only migration/revalidation, and test unknown/future identities and changed real publication separately.
- **Repository-only proof leaks into full activation** -> Dedicated phases/completion groups, exact scope binding, explicit main hold and separately approved later qualification.
- **LLM proposals or project scripts exceed their intended scope** -> Treat proposals as untrusted, enforce structural/identity/approval limits, disclose trusted-code effects, and block workflows requiring unavailable sandbox guarantees.
- **Windows controller fails under host restrictions or load** -> Diagnose actual failures, qualify stock supported hosts, preserve uncertain workspaces, and never weaken execution policy or settlement requirements as a fallback.
- **Manager catalog or signing/qualification access is unavailable** -> Block coordinated publication and report the missing prerequisite; do not substitute npm, unsigned artifacts or mocked production evidence.
- **Provider response evolution is mistaken for policy drift** -> Qualify #82's supported defaults and meaningful restrictions through strict typed normalization and semantic comparison; unknown enforcement remains blocked.
- **Telemetry volume or query failure is misread as people, errors or health** -> Use explicit recorded-event/nonzero-exit labels, data-quality notes and distinct no-data/access/query states without zero-value fallbacks.
- **Dashboard rollout widens cost, identity or data authority** -> Use the confirmed Azure Monitor Grafana host, current-user RBAC and an exact OpenTofu dashboard plan; preserve ingestion, retention and existing resources.

## Migration Plan

1. Freeze the baseline inventory, support/qualification matrix and exact new contract tuple. Add characterization and failure-reproduction cases before moving existing implementations.
2. Extract the shared protocol/kernel seams and six engine ownership boundaries while preserving existing commands and registered recovery formats.
3. Implement assessment/adoption, template/skill catalogs, cask/native distribution and installation handover, activation migration/executors/repository scope, #82 normalization, the two generator fixes and the telemetry Grafana dashboard behind the declared contracts.
4. Qualify all old-to-new paths, including the affected schema-3 publication sequence, current GitHub defaults/restrictions, v2-v7 manifests, legacy repair records, native installation conflicts, dashboard queries/access and incomplete-effect recovery.
5. Produce signed immutable native artifacts from one reviewed source version. Stage and verify the Homebrew cask/WinGet/direct delivery metadata and independently approved operator-dashboard deployment, then advance the stable release only when all required channels and qualification are ready.
6. Existing users replace only the CLI installation, inspect their projects, and separately approve any managed integration, manifest, repair or activation migration. Do not run initialization over existing projects.
7. For failure, stop at the actual recorded boundary. Use owner-specific installer recovery or the exact registered project/provider recovery path. Preserve history, changed external facts and working installations; never restore old bytes blindly over new work.

## Open Questions

These are operational values, not unresolved product scope:

- Final coordinated CLI SemVer, approved Homebrew tap/WinGet publisher identities, and immutable artifact hosting identifiers must be fixed before release metadata is produced.
- Signing identities, approved native runners and disposable GitHub/Azure qualification resources require maintainer-provided access through secure channels. Public identifiers and spending/time bounds belong in reviewed qualification inputs; credentials do not belong in these artifacts.
- The final phase graph hash and observed performance budgets are computed/qualified during implementation. A failing result blocks release rather than changing the agreed contracts.
- Exact dashboard resource name/location and approved viewer/editor assignments are operator inputs. The hosting choice is settled as Azure Monitor dashboards with Grafana; these values do not authorize a dedicated Grafana service, broader data roles or production deployment during planning.
