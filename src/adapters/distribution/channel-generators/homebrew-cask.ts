import {
  canonicalRepository,
  nativeTargetFloors
} from '../../../domain/distribution/contracts.js';

export interface HomebrewCaskInputs {
  version: string;
  arm64Sha256: string;
  x64Sha256: string;
  isTapApproved?: boolean;
  tapName?: string;
}

export interface CaskGenerationResult {
  rubySource: string;
  isBlocked: boolean;
  blockerReason?: string;
}

export function renderHomebrewCask(inputs: HomebrewCaskInputs): CaskGenerationResult {
  const { version, arm64Sha256, x64Sha256, isTapApproved = false, tapName = 'voyager163/liftoff' } = inputs;

  if (!isTapApproved) {
    return {
      rubySource: '',
      isBlocked: true,
      blockerReason: `RELEASE BLOCKER: Homebrew tap "${tapName}" is not approved or established for publication. Do not publish cask until tap is approved.`
    };
  }

  const rubySource = `# typed: false
# frozen_string_literal: true

cask "liftoff" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${arm64Sha256}",
         intel: "${x64Sha256}"

  url "https://github.com/${canonicalRepository}/releases/download/v#{version}/liftoff-v#{version}-darwin-#{arch}.tar.gz"
  name "Liftoff"
  desc "Development lifecycle orchestration CLI"
  homepage "https://github.com/${canonicalRepository}"

  conflicts_with formula: "liftoff"
  depends_on macos: ">= ${nativeTargetFloors.darwin.minimumHostVersion}"

  binary "liftoff-v#{version}-darwin-#{arch}/bin/liftoff"
end
`;

  return {
    rubySource,
    isBlocked: false
  };
}
