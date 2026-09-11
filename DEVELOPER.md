# Liftoff developer guide

This guide covers release-owned compatibility, deterministic setup, and package
publishing. General contribution setup remains in [CONTRIBUTING.md](CONTRIBUTING.md).

## Stabilization acceptance matrix

The `stabilize-and-modularize-liftoff` change separates retirement, mechanical
extraction, and behavior corrections. This matrix identifies acceptance targets,
not a claim of production readiness. Its OpenSpec task checklist is the progress
authority; the locations below identify the extracted implementation, not its
temporary compatibility facades.

| Capability | Canonical implementation area under `src/` | Acceptance evidence | Change kind |
| --- | --- | --- | --- |
| `liftoff-cli-workflow` | `cli/args/`, `cli/commands/`, `domain/project/inputs.ts`, `interactive.ts` | Command, interactive, help and lifecycle cases | Retirement, correction, extraction |
| `liftoff-power-apps-code-apps` | `domain/project/retired-workload.ts` and manifest/input guards | Retired-manifest rejection and explicit retirement inventory | Retirement |
| `liftoff-project-scaffold` | `generators/{common,genai,containers}/`, `templates.ts` assembler | Template, generated-stack and seed-lifecycle cases | Retirement, correction, extraction |
| `liftoff-standard-projects` | `generators/standard/`, `adapters/packaged-assets/` | Three-stack startup/configuration and container cases | Correction |
| `liftoff-supported-stack-baselines` | `domain/project/supported-stack.ts`, `adapters/packaged-assets/supported-stack.ts` | Baseline identity, integrity and freshness cases | Retirement, correction |
| `liftoff-template-dependency-security` | Audit/freshness scripts and explicit package inventories | Template dependency/security and inventory cases | Retirement |
| `liftoff-infrastructure-governance` | `generators/infrastructure/`, `domain/project/infrastructure-layout.ts`, `cli/commands/helpers.ts` | Per-environment roots, state, naming and sender/receiver cases | Correction, extraction |
| `liftoff-workstation-bootstrap` | `application/initialize/`, `domain/workstation/`, workstation/framework registries | Runtime/package-manager constraints and independent consent | Retirement, correction |
| `liftoff-project-migration` | `domain/migration/`, `scan.ts`, `migrate-plan.ts`, `application/migrate/` | Complete inventory, target overrides, source preservation, cleanup-last | Correction, extraction |
| `liftoff-template-ownership` | `domain/project/artifact-lifecycle.ts`, `reconcile.ts` | Exact ownership, create-only provisioning and force refusal | Retirement, preservation |
| `liftoff-manifest-contract` | `domain/project/manifest/`, `application/project/manifest.ts` | API/GenAI v2-v7 readers, retirement and historical identity boundaries | Retirement, correction, extraction |
| `liftoff-project-update` | `application/update/`, `adapters/filesystem/` | Collisions, recovery, concurrent edits, modes and layout gates | Correction, extraction |
| `liftoff-project-doctor` | `application/diagnose/` and shared probes | Honest readiness, invalid boundaries and no-write diagnostics | Retirement, correction, extraction |
| `liftoff-cli-self-upgrade` | `application/upgrade/`, `self-upgrade.ts`, `stable-release.ts` | Scoped registry precedence, isolation and failure classification | Correction, extraction |
| `liftoff-npm-distribution` | Package metadata and packaging/release scripts | Packed CLI entry point, asset resolution and historical surfaces | Retirement, preservation |
| `liftoff-repository-governance-profile` | `repository-governance.ts`, `domain/governance/policy/identity.ts` | Fixed policy, real workload boundaries and exact managed inventory | Retirement, preservation |
| `liftoff-governance-activation-engine` | `domain/governance/activation/`, `governance-activation/` | Current-input/body binding, retries, selected paths, Spec Kit seed | Correction, extraction |
| `liftoff-governance-assessment` | `domain/governance/assessment/`, `governance-assessment/`, read-only Git/GitHub/Azure adapters | Any-Git coverage, effective enforcement, partial reads and no writes | Correction, extraction |
| `liftoff-user-documentation` | README, developer guide and packaged docs | Links, accurate capabilities, ownership and compatibility guidance | Retirement, correction |

