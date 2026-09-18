#!/usr/bin/env python3
"""Read bounded native archives without extracting or executing their contents."""
import hashlib
import json
import os
import pathlib
import stat
import struct
import sys
import tarfile
import unicodedata
import zipfile

MAX_FILES = 30000
MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_TOTAL_BYTES = 3 * 1024 * 1024 * 1024
MAX_METADATA_BYTES = 4 * 1024 * 1024
MAX_MARKDOWN_BYTES = 2 * 1024 * 1024
MAX_MARKDOWN_TOTAL_BYTES = 8 * 1024 * 1024


def read_archive(archive_path, archive_format):
    seen = set()
    files = []
    metadata = {}
    runtime_headers = {}
    member_paths = []
    documents = {}
    document_bytes = 0
    total = 0

    def consume(name, size, mode, stream, directory):
        nonlocal total, document_bytes
        while name.startswith("./"):
            name = name[2:]
        name = name.removesuffix("/")
        if name in ("", ".") and directory:
            return
        parts = pathlib.PurePosixPath(name).parts
        if (not parts or name.startswith("/") or "\\" in name or
                any(part in ("", ".", "..") or ":" in part or part.endswith((" ", ".")) for part in name.split("/")) or
                any(ord(char) < 32 for char in name)):
            raise ValueError("Unsafe archive member path")
        identity = unicodedata.normalize("NFC", name).casefold()
        if identity in seen:
            raise ValueError("Duplicate or native-case-colliding archive member")
        seen.add(identity)
        member_paths.append((name, directory))
        if len(seen) > MAX_FILES:
            raise ValueError("Native archive exceeds file-count bound")
        if directory:
            return
        if size < 0 or size > MAX_FILE_BYTES:
            raise ValueError("Native archive member exceeds size bound")
        total += size
        if total > MAX_TOTAL_BYTES:
            raise ValueError("Native archive exceeds uncompressed-size bound")
        digest = hashlib.sha256()
        captured = bytearray()
        capture = parts[-1] in ("build-info.json", "liftoff-build-manifest.json", "catalog.json", "package.json", "package-lock.json")
        markdown = parts[-1].lower().endswith(".md")
        if markdown:
            document_bytes += size
            if size > MAX_MARKDOWN_BYTES or document_bytes > MAX_MARKDOWN_TOTAL_BYTES:
                raise ValueError("Archive Markdown exceeds its byte bound")
        header = bytearray()
        measured = 0
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            measured += len(chunk)
            if measured > size:
                raise ValueError("Archive member expands beyond its declared size")
            digest.update(chunk)
            if len(header) < 65536:
                header.extend(chunk[:65536 - len(header)])
            if capture or markdown:
                if measured > (MAX_MARKDOWN_BYTES if markdown else MAX_METADATA_BYTES):
                    raise ValueError("Native metadata exceeds size bound")
                captured.extend(chunk)
        if measured != size:
            raise ValueError("Truncated native archive member")
        files.append({"path": name, "sha256": digest.hexdigest(), "size": size, "mode": mode & 0o777})
        if capture:
            metadata[name] = json.loads(captured.decode("utf-8"))
        if markdown:
            documents[name] = captured.decode("utf-8")
        if name.endswith("/runtime/node") or name == "runtime/node" or name.endswith("/runtime/node.exe") or name == "runtime/node.exe" or name.endswith("/bin/liftoff.exe") or name == "bin/liftoff.exe":
            runtime_headers[name] = bytes(header)

    if archive_format == "zip":
        with zipfile.ZipFile(archive_path) as archive:
            for member in archive.infolist():
                mode = member.external_attr >> 16
                if member.flag_bits & 1 or stat.S_ISLNK(mode) or stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
                    raise ValueError("Encrypted, linked, or special archive member")
                with archive.open(member) as stream:
                    consume(member.filename, member.file_size, mode, stream, member.is_dir())
    elif archive_format == "tar.gz":
        with tarfile.open(archive_path, "r:gz") as archive:
            for member in archive:
                if not (member.isfile() or member.isdir()):
                    raise ValueError("Linked or special archive member")
                if member.isdir():
                    consume(member.name, 0, member.mode, None, True)
                else:
                    with archive.extractfile(member) as stream:
                        consume(member.name, member.size, member.mode, stream, False)
    else:
        raise ValueError("Unsupported native archive format")

    return {"files": files, "metadata": metadata, "documents": documents,
            "runtime_headers": runtime_headers, "member_paths": member_paths}


def scope_archive(observed, root):
    if any(not name.startswith(root) and not (directory and name == root.removesuffix("/"))
           for name, directory in observed["member_paths"]):
        raise ValueError("Native payload has files outside its unique bundle root")
    files = [{**entry, "path": entry["path"][len(root):]} for entry in observed["files"]]
    return {"archiveRoot": root.removesuffix("/"),
            "files": sorted(files, key=lambda entry: entry["path"]),
            "metadata": {name[len(root):]: value for name, value in observed["metadata"].items()},
            "documents": {name[len(root):]: value for name, value in observed["documents"].items()}}


