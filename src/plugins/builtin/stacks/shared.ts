import type { PolicyRule, ProfileId } from "../../../domain/risk-policy/policy.ts";
import type { ProjectTool } from "../../contracts/project-plugin.ts";

/** Parts every API stack shares. */

export const GIT_TOOL: ProjectTool = {
  name: "Git",
  command: "git",
  versionArgs: ["--version"],
  required: true,
  minimum: "2.40.0",
  purpose: "version control and the review policy",
  install: "https://git-scm.com/downloads",
};

export const DOCKER_TOOL: ProjectTool = {
  name: "Docker",
  command: "docker",
  versionArgs: ["--version"],
  required: false,
  purpose: "runs PostgreSQL and the API locally with docker compose",
  install: "https://docs.docker.com/get-started/get-docker/",
};

export const DOCUMENTATION_RULE: PolicyRule = {
  paths: ["docs/**", "*.md"],
  tier: "low",
  always_human: false,
  reason: "documentation",
};

/** The README's "How changes are made" section. */
export const changeProcess = (profile: ProfileId): string =>
  profile === "none"
    ? "See [REVIEW.md](REVIEW.md) for what reviewers look for."
    : "Pull requests target `develop`. See [GOVERNANCE.md](GOVERNANCE.md) for the\nbranch model and [REVIEW.md](REVIEW.md) for what reviewers look for.";
