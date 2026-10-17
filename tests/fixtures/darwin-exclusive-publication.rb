# Raw ABI counterexamples in a private test fixture, not a publication provider.
require "json"
require "fiddle"
require "fcntl"

root, operation, control = ARGV
raise "private fixture required" unless root && File.realpath(root) == root &&
  ENV["LIFTOFF_DARWIN_ABI_FIXTURE"] == root &&
  File.basename(File.dirname(root)).start_with?("liftoff-darwin-exclusive-abi-")
raise "not private" unless File.stat(root).uid == Process.uid && (File.stat(root).mode & 0o077).zero?
raise "invalid operation" unless ["rename", "clone"].include?(operation)
raise "invalid control" unless ["normal", "default-flags", "strict-no-follow", "invalid-flags",
  "bad-source-fd", "missing-symbol", "replace-before-open", "replace-before-unlink"].include?(control)

library = Fiddle.dlopen("/usr/lib/libSystem.B.dylib")
rename_exclusive = Fiddle::Function.new(library["renameatx_np"],
  [Fiddle::TYPE_INT, Fiddle::TYPE_VOIDP, Fiddle::TYPE_INT, Fiddle::TYPE_VOIDP, Fiddle::TYPE_INT],
  Fiddle::TYPE_INT)
clone_descriptor = Fiddle::Function.new(library["fclonefileat"],
  [Fiddle::TYPE_INT, Fiddle::TYPE_INT, Fiddle::TYPE_VOIDP, Fiddle::TYPE_INT], Fiddle::TYPE_INT)
open_at = Fiddle::Function.new(library["openat"],
  [Fiddle::TYPE_INT, Fiddle::TYPE_VOIDP, Fiddle::TYPE_INT], Fiddle::TYPE_INT)
unlink_at = Fiddle::Function.new(library["unlinkat"],
  [Fiddle::TYPE_INT, Fiddle::TYPE_VOIDP, Fiddle::TYPE_INT], Fiddle::TYPE_INT)
get_fd = Fiddle::Function.new(library["fcntl"], [Fiddle::TYPE_INT, Fiddle::TYPE_INT], Fiddle::TYPE_INT)
handles = []
observation = {
  "nativeCalled" => false, "aborted" => false, "rubyDescription" => RUBY_DESCRIPTION,
  "library" => "/usr/lib/libSystem.B.dylib"
}
identity = ->(io) {
  value = io.stat
  {"dev" => value.dev.to_s, "ino" => value.ino.to_s, "mode" => value.mode,
   "uid" => value.uid, "gid" => value.gid, "nlink" => value.nlink}
}
flags = File::RDONLY | File::NOFOLLOW | File::NONBLOCK
barrier = ->(ready, proceed) {
  File.write(File.join(root, ready), "native-barrier")
  deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 5
  until File.exist?(File.join(root, proceed))
    raise "native barrier timeout" if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
    sleep 0.002
  end
}

begin
  source_parent = File.open(File.join(root, "source"), flags)
  handles << source_parent
  destination_parent = File.open(File.join(root, "destination"), flags)
  handles << destination_parent
  raise "parents are not directories" unless source_parent.stat.directory? && destination_parent.stat.directory?
  source = File.open(File.join(root, "source", "entry"), flags)
  handles << source
  handles.each { |io| io.close_on_exec = true }
  raise "unexpected source type" unless source.stat.file? || source.stat.directory?
  observation["sourceParent"] = identity.call(source_parent)
  observation["destinationParent"] = identity.call(destination_parent)
  observation["source"] = identity.call(source)
  begin
    File.lstat(File.join(root, "destination", "published"))
    raise "destination was occupied before barrier"
  rescue Errno::ENOENT
  end
  File.write(File.join(root, "ready"), "validated-parents-and-source;destination-absent")
  deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 5
  until File.exist?(File.join(root, "continue"))
    raise "barrier timeout" if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
    sleep 0.002
  end
  if File.exist?(File.join(root, "abort"))
    observation["aborted"] = true
  elsif control == "missing-symbol"
    begin
      library["__liftoff_deliberately_absent_publication_symbol"]
      raise "unexpected fixture symbol"
    rescue Fiddle::DLError => error
      observation["unsupportedSymbol"] = error.class.name
    end
  else
    observation["nativeCalled"] = true
    if operation == "rename"
      source_fd = control == "bad-source-fd" ? -1 : source_parent.fileno
      native_flags = control == "invalid-flags" ? -2147483648 : 0x00000004
      result = rename_exclusive.call(source_fd, "entry", destination_parent.fileno, "published", native_flags)
    else
      clone_flags = control == "default-flags" ? 0 : 0x0008
      observation["cloneFlags"] = clone_flags
      result = clone_descriptor.call(source.fileno, destination_parent.fileno, "published", clone_flags)
    end
    error = result == -1 ? Fiddle.last_error : nil
    observation["return"] = result
    observation["errno"] = error
    observation["errorClass"] = error ? SystemCallError.new(error).class.name : nil
    observation["sourceAfter"] = identity.call(source)
    observation["sourceParentAfter"] = identity.call(source_parent)
    observation["destinationParentAfter"] = identity.call(destination_parent)
    if result == 0
      barrier.call("after-native", "continue-observe") if control == "replace-before-open"
      descriptor = open_at.call(destination_parent.fileno, "published", flags)
      if descriptor < 0
        observation["destinationOpenErrno"] = Fiddle.last_error
      else
        destination = File.for_fd(descriptor)
        handles << destination
        destination.close_on_exec = true
        observation["destination"] = identity.call(destination)
        if control == "replace-before-unlink"
          observation["cleanupPrecheckExpectedSource"] = destination.stat.ino == source.stat.ino &&
            destination.stat.dev == source.stat.dev
          raise "cleanup precheck did not identify the original inode" unless observation["cleanupPrecheckExpectedSource"]
          barrier.call("before-unlink", "continue-unlink")
          unlink_result = unlink_at.call(destination_parent.fileno, "published", 0)
          observation["unlinkReturn"] = unlink_result
          observation["unlinkErrno"] = unlink_result == -1 ? Fiddle.last_error : nil
        end
      end
    end
  end
ensure
  observation["descriptors"] = handles.reverse.map do |io|
    descriptor = io.fileno
    io.close
    result = get_fd.call(descriptor, Fcntl::F_GETFD)
    error = result == -1 ? Fiddle.last_error : nil
    {"fd" => descriptor, "rubyClosed" => io.closed?, "fcntl" => result, "errno" => error}
  end
end
STDOUT.write(JSON.generate(observation))
