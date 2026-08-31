## Context

`liftoff init` currently resolves a workload, initializes OpenSpec or Spec Kit in temporary staging, writes a one-time bootstrap seed change, and transactionally merges generated files. It can initialize an existing Git root, but it can also create a named child directory before Git or a GitHub remote exists. `liftoff update` reconciles only durable named artifacts; framework and seed files are deliberately excluded.

The repository bootstrap standard supplied for this change is intentionally strict:

- Vincent Driessen GitFlow with `develop` as the integration and default branch and `main` as released production truth;
- single-maintainer pull requests with zero human approvals and automated fail-closed gates;
- repository-scoped rulesets only, with no org-level substitute;
- GitHub Advanced Security, Checkov, Trivy, Grype, ZAP, attestations, Scorecard, release evidence, immutable tags, build-once promotion, blue-green deployment, automated canary analysis and rollback;
- private-network staging DAST, Slack-routed monitoring, health modeling, DORA metrics, and operational runbooks;
- Phase 0 classification and explicit user approval before any change.

Those live controls cannot safely be applied inside `init`: a remote may not exist, required capabilities may be absent, and the standard itself requires a pause. Liftoff will therefore generate a durable, versioned handoff that the selected agent executes after the first push.

## Goals / Non-Goals

**Goals:**

- Offer a named repository-governance profile during planning and initialization, enabled by default.
- Generate one canonical policy and machine-readable workload context with thin launchers for every selected agent.
- Keep local generation and update deterministic, offline-capable, cross-platform, and free of GitHub mutations.
- Require the post-push agent to perform read-only Phase 0, report gaps and inapplicable controls, and stop for approval.
- Apply the standard honestly across GenAI, standard API, and Power Apps workloads.
- Let existing generated projects receive the durable handoff through ordinary safe `liftoff update`.
- Record profile and policy identity without falsely claiming that live governance is active.
- Preserve one-time seed and official framework ownership.

**Non-Goals:**

- Creating branches, changing the default branch, pushing commits, creating PRs, installing rulesets, or configuring GitHub during `init` or `update`.
- Requiring `gh`, a remote, GitHub Advanced Security, Slack, self-hosted runners, Azure credentials, or deployment access before local project generation.
- Generating a workflow that cannot pass or silently substituting an org-level or third-party control.
- Recreating an archived or deleted OpenSpec/Spec Kit change during update.
- Proving live enforcement from local files alone.

## Decisions

### 1. Model governance as an extensible profile identifier

Project options and configuration gain a `governanceProfile` catalog value with:

- `single-maintainer-gitflow` as the interactive and unspecified default;
- `none` as the explicit opt-out.

Interactive `init` asks after workload selection whether to use the named profile and defaults to enabled. Noninteractive flows use `--governance single-maintainer-gitflow|none`; `--yes` accepts the enabled default but does not authorize any remote action.

The profile identifier is append-only like other catalog IDs. A string catalog is preferred to a boolean because future profiles can be added without another schema redesign.

### 2. Generate canonical durable artifacts under the reserved namespace

The profile renders explicitly named durable artifacts:

- `.liftoff/governance/policy.md`: the versioned canonical repository standard;
- `.liftoff/governance/context.json`: schema-versioned workload facts and known commands, boundaries, environments, health endpoints, selected framework and agents, and policy identity;
- `.liftoff/governance/README.md`: activation sequence, prerequisites, and the statement that local generation is not live enforcement;
- `.github/prompts/liftoff-repository-governance.prompt.md` when GitHub Copilot is selected;
- `.claude/commands/liftoff-repository-governance.md` when Claude Code is selected.

The launchers are thin and direct the agent to read the canonical policy and context. Liftoff owns only these exact logical names, even though two live under directories also used by framework integrations. It never discovers or modifies agent files by directory pattern.

All path construction uses path parts and platform path APIs. Identical plans render identical bytes on Windows, macOS, and Linux.

**Alternative considered:** duplicate the full policy into each agent prompt. Rejected because copies would drift and updates would create avoidable conflicts.

### 3. Do not generate an active governance change

The existing workload bootstrap change remains one-time seed content. Repository governance handoff files are durable, but no `openspec/changes/...` or Spec Kit feature directory is generated for this profile.

After Phase 0 and explicit approval, the selected agent creates a new change through the project's selected framework. That change and every resulting workflow, ruleset source, runbook, exception, evidence record, and activation record are user-owned governance implementation, not Liftoff template state.

**Alternative considered:** seed a governance change during `init`. Rejected because update must not resurrect archived work and a meaningful proposal cannot be written before live Phase 0 discovery.

### 4. Make Phase 0 a strict read-only handoff

The canonical policy instructs the agent to:

1. verify a Git repository and GitHub remote are available;
2. classify artifact type, languages, package managers, working build/test commands, branches, workflows and exact job names, rulesets, tags, releases, environments, security features, deployment paths, runner access, monitoring, alerts, and shallow/deep health coverage;
3. identify continuous-delivery conflicts with GitFlow and every unavailable or inapplicable control;
4. report the current `main` tip proposed as the activation baseline for an existing repository;
5. provide an ordered plan and stop for explicit user approval.

Phase 0 may call read-only local and GitHub APIs but MUST NOT write files, create a change, alter a ref, or mutate settings. Plan approval is distinct from forbidden human merge/deploy approval.

### 5. Create implementation only after approval

After approval, the agent creates an OpenSpec or Spec Kit change that adapts the policy to discovered facts. The eventual implementation follows fail-closed sequencing:

```text
local policy -> Phase 0 report -> user approval -> spec change
             -> workflows and source-of-truth files
             -> observe exact checks green
             -> prove each required check red
             -> install rulesets last
             -> read back live enforcement
```

