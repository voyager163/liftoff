import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { en } from "zod/locales";
import * as z from "zod/mini";
import { pathKey, repositoryPathProblem } from "./paths.ts";

z.config(en());

/** The project's desired state, at the repository root. */
export const CONFIG_FILE = "liftoff.yaml";
export const CONFIG_SCHEMA = "liftoff.config/v1";

/**
 * Project names become directory, container, package and Azure resource names,
 * so keep them simple: no runs of hyphens, which some of those refuse.
 */
const NAME = /^(?=.{2,50}$)[a-z](?:-?[a-z0-9])*$/;
const NAME_RULE =
  "must be 2 to 50 lowercase letters, digits or single hyphens, starting with a letter and ending with a letter or digit";
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Why a project name is not accepted, or undefined when it is. */
export const projectNameProblem = (name: string): string | undefined =>
  NAME.test(name) ? undefined : `A project name ${NAME_RULE}.`;

/** Whether a GitHub login is well formed. */
export const isGithubLogin = (login: string): boolean => LOGIN.test(login);

/** The parts of a project that live in a directory of their own. */
export const COMPONENTS = ["backend", "frontend", "infrastructure"] as const;
export type Component = (typeof COMPONENTS)[number];

/** Where each part lives in a project Liftoff created. */
export const STANDARD_LAYOUT: Readonly<Record<Component, string>> = {
  backend: "backend",
  frontend: "frontend",
  infrastructure: "infrastructure/opentofu/azure",
};

/** Directories no part of a project may be bound to, or inside. */
const RESERVED = [".git", ".github", ".liftoff"];

const configSchema = z.strictObject({
  schema: z.literal(CONFIG_SCHEMA),
  name: z.string().check(z.regex(NAME, NAME_RULE)),
  workload: z.string().check(z.minLength(1)),
  stack: z.string().check(z.minLength(1)),
  /** The GenAI pattern, or "none" for other workloads. */
  pattern: z._default(z.string().check(z.minLength(1)), "none"),
  /** A web frontend, or "none". */
  frontend: z._default(z.string().check(z.minLength(1)), "none"),
  /** Infrastructure as code, or "none". */
  infrastructure: z._default(z.string().check(z.minLength(1)), "none"),
  /** Deployment environments the infrastructure is generated for. */
  environments: z._default(z.array(z.string().check(z.minLength(1))), []),
  workflow: z.string().check(z.minLength(1)),
  agents: z.array(z.string().check(z.minLength(1))),
  governance: z.string().check(z.minLength(1)),
  review: z.strictObject({
    /** Verified AI review in CI. On by default when a coding agent is selected. */
    ai: z.boolean(),
    /** Which selected host runs the verified review. */
    engine: z.optional(z.string().check(z.minLength(1))),
  }),
  /** GitHub logins that own the project, for CODEOWNERS. */
  owners: z._default(z.array(z.string().check(z.regex(LOGIN, "must be a GitHub login"))), []),
  /**
   * Where parts of the project live when not in the standard directories,
   * such as a project adopted with its own layout. "." is the repository
   * root.
   */
  layout: z._default(
    z.strictObject({
      backend: z.optional(z.string()),
      frontend: z.optional(z.string()),
      infrastructure: z.optional(z.string()),
    }),
    {},
  ),
});

export type ProjectConfig = z.output<typeof configSchema>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Validates a config object. Plugin identities are checked separately against the registry. */
export function validateConfig(raw: unknown, source = CONFIG_FILE): ProjectConfig {
  const parsed = z.safeParse(configSchema, raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new ConfigError(`${source} is invalid: ${issues.join("; ")}`);
  }
  const config = parsed.data;
  if (new Set(config.environments).size !== config.environments.length) {
    throw new ConfigError(
      `${source} is invalid: environments: each environment may be listed once`,
    );
  }
  if (new Set(config.agents).size !== config.agents.length) {
    throw new ConfigError(`${source} is invalid: agents: each agent may be listed once`);
  }
  // GitHub logins ignore case, so alice and Alice are one owner.
  if (new Set(config.owners.map((owner) => owner.toLowerCase())).size !== config.owners.length) {
    throw new ConfigError(
      `${source} is invalid: owners: each owner may be listed once, in any letter case`,
    );
  }
  const problem = layoutProblem(config);
  if (problem !== undefined) throw new ConfigError(`${source} is invalid: layout: ${problem}`);
  // A binding to the standard directory is the same as none, and is not written.
  const layout = Object.fromEntries(
    Object.entries(config.layout).filter(
      ([component, directory]) => directory !== STANDARD_LAYOUT[component as Component],
    ),
  );
  return { ...config, layout };
}

