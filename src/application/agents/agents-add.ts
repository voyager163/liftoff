import path from "node:path";
import type { ChangePlan, FileChange } from "../../domain/plan/change-plan.ts";
import { sha256Hex } from "../../domain/plan/plan.ts";
import type { ProjectConfig } from "../../domain/project/config.ts";
import type { Manifest, ManifestFile } from "../../domain/project/manifest.ts";
import { pathKey } from "../../domain/project/paths.ts";
import type { ProjectFile } from "../../generators/project.ts";
import { AGENT_HOSTS } from "../../plugins/builtin/agents/hosts.ts";
import type { AgentHostId } from "../../plugins/contracts/agent-host.ts";
import { WORKFLOWS } from "../../plugins/registry.ts";
import { MAX_CHANGED_BYTES, type NewContent } from "../change/apply-changes.ts";
import {
  planTransition,
  type TransitionFile,
  TransitionOptionError,
} from "../change/config-transition.ts";
import {
  ProjectChangeError,
  type ProjectRecords,
  readProject,
  sealProjectChange,
} from "../change/project-change.ts";
import {
  type ApplyOptions,
  frameworkFiles,
  type PlannedInitializer,
  runInitializer,
} from "../init/init-project.ts";
import type { AssetPort, InitializerPort, ProjectFsPort } from "../ports.ts";
import {
  clearForDirectory,
  emptyDirectories,
  FrameworkCollisionError,
} from "../workflow/workflow-set.ts";

export interface AgentsPlan {
  readonly directory: string;
  /** The coding agents the project has, in order. */
  readonly from: readonly string[];
  /** The coding agents it has once they are added: those it had, in order, then the new ones. */
  readonly to: readonly string[];
  /** The agents added, in the order asked for. */
  readonly added: readonly string[];
  /** Each of Liftoff's files adding them writes, or would, sorted by path. */
  readonly files: readonly TransitionFile[];
  /** The workflow framework's own command that sets the new agents up, run only once approved. */
  readonly initializer?: PlannedInitializer;
  /** The change, once nothing more is needed to make it: undefined while the framework's command is still to run, or when nothing changes. */
  readonly plan?: ChangePlan;
  readonly contents: ReadonlyMap<string, NewContent>;
  /** What the change is made of before the framework's files are added. */
  readonly pending?: Pending;
}

interface Pending {
  readonly project: ProjectRecords;
  readonly config: ProjectConfig;
  readonly generated: readonly ProjectFile[];
  readonly changes: readonly FileChange[];
  readonly contents: ReadonlyMap<string, NewContent>;
  readonly manifest: Omit<Manifest, "history">;
}

/**
 * Plans adding coding agents to a Liftoff project (AGENT-001). It only
 * reads, and runs nothing: in an OpenSpec or Spec Kit project, the
 * framework's own command sets the new agents up, in completeAgentsAdd,
 * once the person approves (AGENT-002).
 *
 * Adding is additive: the agents the project has stay, in order, so the
 * first, which Spec Kit takes as its default, stays first, and the new ones
 * follow. Liftoff's files for them are added where nothing is, and those it
 * writes differently with them, such as the AI review workflow, change only
 * while as Liftoff last wrote it; nothing is removed, and nothing Liftoff
 * did not write, such as another tool's integration, is touched.
 */
