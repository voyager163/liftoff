# The release manifest

The release manifest records exactly what a release of a generated GitFlow
project is. The After release workflow writes it once a release or hotfix
merges into `main`, attests it for each of the release's images, and
includes it in the GitHub release. The production workflow deploys a release
only when each image's attestation carries exactly the manifest the release
shows.

Its attestation predicate type is the address of this page:

```text
https://github.com/voyager163/liftoff/blob/develop/docs/projects/release-manifest.md
```

## Format

```json
{
  "schema": "liftoff.release-manifest/v1",
  "repository": "OWNER/REPO",
  "version": "1.2.0",
  "kind": "release",
  "pullRequest": 21,
  "source": {
    "commit": "the merge commit on main",
    "tree": "its tree, which is also the candidate's",
    "candidate": "the develop commit CI qualified"
  },
  "images": [
    { "name": "api", "reference": "ghcr.io/owner/repo/api", "digest": "sha256:…" }
  ]
}
```

Every field is required, and no other is allowed:

- `version` is X.Y.Z without leading zeros, and `kind` is `release` or
  `hotfix`.
- `commit`, `tree` and `candidate` are full 40-character SHAs.
- Each image appears once, with a lowercase name, its `ghcr.io` reference
  and a `sha256:` digest.

## Verifying an image's manifest

The manifest is attested by the After release workflow, on `main`, from the
release's commit:

```bash
gh attestation verify oci://ghcr.io/OWNER/REPO/api@sha256:DIGEST \
  --repo OWNER/REPO \
  --predicate-type https://github.com/voyager163/liftoff/blob/develop/docs/projects/release-manifest.md \
  --signer-workflow OWNER/REPO/.github/workflows/30-after-release.yml \
  --source-ref refs/heads/main --source-digest COMMIT
```

See [the release flow](release-flow.md) for how releases are cut, published
and deployed.
