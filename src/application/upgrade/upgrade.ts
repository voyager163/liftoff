// `liftoff upgrade`: which channel installed the running Liftoff, what is
// released and what that channel offers, and the channel's own upgrade
// (UPGRADE-001 to UPGRADE-004). It never switches channel, installs a
// package manager, upgrades anything but Liftoff, elevates or touches a
// project. Every program it runs is named by its absolute path.
import path from "node:path";
import {
  brewPackage,
  brewVersion,
  type Channel,
  caskPlace,
  cellarPlace,
  commandCandidates,
  type Invocation,
  LATEST_RELEASE_URL,
  MSI_PRODUCTS_SCRIPT,
  msiProducts,
  npmCliCandidates,
  npmListedVersion,
  npmViewVersion,
  PACKAGE_NAME,
  RELEASES_PAGE,
  samePath,
  WINGET_ID,
  wingetNewestVersion,
  within,
} from "../../domain/install/channels.ts";
import { isNewer, parseVersion } from "../../domain/install/version.ts";
import type { InstallPorts, QueryResult } from "../ports.ts";

/** The channel's upgrade command, and whether it must replace the running executable. */
export interface UpgradeInvocation extends Invocation {
  /** True when it runs on its own after Liftoff exits, so the executable is not in use. */
  readonly handOff: boolean;
  /** The upgraded copy, run with `upgrade --verify --json` to verify itself; none for a hand-off. */
  readonly verifier?: Invocation;
}

/** The running Liftoff, as the channel that installed it records it. */
export interface Install {
  readonly channel: Channel;
  /** The bundle's root, or the npm package's directory. */
  readonly location: string;
  /** The channel's own name for it, such as voyager163/tap/liftoff. */
  readonly name?: string;
  /** The version the channel's record holds; an MSI holds only X.Y.Z. */
  readonly recorded?: string;
  /** What the channel offers to upgrade to, when it could be asked. */
  readonly offered?: string;
  /** Why the channel could not say what it offers, when it could not. */
  readonly offerProblem?: string;
  /** How Liftoff knows the channel, or why it cannot tell or upgrade it. */
  readonly reason: string;
  /** The channel's own upgrade, when it has one. */
  readonly upgrade?: UpgradeInvocation;
  /** Directories a `liftoff` on PATH may resolve into and still be this install. */
  readonly roots: readonly string[];
  /** Launchers outside those that the channel itself wrote for this install. */
  readonly launchers?: readonly string[];
}

/** The newest published release on GitHub, if there is one, or why it could not be read. */
export type Latest =
  | { readonly kind: "release"; readonly version: string; readonly url: string }
  | { readonly kind: "none" }
  | { readonly kind: "unknown"; readonly reason: string };

/** What `liftoff upgrade` found. */
export interface UpgradeStatus {
  readonly version: string;
  readonly install: Install;
  readonly latest: Latest;
}

const pathsOf = (ports: InstallPorts) => (ports.platform === "win32" ? path.win32 : path.posix);

/** Why a query gave nothing usable, from what it printed. */
const failed = (what: string, result: QueryResult | undefined): string => {
  if (result === undefined) return `${what} could not run`;
  const said = (result.stderr || result.stdout).trim().split(/\r?\n/).at(-1);
  return `${what} exited ${result.exitCode}${said ? `: ${said}` : ""}`;
};

/** Finds which channel installed the running copy, from that channel's own records. */
export async function findInstall(ports: InstallPorts, version: string): Promise<Install> {
  const { platform } = ports;
  const paths = pathsOf(ports);
  const { app, executable } = await ports.running();
  if (await ports.exists(paths.join(app, ".git"))) {
    return {
      channel: "source",
      location: app,
      reason: "Liftoff is running from a Git checkout; update it with Git.",
      roots: [app],
    };
  }
  const bundle = paths.dirname(paths.dirname(executable));
  if (
    samePath(platform, paths.join(bundle, "lib", "app"), app) &&
    (await isBundle(ports, paths.join(bundle, "release.json")))
  ) {
    return platform === "darwin" ? macBundle(ports, bundle) : windowsBundle(ports, bundle);
  }
  const cellar = platform === "darwin" ? cellarPlace(app) : undefined;
  if (cellar !== undefined) return cellarFormula(ports, app, cellar);
  return npmInstall(ports, app, executable, version);
}

/** Whether a bundle's release.json is Liftoff's. */
const isBundle = async (ports: InstallPorts, releaseJson: string): Promise<boolean> => {
  const text = await ports.readText(releaseJson);
  try {
    return (JSON.parse(text ?? "") as { schema?: unknown }).schema === "liftoff.release/v1";
  } catch {
    return false;
  }
};

