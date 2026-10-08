# Tasks

All boxes below are implementation work, not completed exploration. Follow the numbered dependency stages; a capability must remain unadvertised until its production path is qualified. Publication, signing/account changes, external repository creation, credentials and live Azure/GitHub effects require their own explicit authorization. Each stage owns its tests and related documentation; the final stage checks integration only.

## 1. Freeze contracts and establish reproducible quality gates

References: design D14; liftoff-quality-gates, liftoff-user-documentation.

- [x] 1.1 Capture current help/JSON/rendered-artifact fixtures, supported v2-v7 manifests, released activation identities and original history digests; verify the capture against the actual checked-out/published versions without changing fixtures to bless new behavior.
- [x] 1.2 Declare pinned compatible coverage providers and source-complete CLI/service coverage commands with all four thresholds at 80.01%; verify a missing report, excluded unimported entrypoint and deliberately lowered metric each fail the gate.
- [x] 1.3 Add meaningful activation-validator/transition/approval failure and recovery cases for uncovered branches; verify targeted tests and a fresh CLI source report rather than relying on saved exploration coverage.
- [x] 1.4 Cover repair-preparation, binding/reference, tool-identity, cancellation and concurrent-edit branches; verify targeted tests preserve original project/staging bytes and retain actual partial effects.
- [x] 1.5 Cover GitHub/provider/credential adapter error, pending-operation and public capability-denial paths without contacting real accounts; verify meaningful negative assertions rather than success-shaped injected qualification.
- [x] 1.6 Cover ingestion startup, managed-identity failure, upload failure, malformed HTTP and graceful/forced shutdown; verify the gateway's independent four-metric report exceeds the threshold.
- [x] 1.7 Wire coverage reports, revision/source-inventory metadata and failing thresholds into CI/release qualification; verify both packages independently pass and a passing CLI cannot mask a failing gateway.
- [x] 1.8 Update CONTRIBUTING.md, DEVELOPER.md and coverage guidance with reproducible invocations, report scope and native/live limits; verify documented commands and documentation tests match the new gate.

## 2. Extract responsibility boundaries and bundled plugins

Depends on 1. References: design D1-D2; liftoff-bundled-plugins, liftoff-template-ownership, liftoff-supported-stack-baselines.

- [x] 2.1 Extract remaining mixed governance rendering/commands and installer logic behind existing application/domain/adapter interfaces; verify public fixtures and existing import/cycle tests remain unchanged before intentional behavior work.
- [x] 2.2 Define typed bundled contribution contracts and deterministic registry validation for stable IDs, API versions, digests, combinations and artifacts; verify duplicate/missing/incompatible contributions fail before rendering.
- [x] 2.3 Register existing Python/FastAPI, Node/Fastify, Go/Huma, Azure, workflow and agent capabilities as first-party built-ins; verify all current supported stacks and nine GenAI pattern identities retain their actual behavior and maturity limits.
- [x] 2.4 Move plugin-specific templates/locks to one canonical asset inventory and shared material to shared assets; verify before/after generation parity and exact logical-name/lifecycle snapshots.
- [x] 2.5 Extend baseline/audit/package inventories for every plugin asset and installable dependency set; verify missing locks/assets and omitted packaged dependencies fail smoke/audit checks.
- [x] 2.6 Enforce dependency direction and prohibit runtime project/plugin-directory discovery; verify import-boundary tests and a repository-supplied executable plugin are rejected without execution.
- [x] 2.7 Add Windows native path/case/junction collision tests for plugin composition and packaged lookup; verify equivalent portable identities on macOS/Linux and no broad directory ownership.
- [x] 2.8 Document plugin/core/adapter responsibilities and one-copy template locations in the contributor/module guide; verify examples point to real files and describe first-party trust rather than sandboxing.

## 3. Introduce current project and activation compatibility contracts

Depends on 2. References: design D6; liftoff-manifest-contract, liftoff-activation-migration, liftoff-project-update.

