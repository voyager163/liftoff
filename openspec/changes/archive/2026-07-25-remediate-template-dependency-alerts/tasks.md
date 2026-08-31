## 1. Security Policy Foundation

- [x] 1.1 Add an explicit packaged npm lockfile inventory with stable logical names and path-part arrays for the Node.js backend, standard frontend, and commit-addressed Power Apps starter.
- [x] 1.2 Add coverage validation that fails when a lockfile shipped through the npm package is absent from the explicit inventory or an inventory entry does not resolve to a packaged lockfile.
- [x] 1.3 Define the versioned JSON exception-policy shape with exact advisory, package, manifest path parts, complete dependency-chain set, disposition, rationale, mitigation, owner, review dates, and optional upstream reference fields.
- [x] 1.4 Implement strict policy parsing for required fields, allowed dispositions, GHSA identifiers, ISO dates, duplicate keys, known inventory entries, and nonempty review evidence.

## 2. Deterministic Audit Engine

- [x] 2.1 Normalize npm audit v2 direct and transitive vulnerability nodes into unique manifest-scoped findings with leaf advisory identifiers, package names, severities, affected nodes, and dependency chains.
- [x] 2.2 Match findings to exceptions by exact advisory, package, and manifest path while keeping duplicate advisories in different templates independent.
- [x] 2.3 Enforce expiry and maximum review windows of 30 days for high or critical findings and 90 days for moderate or lower findings.
- [x] 2.4 Reject unreviewed findings, malformed or overlong exceptions, duplicate matches, stale exceptions, and policy entries for manifests outside the inventory.
- [x] 2.5 Produce concise actionable output that distinguishes clean templates, fixed findings, reviewed findings, policy failures, and audit infrastructure failures.

## 3. Read-Only Live Audit Command

- [x] 3.1 Add a maintainer audit command that resolves every inventory entry with Node.js path utilities and runs npm through the existing cross-platform process dependency.
- [x] 3.2 Run `npm audit --package-lock-only --json` against canonical npm without installing dependencies, creating `node_modules`, or modifying package and lockfile bytes.
- [x] 3.3 Accept npm exit codes 0 and 1 as parseable audit outcomes, reject all other exit codes, and surface malformed JSON or registry failures without a success-shaped fallback.
- [x] 3.4 Add a package script for the live template audit while keeping the audit implementation and policy out of the published npm tarball.

## 4. Standard Template Remediation

- [x] 4.1 Update the Node.js backend template manifest to require Drizzle ORM `^0.45.2`.
- [x] 4.2 Regenerate the Node.js backend lockfile with pinned npm 11.7.0 on Linux, normalize it with baseline npm 10.8.2, and confirm it resolves patched Drizzle ORM without changing the approved backend stack.
- [x] 4.3 Update the standard frontend template manifest to require Vite `^6.4.3` while retaining the compatible `@vitejs/plugin-vue` 5.x line.
- [x] 4.4 Regenerate the standard frontend lockfile with pinned npm 11.7.0 on Linux, confirm baseline npm 10.8.2 can install it, and verify it resolves Vite 6.4.3 or newer within the 6.x line and esbuild 0.25.0 or newer.
- [x] 4.5 Add regression assertions that the frontend remediation does not introduce Vite 7 or 8 or an unnecessary Vue plugin major upgrade.

## 5. Reviewed Upstream and Tooling Exceptions

- [x] 5.1 Record the backend esbuild exception for the `drizzle-kit` dependency chain with evidence that generated commands do not invoke esbuild's affected `serve()` API.
- [x] 5.2 Record the Power Apps React Router exception against the exact starter manifest with evidence that the generated app is a Vite browser SPA and uses no unstable RSC API.
- [x] 5.3 Record the Power Apps uuid exception against the exact starter manifest with evidence that the pinned MSAL implementation imports only `uuid.v4()`.
- [x] 5.4 Record the Power Apps brace-expansion exception against the exact starter manifest with evidence that ESLint is development-only and receives the fixed literal argument `.` rather than attacker-controlled brace patterns.
- [x] 5.5 Assign owners, bounded review dates, mitigations, and upstream tracking references to every initial exception.
- [x] 5.6 Verify the exception policy does not modify the pinned Microsoft starter package, lockfile, catalog, attribution, or content hashes.

## 6. Deterministic Security Tests

- [x] 6.1 Add committed audit fixtures for clean output, direct advisories, transitive chains, duplicate nodes, one advisory across multiple manifests, and malformed npm output.
- [x] 6.2 Test exact exception matching, missing exceptions, duplicate policy entries, expired dates, overlong review windows, stale entries, and controlled-date evaluation.
- [x] 6.3 Test inventory coverage and path resolution with Windows, macOS, and Linux path semantics without hardcoded separators.
- [x] 6.4 Test that live command exit-code handling distinguishes findings from registry, process, and parse failures.
- [x] 6.5 Test that audit execution leaves package manifests, lockfiles, and the repository free of generated `node_modules`.
- [x] 6.6 Update package smoke coverage to prove patched template manifests and lockfiles remain published while contributor-only audit policy and scripts remain excluded.

## 7. Generated Project Verification

- [x] 7.1 Generate a standard Node.js project and verify its backend completes `npm ci`, TypeScript build, and generated tests with the patched Drizzle dependency.
- [x] 7.2 Generate a standard frontend project and verify it completes `npm ci` and a Vite production build with the patched 6.x toolchain.
- [x] 7.3 Verify standard template generation remains deterministic and lockfile-preserving after both dependency refreshes.
- [x] 7.4 Run Power Apps catalog integrity checks and the supported starter install, lint, and build verification without changing upstream bytes.
- [x] 7.5 Ensure the existing Linux, macOS, and Windows CI matrix exercises the new path, policy, generation, and package-smoke regression coverage.

## 8. Scheduled Enforcement and Guidance

- [x] 8.1 Add a least-privilege weekly and manually dispatchable GitHub Actions workflow for live template dependency auditing with the supported Node.js baseline.
- [x] 8.2 Make the workflow fail with separate actionable summaries for unreviewed advisories, invalid exceptions, stale exceptions, and canonical npm infrastructure failures.
- [x] 8.3 Document how maintainers perform targeted dependency refreshes, add or renew reviewed exceptions, remove stale exceptions, and refresh the Power Apps starter without bypassing provenance.
- [x] 8.4 Document that live advisory retrieval is intentionally isolated from ordinary pull-request CI while deterministic policy fixtures remain part of the normal test suite.

## 9. Final Validation and Alert Disposition

- [x] 9.1 Run the targeted security-policy tests, repository build and tests, package smoke test, generated standard-project verification, and Power Apps starter verification.
- [x] 9.2 Run the live audit and confirm every fixable current finding is removed and every remaining finding matches exactly one valid non-expired exception.
- [x] 9.3 Confirm Liftoff's root dependency audit remains clean and no package or lockfile changed during the read-only template audit.
- [x] 9.4 Rebase or supersede Dependabot PR #9 and close duplicate Vite major-upgrade PRs #10 and #11 after the targeted replacements are available.
- [x] 9.5 Confirm the five fixable GitHub alerts close after default-branch scanning and disposition the remaining non-reachable alerts consistently with the checked-in exception policy.
- [x] 9.6 Run strict OpenSpec validation and reconcile any implementation or documentation drift before verification.