Mechanical extraction must preserve the existing supported help, JSON and
generation fixtures except for separately reviewed intentional changes. The
pre-change capture includes all nine GenAI patterns, three standard API stacks,
Spec Kit, and a frontend-enabled production-only case. A new directory or
forwarding callback does not establish a new implementation boundary.

The explicit non-generative retirement inventory is
`tests/fixtures/power-apps-retirement.json`. It separates whole-file removal,
source/reference edits, shared cases to port, and the historical manifest kept
only as negative input. Do not expand that inventory into blanket deletion of
unknown files or user projects.

Production executors, public approval/credential enrollment, and missing GenAI
specializations remain deferred. Local baseline evidence, read-only assessment,
and successful generated-file checks must not be described as those capabilities.

## Activation version vector

Current deterministic setup contract, retained by the 0.11.3 CLI patch:

```json
{
  "liftoffVersion": "0.11.0",
  "manifestArtifactVersion": 7,
  "policyVersion": "6",
  "activationContractVersion": 2,
  "phaseGraphSchemaVersion": 1,
  "phaseGraphHash": "ac160e3fc86f3e438141d985658e09f419508b3adbe176ddd13100d5dfdee47c",
  "activationStateSchemaVersion": 2,
  "evidenceHeaderSchemaVersion": 2,
  "approvalEnvelopeSchemaVersion": 2,
  "supersessionSchemaVersion": 1,
  "credentialPolicySchemaVersion": 1
}
```

`phaseGraphHash` is the lowercase SHA-256 hex digest of the canonical packaged
phase graph bytes. When documenting unreleased work before the final graph is
known, use a clear placeholder such as `<sha256-of-canonical-phase-graph-json>`;
do not fabricate a historical value.

The generated `liftoff.manifest.json` records this as manifest `artifactVersion`
7 plus the activation identity fields shown above. Compatibility metadata uses
schema version 3 in its own document, not a new required manifest field.
Assessment report/catalog, graph, supersession, and credential-policy schemas
remain at version 1; normative policy remains 6.

`src/domain/governance/policy/identity.ts` is the version authority;
`src/domain/governance/activation/graph.ts` computes the canonical graph hash and
phase digests. Documentation tests compare this example with the source identity,
rather than blessing an obsolete hardcoded tuple.

| Axis | Tracks |
| --- | --- |
| CLI SemVer | Published implementation and npm package behavior. |
| Policy version | Normative GitFlow, governance, security, infrastructure, and documentation rules. |
| Activation contract | Phase order, gates, approvals, evidence meaning, invalidation, rollback, and transition semantics. |
| Schema versions | JSON serialization for graph, activation state, evidence headers, approval envelopes, supersession records, credential policy, and manifest artifacts. |
| Graph hash | Exact canonical graph bytes shipped by the release. |

There is no separate `/liftoff-setup` skill version. The setup integration is a
thin managed artifact; its managed content hash plus the activation contract and
graph hash are sufficient identity.

The same rule applies to `/liftoff-governance-assess`: it has no independent
assessment-skill version. Report schema v1 and the packaged assessment catalog
schema identify read-only data contracts, not a new policy or activation identity.

## Bump rules

| Change | Required bump |
| --- | --- |
| Normative governance rule, fixed GitFlow decision, approval policy, or credential policy meaning changes | `policyVersion` |
| Phase dependency, applicability, gate, mutation, evidence semantics, invalidation, rollback, or terminal-state behavior changes | `activationContractVersion` |
| JSON shape or strict validation changes incompatibly | the affected schema version |
| Managed setup or alias wording changes with no behavior change | managed content hash only |
| CLI-only bug fix with no policy, contract, schema, or managed graph change | CLI SemVer only |

One source change may bump multiple axes. Never advance one axis to hide required
changes in another.

## Compatibility maintenance

- Update the explicit compatibility map for every supported tuple. Do not rely
  on numeric less-than comparisons.
- Preserve v2-v7 manifest readers and v7 writers unless an OpenSpec change
  explicitly replaces that contract.
- Future manifest, policy, contract, schema, or graph identities must block
  without rewriting state and must report the exact field, found value, supported
  identity, and minimum Liftoff remedy.
- Manifest composition injects `validateReadableActivationIdentity` only at the
  manifest boundary. Exact known v1 identities remain readable without retagging;
  state, evidence, approval, readiness, and scope use strict current validation.
