import { describe, expect, it } from "vitest";
import { makeUpgradeCommand } from "../../src/cli/commands/upgrade.ts";
import { runCli } from "../../src/cli/run.ts";
import { MSI_PRODUCTS_SCRIPT } from "../../src/domain/install/channels.ts";
import { type Answer, FakeInstall, printed } from "../helpers/fake-install.ts";
import { captureIo } from "../helpers/io.ts";

const RELEASE = JSON.stringify({ schema: "liftoff.release/v1" });
const LATEST = {
  tag_name: "v0.2.0",
  html_url: "https://github.com/voyager163/liftoff/releases/v0.2.0",
};

const exec = async (
  install: FakeInstall,
  argv: string[],
  options: { answer?: boolean; version?: string } = {},
) => {
  const io = captureIo("/work", options.answer);
  const code = await runCli(
    [...argv, "--json"],
    io,
    [makeUpgradeCommand(() => install)],
    options.version ?? "0.1.0",
  );
  return {
    code,
    report: JSON.parse(io.out.join("")),
    err: io.err.join(""),
    questions: io.questions,
  };
};
const text = async (install: FakeInstall, argv: string[], version = "0.1.0") => {
  const io = captureIo("/work");
  const code = await runCli(argv, io, [makeUpgradeCommand(() => install)], version);
  return { code, out: io.out.join(""), err: io.err.join("") };
};

// A cask from the tap, installed at 0.1.0, whose tap now offers 0.2.0.
const CASK_BUNDLE = "/opt/homebrew/Caskroom/liftoff/0.1.0/liftoff-package-aarch64-apple-darwin";
const BREW = "/opt/homebrew/bin/brew";
const casks = (installed: string, version = "0.2.0") =>
  printed(
    JSON.stringify({
      formulae: [],
      casks: [
        { token: "other", full_token: "other", tap: "homebrew/cask", version: "1", installed: "1" },
        {
          token: "liftoff",
          full_token: "voyager163/tap/liftoff",
          tap: "voyager163/tap",
          version,
          installed,
        },
      ],
    }),
  );
const cask = (answers: Record<string, Answer> = {}, latest: unknown = LATEST) => {
  const install = new FakeInstall({
    platform: "darwin",
    app: `${CASK_BUNDLE}/lib/app`,
    executable: `${CASK_BUNDLE}/bin/liftoff`,
    files: { [`${CASK_BUNDLE}/release.json`]: RELEASE, [BREW]: "" },
    answers: { [`${BREW} info --json=v2 --installed --cask`]: casks("0.1.0"), ...answers },
  });
  install.latest = latest;
  return install;
};
const VERIFIED = "liftoff upgrade --verify --json";
const verified = (outcome: string, version: string) =>
  printed(JSON.stringify({ schema: "liftoff.upgrade/v1", outcome, version }));

// A global npm install under the Node at /usr/local/bin/node.
const NODE = "/usr/local/bin/node";
const NPM_CLI = "/usr/local/lib/node_modules/npm/bin/npm-cli.js";
const NPM_APP = "/Users/p/.npm-global/lib/node_modules/@voyager163/liftoff";
const npm = (root = "/Users/p/.npm-global/lib/node_modules", listed = "0.1.0") => {
  const install = new FakeInstall({
    platform: "darwin",
    app: NPM_APP,
    executable: NODE,
    files: { [NPM_CLI]: "", [NPM_APP]: "" },
    links: {},
    env: { PATH: "/Users/p/.npm-global/bin:/usr/bin" },
    answers: {
      [`${NODE} ${NPM_CLI} root -g`]: printed(`${root}\n`),
      [`${NODE} ${NPM_CLI} ls -g --json --depth=0`]: printed(
        JSON.stringify({ dependencies: { "@voyager163/liftoff": { version: listed } } }),
      ),
      [`${NODE} ${NPM_CLI} view @voyager163/liftoff version --json`]: printed('"0.2.0"'),
    },
  });
  install.latest = LATEST;
  return install;
};

