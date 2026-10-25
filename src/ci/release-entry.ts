// Entry point for the bundled release steps (.github/liftoff/release.mjs):
// node release.mjs open-release|identify|manifest|publish|sync
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { COMMANDS, type Command, main } from "./release.ts";

const command = process.argv[2];
if (!(COMMANDS as readonly string[]).includes(command ?? "")) {
  process.stderr.write(`usage: release.mjs ${COMMANDS.join("|")}\n`);
  process.exitCode = 2;
} else {
  process.exitCode = await main(command as Command, {
    env: process.env,
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, text) => writeFileSync(path, text),
    appendFile: (path, text) => appendFileSync(path, text),
    log: (text) => process.stdout.write(text),
  });
}
