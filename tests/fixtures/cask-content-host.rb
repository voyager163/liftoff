# Inert interface double, not Homebrew. All virtual manager paths stay in one private fixture.
require "pathname"
require "digest"
require "json"
Digest::SHA256

module FixturePaths
  PREFIX = "/opt/homebrew"
  ROOT = ENV.fetch("LIFTOFF_FIXTURE_ROOT")
  def self.map(value)
    path = value.to_s
    raise "outside fixture" unless path == PREFIX || path.start_with?("#{PREFIX}/")
    "#{ROOT}#{path.delete_prefix(PREFIX)}"
  end
end

class << File
  alias_method :fixture_lstat, :lstat
  alias_method :fixture_realpath, :realpath
  alias_method :fixture_open, :open
  alias_method :fixture_read, :read
  alias_method :fixture_write, :write
  alias_method :fixture_chmod, :chmod
  alias_method :fixture_rename, :rename
  def lstat(value) = fixture_lstat(FixturePaths.map(value))
  def realpath(value) = fixture_realpath(FixturePaths.map(value)).sub(FixturePaths::ROOT, FixturePaths::PREFIX)
  def open(value, *args, **options, &block) = fixture_open(FixturePaths.map(value), *args, **options, &block)
  def read(value, *args) = fixture_read(FixturePaths.map(value), *args)
  def write(value, *args) = fixture_write(FixturePaths.map(value), *args)
  def chmod(mode, value) = fixture_chmod(mode, FixturePaths.map(value))
  def rename(source, destination) = fixture_rename(FixturePaths.map(source), FixturePaths.map(destination))
end

HOMEBREW_PREFIX = Pathname(FixturePaths::PREFIX)
$fixture_remote = "https://github.com/fixture/homebrew-tools.git"
$fixture_head = "d" * 40

class Tap
  def self.fetch(name)
    raise "foreign tap" unless name == "fixture/tools"
    @tap ||= new
  end
  def name = "fixture/tools"
  def path = Pathname("#{HOMEBREW_PREFIX}/Library/Taps/fixture/homebrew-tools")
  def installed? = ENV["LIFTOFF_FIXTURE_CHANGE"] != "tap-absent"
  def remote = @remote ||= $fixture_remote
  def git_head = @head ||= $fixture_head
end

class GitRepository
  def initialize(path)
    raise "foreign repository" unless path == Tap.fetch("fixture/tools").path
  end
  def origin_url = $fixture_remote
  def head_ref = $fixture_head
end

module Homebrew
  module EnvConfig
    def self.no_require_tap_trust? = ENV["LIFTOFF_FIXTURE_CHANGE"] == "trust-opt-out"
  end
  module Trust
    def self.require_trusted_cask!(token, path)
      raise "foreign subject" unless token == "liftoff" && path.to_s.start_with?("#{Tap.fetch("fixture/tools").path}/Casks/")
      raise "untrusted" if ENV["LIFTOFF_FIXTURE_CHANGE"] == "trust"
      raise "restriction discarded" unless ENV["HOMEBREW_FORBIDDEN_CASKS"] == "foreign" &&
        ENV["HOME"] == ENV["LIFTOFF_FIXTURE_HOME"]
      @calls = (@calls || 0) + 1
      raise "trust changed" if ENV["LIFTOFF_FIXTURE_CHANGE"] == "trust-after" && @calls > 1
    end
  end
end

module Cask
  class Cask
    attr_reader :token, :tap, :source, :sourcefile_path
    def initialize(token, source:, tap:, config:, sourcefile_path: nil, &block)
      @token, @tap, @source, @sourcefile_path = token, tap, source, sourcefile_path
      @sourcefile_path = nil if ENV["LIFTOFF_FIXTURE_CHANGE"] == "attribution"
      instance_eval(&block)
    end
    def full_name = "#{tap.name}/#{token}"
    def version(value = nil) = value ? @version = value : @version
    def sha256(value = nil) = value ? @sha256 = value : @sha256
    def url(value = nil) = value ? @url = value : @url
    def name(*) = nil
    def desc(*) = nil
    def homepage(*) = nil
    def depends_on(**) = nil
    def binary(*) = nil
    def preflight(&block)
      @preflight = block
    end
    def ruby_source_checksum
      @checksum ||= { sha256: ENV["LIFTOFF_FIXTURE_CHANGE"] == "checksum" ? "0" * 64 :
        Digest::SHA256.hexdigest(File.read(sourcefile_path)) }
      if ENV["LIFTOFF_FIXTURE_CHANGE"] == "source-after-checksum"
        File.write("#{sourcefile_path}.replacement", File.read(sourcefile_path))
        File.rename("#{sourcefile_path}.replacement", sourcefile_path)
      end
      @checksum
    end
  end

  module CaskLoader
    class AbstractContentLoader
      private
      def cask(token, **options, &block)
        Cask.new(token, source: @content, tap: @tap, config: @config, **options, &block)
      end
    end
    class FromContentLoader < AbstractContentLoader
      def initialize(content, tap: nil)
        @content, @tap = content.dup.force_encoding("UTF-8"), tap
      end
      def load(config:)
        @config = config
        File.write("#{HOMEBREW_PREFIX}/fixture-loaded", "loaded")
        sleep 10 if ENV["LIFTOFF_FIXTURE_CHANGE"] == "pause"
        result = instance_eval(@content)
        source = result.sourcefile_path
        case ENV["LIFTOFF_FIXTURE_CHANGE"]
        when "source" then File.write(source, @content + "# changed\n")
        when "head" then $fixture_head = "e" * 40
        when "origin" then $fixture_remote = "https://github.com/foreign/tools.git"
        when "config" then File.write("#{@tap.path}/.git/config", "changed\n")
        when "directory" then File.chmod(0o777, "#{@tap.path}/Casks")
        when "loaded-source" then result.source << "# changed\n"
        when "loaded-version" then result.version("0.13.1")
        when "loaded-archive" then result.sha256("0" * 64)
        when "loaded-url" then result.url("https://example.invalid/foreign")
        when "competing-layout"
          File.write("#{@tap.path}/Casks/l/liftoff.rb", @content)
        end
        result
      end
    end
  end
end

$LOADED_FEATURES.concat(%w[cask/cask_loader.rb git_repository.rb trust.rb])