// The MSI, installed for the runner's user.
const MSI_BUNDLE = "C:\\Users\\r\\AppData\\Local\\Programs\\Liftoff";
const POWERSHELL = `powershell.exe -NoProfile -NonInteractive -Command ${MSI_PRODUCTS_SCRIPT}`;
const WINGET_LIST =
  "winget list --id voyager163.liftoff --exact --source winget --disable-interactivity";
const WINGET_SHOW =
  "winget show --id voyager163.liftoff --exact --source winget --disable-interactivity";
const products = (location = `${MSI_BUNDLE}\\`) =>
  printed(JSON.stringify([{ code: "{P}", version: "0.1.0", location, assignment: "0" }]));
const msi = (answers: Record<string, Answer> = {}, pathEntry = `${MSI_BUNDLE}\\bin`) => {
  const install = new FakeInstall({
    platform: "win32",
    app: `${MSI_BUNDLE}\\lib\\app`,
    executable: `${MSI_BUNDLE}\\bin\\liftoff.exe`,
    env: { Path: pathEntry, PATHEXT: ".EXE;.CMD" },
    files: {
      [`${MSI_BUNDLE}\\release.json`]: RELEASE,
      [`${MSI_BUNDLE}\\bin\\liftoff.exe`]: "",
      "C:\\Other\\liftoff.exe": "",
    },
    answers: { [POWERSHELL]: products(), [WINGET_LIST]: printed("", 1), ...answers },
  });
  return install;
};

