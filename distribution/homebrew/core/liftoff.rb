# A draft for homebrew/core (CHAN-002), built from the npm package.
# scripts/release/homebrew.ts fills in the version and checksum. A person
# submits it, as Homebrew's rules for AI-assisted contributions require.
class Liftoff < Formula
  desc "Developer platform CLI for governed API and GenAI projects"
  homepage "https://github.com/voyager163/liftoff"
  url "https://registry.npmjs.org/@voyager163/liftoff/-/liftoff-{{version}}.tgz"
  sha256 "{{sha256}}"
  license "GPL-3.0-only"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/liftoff --version")
    system bin/"liftoff", "init", "--name", "smoke", "--workflow", "manual", "--agents", "claude", "--yes"
    system bin/"liftoff", "validate", "--dir", "smoke"
    assert_path_exists testpath/"smoke/.gitignore"
  end
end
