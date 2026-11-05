#!/usr/bin/env bash
# Managed by Liftoff. Change it through Liftoff rather than by hand.
# Runs one read-only review pass with copilot: review-agent.sh PROMPT_FILE OUTPUT_FILE
# The agent only reads files in the working directory: it has no shell,
# cannot write files or use the network, and holds no token that can reach the
# pull request.
set -euo pipefail
prompt="$1"
output="$2"
mkdir -p "$(dirname "$output")"
copilot -p "$(cat "$prompt")" -s \
  --deny-tool 'shell' \
  --deny-tool 'write' \
  --deny-tool 'url' \
  --excluded-tools web_fetch web_search \
  --disable-builtin-mcps \
  --secret-env-vars COPILOT_GITHUB_TOKEN \
  ${LIFTOFF_REVIEW_MODEL:+--model "$LIFTOFF_REVIEW_MODEL"} \
  > "$output"
