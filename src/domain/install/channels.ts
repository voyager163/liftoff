// How each channel that installs Liftoff records what it installed, and the
// one command each offers to upgrade it (UPGRADE-001, UPGRADE-003). Pure:
// the facts come in as text that a channel's own tools printed.
import path from "node:path";
import { isNewer, parseVersion } from "./version.ts";

export const PACKAGE_NAME = "@voyager163/liftoff";
export const REPOSITORY = "voyager163/liftoff";
export const WINGET_ID = "voyager163.liftoff";
/** The UpgradeCode every Liftoff MSI shares (distribution/windows/liftoff.wxs). */
export const MSI_UPGRADE_CODE = "{60D7F28B-CC6D-4476-B93F-20A568C637F2}";
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases`;

export type Platform = "darwin" | "win32";

/**
 * Who installed the running Liftoff, as its own records say:
 * - homebrew-cask, homebrew-formula: Homebrew, from a tap or homebrew/core;
 * - winget: the WinGet package, which installed the MSI;
 * - msi: the MSI, installed by hand;
 * - npm: a global npm install;
 * - archive: a release archive unpacked by hand;
 * - source: a Git checkout;
 * - unknown: anything else, such as a project's own node_modules.
 */
export type Channel =
  | "homebrew-cask"
  | "homebrew-formula"
  | "winget"
  | "msi"
  | "npm"
  | "archive"
  | "source"
  | "unknown";

/** A program and its arguments, run without a shell. */
export interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
  /** Entries to put first on PATH, so the program finds the same tools. */
  readonly pathFirst?: readonly string[];
}

const pathFor = (platform: Platform) => (platform === "win32" ? path.win32 : path.posix);

/** True when `child` is `parent` or inside it, comparing as the platform does. */
export function within(platform: Platform, parent: string, child: string): boolean {
  const paths = pathFor(platform);
  const fold = (value: string) =>
    platform === "win32" ? paths.resolve(value).toLowerCase() : paths.resolve(value);
  const relative = paths.relative(fold(parent), fold(child));
  return relative === "" || (!relative.startsWith("..") && !paths.isAbsolute(relative));
}

export const samePath = (platform: Platform, a: string, b: string): boolean =>
  within(platform, a, b) && within(platform, b, a);

/** Where a bundle is in Homebrew's Caskroom: `<prefix>/Caskroom/<token>/<version>/…`. */
export function caskPlace(
  bundle: string,
): { prefix: string; token: string; version: string } | undefined {
  const match = /^(\/.*)\/Caskroom\/([^/]+)\/([^/]+)(?:\/|$)/.exec(bundle);
  return match === null
    ? undefined
    : { prefix: match[1] as string, token: match[2] as string, version: match[3] as string };
}

/**
 * Where an npm package is in Homebrew's Cellar, as a formula built with
 * std_npm_args installs it: `<prefix>/Cellar/<name>/<version>/libexec/lib/node_modules/<package>`.
 */
export function cellarPlace(
  app: string,
): { prefix: string; name: string; version: string } | undefined {
  const match =
    /^(\/.*)\/Cellar\/([^/]+)\/([^/]+)\/libexec\/lib\/node_modules\/@voyager163\/liftoff$/.exec(
      app,
    );
  return match === null
    ? undefined
    : { prefix: match[1] as string, name: match[2] as string, version: match[3] as string };
}

/** A Homebrew cask or formula as `brew info --json=v2 --installed` describes it. */
export interface BrewPackage {
  /** The name to upgrade it by, with its tap unless it is from homebrew/core or homebrew/cask. */
  readonly fullName: string;
  readonly tap: string;
  readonly installed: readonly string[];
  /** The installed version Homebrew links, for a formula; a cask has only one. */
  readonly linked?: string;
  /** The newest version the tap offers, as of the last `brew update`. */
  readonly offered: string;
}

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Homebrew's version without the revision or anything after a comma, as `1.2.0_1` or `1.2.0,42`. */
export const brewVersion = (version: string): string => version.replace(/(_\d+)?(,.*)?$/, "");

/** The installed cask `token` or formula `name` in `brew info --json=v2 --installed` output. */
export function brewPackage(
  json: string,
  kind: "cask" | "formula",
  name: string,
): BrewPackage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (kind === "cask") {
    const cask = list(object(parsed).casks)
      .map(object)
      .find((entry) => entry.token === name);
    const installed = text(cask?.installed);
    const fullName = text(cask?.full_token);
    const offered = text(cask?.version);
    if (cask === undefined || installed === undefined || fullName === undefined || !offered) {
      return undefined;
    }
    return { fullName, tap: text(cask.tap) ?? "", installed: [installed], offered };
  }
  const formula = list(object(parsed).formulae)
    .map(object)
    .find((entry) => entry.name === name);
  const fullName = text(formula?.full_name);
  const offered = text(object(formula?.versions).stable);
  if (formula === undefined || fullName === undefined || offered === undefined) return undefined;
  const installed = list(formula.installed)
    .map((entry) => text(object(entry).version))
    .filter((version): version is string => version !== undefined);
  const linked = text(formula.linked_keg);
  return {
    fullName,
    tap: text(formula.tap) ?? "",
    installed,
    ...(linked === undefined ? {} : { linked }),
    offered,
  };
}

/** A product Windows Installer has with Liftoff's UpgradeCode. */
export interface MsiProduct {
  readonly code: string;
  readonly version: string;
  readonly location: string;
  /** "0" when installed for the user, "1" for the machine. */
  readonly assignment: string;
}

/**
 * The PowerShell that lists the products with Liftoff's UpgradeCode, through
 * Windows Installer itself, as JSON. Windows PowerShell 5.1 cannot call the
 * Installer's methods by name, so each goes through InvokeMember, and the
 * list it returns is read by its Count and Item. -InputObject keeps none or
 * one a list.
 */
export const MSI_PRODUCTS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$installer = New-Object -ComObject WindowsInstaller.Installer",
  "function Get-Property($object, $name, $arguments) {",
  "  $object.GetType().InvokeMember($name, 'GetProperty', $null, $object, $arguments)",
  "}",
  `$codes = Get-Property $installer 'RelatedProducts' @('${MSI_UPGRADE_CODE}')`,
  "$count = Get-Property $codes 'Count' $null",
  "$products = @(for ($index = 0; $index -lt $count; $index++) {",
  "  $code = Get-Property $codes 'Item' @($index)",
  "  [pscustomobject]@{",
  "    code = $code",
  "    version = Get-Property $installer 'ProductInfo' @($code, 'VersionString')",
  "    location = Get-Property $installer 'ProductInfo' @($code, 'InstallLocation')",
  "    assignment = Get-Property $installer 'ProductInfo' @($code, 'AssignmentType')",
  "  }",
  "})",
  "ConvertTo-Json -Compress -InputObject $products",
].join("\n");

/** The products MSI_PRODUCTS_SCRIPT printed, or undefined when it printed something else. */
export function msiProducts(json: string): MsiProduct[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const products = parsed.map(object).map((entry) => ({
    code: text(entry.code),
    version: text(entry.version),
    location: text(entry.location),
    assignment: text(entry.assignment) ?? String(entry.assignment),
  }));
  return products.every(
    (product) =>
      product.code !== undefined && product.version !== undefined && product.location !== undefined,
  )
    ? (products as MsiProduct[])
    : undefined;
}

/**
 * The newest version in `winget show --versions` output: the values under
 * the line of dashes, whatever language its heading is in.
 */
export function wingetNewestVersion(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const rule = lines.findIndex((line) => /^-{3,}$/.test(line));
  if (rule === -1) return undefined;
  let newest: string | undefined;
  for (const line of lines.slice(rule + 1)) {
    if (parseVersion(line) !== undefined && (newest === undefined || isNewer(line, newest))) {
      newest = line;
    }
  }
  return newest;
}

/** Liftoff's version in `npm ls -g --json --depth=0` output. */
export function npmListedVersion(json: string): string | undefined {
  try {
    return text(object(object(object(JSON.parse(json)).dependencies)[PACKAGE_NAME]).version);
  } catch {
    return undefined;
  }
}

/** The version `npm view <package> version --json` printed. */
export function npmViewVersion(json: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    return text(Array.isArray(parsed) ? parsed.at(-1) : parsed);
  } catch {
    return undefined;
  }
}

/**
 * Where the npm that ships with a Node may be: beside node.exe on Windows,
 * under the prefix's lib/ for the official macOS archive and Homebrew's
 * Node, and wherever the npm beside node links to.
 */
export function npmCliCandidates(platform: Platform, node: string): string[] {
  const paths = pathFor(platform);
  const directory = paths.dirname(node);
  const cli = ["node_modules", "npm", "bin", "npm-cli.js"];
  return platform === "win32"
    ? [paths.join(directory, ...cli)]
    : [
        paths.join(directory, "..", "lib", ...cli),
        paths.join(directory, "..", "libexec", "lib", ...cli),
        paths.join(directory, "npm"),
      ];
}

/** Where a command named `name` could be on PATH, in the order a shell looks. */
export function commandCandidates(
  platform: Platform,
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const value = (key: string) =>
    Object.entries(env).find(([candidate]) => candidate.toUpperCase() === key)?.[1];
  const paths = pathFor(platform);
  const directories = (value("PATH") ?? "")
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry !== "" && paths.isAbsolute(entry));
  const extensions =
    platform === "win32"
      ? (value("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  return directories.flatMap((directory) =>
    extensions.map((extension) => paths.join(directory, `${name}${extension.toLowerCase()}`)),
  );
}
