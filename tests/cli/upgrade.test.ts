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
const VERIFIED = "/opt/homebrew/bin/liftoff upgrade --verify --json";
/** What the upgraded copy's --verify reports. */
const verified = (
  outcome: string,
  version: string,
  { ok = true, channel = "homebrew-cask", name = "voyager163/tap/liftoff" } = {},
) =>
  printed(
    JSON.stringify({
      schema: "liftoff.upgrade/v1",
      outcome,
      version,
      verified: ok,
      installed: { channel, name },
    }),
  );

// A global npm install, which is not a channel Liftoff supports.
const NODE = "/usr/local/bin/node";
const NPM_APP = "/Users/p/.npm-global/lib/node_modules/@voyager163/liftoff";
const npm = () => {
  const install = new FakeInstall({
    platform: "darwin",
    app: NPM_APP,
    executable: NODE,
    files: { [NPM_APP]: "" },
    env: { PATH: "/Users/p/.npm-global/bin:/usr/bin" },
  });
  install.latest = LATEST;
  return install;
};

// The MSI, installed for the runner's user.
const MSI_BUNDLE = "C:\\Users\\r\\AppData\\Local\\Programs\\Liftoff";
const POWERSHELL = `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -Command ${MSI_PRODUCTS_SCRIPT}`;
const WINDOWS_APPS = "C:\\Users\\r\\AppData\\Local\\Microsoft\\WindowsApps";
const WINGET = `${WINDOWS_APPS}\\winget.exe`;
const WINGET_LIST = `${WINGET} list --id voyager163.liftoff --exact --source winget --disable-interactivity`;
const WINGET_SHOW = `${WINGET} show --id voyager163.liftoff --exact --source winget --versions --disable-interactivity`;
/** `winget show --versions` output, with its heading in the user's language. */
const versions = (heading = "Version", ...listed: string[]) =>
  printed(
    `Found Liftoff [voyager163.liftoff]\r\n${heading}\r\n-------\r\n${listed.join("\r\n")}\r\n`,
  );
const products = (location = `${MSI_BUNDLE}\\`) =>
  printed(JSON.stringify([{ code: "{P}", version: "0.1.0", location, assignment: "0" }]));
