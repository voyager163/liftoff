## Context

See `proposal.md` for motivation. The repository default branch was changed from `main` to `develop` on 2026-09-01. GitHub retargeted newer open Dependabot PRs #25–#32 to `develop`, while older conflicting PRs #15–#20 remain based on `main`. The `main` and `develop` trees are currently byte-identical, but their histories preserve the release and back-merge topology.

Liftoff treats npm manifests and locks as release-owned baseline inputs. Ordinary Dependabot PRs fail `check:supported-stack` when they change those files without updating `assets/supported-stack.json`. The Power Apps starter is additionally hash-verified upstream content and cannot be edited directly.

## Goals / Non-Goals

**Goals:**

- Produce one coherent dependency baseline change against `develop`.
- Preserve Node 24 LTS, immutable Power Apps provenance, deterministic locks, and existing compatibility lanes.
- Reduce future routine PR overlap without suppressing security updates or all dependency majors.
- Close every current Dependabot PR with a traceable disposition after replacement evidence exists.
- Keep production `main` unchanged until the normal release branch is qualified and promoted.

**Non-Goals:**

- Do not merge any current Dependabot PR directly.
- Do not upgrade the runtime baseline from Node 24 to Node 26.
- Do not edit the packaged Power Apps starter independently of an upstream snapshot refresh.
- Do not add `target-branch: develop` while `develop` is already the default branch.
- Do not delete unrelated local branches or alter release history.
- Do not accept every candidate merely because Dependabot proposed it.

## Decisions

### 1. Reconcile on `develop`, never directly on `main`

Create the replacement work from `develop` and target its pull request to `develop`. The default branch now routes new Dependabot version and security PRs to the integration branch without a `target-branch` override. Old PRs that remain based on `main` are closed as superseded rather than retargeted and merged.

Alternative considered: retarget every old PR. Their branches are stale, several conflict, and each still lacks coordinated baseline metadata, so retargeting preserves the underlying failure mode.

### 2. Classify the live backlog by ownership

Refresh the inventory immediately before implementation because checks and bases are mutable.

| Disposition | PRs | Reason |
| --- | --- | --- |
| Candidate for consolidated baseline | #15, #20, #26, #28, #29, #31, #32 | Changes belong to Liftoff-owned root, standard Node backend, or standard frontend graphs; accept only after canonical version and compatibility verification |
| Exclude as runtime-incompatible | #25, #27, #30 | `@types/node` 26 does not match the selected Node 24 LTS runtime major |
| Exclude as provenance-violating | #16, #17, #18 | Directly changes the immutable Microsoft Power Apps starter snapshot |

PR #28 is a major TypeScript candidate, not a routine auto-merge. It may enter the consolidated baseline because the existing policy permits reviewed stable-major migrations, but only if Node 22/npm 10 and Node 24/npm 12 template lanes pass.

### 3. Regenerate each accepted graph from its manifest

Use Node 24 and pinned npm 12.0.2 on Linux x64 for canonical lock generation. For each accepted direct candidate, deliberately update or retain the manifest range, run the documented package-lock-only command with scripts/audit/funding disabled and registry URLs omitted, then install from the resulting lock. Do not combine lockfile hunks manually.

Update both the `requirements` and `resolved` entries in `assets/supported-stack.json` to match the final manifests and locks. Run the baseline checker after each graph so a failure identifies the responsible candidate.

The affected graphs are:

1. Root Liftoff: evaluate `@inquirer/prompts` 8.7.0.
2. Standard Node backend: evaluate `tsx` 4.23.12, `@types/pg` 8.23.1, TypeScript 7.0.2, and the resulting patched `fast-uri` transitive graph.
3. Standard frontend: evaluate Vue 3.5.42 and the resulting patched PostCSS graph.

If a candidate fails, regenerate that graph without it and record the exclusion in the replacement PR.

### 4. Narrow future Dependabot noise without hiding security work

For each configured npm directory, add a uniquely named version-update group that includes minor and patch updates. Unique names avoid branch-name collisions across directories. Major updates remain standalone review points.

