#!/usr/bin/env bash
# Managed by Liftoff. Change it through Liftoff rather than by hand.
# Runs one read-only review pass with copilot: review-agent.sh PROMPT_FILE OUTPUT_FILE
# The agent may read the repository and run read-only git commands; it
# cannot write files, use the network or reach the pull request.
set -euo pipefail
prompt="$1"
output="$2"
mkdir -p "$(dirname "$output")"
copilot -p "$(cat "$prompt")" -s \
  --allow-all-tools \
  --deny-tool 'write' \
  --deny-tool 'shell(git push)' \
  --deny-tool 'shell(git commit)' \
  --deny-tool 'shell(git checkout)' \
  --deny-tool 'shell(git reset)' \
  --deny-tool 'shell(gh:*)' \
  --deny-tool 'shell(curl:*)' \
  --deny-tool 'shell(wget:*)' \
  --deny-tool 'shell(npm:*)' \
  --deny-tool 'shell(npx:*)' \
  --deny-tool 'url' \
  --excluded-tools web_fetch web_search \
  --disable-builtin-mcps \
  --secret-env-vars COPILOT_GITHUB_TOKEN \
  ${LIFTOFF_REVIEW_MODEL:+--model "$LIFTOFF_REVIEW_MODEL"} \
  > "$output"
