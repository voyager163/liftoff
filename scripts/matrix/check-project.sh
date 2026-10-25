#!/usr/bin/env bash
# Runs a generated project's own checks, as its CI does, for the components
# it has: the backend (Python, Node.js or Go), the frontend, and the OpenTofu
# infrastructure. It fails when it finds no backend it knows, and, with
# REQUIRE_TOFU=1, when the project has infrastructure but tofu is missing.
# Usage: scripts/matrix/check-project.sh <project directory>
set -euo pipefail

project=${1:?usage: check-project.sh <project directory>}
if [ ! -d "$project" ]; then
  echo "check-project.sh: $project is not a directory" >&2
  exit 1
fi
backend=$project/backend

if [ -f "$backend/pyproject.toml" ]; then
  echo "::group::Python backend"
  (cd "$backend" && uv sync --locked && uv run ruff check . && uv run ruff format --check . && uv run pytest)
  echo "::endgroup::"
elif [ -f "$backend/package.json" ]; then
  echo "::group::Node.js backend"
  (
    cd "$backend"
    test "$(node --version)" = "v$(cat .node-version)"
    npm ci --no-audit --no-fund
    npm run lint
    npm run typecheck
    npm test
  )
  echo "::endgroup::"
elif [ -f "$backend/go.mod" ]; then
  echo "::group::Go backend"
  (
    cd "$backend"
    unformatted=$(gofmt -l .)
    if [ -n "$unformatted" ]; then echo "Not gofmt-formatted:"; echo "$unformatted"; exit 1; fi
    go vet ./...
    go vet -tags integration ./...
    go test -coverpkg=./cmd/...,./internal/... -coverprofile=cover.out ./...
    go run ./tools/coverage cover.out 80
  )
  echo "::endgroup::"
else
  echo "check-project.sh: $project has no Python, Node.js or Go backend to check" >&2
  exit 1
fi

if [ -d "$project/frontend" ]; then
  echo "::group::Frontend"
  (
    cd "$project/frontend"
    test "$(node --version)" = "v$(cat .node-version)"
    npm ci --no-audit --no-fund
    npm run lint
    npm run typecheck
    npm test
    npm run build
  )
  echo "::endgroup::"
fi

infrastructure=$project/infrastructure/opentofu/azure
if [ -d "$infrastructure" ] && ! command -v tofu > /dev/null; then
  if [ "${REQUIRE_TOFU:-}" = 1 ]; then
    echo "check-project.sh: the project has infrastructure, but tofu is not installed" >&2
    exit 1
  fi
  echo "::notice::OpenTofu is not installed here, so the infrastructure was not checked"
elif [ -d "$infrastructure" ]; then
  echo "::group::Infrastructure"
  (
    cd "$infrastructure"
    tofu fmt -check -recursive
    for root in bootstrap environments/*; do
      tofu -chdir="$root" init -backend=false -input=false -lockfile=readonly
      tofu -chdir="$root" validate
    done
  )
  echo "::endgroup::"
fi
