import type { AgentHostId } from "../../contracts/agent-host.ts";

/**
 * How each coding-agent host runs one read-only review pass in CI. The
 * workflow is the same for every host; only review-agent.sh, the CLI it
 * installs and the secret it needs differ.
 */
export interface ReviewEngine {
  readonly host: AgentHostId;
  /** npm package spec of the CLI, pinned to a release at least a week old. */
  readonly cli: string;
  /** Repository secret holding the credential, chosen by the user. */
  readonly secret: string;
  readonly secretHelp: string;
  /** Bash that reads the prompt from "$prompt" and writes the answer to "$output". */
  readonly run: string;
}

/** Passes --model only when the LIFTOFF_REVIEW_MODEL repository variable is set. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: Bash parameter expansion, not a template literal.
const MODEL_ARGUMENT = '  ${LIFTOFF_REVIEW_MODEL:+--model "$LIFTOFF_REVIEW_MODEL"} \\';

const COPILOT_DENIED = [
  "write",
  "shell(git push)",
  "shell(git commit)",
  "shell(git checkout)",
  "shell(git reset)",
  "shell(gh:*)",
  "shell(curl:*)",
  "shell(wget:*)",
  "shell(npm:*)",
  "shell(npx:*)",
  "url",
];

const CLAUDE_ALLOWED = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git blame:*)",
];
const CLAUDE_DENIED = ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"];

export const REVIEW_ENGINES: Readonly<Record<AgentHostId, ReviewEngine>> = {
  copilot: {
    host: "copilot",
    cli: "@github/copilot@1.0.98",
    secret: "COPILOT_GITHUB_TOKEN",
    secretHelp: 'a user-owned fine-grained token with the "Copilot Requests" permission',
    run: [
      'copilot -p "$(cat "$prompt")" -s \\',
      "  --allow-all-tools \\",
      ...COPILOT_DENIED.map((tool) => `  --deny-tool '${tool}' \\`),
      "  --excluded-tools web_fetch web_search \\",
      "  --disable-builtin-mcps \\",
      "  --secret-env-vars COPILOT_GITHUB_TOKEN \\",
      MODEL_ARGUMENT,
      '  > "$output"',
    ].join("\n"),
  },
  claude: {
    host: "claude",
    cli: "@anthropic-ai/claude-code@2.1.302",
    secret: "ANTHROPIC_API_KEY",
    secretHelp: "an Anthropic API key",
    run: [
      'claude -p "$(cat "$prompt")" \\',
      "  --bare --strict-mcp-config \\",
      "  --permission-mode dontAsk \\",
      `  --allowedTools ${CLAUDE_ALLOWED.map((tool) => `'${tool}'`).join(" ")} \\`,
      `  --disallowedTools ${CLAUDE_DENIED.map((tool) => `'${tool}'`).join(" ")} \\`,
      "  --output-format text \\",
      MODEL_ARGUMENT,
      '  > "$output"',
    ].join("\n"),
  },
  codex: {
    host: "codex",
    cli: "@openai/codex@0.163.0",
    secret: "OPENAI_API_KEY",
    secretHelp: "an OpenAI API key",
    run: [
      "printenv OPENAI_API_KEY | codex login --with-api-key > /dev/null",
      "codex exec \\",
      "  --sandbox read-only --ephemeral \\",
      MODEL_ARGUMENT,
      '  --output-last-message "$output" \\',
      '  "$(cat "$prompt")" > /dev/null',
    ].join("\n"),
  },
};

/** The selected host that runs the verified review: the configured one, else the first by preference. */
export function chooseEngine(
  hosts: readonly AgentHostId[],
  configured?: string,
): ReviewEngine | undefined {
  if (configured !== undefined) {
    const host = hosts.find((candidate) => candidate === configured);
    return host === undefined ? undefined : REVIEW_ENGINES[host];
  }
  const preferred = (["copilot", "claude", "codex"] as const).find((host) => hosts.includes(host));
  return preferred === undefined ? undefined : REVIEW_ENGINES[preferred];
}

/** The script CI calls for each finder and verifier pass. */
export function reviewAgentScript(engine: ReviewEngine): string {
  return [
    "#!/usr/bin/env bash",
    "# Managed by Liftoff. Change it through Liftoff rather than by hand.",
    `# Runs one read-only review pass with ${engine.host}: review-agent.sh PROMPT_FILE OUTPUT_FILE`,
    "# The agent may read the repository and run read-only git commands; it",
    "# cannot write files, use the network or reach the pull request.",
    "set -euo pipefail",
    'prompt="$1"',
    'output="$2"',
    'mkdir -p "$(dirname "$output")"',
    engine.run,
    "",
  ].join("\n");
}
