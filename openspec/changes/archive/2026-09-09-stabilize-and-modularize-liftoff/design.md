## Context

See `proposal.md` for motivation and agreed scope. The current package is 0.10.4 and contains eight functional responsibility groups in one TypeScript CLI. The main concentration points are `commands.ts` (4,001 lines), `templates.ts` (3,637), activation `transitions.ts` (2,566), and `file-system.ts` (1,631). The small `genai-templates.ts` delegates callbacks rather than owning its implementation.

The existing foundation is worth preserving: explicit artifact lifecycles, path-part identities, guarded transactions, independent consent, a packaged policy/graph/catalog, and read-only assessment. API/GenAI application files are project-owned after generation. The 26-phase activation graph includes missing production handlers; the assessment catalog includes unsupported controls. Neither file generation nor those declarations establishes production readiness.

## Goals / Non-Goals

**Goals:**

- Make remaining responsibilities independently understandable and replaceable without changing the public CLI accidentally.
- Give assessment the same trustworthy observation semantics for initialized projects and ordinary Git repositories.
- Correct existing execution, configuration, recovery, and classification boundaries rather than hide failures behind renamed modules or successful-looking defaults.
- Preserve exact ownership and consent across macOS, Linux, and Windows.

**Non-Goals:**

- Separate npm packages, microservices, a dynamic plugin ecosystem, or a new general-purpose templating language.
- Completing the deferred production handlers, implementing public approval-persistence/credential-enrollment workflows, or automatically reconciling historical activation into executable current state.
- Implementing the missing specialized GenAI behaviors listed in the proposal.
- Migrating existing application source or infrastructure/state layout through `update`, `--force`, or assessment.
- Changing the fixed governance policy into a generic recommendation framework, adding AWS/GCP support, deploying resources, or publishing a release as part of implementation.

## Decisions

### 1. Keep a modular monolith with thin compatibility entry points

Use this responsibility layout, with final filenames chosen to match each cohesive operation:

```text
src/
  cli.ts                         public executable shim
  commands.ts                    temporary import-compatible facade
  cli/
    args/                        parsing and help
    commands/                    per-command transport handlers
    presentation/
  application/
    initialize/
    migrate/
    update/
    upgrade/
    diagnose/
  domain/
    project/                     plans, manifest contracts, ownership
    governance/
      policy/                    identities, graph and control definitions
      activation/                planning, readiness, approval, evidence
      assessment/                observations, comparison and coverage
  generators/
    common/
    standard/
    genai/
    containers/
    infrastructure/
  adapters/
    filesystem/
    process/
    frameworks/
    git/
    github/
    azure/
    npm/
    packaged-assets/
assets/
  governance/
  locks/
```

The dependency direction is CLI/composition -> application -> domain. Adapters implement narrow ports and are wired at composition boundaries. Generators consume normalized plans and resolved asset content; domain rules do not import filesystem, process, or provider clients. There is no assessment-to-activation execution dependency.

Preserve `dist/cli.js`, existing CLI syntax except explicit retirement, and useful source import facades while callers move. Internal modules must not route through those facades. Asset lookup uses one installed-package-root resolver rather than new relative-depth calculations in every moved module.

Move actual implementations. A new file that forwards callbacks into an unchanged monolith does not satisfy this decision. Avoid both catch-all utility modules and excessively fragmented one-function files. File size prompts review; no arbitrary line-count limit substitutes for cohesive ownership.

**Alternative rejected:** publishing engines separately would multiply release/compatibility coordination without solving the current coupling.

### 2. Centralize contracts, not a universal plugin framework

Maintain explicit registries for the two active workloads, nine pattern identities, artifact logical names/lifecycles, and phase handlers. A workload entry supplies applicable decisions, prerequisites, runtime/configuration contracts, generation boundaries, baseline recipes, and assessment facts. A phase entry identifies its planner, executor availability, permitted operations, evidence contract, and retry category.

Reuse existing catalogs and identifiers. Do not infer generated-file ownership from names, categories, globs, or directory prefixes. New artifact identities are added to the explicit inventory; existing identities are retired explicitly rather than reused for unrelated files.

