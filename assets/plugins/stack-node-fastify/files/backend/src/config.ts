// Runtime configuration.
//
// Settings come from, in order of precedence:
//
// 1. process environment variables, prefixed APP_ (for example APP_PORT);
// 2. the JSON file named by APP_CONFIG_FILE, when that variable is set;
// 3. the non-secret defaults below.
//
// Naming a configuration file that is missing, malformed or contains unknown
// settings is an error. It never falls back to the defaults silently.
import { readFileSync } from "node:fs";

export const CONFIG_FILE_VARIABLE = "APP_CONFIG_FILE";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  readonly environment: string;
  readonly host: string;
  readonly port: number;
  /** No password here: provide the full URL through APP_DATABASE_URL. */
  readonly databaseUrl: string;
  readonly databaseTimeoutSeconds: number;
  readonly docsEnabled: boolean;
  readonly logLevel: LogLevel;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Each setting's name in the configuration file; the environment uses APP_ plus the upper-case name. */
const DEFAULTS = {
  environment: "local",
  host: "127.0.0.1",
  port: 8000,
  database_url: "postgresql://postgres@localhost:5432/app",
  database_timeout_seconds: 2,
  docs_enabled: true,
  log_level: "info",
} as const;
type Setting = keyof typeof DEFAULTS;
const SETTINGS = Object.keys(DEFAULTS) as Setting[];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sources = new Map<Setting, { value: unknown; source: string }>();
  for (const setting of SETTINGS)
    sources.set(setting, { value: DEFAULTS[setting], source: "default" });
  const file = env[CONFIG_FILE_VARIABLE];
  if (file) {
    for (const [setting, value] of Object.entries(readConfigFile(file))) {
      sources.set(setting as Setting, { value, source: file });
    }
  }
  for (const setting of SETTINGS) {
    const variable = `APP_${setting.toUpperCase()}`;
    const value = env[variable];
    if (value !== undefined) sources.set(setting, { value, source: variable });
  }
  const read = (setting: Setting) =>
    sources.get(setting) ?? { value: undefined, source: "default" };
  return {
    environment: text("environment", read("environment")),
    host: text("host", read("host")),
    port: port(read("port")),
    databaseUrl: text("database_url", read("database_url")),
    databaseTimeoutSeconds: seconds(read("database_timeout_seconds")),
    docsEnabled: flag(read("docs_enabled")),
    logLevel: logLevel(read("log_level")),
  };
}

function readConfigFile(file: string): Record<string, unknown> {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    throw new ConfigError(`${CONFIG_FILE_VARIABLE} names ${file}, which does not exist`);
  }
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ConfigError(`${file} must hold a JSON object of settings`);
  }
  const unknown = Object.keys(data)
    .filter((key) => !(SETTINGS as string[]).includes(key))
    .sort();
  if (unknown.length > 0) {
    throw new ConfigError(`${file} has unknown settings: ${unknown.join(", ")}`);
  }
  return data as Record<string, unknown>;
}

interface Read {
  readonly value: unknown;
  readonly source: string;
}

const invalid = (setting: string, { source }: Read, expected: string): never => {
  throw new ConfigError(`${setting} from ${source} must be ${expected}`);
};

function text(setting: Setting, read: Read): string {
  return typeof read.value === "string" && read.value !== ""
    ? read.value
    : invalid(setting, read, "a non-empty string");
}

function port(read: Read): number {
  const value = typeof read.value === "string" ? Number(read.value) : read.value;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535
    ? value
    : invalid("port", read, "a whole number from 1 to 65535");
}

/** The range also keeps timeouts within what setTimeout accepts (about 24 days). */
const MIN_TIMEOUT_SECONDS = 0.001;
const MAX_TIMEOUT_SECONDS = 86_400;

function seconds(read: Read): number {
  const value = typeof read.value === "string" ? Number(read.value) : read.value;
  return typeof value === "number" && value >= MIN_TIMEOUT_SECONDS && value <= MAX_TIMEOUT_SECONDS
    ? value
    : invalid(
        "database_timeout_seconds",
        read,
        `a number of seconds from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS}`,
      );
}

function flag(read: Read): boolean {
  if (typeof read.value === "boolean") return read.value;
  if (read.value === "true" || read.value === "false") return read.value === "true";
  return invalid("docs_enabled", read, "true or false");
}

function logLevel(read: Read): LogLevel {
  return (LOG_LEVELS as readonly unknown[]).includes(read.value)
    ? (read.value as LogLevel)
    : invalid("log_level", read, `one of ${LOG_LEVELS.join(", ")}`);
}