For the root, telemetry service, and standard Node backend entries, ignore only `@types/node` `version-update:semver-major`. This expresses the runtime-major boundary while retaining patch/minor type updates and Dependabot security alerts.

Keep the Power Apps snapshot directory absent from `.github/dependabot.yml`. Keep the GitHub Actions entry unchanged except for normal default-branch behavior. Do not specify `target-branch`; the repository default is the source of truth for version and security work.

### 5. Validate affected graphs before GitHub cleanup

The replacement must pass:

- supported-stack refresh/check and freshness review;
- root build and full tests;
- standard Node template installs on npm 10/Node 22 and npm 12/Node 24;
- generated standard Node and frontend build/test verification;
- template dependency audit and exception validation;
- Power Apps asset integrity and starter verification, proving no snapshot bytes changed;
- package smoke and the full Windows/macOS/Linux CI matrix.

Local verification produces evidence but does not replace required GitHub checks.

### 6. Create replacement evidence before closing PRs

Open one replacement PR to `develop` whose body links all 13 Dependabot PRs and records accepted or excluded candidates. Wait for its required checks to pass before closing the originals.

Close candidate PRs as superseded by the replacement. Close Node 26 PRs as incompatible with the Node 24 LTS baseline. Close Power Apps PRs because immutable upstream content requires a snapshot refresh. Do not use Dependabot ignore comments for the Power Apps dependencies because that could suppress updates in other owned graphs; removal of the obsolete directory configuration is the durable control.

After each closure, query the exact head ref. Delete only a named leftover Dependabot ref if it still exists and is associated with that closed PR. No wildcard deletion is allowed.

## Risks / Trade-offs

- [A grouped baseline refresh has a wider diff than one Dependabot PR] -> Regenerate and validate one explicit graph at a time, then present one coherent supported-stack review.
- [A candidate changes while implementation is underway] -> Record canonical versions at implementation start and rerun freshness before opening the replacement PR.
- [TypeScript 7 may fail an older compatibility lane] -> Treat it as conditional and exclude it rather than weakening Node/npm compatibility.
- [Closing PRs too early loses visible replacement context] -> Close only after the replacement PR exists and its required checks pass.
- [Ignoring `@types/node` majors can outlive Node 24] -> Scope the rule to that dependency and remove or revise it during the reviewed Node runtime-major migration.
- [Changing the default branch already retargeted only part of the backlog] -> Use explicit PR-number dispositions; do not infer cleanup from branch prefixes.
- [GitHub may leave branches after closing PRs] -> Inspect and delete only exact verified head refs.

## Migration Plan

1. Refresh the live PR inventory and record candidate SHAs, bases, and checks.
2. Update Dependabot grouping and the Node-major ignore rules on the replacement branch.
3. Evaluate and regenerate the root, Node backend, and frontend graphs separately.
4. Update supported-stack metadata and contributor guidance.
5. Run all local validation and open one PR targeting `develop`.
6. Wait for required GitHub checks; remove any failed candidate and repeat if needed.
7. Comment on and close all 13 superseded PRs with their recorded disposition.
8. Verify exact remote Dependabot refs and remove only leftovers.
9. Promote the completed change to `main` only through the next normal release branch.

Rollback before merge by closing the replacement PR and leaving the original PRs open. After merge to `develop`, revert the replacement commit through a new pull request; do not rewrite branch history or restore closed incompatible/provenance-violating PRs as release inputs.

## Implementation Baseline

Captured on 2026-09-01 before repository mutations:

- Branch: `develop` at `0a3b68f85a75444d8cfa4f8145ce30bcbf8c7b1c`, matching `origin/develop`.
- Production: `origin/main` at `1dcadc0a0f7fdf4cfdb90d62eb2564c56e9ea64d`.
- Default branch: `develop`.
- Power Apps snapshot: 49 files with aggregate SHA-256 `63097239ea999297ceba60c8bd16cc9b9100f28bddc362529c40bf56568014b0`.

