---
name: liftoff-cli-upgrade
description: "Routine owner-preserving CLI self-upgrade; inspects release catalog and upgrades without extra confirmation."
---

# Liftoff CLI Upgrade Workflow

## Capability and Owner Inspection

```bash
liftoff capabilities --json
liftoff installation inspect --json
liftoff upgrade --check --json
```

Require `cli-upgrade`, Distribution and CLI Upgrade, public envelope schema 1 and
the actual upgrade JSON result schema 1. Installation inspection is the distinct
`installation-inspection` capability; its report is not an upgrade result.
Native upgrade results identify `distribution`, `mode`, `status`, owner,
upstream/owner availability, reason, completed/uncertain effects and recovery.
Interpret the actual returned contract, not an imagined latest-version field.

Unknown, unlinked, conflicting or historical npm ownership does not permit
replacement. npm is not a current native release channel. Homebrew cask, WinGet
and direct ownership must be independently proven with exact package/launcher
identity and candidate/resource integrity. PATH presence is not ownership.

## Routine Invocation Has Narrow Authority

When the developer explicitly requests the owner-preserving upgrade:

```bash
liftoff upgrade
liftoff upgrade --json
```

The dedicated invocation authorizes only the internally bound validated target
through the proven current owner. It does **not** require an extra confirmation
prompt or plan fingerprint flag. Never add another command's approval flag.
This authorizes neither installation-owner migration, elevation, an unrelated
package upgrade nor project work.

Respect enterprise policy, manager lag, unsupported targets, locked-file handover,
current owner/source changes and unavailable verification. Never use sudo, a
force override, a mutable download, npm replacement or direct edits to work around
a blocker. Installation migration uses its own verified unlinked candidate,
ordered plan and separate default-No/exact machine authorization.

## Verify Without Expanding Scope

Read actual explicit-path, ownership, resource and ordinary command-resolution
verification. Report completed effects, uncertain effects and remaining recovery,
not just exit status. Update-available is not installed. A failed candidate must
not replace the usable current version or trigger premature cleanup.

Existing projects, manifests, Node/npm dependencies, locks, framework output,
history and state remain untouched. Offer a separately requested project
assessment/update preview after installation; never run initialization, project
migration, skills delivery or cloud work as an upgrade side effect.