describe("UPGRADE-001 Liftoff knows which channel installed it from that channel's own records", () => {
  it("reports a cask that brew lists, with its tap and location", async () => {
    const { report } = await exec(cask(), ["upgrade", "--check"]);
    expect(report.installed).toMatchObject({
      channel: "homebrew-cask",
      location: CASK_BUNDLE,
      name: "voyager163/tap/liftoff",
      recorded: "0.1.0",
      offered: "0.2.0",
    });
  });

  it("does not trust a Caskroom path that brew does not list, or a brew that is gone", async () => {
    const otherVersion = cask({ [`${BREW} info --json=v2 --installed --cask`]: casks("0.0.9") });
    expect((await exec(otherVersion, ["upgrade", "--check"])).report.installed.channel).toBe(
      "unknown",
    );
    const noBrew = new FakeInstall({
      platform: "darwin",
      app: `${CASK_BUNDLE}/lib/app`,
      executable: `${CASK_BUNDLE}/bin/liftoff`,
      files: { [`${CASK_BUNDLE}/release.json`]: RELEASE },
    });
    const { report } = await exec(noBrew, ["upgrade", "--check"]);
    expect(report.installed.channel).toBe("unknown");
    expect(noBrew.queries).toEqual([]);
  });

  it("reports a formula from the Cellar that brew lists", async () => {
    const app = "/opt/homebrew/Cellar/liftoff/0.1.0_1/libexec/lib/node_modules/@voyager163/liftoff";
    const formula = (installed: string) =>
      new FakeInstall({
        platform: "darwin",
        app,
        executable: "/opt/homebrew/Cellar/node/26.12.0/bin/node",
        files: { [BREW]: "" },
        answers: {
          [`${BREW} info --json=v2 --installed --formula`]: printed(
            JSON.stringify({
              formulae: [
                {
                  name: "liftoff",
                  full_name: "liftoff",
                  tap: "homebrew/core",
                  versions: { stable: "0.2.0" },
                  installed: [{ version: installed }],
                },
              ],
              casks: [],
            }),
          ),
        },
      });
    const listed = await exec(formula("0.1.0_1"), ["upgrade", "--check"]);
    expect(listed.code).toBe(3);
    expect(listed.report.installed).toMatchObject({
      channel: "homebrew-formula",
      name: "liftoff",
      recorded: "0.1.0",
      offered: "0.2.0",
    });
    expect(listed.report.command).toEqual([BREW, "upgrade", "liftoff"]);
    const unlisted = await exec(formula("0.0.1"), ["upgrade", "--check"]);
    expect(unlisted.report.installed.channel).toBe("unknown");
  });

  it("tells an MSI installed by hand from one WinGet installed, by Windows Installer's record", async () => {
    const byHand = await exec(msi(), ["upgrade", "--check"]);
    expect(byHand.report.installed).toMatchObject({ channel: "msi", recorded: "0.1.0" });
    expect(byHand.report.upgradable).toBe(false);
    const byWinget = msi({
      [WINGET_LIST]: printed("liftoff voyager163.liftoff 0.1.0 0.2.0 winget"),
      [WINGET_SHOW]: printed("Found Liftoff [voyager163.liftoff]\nVersion: 0.2.0\nPublisher: x\n"),
    });
    const { report, code } = await exec(byWinget, ["upgrade", "--check"]);
    expect(code).toBe(3);
    expect(report.installed).toMatchObject({ channel: "winget", offered: "0.2.0" });
  });

  it("calls a Windows bundle Windows Installer does not record unpacked by hand", async () => {
    const elsewhere = await exec(msi({ [POWERSHELL]: products("C:\\Elsewhere\\") }), [
      "upgrade",
      "--check",
    ]);
    expect(elsewhere.report.installed.channel).toBe("archive");
    const unreadable = await exec(msi({ [POWERSHELL]: printed("not json") }), [
      "upgrade",
      "--check",
    ]);
    expect(unreadable.report.installed.channel).toBe("unknown");
    const failed = await exec(msi({ [POWERSHELL]: undefined }), ["upgrade", "--check"]);
    expect(failed.report.installed.reason).toMatch(/Windows Installer could not be asked/);
  });

  it("reports a global npm install, and not a package in another node_modules", async () => {
    const global = await exec(npm(), ["upgrade", "--check"]);
    expect(global.report.installed).toMatchObject({
      channel: "npm",
      location: NPM_APP,
      recorded: "0.1.0",
      offered: "0.2.0",
    });
    const local = await exec(npm("/Users/p/project/node_modules"), ["upgrade", "--check"]);
    expect(local.report.installed.channel).toBe("unknown");
    const noNpm = new FakeInstall({ platform: "darwin", app: NPM_APP, executable: NODE });
    expect((await exec(noNpm, ["upgrade", "--check"])).report.installed.channel).toBe("unknown");
  });

  it("reports a checkout and a macOS archive by where they are", async () => {
    const checkout = new FakeInstall({
      platform: "darwin",
      app: "/src/liftoff",
      executable: NODE,
      files: { "/src/liftoff/.git": "" },
    });
    expect((await exec(checkout, ["upgrade", "--check"])).report.installed.channel).toBe("source");
    const bundle = "/Users/p/tools/liftoff-package-aarch64-apple-darwin";
    const archive = new FakeInstall({
      platform: "darwin",
      app: `${bundle}/lib/app`,
      executable: `${bundle}/bin/liftoff`,
      files: { [`${bundle}/release.json`]: RELEASE },
    });
    const { report } = await exec(archive, ["upgrade", "--check"]);
    expect(report.installed).toMatchObject({ channel: "archive", location: bundle });
    const notOurs = new FakeInstall({
      platform: "darwin",
      app: `${bundle}/lib/app`,
      executable: `${bundle}/bin/liftoff`,
      files: { [`${bundle}/release.json`]: "{}" },
    });
    expect((await exec(notOurs, ["upgrade", "--check"])).report.installed.channel).toBe("unknown");
  });
});

