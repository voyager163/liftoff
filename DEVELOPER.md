# Liftoff developer guide

This guide covers release-owned compatibility, deterministic setup, and package
publishing. General contribution setup remains in [CONTRIBUTING.md](CONTRIBUTING.md).

## Activation version vector

Example for the Liftoff 0.10.0 deterministic setup contract:

```json
{
  "liftoffVersion": "0.10.0",
  "manifestArtifactVersion": 7,
  "policyVersion": "6",
  "activationContractVersion": 1,
  "phaseGraphSchemaVersion": 1,
  "phaseGraphHash": "b84bcde6cd614637f2486b0f3a202860e6e9a6142ac60c773daa11786dbeb7f7",
  "activationStateSchemaVersion": 1,
  "evidenceHeaderSchemaVersion": 1,
  "approvalEnvelopeSchemaVersion": 1,
  "supersessionSchemaVersion": 1,
  "credentialPolicySchemaVersion": 1
}
```

`phaseGraphHash` is the lowercase SHA-256 hex digest of the canonical packaged
phase graph bytes. When documenting unreleased work before the final graph is
known, use a clear placeholder such as `<sha256-of-canonical-phase-graph-json>`;
do not fabricate a historical value.

The generated `liftoff.manifest.json` records this as manifest `artifactVersion`
7 plus the activation identity fields shown above.

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
- Historical state migration requires schema-valid input, an explicit old-to-new
  mapping, transactional writes, immutable evidence preservation, and rollback
  on any failed preflight.
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
openspec validate add-deterministic-liftoff-setup --strict
```

Before release, run:

```bash
npm run check
npm run smoke:package
npm run verify:standard-node-templates
npm run verify:generated-containers
npm run verify:power-apps-starter
npm run verify:release-identity
```

## 0.10.0 release checklist

- Package metadata, lockfile metadata, `liftoff --version`, and tag agree on
  `0.10.0`.
- Manifest writes use artifactVersion 7; readers accept v2-v7.
- Policy version is `"6"`; activation contract, graph/state/evidence/approval/
  supersession/credential schemas are v1.
- The graph hash in code, docs, generated artifacts, compatibility metadata, and
  release-integrity tests is
  `b84bcde6cd614637f2486b0f3a202860e6e9a6142ac60c773daa11786dbeb7f7`.
- `/liftoff-setup` is the primary post-init path and archives the bootstrap seed
  before any commit/push or Phase 0 authority.
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

## Functional engines and recommended boundaries

Grouped at the top-level command/workflow-domain boundary, Liftoff currently
has eight functional engines. Each contains smaller services; these are
responsibility groups, not eight classes named `Engine`:

| Subsystem | Current implementation |
| --- | --- |
| Project planning and generation | `planner.ts`, `templates.ts`, workload renderers and template assets |
| Workstation/framework bootstrap | `workstation.ts`, `project-dependencies.ts`, framework adapters and initialization safety |
| Source migration | `scan.ts`, `migrate-plan.ts`, migration orchestration |
| Managed project maintenance | `reconcile.ts`, artifact lifecycle declarations and guarded filesystem transactions |
| CLI self-upgrade | `self-upgrade.ts`, stable release lookup and installed-package verification |
| Diagnostics | Manifest validation, doctor, runtime and framework checks |
| Governance activation | `governance-activation/` state graph, approvals, evidence and transition dispatch |
| Governance assessment | `governance-assessment/` control catalog, observations, comparison and reporting |

Telemetry, terminal presentation, process execution, catalogs, and filesystem
access support those subsystems rather than constituting additional business
engines.

The next structural change should be incremental. First extract the command
handlers from the large `commands.ts` orchestrator. Then separate pure domain
rules from filesystem/process/GitHub/Azure adapters, and group workload
generators separately from governance policy definitions:

```text
src/
  cli/                 # arguments, per-command handlers, presentation
  application/         # bootstrap, migration, update and upgrade use cases
  domain/
    project/           # manifests, ownership and compatibility
    governance/        # versioned policy and common control definitions
    activation/        # phases, approval envelopes and evidence
    assessment/        # pure comparison and coverage rules
  infrastructure/      # filesystem, process, Git, GitHub, Azure and npm ports
  generators/          # common, standard, GenAI and Power Apps renderers
assets/governance/     # immutable policy bundles, catalogs and compatibility data
```

Keep one source of truth for policy and version identities, retain content
digest checks between policy/catalog/graph artifacts, and make read-only and
mutating adapter capabilities distinct. Preserve current import/CLI contracts
through small extraction changes rather than mixing a broad refactor into a
feature release.

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
the command-only setup flow; and existing activation inspection still uses
placeholder baseline/input digests. Assessment does not accept those
placeholders as current proof. Do not fabricate state, approvals, or evidence
to get past these gaps.

Complete this work separately from the read-only assessment feature:

1. Add explicit approval-persistence and secure credential-enrollment entry
   points with narrow consent and selected-agent command contracts.
2. Bind activation contexts to actual baseline, phase inputs, and transitions;
   define reviewed reconciliation for existing placeholder-bound history
   without rewriting immutable evidence or inventing completion.
3. Supply production implementations for the missing phase adapters and the
   GitHub ruleset adapter, enforcing resource, permission, cost, and destructive
   bounds at execution.
4. Complete retry and rollback behavior, including recovery from active local
   baseline failures, without blanket retries of remote or destructive phases.
5. Prove the entire activation and upgrade/reconciliation path with
   end-to-end positive and negative cases, then gated live readback where
   explicitly authorized.

The assessment/bootstrap patch can ship independently while these fail-closed
limitations remain documented; it must not advertise them as completed
production capabilities.

## Broader audit follow-ups

The whole-CLI review also identified work outside the bounded assessment,
bootstrap, release-safety, and guidance patch. These are not repaired by
successful rendering, unit tests, package smoke, or OpenTofu syntax validation:

- **GenAI capability completeness:** review catalog scaffold labels against an
  executable behavior matrix. Current RAG retrieval/citation code, conversation
  and tool orchestration, prompt-file loading, worker handlers, and streaming
  behavior still require project-level implementation work in several patterns.
- **Azure deployment completeness:** finish RAG publisher configuration and
  sender permissions, Function code packaging/deployment, dependency readiness,
  authenticated ingress, private connectivity, environment-specific safeguards,
  and regional service settings before treating generated applications as
  production-ready.
- **Baseline prerequisites:** keep dependency installation separately
  consented. Python test settings and npm dependency preparation need explicit
  validated recipes; an unprepared baseline must block with a remedy, not pass
  vacuously.
- **Persistent validation coverage:** expand framework delivery validation and
  Power Apps lock compatibility checks, validate exact plugin
  identity/version/enabled state, and strengthen deep readiness rather than
  equating liveness with dependency health.
- **Supply-chain delivery:** configured-registry version parity is not proof
  that its bytes equal the canonical release. Plan canonical artifact integrity
  verification before self-upgrade installation, with an explicit trust model
  for dependencies and approved mirrors. Pin or package mutable runtime/CDN
  assets as part of that work.
- **Filesystem concurrency:** strengthen shared mutation locking and
  no-follow/fd-relative writes against noncooperating processes replacing
  ancestors between validation and mutation. Existing preflight/rollback
  safeguards are not a complete adversarial-filesystem isolation mechanism.

Treat these as separate reviewed changes with workload/runtime acceptance
criteria. Do not enlarge a patch into a production platform rewrite or claim
that unavailable behavior has been implemented.
