## 1. Refresh the live backlog and safety baseline

- [x] 1.1 Re-query open PRs #15–#18, #20, and #25–#32 and record each exact head SHA, base branch, changed-file list, mergeability, and check state; verify every PR still maps to one explicit disposition before changing repository or GitHub state
- [x] 1.2 Confirm the replacement work is based on the current `develop` tree and that `main` receives no direct commit; verify the eventual replacement PR base is `develop`
- [x] 1.3 Capture and verify the current Power Apps starter catalog hashes before dependency work so a final byte comparison can prove the immutable snapshot did not change

## 2. Constrain future Dependabot proposals

- [x] 2.1 Add uniquely named minor-and-patch version-update groups to the root, telemetry, standard Node backend, and standard frontend npm entries; verify each configured directory has exactly one non-colliding routine group and major updates remain outside those groups
- [x] 2.2 Add `@types/node` semantic-major ignores to the root, telemetry, and standard Node backend entries only; verify patch/minor version updates, other dependency majors, and security update behavior remain enabled
- [x] 2.3 Keep the Power Apps snapshot absent from Dependabot package-directory configuration and omit `target-branch`; verify `.github/dependabot.yml` relies on default `develop` and lists only the four owned npm graphs plus GitHub Actions
- [x] 2.4 Add focused configuration tests and contributor guidance for grouping, Node-major review, default-branch targeting, and immutable snapshot ownership; verify tests use exact named entries rather than recursive path matching

## 3. Refresh the root package graph

- [x] 3.1 Inspect canonical metadata and compatibility for `@inquirer/prompts` 8.7.0 represented by PR #32; verify the candidate is stable, satisfies the existing manifest range or an intentionally updated range, and supports the Node 24 runtime contract
- [x] 3.2 Regenerate the root lock with Node 24 and npm 12.0.2 without lifecycle scripts, audit mutation, funding output, or registry URLs; verify the root manifest, lock, and supported-stack `liftoff` requirements/resolved entries agree
- [x] 3.3 Install the regenerated root graph and run the Liftoff build and focused interactive tests; verify package metadata remains byte-identical after installation and candidate validation

## 4. Refresh the standard Node backend graph

- [x] 4.1 Evaluate `tsx` 4.23.12 and `@types/pg` 8.23.1 from PRs #31 and #29 against the generated backend contract; verify both stable candidates install and the generated backend builds/tests before retaining them
- [x] 4.2 Evaluate TypeScript 7.0.2 from PR #28 as a reviewed major candidate in both Node 22/npm 10.9.4 and Node 24/npm 12.0.2 lanes; retain it only if both lanes and generated backend type checks pass, otherwise regenerate without it and record the incompatibility
- [x] 4.3 Regenerate the standard Node backend lock from the final manifest so the patched `fast-uri` graph represented by PR #15 is resolved without hand-editing transitive lock entries; verify the final lock has no unresolved applicable advisory
- [x] 4.4 Update the supported-stack `node-backend` requirements/resolved identities and generated lock assets from the final graph; verify baseline checking and standard Node template verification pass without package metadata drift

## 5. Refresh the standard frontend graph

- [x] 5.1 Evaluate Vue 3.5.42 from PR #26 and the patched PostCSS graph represented by PR #20 against the existing Vite/Tailwind baseline; verify production build behavior and supported ranges before retaining each candidate
- [x] 5.2 Regenerate the frontend lock with Node 24/npm 12.0.2 and update its supported-stack requirements/resolved identities; verify npm 10/Node 22 and npm 12/Node 24 installs plus the generated frontend production build pass without metadata rewrites

## 6. Preserve excluded dependency boundaries

- [x] 6.1 Keep root, telemetry, and backend `@types/node` on the newest verified Node 24-compatible release rather than applying PRs #25, #27, or #30; verify all manifests, locks, and supported-stack entries agree on the retained major
- [x] 6.2 Leave every file under the commit-addressed Power Apps starter snapshot byte-identical rather than applying PRs #16, #17, or #18; verify catalog integrity, starter install/lint/build, and the before/after hash comparison pass

## 7. Complete local and cross-platform qualification

- [x] 7.1 Run supported-stack refresh/check, freshness review, template dependency security audit, focused root/backend/frontend tests, and generated standard template verification; resolve any failure by excluding the responsible candidate rather than weakening policy
- [x] 7.2 Run `npm run check`, package smoke, Power Apps verification, and all existing generated-project gates; verify package manifests and locks remain unchanged after every install/build/test command
- [ ] 7.3 Ensure the Dependabot configuration contract tests run in the existing Windows CI lane and use platform-correct path handling; verify required Windows, macOS, and Linux checks all pass on the replacement PR
- [x] 7.4 Validate `reconcile-dependabot-backlog` and the affected main OpenSpec specification in strict mode before GitHub cleanup

## 8. Replace and close the Dependabot backlog

- [x] 8.1 Commit and push the coherent change on one feature branch and open one pull request targeting `develop`; verify its body links all 13 original PRs and records which seven candidates were retained or excluded
- [ ] 8.2 Wait for every required replacement-PR check to complete successfully; if a candidate fails, revise and revalidate the replacement before closing any original PR
- [ ] 8.3 Comment on and close #15, #20, #26, #28, #29, #31, and #32 as superseded by the validated replacement PR; verify none was merged independently
- [ ] 8.4 Comment on and close #25, #27, and #30 as incompatible with the Node 24 LTS baseline, and #16, #17, and #18 as incompatible with immutable upstream snapshot ownership; verify each closure links the governing replacement or refresh process
- [ ] 8.5 Query every exact closed-PR head ref and remove only verified leftover Dependabot branches; verify no wildcard deletion occurs and no open dependency PR remains based on `main`
- [ ] 8.6 Confirm `develop` contains the merged reconciliation and `main` remains unchanged pending a normal release branch; verify the final open-PR and branch inventory matches GitFlow policy