def inspect_documentation(archive_path, archive_format, archive_root):
    if (not archive_root or "/" in archive_root or "\\" in archive_root or ":" in archive_root or
            archive_root in (".", "..") or any(ord(char) < 32 for char in archive_root)):
        raise ValueError("Documentation inspection requires the exact selected single archive root")
    observed = read_archive(archive_path, archive_format)
    root = archive_root + "/"
    if root + "package.json" not in observed["metadata"]:
        raise ValueError("Documentation archive does not contain the selected package root")
    result = scope_archive(observed, root)
    result["kind"] = "archive-documentation-inspection"
    return result


def inspect(archive_path, archive_format, target):
    observed = read_archive(archive_path, archive_format)
    metadata = observed["metadata"]
    build_paths = [name for name in metadata if pathlib.PurePosixPath(name).name == "build-info.json"]
    if len(build_paths) != 1:
        raise ValueError("Archive requires exactly one root build-info.json")
    root = build_paths[0].removesuffix("build-info.json")
    result = scope_archive(observed, root)
    runtime_headers = observed["runtime_headers"]
    runtime_name = root + ("runtime/node.exe" if target.startswith("win32-") else "runtime/node")
    header = runtime_headers.get(runtime_name, b"")
    os_name, arch = target.split("-")
    if os_name == "linux":
        machine = 62 if arch == "x64" else 183
        valid = len(header) >= 20 and header[:6] == b"\x7fELF\x02\x01" and struct.unpack_from("<H", header, 18)[0] == machine
    elif os_name == "darwin":
        machine = 0x01000007 if arch == "x64" else 0x0100000C
        valid = len(header) >= 8 and struct.unpack_from("<II", header) == (0xFEEDFACF, machine)
    else:
        offset = struct.unpack_from("<I", header, 0x3C)[0] if len(header) >= 64 else len(header)
        machine = 0x8664 if arch == "x64" else 0xAA64
        valid = header[:2] == b"MZ" and offset + 6 <= len(header) and header[offset:offset + 4] == b"PE\0\0" and struct.unpack_from("<H", header, offset + 4)[0] == machine
    if not valid:
        raise ValueError("Bundled runtime binary does not have the selected native OS/architecture")
    if os_name == "win32":
        launcher = runtime_headers.get(root + "bin/liftoff.exe", b"")
        offset = struct.unpack_from("<I", launcher, 0x3C)[0] if len(launcher) >= 64 else len(launcher)
        if not (launcher[:2] == b"MZ" and offset + 6 <= len(launcher) and launcher[offset:offset + 4] == b"PE\0\0" and struct.unpack_from("<H", launcher, offset + 4)[0] == machine):
            raise ValueError("Windows launcher is not an actual matching native PE executable")
    return result


def extract_evidence(archive_path, output):
    root = pathlib.Path(output).resolve(strict=True)
    seen = set()
    total = 0
    with zipfile.ZipFile(archive_path) as archive:
        members = archive.infolist()
        if len(members) > MAX_FILES:
            raise ValueError("Evidence archive exceeds member-count bound")
        for member in members:
            name = member.filename.removesuffix("/")
            parts = name.split("/")
            mode = member.external_attr >> 16
            if (name.startswith("/") or "\\" in name or
                    any(part in ("", ".", "..") or ":" in part or part.endswith((" ", ".")) for part in parts) or
                    any(ord(char) < 32 for char in name) or
                    member.flag_bits & 1 or stat.S_ISLNK(mode) or
                    stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise ValueError("Unsafe evidence archive member")
            key = unicodedata.normalize("NFC", name).casefold()
            if key in seen:
                raise ValueError("Duplicate/case-colliding evidence member")
            seen.add(key)
            if parts[0] not in ("release-evidence.json", "manifest", "artifacts", "reports", "coverage", "channels"):
                raise ValueError("Evidence archive includes an unregistered or private namespace")
            if member.file_size > MAX_FILE_BYTES:
                raise ValueError("Evidence archive member exceeds size bound")
            total += member.file_size
            if total > MAX_TOTAL_BYTES:
                raise ValueError("Evidence archive exceeds uncompressed-size bound")
        if "release-evidence.json" not in seen:
            raise ValueError("Evidence archive lacks release-evidence.json")
        for member in members:
            destination = root.joinpath(*member.filename.removesuffix("/").split("/"))
            if member.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(destination, flags, 0o600)
            with os.fdopen(fd, "wb") as output_file, archive.open(member) as source:
                remaining = member.file_size
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError("Truncated evidence member")
                    output_file.write(chunk)
                    remaining -= len(chunk)
                if source.read(1):
                    raise ValueError("Evidence member expands beyond its size")


if __name__ == "__main__":
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "--extract-evidence":
            extract_evidence(sys.argv[2], sys.argv[3])
            sys.exit(0)
        if len(sys.argv) == 5 and sys.argv[1] == "--inspect-documentation":
            print(json.dumps(inspect_documentation(*sys.argv[2:]), separators=(",", ":")))
            sys.exit(0)
        if len(sys.argv) != 4:
            raise ValueError("Usage: release-evidence-archive.py ARCHIVE FORMAT TARGET")
        print(json.dumps(inspect(*sys.argv[1:]), separators=(",", ":")))
    except (ValueError, OSError, tarfile.TarError, zipfile.BadZipFile, UnicodeError) as error:
        print(f"Native archive integrity failed: {error}", file=sys.stderr)
        sys.exit(1)