The canonical policy/graph/catalog remain versioned data. Presentation, agent wrappers, and documentation project those contracts rather than creating independent authorities.

**Alternative rejected:** scattering workload switches or maintaining separate interpretations of evidence in status, doctor, readiness, and assessment perpetuates the observed inconsistencies.

### 3. Retire Power Apps as one coherent breaking slice

Remove active workload types, option definitions, planner/renderers, plugin probing, dependency/doctor paths, source-commit catalogs, vendored assets, baseline refresh/audit entries, package-smoke assertions, CI jobs, and positive documentation/specification contracts together.

Keep an exact retired-discriminator lookup at the input/manifest boundary. A recognized `power-apps-code-app` manifest is rejected before starter metadata, activation artifacts, deeper artifact paths, or live requests are interpreted. This applies to governance-disabled projects and diagnostic fallback readers too. The generic Git path is not a bypass.

Keep legacy Power Apps manifests only as negative fixtures. Port shared governance/rollback/seed scenarios to supported API/GenAI fixtures before removing their old fixture helpers. Do not uninstall machine-wide Power Platform tools or plugins, delete consumer project files, or reinterpret a retired project as a different workload.

**Alternative rejected:** a legacy support lane contradicts the user's full-retirement decision and would retain much of the coupling.

### 4. Resolve assessment roots without creating project state

Use explicit project descriptors for a supported Liftoff project, an ordinary Git repository, and an invalid/retired boundary. An explicit path is authoritative. Otherwise resolve the nearest applicable project/Git boundary, including worktree `.git` files and nested invocation paths.

A manifest that exists but is malformed, unreadable, a symlink/junction, dangling, or retired is an error boundary; do not walk past it into an outer project or fall back to ordinary-Git mode. Absence is different from invalidity. An ordinary Git repository needs neither a manifest nor generated prompts. The CLI remains usable directly; this change does not install slash commands into arbitrary repositories.

For ordinary repositories, use the installed single-maintainer policy as the explicit displayed target. Do not infer a different policy from observed branches. Reuse nullable project-identity fields and structured diagnostics in report schema v1. Missing Liftoff ownership/baseline/evidence is `not-observed`, not fabricated, aligned, or automatically inapplicable. A valid Liftoff governance opt-out retains its distinct `not-applicable` result.

Local reads never execute project scripts, hooks, filters, YAML, or `git status`. Live mode retains explicit consent, bounded endpoint allowlists, scope validation, and existing permissions. Ordinary Git mode can collect repository-bound GitHub facts; absent authoritative Azure/runner bindings withhold those reads. No default-subscription or organization-wide discovery is introduced.

**Alternative rejected:** initializing a repository as a prerequisite would mix assessment with mutation and prevent useful self-assessment of Liftoff.

### 5. Preserve independent facts and evaluate effective enforcement

Represent observation availability, source provenance, scope, freshness, and collection stability independently. Access denied, missing credentials, incomplete pagination, and timeouts are not evidence that local files changed. Only an actual change to a relevant input invalidates that input's dependent findings. A denied unrelated resource cannot erase a proven local or storage violation.

Evaluate repository rulesets, inherited/effective rules, and classic branch protections as the effective enforcement set. Compare check names and application bindings for `develop`, `main`, and the release/hotfix ref families. Bound live enumeration using the existing limits; if exact refs or effective rule coverage cannot be established, expose incomplete coverage rather than assume the two permanent branches represent all protected refs.

Resolve required jobs and their transitive `needs` dependencies without executing workflows. Unknown reusable-workflow, matrix, dynamic-name, or condition semantics remain unobserved. Do not infer safety from a passing aggregator job.

Runner alignment requires the full policy-relevant binding, labels, capacity, status, and repository/group restrictions, not just matching IDs. A complete observation of absent assignment is missing proof of compliance, not an unknown assignment. Evaluate independently available Azure facts per bound resource, require an authoritative environment/storage role, and diagnose conflicting bindings before deduplication. Approval phase names are not resource-role evidence.

Keep report and catalog schemas v1 because the target/classification vocabulary and nullable identity shape remain intact. Support counts identify available evaluators, not completed proof. Existing unsupported families and unavailable proof layers remain explicit. Enabled reports with those gaps still exit 2; do not remove controls or weaken requirements to obtain exit 0.

