## Context

Liftoff publishes three npm lockfile families as runtime scaffold assets:

- `assets/locks/node-backend/package-lock.json`
- `assets/locks/frontend/package-lock.json`
- the lockfile under the commit-addressed Power Apps starter asset

The root Liftoff dependency tree currently audits clean, but these packaged templates contain eight open Dependabot alerts. Five findings have compatible fixes: Drizzle ORM in the Node.js backend template and Vite plus its esbuild dependency in the standard frontend template. Three findings are not reachable through the generated behavior: the Node.js backend uses an old esbuild only through `drizzle-kit` without invoking `serve()`, the Power Apps SPA does not use React Router's unstable RSC APIs, and MSAL uses `uuid.v4()` rather than the affected buffered v3/v5/v6 APIs. A newer `brace-expansion` advisory is also visible through `npm audit` in the Power Apps development toolchain but is not yet represented by a Dependabot alert.

The standard template lockfiles are Liftoff-owned. The Power Apps files are a hash-verified snapshot of Microsoft's official starter, with a locally generated deterministic lockfile tied to the recorded source commit. Security remediation must therefore distinguish a normal Liftoff dependency refresh from an upstream-derived asset change that would alter recorded provenance.

## Goals / Non-Goals

**Goals:**

- Remove every currently fixable advisory without unnecessary major-version upgrades.
- Inventory and audit every packaged npm lockfile explicitly.
- Represent unresolved findings as exact, reviewable, expiring exceptions.
- Keep the official Power Apps source snapshot byte-for-byte intact when affected code is demonstrably unused.
- Make live advisory checks actionable without making ordinary pull-request CI nondeterministic.
- Preserve deterministic scaffold generation and cross-platform install and build behavior.

**Non-Goals:**

- Changing Liftoff's CLI commands, manifest schema, or root runtime dependencies.
- Rewriting already-generated developer projects.
- Automatically applying `npm audit fix`, dependency overrides, or unreviewed major upgrades.
- Dismissing an applicable vulnerability solely because an upstream fix is unavailable.
- Replacing Dependabot or GitHub security alerts.
- Refreshing the Microsoft starter commit unless a separate upstream refresh is selected and verified.

## Decisions

### 1. Maintain an explicit packaged-lockfile inventory

The audit implementation will enumerate each packaged lockfile by stable logical name and path-part array. It will not discover manifests with a filesystem glob. The initial inventory contains the Node.js backend template, standard frontend template, and the current commit-addressed Power Apps starter.

Path-part arrays will be resolved with `path.join()` so a manual audit identifies the same files on Windows, macOS, and Linux. The Power Apps entry includes the immutable source commit in its path. A future starter refresh must update that explicit entry and re-review all exceptions.

**Alternative considered:** recursively scan every `package-lock.json`. This is simpler, but it can silently expand scope to fixtures or contributor-only projects and violates the repository's explicit asset-tracking convention.

### 2. Use minimal compatible upgrades for fixable findings

The standard Node.js backend package will move from Drizzle ORM `^0.44.0` to `^0.45.2`, resolving the identifier-escaping SQL injection advisory.

The standard frontend package will move from Vite `^5.3.1` to `^6.4.3`. Its existing `@vitejs/plugin-vue` 5.x line supports Vite 6, and Vite 6.4.3 resolves all three Vite advisories while selecting esbuild 0.25 or newer. The Dependabot proposals that jump directly to Vite 8 and `@vitejs/plugin-vue` 6 will not be used.

Both lockfiles will be regenerated together with their package manifests using pinned npm 11.7.0 on Linux, normalized with the oldest supported npm 10.8.2 baseline, and followed by `npm ci` plus generated-project validation on every supported operating system. The baseline normalization prevents newer npm lockfile deduplication from omitting nested optional-peer records still required by npm 10.

**Alternative considered:** merge the existing Dependabot major-upgrade pull requests. Their changes are broader than the security boundary, duplicate one another, and add avoidable Vite 7 and 8 migration risk.

### 3. Store reviewed exceptions as repository-owned structured data

A checked-in JSON policy will contain `schemaVersion` and explicit exception records. Each record will include:

- advisory identifier and affected package
- manifest path parts and the complete reviewed dependency-chain set
- disposition from a small allowlist such as `vulnerable-code-not-used` or `mitigated`
- technical rationale and concrete mitigation
- responsible owner
- `reviewedAt` and `reviewBy` ISO dates
- upstream tracking reference when remediation depends on another maintainer

Severity comes from the live advisory result rather than the policy file. Exceptions for high or critical findings may span at most 30 days; moderate or lower findings may span at most 90 days. Matching uses the advisory, package, and exact manifest path so the same advisory in two templates requires two independent decisions.

The initial records will cover:

- backend `esbuild` through `drizzle-kit`, because the affected `serve()` API is not invoked
- Power Apps `react-router`, because the generated Vite SPA uses `createBrowserRouter` and no unstable RSC API
- Power Apps `uuid`, because the pinned MSAL dependency imports only `v4()`
- Power Apps `brace-expansion`, because the development-only ESLint command uses the fixed literal argument `.` and accepts no attacker-controlled pattern

