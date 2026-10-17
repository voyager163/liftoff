import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { NativeCandidate, NativeReleasePolicy } from '../../domain/distribution/native-upgrade.js';
import { SelfUpgradeFailure } from '../../domain/distribution/liftoff-upgrade.js';
import { commandFailed } from '../../domain/distribution/liftoff-npm-installation.js';
import type { CommandResult } from '../../process-runner.js';
import { stableReleaseLookupTimeoutMs } from '../../stable-release.js';
import { authenticatedNativeCaskDefinition, lookupNativeStableCandidate, snapshotNativeStableMaterial,
  type NativeStableMaterial } from './native-metadata.js';

export interface CaskContentRequest {
  readonly stdin: string;
  readonly sha256: string;
  readonly candidateIdentity: string;
  readonly definitionSha256: string;
}

export interface CaskContentObservation {
  readonly candidateIdentity: string;
  readonly definitionSha256: string;
  readonly fullToken: string;
  readonly sourceRepository: string;
  readonly sourcePath: string;
  readonly tapCommit: string;
  readonly identity: string;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const invalid = () => new SelfUpgradeFailure('failed', 'native_invalid');
const requests = new WeakMap<CaskContentRequest, Readonly<Record<string, string | number>>>();

/** Required controls only, not a replacement for the admitted manager's effective environment. */
export const caskContentEnvironment = Object.freeze({
  HOMEBREW_DEVELOPER: '1', HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1',
  HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_SUDO: '1'
});

/** Prepares content observation only; supplies neither an invocation nor installation authority. */
export async function prepareAuthenticatedCaskContent(options: {
  material: NativeStableMaterial;
  candidate: NativeCandidate;
  policy: NativeReleasePolicy;
  source: { prefix: string; path: string; tapCommit: string };
  signal: AbortSignal;
}): Promise<CaskContentRequest> {
  const started = performance.now();
  const deadline = new AbortController();
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  const check = () => {
    if (signal.aborted || performance.now() - started >= stableReleaseLookupTimeoutMs) {
      throw new SelfUpgradeFailure('failed', 'native_timeout');
    }
  };
  let interrupt = () => {};
  const aborted = new Promise<never>((_, reject) => {
    interrupt = () => reject(new SelfUpgradeFailure('failed', 'native_timeout'));
    if (signal.aborted) interrupt();
    else signal.addEventListener('abort', interrupt, { once: true });
  });
  const timer = setTimeout(() => deadline.abort(), stableReleaseLookupTimeoutMs);
  try {
    return await Promise.race([aborted, (async () => {
      check();
      const policy = structuredClone(options.policy), candidate = structuredClone(options.candidate), source = { ...options.source };
      const fullToken = policy.homebrew.cask, repository = policy.homebrew.sourceRepository;
      if (!policy.approvedSigningKeySha256 || !policy.homebrew.developerTeamId || !fullToken || !repository) {
        throw new SelfUpgradeFailure('blocked', 'native_unqualified');
      }
      if (candidate.target !== 'darwin-arm64' || !/^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(fullToken) ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
        !['/opt/homebrew', '/usr/local'].includes(source.prefix) || !/^[a-f0-9]{40}$/.test(source.tapCommit)) throw invalid();
      const [owner, tap, token] = fullToken.split('/');
      const casks = path.posix.join(source.prefix, 'Library', 'Taps', owner, `homebrew-${tap}`, 'Casks');
      if (![path.posix.join(casks, `${token}.rb`), path.posix.join(casks, token[0], `${token}.rb`)].includes(source.path)) throw invalid();
      const macMaterial = { ...options.material };
      delete macMaterial.archiveSignature;
      delete macMaterial.archivePublicKey;
      const archiveName = `liftoff-${candidate.version}-darwin-arm64.tar.gz`;
      const names = [archiveName, 'sbom.cdx.json', 'provenance.json', 'NOTICE'];
      if (macMaterial.assets.size !== names.length || names.some(name => {
        const bytes = macMaterial.assets.get(name);
        return !bytes || !bytes.length || bytes.length > (name === archiveName ? 256 * 1024 * 1024 : 8 * 1024 * 1024);
      }) || macMaterial.platformEvidence.size > 32 ||
        [...macMaterial.platformEvidence.values()].some(bytes => bytes.length > 8 * 1024 * 1024) ||
        macMaterial.record.length > 8 * 1024 * 1024 || macMaterial.qualification.length > 8 * 1024 * 1024 ||
        macMaterial.signature.length !== 64 || macMaterial.publicKey.length > 4096) throw invalid();
      const material = snapshotNativeStableMaterial(macMaterial);
      const admitted = await lookupNativeStableCandidate({ target: 'darwin-arm64' }, policy, {
        readStable: async () => material
      });
      check();
      if (!isDeepStrictEqual(admitted, candidate)) throw invalid();
      if (!admitted.archiveSha256) throw invalid();
      const definition = await authenticatedNativeCaskDefinition(material, admitted, policy);
      check();
      const common = {
        candidateIdentity: candidate.identity, definitionSha256: definition.sha256, version: candidate.version,
        archiveSha256: admitted.archiveSha256,
        artifactUrl: `https://github.com/${policy.repository}/releases/download/v${candidate.version}/liftoff-${candidate.version}-darwin-arm64.tar.gz`,
        fullToken, sourceRepository: repository, sourcePath: source.path, tapCommit: source.tapCommit
      };
      const stdin = JSON.stringify({ schemaVersion: 1, kind: 'liftoff-cask-content-request', ...common,
        prefix: source.prefix, definition: Buffer.from(definition.content).toString('base64') });
      if (definition.bytes > 256 * 1024 || Buffer.byteLength(stdin) > 512 * 1024) throw invalid();
      const request = Object.freeze({ stdin, sha256: hash(stdin), candidateIdentity: candidate.identity,
        definitionSha256: definition.sha256 });
      requests.set(request, Object.freeze({ schemaVersion: 1, kind: 'liftoff-cask-content-observation',
        ...common, requestSha256: request.sha256, sourceChecksum: definition.sha256 }));
      return request;
    })()]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', interrupt);
    deadline.abort();
  }
}

/** Validates a trusted settled runner result, not the admission of its Homebrew executable or environment. */
export function readCaskContentObservation(request: CaskContentRequest, result: CommandResult): CaskContentObservation {
  const expected = requests.get(request);
  if (!expected) throw invalid();
  if (commandFailed(result) || result.timedOut !== false || result.processSpawned !== true ||
    result.processTreeSettled !== true || result.stderr !== '' || Buffer.byteLength(result.stdout) > 16 * 1024) {
    throw new SelfUpgradeFailure('failed', result.timedOut || result.aborted ? 'native_timeout' : 'native_unavailable');
  }
  if (result.stdout !== JSON.stringify(expected)) throw invalid();
  return Object.freeze({
    candidateIdentity: request.candidateIdentity, definitionSha256: request.definitionSha256,
    fullToken: String(expected.fullToken), sourceRepository: String(expected.sourceRepository),
    sourcePath: String(expected.sourcePath), tapCommit: String(expected.tapCommit),
    identity: hash(JSON.stringify(expected))
  });
}

// Runs only inside a separately admitted Homebrew Ruby host. No installer, receipt or destination write.
export const caskContentProgram = String.raw`
module LiftoffCaskContent
  class Refusal < StandardError; end
  MAXIMUM = 256 * 1024

  def self.identity(stat)
    [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.nlink, stat.size,
     stat.mtime.to_i, stat.mtime.nsec, stat.ctime.to_i, stat.ctime.nsec]
  end

  def self.directories(path, prefix, observed)
    current = Pathname(path)
    loop do
      value = current.to_s
      raise Refusal unless value == prefix || value.start_with?("#{prefix}/")
      stat = File.lstat(value)
      raise Refusal unless stat.directory? && !stat.symlink? && File.realpath(value) == value
      # This is directory identity, not atomic directory-content ownership.
      value_identity = [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode]
      raise Refusal if observed.key?(value) && observed[value] != value_identity
      observed[value] = value_identity
      break if value == prefix
      current = current.parent
    end
  end

  def self.file(path, maximum)
    raise Refusal unless File.const_defined?(:NOFOLLOW) && File.const_defined?(:NONBLOCK)
    before = File.lstat(path)
    raise Refusal unless before.file? && !before.symlink? && before.nlink == 1 && before.size <= maximum
    bytes = File.open(path, File::RDONLY | File::NOFOLLOW | File::NONBLOCK) do |stream|
      raise Refusal unless identity(stream.stat) == identity(before)
      content = stream.read(maximum + 1)
      raise Refusal unless content.bytesize <= maximum && content.bytesize == before.size
      raise Refusal unless identity(stream.stat) == identity(before)
      content
    end
    raise Refusal unless identity(File.lstat(path)) == identity(before)
    [bytes, identity(before)]
  end

  def self.absent(path, prefix, observed)
    parent = File.dirname(path)
    begin
      File.lstat(parent)
    rescue Errno::ENOENT
      return
    end
    directories(parent, prefix, observed)
    begin
      File.lstat(path)
    rescue Errno::ENOENT
      return
    end
    raise Refusal
  end
end

phase = "input"
begin
  controls = %w[HOMEBREW_DEVELOPER HOMEBREW_NO_AUTO_UPDATE HOMEBREW_NO_ANALYTICS HOMEBREW_NO_INSTALL_CLEANUP HOMEBREW_NO_SUDO]
  raise LiftoffCaskContent::Refusal unless controls.all? { |name| ENV[name] == "1" }
  raise LiftoffCaskContent::Refusal unless %w[RUBYOPT RUBYLIB].all? { |name| ENV[name].to_s.empty? }
  require "json"
  require "digest"
  require "pathname"
  raw = STDIN.read(512 * 1024 + 1)
  raise LiftoffCaskContent::Refusal unless ARGV.length == 1 && ARGV[0].match?(/\A[a-f0-9]{64}\z/) &&
    raw.bytesize <= 512 * 1024 && Digest::SHA256.hexdigest(raw) == ARGV[0]
  input = JSON.parse(raw)
  keys = %w[schemaVersion kind candidateIdentity definitionSha256 version archiveSha256 artifactUrl fullToken
            sourceRepository sourcePath tapCommit prefix definition]
  raise LiftoffCaskContent::Refusal unless input.is_a?(Hash) && input.keys.sort == keys.sort &&
    input["schemaVersion"] == 1 && input["kind"] == "liftoff-cask-content-request"
  keys.reject { |name| name == "schemaVersion" }.each do |name|
    raise LiftoffCaskContent::Refusal unless input[name].is_a?(String)
  end
  %w[candidateIdentity definitionSha256 archiveSha256].each do |name|
    raise LiftoffCaskContent::Refusal unless input[name].match?(/\A[a-f0-9]{64}\z/)
  end
  raise LiftoffCaskContent::Refusal unless input["version"].match?(/\A(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\z/) &&
    input["tapCommit"].match?(/\A[a-f0-9]{40}\z/) && %w[/opt/homebrew /usr/local].include?(input["prefix"]) &&
    input["fullToken"].match?(/\A[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\z/) &&
    input["sourceRepository"].match?(/\A[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\z/)
  prefix = input.fetch("prefix")
  owner, tap_name, token = input.fetch("fullToken").split("/")
  tap_root = "#{prefix}/Library/Taps/#{owner}/homebrew-#{tap_name}"
  source_path = input.fetch("sourcePath")
  layouts = ["#{tap_root}/Casks/#{token}.rb", "#{tap_root}/Casks/#{token[0]}/#{token}.rb"]
  raise LiftoffCaskContent::Refusal unless layouts.include?(source_path)
  alternate_path = (layouts - [source_path]).fetch(0)
  content = input.fetch("definition").unpack1("m0").force_encoding(Encoding::UTF_8)
  raise LiftoffCaskContent::Refusal unless content.valid_encoding? && !content.include?("\0") &&
    content.bytesize.positive? && content.bytesize <= LiftoffCaskContent::MAXIMUM &&
    Digest::SHA256.hexdigest(content) == input["definitionSha256"]
  content.freeze

  phase = "host"
  require "cask/cask_loader"
  require "git_repository"
  require "trust"
  raise LiftoffCaskContent::Refusal unless HOMEBREW_PREFIX.to_s == prefix
  observed = {}
  LiftoffCaskContent.directories(File.dirname(source_path), prefix, observed)
  LiftoffCaskContent.directories("#{tap_root}/.git", prefix, observed)
  LiftoffCaskContent.absent(alternate_path, prefix, observed)
  config_path = "#{tap_root}/.git/config"
  config = LiftoffCaskContent.file(config_path, 64 * 1024)
  source = LiftoffCaskContent.file(source_path, LiftoffCaskContent::MAXIMUM)
  raise LiftoffCaskContent::Refusal unless source[0] == content
  tap = Tap.fetch("#{owner}/#{tap_name}")
  repository = GitRepository.new(Pathname(tap_root))
  approved = input.fetch("sourceRepository")
  remotes = ["https://github.com/#{approved}", "https://github.com/#{approved}.git",
             "git@github.com:#{approved}", "git@github.com:#{approved}.git",
             "ssh://git@github.com/#{approved}", "ssh://git@github.com/#{approved}.git"].map(&:downcase)
  origin = repository.origin_url
  raise LiftoffCaskContent::Refusal unless tap.installed? && tap.name == "#{owner}/#{tap_name}" &&
    tap.path.to_s == tap_root && tap.remote == origin && origin.is_a?(String) && remotes.include?(origin.downcase) &&
    repository.head_ref == input["tapCommit"] && tap.git_head == input["tapCommit"]

  phase = "trust"
  raise LiftoffCaskContent::Refusal if Homebrew::EnvConfig.no_require_tap_trust?
  Homebrew::Trust.require_trusted_cask!(token, Pathname(source_path))

  phase = "content"
  class LiftoffCaskContent::Loader < Cask::CaskLoader::FromContentLoader
    def initialize(content, source_path:, token:, tap:)
      @liftoff_source_path = Pathname(source_path)
      @liftoff_token = token
      super(content, tap: tap)
    end

    private

    def cask(header_token, **options, &block)
      raise LiftoffCaskContent::Refusal unless header_token == @liftoff_token && options.empty?
      super(header_token, sourcefile_path: @liftoff_source_path, &block)
    end
  end
  cask = LiftoffCaskContent::Loader.new(content, source_path: source_path, token: token, tap: tap).load(config: nil)
  raise LiftoffCaskContent::Refusal unless cask.is_a?(Cask::Cask) && cask.token == token &&
    cask.full_name == input["fullToken"] && cask.tap.equal?(tap) && cask.sourcefile_path.to_s == source_path &&
    cask.source == content && cask.version.to_s == input["version"] &&
    cask.sha256.to_s == input["archiveSha256"] && cask.url.to_s == input["artifactUrl"]
  checksum = cask.ruby_source_checksum.fetch(:sha256)
  raise LiftoffCaskContent::Refusal unless checksum == input["definitionSha256"]

  phase = "recheck"
  raise LiftoffCaskContent::Refusal unless LiftoffCaskContent.file(source_path, LiftoffCaskContent::MAXIMUM) == source &&
    LiftoffCaskContent.file(config_path, 64 * 1024) == config &&
    repository.origin_url == origin && repository.head_ref == input["tapCommit"]
  observed.keys.each { |directory| LiftoffCaskContent.directories(directory, prefix, observed) }
  LiftoffCaskContent.absent(alternate_path, prefix, observed)
  raise LiftoffCaskContent::Refusal if Homebrew::EnvConfig.no_require_tap_trust?
  Homebrew::Trust.require_trusted_cask!(token, Pathname(source_path))
  output = input.reject { |name, _| %w[prefix definition].include?(name) }
  output["kind"] = "liftoff-cask-content-observation"
  output["requestSha256"] = ARGV[0]
  output["sourceChecksum"] = checksum
  STDOUT.write(JSON.generate(output))
rescue StandardError
  STDERR.write("liftoff-cask-content:#{phase}\n")
  exit 1
end
`;
