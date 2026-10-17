import assert from 'node:assert/strict';
import { assertNativePublicationEvidence } from './native-release-admission.mjs';
import policy from './release-policy.json' with { type: 'json' };
import platforms from './platforms.json' with { type: 'json' };

/** @param {unknown} [approvedPolicy] */
export function nativeCaskDefinition(record, evidence, approvedPolicy = policy) {
  assertNativePublicationEvidence(record, evidence, approvedPolicy);
  assert.equal(record.target, 'darwin-arm64', 'Cask definitions require the qualified Apple Silicon target.');
  assert.match(record.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
  const token = approvedPolicy.homebrew.cask.split('/').at(-1);
  assert.equal(record.files[0].filename, `liftoff-${record.version}-darwin-arm64.tar.gz`);
  assert.match(record.files[0].sha256, /^[a-f0-9]{64}$/);
  const base = `https://github.com/${record.repository}/releases/download/v${record.version}/`;
  assert.equal(evidence.artifactUrl, `${base}${record.files[0].filename}`, 'Cask URL must identify the exact qualified release asset.');
  return { filename: `${token}.rb`, content: [
    `cask "${token}" do`,
    `  version "${record.version}"`,
    `  sha256 "${record.files[0].sha256}"`,
    `  url "${evidence.artifactUrl}"`,
    '  name "Liftoff"',
    '  desc "CLI for governed GenAI applications and APIs"',
    `  homepage "https://github.com/${record.repository}"`,
    '  depends_on arch: :arm64',
    '  depends_on macos: ">= :ventura"',
    '  preflight do',
    '    odie "Native Apple Silicon is required" unless Hardware::CPU.arm? && !Hardware::CPU.in_rosetta2?',
    `    odie "The qualified runtime requires macOS ${platforms.targets['darwin-arm64'].minimumOs} or newer" if MacOS.version < MacOSVersion.new("${platforms.targets['darwin-arm64'].minimumOs}")`,
    '  end',
    '  binary "bin/liftoff"',
    'end', ''
  ].join('\n') };
}
