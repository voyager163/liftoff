## Why

Thirteen Dependabot pull requests now span stale `main` targets, overlapping baseline-managed package graphs, Node 26 type proposals that conflict with the Node 24 LTS contract, and direct edits to an immutable Power Apps snapshot. Handling them independently would bypass Liftoff's reviewed baseline and provenance rules while repeatedly failing deterministic CI.

## What Changes

- Reconcile the backlog from a feature branch targeting `develop`; keep `main` unchanged until the normal release flow promotes a qualified baseline.
- Consolidate admissible updates represented by PRs #15, #20, #26, #28, #29, #31, and #32 into one coherent supported-stack refresh rather than merging their mutually overlapping manifests and locks independently.
- Re-resolve the root, standard Node backend, and standard frontend package graphs with the pinned Node/npm toolchain, update their explicit supported-stack identities, and retain only candidates that pass the full compatibility and security matrix.
- Close PRs #25, #27, and #30 as incompatible Node 26 type proposals while Node 24 remains the selected LTS baseline, and configure Dependabot to suppress only `@types/node` semantic-major version updates for Node 24 graphs.
- Close PRs #16, #17, and #18 as superseded direct edits to the commit-addressed Power Apps snapshot; retain the existing upstream-snapshot refresh process as the only path for those bytes.
- Group routine minor and patch version updates within each configured npm package graph to reduce overlapping PRs while keeping majors separately reviewable.
- Let version and security updates follow the repository's default `develop` branch rather than adding a redundant `target-branch` override.
- Open one replacement pull request to `develop`, retain links to every superseded Dependabot PR, and close superseded PRs only after the replacement branch and validation evidence are available.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `liftoff-template-dependency-security`: Define how Dependabot proposals target the integration branch, group compatible updates, respect runtime-major and immutable-upstream boundaries, consolidate baseline-managed graphs, and close superseded PRs safely.

## Impact

- Affected repository surfaces: `.github/dependabot.yml`, root npm metadata, standard Node backend and frontend template metadata, `assets/supported-stack.json`, generated template assets, tests, snapshots, and contributor guidance.
- GitHub operations affect open PRs #15–#18, #20, and #25–#32 plus their Dependabot branches; no production merge or direct `main` change is part of this change.
- Validation includes supported-stack freshness, deterministic lock regeneration, Node 22/npm 10 and Node 24/npm 12 compatibility, generated stack builds/tests, template security audit, Power Apps integrity, full CI, and package smoke testing.
- The exact accepted dependency versions remain implementation-time decisions gated by canonical-source inspection and compatibility evidence; a candidate that fails remains excluded and documented.
