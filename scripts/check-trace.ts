// Checks that requirements and tests reference each other. A requirement
// marked "Verification: test" needs at least one test that cites its ID, and
// every ID a test cites must exist. Live requirements are listed, not tested.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const ID = /\b([A-Z]{2,12}-\d{3})\b/g;

interface Requirement {
  id: string;
  file: string;
  verification: string;
  retired: boolean;
}

function walk(dir: string, match: (file: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, match);
    return match(full) ? [full] : [];
  });
}

function readRequirements(): Requirement[] {
  const requirements: Requirement[] = [];
  for (const file of walk(path.join(root, "docs/requirements"), (f) => f.endsWith(".md"))) {
    const text = readFileSync(file, "utf8").replace(/^```[\s\S]*?^```/gm, "");
    const sections = text.split(/^## /m).slice(1);
    for (const section of sections) {
      const id = /^([A-Z]{2,12}-\d{3}) /.exec(section)?.[1];
      if (!id) continue;
      requirements.push({
        id,
        file: path.relative(root, file),
        verification: /^Verification: (\w+)/m.exec(section)?.[1] ?? "missing",
        retired: /^Status: retired/m.test(section),
      });
    }
  }
  return requirements;
}

const requirements = readRequirements();
const problems: string[] = [];
const known = new Map<string, Requirement>();
for (const requirement of requirements) {
  if (known.has(requirement.id)) problems.push(`${requirement.id} is defined twice`);
  known.set(requirement.id, requirement);
  if (!["test", "live"].includes(requirement.verification)) {
    problems.push(
      `${requirement.id} (${requirement.file}) needs "Verification: test" or "Verification: live"`,
    );
  }
}

const cited = new Map<string, Set<string>>();
for (const file of walk(path.join(root, "tests"), (f) => f.endsWith(".test.ts"))) {
  for (const match of readFileSync(file, "utf8").matchAll(ID)) {
    const id = match[1] as string;
    const files = cited.get(id) ?? new Set<string>();
    files.add(path.relative(root, file));
    cited.set(id, files);
  }
}

for (const [id, files] of cited) {
  const requirement = known.get(id);
  if (!requirement) problems.push(`${[...files].join(", ")} cites unknown requirement ${id}`);
  else if (requirement.retired)
    problems.push(`${[...files].join(", ")} cites retired requirement ${id}`);
}
const untested = requirements.filter(
  (r) => r.verification === "test" && !r.retired && !cited.has(r.id),
);
for (const requirement of untested) {
  problems.push(`${requirement.id} (${requirement.file}) has no test that cites it`);
}

const live = requirements.filter((r) => r.verification === "live" && !r.retired);
console.log(
  `${requirements.length} requirements: ${requirements.length - live.length} tested, ${live.length} verified live (${live.map((r) => r.id).join(", ") || "none"}).`,
);
if (problems.length > 0) {
  for (const problem of problems) console.error(`trace: ${problem}`);
  process.exit(1);
}
