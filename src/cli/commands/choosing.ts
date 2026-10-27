import type { ProjectChoices, Proposal } from "../../application/project/proposal.ts";
import { ENVIRONMENTS } from "../../plugins/contracts/project-plugin.ts";
import {
  FRONTENDS,
  GOVERNANCE,
  INFRASTRUCTURE,
  NO_FRONTEND,
  NO_INFRASTRUCTURE,
  PATTERNS,
  STACKS,
} from "../../plugins/registry.ts";
import type { OptionSpec, ParsedArgs } from "../command.ts";
import { listed } from "./changing.ts";

/**
 * The options that choose what an existing project is, for adopt and
 * migrate; anything not given is proposed from what the project holds.
 */
export const CHOICE_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  name: {
    type: "string",
    valueName: "name",
    description:
      "Project name: 2 to 50 lowercase letters, digits and single hyphens. Defaults to the old configuration's, or the directory's name.",
  },
  stack: {
    type: "string",
    valueName: "stack",
    choices: Object.keys(STACKS),
    description: "The backend's stack, when the project holds more than one kind.",
  },
  pattern: {
    type: "string",
    valueName: "pattern",
    choices: Object.keys(PATTERNS),
    description: "GenAI pattern, for a PydanticAI backend. Defaults to generic.",
  },
  frontend: {
    type: "string",
    valueName: "frontend",
    choices: [NO_FRONTEND, ...Object.keys(FRONTENDS)],
    description: "Web frontend, or none to leave one found as the project's own.",
  },
  infrastructure: {
    type: "string",
    valueName: "provider",
    choices: [NO_INFRASTRUCTURE, ...Object.keys(INFRASTRUCTURE)],
    description: "Infrastructure as code, or none to leave any found as the project's own.",
  },
  environments: {
    type: "string",
    valueName: "list",
    description: `Environments the infrastructure deploys to, comma-separated: ${ENVIRONMENTS.join(", ")}. Defaults to all three.`,
  },
  agents: {
    type: "string",
    valueName: "list",
    description:
      "Coding-agent hosts, comma-separated: copilot, codex, claude. Defaults to those the project is set up for.",
  },
  governance: {
    type: "string",
    valueName: "profile",
    choices: Object.keys(GOVERNANCE),
    description: "Governance profile. Defaults to single-maintainer-gitflow.",
  },
  "ai-review": {
    type: "string",
    valueName: "mode",
    choices: ["auto", "on", "off"],
    description: "Verified AI review in CI; auto turns it on when agents are selected.",
  },
  "review-engine": {
    type: "string",
    valueName: "host",
    description: "Which selected agent host runs the verified AI review.",
  },
  owners: {
    type: "string",
    valueName: "logins",
    description: "GitHub logins that own the project, comma-separated, for CODEOWNERS.",
  },
};

const list = (value: string | undefined) => (value === undefined ? undefined : [...listed(value)]);

/** The choices typed on the command line, other than --layout; anything else is proposed. */
export function choicesFrom(args: ParsedArgs): Omit<ProjectChoices, "layout"> {
  const option = (name: string) =>
    args.given.has(name) ? (args.options[name] as string | undefined) : undefined;
  const aiReview = option("ai-review") as ProjectChoices["aiReview"];
  const values: {
    [Key in keyof Omit<ProjectChoices, "layout">]-?: ProjectChoices[Key] | undefined;
  } = {
    name: option("name"),
    stack: option("stack"),
    pattern: option("pattern"),
    frontend: option("frontend"),
    infrastructure: option("infrastructure"),
    environments: list(option("environments")),
    agents: list(option("agents")),
    governance: option("governance"),
    aiReview,
    reviewEngine: option("review-engine"),
    owners: list(option("owners")),
  };
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Omit<ProjectChoices, "layout">;
}

/** Each proposed choice, one to a line, with where it came from. */
export function proposalLines(proposal: readonly Proposal[]): string[] {
  const width = Math.max(...proposal.map((proposed) => proposed.choice.length));
  return proposal.map(({ choice, value, from, evidence }) => {
    const why = from === "found" && evidence?.length ? `found: ${evidence.join(", ")}` : from;
    return `  ${choice.padEnd(width)}  ${value} (${why})`;
  });
}
