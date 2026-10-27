import { parse } from "yaml";

/**
 * What an assessment reads out of the declarations it opens. Each reader
 * takes text and never runs, imports or resolves anything: a dependency is
 * what the file names, not what an installer would choose.
 */

/** A Python package name as pip compares them. */
const pythonName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/** Strips a TOML comment, leaving `#` inside a quoted string alone. */
function withoutComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote !== undefined) {
      if (character === "\\" && quote === '"') index++;
      else if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

/** The quoted strings in some TOML. */
const quoted = (text: string) =>
  [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((match) => match[1] ?? match[2] ?? "");

/** The name a PEP 508 requirement, such as "fastapi[standard]>=0.115", starts with. */
const requirementName = (requirement: string) =>
  /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement)?.[1];

export interface PythonProject {
  /** Package names, as pip compares them, from every dependency list. */
  readonly dependencies: ReadonlySet<string>;
  readonly requiresPython: boolean;
  /** Whether it is the root of a uv workspace, which locks its members. */
  readonly workspace: boolean;
}

/**
 * Reads a pyproject.toml's dependency lists: `[project]` dependencies,
 * optional dependencies, dependency groups, uv's development dependencies
 * and Poetry's dependency tables.
 */
export function readPyproject(text: string): PythonProject {
  const dependencies = new Set<string>();
  let section = "";
  let array: { key: string; text: string; depth: number } | undefined;
  const lists = (key: string) =>
    (section === "project" && key === "dependencies") ||
    section === "project.optional-dependencies" ||
    section === "dependency-groups" ||
    (section === "tool.uv" && key === "dev-dependencies");
  const tables = () => /^tool\.poetry\.(.+\.)?(dev-)?dependencies$/.test(section);
  let requiresPython = false;
  let workspace = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = withoutComment(raw);
    if (array !== undefined) {
      array.text += `\n${line}`;
      array.depth += (line.match(/\[/g) ?? []).length - (line.match(/\]/g) ?? []).length;
      if (array.depth <= 0) {
        for (const value of quoted(array.text)) {
          const name = requirementName(value);
          if (name) dependencies.add(pythonName(name));
        }
        array = undefined;
      }
      continue;
    }
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/.exec(line);
    if (header) {
      section = (header[1] ?? "").replace(/["'\s]/g, "");
      if (section === "tool.uv.workspace") workspace = true;
      continue;
    }
    const assignment = /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!assignment) continue;
    const key = (assignment[1] ?? "").replace(/^["']|["']$/g, "");
    const value = assignment[2] ?? "";
    if (section === "project" && key === "requires-python") requiresPython = true;
    if (tables() && key.toLowerCase() === "python") {
      requiresPython = true;
    } else if (tables()) {
      dependencies.add(pythonName(key));
    } else if (lists(key) && value.trimStart().startsWith("[")) {
      const depth = (value.match(/\[/g) ?? []).length - (value.match(/\]/g) ?? []).length;
      array = { key, text: value, depth };
      if (depth <= 0) {
        for (const quotedValue of quoted(value)) {
          const name = requirementName(quotedValue);
          if (name) dependencies.add(pythonName(name));
        }
        array = undefined;
      }
    }
  }
  return { dependencies, requiresPython, workspace };
}

export const hasPython = (project: PythonProject, ...names: readonly string[]): boolean =>
  names.some((name) => project.dependencies.has(pythonName(name)));

export interface NodePackage {
  readonly dependencies: ReadonlySet<string>;
  readonly engine: boolean;
  readonly workspaces: boolean;
}

/** Reads a package.json, or undefined when it is not a JSON object. */
export function readPackageJson(text: string): NodePackage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const json = value as Record<string, unknown>;
  const keys = (field: string) => {
    const object = json[field];
    return typeof object === "object" && object !== null && !Array.isArray(object)
      ? Object.keys(object)
      : [];
  };
  const engines = json.engines as Record<string, unknown> | undefined;
  return {
    dependencies: new Set([...keys("dependencies"), ...keys("devDependencies")]),
    engine: typeof engines === "object" && engines !== null && typeof engines.node === "string",
    workspaces: json.workspaces !== undefined,
  };
}

export interface GoModule {
  /** Module paths the go.mod requires. */
  readonly requires: readonly string[];
  readonly goVersion: boolean;
}

/** Reads a go.mod's go directive and required modules. */
export function readGoMod(text: string): GoModule {
  const requires: string[] = [];
  let block = false;
  let goVersion = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (/^go\s+\d/.test(line)) goVersion = true;
    if (block) {
      if (line === ")") block = false;
      else if (line !== "") requires.push(line.split(/\s+/)[0] ?? "");
    } else if (/^require\s*\($/.test(line)) {
      block = true;
    } else if (/^require\s+\S/.test(line)) {
      requires.push(line.split(/\s+/)[1] ?? "");
    }
  }
  return { requires, goVersion };
}

export const requiresGo = (module: GoModule, prefix: string): boolean =>
  module.requires.some((required) => required === prefix || required.startsWith(`${prefix}/`));

/** The providers a .terraform.lock.hcl locks, such as "hashicorp/azurerm". */
export const lockedProviders = (text: string): string[] =>
  [...text.matchAll(/^provider\s+"(?:[^"/]+\/)?([^"]+)"/gm)].map((match) => match[1] ?? "");

/** What a GitHub Actions workflow declares, or undefined when it is not valid YAML. */
export interface Workflow {
  readonly onPullRequest: boolean;
  readonly jobs: readonly string[];
  /** Every action and reusable workflow it uses, as written. */
  readonly uses: readonly string[];
}

export function readWorkflow(text: string): Workflow | undefined {
  let value: unknown;
  try {
    value = parse(text, { maxAliasCount: 100 });
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const workflow = value as Record<string, unknown>;
  // YAML 1.1 reads a bare `on:` key as true.
  const on = workflow.on ?? workflow.true;
  const events =
    typeof on === "string"
      ? [on]
      : Array.isArray(on)
        ? on.map(String)
        : typeof on === "object" && on !== null
          ? Object.keys(on)
          : [];
  const jobs =
    typeof workflow.jobs === "object" && workflow.jobs !== null
      ? (workflow.jobs as Record<string, unknown>)
      : {};
  const uses: string[] = [];
  for (const job of Object.values(jobs)) {
    if (typeof job !== "object" || job === null) continue;
    const { uses: called, steps } = job as { uses?: unknown; steps?: unknown };
    if (typeof called === "string") uses.push(called);
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      const used = (step as { uses?: unknown } | null)?.uses;
      if (typeof used === "string") uses.push(used);
    }
  }
  return { onPullRequest: events.includes("pull_request"), jobs: Object.keys(jobs), uses };
}

/** Whether an action is pinned to a full commit SHA. Local actions and containers need not be. */
export const pinned = (used: string): boolean =>
  used.startsWith("./") || used.startsWith("docker://") || /@[0-9a-f]{40}$/.test(used);

/** The images a Compose file's services use, or undefined when it is not valid YAML. */
export function composeImages(text: string): string[] | undefined {
  let value: unknown;
  try {
    value = parse(text, { maxAliasCount: 100 });
  } catch {
    return undefined;
  }
  const services = (value as { services?: unknown } | null)?.services;
  if (typeof services !== "object" || services === null) return [];
  return Object.values(services as Record<string, unknown>)
    .map((service) => (service as { image?: unknown } | null)?.image)
    .filter((image): image is string => typeof image === "string");
}