- [x] 3.1 Define v8 workload/workflow/framework/agent/profile/plugin/layout schemas with explicit Manual not-required state and finite portable bindings; verify strict positive/negative schema fixtures, including unknown keys and invalid identity combinations.
- [x] 3.2 Preserve exact supported v2-v7 readers and retirement/unsafe-inner-boundary behavior; verify historical manifests and generation hashes remain byte-preserved and unknown sources cannot fall through to ordinary Git handling.
- [x] 3.3 Allocate advancing activation/graph/state/evidence/approval/compatibility constants from the actual representation changes and compute canonical graph hashes; verify one authoritative identity table and reject mixed/future/placeholder tuples.
- [x] 3.4 Add explicit plugin/layout bindings and adoption provenance distinct from original generation history; verify compatible custom paths do not become managed-core authority or forged generation hashes.
- [x] 3.5 Implement current v8 writers and guarded schema-successor publication, including original-target preservation for metadata-changing active maintenance; verify double-render determinism, exact original bytes/modes and no random telemetry IDs in template/manifest output.
- [x] 3.6 Extend historical activation-to-current successor maps and exact snapshot/index/journal relationships; verify original records, line endings, modes, nested history and retention timestamps survive without retagging.
- [x] 3.7 Wire update's reviewed v8/local-successor transaction and finite revalidation, keeping maintenance source observation separate from installed readiness; verify interruption, stale preview, changed source or collection membership, damaged original-target/history links and post-commit failure preserve actual progress and original transition/preparation identities without automatic downgrade.
- [x] 3.8 Update manifest/versioning and state-migration README guidance to distinguish historical readers, current targets, private APIs and deferred public deployment-state work; verify documentation examples against actual constants.

## 4. Add Manual workflow and conditional workstation readiness

Depends on 3. References: design D7; liftoff-cli-workflow, liftoff-project-scaffold, liftoff-workstation-bootstrap, liftoff-project-doctor.

- [x] 4.1 Add Manual to the development-workflow catalog/prompt and `--spec`, preserving OpenSpec omission defaults; verify interactive/noninteractive/configuration parity and invalid input rejection.
- [x] 4.2 Support Manual empty agent selection and `--agents none`, rejecting mixed none/real IDs and retaining external-framework nonempty/default-agent rules; verify all Manual subsets and every existing OpenSpec/Spec Kit subset.
- [x] 4.3 Separate bundled CLI runtime from external workload/framework/agent prerequisites; verify native Manual/no-agent startup does not probe or require Node/npm/frameworks unless the selected project operation needs them.
- [x] 4.4 Remove unconditional framework calls and non-OpenSpec-equals-Spec-Kit fallbacks across generation, initialization, sibling migration and validation; verify Manual creates no framework directories, seeds, global profile reads or fictitious markers.
- [x] 4.5 Implement explicit native Manual local verification/finalization with optional agents and selected governance; verify no fake archive and valid CLI-only local completion without remote credentials.
- [x] 4.6 Keep governance-none Manual validation/repair usable without manufacturing governance state; verify actual CLI next actions and no nonexistent shell setup command.
- [x] 4.7 Add Windows, macOS and Linux Manual generation/path tests with spaces, case collisions and omitted tools; verify identical logical inventories and protected unselected framework files.
- [x] 4.8 Refresh workflow/prerequisite/getting-started guides and generated root/infrastructure README content for Manual and CLI-only use; verify each example against command definitions and documentation tests.

## 5. Deliver canonical skills and capability negotiation

Depends on 2-4. References: design D9; liftoff-bundled-plugins, liftoff-cli-workflow, liftoff-project-scaffold.

- [x] 5.1 Implement project-independent `liftoff capabilities --json` and preserve repair capability discovery; verify catalog entries represent actual modes/schemas/host boundaries and neither command performs telemetry, probes, network or state writes.
- [x] 5.2 Move canonical setup/repair/governance-assessment content into shared packaged sources while preserving existing Copilot/Claude/Codex logical paths and invocation forms; verify generated content/ownership and installed asset lookup.
- [x] 5.3 Generate selected Liftoff integrations for Manual without external framework artifacts and allow no-agent output; verify unselected/custom neighboring skills remain untouched.
- [x] 5.4 Require skills to negotiate actual commands/recipes and use external staged patches with independent permission boundaries; verify contract fixtures prohibit invented receipts, retrospective approval and direct real-project patching.
- [x] 5.5 Add shared whole-project assessment/adoption guidance that uses only advertised capabilities; verify CLI-only fallback and capability-mismatch remedies without fabricating commands in old releases.
- [x] 5.6 Document native invocation, ownership/update rules, agent-host/model distinction and staging limitations; verify equivalent instructions and packaged links for all three hosts.

