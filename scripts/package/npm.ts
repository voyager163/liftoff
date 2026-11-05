// Runs the npm that ships with the Node running these scripts, through Node
// itself rather than a shell: on Windows npm is a .cmd file, which needs a
// shell, and Node would then neither quote the arguments (paths with spaces
// break) nor keep quiet about it (DEP0190 on stderr).
import { execFileSync, type StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function npmCli(): string {
  const fromScript = process.env.npm_execpath;
  const candidates = [
    ...(fromScript !== undefined && path.basename(fromScript) === "npm-cli.js" ? [fromScript] : []),
    // Windows and the official archives keep npm beside node or under lib/.
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(
      path.dirname(process.execPath),
      "..",
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined)
    throw new Error(`cannot find the npm that ships with ${process.execPath}`);
  return found;
}

export function npm(args: string[], cwd: string, stdio: StdioOptions = "pipe"): string {
  return (
    execFileSync(process.execPath, [npmCli(), ...args], { cwd, encoding: "utf8", stdio }) ?? ""
  );
}
