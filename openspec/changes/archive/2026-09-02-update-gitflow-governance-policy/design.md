## Context

See `proposal.md` for motivation. Liftoff currently packages one versioned policy
asset verbatim, validates mandatory contract fragments, and renders it with a
deterministic workload context, guide, and thin agent launchers. The supplied
revision changes the normative baseline but omits Liftoff's frontmatter and
activation protocol, so it cannot safely replace the asset byte-for-byte.

Two GitHub mechanics also need explicit treatment:

1. Staging qualifies a release or hotfix branch tip, while a true merge into
   `main` creates a different commit.
2. Events created with `GITHUB_TOKEN` do not ordinarily trigger additional
   workflows, although an explicit `workflow_dispatch` remains available.

## Goals / Non-Goals

**Goals:**

- Package the revised standard as a deterministic, versioned Liftoff handoff.
- Give future governance agents an internally coherent release identity model.
- Preserve zero-human-approval, pull-request-only protected branches.
- Make the VNet-injected runner and SLSA pinning exceptions narrow and fail
  closed.
- Keep universal defaults separate from workload-specific applicability.

**Non-Goals:**

- Activate governance or alter this repository's live GitHub settings.
- Provision the organization-level runner group or Azure network configuration.
- Implement release, deployment, monitoring, or ruleset workflows for Liftoff
  itself.
- Resolve repository-specific Phase 0 facts in the generated universal policy.

## Decisions

### Preserve the Liftoff envelope and advance the policy version

The canonical asset will remain a single self-contained document:

```text
Liftoff frontmatter
        │
        ▼
updated normative governance baseline
        │
        ▼
Liftoff activation protocol
```

The policy version will advance because generated managed-core bytes and
downstream obligations change. The supplied normative text will be integrated
between the existing envelope sections rather than replacing the complete file.
Validation will retain the approval and activation-baseline fragments and add
fragments for each new fixed decision.

Alternative considered: package the supplied text unchanged. Rejected because
it would remove schema identity, handoff state, approval sequencing, and
grandfathering behavior that existing Liftoff specifications require.

### Model candidate and production identities separately

Every qualified release will carry this identity tuple:

```text
version
release_branch
candidate_sha ───────► artifact_digest
      │                       │
      └── qualification ──────┤
                              ▼
main_merge_sha ───────► production deployment
      │
      └───────────────► vX.Y.Z tag + GitHub Release
```

The qualification record and provenance bind `candidate_sha` and
`artifact_digest`. Production verifies that the `main` commit is a true merge
whose merged release or hotfix parent is the qualified candidate, then records
`main_merge_sha` against the same digest. The immutable tag targets
`main_merge_sha`; evidence records both SHAs.

For npm and other package formats that require embedded versions, branch naming
remains authoritative. Artifact metadata is derived from or checked against the
branch version during candidate stabilization. It is required metadata, not an
independent version declaration.

Alternative considered: require qualification to bind the future `main` SHA.
Rejected because that SHA does not exist before the merge and would require a
production rebuild, violating build-once promotion.

### Complete automated back-merges through checked pull requests

Protected branches retain empty branch bypass lists. After successful production
release work, the coordinating workflow creates a sync branch and pull request
to `develop`, or to the single open release branch for a hotfix when applicable.
Because the PR is created by `GITHUB_TOKEN`, the coordinator explicitly
dispatches the validation workflow against the sync branch's exact head SHA,
waits for every required context to reach `success`, and then merges through the
pull-request API.

If that token-generated merge requires develop deployment or other follow-on
work, the coordinator explicitly dispatches it for the resulting merge SHA.
Dispatch failure, missing contexts, skipped or cancelled checks, ambiguous open
release branches, or SHA movement aborts the operation. Tag creation and Release
publication remain in the successful production workflow; no tag-push trigger is
part of the chain.

Alternative considered: give GitHub Actions a protected-branch bypass and push
the back-merge directly. Rejected because the fixed policy requires pull requests
for protected branches and reserves the Actions bypass for restricted tag
creation.

