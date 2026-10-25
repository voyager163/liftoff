// Checks the Azure infrastructure template's resource names against Azure's
// naming rules, for the project names most likely to break them: the
// shortest, the longest Liftoff accepts, and ones with runs of hyphens. It
// evaluates the template's own naming module with OpenTofu, which needs no
// cloud access because the module creates nothing. Names that must be
// globally unique must also differ between environments.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const naming = path.join(
  root,
  "assets/plugins/infrastructure-azure/files/infrastructure/opentofu/azure/modules/naming",
);
const PROJECTS = ["ab", "a".repeat(50), "z-".repeat(24) + "zz", "demo--api", "a-b--c---d-e"];
const ENVIRONMENTS = ["", "dev", "staging", "prod"];
const SUBSCRIPTION = "00000000-0000-0000-0000-000000000000";

/** Azure's rules for each name the module makes, from Microsoft's naming rules. */
const RULES: Record<string, RegExp> = {
  resource_group: /^[\w.()-]{1,89}[\w()-]$/,
  state_storage_account: /^[a-z0-9]{3,24}$/,
  container_registry: /^[a-zA-Z0-9]{5,50}$/,
  app_identity: /^[a-zA-Z0-9][\w-]{2,127}$/,
  log_analytics_workspace: /^[a-zA-Z0-9][a-zA-Z0-9-]{2,61}[a-zA-Z0-9]$/,
  virtual_network: /^[a-zA-Z0-9][\w.-]{0,62}\w$/,
  container_app_environment: /^[a-z][a-z0-9-]{0,58}[a-z0-9]$/,
  postgres_server: /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
  postgres_dns_zone: /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9-]+)+$/,
  api_app: /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/,
  web_app: /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/,
  migrate_job: /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/,
};
/** Names Azure requires to be unique beyond the resource group. */
const GLOBAL = ["state_storage_account", "container_registry", "postgres_server"];
/** Names that only exist per environment. */
const PER_ENVIRONMENT = [
  "postgres_server",
  "postgres_dns_zone",
  "api_app",
  "web_app",
  "migrate_job",
  "container_app_environment",
];

const work = mkdtempSync(path.join(tmpdir(), "liftoff-names-"));
const problems: string[] = [];
try {
  const modules = PROJECTS.flatMap((project, p) =>
    ENVIRONMENTS.map(
      (environment, e) =>
        `module "n_${p}_${e}" {\n  source = ${JSON.stringify(naming)}\n  project = ${JSON.stringify(project)}\n  environment = ${JSON.stringify(environment)}\n  subscription_id = ${JSON.stringify(SUBSCRIPTION)}\n}\noutput "n_${p}_${e}" {\n  value = module.n_${p}_${e}\n}\n`,
    ),
  );
  writeFileSync(path.join(work, "main.tf"), modules.join("\n"));
  const tofu = (...args: string[]) =>
    execFileSync("tofu", args, {
      cwd: work,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  tofu("init", "-input=false", "-no-color");
  tofu("apply", "-auto-approve", "-input=false", "-no-color");
  const outputs = JSON.parse(tofu("output", "-json")) as Record<
    string,
    { value: Record<string, string> }
  >;

  PROJECTS.forEach((project, p) => {
    const perEnvironment = new Map<string, Set<string>>();
    ENVIRONMENTS.forEach((environment, e) => {
      const names = outputs[`n_${p}_${e}`]?.value ?? {};
      for (const [kind, rule] of Object.entries(RULES)) {
        if (environment === "" && PER_ENVIRONMENT.includes(kind)) continue;
        const name = names[kind] ?? "";
        // A DNS zone name is checked label by label; each is at most 63 characters.
        const longLabel =
          kind === "postgres_dns_zone" && name.split(".").some((l) => l.length > 63);
        if (!rule.test(name) || name.includes("--") || longLabel) {
          problems.push(`${kind} for "${project}" in "${environment}": ${name}`);
        }
        if (environment !== "" && GLOBAL.includes(kind) && PER_ENVIRONMENT.includes(kind)) {
          const seen = perEnvironment.get(kind) ?? new Set<string>();
          if (seen.has(name))
            problems.push(`${kind} for "${project}" repeats in ${environment}: ${name}`);
          seen.add(name);
          perEnvironment.set(kind, seen);
        }
      }
    });
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`Azure naming problems:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `checked ${Object.keys(RULES).length} kinds of name for ${PROJECTS.length} project names in ${ENVIRONMENTS.length - 1} environments`,
);