The implementation records the pre-governance `main` SHA in a user-owned `governance/activation-baseline.json`. Release/tag anomaly checks apply only to governed commits after that baseline; no synthetic historical release or tag is created.

### 6. Separate universal invariants from workload adapters

Universal profile invariants include GitFlow roles, zero human approvals, repository scope, fail-closed checks, immutable release identity, evidence durability, ruleset sequencing, negative tests, and documentation.

Workload context drives explicit applicability:

- GenAI and standard API container workloads can receive image scanning, SBOM, provenance, staged DAST, OpenTofu-aware deployment, and runtime health requirements when deployment infrastructure exists.
- Power Apps receives source, dependency, secret, CodeQL, release, and repository controls that apply to its React application, but no Liftoff backend, container, OpenTofu, custom blue-green deployment, or private-origin DAST is invented.
- A library, static site, infrastructure-only repository, unsupported deployment platform, missing private runner, or statistically empty canary is reported and adapted explicitly.

The policy forbids replacing unavailable licensed capabilities with duplicate tools or org-level controls.

### 7. Adopt through normal durable reconciliation

New projects write `governanceProfile` explicitly to `liftoff.config.json`. Existing configurations that omit it normalize to `single-maintainer-gitflow`, so the next `liftoff update` renders the new durable artifacts automatically without rewriting the user-owned config.

Normal update semantics apply:

- absent files are safe `new` artifacts;
- identical files are adopted without rewriting;
- different pre-existing files are conflicts;
- unrecorded conflicts remain outside Liftoff ownership while collision-free
  artifacts are applied, and the manifest records the handoff as partial;
- modified managed policy files remain conflicts unless explicitly forced;
- disabling the profile stops rendering its artifacts, which become reported orphans and are never auto-deleted.

Update does not run an agent, inspect GitHub, create a spec change, or infer live activation.

### 8. Introduce manifest schema v5

Schema v5 adds project governance metadata:

```json
{
  "governance": {
    "profile": "single-maintainer-gitflow",
    "policyVersion": "1",
    "state": "handoff-generated"
  }
}
```

Fresh initialization and complete adoption use `handoff-generated`.
`handoff-partial` is update-only and means one or more required destinations
contained preserved user-owned bytes that Liftoff neither wrote nor adopted.
Only written or byte-identical adopted artifacts enter that manifest, so every
recorded hash remains truthful and a later update continues to classify the
unrecorded destination as a conflict. Resolving the conflict promotes the next
manifest to `handoff-generated`. `none` records an explicit disabled state
without a policy version. These states describe only Liftoff's local handoff;
they never change to `active` based on local assumptions.

Readers continue accepting v2, v3, and v4, normalizing them with an unspecified governance field. A successful update writes v5 using the configuration default; check mode remains byte-for-byte read-only.

### 9. Keep the full standard as a maintained policy asset

The supplied standard becomes a canonical source asset with a policy schema/version and tested rendering adapters. Its fixed single-maintainer assumptions remain explicit. Workload context supplements the policy rather than interpolating secrets or live observations into it.

Policy updates are ordinary Liftoff managed upgrades. Agent implementation output remains outside Liftoff ownership.

## Risks / Trade-offs

- **[Users mistake generated policy for active enforcement]** -> State “handoff generated; not enforced” in plan output, generated README, context state, manifest, and documentation.
- **[Default-enabled profile is unavailable on a user's GitHub plan]** -> Phase 0 reports the blocker and omits theatre; it does not install substitutes or block local initialization.
- **[Policy is too broad for a workload]** -> Require explicit applicability classification and workload adapters before any workflow is authored.
- **[Agent launchers conflict with framework output]** -> Own only exact named files, stage framework initialization first where necessary, and use standard destination conflict protection.
- **[Existing project has a file at a new governance path]** -> Classify it as a normal conflict and preserve it without `--force`.
- **[Partial adoption falsely claims user-owned bytes]** -> Omit every
  unrecorded conflict from durable ownership, record `handoff-partial`, and
  require explicit conflict resolution before reporting a complete handoff.
- **[Schema migration fabricates live state]** -> Record only profile selection and local handoff state; activation evidence remains user-owned and live-read-back based.
- **[GitFlow does not fit continuous delivery]** -> Phase 0 must report the conflict and obtain approval for a documented adaptation rather than force the full branch model.
- **[Required check deadlocks the repository]** -> The policy requires observed green contexts and deliberate red tests before ruleset installation.
- **[Cross-platform launcher paths diverge]** -> Use path-part arrays and verify identical artifact bytes and logical names across all supported operating systems.

## Migration Plan

1. Implement after `refresh-supported-stack-baselines` so policy context references the current tested stack.
2. Add the governance profile catalog, CLI/config parsing, plan entry, and default behavior.
3. Add canonical policy/context rendering and selected-agent launchers with explicit artifact names.
4. Add schema-v5 readers, writers, fixtures, and backward normalization.
5. Extend update reconciliation tests for automatic v2-v4 adoption, partial
   conflict state, opt-out orphans, and read-only checks.
6. Add workload-specific context fixtures and validate Power Apps exclusions.
7. Update packaged documentation, snapshots, and cross-platform tests.
8. Release normally. Existing users inspect adoption with `liftoff update --check` and apply with plain `liftoff update`.

Rollback before release is a normal source revert. After release, disabling the profile in configuration stops future rendering while preserving already generated or user-owned governance files as explicit orphans.

## Open Questions

- The implementation should confirm the exact Copilot and Claude launcher locations produced by the currently pinned framework versions before reserving the final logical paths.
- The canonical policy version starts at `1`; future compatibility rules for policy-major migrations should be defined when a breaking policy revision is first needed.
