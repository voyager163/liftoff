## Why

Liftoff packages deterministic dependency templates that currently contain eight open Dependabot alerts even though the CLI's own dependency tree audits clean. Fixable template vulnerabilities need prompt remediation, while non-applicable transitive findings need explicit, expiring evidence instead of being silently ignored or forcing unsafe upstream divergence.

## What Changes

- Upgrade the standard Node.js backend template to a patched Drizzle ORM release.
- Upgrade the standard frontend template to the smallest compatible Vite release that resolves its Vite and esbuild advisories, avoiding an unnecessary major-version jump.
- Audit every packaged npm lockfile, including immutable Power Apps starter assets, on a scheduled basis.
- Require each unresolved advisory to have a checked-in, time-bounded exception that records applicability, rationale, mitigation, ownership, and review expiry.
- Preserve the pinned official Power Apps source identity when an advisory affects code paths the generated starter does not use; track the responsible upstream package instead of applying an unverified override.
- Reject unreviewed or expired template advisories in the dedicated audit workflow and report affected template paths and dependency chains.
- Cover dependency refreshes and advisory policy with deterministic generation, install, build, and cross-platform regression tests.

## Capabilities

### New Capabilities

- `liftoff-template-dependency-security`: Defines vulnerability scanning, minimal safe upgrades, reviewed exceptions, upstream-derived template handling, and scheduled enforcement for packaged dependency templates.

### Modified Capabilities

None.

## Impact

- Affects `assets/locks/node-backend`, `assets/locks/frontend`, the packaged Power Apps starter lockfile, dependency-template tests, and GitHub automation.
- Adds a repository-owned advisory policy and audit tooling without changing the Liftoff CLI command surface or generated manifest schema.
- May update generated standard-project dependency versions and lockfile bytes; existing generated projects remain unchanged until developers update their own dependencies.
- Leaves Liftoff's root runtime dependency graph and the immutable Microsoft starter source snapshot unchanged unless a separately verified upstream refresh is selected.
