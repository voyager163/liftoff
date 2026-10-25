// Enforces Liftoff's architecture boundaries using esbuild's import graph.
// Dependencies point inward: cli and ci are composition roots; application
// reaches the outside world only through ports; domain, generators and
// plugins never perform I/O. Also rejects import cycles and unreachable files.
import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const IO_MODULES =
  /^(node:)?(fs|fs\/promises|child_process|net|http|https|dns|tls|os|worker_threads)$/;
// Entry points outside src/ are build tooling that renders shipped assets.
const ENTRY_POINTS = [
  "src/cli/main.ts",
  "src/ci/review-policy-entry.ts",
  "src/ci/governance-drift-entry.ts",
  "scripts/render-own-skills.ts",
];

interface Rule {
  name: string;
  from: RegExp;
  forbidden: (target: string) => boolean;
}

const layer = (name: string) => (target: string) => target.startsWith(`src/${name}/`);
const any =
  (...checks: ((t: string) => boolean)[]) =>
  (target: string) =>
    checks.some((check) => check(target));
const io = (target: string) => IO_MODULES.test(target);

const RULES: Rule[] = [
  {
    name: "domain is pure: no I/O and no outer layers",
    from: /^src\/domain\//,
    forbidden: any(
      io,
      layer("cli"),
      layer("ci"),
      layer("application"),
      layer("adapters"),
      layer("plugins"),
      layer("generators"),
    ),
  },
  {
    name: "application reaches the outside world only through ports",
    from: /^src\/application\//,
    forbidden: any(io, layer("cli"), layer("ci"), layer("adapters")),
  },
  {
    name: "generators and plugins are pure",
    from: /^src\/(generators|plugins)\//,
    forbidden: any(io, layer("cli"), layer("ci"), layer("application"), layer("adapters")),
  },
  {
    name: "adapters do not reach up into use cases or presentation",
    from: /^src\/adapters\//,
    forbidden: any(
      layer("cli"),
      layer("ci"),
      layer("application"),
      layer("plugins"),
      layer("generators"),
    ),
  },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(relative);
    return entry.name.endsWith(".ts") ? [relative] : [];
  });
}

const files = sourceFiles("src");
const result = await build({
  absWorkingDir: root,
  entryPoints: [...files, ...ENTRY_POINTS.filter((entry) => !entry.startsWith("src/"))],
  bundle: true,
  write: false,
  metafile: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outdir: "out",
  logLevel: "silent",
});

const graph = new Map<string, string[]>();
for (const [input, info] of Object.entries(result.metafile.inputs)) {
  if (!input.startsWith("src/") && !ENTRY_POINTS.includes(input)) continue;
  graph.set(
    input,
    info.imports.map((entry) => entry.path),
  );
}
if (
  graph.size === 0 ||
  graph.size < files.length + ENTRY_POINTS.filter((entry) => !entry.startsWith("src/")).length
) {
  console.error(`boundaries: expected ${files.length} modules in the graph, found ${graph.size}`);
  process.exit(1);
}

const problems: string[] = [];
for (const [from, targets] of graph) {
  for (const rule of RULES) {
    if (!rule.from.test(from)) continue;
    for (const target of targets) {
      if (rule.forbidden(target)) problems.push(`${from} imports ${target}: ${rule.name}`);
    }
  }
}

// Cycles, by depth-first search over source-to-source edges.
const state = new Map<string, "visiting" | "done">();
const stack: string[] = [];
const visit = (node: string) => {
  state.set(node, "visiting");
  stack.push(node);
  for (const next of graph.get(node) ?? []) {
    if (!graph.has(next)) continue;
    if (state.get(next) === "visiting") {
      problems.push(`import cycle: ${[...stack.slice(stack.indexOf(next)), next].join(" -> ")}`);
    } else if (!state.has(next)) {
      visit(next);
    }
  }
  stack.pop();
  state.set(node, "done");
};
for (const node of graph.keys()) if (!state.has(node)) visit(node);

// Every source file must be reachable from an entry point.
const reachable = new Set<string>();
const walk = (node: string) => {
  if (reachable.has(node)) return;
  reachable.add(node);
  for (const next of graph.get(node) ?? []) if (graph.has(next)) walk(next);
};
for (const entry of ENTRY_POINTS) {
  if (graph.has(entry)) walk(entry);
  else problems.push(`entry point ${entry} is missing`);
}
// Files holding only types vanish from esbuild's graph, so they are exempt.
const typesOnly = (file: string) =>
  stripTypeScriptTypes(readFileSync(path.join(root, file), "utf8"))
    .replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")
    .trim() === "";
for (const file of graph.keys()) {
  if (!reachable.has(file) && !typesOnly(file)) {
    problems.push(`${file} is not reachable from any entry point`);
  }
}

console.log(`boundaries: checked ${graph.size} modules`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`boundaries: ${problem}`);
  process.exit(1);
}
