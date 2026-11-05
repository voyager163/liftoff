import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "config-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const file = (content: string) => {
  const name = path.join(directory, "config.json");
  writeFileSync(name, content);
  return name;
};

describe("configuration", () => {
  it("uses non-secret defaults when nothing is set", () => {
    expect(loadConfig({})).toEqual({
      environment: "local",
      host: "127.0.0.1",
      port: 8000,
      databaseUrl: "postgresql://postgres@localhost:5432/app",
      databaseTimeoutSeconds: 2,
      docsEnabled: true,
      logLevel: "info",
    });
  });

  it("accepts timeouts from a millisecond to a day", () => {
    for (const seconds of [0.001, 0.25, 86_400]) {
      expect(
        loadConfig({ APP_DATABASE_TIMEOUT_SECONDS: String(seconds) }).databaseTimeoutSeconds,
      ).toBe(seconds);
    }
  });

  it("prefers the environment over the named file over the defaults", () => {
    const config = loadConfig({
      APP_CONFIG_FILE: file(JSON.stringify({ port: 9000, environment: "staging" })),
      APP_PORT: "9100",
      APP_DOCS_ENABLED: "false",
    });
    expect(config).toMatchObject({ port: 9100, environment: "staging", docsEnabled: false });
  });

  it.each([
    [{ APP_CONFIG_FILE: "missing.json" }, "which does not exist"],
    [{ APP_PORT: "eighty" }, "port from APP_PORT must be a whole number"],
    [{ APP_PORT: "70000" }, "from 1 to 65535"],
    [{ APP_DATABASE_TIMEOUT_SECONDS: "0" }, "a number of seconds from 0.001 to 86400"],
    [{ APP_DATABASE_TIMEOUT_SECONDS: "1e-10" }, "from 0.001 to 86400"],
    [{ APP_DATABASE_TIMEOUT_SECONDS: "Infinity" }, "from 0.001 to 86400"],
    [{ APP_DATABASE_TIMEOUT_SECONDS: "3000000" }, "from 0.001 to 86400"],
    [{ APP_DATABASE_TIMEOUT_SECONDS: "soon" }, "from 0.001 to 86400"],
    [{ APP_DOCS_ENABLED: "yes" }, "docs_enabled from APP_DOCS_ENABLED must be true or false"],
    [{ APP_LOG_LEVEL: "loud" }, "log_level from APP_LOG_LEVEL must be one of"],
    [{ APP_HOST: "" }, "host from APP_HOST must be a non-empty string"],
  ])("rejects %j", (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });

  it("rejects a named file that is malformed, not an object or has unknown settings", () => {
    expect(() => loadConfig({ APP_CONFIG_FILE: file("{ port: ") })).toThrow("is not valid JSON");
    expect(() => loadConfig({ APP_CONFIG_FILE: file("[1]") })).toThrow("must hold a JSON object");
    expect(() => loadConfig({ APP_CONFIG_FILE: file('{"prot": 1, "colour": 2}') })).toThrow(
      "has unknown settings: colour, prot",
    );
    expect(() => loadConfig({ APP_CONFIG_FILE: file('{"docs_enabled": "maybe"}') })).toThrow(
      ConfigError,
    );
  });
});
