import { LocalInstall } from "../../adapters/install.ts";
import type { InstallPorts } from "../../application/ports.ts";
import {
  landed,
  released,
  runUpgrade,
  type UpgradeStatus,
  upgradable,
  upgradeStatus,
  verifyInstall,
} from "../../application/upgrade/upgrade.ts";
import type { Channel } from "../../domain/install/channels.ts";
import type { CommandResult, CommandSpec, Io } from "../command.ts";
import { CancelledError, UsageError } from "../outcome.ts";
import { shown } from "../terminal.ts";

const CHANNELS: Record<Channel, string> = {
  "homebrew-cask": "Homebrew",
  "homebrew-formula": "Homebrew",
  winget: "WinGet",
  msi: "its MSI",
  npm: "npm",
  archive: "a release archive",
  source: "a Git checkout",
  unknown: "no channel Liftoff knows",
};

/** A command line as a person would type it. */
const commandLine = (command: string, args: readonly string[]) =>
  [command, ...args].map((word) => (/[\s"]/.test(word) ? JSON.stringify(word) : word)).join(" ");

/** What the JSON report says about what was found. */
function reported(status: UpgradeStatus) {
  const { install, latest } = status;
  return {
    version: status.version,
    installed: {
      channel: install.channel,
      location: install.location,
      ...(install.name === undefined ? {} : { name: install.name }),
      ...(install.recorded === undefined ? {} : { recorded: install.recorded }),
      ...(install.offered === undefined ? {} : { offered: install.offered }),
      ...(install.offerProblem === undefined ? {} : { offerProblem: install.offerProblem }),
      reason: install.reason,
    },
    latest,
    released: released(status),
    upgradable: upgradable(status),
    ...(upgradable(status) && install.upgrade !== undefined
      ? { command: [install.upgrade.command, ...install.upgrade.args] }
      : {}),
  };
}

/** The status, in the words the text shows it. */
export function renderStatus(status: UpgradeStatus): string[] {
  const { install, latest, version } = status;
  const lines = [
    install.channel === "unknown" || install.channel === "source"
      ? `Liftoff ${version} is running from ${install.location}.`
      : `Liftoff ${version} was installed by ${CHANNELS[install.channel]}, in ${install.location}.`,
    `  ${install.reason}`,
  ];
  if (latest.kind === "release") {
    lines.push(`The latest release is ${latest.version}: ${latest.url}`);
  } else if (latest.kind === "none") {
    lines.push("GitHub has no published release of Liftoff yet.");
  } else {
    lines.push(`The latest release could not be read: ${latest.reason}.`);
  }
  if (upgradable(status) && install.upgrade !== undefined) {
    lines.push(
      `${CHANNELS[install.channel]} offers ${install.offered}; it upgrades with:`,
      `  ${commandLine(install.upgrade.command, install.upgrade.args)}`,
    );
  } else if (install.offerProblem !== undefined) {
    lines.push(
      `${CHANNELS[install.channel]} could not say which version it offers: ${install.offerProblem}.`,
    );
  } else if (install.upgrade !== undefined) {
    lines.push(
      `${CHANNELS[install.channel]} offers ${install.offered}, so there is nothing to upgrade${
        released(status) ? " until it offers the latest release" : ""
      }.`,
    );
  }
  return lines.map(shown);
}

export function makeUpgradeCommand(
  portsFor: (io: Io) => InstallPorts = (io) => new LocalInstall({ signal: io.signal }),
): CommandSpec {
  return {
    path: ["upgrade"],
    summary: "Upgrade Liftoff itself with the channel that installed it.",
    description:
      "Finds which channel installed the running Liftoff from that channel's own records: Homebrew, WinGet, its MSI or npm. It reports the latest release on GitHub apart from what that channel offers, which can lag behind it, and upgrades only with that channel's own command for Liftoff alone: brew upgrade, winget upgrade or npm install --global. It never switches channel, installs a package manager, upgrades anything else, asks for administrator rights or changes a project. It shows the command and asks before running it; the default answer is no. In scripts, pass --yes. On Windows, WinGet replaces liftoff.exe, so Liftoff hands it over and exits; run liftoff upgrade --verify once it finishes. A copy unpacked by hand, a checkout or one no channel records is reported, never changed.",
    readOnly: false,
    reportSchema: "liftoff.upgrade/v1",
    options: {
      check: {
        type: "boolean",
        description:
          "Change nothing; exit 3 when the channel that installed Liftoff offers a newer version.",
      },
      verify: {
        type: "boolean",
        description:
          "Change nothing; check that the channel records this version and that liftoff on PATH is this copy.",
      },
      yes: {
        type: "boolean",
        short: "y",
        description: "Run the channel's upgrade without asking.",
      },
    },
    examples: ["liftoff upgrade --check", "liftoff upgrade", "liftoff upgrade --verify"],
    async run(args, { io, version }): Promise<CommandResult> {
      const verify = args.options.verify === true;
      const check = args.options.check === true;
      const yes = args.options.yes === true;
      if (verify && (check || yes)) {
        throw new UsageError(`--verify goes without --${check ? "check" : "yes"}`);
      }
      if (check && yes) throw new UsageError("--check changes nothing, so it goes without --yes");
      const ports = portsFor(io);
      const status = await upgradeStatus(ports, version);
      const lines = renderStatus(status);

      if (verify) {
        const checks = await verifyInstall(ports, status);
        if (checks === undefined) {
          return {
            outcome: "unsupported",
            report: { ...reported(status), verified: false },
            text: `${[...lines, "No channel records this copy, so there is nothing to verify it against."].join("\n")}\n`,
          };
        }
        const ok = checks.every((entry) => entry.ok);
        return {
          outcome: !ok ? "failure" : released(status) ? "attention" : "success",
          report: { ...reported(status), verified: ok, checks },
          text: `${[
            ...lines,
            ...checks.map((entry) => shown(`  ${entry.ok ? "ok  " : "FAIL"} ${entry.detail}`)),
          ].join("\n")}\n`,
        };
      }

      const upgrade = status.install.upgrade;
      if (check || !upgradable(status) || upgrade === undefined) {
        return {
          // A channel that could not say what it offers is not up to date.
          outcome:
            status.install.offerProblem !== undefined
              ? "failure"
              : check && upgradable(status)
                ? "attention"
                : "success",
          report: { ...reported(status), upgraded: false },
          text: `${lines.join("\n")}\n`,
        };
      }

      io.stderr(`${lines.join("\n")}\n`);
      if (!yes) {
        if (!io.interactive) {
          throw new UsageError(
            "upgrade runs the channel's upgrade; pass --yes to confirm when no one can answer a prompt",
          );
        }
        if (!(await io.confirm(`Run ${commandLine(upgrade.command, upgrade.args)}?`))) {
          return {
            outcome: "cancelled",
            report: { ...reported(status), upgraded: false },
            text: "Nothing was changed.\n",
          };
        }
      }
      // Stopped while Liftoff was finding the channel or asking: run nothing.
      if (io.signal.aborted) throw new CancelledError("stopped before the upgrade started");
      const result = await runUpgrade(ports, upgrade);
      // Stopped while the channel was upgrading, which may have changed something.
      if (io.signal.aborted) {
        throw new CancelledError(
          `stopped while ${CHANNELS[status.install.channel]} was upgrading Liftoff; run liftoff upgrade --verify`,
        );
      }
      if (result.kind === "handed-off") {
        return {
          outcome: "attention",
          report: { ...reported(status), upgraded: "handed-off" },
          text: `${CHANNELS[status.install.channel]} is upgrading Liftoff in its own window. When it finishes, open a new terminal and run: liftoff upgrade --verify\n`,
        };
      }
      if (result.kind === "failed") {
        return {
          outcome: "failure",
          report: { ...reported(status), upgraded: false, exitCode: result.exitCode },
          text: `${commandLine(upgrade.command, upgrade.args)} ${
            result.exitCode === null ? "could not run" : `exited ${result.exitCode}`
          }; Liftoff changed nothing itself.\n`,
        };
      }
      const verified = result.verified;
      const done = landed(status.install, version, verified);
      return {
        outcome: done ? "success" : "attention",
        report: {
          ...reported(status),
          upgraded: true,
          ...(verified === undefined ? {} : { verification: verified }),
        },
        text: done
          ? `Upgraded Liftoff to ${verified?.version}.\n`
          : `${CHANNELS[status.install.channel]} finished, but the upgraded Liftoff ${
              verified === undefined
                ? "could not verify itself"
                : `did not verify itself: ${verified.channel ?? "no channel"} ${
                    verified.version ?? "no version"
                  } (${verified.outcome}${verified.verified ? "" : ", not verified"})`
            }; run liftoff upgrade --verify.\n`,
      };
    },
  };
}