- Known v1 activation remains non-executable. The exact packaged successor lane
  requires update preview and approval, preserves original history, and creates
  new v2 proof only through current validation. Never add v1 to the executable map.
- Compatibility metadata v3 distinguishes successor eligibility from execution;
  retain strict schema-2 input reading without treating it as migration authority.
  Update report v3 distinguishes local commit from incomplete revalidation.
- Preview receipts are external user-local metadata, never approval. Persist
  transaction approval separately after explicit consent; recovery must validate
  that external binding rather than trust project-local JSON claiming approval.
- Durable history stays inside the project and outside managed-core ownership.
  It preserves historical state and evidence byte-for-byte. After migration
  commits, repair/resume blocked v2 rather than restore v1.
- The eight flat-root OpenTofu identities are an explicit new-output-only
  exception to append-only naming in 0.11.0. Preserve historical records and
  files; use the exact [retirement inventory](docs/azure-deployment.md#explicit-flat-root-identity-retirement),
  never aliases, prefix ownership, or force conversion.
- A CLI-only patch does not retag activation history. When unchanged renderer
  semantics support a new CLI generation, add that exact version to the
  infrastructure generation compatibility inventory and cover mixed old/new
  component provenance; do not infer compatibility from a SemVer range.
- Never fabricate history: prose, filenames, timestamps, or checked tasks are
  not evidence.

## Read-only assessment maintenance

The pinned target is the installed CLI's packaged policy, activation identity,
phase graph, and control catalog, never registry latest. The local-only
`liftoff governance assess --json` path must make no network requests or require
cloud credentials. Only an explicit `--live` request authorizes bounded
read-only GitHub/Azure metadata using existing permissions and validated scope.
No mode may enroll credentials, run project scripts, mutate configuration,
update or upgrade anything, or write state, approvals, or evidence.
Every assessment invocation, including `--live` and `--help`, must skip telemetry
and disclosure entirely. Local Git reads use only repository root, HEAD, and
origin metadata; never call `git status`, whose clean filters can execute code.
Azure scope and evidence-backed applicability require a current active-baseline
and referenced, validated saved-plan/evidence receipts. Reject placeholder
digests, future-dated approvals, and inferred bindings. Missing bindings remain
`not-observed`; remediation must never suggest manually fabricating activation
state, baselines, receipts, or evidence.
Use `inspectCurrentActivationEvidence` from
`src/governance-activation/read-only.ts`: its contexts include actual input
snapshots, reviewed immutable plans, and state evidence references. Consume
validated selected payloads, never reselect an unvalidated raw duplicate.
`bodyDigest` commits payload and normalized readbacks; `planDigest` binds semantic
inputs and `savedPlanDigest` binds the complete saved plan, including clocks.
Writing receipts does not invalidate their own source-input snapshot.

Reports distinguish target, recorded baseline, declared configuration, and
observed enforcement with expected/observed values, provenance, impact, and
ownership-aware advisory remediation. Preserve all seven classifications:
`aligned`, `outdated`, `missing`, `conflicting`, `approved-exception`,
`inapplicable`, and `not-observed`. Coverage must expose unknown applicability,
unobserved live proof, stale evidence, and unsupported evaluators.
Exit 0 means fully observed aligned or explicitly disabled not-applicable
governance, not interchangeable claims; exit 2 means partial coverage or
differences including approved exceptions; exit 1 means error. An assessment
cannot advance a phase or supply approval for a future governance upgrade.
Show the project policy version when available and expected/observed values.
Optional normalized observation `facts` retain sanitized details alongside
evaluator predicate values without retaining raw provider payloads.

When adding a control or evaluator:

- Use unique stable control IDs, normative policy references, explicit expected
  values, applicability/proof layers, valid phase IDs, and narrow exception scope.
- Bind the catalog digest to the canonical policy digest; test policy/catalog
  coherence and non-empty enabled coverage. Keep every normative policy family
  in the reviewed inventory, including explicit unsupported coverage.
- Add deterministic fixtures for equivalent reordered facts, known differences,
  stale/denied/unknown/incomplete observations, and scope-bound exceptions.
  Unknown proof must not become missing, inapplicable, or aligned.
- Prove read-only behavior with filesystem fingerprints and injected operation
  logs, including failure paths and unsupported identities. Test redaction
  before retention/truncation and fixed live read allowlists and limits.
- Cover Windows/macOS/Linux paths, CRLF, spaces, case handling, and
  symlink/junction rejection; never execute project YAML, hooks, or scripts.
- Keep both agent wrappers equivalent and limited to
  `liftoff governance assess --json` or, after explicit live consent,
  `liftoff governance assess --live --json`. Keep `/liftoff-setup` primary.
- Append exact `liftoff-governance-assess-copilot` and
  `liftoff-governance-assess-claude` ownership identities and portable paths.
  Older supported inventories must load and expose safe new drift. Test
  unowned collision protection under force, managed conflict handling,
  transactional rollback, and unchanged state/evidence bytes.

Assessment diagnoses unsupported activation mappings without weakening mutation
loaders or claiming a migration exists. A future governance upgrade must collect
fresh observations, produce its own authoritative plan, and obtain approvals.
See [assessment guidance](docs/repository-governance.md#read-only-governance-assessment).

## Release integrity requirements

- Validate the canonical graph, graph hash, per-phase contract digests, and
  compatibility metadata together.
- A graph byte change with unchanged phase semantics needs a compatibility
  mapping for unchanged phase digests; a semantic phase change needs the contract
  bump and affected descendant invalidation.
- Generated OpenSpec seeds must include metadata, proposal, design, tasks, and
  declared capability specs, and must pass strict validation immediately.
  Test external archival before activation as well: the baseline must retain
  every applicable local check and validate synchronized specs rather than an
  inactive change name. A persisted archived-baseline blocker is retryable only
  through a new explicit execution, never by fabricating evidence on resume.
- Copilot and Claude `/liftoff-setup` integrations must be behaviorally
  equivalent, command-only, model-agnostic, and free of skill-version fields.
  They must distinguish the read-only `apply-next --json` preview from
  `apply-next --json --execute`, and execute only when approval status is
  `not-required` or `reused`.
  Use `selectedPhase` and `executedPhase` for the apply-next attempt; read the
  subsequent status or verify result for post-transition `nextReadyPhase`.
- Governance verification must report state consistency separately from setup
  progress. A consistent `not-started` or `in-progress` result is not complete;
  completion requires every phase to have a successful terminal state.
- Credential tests must prove PAT/App policy equivalence, exact workflow/job
  allowlists, masked input, no command-argument/file/log/evidence leaks, and
  compromised revoke/rotate guidance.
  OpenSpec failure diagnostics must be bounded, stripped of terminal controls,
  and screened for credential-shaped content before truncation or persistence.
- Path tests must cover Windows, macOS, and Linux path-part arrays, symlink
  rejection, atomic state writes, and rollback.

## Focused commands

Run the smallest focused command while iterating:

```bash
npx vitest run tests/documentation.test.ts
npx vitest run tests/templates.test.ts tests/repository-governance.test.ts
npx vitest run tests/governance-activation.test.ts tests/governance-commands.test.ts tests/governance-credentials.test.ts
npx vitest run tests/seed-lifecycle.test.ts
npx vitest run tests/governance-assessment.test.ts tests/governance-assessment-engine.test.ts
npx vitest run tests/commands.test.ts tests/file-system.test.ts tests/contract.test.ts tests/update.test.ts
npm run build
openspec validate stabilize-and-modularize-liftoff --strict
```

Before release, run:

```bash
npm run check
npm run smoke:package
npm run verify:standard-node-templates
npm run verify:generated-containers
npm run verify:release-identity
```

## 0.11.3 release checklist

- Package metadata, lockfile metadata, `liftoff --version`, and tag agree on
  `0.11.3`. Preparing these files is not publication or permission to create a tag.
- Activation package identity remains `0.11.0`; no phase semantics or graph
  identity change is introduced by patch-release preparation.
- Release notes identify context-aware update follow-ups, root-aware validation
  guidance, and reason-specific preview errors. Mandatory matching preview and
  exact-plan approval, schema-3 project-update reports, and exit 2 after committed
  but incomplete local revalidation remain unchanged.
- Manifest writes use artifactVersion 7; readers accept v2-v7.
- Policy version is `"6"`; activation contract/state/evidence-header/approval
  remain v2. Compatibility metadata and update reports are v3; preview receipts,
  transaction approvals, history indexes, and migration journals are v1. Graph,
  supersession, credential-policy, assessment report, and assessment catalog
  schemas remain v1.
- The graph hash in code, docs, generated artifacts, compatibility metadata, and
  release-integrity tests is
  `ac160e3fc86f3e438141d985658e09f419508b3adbe176ddd13100d5dfdee47c`.
- `/liftoff-setup` archives the OpenSpec bootstrap or finalizes the real Spec Kit
  B001–B006 bundle locally before separate publication and Phase 0 gates.
- Power Apps and the eight explicitly retired flat-root infrastructure IDs have
  no positive new-generation lane. Old API/GenAI project provenance and v1
  activation history remain preserved. Only the exact approved migration lane
  can create a linked v2 successor; it does not retag historical proof.
- Independent infrastructure provenance explicitly admits generation versions
  `0.11.0`, `0.11.1`, `0.11.2`, and `0.11.3`, including mixed component histories.
  Unknown releases remain blocked rather than being accepted through a version range.
- No setup-skill version exists in manifests, JSON status, docs, or generated
  integrations.
- Doctor states and remedies cover seed-incomplete, phase-blocked,
  evidence-stale, credential-expiring, reconciliation-required,
  identity-incompatible, enforcement-incomplete, and disposal-pending.
- Package contents include `DEVELOPER.md`, docs, assets, governance artifacts,
  schemas, compatibility metadata, and setup templates.

## Trusted npm publishing overview

The `Release Liftoff` workflow builds, tests, packs, verifies release identity,
publishes with npm trusted publishing and provenance, then verifies the canonical
dist-tag. Do not place npm tokens, registry credentials, PATs, cloud secrets, or
signing material in repository files, workflow logs, chat, screenshots, or
evidence. Failed post-publish verification requires a dist-tag correction when
the immutable package is correct, or a corrected patch release; do not unpublish
as routine recovery.

## Functional engines and implementation boundaries

Liftoff remains one npm package and a modular monolith. It has eight functional
responsibility groups, not eight separately deployed services or classes named
`Engine`. Workloads, patterns, activation phases, and assessment controls are
different dimensions; adding a template does not create another engine.

| Subsystem | Current implementation |
| --- | --- |
| Project planning and generation | `domain/project/`, `application/project/`, `generators/`, resolved packaged template assets |
| Workstation/framework bootstrap | `application/initialize/`, workstation registry, framework adapters, `init-filesystem.ts`, dependency setup |
| Source migration | `domain/migration/`, `scan.ts`, `migrate-plan.ts`, `application/migrate/` |
| Managed project maintenance | `application/update/{planning,reporting,use-case}.ts`, `reconcile.ts`, filesystem transactions |
| CLI self-upgrade | `application/upgrade/use-case.ts`, `self-upgrade.ts`, stable release lookup and installed-package verification |
| Diagnostics | `application/diagnose/`, pure manifest contracts, shared runtime/framework/governance checks |
| Governance activation | `domain/governance/{policy,activation}/` rules and `governance-activation/` execution composition |
| Governance assessment | `domain/governance/assessment/` comparison/report contracts and `governance-assessment/` read-only collection |

Telemetry, terminal presentation, process execution, catalogs, and filesystem
access support those subsystems rather than constituting additional business
engines.

### Canonical entry points and ports

| Responsibility | Entry point or data contract |
| --- | --- |
| CLI parsing/dispatch | `src/cli/args/parser.ts`, `src/cli/commands/dispatch.ts` |
| Typed use-case requests | `src/application/context.ts`, `src/application/initialize/use-case.ts`, `src/application/update/use-case.ts`, `src/application/migrate/use-case.ts`, `src/application/upgrade/use-case.ts` |
| Pure plans/catalog/manifest rules | `src/domain/project/contracts.ts`, `src/domain/project/catalog.ts`, `src/domain/project/planning.ts`, `src/domain/project/manifest/reader.ts` |
| Release composition | `src/application/project/catalog.ts`, `src/application/project/manifest.ts` |
| Generator assembly and resolved subsets | `src/templates.ts`, `src/generators/context.ts` and its renderer families |
| Installed-package assets | `src/adapters/packaged-assets/package-root.ts`, `src/adapters/packaged-assets/template-assets.ts` |
| Guarded mutations | `src/adapters/filesystem/project-lock.ts`, `src/adapters/filesystem/atomic-write.ts`, `src/adapters/filesystem/project-transaction.ts` |
| Exact infrastructure inventory/layout | `src/domain/project/infrastructure-layout.ts` |
| Current activation observations | `src/governance-activation/inputs.ts`, `src/governance-activation/read-only.ts` |
| Activation planning/execution ports | `src/governance-activation/transition-planning.ts`, `src/governance-activation/transition-ports.ts`, locked coordinator `src/governance-activation/transitions.ts` |
| Concrete phase handlers and persistence | `src/governance-activation/seed-lifecycle.ts`, `src/governance-activation/phase-publication.ts`, `src/governance-activation/phase-discovery.ts`, `src/governance-activation/phase-governance.ts`, `src/governance-activation/phase-bootstrap-state.ts`, `src/governance-activation/transition-records.ts` |
| Pure evidence/availability contracts | `src/domain/governance/activation/evidence.ts`, `src/domain/governance/activation/capabilities.ts` |
| Read-only assessment | `src/governance-assessment/project.ts`, `src/domain/governance/assessment/`, `src/adapters/git/governance-assessment.ts`, `src/adapters/github/governance-assessment.ts`, `src/adapters/azure/governance-assessment.ts` |

The source boundaries are:

```text
src/
  cli/                 # parsing/help and per-command transport
  application/         # typed requests, execution ports and workflow orchestration
  domain/
    project/           # injected catalogs/planning, manifest contracts and ownership
    migration/         # declaration parsing, inventory and placement decisions
    governance/
      policy/          # shared version identities
      activation/      # graph, approval, applicability, evidence and readiness rules
      assessment/      # observations, comparison, coverage and report rules
  generators/
    common/            # shared files, frontend, configuration and workflow seeds
    standard/          # Python, Node.js and Go implementations
    genai/             # configuration, backend, patterns, database and functions
    containers/        # Compose, images and build-context exclusions
    infrastructure/    # independent Azure roots and resource naming
  adapters/
    filesystem/        # guarded discovery/read/write, transactions and locks
    packaged-assets/   # one installed-package root and resolved release assets
    process/           # shell-specific literal command formatting
assets/governance/     # immutable policy bundles, catalogs and compatibility data
```

Activation planning, process transport, outcome persistence, and phase handlers
are real modules, not callbacks into a monolithic dispatcher.
`phase-bootstrap-state.ts` handles retention/disposal boundaries, not the missing
`bootstrap-local` cloud-provisioning executor. `transition-process.ts` centralizes
command outcomes; `transition-records.ts` commits the reviewed plan/evidence/state
contracts through guarded filesystem operations.

`commands.ts`, `args.ts`, `file-system.ts`, and the project/catalog entry modules
are compatibility facades. `templates.ts` assembles actual renderer modules;
it must not regain backend, container, infrastructure, or workflow implementation.
Internal callers use canonical modules rather than routing back through facades.

CLI handlers parse syntax and pass typed `ProjectOptions`, `MigrationRequest`,
`UpdateRequest`, and `UpgradeRequest` to application use cases with
`ExecutionContext` ports from `application/context.ts`.
Application code does not call back into CLI parsing. Pure rules receive data or
narrow context explicitly: `createProjectCatalog`, `buildProjectPlanWithCatalog`,
and `createManifestReader` do not discover files, run processes, or contact
providers. `application/project/catalog.ts` composes the release catalog;
`domain/project/catalog.ts` remains the pure factory.
Root generator composition accepts `PackagedTemplateAssetContext` and calls
`createGeneratorContext` in `generators/context.ts`. Pure renderers receive narrow
resolved subsets and do not import adapters. Only composition loads
`packagedTemplateAssets` through the canonical `resolvePackageFile` /
`resolvePackageFileUrl` resolver.

Manifest grammar, workload normalization, artifact authority, and governance
compatibility have separate project-domain modules. Filesystem discovery,
path safety, file access, and transactions live in distinct adapters.
`withProjectMutationLock` coordinates writers, while snapshots and path/content
preconditions still protect reviewed mutations and conflict-preserving rollback.
Its operation receives a lease with `assertHeld()`; nested same-root mutations
reuse it, while read-only paths do not acquire a lock.
Read-only assessment receives read capabilities, never activation executors or
mutation adapters.

When changing a feature, update its narrow rule/renderer first, wire the
application and CLI boundary, then extend the existing focused cases. Add exact
artifact lifecycle/provenance identities; do not infer ownership from folders.
The import-boundary suite checks cycles, domain I/O, application-to-CLI coupling,
and facade use. Packed smoke covers runtime asset lookup outside this checkout.

## Activation completeness and separate follow-up plan

The activation engine is not yet an end-to-end production provisioning engine.
Of its 26 declared phases, 10 have built-in handler paths, 2 require an injected
GitHub ruleset adapter that the public CLI does not currently supply, and 14
fall back to an explicit missing-production-adapter blocker.

The missing production phase handlers are `provider-ready`,
`state-path-selected`, `existing-private-path`, `bootstrap-local`,
`runner-ready`, `private-backend-proof`, `remote-import-verified`,
`application-foundation`, `workflow-source-ready`, `dev-proof`,
`staging-qualified`, `production-rehearsed`, `green-red-proof`, and
`enforcement-approved`. `rulesets-applied` and `live-readback` have adapter
contracts but need production wiring.

Built-in handler presence does not establish a complete user journey:
approval envelopes are read from disk but no public approval-persistence
command is exposed; secure credential enrollment helpers are not wired into
the command-only setup flow. Current activation inspection now binds real
baseline/input snapshots, reviewed plans, state references, and evidence bodies.
Historical placeholder-bound records remain diagnostic-only, never current
proof. Do not fabricate state, approvals, or evidence to get past capability gaps.

Complete this work separately from the read-only assessment feature:

1. Add explicit approval-persistence and secure credential-enrollment entry
   points with narrow consent and selected-agent command contracts.
2. Define a separately reviewed reconciliation workflow for historical activation
   identities and placeholder-bound history
   without rewriting immutable evidence or inventing completion.
3. Supply production implementations for the missing phase adapters and the
   GitHub ruleset adapter, enforcing resource, permission, cost, and destructive
   bounds at execution.
4. Design phase-specific production retry/rollback behavior without blanket
   remote or destructive retries. Explicit local seed/baseline/finalization
   recovery and cooperating-writer locking are already implemented.
5. Prove the entire activation and upgrade/reconciliation path with
   end-to-end positive and negative cases, then gated live readback where
   explicitly authorized.

This stabilization can ship independently while these fail-closed
limitations remain documented; it must not advertise them as completed
production capabilities.

## Broader audit follow-ups

The following work remains outside this stabilization, despite the repaired
runtime configuration, infrastructure generation, and local safety boundaries.
Rendering, unit tests, package smoke, and OpenTofu syntax validation alone do not
establish these production capabilities:

- **GenAI capability completeness:** all nine catalog entries now say
  `foundation` and describe actual behavior. Retrieval/citations, conversation
  history, tools, prompt-file loading, worker processing, coordination,
  fine-tuning, workflow stages, and incremental streaming remain project work.
  Generic has no pgvector package/extension or application-worker requirement.
- **Azure deployment completeness:** RAG publisher configuration and queue-scoped
  sender/receiver separation are implemented. Function code packaging/deployment,
  dependency readiness,
  authenticated ingress, private connectivity, environment-specific safeguards,
  and regional service settings still need reviewed implementation and verification
  before treating generated applications as production-ready.
- **Baseline prerequisites:** keep dependency installation separately
  consented. Python test settings and npm dependency preparation need explicit
  validated recipes; an unprepared baseline must block with a remedy, not pass
  vacuously.
- **Persistent validation coverage:** preserve framework delivery validation,
  retired-workload rejection, and shared safety coverage, and strengthen deep
  readiness rather than equating liveness with dependency health.
- **Supply-chain delivery:** configured-registry version parity is not proof
  that its bytes equal the canonical release. Plan canonical artifact integrity
  verification before self-upgrade installation, with an explicit trust model
  for dependencies and approved mirrors. Pin or package mutable runtime/CDN
  assets as part of that work.
- **Filesystem concurrency:** cooperating-writer locks, guarded transactions,
  mode preservation, and conflict-preserving recovery are implemented. Stronger
  no-follow/fd-relative isolation against noncooperating processes replacing
  ancestors between validation and mutation remains future hardening. Existing preflight/rollback
  safeguards are not a complete adversarial-filesystem isolation mechanism.

Treat these as separate reviewed changes with workload/runtime acceptance
criteria. Do not enlarge a patch into a production platform rewrite or claim
that unavailable behavior has been implemented.