**Alternative rejected:** aggregating all provider success into a single Boolean destroys useful evidence and makes partial access look like missing facts everywhere.

### 6. Bind current execution to real inputs and preserve immutable history

Create a normalized phase-input snapshot from explicit workload/governance input inventories, relevant files under declared source roots, applicable workflow/seed metadata, and allowed Git metadata. Exclude dependency caches, generated execution outputs, state/evidence directories, and credential-bearing local configuration through explicit rules so writing a receipt does not invalidate itself. Public configuration is normalized through its contract; raw secrets are never retained in plans or reports.

Keep `baselineSha` as a canonical SHA-256 baseline digest, not a raw Git object ID. Record Git HEAD separately in the input snapshot. Derive input and transition digests from actual normalized inputs; remove permissive placeholder defaults from production contexts. Re-read relevant inputs before committing an outcome, and invalidate affected descendants when those inputs change.

Use an immutable execution/project anchor and a separate verified remote-repository binding. Establish a persisted anchor only during an explicitly executed local transition; inspection of an uninitialized project remains unbound. Phase 0 must not replace the identity under previously produced local receipts. Only matching verified remote bindings permit remote evidence reuse, and Phase 0's own outcome must be acceptable to subsequent inspection.

Evidence header v2 includes a `bodyDigest` over the canonical payload and normalized live-readback collection. Existing header references therefore bind the body transitively. Validate phase-specific payloads, plan destinations, provider readback, current inputs, timestamps, and the referenced body before using runner IDs or Azure resources as scope. Digests establish consistency, not an independent signature or permission grant.

Represent unknown applicability explicitly rather than defaulting private DAST/credential requirements to false. Unknown cannot satisfy an inapplicable dependency. For an alternative backend path, only successful proof from the selected applicable path satisfies `remote-ready`.

**Alternative rejected:** accepting stored plan digests as current inputs or retagging v1 receipts would fabricate freshness and conceal the existing producer gap.

### 7. Repair the existing setup kernel without promising production completion

A shared evidence-selection result distinguishes authoritative current evidence, historical informational records, conflicting current records, and missing proof. Status, readiness, doctor, and verification consume that result consistently. Old stale records do not poison a valid current selection; equally authoritative contradictions still block.

Planning validates every operation against its phase's mutation contract. Execution validates the completed outcome and required live proof before persisting a successful state. Correct the `activation-approved` graph/operation mismatch. Missing executors, approval-persistence support, or credential-enrollment support produce capability-specific blockers, not instructions to hand-edit state or credentials.

Only explicit execution retries repaired local seed/baseline/archive failures. Inspection and resume remain read-only. Verified unchanged work is reused; failed remote/destructive work never gains a blanket retry policy. Generated task projection is derived from authoritative phase state and updated only as an explicitly planned local mutation.

Provide workflow-specific local baseline adapters for both supported workflows. OpenSpec retains validation, synchronization, and archival of its generated seed, including already-archived recovery.

New Spec Kit projects receive an explicit one-time bootstrap bundle at `specs/000-liftoff-bootstrap/`: `spec.md`, `plan.md`, and `tasks.md`, declared under the logical names `spec-kit-bootstrap-spec`, `spec-kit-bootstrap-plan`, and `spec-kit-bootstrap-tasks`. These are project-owned `seed` artifacts, not framework-owned templates or managed-core files. Official `.specify` initialization markers remain framework-owned and are validated separately. The bundle describes only generated-project baseline preparation and local checks; generation creates no Git branch and does not claim completed product work.

The Spec Kit lifecycle adapter validates the real bundle and official markers, runs applicable local checks, and only then finalizes its task projection and records a body-bound local baseline receipt. It must not count a plan template as a project plan or an unchecked task file as completion. No fake OpenSpec directory, feature archive, or OpenSpec archive command is introduced. The `seed-archived` graph boundary means this local bootstrap handoff is finalized. The exact bootstrap identity is not an active governance change.

An existing Spec Kit project without the bundle receives a specific seed-adoption blocker. Adoption requires separate reviewed project work; ordinary update, force, assessment, and read-only setup inspection do not create missing seed files or infer past completion.

