import { parse } from "yaml";
import { renderTemplate } from "../../generators/template.ts";
import type {
  Artifact,
  ComponentPlugin,
  GenerationContext,
  ProjectPlugin,
} from "../contracts/project-plugin.ts";
import { changeProcess } from "./stacks/shared.ts";

const ROOT = "templates/delivery";

/** Indents every non-empty line, so a part can sit under a YAML key. */
const indent = (text: string, spaces: number): string =>
  text
    .split("\n")
    .map((line) => (line === "" ? line : `${" ".repeat(spaces)}${line}`))
    .join("\n");

/** Wraps words into comment lines of at most 80 characters. */
function comment(text: string): string {
  const lines: string[] = [];
  let line = "#";
  for (const word of text.split(" ")) {
    if (line.length + word.length + 1 > 80) {
      lines.push(line);
      line = "#";
    }
    line += ` ${word}`;
  }
  return [...lines, line].join("\n");
}

const englishList = (items: readonly string[]): string =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

interface Part {
  readonly component: ComponentPlugin;
  readonly text: string;
  readonly data: unknown;
}

/** The components that have a part of `file`, with its asset path. */
const withPart = (context: GenerationContext, file: string) =>
  context.components
    .map((component) => ({ component, path: `${component.parts}/${file}` }))
    .filter(({ component, path }) => context.templates.list(component.parts).includes(path));

/** Each component's part of one shared file, rendered and checked to parse as `shape`. */
function parts(context: GenerationContext, file: string, shape: "mapping" | "list"): Part[] {
  return withPart(context, file).map(({ component, path }) => {
    const text = renderTemplate(context.templates.read(path), { name: context.config.name }, path);
    const data: unknown = parse(text);
    const isList = Array.isArray(data);
    if (data === null || typeof data !== "object" || isList !== (shape === "list")) {
      throw new Error(`${path} must be a YAML ${shape}`);
    }
    return { component, text: text.trimEnd(), data };
  });
}

/**
 * The keys of mapping parts, refusing a key two components both define or
 * one the shared file already has (`builtIn`).
 */
function keysOf(mappings: readonly Part[], what: string, builtIn: readonly string[]): string[] {
  const owner = new Map<string, string>();
  for (const { component, data } of mappings) {
    for (const key of Object.keys(data as object)) {
      if (builtIn.includes(key)) {
        throw new Error(`${component.id} defines the ${what} "${key}", which Liftoff adds itself`);
      }
      const other = owner.get(key);
      if (other) throw new Error(`${component.id} and ${other} both define the ${what} "${key}"`);
      owner.set(key, component.id);
    }
  }
  return [...owner.keys()];
}

/** How to start the application locally, at the top of compose.yaml. */
const COMPOSE_HEADER = {
  database: [
    "# Local development: PostgreSQL and the application.",
    "#   cp .env.example .env    # then set POSTGRES_PASSWORD",
    "#   docker compose up --build",
  ],
  application: [
    "# Local development: the application.",
    "#   cp .env.example .env    # then adjust it if needed",
    "#   docker compose up --build",
  ],
};

function compose(context: GenerationContext): string {
  // PostgreSQL is part of the project only when the stack uses it.
  const database = context.stack.database !== undefined;
  const builtIn = database ? ["database"] : [];
  const services = parts(context, "compose.yaml", "mapping");
  const names = new Set([...builtIn, ...keysOf(services, "Compose service", builtIn)]);
  for (const { component, data } of services) {
    for (const [name, service] of Object.entries(data as Record<string, { depends_on?: object }>)) {
      for (const needed of Object.keys(service.depends_on ?? {})) {
        if (!names.has(needed)) {
          throw new Error(`${component.id}'s ${name} service depends on unknown "${needed}"`);
        }
      }
    }
  }
  const blocks = [
    ...(database ? [context.templates.read(`${ROOT}/database.yaml`).trimEnd()] : []),
    ...services.map(({ text }) => text),
  ].map((text) => indent(text, 2));
  return renderTemplate(
    context.templates.read(`${ROOT}/compose.yaml`),
    {
      name: context.config.name,
      header: COMPOSE_HEADER[database ? "database" : "application"].join("\n"),
      body: `${blocks.join("\n\n")}${database ? "\n\nvolumes:\n  database:" : ""}`,
    },
    `${ROOT}/compose.yaml`,
  );
}

/** Local settings for Compose: the database password, then each component's. */
function envExample(context: GenerationContext): string | undefined {
  const sections = [
    ...(context.stack.database ? [context.templates.read(`${ROOT}/database.env.example`)] : []),
    ...withPart(context, "env.example").map(({ path }) =>
      renderTemplate(context.templates.read(path), { name: context.config.name }, path),
    ),
  ].map((section) => section.trimEnd());
  return sections.length === 0 ? undefined : `${sections.join("\n\n")}\n`;
}