## 6. Add shared project assessment and active-layout interpretation

Depends on 3-5. References: design D8; liftoff-project-assessment, liftoff-governance-assessment, liftoff-project-doctor.

- [x] 6.1 Implement bounded static inventory for supported application layout, dependencies, framework/agents, CI/infrastructure and documentation; verify no project-script execution, unsafe link traversal, secret/state payload reads or unbounded repository scan.
- [x] 6.2 Share explicit active-binding and expected-managed-context interpretation across update, repair, doctor and assessments; verify compatible custom layouts do not become cosmetic migration debt.
- [x] 6.3 Add `liftoff assess` and explicit `--governance` comparison target selection, preserving the narrower governance-assess contract; verify target selection is advisory and does not change project profile or query registry latest.
- [x] 6.4 Compose stable findings/provenance/coverage and schema-1 reports with deterministic ordering and 0/1/2 outcomes; verify missing evidence, unknown applicability, denied/paginated reads and genuine differences remain distinct.
- [x] 6.5 Wire scoped live metadata collection with existing permissions only; verify assessment/help/capabilities stay telemetry/disclosure/receipt-free and never enroll credentials or execute recommendations.
- [x] 6.6 Add ordinary-Git, explicit non-Git, nested-manifest/worktree and monorepo tests on Windows/macOS/Linux; verify unsafe inner boundaries stop rather than select an outer project.
- [x] 6.7 Document the assessment/remediation categories and update the canonical assessment skill; verify examples distinguish core update, application repair, adoption, workflow changes and deferred deployed-state work.

## 7. Implement reviewed in-place adoption and preserved-layout repair

Depends on 3-6. References: design D8-D9; liftoff-project-migration, liftoff-project-repair, liftoff-template-ownership.

- [x] 7.1 Register adopt parsing/help/JSON/preview/approval/recovery surfaces with separate schema-1 identity; verify bare non-TTY/JSON previews only and invalid authority flags fail before effects.
- [x] 7.2 Build supported in-place plans from static evidence and explicit compatible bindings; verify existing application paths and Git history remain unchanged when already compliant.
- [x] 7.3 Implement necessary per-file mapping/reference review across imports, build/tests, Docker/Compose, CI and docs; verify unresolved mappings and unsupported language/framework conversion remain blocked rather than replaced with starters.
- [x] 7.4 Extend external preparation/check staging to non-Liftoff adoption candidates while retaining exact independent preparation/script/network permissions; verify failed or declined checks cannot authorize a file transaction.
- [x] 7.5 Implement exact adoption metadata/core/application publication with authenticated external transaction ownership; verify rollback/resume works even when the final manifest was never written and concurrent edits survive.
- [x] 7.6 Add separately reviewed active-binding publication after verified application moves without allowing patches to write provenance; verify partial binding failure reports committed file effects and cannot repeat the move or invent generation history.
- [x] 7.7 Preserve sibling migrate safety and add its Manual/current-manifest output; verify source snapshots, filtered staging, strict OpenSpec plans, non-OpenSpec checklist and verification-before-cleanup.
- [x] 7.8 Enforce existing-deployment/state planning-only boundaries in adopt and repair; verify absence of local state or an approved local patch never enables resource/state mutation.
- [ ] 7.9 Qualify Windows paths, junctions, modes, spaces, process settlement and interrupted transaction handling alongside macOS/Linux; verify exact ownership without broad cleanup.
- [x] 7.10 Update existing-repository, migration and application-repair guides plus generated migration instructions; verify complete developer/agent/CLI-only journeys and honest partial completion.

## 8. Implement workflow and profile transitions with integration repair

Depends on 3-7. References: design D7-D10; liftoff-project-migration, liftoff-project-update, liftoff-repository-governance-profile.