Credential execution cannot claim success merely because a policy file exists; unavailable independent readback blocks. Existing approval evaluation requires `approvedAt <= now < expiresAt` and a valid interval as well as exact scope. Git publication plans bind the actual push destinations, reject unreviewed differing/multiple push URLs, honor ignored paths during initial staging, and re-read the reviewed destination. These fixes do not add a new public publication/approval workflow.

**Alternative rejected:** implementing every production adapter in this change would turn bounded repair into a new provisioning platform.

### 8. Version semantic corrections explicitly

Use the next breaking pre-1.0 release line, 0.11.0, for implementation/release-identity preparation; publishing remains separate. The planned activation package identity is also 0.11.0.

| Contract | Planned identity | Reason |
| --- | --- | --- |
| Manifest artifact | 7; API/GenAI readers 2-7 | The workload retirement does not require a new manifest shape. |
| Normative policy | 6 | Fixed governance rules are preserved, not relaxed. |
| Activation contract | 2 | Input authority, applicability, transition, and retry semantics change. |
| Phase graph schema | 1, new computed graph hash | Existing graph serialization can express the revised operations/dependencies. |
| Activation state schema | 2 | Explicit unknown applicability and separate stable/remote identity binding. |
| Evidence header schema | 2 | Required body binding and current-input semantics. |
| Approval envelope schema | 2 | Strict temporal authorization contract. |
| Compatibility metadata schema | 2 | Distinguish historically readable identities from executable identities. |
| Supersession and credential-policy schemas | 1 | Their serialized shapes and normative credential policy are not expanded. |
| Assessment report and catalog schemas | 1 | Preserve their external shapes and classification meanings. |

Compute the graph hash and phase contract digests from the implemented canonical bytes; never place a made-up future hash in planning artifacts. Keep one identity definition and derive packaged/generated metadata from it.

Compatibility metadata identifies its schema in its own document. Do not add a new required manifest field or an unversioned report field merely to expose that implementation contract; the existing activation vector, findings, and provenance carry the applicable identities.

Known v1 activation history remains readable for diagnosis, but is not current executable proof. Preserve its state/evidence bytes and report a precise reconciliation-required or unsupported-migration blocker. Do not automatically upgrade, reset, delete, or manufacture that history. API/GenAI manifests remain readable and managed-core maintenance can be reported/performed without silently migrating user-owned activation state. A production historical-state reconciliation workflow is deferred; do not recommend a nonexistent command or manual JSON fabrication.

**Alternative rejected:** keeping activation contract/schema v1 would disguise incompatible changes as a CLI-only patch.

### 9. Fix starter execution while keeping specialization honest

Give each API stack one documented runtime configuration contract with explicit precedence: supplied process environment over the selected local configuration file over nonsecret defaults. All model, messaging, tracing, database, and readiness consumers use the resolved configuration rather than independently rereading environment variables. Document and exercise the native and Compose recipes; no unsafe shell-sourcing of configuration is introduced.

Compose must deliberately pass the documented model/transport/tracing settings while retaining correct container service addresses. Add explicitly inventoried root/frontend container-context exclusions so host virtual environments, dependency trees, build outputs, VCS metadata, and local secrets cannot overwrite installed image dependencies or enter the image.

For the already-generated Azure RAG publisher, supply queue, namespace, and selected identity consistently; grant the sender identity only the required send role at the narrowest generated entity scope. Keep receiver permission on the worker's receiver identity. Missing required settings fail clearly rather than returning a successful ingestion result.

Keep all nine pattern IDs. Derive maturity/capability descriptions from the actual generated behavior. RAG retrieval/citations, chat history, tools, prompt loading, coordination, workflow stages, and incremental streaming cannot be described as implemented while absent. Buffered SSE stays explicitly a foundation rather than real streaming. Generic must not receive retrieval/pgvector or worker specialization indirectly.

**Alternative rejected:** implementing full pattern behavior would expand scope; changing labels alone would leave the real runtime/configuration defects unfixed.

### 10. Give each new deployment environment an independent root

