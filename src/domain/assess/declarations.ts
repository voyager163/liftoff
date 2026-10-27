import { parse as parseToml } from "smol-toml";
import { parse } from "yaml";

/**
 * What an assessment reads out of the declarations it opens. Each reader
 * takes text and never runs, imports or resolves anything: a dependency is
 * what the file names, not what an installer would choose.
 */

/** A Python package name as pip compares them. */
const pythonName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/** The name a PEP 508 requirement, such as "fastapi[standard]>=0.115", starts with. */
const requirementName = (requirement: string) =>
  /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement)?.[1];

type Table = Readonly<Record<string, unknown>>;

/** A value as a table, or undefined when it is anything else. */
const table = (value: unknown): Table | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
    ? (value as Table)
    : undefined;

/** A value's strings, when it is an array; anything else in it is skipped. */
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** A positive threshold, as a number or as text. */
const positive = (value: unknown) => Number(value) > 0;

/**
 * Whether pytest options, as text or a list, set a coverage threshold above
 * 0; pytest takes the last one given.
 */
function failsUnderCoverage(options: unknown): boolean {
  const text = Array.isArray(options) ? options.join(" ") : String(options ?? "");
  const given = [...text.matchAll(/--cov-fail-under(?:=|\s+)(\S+)/g)].at(-1)?.[1];
  return given !== undefined && positive(given);
}

/** Member and excluded directories of a workspace, as globs relative to its root. */
export interface Workspace {
  readonly members: readonly string[];
  readonly exclude: readonly string[];
}

export interface PythonProject {
  /** Package names, as pip compares them, from every dependency list. */
  readonly dependencies: ReadonlySet<string>;
  readonly requiresPython: boolean;
  /** The uv workspace it is the root of, which locks its members. */
  readonly workspace?: Workspace;
  /** Whether coverage below a threshold fails: fail_under, or pytest's --cov-fail-under. */
  readonly coverageGate: boolean;
}

/**
 * Reads a pyproject.toml, or undefined when it is not valid TOML: its
 * `[project]` dependencies, optional dependencies, dependency groups, uv's
 * development dependencies and Poetry's dependency tables.
 */
export function readPyproject(text: string): PythonProject | undefined {
  let document: Table;
  try {
    document = parseToml(text);
  } catch {
    return undefined;
  }
  const project = table(document.project) ?? {};
  const tool = table(document.tool) ?? {};
  const uv = table(tool.uv) ?? {};
  const poetry = table(tool.poetry) ?? {};
  const requirements = [
    ...strings(project.dependencies),
    ...Object.values(table(project["optional-dependencies"]) ?? {}).flatMap(strings),
    ...Object.values(table(document["dependency-groups"]) ?? {}).flatMap(strings),
    ...strings(uv["dev-dependencies"]),
  ];
  const poetryTables = [
    table(poetry.dependencies),
    table(poetry["dev-dependencies"]),
    ...Object.values(table(poetry.group) ?? {}).map((group) => table(table(group)?.dependencies)),
  ];
  const dependencies = new Set<string>();
  for (const requirement of requirements) {
    const name = requirementName(requirement);
    if (name) dependencies.add(pythonName(name));
  }
  for (const names of poetryTables) {
    for (const name of Object.keys(names ?? {})) {
      if (name.toLowerCase() !== "python") dependencies.add(pythonName(name));
    }
  }
  const workspace = table(uv.workspace);
  const coverage = table(table(tool.coverage)?.report);
  // pytest 9 reads [tool.pytest] itself; older releases [tool.pytest.ini_options].
  const pytest = table(tool.pytest);
  const legacy = table(pytest?.ini_options);
  return {
    dependencies,
    requiresPython:
      typeof project["requires-python"] === "string" ||
      typeof table(poetry.dependencies)?.python === "string",
    ...(workspace
      ? { workspace: { members: strings(workspace.members), exclude: strings(workspace.exclude) } }
      : {}),
    coverageGate:
      positive(coverage?.fail_under) ||
      failsUnderCoverage(pytest?.addopts) ||
      failsUnderCoverage(legacy?.addopts),
  };
}

export const hasPython = (project: PythonProject, ...names: readonly string[]): boolean =>
  names.some((name) => project.dependencies.has(pythonName(name)));

/**
 * Whether a pytest.toml or .pytest.toml sets a coverage threshold above 0
 * in its [pytest] options, or undefined when it is not valid TOML.
 */
export function pytestTomlCoverageGate(text: string): boolean | undefined {
  try {
    return failsUnderCoverage(table(parseToml(text).pytest)?.addopts);
  } catch {
    return undefined;
  }
}

/**
 * The sections of an INI file, such as setup.cfg, each with its keys. A
 * line indented deeper than its option continues the value before it. A comment, whole-line or
 * after a space, is left out, so what it mentions never counts.
 */