describe("UPGRADE-002 What is released is reported apart from what the channel offers", () => {
  it("is no upgrade when the channel offers less than is released", async () => {
    const lagging = cask({
      [`${BREW} info --json=v2 --installed --cask`]: casks("0.1.0", "0.1.0"),
    });
    const { code, report } = await exec(lagging, ["upgrade", "--check"]);
    expect(code).toBe(0);
    expect(report).toMatchObject({ released: true, upgradable: false });
    expect(report.latest).toEqual({ kind: "release", version: "0.2.0", url: LATEST.html_url });
    const shown = await text(lagging, ["upgrade"]);
    expect(shown.out).toContain("Homebrew offers 0.1.0, so there is nothing to upgrade until it");
  });

  it("names the command when the channel offers a newer version", async () => {
    const { code, report } = await exec(cask(), ["upgrade", "--check"]);
    expect(code).toBe(3);
    expect(report.command).toEqual([BREW, "upgrade", "--cask", "voyager163/tap/liftoff"]);
    const shown = await text(cask(), ["upgrade", "--check"]);
    expect(shown.out).toContain("Homebrew offers 0.2.0; it upgrades with:");
    expect(shown.out).toContain("The latest release is 0.2.0");
  });

  it("still reports the channel when GitHub cannot be asked or has no release", async () => {
    const offline = await exec(cask({}, new Error("fetch failed")), ["upgrade", "--check"]);
    expect(offline.report.latest).toEqual({ kind: "unknown", reason: "fetch failed" });
    expect(offline.report.installed.channel).toBe("homebrew-cask");
    const unreleased = cask();
    unreleased.latest = undefined;
    const none = await text(unreleased, ["upgrade", "--check"]);
    expect(none.out).toContain("GitHub has no published release of Liftoff yet.");
    const odd = await exec(cask({}, { tag_name: "nightly", html_url: "x" }), [
      "upgrade",
      "--check",
    ]);
    expect(odd.report.latest.kind).toBe("unknown");
    const shown = await text(cask({}, new Error("offline")), ["upgrade", "--check"]);
    expect(shown.out).toContain("The latest release could not be read: offline.");
  });

  it("says when the channel cannot say what it offers", async () => {
    const quiet = npm();
    quiet.answers[`${NODE} ${NPM_CLI} view @voyager163/liftoff version --json`] = printed("", 1);
    const shown = await text(quiet, ["upgrade"]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("npm could not say which version it offers.");
  });
});

describe("UPGRADE-003 Only the owning channel upgrades Liftoff, and only when asked", () => {
  it("runs nothing when the person answers no, or no one can answer", async () => {
    const declined = cask();
    const no = await exec(declined, ["upgrade"], { answer: false });
    expect(no.code).toBe(4);
    expect(no.questions).toEqual([
      "Run /opt/homebrew/bin/brew upgrade --cask voyager163/tap/liftoff?",
    ]);
    expect(declined.delegated).toEqual([]);
    const unattended = cask();
    const refused = await exec(unattended, ["upgrade"]);
    expect(refused.code).toBe(2);
    expect(unattended.delegated).toEqual([]);
  });

  it("runs only the channel's own upgrade, for Liftoff alone", async () => {
    const brew = cask({ [VERIFIED]: verified("success", "0.2.0") });
    const done = await exec(brew, ["upgrade"], { answer: true });
    expect(done.code).toBe(0);
    expect(brew.delegated).toEqual([
      { command: BREW, args: ["upgrade", "--cask", "voyager163/tap/liftoff"] },
    ]);
    const viaNpm = npm();
    await exec(viaNpm, ["upgrade", "--yes"]);
    expect(viaNpm.delegated).toEqual([
      {
        command: NODE,
        args: [NPM_CLI, "install", "--global", "@voyager163/liftoff@0.2.0"],
        pathFirst: ["/usr/local/bin"],
      },
    ]);
  });

  it("changes nothing for a copy no channel can upgrade", async () => {
    for (const install of [msi(), npm("/elsewhere")]) {
      const { code, report } = await exec(install, ["upgrade", "--yes"]);
      expect(code).toBe(0);
      expect(report.upgraded).toBe(false);
      expect(install.delegated).toEqual([]);
      expect(install.handedOff).toEqual([]);
    }
  });

  it("reports the exit code of a channel's upgrade that fails", async () => {
    const failing = cask();
    failing.delegateExit = 1;
    const { code, report } = await exec(failing, ["upgrade", "--yes"]);
    expect(code).toBe(1);
    expect(report).toMatchObject({ upgraded: false, exitCode: 1 });
    failing.delegateExit = null;
    const shown = await text(failing, ["upgrade", "--yes"]);
    expect(shown.out).toContain("could not run; Liftoff changed nothing itself.");
  });

  it("refuses options that contradict each other", async () => {
    expect((await exec(cask(), ["upgrade", "--verify", "--yes"])).code).toBe(2);
    expect((await exec(cask(), ["upgrade", "--verify", "--check"])).code).toBe(2);
    expect((await exec(cask(), ["upgrade", "--check", "--yes"])).code).toBe(2);
  });
});

describe("UPGRADE-004 An upgrade is verified, and WinGet's is handed over", () => {
  it("succeeds when the upgraded copy verifies itself, and says when it does not", async () => {
    const landed = await text(cask({ [VERIFIED]: verified("success", "0.2.0") }), [
      "upgrade",
      "--yes",
    ]);
    expect(landed.code).toBe(0);
    expect(landed.out).toBe("Upgraded Liftoff to 0.2.0.\n");
    const stale = await text(cask({ [VERIFIED]: verified("failure", "0.1.0") }), [
      "upgrade",
      "--yes",
    ]);
    expect(stale.code).toBe(3);
    expect(stale.out).toContain("reports 0.1.0 (failure); run liftoff upgrade --verify.");
    const silent = await exec(cask({ [VERIFIED]: printed("not json") }), ["upgrade", "--yes"]);
    expect(silent.code).toBe(3);
    expect(silent.report.upgraded).toBe(true);
  });

  it("verifies the X.Y.Z an MSI records, and that liftoff on PATH is this copy", async () => {
    const ok = await exec(msi(), ["upgrade", "--verify"], { version: "0.1.0-rc.2" });
    expect(ok.code).toBe(0);
    expect(ok.report.checks).toEqual([
      { name: "record", ok: true, detail: "msi records 0.1.0" },
      {
        name: "path",
        ok: true,
        detail: `liftoff on PATH is this copy, at ${MSI_BUNDLE}\\bin\\liftoff.exe`,
      },
    ]);
    const shadowed = await exec(msi({}, "C:\\Other"), ["upgrade", "--verify"]);
    expect(shadowed.code).toBe(1);
    expect(shadowed.report.checks[1].detail).toMatch(/liftoff on PATH is C:\\Other\\liftoff.exe/);
    const missing = await exec(msi({}, "C:\\Nowhere"), ["upgrade", "--verify"]);
    expect(missing.report.checks[1].detail).toBe("no liftoff is on PATH");
    const older = await text(msi(), ["upgrade", "--verify"], "0.0.9");
    expect(older.code).toBe(1);
    expect(older.out).toContain("FAIL msi records 0.1.0, but 0.0.9 is running");
  });

  it("asks for an upgrade when the verified copy is older than the latest release", async () => {
    const install = npm();
    const { code, report } = await exec(install, ["upgrade", "--verify"]);
    expect(report.verified).toBe(false);
    expect(code).toBe(1);
    install.links["/Users/p/.npm-global/bin/liftoff"] = `${NPM_APP}/dist/cli/main.js`;
    expect((await exec(install, ["upgrade", "--verify"])).code).toBe(3);
  });

  it("has nothing to verify a copy no channel records against", async () => {
    const checkout = new FakeInstall({
      platform: "darwin",
      app: "/src/liftoff",
      executable: NODE,
      files: { "/src/liftoff/.git": "" },
    });
    const { code, report } = await exec(checkout, ["upgrade", "--verify"]);
    expect(code).toBe(6);
    expect(report.verified).toBe(false);
  });

  it("hands WinGet's upgrade over and asks for --verify afterwards", async () => {
    const install = msi({
      [WINGET_LIST]: printed("winget"),
      [WINGET_SHOW]: printed("Version: 0.2.0\n"),
    });
    const shown = await text(install, ["upgrade", "--yes"]);
    expect(shown.code).toBe(3);
    expect(install.handedOff).toEqual([
      {
        command: "winget",
        args: ["upgrade", "--id", "voyager163.liftoff", "--exact", "--source", "winget"],
      },
    ]);
    expect(install.delegated).toEqual([]);
    expect(shown.out).toContain("run: liftoff upgrade --verify");
  });
});