| PR | Head SHA | Base | Files | State at capture | Disposition |
| --- | --- | --- | --- | --- | --- |
| #15 | `81a5c8f4f5a5abd76479d6eb7ce5d93dc0379a76` | `main` | Node backend lock | dirty; 3 failed tests | consolidate |
| #16 | `38b94cd717333cbca4b281d8d237b7fd89be7ad4` | `main` | Power Apps lock | dirty; 6 failed checks | close: immutable snapshot |
| #17 | `13a759d146cc3ddd2dd0cadb54712b8b5dc048b0` | `main` | Power Apps manifest and lock | dirty; 6 failed checks | close: immutable snapshot |
| #18 | `b72807f40312ecf40ad0fd0e54dce76f9acb35eb` | `main` | Power Apps lock | dirty; 6 failed checks | close: immutable snapshot |
| #20 | `91a3d422cd06bea569c83b8849b199baedca72c2` | `main` | Frontend manifest and lock | dirty | consolidate |
| #25 | `871d68bdfb83fa0c01dcbb1f50a314413aaa7b62` | `develop` | Telemetry manifest and lock | unstable; 3 failed tests | close: Node 26 types |
| #26 | `2a97ea931e80ffbc099e5e9705f18180778c6282` | `develop` | Frontend manifest and lock | unstable; 3 failed tests | consolidate |
| #27 | `8b89e5d3b8da479d242c23038539e1d4ac7bc7ad` | `develop` | Node backend manifest and lock | unstable; 3 failed tests | close: Node 26 types |
| #28 | `ebf22899f6136671447b6f385ca948809351b6f9` | `develop` | Node backend manifest and lock | unstable; 3 failed tests | evaluate major |
| #29 | `9b45d56c76f3b7cbfa7a99eb566a8f39469cf00c` | `develop` | Node backend manifest and lock | unstable; 3 failed tests | consolidate |
| #30 | `e56d7ca8b1a32112f64f208cdc6bf9c1e0df8eef` | `develop` | Root manifest and lock | unstable; 3 failed tests | close: Node 26 types |
| #31 | `286e17dc59a5a0fa7c4d75f746ba93d334859d9b` | `develop` | Node backend manifest and lock | unstable; 3 failed tests | consolidate at latest stable patch |
| #32 | `a1c57b42ed909d7d13d5fddd993f1b3628c55d3c` | `develop` | Root lock | unstable; 3 failed tests | consolidate |

Canonical inspection found that PR #31's `tsx` 4.23.12 is already superseded by stable 4.23.13. The replacement evaluates 4.23.13 and records #31 as its originating proposal.

## Implementation Results

The consolidated graphs retain:

| Graph | Candidate result |
| --- | --- |
| Root Liftoff | `@inquirer/prompts` 8.7.0 retained; package range remains `^8.6.0`; Node engine requires a supported Node 24 host |
| Standard Node backend | `tsx` 4.23.13, `@types/pg` 8.23.1, and TypeScript 7.0.2 retained |
| Standard Node transitive | `fast-uri` 3.1.6 and nested 4.1.3 already supersede PR #15's older graph |
| Standard frontend | Vue 3.5.42 retained; PostCSS 8.5.26 was already resolved and supersedes PR #20 |
| Node runtime types | `@types/node` 24.13.3 retained in root, telemetry, and backend graphs |
| Power Apps starter | Aggregate SHA-256 remains `63097239ea999297ceba60c8bd16cc9b9100f28bddc362529c40bf56568014b0` across 49 files |

Canonical locks were regenerated under Linux x64 Node 24.20.0 with npm 12.0.2 and contain no registry `resolved` URLs. TypeScript 7 and the final backend/frontend graphs passed the Linux x64 Node 22.12/npm 10.9.4 and Node 24.20/npm 12.0.2 template lanes. Root build and interactive tests, the complete Liftoff test suite, telemetry tests, package smoke, standard template verification, Power Apps verification, template audit, and generated container verification pass.

The advisory supported-stack freshness probe was also run. Registry lookups timed out, and mutable Python/Langfuse tags reported digest movement unrelated to these npm candidates. Those findings are not promoted in this dependency-only change; deterministic supported-stack checking remains current.