An exception is invalid when required evidence is missing, its review window is too long, it has expired, it no longer matches a finding, or its recorded manifest is not in the inventory. A finding with no valid exception fails the audit regardless of severity.

**Alternative considered:** dismiss findings only in GitHub. That loses review data from source control, cannot cover npm advisories that Dependabot has not surfaced yet, and provides no deterministic expiry enforcement.

### 4. Separate deterministic policy tests from live advisory retrieval

Pure policy parsing, finding normalization, exact matching, expiry behavior, and reporting will be covered by committed fixtures in normal CI. A dedicated workflow, scheduled weekly and available through manual dispatch, will run live `npm audit --package-lock-only --json` against canonical npm for each inventory entry.

The live runner will use the existing cross-platform process dependency instead of shell-specific command names. Exit code 0 means no findings, exit code 1 is accepted as advisory output, and any other exit code or malformed response is an explicit infrastructure failure. The command must not install dependencies, create `node_modules`, or rewrite package metadata.

The workflow will print the manifest, advisory, package, severity, affected nodes and dependency chains, and disposition. It will fail for unreviewed, malformed, expired, overlong, duplicate, partially matched, or stale exceptions. Ordinary pull-request CI will test the policy engine with fixtures but will not depend on mutable registry advisory data.

**Alternative considered:** run live npm audits in every pull request. Newly published advisories or registry outages could block unrelated work without a reviewed policy update, making CI nondeterministic.

### 5. Preserve Power Apps provenance instead of applying hidden overrides

No `overrides` entry or manual package substitution will be injected into the pinned Microsoft starter for the currently non-reachable React Router, uuid, or brace-expansion findings. The catalog hashes and upstream file provenance remain unchanged.

When Microsoft publishes a compatible starter or CLI dependency fix, maintainers will use the existing starter refresh workflow, regenerate its lockfile, update the explicit inventory path, and remove now-stale exceptions. If later analysis shows that an affected path is reachable, the exception becomes invalid and release work must stop until a verified patch or mitigation is designed.

**Alternative considered:** force transitive versions with npm overrides. React Router DOM does not yet expose the patched React Router 8 line, MSAL's pinned major has a different dependency contract, and unverified overrides could make the official starter unsupported while obscuring its real provenance.

### 6. Treat generated-template validation as part of remediation

Dependency-only changes must still prove the generated product:

- Node.js standard backend: deterministic generation, `npm ci`, TypeScript build, and tests
- standard frontend: deterministic generation, `npm ci`, Vite production build, and package smoke coverage
- Power Apps: unchanged asset hashes plus install, lint, and build verification
- all inventory and policy path handling: Windows, macOS, and Linux-safe tests

The audit policy and workflow are contributor-only assets and remain excluded from the published npm tarball. The patched package manifests and lockfiles remain included because the CLI renders them into generated projects.

## Risks / Trade-offs

- **[Reviewed exceptions can become permanent normalization of risk]** -> Enforce exact matching, mandatory evidence, short maximum review windows, owners, stale-entry failure, and scheduled re-evaluation.
- **[Live npm advisory data can change or be unavailable]** -> Isolate live retrieval in a scheduled/manual workflow and treat registry failures distinctly from vulnerability findings.
- **[Vite 6 or Drizzle 0.45 can introduce compatibility changes]** -> Use the smallest patched lines and run generated install, build, and test coverage across all supported operating systems.
- **[Lockfile generation can vary by npm version or host]** -> Resolve with pinned npm 11.7.0 on Linux, normalize with baseline npm 10.8.2, and verify `npm ci` on Windows, macOS, and Linux.
- **[An upstream-derived finding can become reachable after a starter refresh]** -> Bind exceptions to the exact manifest path and complete dependency-chain set so a commit-addressed refresh or new path invalidates the old review.
- **[A scanner may classify development tools as runtime dependencies]** -> Base disposition on actual generated deployment and invoked APIs, while still tracking every scanner finding.

## Migration Plan

1. Add the explicit lockfile inventory, policy schema, parser, matching rules, report formatter, fixtures, and deterministic tests.
2. Update Drizzle ORM and regenerate the Node.js backend lockfile.
3. Update Vite to the compatible patched 6.x line and regenerate the standard frontend lockfile.
4. Add initial reviewed exceptions for the unresolved backend and Power Apps findings with bounded review dates and upstream references.
5. Add the weekly/manual audit workflow and contributor documentation for refreshing dependencies, renewing evidence, and removing stale exceptions.
6. Run repository checks, generated standard-project install/build tests, Power Apps install/lint/build verification, package smoke tests, and the live template audit.
7. Rebase or supersede the precise Drizzle Dependabot pull request, close the duplicate Vite 8 proposals, and disposition the remaining GitHub alerts consistently with the checked-in policy.

Rollback consists of reverting the dependency manifests, lockfiles, audit policy, script, and workflow together. Existing generated projects and the published 0.5.0 package remain unchanged.

## Open Questions

None. Future exception renewal is an explicit security review, not an automatic extension.