/** Jobs the GitFlow profiles add to CI, which ci-gate also needs. */
const GOVERNANCE_JOBS = ["branch-policy", "release-lineage"];

/** Branch prefixes of the tools that open pull requests into develop. */
const automationBranches = (context: GenerationContext): string[] => [
  "dependabot",
  ...context.hosts,
];

function ci(context: GenerationContext): string {
  const jobs = parts(context, "ci-jobs.yml", "mapping");
  const governed = context.profile !== "none";
  const ids = keysOf(jobs, "CI job", [
    "dependencies",
    "ci-gate",
    ...(governed ? GOVERNANCE_JOBS : []),
  ]);
  const governanceJobs = governed
    ? renderTemplate(
        context.templates.read(`${ROOT}/branch-policy-jobs.yml`),
        { automation: automationBranches(context).join(",") },
        `${ROOT}/branch-policy-jobs.yml`,
      )
    : "";
  return renderTemplate(
    context.templates.read(`${ROOT}/01-pr-ci.yml`),
    {
      jobs: jobs.map(({ text }) => indent(text, 2)).join("\n\n"),
      governanceJobs: governanceJobs === "" ? "" : `\n${indent(governanceJobs.trimEnd(), 2)}\n`,
      gateNeeds: [...ids, ...(governed ? GOVERNANCE_JOBS : []), "dependencies"].join(", "),
    },
    `${ROOT}/01-pr-ci.yml`,
  );
}

function codeql(context: GenerationContext): string {
  const languages = new Map<string, string>();
  const analyzed = context.components.flatMap(({ codeql }) => (codeql ? [codeql] : []));
  for (const { language, buildMode } of analyzed) {
    if (!languages.has(language)) languages.set(language, buildMode);
  }
  languages.set("actions", "none");
  const subjects = [
    ...new Set(analyzed.map(({ subject }) => subject)),
    "the GitHub Actions workflows",
  ];
  return renderTemplate(
    context.templates.read(`${ROOT}/02-codeql.yml`),
    {
      codeqlHeader: comment(
        `Static application security testing with CodeQL for ${englishList(subjects)}.`,
      ),
      codeqlLanguages: [...languages]
        .map(
          ([language, mode]) =>
            `          - language: ${language}\n            build-mode: ${mode}`,
        )
        .join("\n"),
    },
    `${ROOT}/02-codeql.yml`,
  );
}

function dependabot(context: GenerationContext): string {
  const updates = parts(context, "dependabot.yml", "list");
  // Dependabot allows one entry per ecosystem and directory.
  const byTarget = updates.map((part) => ({
    ...part,
    data: Object.fromEntries(
      (part.data as Record<string, unknown>[]).map((update) => [
        `${update["package-ecosystem"]} in ${update.directory ?? update.directories}`,
        update,
      ]),
    ),
  }));
  keysOf(byTarget, "Dependabot update", ["github-actions in /"]);
  return renderTemplate(
    context.templates.read(`${ROOT}/dependabot.yml`),
    { updates: updates.map(({ text }) => indent(text, 2)).join("\n\n") },
    `${ROOT}/dependabot.yml`,
  );
}

function readme(context: GenerationContext): string {
  const sections = withPart(context, "README.md").map(({ component, path }) =>
    renderTemplate(
      context.templates.read(path),
      { name: context.config.name, ...component.readmeValues?.(context) },
      path,
    ),
  );
  const { guide } = context.workflow;
  return [
    ...sections.map((section) => `${section.trimEnd()}\n`),
    ...(guide.length === 0 ? [] : [`## Specifications\n\n${guide.join("\n\n")}\n`]),
    `## How changes are made\n\n${changeProcess(context.profile)}\n`,
  ].join("\n");
}

/**
 * Files every component contributes to: Docker Compose, the CI and CodeQL
 * workflows, Dependabot and the README, assembled from each selected
 * component's parts so that a frontend adds its own services and jobs.
 */
export const deliveryPlugin: ProjectPlugin = {
  id: "common/delivery",
  kind: "common",
  version: "1",
  summary: "Docker Compose, CI, CodeQL, Dependabot and README for the selected components",
  templateRoots: [ROOT],
  artifacts(context): Artifact[] {
    const file = (path: string, content: string): Artifact => ({
      path,
      ownership: "seeded",
      content,
    });
    const env = envExample(context);
    return [
      ...(env === undefined ? [] : [file(".env.example", env)]),
      file("README.md", readme(context)),
      file("compose.yaml", compose(context)),
      file(".github/workflows/01-pr-ci.yml", ci(context)),
      file(".github/workflows/02-codeql.yml", codeql(context)),
      file(".github/dependabot.yml", dependabot(context)),
    ];
  },
};