const unknown = (location: string, reason: string): Install => ({
  channel: "unknown",
  location,
  reason,
  roots: [location],
});

const brewInstalled = async (
  ports: InstallPorts,
  brew: string,
  kind: "cask" | "formula",
  name: string,
) => {
  if (!(await ports.exists(brew))) return undefined;
  const result = await ports.query(brew, [
    "info",
    "--json=v2",
    "--installed",
    kind === "cask" ? "--cask" : "--formula",
  ]);
  return result?.exitCode === 0 ? brewPackage(result.stdout, kind, name) : undefined;
};

/** The `liftoff` Homebrew links into its prefix, which verifies the upgrade. */
const brewVerifier = (prefix: string): Invocation => ({
  command: path.posix.join(prefix, "bin", "liftoff"),
  args: ["upgrade", "--verify", "--json"],
});

async function cellarFormula(
  ports: InstallPorts,
  app: string,
  cellar: { prefix: string; name: string; version: string },
): Promise<Install> {
  const brew = path.posix.join(cellar.prefix, "bin", "brew");
  const found = await brewInstalled(ports, brew, "formula", cellar.name);
  if (!found?.installed.map(brewVersion).includes(brewVersion(cellar.version))) {
    return unknown(
      app,
      `Liftoff is in Homebrew's Cellar at ${app}, but brew does not list it there.`,
    );
  }
  return {
    channel: "homebrew-formula",
    location: app,
    name: found.fullName,
    // The version brew links, which a new terminal runs; none when it links none.
    recorded: found.linked === undefined ? "none linked" : brewVersion(found.linked),
    offered: brewVersion(found.offered),
    reason: `Homebrew installed it as the formula ${found.fullName}.`,
    upgrade: {
      command: brew,
      args: ["upgrade", found.fullName],
      handOff: false,
      verifier: brewVerifier(cellar.prefix),
    },
    roots: [app],
  };
}

async function macBundle(ports: InstallPorts, bundle: string): Promise<Install> {
  const cask = caskPlace(bundle);
  if (cask === undefined) return archive(bundle);
  const brew = path.posix.join(cask.prefix, "bin", "brew");
  const found = await brewInstalled(ports, brew, "cask", cask.token);
  if (found === undefined || !found.installed.includes(cask.version)) {
    return unknown(
      bundle,
      `Liftoff is in Homebrew's Caskroom at ${bundle}, but brew does not list it there.`,
    );
  }
  return {
    channel: "homebrew-cask",
    location: bundle,
    name: found.fullName,
    recorded: brewVersion(cask.version),
    offered: brewVersion(found.offered),
    reason: `Homebrew installed it as the cask ${found.fullName}.`,
    upgrade: {
      command: brew,
      args: ["upgrade", "--cask", found.fullName],
      handOff: false,
      verifier: brewVerifier(cask.prefix),
    },
    roots: [bundle],
  };
}

const archive = (bundle: string): Install => ({
  channel: "archive",
  location: bundle,
  reason: `Liftoff was unpacked by hand at ${bundle}, so nothing records it; download a newer archive from ${RELEASES_PAGE}.`,
  roots: [bundle],
});

/** Windows PowerShell, which every Windows has, by its absolute path. */
const powershell = (ports: InstallPorts): string =>
  path.win32.join(
    ports.env.SystemRoot ?? ports.env.SYSTEMROOT ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );

/** WinGet's winget.exe on PATH, by its absolute path, if it is there. */
async function wingetPath(ports: InstallPorts): Promise<string | undefined> {
  for (const candidate of commandCandidates("win32", "winget", ports.env)) {
    // An App Execution Alias, which is not a file a link can be followed to.
    if (candidate.endsWith(".exe") && (await ports.exists(candidate))) return candidate;
  }
  return undefined;
}

async function windowsBundle(ports: InstallPorts, bundle: string): Promise<Install> {
  const listed = await ports.query(powershell(ports), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    MSI_PRODUCTS_SCRIPT,
  ]);
  const products = listed?.exitCode === 0 ? msiProducts(listed.stdout) : undefined;
  if (products === undefined) {
    return unknown(
      bundle,
      `Windows Installer could not be asked which Liftoff is installed (${failed("PowerShell", listed)}).`,
    );
  }
  const product = products.find((candidate) => samePath("win32", candidate.location, bundle));
  if (product === undefined) return archive(bundle);
  const winget = await wingetPath(ports);
  const scoped = ["--id", WINGET_ID, "--exact", "--source", "winget"];
  const byWinget =
    winget === undefined
      ? undefined
      : await ports.query(winget, ["list", ...scoped, "--disable-interactivity"]);
  if (winget === undefined || byWinget?.exitCode !== 0) {
    return {
      channel: "msi",
      location: bundle,
      recorded: product.version,
      reason: `Liftoff was installed from its MSI, which WinGet does not list; install a newer MSI from ${RELEASES_PAGE}.`,
      roots: [bundle],
    };
  }
  // The versions table: its headings are in the user's language, its values are not.
  const shown = await ports.query(winget, [
    "show",
    ...scoped,
    "--versions",
    "--disable-interactivity",
  ]);
  const offered = shown?.exitCode === 0 ? wingetNewestVersion(shown.stdout) : undefined;
  return {
    channel: "winget",
    location: bundle,
    name: WINGET_ID,
    recorded: product.version,
    ...(offered === undefined
      ? { offerProblem: failed("winget show --versions", shown) }
      : { offered }),
    reason: `WinGet installed it as ${WINGET_ID}.`,
    upgrade: { command: winget, args: ["upgrade", ...scoped], handOff: true },
    roots: [bundle],
  };
}

