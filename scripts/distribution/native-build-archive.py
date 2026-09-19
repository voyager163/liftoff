#!/usr/bin/env python3
"""Bounded archive operations for verified build inputs and exact inventoried outputs."""
import hashlib
import json
import os
import pathlib
import stat
import sys
import tarfile
import unicodedata
import zipfile


def safe_name(name):
    parts = name.removesuffix("/").split("/")
    if (name.startswith("/") or "\\" in name or ":" in name or
            any(part in ("", ".", "..") or part.endswith((" ", ".")) for part in parts) or
            any(ord(char) < 32 for char in name)):
        raise ValueError("Unsafe archive member identity")
    return unicodedata.normalize("NFC", name.removesuffix("/")).casefold()


def extract_runtime(archive_path, root_name, binary_name, destination):
    expected = {f"{root_name}/{binary_name}": "node.exe" if binary_name.endswith(".exe") else "node",
                f"{root_name}/LICENSE": "LICENSE"}
    selected = {}
    seen = set()
    archive = zipfile.ZipFile(archive_path) if archive_path.endswith(".zip") else tarfile.open(archive_path, "r:gz")
    try:
        members = archive.infolist() if isinstance(archive, zipfile.ZipFile) else archive.getmembers()
        if len(members) > 30000:
            raise ValueError("Runtime archive exceeds member-count bound")
        for member in members:
            name = member.filename if isinstance(archive, zipfile.ZipFile) else member.name
            identity = safe_name(name)
            if identity in seen:
                raise ValueError("Duplicate/case-colliding runtime archive identity")
            seen.add(identity)
            if name not in expected:
                continue
            if isinstance(archive, zipfile.ZipFile):
                mode = member.external_attr >> 16
                size = member.file_size
                regular = not member.is_dir() and stat.S_IFMT(mode) in (0, stat.S_IFREG) and not member.flag_bits & 1
            else:
                size = member.size
                regular = member.isfile()
            if not regular or size <= 0 or size > 256 * 1024 * 1024:
                raise ValueError("Runtime/license member is not a bounded regular file")
            selected[name] = member
        if set(selected) != set(expected):
            raise ValueError("Official runtime archive is missing its exact binary/license members")
        for name, member in selected.items():
            target = pathlib.Path(destination) / expected[name]
            stream = archive.open(member) if isinstance(archive, zipfile.ZipFile) else archive.extractfile(member)
            with stream, target.open("xb") as output:
                while chunk := stream.read(1024 * 1024):
                    output.write(chunk)
            os.chmod(target, 0o555 if expected[name] != "LICENSE" else 0o444)
    finally:
        archive.close()


def create_archive(root, inventory_path, output):
    source = pathlib.Path(root)
    entries = json.loads(pathlib.Path(inventory_path).read_text())
    seen = set()
    for entry in entries:
        identity = safe_name(entry["path"])
        if identity in seen:
            raise ValueError("Duplicate/case-colliding output identity")
        seen.add(identity)
        file = source.joinpath(*entry["path"].split("/"))
        info = file.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size != entry["size"]:
            raise ValueError("Inventoried output changed before archiving")
        digest = hashlib.sha256()
        with file.open("rb") as input_file:
            while chunk := input_file.read(1024 * 1024):
                digest.update(chunk)
        if digest.hexdigest() != entry["sha256"]:
            raise ValueError("Inventoried output bytes changed before archiving")
    if pathlib.Path(output).exists():
        raise ValueError("Archive output already exists")
    if output.endswith(".zip"):
        with zipfile.ZipFile(output, "x", zipfile.ZIP_DEFLATED) as archive:
            for entry in entries:
                archive.write(source / entry["path"], f"{source.name}/{entry['path']}")
    elif output.endswith(".tar.gz"):
        with tarfile.open(output, "x:gz") as archive:
            for entry in entries:
                archive.add(source / entry["path"], arcname=f"{source.name}/{entry['path']}", recursive=False)
    else:
        raise ValueError("Unsupported native archive format")


if __name__ == "__main__":
    try:
        if len(sys.argv) == 6 and sys.argv[1] == "runtime":
            extract_runtime(*sys.argv[2:])
        elif len(sys.argv) == 5 and sys.argv[1] == "pack":
            create_archive(*sys.argv[2:])
        else:
            raise ValueError("Usage: native-build-archive.py runtime ARCHIVE ROOT BINARY DEST | pack ROOT INVENTORY OUTPUT")
    except (OSError, ValueError, tarfile.TarError, zipfile.BadZipFile) as error:
        print(f"Native build archive failed: {error}", file=sys.stderr)
        sys.exit(1)
