import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  developerIdentity,
  entitlementKeys,
  entitlementsPlist,
  machOFiles,
  machOKind,
  notarizationProblems,
  SIGNING_SECRETS,
  signingSecrets,
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
/** A fat file whose first slice, at 4096, is `slice`. */
const fat = (slice: Buffer, slices = 2) => {
  const header = Buffer.alloc(4096 + slice.length);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(slices, 4);
  header.writeUInt32BE(4096, 16);
  slice.copy(header, 4096);
  return header;
};

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
    expect(machOKind(thin(2))).toBe("executable");
    expect(machOKind(thin(8))).toBe("library");
    expect(machOKind(fat(thin(2)))).toBe("executable");
    // A Java class file starts as a fat file does, with a version for a count.
    expect(machOKind(fat(thin(2), 52))).toBeNull();
    expect(machOKind(Buffer.from("#!/bin/sh\necho not a Mach-O binary at all\n"))).toBeNull();
    expect(machOKind(Buffer.alloc(8))).toBeNull();

    const bundle = realpathSync(mkdtempSync(path.join(tmpdir(), "liftoff-macho-")));
    temporary.push(bundle);
    const write = (file: string, bytes: Buffer) => {
      mkdirSync(path.dirname(path.join(bundle, file)), { recursive: true });
      writeFileSync(path.join(bundle, file), bytes);
    };
    write("bin/liftoff", thin(2));
    write("lib/app/node_modules/a/build/addon.node", thin(8));
    write("lib/app/node_modules/b/lib.dylib", fat(thin(6)));
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

  it("checks the downloaded bundle's signature, entitlements and notarization, quarantined", () => {
    const text = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
    expect(text).toContain('codesign --verify --strict --verbose=2 "$file"');
    expect(text).toContain('grep -Fxq "Authority=$signer"');
    expect(text).toContain("flags=0x10000\\(runtime\\)");
    expect(text).toContain("'{\"com.apple.security.cs.allow-jit\":true}'");
    expect(text).toContain("spctl --assess --type open --context context:primary-signature");
    expect(text).toContain("grep -Fq 'source=Notarized Developer ID' spctl.log");
    expect(text).toContain("xattr -w com.apple.quarantine");
    const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain('node scripts/package/check-entitlements.ts "out/$BUNDLE"');
  });
});
