# The cask in voyager163/homebrew-tap (CHAN-001). scripts/release/homebrew.ts
# fills in the version and checksum; after that, the tap's copy is changed
# only in those two lines, so its maintainers may reformat the rest.
cask "liftoff" do
  version "{{version}}"
  sha256 "{{sha256}}"

  url "https://github.com/voyager163/liftoff/releases/download/v#{version}/liftoff-package-aarch64-apple-darwin.tar.gz"
  name "Liftoff"
  desc "Developer platform CLI for governed API and GenAI projects"
  homepage "https://github.com/voyager163/liftoff"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on macos: :sequoia

  binary "liftoff-package-aarch64-apple-darwin/bin/liftoff"
end