- [x] 8.1 Implement reviewed workflow-set plans and exact check/apply/recovery interfaces; verify source workflow, target, agent selection, current files, checks and expiry bind one immutable plan.
- [ ] 8.2 Implement external-framework-to-Manual transition without deleting framework documents/history or uninstalling shared tools; verify preserved bytes and correct native local readiness.
- [ ] 8.3 Implement transitions into pinned OpenSpec/Spec Kit using official isolated staging and separate tool/global-profile consent; verify collisions, active overlapping changes and invalid framework output block safely.
- [ ] 8.4 Complete additive agent/default repair for external workflows and Manual; verify existing integrations/defaults are preserved unless the exact requested change authorizes them.
- [ ] 8.5 Add team profile assets, identity, input selection and one-independent-human-review rules while retaining single-maintainer defaults; verify self/bot/stale approvals fail and no deployment-reviewer requirement is added implicitly.
- [ ] 8.6 Implement profile-specific assessment and a distinct local policy/successor update plan for explicit profile changes; verify stronger existing controls, CODEOWNERS and old proof are not silently weakened/reused.
- [ ] 8.7 Extend update routing and shared output contracts for workflow/profile/plugin incompatibility; verify ordinary update and force cannot execute another lane or enroll telemetry.
- [ ] 8.8 Update all affected workflow/governance/repair guides and generated governance README sources; verify both profiles, all workflow directions, CLI-only use and Windows literal command rendering.

## 9. Build and qualify runtime-inclusive distributions

Depends on 2-5. References: design D3; liftoff-native-distribution, liftoff-npm-distribution, liftoff-supported-stack-baselines.

- [x] 9.1 Build a runtime-inclusive bundle from the existing implementation and explicit asset/license inventory; verify help/version/capabilities/plan and HCL/native-helper resolution outside the checkout without global Node/npm.
- [ ] 9.2 Qualify native Apple Silicon runtime dependencies and determine/document the minimum macOS floor; verify unsupported Intel/translated/unqualified hosts are refused before installation changes.
- [ ] 9.3 Produce signed/notarized macOS packaging and a cask definition under a verified approved namespace; verify signature/notarization, exact artifact checksum, install/uninstall ownership and no forced launcher overwrite in isolation.
- [ ] 9.4 Produce a signed Windows x64 installer and WinGet manifests under a verified approved ID; verify stock policy behavior, executable locking, native paths and packaged controller assets in Windows CI.
- [ ] 9.5 Produce verified Linux x64/arm64 archives and a user-local installer with declared glibc/runtime floors; verify signatures/checksums, atomic owned installation and refusal of unqualified musl/platform combinations.
- [ ] 9.6 Extend immutable release manifests, exact-artifact handoff, SBOM/notices and provenance for every native asset; verify changed digests/source/version or absent signing evidence block publication without changing existing npm account settings.
- [ ] 9.7 Add native package smoke tests and missing-asset/foreign-cwd fixtures on each advertised platform; verify tests never alter the developer's real global installation.
- [ ] 9.8 Refresh installation/prerequisite/root README guidance and release-maintainer instructions as artifacts become qualified; verify actual package IDs/commands and no unqualified support claims.

## 10. Implement installation-owner-aware upgrade and doctor

Depends on 9. References: design D4; liftoff-cli-self-upgrade, liftoff-project-doctor, liftoff-npm-distribution.

- [ ] 10.1 Implement authoritative owner detection for npm, cask, WinGet and Liftoff-native receipts; verify local/npx/link/ambiguous/escaping origins fail and Homebrew Node's npm prefix is not mistaken for cask ownership.
- [ ] 10.2 Implement verified native stable metadata and independent selected-channel availability; verify lag, timeout, invalid metadata, prerelease/downgrade and changed-channel cases do not report false current/installable status.
- [ ] 10.3 Preserve scoped npm mirror precedence, neutral directories and verified prefix handling in its compatibility adapter; verify no persistent configuration/cache changes or mirror bypass.
- [ ] 10.4 Implement bounded same-owner check/apply or supported manual handoff, exact target binding and post-install verification; verify no broad package upgrades, automatic elevation or direct overwrite of manager-owned files.
- [ ] 10.5 Add Windows lock/restart/handoff and Linux owned-version replacement cases; verify actual effects and unresolved executable selection are visible instead of upgraded success.
- [ ] 10.6 Publish schema-2 upgrade output and share owner/freshness semantics with doctor; verify legacy JSON remains documented and verification subprocesses produce no telemetry/disclosure.
- [ ] 10.7 Update owner-specific upgrade/recovery/doctor help and troubleshooting; verify exact commands, Windows quoting and separation from project update through installed-package tests.

## 11. Deliver the standalone Apple Silicon npm-to-Homebrew migration

Depends on 9-10. References: design D5; liftoff-native-distribution, liftoff-npm-distribution.

