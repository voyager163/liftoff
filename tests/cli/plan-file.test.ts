import {
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writePlanFile } from "../../src/cli/plan-file.ts";

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "liftoff-plan-file-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const at = (name: string) => path.join(work, name);

describe("INIT-001 a plan file is written as a new file", () => {
  it("replaces a file, and another name for a file, without writing to what it named", async () => {
    writeFileSync(at("plan.json"), "old\n");
    await writePlanFile(at("plan.json"), "{}\n");
    expect(readFileSync(at("plan.json"), "utf8")).toBe("{}\n");

    writeFileSync(at("main.py"), "print('hi')\n");
    linkSync(at("main.py"), at("hard.json"));
    await writePlanFile(at("hard.json"), "{}\n");
    expect(readFileSync(at("hard.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(at("main.py"), "utf8")).toBe("print('hi')\n");
    expect(readdirSync(work).sort()).toEqual(["hard.json", "main.py", "plan.json"]);
  });

  it("replaces a link instead of writing where it points, and leaves nothing when it fails", async () => {
    await expect(writePlanFile(at("missing/plan.json"), "{}\n")).rejects.toThrow();
    expect(readdirSync(work)).toEqual([]);
    // A link to a file is a privilege on Windows, so this part runs elsewhere.
    if (process.platform === "win32") return;
    symlinkSync(at("elsewhere.json"), at("linked.json"));
    await writePlanFile(at("linked.json"), "{}\n");
    expect(readdirSync(work).sort()).toEqual(["linked.json"]);
    expect(readFileSync(at("linked.json"), "utf8")).toBe("{}\n");
  });
});
