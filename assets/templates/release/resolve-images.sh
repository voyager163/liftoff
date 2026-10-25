#!/usr/bin/env bash
# Managed by Liftoff. Change it through Liftoff rather than by hand.
#
# Finds each image built from a commit by digest, and checks with its build
# provenance that this repository's Build workflow built it from that
# commit. Prints "name reference digest" for each image.
# Usage: resolve-images.sh COMMIT NAME...
set -euo pipefail

candidate=${1:?usage: resolve-images.sh COMMIT NAME...}
shift
for name in "$@"; do
  reference="ghcr.io/${GITHUB_REPOSITORY,,}/${name}"
  digest=$(docker buildx imagetools inspect "${reference}:${candidate}" \
    --format '{{json .Manifest.Digest}}' | tr -d '"')
  gh attestation verify "oci://${reference}@${digest}" --repo "$GITHUB_REPOSITORY" \
    --signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/10-build.yml" \
    --source-digest "$candidate" >&2
  echo "${name} ${reference} ${digest}"
done