- [ ] 11.1 Build a standalone utility outside the old npm package with dry-run default and explicit apply; verify preview changes no installation/project/configuration and cannot bootstrap Homebrew.
- [ ] 11.2 Implement exact old-owner discovery for supported Homebrew Node, nvm, Volta and custom npm prefixes; verify multiple/unproven copies require explicit selection and no version-manager directory sweep occurs.
- [ ] 11.3 Preflight the supported host, reviewed cask/version, permissions/collisions and verified offline old-package recovery material before uninstall; verify every missing prerequisite leaves the old executable intact.
- [ ] 11.4 Implement journaled owning-npm uninstall, attributable residual-link cleanup and cask handover; verify shared launcher collisions, concurrent changes and unrelated packages/config/projects are protected.
- [ ] 11.5 Implement exact interrupted recovery and final ownership/version/asset/PATH verification; verify failures after uninstall can restore only attributable unchanged old scope and cannot overwrite a newer Homebrew/user installation.
- [ ] 11.6 Qualify the utility on isolated native Apple Silicon fixtures including paths with spaces and old unsupported upgrade commands; verify Intel/Windows/Linux refusal and no real-host global cleanup.
- [ ] 11.7 Prepare and qualify the npm bridge and migration documentation after cask availability; verify older users retain explicit-version packages, approved mirror behavior and an independent utility path without automatic migration.

## 12. Complete production discovery identity and provider readiness

Depends on 3-8. References: design D10-D11; liftoff-governance-activation-engine, liftoff-infrastructure-governance, liftoff-repository-governance-profile.

- [ ] 12.1 Replace placeholder/injected-only advertised discovery paths with bounded actual GitHub/Azure reads; verify exact repository, tenant, subscription, principal, environment and resource binding rather than trusting default account or matching names.
- [ ] 12.2 Derive minimal provider namespaces/features from approved resource types and inspect/register only authorized prerequisites; verify terminal Registered readback precedes dependent writes and shared registrations survive rollback.
- [ ] 12.3 Implement exact approval persistence, expiry/source binding and protected credential enrollment/use proof; verify no credential in chat/argv/source/public receipts and a policy file alone cannot establish readiness.
- [ ] 12.4 Enforce new-environment versus same-operation-owned versus pre-existing deployment classification before every effect; verify unknown/occupied/brownfield cases remain planning-only without duplicate resources or sensitive state reads.
- [ ] 12.5 Implement bounded asynchronous handles, current reobservation and sanitized partial-failure records; verify retry observes existing operations without redispatch and stale ownership blocks compensation.
- [ ] 12.6 Update Azure/governance/setup guidance with real prerequisites, profile differences and exact producer limits; verify no unsupported public stateful command is advertised and no credentials are needed for local completion.

## 13. Qualify protected new-environment backend and execution prerequisites

Depends on 12. References: design D11; liftoff-governance-activation-engine, liftoff-infrastructure-governance.

- [ ] 13.1 Implement verified reuse of an approved private backend/execution path without adopting unknown deployment state; verify identity, reachability, locking/versioning and readback conditions with positive/negative tests.
- [ ] 13.2 Implement only the minimal separately approved new-environment bootstrap when reachability requires it; verify scoped names, cost, permissions and owned operation records before billable writes.
- [ ] 13.3 Complete applicable repository-dedicated hosted-runner/network prerequisites with exact labels, routing, DNS and one approved egress mode; verify real reachability and keep unavailable org/account capabilities explicit blockers.
- [ ] 13.4 Qualify protected state handling/handover only for resources created by the same approved bootstrap, with backups, exact mapping/concurrency, no-change verification and retention; verify the public API still rejects arbitrary pre-existing state import/partition/relocation.
- [ ] 13.5 Preserve due-time/custody/disposal obligations and unsupported-host admission; verify absent protected storage/keys/locking blocks rather than falling back to plaintext or an unapproved execution host.
- [ ] 13.6 Run explicitly approved disposable native/cloud qualification for each advertised execution combination; verify reports separate real outcomes from mocks and preserve partial checkpoints on failure.
- [ ] 13.7 Update generated infrastructure/bootstrap guidance and state-migration README with the narrow new-owned-bootstrap exception and deferred brownfield scope; verify examples use actual qualified hosts and commands.

## 14. Complete application deployment qualification and enforcement