async function npmInstall(
  ports: InstallPorts,
  app: string,
  node: string,
  version: string,
): Promise<Install> {
  const { platform } = ports;
  const paths = pathsOf(ports);
  let cli: string | undefined;
  for (const candidate of npmCliCandidates(platform, node)) {
    const real = await ports.realPath(candidate);
    if (real !== undefined && paths.basename(real) === "npm-cli.js") {
      cli = real;
      break;
    }
  }
  const nobody = `Liftoff is running from ${app}, which no channel records, such as a project's own node_modules.`;
  if (cli === undefined) return unknown(app, nobody);
  const pathFirst = [paths.dirname(node)];
  const npm = (...args: string[]) => ports.query(node, [cli, ...args], pathFirst);
  const root = (await npm("root", "--global"))?.stdout.trim();
  const installed = root ? await ports.realPath(paths.join(root, PACKAGE_NAME)) : undefined;
  if (root === undefined || installed === undefined || !samePath(platform, installed, app)) {
    return unknown(app, nobody);
  }
  const listed = await npm("ls", "--global", "--json", "--depth=0");
  const recorded = listed === undefined ? undefined : npmListedVersion(listed.stdout);
  const viewed = await npm("view", PACKAGE_NAME, "version", "--json");
  const offered = viewed?.exitCode === 0 ? npmViewVersion(viewed.stdout) : undefined;
  // npm writes liftoff.cmd and its siblings into the prefix on Windows; on
  // macOS bin/liftoff links into the package.
  const prefix = platform === "win32" ? await ports.realPath(paths.dirname(root)) : undefined;
  return {
    channel: "npm",
    location: app,
    name: PACKAGE_NAME,
    ...(recorded === undefined ? {} : { recorded }),
    ...(offered === undefined ? { offerProblem: failed("npm view", viewed) } : { offered }),
    reason: `npm installed it globally, with the npm of the Node at ${node}.`,
    ...(offered === undefined || !isNewer(offered, version)
      ? {}
      : {
          upgrade: {
            command: node,
            args: [cli, "install", "--global", `${PACKAGE_NAME}@${offered}`],
            pathFirst,
            handOff: false,
            // npm replaces the package in place.
            verifier: {
              command: node,
              args: [paths.join(app, "dist", "cli", "main.js"), "upgrade", "--verify", "--json"],
              pathFirst,
            },
          },
        }),
    roots: [app],
    ...(prefix === undefined
      ? {}
      : {
          launchers: ["liftoff", "liftoff.cmd", "liftoff.ps1"].map((name) =>
            paths.join(prefix, name),
          ),
        }),
  };
}

/** The newest published, non-prerelease release on GitHub. */
export async function latestRelease(ports: InstallPorts): Promise<Latest> {
  try {
    const release = (await ports.fetchJson(LATEST_RELEASE_URL)) as
      | { tag_name?: unknown; html_url?: unknown }
      | undefined;
    if (release === undefined) return { kind: "none" };
    const tag = typeof release.tag_name === "string" ? release.tag_name : "";
    const version = tag.replace(/^v/, "");
    if (parseVersion(version) === undefined || typeof release.html_url !== "string") {
      return { kind: "unknown", reason: `GitHub's latest release has the tag "${tag}"` };
    }
    return { kind: "release", version, url: release.html_url };
  } catch (error) {
    return { kind: "unknown", reason: (error as Error).message };
  }
}

/** Which channel has the running copy, and what is released. */
export async function upgradeStatus(ports: InstallPorts, version: string): Promise<UpgradeStatus> {
  const [install, latest] = await Promise.all([findInstall(ports, version), latestRelease(ports)]);
  return { version, install, latest };
}

/** True when the channel that owns the running copy offers a newer version. */
export const upgradable = (status: UpgradeStatus): boolean =>
  status.install.upgrade !== undefined && isNewer(status.install.offered, status.version);

