// Signs and notarizes a macOS bundle from build-bundle.ts (DIST-005):
//
//   node scripts/package/sign-macos.ts <bundle directory>
//
// The Release workflow runs it with the release environment's signing
// secrets (SIGNING_SECRETS in macos-signing.ts). With none of them set the
// bundle is left unsigned, so it can be released only as a prerelease; with
// some but not all, it fails.
//
// The certificate goes into a keychain of its own, made for this run and
// deleted after it. Every Mach-O file is signed with the hardened runtime
// and a secure timestamp, the executable with distribution/macos's
// entitlements. A ZIP of the bundle goes to Apple's notary service, which
// must accept it with no issue. A bare executable cannot be stapled, so
// Gatekeeper looks the ticket up online. Only then does release.json name
// the signer.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  developerIdentity,
  machOFiles,
  notarizationProblems,
  signingSecrets,
} from "./macos-signing.ts";

const root = path.resolve(import.meta.dirname, "../..");
const entitlements = path.join(root, "distribution", "macos", "entitlements.plist");

/**
 * Runs a tool, quietly. A failure names only the step, with the tool's own
 * output: the error execFileSync makes would print the arguments, passwords
 * among them.
 */
const tool = (step: string, command: string, args: string[]): string => {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    throw new Error(`${step} failed\n${stdout}${stderr}`.trim());
  }
};

const bundle = path.resolve(process.argv[2] ?? "");
const identityFile = path.join(bundle, "release.json");
const identity = JSON.parse(readFileSync(identityFile, "utf8")) as {
  target: string;
  signed: { macos: string | null; windows: string | null };
};
if (process.platform !== "darwin" || !identity.target.endsWith("-apple-darwin")) {
  throw new Error(`${bundle} is not a macOS bundle, or this is not macOS`);
}
const secrets = signingSecrets(process.env);
if (secrets === null) {
  console.log(
    "::warning::no macOS signing secrets are set, so the bundle stays unsigned and can be released only as a prerelease",
  );
  process.exit(0);
}

const work = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "liftoff-sign-"));
chmodSync(work, 0o700);
const keychain = path.join(work, "signing.keychain-db");
const certificate = path.join(work, "certificate.p12");
const notaryKey = path.join(work, "notary-key.p8");
const searchList = tool("Reading the keychain search list", "security", [
  "list-keychains",
  "-d",
  "user",
])
  .split("\n")
  .map((line) => line.trim().replace(/^"|"$/g, ""))
  .filter(Boolean);
try {
  writeFileSync(certificate, Buffer.from(secrets.MACOS_CERTIFICATE_P12, "base64"), { mode: 0o600 });
  writeFileSync(notaryKey, secrets.APPLE_NOTARY_KEY_P8, { mode: 0o600 });

  // A keychain of its own, unlocked for this run, that codesign may use
  // without a prompt.
  const password = randomBytes(32).toString("hex");
  tool("Creating the keychain", "security", ["create-keychain", "-p", password, keychain]);
  tool("Setting the keychain to lock", "security", [
    "set-keychain-settings",
    "-lut",
    "3600",
    keychain,
  ]);
  tool("Unlocking the keychain", "security", ["unlock-keychain", "-p", password, keychain]);
  tool("Importing the certificate", "security", [
    "import",
    certificate,
    "-k",
    keychain,
    "-f",
    "pkcs12",
    "-P",
    secrets.MACOS_CERTIFICATE_PASSWORD,
    "-T",
    "/usr/bin/codesign",
  ]);
  rmSync(certificate);
  tool("Letting codesign use the key", "security", [
    "set-key-partition-list",
    "-S",
    "apple-tool:,apple:,codesign:",
    "-s",
    "-k",
    password,
    keychain,
  ]);
  tool("Adding the keychain to the search list", "security", [
    "list-keychains",
    "-d",
    "user",
    "-s",
    keychain,
    ...searchList,
  ]);
  const signer = developerIdentity(
    tool("Finding the signing identity", "security", [
      "find-identity",
      "-v",
      "-p",
      "codesigning",
      keychain,
    ]),
  );

  const files = machOFiles(bundle);
  if (!files.some(({ kind }) => kind === "executable")) {
    throw new Error(`${bundle} has no Mach-O executable to sign`);
  }
  for (const { file, kind } of files) {
    const name = path.relative(bundle, file);
    tool(`Signing ${name}`, "codesign", [
      "--force",
      "--sign",
      signer.hash,
      "--keychain",
      keychain,
      "--options",
      "runtime",
      "--timestamp",
      ...(kind === "executable" ? ["--entitlements", entitlements] : []),
      file,
    ]);
    tool(`Checking the signature of ${name}`, "codesign", [
      "--verify",
      "--strict",
      "--verbose=2",
      file,
    ]);
    console.log(`signed ${name}`);
  }

  // notarytool takes a ZIP, never a tar.gz. ditto keeps the bundle's own
  // directory, so the ticket names paths as the archive does.
  const zip = path.join(work, `${path.basename(bundle)}.zip`);
  tool("Zipping the bundle", "ditto", ["-c", "-k", "--keepParent", bundle, zip]);
  const credentials = [
    "--key",
    notaryKey,
    "--key-id",
    secrets.APPLE_NOTARY_KEY_ID,
    "--issuer",
    secrets.APPLE_NOTARY_ISSUER_ID,
  ];
  const submission = JSON.parse(
    tool("Notarizing the bundle", "xcrun", [
      "notarytool",
      "submit",
      zip,
      ...credentials,
      "--wait",
      "--timeout",
      "30m",
      "--output-format",
      "json",
    ]),
  ) as { id?: string; status?: string; message?: string };
  if (submission.id === undefined || !/^[0-9a-f-]{36}$/.test(submission.id)) {
    throw new Error(`notarytool named no submission: ${JSON.stringify(submission)}`);
  }
  const log = JSON.parse(
    tool("Reading the notary log", "xcrun", ["notarytool", "log", submission.id, ...credentials]),
  );
  const signed = files.map(({ file }) =>
    path.posix.join(path.basename(bundle), ...path.relative(bundle, file).split(path.sep)),
  );
  const problems = notarizationProblems(submission, log, signed);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  console.log(`notarized as ${submission.id}`);

  writeFileSync(
    identityFile,
    `${JSON.stringify({ ...identity, signed: { ...identity.signed, macos: signer.name } }, null, 2)}\n`,
  );
  console.log(`${path.basename(bundle)} is signed by ${signer.name}`);
} finally {
  // The search list as it was, and nothing of the secrets left behind,
  // whichever step failed.
  const attempt = (step: () => unknown) => {
    try {
      step();
    } catch (error) {
      console.error((error as Error).message);
    }
  };
  attempt(() =>
    tool("Restoring the keychain search list", "security", [
      "list-keychains",
      "-d",
      "user",
      "-s",
      ...searchList,
    ]),
  );
  attempt(() => tool("Deleting the keychain", "security", ["delete-keychain", keychain]));
  rmSync(work, { recursive: true, force: true });
}