Depends on 12-13. References: design D10-D11; liftoff-governance-activation-engine, liftoff-repository-governance-profile, liftoff-governance-assessment.

- [ ] 14.1 Implement approved registry/identity prerequisites and source-bound immutable application artifact publication; verify deployment cannot proceed with a placeholder, tag-only or mismatched artifact.
- [ ] 14.2 Implement bounded OpenTofu new-environment apply/readback and actual workload health/qualification; verify exact subscription/environment/resource/cost bindings and preserve current application customizations.
- [ ] 14.3 Implement real workflow/source publication and token-safe exact-commit dispatch for required context proofs; verify green and controlled-red on every applicable protected ref family without synthetic status substitution.
- [ ] 14.4 Complete ruleset-last idempotent enforcement and independent effective-rule readback for both profiles; verify team independent approvals and single-maintainer zero-review rules remain distinct.
- [ ] 14.5 Implement operation-scoped recovery and already-approved emergency compensation without requiring failed release checks to pass; verify no arbitrary resource/state rollback or erasure of later changes.
- [ ] 14.6 Implement due lifecycle execution/status with exact retained scope and current authority; verify local/activation/lifecycle completion and consistent-incomplete exit 2 agree across CLI and skills.
- [ ] 14.7 Complete supported profile evaluators with real evidence producers and explicit unsupported external coverage; verify whole-project and governance assessments cannot report full alignment while mandatory proof is missing.
- [ ] 14.8 Qualify an explicitly approved disposable new-environment journey for both profiles and representative supported workloads; verify actual artifact/deployment/health/check/ruleset proof and no false brownfield completion.
- [ ] 14.9 Refresh Azure, governance, troubleshooting and generated governance/infrastructure READMEs for the qualified journey; verify every next action is registered and independently permissioned.

## 15. Version telemetry outcomes and ingestion contracts

Depends on 1 and 3. References: design D12; liftoff-cli-telemetry.

- [x] 15.1 Define command schema 2 semantic outcomes and exact project_observed schema 2/dimension allowlists; verify expected exit-2 drift, cancellation and actual partial failures are classified correctly while v1 records retain old semantics.
- [x] 15.2 Extend strict endpoint parsing and managed-identity upload for separate command/project records under the 1-KiB streamed limit; verify unknown fields/versions, raw metadata and malformed/oversized bodies are rejected without logging.
- [x] 15.3 Add project table/DCR declarations with 180-day analytics/total retention, preserving existing command table/data and logging exclusions; verify static OpenTofu and privacy-contract tests on supported hosts.
- [ ] 15.4 Implement shared one-second ordinary-command telemetry delivery budget, at most one request per channel, no queue/retry and verification-probe exclusions; verify unreachable endpoints do not alter ordinary output/exit.
- [ ] 15.5 Add explicit reporting-result behavior without recursive aggregate emission; verify status/disabled/failure delivery results and strict telemetry-free assessment/capability/help paths.
- [x] 15.6 Update service/operator/privacy documentation with schema rollout and historical semantics; verify package links and independent gateway coverage remain above the floor.

## 16. Add explicit project enrollment and optional monthly CI reporting

Depends on 3-8 and 15. References: design D12; liftoff-cli-telemetry, liftoff-template-ownership.

- [ ] 16.1 Implement explicit status/enrollment/disable/report CLI operations and disclosure versioning; verify install, generic yes, existing notices and copied repository records cannot opt a developer in.
- [ ] 16.2 Create per-project random identity only during approved enrollment and bind local consent externally; verify deterministic rendering, clone/worktree identity preservation, independent monorepo IDs and deliberate fork/copy reenrollment.
- [ ] 16.3 Preserve global opt-outs, invalid/read-only config and unknown fields across enrollment and installer migration; verify no notice/consent writes or transport occur when opted out.
- [ ] 16.4 Add a separately approved monthly repository-scoped heartbeat workflow with explicit root inventory and pinned CLI/action/tooling; verify no application scripts, project scan, upgrade, repair or Azure deployment runs.
- [ ] 16.5 Implement the narrow explicit CI heartbeat exception while retaining ordinary CI=true disablement; verify both global opt-outs always win and no event is sent for absent/disabled/unsupported project records.
- [ ] 16.6 Implement reviewed heartbeat entry updates/removal for nested monorepo projects with explicit repository authority; verify other project entries and custom workflow bytes are preserved on Windows/macOS/Linux.
- [ ] 16.7 Add bounded consent/identity/transport integration tests including moved checkout receipts and no telemetry on assessment/live/help/capabilities/status; verify measurement identity never becomes write approval or authentication.
- [ ] 16.8 Document pseudonymity, first-observed/windowed metrics, heartbeat meaning/delays, disablement versus retention and operator-reviewed deletion; verify generated README/setup guidance never enrolls implicitly.

