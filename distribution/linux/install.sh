#!/bin/sh
set -eu

if [ "$#" -ne 8 ]; then
  printf '%s\n' 'Usage: install.sh <archive> <signature> <public-key> <approved-archive-sha256> <approved-SPKI-sha256> <existing-private-prefix> <approved-bundle-manifest-sha256> <none|current-target>' >&2
  exit 1
fi
if [ "$(uname -s)" != Linux ]; then
  printf '%s\n' 'Liftoff archive installation requires native Linux; no installation was changed.' >&2
  exit 1
fi
case "$(uname -m)" in x86_64|aarch64) ;; *)
  printf '%s\n' 'Unsupported native architecture; retain the existing npm installation.' >&2
  exit 1 ;;
esac
libc=$(getconf GNU_LIBC_VERSION) || {
  printf '%s\n' 'musl or an unknown libc is not qualified.' >&2
  exit 1
}
case "$libc" in 'glibc '*) ;; *)
  printf '%s\n' 'The libc observation is unavailable or unsupported.' >&2; exit 1 ;;
esac
at_least() {
  awk -v actual="$1" -v floor="$2" 'BEGIN {
    n=split(actual,a,"."); m=split(floor,b,".");
    for(i=1;i<=n || i<=m;i++) {
      if ((a[i]+0)>(b[i]+0)) exit 0;
      if ((a[i]+0)<(b[i]+0)) exit 1;
    }
    exit 0;
  }'
}
at_least "${libc#glibc }" 2.28 && at_least "$(uname -r | cut -d- -f1)" 4.18 || {
  printf '%s\n' 'The selected runtime requires Linux kernel 4.18 and glibc 2.28 or newer.' >&2
  exit 1
}
for digest in "$4" "$5" "$7"; do
  case "$digest" in ''|*[!0-9a-f]*) printf '%s\n' 'Approved SHA-256 identities are required.' >&2; exit 1 ;; esac
  [ "${#digest}" -eq 64 ] || {
    printf '%s\n' 'Approved SHA-256 identities must have exactly 64 characters.' >&2; exit 1
  }
done
case "$6" in /*) ;; *) printf '%s\n' 'An explicit existing private user-local prefix is required.' >&2; exit 1 ;; esac
umask 077
scratch=$(mktemp -d "${TMPDIR:-/tmp}/liftoff-authenticated-archive.XXXXXXXX")
for file in "$1" "$2" "$3"; do
  [ -f "$file" ] && [ ! -L "$file" ] && [ "$(stat -c %h -- "$file")" -eq 1 ] || {
    printf '%s\n' "Authentication input is not a single-link regular file; retained scratch: $scratch" >&2
    exit 1
  }
done
# Authenticate private, bounded snapshots, never re-open external inputs for extraction.
dd if="$1" of="$scratch/archive.tar.gz" bs=1048576 count=257 status=none
[ "$(stat -c %s "$scratch/archive.tar.gz")" -le 268435456 ] || {
  printf '%s\n' "Archive exceeds its bounded input size; retained scratch: $scratch" >&2; exit 1
}
dd if="$2" of="$scratch/archive.sig" bs=4096 count=2 status=none
dd if="$3" of="$scratch/archive.pub" bs=4096 count=2 status=none
[ "$(stat -c %s "$scratch/archive.sig")" -eq 64 ] && [ "$(stat -c %s "$scratch/archive.pub")" -le 4096 ] || {
  printf '%s\n' "Ed25519 signature/key input is invalid; retained scratch: $scratch" >&2; exit 1
}
[ "$(sha256sum -- "$scratch/archive.tar.gz" | cut -d' ' -f1)" = "$4" ] || {
  printf '%s\n' "Archive differs from its independently approved checksum; retained scratch: $scratch" >&2
  exit 1
}
# Extraction happens only after independent digest and signature authentication.
openssl pkey -pubin -in "$scratch/archive.pub" -outform DER -out "$scratch/public.der"
openssl pkey -pubin -in "$scratch/archive.pub" -text -noout > "$scratch/key.txt"
grep -q '^ED25519 Public-Key:' "$scratch/key.txt" || {
  printf '%s\n' "Only the approved Ed25519 algorithm is supported; retained scratch: $scratch" >&2; exit 1
}
[ "$(sha256sum -- "$scratch/public.der" | cut -d' ' -f1)" = "$5" ] || {
  printf '%s\n' "Archive signing identity differs; retained scratch: $scratch" >&2
  exit 1
}
openssl pkeyutl -verify -pubin -inkey "$scratch/archive.pub" -rawin -in "$scratch/archive.tar.gz" -sigfile "$scratch/archive.sig"
mkdir "$scratch/bundle"
tar --extract --gzip --file "$scratch/archive.tar.gz" --directory "$scratch/bundle" \
  --no-same-owner --same-permissions --keep-old-files --no-overwrite-dir
unset NODE_OPTIONS NODE_PATH
if ! "$scratch/bundle/runtime/node" "$scratch/bundle/installation/native-install.mjs" \
  install "$6" "$7" "$8"; then
  printf '%s\n' "Installation remains incomplete; retained authenticated scratch: $scratch" >&2
  exit 1
fi
printf '%s\n' "Verified archive material retained at $scratch; no shell profile or global launcher was changed."
