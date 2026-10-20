#!/bin/bash
set -euo pipefail
export LC_ALL=C

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 || "$EUID" != 0 ]]; then
  printf '%s\n' 'Native Linux x64 CI root setup is required.' >&2
  exit 1
fi
if [[ "$#" -lt 3 ]]; then
  printf '%s\n' 'Usage: native-linux-kvm-namespace.sh <invoking-uid> <kvm-gid> <absolute-executable> [arguments...]' >&2
  exit 1
fi
uid="$1"
gid="$2"
shift 2
[[ "$uid" =~ ^[1-9][0-9]*$ && "$gid" =~ ^[1-9][0-9]*$ ]]
test "$uid" = "${SUDO_UID:?An explicit invoking sudo user is required.}"
test "$gid" = "$(getent group kvm | cut -d: -f3)"
test "$(stat --format='%F|%t|%T|%u|%g|%a|%h' /dev/kvm)" = "character special file|a|e8|0|$gid|660|1"
[[ "$1" == /* && -f "$1" && -x "$1" ]]
namespace="$(readlink /proc/self/ns/mnt)"

# udev refreshes the host node on VM events; keep strict checks on a private inode.
exec /usr/bin/unshare --mount --propagation private -- /bin/bash -eu -o pipefail -c '
  namespace="$1"
  uid="$2"
  gid="$3"
  shift 3
  current="$(readlink /proc/self/ns/mnt)"
  test "$current" != "$namespace"
  /usr/bin/mount -t tmpfs -o rw,nosuid,noexec,dev,size=268435456,mode=1777 tmpfs /tmp
  /usr/bin/mknod --mode=0660 /tmp/liftoff-kvm c 10 232
  /usr/bin/chown -- "0:$gid" /tmp/liftoff-kvm
  /usr/bin/mount --bind -- /tmp/liftoff-kvm /dev/kvm
  printf "LIFTOFF_KVM_PRIVATE_NAMESPACE=%s PARENT=%s\n" "$current" "$namespace"
  exec /usr/bin/setpriv --reuid="$uid" --regid="$gid" --init-groups \
    --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs -- "$@"
' liftoff-kvm-namespace "$namespace" "$uid" "$gid" "$@"