### Preflight private-runner availability before scheduling DAST

The generated policy will require Phase 0 to discover the exact runner group and
labels. A repository implementation must use a standard hosted preflight job to
verify that the assigned larger runner is visible to the repository before it
schedules the VNet-bound DAST job. API denial, no matching runner, or label
mismatch is a terminal failure. The aggregate qualification check treats a
skipped DAST job as not successful.

This avoids placing the only diagnostic step on a missing runner, which would
leave the job queued instead of failing loudly.

Alternative considered: fall back to a self-hosted runner. Rejected by the
settled security model and because it introduces persistent compute into the
Staging network.

### Scope the SLSA exception without weakening action pinning

The policy validator will require all of these properties:

- the exception names only the official SLSA L3 reusable workflow;
- the outer reference uses the tightest supported immutable or versioned form;
- the record has a reason and expiry;
- the pinning check rejects an expired or differently named exception;
- all other action references remain SHA-pinned.

The policy text will distinguish this action-reference exception from
vulnerability acceptance. Trivy remains the only blocking vulnerability
allowlist owner; Grype remains report-only. A repository may represent both
exception types in one typed governance registry, but it must not create a
second vulnerability allowlist or allow Grype to gate.

Alternative considered: downgrade release candidates to SLSA L2. Rejected
because the revised baseline explicitly prioritizes L3 and accepts the narrow
upstream limitation.

### Treat platform defaults as applicable defaults, not unconditional resources

The policy will state the fixed values but continue to require workload
classification. A database HA default applies only when the workload uses a
database; storage defaults apply only to required storage; canary and image
controls apply only where meaningful. The "provision nothing unused" rule wins
over a default that has no corresponding workload component.

Live-resource reconciliation remains a planning boundary: Phase 0 reports drift
and proposes refactor-plus-import before any apply. It never silently imports,
replaces, or duplicates resources.

### Update contract tests by behavior group

Tests will stop depending solely on one hash and a few broad phrases. The
canonical-byte hash remains useful for deterministic packaging, while focused
assertions will cover:

- VNet-injected larger runner wording and prohibition of self-hosted fallback;
- the sole org-level prerequisite;
- every settled platform default;
- cost, service-limit, and import-first rules;
- SLSA exception scope and expiry;
- candidate and production merge identities;
- token-safe back-merge behavior;
- retained frontmatter, approval boundary, and activation baseline.

Documentation tests and packaged-file checks will be updated with the new policy
version and bytes.

## Risks / Trade-offs

- **[Explicit workflow dispatch still creates a separate run]** -> The policy
  treats it as explicitly coordinated follow-on work, records its run URL, and
  never relies on implicit event recursion.
- **[Runner inventory APIs may be inaccessible to `GITHUB_TOKEN`]** -> A concrete
  repository must prove read access during Phase 0; inability to verify the
  assigned runner is a blocker, not a queued DAST job.
- **[True merge parent interpretation varies by merge mechanism]** -> Require a
  true two-parent merge and verify candidate ancestry and recorded PR head rather
  than trusting branch names alone.
- **[Active LTS changes over time]** -> Keep the policy normative and let the
  existing supported-stack refresh process update concrete pinned versions.
- **[Existing generated policy files will drift]** -> Preserve Liftoff's
  managed-core conflict behavior; users review replacements and no update
  activates live governance.

## Migration Plan

1. Integrate the revised normative text into the existing Liftoff policy
   envelope and increment the policy version.
2. Strengthen validation and focused policy tests, then update the deterministic
   hash and managed-core expectations.
3. Update public governance documentation and relevant snapshots.
4. Run focused governance and documentation tests, followed by the package
   checks required for a changed managed-core artifact.
5. Roll back by restoring the prior policy asset, version constant, validation
   fragments, tests, and documentation together; no live repository control is
   changed by this migration.