/** Whether the project has a part, so it may be bound. */
const hasComponent = (config: ProjectConfig, component: Component): boolean =>
  component === "backend" || config[component] !== "none";

/** Where each part the project has lives: its binding, or the standard directory. */
export function layoutOf(config: ProjectConfig): Partial<Record<Component, string>> {
  return Object.fromEntries(
    COMPONENTS.filter((component) => hasComponent(config, component)).map((component) => [
      component,
      config.layout[component] ?? STANDARD_LAYOUT[component],
    ]),
  );
}

/** Whether every part the project has is in its standard directory. */
export const isStandardLayout = (config: ProjectConfig): boolean =>
  Object.keys(config.layout).length === 0;

/**
 * Why the layout cannot be used, or undefined: each binding is for a part
 * the project has, is "." or a repository-relative path outside .git,
 * .github and .liftoff, and no part lies inside another part's directory,
 * except inside the repository root.
 */
function layoutProblem(config: ProjectConfig): string | undefined {
  for (const component of COMPONENTS) {
    const directory = config.layout[component];
    if (directory === undefined) continue;
    if (!hasComponent(config, component)) {
      return `${component}: the project has no ${component}`;
    }
    if (directory === ".") continue;
    const problem = repositoryPathProblem(directory);
    if (problem !== undefined) return `${component}: ${problem}`;
    if (RESERVED.includes(pathKey(directory.split("/")[0] ?? ""))) {
      return `${component}: ${directory} is inside a directory Liftoff or Git keeps for itself`;
    }
  }
  const placed = Object.entries(layoutOf(config)).map(([component, directory]) => ({
    component,
    key: pathKey(directory),
  }));
  for (const [index, one] of placed.entries()) {
    for (const other of placed.slice(index + 1)) {
      if (one.key === other.key) return `${one.component} and ${other.component} share a directory`;
      const [outer, inner] = one.key.length < other.key.length ? [one, other] : [other, one];
      if (outer.key !== "." && inner.key.startsWith(`${outer.key}/`)) {
        return `${inner.component} is inside ${outer.component}'s directory`;
      }
    }
  }
  return undefined;
}

export function parseConfig(text: string, source = CONFIG_FILE): ProjectConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`${source} is not valid YAML: ${(error as Error).message}`);
  }
  return validateConfig(raw, source);
}

/** Writes the config with a fixed key order, so the same config is always the same bytes. */
export function serializeConfig(config: ProjectConfig): string {
  const ordered = {
    schema: config.schema,
    name: config.name,
    workload: config.workload,
    stack: config.stack,
    pattern: config.pattern,
    frontend: config.frontend,
    infrastructure: config.infrastructure,
    environments: config.environments,
    workflow: config.workflow,
    agents: config.agents,
    governance: config.governance,
    review:
      config.review.engine === undefined
        ? { ai: config.review.ai }
        : { ai: config.review.ai, engine: config.review.engine },
    owners: config.owners,
    // Only bindings away from the standard directories, in a fixed order.
    ...(isStandardLayout(config)
      ? {}
      : {
          layout: Object.fromEntries(
            COMPONENTS.flatMap((component) =>
              config.layout[component] === undefined ? [] : [[component, config.layout[component]]],
            ),
          ),
        }),
  };
  return [
    "# Liftoff project configuration: what this project is made of.",
    "# Change it through Liftoff commands; see https://github.com/voyager163/liftoff",
    stringifyYaml(ordered, { lineWidth: 0 }),
  ].join("\n");
}
