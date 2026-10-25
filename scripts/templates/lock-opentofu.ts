// Regenerates the canonical OpenTofu provider locks for the Azure
// infrastructure template: one for bootstrap and one for the environment
// roots, each pinning the providers their versions.tf names, with hashes for
// every platform a project is checked on: macOS arm64, Windows x64 and the
// Linux x64 CI runners. Choose new provider versions with the same 7-day
// cooldown as the other templates, and edit versions.tf first.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const template = path.join(root, "assets/plugins/infrastructure-azure");
const roots = {
  bootstrap: path.join(template, "files/infrastructure/opentofu/azure/bootstrap/versions.tf"),
  environment: path.join(template, "environment/versions.tf"),
};
const PLATFORMS = ["darwin_arm64", "windows_amd64", "linux_amd64"];

for (const [kind, versions] of Object.entries(roots)) {
  // Only the required_providers block: the rest of versions.tf names a backend
  // and variables this scratch directory does not have.
  const block = /required_providers \{[\s\S]*?\n {2}\}/.exec(readFileSync(versions, "utf8"))?.[0];
  if (!block) throw new Error(`${versions} has no required_providers block`);
  const work = mkdtempSync(path.join(tmpdir(), "liftoff-tofu-lock-"));
  try {
    writeFileSync(path.join(work, "versions.tf"), `terraform {\n  ${block}\n}\n`);
    execFileSync(
      "tofu",
      ["providers", "lock", ...PLATFORMS.map((platform) => `-platform=${platform}`)],
      { cwd: work, stdio: ["ignore", "inherit", "inherit"] },
    );
    copyFileSync(
      path.join(work, ".terraform.lock.hcl"),
      path.join(template, `lock/${kind}.terraform.lock.hcl`),
    );
    console.log(`wrote lock/${kind}.terraform.lock.hcl for ${PLATFORMS.join(", ")}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
