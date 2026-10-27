import type {
  Artifact,
  EnvironmentId,
  GenerationContext,
  InfrastructurePlugin,
} from "../../contracts/project-plugin.ts";
import { filesFrom } from "../files.ts";

const ROOT = "plugins/infrastructure-azure";
const TARGET = "infrastructure/opentofu/azure";

/** What differs between environments; everything else is the shared module. */
const SETTINGS: Readonly<Record<EnvironmentId, Readonly<Record<string, string>>>> = {
  dev: {
    databaseSku: "B_Standard_B1ms",
    databaseHighAvailability: "false",
    databaseBackupRetentionDays: "7",
    apiMinReplicas: "0",
  },
  staging: {
    databaseSku: "B_Standard_B1ms",
    databaseHighAvailability: "false",
    databaseBackupRetentionDays: "7",
    apiMinReplicas: "1",
  },
  prod: {
    databaseSku: "GP_Standard_D2ds_v5",
    databaseHighAvailability: "true",
    databaseBackupRetentionDays: "35",
    apiMinReplicas: "1",
  },
};

/** An HCL list of strings, formatted as `tofu fmt` writes it. */
const hclList = (values: readonly string[]) =>
  `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;

/** The frontend's image appears only in projects that have a frontend. */
function webImage({ config, frontend }: GenerationContext): Record<string, string> {
  if (!frontend) return { webImageArgument: "", webImageVariable: "", webImageExample: "" };
  const example = `<registry>.azurecr.io/${config.name}-web@sha256:<digest>`;
  return {
    webImageArgument: "\n  web_image = var.web_image\n",
    webImageVariable: `\nvariable "web_image" {\n  description = "The frontend image by digest, such as ${example}."\n  type        = string\n}\n`,
    webImageExample: `web_image       = "${example}"\n`,
  };
}

function environmentRoot(context: GenerationContext, environment: EnvironmentId): Artifact[] {
  const { database } = context.stack;
  // The registry only offers this infrastructure for stacks with a database.
  if (!database) throw new Error(`${context.stack.id} has no database for the Azure module`);
  const values = {
    name: context.config.name,
    environment,
    migrateCommand: hclList(database.migrateCommand),
    databaseUrlScheme: database.urlScheme,
    ...SETTINGS[environment],
    ...webImage(context),
  };
  const directory = `${TARGET}/environments/${environment}`;
  return [
    ...filesFrom(
      context.templates,
      `${ROOT}/environment`,
      values,
      "seeded",
      (path) => `${directory}/${path}`,
    ),
    lock(context, "environment", directory),
  ];
}

/** The provider lock for a kind of root, with hashes for every supported platform. */
function lock(context: GenerationContext, kind: string, directory: string): Artifact {
  return {
    path: `${directory}/.terraform.lock.hcl`,
    ownership: "seeded",
    content: context.templates.read(`${ROOT}/lock/${kind}.terraform.lock.hcl`),
  };
}

/**
 * Azure infrastructure as OpenTofu code: a bootstrap root for what the
 * environments share, and one root per selected environment over a shared
 * module. Liftoff only generates and validates it; applying it is separate.
 */
export const azureInfrastructure: InfrastructurePlugin = {
  id: "infrastructure/azure-opentofu",
  kind: "infrastructure",
  version: "2",
  summary: "Azure infrastructure as OpenTofu code, with a root per environment",
  templateRoots: [`${ROOT}/files`, `${ROOT}/environment`, `${ROOT}/lock`, `${ROOT}/parts`],
  parts: `${ROOT}/parts`,
  checks: [
    { name: "Infrastructure formatting", command: "tofu fmt -check -recursive", directory: TARGET },
    {
      name: "Infrastructure validation, for each root (bootstrap, environments/<name>)",
      command:
        "tofu -chdir=<root> init -backend=false -lockfile=readonly && tofu -chdir=<root> validate",
      directory: TARGET,
    },
    {
      name: "Infrastructure security scan",
      command: "checkov --directory . --framework terraform",
      directory: TARGET,
    },
  ],
  tools: [
    {
      name: "OpenTofu",
      command: "tofu",
      versionArgs: ["--version"],
      required: true,
      minimum: "1.13.2",
      purpose: "formats and validates the infrastructure code",
      install: "https://opentofu.org/docs/intro/install/",
    },
    {
      name: "Checkov",
      command: "checkov",
      versionArgs: ["--version"],
      required: false,
      purpose: "scans the infrastructure code for security issues",
      install: "https://www.checkov.io/2.Basics/Installing%20Checkov.html",
    },
  ],
  reviewRules: [
    {
      paths: [`${TARGET}/**`],
      tier: "high",
      always_human: true,
      reason: "changes the Azure infrastructure",
    },
  ],
  quickStart: { directory: TARGET, command: "tofu fmt -check -recursive" },
  layout: [
    {
      path: `${TARGET}/bootstrap/`,
      purpose: "state storage, the container registry and each environment's resource group",
    },
    { path: `${TARGET}/environments/`, purpose: "one OpenTofu root per environment" },
    { path: `${TARGET}/modules/`, purpose: "what an environment is made of, and resource names" },
  ],
  artifacts(context) {
    return [
      ...filesFrom(
        context.templates,
        `${ROOT}/files`,
        { name: context.config.name, environmentList: hclList(context.environments) },
        "seeded",
      ),
      lock(context, "bootstrap", `${TARGET}/bootstrap`),
      ...context.environments.flatMap((environment) => environmentRoot(context, environment)),
    ];
  },
};