export async function planAgentsAdd(
  ports: { readonly assets: AssetPort; readonly fs: ProjectFsPort },
  directory: string,
  liftoffVersion: string,
  agents: readonly string[],
): Promise<AgentsPlan> {
  const unknown = agents.filter((agent) => !Object.hasOwn(AGENT_HOSTS, agent));
  if (agents.length === 0 || unknown.length > 0) {
    throw new TransitionOptionError(
      `${unknown.length > 0 ? `unknown agent "${unknown[0]}"` : "no agent named"}; available: ${Object.keys(AGENT_HOSTS).join(", ")}`,
    );
  }
  const asked = [...new Set(agents)];
  const transition = await planTransition(ports, directory, liftoffVersion, "agents-add", {
    name: "coding agents",
    field: "agents",
    // Those the project has stay, in order, and those it lacks follow.
    to: (config) => [...config.agents, ...asked.filter((agent) => !config.agents.includes(agent))],
  });
  if (transition === undefined) {
    const { agents: present } = (await readProject(ports.fs, directory, "agents-add")).config;
    return { directory, from: present, to: present, added: [], files: [], contents: new Map() };
  }
  const { project, changes, contents, manifest, generated } = transition;
  const from = project.config.agents;
  const added = asked.filter((agent) => !from.includes(agent));
  // The one removal adding allows is a copy of Liftoff's skills that moves:
  // each skill is written once, in a directory every agent reads, so a
  // Copilot-only project's .github/skills moves to the new agent's, which
  // Copilot reads too. Should anything else ever go, nothing changes.
  const making = new Set(generated.files.map((file) => pathKey(file.path)));
  const lost = changes
    .filter((change) => change.after === null && !moves(change.path, from, making))
    .map((change) => change.path);
  if (lost.length > 0) {
    throw new ProjectChangeError(
      `adding ${added.join(", ")} would remove ${lost.join(", ")}, and adding an agent removes nothing; nothing was changed`,
    );
  }
  const pending: Pending = {
    project,
    config: transition.config,
    generated: generated.files,
    changes,
    contents,
    manifest,
  };
  const planned = { directory, from, to: transition.config.agents, added, files: transition.files };
  const framework = generated.selection.workflow.initializer;
  if (framework !== undefined) {
    const initializer: PlannedInitializer = {
      name: framework.name,
      version: framework.version,
      steps: framework
        .addHosts(from as AgentHostId[], added as AgentHostId[])
        .map((step) => ({ command: step.command, args: [...step.args] })),
    };
    return { ...planned, initializer, contents: new Map(), pending };
  }
  const sealed = sealProjectChange(
    project,
    "agents-add",
    liftoffVersion,
    changes,
    contents,
    manifest,
  );
  return { ...planned, plan: sealed.plan, contents: sealed.contents, pending };
}

/**
 * Whether a file is one of Liftoff's skills in a directory the project's
 * agents read, and the new configuration writes the same skill in another
 * directory that every agent reading the first reads too.
 */
function moves(file: string, agents: readonly string[], making: ReadonlySet<string>): boolean {
  const hosts = agents.map((agent) => AGENT_HOSTS[agent as AgentHostId]);
  for (const host of hosts) {
    for (const directory of host.skillDirectories) {
      if (!file.startsWith(`${directory}/`)) continue;
      const skill = file.slice(directory.length);
      const readers = hosts.filter((other) => other.skillDirectories.includes(directory));
      const elsewhere = readers[0]?.skillDirectories.filter(
        (other) =>
          other !== directory &&
          making.has(pathKey(`${other}${skill}`)) &&
          readers.every((reader) => reader.skillDirectories.includes(other)),
      );
      if (elsewhere !== undefined && elsewhere.length > 0) return true;
    }
  }
  return false;
}

/**
 * Runs the workflow framework's own command that sets up the new agents,
 * once adding them is approved (AGENT-002): on a copy of the framework's
 * files, in an empty directory beside the project, as init runs its
 * initializer, with telemetry off and a temporary home and configuration
 * directories. What it writes is checked as init checks it. A file it adds
 * becomes the framework's, added only where the project has nothing, and
 * one it rewrites, such as Spec Kit's list of its integrations, changes only
 * while as the framework wrote it; a file of the framework's the project no
 * longer has is not added back. Anything else in its way, and any file it
 * removes, refuses the change. The directory is removed whatever happens.
 */
