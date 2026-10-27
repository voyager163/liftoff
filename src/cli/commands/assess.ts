import os from "node:os";
import { GitHubApiError } from "../../adapters/gh.ts";
import { assessGovernance, GovernanceError } from "../../application/governance/assess.ts";
import {
  AssessError,
  assessProject,
  type ProjectAssessment,
} from "../../application/project/assess-project.ts";
import type { GitHubState } from "../../domain/assess/standard.ts";
import { GovernanceStateError } from "../../domain/governance/state.ts";
import type { CommandSpec } from "../command.ts";
import { UsageError } from "../outcome.ts";
import {
  defaultGovernancePorts,
  type GovernancePorts,
  repositoryWithConsent,
} from "./governance.ts";
import { projectDirectory } from "./project-ports.ts";

/** How many gaps the text lists; the JSON report has every one. */
const SHOWN_GAPS = 20;

/** Escapes characters that would change how a terminal shows the rest of a line. */
const shown = (text: string) =>
  text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it escapes.
    /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

const LIFTOFF = {
  none: "not a Liftoff project",
  project: "a Liftoff project",
  "pre-rebuild": "made by a Liftoff release before the rebuild",
} as const;

export function renderProjectAssessment(assessment: ProjectAssessment, version: string): string {
  const lines = [
    `Assessment of ${assessment.directory} against Liftoff ${version}'s standard`,
    `${assessment.git ? "A Git repository" : "Not the root of a Git repository"}; ${LIFTOFF[assessment.liftoff]}.`,
    `Parts: ${
      assessment.parts.length === 0
        ? "none found"
        : assessment.parts
            .map(
              (part) =>
                `${part.component} ${part.stack} at ${part.path}${part.supported ? "" : " (unsupported)"}`,
            )
            .join("; ")
    }.`,
    `Workflow: ${assessment.workflows.join(", ")}. Agents: ${assessment.agents.join(", ") || "none"}.`,
  ];
  let area = "";
  for (const finding of assessment.findings) {
    if (finding.area !== area) {
      area = finding.area;
      lines.push("", area);
    }
    lines.push(
      `  ${finding.status.padEnd(12)} ${finding.check}${finding.subject ? ` (${finding.subject})` : ""}: ${finding.message}`,
    );
  }
  if (assessment.gaps.length > 0) {
    lines.push("", `Not walked or read (${assessment.gaps.length}):`);
    for (const gap of assessment.gaps.slice(0, SHOWN_GAPS)) {
      lines.push(`  ${gap.kind.padEnd(12)} ${gap.path ? `${gap.path}: ` : ""}${gap.detail}`);
    }
    if (assessment.gaps.length > SHOWN_GAPS) {
      lines.push(`  … and ${assessment.gaps.length - SHOWN_GAPS} more in the --json report`);
    }
  }
  if (assessment.next.length > 0) {
    lines.push("", "Next:");
    for (const action of assessment.next) {
      lines.push(
        `  ${action.category.padEnd(12)} ${action.command ? `${action.command}: ` : ""}${action.text} [${action.checks.join(", ")}]`,
      );
    }
  }
  const { summary } = assessment;
  lines.push(
    "",
    `${summary.compliant} compliant, ${summary.noncompliant} noncompliant, ${summary.unknown} unknown, ${summary.unsupported} unsupported, ${summary.inaccessible} inaccessible.`,
  );
  // Paths, stacks and messages come from the project, so every line is escaped.
  return `${lines.map(shown).join("\n")}\n`;
}

export function makeAssessCommand(
  portsFor: (cwd: string) => GovernancePorts = defaultGovernancePorts,
  home: string = os.homedir(),
): CommandSpec {
  return {
    path: ["assess"],
    summary: "Assess a whole project against this release's standard, read-only.",
    description:
      "Walks the project, within limits and without following links, and checks its applications, dependencies, tests, builds, database, coding-agent setup, CI, governance, infrastructure and documentation against what this Liftoff release generates. It reads only the declarations it interprets, such as pyproject.toml, package.json and workflow files, never secrets or state, runs nothing and writes nothing. Each finding is compliant, noncompliant, unknown, unsupported or inaccessible, with the paths it rests on, and what was not walked or read is listed. With --live it also reads the repository's governance on GitHub, after you agree.",
    readOnly: true,
    reportSchema: "liftoff.assessment/v1",
    options: {
      dir: {
        type: "string",
        valueName: "path",
        default: ".",
        description:
          "Directory to assess: the root of a Git repository, or any other directory when named.",
      },
      live: {
        type: "boolean",
        description: "Also read the repository's branches, rulesets and check runs on GitHub.",
      },
      repo: {
        type: "string",
        valueName: "owner/name",
        description: "With --live, the GitHub repository. Defaults to the one origin points at.",
      },
      "use-gh": {
        type: "boolean",
        description:
          "With --live, let Liftoff use your GitHub CLI login without asking. Liftoff never sees or stores your credentials.",
      },
    },
    examples: [
      "liftoff assess",
      "liftoff assess --dir ../service --json",
      "liftoff assess --live --use-gh",
    ],
    async run(args, { io, version }) {
      const directory = await projectDirectory(io.cwd, args.options.dir as string);
      const live = args.options.live === true;
      if (!live && (args.given.has("repo") || args.given.has("use-gh"))) {
        throw new UsageError("--repo and --use-gh go with --live");
      }
      const ports = portsFor(io.cwd);
      // Asked before the walk, so the person is not kept waiting for the question.
      const repository = live
        ? await repositoryWithConsent(args, io, ports.github, directory)
        : undefined;
      let assessment: ProjectAssessment;
      try {
        assessment = await assessProject(ports.fs, directory, {
          named: args.given.has("dir"),
          refused: [await projectDirectory(io.cwd, home)],
          ...(repository === undefined
            ? {}
            : { live: () => readGitHub(ports, directory, repository) }),
        });
      } catch (error) {
        if (error instanceof AssessError) throw new UsageError(error.message);
        throw error;
      }
      const { summary } = assessment;
      return {
        outcome: summary.compliant === assessment.findings.length ? "success" : "attention",
        report: { ...assessment, standard: version },
        text: renderProjectAssessment(assessment, version),
      };
    },
  };
}

/** The repository's governance on GitHub, or why it could not be read. */
async function readGitHub(
  ports: GovernancePorts,
  directory: string,
  repository: string,
): Promise<GitHubState> {
  try {
    const { checkpoints } = await assessGovernance(ports, directory, repository);
    return { kind: "read", repository, checkpoints };
  } catch (error) {
    // The committed governance files or the recorded state could not be used.
    if (error instanceof GovernanceError || error instanceof GovernanceStateError) {
      return { kind: "failed", repository, status: "unknown", reason: error.message };
    }
    // A request GitHub answered with an error, or that did not reach it.
    const status = (error as { status?: unknown } | undefined)?.status;
    if (error instanceof GitHubApiError || typeof status === "number") {
      const denied = status === 401 || status === 403 || status === 404;
      return {
        kind: "failed",
        repository,
        status: denied ? "inaccessible" : "unknown",
        reason: (error as Error).message,
      };
    }
    throw error;
  }
}
