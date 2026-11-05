import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  cleanUpSigning,
  developerIdentity,
  entitlementKeys,
  entitlementsPlist,
  machOFiles,
  machOKind,
  notarizationProblems,
  SIGNING_SECRETS,
  signingSecrets,
  sipEnabled,
} from "../../scripts/package/macos-signing.ts";

const root = path.resolve(import.meta.dirname, "../..");
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** The first bytes of a thin 64-bit Mach-O of a file type (2 is an executable). */
const thin = (filetype: number) => {
  const header = Buffer.alloc(64);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(filetype, 12);
  return header;
};
/** A fat file whose first slice, at `at`, is `slice`. */
const fat = (slice: Buffer, slices = 2, at = 4096) => {
  const header = Buffer.alloc(at + slice.length);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(slices, 4);
  header.writeUInt32BE(at, 16);
  slice.copy(header, at);
  return header;
};
/** Reads a buffer as machOKind reads a file. */
const kind = (bytes: Buffer) =>
  machOKind((offset, length) => bytes.subarray(offset, offset + length));

describe("DIST-005 the macOS bundle is signed and notarized", () => {
  const all = Object.fromEntries(SIGNING_SECRETS.map((name) => [name, `${name}-value`]));

  it("signs with all five secrets, leaves the bundle unsigned with none, and fails with some", () => {
    expect(signingSecrets(all)).toEqual(all);
    expect(signingSecrets({})).toBeNull();
    expect(signingSecrets({ MACOS_CERTIFICATE_P12: "" })).toBeNull();
    expect(() => signingSecrets({ ...all, APPLE_NOTARY_KEY_ID: "" })).toThrow(
      "the release environment is missing APPLE_NOTARY_KEY_ID",
    );
  });

  it("signs with the one Developer ID Application identity the certificate holds", () => {
    const hash = "A".repeat(40);
    const listing = [
      `  1) ${hash} "Developer ID Application: Example (TEAM123456)"`,
      `  2) ${"B".repeat(40)} "Apple Development: Example (OTHER12345)"`,
      "     2 valid identities found",
    ].join("\n");
    expect(developerIdentity(listing)).toEqual({
      hash,
      name: "Developer ID Application: Example (TEAM123456)",
    });
    expect(() => developerIdentity("     0 valid identities found")).toThrow("not 0");
    const two = `${listing}\n  3) ${"C".repeat(40)} "Developer ID Application: Other (TEAM654321)"`;
    expect(() => developerIdentity(two)).toThrow("not 2");
  });

  it("finds every Mach-O file, libraries before the executable that loads them", () => {
    expect(kind(thin(2))).toBe("executable");
    expect(kind(thin(8))).toBe("library");
    expect(kind(fat(thin(2)))).toBe("executable");
    // However far in the first slice starts.
    expect(kind(fat(thin(8), 2, 0x10000))).toBe("library");
    expect(kind(fat(thin(8), 2, 0x40000))).toBe("library");
    // A Java class file starts as a fat file does, with a version for a count.
    expect(kind(fat(thin(2), 52))).toBeNull();
    // A fat header pointing past the end of the file.
    expect(kind(fat(thin(2)).subarray(0, 64))).toBeNull();
    expect(kind(Buffer.from("#!/bin/sh\necho not a Mach-O binary at all\n"))).toBeNull();
    expect(kind(Buffer.alloc(8))).toBeNull();

    const bundle = realpathSync(mkdtempSync(path.join(tmpdir(), "liftoff-macho-")));
    temporary.push(bundle);
    const write = (file: string, bytes: Buffer) => {
      mkdirSync(path.dirname(path.join(bundle, file)), { recursive: true });
      writeFileSync(path.join(bundle, file), bytes);
    };
    write("bin/liftoff", thin(2));
    write("lib/app/node_modules/a/build/addon.node", thin(8));
    write("lib/app/node_modules/b/lib.dylib", fat(thin(6), 2, 0x10000));
    write("lib/app/dist/cli/main.js", Buffer.from("export {};\n".repeat(8)));
    expect(machOFiles(bundle).map(({ file, kind }) => [path.relative(bundle, file), kind])).toEqual(
      [
        [path.join("lib", "app", "node_modules", "a", "build", "addon.node"), "library"],
        [path.join("lib", "app", "node_modules", "b", "lib.dylib"), "library"],
        [path.join("bin", "liftoff"), "executable"],
      ],
    );
  });

  it("takes notarization only when Apple accepts it with no issue and tickets every signed file", () => {
    const signed = ["liftoff-package-aarch64-apple-darwin/bin/liftoff"];
    const ticket = [{ path: "bundle.zip/liftoff-package-aarch64-apple-darwin/bin/liftoff" }];
    const accepted = { status: "Accepted", issues: null, ticketContents: ticket };
    expect(notarizationProblems({ status: "Accepted" }, accepted, signed)).toEqual([]);
    expect(
      notarizationProblems({ status: "Invalid", message: "Processing complete" }, accepted, signed),
    ).toEqual(["notarization ended Invalid: Processing complete"]);
    expect(
      notarizationProblems(
        { status: "Accepted" },
        { ...accepted, issues: [{ path: "bundle.zip/x", message: "no secure timestamp" }] },
        signed,
      ),
    ).toEqual(["notarization issue in bundle.zip/x: no secure timestamp"]);
    expect(
      notarizationProblems({ status: "Accepted" }, { ...accepted, ticketContents: [] }, signed),
    ).toEqual([
      "the notarization ticket does not cover liftoff-package-aarch64-apple-darwin/bin/liftoff",
    ]);
    expect(notarizationProblems({}, {}, [])).toEqual([
      "notarization ended without a status:",
      "the notary log says nothing",
    ]);
  });

  it("shows each entitlement is needed only where SIP is known to be on, and never guesses", () => {
    const said = (stdout: string, status = 0) => ({ status, stdout });
    expect(sipEnabled(said("System Integrity Protection status: enabled.\n"))).toBe(true);
    expect(sipEnabled(said("System Integrity Protection status: disabled.\n"))).toBe(false);
    expect(() =>
      sipEnabled({ error: new Error("spawnSync csrutil ENOENT"), status: null, stdout: null }),
    ).toThrow("csrutil could not run: spawnSync csrutil ENOENT");
    expect(() => sipEnabled(said("System Integrity Protection status: enabled.\n", 1))).toThrow(
      "is unknown",
    );
    expect(() =>
      sipEnabled(said("System Integrity Protection status: unknown (Custom Configuration).\n")),
    ).toThrow("is unknown");
    expect(() => sipEnabled(said(""))).toThrow("is unknown");
  });

  it("removes the keychain and keys even when the signing job is cancelled", () => {
    const text = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
    const steps =
      (
        parse(text) as {
          jobs: Record<string, { steps: { name?: string; if?: string; run?: string }[] }>;
        }
      ).jobs.bundle?.steps ?? [];
    const names = steps.map((step) => step.name);
    const cleanup = steps.find((step) => step.name === "Remove the signing keychain and keys");
    expect(cleanup?.if).toBe("always() && runner.os == 'macOS'");
    expect(cleanup?.run).toBe("node scripts/package/sign-macos.ts --cleanup");
    expect(names.indexOf("Remove the signing keychain and keys")).toBe(
      names.indexOf("Sign and notarize the macOS bundle") + 1,
    );
    // What cleanup undoes is recorded before any secret is written.
    const script = readFileSync(path.join(root, "scripts/package/sign-macos.ts"), "utf8");
    expect(script.indexOf('"cleanup.json"), JSON.stringify')).toBeLessThan(
      script.indexOf("writeFileSync(certificate"),
    );
  });

  it("keeps the cleanup record until the keychain is gone and the search list restored", () => {
    const work = realpathSync(mkdtempSync(path.join(tmpdir(), "liftoff-sign-")));
    temporary.push(work);
    const keychain = path.join(work, "signing.keychain-db");
    for (const file of [keychain, path.join(work, "notary-key.p8")]) writeFileSync(file, "x");
    writeFileSync(
      path.join(work, "cleanup.json"),
      JSON.stringify({ keychain, searchList: ["/login.keychain-db"] }),
    );
    const calls: string[][] = [];
    let failing = true;
    const security = (step: string, args: string[]) => {
      calls.push(args);
      if (failing && args[0] === "list-keychains") throw new Error(`${step} failed`);
      if (args[0] === "delete-keychain") rmSync(keychain);
    };
    expect(() => cleanUpSigning(work, security)).toThrow(
      "cleanup is incomplete, so " +
        path.join(work, "cleanup.json") +
        " is kept for another try:\nRestoring the keychain search list failed",
    );
    // The key file is gone at once, and the keychain was still deleted.
    expect(readdirSync(work).sort()).toEqual(["cleanup.json"]);
    expect(calls.map((args) => args[0])).toEqual(["list-keychains", "delete-keychain"]);
    failing = false;
    cleanUpSigning(work, security);
    expect(calls.at(-1)).toEqual(["list-keychains", "-d", "user", "-s", "/login.keychain-db"]);
    expect(existsSync(work)).toBe(false);
    // Nothing recorded: nothing to undo but the directory.
    mkdirSync(work);
    cleanUpSigning(work, () => {
      throw new Error("not called");
    });
    expect(existsSync(work)).toBe(false);
  });

  it("trusts only Apple's own Developer ID intermediate, and keeps the secrets from every tool", () => {
    const script = readFileSync(path.join(root, "scripts/package/sign-macos.ts"), "utf8");
    const pinned = /INTERMEDIATE_SHA256 = "([0-9a-f]{64})"/.exec(script)?.[1];
    const authority = readFileSync(path.join(root, "distribution/macos/DeveloperIDG2CA.cer"));
    expect(createHash("sha256").update(authority).digest("hex")).toBe(pinned);
    expect(script).toContain("env: toolEnv");
  });

  it("grants the executable allow-jit and nothing more", () => {
    const plist = readFileSync(path.join(root, "distribution/macos/entitlements.plist"), "utf8");
    expect(entitlementKeys(plist)).toEqual(["com.apple.security.cs.allow-jit"]);
    expect(entitlementKeys(entitlementsPlist(["a", "b"]))).toEqual(["a", "b"]);
    expect(entitlementKeys(entitlementsPlist([]))).toEqual([]);
  });

  it("signs in the approved release environment, giving the secrets to the signing step alone", () => {
    const text = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
    const bundle = (
      parse(text) as {
        jobs: Record<
          string,
          {
            environment?: string;
            steps: { name?: string; if?: string; run?: string; env?: Record<string, string> }[];
          }
        >;
      }
    ).jobs.bundle;
    expect(bundle?.environment).toBe("release");
    const steps = bundle?.steps ?? [];
    const sign = steps.find((step) => step.name === "Sign and notarize the macOS bundle");
    expect(sign?.if).toBe("runner.os == 'macOS'");
    expect(sign?.run).toBe('node scripts/package/sign-macos.ts "out/$BUNDLE"');
    expect(Object.keys(sign?.env ?? {})).toEqual([...SIGNING_SECRETS]);
    expect(text.match(/\$\{\{ secrets\./g)).toHaveLength(SIGNING_SECRETS.length);
    // Signed after it is built and before it is archived.
    const names = steps.map((step) => step.name);
    expect(names.indexOf("Build the bundle from the package")).toBeLessThan(
      names.indexOf("Sign and notarize the macOS bundle"),
    );
    expect(names.indexOf("Sign and notarize the macOS bundle")).toBeLessThan(
      names.indexOf("Archive the bundle"),
    );
  });

  it("checks the downloaded bundle's signature, entitlements and notarization, quarantined when signed", () => {
    const text = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
    expect(text).toContain('codesign --verify --strict --verbose=2 "$file"');
    // One file at a time, so a universal file's per-architecture lines are not names.
    expect(text).toContain("file -b \"$file\" | head -n 1 | grep -q '^Mach-O'");
    expect(text).not.toContain("xargs -0 file");
    expect(text).toContain('grep -Fxq "Authority=$signer"');
    expect(text).toContain("flags=0x10000\\(runtime\\)");
    expect(text).toContain("'{\"com.apple.security.cs.allow-jit\":true}'");
    expect(text).toContain("codesign --verify --strict --check-notarization -R=notarized");
    expect(text).not.toContain("spctl");
    // Only a signed bundle is quarantined: an unsigned one is not notarized.
    expect(text).toContain('if [ "$RUNNER_OS" = macOS ] && [ -n "$signer" ]; then');
    expect(text).toContain("xattr -w com.apple.quarantine");
    const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain('node scripts/package/check-entitlements.ts "out/$BUNDLE"');
  });
});
