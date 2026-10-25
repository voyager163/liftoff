import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { en } from "zod/locales";
import * as z from "zod/mini";

z.config(en());

/** The project's desired state, at the repository root. */
export const CONFIG_FILE = "liftoff.yaml";
export const CONFIG_SCHEMA = "liftoff.config/v1";

/**
 * Project names become directory, container, package and Azure resource names,
 * so keep them simple: no runs of hyphens, which some of those refuse.
 */
const NAME = /^(?=.{2,50}$)[a-z](?:-?[a-z0-9])*$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const configSchema = z.strictObject({
  schema: z.literal(CONFIG_SCHEMA),
  name: z
    .string()
    .check(
      z.regex(
        NAME,
        "must be 2 to 50 lowercase letters, digits or single hyphens, starting with a letter and ending with a letter or digit",
      ),
    ),
  workload: z.string().check(z.minLength(1)),
  stack: z.string().check(z.minLength(1)),
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
  return config;
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
  };
  return [
    "# Liftoff project configuration: what this project is made of.",
    "# Change it through Liftoff commands; see https://github.com/voyager163/liftoff",
    stringifyYaml(ordered, { lineWidth: 0 }),
  ].join("\n");
}
