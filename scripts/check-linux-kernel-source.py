#!/usr/bin/env python3
"""Compare a Linux source tree with its separately authenticated, uncompressed tar."""
import argparse
import hashlib
import json
import os
import stat
import tarfile
from pathlib import Path, PurePosixPath

MAX_ARCHIVE_BYTES = 2 * 1024 ** 3
MAX_FILE_BYTES = 32 * 1024 ** 2
MAX_ENTRIES = 100000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def file_digest(stream, size):
    digest = hashlib.sha256()
    remaining = size
    while remaining:
        chunk = stream.read(min(remaining, 1024 * 1024))
        require(chunk, "Source input ended before its declared size")
        digest.update(chunk)
        remaining -= len(chunk)
    require(stream.read(1) == b"", "Source input exceeds its declared size")
    return digest.hexdigest()


def identity(info):
    return tuple(getattr(info, field) for field in
                 ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink",
                  "st_size", "st_mtime_ns", "st_ctime_ns"))


def physical_file(filename, maximum):
    before = os.lstat(filename)
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1,
            "Source input is not a single-link physical regular file: " + str(filename))
    require(0 <= before.st_size <= maximum, "Source input exceeds its bound: " + str(filename))
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        require(identity(os.fstat(stream.fileno())) == identity(before), "Source input changed before open")
        digest = file_digest(stream, before.st_size)
        require(identity(os.fstat(stream.fileno())) == identity(before), "Source input changed during read")
        require(identity(os.lstat(filename)) == identity(before), "Source input path changed during read")
    return before, digest


def source_inventory(archive, source, archive_sha256):
    archive = Path(archive)
    source = Path(source)
    archive_info, observed_sha256 = physical_file(archive, MAX_ARCHIVE_BYTES)
    require(observed_sha256 == archive_sha256, "Authenticated source tar digest differs")
    root_info = os.lstat(source)
    require(stat.S_ISDIR(root_info.st_mode), "Source root must be a physical directory")
    expected = {}
    with tarfile.open(str(archive), "r:") as members:
        for member in members:
            require(len(expected) < MAX_ENTRIES, "Source inventory exceeds its entry bound")
            name = member.name.rstrip("/")
            require(name and not name.startswith("/") and
                    all(part not in ("", ".", "..") for part in name.split("/")),
                    "Unsafe source tar path")
            parts = PurePosixPath(name).parts
            require(parts[0] == source.name, "Source tar root differs")
            relative = "/".join(parts[1:])
            require(relative not in expected, "Duplicate source tar path")
            row = {"path": relative, "mode": member.mode & 0o7777}
            if member.isdir():
                row["type"] = "directory"
            elif member.isfile():
                require(0 <= member.size <= MAX_FILE_BYTES, "Source member exceeds its byte bound")
                with members.extractfile(member) as stream:
                    row.update(type="file", bytes=member.size, sha256=file_digest(stream, member.size))
            elif member.issym():
                row.update(type="symlink", target=member.linkname)
            else:
                raise ValueError("Unsupported source tar entry type: " + name)
            expected[relative] = row
    require("" in expected and expected[""]["type"] == "directory", "Source tar root is absent")
    observed = {}
    physical = []
    pending = [(source, "")]
    while pending:
        filename, relative = pending.pop()
        require(len(observed) < MAX_ENTRIES, "Extracted source exceeds its entry bound")
        info = os.lstat(filename)
        physical.append((filename, identity(info)))
        row = {"path": relative, "mode": stat.S_IMODE(info.st_mode)}
        if stat.S_ISDIR(info.st_mode):
            row["type"] = "directory"
            with os.scandir(filename) as entries:
                children = sorted((entry.name for entry in entries), reverse=True)
            for name in children:
                pending.append((filename / name, (relative + "/" + name).lstrip("/")))
        elif stat.S_ISREG(info.st_mode):
            captured, digest = physical_file(filename, MAX_FILE_BYTES)
            require(identity(captured) == identity(info), "Source file changed between observations")
            row.update(type="file", bytes=captured.st_size, sha256=digest)
        elif stat.S_ISLNK(info.st_mode):
            row.update(type="symlink", target=os.readlink(filename))
            require(identity(os.lstat(filename)) == identity(info), "Source link changed during read")
        else:
            raise ValueError("Unsupported extracted source type: " + relative)
        observed[relative] = row
    require(observed.keys() == expected.keys(), "Extracted source path/type/mode/byte inventory differs: paths")
    for name in sorted(expected):
        require(observed[name] == expected[name],
                "Extracted source path/type/mode/byte inventory differs: " + name)
    for filename, before in physical:
        require(identity(os.lstat(filename)) == before, "Source entry changed during observation: " + str(filename))
    require(identity(os.lstat(archive)) == identity(archive_info), "Authenticated source tar changed")
    require(identity(os.lstat(source)) == identity(root_info), "Source root changed during observation")
    rows = [expected[name] for name in sorted(expected)]
    encoded = json.dumps(rows, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    return {"schemaVersion": 1, "kind": "liftoff-linux-kernel-source-inventory",
            "archiveSha256": observed_sha256, "inventorySha256": hashlib.sha256(encoded).hexdigest(),
            "entries": len(rows), "inventory": rows, "signatureAuthenticatedByThisTool": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive")
    parser.add_argument("source")
    parser.add_argument("archive_sha256")
    parser.add_argument("new_output")
    args = parser.parse_args()
    result = source_inventory(args.archive, args.source, args.archive_sha256)
    with open(args.new_output, "x", encoding="utf8") as output:
        json.dump(result, output, sort_keys=True, indent=2)
        output.write("\n")


if __name__ == "__main__":
    main()