export async function completeAgentsAdd(
  ports: { readonly fs: ProjectFsPort; readonly initializer: InitializerPort },
  agents: AgentsPlan,
  liftoffVersion: string,
  options: ApplyOptions = {},
): Promise<{
  readonly plan: ChangePlan;
  readonly contents: ReadonlyMap<string, NewContent>;
  /** Empty directories the framework made, to make once the change applies. */
  readonly directories: readonly string[];
  /** The framework's files the project no longer has, which its command wrote again and are not added back. */
  readonly skipped: readonly string[];
}> {
  const { fs } = ports;
  const { pending, initializer } = agents;
  const workflow = pending === undefined ? undefined : WORKFLOWS[pending.config.workflow];
  const framework = workflow?.initializer;
  if (pending === undefined || initializer === undefined || framework === undefined) {
    throw new Error("only adding agents to a framework's project has a command to run");
  }
  const who = framework.name;
  options.signal?.throwIfAborted();
  const staging = await fs.createStaging(agents.directory, "private");
  try {
    // The framework's files as the project has them, each as it is now.
    const recorded = pending.project.manifest.files.filter(
      (entry) => entry.ownership === "framework" && entry.plugin === workflow?.id,
    );
    const copied = new Map<string, { entry: ManifestFile; sha256: string }>();
    const missing = new Set<string>();
    for (const entry of recorded) {
      options.signal?.throwIfAborted();
      const there = await fs.copyWithin(
        agents.directory,
        entry.path,
        MAX_CHANGED_BYTES,
        path.join(staging, ...entry.path.split("/")),
      );
      if (there.kind === "missing") missing.add(pathKey(entry.path));
      else if (there.kind !== "file" || there.sha256 === undefined) {
        throw new ProjectChangeError(
          `${entry.path}, one of ${who}'s files, could not be read whole, so nothing was changed`,
        );
      } else copied.set(pathKey(entry.path), { entry, sha256: there.sha256 });
    }
    await runInitializer(ports.initializer, framework, initializer, staging, options);
    const written = await frameworkFiles(ports, staging, pending.generated, framework);
    const collisions: string[] = [];
    const directories: string[] = [];
    for (const directory of emptyDirectories(await fs.listTree(staging))) {
      const there = await fs.entry(path.join(agents.directory, ...directory.split("/")));
      if (there.kind === "directory") continue;
      if (await clearForDirectory(fs, agents.directory, directory)) directories.push(directory);
      else collisions.push(directory);
    }
    const changes = [...pending.changes];
    const contents = new Map(pending.contents);
    const files = new Map(pending.manifest.files.map((entry) => [pathKey(entry.path), entry]));
    const refused: string[] = [];
    const unreadable: string[] = [];
    const skipped: string[] = [];
    const seen = new Set<string>();
    for (const file of written) {
      options.signal?.throwIfAborted();
      const key = pathKey(file.path);
      seen.add(key);
      const before = copied.get(key);
      if (before !== undefined && before.sha256 === file.sha256) continue;
      if (before === undefined && missing.has(key)) {
        skipped.push(file.path);
        continue;
      }
      let previous: string | null = null;
      if (before !== undefined) {
        // Changed only while the framework's file is as it wrote it.
        if (before.sha256 !== before.entry.sha256) {
          refused.push(file.path);
          continue;
        }
        previous = before.sha256;
      } else {
        const there = await fs.hashWithin(agents.directory, file.path, MAX_CHANGED_BYTES);
        if (there.kind !== "missing") {
          collisions.push(file.path);
          continue;
        }
      }
      // Carried as the framework wrote it: its exact text, and whether it
      // runs. A change holds text, so a file that is not UTF-8 is refused
      // rather than written back other than it was.
      const bytes = await fs.hashWithin(staging, file.path, MAX_CHANGED_BYTES);
      const content = (await fs.readText(path.join(staging, ...file.path.split("/")))) ?? "";
      if (bytes.kind !== "file" || bytes.sha256 !== sha256Hex(content)) {
        unreadable.push(file.path);
        continue;
      }
      const executable = bytes.executable === true;
      changes.push({
        path: file.path,
        before: previous,
        after: file.sha256,
        ownership: "framework",
        executable,
      });
      contents.set(file.path, { content, executable });
      files.set(key, {
        path: file.path,
        ownership: "framework",
        sha256: file.sha256,
        plugin: workflow?.id ?? "",
      });
    }
    const gone = [...copied.values()]
      .filter(({ entry }) => !seen.has(pathKey(entry.path)))
      .map(({ entry }) => entry.path)
      .sort();
    if (gone.length > 0) {
      throw new ProjectChangeError(
        `${who}'s command removed ${gone.join(", ")}, and adding an agent removes nothing, so nothing was changed`,
      );
    }
    if (collisions.length > 0) throw new FrameworkCollisionError(who, collisions.sort());
    if (refused.length > 0) {
      throw new ProjectChangeError(
        `${who}'s command rewrites ${refused.sort().join(", ")}, which changed since ${who} wrote ${refused.length === 1 ? "it" : "them"}, so nothing was changed; put ${refused.length === 1 ? "it" : "them"} back as ${who} wrote ${refused.length === 1 ? "it" : "them"} to add the agent`,
      );
    }
    if (unreadable.length > 0) {
      throw new ProjectChangeError(
        `${who}'s command wrote ${unreadable.sort().join(", ")}, which ${unreadable.length === 1 ? "is" : "are"} not UTF-8 text Liftoff can add as it was written, so nothing was changed`,
      );
    }
    const sealed = sealProjectChange(
      pending.project,
      "agents-add",
      liftoffVersion,
      changes,
      contents,
      { ...pending.manifest, files: [...files.values()] },
    );
    return { ...sealed, directories, skipped: skipped.sort() };
  } finally {
    await fs.remove(staging);
  }
}
