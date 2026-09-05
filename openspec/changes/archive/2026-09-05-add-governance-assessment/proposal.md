## Why

Developers cannot currently get one trustworthy comparison between the
governance their project declares, what GitHub and Azure actually enforce, and
what their installed Liftoff release requires. Managed-file drift and activation
verification answer parts of that question, but unsupported activation
identities can block those paths before developers understand the differences.

## What Changes

- Add `liftoff governance assess [project] [--json] [--live]`, local-only by
  default, with a versioned report and concise human presentation.
- Add `/liftoff-governance-assess` for selected Copilot and Claude integrations
  as a thin explanation layer over that CLI command, not another setup alias.
- Pin the assessment target to the installed CLI's packaged policy, activation
  contract, graph, and assessment control catalog; never silently substitute
  registry `latest`.
- Compare recorded baseline identity, managed-file drift, project-owned
  governance configuration, applicable evidence, and explicitly requested live
  enforcement. Report expected and observed values, provenance, impact, and
  recommended actions without granting mutation authority.
- Distinguish `aligned`, `outdated`, `missing`, `conflicting`,
  `approved-exception`, `inapplicable`, and `not-observed`. Missing permissions,
  stale evidence, unsupported evaluators, and unknown applicability must not
  become a compliant result.
- Keep useful identity/coverage diagnostics available for unsupported
  activation tuples while retaining strict path and malformed-input safeguards.
- Reuse the guarded managed-core update mechanism to distribute the new agent
  integrations; an assessment never runs update, activation, or migration.

## Capabilities

### New Capabilities

- `liftoff-governance-assessment`: Deterministic, read-only local and opt-in live
  comparison, versioned control coverage, provenance, exception handling,
  diagnostics, and advisory remediation.

### Modified Capabilities

- `liftoff-cli-workflow`: Strict assessment arguments, local/live consent,
  human/JSON output, and exit-code semantics.
- `liftoff-project-scaffold`: One explicitly read-only assessment integration
  for each selected supported agent, distinct from `/liftoff-setup`.
- `liftoff-manifest-contract`: Exact assessment logical names and path
  identities in current managed-core manifests and compatibility inventory.
- `liftoff-repository-governance-profile`: Assessment launchers in the canonical
  handoff without applying activation's commit/push prerequisite to assessment.
- `liftoff-user-documentation`: Explain comparison layers, incomplete coverage,
  live-read consent, and the boundaries between assess, update, setup, and a
  future governance upgrade.

## Impact

Implementation will affect governance CLI parsing/routing, a new assessment
module and packaged control catalog, shared safe inspection helpers, selected
agent rendering, explicit lifecycle/compatibility inventories, and public and
developer documentation. Regression coverage must include the installed
package, supported workloads, historical/unsupported identities, network
denials, and Windows/macOS/Linux paths.

No policy requirement, activation phase, approval gate, existing artifact
identity, or state schema is changed. This feature does not migrate governance,
rewrite workflows or infrastructure, apply rulesets, create reports in the
worktree by default, enroll credentials, or add an independent skill version.

The completed but uncommitted `fix-archived-seed-activation` work remains a
separate change. The CLI/scaffold/documentation additions here use separate
requirements so syncing this change cannot discard that change's deltas.
