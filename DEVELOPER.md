# Liftoff developer guide

This guide covers release-owned compatibility, deterministic setup, and package
publishing. General contribution setup remains in [CONTRIBUTING.md](CONTRIBUTING.md).

## Activation version vector

Example for the Liftoff 0.10.0 deterministic setup contract:

```json
{
  "liftoffVersion": "0.10.0",
  "manifestArtifactVersion": 7,
  "policyVersion": "6",
  "activationContractVersion": 1,
  "phaseGraphSchemaVersion": 1,
  "phaseGraphHash": "b84bcde6cd614637f2486b0f3a202860e6e9a6142ac60c773daa11786dbeb7f7",
  "activationStateSchemaVersion": 1,
  "evidenceHeaderSchemaVersion": 1,
  "approvalEnvelopeSchemaVersion": 1,
  "supersessionSchemaVersion": 1,
  "credentialPolicySchemaVersion": 1
}
```

`phaseGraphHash` is the lowercase SHA-256 hex digest of the canonical packaged
phase graph bytes. When documenting unreleased work before the final graph is
known, use a clear placeholder such as `<sha256-of-canonical-phase-graph-json>`;
do not fabricate a historical value.

The generated `liftoff.manifest.json` records this as manifest `artifactVersion`
7 plus the activation identity fields shown above.

| Axis | Tracks |
| --- | --- |
| CLI SemVer | Published implementation and npm package behavior. |
| Policy version | Normative GitFlow, governance, security, infrastructure, and documentation rules. |
| Activation contract | Phase order, gates, approvals, evidence meaning, invalidation, rollback, and transition semantics. |
| Schema versions | JSON serialization for graph, activation state, evidence headers, approval envelopes, supersession records, credential policy, and manifest artifacts. |
| Graph hash | Exact canonical graph bytes shipped by the release. |

There is no separate `/liftoff-setup` skill version. The setup integration is a
thin managed artifact; its managed content hash plus the activation contract and
graph hash are sufficient identity.

## Bump rules

| Change | Required bump |
| --- | --- |
| Normative governance rule, fixed GitFlow decision, approval policy, or credential policy meaning changes | `policyVersion` |
| Phase dependency, applicability, gate, mutation, evidence semantics, invalidation, rollback, or terminal-state behavior changes | `activationContractVersion` |
| JSON shape or strict validation changes incompatibly | the affected schema version |
| Managed setup or alias wording changes with no behavior change | managed content hash only |
| CLI-only bug fix with no policy, contract, schema, or managed graph change | CLI SemVer only |

One source change may bump multiple axes. Never advance one axis to hide required
changes in another.

## Compatibility maintenance

- Update the explicit compatibility map for every supported tuple. Do not rely
  on numeric less-than comparisons.
- Preserve v2-v7 manifest readers and v7 writers unless an OpenSpec change
  explicitly replaces that contract.
- Future manifest, policy, contract, schema, or graph identities must block
  without rewriting state and must report the exact field, found value, supported
  identity, and minimum Liftoff remedy.
- Historical state migration requires schema-valid input, an explicit old-to-new
  mapping, transactional writes, immutable evidence preservation, and rollback
  on any failed preflight.
- Never fabricate history: prose, filenames, timestamps, or checked tasks are
  not evidence.

## Release integrity requirements

- Validate the canonical graph, graph hash, per-phase contract digests, and
  compatibility metadata together.
- A graph byte change with unchanged phase semantics needs a compatibility
  mapping for unchanged phase digests; a semantic phase change needs the contract
  bump and affected descendant invalidation.
- Generated OpenSpec seeds must include metadata, proposal, design, tasks, and
  declared capability specs, and must pass strict validation immediately.
- Copilot and Claude `/liftoff-setup` integrations must be behaviorally
  equivalent, command-only, model-agnostic, and free of skill-version fields.
- Credential tests must prove PAT/App policy equivalence, exact workflow/job
  allowlists, masked input, no command-argument/file/log/evidence leaks, and
  compromised revoke/rotate guidance.
- Path tests must cover Windows, macOS, and Linux path-part arrays, symlink
  rejection, atomic state writes, and rollback.

## Focused commands

Run the smallest focused command while iterating:

```bash
npx vitest run tests/documentation.test.ts
npx vitest run tests/templates.test.ts tests/repository-governance.test.ts
npx vitest run tests/governance-activation.test.ts tests/governance-credentials.test.ts
npm run build
openspec validate add-deterministic-liftoff-setup --strict
```

Before release, run:

```bash
npm run check
npm run smoke:package
npm run verify:standard-node-templates
npm run verify:generated-containers
npm run verify:power-apps-starter
npm run verify:release-identity
```

## 0.10.0 release checklist

- Package metadata, lockfile metadata, `liftoff --version`, and tag agree on
  `0.10.0`.
- Manifest writes use artifactVersion 7; readers accept v2-v7.
- Policy version is `"6"`; activation contract, graph/state/evidence/approval/
  supersession/credential schemas are v1.
- The graph hash in code, docs, generated artifacts, compatibility metadata, and
  release-integrity tests is
  `b84bcde6cd614637f2486b0f3a202860e6e9a6142ac60c773daa11786dbeb7f7`.
- `/liftoff-setup` is the primary post-init path and archives the bootstrap seed
  before any commit/push or Phase 0 authority.
- No setup-skill version exists in manifests, JSON status, docs, or generated
  integrations.
- Doctor states and remedies cover seed-incomplete, phase-blocked,
  evidence-stale, credential-expiring, reconciliation-required,
  identity-incompatible, enforcement-incomplete, and disposal-pending.
- Package contents include `DEVELOPER.md`, docs, assets, governance artifacts,
  schemas, compatibility metadata, and setup templates.

## Trusted npm publishing overview

The `Release Liftoff` workflow builds, tests, packs, verifies release identity,
publishes with npm trusted publishing and provenance, then verifies the canonical
dist-tag. Do not place npm tokens, registry credentials, PATs, cloud secrets, or
signing material in repository files, workflow logs, chat, screenshots, or
evidence. Failed post-publish verification requires a dist-tag correction when
the immutable package is correct, or a corrected patch release; do not unpublish
as routine recovery.
