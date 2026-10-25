import type { AgentHostId } from "../contracts/agent-host.ts";
import type { WorkflowPlugin } from "../contracts/project-plugin.ts";

/**
 * Manual development: no specification framework. It writes nothing, so a
 * project never gets framework files, markers or archive steps it did not ask for.
 */
export const manualWorkflow: WorkflowPlugin = {
  id: "workflow/manual",
  kind: "workflow",
  version: "1",
  title: "Manual",
  summary: "No specification framework",
  templateRoots: [],
  tools: [],
  guide: [],
  artifacts: () => [],
};

const OPENSPEC_VERSION = "1.14.3";
const OPENSPEC_PACKAGE = `@fission-ai/openspec@${OPENSPEC_VERSION}`;
/** OpenSpec's name for each coding-agent host. */
const OPENSPEC_TOOLS: Record<AgentHostId, string> = {
  claude: "claude",
  codex: "codex",
  copilot: "github-copilot",
};

/**
 * OpenSpec, the default: changes are proposed as specification deltas, built,
 * then archived into the living specifications. Its files come from
 * OpenSpec's own initializer at the pinned version, with skills and commands
 * for each selected host.
 */
export const openspecWorkflow: WorkflowPlugin = {
  id: "workflow/openspec",
  kind: "workflow",
  version: "1",
  title: "OpenSpec",
  summary: `OpenSpec ${OPENSPEC_VERSION}, set up by its own initializer`,
  templateRoots: [],
  tools: [
    {
      name: "OpenSpec",
      command: "openspec",
      versionArgs: ["--version"],
      required: true,
      minimum: OPENSPEC_VERSION,
      purpose: "the OpenSpec CLI its skills and commands run",
      install: `npm install --global ${OPENSPEC_PACKAGE}`,
    },
  ],
  guide: [
    `Changes are specified with [OpenSpec](https://github.com/Fission-AI/OpenSpec) ${OPENSPEC_VERSION} before they are built. \`openspec/specs/\` holds the specifications and \`openspec/changes/\` the changes in progress. OpenSpec's own initializer wrote these files and its skills and commands for each coding agent; they belong to OpenSpec, and Liftoff never changes them.`,
    "Propose a change with the `openspec-propose` skill (`/opsx:propose` in Claude Code), build it with `openspec-apply-change`, and once it is merged archive it into the specifications with `openspec-archive-change`. Without a coding agent, use the `openspec` CLI directly, starting with `openspec new change <name>`.",
    `Install the CLI with \`npm install --global ${OPENSPEC_PACKAGE}\`.`,
  ],
  initializer: {
    name: "OpenSpec",
    version: OPENSPEC_VERSION,
    needs: "Node.js with npm",
    steps: (hosts) => [
      {
        command: "npx",
        args: [
          "--yes",
          OPENSPEC_PACKAGE,
          "init",
          "--tools",
          hosts.length === 0 ? "none" : hosts.map((host) => OPENSPEC_TOOLS[host]).join(","),
          "--no-animation",
          "--no-copilot-cloud",
          ".",
        ],
      },
    ],
  },
  artifacts: () => [],
};

const SPEC_KIT_VERSION = "1.2.1";
/** The commit tagged v1.2.1, so a moved tag cannot change what runs. */
const SPEC_KIT_SOURCE =
  "git+https://github.com/github/spec-kit.git@9dca9bf42a031765ee5e5f2371137f2f26967e11";

/**
 * Spec Kit: a constitution, then for each feature a specification, a plan,
 * tasks and their implementation. Its files come from Spec Kit's own
 * initializer at the pinned commit, with Python scripts so they run the same
 * on macOS and Windows.
 */
export const specKitWorkflow: WorkflowPlugin = {
  id: "workflow/spec-kit",
  kind: "workflow",
  version: "1",
  title: "Spec Kit",
  summary: `Spec Kit ${SPEC_KIT_VERSION}, set up by its own initializer`,
  templateRoots: [],
  tools: [
    {
      name: "Python",
      command: "python3",
      alternatives: ["python"],
      versionArgs: ["--version"],
      required: true,
      minimum: "3.11.0",
      purpose: "Spec Kit's scripts",
      install: "https://www.python.org/downloads/",
    },
  ],
  guide: [
    `Changes are specified with [Spec Kit](https://github.com/github/spec-kit) ${SPEC_KIT_VERSION} before they are built. \`.specify/\` holds its templates, scripts and the project's constitution, and \`specs/\` one directory per feature. Spec Kit's own initializer wrote these files and its skills for each coding agent; they belong to Spec Kit, and Liftoff never changes them.`,
    "Set the project's principles once with the `speckit-constitution` skill. Then, for each feature, run `speckit-specify`, `speckit-plan`, `speckit-tasks` and `speckit-implement`. Its scripts need Python 3.11 or later.",
  ],
  initializer: {
    name: "Spec Kit",
    version: SPEC_KIT_VERSION,
    needs: "uv and Git",
    steps(hosts) {
      const specify = ["--from", SPEC_KIT_SOURCE, "specify"];
      // Spec Kit installs integrations side by side only when it declares
      // each one safe to combine; Copilot is not, so that is asked for
      // explicitly. In a new directory there is nothing else to overwrite.
      const force = hosts.includes("copilot") ? ["--force"] : [];
      // The first host is set up with the project and becomes the default.
      return hosts.map((host, index) => ({
        command: "uvx",
        args:
          index === 0
            ? [
                ...specify,
                "init",
                "--here",
                "--non-interactive",
                "--ignore-agent-tools",
                "--script",
                "py",
                "--integration",
                host,
              ]
            : [...specify, "integration", "install", host, ...force],
      }));
    },
  },
  unsupportedHosts: (hosts) =>
    hosts.length === 0
      ? "Spec Kit needs at least one coding agent; add --agents, or use --workflow openspec or manual"
      : undefined,
  artifacts: () => [],
};
