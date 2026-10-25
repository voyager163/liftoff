import path from "node:path";
import { runDoctor } from "../../application/project/doctor.ts";
import { validateProject } from "../../application/project/validate-project.ts";
import type { CommandSpec } from "../command.ts";
import { defaultProjectPorts, type ProjectPorts } from "./project-ports.ts";

const DIR = {
  type: "string",
  valueName: "path",
  default: ".",
  description: "Project directory.",
} as const;

export function makeValidateCommand(
  portsFor: (cwd: string) => ProjectPorts = defaultProjectPorts,
): CommandSpec {
  return {
    path: ["validate"],
    summary: "Check a project's Liftoff configuration and managed files.",
    description:
      "Checks liftoff.yaml, the plugins it names and every file in .liftoff/manifest.json. Files Liftoff manages that are missing or were changed by hand are reported; files the project owns may change freely. Nothing is repaired or changed.",
    readOnly: true,
    reportSchema: "liftoff.validation/v1",
    options: { dir: DIR },
    examples: ["liftoff validate", "liftoff validate --dir demo --json"],
    async run(args, { io }) {
      const directory = path.resolve(io.cwd, args.options.dir as string);
      const result = await validateProject(portsFor(io.cwd).fs, directory);
      const problems = result.findings.filter((finding) => finding.severity !== "info");
      const lines = result.findings.map(
        (finding) =>
          `${finding.severity.padEnd(7)} ${finding.path ? `${finding.path}: ` : ""}${finding.message}`,
      );
      lines.unshift(
        problems.length === 0
          ? `${result.config?.name ?? directory} is valid.`
          : `${problems.length} problem${problems.length === 1 ? "" : "s"} in ${directory}:`,
      );
      return {
        outcome: problems.length === 0 ? "success" : "attention",
        report: { directory, valid: result.valid, findings: result.findings },
        text: `${lines.join("\n")}\n`,
      };
    },
  };
}

export function makeDoctorCommand(
  portsFor: (cwd: string) => ProjectPorts = defaultProjectPorts,
): CommandSpec {
  return {
    path: ["doctor"],
    summary: "Check the tools a project needs on this machine.",
    description:
      "Checks that the tools the project needs are installed and new enough, by running their version commands. Inside a Liftoff project it checks that project's stack; elsewhere, the tools every project needs. Nothing is installed or changed.",
    readOnly: true,
    reportSchema: "liftoff.doctor/v1",
    options: { dir: DIR },
    examples: ["liftoff doctor", "liftoff doctor --dir demo --json"],
    async run(args, { io }) {
      const directory = path.resolve(io.cwd, args.options.dir as string);
      const result = await runDoctor(portsFor(io.cwd), directory);
      const mark = {
        ok: "ok",
        missing: "missing",
        "too-old": "too old",
        "unknown-version": "unknown version",
      };
      const lines = [
        result.project
          ? `Tools for ${result.project.name} (${result.project.stack}):`
          : "Tools every project needs:",
        ...result.tools.map((tool) => {
          const detail = tool.version ? ` ${tool.version}` : "";
          const minimum = tool.minimum ? ` (needs ${tool.minimum}+)` : "";
          const fix = tool.status === "ok" ? "" : `\n          install: ${tool.install}`;
          return `  ${mark[tool.status].padEnd(8)} ${tool.name}${detail}${minimum}${tool.required ? "" : " [optional]"}: ${tool.purpose}${fix}`;
        }),
        "",
        result.ready ? "Ready." : "Not ready: install or update the required tools above.",
      ];
      return {
        outcome: result.ready ? "success" : "attention",
        report: { ...result },
        text: `${lines.join("\n")}\n`,
      };
    },
  };
}
