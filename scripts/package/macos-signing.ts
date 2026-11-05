// What signing and notarizing the macOS bundle decides (DIST-005), apart
// from the tools that do it, so the tests can check each rule.
import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import path from "node:path";

/** The release environment secrets signing needs, by name. */
export const SIGNING_SECRETS = [
  "MACOS_CERTIFICATE_P12",
  "MACOS_CERTIFICATE_PASSWORD",
  "APPLE_NOTARY_KEY_P8",
  "APPLE_NOTARY_KEY_ID",
  "APPLE_NOTARY_ISSUER_ID",
] as const;
export type SigningSecrets = Record<(typeof SIGNING_SECRETS)[number], string>;

/**
 * The signing secrets, or null when none is set, so the bundle stays
 * unsigned and can be released only as a prerelease. Some but not all is a
 * mistake in the environment, never a reason to ship unsigned.
 */
export function signingSecrets(env: Record<string, string | undefined>): SigningSecrets | null {
  const missing = SIGNING_SECRETS.filter((name) => (env[name] ?? "") === "");
  if (missing.length === SIGNING_SECRETS.length) return null;
  if (missing.length > 0) {
    throw new Error(`the release environment is missing ${missing.join(", ")}`);
  }
  return Object.fromEntries(
    SIGNING_SECRETS.map((name) => [name, env[name] ?? ""]),
  ) as SigningSecrets;
}

/** The one Developer ID Application identity `security find-identity` lists. */
export function developerIdentity(listing: string): { hash: string; name: string } {
  const found = [
    ...listing.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(Developer ID Application: [^"]+)"\s*$/gm),
  ].map(([, hash = "", name = ""]) => ({ hash, name }));
  const unique = new Map(found.map((identity) => [identity.hash, identity]));
  if (unique.size !== 1) {
    throw new Error(
      `the certificate must hold exactly one Developer ID Application identity, not ${unique.size}`,
    );
  }
  return [...unique.values()][0] as { hash: string; name: string };
}

const MH_EXECUTE = 2;

/**
 * What a file's first bytes say it is: a Mach-O executable, another Mach-O
 * (a library or a native addon), or neither. A fat file's first slice
 * decides. Java class files share the fat magic, but never with so few
 * slices.
 */
export function machOKind(header: Buffer): "executable" | "library" | null {
  if (header.length < 32) return null;
  const thin = (at: number): "executable" | "library" | null => {
    const magic = header.readUInt32LE(at);
    if (magic === 0xfeedfacf || magic === 0xfeedface) {
      return header.readUInt32LE(at + 12) === MH_EXECUTE ? "executable" : "library";
    }
    return null;
  };
  const magic = header.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const slices = header.readUInt32BE(4);
    if (slices === 0 || slices > 16) return null;
    // The first fat_arch (or fat_arch_64) follows the 8-byte fat header;
    // its slice offset is the third field.
    const offset =
      magic === 0xcafebabf ? Number(header.readBigUInt64BE(16)) : header.readUInt32BE(16);
    return offset + 16 <= header.length ? thin(offset) : null;
  }
  return thin(0);
}

/**
 * Every Mach-O file under a directory, deepest first and executables last,
 * the order codesign needs: what a file loads is signed before it is.
 */
export function machOFiles(
  root: string,
  read: (file: string, bytes: number) => Buffer = readHead,
): { file: string; kind: "executable" | "library" }[] {
  const found: { file: string; kind: "executable" | "library" }[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        // Room for a fat header and its first slice's header.
        const kind = machOKind(read(file, 64 * 1024));
        if (kind !== null) found.push({ file, kind });
      }
    }
  };
  walk(root);
  const depth = (file: string) => file.split(path.sep).length;
  return found.sort(
    (a, b) =>
      Number(a.kind === "executable") - Number(b.kind === "executable") ||
      depth(b.file) - depth(a.file) ||
      a.file.localeCompare(b.file),
  );
}

const readHead = (file: string, bytes: number): Buffer => {
  const buffer = Buffer.alloc(bytes);
  const descriptor = openSync(file, "r");
  try {
    return buffer.subarray(0, readSync(descriptor, buffer, 0, bytes, 0));
  } finally {
    closeSync(descriptor);
  }
};

interface NotaryLog {
  readonly status?: string;
  readonly issues?: readonly { readonly path?: string; readonly message?: string }[] | null;
  readonly ticketContents?: readonly { readonly path?: string }[] | null;
}

/**
 * Why Apple's answer does not notarize the bundle: the submission must be
 * accepted with no issue at all, warnings included, and its ticket must
 * cover every Mach-O file that was signed, named as in the ZIP.
 */
export function notarizationProblems(
  submission: { readonly status?: string; readonly message?: string },
  log: NotaryLog,
  signed: readonly string[],
): string[] {
  const problems: string[] = [];
  if (submission.status !== "Accepted") {
    problems.push(
      `notarization ended ${submission.status ?? "without a status"}: ${submission.message ?? ""}`.trim(),
    );
  }
  if (log.status !== "Accepted") problems.push(`the notary log says ${log.status ?? "nothing"}`);
  for (const issue of log.issues ?? []) {
    problems.push(`notarization issue in ${issue.path ?? "the bundle"}: ${issue.message ?? ""}`);
  }
  // The log names each file under the ZIP's own name, as in
  // liftoff.zip/liftoff-package-aarch64-apple-darwin/bin/liftoff.
  const ticketed = (log.ticketContents ?? []).map((entry) => entry.path ?? "");
  for (const file of signed) {
    if (!ticketed.some((entry) => entry === file || entry.endsWith(`/${file}`))) {
      problems.push(`the notarization ticket does not cover ${file}`);
    }
  }
  return problems;
}

/** The entitlement keys a property list grants, in order. */
export function entitlementKeys(plist: string): string[] {
  return [...plist.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map(([, key = ""]) => key);
}

/** A property list granting exactly these entitlements. */
export function entitlementsPlist(keys: readonly string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...keys.flatMap((key) => [`  <key>${key}</key>`, "  <true/>"]),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}
