---
name: liftoff-repair
description: "Execute targeted application code repair and baseline remediation under staged validation and contract 1 / report schema 2."
---

# Liftoff Repair Workflow

## Capability Negotiation Before Project Access

The CLI owns repair decisions and writes. This is not setup, assessment, agent
installation, or a second mutation engine. Managed content hashes identify this
integration; there is no independent skill SemVer or embedded model client.

```bash
liftoff capabilities --json
liftoff repair --capabilities --json
```

Require public envelope schema 1, capability `project-repair`, Project Evolution,
repair contract 1 and report schema 2. The native capabilities body is schema 1,
kind `liftoff-repair-capabilities`, with `cliVersion` and `repairContractVersion: 1`.
Read its exact `schemas`, `recipes`, `modes`, preparation providers and toolchains.
Report/preview/history/journal remain schema 2; do not retag them as public schema 1.
Application inventory/patch/verification retain their own declared schemas.

Supported preparation is explicit: `npm-ci`, `uv-locked-sync`, and `go-mod-download`
version 1, with only the registered `npmjs`, `microsoft-npm`, `pypi`,
`microsoft-pypi`, and `go-proxy` sources. Check the actual recipe identity:
`azure-local-layout`, `azure-baseline-settings`, or `application-layout-patch`,
their registered versions and supported modes, including `interactive-repair`.
Repair contract 1/report 2 is released in 0.12.3; availability of a newer recipe
still requires negotiation. CLI SemVer, model confidence or file presence is
not compatibility or host/provider qualification.

Missing support: stop and offer a non-installing upgrade check. An upgrade
requires its own requested scope; then negotiate again. Never emulate a missing
feature with edits, commands, fabricated receipts, or a model-generated result.

```bash
liftoff upgrade --check --json
```

## Exact Project Context and Default-No Review

Retain schema-2 `nextActions`, `command.executable`, literal `command.args`, `cwd`,
project, scope, configuration path/digest, `approvalRequired`, and effects.
Use argument arrays or native shell rendering, not concatenated project prose.
The following examples use an explicit project; repair also supports its
registered project option. Do not infer a different root after changing cwd.

```bash
liftoff repair ./my-app --check --json
liftoff repair ./my-app
```

Prefer the genuine terminal journey. It displays the immutable plan before
Yes/No, default No, with usable input and stderr TTYs. No/Ctrl-C/EOF declines
without unapproved writes. Never require human hash entry. JSON/non-TTY bare
repair previews only; never prompt or wait there. Autopilot, generic Yes, piped
answers, and model-generated approval grant no authority.

Ordinary check makes no cloud calls. Separately approved live inspection needs
the exact live/subscription options and existing authentication; state/backend
metadata stay protected. Deployed or unknown state remains plan-only. Missing
files prove no absence, and no public stateful migration is inferred.

## Actual Inventory, Mappings, and Reference Review

```bash
liftoff repair ./my-app --inspect-layout --json
```

Use actual artifact IDs and paths, source provenance, digests, modes, directory
inventory, customizations, and every source mapping. Review imports/module paths,
build/test configuration, Docker/Compose contexts, scripts, CI and documentation
references. Respect protected-file exclusions and bounded coverage. Do not infer
historical layouts, replace customized code with starters, guess a move, or
expand ownership by wildcard or recursive directory selection.

Author exact replacement bytes and a strict application-patch document in
external isolated staging OUTSIDE the project, using the installed schema.
Bind every source/destination, digest/mode, staged bytes, target identity,
reference review and exact declared check.

```bash
liftoff repair ./my-app --check --application-patch ../reviewed-patch.json --json
liftoff repair ./my-app --application-patch ../reviewed-patch.json
```

Explain the diff, references, limits and expiry. Changed bytes, modes, directories,
toolchains, configuration, inputs or identity after the prompt invalidate review.

## Separate Verification, Network, and File Authority

Before checks, obtain independent default-No consent for declared locked dependency
preparation, exact project-code execution, and separately for declared network.
Registered providers restore into private environments with lifecycle scripts
suppressed (`lifecycle: disabled`). No arbitrary installer, global installation,
live dependency reuse, inherited credentials, or lock upgrade is permitted.
Missing tools, locks, unsupported hooks or sources remain explicit blockers.

Private staging is NOT an OS or network sandbox. Trusted dependency/project code
can affect the host and access the network. A `network: false` declaration does
not prove isolation. Mandatory unsupported isolation blocks execution.
Preparation and network consent imply no file approval; failed checks apply no patch.

After fresh successful verification, the CLI asks SEPARATELY about exact file
writes. A later decline must report earlier authorized commands and observations,
not claim "nothing happened." Cancellation cannot undo host/network effects.
Only the confined guarded transaction applies the patch; no retrospective
approval or force/yes bypass is allowed.

Application patches cannot edit manifest/provenance, desired state, framework or
managed integrations, activation proof, history, state or secrets. This does not
prohibit a registered Azure recipe's separately reviewed manifest/history producer.
Never fabricate evidence, retag old records, or acquire authority from a matching hash.

Machine execution uses only actual returned actions after the user separately
approved the corresponding immutable scope. `--verify-plan` selects verification;
`--allow-dependency-preparation` and `--allow-network` need separate consent.
`--approve-plan` selects the later, separately authorized file transaction.
Do not construct or copy a fake fingerprint, reuse another action's approval, or
turn a generic repair request into any of these permissions.

## Readback, Recovery, and Scoped Continuation

Distinguish inventory, proposal, preparation, checks, committed effects, readback,
cleanup and remaining work. Build-only proof is not tests. Declared checks are not
complete application/cloud conformance or activation. Preserve private rollback
material and immutable history; uncertain process settlement blocks success
and unsafe cleanup.

```bash
liftoff repair ./my-app --recover --json
```

Recover only the original reported interrupted scope, never generic cleanup or
rerunning verification. Do not delete user staging/backups/history, guess cleanup
paths, or restore old bytes over newer user files. Post-commit corrections require
a new reviewed patch or user-controlled history recovery.

```bash
liftoff update --project ./my-app --check --json
liftoff governance status --project ./my-app --scope local --json
liftoff governance verify --project ./my-app --scope local --json
liftoff governance resume --project ./my-app --scope local --json
```

Update approval is separate. Follow governance continuations only when enabled,
for the same selected project and original configuration binding. Explain Local
baseline verification rather than asking users to complete raw phase IDs manually.
Deployment/activation consent remains separate.

Governance `none` stays disabled: do not create policy, setup, assessment, state
or evidence to use repair. Do not invent agent installation, shell setup or
state-migration commands. Missing selected integrations need reviewed additive
update; unowned collisions and neighboring skills remain protected.