const msi = (answers: Record<string, Answer> = {}, pathEntry = `${MSI_BUNDLE}\\bin`) => {
  const install = new FakeInstall({
    platform: "win32",
    app: `${MSI_BUNDLE}\\lib\\app`,
    executable: `${MSI_BUNDLE}\\bin\\liftoff.exe`,
    env: { Path: `${pathEntry};${WINDOWS_APPS}`, PATHEXT: ".EXE;.CMD", SystemRoot: "C:\\Windows" },
    files: {
      [WINGET]: "",
      [`${MSI_BUNDLE}\\release.json`]: RELEASE,
      [`${MSI_BUNDLE}\\bin\\liftoff.exe`]: "",
      "C:\\Other\\liftoff.exe": "",
    },
    answers: {
      [POWERSHELL]: products(),
      // WinGet's "no installed package found", as Windows reports it.
      [WINGET_LIST]: printed("", 0x8a150014),
      ...answers,
    },
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
                  linked_keg: installed,
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
    const upgraded = formula("0.1.0_1");
    await exec(upgraded, ["upgrade", "--yes"]);
    expect(upgraded.delegated).toEqual([
      {
        command: BREW,
        args: ["upgrade", "liftoff"],
        env: { HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: "1" },
      },
    ]);
    // Another revision of the same version is another keg.
    const revision = await exec(formula("0.1.0_2"), ["upgrade", "--check"]);
    expect(revision.report.installed.channel).toBe("unknown");
    const unlisted = await exec(formula("0.0.1"), ["upgrade", "--check"]);
    expect(unlisted.report.installed.channel).toBe("unknown");
  });

  it("tells an MSI installed by hand from one WinGet installed, by Windows Installer's record", async () => {
    const byHand = await exec(msi(), ["upgrade", "--check"]);
    expect(byHand.report.installed).toMatchObject({ channel: "msi", recorded: "0.1.0" });
    expect(byHand.report.upgradable).toBe(false);
    const byWinget = msi({
      [WINGET_LIST]: printed("liftoff voyager163.liftoff 0.1.0 0.2.0 winget"),
      [WINGET_SHOW]: versions("Version", "0.1.0", "0.2.0"),
    });
    const { report, code } = await exec(byWinget, ["upgrade", "--check"]);
    expect(code).toBe(3);
    expect(report.installed).toMatchObject({ channel: "winget", offered: "0.2.0" });
  });

  it("fails rather than guess when WinGet cannot be asked", async () => {
    for (const answer of [printed("", 1), undefined]) {
      const { code, report } = await exec(msi({ [WINGET_LIST]: answer }), ["upgrade", "--check"]);
      expect(code).toBe(1);
      expect(report.installed).toMatchObject({ channel: "msi", recorded: "0.1.0" });
      expect(report.installed.offerProblem).toMatch(/^winget list (exited 1|could not run)/);
    }
    const signed = await exec(msi({ [WINGET_LIST]: printed("", 0x8a150014 - 2 ** 32) }), [
      "upgrade",
      "--check",
    ]);
    expect(signed.code).toBe(0);
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

  it("reports a global npm install as no channel's, and asks npm nothing", async () => {
    const install = npm();
    const { report } = await exec(install, ["upgrade", "--check"]);
    expect(report.installed).toMatchObject({ channel: "unknown", location: NPM_APP });
    expect(report.installed.reason).toContain("an npm install");
    expect(install.queries).toEqual([]);
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

  it("fails when the channel cannot say what it offers, rather than calling it current", async () => {
    const refused = msi({
      [WINGET_LIST]: printed("winget"),
      [WINGET_SHOW]: { exitCode: 1, stdout: "", stderr: "No package found\r\n" },
    });
    const shown = await text(refused, ["upgrade", "--check"]);
    expect(shown.code).toBe(1);
    expect(shown.out).toContain(
      "WinGet could not say which version it offers: winget show --versions exited 1: No package found.",
    );
    const timedOut = msi({ [WINGET_LIST]: printed("winget"), [WINGET_SHOW]: undefined });
    const { code, report } = await exec(timedOut, ["upgrade", "--check"]);
    expect(code).toBe(1);
    expect(report.installed.offerProblem).toBe("winget show --versions could not run");
    const quietWinget = msi({ [WINGET_LIST]: printed("winget"), [WINGET_SHOW]: printed("", 1) });
    expect((await exec(quietWinget, ["upgrade", "--yes"])).code).toBe(1);
    expect(quietWinget.handedOff).toEqual([]);
  });

  it("reads WinGet's versions whatever language it prints its headings in", async () => {
    const spanish = msi({
      [WINGET_LIST]: printed("winget"),
      [WINGET_SHOW]: versions("Versión", "0.1.0", "0.3.0-rc.1", "0.2.0"),
    });
    const { code, report } = await exec(spanish, ["upgrade", "--check"]);
    expect(code).toBe(3);
    expect(report.installed.offered).toBe("0.3.0-rc.1");
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
  });

  it("changes nothing for a copy no channel can upgrade", async () => {
    for (const install of [msi(), npm()]) {
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
    expect(stale.out).toContain(
      "did not verify itself: homebrew-cask 0.1.0 (failure); run liftoff upgrade --verify.",
    );
    // An archive on PATH at the offered version cannot verify itself.
    const unsupported = await text(
      cask({
        [VERIFIED]: verified("unsupported", "0.2.0", { ok: false, channel: "archive", name: "" }),
      }),
      ["upgrade", "--yes"],
    );
    expect(unsupported.code).toBe(3);
    expect(unsupported.out).toContain("archive 0.2.0 (unsupported, not verified)");
    // Nor does another channel's copy that verified itself.
    const other = await exec(
      cask({
        [VERIFIED]: verified("success", "0.2.0", { channel: "homebrew-formula", name: "liftoff" }),
      }),
      ["upgrade", "--yes"],
    );
    expect(other.code).toBe(3);
    // brew may install something newer than it offered before its update.
    const newer = await exec(cask({ [VERIFIED]: verified("success", "0.3.0") }), [
      "upgrade",
      "--yes",
    ]);
    expect(newer.code).toBe(0);
    expect(newer.report.verification).toMatchObject({ verified: true, version: "0.3.0" });
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
    const install = cask();
    install.env.PATH = "/opt/homebrew/bin:/usr/bin";
    const { code, report } = await exec(install, ["upgrade", "--verify"]);
    expect(report.verified).toBe(false);
    expect(code).toBe(1);
    install.links["/opt/homebrew/bin/liftoff"] = `${CASK_BUNDLE}/bin/liftoff`;
    expect((await exec(install, ["upgrade", "--verify"])).code).toBe(3);
  });

  it("checks the version Homebrew links, not the one it is run from", async () => {
    const app = "/opt/homebrew/Cellar/liftoff/0.1.0/libexec/lib/node_modules/@voyager163/liftoff";
    const unlinked = new FakeInstall({
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
                versions: { stable: "0.2.0" },
                installed: [{ version: "0.1.0" }, { version: "0.2.0" }],
                linked_keg: "0.2.0",
              },
            ],
          }),
        ),
      },
    });
    const { code, report } = await exec(unlinked, ["upgrade", "--verify"]);
    expect(code).toBe(1);
    expect(report.checks[0].detail).toBe(
      "homebrew-formula records 0.2.0 linked, not 0.1.0, but 0.1.0 is running",
    );
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
      [WINGET_SHOW]: versions("Versión", "0.2.0"),
    });
    const shown = await text(install, ["upgrade", "--yes"]);
    expect(shown.code).toBe(3);
    expect(install.handedOff).toEqual([
      {
        command: WINGET,
        args: ["upgrade", "--id", "voyager163.liftoff", "--exact", "--source", "winget"],
      },
    ]);
    expect(install.delegated).toEqual([]);
    expect(shown.out).toContain("run: liftoff upgrade --verify");
  });

  it("reports a cancel, not a failure, when it is stopped during the upgrade", async () => {
    const io = captureIo("/work");
    const install = cask();
    install.delegate = async () => {
      io.controller.abort();
      return null;
    };
    const code = await runCli(
      ["upgrade", "--yes", "--json"],
      io,
      [makeUpgradeCommand(() => install)],
      "0.1.0",
    );
    expect(code).toBe(4);
    expect(io.err.join("")).toContain("stopped while Homebrew was upgrading Liftoff");
  });

  it("starts nothing when it is stopped while finding the channel", async () => {
    const io = captureIo("/work");
    const install = cask();
    const brewInfo = `${BREW} info --json=v2 --installed --cask`;
    const answer = install.answers[brewInfo];
    install.answers[brewInfo] = undefined;
    const query = install.query.bind(install);
    install.query = async (command, args) => {
      io.controller.abort();
      return [command, ...args].join(" ") === brewInfo ? answer : query(command, args);
    };
    const code = await runCli(
      ["upgrade", "--yes"],
      io,
      [makeUpgradeCommand(() => install)],
      "0.1.0",
    );
    expect(code).toBe(4);
    expect(install.delegated).toEqual([]);
  });
});