export function readIni(text: string): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let section: Map<string, string> | undefined;
  let key: { readonly name: string; readonly indent: number } | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s[#;].*$/, "");
    const indent = /^\s*/.exec(line)?.[0].length ?? 0;
    if (/^\s*([#;]|$)/.test(line)) continue;
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = new Map();
      sections.set((header[1] ?? "").trim(), section);
      key = undefined;
    } else if (section !== undefined && key !== undefined && indent > key.indent) {
      // Only a line indented deeper than its option continues the value.
      section.set(key.name, `${section.get(key.name) ?? ""} ${line.trim()}`);
    } else {
      const pair = /^\s*([^=:]+?)\s*[=:]\s*(.*)$/.exec(line);
      if (pair && section !== undefined) {
        key = { name: (pair[1] ?? "").trim(), indent };
        section.set(key.name, (pair[2] ?? "").trim());
      }
    }
  }
  return sections;
}

/**
 * Whether an INI file Python's tools read sets a coverage threshold above 0:
 * coverage's fail_under, or pytest's --cov-fail-under.
 */
export function iniCoverageGate(file: string, text: string): boolean {
  const sections = readIni(text);
  const value = (section: string, key: string) => sections.get(section)?.get(key);
  switch (file) {
    case ".coveragerc":
      return positive(value("report", "fail_under"));
    case "pytest.ini":
      return failsUnderCoverage(value("pytest", "addopts"));
    case "setup.cfg":
      return (
        positive(value("coverage:report", "fail_under")) ||
        failsUnderCoverage(value("tool:pytest", "addopts"))
      );
    case "tox.ini":
      return (
        positive(value("coverage:report", "fail_under")) ||
        failsUnderCoverage(value("pytest", "addopts"))
      );
    default:
      return false;
  }
}

/**
 * The shape of some JavaScript or TypeScript: without its comments, and with
 * every string emptied except a quoted key, which keeps its name. What is
 * left is only what the code says, not what its text mentions.
 */
function codeShape(code: string): string {
  let out = "";
  for (let index = 0; index < code.length; index++) {
    const character = code[index] ?? "";
    if (character === '"' || character === "'" || character === "`") {
      let end = index + 1;
      while (end < code.length && code[end] !== character) end += code[end] === "\\" ? 2 : 1;
      const key = character !== "`" && /^\s*:/.test(code.slice(end + 1));
      out += key ? code.slice(index + 1, end) : '""';
      index = end;
    } else if (code.startsWith("//", index)) {
      const end = code.indexOf("\n", index);
      index = end === -1 ? code.length : end - 1;
    } else if (code.startsWith("/*", index)) {
      const end = code.indexOf("*/", index + 2);
      index = end === -1 ? code.length : end + 1;
    } else {
      out += character;
    }
  }
  return out;
}

/**
 * Whether a Vitest, Vite or Jest configuration, which is code, sets coverage
 * thresholds: "declared" when it gives a non-empty object literal for
 * `thresholds` or `coverageThreshold`; "unclear" when it gives one some other
 * way, such as from a variable; "none" when it gives neither, or only `{}`.
 */
export function scriptCoverage(code: string): "declared" | "unclear" | "none" {
  const shape = codeShape(code);
  if (/\b(thresholds|coverageThreshold)\s*:\s*\{\s*[^\s}]/.test(shape)) return "declared";
  const named = [...shape.matchAll(/\b(thresholds|coverageThreshold)\b(\s*:\s*\{\s*\})?/g)];
  return named.some((match) => match[2] === undefined) ? "unclear" : "none";
}

export interface NodePackage {
  readonly dependencies: ReadonlySet<string>;
  readonly engine: boolean;
  /** The npm workspace it is the root of, which locks its members. */
  readonly workspace?: Workspace;
  /** Whether Jest's configuration in it sets a coverage threshold. */
  readonly coverageGate: boolean;
}

/** Reads a package.json, or undefined when it is not a JSON object. */
export function readPackageJson(text: string): NodePackage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const json = table(value);
  if (json === undefined) return undefined;
  const keys = (field: string) => Object.keys(table(json[field]) ?? {});
  // npm takes a list of globs, or Yarn's { packages } form; "!" excludes.
  const patterns = Array.isArray(json.workspaces)
    ? strings(json.workspaces)
    : strings(table(json.workspaces)?.packages);
  const threshold = table(table(json.jest)?.coverageThreshold);
  return {
    dependencies: new Set([...keys("dependencies"), ...keys("devDependencies")]),
    engine: typeof table(json.engines)?.node === "string",
    ...(json.workspaces === undefined
      ? {}
      : {
          workspace: {
            members: patterns.filter((pattern) => !pattern.startsWith("!")),
            exclude: patterns
              .filter((pattern) => pattern.startsWith("!"))
              .map((pattern) => pattern.slice(1)),
          },
        }),
    coverageGate: threshold !== undefined && Object.keys(threshold).length > 0,
  };
}

export interface GoModule {
  /** Module paths the go.mod requires. */
  readonly requires: readonly string[];
  readonly goVersion: boolean;
}

/**
 * Reads a go.mod's go directive and required modules, or undefined when it is
 * not a valid go.mod: no module directive, a block left open, or a
 * requirement without a version.
 */
export function readGoMod(text: string): GoModule | undefined {
  const requires: string[] = [];
  let block: string | undefined;
  let module = false;
  let goVersion = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line === "") continue;
    if (block !== undefined) {
      if (line === ")") block = undefined;
      else if (block === "require") {
        const [path, version] = line.split(/\s+/);
        if (path === undefined || version === undefined) return undefined;
        requires.push(path);
      }
      continue;
    }
    const opening = /^([a-z]+)\s*\($/.exec(line);
    if (opening) {
      block = opening[1];
      continue;
    }
    if (/^module\s+\S/.test(line)) module = true;
    if (/^go\s+\d/.test(line)) goVersion = true;
    if (/^require\s/.test(line)) {
      const [, path, version] = line.split(/\s+/);
      if (path === undefined || version === undefined) return undefined;
      requires.push(path);
    }
  }
  return module && block === undefined ? { requires, goVersion } : undefined;
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