/** True when GitHub has a newer release than the running copy. */
export const released = (status: UpgradeStatus): boolean =>
  status.latest.kind === "release" && isNewer(status.latest.version, status.version);

/** One thing `--verify` checks. */
export interface Check {
  readonly name: "record" | "path";
  readonly ok: boolean;
  readonly detail: string;
}

/** The X.Y.Z of a version: all an MSI records. */
const core = (version: string) => /^\d+\.\d+\.\d+/.exec(version)?.[0] ?? version;

/**
 * Checks that the channel records the running version, and that a new
 * terminal's `liftoff` is this copy. Undefined for a copy no channel
 * records, which has nothing to check against.
 */
export async function verifyInstall(
  ports: InstallPorts,
  status: UpgradeStatus,
): Promise<readonly Check[] | undefined> {
  const { install, version } = status;
  if (install.recorded === undefined) return undefined;
  const recordsCore = install.channel === "msi" || install.channel === "winget";
  const expected = recordsCore ? core(version) : version;
  const checks: Check[] = [
    {
      name: "record",
      ok: install.recorded === expected,
      detail:
        install.recorded === expected
          ? `${install.channel} records ${install.recorded}`
          : `${install.channel} records ${install.recorded}, but ${version} is running`,
    },
  ];
  let found: string | undefined;
  for (const candidate of commandCandidates(ports.platform, "liftoff", ports.env)) {
    found = await ports.realPath(candidate);
    if (found !== undefined) break;
  }
  const ours =
    found !== undefined &&
    (install.roots.some((root) => within(ports.platform, root, found)) ||
      (install.launchers ?? []).some((launcher) => samePath(ports.platform, launcher, found)));
  checks.push({
    name: "path",
    ok: ours,
    detail:
      found === undefined
        ? "no liftoff is on PATH"
        : ours
          ? `liftoff on PATH is this copy, at ${found}`
          : `liftoff on PATH is ${found}, not this copy in ${install.location}`,
  });
  return checks;
}

/** What the upgraded copy's `liftoff upgrade --verify --json` reported. */
export interface Verified {
  readonly outcome: string;
  /** True only when it verified itself against its channel's record and PATH. */
  readonly verified: boolean;
  readonly version?: string;
  readonly channel?: string;
  readonly name?: string;
}

/** Reads the upgraded copy's report, or undefined when it is not one. */
function verifiedReport(stdout: string): Verified | undefined {
  try {
    const report = JSON.parse(stdout) as Record<string, unknown>;
    const installed = (report.installed ?? {}) as Record<string, unknown>;
    if (report.schema !== "liftoff.upgrade/v1" || typeof report.outcome !== "string") {
      return undefined;
    }
    const field = (value: unknown) => (typeof value === "string" ? value : undefined);
    const version = field(report.version);
    const channel = field(installed.channel);
    const name = field(installed.name);
    return {
      outcome: report.outcome,
      verified: report.verified === true,
      ...(version === undefined ? {} : { version }),
      ...(channel === undefined ? {} : { channel }),
      ...(name === undefined ? {} : { name }),
    };
  } catch {
    return undefined;
  }
}

/** True when the copy that verified itself is the upgraded one, newer than `from`. */
export const landed = (install: Install, from: string, verified: Verified | undefined): boolean =>
  verified !== undefined &&
  verified.verified &&
  verified.outcome !== "failure" &&
  verified.channel === install.channel &&
  verified.name === install.name &&
  isNewer(verified.version, from);

/**
 * Runs the channel's upgrade. One that replaces this executable is handed
 * off and not waited for; otherwise the upgraded copy verifies itself and
 * its report is returned.
 */
export async function runUpgrade(
  ports: InstallPorts,
  upgrade: UpgradeInvocation,
): Promise<
  | { readonly kind: "handed-off" }
  | { readonly kind: "failed"; readonly exitCode: number | null }
  | { readonly kind: "done"; readonly verified?: Verified }
> {
  if (upgrade.handOff) {
    await ports.handOff(upgrade.command, upgrade.args);
    return { kind: "handed-off" };
  }
  const exitCode = await ports.delegate(upgrade.command, upgrade.args, upgrade.pathFirst);
  if (exitCode !== 0) return { kind: "failed", exitCode };
  if (upgrade.verifier === undefined) return { kind: "done" };
  const result = await ports.query(
    upgrade.verifier.command,
    upgrade.verifier.args,
    upgrade.verifier.pathFirst,
  );
  const verified = result === undefined ? undefined : verifiedReport(result.stdout);
  return verified === undefined ? { kind: "done" } : { kind: "done", verified };
}