## 17. Extend the approved Azure telemetry deployment and Grafana dashboards

Depends on 9 and 15-16 for qualified candidate artifacts and client contracts, not prior client publication. Production steps require separate operator approval. Use synthetic observations to qualify ingestion before publishing/enabling the client and heartbeat. References: design D13; liftoff-telemetry-dashboard, liftoff-cli-telemetry.

- [ ] 17.1 Re-observe the exact subscription/resource group, existing Korea Central resources, state ownership/perimeter, table schemas and provider availability through authorized read-only access; verify the proposed plan has no unintended replacement or region/default drift.
- [ ] 17.2 Add version-pinned Managed Grafana, scoped managed-identity Logs access, datasource and explicit dashboard provisioning; verify actual Standard tier/size/cost/region and provider registration are disclosed before apply.
- [ ] 17.3 Build 30/90/180-day observed/first-observed project, version/policy/template, source/freshness and semantic-outcome panels; verify fixed datasets deduplicate clones and count separate monorepo roots correctly.
- [ ] 17.4 Implement explicit unavailable/empty/disabled/stale and legacy-semantic states plus synthetic-project exclusions; verify forged/public-event caveats, retention-window labels and no lifetime/census/compliance claims.
- [ ] 17.5 Add bounded ingestion-fault/heartbeat-freshness alert definitions with disclosed grace periods; verify low daily CLI usage does not trigger an abandonment/failure claim.
- [ ] 17.6 Update telemetry and bootstrap READMEs with OpenTofu-only deployment, cost/RBAC, consent schema, verification and rollback instructions; verify static configuration, dashboard JSON and documentation tests without production access.
- [ ] 17.7 After explicit operator approval, deploy backward-compatible gateway/table/DCR changes first, then Grafana; verify real identity access, synthetic ingestion/query, 180-day retention and continued absence of request/IP/console logging.
- [ ] 17.8 Exercise approved feature disablement/dashboard rollback without destroying the protected group, workspace/data, backend or perimeter; verify existing anonymous ingestion remains operational and records survive.

## 18. Qualify the integrated release and complete the change

Depends on all prior stages. This group is integration verification, not a substitute for earlier tests/documentation.

- [ ] 18.1 Run the complete declared workload/workflow/agent/profile and native-host qualification matrix, including Manual/no-agent, preserved layouts, old manifests, clean installs and Apple Silicon handover; verify every advertised combination and explicit unsupported boundary.
- [ ] 18.2 Run fresh independent CLI/gateway coverage, import boundaries, repository policy, template audits, generated-container/OpenTofu checks and installed native/npm smoke tests; verify all four metrics exceed 80% and every report identifies its exact revision/inventory.
- [ ] 18.3 Verify a representative old Liftoff project and a non-Liftoff project through their complete separate migration journeys; confirm original code/Git/history and opt-outs are preserved except exact approved changes, and brownfield state remains untouched.
- [ ] 18.4 Audit the explicit inventory of all four maintained READMEs, generated README sources and related guides against actual commands, schemas, capabilities and package links; verify no stale npm-primary, fake archive, wrong completion, unsupported public stateful or anonymous-project-ID claim remains.
- [ ] 18.5 Verify release assembly uses the same qualified immutable source/artifacts across native channels and npm bridge, with native assets available before migration guidance and ingestion ready before project reporting; publish only with separate maintainer authorization.
- [ ] 18.6 After authorized publication, qualify installed client enrollment/reporting and a separately enabled heartbeat in an explicitly approved disposable project using the exact published pins; verify actual ingestion/deduplication and opt-out behavior before claiming live end-to-end reporting.
- [ ] 18.7 Check every proposal capability against its implemented scenarios and retained evidence, then run strict OpenSpec validation; mark only actually completed tasks and leave unavailable external qualification/deployment tasks explicitly incomplete rather than archiving or claiming full delivery.