New projects use one OpenTofu root per selected environment at `infrastructure/opentofu/azure/environments/<environment>/`, backed by a shared application module at `infrastructure/opentofu/azure/modules/application/`. Each root has its own local state directory and exact environment inputs. Remote backend examples use distinct project-and-environment keys and preserve the canonical policy's private state, locking, encryption, and redundancy requirements.

This layout introduces one explicit exception to the append-only generated logical-name contract in 0.11.0. The following eight flat-root identities are retired from new scaffold output. Their historical paths are relative to `infrastructure/opentofu/azure/`:

| Retired flat-root logical name | Historical file |
| --- | --- |
| `opentofu-versions` | `versions.tf` |
| `opentofu-provider-lock` | `.terraform.lock.hcl` |
| `opentofu-providers` | `providers.tf` |
| `opentofu-variables` | `variables.tf` |
| `opentofu-main` | `main.tf` |
| `opentofu-outputs` | `outputs.tf` |
| `opentofu-local-state` | `backend.local.tf` |
| `opentofu-remote-state-example` | `backend.remote.example.tf` |

New declarations are `opentofu-application-{versions,variables,main,outputs}` for the shared module, with lifecycle `project` and provisioning group `base`, and `opentofu-<environment>-{versions,provider-lock,providers,variables,main,outputs,local-state,remote-state-example,tfvars}` for each selected root, with lifecycle `project` and provisioning group `environment:<environment>`. These are finite declarations expanded only for `dev`, `staging`, and `prod`, not wildcard ownership rules. `opentofu-readme` and the existing `opentofu-<environment>-tfvars` logical names retain their identities.

This exception retires generator output, not user files or recorded provenance. Supported manifest readers preserve the old logical names, paths, and generation hashes as historical project provenance. Ordinary update, force, helpers, and assessment do not delete those records, alias them onto new paths, move infrastructure or state, or acquire managed-core authority over them. Other non-environment logical names retain the append-only contract; this is not blanket permission to rename artifacts.

Each root keeps an explicitly inventoried `<environment>.tfvars` input file. Printed operational `init` recipes initialize the selected root's configured backend; only the local baseline uses backend-disabled initialization.

CLI helper output, README recipes, governance context, baseline checks, container/image instructions, and outputs all select that same root. Local baseline validation initializes with backend disabled and validates each selected root; it never performs a live plan/apply or implicit state migration.

Include a stable digest of the complete project identity in bounded resource names, not only the truncated display prefix. A user-supplied suffix is not the sole protection against collisions.

Existing project-owned infrastructure and state are not relocated. Helpers recognize recorded legacy layout through explicit generation/provenance compatibility entries, explain its shared-state limitation, and refuse a misleading environment-switch recipe. Reviewed infrastructure migration is separate; force cannot perform it.

New-environment provisioning also requires a compatible recorded independent-root layout. A legacy shared-state or unknown layout produces a component-level migration-required blocker instead of a new root pointing to an absent shared module. Other safe managed-core work can continue, but update cannot rewrite shared project infrastructure to unblock the component.

**Alternative rejected:** switching only variable files preserves the same state addresses; implicit workspace switching is harder to review and permits accidental use of the default workspace.

