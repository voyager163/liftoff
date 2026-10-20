import hashlib
import importlib.util
import io
import os
import tarfile
import tempfile
import unittest
from unittest import mock
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "kernel_source", Path(__file__).resolve().parent.parent / "scripts/check-linux-kernel-source.py")
kernel_source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kernel_source)


class LinuxKernelSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="liftoff-kernel-source-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.archive = self.root / "source.tar"
        self.source = self.root / "linux-4.18"
        with tarfile.open(str(self.archive), "w") as output:
            for name, kind, mode, content in [
                ("linux-4.18", tarfile.DIRTYPE, 0o755, b""),
                ("linux-4.18/source.c", tarfile.REGTYPE, 0o644, b"original\n"),
                ("linux-4.18/build.sh", tarfile.REGTYPE, 0o755, b"#!/bin/sh\n"),
                ("linux-4.18/link", tarfile.SYMTYPE, 0o777, b"")
            ]:
                member = tarfile.TarInfo(name)
                member.type, member.mode, member.size = kind, mode, len(content)
                if kind == tarfile.SYMTYPE:
                    member.linkname = "source.c"
                output.addfile(member, io.BytesIO(content))
        self.digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        with tarfile.open(str(self.archive), "r:") as source:
            source.extractall(str(self.root))
        if hasattr(os, "lchmod"):
            os.lchmod(str(self.source / "link"), 0o777)

    def observe(self, digest=None):
        return kernel_source.source_inventory(self.archive, self.source, digest or self.digest)

    def test_complete_inventory_preserves_bytes_modes_links_and_authority_boundary(self):
        result = self.observe()
        self.assertEqual(result["entries"], 4)
        self.assertFalse(result["signatureAuthenticatedByThisTool"])
        self.assertEqual(result, self.observe())

    def test_changed_bytes(self):
        (self.source / "source.c").write_bytes(b"modified\n")
        with self.assertRaisesRegex(ValueError, "inventory differs"):
            self.observe()

    def test_case_distinct_source_paths_cannot_be_silently_collapsed(self):
        with tarfile.open(str(self.archive), "a") as output:
            for name, content in [("Case.c", b"upper\n"), ("case.c", b"lower\n")]:
                member = tarfile.TarInfo("linux-4.18/" + name)
                member.mode, member.size = 0o644, len(content)
                output.addfile(member, io.BytesIO(content))
                (self.source / name).write_bytes(content)
        self.digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        if (self.source / "Case.c").read_bytes() == (self.source / "case.c").read_bytes():
            with self.assertRaisesRegex(ValueError, "inventory differs"):
                self.observe()
        else:
            self.assertEqual(self.observe()["entries"], 6)

    def test_changed_mode(self):
        (self.source / "build.sh").chmod(0o644)
        with self.assertRaisesRegex(ValueError, "inventory differs"):
            self.observe()

    def test_authenticated_group_write_modes_are_not_normalized(self):
        members = []
        with tarfile.open(str(self.archive), "r:") as archive:
            for member in archive:
                content = archive.extractfile(member).read() if member.isfile() else b""
                if member.isdir() or member.isfile():
                    member.mode |= 0o020
                members.append((member, content))
        with tarfile.open(str(self.archive), "w") as archive:
            for member, content in members:
                archive.addfile(member, io.BytesIO(content))
        self.digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.source.chmod(0o775)
        (self.source / "source.c").chmod(0o664)
        (self.source / "build.sh").chmod(0o775)
        result = self.observe()
        self.assertEqual(result["inventory"][0]["mode"], 0o775)
        self.assertEqual(next(row for row in result["inventory"] if row["path"] == "source.c")["mode"], 0o664)

    def test_missing_file(self):
        (self.source / "source.c").unlink()
        with self.assertRaisesRegex(ValueError, "inventory differs"):
            self.observe()

    def test_extra_file(self):
        (self.source / "extra.c").write_bytes(b"not authenticated")
        with self.assertRaisesRegex(ValueError, "inventory differs"):
            self.observe()

    def test_changed_link_without_following_its_target(self):
        (self.source / "link").unlink()
        (self.source / "link").symlink_to("/unreadable-unrelated-target")
        with self.assertRaisesRegex(ValueError, "inventory differs"):
            self.observe()

    def test_hardlinked_file(self):
        os.link(str(self.source / "source.c"), str(self.root / "outside-hardlink"))
        with self.assertRaisesRegex(ValueError, "single-link"):
            self.observe()

    def test_wrong_tar_digest(self):
        with self.assertRaisesRegex(ValueError, "tar digest differs"):
            self.observe("0" * 64)

    def test_declared_stream_sizes_reject_truncation_and_overflow(self):
        self.assertEqual(kernel_source.file_digest(io.BytesIO(b"exact"), 5), hashlib.sha256(b"exact").hexdigest())
        for content, size in [(b"short", 6), (b"overflow", 7)]:
            with self.assertRaisesRegex(ValueError, "declared size"):
                kernel_source.file_digest(io.BytesIO(content), size)

    def test_size_is_rejected_before_opening_an_oversized_file(self):
        filename = self.source / "source.c"
        with open(str(filename), "r+b") as stream:
            stream.truncate(kernel_source.MAX_FILE_BYTES + 1)
        with mock.patch.object(kernel_source.os, "open", wraps=os.open) as opened:
            with self.assertRaisesRegex(ValueError, "exceeds its bound"):
                self.observe()
            self.assertFalse(any(Path(call[0][0]) == filename for call in opened.call_args_list))

    def test_mode_mutation_between_path_observation_and_capture(self):
        original = kernel_source.physical_file
        filename = self.source / "source.c"

        def changing_capture(candidate, maximum):
            if Path(candidate) == filename:
                filename.chmod(0o600)
            return original(candidate, maximum)

        with mock.patch.object(kernel_source, "physical_file", side_effect=changing_capture):
            with self.assertRaisesRegex(ValueError, "between observations"):
                self.observe()

    def test_symlinked_archive(self):
        original = self.root / "original.tar"
        self.archive.rename(original)
        self.archive.symlink_to(original)
        with self.assertRaisesRegex(ValueError, "single-link"):
            self.observe()

    def test_symlinked_source_root(self):
        original = self.root / "original-source"
        self.source.rename(original)
        self.source.symlink_to(original, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "physical directory"):
            self.observe()

    def test_duplicate_tar_member(self):
        with tarfile.open(str(self.archive), "a") as output:
            output.add(str(self.source / "source.c"), arcname="linux-4.18/source.c")
        self.digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            self.observe()

    def test_unsafe_tar_member(self):
        with tarfile.open(str(self.archive), "a") as output:
            output.addfile(tarfile.TarInfo("linux-4.18/../escape"))
        self.digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            self.observe()


if __name__ == "__main__":
    unittest.main()