Service semantics are grounded in Microsoft guidance on [remote state](https://learn.microsoft.com/en-us/azure/developer/terraform/store-state-in-azure-storage) and [Service Bus managed identities and role scope](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-managed-service-identity). Illustrative provider defaults in those documents do not override Liftoff's normative policy.

### 11. Make recovery, migration, and upgrade boundaries explicit

- Share normalized CLI input resolution so prompts honor `--genai`/`--no-genai`, aliases, and invalid agents exactly as noninteractive planning does. Region filtering uses the declared region contract.
- Model required package managers separately from runtimes and consent. Preserve prerelease identifiers during exact/stable version checks. Normalize the Git probe locale rather than parse translated failure text.
- Use one explicit migration inventory for detection, staging, and tasks. Configuration files and non-workflow `.github` contents receive placement decisions; dependency comments are not declarations. Target-specific porting instructions honor stack/frontend overrides, and cleanup is last.
- Do not blindly restore every file difference after dependency execution. Preserve detected changes of uncertain origin and report their exact paths; automatic restoration is permitted only for an attributable, conflict-free write set. Project scripts are not falsely described as confined to lockfiles. Recovery recipes quote literal paths for the selected shell rather than treating JSON quoting as shell quoting.
- Acquire a project mutation lock for cooperating Liftoff writers, keep optimistic preconditions, preserve existing modes where supported, and clean temporary files even after partial-write failure. Never overwrite a concurrently changed destination during rollback. This does not claim adversarial-filesystem isolation from noncooperating processes.
- Resolve npm's effective `@msn-control:registry` before its default registry. Canonical verification explicitly isolates scoped overrides without changing persistent user npm configuration. Keep transport/body timeouts distinct from malformed metadata and verify historical releases only against their actual supported command surface.

### 12. Define maintainability completion by boundaries and behavior

The four concentration-point files become executable shims, public facades, or focused assemblers rather than retaining their original implementation behind forwarding callbacks. Feature work has documented integration points, public interfaces, and focused domain cases. No new runtime dependency cycles or domain-to-I/O imports are introduced.

Use the existing test/build infrastructure to demonstrate import boundaries, pure planning/comparison, command composition, unchanged behavior for mechanical moves, and the intended corrected behavior. Preserve generated-output expectations for unchanged cases and review intentional output changes separately. Package smoke must exercise the relocated runtime assets through the installed entry point, not only source imports.

Update `DEVELOPER.md` with the real module map, the eight responsibility groups, identity bump rules, and a capability/acceptance matrix. Update canonical specs rather than leaving stale runtime or retired-workload promises behind. Refactoring is not complete merely because files have been moved or shortened.

## Risks / Trade-offs

- [Broad but bounded change] -> Separate retirement, mechanical extraction, and behavior repairs into reviewable task groups; do not mix unrelated platform expansion into them.
- [Historical activation cannot be trusted under the new semantics] -> Preserve bytes, diagnose the exact identity gap, and defer executable reconciliation instead of inventing proof.
- [Assessment remains partial] -> Expose unsupported controls and missing layers; the goal is reliable findings, not a cosmetically green exit.
- [Generic assessment could hide a damaged project boundary] -> Treat existing malformed/retired manifests as errors before ordinary-Git fallback.
- [Partial provider access] -> Retain independent observations and mark only dependent proof unavailable; source/destination ambiguity blocks scoped requests.
- [Infrastructure layout and name changes affect existing deployments] -> Apply new output only to generation/new authorized components, never automatically migrate production resources or state.
- [Dependency scripts and concurrent editing] -> Prefer preservation and explicit conflict reports over success-shaped restoration; do not promise complete script sandboxing.
- [Cross-platform filesystem behavior] -> Use `node:path`, path-part identities, deterministic sorting, explicit case/CRLF rules, and symlink/junction refusal. POSIX mode preservation has no equivalent executable-bit guarantee on Windows; report unsupported metadata behavior accurately.
- [Refactoring regressions or asset lookup failures] -> Keep compatibility shims temporarily, avoid new packaging layers, and exercise the packed CLI on Windows/macOS/Linux.

## Migration Plan

1. Establish the supported behavior/ownership baseline and explicit retirement inventory. Port generic Power Apps-based regression cases before deleting active support.
2. Remove Power Apps coherently without operating on consumer projects.
3. Extract the remaining domain, use-case, generator, and adapter boundaries in behavior-preserving slices.
4. Repair CLI/bootstrap/migration/recovery and starter runtime/infrastructure contracts within those boundaries.
5. Introduce the versioned activation bindings and local setup corrections, keeping historical records diagnostic-only and production executors unavailable.
6. Extend and repair assessment against those contracts; demonstrate ordinary-Git, supported-project, retired-project, incomplete-live, and contradictory-evidence cases.
7. Align documentation, canonical requirements, package/release identity, and cross-platform delivery. Run the existing release checks without publishing or live provisioning.

Rollback of development changes is an ordinary reviewed source change, not a runtime `reset` operation. Runtime write failures restore only an attributable unchanged transaction write set; historical evidence and external state are never rewritten as rollback. Previously generated projects retain their project-owned application/infrastructure bytes. Any later live deployment or historical-state migration requires a separate approved change.
